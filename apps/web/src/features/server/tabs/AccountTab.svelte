<script lang="ts">
  import { net } from '../../../lib/net.svelte';
  import { router } from '../../../lib/router.svelte';
  import { services } from '../../../lib/services';
  import { describeError } from '../../../lib/server/api';
  import { changePassword, roleOf, signOut } from '../../../lib/server/servers';
  import { removeServer } from '../../../lib/server/source';
  import { sync } from '../../../lib/sync/controller.svelte';
  import { rewrapDataKey } from '../../../lib/sync/keys';
  import { toasts } from '../../../lib/stores/toasts.svelte';
  import Dialog from '../../../lib/ui/Dialog.svelte';
  import { formatRelative } from '../../../lib/ui/format';
  import { servers, type ServerEntry } from '../store.svelte';
  import { ROLE_LABEL } from '../util';

  let { entry }: { entry: ServerEntry } = $props();
  const role = $derived(roleOf(entry.source));
  const isHome = $derived(sync.home?.sourceId === entry.source.id);
  const c = $derived(entry.source.config);

  function joinHref(mode: 'login' | 'register'): string {
    return `#/join?server=${encodeURIComponent(c.url)}&mode=${mode}${c.username ? `&username=${encodeURIComponent(c.username)}` : ''}`;
  }

  // --- password -------------------------------------------------------------
  let current = $state('');
  let next = $state('');
  let repeat = $state('');
  let changing = $state(false);
  let pwError = $state<string | null>(null);

  async function submitPassword(e: SubmitEvent) {
    e.preventDefault();
    pwError = null;
    if (next !== repeat) {
      pwError = 'The new passwords do not match.';
      return;
    }
    changing = true;
    try {
      const stored = isHome ? sync.storedKey : null;
      await changePassword(services().repo, entry.source, current, next, {
        rewrap: stored ? (mk) => rewrapDataKey(stored, mk) : undefined,
      });
      current = next = repeat = '';
      toasts.show(
        isHome ? 'Password changed. Sync keeps working with the new password.' : 'Password changed. Your other devices must sign in again.',
        { kind: 'success' },
      );
    } catch (err) {
      pwError = describeError(err);
    } finally {
      changing = false;
    }
  }

  // --- sign out / remove ---------------------------------------------------------
  let outOpen = $state(false);
  async function doSignOut() {
    outOpen = false;
    await signOut(services().repo, entry.source);
    await servers.reload();
    toasts.show(`Signed out of ${entry.source.name}`);
  }

  let removeOpen = $state(false);
  async function doRemove() {
    removeOpen = false;
    const name = entry.source.name;
    if (isHome) await sync.forget();
    await removeServer(entry.source, services(), { logout: true });
    await servers.reload();
    toasts.show(`Removed ${name} from this device`);
    router.navigate('/servers', { replace: true });
  }
</script>

