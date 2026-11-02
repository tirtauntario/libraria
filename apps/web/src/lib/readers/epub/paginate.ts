import type { EpubBook } from '@libraria/core/browser';
import { countPages } from './style';

/** Wait for fonts and images, which change the layout. */
export async function settled(doc: Document, capMs = 1500): Promise<void> {
  const imgs = Array.from(doc.images).filter((i) => !i.complete);
  const wait = Promise.all([
    doc.fonts?.ready.catch(() => {}),
    ...imgs.map((i) => new Promise((r) => ((i.onload = r), (i.onerror = r)))),
  ]);
  await Promise.race([wait, new Promise((r) => setTimeout(r, capMs))]);
  await new Promise((r) => requestAnimationFrame(() => r(null)));
}

function idle(): Promise<void> {
  return new Promise((r) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => r(), { timeout: 500 });
    else setTimeout(r, 16);
  });
}

export interface CountOptions {
  book: EpubBook;
  /** The reader CSS of the layout being counted. */
  css: string;
  /** Size of the reading frame, in CSS pixels. */
  width: number;
  height: number;
  /** Chapters whose count is already known: skipped. */
  known: (index: number) => boolean;
  onCount: (index: number, pages: number) => void;
  signal: AbortSignal;
}

/**
 * Count the pages of every chapter for one layout by laying each out in a
 * hidden frame of the reading frame's size: same sandbox (no scripts), same
 * CSS, same `countPages`, so the counts match what the reader shows. One
 * chapter at a time in idle periods, so reading stays smooth.
 */
export async function countChapterPages(opts: CountOptions): Promise<void> {
  const { book, css, width, height, signal } = opts;
  const f = document.createElement('iframe');
  f.title = 'Page count';
  f.setAttribute('sandbox', 'allow-same-origin');
  f.setAttribute('referrerpolicy', 'no-referrer');
  f.setAttribute('aria-hidden', 'true');
  f.tabIndex = -1;
  f.inert = true;
  Object.assign(f.style, {
    position: 'fixed',
    left: '-100000px',
    top: '0',
    width: `${width}px`,
    height: `${height}px`,
    border: '0',
    visibility: 'hidden',
    pointerEvents: 'none',
  });
  document.body.append(f);
  try {
    for (let i = 0; i < book.spineLength; i++) {
      if (signal.aborted) return;
      if (opts.known(i)) continue;
      await idle();
      if (signal.aborted) return;
      // An unreadable chapter shows as a one-page error.
      let pages = 1;
      try {
        const html = await book.chapterDocument(i, css);
        if (signal.aborted) return;
        await new Promise<void>((resolve) => {
          f.onload = () => resolve();
          f.srcdoc = html;
        });
        const doc = f.contentDocument;
        if (doc?.body) {
          await settled(doc, 800);
          pages = countPages(doc.body.scrollWidth, doc.documentElement.clientWidth || width);
        }
      } catch {
        // keep one page
      }
      if (signal.aborted) return;
      opts.onCount(i, pages);
    }
  } finally {
    f.remove();
  }
}
