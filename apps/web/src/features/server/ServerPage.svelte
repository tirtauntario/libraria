<script lang="ts">
  import { canManageBooks } from '@libraria/core';
  import type { Component } from 'svelte';
  import { net } from '../../lib/net.svelte';
  import { href, router } from '../../lib/router.svelte';
  import { services } from '../../lib/services';
  import { refreshAccount, roleOf } from '../../lib/server/servers';
  import { refreshIfStale } from '../../lib/server/source';
  import { sync } from '../../lib/sync/controller.svelte';
  import Icon from '../../lib/ui/Icon.svelte';
  import { servers, type ServerEntry } from './store.svelte';
  import AccountTab from './tabs/AccountTab.svelte';
  import BooksTab from './tabs/BooksTab.svelte';
  import ContributeTab from './tabs/ContributeTab.svelte';
  import InvitesTab from './tabs/InvitesTab.svelte';
  import MembersTab from './tabs/MembersTab.svelte';
  import ReviewTab from './tabs/ReviewTab.svelte';
  import SettingsTab from './tabs/SettingsTab.svelte';
  import SourcesTab from './tabs/SourcesTab.svelte';
  import { hostOf, ROLE_LABEL } from './util';

  let { params }: { params: Record<string, string> } = $props();

  const entry = $derived(servers.get(params.id ?? ''));
  const role = $derived(entry ? roleOf(entry.source) : null);

  interface Tab {
    id: string;
    label: string;
    component: Component<{ entry: ServerEntry }>;
    show: boolean;
  }
  const tabs = $derived<Tab[]>([
    { id: 'books', label: 'Books', component: BooksTab, show: true },
    { id: 'contribute', label: 'My submissions', component: ContributeTab, show: !!role },
    { id: 'review', label: 'Review', component: ReviewTab, show: canManageBooks(role) },
    { id: 'members', label: 'Members', component: MembersTab, show: canManageBooks(role) },
    { id: 'invites', label: 'Invites', component: InvitesTab, show: canManageBooks(role) },
    { id: 'settings', label: 'Library settings', component: SettingsTab, show: role === 'owner' },
    { id: 'sources', label: 'Disk sources', component: SourcesTab, show: role === 'owner' },
    { id: 'account', label: role ? 'Account' : 'Guest', component: AccountTab, show: true },
  ].filter((t) => t.show));
  const current = $derived(tabs.find((t) => t.id === router.query.get('tab')) ?? tabs[0]!);

  // Refresh the catalog (throttled) and the account when the page opens online.
  let refreshedFor = '';
  $effect(() => {
    const e = entry;
    if (!e || !net.online || refreshedFor === e.source.id) return;
    refreshedFor = e.source.id;
    const s = services();
    void refreshIfStale(e.source, s, 60_000).catch(() => {});
    if (!e.state.sessionExpired) void refreshAccount(s.repo, e.source).catch(() => {});
  });

  function signInAgain() {
    if (!entry) return;
    const c = entry.source.config;
    router.navigate(`/join?server=${encodeURIComponent(c.url)}&mode=login&username=${encodeURIComponent(c.username)}`);
  }
</script>

<div class="page">
  <header class="page-header">
    <button class="icon-btn" type="button" aria-label="Back" onclick={() => router.back('/servers')}><Icon name="arrow-left" /></button>
    <div class="title">
      <h1>{entry?.source.name ?? 'Server'}</h1>
      {#if entry}
        <p class="subtle small">
          {hostOf(entry.source.config.url)} ·
          {role ? `${entry.source.config.username} · ${ROLE_LABEL[role]}` : 'Guest'}
          {#if sync.home?.sourceId === entry.source.id}&nbsp;· sync server{/if}
        </p>
      {/if}
    </div>
  </header>

  {#if !servers.loaded}
    <div class="spinner"></div>
  {:else if !entry}
    <p class="muted">This server is not on this device any more. <a href="#/servers">See your servers</a>.</p>
  {:else}
    {#if entry.state.sessionExpired}
      <div class="banner warn" role="status">
        <Icon name="alert" size={18} />
        <span>You are signed out of this server. Books you downloaded still open.</span>
        <button class="btn small" type="button" onclick={signInAgain}>Sign in</button>
      </div>
    {:else if !net.online}
      <div class="banner" role="status">
        <Icon name="wifi-off" size={18} />
        <span>Offline: showing what this device remembers. Changes need a connection.</span>
      </div>
    {/if}
    {#if entry.state.info?.description && current.id === 'books'}
      <p class="description">{entry.state.info.description}</p>
    {/if}

    <nav class="tabs" aria-label="Server sections">
      {#each tabs as t (t.id)}
        <a href="{href('/server', entry.source.id)}?tab={t.id}" aria-current={current.id === t.id ? 'page' : undefined}>
          {t.label}
        </a>
      {/each}
    </nav>

    {#key current.id + entry.source.id}
      <current.component {entry} />
    {/key}
  {/if}
</div>

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
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .small {
    font-size: 13px;
  }
  .description {
    margin: -6px 0 14px;
    max-width: 720px;
    color: var(--text-2);
    white-space: pre-line;
  }
  .banner {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px 10px;
    margin-bottom: 14px;
    padding: 10px 14px;
    border-radius: var(--radius);
    background: var(--surface-2);
    color: var(--text-2);
    font-size: 14px;
  }
  .banner span {
    flex: 1 1 200px;
  }
  .banner.warn {
    background: color-mix(in srgb, var(--warning) 14%, var(--surface));
    color: var(--text);
  }
  .tabs {
    display: flex;
    gap: 4px;
    margin: 0 -16px 18px;
    padding: 0 16px;
    overflow-x: auto;
    scrollbar-width: none;
    border-bottom: 1px solid var(--border);
  }
  .tabs::-webkit-scrollbar {
    display: none;
  }
  .tabs a {
    flex: none;
    padding: 10px 12px;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    color: var(--text-2);
    font-weight: 550;
    font-size: 14px;
    text-decoration: none;
    white-space: nowrap;
  }
  .tabs a:hover {
    color: var(--text);
  }
  .tabs a[aria-current='page'] {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }
  @media (min-width: 720px) {
    .tabs {
      margin: 0 0 20px;
      padding: 0;
    }
  }
</style>
