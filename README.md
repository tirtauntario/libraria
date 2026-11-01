# Libraria

Read all your ebooks and comics in one place, and share a library with your community.

## Libraria has two parts

| | **Libraria app** | **Libraria server** |
|---|---|---|
| **What it is** | The reader. An app you install on your phone, tablet or computer. | A shared library that one person runs for a group. |
| **Do I need it?** | Yes. This is what you read with. | No. It is optional, for sharing with a group or syncing your devices. |
| **Who uses it** | Every reader. | An **owner** sets it up and looks after it, **curators** can help, and **members** connect to it from their app. |
| **Where it runs** | In your browser, on your own device. | On a computer the owner controls: a home server, Raspberry Pi, NAS or rented server. |
| **Where the books are** | On your device. | On the server, for its members to read and download. |
| **Account** | None. | Members register on each server they join. |
| **What it does** | Reads EPUB, PDF, CBZ and CBR, works offline, organises your libraries, and can also open books from a folder, WebDAV, Google Drive or Dropbox. | Members browse, read and download its books (also for offline reading) and can suggest new ones, which the owner or a curator approves. It can also sync your progress and bookmarks between your devices, encrypted. |
| **How to get it** | Open **https://tirtauntario.github.io/libraria/** and install it. | Run it yourself: see [Running a Libraria server](#running-a-libraria-server). |

**How they fit together**

- The app works completely on its own. You never need a server to read.
- To join a server, open the app, go to **Servers → Add server**, and enter the address you were given.
- One app can join many servers. Servers never talk to each other, and there is no central Libraria server or company in the middle.
- Each server also serves its own copy of the app at its address. Each address keeps a separate library on your device, so choose one address as your app and add servers inside it.

## Why Libraria exists

1. **One simple place for everything you read.** Ebooks, PDFs and comics usually need different apps. Libraria opens EPUB, PDF, CBZ and CBR in one app, with one library and your place saved in every book.
2. **Sharing with a community should be easy.** With a Libraria server, a class, club, family or team gets a shared library it runs itself. Members find the books in their app, read them, and keep copies for offline reading.

What else to expect:

- **Works offline.** Books open on a plane, underground or with no signal.
- **No sign-up, no tracking.** The app has no account and reports nothing about what you read. It only connects to places you add.
- **Private sync.** Progress and bookmarks are encrypted on your device before they reach a server, so the server cannot read them.
- **Free software** under the AGPL: use it, study it, run your own copy, improve it.

## Content, rights and responsibility

<!-- Same text as DISCLAIMER.md. Change both together. -->

Libraria is software for reading and sharing files. It is not a store, a publisher or a content service, and it comes with no books. Whatever you read or share with it, you bring yourself.

This section explains who is responsible for what. It is not legal advice. Copyright and privacy law differ from country to country, so if you are unsure whether you may share something, ask the rights holder or a lawyer first.

### Have the rights before you share

**Everyone who adds content is responsible for it.** That means both:

- **Readers using the Libraria app**, who import files and may send them to a server, and
- **Server operators** (owners and curators), who publish books from the server's disk, accept submissions from members, and decide who can download them.

Before you store, upload, publish or share a file, make sure you have the right to do so. That right can come from:

- owning the work yourself (you wrote, drew or scanned something you hold the rights to),
- the work being in the **public domain** where you and your readers live,
- a **licence** that allows it, such as a Creative Commons licence, an open-access licence, or a written agreement with the rights holder, or
- explicit **permission** from the rights holder.

Buying a book does not by itself give you the right to share it. Many store licences, including for files without copy protection, allow personal use only.

Libraria does not remove DRM or any other copy protection, and must not be used to get around it.

### What people use Libraria for

These are examples of sharing that is usually allowed. Check the terms of each source; they can change and can differ by country.

