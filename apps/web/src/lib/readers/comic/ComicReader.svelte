<script lang="ts">
  import type { ComicFormat } from '@libraria/core';
  import { openComic, type ArchiveReader } from '@libraria/core/browser';
  import { onDestroy, onMount } from 'svelte';
  import { settings } from '../../stores/settings.svelte';
  import Icon from '../../ui/Icon.svelte';
  import Segmented from '../../ui/Segmented.svelte';
  import { clampZoom, isTypingTarget, toggleFullscreen, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from '../gestures';
  import { pageLocator, resumePage } from '../locator';
  import ReaderChrome from '../ReaderChrome.svelte';
  import type { Panel, ReaderProps } from '../types';
  import ContinuousView from './ContinuousView.svelte';
  import { ComicPages, spreadPages, spreadStart, windowOrder } from './pages.svelte';
  import PagedView from './PagedView.svelte';

  let { book, blob, initial, edge, bookmarks, siblings, onlocation, onback, onopen }: ReaderProps = $props();

  let archive: ArchiveReader | null = null;
  let pages = $state<ComicPages | null>(null);
  let error = $state<string | null>(null);
  let current = $state(0);
  let moveDir = $state(0);
  let visible = $state(true);
  let panel = $state<Panel>(null);
  let boundary = $state<'start' | 'end' | null>(null);
  let viewer = $state<HTMLDivElement>();
  let continuous = $state<ContinuousView>();
  let winW = $state(typeof window !== 'undefined' ? window.innerWidth : 1024);
  let winH = $state(typeof window !== 'undefined' ? window.innerHeight : 768);

  const cs = $derived(settings.synced.comic);
  const count = $derived(pages?.count ?? 0);
  const rtl = $derived(cs.direction === 'rtl');
  const wide = $derived(winW >= 900 && winW > winH);
  const spread = $derived(cs.mode === 'paged' && cs.spread && wide);

  onMount(async () => {
    try {
      archive = await openComic(book.format as ComicFormat, blob);
      const list = await archive.getPages();
      if (list.length === 0) throw new Error('This comic has no pages.');
      const p = new ComicPages(list);
      current = edge === 'end' ? list.length - 1 : edge === 'start' ? 0 : resumePage(initial, list.length);
      pages = p;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  });

  onDestroy(() => {
    pages?.destroy();
    archive?.close();
  });

  // Keep a page window loaded: 1 behind / 2 ahead (doubled for spreads, wider when scrolling).
  $effect(() => {
    if (!pages) return;
    if (cs.mode === 'continuous') pages.want(windowOrder(current, 4, 8));
    else if (spread) pages.want(windowOrder(spreadStart(current), 2, 5));
    else pages.want(windowOrder(current, 1, 2));
  });

  // Report position.
  $effect(() => {
    if (count) onlocation(pageLocator(current, count));
  });

  $effect(() => {
    if (spread) current = spreadStart(current);
  });

  function go(page: number) {
    if (!count) return;
    const target = Math.min(count - 1, Math.max(0, page));
    moveDir = target > current ? 1 : target < current ? -1 : 0;
    current = target;
    boundary = null;
    if (cs.mode === 'continuous') continuous?.scrollToPage(target);
  }

  function next() {
    if (!count) return;
    const step = spread ? spreadPages(current, count).length : 1;
    if (current + step >= count) {
      boundary = 'end';
      visible = true;
      return;
    }
    go(current + step);
  }

  function prev() {
    if (!count) return;
    if (current <= 0) {
      boundary = siblings.prev ? 'start' : null;
      return;
    }
    go(spread ? spreadStart(current - 1) : current - 1);
  }

  function onzone(zone: 'left' | 'middle' | 'right') {
    if (zone === 'middle') {
      visible = !visible;
      return;
    }
    if (boundary) boundary = null;
    const forward = (zone === 'right') !== rtl;
    if (forward) next();
    else prev();
  }

  function onswipe(dir: 'left' | 'right') {
    const forward = (dir === 'left') !== rtl;
    if (forward) next();
    else prev();
  }

  function setZoom(z: number) {
    settings.updateSynced((s) => (s.comic.zoom = clampZoom(z)));
  }

  function scrollable(el: HTMLElement | undefined, dy: number) {
    if (!el) return false;
    return dy > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0;
  }

  function onkeydown(e: KeyboardEvent) {
    if (isTypingTarget(e.target) || panel || e.metaKey || e.ctrlKey || e.altKey) return;
    const el = viewer;
    const pageH = el?.clientHeight ?? 600;
    const cont = cs.mode === 'continuous';
    let handled = true;
    switch (e.key) {
      case 'ArrowRight':
        if (cont) handled = false;
        else if (rtl) prev();
        else next();
        break;
      case 'ArrowLeft':
        if (cont) handled = false;
        else if (rtl) next();
        else prev();
        break;
      case ' ':
        if (cont) el?.scrollBy({ top: (e.shiftKey ? -1 : 1) * pageH * 0.9 });
        else if (e.shiftKey) prev();
        else next();
        break;
      case 'ArrowDown':
      case 'PageDown': {
        const dy = e.key === 'ArrowDown' ? 100 : pageH;
        if (cont || scrollable(el, 1)) el?.scrollBy({ top: dy });
        else next();
        break;
      }
      case 'ArrowUp':
      case 'PageUp': {
        const dy = e.key === 'ArrowUp' ? 100 : pageH;
        if (cont || scrollable(el, -1)) el?.scrollBy({ top: -dy });
        else prev();
        break;
      }
      case 'Home':
        go(0);
        break;
      case 'End':
        go(count - 1);
        break;
      case 'f':
      case 'F':
        toggleFullscreen();
        break;
      case 'Escape':
        if (boundary) boundary = null;
        else handled = false;
        break;
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  }

  let pageInput = $state('');
  let editingPage = $state(false);
  function submitPage(e: SubmitEvent) {
    e.preventDefault();
    const n = Number.parseInt(pageInput, 10);
    if (Number.isFinite(n)) go(n - 1);
    editingPage = false;
  }

  const pageLabel = $derived(
    spread && count ? spreadPages(current, count).map((p) => p + 1).join('–') : String(current + 1),
  );
</script>

<svelte:window {onkeydown} bind:innerWidth={winW} bind:innerHeight={winH} />

{#snippet settingsPanel()}
  <div class="opt">
    <span class="label">Layout</span>
    <Segmented label="Layout" value={cs.mode} onchange={(v) => settings.updateSynced((s) => (s.comic.mode = v))}
      options={[{ value: 'paged', label: 'Pages', icon: 'page-single' }, { value: 'continuous', label: 'Scroll', icon: 'scroll' }]} />
  </div>
  <div class="opt">
    <span class="label">Direction</span>
    <Segmented label="Reading direction" value={cs.direction} onchange={(v) => settings.updateSynced((s) => (s.comic.direction = v))}
      options={[{ value: 'ltr', label: 'Left to right', icon: 'ltr' }, { value: 'rtl', label: 'Right to left', icon: 'rtl' }]} />
  </div>
  <div class="opt">
    <span class="label">Fit</span>
    <Segmented label="Fit" compact value={cs.fit} onchange={(v) => settings.updateSynced((s) => (s.comic.fit = v))}
      options={[{ value: 'contain', label: 'Page' }, { value: 'width', label: 'Width' }, { value: 'height', label: 'Height' }, { value: 'original', label: '1:1' }]} />
  </div>
  <div class="opt">
    <span class="label">Zoom</span>
    <div class="zoom">
      <button class="icon-btn" type="button" aria-label="Zoom out" disabled={cs.zoom <= ZOOM_MIN} onclick={() => setZoom(cs.zoom - ZOOM_STEP)}><Icon name="zoom-out" /></button>
      <button class="btn small ghost" type="button" onclick={() => setZoom(1)} aria-label="Reset zoom">{Math.round(cs.zoom * 100)}%</button>
      <button class="icon-btn" type="button" aria-label="Zoom in" disabled={cs.zoom >= ZOOM_MAX} onclick={() => setZoom(cs.zoom + ZOOM_STEP)}><Icon name="zoom-in" /></button>
    </div>
  </div>
  <label class="opt row">
    <span><span class="label">Two-page spreads</span><br /><span class="hint">Wide screens, page mode</span></span>
    <input type="checkbox" checked={cs.spread} onchange={(e) => settings.updateSynced((s) => (s.comic.spread = e.currentTarget.checked))} />
  </label>
{/snippet}

{#snippet chapterButton(kind: 'prev' | 'next')}
  {@const target = kind === 'prev' ? siblings.prev : siblings.next}
  {#if target}
    <button class="chapter" type="button" onclick={() => onopen(target, kind === 'prev' ? 'end' : 'start')}>
      <span class="chapter-kicker">{kind === 'prev' ? 'Previous' : 'Next'}</span>
      <span class="chapter-title">{target.title}</span>
    </button>
  {/if}
{/snippet}

{#snippet footer()}
  <div class="footer">
    <button class="icon-btn" type="button" aria-label={rtl ? 'Next page' : 'Previous page'} onclick={() => (rtl ? next() : prev())}>
      <Icon name="chevron-left" />
    </button>
    <input
      class="slider"
      type="range"
      min="0"
      max={Math.max(0, count - 1)}
      value={current}
      dir={cs.direction}
      aria-label="Page"
      oninput={(e) => go(Number(e.currentTarget.value))}
    />
    <button class="icon-btn" type="button" aria-label={rtl ? 'Previous page' : 'Next page'} onclick={() => (rtl ? prev() : next())}>
      <Icon name="chevron-right" />
    </button>
    {#if editingPage}
      <form class="goto" onsubmit={submitPage}>
        <label class="visually-hidden" for="goto">Go to page</label>
        <!-- svelte-ignore a11y_autofocus -->
        <input id="goto" class="goto-input" type="number" min="1" max={count} bind:value={pageInput} autofocus onblur={() => (editingPage = false)} />
      </form>
    {:else}
      <button class="count" type="button" title="Go to page" onclick={() => { pageInput = String(current + 1); editingPage = true; }}>
        {pageLabel} / {count}
      </button>
    {/if}
  </div>
{/snippet}

<ReaderChrome
  title={book.title}
  subtitle={book.series ?? ''}
  bind:visible
  bind:panel
  {onback}
  {bookmarks}
  here={count ? pageLocator(current, count) : null}
  hereLabel="Page {current + 1}"
  isHere={(loc) => loc.type === 'page' && loc.page === current}
  onjump={(bm) => bm.locator.type === 'page' && go(bm.locator.page)}
  {settingsPanel}
  {footer}
>
  {#if error}
    <div class="message" role="alert"><Icon name="alert" size={28} /><p>{error}</p></div>
  {:else if !pages}
    <div class="message"><div class="spinner"></div><p>{book.format === 'cbr' ? 'Unpacking…' : 'Opening…'}</p></div>
  {:else if cs.mode === 'continuous'}
    <ContinuousView
      bind:this={continuous}
      bind:viewer
      {pages}
      {current}
      fit={cs.fit}
      zoom={cs.zoom}
      onpage={(p) => (current = p)}
      ontap={() => (visible = !visible)}
      onzoom={setZoom}
    >
      {#snippet before()}{@render chapterButton('prev')}{/snippet}
      {#snippet after()}
        {#if siblings.next}{@render chapterButton('next')}{:else}<p class="the-end">The end</p>{/if}
      {/snippet}
    </ContinuousView>
  {:else}
    <PagedView
      bind:viewer
      {pages}
      {current}
      {spread}
      direction={cs.direction}
      fit={cs.fit}
      zoom={cs.zoom}
      {moveDir}
      {onzone}
      {onswipe}
      onzoom={setZoom}
    />
  {/if}

  {#if boundary}
    <div class="boundary" role="dialog" aria-label={boundary === 'end' ? 'End of book' : 'Start of book'}>
      <div class="boundary-card">
        {#if boundary === 'end'}
          <p class="boundary-title">{siblings.next ? 'End of this volume' : 'You finished it'}</p>
          <p class="boundary-sub">{book.title}</p>
          {@render chapterButton('next')}
        {:else}
          <p class="boundary-title">Start of this volume</p>
          {@render chapterButton('prev')}
        {/if}
        <div class="boundary-actions">
          <button class="btn small ghost" type="button" onclick={() => (boundary = null)}>Stay here</button>
          <button class="btn small ghost" type="button" onclick={onback}>Back to library</button>
        </div>
      </div>
    </div>
  {/if}
</ReaderChrome>

<style>
  .message {
    position: absolute;
    inset: 0;
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 12px;
    color: rgb(255 255 255 / 0.7);
    text-align: center;
    padding: 24px;
  }
  .footer {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .slider {
    flex: 1;
    min-width: 0;
    accent-color: #7cc4ad;
  }
  .count {
    min-width: 76px;
    padding: 6px 8px;
    border: 0;
    border-radius: var(--radius-sm);
    background: rgb(255 255 255 / 0.08);
    color: inherit;
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }
  .goto-input {
    width: 76px;
    padding: 6px 8px;
    border-radius: var(--radius-sm);
    border: 1px solid rgb(255 255 255 / 0.3);
    background: rgb(0 0 0 / 0.4);
    color: inherit;
    font-size: 13px;
  }
  .opt {
    display: grid;
    gap: 8px;
  }
  .opt.row {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .hint {
    font-size: 12.5px;
    color: var(--text-3);
  }
  .zoom {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .chapter {
    display: grid;
    gap: 2px;
    width: min(360px, 100%);
    padding: 14px 18px;
    border: 1px solid rgb(255 255 255 / 0.15);
    border-radius: var(--radius-lg);
    background: rgb(255 255 255 / 0.06);
    color: #f1eee8;
    text-align: left;
    transition: background-color var(--dur) var(--ease);
  }
  .chapter:hover {
    background: rgb(255 255 255 / 0.12);
  }
  .chapter-kicker {
    font-size: 12px;
    color: #7cc4ad;
    font-weight: 650;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .chapter-title {
    font-weight: 600;
  }
  .the-end {
    color: rgb(255 255 255 / 0.5);
    font-family: var(--font-serif);
    font-style: italic;
  }
  .boundary {
    position: absolute;
    inset: 0;
    z-index: 30;
    display: grid;
    place-items: center;
    padding: 24px;
    background: rgb(0 0 0 / 0.55);
    backdrop-filter: blur(6px);
    animation: fade 200ms ease;
  }
  .boundary-card {
    display: grid;
    justify-items: center;
    gap: 14px;
    width: min(400px, 100%);
    padding: 24px;
    border-radius: var(--radius-lg);
    background: #1c1f1e;
    color: #f1eee8;
    text-align: center;
    box-shadow: var(--shadow-lg);
  }
  .boundary-title {
    font-size: 18px;
    font-weight: 650;
  }
  .boundary-sub {
    margin-top: -8px;
    color: rgb(255 255 255 / 0.6);
    font-size: 14px;
  }
  .boundary-actions {
    display: flex;
    gap: 6px;
  }
  .boundary-actions .btn {
    color: #e8e5df;
  }
  .boundary-actions .btn:hover {
    background: rgb(255 255 255 / 0.1);
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
</style>
