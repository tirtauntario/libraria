import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from '../src/app';
import { CONFIG_FILENAME, loadConfig } from '../src/config';
import { createLogger } from '../src/log';
import { newCreds, p } from './helpers';
import request from 'supertest';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'libraria-config-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('config', () => {
  it('writes a default config file on first run and applies env overrides', () => {
    const data = join(dir, 'data');
    const config = loadConfig({ LIBRARIA_DATA_DIR: data }, dir);
    expect(config).toMatchObject({ port: 8080, dataDir: data, publicUrl: null, trustProxy: false, sourceRoots: [] });
    const file = join(data, CONFIG_FILENAME);
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8')).port).toBe(8080);

    writeFileSync(file, JSON.stringify({ port: 9000, allowedOrigins: ['https://a.example/'], log: { level: 'warn' } }));
    const fromFile = loadConfig({ LIBRARIA_DATA_DIR: data }, dir);
    expect(fromFile).toMatchObject({ port: 9000, allowedOrigins: ['https://a.example'], log: { level: 'warn' } });

    const env = loadConfig(
      {
        LIBRARIA_DATA_DIR: data,
        LIBRARIA_PORT: '9100',
        LIBRARIA_PUBLIC_URL: 'https://books.example.org/',
        LIBRARIA_TRUST_PROXY: '1',
        LIBRARIA_ALLOWED_ORIGINS: 'https://x.example, https://y.example',
        LIBRARIA_SOURCE_ROOTS: '/srv/books,media',
        LIBRARIA_LOG_LEVEL: 'debug',
        LIBRARIA_WEB_DIR: 'web',
      },
      dir,
    );
    expect(env).toMatchObject({
      port: 9100,
      publicUrl: 'https://books.example.org',
      trustProxy: 1,
      allowedOrigins: ['https://x.example', 'https://y.example'],
      sourceRoots: ['/srv/books', join(dir, 'media')],
      log: { level: 'debug' },
      webDir: join(dir, 'web'),
    });
  });

  it('keeps identity, secret and owner across restarts', async () => {
    const config = loadConfig({ LIBRARIA_DATA_DIR: join(dir, 'data'), LIBRARIA_WEB_DIR: '' }, dir);
    const log = createLogger('silent');
    const first = await createServer(config, { log });
    expect(first.setupToken).toBeTruthy();
    const restartedBeforeSetup = { id: first.ctx.serverId, secret: first.ctx.secret };
    await first.close();

    const second = await createServer(config, { log });
    expect(second.ctx.serverId).toBe(restartedBeforeSetup.id);
    expect(second.ctx.secret).toBe(restartedBeforeSetup.secret);
    expect(second.setupToken).not.toBe(first.setupToken);
    // The old token is void after a restart.
    const old = await request(second.app).post(p('/setup')).send({ setupToken: first.setupToken, username: 'own', libraryName: 'L', ...newCreds() });
    expect(old.status).toBe(403);
    const ok = await request(second.app).post(p('/setup')).send({ setupToken: second.setupToken, username: 'own', libraryName: 'Kept', ...newCreds() });
    expect(ok.status).toBe(201);
    await second.close();

    const third = await createServer(config, { log });
    expect(third.setupToken).toBeNull();
    const info = await request(third.app).get(p('/info'));
    expect(info.body).toMatchObject({ id: restartedBeforeSetup.id, name: 'Kept', setupRequired: false });
    await third.close();
  });
});
