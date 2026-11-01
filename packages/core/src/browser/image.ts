/** Tracks blob URLs so a view can revoke everything it created. */
export class BlobUrls {
  private urls = new Set<string>();

  create(blob: Blob): string {
    const url = URL.createObjectURL(blob);
    this.urls.add(url);
    return url;
  }

  revoke(url: string): void {
    if (this.urls.delete(url)) URL.revokeObjectURL(url);
  }

  revokeAll(): void {
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls.clear();
  }

  get size(): number {
    return this.urls.size;
  }
}

async function canvasToBlob(canvas: HTMLCanvasElement | OffscreenCanvas, quality: number): Promise<Blob> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type: 'image/jpeg', quality });
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', quality),
  );
}

function makeCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

/** Downscale an image to a JPEG thumbnail that fits in maxSize × (maxSize * 1.5). */
export async function createThumbnail(image: Blob, maxSize = 360, quality = 0.75): Promise<Blob> {
  const bitmap = await createImageBitmap(image);
  try {
    const scale = Math.min(maxSize / bitmap.width, (maxSize * 1.5) / bitmap.height, 1);
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = makeCanvas(w, h);
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
    ctx.drawImage(bitmap, 0, 0, w, h);
    return canvasToBlob(canvas, quality);
  } finally {
    bitmap.close();
  }
}

export { canvasToBlob, makeCanvas };
