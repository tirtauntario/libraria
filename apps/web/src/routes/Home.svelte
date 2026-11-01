<script lang="ts">
  import { homeSections } from '../lib/extensions';
  import { bookIdsInLibrary, continueReading } from '../lib/library/catalog';
  import { href } from '../lib/router.svelte';
  import { catalog } from '../lib/stores/catalog.svelte';
  import { importer, pickFiles } from '../lib/stores/importer.svelte';
  import { pwa } from '../lib/stores/pwa.svelte';
  import BookCard from '../lib/ui/BookCard.svelte';
  import BookCover from '../lib/ui/BookCover.svelte';
  import Icon from '../lib/ui/Icon.svelte';
  import Logo from '../lib/ui/Logo.svelte';
  import { formatPercent, plural } from '../lib/ui/format';

  let { params: _params }: { params: Record<string, string> } = $props();

  const reading = $derived(continueReading(catalog.books));
  const recent = $derived([...catalog.books].sort((a, b) => b.addedAt - a.addedAt).slice(0, 12));
  const libraries = $derived(
    catalog.libraries.map((lib) => {
      const ids = bookIdsInLibrary(lib, catalog.files);
      const books = catalog.books.filter((b) => ids.has(b.id));
      return { lib, count: books.length, covers: books.filter((b) => b.cover).slice(0, 3) };
    }),
  );
  const showInstall = $derived(pwa.canPrompt && !pwa.installed && !pwa.dismissed && catalog.books.length > 0);
</script>

