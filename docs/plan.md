# Libraria — Plan

Source note: handwritten requirements, 1 Nov 2026. Decisions below were settled in follow-up discussion.

## Product

Libraria is an offline-first EPUB, PDF and comic reader delivered as a PWA. It works fully without any server.

A **Libraria server** is optional. It acts as a community library: an owner shares books with members who read them. A server can also act as a user's **sync home** for personal data (progress, bookmarks, other reading metadata).

Libraria is **not SaaS**. There is no central service. Anyone can run their own server, and the client connects to any servers the user chooses.

The client can use, at the same time:

- many libraries,
- many storage sources (a library can combine several),
- many Libraria servers (one of them chosen as sync home).

## Requirements

| Area | Requirement |
|---|---|
| Formats | Comics: CBZ, CBR (as in comic-reader / omni-reader). Books: EPUB, PDF. |
| Delivery | PWA, no install hassle. Offline reading is mandatory. |
| Sources | Local files, WebDAV, Google Drive, Dropbox, Libraria server, more later. |
| Server | Optional. Node.js + Express. SQLite, upgradeable to MySQL/Postgres. |
| Client | Svelte. UI is a rewrite; logic is ported from omni-reader. |
| Library per server | Exactly one. The server *is* the library. Only the owner creates it (at server setup). |
| Roles | Owner: everything, including curators and server settings. Curator: add/edit/remove books, accept signups. Member: read and download. |
| Visibility | Public or private. In a private library, owner or curator must accept each signup. |
| Client independence | Every client feature works offline with no server. Servers add sync and community libraries only. |
| Connecting to a server | The client talks to a server only after the user registers there. |
| Contributions | Members can submit books from their device. Owner or curator approves before members see them. Owner and curator add books directly. |
| Offline for members | Members can download any book for offline reading. Required. |
| Personal sync | Progress, bookmarks, library and source configuration. End-to-end encrypted; the server cannot read it. |
| License | AGPL-3.0-or-later. |
| Identity | Primary keys are UUIDv7. Book uniqueness is the file's SHA-512. |
| Distribution | Self-hosted, decentralized. Anyone can run a server. No central service. |

## Reuse from existing repos

`tirtauntario/omni-reader` (`packages/core/src/lib`) is the main base; `tirtauntario/comic-reader` is the older CBZ/CBR-only version of the same code.

Port almost as-is (framework-free TypeScript):

- `lib/archive/*` — format detection by magic bytes, CBZ lazy extraction (zip.js), CBR via bitjs worker, natural sort. Keep `scripts/patch-bitjs.sh`.
- `lib/pdf/pdf-reader.ts` — pdfjs-dist wrapper, thumbnails. Keep the `streamTextContent()` note (Safari < 17.2).
- `lib/epub/epub-reader.ts` — zip.js-based EPUB parser (OPF, spine, TOC, cover, resource blob URLs). **Needs a security fix before use, see below.**
- `lib/group.ts`, `lib/image.ts` (BlobUrlManager), `lib/uuid.ts` (UUIDv7).
- `platform/types.ts` `StorageProvider` — basis for the storage interface, extended for multiple sources.

Rewrite in Svelte: all components, hooks, routes. `comic-reader/docs/instructions.md` is a framework-neutral spec of the comic UI and behaviour.

### EPUB rendering must be isolated

omni-reader injects chapter HTML into the app's DOM (`dangerouslySetInnerHTML` in `BookPageViewer.tsx` / `BookContinuousViewer.tsx`). `processHtml` scopes CSS and rewrites image URLs but does not strip scripts, event handlers (`<img onerror>`) or `javascript:` links.

That was tolerable when every book was the user's own file. In Libraria, books come from community servers and shared drives, and the app origin holds Drive/Dropbox tokens and server sessions. Render chapters in a sandboxed `<iframe>` without `allow-scripts`, and sanitize as a second layer (DOMPurify).

## Architecture

```
packages/core   framework-free TS: format readers, hashing, models, sync protocol, source interface
apps/web        Svelte PWA (hash routing, Vite, vite-plugin-pwa)
apps/server     Express + SQLite (via Kysely or Drizzle; avoid Prisma's native engine)
```

pnpm workspaces, same layout as omni-reader.

### Client

- **Metadata**: IndexedDB. **Offline files**: OPFS, IndexedDB fallback (as omni-reader).
- **Sources** implement one interface: `list(path)`, `stat(path)`, `read(path, range?)`.
  - Local: files imported into OPFS (all browsers); linked folders via File System Access (Chromium only).
  - WebDAV: direct from browser — requires CORS on the WebDAV server.
  - Google Drive / Dropbox: OAuth PKCE in browser.
  - Libraria server: REST API with bearer token.
