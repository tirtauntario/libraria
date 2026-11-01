# @libraria/web

The Libraria PWA: an offline-first reader for EPUB, PDF and comics (CBZ, CBR). Svelte 5 (runes), TypeScript, Vite, hash routing, vanilla CSS. It works fully offline with no server.

```sh
pnpm --filter @libraria/web dev       # dev server
pnpm --filter @libraria/web check     # svelte-check (0 errors, 0 warnings)
pnpm --filter @libraria/web test      # vitest (fake-indexeddb)
pnpm --filter @libraria/web build     # production build + service worker
pnpm --filter @libraria/web e2e       # Playwright: smoke test against `vite preview`, and server.spec.ts
                                      # against a real server (built from apps/server) serving dist/
pnpm --filter @libraria/web icons     # re-render PNG icons from the SVG logo
```

The e2e run writes screenshots to `test-results/screens/` (git-ignored). `E2E_PORT=4391 pnpm --filter @libraria/web e2e` uses another preview port. `e2e/sources.spec.ts` starts its own WebDAV server (`e2e/webdav-server.ts`) on a random port.

## Layout

```
src/
  main.ts, App.svelte      bootstrap: services → settings → catalog → PWA → startup hooks
  routes.ts               core routes and nav items
  features.ts             import optional features here (server, sync, more sources)
  routes/                 pages: Home, LibraryPage, BookPage, Libraries, SettingsPage, ReaderPage
  lib/
    db/schema.ts          IndexedDB schema + migrations (idb)
    db/repo.ts            every read/write; records the sync change log
    db/events.ts          change bus (also relayed to other tabs)
    storage/opfs.ts       file store: OPFS (streaming writes) or IndexedDB blobs; quota/persist
    sources/              SourceDriver interface, registry, drivers (local, folder, webdav, gdrive, dropbox),
                          OAuth redirect plumbing, setup forms (ui/)
    library/              import, scan, open/download, offline + eviction, catalog logic
    readers/              shared chrome, gestures, locators; comic/, pdf/, epub/
    stores/               reactive state (catalog, settings, toasts, importer, pwa)
    ui/                   components and icons
    router.svelte.ts      hash router
    net.svelte.ts         online/metered state
    extensions.ts         UI extension registries
    services.ts           singletons (db, repo, file store, hasher, analyzer)
```

## Data model (IndexedDB `libraria`)

| Store | Key | Notes |
|---|---|---|
| `books` | `id` (UUIDv7) | `sha512` nullable (unique index skips nulls), metadata, cover thumbnail Blob, `customGroup`, `metaSource` (`file` / `filename` placeholder), `metaEdited`, `addedAt`, `updatedAt`, `lastReadAt` |
| `bookFiles` | `id` | where a book lives: `bookId`, `sourceId`, `path`, `size`, `mtime`, `etag`, optional `displayPath` and `missing`; unique `[sourceId, path]` |
| `offlineFiles` | `id` | downloaded copy of a remote book in the file store: `opfsName`, `size`, `pinned`, `lastOpenedAt` |
| `fileBlobs` | file-store name | IndexedDB fallback when OPFS is missing |
| `progress` | `sha512` | natural key: exactly one progress per book across devices (LWW) |
| `bookmarks` | `id` | soft delete (`deleted` + `updatedAt`) |
| `libraries`, `sources` | `id` | core `Library` / `Source` |
| `settings` | name | singletons: `synced`, `syncedUpdatedAt`, `device`, `meta` (device id, built-in source/library ids), `ui`; extensions may add namespaced keys via `repo.getValue/setValue` |
| `changes` | sync logical key | outbox, see below |
| `uploads` (v2) | `id` | books being sent to Libraria servers: server source, book, SHA-512, submission id, confirmed offset, status; indexes `bookId`, `sourceId` |

Migrations: append a function to `MIGRATIONS` in `src/lib/db/schema.ts`; never edit a released one. The version is `MIGRATIONS.length`.

Every device has one built-in `local` source ("This device", books imported into OPFS) and the default library "On this device" containing it. Both are device-only and never enter the change log.

## Extension points

### Storage sources (folder, WebDAV, Google Drive, Dropbox, Libraria)

