/**
 * Pure view logic for the library: membership, search, filter, sort,
 * grouping and series siblings.
 */
import {
  extractSeriesName,
  groupBooks,
  groupKey,
  naturalSort,
  type BookFormat,
  type BookGroup,
  type Library,
  type LibrarySort,
  type Progress,
} from '@libraria/core';
import type { BookFileRecord, BookRecord } from '../db/schema';
import { inFolder } from './scan';

/** Ids of books that have a file in one of the library's sources/folders. */
export function bookIdsInLibrary(library: Pick<Library, 'sources'>, files: BookFileRecord[]): Set<string> {
  const ids = new Set<string>();
  for (const f of files) {
    if (library.sources.some((ref) => ref.sourceId === f.sourceId && inFolder(f.path, ref.path))) ids.add(f.bookId);
  }
  return ids;
}

export interface CatalogItem extends BookRecord {
  percent: number | null;
}

export interface CatalogQuery {
  search?: string;
  format?: BookFormat | 'all' | 'comics' | 'books';
  sort: LibrarySort;
}

function matchesFormat(format: BookFormat, filter: CatalogQuery['format']): boolean {
  if (!filter || filter === 'all') return true;
  if (filter === 'comics') return format === 'cbz' || format === 'cbr';
  if (filter === 'books') return format === 'epub' || format === 'pdf';
  return format === filter;
}

function matchesSearch(book: BookRecord, q: string): boolean {
  if (!q) return true;
  const hay = [book.title, book.series ?? '', book.customGroup ?? '', ...book.authors].join(' \u0000 ').toLocaleLowerCase();
  return q
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word));
}

export function compareBooks(sort: LibrarySort): (a: BookRecord, b: BookRecord) => number {
  const byName = (a: BookRecord, b: BookRecord) =>
    (a.series && a.series === b.series && a.seriesIndex != null && b.seriesIndex != null
      ? a.seriesIndex - b.seriesIndex
      : 0) || naturalSort(a.title, b.title);
  if (sort === 'name') return byName;
  if (sort === 'added') return (a, b) => b.addedAt - a.addedAt || byName(a, b);
  return (a, b) => (b.lastReadAt ?? 0) - (a.lastReadAt ?? 0) || b.addedAt - a.addedAt;
}

export function withProgress(books: BookRecord[], progress: Map<string, Progress>): CatalogItem[] {
  return books.map((b) => ({ ...b, percent: b.sha512 ? (progress.get(b.sha512)?.percent ?? null) : null }));
}

export function queryBooks(items: CatalogItem[], q: CatalogQuery): CatalogItem[] {
  const search = (q.search ?? '').trim();
  return items.filter((b) => matchesFormat(b.format, q.format) && matchesSearch(b, search)).sort(compareBooks(q.sort));
}

/** Group sorted items into series groups. Groups by name sort alphabetically. */
export function groupCatalog(sorted: CatalogItem[], sort: LibrarySort, renames: Record<string, string>): BookGroup<CatalogItem>[] {
  const groups = groupBooks(sorted, sort, renames);
  if (sort === 'name') groups.sort((a, b) => naturalSort(a.name, b.name));
  if (sort === 'added') {
    const newest = (g: BookGroup<CatalogItem>) => Math.max(...g.items.map((i) => i.addedAt));
    groups.sort((a, b) => newest(b) - newest(a));
  }
  // Inside a series, always read order.
  for (const g of groups) if (g.isSeries) g.items.sort(compareBooks('name'));
  return groups;
}

/** Previous/next book in the same series group, in reading order. */
export function seriesSiblings<T extends BookRecord>(book: T, all: T[]): { prev: T | null; next: T | null } {
  const key = groupKey(book);
  const series = all.filter((b) => groupKey(b) === key).sort(compareBooks('name'));
  const i = series.findIndex((b) => b.id === book.id);
  if (i < 0 || series.length < 2) return { prev: null, next: null };
  return { prev: series[i - 1] ?? null, next: series[i + 1] ?? null };
}

/** Books with progress that are not finished, most recent first. */
export function continueReading(items: CatalogItem[], limit = 12): CatalogItem[] {
  return items
    .filter((b) => b.lastReadAt && (b.percent == null || b.percent < 0.995))
    .sort((a, b) => (b.lastReadAt ?? 0) - (a.lastReadAt ?? 0))
    .slice(0, limit);
}

export { extractSeriesName, groupKey };
