<script lang="ts">
  import type { Bookmark, Locator } from '@libraria/core';
  import { onMount, type Snippet } from 'svelte';
  import Icon from '../ui/Icon.svelte';
  import Sheet from '../ui/Sheet.svelte';
  import { formatRelative } from '../ui/format';
  import type { BookmarkList } from './bookmarks.svelte';
  import type { Panel } from './types';
  import { toggleFullscreen } from './gestures';



  /**
   * Shared reader frame: top bar (back, title, bookmark, contents, bookmarks,
   * settings, fullscreen), a bottom bar, side panels, and auto-hiding.
   */
  let {
    title,
    subtitle = '',
    visible = $bindable(true),
    panel = $bindable(null),
    onback,
    bookmarks,
    here,
    hereLabel,
    isHere,
    onjump,
    toc,
    settingsPanel,
    footer,
    children,
    tone = 'dark',
  }: {
    title: string;
    subtitle?: string;
    visible?: boolean;
    panel?: Panel;
    onback: () => void;
    bookmarks: BookmarkList | null;
    /** Current position, for adding a bookmark. */
    here: Locator | null;
    hereLabel: string;
    isHere: (loc: Locator) => boolean;
    onjump: (bm: Bookmark) => void;
    toc?: Snippet<[close: () => void]>;
    settingsPanel: Snippet;
    footer?: Snippet;
    children: Snippet;
    /** Colour of the bars: dark glass over comics/PDF, or matching the EPUB page. */
    tone?: 'dark' | 'dim' | 'light' | 'sepia';
  } = $props();

  const AUTO_HIDE_MS = 3000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let hovering = false;
  let last = { x: -1, y: -1 };
  let isFullscreen = $state(false);

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (!hovering && !panel) visible = false;
    }, AUTO_HIDE_MS);
  }

  function onpointermove(e: PointerEvent) {
    if (e.pointerType !== 'mouse') return;
    if (e.clientX === last.x && e.clientY === last.y) return;
    last = { x: e.clientX, y: e.clientY };
    visible = true;
    schedule();
  }

  onMount(() => {
    schedule();
    const fs = () => (isFullscreen = !!document.fullscreenElement);
    document.addEventListener('fullscreenchange', fs);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('fullscreenchange', fs);
    };
  });

  $effect(() => {
    if (panel) visible = true;
  });

  const current = $derived(bookmarks?.items.find((b) => isHere(b.locator)));

  async function toggleBookmark() {
    if (!bookmarks || !here) return;
    if (current) await bookmarks.remove(current.id);
    else await bookmarks.add(here, hereLabel);
  }

  const close = () => (panel = null);
  const canFullscreen = typeof document !== 'undefined' && !!document.documentElement.requestFullscreen;
</script>

<svelte:document {onpointermove} />