1. Implement `SourceDriver` from `src/lib/sources/types.ts`:
   - `list(path)` async-iterates `SourceEntry { path, name, isDir, size, mtime, etag, sha512? }` for one folder (`''` is the root). `path` is stable; it is stored in `bookFiles`.
   - `read(path, { signal, onProgress })` → `Blob`. Optional `readStream()` (preferred for downloads: bytes go straight to OPFS), `stat`, `write`, `remove`, `close`.
   - `isLocal`: `true` for sources read without the network (a File System Access folder). Local books are never copied offline and never evicted.
   - `describe()` → `{ title, detail }`.
2. Register it, replacing the stub of the same kind: `registerSourceKind({ kind, label, description, deviceOnly, implemented: true, userCreatable: true, isSupported, createDriver, setup })` from `src/lib/sources/registry.ts`. `setup` is a Svelte component receiving `SourceSetupProps { onCreate(name, config), onCancel }`; the Libraries page shows it in "Add source" and creates the `Source` record (then scans it).
3. Import the module from `src/lib/sources/index.ts` (after `./stubs`) or from `src/features.ts`.

Reuse, don't rewrite:
- `scanSource(source, rootPath, services, { signal, onProgress, recursive, prune })` in `lib/library/scan.ts` walks `list()`, creates placeholder books (`sha512: null`, title from the filename), updates changed files (size/mtime/etag) and prunes removed ones. If an entry carries `sha512` (Libraria servers know it), it links to the existing book directly.
- `openBook(bookId, services, { signal, onStage })` in `lib/library/open.ts` resolves a readable Blob: offline copy → local source → download (into OPFS when `autoDownloadOnOpen` allows, honouring `downloadOnMetered`), then hashes and analyses placeholders and merges them into an existing book with the same SHA-512. `keepOffline()` downloads and pins. Progress stages drive the reader's loading UI.
- `importFiles(files, services)` for anything the user picks from their device.
- `scanner` (`lib/stores/scanner.svelte.ts`) for background scans with progress and per-source problems; `scanRoots()` scans only the folders libraries use.
- `SourceError` (`sources/errors.ts`) with a `code` the UI acts on: `auth` → "Sign in again", `permission` → "Grant access", `network` + `corsHelp` → CORS help. Show messages through `errorMessage(err, config)`, which redacts the config's secrets.
- `resumableStream()` (`sources/http.ts`) for downloads that resume with `Range` after a dropped connection.

Built-in remote/device drivers:

| Kind | Paths | Notes |
|---|---|---|
| `folder` | relative to the picked folder | File System Access (Chromium). Handle stored under `settings` key `folder:handle:<handleId>`; permission is re-requested only from a click (`requestFolderAccess`). `isLocal`: read in place, copied only by "Keep a copy". Device-only. |
| `webdav` | decoded, relative to the configured URL | PROPFIND Depth 1, Basic auth (UTF-8). Needs CORS on the server; `CorsHelp.svelte` explains it. |
| `gdrive` | chains of Drive file ids; names in `displayPath` | OAuth token flow (`drive.readonly`), about an hour per sign-in, re-auth tries `prompt=none` first. Client ID in `SyncedSettings.oauth.googleClientId`. |
| `dropbox` | display paths relative to `rootPath` | OAuth code flow + PKCE, `token_access_type=offline`; refreshed tokens are written back to the source. App key in `SyncedSettings.oauth.dropboxAppKey`. |

OAuth: `oauth.ts` stores the pending request (`state`, PKCE verifier, route to return to) in localStorage and navigates the whole page to the provider. `oauth-capture.ts`, imported first in `main.ts`, takes the response out of the URL before the hash router starts, checks `state` and restores the route; `finishSignIn()` (startup hook in `features/sources.ts`) turns it into tokens. The redirect URI to register is the app's origin + path (shown with a copy button in Settings › Cloud storage).

Removed files: a rescan that no longer finds a file deletes its `bookFiles` row only if the book is still somewhere else. Otherwise the row stays with `missing: true`, so the book keeps its place in its libraries, readable from an offline copy or shown as unavailable. Progress and bookmarks are never touched.

### Libraria server integration

