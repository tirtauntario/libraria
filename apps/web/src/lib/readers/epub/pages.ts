/**
 * Whole-book positions for the EPUB reader. Pure logic, unit tested.
 *
 * Pages are counted per chapter (each chapter is its own document), so the
 * book's pages are the chapters' counts laid end to end. While some chapters
 * are not counted yet, their counts are estimated from their size in bytes at
 * the bytes-per-page rate of the chapters already counted.
 */

/** Weight of one chapter by size; never zero, so empty chapters still take a sliver. */
function weight(size: number | undefined): number {
  return Math.max(1, size ?? 0);
}

/**
 * Page count of every chapter: counted where known, estimated elsewhere.
 * `exact` is true when every chapter was counted. Null until at least one
 * chapter with a size has been counted (there is no rate to estimate from).
 */
export function chapterPages(counts: readonly (number | null)[], sizes: readonly number[]): { pages: number[]; exact: boolean } | null {
  let bytes = 0;
  let counted = 0;
  let exact = true;
  for (let i = 0; i < sizes.length; i++) {
    const c = counts[i];
    if (c == null) exact = false;
    else {
      bytes += weight(sizes[i]);
      counted += c;
    }
  }
  if (exact) return { pages: sizes.map((_, i) => Math.max(1, counts[i] ?? 1)), exact };
  if (!counted) return null;
  const perPage = bytes / counted;
  return { pages: sizes.map((s, i) => Math.max(1, counts[i] ?? Math.round(weight(s) / perPage))), exact };
}

export function sum(values: readonly number[]): number {
  let t = 0;
  for (const v of values) t += v;
  return t;
}

/** 0-based page in the whole book of `page` in chapter `spine`. */
export function bookPage(pages: readonly number[], spine: number, page: number): number {
  let before = 0;
  for (let i = 0; i < spine && i < pages.length; i++) before += pages[i]!;
  return before + Math.min(Math.max(0, page), Math.max(0, (pages[spine] ?? 1) - 1));
}

/** Chapter and page in it of a 0-based page in the whole book. */
export function locatePage(pages: readonly number[], n: number): { spine: number; page: number } {
  let rest = Math.max(0, Math.floor(n));
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i]!;
    if (rest < p) return { spine: i, page: rest };
    rest -= p;
  }
  const last = Math.max(0, pages.length - 1);
  return { spine: last, page: Math.max(0, (pages[last] ?? 1) - 1) };
}

/** Fraction read (0..1) at a 0-based page of `total`: the last page is the end. */
export function pageFraction(n: number, total: number): number {
  return total > 1 ? Math.min(1, Math.max(0, n / (total - 1))) : 1;
}

/** Position in the whole book (0..1) with chapters weighted by size. */
export function sizeFraction(sizes: readonly number[], spine: number, progression: number): number {
  const total = sum(sizes.map(weight));
  if (!total) return 0;
  let before = 0;
  for (let i = 0; i < spine && i < sizes.length; i++) before += weight(sizes[i]);
  const own = weight(sizes[spine]);
  return Math.min(1, Math.max(0, (before + own * Math.min(1, Math.max(0, progression))) / total));
}

/** Inverse of sizeFraction: chapter and progression (0..1) inside it. */
export function locateFraction(sizes: readonly number[], fraction: number): { spine: number; progression: number } {
  const total = sum(sizes.map(weight));
  let rest = Math.min(1, Math.max(0, fraction)) * total;
  for (let i = 0; i < sizes.length; i++) {
    const w = weight(sizes[i]);
    if (rest < w || i === sizes.length - 1) return { spine: i, progression: Math.min(1, rest / w) };
    rest -= w;
  }
  return { spine: 0, progression: 0 };
}

/** Short, stable key for a layout (the reader CSS, which includes the frame size). FNV-1a. */
export function layoutKey(css: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < css.length; i++) {
    h ^= css.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(36)}.${css.length.toString(36)}`;
}
