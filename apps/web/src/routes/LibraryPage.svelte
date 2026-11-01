<script lang="ts">
  import type { LibrarySort } from '@libraria/core';
  import { bookIdsInLibrary, groupCatalog, queryBooks, type CatalogQuery } from '../lib/library/catalog';
  import SourceProblem from '../lib/sources/ui/SourceProblem.svelte';
  import { catalog } from '../lib/stores/catalog.svelte';
  import { describeScan, scannable, scanner } from '../lib/stores/scanner.svelte';
  import { toasts } from '../lib/stores/toasts.svelte';
  import { importer, pickFiles } from '../lib/stores/importer.svelte';
  import { settings } from '../lib/stores/settings.svelte';
  import BookCard from '../lib/ui/BookCard.svelte';
  import BookRow from '../lib/ui/BookRow.svelte';
  import Dialog from '../lib/ui/Dialog.svelte';
  import Icon from '../lib/ui/Icon.svelte';
  import { plural } from '../lib/ui/format';

  let { params }: { params: Record<string, string> } = $props();

  const library = $derived(catalog.libraries.find((l) => l.id === params.id));
  const hasLocal = $derived(!!library?.sources.some((s) => s.sourceId === catalog.localSourceId));
  const ids = $derived(library ? bookIdsInLibrary(library, catalog.files) : new Set<string>());
  const members = $derived(catalog.books.filter((b) => ids.has(b.id)));

  const libSources = $derived(
    (library?.sources ?? []).map((r) => catalog.sources.find((s) => s.id === r.sourceId)).filter((s) => s !== undefined),
  );
  const canRescan = $derived(libSources.some((s) => scannable(s)));
  const scanning = $derived(libSources.filter((s) => scanner.busy(s.id)));
  const found = $derived(scanning.reduce((n, s) => n + (scanner.jobs[s.id]?.found ?? 0), 0));
  const problems = $derived(libSources.filter((s) => scanner.problems[s.id]));

  async function rescan() {
    if (!library) return;
    const { result, failed } = await scanner.scanLibrary(library);
    if (!failed) toasts.show(`${library.name}: ${describeScan(result)}`);
  }

  let search = $state('');
  let format = $state<NonNullable<CatalogQuery['format']>>('all');
  const lib = $derived(settings.synced.library);

  const items = $derived(queryBooks(members, { search, format, sort: lib.sort }));
  const groups = $derived(lib.group ? groupCatalog(items, lib.sort, lib.groupRenames) : []);
  const collapsed = $derived(new Set(settings.ui.collapsedGroups));
  const seriesGroups = $derived(groups.filter((g) => g.isSeries));

  function toggleGroup(key: string) {
    settings.updateUi((ui) => {
      const set = new Set(ui.collapsedGroups);
      if (set.has(key)) set.delete(key);
      else set.add(key);
      ui.collapsedGroups = [...set];
    });
  }

  function setAllCollapsed(value: boolean) {
    settings.updateUi((ui) => {
      const set = new Set(ui.collapsedGroups);
      for (const g of seriesGroups) {
        if (value) set.add(g.key);
        else set.delete(g.key);
      }
      ui.collapsedGroups = [...set];
    });
  }

  let renaming = $state<{ key: string; name: string } | null>(null);
  let renameOpen = $state(false);
  function startRename(key: string, name: string) {
    renaming = { key, name };
    renameOpen = true;
  }
  function saveRename(e: SubmitEvent) {
    e.preventDefault();
    const r = renaming;
    if (!r) return;
    settings.updateSynced((s) => {
      const name = r.name.trim();
      if (!name || name === r.key) delete s.library.groupRenames[r.key];
      else s.library.groupRenames[r.key] = name;
    });
    renameOpen = false;
  }

  const SORTS: { value: LibrarySort; label: string }[] = [
    { value: 'lastRead', label: 'Last read' },
    { value: 'added', label: 'Date added' },
    { value: 'name', label: 'Title' },
  ];
</script>