- Routes: `registerRoute({ pattern: '/server/:id', component, section })` (`lib/router.svelte.ts`). Catch-all routes are tried last, so feature routes registered later still match.
- Navigation: `navItems.register({ id, label, href, icon, order })` (`lib/extensions.ts`). Core items use order 0–100.
- Settings page sections: `settingsSections.register({ id, title, component, order })`.
- Book page panels (e.g. "Submit to server", server copy status): `bookPanels.register({ id, component, order })`; the component receives `{ book }`.
- Home sections: `homeSections.register(...)`.
- Startup work (token refresh, retry queued submissions): `onStartup(async () => …)` runs after services and settings load.
- Server books: register the `libraria` source kind (above). `LibrariaConfig` lives in the source config.
- Network: `net.online`, `net.metered`, `net.whenOnline(fn)` in `lib/net.svelte.ts`. No feature may call a server the user has not registered on.

### Sync engine (end-to-end encrypted)

- Outbox: `repo.listChanges()` returns `ChangeRecord { key, kind, ref, updatedAt }` oldest first, one per logical record (repeated writes coalesce). Keys follow core `logicalKey`: `progress:<sha512>`, `bookmark:<id>`, `config:library:<id>`, `config:source:<id>`, `config:settings:settings`. Load the current value by `kind` + `ref` (`getProgress(ref)`, bookmarks by id, `getLibrary`, `getSource`, `getSyncedSettings`), encrypt, push, then `repo.ackChanges(pushed)`; an entry rewritten after it was listed stays queued.
- Applying remote data (never recorded as local changes): `applyRemoteProgress` (LWW on `updatedAt`, tie on device id), `applyRemoteBookmark` (by UUID, LWW, soft delete wins if newer), `applyRemoteConfig('library' | 'source', value)` (LWW), `applyRemoteSettings(value, updatedAt)`.
- Device-only data is excluded from the outbox: the built-in library, `local`/`folder` sources (`DEVICE_ONLY_SOURCES`), device settings, books, files and offline copies. When pushing a library, drop `sources` refs that point at device-only sources.
- Sync state (cursor/rev, keys): `repo.getValue('sync:…')` / `setValue`. Device setting `autoSync` exists for it.
- The UI re-queries on `repo.events` topics (`books`, `progress`, `bookmarks`, `libraries`, `sources`, `settings`, `offline`); repo writes emit them, so merged data appears without extra wiring.

## Libraria servers and sync (built)

Code: `src/lib/server/` (API client, registry, `libraria` source, uploads), `src/lib/sync/` (keys, engine, controller) and `src/features/server/` (pages, panels, startup). The feature registers itself from `src/features.ts`.

- **Joining**: `#/join` (also `#/join?server=<url>&invite=<token>` from invite links). The address is normalized; plain `http://` is only allowed for localhost, and a blocked mixed-content request is explained. `/info` decides between first-run owner setup (setup token + library name), sign up, sign in and "Browse as guest" (when the server allows anonymous access). Argon2id runs in a worker (`lib/server/kdf.ts`); registration uses a random salt and `DEFAULT_KDF`. Accounts that wait for approval are listed on `#/servers` until the user signs in.
- **Registry**: a joined server is a `libraria` source whose id is the server's id, plus a library with the same id and name. Every device that joins the server creates the same records, so sync merges them instead of duplicating the server. Per-device state (cached `/info`, session expired, refresh times) is in `repo.getValue('server:state:<id>')`. A 401 on a request that carried the token marks the session expired; the UI offers to sign in again.
- **Catalog**: `refreshServerCatalog()` lists `/books`, runs the generic `scanSource()` (entries carry the SHA-512, so local copies link at once), copies server metadata into books that only live on servers, and caches covers. It runs on app start and when coming online (at most every 5 minutes), when a server page opens (1 minute) and on "Refresh". Downloads stream into OPFS and resume with `Range` after a dropped connection.
- **Contributions**: "Send to server…" on a book page or "Send a book…" on the server page queue an upload job (`uploads` store). Jobs look the SHA-512 up first, create the submission, send `UPLOAD_CHUNK_BYTES` chunks and resume from `HEAD` after reloads; offline jobs wait for app start or the `online` event. Pending jobs poll for the review result; once approved, the local cover is uploaded if the server has none.
- **Server pages** (`#/server/<id>?tab=`): books, my submissions, review queue (open the pending file read-only at `#/server/<id>/review/<submission>`), members, invites, library settings and disk sources by role, account (password change, sign out, remove).
- **Sync** (`#/sync`, Settings → Sync): the login password is the sync password. Setting up on the first device creates the data key, wraps it with the master key and a recovery key (shown once, with copy, download and an "I saved it" check). Other devices unwrap it with the master key from signing in, or with the recovery key, which then re-wraps it for the current password. Changing the password on a sync device re-wraps the key. "Delete synced data" calls `DELETE /sync`.
  - **Device-trusted model**: after setup or unlock this device stores the raw data key in IndexedDB (`sync:key`), so sync runs without the password. Anyone who can open this browser profile can read it, as they can read the books and progress next to it. "Forget sync key" deletes it.
  - The sync home is per device (`sync:key` names it), not part of the synced config: a new device has to sign in to unlock the key anyway.
  - Engine: check the keys still match → pull since the cursor (paged), decrypt, `applyRemote*` → push the outbox with `ref = HMAC(logical key)` and the last rev seen per ref (`sync:revs`); conflicts are decrypted, merged with the core rules, applied or re-pushed. Device-only sources and the built-in library never leave the device; refs to device-only sources are stripped from synced libraries and kept on each device. Triggers: start, local changes (3 s debounce), online, every 2 minutes while visible, "Sync now"; automatic runs follow the device setting "Sync automatically".
  - Source records sync with their credentials (WebDAV passwords, OAuth tokens, server session tokens), encrypted. Signing out of a server clears its token on every synced device.