- **Offline**: books are copied to OPFS on open or when pinned "keep offline". Call `navigator.storage.persist()`. Show quota usage. On iOS, offline storage is only reliable for the installed PWA.

- **Independence rule**: hashing, metadata extraction, covers, grouping, reading and library management all run in the client. No feature may call a server unless the user registered on it.

### Contributing books

1. Member picks a book from their device and a registered server.
2. Client sends the SHA-512 first. If the library already has it, or it is already pending, nothing is uploaded.
3. Client uploads in chunks with resume. If offline, the submission is queued and sent when the app is next online (Background Sync exists only in Chromium, so also retry on app open).
4. Server stores the file in a quarantine folder that members cannot see. It checks size limits, verifies the SHA-512, checks the format by magic bytes, parses the file, and sanitizes metadata.
5. Owner or curator reviews: approve (book joins the library), or reject with an optional note. The member sees the status in the client.
6. The submitter's local copy and the server copy share the SHA-512, so the client links them automatically.

The approval step is also where the owner checks they have the right to share the book. Approved books can still be removed later.

### Server

- Hosts one community library: users with roles, server-side storage sources, uploads, scanning, covers.
- Serves book files with HTTP Range support, so member downloads can resume.
- Computes SHA-512 at scan time and exposes it, so clients get identity without downloading.
- Stores personal sync data for users who pick it as sync home.
- Bearer tokens, not cookies (client may run on another origin; third-party cookies are blocked). CORS open to configured client origins.
- Must be reachable over HTTPS: an HTTPS-hosted PWA cannot call `http://192.168.x.x` (mixed content). Option: the server also serves the PWA bundle, so a self-hosted server works same-origin.

## Distribution

Decentralized: servers are independent and never talk to each other. The client is the only place where libraries, sources and servers come together. Nothing is federated.

### Running a server

- One Node process plus one SQLite file. No external services required.
- Ship as `npx libraria-server`, a Docker image, and possibly a single executable (Node SEA).
- No native dependencies, so it runs on a Raspberry Pi, a NAS or a VPS without build tools. Use the built-in `node:sqlite` module instead of better-sqlite3. Make covers with WASM or pure JS instead of sharp.
- Configure with a config file and environment variables. Data lives in one directory, so backups are a copy.
- **HTTPS is required, not optional.** Service workers (offline, install) only run in a secure context, and an HTTPS client cannot call an HTTP server. Document three paths: Caddy (automatic certificates), Tailscale (`*.ts.net` certificates), Cloudflare Tunnel.

### Where the client comes from

- Every server serves the PWA bundle, so `https://my-server` opens a working app with no other hosting.
- Also publish the same build as a static site (GitHub Pages or similar). It's a plain file host with no backend, so it isn't SaaS. Users without a server use it, or they host the static files themselves.
- **Origin matters.** IndexedDB and OPFS are tied to the origin. Opening the app from server A and from server B gives two separate local libraries. Tell users to pick one origin as their app and add other servers inside it. That's also why cross-origin access (CORS, bearer tokens) is required even when every server serves the client.

### Server identity and compatibility

- A server is identified by its URL plus a server UUIDv7 created on first run, so the client can detect a server that moved or was replaced.
- `GET /api/info` returns name, server id, API version and capabilities. Version the API (`/api/v1`): servers and clients update independently.
- Join a server with an invite link containing the server URL and an invite token. No central directory.

### Accounts and ownership

- Accounts exist per server. There is no global identity. A user may run a personal (private, empty) server just as a sync home.
- **Owner is set at first run.** The server prints a one-time setup token to the console. Whoever has console access uses it to create the owner account and the library. This stops the first visitor from claiming a fresh server.
- **Only the owner adds sources.** Server-local disk paths and server-side cloud credentials come from the person running the host. Letting curators attach paths like `/etc` would expose it. Curators add books by uploading them and edit metadata.
- **Signups.** Public library: signups are active immediately. Private library: signups wait as `pending` until an owner or curator accepts or rejects them.
- **Members download freely.** Books are DRM-free once downloaded. Owners should understand that publishing a book to members means members can copy it.

### Cloud storage OAuth without a central app

