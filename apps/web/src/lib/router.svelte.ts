/**
 * Minimal hash router: `#/book/<id>?tab=x`. Hash routing keeps the app
 * working from any static host, a sub-path, or a Libraria server without
 * server-side rewrites.
 */
import type { Component } from 'svelte';

export interface RouteDef {
  /** e.g. '/book/:id', '/read/:id', '/library/:id?' (trailing optional param). */
  pattern: string;
  component: Component<{ params: Record<string, string> }>;
  /** 'app' shows the navigation chrome; 'bare' is full screen (readers). */
  layout?: 'app' | 'bare';
  /** Nav section to highlight. */
  section?: string;
}

export interface Location {
  path: string;
  query: URLSearchParams;
}

export function parseHash(hash: string): Location {
  const raw = hash.replace(/^#/, '') || '/';
  const qi = raw.indexOf('?');
  const pathPart = qi < 0 ? raw : raw.slice(0, qi);
  const path = '/' + pathPart.split('/').filter(Boolean).join('/');
  return { path, query: new URLSearchParams(qi < 0 ? '' : raw.slice(qi + 1)) };
}

/** Match a pattern against a path. Returns decoded params, or null. */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const pp = pattern.split('/').filter(Boolean);
  const sp = path.split('/').filter(Boolean);
  const params: Record<string, string> = {};
  for (let i = 0; i < Math.max(pp.length, sp.length); i++) {
    const p = pp[i];
    const s = sp[i];
    if (p === undefined) return null;
    if (p === '*') {
      params['*'] = sp.slice(i).map(safeDecode).join('/');
      return params;
    }
    if (p.startsWith(':')) {
      const optional = p.endsWith('?');
      const name = p.slice(1, optional ? -1 : undefined);
      if (s === undefined) {
        if (!optional) return null;
        continue;
      }
      params[name] = safeDecode(s);
    } else if (p !== s) {
      return null;
    }
  }
  return params;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Build a hash href: href('/book', id) → '#/book/<id>'. */
export function href(...parts: (string | number)[]): string {
  const path = parts
    .map((p, i) => (i === 0 ? String(p).replace(/\/+$/, '') : encodeURIComponent(String(p))))
    .join('/');
  return '#' + (path.startsWith('/') ? path : '/' + path);
}

const routes: RouteDef[] = [];

/** Register a route. Later registrations with the same pattern replace earlier ones. */
export function registerRoute(def: RouteDef): void {
  const i = routes.findIndex((r) => r.pattern === def.pattern);
  if (i >= 0) routes[i] = def;
  else routes.push(def);
}

export function resolve(path: string): { route: RouteDef; params: Record<string, string> } | null {
  // Catch-all patterns are tried last, so routes registered later still win.
  const ordered = [...routes.filter((r) => !r.pattern.includes('*')), ...routes.filter((r) => r.pattern.includes('*'))];
  for (const route of ordered) {
    const params = matchPath(route.pattern, path);
    if (params) return { route, params };
  }
  return null;
}

class RouterState {
  location = $state<Location>(parseHash(typeof location !== 'undefined' ? location.hash : ''));
  /** Position in this app's history stack; > 0 means "back" stays inside the app. */
  index = $state(0);

  constructor() {
    if (typeof window === 'undefined') return;
    const st = history.state as { idx?: number } | null;
    if (typeof st?.idx === 'number') this.index = st.idx;
    else history.replaceState({ ...(st ?? {}), idx: 0 }, '');
    window.addEventListener('hashchange', () => {
      const cur = history.state as { idx?: number } | null;
      if (typeof cur?.idx === 'number') {
        this.index = cur.idx;
      } else {
        this.index += 1;
        history.replaceState({ ...(cur ?? {}), idx: this.index }, '');
      }
      this.location = parseHash(location.hash);
    });
  }

  get path(): string {
    return this.location.path;
  }

  get query(): URLSearchParams {
    return this.location.query;
  }

  navigate(to: string, opts: { replace?: boolean } = {}): void {
    const target = to.startsWith('#') ? to : '#' + (to.startsWith('/') ? to : '/' + to);
    if (opts.replace) {
      history.replaceState({ idx: this.index }, '', target);
      this.location = parseHash(target);
    } else {
      location.hash = target;
    }
  }

  /** Go back if the previous entry is inside the app, else replace with `fallback`. */
  back(fallback = '/'): void {
    if (this.index > 0) history.back();
    else this.navigate(fallback, { replace: true });
  }
}

export const router = new RouterState();
