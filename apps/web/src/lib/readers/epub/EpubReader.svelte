<script lang="ts">
  import type { BookFont, Locator } from '@libraria/core';
  import { EpubBook, type EpubTocEntry } from '@libraria/core/browser';
  import { onDestroy, onMount } from 'svelte';
  import { settings } from '../../stores/settings.svelte';
  import Icon from '../../ui/Icon.svelte';
  import Segmented from '../../ui/Segmented.svelte';
  import { isTypingTarget, SWIPE_THRESHOLD, toggleFullscreen } from '../gestures';
  import { pageFromProgression, samePosition } from '../locator';
  import ReaderChrome from '../ReaderChrome.svelte';
  import type { Panel, ReaderProps } from '../types';
  import { BOOK_FONTS, BOOK_THEMES, countPages, FONT_SIZE, LINE_HEIGHT, MARGIN, readerCss, WORD_SPACING } from './style';

  /**
   * EPUB reader. Each chapter is a sanitized document from core's EpubBook,
   * shown in an iframe with sandbox="allow-same-origin" and NO allow-scripts:
   * book code never runs, and book HTML never enters the app's DOM. The
   * parent drives everything (page turns, links, keys, swipes) by listening
   * on the iframe's document.
   */
  let { book, blob, initial, edge, bookmarks, onlocation, onback }: ReaderProps = $props();

  let epub = $state.raw<EpubBook | null>(null);
  let error = $state<string | null>(null);
  let chapterError = $state<string | null>(null);
  let spine = $state(0);
  let page = $state(0);
  let pages = $state(1);
  /** Scrolled mode: 0..1 inside the chapter. */
  let scrollProgress = $state(0);
  let loading = $state(true);
  let visible = $state(true);
  let panel = $state<Panel>(null);
  let frame = $state<HTMLIFrameElement>();

  let W = $state(0);
  let H = $state(0);

  const bs = $derived(settings.synced.book);
  const paginated = $derived(bs.flow === 'paginated');
  const rtl = $derived(epub?.info.direction === 'rtl');
  const total = $derived(epub?.spineLength ?? 0);
  const theme = $derived(BOOK_THEMES[bs.theme] ?? BOOK_THEMES.light);
  const progression = $derived(paginated ? (pages > 1 ? page / pages : 0) : scrollProgress);

  let detach: (() => void) | null = null;
  let loadToken = 0;

  onMount(async () => {
    try {
      const e = await EpubBook.open(blob);
      if (e.spineLength === 0) throw new Error('This book has no readable chapters.');
      epub = e;
      // Wait for the frame to be measured: pagination depends on its size.
      for (let i = 0; i < 60 && (!W || !H); i++) await new Promise((r) => requestAnimationFrame(r));
      let start: Target = { kind: 'start' };
      let startSpine = 0;
      if (edge === 'end') {
        startSpine = e.spineLength - 1;
        start = { kind: 'end' };
      } else if (initial?.type === 'epub') {
        startSpine = Math.min(e.spineLength - 1, Math.max(0, initial.spine));
        start = { kind: 'progression', value: initial.progression };
      }
      await loadChapter(startSpine, start);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      loading = false;
    }
  });

  onDestroy(() => {
    detach?.();
    epub?.close();
  });

  // --- chapter loading ------------------------------------------------------------

  type Target = { kind: 'start' } | { kind: 'end' } | { kind: 'progression'; value: number } | { kind: 'fragment'; id: string };

  function css(): string {
    return readerCss($state.snapshot(bs) as typeof bs, { paginated, width: W || window.innerWidth, height: H || window.innerHeight });
  }

  async function loadChapter(index: number, target: Target): Promise<void> {
    const e = epub;
    const f = frame;
    if (!e || !f) return;
    const token = ++loadToken;
    loading = true;
    chapterError = null;
    let html: string;
    const usedCss = css();
    try {
      html = await e.chapterDocument(index, usedCss);
    } catch (err) {
      chapterError = err instanceof Error ? err.message : String(err);
      spine = index;
      loading = false;
      return;
    }
    if (token !== loadToken) return;
    detach?.();
    detach = null;
    await new Promise<void>((resolve) => {
      f.onload = () => resolve();
      f.srcdoc = html;
    });
    if (token !== loadToken) return;
    spine = index;
    const doc = f.contentDocument;
    if (!doc) return;
    detach = attach(doc);
    await settled(doc);
    if (token !== loadToken) return;
    lastCss = usedCss;
    measure();
    position(target);
    loading = false;
    report();
    // The frame may have been resized or settings changed while loading.
    if (css() !== usedCss) void relayout();
  }

  /** Wait for fonts and images, which change the layout. */
  async function settled(doc: Document): Promise<void> {
    const imgs = Array.from(doc.images).filter((i) => !i.complete);
    const wait = Promise.all([
      doc.fonts?.ready.catch(() => {}),
      ...imgs.map((i) => new Promise((r) => ((i.onload = r), (i.onerror = r)))),
    ]);
    await Promise.race([wait, new Promise((r) => setTimeout(r, 1500))]);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
  }

  function scroller(): Element | null {
    return frame?.contentDocument?.scrollingElement ?? null;
  }

  function pageWidth(): number {
    return frame?.contentDocument?.documentElement.clientWidth || W;
  }

  function measure() {
    const el = scroller();
    if (!el) return;
    if (paginated) pages = countPages(el.scrollWidth, pageWidth());
    else pages = 1;
  }

  function position(target: Target) {
    const el = scroller();
    if (!el) return;
    if (paginated) {
      let p = 0;
      if (target.kind === 'end') p = pages - 1;
      else if (target.kind === 'progression') p = pageFromProgression(target.value, pages);
      else if (target.kind === 'fragment') p = pageOfFragment(target.id) ?? 0;
      showPage(p);
    } else {
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      if (target.kind === 'end') el.scrollTop = max;
      else if (target.kind === 'progression') el.scrollTop = target.value * max;
      else if (target.kind === 'fragment') findFragment(target.id)?.scrollIntoView({ block: 'start' });
      else el.scrollTop = 0;
      scrollProgress = max > 0 ? el.scrollTop / max : 0;
    }
  }

  function findFragment(id: string): Element | null {
    const doc = frame?.contentDocument;
    if (!doc) return null;
    return doc.getElementById(id) ?? doc.querySelector(`[name="${CSS.escape(id)}"]`);
  }

  function pageOfFragment(id: string): number | null {
    const el = findFragment(id);
    if (!el) return null;
    const pw = pageWidth();
    const left = el.getBoundingClientRect().left;
    const p = rtl ? page - Math.floor(left / pw) : page + Math.floor(left / pw);
    return Math.min(pages - 1, Math.max(0, p));
  }

  function showPage(p: number) {
    const el = scroller();
    page = Math.min(pages - 1, Math.max(0, p));
    if (el) el.scrollLeft = (rtl ? -1 : 1) * page * pageWidth();
  }

  /** Re-paginate (resize, settings change) and stay at the same place. */
  async function relayout() {
    const doc = frame?.contentDocument;
    if (!doc || loading) return;
    // Not `progression`: after a flow switch it would read the other mode's state.
    const keep = lastProgression;
    const style = doc.getElementById('libraria-reader');
    lastCss = css();
    if (style) style.textContent = lastCss;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
    measure();
    position({ kind: 'progression', value: keep });
    report();
  }

  let lastCss = '';
  $effect(() => {
    // Depend on everything the CSS depends on.
    const next = readerCss($state.snapshot(bs) as typeof bs, { paginated, width: W, height: H });
    if (!epub || !W || !H || !lastCss || next === lastCss) return;
    void relayout();
  });

  // --- navigation ------------------------------------------------------------------

  function next() {
    if (loading || !epub) return;
    if (paginated && page < pages - 1) {
      showPage(page + 1);
      report();
    } else if (!paginated && scrollProgress < 0.999) {
      const el = scroller();
      el?.scrollBy({ top: (el.clientHeight || H) * 0.9 });
    } else if (spine < total - 1) {
      void loadChapter(spine + 1, { kind: 'start' });
    }
  }

  function prev() {
    if (loading || !epub) return;
    if (paginated && page > 0) {
      showPage(page - 1);
      report();
    } else if (!paginated && scrollProgress > 0.001) {
      const el = scroller();
      el?.scrollBy({ top: -(el.clientHeight || H) * 0.9 });
    } else if (spine > 0) {
      void loadChapter(spine - 1, { kind: 'end' });
    }
  }

  function goTo(target: { spine: number; fragment: string | null }) {
    panel = null;
    if (target.spine === spine && !loading && target.fragment) {
      position({ kind: 'fragment', id: target.fragment });
      report();
    } else {
      void loadChapter(target.spine, target.fragment ? { kind: 'fragment', id: target.fragment } : { kind: 'start' });
    }
  }

  function jump(loc: Locator) {
    if (loc.type !== 'epub') return;
    if (loc.spine === spine && !loading) {
      position({ kind: 'progression', value: loc.progression });
      report();
    } else {
      void loadChapter(loc.spine, { kind: 'progression', value: loc.progression });
    }
  }

  function here(): Locator {
    return { type: 'epub', spine, progression: Math.min(1, Math.max(0, progression)), total, ...(chapterTitle ? { label: chapterTitle } : {}) };
  }

  let lastProgression = 0;
  function report() {
    lastProgression = progression;
    if (epub) onlocation(here());
  }

  // --- events inside the book document --------------------------------------------

  function attach(doc: Document): () => void {
    const win = doc.defaultView;
    let touch: { x: number; y: number; t: number } | null = null;

    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.('a[href]');
      if (a) {
        e.preventDefault();
        followLink(a.getAttribute('href') ?? '');
        return;
      }
      if (doc.getSelection()?.toString()) return;
      const w = doc.documentElement.clientWidth;
      if (!paginated) {
        visible = !visible;
        return;
      }
      if (e.clientX < w / 3) (rtl ? next : prev)();
      else if (e.clientX > (w * 2) / 3) (rtl ? prev : next)();
      else visible = !visible;
    };
    const onKey = (e: KeyboardEvent) => handleKey(e);
    const onTouchStart = (e: TouchEvent) => {
      touch = e.touches.length === 1 ? { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY, t: Date.now() } : null;
    };
    const onTouchEnd = (e: TouchEvent) => {
      const t = e.changedTouches[0];
      if (!touch || !t || !paginated) return;
      const dx = t.clientX - touch.x;
      const dy = t.clientY - touch.y;
      touch = null;
      if (Math.abs(dx) >= SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy) * 1.2) {
        const forward = (dx < 0) !== rtl;
        (forward ? next : prev)();
      }
    };
    // Paginated: block native horizontal scrolling (trackpads, touch) so pages stay aligned.
    const onWheel = (e: WheelEvent) => {
      if (!paginated || e.ctrlKey) return;
      e.preventDefault();
      if (wheelLock) return;
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (Math.abs(d) < 12) return;
      wheelLock = true;
      setTimeout(() => (wheelLock = false), 350);
      (d > 0 ? next : prev)();
    };
    let ticking = false;
    const onScroll = () => {
      if (paginated || ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        const el = scroller();
        if (!el) return;
        const max = Math.max(0, el.scrollHeight - el.clientHeight);
        scrollProgress = max > 0 ? el.scrollTop / max : 0;
        report();
      });
    };
    // Keep the paginated scroll position exact (e.g. after find-in-page or focus moves).
    const onPaginatedScroll = () => {
      if (!paginated) return;
      const el = scroller();
      if (!el) return;
      const expected = (rtl ? -1 : 1) * page * pageWidth();
      if (Math.abs(el.scrollLeft - expected) > 2) el.scrollLeft = expected;
    };

    doc.addEventListener('click', onClick);
    doc.addEventListener('keydown', onKey);
    doc.addEventListener('touchstart', onTouchStart, { passive: true });
    doc.addEventListener('touchend', onTouchEnd, { passive: true });
    doc.addEventListener('wheel', onWheel, { passive: false });
    win?.addEventListener('scroll', onScroll, { passive: true });
    win?.addEventListener('scroll', onPaginatedScroll, { passive: true });
    return () => {
      doc.removeEventListener('click', onClick);
      doc.removeEventListener('keydown', onKey);
      doc.removeEventListener('touchstart', onTouchStart);
      doc.removeEventListener('touchend', onTouchEnd);
      doc.removeEventListener('wheel', onWheel);
      win?.removeEventListener('scroll', onScroll);
      win?.removeEventListener('scroll', onPaginatedScroll);
    };
  }
  let wheelLock = false;

  function followLink(href: string) {
    if (!href || !epub) return;
    if (/^(https?:|mailto:)/i.test(href)) {
      window.open(href, '_blank', 'noopener,noreferrer');
      return;
    }
    if (href.startsWith('#')) {
      const id = decodeURIComponent(href.slice(1));
      if (id) goTo({ spine, fragment: id });
      return;
    }
    const target = epub.resolveLink(spine, href);
    if (target) goTo(target);
  }

  function handleKey(e: KeyboardEvent) {
    if (isTypingTarget(e.target) || panel || e.metaKey || e.ctrlKey || e.altKey) return;
    let handled = true;
    switch (e.key) {
      case 'ArrowRight':
        (rtl ? prev : next)();
        break;
      case 'ArrowLeft':
        (rtl ? next : prev)();
        break;
      case ' ':
      case 'PageDown':
        (e.shiftKey ? prev : next)();
        break;
      case 'PageUp':
        prev();
        break;
      case 'ArrowDown':
        if (paginated) next();
        else handled = false;
        break;
      case 'ArrowUp':
        if (paginated) prev();
        else handled = false;
        break;
      case 'Home':
        void loadChapter(0, { kind: 'start' });
        break;
      case 'End':
        void loadChapter(total - 1, { kind: 'end' });
        break;
      case 'f':
      case 'F':
        toggleFullscreen();
        break;
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  }

  // --- TOC -----------------------------------------------------------------------

  function flatToc(entries: EpubTocEntry[]): EpubTocEntry[] {
    return entries.flatMap((e) => [e, ...flatToc(e.children)]);
  }
  const flat = $derived(epub ? flatToc(epub.toc) : []);
  const chapterTitle = $derived.by(() => {
    let best: EpubTocEntry | undefined;
    for (const t of flat) if (t.spine >= 0 && t.spine <= spine && (!best || t.spine >= best.spine)) best = t;
    return best?.title ?? '';
  });

  const overall = $derived(total ? Math.min(1, (spine + progression) / total) : 0);
  let sliderValue = $state<number | null>(null);

  function changeSize(delta: number) {
    settings.updateSynced((s) => (s.book.fontSize = Math.min(FONT_SIZE.max, Math.max(FONT_SIZE.min, s.book.fontSize + delta))));
  }
  const round = (v: number, step: number) => Math.round(v / step) * step;
</script>

<svelte:window onkeydown={handleKey} />

{#snippet tocList(entries: EpubTocEntry[], close: () => void, depth: number)}
  <ul class="toc" class:nested={depth > 0}>
    {#each entries as entry, i (i)}
      <li>
        <button
          class="toc-item"
          type="button"
          disabled={entry.spine < 0}
          aria-current={entry.spine === spine && entry.title === chapterTitle ? 'true' : undefined}
          onclick={() => {
            close();
            goTo({ spine: entry.spine, fragment: entry.fragment });
          }}>{entry.title || 'Untitled'}</button
        >
        {#if entry.children.length}{@render tocList(entry.children, close, depth + 1)}{/if}
      </li>
    {/each}
  </ul>
{/snippet}

{#snippet toc(close: () => void)}
  {#if epub && epub.toc.length}
    {@render tocList(epub.toc, close, 0)}
  {:else}
    <p class="empty">This book has no table of contents.</p>
  {/if}
{/snippet}

{#snippet settingsPanel()}
  <div class="opt">
    <span class="label">Layout</span>
    <Segmented label="Layout" value={bs.flow} onchange={(v) => settings.updateSynced((s) => (s.book.flow = v))}
      options={[{ value: 'paginated', label: 'Pages', icon: 'page-single' }, { value: 'scrolled', label: 'Scroll', icon: 'scroll' }]} />
  </div>
  <div class="opt">
    <span class="label">Page colour</span>
    <div class="swatches" role="radiogroup" aria-label="Page colour">
      {#each Object.entries(BOOK_THEMES) as [key, t] (key)}
        <button type="button" role="radio" aria-checked={bs.theme === key} class="swatch" style:background={t.bg} style:color={t.fg}
          onclick={() => settings.updateSynced((s) => (s.book.theme = key as typeof s.book.theme))}>
          Aa <span class="visually-hidden">{key}</span>
        </button>
      {/each}
    </div>
  </div>
  <div class="opt">
    <span class="label">Font</span>
    <div class="fonts" role="radiogroup" aria-label="Font">
      {#each Object.entries(BOOK_FONTS) as [key, f] (key)}
        <button type="button" role="radio" aria-checked={bs.font === key} class="font" style:font-family={f.stack ?? 'inherit'}
          onclick={() => settings.updateSynced((s) => (s.book.font = key as BookFont))}>{f.label}</button>
      {/each}
    </div>
  </div>
  <div class="opt">
    <span class="label">Text size</span>
    <div class="stepper">
      <button class="icon-btn" type="button" aria-label="Smaller text" disabled={bs.fontSize <= FONT_SIZE.min} onclick={() => changeSize(-FONT_SIZE.step)}><span class="a-small">A</span></button>
      <span class="value">{bs.fontSize}%</span>
      <button class="icon-btn" type="button" aria-label="Larger text" disabled={bs.fontSize >= FONT_SIZE.max} onclick={() => changeSize(FONT_SIZE.step)}><span class="a-big">A</span></button>
    </div>
  </div>
  <label class="opt">
    <span class="label">Line spacing <span class="value-inline">{bs.lineHeight.toFixed(1)}</span></span>
    <input type="range" min={LINE_HEIGHT.min} max={LINE_HEIGHT.max} step={LINE_HEIGHT.step} value={bs.lineHeight}
      oninput={(e) => settings.updateSynced((s) => (s.book.lineHeight = round(Number(e.currentTarget.value), LINE_HEIGHT.step)))} />
  </label>
  <label class="opt">
    <span class="label">Margins <span class="value-inline">{bs.margin}%</span></span>
    <input type="range" min={MARGIN.min} max={MARGIN.max} step={MARGIN.step} value={bs.margin}
      oninput={(e) => settings.updateSynced((s) => (s.book.margin = Number(e.currentTarget.value)))} />
  </label>
  <label class="opt">
    <span class="label">Word spacing <span class="value-inline">{bs.wordSpacing.toFixed(2)} em</span></span>
    <input type="range" min={WORD_SPACING.min} max={WORD_SPACING.max} step={WORD_SPACING.step} value={bs.wordSpacing}
      oninput={(e) => settings.updateSynced((s) => (s.book.wordSpacing = round(Number(e.currentTarget.value), WORD_SPACING.step)))} />
  </label>
  <label class="opt row">
    <span class="label">Justify text</span>
    <input type="checkbox" checked={bs.justify} onchange={(e) => settings.updateSynced((s) => (s.book.justify = e.currentTarget.checked))} />
  </label>
{/snippet}

{#snippet footer()}
  <div class="footer">
    <button class="icon-btn" type="button" aria-label={rtl ? 'Next' : 'Previous'} onclick={() => (rtl ? next() : prev())}><Icon name="chevron-left" /></button>
    <div class="progress">
      <input
        class="slider"
        type="range"
        min="0"
        max={total}
        step="0.01"
        dir={rtl ? 'rtl' : 'ltr'}
        value={sliderValue ?? spine + progression}
        aria-label="Position in book"
        oninput={(e) => (sliderValue = Number(e.currentTarget.value))}
        onchange={(e) => {
          const v = Number(e.currentTarget.value);
          sliderValue = null;
          const s = Math.min(total - 1, Math.floor(v));
          jump({ type: 'epub', spine: s, progression: v - s, total });
        }}
      />
      <div class="meta">
        <span class="chapter">{chapterTitle || `Section ${spine + 1} of ${total}`}</span>
        <span class="pos">
          {#if paginated}{page + 1} / {pages} ·{/if}
          {Math.round(overall * 100)}%
        </span>
      </div>
    </div>
    <button class="icon-btn" type="button" aria-label={rtl ? 'Previous' : 'Next'} onclick={() => (rtl ? prev() : next())}><Icon name="chevron-right" /></button>
  </div>
{/snippet}

<ReaderChrome
  title={book.title}
  subtitle={chapterTitle || book.authors.join(', ')}
  bind:visible
  bind:panel
  {onback}
  {bookmarks}
  here={epub ? here() : null}
  hereLabel={`${chapterTitle || `Section ${spine + 1}`} · ${Math.round(overall * 100)}%`}
  isHere={(loc) => samePosition(loc, here(), paginated ? pages : 1000)}
  onjump={(bm) => jump(bm.locator)}
  {toc}
  {settingsPanel}
  {footer}
  tone={bs.theme}
>
  <div class="page" style:background={theme.bg} style:color={theme.fg}>
    <div class="host" bind:clientWidth={W} bind:clientHeight={H}>
      <iframe
        bind:this={frame}
        title="Book text"
        sandbox="allow-same-origin"
        referrerpolicy="no-referrer"
        style:width="{Math.floor(W)}px"
        style:height="{Math.floor(H)}px"
        class:hidden={loading}
      ></iframe>
    </div>
    {#if error || chapterError}
      <div class="message" role="alert">
        <Icon name="alert" size={28} />
        <p>{error ?? `This section could not be shown: ${chapterError}`}</p>
        {#if chapterError && spine < total - 1}<button class="btn small" type="button" onclick={() => loadChapter(spine + 1, { kind: 'start' })}>Next section</button>{/if}
      </div>
    {:else if loading}
      <div class="message"><div class="spinner"></div></div>
    {/if}
  </div>
</ReaderChrome>

<style>
  .page {
    position: absolute;
    inset: 0;
    transition: background-color 200ms ease;
  }
  .host {
    position: absolute;
    top: max(52px, calc(var(--safe-top) + 48px));
    bottom: max(56px, calc(var(--safe-bottom) + 48px));
    left: var(--safe-left);
    right: var(--safe-right);
    overflow: hidden;
  }
  iframe {
    display: block;
    border: 0;
    background: transparent;
    color-scheme: normal;
  }
  iframe.hidden {
    visibility: hidden;
  }
  .message {
    position: absolute;
    inset: 0;
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 12px;
    padding: 24px;
    text-align: center;
    opacity: 0.8;
  }
  .footer {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .progress {
    flex: 1;
    min-width: 0;
    display: grid;
    gap: 2px;
  }
  .slider {
    width: 100%;
    accent-color: #7cc4ad;
  }
  .meta {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    font-size: 12px;
    color: var(--bar-sub);
  }
  .chapter {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pos {
    flex: none;
    font-variant-numeric: tabular-nums;
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
  .value-inline {
    float: right;
    color: var(--text-3);
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }
  .swatches {
    display: flex;
    gap: 10px;
  }
  .swatch {
    width: 56px;
    height: 44px;
    border-radius: var(--radius);
    border: 2px solid transparent;
    font-family: var(--font-serif);
    font-size: 16px;
    box-shadow: inset 0 0 0 1px rgb(127 127 127 / 0.35);
  }
  .swatch[aria-checked='true'] {
    border-color: var(--accent);
  }
  .fonts {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
  }
  .font {
    min-height: 40px;
    border-radius: var(--radius);
    border: 1px solid var(--border-strong);
    background: var(--surface);
    color: var(--text);
    font-size: 14px;
  }
  .font[aria-checked='true'] {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .stepper {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 2px;
    border-radius: var(--radius);
    background: var(--surface-2);
  }
  .value {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
  .a-small {
    font-size: 13px;
    font-weight: 600;
  }
  .a-big {
    font-size: 20px;
    font-weight: 600;
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
  .empty {
    padding: 8px 20px;
    color: var(--text-2);
    font-size: 14px;
  }
</style>