- **Public-domain classics** from [Project Gutenberg](https://www.gutenberg.org/), [Standard Ebooks](https://standardebooks.org/) or [Wikisource](https://wikisource.org/). Public-domain status depends on the country: Project Gutenberg, for example, checks US copyright law and asks readers elsewhere to check their own.
- **Open textbooks** for a class, such as [OpenStax](https://openstax.org/) or [LibreTexts](https://libretexts.org/), shared under their Creative Commons licences.
- **Student papers for grading.** A professor runs a private library, students submit their papers as members, and the professor reviews them. Papers contain students' personal data, so follow your institution's rules and privacy laws (for example FERPA in the US or the GDPR in the EU).
- **Open-access research** for a reading group or lab, when each paper's licence allows redistribution (many papers on arXiv and in open-access journals use CC BY; some do not).
- **Your own writing and art.** An author sharing drafts with beta readers, a comic artist sharing pages with supporters, a writing group or zine collective swapping work.
- **Openly licensed comics**, such as [Pepper&Carrot](https://www.peppercarrot.com/) (CC BY), and Golden Age comics that are in the public domain.
- **Organisation documents** you own: manuals, handbooks, training material and policies shared with staff or volunteers.
- **Government publications** that are in the public domain or published under an open licence.
- **Game groups** sharing house rules or openly licensed rulebooks, such as material released under Creative Commons.
- **Family archives**: scanned letters, recipes, photo books and children's drawings bound as comics.
- **Your own DRM-free books, for yourself.** Reading them on all your devices and syncing your progress is personal use. Sharing them with others is a different matter and depends on the licence.

### Servers are independent

Libraria is decentralised. Every server is run by its own operator, and servers do not talk to each other. The people who make Libraria do not run, host, monitor or control any server or the content on it, and cannot add, change or remove content on a server they do not operate.

- Questions or complaints about content on a server, including copyright notices and takedown requests, go to **that server's operator**.
- Server operators decide who may join, which submissions to accept, and how to respond to such requests. They are responsible for following the laws that apply to them.
- The hosted copy of the Libraria app (for example on GitHub Pages) is only the reader. Your books stay in your own browser; they are never uploaded to it.

### No warranty and no liability

Libraria is free software, licensed under the [GNU Affero General Public License, version 3 or later](LICENSE). As the licence says in sections 15 and 16, it is provided **"as is", without warranty of any kind**, and to the extent permitted by law its authors and contributors are **not liable for any damages** arising from its use or inability to use it, including loss of data.

In particular, the authors and contributors of Libraria:

- are not a party to any dispute between users, server operators, rights holders or anyone else about content stored, read or shared with Libraria,
- do not endorse, review or take responsibility for any content that users or server operators choose to store or share, and
- accept no liability for any claim, loss or legal action that results from content you add, or from how you or your server's members use it.

By using Libraria or running a Libraria server, you accept that you are solely responsible for the content you add and share, and for complying with the copyright, licensing and privacy laws that apply to you.

## Using the Libraria app

### What is a PWA?

The Libraria app is a **progressive web app** (PWA): a website you can install and use like a normal app. There is no app store. Open the address and add it to your home screen, dock or start menu. After the first visit it works offline, and it updates itself when a new version is out. The app explains this too, under **About Libraria**.

Installed, it opens full screen and keeps its books more reliably than a browser tab.

### Install on Android

1. Open the address in **Chrome**.
2. Open the **⋮** menu and choose **Install app** (on some versions: **Add to Home screen → Install**). Libraria's **Settings → Install Libraria** has an **Install** button that does the same.
3. Libraria appears in your app drawer and home screen.

Other browsers: in **Samsung Internet**, open the menu and choose **Add page to → Home screen**. In **Firefox**, open the menu and choose **Install** or **Add to Home screen**.

### Install on iPhone and iPad

1. Open the address in **Safari**. (Chrome and Edge also work on iOS 16.4 or later; use the same Share menu.)
2. Tap **Share**, then **Add to Home Screen**. If you see **Open as Web App**, leave it on.
3. Tap **Add**, then open Libraria from the home screen.

On iOS and iPadOS:

- **Install before adding books.** The home-screen app has its own storage, separate from Safari, so books added in a Safari tab do not show up in the installed app.
- Safari can clear a website's data after a few weeks of not using it. The installed app is exempt, so use it for your library.
- Removing the app from the home screen deletes its books and progress. Sync with a server first if you want to keep them.

### Install on a computer

In Chrome or Edge, click the install icon in the address bar, or use the browser menu → **Install Libraria**. In Safari on macOS, choose **File → Add to Dock**. Firefox on desktop cannot install web apps; Libraria still works in a tab.

**Settings** in the app shows the steps for the browser you are using. When a new version is published, the app says so; tap **Reload** to update.

### Opening books from other apps

Once installed, the app can receive EPUB, PDF, CBZ and CBR files from the rest of the system:

- **Android:** in a file manager, Downloads, a chat or email app, tap **Share** on a book and choose **Libraria**. The app opens and imports it. If you installed Libraria before this was added, Chrome picks up the change within about a day; reinstalling makes it immediate.
- **Computer (Chrome, Edge):** right-click a book → **Open with → Libraria**, or set Libraria as the default app for that file type.
- **iPhone and iPad:** iOS does not let web apps register for files or appear in the share sheet. In Libraria, tap **Add books** and pick files from the Files app (iCloud Drive, On My iPhone, or connected storage).

## Running a Libraria server

You only need this if you want to host a shared library for a group, or a sync home for your own devices. Readers who just join someone else's server do not need it.

What you need:

- A computer that stays on: a home server, Raspberry Pi, NAS or rented server. The server is one Node.js process with one database file; no other services.
- An **HTTPS** address. Browsers only let the app talk to a server over HTTPS. Caddy, Tailscale and Cloudflare Tunnel all work; see the [server guide](apps/server/README.md#https).
- The rights to everything you publish (see [Content, rights and responsibility](#content-rights-and-responsibility)).

Start it with Docker:

```bash
docker build -f apps/server/Dockerfile -t libraria .
docker run -p 8080:8080 -v libraria-data:/data libraria
```

Or with Node.js 24+ and pnpm 10:

```bash
pnpm install && pnpm build
node apps/server/dist/index.js
```

On first start the server prints a **one-time setup token**. Open the Libraria app, go to **Servers → Add server**, and enter the server's address and the token. You become the **owner**. Then invite members, add curators, and add books. Configuration, backups and HTTPS are covered in the [server guide](apps/server/README.md).

## For developers

This repository holds both parts and the code they share:

| Folder | What |
|---|---|
| `apps/web` | The Libraria app (Svelte PWA). See [apps/web/README.md](apps/web/README.md). |
| `apps/server` | The Libraria server (Express, SQLite). See [apps/server/README.md](apps/server/README.md). |
| `packages/core` | Code both use: the API contract, encryption, sync rules, book metadata. |

Run the app in development (no server needed):

```bash
pnpm install
pnpm dev:web
```

Design and decisions are in [docs/plan.md](docs/plan.md).

### Versions and releases

Libraria uses [Semantic Versioning](https://semver.org/). The app and the server share **one version number**, kept in the root `package.json` and copied to every package (a test fails if they drift apart). For this project:

- **Major** (`1.0.0` → `2.0.0`): something people must act on, such as a new server API version, data that needs migrating, or a removed feature.
- **Minor** (`1.1.0` → `1.2.0`): new features that keep working with existing servers and data.
- **Patch** (`1.2.0` → `1.2.1`): fixes only.

The server API has its own number (`/api/v1`) that changes only when the API breaks, so apps and servers of different versions keep working together.

To release:

1. While working, add notes under **Unreleased** in [CHANGELOG.md](CHANGELOG.md).
2. On a clean `main`, run `pnpm release patch` (or `minor`, `major`, or an exact version such as `1.0.0-rc.1`). Add `--dry-run` to preview. It sets the version everywhere, moves the notes under the new version and date, commits `Release vX.Y.Z` and tags `vX.Y.Z`.
3. Push the commit and the tag: `git push origin main vX.Y.Z`. The [Release workflow](.github/workflows/release.yml) publishes a GitHub Release with those notes.

**In the app**, **Settings → App** shows the version and build, and **What's new** lists the changes. After an update the app says which version it was updated to. A server's version is shown on its **Account** tab and returned by `GET /api/v1/info`.

**Build metadata.** A build made exactly from a release tag reports the plain version. Any other build adds its commit, such as `0.2.0+9d74586`, and `.dirty` if it had uncommitted changes, so a build from `main` can be told apart from the release. Docker builds have no `.git`: pass `--build-arg LIBRARIA_BUILD_COMMIT=$(git rev-parse HEAD)`, and `--build-arg LIBRARIA_RELEASE=1` when building a release.

## License

Libraria is free software under the [GNU AGPL-3.0-or-later](LICENSE). See also the [disclaimer](DISCLAIMER.md).