- Google and Dropbox client IDs are bound to redirect origins. With no central service, each deployment registers its own app. Clients read the IDs from `/api/info` or from build-time config.
- Google's `drive.readonly` scope is restricted. A public app needs verification, and an unverified app is capped at 100 users. Self-hosters can stay in testing mode for personal use. `drive.file` with the Google Picker avoids verification but only covers files the user explicitly picks; test whether that is enough for library folders.
- Each server's tokens are scoped to that server and never sent to another. Drive and Dropbox credentials stay in the client unless the user adds that storage as a server-side source.

### Trust

Servers are run by strangers. Treat all server content and metadata as untrusted: sandboxed EPUB rendering, sanitized metadata, and size limits on downloads and covers.

## Configuration

Both server and client are configurable. Each setting lives in exactly one place, so there is never a question of which value wins.

### Server

**Host settings**: config file `libraria.config.json` in the data directory. Environment variables override it (`LIBRARIA_PORT`, etc.). Changing these requires a restart. They are not editable from the web UI, because they control the machine.

| Setting | Default |
|---|---|
| `port` | `8080` |
| `dataDir` | `./data` |
| `publicUrl` | none; required behind a reverse proxy |
| `trustProxy` | `false` |
| `allowedOrigins` (CORS) | the server's own origin plus the official static client |
| `sourceRoots` — disk paths the owner may add as sources | none |
| `oauth.google` / `oauth.dropbox` client IDs | none (feature hidden) |
| `log.level` | `info` |

**Library settings**: stored in the database, edited by the owner in the client. Take effect immediately.

| Setting | Default |
|---|---|
| Name, description | set at first run |
| Visibility | `private` |
| Max upload file size | 500 MB |
| Per-member storage quota (pending + approved submissions) | 2 GB |
| Max pending submissions per member | 20 |
| Members may submit books | on |
| Allowed formats | CBZ, CBR, EPUB, PDF |
| Invite link expiry | 7 days |
| Invite links skip approval (private library) | on |
| Anonymous access (public library): `none` \| `browse` (catalog and covers) \| `read` (also open and download) | `none` |

Owner and curator uploads skip quota and approval.

Anonymous visitors never sync or submit, since both need an account. Anonymous requests are rate-limited per IP address.

### Client

Settings page, stored in IndexedDB. Two groups:

**Synced** (part of the encrypted config, same on all devices):

- Reader: mode, direction, fit, zoom (comics); font, size, margins, spacing, theme (books).
- Library: view, sort, grouping, custom groups and renames.
- Libraries, sources, registered servers, sync home.

**Per device** (never synced):

| Setting | Default |
|---|---|
| Auto-download a book when opened | on |
| Download on metered connections | on (the Network Information API is Chromium only) |
| Offline storage limit | none (browser quota applies) |
| Auto-remove unpinned books not opened for N days | off |
| Sync automatically | on |

## Identity and sync

- Every row has a UUIDv7 primary key, generated where the row is created.
- UUIDs of books are **local** to a device or server. Anything that crosses systems (progress, bookmarks) references the book by **SHA-512**.
- Synced records (bookmarks, notes) keep their own UUIDv7, which is globally unique, so they merge without collisions.
- Progress: one record per (user, sha512), last-write-wins on `updated_at`.
- Bookmarks/notes: add-only with soft delete (`deleted_at`), merged by UUID.
- Positions: page number for comics and PDF. EPUB uses spine index plus progression (0..1) within the chapter, which survives font and layout changes. CFI was the original plan; spine + progression is what shipped.

### End-to-end encrypted sync

All personal sync data is encrypted in the client. The sync-home server stores opaque blobs only. This covers progress, bookmarks, notes, libraries, sources and source credentials.

- **Keys** (Bitwarden-style):
  - `master_key = Argon2id(password, salt)`, computed in the client (WASM).
  - The client sends only `auth_hash = HKDF(master_key, "auth")` to log in. The server never sees the password or `master_key`.
  - A random `data_key` encrypts all sync data (AES-256-GCM, WebCrypto). The server stores `data_key` wrapped by `master_key`.
  - Changing the password re-wraps `data_key`. Data is not re-encrypted.
  - Show a **recovery key** once at setup (`data_key` wrapped by a random key the user writes down). Without password or recovery key, the data is gone: the server cannot reset it.
