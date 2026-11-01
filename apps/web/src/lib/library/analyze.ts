/**
 * Metadata + cover thumbnail for a book file. Runs fully in the client.
 */
import { extractBook, type BookFormat, type BookMeta } from '@libraria/core';

export interface Analysis {
  format: BookFormat;
  meta: BookMeta;
  /** JPEG thumbnail, or null if none could be made. */
  cover: Blob | null;
}

export type Analyzer = (blob: Blob, filename: string) => Promise<Analysis>;

const THUMB_SIZE = 360;

/** Default analyzer: core extractBook, then a format-specific cover. */
export const analyzeBook: Analyzer = async (blob, filename) => {
  const extracted = await extractBook(blob, filename);
  const meta = { ...extracted.meta };
  let cover: Blob | null = null;
  try {
    const browser = await import('@libraria/core/browser');
    switch (extracted.format) {
      case 'cbz':
        if (extracted.cover) cover = await browser.createThumbnail(extracted.cover.data, THUMB_SIZE);
        break;
      case 'epub': {
        let raw = extracted.cover?.data ?? null;
        if (!raw) {
          const book = await browser.EpubBook.open(blob);
          try {
            raw = await book.cover();
          } finally {
            book.close();
          }
        }
        if (raw) cover = await browser.createThumbnail(raw, THUMB_SIZE);
        break;
      }
      case 'cbr': {
        // RAR has no random access: this unpacks the archive once, at import.
        const reader = await browser.openComic('cbr', blob);
        try {
          const pages = await reader.getPages();
          meta.pageCount = pages.length;
          if (pages[0]) cover = await browser.createThumbnail(await pages[0].getData(), THUMB_SIZE);
        } finally {
          reader.close();
        }
        break;
      }
      case 'pdf': {
        const pdf = await browser.PdfDocument.open(blob);
        try {
          meta.pageCount = pdf.pageCount;
          cover = await pdf.renderThumbnail(0, THUMB_SIZE);
          const info = (await pdf.doc.getMetadata().catch(() => null))?.info as Record<string, unknown> | undefined;
          const title = typeof info?.Title === 'string' ? info.Title.trim() : '';
          const author = typeof info?.Author === 'string' ? info.Author.trim() : '';
          if (title && title.length < 300) meta.title = title;
          if (author && meta.authors.length === 0) meta.authors = [author.slice(0, 200)];
        } finally {
          pdf.close();
        }
        break;
      }
    }
  } catch {
    // No cover (or no DOM, in tests). The book still imports.
  }
  return { format: extracted.format, meta, cover };
};
