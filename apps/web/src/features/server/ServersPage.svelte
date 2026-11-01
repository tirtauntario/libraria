<script lang="ts">
  import { href } from '../../lib/router.svelte';
  import { services } from '../../lib/services';
  import { removePending } from '../../lib/server/servers';
  import { catalog } from '../../lib/stores/catalog.svelte';
  import { sync } from '../../lib/sync/controller.svelte';
  import Icon from '../../lib/ui/Icon.svelte';
  import { plural } from '../../lib/ui/format';
  import { servers } from './store.svelte';
  import SyncStatus from './SyncStatus.svelte';
  import { hostOf, ROLE_LABEL } from './util';

  let { params: _params }: { params: Record<string, string> } = $props();

  const counts = $derived(
    catalog.files.reduce((m, f) => m.set(f.sourceId, (m.get(f.sourceId) ?? 0) + 1), new Map<string, number>()),
  );

  function loginHref(url: string, username: string): string {
    return `#/join?server=${encodeURIComponent(url)}&mode=login&username=${encodeURIComponent(username)}`;
  }
</script>

<div class="page narrow">
  <header class="page-header">
    <h1>Servers</h1>
    <a class="btn primary" href="#/join"><Icon name="plus" size={18} /> Add server</a>
  </header>
  <p class="muted intro">
    Libraria servers are community libraries run by people you know. Join as many as you like; each one shows up as a library. One of
    them can also keep your reading in sync across devices, end-to-end encrypted.
  </p>

  <SyncStatus />

  <h2 class="section-title">Your servers</h2>
  {#if servers.list.length === 0 && servers.pending.length === 0}
    <div class="card empty">
      <Icon name="cloud" size={28} />
      <p>You have not joined a server yet.</p>
      <p class="muted small">Got an invite link? Open it on this device. Otherwise add the server’s address.</p>
      <a class="btn" href="#/join">Add a server</a>
    </div>
  {/if}

  <ul class="list">
    {#each servers.list as { source, state } (source.id)}
      {@const guest = !source.config.token}
      <li class="card item">
        <a class="item-main" href={href('/server', source.id)}>
          <span class="item-icon"><Icon name="library" /></span>
          <span class="item-text">
            <span class="item-name">{source.name}</span>
            <span class="subtle small">
              {hostOf(source.config.url)} · {guest ? (source.config.username ? `${source.config.username} · signed out` : 'Guest') : `${source.config.username} · ${ROLE_LABEL[source.config.role]}`} ·
              {plural(counts.get(source.id) ?? 0, 'book')}
            </span>
          </span>
        </a>
        <span class="tags">
          {#if state.sessionExpired}
            <span class="chip warn">Signed out</span>
          {/if}
          {#if sync.home?.sourceId === source.id}
            <span class="chip"><Icon name="refresh" size={12} /> Sync</span>
          {/if}
        </span>
        <Icon name="chevron-right" size={18} />
      </li>
    {/each}
    {#each servers.pending as p (p.serverId + p.username)}
      <li class="card item pending">
        <div class="item-main">
          <span class="item-icon"><Icon name="info" /></span>
          <span class="item-text">
            <span class="item-name">{p.serverName}</span>
            <span class="subtle small">{hostOf(p.url)} · {p.username} · waiting for approval</span>
          </span>
        </div>
        <a class="btn small" href={loginHref(p.url, p.username)}>Sign in</a>
        <button class="icon-btn" type="button" aria-label="Forget {p.serverName}" onclick={() => removePending(services().repo, p.serverId, p.username)}>
          <Icon name="close" size={18} />
        </button>
      </li>
    {/each}
  </ul>
</div>

<style>
  .narrow {
    max-width: 760px;
  }
  .intro {
    margin-bottom: 18px;
    font-size: 14px;
  }
  .section-title {
    margin: 26px 0 10px;
    font-size: 17px;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 8px;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px 8px 8px;
    color: var(--text-3);
  }
  .item-main {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px;
    color: var(--text);
    text-decoration: none;
  }
  .item-main:hover {
    text-decoration: none;
  }
  .item-icon {
    display: grid;
    place-items: center;
    flex: none;
    width: 40px;
    height: 40px;
    border-radius: 10px;
    background: var(--accent-soft);
    color: var(--accent);
  }
  .pending .item-icon {
    background: var(--surface-2);
    color: var(--warning);
  }
  .item-text {
    display: grid;
    min-width: 0;
  }
  .item-name {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .small {
    font-size: 13px;
  }
  .item-text .small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tags {
    display: flex;
    gap: 6px;
  }
  .warn {
    background: color-mix(in srgb, var(--warning) 18%, transparent);
    color: var(--warning);
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
