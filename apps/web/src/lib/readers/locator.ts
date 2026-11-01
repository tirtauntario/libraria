/**
 * Reading positions and debounced progress saving. Pure logic, unit tested.
 */
import type { Locator } from '@libraria/core';

export const SAVE_DEBOUNCE_MS = 500;

export function pageLocator(page: number, total: number): Locator {
  const t = Math.max(1, total);
  return { type: 'page', page: Math.min(Math.max(0, Math.round(page)), t - 1), total: t };
}

/** Page to open for a page-based book. */
export function resumePage(loc: Locator | null | undefined, total: number): number {
  if (!loc || total <= 0) return 0;
  if (loc.type === 'page') {
    // Same book, so totals normally match; if not, keep the relative position.
    const page = loc.total === total || loc.total <= 1 ? loc.page : Math.round((loc.page / (loc.total - 1)) * (total - 1));
    return Math.min(Math.max(0, page), total - 1);
  }
  return 0;
}

/**
 * EPUB position: spine index + progression (0..1) of the page start inside
 * the chapter. Survives font, size and screen changes.
 */
export function epubLocator(spine: number, page: number, pages: number, spineTotal: number, label?: string): Locator {
  const progression = pages > 1 ? Math.min(1, Math.max(0, page / pages)) : 0;
  return { type: 'epub', spine, progression, total: spineTotal, ...(label ? { label } : {}) };
}

/** Page inside a chapter that shows `progression`, after a relayout to `pages` pages. */
export function pageFromProgression(progression: number, pages: number): number {
  if (pages <= 1) return 0;
  return Math.min(pages - 1, Math.max(0, Math.round(progression * pages)));
}

/** Position used for bookmark matching: is the reader "at" this bookmark? */
export function samePosition(a: Locator, b: Locator, pages = 1): boolean {
  if (a.type === 'page' && b.type === 'page') return a.page === b.page;
  if (a.type === 'epub' && b.type === 'epub') {
    return a.spine === b.spine && pageFromProgression(a.progression, pages) === pageFromProgression(b.progression, pages);
  }
  return false;
}

export function locatorKey(l: Locator): string {
  return l.type === 'page' ? `p:${l.page}/${l.total}` : `e:${l.spine}:${l.progression.toFixed(5)}/${l.total}`;
}

export interface ProgressSaver {
  update(loc: Locator): void;
  /** Save a pending position now. */
  flush(): Promise<void>;
  cancel(): void;
}

/** Debounce saves; skip saving a position equal to the last saved one. */
export function createProgressSaver(
  save: (loc: Locator) => Promise<unknown>,
  delay = SAVE_DEBOUNCE_MS,
  timers: { set: typeof setTimeout; clear: typeof clearTimeout } = { set: setTimeout, clear: clearTimeout },
): ProgressSaver {
  let pending: Locator | null = null;
  let lastKey: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const run = async () => {
    timer = null;
    const loc = pending;
    pending = null;
    if (!loc) return;
    const key = locatorKey(loc);
    if (key === lastKey) return;
    lastKey = key;
    await save(loc);
  };

  return {
    update(loc) {
      pending = loc;
      if (timer) timers.clear(timer);
      timer = timers.set(() => void run(), delay);
    },
    async flush() {
      if (timer) timers.clear(timer);
      await run();
    },
    cancel() {
      if (timer) timers.clear(timer);
      timer = null;
      pending = null;
    },
  };
}