<div class="reader tone-{tone}">
  {@render children()}

  <!-- Hover tracking only, to pause auto-hide. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <header
    class="bar top"
    class:hidden={!visible}
    onpointerenter={() => (hovering = true)}
    onpointerleave={() => {
      hovering = false;
      schedule();
    }}
  >
    <button class="icon-btn" type="button" aria-label="Back to library" onclick={onback}><Icon name="arrow-left" /></button>
    <div class="titles">
      <p class="title">{title}</p>
      {#if subtitle}<p class="subtitle">{subtitle}</p>{/if}
    </div>
    {#if bookmarks}
      <button
        class="icon-btn"
        type="button"
        aria-pressed={!!current}
        aria-label={current ? 'Remove bookmark here' : 'Bookmark this page'}
        title={current ? 'Remove bookmark' : 'Add bookmark'}
        onclick={toggleBookmark}
      >
        <Icon name={current ? 'bookmark-filled' : 'bookmark'} />
      </button>
    {/if}
    {#if toc}
      <button class="icon-btn" type="button" aria-label="Contents" title="Contents" onclick={() => (panel = 'toc')}><Icon name="toc" /></button>
    {/if}
    {#if bookmarks}
      <button class="icon-btn" type="button" aria-label="All bookmarks" title="Bookmarks" onclick={() => (panel = 'bookmarks')}>
        <Icon name="bookmarks" />
      </button>
    {/if}
    <button class="icon-btn" type="button" aria-label="Reading settings" title="Settings" onclick={() => (panel = 'settings')}>
      <Icon name="sliders" />
    </button>
    {#if canFullscreen}
      <button class="icon-btn fs" type="button" aria-label={isFullscreen ? 'Exit full screen' : 'Full screen'} title="Full screen (F)" onclick={() => toggleFullscreen()}>
        <Icon name={isFullscreen ? 'minimize' : 'maximize'} />
      </button>
    {/if}
  </header>

  {#if footer}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <footer
      class="bar bottom"
      class:hidden={!visible}
      onpointerenter={() => (hovering = true)}
      onpointerleave={() => {
        hovering = false;
        schedule();
      }}
    >
      {@render footer()}
    </footer>
  {/if}
</div>

{#if toc}
  <Sheet open={panel === 'toc'} title="Contents" side="left" tone="reader" onclose={close}>
    {@render toc(close)}
  </Sheet>
{/if}

<Sheet open={panel === 'bookmarks'} title="Bookmarks" tone="reader" onclose={close}>
  {#if !bookmarks || bookmarks.items.length === 0}
    <p class="empty">No bookmarks yet. Use the bookmark button in the top bar to add one.</p>
  {:else}
    <ul class="bms">
      {#each bookmarks.items as bm (bm.id)}
        <li>
          <button
            class="bm"
            type="button"
            onclick={() => {
              onjump(bm);
              close();
            }}
          >
            <Icon name="bookmark" size={16} />
            <span class="bm-text">
              <span>{bm.label}</span>
              <span class="when">{formatRelative(bm.createdAt)}</span>
            </span>
          </button>
          <button class="icon-btn" type="button" aria-label="Delete bookmark {bm.label}" onclick={() => bookmarks?.remove(bm.id)}>
            <Icon name="trash" size={16} />
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</Sheet>

<Sheet open={panel === 'settings'} title="Reading settings" tone="reader" onclose={close}>
  <div class="settings">{@render settingsPanel()}</div>
</Sheet>

<style>
  .reader {
    position: fixed;
    inset: 0;
    overflow: hidden;
    background: #111;
    color: #eee;
    touch-action: manipulation;
    --bar-bg: rgb(18 20 19 / 0.78);
    --bar-fg: #efece6;
    --bar-sub: rgb(239 236 230 / 0.65);
    --bar-border: rgb(255 255 255 / 0.08);
  }
  .tone-dim {
    --bar-bg: rgb(43 45 44 / 0.9);
    --bar-fg: #d9d5ce;
    --bar-sub: rgb(217 213 206 / 0.65);
    --bar-border: rgb(255 255 255 / 0.07);
  }
  .tone-light {
    --bar-bg: rgb(250 248 244 / 0.9);
    --bar-fg: #1f1d1a;
    --bar-sub: #6f6a62;
    --bar-border: rgb(0 0 0 / 0.08);
  }
  .tone-sepia {
    --bar-bg: rgb(244 236 218 / 0.92);
    --bar-fg: #3b2f22;
    --bar-sub: #7a6a55;
    --bar-border: rgb(60 40 10 / 0.1);
  }
  .bar {
    position: absolute;
    left: 0;
    right: 0;
    z-index: 20;
    display: flex;
    align-items: center;
    gap: 2px;
    background: var(--bar-bg);
    color: var(--bar-fg);
    backdrop-filter: saturate(1.3) blur(18px);
    -webkit-backdrop-filter: saturate(1.3) blur(18px);
    transition:
      opacity 250ms ease,
      transform 250ms var(--ease);
  }
  .top {
    top: 0;
    padding: max(6px, var(--safe-top)) max(8px, var(--safe-right)) 6px max(8px, var(--safe-left));
    border-bottom: 1px solid var(--bar-border);
  }
  .bottom {
    bottom: 0;
    padding: 10px max(14px, var(--safe-right)) max(12px, var(--safe-bottom)) max(14px, var(--safe-left));
    border-top: 1px solid var(--bar-border);
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
  }
  .top.hidden {
    opacity: 0;
    transform: translateY(-100%);
    pointer-events: none;
  }
  .bottom.hidden {
    opacity: 0;
    transform: translateY(100%);
    pointer-events: none;
  }
  .titles {
    flex: 1;
    min-width: 0;
    padding: 0 6px;
  }
  .title {
    font-weight: 600;
    font-size: 15px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .subtitle {
    font-size: 12px;
    color: var(--bar-sub);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .icon-btn[aria-pressed='true'] {
    background: transparent;
    color: #e0a43a;
  }
  @media (max-width: 420px) {
    .fs {
      display: none;
    }
  }
  .empty {
    padding: 8px 20px;
    color: var(--text-2);
    font-size: 14px;
  }
  .bms {
    list-style: none;
    margin: 0;
    padding: 0 8px;
  }
  .bms li {
    display: flex;
    align-items: center;
  }
  .bm {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 48px;
    padding: 6px 12px;
    border: 0;
    border-radius: var(--radius);
    background: none;
    color: var(--text);
    text-align: left;
    min-width: 0;
  }
  .bm:hover {
    background: var(--surface-2);
  }
  .bm-text {
    display: grid;
    min-width: 0;
  }
  .bm-text > span:first-child {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .when {
    font-size: 12px;
    color: var(--text-3);
  }
  .settings {
    padding: 0 20px;
    display: grid;
    gap: 18px;
  }
</style>
