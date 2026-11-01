<script lang="ts">
  import { uuidv7 } from '@libraria/core';
  import { services } from '../../services';
  import Icon from '../../ui/Icon.svelte';
  import { errorMessage } from '../errors';
  import { pickDirectory, saveFolderHandle, type DirHandle } from '../folder';
  import type { SourceSetupProps } from '../types';

  let { onCreate, onCancel }: SourceSetupProps = $props();

  let handle = $state.raw<DirHandle | null>(null);
  let name = $state('');
  let error = $state<string | null>(null);
  let saving = $state(false);

  async function choose() {
    error = null;
    try {
      const h = await pickDirectory();
      if (!h) return;
      handle = h;
      if (!name) name = h.name;
    } catch (err) {
      error = errorMessage(err);
    }
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (!handle) return;
    saving = true;
    try {
      const handleId = uuidv7();
      await saveFolderHandle(services().repo, handleId, handle);
      await onCreate(name.trim() || handle.name, { kind: 'folder', name: handle.name, handleId });
    } catch (err) {
      error = errorMessage(err);
    } finally {
      saving = false;
    }
  }
</script>

<form class="form" onsubmit={save}>
  <p class="muted">
    Libraria reads books straight from a folder on this computer. Nothing is copied, and the folder stays on this device: it is never synced.
  </p>
  <div class="pick">
    <span class="icon"><Icon name="folder" /></span>
    <span class="what">{handle ? handle.name : 'No folder chosen'}</span>
    <button class="btn" type="button" onclick={choose}>{handle ? 'Change…' : 'Choose folder…'}</button>
  </div>
  {#if handle}
    <label class="field">
      <span>Name</span>
      <input class="input" bind:value={name} />
    </label>
  {/if}
  <p class="subtle small">The browser asks again for permission to read the folder after a restart. Libraria shows a “Grant access” button then.</p>
  {#if error}<p class="err" role="alert">{error}</p>{/if}
  <div class="actions">
    <button class="btn" type="button" onclick={onCancel}>Back</button>
    <button class="btn primary" type="submit" disabled={!handle || saving}>Add folder</button>
  </div>
</form>

<style>
  .form {
    display: grid;
    gap: 14px;
  }
  .pick {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius);
  }
  .icon {
    color: var(--accent);
    display: inline-flex;
  }
  .what {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 550;
  }
  .small {
    font-size: 13px;
  }
  .err {
    color: var(--danger);
    font-size: 14px;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
</style>
