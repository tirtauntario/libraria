<script lang="ts">
  import { pdfjs, type PdfDocument } from '@libraria/core/browser';

  /**
   * One PDF page: canvas rendered at devicePixelRatio plus a pdf.js text
   * layer for selection. When `active` is false the canvas and text layer
   * are released (continuous mode keeps only pages near the viewport).
   */
  let {
    doc,
    index,
    scale,
    width,
    height,
    active = true,
  }: {
    doc: PdfDocument;
    index: number;
    /** CSS pixels per PDF unit. */
    scale: number;
    /** CSS size of the page box (known before rendering). */
    width: number;
    height: number;
    active?: boolean;
  } = $props();

  let canvas = $state<HTMLCanvasElement>();
  let textDiv = $state<HTMLDivElement>();
  let rendered = $state(false);

  // iOS Safari refuses canvases above ~16.7 M pixels.
  const MAX_PIXELS = 16_000_000;

  $effect(() => {
    if (!active || !canvas || !textDiv || scale <= 0) return;
    const c = canvas;
    const t = textDiv;
    const s = scale;
    let cancelled = false;
    let task: { cancel(): void; promise: Promise<unknown> } | null = null;
    let textLayer: InstanceType<typeof pdfjs.TextLayer> | null = null;

    void (async () => {
      try {
        const page = await doc.getPage(index);
        if (cancelled) return;
        const viewport = page.getViewport({ scale: s });
        let dpr = window.devicePixelRatio || 1;
        const px = viewport.width * viewport.height * dpr * dpr;
        if (px > MAX_PIXELS) dpr = Math.sqrt(MAX_PIXELS / (viewport.width * viewport.height));
        const renderViewport = page.getViewport({ scale: s * dpr });
        // Render into an offscreen canvas first so the old image stays until the new one is ready.
        const buffer = document.createElement('canvas');
        buffer.width = Math.floor(renderViewport.width);
        buffer.height = Math.floor(renderViewport.height);
        task = page.render({ canvas: buffer, viewport: renderViewport });
        await task.promise;
        if (cancelled) return;
        c.width = buffer.width;
        c.height = buffer.height;
        c.getContext('2d')?.drawImage(buffer, 0, 0);
        buffer.width = buffer.height = 0;
        rendered = true;

        t.replaceChildren();
        t.style.setProperty('--total-scale-factor', String(s));
        t.style.setProperty('--scale-round-x', '1px');
        t.style.setProperty('--scale-round-y', '1px');
        // streamTextContent, not getTextContent: the latter needs async
        // iteration of ReadableStream (Safari 17.2+).
        textLayer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: t, viewport });
        await textLayer.render();
      } catch (err) {
        if ((err as Error)?.name !== 'RenderingCancelledException' && !cancelled) console.warn('PDF page render failed', err);
      }
    })();

    return () => {
      cancelled = true;
      task?.cancel();
      textLayer?.cancel();
    };
  });

  // Release memory when the page scrolls far away.
  $effect(() => {
    if (active || !canvas) return;
    canvas.width = 0;
    canvas.height = 0;
    textDiv?.replaceChildren();
    rendered = false;
  });
</script>

<div class="pdf-page" style:width="{width}px" style:height="{height}px" data-page={index}>
  <canvas bind:this={canvas} class:ready={rendered} aria-label="Page {index + 1}"></canvas>
  <div bind:this={textDiv} class="pdf-text-layer"></div>
  {#if !rendered && active}<div class="spinner" aria-hidden="true"></div>{/if}
</div>

<style>
  .pdf-page {
    position: relative;
    flex: none;
    background: #fff;
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.35);
    display: grid;
    place-items: center;
    color: #999;
  }
  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    opacity: 0;
    transition: opacity 120ms ease-out;
  }
  canvas.ready {
    opacity: 1;
  }
  .spinner {
    position: relative;
  }

  /* pdf.js text layer: transparent text positioned over the canvas, for selection. */
  .pdf-text-layer {
    position: absolute;
    inset: 0;
    overflow: clip;
    line-height: 1;
    text-align: initial;
    -webkit-text-size-adjust: none;
    text-size-adjust: none;
    forced-color-adjust: none;
    transform-origin: 0 0;
    z-index: 1;
    caret-color: CanvasText;
    --min-font-size: 1;
    --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
    --min-font-size-inv: calc(1 / var(--min-font-size));
  }
  .pdf-text-layer :global(:is(span, br)) {
    color: transparent;
    position: absolute;
    white-space: pre;
    cursor: text;
    transform-origin: 0% 0%;
    -webkit-user-select: text;
    user-select: text;
  }
  .pdf-text-layer :global(> :not(.markedContent)),
  .pdf-text-layer :global(.markedContent span:not(.markedContent)) {
    z-index: 1;
    --font-height: 0;
    font-size: calc(var(--text-scale-factor) * var(--font-height));
    --scale-x: 1;
    --rotate: 0deg;
    transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));
  }
  .pdf-text-layer :global(.markedContent) {
    display: contents;
  }
  .pdf-text-layer :global(::selection) {
    background: rgb(40 110 255 / 0.28);
  }
  .pdf-text-layer :global(br::selection) {
    background: transparent;
  }
</style>
