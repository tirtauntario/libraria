/**
 * Background scanning of sources, with progress and per-source problems
 * ("Grant access", "Sign in again", CORS) for the UI.
 *
 * - `scanner.scan(source)` scans the folders libraries use (scanRoots).
 * - `scanner.scanLibrary(lib)` scans every source of a library.
 * - `scanner.autoRescan()` runs on app start when online: sources not
 *   scanned within RESCAN_INTERVAL. It never prompts: folder sources that
 *   lost permission and expired sign-ins are only marked.
 */
import type { Library, Source } from '@libraria/core';
import { dueForRescan, lastScanAt, markScanned, scanRoots } from '../library/sources';
import { scanSource, type ScanResult } from '../library/scan';
import { isOnline } from '../net.svelte';
import { services as appServices, type Services } from '../services';
import { SourceError, errorMessage, isAbort } from '../sources/errors';
import { folderAccess, requestFolderAccess } from '../sources/folder';
import { getSourceKind } from '../sources/registry';
import { catalog } from './catalog.svelte';

export interface ScanJob {
  found: number;
  path: string;
}

export interface SourceProblem {
  code: SourceError['code'] | 'unknown';
  message: string;
  corsHelp: boolean;
}

export function problemFrom(err: unknown, source: Source): SourceProblem {
  const message = errorMessage(err, source.config);
  if (err instanceof SourceError) return { code: err.code, message, corsHelp: err.corsHelp };
  return { code: 'unknown', message, corsHelp: false };
}

/** Kinds that can be scanned in this browser right now. */
export function scannable(source: Source): boolean {
  const def = getSourceKind(source.config.kind);
  return !!def && def.implemented && source.config.kind !== 'local' && def.isSupported();
}

class Scanner {
  jobs = $state<Record<string, ScanJob>>({});
  problems = $state<Record<string, SourceProblem>>({});
  private running = new Map<string, Promise<ScanResult | null>>();
  private controllers = new Map<string, AbortController>();
  private s: Services | null = null;

  attach(s: Services): void {
    this.s = s;
  }

  private services(): Services {
    return (this.s ??= appServices());
  }

  busy(sourceId: string): boolean {
    return sourceId in this.jobs;
  }

  setProblem(sourceId: string, p: SourceProblem | null): void {
    const next = { ...this.problems };
    if (p) next[sourceId] = p;
    else delete next[sourceId];
    this.problems = next;
  }

  /** Scan one source. Concurrent calls for the same source share one run. Never throws. */
  scan(source: Source, opts: { onDone?: (r: ScanResult | null, problem: SourceProblem | null) => void } = {}): Promise<ScanResult | null> {
    const existing = this.running.get(source.id);
    if (existing) return existing;
    const run = this.run(source).then(
      (r) => {
        opts.onDone?.(r, null);
        return r;
      },
      (err) => {
        const p = isAbort(err) ? null : problemFrom(err, source);
        if (p) this.setProblem(source.id, p);
        opts.onDone?.(null, p);
        return null;
      },
    );
    this.running.set(source.id, run);
    void run.finally(() => {
      this.running.delete(source.id);
      this.controllers.delete(source.id);
      const next = { ...this.jobs };
      delete next[source.id];
      this.jobs = next;
    });
    return run;
  }

  private async run(source: Source): Promise<ScanResult> {
    const s = this.services();
    const ctrl = new AbortController();
    this.controllers.set(source.id, ctrl);
    this.jobs = { ...this.jobs, [source.id]: { found: 0, path: '' } };
    const total: ScanResult = { added: 0, updated: 0, unchanged: 0, removed: 0 };
    const roots = scanRoots(source.id, await s.repo.listLibraries());
    let found = 0;
    for (const root of roots) {
      const r = await scanSource(source, root, s, {
        signal: ctrl.signal,
        onProgress: (_n, path) => {
          found++;
          this.jobs = { ...this.jobs, [source.id]: { found, path } };
        },
      });
      total.added += r.added;
      total.updated += r.updated;
      total.unchanged += r.unchanged;
      total.removed += r.removed;
    }
    this.setProblem(source.id, null);
    await markScanned(s, source.id);
    return total;
  }

  cancel(sourceId: string): void {
    this.controllers.get(sourceId)?.abort();
  }

  /** Scan every scannable source of a library, one after another. */
  async scanLibrary(lib: Library): Promise<{ result: ScanResult; failed: number }> {
    const result: ScanResult = { added: 0, updated: 0, unchanged: 0, removed: 0 };
    let failed = 0;
    const ids = new Set(lib.sources.map((r) => r.sourceId));
    for (const src of catalog.sources.filter((x) => ids.has(x.id) && scannable(x))) {
      if (!isOnline() && !getSourceKind(src.config.kind)?.deviceOnly) continue;
      const r = await this.scan(src);
      if (!r) failed++;
      else for (const k of Object.keys(result) as (keyof ScanResult)[]) result[k] += r[k];
    }
    return { result, failed };
  }

  /** Mark folder sources without permission and expired sign-ins. Cheap; no network, no prompts. */
  async checkAccess(sources: Source[] = catalog.sources): Promise<void> {
    const s = this.services();
    for (const src of sources) {
      if (src.config.kind === 'folder' && scannable(src)) {
        const state = await folderAccess(s.repo, src);
        if (state === 'granted') {
          if (this.problems[src.id]?.code === 'permission') this.setProblem(src.id, null);
        } else if (state === 'missing') {
          this.setProblem(src.id, { code: 'config', message: `The folder link for “${src.name}” is missing on this device. Remove the source and add the folder again.`, corsHelp: false });
        } else {
          this.setProblem(src.id, { code: 'permission', message: `Libraria needs your permission to read “${src.name}” again.`, corsHelp: false });
        }
      }
      if (src.config.kind === 'gdrive' || src.config.kind === 'dropbox') {
        const t = src.config.tokens;
        const expired = !t?.accessToken || (t.expiresAt != null && t.expiresAt <= Date.now() && !t.refreshToken);
        if (expired) this.setProblem(src.id, { code: 'auth', message: `Sign in to ${src.config.kind === 'gdrive' ? 'Google Drive' : 'Dropbox'} again to update “${src.name}”.`, corsHelp: false });
        else if (this.problems[src.id]?.code === 'auth') this.setProblem(src.id, null);
      }
    }
  }

  /** Rescan sources that are due. Skips ones with a known problem that needs the user. */
  async autoRescan(interval?: number): Promise<void> {
    const s = this.services();
    await this.checkAccess();
    const candidates = catalog.sources.filter((src) => scannable(src) && !this.problems[src.id]);
    const last = new Map<string, number>();
    for (const src of candidates) last.set(src.id, await lastScanAt(s, src.id));
    for (const src of dueForRescan(candidates, last, Date.now(), interval)) {
      if (!isOnline() && !getSourceKind(src.config.kind)?.deviceOnly) continue;
      await this.scan(src);
    }
  }

  /** "Grant access" button: ask for folder permission (click handler), then rescan. */
  async grantAccess(source: Source): Promise<boolean> {
    const ok = await requestFolderAccess(this.services().repo, source);
    if (ok) {
      this.setProblem(source.id, null);
      void this.scan(source);
    }
    return ok;
  }
}

export const scanner = new Scanner();

export function describeScan(r: ScanResult): string {
  const parts: string[] = [];
  if (r.added) parts.push(`${r.added} new`);
  if (r.updated) parts.push(`${r.updated} changed`);
  if (r.removed) parts.push(`${r.removed} removed`);
  return parts.length ? parts.join(', ') : 'no changes';
}
