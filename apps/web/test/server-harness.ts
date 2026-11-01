/**
 * Runs the real Libraria server (apps/server) in-process on a random port
 * with a temp data dir. The server modules are imported by path at run time
 * so the web type-check does not pull in the server's dependencies.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KdfParams } from '@libraria/core';

/** Cheapest Argon2id parameters the server accepts. */
export const TEST_KDF: KdfParams = { algorithm: 'argon2id', memoryKiB: 16 * 1024, iterations: 1, parallelism: 1 };

interface ServerModule {
  createServer(config: unknown, opts: { log?: unknown }): Promise<{ app: (req: unknown, res: unknown) => void; setupToken: string | null; close(): Promise<void> }>;
}
interface ConfigModule {
  defaultConfig(dataDir: string): Record<string, unknown>;
  finalizeConfig(config: unknown): unknown;
}
interface LogModule {
  createLogger(level: string): unknown;
}

const SERVER_SRC = new URL('../../server/src/', import.meta.url).href;

export interface RunningServer {
  url: string;
  dataDir: string;
  setupToken: string;
  stop(): Promise<void>;
}

export async function startRealServer(): Promise<RunningServer> {
  const dir = await mkdtemp(join(tmpdir(), 'libraria-web-it-'));
  const dataDir = join(dir, 'data');
  const app = (await import(/* @vite-ignore */ SERVER_SRC + 'app.ts')) as ServerModule;
  const cfg = (await import(/* @vite-ignore */ SERVER_SRC + 'config.ts')) as ConfigModule;
  const log = (await import(/* @vite-ignore */ SERVER_SRC + 'log.ts')) as LogModule;
  const fast = { capacity: 1e9, refillPerSecond: 1e9 };
  const config = cfg.finalizeConfig({ ...cfg.defaultConfig(dataDir), webDir: null, rateLimit: { anonymous: fast, auth: fast } });
  const handle = await app.createServer(config, { log: log.createLogger('silent') });
  const http: Server = createHttpServer(handle.app as never);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    dataDir,
    setupToken: handle.setupToken!,
    async stop() {
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await handle.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
