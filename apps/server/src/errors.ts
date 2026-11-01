import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { ApiError, ErrorCode } from '@libraria/core';
import type { Logger } from './log';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly extra: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export const badRequest = (message: string) => new HttpError(400, 'bad_request', message);
export const unauthorized = (message = 'Sign in required') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'Not allowed') => new HttpError(403, 'forbidden', message);
export const notFound = (message = 'Not found') => new HttpError(404, 'not_found', message);
export const conflict = (message: string, extra: Record<string, unknown> = {}) =>
  new HttpError(409, 'conflict', message, extra);

export function sendError(res: Parameters<RequestHandler>[1], err: HttpError) {
  for (const [k, v] of Object.entries(err.headers)) res.setHeader(k, v);
  const body: ApiError & Record<string, unknown> = { ...err.extra, error: err.code, message: err.message };
  res.status(err.status).json(body);
}

export const notFoundHandler: RequestHandler = (_req, _res, next) => next(notFound('No such endpoint'));

export function errorHandler(log: Logger): ErrorRequestHandler {
  return (err, _req, res, _next) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (err instanceof HttpError) return sendError(res, err);
    // body-parser errors carry `type` and `status`.
    const type = (err as { type?: string }).type;
    if (type === 'entity.too.large') return sendError(res, new HttpError(413, 'too_large', 'Request body too large'));
    if (type === 'entity.parse.failed') return sendError(res, badRequest('Invalid JSON body'));
    const status = (err as { status?: number }).status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return sendError(res, new HttpError(status, status === 404 ? 'not_found' : 'bad_request', String(err.message ?? 'Bad request')));
    }
    log.error('Unhandled error', err);
    sendError(res, new HttpError(500, 'internal', 'Internal server error'));
  };
}