## Readers

All three share `ReaderChrome.svelte` (top bar with back, bookmark toggle, contents, bookmarks, settings, fullscreen; bottom bar; auto-hide after 3 s; side sheets). They receive `ReaderProps` and report positions through `onlocation`; `ReaderPage` saves progress debounced (500 ms) and on page hide.

- **Comics** (`readers/comic`): paged and continuous, LTR/RTL, fit contain/width/height/original, zoom 50–400 % with pinch and ctrl-wheel, swipe, click thirds, keyboard (arrows, space, PgUp/PgDn, Home/End, F), slider + page entry, preload 1 behind / 2 ahead with blob-URL revocation, two-page spreads on wide screens, end-of-volume prompt to the previous/next book of the series.
- **PDF** (`readers/pdf`): pdf.js canvas at devicePixelRatio (capped for iOS canvas limits), text layer via `page.streamTextContent()`, paged and continuous with lazy render and release off-screen, outline as contents.
- **EPUB** (`readers/epub`): sanitized chapter documents from core `EpubBook` in `<iframe sandbox="allow-same-origin">` (no `allow-scripts`, plus the core CSP). Book HTML never enters the app DOM. The parent handles clicks, links (`resolveLink`; external links open in a new tab with `noopener`), keys and swipes inside the frame. Paginated mode lays chapters out in CSS columns (two per page on wide screens) and turns pages by shifting the body; scrolled mode scrolls the frame. Page turns animate as slide or curl (setting; none under `prefers-reduced-motion`): a second inert frame (the peel) holds the same chapter and shows the page being left, so book HTML still never enters the app DOM. Slide moves both frames; curl clips the earlier page along a fold (`turn.ts`, a corner lifted towards the spine) and draws the back of the sheet over it. Swipes (setting, on by default) drag the page with the finger within a chapter and commit past a quarter of the width or on a flick; across chapters the peel keeps the old page on screen while the next chapter loads. Locator: `{ type: 'epub', spine, progression, total }`, restored after font, size and window changes.

## PWA

`vite-plugin-pwa` (generateSW): the app shell, workers and pdf.js are precached, so the app loads offline after the first visit. Update prompt via a toast; install prompt on Home (Chromium) and instructions in Settings. The manifest declares `file_handlers` for .epub/.pdf/.cbz/.cbr; files arrive through `launchQueue` and are imported. The build uses a relative base, so it works at a domain root, a sub-path, or served by a Libraria server.

## Not done yet

- Google Drive and Dropbox are covered by mocked unit tests and a mocked sign-in e2e only; they have not been run against the real services.
- EPUB positions use spine + progression, not CFI (the plan mentions CFI).
- The "Readable" font uses OpenDyslexic / Atkinson Hyperlegible only if installed; no font files are bundled.
- Fixed-layout EPUBs and vertical writing are rendered as reflowable text.
