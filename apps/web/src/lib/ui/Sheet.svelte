<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';

  /**
   * Side panel (desktop) / bottom sheet (phone). Used for reader TOC,
   * bookmarks and settings. Escape and the scrim close it.
   */
  let {
    open = $bindable(false),
    title,
    side = 'right',
    children,
    tone = 'app',
    onclose,
  }: {
    open?: boolean;
    title: string;
    side?: 'left' | 'right';
    children: Snippet;
    /** 'reader' uses the dark glass look of the reader chrome. */
    tone?: 'app' | 'reader';
    onclose?: () => void;
  } = $props();

  const uid = $props.id();
  let panel: HTMLElement | undefined = $state();
  let returnFocus: Element | null = null;

  $effect(() => {
    if (open) {
      returnFocus = document.activeElement;
      queueMicrotask(() => panel?.focus());
    } else if (returnFocus instanceof HTMLElement) {
      returnFocus.focus();
      returnFocus = null;
    }
  });

  function dismiss() {
    open = false;
    onclose?.();
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      dismiss();
    }
  }
</script>

{#if open}
  <div class="scrim" role="presentation" onclick={dismiss}></div>
  <div
    bind:this={panel}
    class="sheet {side} {tone}"
    role="dialog"
    aria-modal="true"
    aria-labelledby="{uid}-title"
    tabindex="-1"
    {onkeydown}
  >
    <header>
      <h2 id="{uid}-title">{title}</h2>
      <button class="icon-btn" type="button" aria-label="Close" onclick={dismiss}>
        <Icon name="close" />
      </button>
    </header>
    <div class="content">{@render children()}</div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 60;
    background: var(--scrim);
    animation: fade 160ms var(--ease);
  }
  .sheet {
    position: fixed;
    z-index: 61;
    display: flex;
    flex-direction: column;
    background: var(--bg-elevated);
    color: var(--text);
    box-shadow: var(--shadow-lg);
    outline: none;
    /* phone: bottom sheet */
    left: 0;
    right: 0;
    bottom: 0;
    max-height: min(80dvh, 720px);
    border-radius: var(--radius-lg) var(--radius-lg) 0 0;
    padding-bottom: var(--safe-bottom);
    animation: up 220ms var(--ease);
  }
  .sheet.reader {
    --bg-elevated: #1c1f1e;
    --text: #ece9e3;
    --text-2: #b9b4ab;
    --text-3: #8b867e;
    --border: #2f3432;
    --border-strong: #454c49;
    --surface: #242927;
    --surface-2: #2c322f;
    --accent: #7cc4ad;
    --accent-soft: #23403a;
    --accent-text: #0d1f1a;
    color-scheme: dark;
  }
  @media (min-width: 720px) {
    .sheet {
      top: 0;
      bottom: 0;
      left: auto;
      right: 0;
      width: 380px;
      max-height: none;
      border-radius: 0;
      padding-top: var(--safe-top);
      animation: in-right 220ms var(--ease);
    }
    .sheet.left {
      right: auto;
      left: 0;
      animation-name: in-left;
    }
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 8px 8px 20px;
    border-bottom: 1px solid var(--border);
  }
  h2 {
    flex: 1;
    font-size: 17px;
  }
  .content {
    flex: 1;
    overflow: auto;
    overscroll-behavior: contain;
    padding: 12px 0 16px;
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  @keyframes up {
    from {
      transform: translateY(40px);
      opacity: 0;
    }
  }
  @keyframes in-right {
    from {
      transform: translateX(40px);
      opacity: 0;
    }
  }
  @keyframes in-left {
    from {
      transform: translateX(-40px);
      opacity: 0;
    }
  }
</style>
