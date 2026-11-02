import { describe, expect, it } from 'vitest';
import { bookPage, chapterPages, layoutKey, locateFraction, locatePage, pageFraction, sizeFraction } from '../src/lib/readers/epub/pages';

describe('whole-book EPUB pages', () => {
  it('uses the counts when every chapter is counted', () => {
    expect(chapterPages([1, 12, 30], [100, 5000, 9000])).toEqual({ pages: [1, 12, 30], exact: true });
  });

  it('estimates uncounted chapters from the counted bytes-per-page rate', () => {
    // 1000 bytes per page from chapter 0.
    expect(chapterPages([10, null, null], [10000, 4000, 100])).toEqual({ pages: [10, 4, 1], exact: false });
  });

  it('has nothing to estimate from before the first count', () => {
    expect(chapterPages([null, null], [100, 200])).toBeNull();
  });

  it('maps chapter pages to book pages and back', () => {
    const pages = [1, 12, 30];
    expect(bookPage(pages, 0, 0)).toBe(0);
    expect(bookPage(pages, 1, 0)).toBe(1);
    expect(bookPage(pages, 2, 29)).toBe(42);
    expect(bookPage(pages, 1, 99)).toBe(12); // clamped to the chapter
    for (let n = 0; n < 43; n++) {
      const at = locatePage(pages, n);
      expect(bookPage(pages, at.spine, at.page)).toBe(n);
    }
    expect(locatePage(pages, 1000)).toEqual({ spine: 2, page: 29 });
    expect(locatePage(pages, -3)).toEqual({ spine: 0, page: 0 });
  });

  it('reads the last page as the end of the book', () => {
    expect(pageFraction(0, 43)).toBe(0);
    expect(pageFraction(42, 43)).toBe(1);
    expect(pageFraction(0, 1)).toBe(1);
  });

  it('weights chapters by size, not count', () => {
    const sizes = [100, 900, 9000];
    expect(sizeFraction(sizes, 0, 0)).toBe(0);
    expect(sizeFraction(sizes, 2, 0)).toBeCloseTo(0.1);
    expect(sizeFraction(sizes, 2, 1)).toBe(1);
    expect(locateFraction(sizes, 0.1)).toEqual({ spine: 2, progression: 0 });
    expect(locateFraction(sizes, 0.55).spine).toBe(2);
    expect(locateFraction(sizes, 0.55).progression).toBeCloseTo(0.5);
    expect(locateFraction(sizes, 1)).toEqual({ spine: 2, progression: 1 });
  });

  it('still gives empty chapters a place', () => {
    expect(sizeFraction([0, 0], 1, 0)).toBe(0.5);
  });

  it('keys layouts by their CSS', () => {
    expect(layoutKey('a{}')).toBe(layoutKey('a{}'));
    expect(layoutKey('a{}')).not.toBe(layoutKey('b{}'));
  });
});
