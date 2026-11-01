<script lang="ts">
  import type { Library, LibrarySourceRef, Source, SourceConfig } from '@libraria/core';
  import { bookIdsInLibrary } from '../lib/library/catalog';
  import { scanSource } from '../lib/library/scan';
  import { net } from '../lib/net.svelte';
  import { href } from '../lib/router.svelte';
  import { services } from '../lib/services';
  import { getSourceKind, listSourceKinds, type SourceKindDefinition } from '../lib/sources';
  import { catalog } from '../lib/stores/catalog.svelte';
  import { toasts } from '../lib/stores/toasts.svelte';
  import Dialog from '../lib/ui/Dialog.svelte';
  import Icon from '../lib/ui/Icon.svelte';
  import { plural } from '../lib/ui/format';

  let { params: _params }: { params: Record<string, string> } = $props();

  const counts = $derived(new Map(catalog.libraries.map((l) => [l.id, bookIdsInLibrary(l, catalog.files).size])));
  const filesPerSource = $derived(
    catalog.files.reduce((m, f) => m.set(f.sourceId, (m.get(f.sourceId) ?? 0) + 1), new Map<string, number>()),
  );

  // --- library editor ---------------------------------------------------------
  let editorOpen = $state(false);
  let editing = $state<{ id: string | null; name: string; refs: Record<string, { on: boolean; path: string }> }>({
    id: null,
    name: '',
    refs: {},
  });

  function openEditor(lib?: Library) {
    const refs: Record<string, { on: boolean; path: string }> = {};
    for (const s of catalog.sources) {
      const ref = lib?.sources.find((r) => r.sourceId === s.id);
      refs[s.id] = { on: !!ref, path: ref?.path ?? '' };
    }
    editing = { id: lib?.id ?? null, name: lib?.name ?? '', refs };
    editorOpen = true;
  }

  async function saveLibrary(e: SubmitEvent) {
    e.preventDefault();
    const sources: LibrarySourceRef[] = Object.entries(editing.refs)
      .filter(([, r]) => r.on)
      .map(([sourceId, r]) => ({ sourceId, path: r.path.trim().replace(/^\/+|\/+$/g, '') }));
    const name = editing.name.trim() || 'Untitled library';
    if (editing.id) await services().repo.updateLibrary(editing.id, { name, sources });
    else await services().repo.createLibrary(name, sources);
    editorOpen = false;
  }

  let deleting = $state<Library | null>(null);
  let deleteOpen = $state(false);
  async function confirmDelete() {
    if (deleting) await services().repo.deleteLibrary(deleting.id);
    deleteOpen = false;
  }

  // --- sources ------------------------------------------------------------------
  let addOpen = $state(false);
  let setupKind = $state<SourceKindDefinition | null>(null);
  const kinds = listSourceKinds().filter((k) => k.userCreatable);

  async function createSource(name: string, config: SourceConfig) {
    const src = await services().repo.createSource(name, config);
    setupKind = null;
    addOpen = false;
    toasts.show(`Added ${name}`, { kind: 'success' });
    void scan(src);
  }

  let scanning = $state<string | null>(null);
  async function scan(src: Source) {
    scanning = src.id;
    try {
      const r = await scanSource(src, '', services());
      toasts.show(`${src.name}: ${r.added} new, ${r.updated} changed, ${r.removed} removed`);
    } catch (err) {
      toasts.error(`Could not scan ${src.name}`, err instanceof Error ? err.message : String(err));
    } finally {
      scanning = null;
    }
  }

  function kindLabel(src: Source) {
    return getSourceKind(src.config.kind)?.label ?? src.config.kind;
  }
</script>

