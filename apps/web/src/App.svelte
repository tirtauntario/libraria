<script lang="ts">
  import { onMount } from 'svelte';
  import { runStartupHooks } from './lib/extensions';
  import { runEviction } from './lib/library/offline';
  import { resolve, router } from './lib/router.svelte';
  import { initServices } from './lib/services';
  import { catalog } from './lib/stores/catalog.svelte';
  import { connectVersions } from './lib/stores/data.svelte';
  import { listenForLaunchFiles } from './lib/stores/importer.svelte';
  import { pwa } from './lib/stores/pwa.svelte';
  import { settings } from './lib/stores/settings.svelte';
  import DropZone from './lib/ui/DropZone.svelte';
  import Shell from './lib/ui/Shell.svelte';
  import Toasts from './lib/ui/Toasts.svelte';

  let ready = $state(false);
  let error = $state<string | null>(null);

  onMount(() => {
    void start();
    const flush = () => void settings.flush();
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  });

  async function start() {
    try {
      const s = await initServices();
      connectVersions(s.repo.events);
      await Promise.all([settings.load(s.repo), catalog.load(s)]);
      ready = true;
      pwa.init();
      listenForLaunchFiles();
      void runEviction(s).catch(() => {});
      void runStartupHooks();
    } catch (err) {
      console.error(err);
      error = err instanceof Error ? err.message : String(err);
    }
  }

  const match = $derived(resolve(router.path));
</script>

{#if error}
  <main class="splash" role="alert">
    <h1>Libraria could not start</h1>
    <p class="muted">{error}</p>
    <p class="subtle">Private browsing modes sometimes block the storage Libraria needs.</p>
    <button class="btn" type="button" onclick={() => location.reload()}>Try again</button>
  </main>
{:else if !ready}
  <div class="splash" aria-busy="true" aria-label="Loading"><div class="spinner"></div></div>
{:else if match}
  {#key match.route.pattern + JSON.stringify(match.params)}
    {#if match.route.layout === 'bare'}
      <match.route.component params={match.params} />
    {:else}
      <Shell section={match.route.section}>
        <match.route.component params={match.params} />
      </Shell>
      <DropZone />
    {/if}
  {/key}
{/if}

<Toasts />

<style>
  .splash {
    min-height: 100dvh;
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 12px;
    padding: 24px;
    text-align: center;
    color: var(--text-2);
  }
  .splash h1 {
    color: var(--text);
    font-size: 20px;
  }
</style>
