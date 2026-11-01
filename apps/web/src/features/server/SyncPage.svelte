<script lang="ts">
  import { net } from '../../lib/net.svelte';
  import { router } from '../../lib/router.svelte';
  import { services } from '../../lib/services';
  import { describeError, isServerError } from '../../lib/server/api';
  import { attachServer, signIn, type LibrariaSource } from '../../lib/server/servers';
  import { sync } from '../../lib/sync/controller.svelte';
  import { toasts } from '../../lib/stores/toasts.svelte';
  import Dialog from '../../lib/ui/Dialog.svelte';
  import Icon from '../../lib/ui/Icon.svelte';
  import { servers } from './store.svelte';
  import SyncSetup from './SyncSetup.svelte';
  import SyncStatus from './SyncStatus.svelte';
  import { deviceName, hostOf } from './util';

  let { params: _params }: { params: Record<string, string> } = $props();

  const candidates = $derived(servers.signedIn);
  let chosen = $state<string>('');
  $effect(() => {
    if (!chosen && candidates[0]) chosen = candidates[0].source.id;
  });
  let password = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);
  let setup = $state<{ source: LibrariaSource; masterKey: Uint8Array } | null>(null);

  async function enable(e: SubmitEvent) {
    e.preventDefault();
    const entry = servers.get(chosen);
    if (!entry) return;
    busy = true;
    error = null;
    try {
      // Signing in again checks the password and derives the key that protects sync.
      const r = await signIn(entry.source.config.url, entry.source.config.username, password, deviceName());
      password = '';
      const source = await attachServer(services().repo, entry.source.config.url, r.info, r.auth);
      setup = { source, masterKey: r.masterKey };
    } catch (err) {
      error = isServerError(err) && err.status === 401 ? 'Wrong password.' : describeError(err);
    } finally {
      busy = false;
    }
  }

  let forgetOpen = $state(false);
  async function forget() {
    await sync.forget();
    forgetOpen = false;
    toasts.show('The sync key was removed from this device.');
  }

  let resetOpen = $state(false);
  let resetText = $state('');
  let resetting = $state(false);
  async function reset() {
    resetting = true;
    try {
      await sync.reset();
      resetOpen = false;
      toasts.show('Sync is off. The synced data was deleted from the server.');
    } catch (err) {
      toasts.error('Could not turn sync off', describeError(err));
    } finally {
      resetting = false;
      resetText = '';
    }
  }

  const home = $derived(sync.home ? servers.get(sync.home.sourceId) : undefined);
  function signInAgain() {
    if (!home) return;
    router.navigate(
      `/join?server=${encodeURIComponent(home.source.config.url)}&mode=login&username=${encodeURIComponent(home.source.config.username)}`,
    );
  }
</script>

