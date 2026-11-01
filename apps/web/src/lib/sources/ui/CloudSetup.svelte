<script lang="ts">
  /**
   * Add a Google Drive or Dropbox source: client ID → sign in (full-page
   * redirect, we come back to '#/libraries?add=<kind>') → pick the folder →
   * name it.
   */
  import type { OAuthTokens, Source, SourceConfig } from '@libraria/core';
  import { settings } from '../../stores/settings.svelte';
  import Icon from '../../ui/Icon.svelte';
  import { DropboxDriver } from '../dropbox';
  import { errorMessage } from '../errors';
  import { GdriveDriver } from '../gdrive';
  import { oauthFlow, startSignIn } from '../oauth-flow.svelte';
  import type { SourceDriver, SourceSetupProps } from '../types';
  import FolderPicker from './FolderPicker.svelte';
  import OAuthAppField from './OAuthAppField.svelte';

  let { onCreate, onCancel, provider }: SourceSetupProps & { provider: 'gdrive' | 'dropbox' } = $props();

  const title = $derived(provider === 'gdrive' ? 'Google Drive' : 'Dropbox');
  const clientId = $derived(provider === 'gdrive' ? settings.synced.oauth.googleClientId : settings.synced.oauth.dropboxAppKey);

  let tokens = $state.raw<OAuthTokens | null>(null);
  let picked = $state<{ path: string; label: string } | null>(null);
  let name = $state('');
  let error = $state<string | null>(null);
  let leaving = $state(false);

  // Tokens arrive from the redirect (possibly after this form mounted).
  $effect(() => {
    if (!tokens && oauthFlow.setup[provider]) tokens = oauthFlow.takeSetup(provider);
  });
  const flowError = $derived(oauthFlow.error[provider]);

  function config(root: { path: string; label: string }): SourceConfig {
    if (provider === 'gdrive') {
      const id = root.path.split('/').filter(Boolean).pop() ?? 'root';
      return { kind: 'gdrive', clientId, rootFolderId: id, rootFolderName: root.label || 'My Drive', tokens };
    }
    return { kind: 'dropbox', appKey: clientId, rootPath: root.path ? '/' + root.path : '', tokens };
  }

  // A driver for a source that does not exist yet, to browse folders.
  const browser = $derived.by((): SourceDriver | null => {
    if (!tokens) return null;
    const cfg = config({ path: '', label: '' });
    const src = { id: 'setup', name: title, config: cfg, createdAt: 0, updatedAt: 0, deleted: false } as Source;
    if (cfg.kind === 'gdrive') return new GdriveDriver(src, cfg);
    if (cfg.kind === 'dropbox') return new DropboxDriver(src, cfg);
    return null;
  });

  async function signIn() {
    error = null;
    leaving = true;
    try {
      await settings.flush();
      await startSignIn({ provider, clientId, purpose: 'setup', returnTo: `#/libraries?add=${provider}` });
    } catch (err) {
      leaving = false;
      error = errorMessage(err);
    }
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (!picked || !tokens) return;
    try {
      await onCreate(name.trim() || picked.label.split('/').pop() || title, config(picked));
    } catch (err) {
      error = errorMessage(err, config(picked));
    }
  }

</script>

{#if oauthFlow.busy}
  <div class="center" aria-busy="true"><div class="spinner"></div><p class="muted">Finishing sign-in…</p></div>
{:else if !tokens}
  <div class="form">
    <p class="muted">
      {#if provider === 'gdrive'}
        Read books from a folder in your Google Drive. Libraria asks for read-only access and talks to Google directly from this browser.
      {:else}
        Read books from a folder in your Dropbox. Libraria talks to Dropbox directly from this browser and stays signed in.
      {/if}
    </p>
    <OAuthAppField {provider} compact={!!clientId} />
    {#if flowError || error}<p class="err" role="alert"><Icon name="alert" size={18} /> {flowError ?? error}</p>{/if}
    <div class="actions">
      <button class="btn" type="button" onclick={onCancel}>Back</button>
      <button class="btn primary" type="button" disabled={!clientId || leaving} onclick={signIn}>
        {leaving ? 'Opening…' : `Sign in to ${title}`}
      </button>
    </div>
    {#if provider === 'gdrive'}
      <p class="subtle small">Google’s sign-in for browser apps lasts about an hour. Libraria asks you to sign in again when it needs to rescan.</p>
    {/if}
  </div>
{:else if !picked}
  <div class="form">
    <p class="muted">Signed in. Choose the folder that holds your books.</p>
    {#if browser}
      <FolderPicker
        list={(path, signal) => browser.list(path, { signal })}
        rootLabel={provider === 'gdrive' ? 'My Drive' : 'Dropbox'}
        onPick={(path, label) => {
          picked = { path, label };
          name = label.split('/').pop() || title;
        }}
        onCancel={() => {
          tokens = null;
        }}
      />
    {/if}
  </div>
{:else}
  <form class="form" onsubmit={save}>
    <div class="chosen">
      <Icon name="folder" />
      <span>{picked.label || (provider === 'gdrive' ? 'My Drive' : 'Whole Dropbox')}</span>
      <button class="btn small ghost" type="button" onclick={() => (picked = null)}>Change</button>
    </div>
    <label class="field"><span>Name</span><input class="input" bind:value={name} /></label>
    {#if error}<p class="err" role="alert">{error}</p>{/if}
    <div class="actions">
      <button class="btn" type="button" onclick={onCancel}>Cancel</button>
      <button class="btn primary" type="submit">Add source</button>
    </div>
  </form>
{/if}

<style>
  .form {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 14px;
  }
  .center {
    display: grid;
    justify-items: center;
    gap: 12px;
    padding: 24px;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    flex-wrap: wrap;
  }
  .err {
    display: flex;
    gap: 8px;
    color: var(--danger);
    font-size: 14px;
  }
  .small {
    font-size: 12.5px;
  }
  .chosen {
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-weight: 550;
  }
  .chosen span {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
