import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { canvasToBlob, makeCanvas } from './image';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export interface PdfOutlineItem {
  title: string;
  /** 0-based page index, or null if the destination could not be resolved. */
  page: number | null;
  items: PdfOutlineItem[];
}

export class PdfDocument {
  private constructor(
    private readonly task: PDFDocumentLoadingTask,
    readonly doc: PDFDocumentProxy,
  ) {}

  static async open(source: Blob): Promise<PdfDocument> {
    // pdf.js transfers the buffer to its worker, so hand it a fresh copy.
    const data = new Uint8Array(await source.arrayBuffer());
    const task = pdfjs.getDocument({ data });
    return new PdfDocument(task, await task.promise);
  }

  get pageCount(): number {
    return this.doc.numPages;
  }

  /** pageIndex is 0-based. */
  getPage(pageIndex: number): Promise<PDFPageProxy> {
    return this.doc.getPage(pageIndex + 1);
  }

  /** Outline (bookmarks) with 0-based page indexes, nested items resolved too. */
  async getOutline(): Promise<PdfOutlineItem[]> {
    const outline = await this.doc.getOutline();
    if (!outline) return [];
    const resolve = async (dest: unknown): Promise<number | null> => {
      try {
        const explicit = typeof dest === 'string' ? await this.doc.getDestination(dest) : dest;
        if (!Array.isArray(explicit) || explicit[0] == null) return null;
        // A destination names its page by reference, or (rarely) by index.
        if (typeof explicit[0] === 'number') return explicit[0];
        return await this.doc.getPageIndex(explicit[0]);
      } catch {
        return null;
      }
    };
    type Node = { title: string; dest: unknown; items?: Node[] };
    const walk = (nodes: Node[], depth: number): Promise<PdfOutlineItem[]> =>
      Promise.all(
        nodes.map(async (o) => ({
          title: o.title,
          page: await resolve(o.dest),
          items: depth < 8 && o.items?.length ? await walk(o.items, depth + 1) : [],
        })),
      );
    return walk(outline as Node[], 0);
  }

  async renderThumbnail(pageIndex = 0, maxSize = 360): Promise<Blob> {
    const page = await this.getPage(pageIndex);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(maxSize / base.width, (maxSize * 1.5) / base.height, 2);
    const viewport = page.getViewport({ scale });
    const canvas = makeCanvas(Math.round(viewport.width), Math.round(viewport.height));
    await page.render({ canvas: canvas as HTMLCanvasElement, viewport }).promise;
    return canvasToBlob(canvas, 0.75);
  }

  close(): void {
    void this.task.destroy();
  }
}

export { pdfjs };
export type { PDFDocumentProxy, PDFPageProxy };