- **Hide which books a user reads.** Records refer to books by `HMAC(data_key, sha512)`, not raw `sha512`, so the server cannot match sync records to its own books.
- **Record shape the server sees**: `id` (UUIDv7), `kind` (`progress` | `bookmark` | `config`), `ref` (the HMAC), `rev` (server-assigned, increasing), `deleted`, `ciphertext`.
- **Merging happens in the client.** The server cannot read `updated_at`. Clients pull everything since their last `rev`, decrypt, merge (progress last-write-wins, bookmarks by UUID), and push results. Pushes carry the `rev` they are based on; the server rejects stale writes so the client re-merges.
- These apply only to the sync-home account. Accounts on other servers use ordinary login.

### SHA-512 cost

- Hashing needs the full file. For remote sources that means downloading it.
- Hash lazily: when a file is first downloaded or opened. Until then the book row has `sha512 = NULL` and is identified by source + path + size + mtime.
- `crypto.subtle.digest` is not streaming and needs the whole file in memory. Use a streaming WASM hasher (e.g. hash-wasm) in a worker for large files.
- Drive and Dropbox expose their own checksums (SHA-256 / Dropbox content hash), not SHA-512, so they can detect changes but not replace the hash.

## Draft data model

Client (IndexedDB stores) and server (SQLite tables) share these shapes in `packages/core`.

**Client**

- `libraries` — id, name, created_at
- `sources` — id, kind (`opfs` | `fs-handle` | `webdav` | `gdrive` | `dropbox` | `libraria`), config, server_id?
- `library_sources` — library_id, source_id, root_path
- `books` — id, sha512 (unique, nullable), format, title, author, series, page_count, file_size, cover, added_at
- `book_files` — id, book_id, source_id, path, size, mtime, etag
- `offline_files` — id, book_id, opfs_name, size, pinned, last_opened_at
- `servers` — id, url, username, token, is_sync_home
- `progress` — id, sha512, position, percent, updated_at
- `bookmarks` — id, sha512, position, note, created_at, updated_at, deleted_at
- `settings`

**Server**

- `server` — single row: id, name, visibility (`public` | `private`), created_at
- `users` — id, username, auth_hash, kdf_salt, kdf_params, role (`owner` | `curator` | `member`), status (`pending` | `active` | `rejected` | `disabled`), created_at
- `invites` — id, token_hash, created_by, expires_at, used_by
- `submissions` — id, user_id, sha512, format, title, author, file_size, upload_offset, status (`uploading` | `pending` | `approved` | `rejected`), reviewed_by, review_note, created_at, reviewed_at
- `sources`, `books`, `book_files` — as client (no `libraries`: the server is the library)
- `sync_keys` — user_id, wrapped_data_key, wrapped_recovery_key
- `sync_records` — id, user_id, kind, ref, rev, deleted, ciphertext, updated_at

## Build order

1. Monorepo, `packages/core` ported from omni-reader, SHA-512 hashing, data model.
2. Svelte PWA: local import, library view, comic + PDF readers, offline.
3. EPUB reader with sandboxed rendering.
4. WebDAV, Google Drive, Dropbox sources; libraries combining sources.
5. Server: first-run setup, accounts, roles, signups, sources, uploads, scanning, book API.
6. Client: connect to multiple servers, download for offline, submit books; server review queue.
7. End-to-end encrypted sync home.

## Implementation notes

Decisions made while building, beyond the sections above.

- **Sync home is per device.** It is stored with the local data key, not in synced settings, since a new device must sign in to unlock the key anyway.
- **The raw data key stays on the device** (IndexedDB) so sync runs without re-entering the password. Anyone with access to the browser profile can read it. "Forget sync key" removes it.
- **Server session tokens sync** inside the encrypted libraria source record. Signing out of a server clears it on every synced device.
- **A joined server's source and library use the server's own id**, so two devices joining the same server merge instead of duplicating it.
- **New sources get a library of the same name** automatically.
- **Removed remote files** keep the book (marked unavailable) unless it exists elsewhere. Progress and bookmarks are never deleted.
- **Deleting a server book that also lives on a disk source** leaves a hidden tombstone so the next scan does not re-add it.
- **`PUT /sync/keys`** creates keys once; replacing them needs the header `X-Libraria-Replace-Keys: 1`.

## Known gaps

- Google Drive and Dropbox are covered by mocked tests only; not yet run against the real services.
- Google's implicit flow has no refresh token: Drive asks to sign in again about every hour.
- Server catalog refresh downloads the full book list (no "changed since" query).
- Download resume works within a session, not across reloads.
- Fixed-layout EPUBs render as reflowable text; no bundled dyslexia-friendly font.
- CBR and Safari/WebKit are not covered by the end-to-end tests.
- On MySQL/Postgres the sync rev counter would need a row lock; only SQLite is implemented.

