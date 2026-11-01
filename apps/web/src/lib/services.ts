/**
 * App-wide singletons: database, file store and the pluggable steps of the
 * import pipeline. Library functions take `Services` explicitly so tests can
 * pass their own (fake-indexeddb, IDB file store, stub analyzer).
 */
import { ChangeBus } from './db/events';
import { Repo } from './db/repo';
import { openLibrariaDb, type Db } from './db/schema';
import { analyzeBook, type Analyzer } from './library/analyze';
import { hashInWorker, type Hasher } from './library/hash';
import { driverFor, type SourceDriver } from './sources';
import type { Source } from '@libraria/core';
import { createFileStore, type FileStore } from './storage/opfs';

export interface Services {
  db: Db;
  repo: Repo;
  files: FileStore;
  hash: Hasher;
  analyze: Analyzer;
  driver(source: Source): SourceDriver;
}

export function makeServices(db: Db, files: FileStore, opts: { hash?: Hasher; analyze?: Analyzer; bus?: ChangeBus; now?: () => number } = {}): Services {
  const repo = new Repo(db, opts.bus ?? new ChangeBus(), opts.now);
  const services: Services = {
    db,
    repo,
    files,
    hash: opts.hash ?? hashInWorker,
    analyze: opts.analyze ?? analyzeBook,
    driver: (source) => driverFor(source, { repo, files }),
  };
  return services;
}

let current: Services | null = null;
let starting: Promise<Services> | null = null;

export function initServices(): Promise<Services> {
  starting ??= (async () => {
    const db = await openLibrariaDb();
    const files = await createFileStore(db);
    const s = makeServices(db, files, { bus: new ChangeBus('libraria-data') });
    await s.repo.init();
    current = s;
    return s;
  })();
  return starting;
}

export function services(): Services {
  if (!current) throw new Error('Services not initialised');
  return current;
}

/** For tests. */
export function setServices(s: Services | null): void {
  current = s;
  starting = s ? Promise.resolve(s) : null;
}
