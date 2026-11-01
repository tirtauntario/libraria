<script lang="ts">
  import { toasts } from '../../lib/stores/toasts.svelte';
  import Icon from '../../lib/ui/Icon.svelte';

  /** Shows the recovery key once, with copy / download and an "I saved it" confirmation. */
  let { recoveryKey, server, ondone }: { recoveryKey: string; server: string; ondone: () => void } = $props();

  let saved = $state(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(recoveryKey);
      toasts.show('Recovery key copied', { kind: 'success', timeout: 2500 });
    } catch {
      toasts.error('Could not copy', 'Select the key and copy it by hand.');
    }
  }

  function download() {
    const text = [
      'Libraria recovery key',
      '',
      `Sync server: ${server}`,
      `Created: ${new Date().toLocaleString()}`,
      '',
      recoveryKey,
      '',
      'Keep this somewhere safe. With your password or this key you can unlock your synced',
      'reading data on a new device. Without both, the data cannot be recovered: the server',
      'only stores it encrypted.',
      '',
    ].join('\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'libraria-recovery-key.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
</script>

<div class="recovery" data-testid="recovery-key">
  <p class="lead"><Icon name="alert" size={18} /> Save your recovery key</p>
  <p class="muted">
    Your synced data is encrypted on this device before it goes to the server. If you forget your password, this key is the only way
    to unlock it. It is shown only now.
  </p>
  <code class="key" aria-label="Recovery key">{recoveryKey}</code>
  <div class="row">
    <button class="btn" type="button" onclick={copy}><Icon name="check" size={16} /> Copy</button>
    <button class="btn" type="button" onclick={download}><Icon name="download" size={16} /> Download</button>
  </div>
  <label class="confirm">
    <input type="checkbox" bind:checked={saved} />
    <span>I saved my recovery key somewhere safe</span>
  </label>
  <button class="btn primary" type="button" disabled={!saved} onclick={ondone}>Done</button>
</div>

<style>
  .recovery {
    display: grid;
    gap: 12px;
  }
  .lead {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 650;
    color: var(--warning);
  }
  .key {
    display: block;
    padding: 14px;
    border-radius: var(--radius);
    background: var(--surface-2);
    border: 1px dashed var(--border-strong);
    font-family: var(--font-mono);
    font-size: 15px;
    line-height: 1.7;
    letter-spacing: 0.04em;
    word-break: break-all;
    user-select: all;
  }
  .row {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .confirm {
    display: flex;
    gap: 10px;
    align-items: center;
    font-size: 14px;
  }
</style>
