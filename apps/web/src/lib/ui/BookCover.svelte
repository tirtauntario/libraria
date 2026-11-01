<script lang="ts">
  import type { BookFormat } from '@libraria/core';
  import { FORMAT_LABEL } from './format';

  /** Cover thumbnail with a typographic fallback. Owns its blob URL. */
  let { cover, title, format, eager = false }: { cover: Blob | null; title: string; format: BookFormat; eager?: boolean } = $props();

  let url = $state<string | null>(null);
  let failed = $state(false);

  $effect(() => {
    failed = false;
    if (!cover) {
      url = null;
      return;
    }
    const u = URL.createObjectURL(cover);
    url = u;
    return () => URL.revokeObjectURL(u);
  });

  // Stable pleasant colour from the title for covers without an image.
  const hue = $derived([...title].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7));
</script>

<div class="cover" style:--hue={hue}>
  {#if url && !failed}
    <img src={url} alt="" loading={eager ? 'eager' : 'lazy'} decoding="async" onerror={() => (failed = true)} />
  {:else}
    <div class="fallback" aria-hidden="true">
      <span class="t">{title}</span>
      <span class="f">{FORMAT_LABEL[format]}</span>
    </div>
  {/if}
</div>

<style>
  .cover {
    position: relative;
    aspect-ratio: 2 / 3;
    width: 100%;
    border-radius: 6px;
    overflow: hidden;
    background: var(--surface-2);
    box-shadow: var(--cover-shadow);
  }
  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .fallback {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 12% 10%;
    background: linear-gradient(160deg, hsl(var(--hue) 32% 42%), hsl(calc(var(--hue) + 30) 34% 28%));
    color: hsl(var(--hue) 40% 94%);
  }
  .t {
    font-family: var(--font-serif);
    font-size: clamp(11px, 1.1em, 17px);
    line-height: 1.2;
    font-weight: 600;
    display: -webkit-box;
    -webkit-line-clamp: 5;
    line-clamp: 5;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
  }
  .f {
    font-size: 10px;
    letter-spacing: 0.12em;
    font-weight: 700;
    opacity: 0.75;
  }
</style>