<div class="page">
  <header class="page-header">
    <h1>Libraries</h1>
    <button class="btn primary" type="button" onclick={() => openEditor()}><Icon name="plus" size={18} /> New library</button>
  </header>

  <p class="muted intro">A library shows the books from one or more sources. A book can be in several libraries.</p>

  <ul class="list">
    {#each catalog.libraries as lib (lib.id)}
      <li class="card item">
        <a class="item-main" href={href('/library', lib.id)}>
          <span class="item-icon"><Icon name={lib.id === catalog.localLibraryId ? 'device' : 'library'} /></span>
          <span>
            <span class="item-name">{lib.name}</span>
            <span class="subtle small">
              {plural(counts.get(lib.id) ?? 0, 'book')} ·
              {lib.sources.length ? lib.sources.map((r) => catalog.sources.find((s) => s.id === r.sourceId)?.name ?? '?').join(', ') : 'No sources'}
            </span>
          </span>
        </a>
        <button class="icon-btn" type="button" aria-label="Edit {lib.name}" onclick={() => openEditor(lib)}><Icon name="edit" size={18} /></button>
        {#if lib.id !== catalog.localLibraryId}
          <button
            class="icon-btn"
            type="button"
            aria-label="Delete {lib.name}"
            onclick={() => {
              deleting = lib;
              deleteOpen = true;
            }}><Icon name="trash" size={18} /></button
          >
        {/if}
      </li>
    {/each}
  </ul>

  <header class="section-head">
    <h2>Sources</h2>
    <button class="btn small" type="button" onclick={() => (addOpen = true)}><Icon name="plus" size={16} /> Add source</button>
  </header>
  <p class="muted intro">Where your books are stored. Books from a source appear in every library that includes it.</p>

  <ul class="list">
    {#each catalog.sources as src (src.id)}
      <li class="card item">
        <div class="item-main">
          <span class="item-icon"><Icon name={src.config.kind === 'local' ? 'device' : src.config.kind === 'folder' ? 'folder' : 'cloud'} /></span>
          <span>
            <span class="item-name">{src.name}</span>
            <span class="subtle small">{kindLabel(src)} · {plural(filesPerSource.get(src.id) ?? 0, 'file')}</span>
          </span>
        </div>
        {#if src.config.kind !== 'local' && getSourceKind(src.config.kind)?.implemented}
          <button class="btn small ghost" type="button" disabled={scanning === src.id || (!net.online && !getSourceKind(src.config.kind)?.deviceOnly)} onclick={() => scan(src)}>
            <Icon name="refresh" size={16} />
            {scanning === src.id ? 'Scanning…' : 'Scan'}
          </button>
        {/if}
      </li>
    {/each}
  </ul>
</div>

<Dialog bind:open={editorOpen} title={editing.id ? 'Edit library' : 'New library'} size="md">
  <form id="lib-form" class="form" onsubmit={saveLibrary}>
    <label class="field">
      <span>Name</span>
      <input class="input" bind:value={editing.name} placeholder="e.g. Manga, Work, Kids" required />
    </label>
    <fieldset>
      <legend class="label">Sources</legend>
      {#each catalog.sources as src (src.id)}
        {@const ref = editing.refs[src.id]}
        {#if ref}
          <div class="src-row">
            <label class="check">
              <input type="checkbox" bind:checked={ref.on} />
              <span>{src.name} <span class="subtle">· {kindLabel(src)}</span></span>
            </label>
            {#if ref.on && src.config.kind !== 'local'}
              <label class="field path">
                <span>Folder (optional)</span>
                <input class="input" bind:value={ref.path} placeholder="Whole source" />
              </label>
            {/if}
          </div>
        {/if}
      {/each}
    </fieldset>
  </form>
  {#snippet actions()}
    <button class="btn" type="button" onclick={() => (editorOpen = false)}>Cancel</button>
    <button class="btn primary" type="submit" form="lib-form">Save</button>
  {/snippet}
</Dialog>

<Dialog bind:open={deleteOpen} title="Delete library?">
  <p class="muted">“{deleting?.name}” is removed. Its books and sources stay; they still appear in other libraries.</p>
  {#snippet actions()}
    <button class="btn" type="button" onclick={() => (deleteOpen = false)}>Cancel</button>
    <button class="btn danger" type="button" onclick={confirmDelete}>Delete</button>
  {/snippet}
</Dialog>

<Dialog bind:open={addOpen} title={setupKind ? `Add ${setupKind.label}` : 'Add a source'} size="md" onclose={() => (setupKind = null)}>
  {#if setupKind?.setup}
    <setupKind.setup onCreate={createSource} onCancel={() => (setupKind = null)} />
  {:else}
    <ul class="kinds">
      {#each kinds as k (k.kind)}
        {@const usable = k.implemented && k.isSupported()}
        <li>
          <button class="kind" type="button" disabled={!usable} onclick={() => (setupKind = k)}>
            <span class="item-icon"><Icon name={k.kind === 'folder' ? 'folder' : 'cloud'} /></span>
            <span class="kind-text">
              <span class="item-name">{k.label}</span>
              <span class="subtle small">{k.description}</span>
            </span>
            {#if !k.implemented}<span class="chip">Coming soon</span>{:else if !k.isSupported()}<span class="chip">Not in this browser</span>{/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</Dialog>

<style>
  .intro {
    margin: -8px 0 16px;
    font-size: 14px;
  }
  .section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 40px 0 16px;
  }
  .section-head h2 {
    font-size: 20px;
  }
  .list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    gap: 8px;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 8px 8px 8px 0;
  }
  .item-main {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 6px 12px 6px 16px;
    min-width: 0;
    color: var(--text);
    text-decoration: none;
  }
  .item-main > span:last-child {
    display: grid;
    min-width: 0;
  }
  .item-main:hover {
    text-decoration: none;
  }
  .item-icon {
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    flex: none;
    border-radius: var(--radius);
    background: var(--accent-soft);
    color: var(--accent);
  }
  .item-name {
    font-weight: 600;
  }
  .small {
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .form {
    display: grid;
    gap: 16px;
  }
  fieldset {
    border: 0;
    padding: 0;
    margin: 0;
    display: grid;
    gap: 10px;
  }
  legend {
    margin-bottom: 8px;
  }
  .src-row {
    display: grid;
    gap: 8px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .check {
    display: flex;
    gap: 10px;
    align-items: center;
  }
  .path {
    margin-left: 28px;
  }
  .kinds {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 6px;
  }
  .kind {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    text-align: left;
  }
  .kind:hover:not(:disabled) {
    border-color: var(--border-strong);
    background: var(--surface-2);
  }
  .kind:disabled {
    cursor: default;
    opacity: 0.75;
  }
  .kind-text {
    flex: 1;
    display: grid;
    min-width: 0;
  }
  .kind-text .small {
    white-space: normal;
  }
</style>
