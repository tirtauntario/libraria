export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export interface Logger {
  error(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

export function createLogger(level: LogLevel | 'silent'): Logger {
  const max = level === 'silent' ? -1 : ORDER[level];
  const at = (l: LogLevel, fn: (...a: unknown[]) => void) => (msg: string, ...args: unknown[]) => {
    if (ORDER[l] <= max) fn(`${new Date().toISOString()} ${l.toUpperCase()} ${msg}`, ...args);
  };
  return {
    error: at('error', console.error),
    warn: at('warn', console.warn),
    info: at('info', console.log),
    debug: at('debug', console.log),
  };
}
