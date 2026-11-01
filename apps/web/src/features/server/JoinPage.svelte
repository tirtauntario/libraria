<script lang="ts">
  import type { ServerInfo } from '@libraria/core';
  import { onMount } from 'svelte';
  import { net } from '../../lib/net.svelte';
  import { href, router } from '../../lib/router.svelte';
  import { services } from '../../lib/services';
  import { describeError, isServerError } from '../../lib/server/api';
  import {
    addPending,
    anonymousApi,
    attachServer,
    PendingApprovalError,
    setupOwner,
    signIn,
    signUp,
    type AuthResult,
    type LibrariaSource,
  } from '../../lib/server/servers';
  import { refreshServerCatalog } from '../../lib/server/source';
  import { normalizeServerUrl, ServerUrlError } from '../../lib/server/url';
  import { sync } from '../../lib/sync/controller.svelte';
  import { toasts } from '../../lib/stores/toasts.svelte';
  import Icon from '../../lib/ui/Icon.svelte';
  import Segmented from '../../lib/ui/Segmented.svelte';
  import { servers } from './store.svelte';
  import SyncSetup from './SyncSetup.svelte';
  import { deviceName, normalizeUsername, USERNAME_HINT, USERNAME_PATTERN } from './util';

  let { params: _params }: { params: Record<string, string> } = $props();

  const query = router.query;
  const invite = query.get('invite') ?? '';
  let address = $state(query.get('server') ?? '');
  let info = $state<ServerInfo | null>(null);
  let url = $state('');
  let checking = $state(false);
  let addressError = $state<{ message: string; hint?: string } | null>(null);

  type Mode = 'register' | 'login';
  let mode = $state<Mode>(query.get('mode') === 'login' ? 'login' : 'register');
  let username = $state(query.get('username') ?? '');
  let password = $state('');
  let confirm = $state('');
  let setupToken = $state('');
  let libraryName = $state('');
  let useForSync = $state(!sync.enabled);
  let busy = $state<string | null>(null);
  let formError = $state<string | null>(null);

  type Done = { kind: 'pending'; username: string } | { kind: 'sync'; source: LibrariaSource; masterKey: Uint8Array };
  let done = $state<Done | null>(null);

  onMount(() => {
    if (address) void check();
  });

  async function check(e?: SubmitEvent) {
    e?.preventDefault();
    addressError = null;
    info = null;
    let normalized: string;
    try {
      normalized = normalizeServerUrl(address);
    } catch (err) {
      addressError = { message: err instanceof ServerUrlError ? err.message : describeError(err) };
      return;
    }
    checking = true;
    try {
      const i = await anonymousApi(normalized).info();
      url = normalized;
      info = i;
      address = normalized;
      if (i.setupRequired) libraryName = libraryName || i.name;
    } catch (err) {
      if (isServerError(err, 'mixed_content')) {
        addressError = {
          message: describeError(err),
          hint: 'Browsers block plain http:// servers from apps loaded over https://. Give the server a certificate (Caddy, Tailscale or a Cloudflare Tunnel) and use its https:// address.',
        };
      } else if (isServerError(err, 'network')) {
        addressError = {
          message: `Could not reach ${normalized}.`,
          hint: 'Check the address and that the server is running. It must be reachable over HTTPS and list this app’s address in allowedOrigins (or serve this app itself).',
        };
      } else if (isServerError(err) && err.status === 404) {
        addressError = { message: 'There is a web server at this address, but it is not a Libraria server.' };
      } else {
        addressError = { message: describeError(err) };
      }
    } finally {
      checking = false;
    }
  }

  const passwordsDiffer = $derived((mode === 'register' || info?.setupRequired) && confirm.length > 0 && confirm !== password);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!info) return;
    formError = null;
    const name = normalizeUsername(username);
    if ((mode === 'register' || info.setupRequired) && password !== confirm) {
      formError = 'The passwords do not match.';
      return;
    }
    busy = 'Securing your password…';
    try {
      let result: AuthResult;
      if (info.setupRequired) {
        result = await setupOwner(url, setupToken, name, password, libraryName.trim() || 'Libraria', { deviceName: deviceName() });
      } else if (mode === 'register') {
        result = await signUp(url, name, password, { inviteToken: invite || null, deviceName: deviceName() });
      } else {
        result = await signIn(url, name, password, deviceName());
      }
      password = '';
      confirm = '';
      if (!result.auth.token) {
        await addPending(services().repo, {
          url,
          serverId: result.info.id,
          serverName: result.info.name,
          username: name,
          inviteToken: invite || null,
          createdAt: Date.now(),
        });
        done = { kind: 'pending', username: name };
        return;
      }
      busy = 'Adding the library…';
      const source = await attachServer(services().repo, url, result.info, result.auth);
      await servers.reload();
      void refreshServerCatalog(source, services()).catch(() => {});
      if (sync.isHome(source.id)) await sync.signedIn(source.id);
      if (useForSync && !sync.enabled) {
        done = { kind: 'sync', source, masterKey: result.masterKey };
      } else {
        finish(source);
      }
    } catch (err) {
      if (err instanceof PendingApprovalError) {
        await addPending(services().repo, { url, serverId: info.id, serverName: info.name, username: name, createdAt: Date.now() });
        done = { kind: 'pending', username: name };
      } else if (isServerError(err) && err.status === 401) {
        formError = 'Wrong user name or password.';
      } else if (isServerError(err) && err.code === 'conflict' && mode === 'register') {
        formError = 'That user name is taken. Pick another, or sign in if it is yours.';
      } else if (isServerError(err) && info.setupRequired && err.status === 403) {
        formError = 'The setup token is not valid. Copy the newest one from the server console; each restart prints a new one.';
      } else {
        formError = describeError(err);
      }
    } finally {
      busy = null;
    }
  }

  async function browseAsGuest() {
    if (!info) return;
    const source = await attachServer(services().repo, url, info, null);
    await servers.reload();
    void refreshServerCatalog(source, services()).catch(() => {});
    finish(source);
  }

  function finish(source: LibrariaSource) {
    toasts.show(`Joined ${source.name}`, { kind: 'success' });
    router.navigate(href('/server', source.id), { replace: true });
  }

  const registration = $derived(
    info?.registration === 'open'
      ? 'Anyone can create an account.'
      : invite
        ? 'You have an invite link.'
        : 'New accounts wait until the owner or a curator accepts them.',
  );
