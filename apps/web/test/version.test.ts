import type { BuildInfo } from '@libraria/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toasts } from '../src/lib/stores/toasts.svelte';
import { announceUpdate, buildLabel, releaseNotes } from '../src/lib/version';

const build = (b: Partial<BuildInfo>): BuildInfo => ({
  version: '0.2.0',
  full: '0.2.0',
  commit: '9d74586',
  dirty: false,
  release: false,
  date: '2026-11-01T10:00:00.000Z',
  ...b,
});

const MD = `## Unreleased

- Coming soon.

## 0.2.0 - 2026-11-01

- Shipped.
`;

describe('app version', () => {
  it('describes the build', () => {
    expect(buildLabel(build({ release: true }), false)).toMatch(/^Release · /);
    expect(buildLabel(build({}), false)).toMatch(/^Build 9d74586 · .*2026$/);
    expect(buildLabel(build({ dirty: true }), false)).toMatch(/· local changes$/);
    expect(buildLabel(build({ commit: null }), false)).toMatch(/^Build · /);
    expect(buildLabel(build({}), true)).toBe('Development build');
  });

  it('shows upcoming notes only in builds that are not a release', () => {
    expect(releaseNotes(build({ release: false }), MD).map((e) => e.version)).toEqual(['Unreleased', '0.2.0']);
    expect(releaseNotes(build({ release: true }), MD).map((e) => e.version)).toEqual(['0.2.0']);
  });
});

describe('update notice', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    toasts.items.length = 0;
  });
  afterEach(() => vi.unstubAllGlobals());

  it('says nothing on the first start, then once after an update', () => {
    announceUpdate('0.1.0');
    expect(toasts.items).toHaveLength(0);
    announceUpdate('0.1.0');
    expect(toasts.items).toHaveLength(0);
    announceUpdate('0.2.0');
    expect(toasts.items.map((t) => t.message)).toEqual(['Libraria is updated to 0.2.0.']);
    announceUpdate('0.2.0');
    expect(toasts.items).toHaveLength(1);
  });

  it('stays quiet after going back to an older version', () => {
    announceUpdate('0.3.0');
    announceUpdate('0.2.0');
    expect(toasts.items).toHaveLength(0);
  });
});
