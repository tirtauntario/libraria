<script lang="ts">
  import type { FitMode, ReadingDirection } from '@libraria/core';
  import { tick } from 'svelte';
  import { fly } from 'svelte/transition';
  import { clickZone, keepCenter, pinch, swipe } from '../gestures';
  import { spreadPages, type ComicPages } from './pages.svelte';

  let {
    pages,
    current,
    spread,
    direction,
    fit,
    zoom,
    moveDir,
    viewer = $bindable(),
    onzone,
    onswipe,
    onzoom,
  }: {
    pages: ComicPages;
    current: number;
    spread: boolean;
    direction: ReadingDirection;
    fit: FitMode;
    zoom: number;
    /** +1 after going forward, -1 after going back (for the slide). */
    moveDir: number;
    viewer?: HTMLDivElement;
    onzone: (zone: 'left' | 'middle' | 'right') => void;
    onswipe: (dir: 'left' | 'right') => void;
    onzoom: (zoom: number) => void;
  } = $props();

  let W = $state(0);
  let H = $state(0);
  const reduceMotion = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const shown = $derived(spread ? spreadPages(current, pages.count) : [current]);
  const ordered = $derived(direction === 'rtl' ? [...shown].reverse() : shown);

  const layout = $derived.by(() => {
    const base = 1000;
    const dims = ordered.map((i) => {
      const s = pages.sizes.get(i);
      return s ? { w: (s.w * base) / s.h, h: base, natural: s.h } : { w: pages.typicalAspect * base, h: base, natural: base };
    });
    const totalW = dims.reduce((n, d) => n + d.w, 0);
    const natural = Math.max(...dims.map((d) => d.natural));
    let scale: number;
    if (!W || !H) scale = 0;
    else if (fit === 'contain') scale = Math.min(W / totalW, H / base);
    else if (fit === 'width') scale = W / totalW;
    else if (fit === 'height') scale = H / base;
    else scale = natural / base;
    return ordered.map((i, k) => ({ index: i, w: Math.round(dims[k]!.w * scale * zoom), h: Math.round(base * scale * zoom) }));
  });

  // Scroll back to the start of the page when it changes.
  $effect(() => {
    void current;
    if (viewer) {
      viewer.scrollTop = 0;
      viewer.scrollLeft = direction === 'rtl' ? viewer.scrollWidth : 0;
    }
  });

  // Keep the visual centre while zooming.
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
  function onpointerdown(e: PointerEvent) {
    down = { x: e.clientX, y: e.clientY };
  }
  function onclick(e: MouseEvent) {
    // Ignore drags (panning a zoomed page) and text selection.
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) return;
    if (viewer) onzone(clickZone(e, viewer));
  }
</script>

<!-- Keyboard navigation is handled by the reader. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
  class="viewer"
  bind:this={viewer}
  bind:clientWidth={W}
  bind:clientHeight={H}
  {onpointerdown}
  {onclick}
  use:swipe={{ onSwipe: onswipe }}
  use:pinch={{ getZoom: () => zoom, setZoom: onzoom }}
>
  {#key current}
    <div class="stage" in:fly={{ x: reduceMotion ? 0 : moveDir * (direction === 'rtl' ? -48 : 48), duration: reduceMotion ? 0 : 220, opacity: 0.2 }}>
      {#each layout as p (p.index)}
        {@const url = pages.urls.get(p.index)}
        <div class="page" style:width="{p.w}px" style:height="{p.h}px">
          {#if url}
            <img src={url} alt="Page {p.index + 1}" draggable="false" />
          {:else}
            <div class="spinner" aria-label="Loading page {p.index + 1}"></div>
          {/if}
        </div>
      {/each}
    </div>
  {/key}
</div>

<style>
  .viewer {
    position: absolute;
    inset: 0;
    overflow: auto;
    display: flex;
    overscroll-behavior: contain;
    -webkit-user-select: none;
    user-select: none;
    scrollbar-width: none;
  }
  .viewer::-webkit-scrollbar {
    display: none;
  }
  .stage {
    margin: auto;
    display: flex;
    flex: none;
  }
  .page {
    position: relative;
    flex: none;
    display: grid;
    place-items: center;
    color: rgb(255 255 255 / 0.5);
  }
  img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    -webkit-user-drag: none;
  }
</style>
