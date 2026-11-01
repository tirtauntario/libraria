<script lang="ts">
  import { isBookFilename } from '@libraria/core';
  import { onMount } from 'svelte';
  import { importer } from '../stores/importer.svelte';
  import { toasts } from '../stores/toasts.svelte';
  import Icon from './Icon.svelte';

  /** Drop books anywhere on the window to import them. */
  let active = $state(false);
  let depth = 0;

  const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');

  onMount(() => {
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      active = true;
    };
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) active = false;
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      active = false;
      const files = [...(e.dataTransfer?.files ?? [])];
      const books = files.filter((f) => isBookFilename(f.name));
      if (books.length < files.length) {
        toasts.show(`Skipped ${files.length - books.length} file(s) that are not EPUB, PDF, CBZ or CBR.`);
      }
      importer.add(books);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  });
</script>

{#if active}
  <div class="drop" aria-hidden="true">
    <div class="box">
      <Icon name="upload" size={36} />
      <p>Drop to add to your library</p>
      <p class="hint">EPUB, PDF, CBZ and CBR</p>
    </div>
  </div>
{/if}

<style>
  .drop {
    position: fixed;
    inset: 0;
    z-index: 90;
    display: grid;
    place-items: center;
    padding: 24px;
    background: color-mix(in srgb, var(--bg) 70%, transparent);
    backdrop-filter: blur(4px);
    pointer-events: none;
    animation: fade 120ms var(--ease);
  }
  .box {
    display: grid;
    justify-items: center;
    gap: 6px;
    width: min(420px, 100%);
    padding: 40px 24px;
    border: 2px dashed var(--accent);
    border-radius: var(--radius-lg);
    background: var(--surface);
    color: var(--accent);
    font-weight: 600;
    font-size: 17px;
    box-shadow: var(--shadow-lg);
  }
  .hint {
    color: var(--text-3);
    font-weight: 500;
    font-size: 13px;
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
</style>
