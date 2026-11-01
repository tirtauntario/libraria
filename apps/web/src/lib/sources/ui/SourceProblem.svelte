<script lang="ts">
  /** A source's current problem with the action that fixes it. */
  import type { Source } from '@libraria/core';
  import { scanner, type SourceProblem } from '../../stores/scanner.svelte';
  import { settings } from '../../stores/settings.svelte';
  import { toasts } from '../../stores/toasts.svelte';
  import Icon from '../../ui/Icon.svelte';
  import { errorMessage } from '../errors';
  import { reauthorize } from '../oauth-flow.svelte';
  import CorsHelp from './CorsHelp.svelte';

  let { source, problem, compact = false }: { source: Source; problem: SourceProblem; compact?: boolean } = $props();

  async function grant() {
    if (!(await scanner.grantAccess(source))) toasts.error(`Access to “${source.name}” was not granted.`);
  }

  async function signIn() {
    try {
      await settings.flush();
      const fallback = source.config.kind === 'gdrive' ? settings.synced.oauth.googleClientId : settings.synced.oauth.dropboxAppKey;
      await reauthorize(source, fallback);
    } catch (err) {
      toasts.error('Could not start sign-in', errorMessage(err, source.config));
    }
  }
</script>

<div class="problem" class:compact role="status">
  <Icon name={problem.code === 'permission' ? 'folder' : problem.code === 'network' ? 'wifi-off' : 'alert'} size={18} />
  <div class="text">
    <p>{#if !compact}<strong>{source.name}:</strong> {/if}{problem.message}</p>
    {#if problem.corsHelp && !compact}<CorsHelp />{/if}
  </div>
  {#if problem.code === 'permission'}
    <button class="btn small primary" type="button" onclick={grant}>Grant access</button>
  {:else if problem.code === 'auth' && (source.config.kind === 'gdrive' || source.config.kind === 'dropbox')}
    <button class="btn small primary" type="button" onclick={signIn}>Sign in again</button>
  {:else if !compact}
    <button class="btn small" type="button" onclick={() => scanner.scan(source)} disabled={scanner.busy(source.id)}>Try again</button>
  {/if}
</div>

<style>
  .problem {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 8px 10px;
    padding: 10px 12px;
    border-radius: var(--radius);
    background: color-mix(in srgb, var(--warning) 12%, var(--surface));
    border: 1px solid color-mix(in srgb, var(--warning) 30%, transparent);
    color: var(--text);
    font-size: 14px;
  }
  .problem > :global(svg) {
    flex: none;
    margin-top: 2px;
    color: var(--warning);
  }
  .text {
    flex: 1 1 200px;
    min-width: 0;
    display: grid;
    gap: 8px;
  }
  .text p {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .compact {
    padding: 6px 10px;
    font-size: 13px;
  }
</style>
