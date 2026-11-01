<script lang="ts">
  import { net } from '../../lib/net.svelte';
  import { sync } from '../../lib/sync/controller.svelte';
  import Icon from '../../lib/ui/Icon.svelte';
  import { formatRelative, plural } from '../../lib/ui/format';

  let { compact = false }: { compact?: boolean } = $props();

  const label = $derived(
    sync.phase === 'syncing'
      ? 'Syncing…'
      : sync.phase === 'offline' || (!net.online && sync.enabled)
        ? 'Waiting for a connection'
        : sync.phase === 'error'
          ? 'Sync failed'
          : sync.phase === 'signed-out'
            ? 'Signed out of the sync server'
            : sync.phase === 'reset'
              ? 'Sync was reset elsewhere'
              : sync.enabled
                ? 'Up to date'
                : 'Sync is off',
  );
  const tone = $derived(
    sync.phase === 'error' || sync.phase === 'signed-out' || sync.phase === 'reset' ? 'bad' : sync.enabled ? 'good' : 'off',
  );
</script>

<section class="card sync" class:compact data-testid="sync-status">
  <span class="icon {tone}" class:spin={sync.phase === 'syncing'}><Icon name="refresh" /></span>
  <div class="text">
    <p class="title">{label}</p>
    {#if sync.enabled}
      <p class="subtle small">
        {sync.home?.name} · last synced {formatRelative(sync.lastSyncAt).toLowerCase()}{#if sync.pending}&nbsp;· {plural(sync.pending, 'change')} to send{/if}
      </p>
      {#if sync.lastError && sync.phase !== 'syncing'}<p class="error small">{sync.lastError}</p>{/if}
    {:else}
      <p class="subtle small">Keep progress, bookmarks, libraries and sources the same on all your devices.</p>
    {/if}
  </div>
  <div class="actions">
    {#if sync.enabled}
      <button class="btn small" type="button" disabled={sync.phase === 'syncing' || !net.online} onclick={() => sync.syncNow()}>Sync now</button>
    {/if}
    <a class="btn small {sync.enabled ? 'ghost' : 'primary'}" href="#/sync">{sync.enabled ? 'Details' : 'Set up'}</a>
  </div>
</section>

<style>
  .sync {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px 14px;
    padding: 14px 16px;
  }
  .compact {
    border: 0;
    padding: 4px 0 0;
    background: transparent;
  }
  .icon {
    display: grid;
    place-items: center;
    flex: none;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: var(--surface-2);
    color: var(--text-3);
  }
  .icon.good {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .icon.bad {
    background: var(--danger-soft);
    color: var(--danger);
  }
  .spin :global(svg) {
    animation: spin 1s linear infinite;
  }
  .text {
    flex: 1 1 200px;
    min-width: 0;
  }
  .title {
    font-weight: 600;
  }
  .small {
    font-size: 13px;
  }
  .error {
    color: var(--danger);
  }
  .actions {
    display: flex;
    gap: 8px;
  }
</style>
