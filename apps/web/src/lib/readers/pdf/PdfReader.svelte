<script lang="ts">
  import type { FitMode } from '@libraria/core';
  import { PdfDocument, type PdfOutlineItem } from '@libraria/core/browser';
  import { onDestroy, onMount, tick } from 'svelte';
  import { settings } from '../../stores/settings.svelte';
  import Icon from '../../ui/Icon.svelte';
  import Segmented from '../../ui/Segmented.svelte';
  import { clampZoom, clickZone, isTypingTarget, keepCenter, pinch, swipe, toggleFullscreen, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from '../gestures';
  import { pageLocator, resumePage } from '../locator';
  import ReaderChrome from '../ReaderChrome.svelte';
  import type { Panel, ReaderProps } from '../types';
  import PdfPage from './PdfPage.svelte';

  let { book, blob, initial, edge, bookmarks, onlocation, onback }: ReaderProps = $props();

  let doc = $state.raw<PdfDocument | null>(null);
  let outline = $state.raw<PdfOutlineItem[]>([]);
  let sizes = $state.raw<{ w: number; h: number }[]>([]);
  let error = $state<string | null>(null);
  let current = $state(0);
  let visible = $state(true);
  let panel = $state<Panel>(null);
  let viewer = $state<HTMLDivElement>();
  let W = $state(0);
  let H = $state(0);
  let active = $state(new Set<number>());

  const ps = $derived(settings.synced.pdf);
  const count = $derived(sizes.length);
  const PAD = 12;
  const CSS_PER_PT = 96 / 72;

  onMount(async () => {
    try {
      const d = await PdfDocument.open(blob);
      const first = (await d.getPage(0)).getViewport({ scale: 1 });
      sizes = Array.from({ length: d.pageCount }, () => ({ w: first.width, h: first.height }));
      current = edge === 'end' ? d.pageCount - 1 : edge === 'start' ? 0 : resumePage(initial, d.pageCount);
      doc = d;
      void d.getOutline().then((o) => (outline = o)).catch(() => {});
      void loadSizes(d);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  });

  /** Real page sizes, fetched in the background (mixed page sizes are common). */
  async function loadSizes(d: PdfDocument) {
    const next = [...sizes];
    for (let i = 1; i < d.pageCount; i++) {
      if (!doc) return;
      try {
        const vp = (await d.getPage(i)).getViewport({ scale: 1 });
        next[i] = { w: vp.width, h: vp.height };
      } catch {
        // keep the default
      }
      if (i % 25 === 0 || i === d.pageCount - 1) sizes = [...next];
    }
  }

  onDestroy(() => {
    observer?.disconnect();
    doc?.close();
    doc = null;
  });

  function scaleFor(i: number, fit: FitMode, zoom: number): number {
    const s = sizes[i];
    if (!s || !W || !H) return 0;
    const w = Math.max(1, W - PAD * 2);
    const h = Math.max(1, H - PAD * 2);
    switch (fit) {
      case 'width':
        return (w / s.w) * zoom;
      case 'height':
        return (h / s.h) * zoom;
      case 'contain':
        return Math.min(w / s.w, h / s.h) * zoom;
      default:
        return CSS_PER_PT * zoom;
    }
  }

  $effect(() => {
    if (count) onlocation(pageLocator(current, count));
  });

  // --- continuous mode: render only pages near the viewport -------------------
  let observer: IntersectionObserver | null = null;
  function observe(node: HTMLElement) {
    if (!observer) {
      observer = new IntersectionObserver(
        (entries) => {
          const next = new Set(active);
          for (const e of entries) {
            const i = Number((e.target as HTMLElement).dataset.slot);
            if (e.isIntersecting) next.add(i);
            else next.delete(i);
          }
          active = next;
        },
        { root: viewer, rootMargin: '1200px 0px' },
      );
    }
    observer.observe(node);
    return { destroy: () => observer?.unobserve(node) };
  }

  $effect(() => {
    if (ps.mode !== 'continuous') {
      observer?.disconnect();
      observer = null;
      active = new Set();
    }
  });

  let ticking = false;
  let positioned = false;
  function onscroll() {
    if (ps.mode !== 'continuous' || ticking || !positioned) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      if (!viewer) return;
      const mid = viewer.scrollTop + viewer.clientHeight / 2;
      let best = current;
      let bestDist = Infinity;
      for (const el of viewer.querySelectorAll<HTMLElement>('[data-slot]')) {
        const d = Math.abs(el.offsetTop + el.offsetHeight / 2 - mid);
        if (d < bestDist) {
          bestDist = d;
          best = Number(el.dataset.slot);
        }
      }
      current = best;
    });
  }

  function scrollToSlot(i: number) {
    const el = viewer?.querySelector<HTMLElement>(`[data-slot="${i}"]`);
    if (el && viewer) viewer.scrollTop = el.offsetTop - PAD;
  }

  // Position continuous mode at the current page whenever the mode (re)starts.
  $effect(() => {
    if (ps.mode !== 'continuous' || !doc || !W) return;
    positioned = false;
    void tick().then(() => {
      scrollToSlot(current);
      positioned = true;
    });
  });

  let prevZoom: number | null = null;
  $effect(() => {
    const z = ps.zoom;
    if (prevZoom === null || !viewer || z === prevZoom) {
      prevZoom = z;
      return;
    }
    const ratio = z / prevZoom;
    prevZoom = z;
    const el = viewer;
    void tick().then(() => keepCenter(el, ratio));
  });

  // --- navigation ---------------------------------------------------------------
  function go(page: number) {
    if (!count) return;
    current = Math.min(count - 1, Math.max(0, page));
    if (ps.mode === 'continuous') scrollToSlot(current);
    else if (viewer) viewer.scrollTop = 0;
  }
  const next = () => go(current + 1);
  const prev = () => go(current - 1);

  function setZoom(z: number) {
    settings.updateSynced((s) => (s.pdf.zoom = clampZoom(z)));
  }

  let down: { x: number; y: number } | null = null;
  function onclick(e: MouseEvent) {
    if (!viewer || (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8)) return;
    if (window.getSelection()?.toString()) return; // selecting text
    const zone = ps.mode === 'paged' ? clickZone(e, viewer) : 'middle';
    if (zone === 'middle') visible = !visible;
    else if (zone === 'right') next();
    else prev();
  }

  function onkeydown(e: KeyboardEvent) {
    if (isTypingTarget(e.target) || panel || e.metaKey || e.ctrlKey || e.altKey) return;
    const el = viewer;
    const pageH = el?.clientHeight ?? 600;
    const cont = ps.mode === 'continuous';
    const canScroll = (dy: number) => !!el && (dy > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0);
    let handled = true;
    switch (e.key) {
      case 'ArrowRight':
        if (cont) handled = false;
        else next();
        break;
      case 'ArrowLeft':
        if (cont) handled = false;
        else prev();
        break;
      case ' ':
        if (cont) el?.scrollBy({ top: (e.shiftKey ? -1 : 1) * pageH * 0.9 });
        else if (e.shiftKey) prev();
        else next();
        break;
      case 'ArrowDown':
      case 'PageDown':
        if (cont || canScroll(1)) el?.scrollBy({ top: e.key === 'ArrowDown' ? 100 : pageH });
        else next();
        break;
      case 'ArrowUp':
      case 'PageUp':
        if (cont || canScroll(-1)) el?.scrollBy({ top: -(e.key === 'ArrowUp' ? 100 : pageH) });
        else prev();
        break;
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
      case '+':
      case '=':
        setZoom(ps.zoom + ZOOM_STEP);
        break;
      case '-':
        setZoom(ps.zoom - ZOOM_STEP);
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

  function currentOutlineTitle(items: PdfOutlineItem[], page: number): string {
    let best = '';
    const walk = (list: PdfOutlineItem[]) => {
      for (const it of list) {
        if (it.page != null && it.page <= page) best = it.title;
        walk(it.items);
      }
    };
    walk(items);
    return best;
  }
  const chapter = $derived(currentOutlineTitle(outline, current));
</script>

<svelte:window {onkeydown} />

{#snippet outlineList(items: PdfOutlineItem[], close: () => void, depth: number)}
  <ul class="toc" class:nested={depth > 0}>
    {#each items as it, i (i)}
      <li>
        <button
          class="toc-item"
          type="button"
          disabled={it.page == null}
          aria-current={it.title === chapter ? 'true' : undefined}
          onclick={() => {
            if (it.page != null) go(it.page);
            close();
          }}
        >
          <span>{it.title}</span>
          {#if it.page != null}<span class="toc-page">{it.page + 1}</span>{/if}
        </button>
        {#if it.items.length}{@render outlineList(it.items, close, depth + 1)}{/if}
      </li>
    {/each}
  </ul>
{/snippet}

{#snippet toc(close: () => void)}
  {@render outlineList(outline, close, 0)}
{/snippet}

{#snippet settingsPanel()}
  <div class="opt">
    <span class="label">Layout</span>
    <Segmented label="Layout" value={ps.mode} onchange={(v) => settings.updateSynced((s) => (s.pdf.mode = v))}
      options={[{ value: 'paged', label: 'Pages', icon: 'page-single' }, { value: 'continuous', label: 'Scroll', icon: 'scroll' }]} />
  </div>
  <div class="opt">
    <span class="label">Fit</span>
    <Segmented label="Fit" compact value={ps.fit} onchange={(v) => settings.updateSynced((s) => (s.pdf.fit = v))}
      options={[{ value: 'contain', label: 'Page' }, { value: 'width', label: 'Width' }, { value: 'height', label: 'Height' }, { value: 'original', label: '100%' }]} />
  </div>
  <div class="opt">
    <span class="label">Zoom</span>
    <div class="zoom">
      <button class="icon-btn" type="button" aria-label="Zoom out" disabled={ps.zoom <= ZOOM_MIN} onclick={() => setZoom(ps.zoom - ZOOM_STEP)}><Icon name="zoom-out" /></button>
      <button class="btn small ghost" type="button" onclick={() => setZoom(1)} aria-label="Reset zoom">{Math.round(ps.zoom * 100)}%</button>
      <button class="icon-btn" type="button" aria-label="Zoom in" disabled={ps.zoom >= ZOOM_MAX} onclick={() => setZoom(ps.zoom + ZOOM_STEP)}><Icon name="zoom-in" /></button>
    </div>
  </div>
{/snippet}

{#snippet footer()}
  <div class="footer">
    <button class="icon-btn" type="button" aria-label="Previous page" onclick={prev} disabled={current <= 0}><Icon name="chevron-left" /></button>
    <input class="slider" type="range" min="0" max={Math.max(0, count - 1)} value={current} aria-label="Page" oninput={(e) => go(Number(e.currentTarget.value))} />
    <button class="icon-btn" type="button" aria-label="Next page" onclick={next} disabled={current >= count - 1}><Icon name="chevron-right" /></button>
    {#if editingPage}
      <form onsubmit={submitPage}>
        <label class="visually-hidden" for="pdf-goto">Go to page</label>
        <!-- svelte-ignore a11y_autofocus -->
        <input id="pdf-goto" class="goto-input" type="number" min="1" max={count} bind:value={pageInput} autofocus onblur={() => (editingPage = false)} />
      </form>
    {:else}
      <button class="count" type="button" title="Go to page" onclick={() => { pageInput = String(current + 1); editingPage = true; }}>{current + 1} / {count}</button>
    {/if}
  </div>
{/snippet}

<ReaderChrome
  title={book.title}
  subtitle={chapter || book.authors.join(', ')}
  bind:visible
  bind:panel
  {onback}
  {bookmarks}
  here={count ? pageLocator(current, count) : null}
  hereLabel={chapter ? `${chapter} · page ${current + 1}` : `Page ${current + 1}`}
  isHere={(loc) => loc.type === 'page' && loc.page === current}
  onjump={(bm) => bm.locator.type === 'page' && go(bm.locator.page)}
  toc={outline.length ? toc : undefined}
  {settingsPanel}
  {footer}
>
  <!-- Keyboard navigation is handled on the window. -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class="viewer"
    class:paged={ps.mode === 'paged'}
    bind:this={viewer}
    bind:clientWidth={W}
    bind:clientHeight={H}
    {onscroll}
    onpointerdown={(e) => (down = { x: e.clientX, y: e.clientY })}
    {onclick}
    use:swipe={{ onSwipe: (d) => (d === 'left' ? next() : prev()), enabled: ps.mode === 'paged' }}
    use:pinch={{ getZoom: () => ps.zoom, setZoom }}
  >
    {#if error}
      <div class="message" role="alert"><Icon name="alert" size={28} /><p>{error}</p></div>
    {:else if !doc}
      <div class="message"><div class="spinner"></div><p>Opening…</p></div>
    {:else if ps.mode === 'paged'}
      {@const s = scaleFor(current, ps.fit, ps.zoom)}
      {@const size = sizes[current]}
      {#if size && s > 0}
        <div class="stage">
          {#key current}
            <PdfPage {doc} index={current} scale={s} width={Math.round(size.w * s)} height={Math.round(size.h * s)} />
          {/key}
        </div>
      {/if}
    {:else}
      <div class="column">
        {#each sizes as size, i (i)}
          {@const s = scaleFor(i, ps.fit, ps.zoom)}
          <div class="slot" data-slot={i} use:observe>
            <PdfPage {doc} index={i} scale={s} width={Math.round(size.w * s)} height={Math.round(size.h * s)} active={active.has(i)} />
          </div>
        {/each}
      </div>
    {/if}
  </div>
</ReaderChrome>

<style>
  .viewer {
    position: absolute;
    inset: 0;
    overflow: auto;
    overscroll-behavior: contain;
    background: #2a2d2c;
  }
  .viewer.paged {
    display: flex;
  }
  .stage {
    margin: auto;
    padding: 12px;
  }
  .column {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 12px;
    width: max-content;
    min-width: 100%;
  }
  .slot {
    display: block;
  }
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
  .zoom {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .toc {
    list-style: none;
    margin: 0;
    padding: 0 8px;
  }
  .toc.nested {
    padding: 0 0 0 14px;
  }
  .toc-item {
    width: 100%;
    display: flex;
    justify-content: space-between;
    gap: 12px;
    min-height: 40px;
    padding: 8px 12px;
    border: 0;
    border-radius: var(--radius);
    background: none;
    color: var(--text);
    text-align: left;
    font-size: 14px;
  }
  .toc-item:hover:not(:disabled) {
    background: var(--surface-2);
  }
  .toc-item[aria-current='true'] {
    color: var(--accent);
    font-weight: 600;
  }
  .toc-page {
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }
</style>
