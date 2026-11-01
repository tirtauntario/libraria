<script lang="ts">
  import type { Library, LibrarySourceRef, Source, SourceConfig } from '@libraria/core';
  import { bookIdsInLibrary } from '../lib/library/catalog';
  import { removeSource } from '../lib/library/sources';
  import { net } from '../lib/net.svelte';
  import { href, router } from '../lib/router.svelte';
  import { services } from '../lib/services';
  import { getSourceKind, listSourceKinds, type SourceKindDefinition } from '../lib/sources';
  import FolderPicker from '../lib/sources/ui/FolderPicker.svelte';
  import SourceProblem from '../lib/sources/ui/SourceProblem.svelte';
  import { catalog } from '../lib/stores/catalog.svelte';
  import { describeScan, scannable, scanner } from '../lib/stores/scanner.svelte';
  import { toasts } from '../lib/stores/toasts.svelte';
  import Dialog from '../lib/ui/Dialog.svelte';
  import Icon from '../lib/ui/Icon.svelte';
  import { plural } from '../lib/ui/format';

  let { params: _params }: { params: Record<string, string> } = $props();

  const counts = $derived(new Map(catalog.libraries.map((l) => [l.id, bookIdsInLibrary(l, catalog.files).size])));
  const filesPerSource = $derived(
    catalog.files.reduce((m, f) => m.set(f.sourceId, (m.get(f.sourceId) ?? 0) + 1), new Map<string, number>()),
  );
  const sourceById = $derived(new Map(catalog.sources.map((s) => [s.id, s])));

  const needsNetwork = (src: Source) => !getSourceKind(src.config.kind)?.deviceOnly;
  const canScan = (src: Source) => scannable(src) && (net.online || !needsNetwork(src));

  // --- library editor ---------------------------------------------------------
  interface RefDraft {
    on: boolean;
    path: string;
    label: string;
  }
  let editorOpen = $state(false);
  let editing = $state<{ id: string | null; name: string; refs: Record<string, RefDraft> }>({ id: null, name: '', refs: {} });

  function openEditor(lib?: Library) {
    const refs: Record<string, RefDraft> = {};
    for (const s of catalog.sources) {
      const ref = lib?.sources.find((r) => r.sourceId === s.id);
      refs[s.id] = { on: !!ref, path: ref?.path ?? '', label: ref?.label ?? ref?.path ?? '' };
    }
    editing = { id: lib?.id ?? null, name: lib?.name ?? '', refs };
    editorOpen = true;
  }

  async function saveLibrary(e: SubmitEvent) {
    e.preventDefault();
    const sources: LibrarySourceRef[] = Object.entries(editing.refs)
      .filter(([, r]) => r.on)
      .map(([sourceId, r]) => {
        const path = r.path.trim().replace(/^\/+|\/+$/g, '');
        const ref: LibrarySourceRef = { sourceId, path };
        const pathsAreIds = getSourceKind(sourceById.get(sourceId)?.config.kind ?? 'local')?.pathsAreIds;
        if (pathsAreIds && path && r.label) ref.label = r.label;
        return ref;
      });
    const name = editing.name.trim() || 'Untitled library';
    const before = editing.id ? catalog.libraries.find((l) => l.id === editing.id) : undefined;
    const lib = editing.id ? await services().repo.updateLibrary(editing.id, { name, sources }) : await services().repo.createLibrary(name, sources);
    editorOpen = false;
    // New folders may not have been scanned yet.
    if (lib) {
      const changed = lib.sources.filter((r) => !before?.sources.some((b) => b.sourceId === r.sourceId && b.path === r.path));
      for (const r of changed) {
        const src = sourceById.get(r.sourceId);
        if (src && canScan(src)) void scanner.scan(src);
      }
    }
  }

  // Folder picker for one source of the library being edited.
  let picking = $state<Source | null>(null);
  let pickerOpen = $state(false);
  function browse(src: Source) {
    picking = src;
    pickerOpen = true;
  }
  function picked(path: string, label: string) {
    const ref = picking && editing.refs[picking.id];
    if (ref) {
      ref.path = path;
      ref.label = label;
    }
    pickerOpen = false;
  }
  const pickerDriver = $derived.by(() => {
    if (!picking) return null;
    try {
      return services().driver(picking);
    } catch {
      return null;
    }
  });

  let deleting = $state<Library | null>(null);
  let deleteOpen = $state(false);
  async function confirmDelete() {
    if (deleting) await services().repo.deleteLibrary(deleting.id);
    deleteOpen = false;
  }

  function libraryScannable(lib: Library): boolean {
    return lib.sources.some((r) => {
      const src = sourceById.get(r.sourceId);
      return !!src && scannable(src);
    });
  }
  const libraryScanning = (lib: Library) => lib.sources.some((r) => scanner.busy(r.sourceId));

  async function rescanLibrary(lib: Library) {
    const { result, failed } = await scanner.scanLibrary(lib);
    if (failed) toasts.error(`${lib.name}: ${plural(failed, 'source')} could not be scanned`, 'See Sources below for details.');
    else toasts.show(`${lib.name}: ${describeScan(result)}`);
  }

  // --- sources ------------------------------------------------------------------
  let addOpen = $state(false);
  let setupKind = $state<SourceKindDefinition | null>(null);
  const kinds = listSourceKinds().filter((k) => k.userCreatable);
  const shownKinds = kinds.filter((k) => !k.implemented || k.isSupported() || !k.unsupportedHint);
  const hiddenHints = kinds.filter((k) => k.implemented && !k.isSupported() && k.unsupportedHint).map((k) => k.unsupportedHint!);

  // '#/libraries?add=gdrive' (coming back from a sign-in) reopens that form.
  $effect(() => {
    const add = router.query.get('add');
    if (!add) return;
    const k = kinds.find((x) => x.kind === add && x.implemented && x.isSupported());
    if (k) {
      setupKind = k;
      addOpen = true;
    }
    router.navigate('/libraries', { replace: true });
  });

  async function createSource(name: string, config: SourceConfig) {
    const s = services();
    const src = await s.repo.createSource(name, config);
    setupKind = null;
    addOpen = false;
    // A source shows books only through a library: give it one.
    const used = (await s.repo.listLibraries()).some((l) => l.sources.some((r) => r.sourceId === src.id));
    if (!used) await s.repo.createLibrary(name, [{ sourceId: src.id, path: '' }]);
    toasts.show(`Added ${name}. Scanning…`, { kind: 'success' });
    void scan(src);
  }

  async function scan(src: Source) {
    await scanner.scan(src, {
      onDone: (r, problem) => {
        if (r) toasts.show(`${src.name}: ${describeScan(r)}`);
        else if (problem && problem.code !== 'permission' && problem.code !== 'auth') toasts.error(`Could not scan ${src.name}`, problem.message);
      },
    });
  }

  let removing = $state<Source | null>(null);
  let removeOpen = $state(false);
  async function confirmRemove() {
    const src = removing;
    removeOpen = false;
    if (!src) return;
    scanner.cancel(src.id);
    await removeSource(src, services());
    scanner.setProblem(src.id, null);
    toasts.show(`Removed ${src.name}`);
  }

  function kindLabel(src: Source) {
    return getSourceKind(src.config.kind)?.label ?? src.config.kind;
  }
  function sourceDetail(src: Source): string {
    try {
      return services().driver(src).describe().detail ?? '';
    } catch {
      return '';
    }
  }
  const iconFor = (kind: string) => (kind === 'local' ? 'device' : kind === 'folder' ? 'folder' : 'cloud');
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
              {lib.sources.length
                ? lib.sources
                    .map((r) => (sourceById.get(r.sourceId)?.name ?? '?') + (r.path ? ` › ${r.label || r.path}` : ''))
                    .join(', ')
                : 'No sources'}
            </span>
          </span>
        </a>
        {#if libraryScannable(lib)}
          <button
            class="icon-btn"
            type="button"
            aria-label="Rescan {lib.name}"
            title="Rescan"
            disabled={libraryScanning(lib)}
            onclick={() => rescanLibrary(lib)}
          >
            <span class:spin={libraryScanning(lib)}><Icon name="refresh" size={18} /></span>
          </button>
        {/if}
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
      {@const job = scanner.jobs[src.id]}
      {@const problem = scanner.problems[src.id]}
      <li class="card source" aria-label={src.name}>
        <div class="item">
          <div class="item-main">
            <span class="item-icon"><Icon name={iconFor(src.config.kind)} /></span>
            <span>
              <span class="item-name">{src.name}</span>
              <span class="subtle small">
                {plural(filesPerSource.get(src.id) ?? 0, 'file')} · {kindLabel(src)}{#if sourceDetail(src) && src.config.kind !== 'local'}&nbsp;· {sourceDetail(src)}{/if}
              </span>
            </span>
          </div>
          {#if src.config.kind !== 'local' && getSourceKind(src.config.kind)?.implemented}
            <button class="btn small ghost" type="button" disabled={!!job || !canScan(src)} onclick={() => scan(src)}>
              <span class:spin={!!job}><Icon name="refresh" size={16} /></span>
              {job ? 'Scanning…' : 'Rescan'}
            </button>
            <button
              class="icon-btn"
              type="button"
              aria-label="Remove {src.name}"
              onclick={() => {
                removing = src;
                removeOpen = true;
              }}><Icon name="trash" size={18} /></button
            >
          {/if}
        </div>
        {#if job}
          <p class="progress subtle" aria-live="polite">
            Found {plural(job.found, 'book')}{#if job.path}&nbsp;· <span class="job-path">{job.path.split('/').pop()}</span>{/if}
          </p>
        {:else if problem}
          <div class="problem"><SourceProblem source={src} {problem} /></div>
        {:else if !getSourceKind(src.config.kind)?.isSupported()}
          <p class="progress subtle">{getSourceKind(src.config.kind)?.unsupportedHint ?? 'Not available in this browser.'}</p>
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
        {@const def = getSourceKind(src.config.kind)}
        {#if ref}
          <div class="src-row">
            <label class="check">
              <input type="checkbox" bind:checked={ref.on} />
              <span>{src.name} <span class="subtle">· {kindLabel(src)}</span></span>
            </label>
            {#if ref.on && src.config.kind !== 'local'}
              <div class="path">
                {#if def?.pathsAreIds}
                  <span class="field">
                    <span>Folder</span>
                    <span class="picked">{ref.path ? ref.label || ref.path : 'Whole source'}</span>
                  </span>
                {:else}
                  <label class="field">
                    <span>Folder (optional)</span>
                    <input class="input" bind:value={ref.path} oninput={() => (ref.label = ref.path)} placeholder="Whole source" />
                  </label>
                {/if}
                <div class="path-actions">
                  {#if def?.implemented && def.isSupported()}
                    <button class="btn small" type="button" onclick={() => browse(src)} disabled={needsNetwork(src) && !net.online}>
                      <Icon name="folder" size={16} /> Browse…
                    </button>
                  {/if}
                  {#if ref.path}
                    <button class="btn small ghost" type="button" onclick={() => ((ref.path = ''), (ref.label = ''))}>Whole source</button>
                  {/if}
                </div>
              </div>
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

<Dialog bind:open={pickerOpen} title={picking ? `Choose a folder in ${picking.name}` : 'Choose a folder'} size="md" onclose={() => (picking = null)}>
  {#if pickerDriver && picking}
    <FolderPicker
      list={(path, signal) => pickerDriver.list(path, { signal })}
      rootLabel={picking.name}
      onPick={picked}
      onCancel={() => (pickerOpen = false)}
    />
  {:else}
    <p class="muted">This source cannot be browsed right now.</p>
  {/if}
</Dialog>

<Dialog bind:open={deleteOpen} title="Delete library?">
  <p class="muted">“{deleting?.name}” is removed. Its books and sources stay; they still appear in other libraries.</p>
  {#snippet actions()}
    <button class="btn" type="button" onclick={() => (deleteOpen = false)}>Cancel</button>
    <button class="btn danger" type="button" onclick={confirmDelete}>Delete</button>
  {/snippet}
</Dialog>

<Dialog bind:open={removeOpen} title="Remove source?">
  <p class="muted">
    “{removing?.name}” is removed from Libraria and from your libraries. The files in it are not touched. Books found nowhere else
    disappear, except ones you keep offline. Reading progress and bookmarks stay.
  </p>
  {#snippet actions()}
    <button class="btn" type="button" onclick={() => (removeOpen = false)}>Cancel</button>
    <button class="btn danger" type="button" onclick={confirmRemove}>Remove</button>
  {/snippet}
</Dialog>

<Dialog bind:open={addOpen} title={setupKind ? `Add ${setupKind.label}` : 'Add a source'} size="md" onclose={() => (setupKind = null)}>
  {#if setupKind?.setup}
    <setupKind.setup onCreate={createSource} onCancel={() => (setupKind = null)} />
  {:else}
    <ul class="kinds">
      {#each shownKinds as k (k.kind)}
        {@const usable = k.implemented && k.isSupported()}
        <li>
          <button class="kind" type="button" disabled={!usable} onclick={() => (setupKind = k)}>
            <span class="item-icon"><Icon name={k.kind === 'folder' ? 'folder' : 'cloud'} /></span>
            <span class="kind-text">
              <span class="item-name">{k.label}</span>
              <span class="subtle small">{k.description}</span>
            </span>
            {#if !k.implemented}<span class="chip">Coming soon</span>{:else if !k.isSupported()}<span class="chip">Not in this browser</span>{:else}<Icon name="chevron-right" size={18} />{/if}
          </button>
        </li>
      {/each}
    </ul>
    {#each hiddenHints as hint (hint)}
      <p class="subtle hint"><Icon name="info" size={16} /> {hint}</p>
    {/each}
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
    min-width: 0;
  }
  .source {
    padding: 0;
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
  .progress {
    margin: -4px 16px 12px 70px;
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .job-path {
    font-family: var(--font-mono);
    font-size: 12px;
  }
  .problem {
    margin: 0 12px 12px;
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
    display: grid;
    gap: 8px;
  }
  .path-actions {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .picked {
    font-size: 14px;
    overflow-wrap: anywhere;
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
  .kind > :global(svg) {
    color: var(--text-3);
    flex: none;
  }
  .kind-text {
    flex: 1;
    display: grid;
    min-width: 0;
  }
  .kind-text .small {
    white-space: normal;
  }
  .hint {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    margin-top: 12px;
    font-size: 13px;
  }
  .hint :global(svg) {
    flex: none;
    margin-top: 1px;
  }
</style>