<div class="account">
  <section class="card group">
    <h2>Account</h2>
    {#if role}
      <dl class="facts">
        <div><dt>User name</dt><dd>{c.username}</dd></div>
        <div><dt>Role</dt><dd>{ROLE_LABEL[role]}</dd></div>
        {#if entry.state.user}<div><dt>Member since</dt><dd>{formatRelative(entry.state.user.createdAt)}</dd></div>{/if}
        <div><dt>Server</dt><dd class="url">{c.url}</dd></div>
        {#if entry.state.info}<div><dt>Server version</dt><dd>{entry.state.info.serverVersion}</dd></div>{/if}
      </dl>
    {:else}
      <p class="muted">You are browsing as a guest. Create an account to download books, send books and sync.</p>
      <div class="row">
        <a class="btn" href={joinHref('login')}>Sign in</a>
        <a class="btn primary" href={joinHref('register')}>Create account</a>
      </div>
    {/if}
  </section>

  {#if role}
    <section class="card group">
      <h2>Sync</h2>
      {#if isHome}
        <p class="muted">This server keeps your reading in sync, end-to-end encrypted. <a href="#/sync">Sync details</a></p>
      {:else if sync.enabled}
        <p class="muted">Your sync server is {sync.home?.name}. <a href="#/sync">Sync details</a></p>
      {:else}
        <p class="muted">Use this server to keep progress, bookmarks and libraries the same on your devices.</p>
        <div class="row"><a class="btn" href="#/sync">Set up sync</a></div>
      {/if}
    </section>

    <section class="card group">
      <h2>Change password</h2>
      <form class="form" onsubmit={submitPassword}>
        <input class="visually-hidden" autocomplete="username" value={c.username} readonly tabindex="-1" aria-hidden="true" />
        <label class="field"><span>Current password</span><input class="input" type="password" bind:value={current} autocomplete="current-password" required /></label>
        <label class="field"><span>New password</span><input class="input" type="password" bind:value={next} autocomplete="new-password" minlength="8" required /></label>
        <label class="field"><span>Repeat new password</span><input class="input" type="password" bind:value={repeat} autocomplete="new-password" required /></label>
        {#if isHome}<p class="muted small">Your sync key is re-wrapped with the new password; nothing is re-encrypted.</p>{/if}
        <p class="muted small">Other devices signed in to this account are signed out.</p>
        {#if pwError}<p class="error" role="alert">{pwError}</p>{/if}
        <div class="row"><button class="btn primary" type="submit" disabled={changing || !net.online}>{changing ? 'Changing…' : 'Change password'}</button></div>
      </form>
    </section>
  {/if}

  <section class="card group">
    <h2>This device</h2>
    {#if role}
      <div class="line">
        <div><p>Sign out</p><p class="muted small">Books you downloaded stay readable. Your other devices that sync this server are signed out too.</p></div>
        <button class="btn small" type="button" onclick={() => (outOpen = true)}>Sign out…</button>
      </div>
    {/if}
    <div class="line">
      <div><p>Remove this server</p><p class="muted small">Its library and downloaded copies leave this device. Your account stays on the server.</p></div>
      <button class="btn small danger-outline" type="button" onclick={() => (removeOpen = true)}>Remove…</button>
    </div>
  </section>
</div>

<Dialog bind:open={outOpen} title="Sign out of {entry.source.name}?">
  <p class="muted">You can sign in again at any time. Downloaded books still open.{#if isHome} Sync pauses until you sign in again.{/if}</p>
  {#snippet actions()}
    <button class="btn" type="button" onclick={() => (outOpen = false)}>Cancel</button>
    <button class="btn primary" type="button" onclick={doSignOut}>Sign out</button>
  {/snippet}
</Dialog>

<Dialog bind:open={removeOpen} title="Remove {entry.source.name}?">
  <p class="muted">
    The library “{entry.source.name}” and books that are only on this server are removed from this device (and from your other devices
    through sync).{#if isHome} This is your sync server: sync stops on this device.{/if}
  </p>
  {#snippet actions()}
    <button class="btn" type="button" onclick={() => (removeOpen = false)}>Cancel</button>
    <button class="btn danger" type="button" onclick={doRemove}>Remove</button>
  {/snippet}
</Dialog>

<style>
  .account {
    max-width: 760px;
    display: grid;
    gap: 16px;
  }
  .group {
    padding: 18px 20px;
    display: grid;
    gap: 12px;
  }
  h2 {
    font-size: 17px;
  }
  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 12px;
    margin: 0;
  }
  dt {
    font-size: 12px;
    color: var(--text-3);
  }
  dd {
    margin: 2px 0 0;
    font-weight: 550;
  }
  .url {
    overflow-wrap: anywhere;
  }
  .form {
    display: grid;
    gap: 12px;
  }
  .row {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    justify-content: flex-end;
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
  .line:first-of-type {
    border-top: 0;
    padding-top: 0;
  }
  .line > div {
    flex: 1 1 240px;
  }
  .small {
    font-size: 13px;
  }
  .error {
    color: var(--danger);
  }
  .danger-outline {
    color: var(--danger);
    border-color: color-mix(in srgb, var(--danger) 45%, transparent);
  }
</style>