{#snippet bookList(list: typeof items)}
  {#if lib.view === 'grid'}
    <div class="grid">
      {#each list as book (book.id)}
        <BookCard {book} remote={!catalog.onDevice(book.id)} unavailable={catalog.unavailableIds.has(book.id)} />
      {/each}
    </div>
  {:else}
    <div class="list">
      {#each list as book (book.id)}
        <BookRow {book} remote={!catalog.onDevice(book.id)} unavailable={catalog.unavailableIds.has(book.id)} />
      {/each}
    </div>
  {/if}
{/snippet}

<div class="page">
  {#if !library}
    <header class="page-header"><h1>Library not found</h1></header>
    <p class="muted">It may have been deleted. <a href="#/libraries">See all libraries</a>.</p>
  {:else}
    <header class="page-header">
      <div class="title">
        <h1>{library.name}</h1>
        <p class="subtle">{plural(members.length, 'book')}</p>
      </div>
      {#if canRescan}
        <button class="icon-btn" type="button" aria-label="Rescan library" title="Rescan" onclick={rescan} disabled={scanning.length > 0}>
          <span class:spin={scanning.length > 0}><Icon name="refresh" /></span>
        </button>
      {/if}
      {#if hasLocal}
        <button class="btn primary add" type="button" onclick={pickFiles} disabled={importer.busy}>
          <Icon name="plus" size={18} /><span>Add books</span>
        </button>
      {/if}
    </header>

    {#if scanning.length}
      <p class="scan subtle" aria-live="polite"><span class="spinner small"></span> Scanning {scanning.map((s) => s.name).join(', ')}… {plural(found, 'book')} found</p>
    {/if}
    {#each problems as src (src.id)}
      {@const problem = scanner.problems[src.id]}
      {#if problem}<div class="problem"><SourceProblem source={src} {problem} /></div>{/if}
    {/each}

    {#if members.length > 0}
      <div class="toolbar">
        <label class="search">
          <Icon name="search" size={18} />
          <span class="visually-hidden">Search this library</span>
          <input class="input" type="search" placeholder="Search title, author, series" bind:value={search} />
        </label>
        <div class="controls">
          <label class="visually-hidden" for="fmt">Format</label>
          <select id="fmt" class="input select" bind:value={format}>
            <option value="all">All</option>
            <option value="books">Books</option>
            <option value="comics">Comics</option>
            <option value="epub">EPUB</option>
            <option value="pdf">PDF</option>
            <option value="cbz">CBZ</option>
            <option value="cbr">CBR</option>
          </select>
          <label class="visually-hidden" for="sort">Sort by</label>
          <select
            id="sort"
            class="input select"
            value={lib.sort}
            onchange={(e) => settings.updateSynced((s) => (s.library.sort = (e.currentTarget as HTMLSelectElement).value as LibrarySort))}
          >
            {#each SORTS as s (s.value)}<option value={s.value}>{s.label}</option>{/each}
          </select>
          <button
            class="icon-btn"
            type="button"
            aria-pressed={lib.group}
            aria-label="Group by series"
            title="Group by series"
            onclick={() => settings.updateSynced((s) => (s.library.group = !s.library.group))}
          >
            <Icon name="layers" />
          </button>
          <button
            class="icon-btn"
            type="button"
            aria-label={lib.view === 'grid' ? 'Show as list' : 'Show as grid'}
            title={lib.view === 'grid' ? 'Show as list' : 'Show as grid'}
            onclick={() => settings.updateSynced((s) => (s.library.view = s.library.view === 'grid' ? 'list' : 'grid'))}
          >
            <Icon name={lib.view === 'grid' ? 'list' : 'grid'} />
          </button>
        </div>
      </div>
    {/if}

    {#if members.length === 0}
      <div class="empty">
        <Icon name="library" size={36} />
        <p>{scanning.length ? 'Looking for books…' : 'No books here yet.'}</p>
        {#if hasLocal}
          <button class="btn primary" type="button" onclick={pickFiles}><Icon name="plus" size={18} /> Add books</button>
        {:else}
          <a class="btn" href="#/libraries">Choose sources</a>
        {/if}
      </div>
    {:else if items.length === 0}
      <p class="empty muted">No books match your search.</p>
    {:else if lib.group}
      {#if seriesGroups.length > 1}
        <div class="group-actions">
          <button class="btn small ghost" type="button" onclick={() => setAllCollapsed(true)}>Collapse all</button>
          <button class="btn small ghost" type="button" onclick={() => setAllCollapsed(false)}>Expand all</button>
        </div>
      {/if}
      {@const singles = groups.filter((g) => !g.isSeries).flatMap((g) => g.items)}
      {#each groups as group (group.key)}
        {#if group.isSeries}
          <section class="group">
            <div class="group-head">
              <button
                class="group-toggle"
                type="button"
                aria-expanded={!collapsed.has(group.key)}
                onclick={() => toggleGroup(group.key)}
              >
                <span class="chev" class:open={!collapsed.has(group.key)}><Icon name="chevron-right" size={18} /></span>
                <span class="group-name">{group.name}</span>
                <span class="chip">{group.items.length}</span>
              </button>
              <button class="icon-btn small" type="button" aria-label="Rename group {group.name}" onclick={() => startRename(group.key, group.name)}>
                <Icon name="edit" size={16} />
              </button>
            </div>
            {#if !collapsed.has(group.key)}
              {@render bookList(group.items)}
            {/if}
          </section>
        {/if}
      {/each}
      {#if singles.length}
        <section class="group">
          {#if seriesGroups.length}<h2 class="group-head plain">Other books</h2>{/if}
          {@render bookList(singles)}
        </section>
      {/if}
    {:else}
      {@render bookList(items)}
    {/if}
  {/if}
</div>

<Dialog bind:open={renameOpen} title="Rename group">
  {#if renaming}
    <form id="rename-form" class="form" onsubmit={saveRename}>
      <label class="field">
        <span>Name</span>
        <input class="input" bind:value={renaming.name} required />
      </label>
      <p class="subtle small">The name follows you to your other devices. Clear it to use the detected series name.</p>
    </form>
  {/if}
  {#snippet actions()}
    <button class="btn" type="button" onclick={() => (renameOpen = false)}>Cancel</button>
    <button class="btn primary" type="submit" form="rename-form">Save</button>
  {/snippet}
</Dialog>

<style>
  .title {
    flex: 1;
    min-width: 0;
  }
  .title h1 {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .title p {
    font-size: 13px;
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
  .scan {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: -8px 0 16px;
    font-size: 13.5px;
  }
  .spinner.small {
    width: 14px;
    height: 14px;
    border-width: 2px;
  }
  .problem {
    margin: 0 0 16px;
  }
  .spin {
    display: inline-flex;
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
    margin-bottom: 20px;
  }
  .search {
    position: relative;
    flex: 1 1 260px;
    display: flex;
    align-items: center;
    color: var(--text-3);
  }
  .search :global(svg) {
    position: absolute;
    left: 12px;
    pointer-events: none;
  }
  .search .input {
    padding-left: 38px;
    border-radius: 999px;
    background: var(--surface);
  }
  .controls {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .select {
    width: auto;
    min-height: 38px;
    padding: 6px 30px 6px 12px;
    font-size: 13.5px;
  }
  @media (max-width: 600px) {
    .controls {
      flex: 1 1 100%;
      flex-wrap: nowrap;
      min-width: 0;
    }
    .select {
      flex: 1 1 0;
      min-width: 0;
      padding-right: 24px;
    }
  }
  .group-actions {
    display: flex;
    justify-content: flex-end;
    gap: 4px;
    margin: -8px 0 8px;
  }
  .group {
    margin-bottom: 24px;
  }
  .group-head {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-bottom: 12px;
  }
  .group-head.plain {
    font-size: 15px;
    color: var(--text-2);
    padding: 6px 4px;
  }
  .group-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 38px;
    padding: 0 10px 0 4px;
    border: 0;
    border-radius: var(--radius);
    background: none;
    font-weight: 650;
    font-size: 16px;
    text-align: left;
    min-width: 0;
  }
  .group-toggle:hover {
    background: var(--surface-2);
  }
  .group-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chev {
    display: inline-flex;
    color: var(--text-3);
    transition: transform 200ms var(--ease);
  }
  .chev.open {
    transform: rotate(90deg);
  }
  .icon-btn.small {
    width: 32px;
    height: 32px;
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
  .list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .empty {
    display: grid;
    justify-items: center;
    gap: 12px;
    padding: 64px 16px;
    color: var(--text-3);
    text-align: center;
  }
  .form {
    display: grid;
    gap: 12px;
  }
  .small {
    font-size: 13px;
  }
</style>