<div class="page narrow">
  <header class="page-header">
    <button class="icon-btn" type="button" aria-label="Back" onclick={() => router.back('/servers')}><Icon name="arrow-left" /></button>
    <h1>Sync</h1>
  </header>

  {#if setup}
    <section class="card panel">
      <h2>Encrypted sync</h2>
      <SyncSetup source={setup.source} masterKey={setup.masterKey} ondone={() => (setup = null)} />
    </section>
  {:else}
    <SyncStatus />

    {#if sync.enabled}
      <section class="card panel">
        <h2>Sync server</h2>
        <p>
          <strong>{sync.home?.name}</strong> as <strong>{sync.home?.username}</strong>{#if home}&nbsp;· {hostOf(home.source.config.url)}{/if}
        </p>
        {#if sync.phase === 'signed-out'}
          <p class="muted">Sign in to the server again to resume. Your data on this device is safe.</p>
          <div class="row"><button class="btn primary" type="button" onclick={signInAgain} disabled={!home}>Sign in again</button></div>
        {/if}
        {#if sync.phase === 'reset'}
          <p class="muted">Another device turned sync off or set it up with new keys. Remove the old key here, then set sync up again.</p>
          <div class="row"><button class="btn primary" type="button" onclick={() => sync.forget()}>Remove old key</button></div>
        {/if}
        <p class="muted small">Automatic sync follows “Sync automatically” under Settings → This device. “Sync now” always works.</p>
      </section>

      <section class="card panel">
        <h2>How your data is protected</h2>
        <ul class="facts">
          <li>Everything that syncs is encrypted on your devices with a key only you hold. The server stores ciphertext and cannot read titles, positions, notes or passwords of your sources.</li>
          <li>Your login password unlocks that key. A recovery key, shown once when sync was set up, unlocks it too.</li>
          <li>This device keeps the unlocked key so it can sync without asking for your password. Anyone who can open this browser profile can read your library anyway; on a shared computer, remove the key when you are done.</li>
        </ul>
      </section>

      <section class="card panel danger">
        <h2>Turn off</h2>
        <div class="line">
          <div><p>Forget the sync key on this device</p><p class="muted small">Stops syncing here. Your data stays on this device and on the server.</p></div>
          <button class="btn small" type="button" onclick={() => (forgetOpen = true)}>Forget key…</button>
        </div>
        <div class="line">
          <div><p>Turn off sync and delete synced data</p><p class="muted small">Deletes the encrypted copy on the server for all your devices. Data on each device stays.</p></div>
          <button class="btn small danger-outline" type="button" disabled={!net.online} onclick={() => (resetOpen = true)}>Delete…</button>
        </div>
      </section>
    {:else}
      <section class="card panel">
        <h2>Choose a sync server</h2>
        {#if candidates.length === 0}
          <p class="muted">Join or sign in to a Libraria server first. Any server you have an account on can keep your reading in sync, even a small private one of your own.</p>
          <div class="row"><a class="btn primary" href="#/join">Add a server</a></div>
        {:else}
          <form class="form" onsubmit={enable}>
            <fieldset>
              <legend class="label">Server</legend>
              {#each candidates as { source } (source.id)}
                <label class="radio">
                  <input type="radio" name="home" value={source.id} bind:group={chosen} />
                  <span>{source.name} <span class="muted small">· {source.config.username} · {hostOf(source.config.url)}</span></span>
                </label>
              {/each}
            </fieldset>
            <label class="field">
              <span>Your password on that server</span>
              <input class="input" type="password" bind:value={password} autocomplete="current-password" required />
            </label>
            <p class="muted small">The password encrypts your sync data. It never leaves this device.</p>
            {#if error}<p class="error" role="alert">{error}</p>{/if}
            <div class="row">
              {#if busy}<span class="muted small"><span class="spinner inline"></span> Securing your password…</span>{/if}
              <button class="btn primary" type="submit" disabled={busy || !net.online || !chosen}>Turn on sync</button>
            </div>
          </form>
        {/if}
      </section>
    {/if}
  {/if}
</div>

<Dialog bind:open={forgetOpen} title="Forget the sync key?">
  <p class="muted">This device stops syncing. To sync again you need your password or recovery key.</p>
  {#snippet actions()}
    <button class="btn" type="button" onclick={() => (forgetOpen = false)}>Cancel</button>
    <button class="btn danger" type="button" onclick={forget}>Forget key</button>
  {/snippet}
</Dialog>

<Dialog bind:open={resetOpen} title="Delete synced data?" onclose={() => (resetText = '')}>
  <form id="reset-form" class="form" onsubmit={(e) => { e.preventDefault(); if (resetText === 'delete') void reset(); }}>
    <p class="muted">
      The encrypted progress, bookmarks, libraries, sources and settings on <strong>{sync.home?.name}</strong> are deleted for every device.
      Other devices stop syncing until you set sync up again. This cannot be undone.
    </p>
    <label class="field"><span>Type <strong>delete</strong> to confirm</span><input class="input" bind:value={resetText} autocomplete="off" /></label>
  </form>
  {#snippet actions()}
    <button class="btn" type="button" onclick={() => (resetOpen = false)}>Cancel</button>
    <button class="btn danger" type="submit" form="reset-form" disabled={resetText !== 'delete' || resetting}>Delete synced data</button>
  {/snippet}
</Dialog>

<style>
  .narrow {
    max-width: 760px;
  }
  .panel {
    padding: 18px 20px;
    margin-top: 16px;
    display: grid;
    gap: 12px;
  }
  .panel h2 {
    font-size: 17px;
  }
  .form {
    display: grid;
    gap: 14px;
  }
  fieldset {
    border: 0;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 8px;
  }
  .radio {
    display: flex;
    gap: 10px;
    align-items: center;
    min-height: 36px;
  }
  .row {
    display: flex;
    gap: 10px;
    align-items: center;
    justify-content: flex-end;
    flex-wrap: wrap;
  }
  .small {
    font-size: 13px;
  }
  .error {
    color: var(--danger);
  }
  .facts {
    margin: 0;
    padding-left: 18px;
    display: grid;
    gap: 8px;
    color: var(--text-2);
    font-size: 14px;
  }
  .line {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 10px 16px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }
  .line > div {
    flex: 1 1 240px;
  }
  .danger-outline {
    color: var(--danger);
    border-color: color-mix(in srgb, var(--danger) 45%, transparent);
  }
  .inline {
    display: inline-block;
    width: 14px;
    height: 14px;
    vertical-align: -2px;
  }
</style>
