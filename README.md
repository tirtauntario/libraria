# Libraria

An offline-first reader for EPUB, PDF and comics (CBZ, CBR), delivered as a PWA.

- Works fully offline, no server needed.
- Libraries can combine several sources: files on this device, a local folder, WebDAV, Google Drive, Dropbox, and Libraria servers.
- Anyone can run a **Libraria server**: a self-hosted community library where members read and download books and can contribute their own.
- Progress, bookmarks and settings sync through a server of your choice, end-to-end encrypted.

Open it at **https://tirtauntario.github.io/libraria/**, or at the address of any Libraria server.

## Install the app

Libraria is a web app you can install on your home screen. Installed, it opens full screen, works offline, and keeps its books more reliably than a browser tab.

Your books and progress belong to the address you installed from. The GitHub Pages app and a server's app are separate libraries, so pick one address as your app and add servers inside it (**Servers → Add server**).

### Android

1. Open the address in **Chrome**.
2. Open the **⋮** menu and choose **Install app** (on some versions: **Add to Home screen → Install**). Libraria's **Settings → Install Libraria** has an **Install** button that does the same.
3. Libraria appears in your app drawer and home screen.

Other browsers: in **Samsung Internet**, open the menu and choose **Add page to → Home screen**. In **Firefox**, open the menu and choose **Install** or **Add to Home screen**.

### iPhone and iPad

1. Open the address in **Safari**. (Chrome and Edge also work on iOS 16.4 or later; use the same Share menu.)
2. Tap **Share**, then **Add to Home Screen**. If you see **Open as Web App**, leave it on.
3. Tap **Add**, then open Libraria from the home screen.

On iOS and iPadOS:

- **Install before adding books.** The home-screen app has its own storage, separate from Safari, so books added in a Safari tab do not show up in the installed app.
- Safari can clear a website's data after a few weeks of not using it. The installed app is exempt, so use it for your library.
- Removing the app from the home screen deletes its books and progress. Sync with a server first if you want to keep them.

### Desktop

In Chrome or Edge, click the install icon in the address bar, or use the browser menu → **Install Libraria**. In Safari on macOS, choose **File → Add to Dock**. Firefox on desktop cannot install web apps; Libraria still works in a tab.

**Settings** in the app shows the steps for the browser you are using. When a new version is published, the app says so; tap **Reload** to update.

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
