import type { Locator } from '@libraria/core';
import type { BookRecord } from '../db/schema';
import type { BookmarkList } from './bookmarks.svelte';

export type Panel = 'toc' | 'bookmarks' | 'settings' | null;

export interface PageCache {
  get(layout: string): Promise<number[] | null>;
  put(layout: string, counts: number[]): Promise<void>;
}

/** Props every reader component receives from the reader page. */
export interface ReaderProps {
  /** Always hashed by the time a reader opens (sha512 is set). */
  book: BookRecord;
  blob: Blob;
  /** Where to start: saved progress, a bookmark, or an explicit page. */
  initial: Locator | null;
  /** 'start' or 'end' when arriving from the previous/next book in a series. */
  edge: 'start' | 'end' | null;
  bookmarks: BookmarkList;
  siblings: { prev: BookRecord | null; next: BookRecord | null };
  /** Device-only store for EPUB page counts per layout. Absent when nothing may be stored. */
  pageCache?: PageCache;
  /** Report the current position (debounced and saved by the page). */
  onlocation: (loc: Locator) => void;
  onback: () => void;
  /** Open another book of the series (chapter navigation). */
  onopen: (book: BookRecord, edge: 'start' | 'end') => void;
}