</script>

<div class="page narrow">
  <header class="page-header">
    <button class="icon-btn" type="button" aria-label="Back" onclick={() => router.back('/servers')}><Icon name="arrow-left" /></button>
    <h1>{info?.setupRequired ? 'Set up your server' : 'Join a server'}</h1>
  </header>

  {#if done?.kind === 'pending'}
    <section class="card panel" aria-live="polite">
      <h2><Icon name="info" /> Waiting for approval</h2>
      <p>
        Your account <strong>{done.username}</strong> on <strong>{info?.name}</strong> was created. The owner or a curator has to accept
        it before you can sign in.
      </p>
      <p class="muted">Come back later and sign in from the Servers page. Nothing else is needed on your side.</p>
      <div class="row">
        <a class="btn primary" href="#/servers">Go to servers</a>
      </div>
    </section>
  {:else if done?.kind === 'sync'}
    <section class="card panel">
      <h2>Encrypted sync</h2>
      <SyncSetup source={done.source} masterKey={done.masterKey} ondone={() => done?.kind === 'sync' && finish(done.source)} />
    </section>
  {:else}
    <section class="card panel">
      <form class="form" onsubmit={check}>
        <label class="field">
          <span>Server address</span>
          <input
            class="input"
            bind:value={address}
            placeholder="books.example.org"
            inputmode="url"
            autocomplete="url"
            autocapitalize="off"
            spellcheck="false"
            required
          />
        </label>
        {#if addressError}
          <div class="error-box" role="alert">
            <p><Icon name="alert" size={16} /> {addressError.message}</p>
            {#if addressError.hint}<p class="muted small">{addressError.hint}</p>{/if}
          </div>
        {/if}
        <div class="row">
          {#if !info}
            <p class="muted small grow">Your device only talks to a server after you join it.</p>
          {/if}
          <button class="btn {info ? '' : 'primary'}" type="submit" disabled={checking || !net.online}>
            {#if checking}<span class="spinner small-spin"></span>{/if}
            {info ? 'Check again' : 'Continue'}
          </button>
        </div>
        {#if !net.online}<p class="muted small">You are offline. Connect to join a server.</p>{/if}
      </form>
    </section>

    {#if info}
      <section class="card panel server-card" data-testid="server-info">
        <div class="server-head">
          <span class="badge"><Icon name="library" /></span>
          <div>
            <h2>{info.name}</h2>
            <p class="muted small">{url}</p>
          </div>
        </div>
        {#if info.description}<p class="description">{info.description}</p>{/if}
        <div class="chips">
          <span class="chip">{info.visibility === 'public' ? 'Public library' : 'Private library'}</span>
          {#if !info.setupRequired}
            <span class="chip">{info.registration === 'open' ? 'Open signups' : 'Signups need approval'}</span>
          {/if}
          {#if info.anonymousAccess !== 'none'}<span class="chip">Guests can {info.anonymousAccess === 'read' ? 'read' : 'browse'}</span>{/if}
        </div>
        {#if !info.setupRequired}<p class="muted small">{registration}</p>{/if}
      </section>

      <section class="card panel">
        {#if info.setupRequired}
          <p class="muted">
            This server has no owner yet. The person who started it can finish the setup: the server printed a one-time
            <strong>setup token</strong> in its console (or <code>docker logs</code>).
          </p>
        {:else}
          <Segmented
            label="Account"
            value={mode}
            onchange={(v) => {
              mode = v;
              formError = null;
            }}
            options={[
              { value: 'register', label: 'Create account' },
              { value: 'login', label: 'Sign in' },
            ]}
          />
        {/if}

        <form class="form auth" onsubmit={submit}>
          {#if info.setupRequired}
            <label class="field">
              <span>Setup token</span>
              <input class="input mono" bind:value={setupToken} autocomplete="off" spellcheck="false" required />
            </label>
            <label class="field">
              <span>Library name</span>
              <input class="input" bind:value={libraryName} maxlength="100" required />
            </label>
          {/if}
          <label class="field">
            <span>User name</span>
            <input
              class="input"
              bind:value={username}
              autocomplete="username"
              autocapitalize="off"
              spellcheck="false"
              pattern={USERNAME_PATTERN}
              title={USERNAME_HINT}
              required
            />
          </label>
          <label class="field">
            <span>Password</span>
            <input
              class="input"
              type="password"
              bind:value={password}
              autocomplete={mode === 'login' && !info.setupRequired ? 'current-password' : 'new-password'}
              minlength={mode === 'login' && !info.setupRequired ? 1 : 8}
              required
            />
          </label>
          {#if mode === 'register' || info.setupRequired}
            <label class="field">
              <span>Repeat password</span>
              <input class="input" type="password" bind:value={confirm} autocomplete="new-password" required />
            </label>
            {#if passwordsDiffer}<p class="error small">The passwords do not match.</p>{/if}
            <p class="muted small">
              Your password never leaves this device; Libraria sends a key derived from it. Nobody, not even the server owner, can
              reset it for you.
            </p>
          {/if}
          {#if !sync.enabled}
            <label class="check">
              <input type="checkbox" bind:checked={useForSync} />
              <span>
                Sync my reading through this server
                <span class="muted small block">Progress, bookmarks, libraries and sources, end-to-end encrypted with this password.</span>
              </span>
            </label>
          {/if}
          {#if formError}<p class="error" role="alert">{formError}</p>{/if}
          {#if busy}
            <p class="busy" aria-live="polite"><span class="spinner"></span> {busy}</p>
          {/if}
          <div class="row">
            {#if !info.setupRequired && info.anonymousAccess !== 'none'}
              <button class="btn ghost" type="button" onclick={browseAsGuest} disabled={!!busy}>Browse as guest</button>
            {/if}
            <span class="grow"></span>
            <button class="btn primary" type="submit" disabled={!!busy || !net.online}>
              {info.setupRequired ? 'Create owner account' : mode === 'register' ? 'Create account' : 'Sign in'}
            </button>
          </div>
        </form>
      </section>
    {/if}
  {/if}
</div>

<style>
  .narrow {
    max-width: 640px;
  }
  .panel {
    padding: 18px 20px;
    margin-bottom: 16px;
    display: grid;
    gap: 12px;
  }
  .panel h2 {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 18px;
  }
  .form {
    display: grid;
    gap: 14px;
  }
  .auth {
    margin-top: 4px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .grow {
    flex: 1 1 auto;
  }
  .small {
    font-size: 13px;
  }
  .block {
    display: block;
    font-weight: 400;
  }
  .mono {
    font-family: var(--font-mono);
  }
  .error {
    color: var(--danger);
  }
  .error-box {
    display: grid;
    gap: 4px;
    padding: 10px 12px;
    border-radius: var(--radius);
    background: var(--danger-soft);
  }
  .error-box p:first-child {
    display: flex;
    gap: 8px;
    align-items: center;
    color: var(--danger);
    font-weight: 550;
  }
  .server-head {
    display: flex;
    gap: 12px;
    align-items: center;
    min-width: 0;
  }
  .server-head > div {
    min-width: 0;
  }
  .server-head p {
    overflow-wrap: anywhere;
  }
  .badge {
    display: grid;
    place-items: center;
    flex: none;
    width: 44px;
    height: 44px;
    border-radius: 12px;
    background: var(--accent-soft);
    color: var(--accent);
  }
  .description {
    white-space: pre-line;
    color: var(--text-2);
  }
  .chips {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .check {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    font-weight: 550;
  }
  .check input {
    margin-top: 2px;
    flex: none;
  }
  .busy {
    display: flex;
    gap: 10px;
    align-items: center;
    color: var(--text-2);
  }
  .small-spin {
    width: 14px;
    height: 14px;
  }
</style>
