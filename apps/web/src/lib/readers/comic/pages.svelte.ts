/**
 * Page images of an open comic: lazy loading with a concurrency limit,
 * natural sizes, and blob-URL hygiene (only pages in the wanted window keep
 * a URL; everything else is revoked).
 */
import { BlobUrls, type ArchivePage } from '@libraria/core/browser';
import { SvelteMap } from 'svelte/reactivity';

export interface PageSize {
  w: number;
  h: number;
}

const CONCURRENCY = 3;

export class ComicPages {
  readonly urls = new SvelteMap<number, string>();
  readonly sizes = new SvelteMap<number, PageSize>();
  private readonly blobUrls = new BlobUrls();
  private readonly inflight = new Map<number, Promise<void>>();
  private wanted = new Set<number>();
  private queue: number[] = [];
  private active = 0;
  private destroyed = false;

  constructor(private readonly pages: ArchivePage[]) {}

  get count(): number {
    return this.pages.length;
  }

  /** Typical aspect ratio (w/h), used for pages not loaded yet. */
  get typicalAspect(): number {
    for (const s of this.sizes.values()) if (s.h > 0 && s.w <= s.h * 1.2) return s.w / s.h;
    return 2 / 3;
  }

  aspect(i: number): number {
    const s = this.sizes.get(i);
    return s && s.h > 0 ? s.w / s.h : this.typicalAspect;
  }

  /**
   * Keep exactly these pages loaded. `order` gives load priority
   * (closest to the current page first).
   */
  want(order: number[]): void {
    const valid = order.filter((i) => i >= 0 && i < this.pages.length);
    this.wanted = new Set(valid);
    for (const [i, url] of this.urls) {
      if (!this.wanted.has(i)) {
        this.blobUrls.revoke(url);
        this.urls.delete(i);
      }
    }
    this.queue = valid.filter((i) => !this.urls.has(i) && !this.inflight.has(i));
    this.pump();
  }

  private pump(): void {
    while (this.active < CONCURRENCY && this.queue.length) {
      const i = this.queue.shift()!;
      if (this.urls.has(i) || this.inflight.has(i) || !this.wanted.has(i)) continue;
      this.active++;
      const p = this.load(i).finally(() => {
        this.active--;
        this.inflight.delete(i);
        this.pump();
      });
      this.inflight.set(i, p);
    }
  }

  private async load(i: number): Promise<void> {
    try {
      const blob = await this.pages[i]!.getData();
      if (this.destroyed || !this.wanted.has(i)) return;
      const url = this.blobUrls.create(blob);
      if (!this.sizes.has(i)) {
        const img = new Image();
        img.src = url;
        try {
          await img.decode();
          this.sizes.set(i, { w: img.naturalWidth, h: img.naturalHeight });
        } catch {
          // Undecodable page: show the broken image rather than nothing.
        }
      }
      // Re-check: the reader may have moved on while we decoded.
      if (this.destroyed || !this.wanted.has(i)) {
        this.blobUrls.revoke(url);
        return;
      }
      this.urls.set(i, url);
    } catch (err) {
      console.warn(`Page ${i + 1} failed to load`, err);
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.queue = [];
    this.blobUrls.revokeAll();
    this.urls.clear();
  }
}

/** Load order expanding from the current page: [c, c+1, c-1, c+2, ...], more ahead than behind. */
export function windowOrder(current: number, behind: number, ahead: number): number[] {
  const out = [current];
  for (let d = 1; d <= Math.max(behind, ahead); d++) {
    if (d <= ahead) out.push(current + d);
    if (d <= behind) out.push(current - d);
  }
  return out;
}

/** Spreads for two-page mode: the cover alone, then pairs. Returns the first page of each spread. */
export function spreadStart(page: number): number {
  if (page <= 0) return 0;
  return page % 2 === 1 ? page : page - 1;
}

export function spreadPages(start: number, count: number): number[] {
  if (start === 0) return [0];
  return start + 1 < count ? [start, start + 1] : [start];
}
