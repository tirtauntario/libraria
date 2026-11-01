import { locatorPercent, type Locator } from '@libraria/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createProgressSaver,
  epubLocator,
  pageFromProgression,
  pageLocator,
  resumePage,
  samePosition,
} from '../src/lib/readers/locator';
import { countPages, readerCss } from '../src/lib/readers/epub/style';
import { DEFAULT_SYNCED_SETTINGS } from '@libraria/core';

describe('page locators', () => {
  it('clamps pages and computes percent', () => {
    expect(pageLocator(-1, 10)).toEqual({ type: 'page', page: 0, total: 10 });
    expect(pageLocator(99, 10)).toEqual({ type: 'page', page: 9, total: 10 });
    expect(locatorPercent(pageLocator(9, 10))).toBe(1);
    expect(locatorPercent(pageLocator(0, 1))).toBe(1);
  });

  it('resumes at the saved page, scaled if the page count changed', () => {
    expect(resumePage(null, 10)).toBe(0);
    expect(resumePage(pageLocator(4, 10), 10)).toBe(4);
    expect(resumePage(pageLocator(9, 10), 19)).toBe(18);
    expect(resumePage(pageLocator(50, 100), 3)).toBe(1);
    expect(resumePage({ type: 'epub', spine: 1, progression: 0.5, total: 3 }, 10)).toBe(0);
  });
});

describe('epub locators', () => {
  it('round-trips page ↔ progression for the same layout', () => {
    for (const pages of [1, 2, 7, 31]) {
      for (let p = 0; p < pages; p++) {
        const loc = epubLocator(2, p, pages, 5);
        expect(loc.type === 'epub' && pageFromProgression(loc.progression, pages)).toBe(p);
      }
    }
  });

  it('maps to the nearest page after a relayout', () => {
    const loc = epubLocator(0, 5, 10, 3) as Extract<Locator, { type: 'epub' }>;
    expect(loc.progression).toBe(0.5);
    expect(pageFromProgression(loc.progression, 20)).toBe(10);
    expect(pageFromProgression(loc.progression, 3)).toBe(2);
    expect(pageFromProgression(0.999, 4)).toBe(3);
    expect(locatorPercent(loc)).toBeCloseTo(0.5 / 3);
  });

  it('matches bookmarks at the same position', () => {
    expect(samePosition(pageLocator(3, 9), pageLocator(3, 9))).toBe(true);
    expect(samePosition(pageLocator(3, 9), pageLocator(4, 9))).toBe(false);
    const a = epubLocator(1, 2, 10, 4);
    const b = epubLocator(1, 2, 10, 4);
    expect(samePosition(a, b, 10)).toBe(true);
    expect(samePosition(a, epubLocator(1, 3, 10, 4), 10)).toBe(false);
    expect(samePosition(a, epubLocator(2, 2, 10, 4), 10)).toBe(false);
  });
});

describe('progress saver', () => {
  afterEach(() => vi.useRealTimers());

  it('debounces, skips duplicates and flushes', async () => {
    vi.useFakeTimers();
    const saved: Locator[] = [];
    const saver = createProgressSaver(async (l) => void saved.push(l), 500);
    saver.update(pageLocator(1, 10));
    saver.update(pageLocator(2, 10));
    await vi.advanceTimersByTimeAsync(499);
    expect(saved).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(saved).toEqual([pageLocator(2, 10)]);

    saver.update(pageLocator(2, 10)); // same position: not saved again
    await vi.advanceTimersByTimeAsync(600);
    expect(saved).toHaveLength(1);

    saver.update(pageLocator(3, 10));
    await saver.flush();
    expect(saved.at(-1)).toEqual(pageLocator(3, 10));

    saver.update(pageLocator(4, 10));
    saver.cancel();
    await vi.advanceTimersByTimeAsync(600);
    expect(saved).toHaveLength(2);
  });
});

describe('epub page geometry', () => {
  it('counts pages from the scroll width', () => {
    expect(countPages(1000, 1000)).toBe(1);
    expect(countPages(2936, 1000)).toBe(3); // last column gap not included
    expect(countPages(3000, 1000)).toBe(3);
    expect(countPages(0, 1000)).toBe(1);
  });

  it('builds paginated CSS whose page stride equals the frame width', () => {
    const book = { ...DEFAULT_SYNCED_SETTINGS.book, margin: 5 };
    const narrow = readerCss(book, { paginated: true, width: 400, height: 800 });
    expect(narrow).toContain('column-width: 360px'); // 400 - 2 × 20
    expect(narrow).toContain('column-gap: 40px');
    const wide = readerCss(book, { paginated: true, width: 1200, height: 800 });
    // two columns per page: 2 × (column + gap) = 1200
    expect(wide).toContain('column-width: 480px');
    expect(wide).toContain('column-gap: 120px');
    const scrolled = readerCss({ ...book, theme: 'dark', font: 'serif', justify: true }, { paginated: false, width: 400, height: 800 });
    expect(scrolled).not.toContain('column-width');
    expect(scrolled).toContain('#161817');
    expect(scrolled).toContain('text-align: justify');
    expect(scrolled).toContain('Iowan Old Style');
  });
});
