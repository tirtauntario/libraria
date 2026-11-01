import type { ComicFormat } from '../../format';
import type { ArchiveReader } from './types';

export async function openComic(format: ComicFormat, source: Blob): Promise<ArchiveReader> {
  if (format === 'cbz') {
    const { CbzReader } = await import('./cbz-reader');
    return new CbzReader(source);
  }
  const { CbrReader } = await import('./cbr-reader');
  return new CbrReader(source);
}

export type { ArchivePage, ArchiveReader } from './types';
