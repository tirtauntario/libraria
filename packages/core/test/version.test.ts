import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  bumpVersion,
  changelogNotes,
  compareVersions,
  formatVersion,
  parseChangelog,
  parseVersion,
  releaseChangelog,
  UNRELEASED,
} from '../src/version';

const repo = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');

describe('semantic versions', () => {
  it('parses and formats', () => {
    expect(parseVersion('1.2.3-rc.1+9d74586.dirty')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: ['rc', '1'], build: ['9d74586', 'dirty'] });
    expect(parseVersion('v0.1.0')?.minor).toBe(1);
    for (const bad of ['1.2', '01.2.3', '1.2.3-', '1.2.3+', 'banana', '1.2.3-01']) expect(parseVersion(bad)).toBeNull();
    expect(formatVersion(parseVersion('1.2.3-rc.1+abc')!)).toBe('1.2.3-rc.1+abc');
  });

  it('orders by precedence, as in the semver spec', () => {
    const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '2.0.0'];
    for (let i = 1; i < ordered.length; i++) expect(compareVersions(ordered[i - 1]!, ordered[i]!)).toBeLessThan(0);
    expect(compareVersions('1.0.0+abc', '1.0.0+def')).toBe(0);
    expect(() => compareVersions('1.0', '1.0.0')).toThrow();
  });

  it('bumps, and releases pre-releases', () => {
    expect(bumpVersion('0.1.0', 'patch')).toBe('0.1.1');
    expect(bumpVersion('0.1.3', 'minor')).toBe('0.2.0');
    expect(bumpVersion('0.9.3', 'major')).toBe('1.0.0');
    expect(bumpVersion('1.0.0-rc.2', 'major')).toBe('1.0.0');
    expect(bumpVersion('1.1.0-beta', 'minor')).toBe('1.1.0');
    expect(bumpVersion('1.1.1-beta', 'patch')).toBe('1.1.1');
    expect(bumpVersion('1.1.1-beta', 'minor')).toBe('1.2.0');
    expect(bumpVersion('1.2.3+abc', 'patch')).toBe('1.2.4');
  });
});

const SAMPLE = `# Changelog

Intro text.

## Unreleased

### Added

- A new **thing**.
- A longer item
  that wraps.

### Fixed

- A bug.

## 0.1.0 - 2026-10-01

- First version.
`;

describe('changelog', () => {
  it('parses versions, dates, sections and wrapped items', () => {
    const entries = parseChangelog(SAMPLE);
    expect(entries.map((e) => [e.version, e.date])).toEqual([
      [UNRELEASED, null],
      ['0.1.0', '2026-10-01'],
    ]);
    expect(entries[0]!.sections).toEqual([
      { title: 'Added', items: ['A new **thing**.', 'A longer item that wraps.'] },
      { title: 'Fixed', items: ['A bug.'] },
    ]);
    expect(entries[1]!.sections).toEqual([{ title: null, items: ['First version.'] }]);
  });

  it('turns Unreleased into a release and starts a new Unreleased', () => {
    const out = releaseChangelog(SAMPLE, '0.2.0', '2026-11-01');
    const entries = parseChangelog(out);
    expect(entries.map((e) => [e.version, e.date])).toEqual([
      [UNRELEASED, null],
      ['0.2.0', '2026-11-01'],
      ['0.1.0', '2026-10-01'],
    ]);
    expect(entries[0]!.sections).toEqual([]);
    expect(changelogNotes(out, '0.2.0')).toBe('### Added\n\n- A new **thing**.\n- A longer item that wraps.\n\n### Fixed\n\n- A bug.');
  });

  it('refuses empty or repeated releases', () => {
    const released = releaseChangelog(SAMPLE, '0.2.0', '2026-11-01');
    expect(() => releaseChangelog(released, '0.3.0', '2026-11-02')).toThrow(/empty/);
    expect(() => releaseChangelog(SAMPLE, '0.1.0', '2026-11-02')).toThrow(/already/);
    expect(() => releaseChangelog('# Changelog\n', '0.2.0', '2026-11-02')).toThrow(/Unreleased/);
  });
});

describe('this repository', () => {
  it('gives the app, the server and core the same version as the root package', () => {
    const version = (path: string) => (JSON.parse(repo(path)) as { version: string }).version;
    const root = version('package.json');
    expect(parseVersion(root)).not.toBeNull();
    for (const p of ['apps/web/package.json', 'apps/server/package.json', 'packages/core/package.json']) expect(version(p), p).toBe(root);
  });

  it('has a CHANGELOG.md the app and the release script can read', () => {
    const entries = parseChangelog(repo('CHANGELOG.md'));
    expect(entries[0]?.version).toBe(UNRELEASED);
    for (const e of entries.slice(1)) expect(parseVersion(e.version), e.version).not.toBeNull();
  });
});
