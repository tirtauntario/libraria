const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const IMAGE_EXTENSIONS = /\.(jpe?g|png|gif|webp|bmp|avif)$/i;
const IGNORED_PATHS = /(?:^__MACOSX\/|\/\.|^\.|Thumbs\.db$)/i;

export function isImageFile(filename: string): boolean {
  return IMAGE_EXTENSIONS.test(filename) && !IGNORED_PATHS.test(filename);
}

export function naturalSort(a: string, b: string): number {
  return collator.compare(a, b);
}

export function imageMimeFromName(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'png': return 'image/png';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'bmp': return 'image/bmp';
    case 'avif': return 'image/avif';
    default: return 'image/jpeg';
  }
}
