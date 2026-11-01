<script lang="ts">
  import { isComic, type SubmissionDto } from '@libraria/core';
  import { onDestroy, onMount, type Component } from 'svelte';
  import type { BookRecord } from '../../lib/db/schema';
  import { BookmarkList } from '../../lib/readers/bookmarks.svelte';
  import type { ReaderProps } from '../../lib/readers/types';
  import { href, router } from '../../lib/router.svelte';
  import { services } from '../../lib/services';
  import { describeError } from '../../lib/server/api';
  import { apiFor, getServer } from '../../lib/server/servers';
  import Icon from '../../lib/ui/Icon.svelte';

  /** Opens a pending submission in the reader, read-only: no progress, no bookmarks, nothing stored. */
  let { params }: { params: Record<string, string> } = $props();

  class ReadOnlyBookmarks extends BookmarkList {
    override async add(): Promise<void> {}
    override async remove(): Promise<void> {}
  }

  let failure = $state<string | null>(null);
  let sub = $state<SubmissionDto | null>(null);
  let ready = $state<{ component: Component<ReaderProps>; props: Omit<ReaderProps, 'onlocation' | 'onback' | 'onopen'> } | null>(null);
  let bookmarks: BookmarkList | null = null;
  const controller = new AbortController();

  function back() {
    router.back(`${href('/server', params.id ?? '')}?tab=review`.slice(1));
  }

  function loadReader(format: BookRecord['format']): Promise<Component<ReaderProps>> {
    if (isComic(format)) return import('../../lib/readers/comic/ComicReader.svelte').then((m) => m.default);
    if (format === 'pdf') return import('../../lib/readers/pdf/PdfReader.svelte').then((m) => m.default);
    return import('../../lib/readers/epub/EpubReader.svelte').then((m) => m.default);
  }

  onMount(async () => {
    const s = services();
    try {
      const source = await getServer(s.repo, params.id ?? '');
      if (!source) throw new Error('This server is not on this device.');
      const api = apiFor(source, s.repo);
      sub = await api.getSubmission(params.sub ?? '');
      const blob = await api.submissionFile(sub.id, controller.signal);
      const now = Date.now();
      const book: BookRecord = {
        id: `review-${sub.id}`,
        sha512: sub.sha512,
        format: sub.format,
        title: sub.title,
        authors: sub.authors,
        fileSize: sub.fileSize,
        cover: null,
        customGroup: null,
        metaSource: 'file',
        metaEdited: false,
        addedAt: now,
        updatedAt: now,
        lastReadAt: null,
      };
      bookmarks = new ReadOnlyBookmarks(s.repo, sub.sha512);
      const component = await loadReader(sub.format);
      if (controller.signal.aborted) return;
      ready = { component, props: { book, blob, initial: null, edge: null, bookmarks, siblings: { prev: null, next: null } } };
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      failure = describeError(err);
    }
  });

  onDestroy(() => {
    controller.abort();
    bookmarks?.destroy();
  });
</script>

<svelte:head><title>Review: {sub?.title ?? 'submission'} · Libraria</title></svelte:head>

{#if ready}
  <ready.component {...ready.props} onlocation={() => {}} onback={back} onopen={() => {}} />
  <p class="pill" aria-live="polite"><Icon name="info" size={14} /> Review copy · not saved</p>
{:else}
  <div class="loading">
    <button class="icon-btn back" type="button" aria-label="Back" onclick={back}><Icon name="arrow-left" /></button>
    <div class="center">
      {#if sub}<p class="title">{sub.title}</p>{/if}
      {#if failure}
        <p role="alert"><Icon name="alert" /> {failure}</p>
        <button class="btn" type="button" onclick={back}>Back</button>
      {:else}
        <div class="spinner"></div>
        <p>Loading the submitted file…</p>
      {/if}
    </div>
  </div>
{/if}

<style>
  .loading {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    background: #141615;
    color: #e9e6df;
    padding: 24px;
  }
  .back {
    position: absolute;
    top: max(8px, var(--safe-top));
    left: max(8px, var(--safe-left));
  }
  .center {
    display: grid;
    justify-items: center;
    gap: 12px;
    text-align: center;
  }
  .title {
    font-family: var(--font-serif);
    font-size: 20px;
  }
  .center p[role='alert'] {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .pill {
    position: fixed;
    z-index: 300;
    left: 50%;
    bottom: calc(76px + var(--safe-bottom));
    transform: translateX(-50%);
    display: flex;
    gap: 6px;
    align-items: center;
    padding: 4px 12px;
    border-radius: 999px;
    background: rgb(20 20 20 / 0.75);
    color: #fff;
    font-size: 12px;
    pointer-events: none;
  }
</style>
