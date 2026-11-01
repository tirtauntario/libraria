import { imageMimeFromName, isImageFile, naturalSort } from '../../sort';
import type { ArchivePage, ArchiveReader } from './types';

/** RAR reader. RAR needs sequential extraction, so all pages unpack up front in a worker. */
export class CbrReader implements ArchiveReader {
  private pages: ArchivePage[] | null = null;
  private worker: Worker | null = null;

  constructor(private readonly source: Blob) {}

  async getPages(): Promise<ArchivePage[]> {
    if (this.pages) return this.pages;
    const buffer = await this.source.arrayBuffer();

    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./unrar-worker.ts', import.meta.url), { type: 'module' });
      this.worker = worker;
      const { port1: hostPort, port2: implPort } = new MessageChannel();
      worker.postMessage(null, [implPort]);

      const files: { filename: string; blob: Blob }[] = [];

      const fail = (message: string) => {
        hostPort.close();
        this.terminate();
        reject(new Error(message));
      };

      worker.onerror = (e) => fail(`RAR worker error: ${e.message}`);

      hostPort.onmessage = (evt: MessageEvent) => {
        const data = evt.data;
        if (typeof data === 'string') return; // log line
        switch (data.type) {
          case 'extract': {
            const entry = data.unarchivedFile as { filename: string; fileData: Uint8Array<ArrayBuffer> } | undefined;
            if (entry && isImageFile(entry.filename)) {
              files.push({
                filename: entry.filename,
                blob: new Blob([entry.fileData], { type: imageMimeFromName(entry.filename) }),
              });
            }
            break;
          }
          case 'finish':
            hostPort.close();
            this.terminate();
            files.sort((a, b) => naturalSort(a.filename, b.filename));
            this.pages = files.map((f, index) => ({
              filename: f.filename,
              index,
              getData: () => Promise.resolve(f.blob),
            }));
            resolve(this.pages);
            break;
          case 'error':
            fail(`RAR extraction failed: ${data.msg || 'unknown error'}`);
            break;
        }
      };

      hostPort.postMessage({ file: buffer, logToConsole: false }, [buffer]);
    });
  }

  private terminate(): void {
    if (this.worker) {
      this.worker.postMessage({ disconnect: true });
      this.worker.terminate();
      this.worker = null;
    }
  }

  close(): void {
    this.terminate();
    this.pages = null;
  }
}
