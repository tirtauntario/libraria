<script lang="ts">
  import type { SyncKeysDto } from '@libraria/core';
  import { onMount } from 'svelte';
  import { describeError } from '../../lib/server/api';
  import type { LibrariaSource } from '../../lib/server/servers';
  import { sync } from '../../lib/sync/controller.svelte';
  import { KeyMismatchError } from '../../lib/sync/keys';
  import Icon from '../../lib/ui/Icon.svelte';
  import RecoveryKey from './RecoveryKey.svelte';

  /**
   * Makes `source` the sync home with the master key from signing in:
   * creates keys (then shows the recovery key) or unlocks existing ones
   * (asks for the recovery key if the password does not fit).
   */
  let { source, masterKey, ondone }: { source: LibrariaSource; masterKey: Uint8Array; ondone: () => void } = $props();

  type Step =
    | { kind: 'working' }
    | { kind: 'created'; recoveryKey: string }
    | { kind: 'unlocked' }
    | { kind: 'mismatch'; keys: SyncKeysDto }
    | { kind: 'error'; message: string };
  let step = $state<Step>({ kind: 'working' });
  let recovery = $state('');
  let recovering = $state(false);
  let recoveryError = $state<string | null>(null);

  async function run() {
    step = { kind: 'working' };
    try {
      const r = await sync.enable(source, masterKey);
      step = r.status === 'created' ? { kind: 'created', recoveryKey: r.recoveryKey } : { kind: 'unlocked' };
    } catch (err) {
      if (err instanceof KeyMismatchError) step = { kind: 'mismatch', keys: err.keys };
      else step = { kind: 'error', message: describeError(err) };
    }
  }
  onMount(run);

  async function useRecovery(e: SubmitEvent) {
    e.preventDefault();
    if (step.kind !== 'mismatch') return;
    recovering = true;
    recoveryError = null;
    try {
      await sync.enableWithRecovery(source, step.keys, recovery, masterKey);
      step = { kind: 'unlocked' };
    } catch (err) {
      recoveryError = describeError(err);
    } finally {
      recovering = false;
    }
  }
</script>

<div class="sync-setup">
  {#if step.kind === 'working'}
    <p class="status"><span class="spinner"></span> Setting up encrypted sync…</p>
  {:else if step.kind === 'created'}
    <RecoveryKey recoveryKey={step.recoveryKey} server={source.name} {ondone} />
  {:else if step.kind === 'unlocked'}
    <p class="ok"><Icon name="check" /> Sync is on. Your progress, bookmarks, libraries and sources from your other devices are on their way.</p>
    <button class="btn primary" type="button" onclick={ondone}>Continue</button>
  {:else if step.kind === 'mismatch'}
    <form class="form" onsubmit={useRecovery}>
      <p class="muted">
        Your password does not unlock the sync data on {source.name}. This happens when the password was changed in a way that could
        not update the keys. Enter your recovery key; Libraria will then update the keys for your current password.
      </p>
      <label class="field">
        <span>Recovery key</span>
        <input class="input mono" bind:value={recovery} autocomplete="off" spellcheck="false" placeholder="XXXX-XXXX-…" required />
      </label>
      {#if recoveryError}<p class="error" role="alert">{recoveryError}</p>{/if}
      <div class="row">
        <button class="btn" type="button" onclick={ondone}>Not now</button>
        <button class="btn primary" type="submit" disabled={recovering}>{recovering ? 'Unlocking…' : 'Unlock'}</button>
      </div>
    </form>
  {:else}
    <p class="error" role="alert">{step.message}</p>
    <div class="row">
      <button class="btn" type="button" onclick={ondone}>Skip</button>
      <button class="btn primary" type="button" onclick={run}>Try again</button>
    </div>
  {/if}
</div>

<style>
  .sync-setup {
    display: grid;
    gap: 12px;
  }
  .status,
  .ok {
    display: flex;
    gap: 10px;
    align-items: center;
  }
  .ok {
    color: var(--success);
    font-weight: 550;
  }
  .form {
    display: grid;
    gap: 12px;
  }
  .mono {
    font-family: var(--font-mono);
  }
  .row {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    flex-wrap: wrap;
  }
  .error {
    color: var(--danger);
  }
</style>
