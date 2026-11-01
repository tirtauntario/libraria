<script lang="ts">
  import { canManageBooks } from '@libraria/core';
  import { queryBooks } from '../../../lib/library/catalog';
  import { net } from '../../../lib/net.svelte';
  import { services } from '../../../lib/services';
  import { describeError } from '../../../lib/server/api';
  import { roleOf } from '../../../lib/server/servers';
  import { refreshServerCatalog } from '../../../lib/server/source';
  import { catalog } from '../../../lib/stores/catalog.svelte';
  import { toasts } from '../../../lib/stores/toasts.svelte';
  import BookCard from '../../../lib/ui/BookCard.svelte';
  import Icon from '../../../lib/ui/Icon.svelte';
  import { formatRelative, plural } from '../../../lib/ui/format';
  import type { ServerEntry } from '../store.svelte';

  let { entry }: { entry: ServerEntry } = $props();

  let search = $state('');
  const ids = $derived(new Set(catalog.files.filter((f) => f.sourceId === entry.source.id).map((f) => f.bookId)));
  const all = $derived(catalog.books.filter((b) => ids.has(b.id)));
  const items = $derived(queryBooks(all, { search, sort: 'added' }));
  const offlineCount = $derived(all.filter((b) => catalog.onDevice(b.id)).length);

  let refreshing = $state(false);
  async function refresh() {
    refreshing = true;
    try {
      const r = await refreshServerCatalog(entry.source, services());
      const changes = r.added + r.removed + r.updated;
      toasts.show(changes ? `${plural(r.added, 'new book')}, ${r.removed} removed` : 'The catalog is up to date', { timeout: 3000 });
    } catch (err) {
      toasts.error('Could not refresh', describeError(err));
    } finally {
      refreshing = false;
    }
  }
</script>

<div class="toolbar">
  <label class="search">
    <Icon name="search" size={18} />
    <input class="input" type="search" placeholder="Search {entry.source.name}" bind:value={search} aria-label="Search this library" />
  </label>
  <button class="btn" type="button" onclick={refresh} disabled={refreshing || !net.online}>
    <Icon name="refresh" size={16} />
    {refreshing ? 'Refreshing…' : 'Refresh'}
  </button>
</div>
<p class="subtle small meta">
  {plural(all.length, 'book')} · {offlineCount} on this device · updated {formatRelative(entry.state.lastRefreshAt).toLowerCase()}
  {#if entry.state.lastRefreshError}<span class="error">· {entry.state.lastRefreshError}</span>{/if}
</p>

{#if items.length}
  <div class="grid">
    {#each items as book (book.id)}
      <BookCard {book} remote={!catalog.onDevice(book.id)} />
    {/each}
  </div>
{:else if all.length}
  <p class="muted">No books match “{search}”.</p>
{:else}
  <div class="card empty">
    <Icon name="library" size={28} />
    {#if !net.online && !entry.state.lastRefreshAt}
      <p>Connect to load this library’s catalog.</p>
    {:else}
      <p>This library has no books yet.</p>
      {#if canManageBooks(roleOf(entry.source))}
        <p class="muted small">Open a book on this device and choose “Send to server”. Uploads from you are added right away.</p>
      {/if}
    {/if}
  </div>
{/if}

<style>
  .toolbar {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }
  .search {
    position: relative;
    flex: 1 1 240px;
    max-width: 480px;
    color: var(--text-3);
  }
  .search :global(svg) {
    position: absolute;
    left: 12px;
    top: 50%;
    transform: translateY(-50%);
  }
  .search .input {
    padding-left: 38px;
  }
  .meta {
    margin: 10px 0 18px;
  }
  .small {
    font-size: 13px;
  }
  .error {
    color: var(--danger);
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
    }
  }
  .empty {
    display: grid;
    justify-items: center;
    gap: 8px;
    padding: 28px 20px;
    text-align: center;
    color: var(--text-2);
  }
</style>
