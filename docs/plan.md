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
| Roles (server library) | Owner: manages library, creates curators. Curator: manages library. Member: read only. No server-wide admin. |
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

### Server

- Hosts community libraries: users, libraries, members with roles, server-side storage sources, scanning, covers.
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

### Accounts and operator

- Accounts exist per server. There is no global identity. A user may run a personal server just as a sync home.
- **Operator.** A server still needs someone to control registration and which server-local disk paths can become sources. Letting any library owner attach paths like `/etc` would expose the host. Make the operator a config-file setting (the person who runs the process), not an in-app role.

### Cloud storage OAuth without a central app

- Google and Dropbox client IDs are bound to redirect origins. With no central service, each deployment registers its own app. Clients read the IDs from `/api/info` or from build-time config.
- Google's `drive.readonly` scope is restricted. A public app needs verification, and an unverified app is capped at 100 users. Self-hosters can stay in testing mode for personal use. `drive.file` with the Google Picker avoids verification but only covers files the user explicitly picks; test whether that is enough for library folders.
- Each server's tokens are scoped to that server and never sent to another. Drive and Dropbox credentials stay in the client unless the user adds that storage as a server-side source.

### Trust

Servers are run by strangers. Treat all server content and metadata as untrusted: sandboxed EPUB rendering, sanitized metadata, and size limits on downloads and covers.

## Identity and sync

- Every row has a UUIDv7 primary key, generated where the row is created.
- UUIDs of books are **local** to a device or server. Anything that crosses systems (progress, bookmarks) references the book by **SHA-512**.
- Synced records (bookmarks, notes) keep their own UUIDv7, which is globally unique, so they merge without collisions.
- Progress: one record per (user, sha512), last-write-wins on `updated_at`.
- Bookmarks/notes: add-only with soft delete (`deleted_at`), merged by UUID.
- Positions: page number for comics and PDF; EPUB CFI for EPUB (chapter index + scroll offset does not survive font or layout changes).

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

- `users` — id, username, password_hash, created_at
- `libraries` — id, name, created_at
- `library_members` — id, library_id, user_id, role (`owner` | `curator` | `member`)
- `sources`, `library_sources`, `books`, `book_files` — as client
- `progress`, `bookmarks` — as client, plus user_id

## Build order

1. Monorepo, `packages/core` ported from omni-reader, SHA-512 hashing, data model.
2. Svelte PWA: local import, library view, comic + PDF readers, offline.
3. EPUB reader with sandboxed rendering.
4. WebDAV, Google Drive, Dropbox sources; libraries combining sources.
5. Server: accounts, libraries, roles, scanning, book API.
6. Client: connect to multiple servers; sync home for progress and bookmarks.

## Open questions

1. Registration: open, invite-only, or operator's choice per server? Who may create a library: any registered user, or only the operator?
2. Should the sync home also sync the user's library and source configuration? If yes, source credentials (WebDAV passwords, OAuth tokens) need to be excluded or end-to-end encrypted.
3. Can members download books for offline reading, or read online only? Offline being mandatory suggests download.
4. Open-source license: MIT (anyone may reuse, including closed forks) or AGPL (modified hosted servers must publish their source).
