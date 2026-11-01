import { BOOK_EXTENSIONS } from '@libraria/core';
import { importFiles, type ImportProgress, type ImportResult } from '../library/import';
import { services } from '../services';
import { isPersisted, requestPersistence } from '../storage/opfs';
import { toasts } from './toasts.svelte';

export const ACCEPT = [...BOOK_EXTENSIONS, 'application/epub+zip', 'application/pdf'].join(',');

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function summarize(r: ImportResult): { message: string; detail?: string; kind: 'success' | 'info' | 'error' } {
  const added = r.added.length + r.attached.length;
  const parts: string[] = [];
  if (added) parts.push(`Added ${plural(added, 'book')}`);
  if (r.duplicates.length) {
    const names = r.duplicates.slice(0, 3).map((d) => d.book.title);
    const more = r.duplicates.length > 3 ? ` and ${r.duplicates.length - 3} more` : '';
    parts.push(`${plural(r.duplicates.length, 'book')} already in your library: ${names.join(', ')}${more}`);
  }
  const detail = r.failed.length ? r.failed.map((f) => `${f.name}: ${f.error}`).join('\n') : undefined;
  if (r.failed.length) parts.push(`${plural(r.failed.length, 'file')} could not be imported`);
  const kind = r.failed.length && !added ? 'error' : added ? 'success' : 'info';
  return { message: parts.join('. ') || 'Nothing to import', detail, kind };
}

/** Runs imports one batch at a time and shows progress in a toast. */
class Importer {
  progress = $state<ImportProgress | null>(null);
  busy = $state(false);
  private queue: File[][] = [];
  private controller: AbortController | null = null;

  add(files: File[]): void {
    if (files.length === 0) return;
    this.queue.push(files);
    if (!this.busy) void this.drain();
  }

  cancel(): void {
    this.controller?.abort();
    this.queue = [];
  }

  private async drain(): Promise<void> {
    this.busy = true;
    const toastId = toasts.show('Importing…', { timeout: 0, progress: 0, action: { label: 'Cancel', run: () => this.cancel() } });
    try {
      while (this.queue.length) {
        const batch = this.queue.shift()!;
        this.controller = new AbortController();
        const result = await importFiles(batch, services(), {
          signal: this.controller.signal,
          onProgress: (p) => {
            this.progress = p;
            const phase = p.phase === 'hashing' ? 'Checking' : p.phase === 'copying' ? 'Copying' : 'Reading';
            toasts.update(toastId, {
              message: `${phase} ${p.name}`,
              detail: p.total > 1 ? `${p.index + 1} of ${p.total}` : undefined,
              progress: (p.index + (p.phase === 'reading' ? 0.9 : p.phase === 'copying' ? 0.5 + p.fraction * 0.4 : p.fraction * 0.5)) / p.total,
            });
          },
        });
        const s = summarize(result);
        toasts.show(s.message, { kind: s.kind, detail: s.detail, timeout: s.kind === 'error' ? 10000 : 5000 });
        // The first real import is the moment to ask the browser to keep our data.
        if (result.added.length && (await isPersisted()) === false) void requestPersistence();
      }
    } catch (err) {
      toasts.error('Import failed', err instanceof Error ? err.message : String(err));
    } finally {
      toasts.dismiss(toastId);
      this.progress = null;
      this.busy = false;
      this.controller = null;
    }
  }
}

export const importer = new Importer();

/** Open the system file picker. */
export function pickFiles(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = ACCEPT;
  input.style.display = 'none';
  input.addEventListener('change', () => {
    importer.add([...(input.files ?? [])]);
    input.remove();
  });
  input.addEventListener('cancel', () => input.remove());
  document.body.appendChild(input);
  input.click();
}

interface LaunchParams {
  files: FileSystemFileHandle[];
}

/** PWA file_handlers: files opened with the installed app arrive here. */
export function listenForLaunchFiles(): void {
  const lq = (window as Window & { launchQueue?: { setConsumer(cb: (p: LaunchParams) => void): void } }).launchQueue;
  lq?.setConsumer(async (params) => {
    if (!params.files?.length) return;
    const files = await Promise.all(params.files.map((h) => h.getFile()));
    importer.add(files);
  });
}
