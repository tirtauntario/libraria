<script lang="ts">
  import type { Bookmark } from '@libraria/core';
  import { bookPanels } from '../lib/extensions';
  import { deleteBook, editBook } from '../lib/library/books';
  import { groupKey } from '../lib/library/catalog';
  import { removeOfflineCopy, setPinned } from '../lib/library/offline';
  import { keepOffline } from '../lib/library/open';
  import { net } from '../lib/net.svelte';
  import { href, router } from '../lib/router.svelte';
  import { services } from '../lib/services';
  import { catalog } from '../lib/stores/catalog.svelte';
  import { versions } from '../lib/stores/data.svelte';
  import { toasts } from '../lib/stores/toasts.svelte';
  import BookCover from '../lib/ui/BookCover.svelte';
  import Dialog from '../lib/ui/Dialog.svelte';
  import Icon from '../lib/ui/Icon.svelte';
  import { FORMAT_LABEL, formatBytes, formatPercent, formatRelative } from '../lib/ui/format';

  let { params }: { params: Record<string, string> } = $props();

  const book = $derived(catalog.book(params.id ?? ''));
  const files = $derived(catalog.files.filter((f) => f.bookId === params.id));
  const offline = $derived(catalog.offline.get(params.id ?? ''));
  const onDevice = $derived(catalog.onDevice(params.id ?? ''));
  const hasLocalFile = $derived(files.some((f) => f.sourceId === catalog.localSourceId));
  const sourceName = (id: string) => catalog.sources.find((s) => s.id === id)?.name ?? 'Unknown source';
  const sourceKind = (id: string) => catalog.sources.find((s) => s.id === id)?.config.kind;
  const unavailable = $derived(catalog.unavailableIds.has(params.id ?? ''));
  /** Only in a linked folder: offer to copy it in, in case the folder goes away. */
  const folderOnly = $derived(!hasLocalFile && files.some((f) => !f.missing && sourceKind(f.sourceId) === 'folder'));

  let bookmarks = $state<Bookmark[]>([]);
  $effect(() => {
    void versions.bookmarks;
    const sha = book?.sha512;
    if (!sha) {
      bookmarks = [];
      return;
    }
    void services()
      .repo.listBookmarks(sha)
      .then((b) => (bookmarks = b));
  });

  let editOpen = $state(false);
  let draft = $state({ title: '', authors: '', series: '', customGroup: '' });
  function startEdit() {
    if (!book) return;
    draft = {
      title: book.title,
      authors: book.authors.join(', '),
      series: book.series ?? '',
      customGroup: book.customGroup ?? '',
    };
    editOpen = true;
  }
  async function saveEdit(e: SubmitEvent) {
    e.preventDefault();
    if (!book) return;
    await editBook(
      book.id,
      { title: draft.title, series: draft.series, customGroup: draft.customGroup, authors: draft.authors.split(',') },
      services(),
    );
    editOpen = false;
    toasts.show('Saved', { kind: 'success', timeout: 2500 });
  }

  let deleteOpen = $state(false);
  async function confirmDelete() {
    if (!book) return;
    const title = book.title;
    deleteOpen = false;
    await deleteBook(book.id, services());
    toasts.show(`Removed “${title}”`);
    router.back('/');
  }

  let downloading = $state(false);
  async function download() {
    if (!book) return;
    downloading = true;
    try {
      await keepOffline(book.id, services());
      toasts.show('Saved for offline reading', { kind: 'success' });
    } catch (err) {
      toasts.error('Could not download', err instanceof Error ? err.message : String(err));
    } finally {
      downloading = false;
    }
  }

  const groups = $derived([...new Set(catalog.books.map((b) => b.customGroup).filter((g): g is string => !!g))].sort());
</script>

