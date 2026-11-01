<script lang="ts">
  import type { ScanResult, ServerSourceDto } from '@libraria/core';
  import { net } from '../../../lib/net.svelte';
  import { services } from '../../../lib/services';
  import { describeError } from '../../../lib/server/api';
  import { apiFor } from '../../../lib/server/servers';
  import { refreshServerCatalog } from '../../../lib/server/source';
  import { toasts } from '../../../lib/stores/toasts.svelte';
  import Dialog from '../../../lib/ui/Dialog.svelte';
  import Icon from '../../../lib/ui/Icon.svelte';
  import { formatRelative, plural } from '../../../lib/ui/format';
  import type { ServerEntry } from '../store.svelte';

  let { entry }: { entry: ServerEntry } = $props();
  const api = $derived(apiFor(entry.source, services().repo));

  let roots = $state<string[] | null>(null);
  let items = $state<ServerSourceDto[] | null>(null);
  let error = $state<string | null>(null);
  let path = $state('');
  let adding = $state(false);
  let scanning = $state<string | null>(null);
  let results = $state<Record<string, ScanResult>>({});

  async function load() {
    if (!net.online) return;
    try {
      const [r, s] = await Promise.all([api.sourceRoots(), api.listSources()]);
      roots = r.roots;
      items = s.items;
      error = null;
    } catch (err) {
      error = describeError(err);
    }
  }
  $effect(() => {
    void net.online;
    void load();
  });

  async function add(e: SubmitEvent) {
    e.preventDefault();
    adding = true;
    try {
      const src = await api.createSource(path.trim());
      path = '';
      await load();
      await scan(src);
    } catch (err) {
      toasts.error('Could not add the folder', describeError(err));
    } finally {
      adding = false;
    }
  }

  async function scan(src: ServerSourceDto) {
    scanning = src.id;
    try {
      const r = await api.scanSource(src.id);
      results[src.id] = r;
      toasts.show(`Scanned ${src.path}: ${r.added} added, ${r.removed} removed${r.failed ? `, ${r.failed} failed` : ''}`);
      await load();
      void refreshServerCatalog(entry.source, services()).catch(() => {});
    } catch (err) {
      toasts.error('Scan failed', describeError(err));
    } finally {
      scanning = null;
    }
  }

  let deleting = $state<ServerSourceDto | null>(null);
  let deleteOpen = $state(false);
  async function remove() {
    const src = deleting;
    if (!src) return;
    deleteOpen = false;
    try {
      await api.deleteSource(src.id);
      toasts.show(`Removed ${src.path}`);
      await load();
      void refreshServerCatalog(entry.source, services()).catch(() => {});
    } catch (err) {
      toasts.error('Could not remove the folder', describeError(err));
    }
  }
</script>

{#if !net.online}
  <p class="subtle">Connect to manage the server’s folders.</p>
{:else if error}
  <p class="error">{error}</p>
{:else if roots === null || items === null}
  <div class="spinner"></div>
{:else}
  <section class="block">
    <h2>Folders on the server</h2>
    <p class="muted small">
      The server can publish books that already sit on its disk. For safety, only folders inside the roots set in the server’s
      config file (<code>sourceRoots</code>) can be added. As the owner you are responsible for what the server publishes: add
      only books you have the right to share. <a href="#/about">Your content, your responsibility</a>
    </p>
    {#if roots.length === 0}
      <div class="card note">
        <Icon name="info" size={18} />
        <p>No roots are configured. Add a path to <code>sourceRoots</code> in <code>libraria.config.json</code> (or <code>LIBRARIA_SOURCE_ROOTS</code>) and restart the server.</p>
      </div>
    {:else}
      <p class="small">Allowed roots: {#each roots as r, i (r)}<code>{r}</code>{i < roots.length - 1 ? ', ' : ''}{/each}</p>
      <form class="add" onsubmit={add}>
        <input class="input mono" bind:value={path} list="roots" placeholder={roots[0]} aria-label="Folder path" required />
        <datalist id="roots">{#each roots as r (r)}<option value={r}></option>{/each}</datalist>
        <button class="btn primary" type="submit" disabled={adding}><Icon name="plus" size={16} /> Add and scan</button>
      </form>
    {/if}

    {#if items.length}
      <ul class="sources">
        {#each items as src (src.id)}
          <li class="card src">
            <span class="icon"><Icon name="folder" /></span>
            <div class="text">
              <p class="path mono">{src.path}</p>
              <p class="small subtle">
                {plural(src.bookCount, 'book')} · {src.lastScanAt ? `scanned ${formatRelative(src.lastScanAt).toLowerCase()}` : 'not scanned yet'}
              </p>
              {#if results[src.id]}
                {@const r = results[src.id]!}
                <p class="small">Last scan: {r.added} added, {r.removed} removed, {r.unchanged} unchanged{#if r.failed}, <span class="error">{r.failed} failed</span>{/if}</p>
              {/if}
            </div>
            <div class="actions">
              <button class="btn small" type="button" disabled={scanning === src.id} onclick={() => scan(src)}>
                <Icon name="refresh" size={16} />
                {scanning === src.id ? 'Scanning…' : 'Scan'}
              </button>
              <button class="icon-btn" type="button" aria-label="Remove {src.path}" onclick={() => { deleting = src; deleteOpen = true; }}><Icon name="trash" size={18} /></button>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}

<Dialog bind:open={deleteOpen} title="Remove this folder?">
  <p class="muted">Books found only in <code>{deleting?.path}</code> leave the library. The files on disk are not touched.</p>
  {#snippet actions()}
    <button class="btn" type="button" onclick={() => (deleteOpen = false)}>Cancel</button>
    <button class="btn danger" type="button" onclick={remove}>Remove</button>
  {/snippet}
</Dialog>

<style>
  .block {
    max-width: 860px;
  }
  h2 {
    font-size: 17px;
    margin-bottom: 4px;
  }
  .small {
    font-size: 13px;
  }
  .block > .small {
    margin-bottom: 12px;
  }
  .mono,
  code {
    font-family: var(--font-mono);
    font-size: 0.92em;
    overflow-wrap: anywhere;
  }
  .error {
    color: var(--danger);
  }
  .note {
    display: flex;
    gap: 10px;
    padding: 12px 14px;
    color: var(--text-2);
    font-size: 14px;
  }
  .add {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 16px;
  }
  .add .input {
    flex: 1 1 260px;
  }
  .sources {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 8px;
  }
  .src {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px 12px;
    padding: 12px 14px;
  }
  .icon {
    color: var(--accent);
  }
  .text {
    flex: 1 1 240px;
    min-width: 0;
  }
  .path {
    font-weight: 600;
  }
  .actions {
    display: flex;
    gap: 6px;
    align-items: center;
  }
</style>
