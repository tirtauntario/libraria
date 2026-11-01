# Libraria

Offline-first EPUB, PDF and comic reader (PWA) with optional, self-hosted community library servers. `docs/plan.md` holds the product decisions and is the source of truth.

## Layout

pnpm workspace:

- `packages/core` — `@libraria/core`. Framework-free TypeScript shared by client and server, consumed as source (no build step).
  - `src/` (isomorphic): ids (UUIDv7), hash (streaming SHA-512), format detection, metadata extraction (zip.js + fast-xml-parser), grouping, models, settings, **API contract (`api.ts`)**, E2E crypto (`crypto.ts`), sync payloads and merge rules (`sync.ts`).
  - `src/browser/` (`@libraria/core/browser`, needs DOM/Workers/Vite): comic archives (CBZ lazy, CBR via bitjs worker), PDF (pdf.js), EPUB (sanitized documents for sandboxed iframes), thumbnails.
- `apps/server` — `@libraria/server`. Express 5 + `node:sqlite` via Kysely. See `apps/server/README.md`.
- `apps/web` — `@libraria/web`. Svelte 5 PWA, hash routing, IndexedDB + OPFS. Extension points (sources, routes, panels, sync hooks) are in `apps/web/README.md`.

## Rules

- Primary keys are UUIDv7 (`uuidv7()` from core). Book identity across systems is SHA-512 (lowercase hex).
- The client works fully offline with no server. No client feature may depend on a server.
- The API contract lives in `packages/core/src/api.ts`. Change it there first, then server and client.
- Passwords never leave the client: it derives `authHash` with Argon2id (`crypto.ts`). The server stores scrypt of `authHash`.
- Sync records are encrypted client-side. The server never sees plaintext progress, bookmarks or config.
- EPUB chapters render only in an iframe sandboxed without `allow-scripts`. Never inject book HTML into the app DOM.
- No native Node dependencies in the server (Raspberry Pi, NAS). Use `node:sqlite`, pure JS or WASM.
- TypeScript strict with `noUncheckedIndexedAccess` and no unused locals/params. Vanilla CSS with custom properties.

## Commands

```bash
pnpm install
pnpm test                          # vitest, all packages
pnpm check                         # type-check all packages
pnpm --filter @libraria/web e2e    # Playwright against vite preview
pnpm dev:web                       # client dev server
pnpm dev:server                    # server dev (tsx watch)
pnpm device                        # "Libraria - Dev" build on :4173 for phone testing over USB
pnpm build                         # build all
```

## Git

Work on a feature branch, then `git merge --no-ff` into `main`. No pull requests for now.