<div class="page">
  <header class="page-header">
    <button class="icon-btn" type="button" aria-label="Back" onclick={() => router.back('/')}><Icon name="arrow-left" /></button>
    <h1 class="visually-hidden">{book?.title ?? 'Book'}</h1>
    <span class="spacer"></span>
    {#if book}
      <button class="btn ghost" type="button" onclick={startEdit}><Icon name="edit" size={18} /> Edit</button>
    {/if}
  </header>

  {#if !book}
    <p class="muted">This book is no longer in your library.</p>
  {:else}
    <div class="layout">
      <div class="cover"><BookCover cover={book.cover} title={book.title} format={book.format} eager /></div>

      <div class="main">
        <p class="kicker">
          {FORMAT_LABEL[book.format]}{#if book.series}&nbsp;· {book.series}{#if book.seriesIndex != null}&nbsp;#{book.seriesIndex}{/if}{/if}
        </p>
        <h2 class="title">{book.title}</h2>
        {#if book.authors.length}<p class="authors">{book.authors.join(', ')}</p>{/if}

        <div class="progress-row">
          {#if book.percent != null}
            <div class="bar" aria-hidden="true"><div style:width={formatPercent(book.percent)}></div></div>
            <span>{formatPercent(book.percent)} read · {formatRelative(book.lastReadAt)}</span>
          {:else}
            <span class="subtle">Not started</span>
          {/if}
        </div>

        {#if unavailable}
          <p class="gone" role="status">
            <Icon name="alert" size={18} /> This book was removed from its source and there is no copy on this device. Its progress and bookmarks are kept.
          </p>
        {/if}

        <div class="actions">
          <a class="btn primary big" href={href('/read', book.id)} aria-disabled={unavailable}>
            <Icon name="book" size={18} />
            {book.percent ? 'Continue reading' : 'Start reading'}
          </a>
        </div>

        {#if book.description}
          <p class="description">{book.description}</p>
        {/if}

        <dl class="facts">
          {#if book.pageCount}<div><dt>Pages</dt><dd>{book.pageCount}</dd></div>{/if}
          <div><dt>Size</dt><dd>{formatBytes(book.fileSize)}</dd></div>
          {#if book.publisher}<div><dt>Publisher</dt><dd>{book.publisher}</dd></div>{/if}
          {#if book.language}<div><dt>Language</dt><dd>{book.language}</dd></div>{/if}
          <div><dt>Group</dt><dd>{book.customGroup ?? groupKey(book)}</dd></div>
          <div><dt>Added</dt><dd>{formatRelative(book.addedAt)}</dd></div>
        </dl>

        <section>
          <h3>Bookmarks</h3>
          {#if bookmarks.length === 0}
            <p class="subtle small">No bookmarks yet. Add them from the reader.</p>
          {:else}
            <ul class="bookmarks">
              {#each bookmarks as bm (bm.id)}
                <li>
                  <a href="{href('/read', book.id)}?bookmark={bm.id}">
                    <Icon name="bookmark" size={16} />
                    <span class="bm-label">{bm.label}</span>
                    <span class="subtle">{formatRelative(bm.createdAt)}</span>
                  </a>
                  <button class="icon-btn" type="button" aria-label="Delete bookmark {bm.label}" onclick={() => services().repo.deleteBookmark(bm.id)}>
                    <Icon name="trash" size={16} />
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </section>

        <section>
          <h3>Where it lives</h3>
          <ul class="where">
            {#each files as f (f.id)}
              <li>
                <Icon name={f.sourceId === catalog.localSourceId ? 'device' : sourceKind(f.sourceId) === 'folder' ? 'folder' : 'cloud'} size={18} />
                <div>
                  <p>{sourceName(f.sourceId)}{#if f.missing}<span class="chip warn">Removed from source</span>{/if}</p>
                  <p class="subtle small path" title={f.displayPath || f.path}>{(f.displayPath || f.path).split('/').pop()}</p>
                </div>
              </li>
            {/each}
            {#if offline}
              <li>
                <Icon name="download" size={18} />
                <div>
                  <p>Offline copy {offline.pinned ? '· kept' : ''}</p>
                  <p class="subtle small">{formatBytes(offline.size)} · opened {formatRelative(offline.lastOpenedAt)}</p>
                </div>
              </li>
            {/if}
          </ul>

          <div class="offline-actions">
            {#if hasLocalFile}
              <p class="subtle small"><Icon name="check" size={14} /> Stored on this device. Always available offline.</p>
            {:else if offline}
              <label class="toggle">
                <input type="checkbox" checked={offline.pinned} onchange={(e) => setPinned(book.id, e.currentTarget.checked, services())} />
                <span>Keep offline (never remove automatically)</span>
              </label>
              <button class="btn small" type="button" onclick={() => removeOfflineCopy(book.id, services())}>
                Remove offline copy
              </button>
            {:else if folderOnly}
              <p class="subtle small"><Icon name="check" size={14} /> In a folder on this device.</p>
              <button class="btn small" type="button" onclick={download} disabled={downloading}>
                <Icon name="download" size={16} />
                {downloading ? 'Copying…' : 'Keep a copy in Libraria'}
              </button>
            {:else if !onDevice && !unavailable}
              <button class="btn small" type="button" onclick={download} disabled={downloading || !net.online}>
                <Icon name="download" size={16} />
                {downloading ? 'Downloading…' : 'Keep offline'}
              </button>
              {#if !net.online}<p class="subtle small">Connect to download this book.</p>{/if}
            {/if}
          </div>
        </section>

        {#each bookPanels.list() as panel (panel.id)}
          <panel.component {book} />
        {/each}

        <section class="danger-zone">
          <button class="btn ghost danger-text" type="button" onclick={() => (deleteOpen = true)}>
            <Icon name="trash" size={18} /> Delete from library
          </button>
        </section>
      </div>
    </div>
  {/if}
</div>

<Dialog bind:open={editOpen} title="Edit book" size="md">
  <form id="edit-form" class="form" onsubmit={saveEdit}>
    <label class="field"><span>Title</span><input class="input" bind:value={draft.title} required /></label>
    <label class="field"><span>Authors</span><input class="input" bind:value={draft.authors} placeholder="Separate with commas" /></label>
    <label class="field"><span>Series</span><input class="input" bind:value={draft.series} /></label>
    <label class="field">
      <span>Custom group</span>
      <input class="input" bind:value={draft.customGroup} list="groups" placeholder="Overrides the series for grouping" />
      <datalist id="groups">{#each groups as g (g)}<option value={g}></option>{/each}</datalist>
    </label>
  </form>
  {#snippet actions()}
    <button class="btn" type="button" onclick={() => (editOpen = false)}>Cancel</button>
    <button class="btn primary" type="submit" form="edit-form">Save</button>
  {/snippet}
</Dialog>

<Dialog bind:open={deleteOpen} title="Delete this book?">
  <p class="muted">
    {#if hasLocalFile}
      “{book?.title}” and its file are removed from this device.
    {:else}
      “{book?.title}” is removed from this device. The file in its source is not touched.
    {/if}
    Your reading progress and bookmarks are kept.
  </p>
  {#snippet actions()}
    <button class="btn" type="button" onclick={() => (deleteOpen = false)}>Cancel</button>
    <button class="btn danger" type="button" onclick={confirmDelete}>Delete</button>
  {/snippet}
</Dialog>

<style>
  .gone {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    padding: 10px 12px;
    margin: 0 0 12px;
    border-radius: var(--radius);
    background: color-mix(in srgb, var(--warning) 12%, var(--surface));
    font-size: 14px;
  }
  .gone :global(svg) {
    flex: none;
    color: var(--warning);
    margin-top: 1px;
  }
  .chip.warn {
    margin-left: 8px;
    color: var(--warning);
  }
  .page-header {
    margin-bottom: 8px;
  }
  .spacer {
    flex: 1;
  }
  .layout {
    display: grid;
    gap: 24px;
  }
  .cover {
    width: min(200px, 55vw);
    margin: 0 auto;
  }
  @media (min-width: 720px) {
    .layout {
      grid-template-columns: 240px 1fr;
      gap: 40px;
      align-items: start;
    }
    .cover {
      width: 100%;
      position: sticky;
      top: 24px;
    }
  }
  .main {
    min-width: 0;
    max-width: 720px;
  }
  .kicker {
    font-size: 12px;
    font-weight: 650;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--accent);
  }
  .title {
    margin-top: 6px;
    font-family: var(--font-serif);
    font-size: clamp(24px, 4vw, 34px);
    line-height: 1.15;
    overflow-wrap: anywhere;
  }
  .authors {
    margin-top: 6px;
    font-size: 16px;
    color: var(--text-2);
  }
  .progress-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 16px;
    font-size: 13px;
    color: var(--text-2);
  }
  .bar {
    width: 120px;
    height: 5px;
    border-radius: 3px;
    background: var(--surface-3);
    overflow: hidden;
  }
  .bar > div {
    height: 100%;
    background: var(--accent);
  }
  .actions {
    margin-top: 20px;
  }
  .big {
    min-height: 46px;
    padding: 0 22px;
    font-size: 15px;
  }
  .description {
    margin-top: 24px;
    color: var(--text-2);
    line-height: 1.6;
    white-space: pre-line;
  }
  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 14px;
    margin: 24px 0 0;
    padding: 16px 0;
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
  }
  .facts dt {
    font-size: 12px;
    color: var(--text-3);
  }
  .facts dd {
    margin: 2px 0 0;
    font-weight: 550;
    overflow-wrap: anywhere;
  }
  section {
    margin-top: 28px;
  }
  h3 {
    font-size: 15px;
    margin-bottom: 10px;
  }
  .small {
    font-size: 13px;
  }
  .bookmarks,
  .where {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 2px;
  }
  .bookmarks li {
    display: flex;
    align-items: center;
  }
  .bookmarks a {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 40px;
    padding: 0 8px;
    border-radius: var(--radius);
    color: var(--text);
    min-width: 0;
  }
  .bookmarks a:hover {
    background: var(--surface-2);
    text-decoration: none;
  }
  .bm-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .where li {
    display: flex;
    gap: 12px;
    align-items: center;
    padding: 8px 0;
    color: var(--text-2);
  }
  .where p:first-child {
    color: var(--text);
    font-weight: 550;
  }
  .path {
    overflow-wrap: anywhere;
  }
  .offline-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
    margin-top: 10px;
  }
  .offline-actions p {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .toggle {
    display: flex;
    gap: 10px;
    align-items: center;
    font-size: 14px;
  }
  .danger-zone {
    padding-top: 16px;
    border-top: 1px solid var(--border);
  }
  .danger-text {
    color: var(--danger);
  }
  .form {
    display: grid;
    gap: 14px;
  }
</style>
