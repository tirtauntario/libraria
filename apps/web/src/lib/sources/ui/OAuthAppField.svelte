<script lang="ts">
  /**
   * The OAuth client ID (Google) / app key (Dropbox) this deployment uses,
   * stored in the synced settings, with how to register one.
   */
  import { settings } from '../../stores/settings.svelte';
  import { redirectUri } from '../oauth';
  import CopyField from './CopyField.svelte';

  let { provider, compact = false }: { provider: 'gdrive' | 'dropbox'; compact?: boolean } = $props();

  const uri = typeof location !== 'undefined' ? redirectUri() : '';
  const value = $derived(provider === 'gdrive' ? settings.synced.oauth.googleClientId : settings.synced.oauth.dropboxAppKey);

  function set(v: string) {
    const clean = v.trim();
    settings.updateSynced((s) => {
      if (provider === 'gdrive') s.oauth.googleClientId = clean;
      else s.oauth.dropboxAppKey = clean;
    });
  }
</script>

<div class="oauth">
  <label class="field">
    <span>{provider === 'gdrive' ? 'Google OAuth client ID' : 'Dropbox app key'}</span>
    <input
      class="input mono"
      {value}
      onchange={(e) => set(e.currentTarget.value)}
      placeholder={provider === 'gdrive' ? '1234567890-abc….apps.googleusercontent.com' : 'e.g. a1b2c3d4e5f6g7h'}
      autocapitalize="off"
      spellcheck="false"
    />
  </label>
  <details class="how" open={!compact && !value}>
    <summary>{provider === 'gdrive' ? 'How to get a client ID' : 'How to get an app key'}</summary>
    {#if provider === 'gdrive'}
      <ol>
        <li>In <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer">Google Cloud Console › Credentials</a>, create a project and enable the <strong>Google Drive API</strong>.</li>
        <li>Configure the OAuth consent screen (Testing mode is fine for personal use; add yourself as a test user).</li>
        <li>Create an <strong>OAuth client ID</strong> of type <em>Web application</em>. Add this app’s address as an <em>authorised JavaScript origin</em> ({uri ? new URL(uri).origin : ''}) and the address below as an <em>authorised redirect URI</em>.</li>
      </ol>
    {:else}
      <ol>
        <li>In the <a href="https://www.dropbox.com/developers/apps" target="_blank" rel="noopener noreferrer">Dropbox App Console</a>, create an app with <em>Scoped access</em> (Full Dropbox or App folder).</li>
        <li>Under <strong>Permissions</strong>, enable <code>files.metadata.read</code> and <code>files.content.read</code>.</li>
        <li>Under <strong>Settings › OAuth 2</strong>, add the address below as a redirect URI and allow public clients (PKCE). Copy the <strong>App key</strong>; no secret is needed.</li>
      </ol>
    {/if}
    <p class="label">Redirect URI</p>
    <CopyField value={uri} label="redirect URI" />
    <p class="subtle">Each Libraria deployment registers its own app: there is no central Libraria service. The ID syncs to your other devices.</p>
  </details>
</div>

<style>
  .oauth {
    display: grid;
    gap: 10px;
  }
  .mono {
    font-family: var(--font-mono);
    font-size: 13px;
  }
  .how {
    font-size: 13.5px;
  }
  .how > summary {
    cursor: pointer;
    color: var(--accent);
    font-weight: 550;
  }
  ol {
    margin: 8px 0;
    padding-left: 20px;
    display: grid;
    gap: 6px;
  }
  .label {
    margin: 8px 0 6px;
  }
  .subtle {
    margin-top: 8px;
    font-size: 12.5px;
  }
  code {
    font-family: var(--font-mono);
    font-size: 12.5px;
  }
</style>
