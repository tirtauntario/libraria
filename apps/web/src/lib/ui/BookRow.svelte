<script lang="ts">
  import type { CatalogItem } from '../library/catalog';
  import { href } from '../router.svelte';
  import BookCover from './BookCover.svelte';
  import Icon from './Icon.svelte';
  import { FORMAT_LABEL, formatBytes, formatPercent, formatRelative } from './format';

  let { book, remote = false }: { book: CatalogItem; remote?: boolean } = $props();
</script>

<article class="row">
  <a class="cover" href={href('/read', book.id)} aria-label="Read {book.title}" tabindex="-1">
    <BookCover cover={book.cover} title={book.title} format={book.format} />
  </a>
  <div class="info">
    <a class="title" href={href('/read', book.id)}>{book.title}</a>
    <p class="sub">
      {[book.authors.join(', '), book.series].filter(Boolean).join(' · ') || FORMAT_LABEL[book.format]}
    </p>
    <div class="line">
      {#if book.percent != null && book.percent > 0}
        <div class="bar" aria-hidden="true"><div style:width={formatPercent(book.percent)}></div></div>
        <span>{formatPercent(book.percent)}</span>
      {:else}
        <span>{book.lastReadAt ? formatRelative(book.lastReadAt) : 'Not started'}</span>
      {/if}
      <span class="dot">·</span>
      <span>{FORMAT_LABEL[book.format]}</span>
      {#if book.fileSize}<span class="dot">·</span><span>{formatBytes(book.fileSize)}</span>{/if}
      {#if remote}<span class="dot">·</span><Icon name="cloud" size={14} label="Not downloaded" />{/if}
    </div>
  </div>
  <a class="icon-btn" href={href('/book', book.id)} aria-label="Details for {book.title}">
    <Icon name="info" />
  </a>
</article>

<style>
  .row {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 10px 8px;
    border-radius: var(--radius);
    transition: background-color var(--dur) var(--ease);
  }
  .row:hover {
    background: var(--surface-2);
  }
  .cover {
    flex: none;
    width: 48px;
  }
  .info {
    flex: 1;
    min-width: 0;
  }
  .title {
    display: block;
    color: var(--text);
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sub {
    font-size: 13px;
    color: var(--text-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .line {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
    font-size: 12px;
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }
  .bar {
    width: 72px;
    height: 4px;
    border-radius: 2px;
    background: var(--surface-3);
    overflow: hidden;
  }
  .bar > div {
    height: 100%;
    background: var(--accent);
  }
  .icon-btn {
    color: var(--text-3);
  }
</style>
