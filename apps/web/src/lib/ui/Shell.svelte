<script lang="ts">
  import type { Snippet } from 'svelte';
  import { navItems } from '../extensions';
  import { net } from '../net.svelte';
  import { href } from '../router.svelte';
  import { catalog } from '../stores/catalog.svelte';
  import { importer, pickFiles } from '../stores/importer.svelte';
  import Icon from './Icon.svelte';
  import Logo from './Logo.svelte';

  let { section, children }: { section?: string; children: Snippet } = $props();
  const items = navItems.list();
</script>

<a class="skip" href="#main">Skip to content</a>

<div class="shell">
  <aside class="sidebar" aria-label="Main">
    <a class="brand" href="#/"><Logo size={28} /><span>Libraria</span></a>
    <button class="btn primary import" type="button" onclick={pickFiles} disabled={importer.busy}>
      <Icon name="plus" size={18} /> Add books
    </button>
    <nav>
      {#each items as item (item.id)}
        <a class="nav-link" href={item.href} aria-current={section === item.id ? 'page' : undefined}>
          <Icon name={item.icon} />
          <span>{item.label}</span>
        </a>
      {/each}
    </nav>
    {#if catalog.libraries.length}
      <div class="libs">
        <p class="libs-title">Your libraries</p>
        {#each catalog.libraries as lib (lib.id)}
          <a class="lib-link" href={href('/library', lib.id)}>
            <Icon name={lib.id === catalog.localLibraryId ? 'device' : 'library'} size={18} />
            <span>{lib.name}</span>
          </a>
        {/each}
      </div>
    {/if}
    {#if !net.online}
      <p class="offline"><Icon name="wifi-off" size={16} /> Offline</p>
    {/if}
  </aside>

  <main id="main" tabindex="-1">
    {#if !net.online}
      <div class="offline-banner" role="status"><Icon name="wifi-off" size={16} /> You're offline. Books on this device still open.</div>
    {/if}
    {@render children()}
  </main>

  <nav class="tabbar" aria-label="Main">
    {#each items as item (item.id)}
      <a href={item.href} aria-current={section === item.id ? 'page' : undefined}>
        <Icon name={item.icon} size={22} />
        <span>{item.label}</span>
      </a>
    {/each}
  </nav>
</div>

<style>
  .skip {
    position: absolute;
    left: 8px;
    top: -48px;
    z-index: 200;
    padding: 8px 12px;
    border-radius: var(--radius);
    background: var(--accent);
    color: var(--accent-text);
  }
  .skip:focus {
    top: 8px;
  }
  .shell {
    min-height: 100dvh;
    padding-left: var(--safe-left);
    padding-right: var(--safe-right);
  }
  main {
    outline: none;
    padding-top: var(--safe-top);
    padding-bottom: calc(var(--nav-h) + var(--safe-bottom));
  }
  .offline-banner {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 6px 12px;
    background: var(--surface-2);
    color: var(--text-2);
    font-size: 13px;
  }

  .sidebar {
    display: none;
  }
  .tabbar {
    position: fixed;
    z-index: 50;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    height: calc(var(--nav-h) + var(--safe-bottom));
    padding: 0 var(--safe-right) var(--safe-bottom) var(--safe-left);
    background: color-mix(in srgb, var(--bg-elevated) 92%, transparent);
    backdrop-filter: saturate(1.4) blur(16px);
    -webkit-backdrop-filter: saturate(1.4) blur(16px);
    border-top: 1px solid var(--border);
  }
  .tabbar a {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    color: var(--text-3);
    font-size: 11px;
    font-weight: 600;
    text-decoration: none;
  }
  .tabbar a[aria-current='page'] {
    color: var(--accent);
  }

  @media (min-width: 900px) {
    .shell {
      display: grid;
      grid-template-columns: var(--sidebar-w) 1fr;
    }
    main {
      padding-bottom: 0;
      min-width: 0;
    }
    .tabbar {
      display: none;
    }
    .sidebar {
      position: sticky;
      top: 0;
      height: 100dvh;
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: calc(20px + var(--safe-top)) 14px 20px;
      border-right: 1px solid var(--border);
      background: var(--bg);
      overflow-y: auto;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 0 8px 14px;
      color: var(--text);
      font-family: var(--font-serif);
      font-size: 21px;
      font-weight: 650;
      letter-spacing: -0.01em;
      text-decoration: none;
    }
    .import {
      margin: 0 0 14px;
    }
    nav {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .nav-link,
    .lib-link {
      display: flex;
      align-items: center;
      gap: 12px;
      min-height: 38px;
      padding: 0 10px;
      border-radius: var(--radius);
      color: var(--text-2);
      font-weight: 550;
      text-decoration: none;
      transition: background-color var(--dur) var(--ease), color var(--dur) var(--ease);
    }
    .nav-link:hover,
    .lib-link:hover {
      background: var(--surface-2);
      color: var(--text);
    }
    .nav-link[aria-current='page'] {
      background: var(--accent-soft);
      color: var(--accent);
    }
    .libs {
      margin-top: 18px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .libs-title {
      padding: 0 10px 6px;
      font-size: 11.5px;
      font-weight: 650;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--text-3);
    }
    .lib-link {
      font-weight: 500;
      font-size: 14px;
    }
    .lib-link span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .offline {
      margin-top: auto;
      display: flex;
      gap: 8px;
      align-items: center;
      padding: 8px 10px;
      color: var(--text-3);
      font-size: 13px;
    }
  }
</style>
