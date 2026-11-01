import type { Source, SourceKind } from '@libraria/core';
import type { DriverContext, SourceDriver, SourceKindDefinition } from './types';

const kinds = new Map<SourceKind, SourceKindDefinition>();
const drivers = new Map<string, { updatedAt: number; driver: SourceDriver }>();

/** Register (or replace) a source kind. Replacing a stub with a real driver is the intended use. */
export function registerSourceKind(def: SourceKindDefinition): void {
  kinds.set(def.kind, def);
  // Drop cached drivers of this kind so the new implementation is used.
  for (const [id, entry] of drivers) {
    if (entry.driver.source.config.kind === def.kind) {
      entry.driver.close?.();
      drivers.delete(id);
    }
  }
}

export function getSourceKind(kind: SourceKind): SourceKindDefinition | undefined {
  return kinds.get(kind);
}

export function listSourceKinds(): SourceKindDefinition[] {
  return [...kinds.values()];
}

export class SourceUnavailableError extends Error {
  constructor(readonly source: Source, reason: string) {
    super(`${source.name}: ${reason}`);
    this.name = 'SourceUnavailableError';
  }
}

/** Live driver for a source. Cached until the source record changes. */
export function driverFor(source: Source, ctx: DriverContext): SourceDriver {
  const cached = drivers.get(source.id);
  if (cached && cached.updatedAt === source.updatedAt) return cached.driver;
  cached?.driver.close?.();
  const def = kinds.get(source.config.kind);
  if (!def || !def.implemented) throw new SourceUnavailableError(source, `${source.config.kind} sources are not supported yet`);
  if (!def.isSupported()) throw new SourceUnavailableError(source, 'not supported in this browser');
  const driver = def.createDriver(source, ctx);
  drivers.set(source.id, { updatedAt: source.updatedAt, driver });
  return driver;
}

export function forgetDriver(sourceId: string): void {
  drivers.get(sourceId)?.driver.close?.();
  drivers.delete(sourceId);
}
