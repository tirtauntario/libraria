/**
 * CSS injected into EPUB chapter documents (last, so it wins over the
 * publisher's styles where it has to). Pure function of the reader settings
 * and the viewport size; regenerated on resize.
 */
import type { BookFont, BookTheme, SyncedSettings } from '@libraria/core';

export const BOOK_THEMES: Record<BookTheme, { bg: string; fg: string; link: string; muted: string; scheme: 'light' | 'dark' }> = {
  light: { bg: '#fbfaf7', fg: '#1f1d1a', link: '#24584b', muted: '#6f6a62', scheme: 'light' },
  sepia: { bg: '#f4ecd8', fg: '#3b2f22', link: '#7a4b16', muted: '#7a6a55', scheme: 'light' },
  dark: { bg: '#161817', fg: '#d8d4cc', link: '#8fd0bb', muted: '#8f8a82', scheme: 'dark' },
};

export const BOOK_FONTS: Record<BookFont, { label: string; stack: string | null }> = {
  publisher: { label: 'Original', stack: null },
  serif: { label: 'Serif', stack: "'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif" },
  sans: { label: 'Sans', stack: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" },
  dyslexic: { label: 'Readable', stack: "OpenDyslexic, 'Atkinson Hyperlegible', Verdana, 'Comic Sans MS', sans-serif" },
  mono: { label: 'Mono', stack: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace" },
};

export const FONT_SIZE = { min: 70, max: 220, step: 10 };
export const LINE_HEIGHT = { min: 1.1, max: 2.2, step: 0.1 };
export const MARGIN = { min: 0, max: 20, step: 1 };
export const WORD_SPACING = { min: 0, max: 0.5, step: 0.05 };

export function columnsPerPage(width: number): number {
  return width >= 1000 ? 2 : 1;
}

export interface PageGeometry {
  /** Horizontal padding (px) on each side of the text column. */
  padX: number;
  /** Vertical padding (px). */
  padY: number;
}

export function pageGeometry(book: SyncedSettings['book'], width: number, height: number): PageGeometry {
  const padX = Math.max(14, Math.round((width * Math.min(MARGIN.max, Math.max(0, book.margin))) / 100));
  const padY = Math.round(Math.min(56, Math.max(20, height * 0.05)));
  return { padX, padY };
}

export function readerCss(
  book: SyncedSettings['book'],
  opts: { paginated: boolean; width: number; height: number },
): string {
  const theme = BOOK_THEMES[book.theme] ?? BOOK_THEMES.light;
  const font = BOOK_FONTS[book.font]?.stack ?? null;
  const { padX, padY } = pageGeometry(book, opts.width, opts.height);
  // Two text columns per page on wide screens keep lines a readable length.
  // Page stride must equal the frame width: n × (column + gap) = width, gap = 2 × padX.
  const perPage = opts.paginated ? columnsPerPage(opts.width) : 1;
  const colW = Math.max(100, Math.floor(opts.width / perPage) - padX * 2);
  const textH = Math.max(100, opts.height - padY * 2);
  const css: string[] = [];

  css.push(`:root { color-scheme: ${theme.scheme}; }`);
  css.push(
    `html { background: ${theme.bg} !important; color: ${theme.fg} !important; font-size: ${book.fontSize}% !important;` +
      ` -webkit-text-size-adjust: none; text-size-adjust: none; }`,
  );
  css.push(`body { background: transparent !important; color: inherit !important; line-height: ${book.lineHeight} !important; }`);
  css.push(`p, li, blockquote, dd, dt, td, th, figcaption, div { line-height: inherit !important; }`);
  // Publisher colours often assume white paper; keep text readable on every theme.
  if (book.theme !== 'light') {
    css.push(`body *:not(a) { color: inherit !important; background-color: transparent !important; border-color: ${theme.muted} !important; }`);
  }
  css.push(`a, a * { color: ${theme.link} !important; }`);
  if (font) css.push(`body, body *:not(code):not(pre):not(kbd):not(samp) { font-family: ${font} !important; }`);
  if (book.wordSpacing > 0) css.push(`body { word-spacing: ${book.wordSpacing}em !important; }`);
  if (book.justify) css.push(`p, li { text-align: justify !important; -webkit-hyphens: auto; hyphens: auto; }`);
  css.push(`::selection { background: ${theme.link}44; }`);
  css.push(`img, svg, video { height: auto; }`);

  if (opts.paginated) {
    css.push(`html { height: 100% !important; overflow: hidden !important; }`);
    css.push(
      `body { margin: 0 !important; box-sizing: border-box !important; height: ${opts.height}px !important;` +
        ` max-width: none !important; padding: ${padY}px ${padX}px !important;` +
        ` column-width: ${colW}px !important; column-gap: ${padX * 2}px !important; column-fill: auto !important;` +
        ` overflow: visible !important; overflow-wrap: break-word; }`,
    );
    css.push(
      `img, svg, video, table { max-width: ${colW}px !important; max-height: ${textH}px !important; object-fit: contain; break-inside: avoid; }`,
    );
    css.push(`h1, h2, h3, h4 { break-after: avoid; }`);
  } else {
    css.push(`html { overflow-y: auto !important; overflow-x: hidden !important; }`);
    css.push(
      `body { margin: 0 auto !important; box-sizing: border-box !important; max-width: ${Math.min(opts.width, Math.round((720 * book.fontSize) / 100) + padX * 2)}px !important;` +
        ` padding: ${padY + 40}px ${padX}px ${padY + 80}px !important; overflow-wrap: break-word; }`,
    );
    css.push(`img, svg, video, table { max-width: 100% !important; }`);
  }
  return css.join('\n');
}

/** Number of pages in a paginated chapter. */
export function countPages(scrollWidth: number, pageWidth: number): number {
  if (pageWidth <= 0) return 1;
  return Math.max(1, Math.ceil(scrollWidth / pageWidth - 0.01));
}
