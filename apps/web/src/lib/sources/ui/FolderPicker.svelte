<script lang="ts">
  /**
   * Browse a source's folders and pick one. Works with any driver's list():
   * WebDAV, Drive (id paths, shown by name), Dropbox, linked folders.
   */
  import { errorMessage } from '../errors';
  import type { SourceEntry } from '../types';
  import Icon from '../../ui/Icon.svelte';

  let {
    list,
    rootLabel,
    onPick,
    onCancel,
    pickLabel = 'Use this folder',
  }: {
    list: (path: string, signal: AbortSignal) => AsyncIterable<SourceEntry>;
    rootLabel: string;
    /** `path` is the driver path ('' = root); `label` is the readable path. */
    onPick: (path: string, label: string) => void;
    onCancel?: () => void;
    pickLabel?: string;
  } = $props();

  /** Breadcrumb: each step's path and name. */
  let trail = $state<{ path: string; name: string }[]>([]);
  let folders = $state<SourceEntry[]>([]);
  let fileCount = $state(0);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let ctrl: AbortController | null = null;

  const here = $derived(trail[trail.length - 1]?.path ?? '');
  const label = $derived(trail.map((t) => t.name).join('/'));

  async function load(path: string) {
    ctrl?.abort();
    const c = (ctrl = new AbortController());
    loading = true;
    error = null;
    const dirs: SourceEntry[] = [];
    let files = 0;
    try {
      for await (const e of list(path, c.signal)) {
        if (e.isDir) {
          if (!e.name.startsWith('.')) dirs.push(e);
        } else files++;
      }
      if (c.signal.aborted) return;
      folders = dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      fileCount = files;
    } catch (err) {
      if (c.signal.aborted) return;
      error = errorMessage(err);
      folders = [];
    } finally {
      if (ctrl === c) loading = false;
    }
  }

  $effect(() => {
    void load(here);
    return () => ctrl?.abort();
  });

  function open(e: SourceEntry) {
    trail = [...trail, { path: e.path, name: e.name }];
  }
  function goTo(i: number) {
    trail = trail.slice(0, i);
  }
</script>

<div class="picker">
  <nav class="crumbs" aria-label="Folder path">
    <button type="button" class="crumb" onclick={() => goTo(0)} disabled={trail.length === 0}>{rootLabel}</button>
    {#each trail as t, i (t.path)}
      <span class="sep" aria-hidden="true">/</span>
      <button type="button" class="crumb" onclick={() => goTo(i + 1)} disabled={i === trail.length - 1}>{t.name}</button>
    {/each}
  </nav>

  <div class="box" aria-busy={loading}>
    {#if loading}
      <div class="state"><div class="spinner"></div></div>
    {:else if error}
      <p class="state error" role="alert"><Icon name="alert" size={18} /> {error}</p>
      <button class="btn small" type="button" onclick={() => load(here)}>Try again</button>
    {:else}
      {#if trail.length}
        <button type="button" class="row up" onclick={() => goTo(trail.length - 1)}>
          <Icon name="arrow-left" size={18} /> <span>Up</span>
        </button>
      {/if}
      {#each folders as f (f.path)}
        <button type="button" class="row" onclick={() => open(f)}>
          <Icon name="folder" size={18} /> <span class="name">{f.name}</span> <Icon name="chevron-right" size={16} />
        </button>
      {:else}
        <p class="state subtle">No folders here.</p>
      {/each}
      {#if fileCount}<p class="files subtle">{fileCount} {fileCount === 1 ? 'file' : 'files'} in this folder</p>{/if}
    {/if}
  </div>

  <div class="actions">
    {#if onCancel}<button class="btn" type="button" onclick={onCancel}>Back</button>{/if}
    <button class="btn primary" type="button" disabled={loading || !!error} onclick={() => onPick(here, label)}>
      {pickLabel}{trail.length ? '' : ` (${rootLabel})`}
    </button>
  </div>
</div>

<style>
  .picker {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 10px;
  }
  .crumbs {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px;
    font-size: 14px;
  }
  .crumb {
    border: 0;
    background: none;
    padding: 4px 6px;
    border-radius: var(--radius-sm);
    color: var(--accent);
    font-weight: 550;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .crumb:disabled {
    color: var(--text);
    cursor: default;
  }
  .sep {
    color: var(--text-3);
  }
  .box {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    max-height: min(46vh, 360px);
    min-height: 120px;
    overflow: auto;
    display: flex;
    flex-direction: column;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    min-height: 44px;
    border: 0;
    border-bottom: 1px solid var(--border);
    background: none;
    text-align: left;
    color: var(--text);
  }
  .row:hover {
    background: var(--surface-2);
  }
  .row :global(svg) {
    flex: none;
    color: var(--text-3);
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .up {
    color: var(--text-2);
  }
  .state {
    margin: auto;
    padding: 16px;
    text-align: center;
  }
  .error {
    color: var(--danger);
    display: flex;
    gap: 8px;
    align-items: flex-start;
    text-align: left;
  }
  .box > .btn {
    margin: 0 auto 16px;
  }
  .files {
    padding: 10px 12px;
    font-size: 13px;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    flex-wrap: wrap;
  }
</style>
