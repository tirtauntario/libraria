<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';

  let {
    open = $bindable(false),
    title,
    children,
    actions,
    onclose,
    size = 'sm',
  }: {
    open?: boolean;
    title: string;
    children: Snippet;
    actions?: Snippet;
    onclose?: () => void;
    size?: 'sm' | 'md';
  } = $props();

  const uid = $props.id();
  let dialog: HTMLDialogElement | undefined = $state();

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  });

  function handleClose() {
    open = false;
    onclose?.();
  }
</script>

<dialog
  bind:this={dialog}
  class={size}
  aria-labelledby="{uid}-title"
  onclose={handleClose}
  onclick={(e) => {
    if (e.target === dialog) dialog?.close();
  }}
>
  {#if open}
    <div class="inner">
      <header>
        <h2 id="{uid}-title">{title}</h2>
        <button class="icon-btn" type="button" aria-label="Close" onclick={() => dialog?.close()}>
          <Icon name="close" />
        </button>
      </header>
      <div class="body">{@render children()}</div>
      {#if actions}
        <footer>{@render actions()}</footer>
      {/if}
    </div>
  {/if}
</dialog>

<style>
  dialog {
    width: min(440px, calc(100vw - 32px));
    max-height: calc(100dvh - 48px);
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--bg-elevated);
    color: var(--text);
    box-shadow: var(--shadow-lg);
  }
  dialog.md {
    width: min(600px, calc(100vw - 32px));
  }
  dialog::backdrop {
    background: var(--scrim);
    backdrop-filter: blur(2px);
  }
  dialog[open] {
    animation: pop 160ms var(--ease);
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: translateY(8px) scale(0.98);
    }
  }
  .inner {
    display: flex;
    flex-direction: column;
    max-height: calc(100dvh - 48px);
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 8px 4px 20px;
  }
  h2 {
    flex: 1;
    font-size: 18px;
  }
  .body {
    padding: 8px 20px 16px;
    overflow: auto;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 8px;
    padding: 12px 20px 16px;
    border-top: 1px solid var(--border);
  }
</style>
