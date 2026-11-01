import { describe, expect, it } from 'vitest';
import { href, matchPath, parseHash, registerRoute, resolve } from '../src/lib/router.svelte';

const C = (() => null) as never;

describe('router', () => {
  it('parses hashes into path and query', () => {
    expect(parseHash('')).toMatchObject({ path: '/' });
    expect(parseHash('#/')).toMatchObject({ path: '/' });
    const loc = parseHash('#/read/abc/?edge=end&x=1');
    expect(loc.path).toBe('/read/abc');
    expect(loc.query.get('edge')).toBe('end');
    expect(parseHash('#//book//x').path).toBe('/book/x');
  });

  it('matches params, optional params and wildcards', () => {
    expect(matchPath('/book/:id', '/book/123')).toEqual({ id: '123' });
    expect(matchPath('/book/:id', '/book')).toBeNull();
    expect(matchPath('/book/:id', '/book/1/extra')).toBeNull();
    expect(matchPath('/library/:id?', '/library')).toEqual({});
    expect(matchPath('/library/:id?', '/library/x')).toEqual({ id: 'x' });
    expect(matchPath('/', '/')).toEqual({});
    expect(matchPath('/', '/x')).toBeNull();
    expect(matchPath('/files/*', '/files/a/b%20c')).toEqual({ '*': 'a/b c' });
    expect(matchPath('/book/:id', '/book/a%2Fb')).toEqual({ id: 'a/b' });
  });

  it('builds encoded hrefs', () => {
    expect(href('/book', 'a b')).toBe('#/book/a%20b');
    expect(href('/read', 'x', 3)).toBe('#/read/x/3');
    expect(href('/')).toBe('#/');
  });

  it('tries catch-all routes last, so later registrations still match', () => {
    registerRoute({ pattern: '/*', component: C });
    registerRoute({ pattern: '/server/:id', component: C });
    expect(resolve('/server/1')?.route.pattern).toBe('/server/:id');
    expect(resolve('/nope')?.route.pattern).toBe('/*');
  });
});