<div class="page">
  <header class="page-header">
    <span class="mobile-logo"><Logo size={30} /></span>
    <h1>{catalog.books.length ? 'Reading' : 'Welcome'}</h1>
    {#if catalog.books.length}
      <button class="btn primary add" type="button" onclick={pickFiles} disabled={importer.busy}>
        <Icon name="plus" size={18} /><span>Add books</span>
      </button>
    {/if}
  </header>

  {#if catalog.books.length === 0}
    <section class="empty card">
      <div class="art" aria-hidden="true">
        <Logo size={72} />
      </div>
      <h2>Your library is empty</h2>
      <p class="muted">Add EPUB, PDF, CBZ or CBR files. They are stored in this browser and open without a connection.</p>
      <div class="empty-actions">
        <button class="btn primary" type="button" onclick={pickFiles}><Icon name="plus" size={18} /> Add books</button>
      </div>
      <p class="subtle hint">You can also drop files anywhere on this page.</p>
    </section>
  {:else}
    {#if showInstall}
      <aside class="install card">
        <Icon name="download" />
        <div>
          <p class="strong">Install Libraria</p>
          <p class="muted small">Opens like an app, works offline, and keeps your books safer from storage clean-up.</p>
        </div>
        <button class="btn small primary" type="button" onclick={() => pwa.promptInstall()}>Install</button>
        <button class="icon-btn" type="button" aria-label="Not now" onclick={() => pwa.dismissInstall()}><Icon name="close" size={18} /></button>
      </aside>
    {/if}

    {#if reading.length}
      <section aria-labelledby="continue">
        <h2 id="continue" class="section-title">Continue reading</h2>
        <ul class="shelf">
          {#each reading as book (book.id)}
            <li><a class="shelf-item" href={href('/read', book.id)}>
              <BookCover cover={book.cover} title={book.title} format={book.format} eager />
              <span class="shelf-title">{book.title}</span>
              <span class="shelf-progress">
                <span class="bar"><span style:width={formatPercent(book.percent ?? 0)}></span></span>
                {formatPercent(book.percent ?? 0)}
              </span>
            </a></li>
          {/each}
        </ul>
      </section>
    {/if}

    <section aria-labelledby="libs">
      <div class="section-head">
        <h2 id="libs" class="section-title">Libraries</h2>
        <a class="btn small ghost" href="#/libraries">Manage</a>
      </div>
      <div class="libs">
        {#each libraries as { lib, count, covers } (lib.id)}
          <a class="lib card" href={href('/library', lib.id)}>
            <div class="stack" aria-hidden="true">
              {#each covers as c, i (c.id)}
                <div class="stack-item" style:--i={i}>
                  <BookCover cover={c.cover} title={c.title} format={c.format} />
                </div>
              {:else}
                <div class="stack-empty"><Icon name="library" size={28} /></div>
              {/each}
            </div>
            <div>
              <p class="lib-name">{lib.name}</p>
              <p class="subtle small">{plural(count, 'book')}</p>
            </div>
          </a>
        {/each}
      </div>
    </section>

    <section aria-labelledby="recent">
      <h2 id="recent" class="section-title">Recently added</h2>
      <div class="grid">
        {#each recent as book (book.id)}
          <BookCard {book} remote={!catalog.onDevice(book.id)} unavailable={catalog.unavailableIds.has(book.id)} />
        {/each}
      </div>
    </section>
  {/if}

  {#each homeSections.list() as section (section.id)}
    <section.component />
  {/each}
</div>

<style>
  .mobile-logo {
    display: inline-flex;
  }
  @media (min-width: 900px) {
    .mobile-logo {
      display: none;
    }
  }
  @media (max-width: 480px) {
    .add span {
      display: none;
    }
    .add {
      width: 40px;
      padding: 0;
      border-radius: 999px;
    }
  }
  section + section {
    margin-top: 32px;
  }
  .section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .section-title {
    font-size: 18px;
    margin-bottom: 14px;
  }
  .section-head .section-title {
    margin-bottom: 0;
  }
  .section-head {
    margin-bottom: 12px;
  }
  .small {
    font-size: 13px;
  }
  .strong {
    font-weight: 600;
  }

  .empty {
    display: grid;
    justify-items: center;
    gap: 12px;
    max-width: 520px;
    margin: 8vh auto 0;
    padding: 40px 24px;
    text-align: center;
  }
  .empty h2 {
    font-size: 21px;
  }
  .empty-actions {
    margin-top: 8px;
  }
  .hint {
    font-size: 13px;
  }

  .install {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 14px 10px 14px 18px;
    margin-bottom: 24px;
    color: var(--accent);
  }
  .install > div {
    flex: 1;
    color: var(--text);
  }

  .shelf {
    list-style: none;
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: 128px;
    gap: 18px;
    overflow-x: auto;
    padding: 4px 4px 12px;
    margin: 0 -4px;
    scroll-snap-type: x proximity;
    scrollbar-width: thin;
  }
  @media (min-width: 720px) {
    .shelf {
      grid-auto-columns: 150px;
      gap: 24px;
    }
  }
  .shelf-item {
    display: grid;
    gap: 8px;
    color: var(--text);
    text-decoration: none;
    scroll-snap-align: start;
    min-width: 0;
  }
  .shelf-title {
    font-size: 13.5px;
    font-weight: 600;
    line-height: 1.3;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .shelf-progress {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }
  .bar {
    flex: 1;
    height: 4px;
    border-radius: 2px;
    background: var(--surface-3);
    overflow: hidden;
  }
  .bar > span {
    display: block;
    height: 100%;
    background: var(--accent);
  }

  .libs {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 12px;
  }
  .lib {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 14px 16px;
    color: var(--text);
    text-decoration: none;
    transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
  }
  .lib:hover {
    border-color: var(--border-strong);
    box-shadow: var(--shadow);
    text-decoration: none;
  }
  .lib-name {
    font-weight: 600;
  }
  .stack {
    position: relative;
    width: 76px;
    height: 64px;
    flex: none;
  }
  .stack-item {
    position: absolute;
    top: calc(var(--i) * 3px);
    left: calc(var(--i) * 16px);
    width: 42px;
    z-index: calc(3 - var(--i));
  }
  .stack-empty {
    display: grid;
    place-items: center;
    width: 64px;
    height: 64px;
    border-radius: var(--radius);
    background: var(--surface-2);
    color: var(--text-3);
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
    gap: 24px 18px;
  }
  @media (max-width: 400px) {
    .grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  @media (min-width: 720px) {
    .grid {
      grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
      gap: 28px 24px;
    }
  }
</style>
