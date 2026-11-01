<script lang="ts">
  import type { Source } from '@libraria/core';
  import Icon from '../../ui/Icon.svelte';
  import { SourceError, errorMessage, redact } from '../errors';
  import type { SourceSetupProps } from '../types';
  import { WebdavDriver, normalizeWebdavUrl } from '../webdav';
  import CorsHelp from './CorsHelp.svelte';

  let { onCreate, onCancel }: SourceSetupProps = $props();

  let url = $state('');
  let username = $state('');
  let password = $state('');
  let name = $state('');
  let status = $state<{ kind: 'idle' | 'testing' | 'ok' | 'error'; message?: string; cors?: boolean }>({ kind: 'idle' });
  let saving = $state(false);
  const uid = $props.id();

  function driver(): WebdavDriver {
    const n = normalizeWebdavUrl(url);
    if (n.username && !username) username = n.username;
    if (n.password && !password) password = n.password;
    url = n.url;
    const src = { id: 'test', name: 'test', config: { kind: 'webdav', url: n.url, username, password } } as Source;
    return new WebdavDriver(src, { url: n.url, username, password });
  }

  async function test(): Promise<boolean> {
    status = { kind: 'testing' };
    try {
      await driver().test(AbortSignal.timeout(20_000));
      status = { kind: 'ok', message: 'Connected. The folder is readable.' };
      return true;
    } catch (err) {
      const secrets = [password].filter((s) => s.length >= 3);
      const message =
        (err as Error)?.name === 'TimeoutError' ? 'The server did not answer within 20 seconds.' : redact(errorMessage(err), secrets);
      status = { kind: 'error', message, cors: err instanceof SourceError && err.corsHelp };
      return false;
    }
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    saving = true;
    try {
      if (status.kind !== 'ok' && !(await test())) return;
      const host = new URL(url).host;
      await onCreate(name.trim() || host, { kind: 'webdav', url, username, password });
    } finally {
      saving = false;
    }
  }
</script>

<form class="form" onsubmit={save} autocomplete="off">
  <label class="field">
    <span>Server address</span>
    <input
      class="input"
      type="text"
      inputmode="url"
      bind:value={url}
      oninput={() => (status = { kind: 'idle' })}
      placeholder="https://cloud.example.com/remote.php/dav/files/me/Books/"
      required
      autocapitalize="off"
      spellcheck="false"
      aria-describedby="{uid}-url-hint"
    />
  </label>
  <p class="hint" id="{uid}-url-hint">The folder to read. Nextcloud: …/remote.php/dav/files/USERNAME/</p>
  <div class="two">
    <label class="field">
      <span>Username</span>
      <input class="input" bind:value={username} oninput={() => (status = { kind: 'idle' })} autocomplete="username" autocapitalize="off" spellcheck="false" />
    </label>
    <label class="field">
      <span>Password</span>
      <input class="input" type="password" bind:value={password} oninput={() => (status = { kind: 'idle' })} autocomplete="current-password" />
    </label>
  </div>
  <p class="hint">Use an app password if your server offers them. It is stored on this device, and synced only end-to-end encrypted.</p>
  <label class="field">
    <span>Name (optional)</span>
    <input class="input" bind:value={name} placeholder="e.g. Home NAS" />
  </label>

  <div class="test">
    <button class="btn small" type="button" onclick={test} disabled={!url || status.kind === 'testing'}>
      {status.kind === 'testing' ? 'Testing…' : 'Test connection'}
    </button>
  </div>
  {#if status.kind === 'ok'}
    <p class="status ok" role="status"><Icon name="check" size={18} /> {status.message}</p>
  {:else if status.kind === 'error'}
    <div class="status err" role="alert">
      <Icon name="alert" size={18} />
      <span>{status.message}</span>
    </div>
  {/if}
  <CorsHelp open={status.kind === 'error' && !!status.cors} />

  <div class="actions">
    <button class="btn" type="button" onclick={onCancel}>Back</button>
    <span class="spacer"></span>
    <button class="btn primary" type="submit" disabled={!url || saving || status.kind === 'testing'}>Add source</button>
  </div>
</form>

<style>
  .form {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 14px;
  }
  .two {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 14px;
  }
  .hint {
    font-size: 12.5px;
    font-weight: 400;
    color: var(--text-3);
    margin: -6px 0 0;
  }
  .status {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    padding: 10px 12px;
    border-radius: var(--radius);
    font-size: 14px;
    margin: 0;
  }
  .status :global(svg) {
    flex: none;
    margin-top: 1px;
  }
  .ok {
    background: var(--accent-soft);
    color: var(--success);
  }
  .err {
    background: var(--danger-soft);
    color: var(--danger);
  }
  .actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
  }
  .test {
    display: flex;
  }
  .spacer {
    flex: 1;
  }
</style>
