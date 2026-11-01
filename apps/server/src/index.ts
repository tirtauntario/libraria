#!/usr/bin/env node
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { API_PREFIX } from '@libraria/core';
import { createServer } from './app';
import { loadConfig } from './config';
import { createLogger } from './log';
import { SERVER_VERSION } from './version';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.log.level);
  const handle = await createServer(config, { log });

  const server = createHttpServer(handle.app);
  // Large upload chunks on slow links need more than Node's 5 minute default.
  server.requestTimeout = 30 * 60 * 1000;

  server.listen(config.port, config.host, () => {
    const { port } = server.address() as AddressInfo;
    const url = config.publicUrl ?? `http://localhost:${port}`;
    log.info(`Libraria server ${SERVER_VERSION} listening on ${config.host}:${port}`);
    log.info(`Data directory: ${config.dataDir}`);
    log.info(`API: ${url}${API_PREFIX}/info`);
    if (config.webDir) log.info(`Serving web client from ${config.webDir}`);
    if (handle.setupToken) {
      const line = '='.repeat(72);
      console.log(
        [
          '',
          line,
          '  This server has no owner yet. Finish setup to create the owner',
          '  account and the library. Open:',
          '',
          `      ${url}`,
          '',
          '  and enter this one-time setup token:',
          '',
          `      ${handle.setupToken}`,
          '',
          `  (or POST ${API_PREFIX}/setup). A new token is printed on every start`,
          '  until setup is done.',
          line,
          '',
        ].join('\n'),
      );
    }
  });

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal} received, shutting down`);
    const force = setTimeout(() => server.closeAllConnections(), 10_000);
    force.unref();
    server.close(() => {
      handle
        .close()
        .catch((err) => log.error('Error while closing the database', err))
        .finally(() => process.exit(0));
    });
    server.closeIdleConnections();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
