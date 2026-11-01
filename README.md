# Libraria

An offline-first reader for EPUB, PDF and comics (CBZ, CBR), delivered as a PWA.

- Works fully offline, no server needed.
- Libraries can combine several sources: files on this device, a local folder, WebDAV, Google Drive, Dropbox, and Libraria servers.
- Anyone can run a **Libraria server**: a self-hosted community library where members read and download books and can contribute their own.
- Progress, bookmarks and settings sync through a server of your choice, end-to-end encrypted.

## Quick start

Requires Node 24+ and pnpm 10.

```bash
pnpm install
pnpm dev:web        # the reader app, no server needed
```

Run a server (serves the app too):

```bash
pnpm build
node apps/server/dist/index.js     # prints a one-time setup token
```

Or with Docker:

```bash
docker build -f apps/server/Dockerfile -t libraria .
docker run -p 8080:8080 -v libraria-data:/data libraria
```

Open the app, go to **Servers → Add server**, enter the address and the setup token to become the owner. Servers need HTTPS for anything beyond localhost; see [apps/server/README.md](apps/server/README.md).

## Docs

- [docs/plan.md](docs/plan.md) — design and decisions
- [apps/web/README.md](apps/web/README.md) — client architecture and extension points
- [apps/server/README.md](apps/server/README.md) — server configuration and deployment

## License

[AGPL-3.0-or-later](LICENSE)
