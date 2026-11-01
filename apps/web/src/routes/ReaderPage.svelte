<script lang="ts">
  import { isComic, type Locator } from '@libraria/core';
  import { onDestroy, onMount, type Component } from 'svelte';
  import type { BookRecord } from '../lib/db/schema';
  import { seriesSiblings } from '../lib/library/catalog';
  import { BookUnavailableError, openBook, type OpenStage } from '../lib/library/open';
  import { BookmarkList } from '../lib/readers/bookmarks.svelte';
  import { createProgressSaver, type ProgressSaver } from '../lib/readers/locator';
  import type { ReaderProps } from '../lib/readers/types';
  import { href, router } from '../lib/router.svelte';
  import { services } from '../lib/services';
  import SourceFixes from '../lib/sources/ui/SourceFixes.svelte';
  import { catalog } from '../lib/stores/catalog.svelte';
  import BookCover from '../lib/ui/BookCover.svelte';
  import Icon from '../lib/ui/Icon.svelte';
  import { formatBytes } from '../lib/ui/format';

  let { params }: { params: Record<string, string> } = $props();

  let stage = $state<OpenStage>({ phase: 'locating' });
  let failure = $state<{ message: string; reason: string } | null>(null);
  let ready = $state<{ component: Component<ReaderProps>; props: Omit<ReaderProps, 'onlocation' | 'onback' | 'onopen'> } | null>(null);
  const placeholder = $derived(catalog.book(params.id ?? ''));

  const controller = new AbortController();
  let saver: ProgressSaver | null = null;
  let bookmarks: BookmarkList | null = null;

  function loadReader(book: BookRecord): Promise<Component<ReaderProps>> {
    if (isComic(book.format)) return import('../lib/readers/comic/ComicReader.svelte').then((m) => m.default);
    if (book.format === 'pdf') return import('../lib/readers/pdf/PdfReader.svelte').then((m) => m.default);
    return import('../lib/readers/epub/EpubReader.svelte').then((m) => m.default);
  }

  onMount(async () => {
    const s = services();
    try {
      const opened = await openBook(params.id ?? '', s, { signal: controller.signal, onStage: (st) => (stage = st) });
      const book = opened.book;
      if (!book.sha512) throw new Error('Book could not be identified');
      if (book.id !== params.id) router.navigate(href('/read', book.id), { replace: true });

      const query = router.query;
      let initial: Locator | null = null;
      const bmId = query.get('bookmark');
      if (bmId) {
        const bm = (await s.repo.listBookmarks(book.sha512)).find((b) => b.id === bmId);
        initial = bm?.locator ?? null;
      }
      const edgeParam = query.get('edge');
      const edge = edgeParam === 'start' || edgeParam === 'end' ? edgeParam : null;
      if (!initial && !edge) initial = (await s.repo.getProgress(book.sha512))?.locator ?? null;

      const sha = book.sha512;
      saver = createProgressSaver((loc) => s.repo.saveProgress(sha, loc, book.id));
      bookmarks = new BookmarkList(s.repo, sha);
      const component = await loadReader(book);
      if (controller.signal.aborted) return;
      ready = {
        component,
        props: { book, blob: opened.blob, initial, edge, bookmarks, siblings: seriesSiblings(book, catalog.books) },
      };
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      if (!(err instanceof BookUnavailableError)) console.error(err); // expected states are shown, not logged
      failure = {
        message: err instanceof Error ? err.message : String(err),
        reason: err instanceof BookUnavailableError ? err.reason : 'failed',
      };
    }
  });

  const flush = () => void saver?.flush();
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') flush();
  };
  onMount(() => {
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
  });
  onDestroy(() => {
    controller.abort();
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', flush);
    flush();
    bookmarks?.destroy();
  });

  function back() {
    router.back('/');
  }

  function openSibling(book: BookRecord, edge: 'start' | 'end') {
    flush();
    router.navigate(`${href('/read', book.id)}?edge=${edge}`, { replace: true });
  }

  const pct = $derived(
    stage.phase === 'downloading' && stage.total
      ? stage.loaded / stage.total
      : stage.phase === 'hashing'
        ? stage.fraction
        : null,
  );
  const stageText = $derived(
    stage.phase === 'downloading'
      ? `Downloading… ${formatBytes(stage.loaded)}${stage.total ? ` of ${formatBytes(stage.total)}` : ''}`
      : stage.phase === 'hashing'
        ? 'Checking the file…'
        : stage.phase === 'reading'
          ? 'Reading details…'
          : 'Opening…',
  );
</script>

<svelte:head><title>{ready?.props.book.title ?? placeholder?.title ?? 'Reading'} · Libraria</title></svelte:head>

{#if ready}
  <ready.component {...ready.props} onlocation={(loc) => saver?.update(loc)} onback={back} onopen={openSibling} />
{:else}
  <div class="loading">
    <button class="icon-btn back" type="button" aria-label="Back" onclick={back}><Icon name="arrow-left" /></button>
    <div class="center">
      {#if placeholder}
        <div class="cover"><BookCover cover={placeholder.cover} title={placeholder.title} format={placeholder.format} eager /></div>
        <p class="title">{placeholder.title}</p>
      {/if}
      {#if failure}
        <div class="failure" role="alert">
          <Icon name={failure.reason === 'offline' ? 'wifi-off' : 'alert'} size={28} />
          <p>{failure.message}</p>
          <div class="row">
            <button class="btn" type="button" onclick={back}>Back</button>
            {#if failure.reason !== 'missing'}
              <button class="btn primary" type="button" onclick={() => location.reload()}>Try again</button>
            {/if}
            <SourceFixes bookId={params.id ?? ''} onfixed={() => location.reload()} />
          </div>
        </div>
      {:else}
        <div class="status" aria-live="polite">
          {#if pct != null}
            <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(pct * 100)}>
              <div style:width="{Math.round(pct * 100)}%"></div>
            </div>
          {:else}
            <div class="spinner"></div>
          {/if}
          <p>{stageText}</p>
        </div>
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
    gap: 14px;
    width: min(320px, 100%);
    text-align: center;
  }
  .cover {
    width: 132px;
    opacity: 0.9;
  }
  .title {
    font-weight: 600;
  }
  .status {
    display: grid;
    justify-items: center;
    gap: 10px;
    width: 100%;
    font-size: 13.5px;
    color: rgb(233 230 223 / 0.7);
  }
  .bar {
    width: 100%;
    height: 4px;
    border-radius: 2px;
    background: rgb(255 255 255 / 0.12);
    overflow: hidden;
  }
  .bar > div {
    height: 100%;
    background: #7cc4ad;
    transition: width 150ms linear;
  }
  .failure {
    display: grid;
    justify-items: center;
    gap: 12px;
    color: #f0b8a8;
  }
  .failure p {
    color: #e9e6df;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
  }
  .failure .btn:not(.primary) {
    background: transparent;
    color: #e9e6df;
    border-color: rgb(255 255 255 / 0.25);
  }
</style>
