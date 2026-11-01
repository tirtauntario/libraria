<script lang="ts">
  import type { FitMode } from '@libraria/core';
  import { onMount, tick, type Snippet } from 'svelte';
  import { keepCenter, pinch } from '../gestures';
  import type { ComicPages } from './pages.svelte';

  let {
    pages,
    current,
    fit,
    zoom,
    viewer = $bindable(),
    onpage,
    ontap,
    onzoom,
    before,
    after,
  }: {
    pages: ComicPages;
    current: number;
    fit: FitMode;
    zoom: number;
    viewer?: HTMLDivElement;
    onpage: (page: number) => void;
    ontap: () => void;
    onzoom: (zoom: number) => void;
    before?: Snippet;
    after?: Snippet;
  } = $props();

  let W = $state(0);
  let H = $state(0);
  const MAX_WIDTH = 960;

  function widthFor(i: number): number {
    const aspect = pages.aspect(i);
    const natural = pages.sizes.get(i)?.w ?? MAX_WIDTH;
    let w: number;
    if (fit === 'width') w = W;
    else if (fit === 'height') w = H * aspect;
    else if (fit === 'original') w = natural;
    else w = Math.min(W, MAX_WIDTH, H * aspect * 1.6);
    return Math.max(40, Math.round(w * zoom));
  }

  const indices = $derived(Array.from({ length: pages.count }, (_, i) => i));

  // Scroll to the starting page once the slots have a size.
  let positioned = false;
  onMount(() => {
    const go = async () => {
      await tick();
      const el = viewer?.querySelector<HTMLElement>(`[data-page="${current}"]`);
      if (el && viewer) viewer.scrollTop = el.offsetTop - 8;
      positioned = true;
    };
    void go();
  });

  /** Jump to a page (slider, TOC, keyboard Home/End). */
  export function scrollToPage(page: number) {
    const el = viewer?.querySelector<HTMLElement>(`[data-page="${page}"]`);
    if (el && viewer) viewer.scrollTop = el.offsetTop - 8;
  }

  let ticking = false;
  function onscroll() {
    if (ticking || !positioned) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      if (!viewer) return;
      const mid = viewer.scrollTop + viewer.clientHeight / 2;
      let best = current;
      let bestDist = Infinity;
      for (const el of viewer.querySelectorAll<HTMLElement>('[data-page]')) {
        const center = el.offsetTop + el.offsetHeight / 2;
        const d = Math.abs(center - mid);
        if (d < bestDist) {
          bestDist = d;
          best = Number(el.dataset.page);
        }
      }
      if (best !== current) onpage(best);
    });
  }

  let prevZoom: number | null = null;
  $effect(() => {
    const z = zoom;
    if (prevZoom === null || z === prevZoom || !viewer) {
      prevZoom = z;
      return;
    }
    const ratio = z / prevZoom;
    prevZoom = z;
    const el = viewer;
    void tick().then(() => keepCenter(el, ratio));
  });

  let down: { x: number; y: number } | null = null;
</script>

<!-- Keyboard navigation is handled by the reader. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
  class="viewer"
  bind:this={viewer}
  bind:clientWidth={W}
  bind:clientHeight={H}
  {onscroll}
  onpointerdown={(e) => (down = { x: e.clientX, y: e.clientY })}
  onclick={(e) => {
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) return;
    if ((e.target as HTMLElement).closest('button, a')) return;
    ontap();
  }}
  use:pinch={{ getZoom: () => zoom, setZoom: onzoom }}
>
  <div class="column">
    {#if before}<div class="edge">{@render before()}</div>{/if}
    {#each indices as i (i)}
      {@const w = widthFor(i)}
      {@const url = pages.urls.get(i)}
      <div class="slot" data-page={i} style:width="{w}px" style:aspect-ratio={pages.aspect(i)}>
        {#if url}
          <img src={url} alt="Page {i + 1}" draggable="false" />
        {/if}
      </div>
    {/each}
    {#if after}<div class="edge">{@render after()}</div>{/if}
  </div>
</div>

<style>
  .viewer {
    position: absolute;
    inset: 0;
    overflow: auto;
    overscroll-behavior: contain;
    -webkit-user-select: none;
    user-select: none;
  }
  .column {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    width: max-content;
    min-width: 100%;
    padding: 0 0 4px;
  }
  .slot {
    max-width: none;
    background: rgb(255 255 255 / 0.04);
  }
  img {
    width: 100%;
    height: 100%;
    display: block;
    object-fit: contain;
    animation: fade 150ms ease-out;
    -webkit-user-drag: none;
  }
  .edge {
    display: grid;
    place-items: center;
    width: 100%;
    padding: max(72px, calc(var(--safe-top) + 64px)) 16px 48px;
  }
  .edge:last-child {
    padding: 48px 16px max(96px, calc(var(--safe-bottom) + 96px));
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
</style>
