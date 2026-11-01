<script lang="ts">
  import { INSTALL_HELP, pwa } from '../lib/stores/pwa.svelte';
  import Icon from '../lib/ui/Icon.svelte';
  import Logo from '../lib/ui/Logo.svelte';
  import { APP_BUILD } from '../lib/version';

  let { params: _params }: { params: Record<string, string> } = $props();
</script>

<div class="page narrow">
  <header class="page-header">
    <h1>About Libraria</h1>
  </header>

  <section class="hero card">
    <Logo size={56} />
    <div>
      <p class="lead">Read all your ebooks and comics in one place, and share a library with your community.</p>
      <p class="muted">Reads EPUB, PDF, CBZ and CBR files.</p>
    </div>
  </section>

  <section class="card group">
    <h2>Libraria has two parts</h2>
    <div class="parts">
      <div class="part">
        <h3><Icon name="device" size={18} /> Libraria app</h3>
        <p class="tag">What you are using now. Everyone needs it.</p>
        <ul>
          <li>The reader, installed on your phone, tablet or computer.</li>
          <li>Keeps your books on this device and works offline.</li>
          <li>No account. Works fully on its own.</li>
        </ul>
      </div>
      <div class="part">
        <h3><Icon name="cloud" size={18} /> Libraria server</h3>
        <p class="tag">Optional. Run by someone for a group.</p>
        <ul>
          <li>A shared library on a computer its <strong>owner</strong> controls.</li>
          <li><strong>Members</strong> join from their app, read and download books, and suggest new ones for the owner or a curator to approve.</li>
          <li>Can also sync your progress and bookmarks between your devices, encrypted.</li>
        </ul>
      </div>
    </div>
    <p class="muted fit">
      To join a server, open <a href="#/servers">Servers</a> and add the address you were given. One app can join many servers.
      Servers do not talk to each other, and there is no central Libraria server or company in the middle.
    </p>
  </section>

  <section class="card group">
    <h2>Why Libraria exists</h2>
    <ul class="reasons">
      <li>
        <Icon name="book" />
        <div>
          <h3>One simple place for everything you read</h3>
          <p>Ebooks, PDFs and comics usually need different apps. Libraria opens them all in one app, with one library and your place saved in every book.</p>
        </div>
      </li>
      <li>
        <Icon name="library" />
        <div>
          <h3>Sharing with a community should be easy</h3>
          <p>With a Libraria server, a class, club, family or team gets a shared library it runs itself. Members find the books in their app, read them, and keep copies for offline reading.</p>
        </div>
      </li>
    </ul>
    <h3 class="sub">What else to expect</h3>
    <ul class="facts">
      <li><strong>Works offline.</strong> Books open on a plane, underground or with no signal.</li>
      <li><strong>No sign-up, no tracking.</strong> The app reports nothing about what you read. It only connects to places you add yourself, such as a server, a WebDAV folder, Google Drive or Dropbox.</li>
      <li><strong>Private sync.</strong> Progress and bookmarks are encrypted on your device before they reach a server, so the server cannot read them.</li>
      <li><strong>Free software.</strong> Anyone can use it, read how it works, run their own copy, or help improve it.</li>
    </ul>
  </section>

  <section class="card group">
    <h2>What is a PWA?</h2>
    <p>The Libraria app is a <strong>progressive web app</strong>, or PWA: a website that you can install and use like a normal app.</p>
    <ul class="facts">
      <li><strong>No app store.</strong> Open Libraria's address in your browser and add it to your home screen, dock or start menu. It gets its own icon and window.</li>
      <li><strong>Works offline.</strong> After your first visit the app is saved on your device, so it starts even with no connection.</li>
      <li><strong>Updates itself.</strong> When a new version is out, Libraria tells you and updates in a moment. There is nothing to download by hand.</li>
      <li><strong>One address, one library.</strong> Your books are kept by the browser for the address you opened Libraria from. A server's copy of the app, or any other address, starts a separate, empty library, so pick one and stick with it.</li>
    </ul>

    <div class="install">
      {#if pwa.installed}
        <p class="installed"><Icon name="check" size={18} /> Libraria is installed on this device.</p>
      {:else}
        <p><strong>Install it on this device:</strong> {INSTALL_HELP[pwa.platform]}</p>
        {#if pwa.canPrompt}<button class="btn primary" type="button" onclick={() => pwa.promptInstall()}>Install Libraria</button>{/if}
      {/if}
    </div>
  </section>

  <section class="card group">
    <h2>What people use it for</h2>
    <ul class="facts">
      <li>Public-domain classics from Project Gutenberg, Standard Ebooks or Wikisource.</li>
      <li>Open textbooks, such as OpenStax or LibreTexts, shared with a class.</li>
      <li>Student papers for grading: students submit papers to a professor's private library.</li>
      <li>Open-access research for a reading group or lab.</li>
      <li>Your own work: drafts for beta readers, comics for your supporters, zines for your group.</li>
      <li>Openly licensed comics, such as Pepper&amp;Carrot, and public-domain Golden Age comics.</li>
      <li>Documents your organisation owns: manuals, handbooks, training material.</li>
      <li>Family archives: scanned letters, recipes and photo books.</li>
      <li>Your own DRM-free books, read and synced across your own devices.</li>
    </ul>
  </section>

  <section class="card group notice">
    <h2>Your content, your responsibility</h2>
    <p>Libraria is software only. It comes with no books, and the people who make it do not run any server or see what you read or share.</p>
    <ul class="facts">
      <li><strong>Only add or share content you have the right to share:</strong> your own work, public-domain works, works under a licence that allows it, or works you have permission for. Buying a book does not by itself give you the right to share it.</li>
      <li><strong>Readers</strong> are responsible for the files they import and anything they send to a server.</li>
      <li><strong>Server owners and curators</strong> are responsible for what their server publishes, which submissions they accept, and for answering copyright or takedown requests. Complaints about a server's content go to its owner.</li>
      <li>Libraria does not remove DRM or other copy protection.</li>
      <li>Libraria is provided as is, without any warranty. Its authors and contributors are not party to, and not liable for, any dispute or claim about content that users or servers store or share.</li>
    </ul>
    <p class="muted">This is not legal advice; laws differ between countries. <a href={`${__SOURCE_URL__}/blob/main/DISCLAIMER.md`} target="_blank" rel="noopener noreferrer">Read the full disclaimer</a>.</p>
  </section>

  <section class="card group">
    <h2>Good to know</h2>
    <dl class="faq">
      <dt>Where are my books?</dt>
      <dd>On this device, inside the Libraria app's storage. They are not uploaded anywhere unless you choose to send a book to a server.</dd>
      <dt>Do I need a server?</dt>
      <dd>No. The app works on its own. A server is only for sharing books with a group or syncing between your devices, and someone in the group runs it.</dd>
      <dt>Can I lose my books?</dt>
      <dd>Clearing your browser's data, or removing the installed app, also removes the books stored in it. Keep your original files, or use a server, if you want a copy elsewhere.</dd>
      <dt>Does it cost anything?</dt>
      <dd>No. Libraria is free.</dd>
    </dl>
  </section>

  <p class="footer subtle">
    Libraria {APP_BUILD.full} · <a href="#/changelog">What's new</a> · Free software under the
    <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noopener noreferrer">GNU AGPL-3.0</a> ·
    <a href={__SOURCE_URL__} target="_blank" rel="noopener noreferrer">Source code</a>
  </p>
</div>

<style>
  .narrow {
    max-width: 760px;
  }
  .hero {
    display: flex;
    align-items: center;
    gap: 18px;
    padding: 20px;
    margin-bottom: 16px;
  }
  .lead {
    margin: 0 0 6px;
    font-size: 17px;
    line-height: 1.5;
  }
  .hero .muted {
    margin: 0;
  }
  .group {
    padding: 18px 20px;
    margin-bottom: 16px;
  }
  h2 {
    font-size: 17px;
    margin-bottom: 10px;
  }
  h3 {
    margin: 0 0 4px;
    font-size: 15px;
  }
  p,
  dd {
    line-height: 1.55;
  }
  .reasons {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 16px;
  }
  .reasons li {
    display: grid;
    grid-template-columns: 24px 1fr;
    gap: 12px;
    align-items: start;
  }
  .reasons li > :global(svg) {
    margin-top: 2px;
    color: var(--accent);
  }
  .reasons p {
    margin: 0;
    color: var(--text-2);
  }
  .facts {
    margin: 10px 0 0;
    padding-left: 20px;
    display: grid;
    gap: 8px;
  }
  .install {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px 16px;
    margin-top: 16px;
    padding: 12px 14px;
    border-radius: var(--radius);
    background: var(--accent-soft);
  }
  .install p {
    margin: 0;
    flex: 1 1 260px;
  }
  .install .installed {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .faq {
    margin: 0;
  }
  .faq dt {
    font-weight: 600;
    margin-top: 12px;
  }
  .faq dt:first-child {
    margin-top: 0;
  }
  .faq dd {
    margin: 2px 0 0;
    color: var(--text-2);
  }
  .parts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 12px;
  }
  .part {
    padding: 14px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .part h3 {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .part .tag {
    margin: 0 0 8px;
    font-size: 13px;
    color: var(--text-3);
  }
  .part ul {
    margin: 0;
    padding-left: 18px;
    display: grid;
    gap: 6px;
    color: var(--text-2);
  }
  .fit {
    margin: 12px 0 0;
  }
  .sub {
    margin-top: 18px;
  }
  .notice {
    border-left: 3px solid var(--accent);
  }
  .notice p {
    margin: 0 0 8px;
  }
  .notice .muted {
    margin: 12px 0 0;
  }
  .footer {
    margin: 4px 0 24px;
    font-size: 13px;
    text-align: center;
  }
</style>
