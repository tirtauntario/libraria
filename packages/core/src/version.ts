/**
 * Semantic versions (semver.org 2.0.0) and the CHANGELOG.md format used for
 * releases. The release script (scripts/release.mjs) imports this file
 * directly through Node's type stripping, so it has no imports and uses only
 * erasable TypeScript syntax.
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  build: string[];
}

export type Bump = 'major' | 'minor' | 'patch';

/** What a build knows about itself (scripts/build-info.mjs). */
export interface BuildInfo {
  /** The version in package.json. */
  version: string;
  /** `version`, plus `+<commit>` (and `.dirty`) unless this is a release build. */
  full: string;
  /** Short commit hash, or null when unknown. */
  commit: string | null;
  /** Built with uncommitted changes. */
  dirty: boolean;
  /** Built exactly from the release tag. */
  release: boolean;
  /** ISO time of the build. */
  date: string;
}

// The regular expression suggested by semver.org.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export function parseVersion(text: string): SemVer | null {
  const m = SEMVER.exec(text.trim().replace(/^v/, ''));
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
    build: m[5] ? m[5].split('.') : [],
  };
}

export function formatVersion(v: SemVer): string {
  let s = `${v.major}.${v.minor}.${v.patch}`;
  if (v.prerelease.length) s += `-${v.prerelease.join('.')}`;
  if (v.build.length) s += `+${v.build.join('.')}`;
  return s;
}

function mustParse(text: string): SemVer {
  const v = parseVersion(text);
  if (!v) throw new Error(`Not a semantic version: ${text}`);
  return v;
}

/** Precedence order (build metadata is ignored, as semver says). Negative if a < b. */
export function compareVersions(a: string, b: string): number {
  const x = mustParse(a);
  const y = mustParse(b);
  for (const k of ['major', 'minor', 'patch'] as const) if (x[k] !== y[k]) return x[k] - y[k];
  // A pre-release sorts before its release.
  if (!x.prerelease.length || !y.prerelease.length) return y.prerelease.length - x.prerelease.length;
  for (let i = 0; i < Math.max(x.prerelease.length, y.prerelease.length); i++) {
    const p = x.prerelease[i];
    const q = y.prerelease[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** Next version. From a pre-release, the bump that matches it releases it (1.0.0-rc.1 + major = 1.0.0). */
export function bumpVersion(version: string, bump: Bump): string {
  const v = mustParse(version);
  const pre = v.prerelease.length > 0;
  let { major, minor, patch } = v;
  if (bump === 'major') {
    if (!(pre && minor === 0 && patch === 0)) major++;
    minor = 0;
    patch = 0;
  } else if (bump === 'minor') {
    if (!(pre && patch === 0)) minor++;
    patch = 0;
  } else if (!pre) {
    patch++;
  }
  return formatVersion({ major, minor, patch, prerelease: [], build: [] });
}

// --- CHANGELOG.md ------------------------------------------------------------------
//
// Format (after keepachangelog.com): an "## Unreleased" section collects notes
// as work lands; a release renames it to "## 1.2.0 - 2026-11-01" and starts a
// new empty one. Inside a section, "### Added" style headings and "- " items.

export const UNRELEASED = 'Unreleased';

export interface ChangelogEntry {
  /** A version, or UNRELEASED. */
  version: string;
  /** YYYY-MM-DD, or null for Unreleased. */
  date: string | null;
  sections: { title: string | null; items: string[] }[];
}

const HEADING = /^## (\S+)(?: - (\d{4}-\d{2}-\d{2}))?\s*$/;

/** Split the file into "## " blocks: [heading line, body lines]. */
function blocks(md: string): { heading: string; body: string[] }[] {
  const out: { heading: string; body: string[] }[] = [];
  for (const line of md.split(/\r?\n/)) {
    if (line.startsWith('## ')) out.push({ heading: line, body: [] });
    else out.at(-1)?.body.push(line);
  }
  return out;
}

export function parseChangelog(md: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  for (const b of blocks(md)) {
    const m = HEADING.exec(b.heading);
    if (!m) continue;
    const sections: ChangelogEntry['sections'] = [];
    let current: ChangelogEntry['sections'][number] | null = null;
    for (const raw of b.body) {
      const line = raw.trimEnd();
      if (line.startsWith('### ')) {
        current = { title: line.slice(4).trim(), items: [] };
        sections.push(current);
      } else if (/^[-*] /.test(line)) {
        if (!current) sections.push((current = { title: null, items: [] }));
        current.items.push(line.slice(2).trim());
      } else if (/^\s+\S/.test(line) && current?.items.length) {
        // Continuation of the previous item.
        current.items[current.items.length - 1] += ` ${line.trim()}`;
      }
    }
    entries.push({ version: m[1]!, date: m[2] ?? null, sections: sections.filter((s) => s.items.length) });
  }
  return entries;
}

/**
 * Turn the Unreleased notes into the release `version` dated `date`, and
 * start a new empty Unreleased section. Throws when there is nothing to release.
 */
export function releaseChangelog(md: string, version: string, date: string): string {
  if (!parseVersion(version)) throw new Error(`Not a semantic version: ${version}`);
  const unreleased = parseChangelog(md).find((e) => e.version === UNRELEASED);
  if (!unreleased) throw new Error('CHANGELOG.md has no "## Unreleased" section.');
  if (!unreleased.sections.length) throw new Error('The "## Unreleased" section of CHANGELOG.md is empty. Describe the changes first.');
  if (parseChangelog(md).some((e) => e.version === version)) throw new Error(`CHANGELOG.md already has ${version}.`);
  return md.replace(/^## Unreleased[ \t]*$/m, `## ${UNRELEASED}\n\n## ${version} - ${date}`);
}

/** The notes for one version as Markdown, for a release page. */
export function changelogNotes(md: string, version: string): string {
  const entry = parseChangelog(md).find((e) => e.version === version);
  if (!entry) return '';
  return entry.sections
    .map((s) => [s.title ? `### ${s.title}\n` : '', ...s.items.map((i) => `- ${i}`)].join('\n'))
    .join('\n\n');
}
