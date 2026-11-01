# Libraria server

This is the **Libraria server**: the optional part of Libraria that hosts a shared library for a group, and can act as a sync home for its members' progress and bookmarks. The **Libraria app** (the reader, in `apps/web`) works without it. If you only want to read, or to join someone else's library, you do not need to run this. See [the two parts of Libraria](../../README.md#libraria-has-two-parts).

One server is one library, run by one **owner** who can appoint **curators**. **Members** connect from their Libraria app, read and download books, and can submit books for review. Servers are independent: they do not talk to each other, and no one else operates or controls yours.

One Node process, one SQLite file (built-in `node:sqlite`), no native dependencies. Runs on a Raspberry Pi, a NAS or a VPS.

## Your responsibilities as an operator

Running a server means you publish content to your members. As owner (and as curators):

- Publish only books you have the right to share: your own work, public-domain works, works under a licence that allows it, or works you have permission for.
- Review member submissions with that in mind before approving them, and keep the library private when the content is meant for a closed group.
- Handle copyright notices and takedown requests for your server yourself. The Libraria project does not run your server and cannot act on it.
- Follow the privacy laws that apply to your members' data (for example, student papers submitted for grading).

The software comes without warranty, and its authors are not liable for content stored or shared on your server. Read the full [disclaimer](../../DISCLAIMER.md).

## Run

Requires Node 24 or newer.

```sh
pnpm install
pnpm --filter @libraria/server build
node apps/server/dist/index.js        # or: pnpm --filter @libraria/server start
```

Development: `pnpm dev:server` (tsx watch). Tests: `pnpm --filter @libraria/server test`.

On first start the server prints a **one-time setup token**. Open the server URL, or `POST /api/v1/setup`, with that token to create the owner account and name the library. Until setup is done, every restart prints a new token and voids the old one.

### Docker

```sh
docker build -f apps/server/Dockerfile -t libraria .
docker run -p 8080:8080 -v libraria-data:/data libraria
```

The image serves the web client too when the workspace contains `apps/web`. Read the setup token with `docker logs`.

## Configuration

Host settings live in `libraria.config.json` inside the data directory (written with defaults on first run). Environment variables override the file. Restart after changing them. Library settings (name, visibility, quotas, formats, invites, anonymous access) are stored in the database and edited by the owner in the client.

| Setting | Env | Default |
|---|---|---|
| data directory | `LIBRARIA_DATA_DIR` | `./data` (env only: the config file lives in it) |
| `port` | `LIBRARIA_PORT` | `8080` |
| `host` | `LIBRARIA_HOST` | `0.0.0.0` |
| `publicUrl` | `LIBRARIA_PUBLIC_URL` | none; set it behind a reverse proxy |
| `trustProxy` | `LIBRARIA_TRUST_PROXY` | `false` (Express `trust proxy`: `true`, hop count or subnet list) |
| `allowedOrigins` | `LIBRARIA_ALLOWED_ORIGINS` (comma-separated) | none; the server's own origin is always allowed |
| `sourceRoots` | `LIBRARIA_SOURCE_ROOTS` (comma-separated) | none; disk paths the owner may add as sources |
| `log.level` | `LIBRARIA_LOG_LEVEL` | `info` (`error`, `warn`, `info`, `debug`) |
| `webDir` | `LIBRARIA_WEB_DIR` | `../web/dist` next to this package, if it exists; empty disables |
| `oauth.google`, `oauth.dropbox` | — | none; client ids reported in `/api/v1/info` |
| `rateLimit.anonymous`, `rateLimit.auth` | — | `{capacity, refillPerSecond}` per IP: 120 / 2 and 20 / 0.2 |

The data directory holds everything: `libraria.db` (+ WAL files), `secret.key`, `books/` (uploaded books, content-addressed by SHA-512), `covers/` and `uploads/` (submissions in progress or awaiting review). Back up by copying it while the server is stopped.

## HTTPS

HTTPS is required: browsers run the offline PWA only in a secure context, and an HTTPS client cannot call an HTTP server. Put the server behind one of these and set `publicUrl` (and `trustProxy` when a proxy sits in front):

- **Caddy** (automatic certificates): `books.example.org { reverse_proxy localhost:8080 }`, then `LIBRARIA_PUBLIC_URL=https://books.example.org LIBRARIA_TRUST_PROXY=1`.
- **Tailscale**: `tailscale serve --bg 8080` gives `https://<machine>.<tailnet>.ts.net` with a valid certificate, reachable from your tailnet.
- **Cloudflare Tunnel**: `cloudflared tunnel --url http://localhost:8080` (or a named tunnel for a stable hostname). No open ports needed.

## API

Versioned under `/api/v1`. The contract is `packages/core/src/api.ts`. Notes beyond the types there:

- Bearer tokens only (no cookies). Sessions last 90 days and roll forward on use.
- `PUT /sync/keys` creates keys once. To overwrite existing keys send `X-Libraria-Replace-Keys: 1`. `POST /me/password` re-wraps the data key in place. `DELETE /sync` wipes the user's keys and records.
- `DELETE /submissions/:id` cancels an upload or pending submission; `GET /submissions/:id/file` lets reviewers open a pending file.
