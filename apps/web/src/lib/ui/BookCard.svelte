<script lang="ts">
  import type { CatalogItem } from '../library/catalog';
  import { href } from '../router.svelte';
  import BookCover from './BookCover.svelte';
  import Icon from './Icon.svelte';
  import { formatPercent } from './format';

  let { book, remote = false, eager = false }: { book: CatalogItem; remote?: boolean; eager?: boolean } = $props();
  const subtitle = $derived(book.authors[0] ?? book.series ?? '');
  const finished = $derived(book.percent != null && book.percent >= 0.995);
</script>

<article class="card-book">
  <a class="open" href={href('/read', book.id)} aria-label="Read {book.title}">
    <div class="cover-wrap">
      <BookCover cover={book.cover} title={book.title} format={book.format} {eager} />
      {#if remote}
        <span class="badge" title="Not downloaded to this device"><Icon name="cloud" size={14} /></span>
      {/if}
      {#if book.percent != null && book.percent > 0}
        <div class="progress" class:finished aria-hidden="true">
          <div style:width={formatPercent(book.percent)}></div>
        </div>
      {/if}
    </div>
  </a>
  <div class="meta">
    <a class="title" href={href('/book', book.id)} title={book.title}>{book.title}</a>
    <div class="sub">
      <span class="who">{subtitle}</span>
      {#if finished}
        <span class="pct done">Finished</span>
      {:else if book.percent != null && book.percent > 0}
        <span class="pct">{formatPercent(book.percent)}</span>
      {/if}
    </div>
  </div>
</article>

<style>
  .card-book {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
  }
  .open {
    display: block;
    border-radius: 6px;
  }
  .cover-wrap {
    position: relative;
    transition: transform 200ms var(--ease);
  }
  @media (hover: hover) {
    .open:hover .cover-wrap {
      transform: translateY(-3px);
    }
  }
  .badge {
    position: absolute;
    top: 6px;
    right: 6px;
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border-radius: 999px;
    background: rgb(0 0 0 / 0.55);
    color: #fff;
  }
  .progress {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 4px;
    background: rgb(0 0 0 / 0.25);
    border-radius: 0 0 6px 6px;
    overflow: hidden;
  }
  .progress > div {
    height: 100%;
    background: var(--accent);
    transition: width 300ms var(--ease);
  }
  .progress.finished > div {
    background: var(--success);
  }
  .meta {
    min-width: 0;
    padding: 0 2px;
  }
  .title {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    color: var(--text);
    font-size: 14px;
    font-weight: 600;
    line-height: 1.3;
    overflow-wrap: anywhere;
  }
  .sub {
    display: flex;
    gap: 6px;
    margin-top: 3px;
    font-size: 12.5px;
    color: var(--text-3);
  }
  .who {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pct {
    flex: none;
    font-variant-numeric: tabular-nums;
  }
  .pct.done {
    color: var(--success);
  }
</style>
