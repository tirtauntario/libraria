import { BlobReader, BlobWriter, ZipReader, type FileEntry } from '@zip.js/zip.js';
import { imageMimeFromName, isImageFile, naturalSort } from '../../sort';
import type { ArchivePage, ArchiveReader } from './types';

/** ZIP reader that only inflates the pages actually requested. */
export class CbzReader implements ArchiveReader {
  private zip: ZipReader<Blob> | null = null;

  constructor(private readonly source: Blob) {}

  async getPages(): Promise<ArchivePage[]> {
    this.zip = new ZipReader(new BlobReader(this.source));
    const entries = (await this.zip.getEntries())
      .filter((e): e is FileEntry => !e.directory && isImageFile(e.filename))
      .sort((a, b) => naturalSort(a.filename, b.filename));

    return entries.map((entry, index) => ({
      filename: entry.filename,
      index,
      getData: async () => {
        const blob = await entry.getData(new BlobWriter(imageMimeFromName(entry.filename)));
        return blob;
      },
    }));
  }

  close(): void {
    void this.zip?.close();
    this.zip = null;
  }
}
