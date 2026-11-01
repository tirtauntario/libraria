<script lang="ts">
  /**
   * Buttons that fix why a book could not be opened: "Grant access" for a
   * linked folder that lost its permission, "Sign in again" for an expired
   * Drive / Dropbox sign-in. Both need a click, so they cannot happen
   * automatically.
   */
  import type { Source } from '@libraria/core';
  import { services } from '../../services';
  import { catalog } from '../../stores/catalog.svelte';
  import { settings } from '../../stores/settings.svelte';
  import { toasts } from '../../stores/toasts.svelte';
  import { errorMessage } from '../errors';
  import { folderAccess, requestFolderAccess } from '../folder';
  import { reauthorize } from '../oauth-flow.svelte';

  let { bookId, onfixed }: { bookId: string; onfixed: () => void } = $props();

  let fixes = $state<{ source: Source; kind: 'access' | 'signin' }[]>([]);

  $effect(() => {
    const ids = new Set(catalog.files.filter((f) => f.bookId === bookId && !f.missing).map((f) => f.sourceId));
    const sources = catalog.sources.filter((s) => ids.has(s.id));
    void (async () => {
      const out: typeof fixes = [];
      for (const src of sources) {
        const c = src.config;
        if (c.kind === 'folder' && (await folderAccess(services().repo, src)) === 'prompt') out.push({ source: src, kind: 'access' });
        if ((c.kind === 'gdrive' || c.kind === 'dropbox') && c.tokens) {
          const expired = c.tokens.expiresAt != null && c.tokens.expiresAt <= Date.now() && !c.tokens.refreshToken;
          if (expired) out.push({ source: src, kind: 'signin' });
        }
      }
      fixes = out;
    })();
  });

  async function fix(f: (typeof fixes)[number]) {
    try {
      if (f.kind === 'access') {
        if (await requestFolderAccess(services().repo, f.source)) onfixed();
        return;
      }
      await settings.flush();
      const c = f.source.config;
      await reauthorize(f.source, c.kind === 'gdrive' ? settings.synced.oauth.googleClientId : settings.synced.oauth.dropboxAppKey);
    } catch (err) {
      toasts.error('Could not fix the source', errorMessage(err, f.source.config));
    }
  }
</script>

{#each fixes as f (f.source.id)}
  <button class="btn primary" type="button" onclick={() => fix(f)}>
    {f.kind === 'access' ? `Grant access to ${f.source.name}` : `Sign in to ${f.source.config.kind === 'gdrive' ? 'Google Drive' : 'Dropbox'}`}
  </button>
{/each}
