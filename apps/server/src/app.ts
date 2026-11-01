import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import express, { Router, type Express, type RequestHandler } from 'express';
import { API_PREFIX, UPLOAD_OFFSET_HEADER } from '@libraria/core';
import { authenticate } from './auth';
import type { ServerConfig } from './config';
import { createContext, issueSetupToken, type AppContext } from './context';
import { errorHandler, notFoundHandler } from './errors';
import { createLogger, type Logger } from './log';
import { RateLimiter } from './ratelimit';
import { accountRoutes } from './routes/account';
import { adminRoutes } from './routes/admin';
import { bookRoutes } from './routes/books';
import { sourceRoutes } from './routes/sources';
import { submissionRoutes } from './routes/submissions';
import { syncRoutes } from './routes/sync';
import { cleanStaleUploads } from './services/submissions';

const AUTH_PATHS = new Set(['/setup', '/auth/login', '/auth/register', '/auth/prelogin']);
const JSON_LIMIT = '256kb';

export interface Limiters {
  anonymous: RateLimiter;
  auth: RateLimiter;
}

const securityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
};

/** API responses are data, never documents: forbid framing and active content. */
const apiHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; sandbox");
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cache-Control', 'no-store');
  next();
};

function cors(config: ServerConfig): RequestHandler {
  const allowed = new Set(config.allowedOrigins);
  const own = config.publicUrl ? new URL(config.publicUrl).origin : null;
  return (req, res, next) => {
    res.vary('Origin');
    const origin = req.headers.origin;
    const preflight = req.method === 'OPTIONS';
    if (origin && (allowed.has(origin) || origin === (own ?? `${req.protocol}://${req.get('host')}`))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader(
        'Access-Control-Expose-Headers',
        `${UPLOAD_OFFSET_HEADER}, Upload-Length, Content-Range, Accept-Ranges, Content-Length, Content-Disposition, Retry-After`,
      );
      if (preflight) {
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE');
        res.setHeader(
          'Access-Control-Allow-Headers',
          `Authorization, Content-Type, ${UPLOAD_OFFSET_HEADER}, Range, X-Libraria-Replace-Keys`,
        );
        res.setHeader('Access-Control-Max-Age', '600');
      }
    }
    if (preflight) return void res.status(204).end();
    next();
  };
}

function staticHeaders(res: express.Response, path: string): void {
  const name = basename(path);
  if (name.endsWith('.html') || name === 'sw.js' || name === 'registerSW.js' || name.endsWith('.webmanifest')) {
    res.setHeader('Cache-Control', 'no-cache');
  } else if (/[\\/]assets[\\/]/.test(path) || /[.-][A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(name)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  } else {
    res.setHeader('Cache-Control', 'public, max-age=3600');
  }
}

export function createApp(ctx: AppContext, limiters: Limiters = createLimiters(ctx.config)): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', ctx.config.trustProxy);
  app.use(securityHeaders);

  const json = express.json({ limit: JSON_LIMIT });
  const api = Router();
  api.use(apiHeaders);
  api.use(cors(ctx.config));
  api.use(limiters.auth.middleware((req) => AUTH_PATHS.has(req.path)));
  // The sync push route has its own, larger JSON limit; uploads stream raw.
  api.use((req, res, next) => (req.path === '/sync/records' ? next() : json(req, res, next)));
  api.use(authenticate(ctx));
  api.use(limiters.anonymous.middleware((req) => !req.auth && !AUTH_PATHS.has(req.path)));
  api.use(accountRoutes(ctx));
  api.use(adminRoutes(ctx));
  api.use(bookRoutes(ctx));
  api.use(submissionRoutes(ctx));
  api.use(sourceRoutes(ctx));
  api.use(syncRoutes(ctx));
  api.use(notFoundHandler);
  app.use(API_PREFIX, api);

  const webDir = ctx.config.webDir;
  if (webDir && existsSync(join(webDir, 'index.html'))) {
    app.use(express.static(webDir, { index: 'index.html', setHeaders: staticHeaders, cacheControl: false }));
  } else {
    app.get('/', (_req, res) => {
      res.type('text/plain').send(`Libraria server. The API lives at ${API_PREFIX}; no web client is installed here.\n`);
    });
  }

  app.use(errorHandler(ctx.log));
  return app;
}

export function createLimiters(config: ServerConfig, now?: () => number): Limiters {
  return {
    anonymous: new RateLimiter(config.rateLimit.anonymous, now),
    auth: new RateLimiter(config.rateLimit.auth, now),
  };
}

export interface ServerHandle {
  app: Express;
  ctx: AppContext;
  /** Printed on the console; null once the owner exists. */
  setupToken: string | null;
  close(): Promise<void>;
}

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/** Opens the data dir, migrates, prepares first-run setup and builds the app. */
export async function createServer(config: ServerConfig, opts: { log?: Logger; now?: () => number } = {}): Promise<ServerHandle> {
  const log = opts.log ?? createLogger(config.log.level);
  const ctx = await createContext(config, log, opts.now);
  await cleanStaleUploads(ctx);
  const setupToken = await issueSetupToken(ctx);
  const limiters = createLimiters(config, opts.now);
  const app = createApp(ctx, limiters);

  const timers = [
    setInterval(() => {
      cleanStaleUploads(ctx).catch((err) => log.error('Stale upload cleanup failed', err));
    }, CLEANUP_INTERVAL_MS),
    setInterval(() => {
      limiters.anonymous.prune();
      limiters.auth.prune();
    }, 60_000),
  ];
  for (const t of timers) t.unref();

  return {
    app,
    ctx,
    setupToken,
    async close() {
      for (const t of timers) clearInterval(t);
      await ctx.db.destroy();
    },
  };
}
