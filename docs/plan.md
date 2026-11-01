# Libraria — Plan

Source note: handwritten requirements, 1 Nov 2026. Decisions below were settled in follow-up discussion.

## Product

Libraria is an offline-first EPUB, PDF and comic reader delivered as a PWA. It works fully without any server.

A **Libraria server** is optional. It acts as a community library: an owner shares books with members who read them. A server can also act as a user's **sync home** for personal data (progress, bookmarks, other reading metadata).

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
| Hosting | Not decided. |

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

1. How do users join a server: open registration, invite links, or created by an owner? With no server admin, who may create a library?
2. Should the sync home also sync the user's library and source configuration? If yes, source credentials (WebDAV passwords, OAuth tokens) need to be excluded or end-to-end encrypted.
3. Can members download books for offline reading, or read online only? Offline being mandatory suggests download.
4. Hosting for the PWA and the server (affects OAuth redirect URIs and HTTPS).
