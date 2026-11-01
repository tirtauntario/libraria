/**
 * Build metadata for the app (vite.config.ts) and the server (tsup.config.ts).
 *
 * A build made exactly from the release tag `v<version>` is a release and
 * reports the plain version. Any other build adds the commit as semver build
 * metadata, e.g. `0.2.0+9d74586`, plus `.dirty` for uncommitted changes.
 *
 * Without git (Docker builds exclude .git), set LIBRARIA_BUILD_COMMIT, and
 * LIBRARIA_RELEASE=1 for a release build. GitHub Actions is detected.
 */
import { execFileSync } from 'node:child_process';

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

/**
 * @param {string} version the version from package.json
 * @param {string} [cwd]
 * @returns {{ version: string, full: string, commit: string | null, dirty: boolean, release: boolean, date: string }}
 */
export function buildInfo(version, cwd = process.cwd()) {
  const env = process.env;
  const fromEnv = env.LIBRARIA_BUILD_COMMIT || env.GITHUB_SHA || '';
  const commit = (fromEnv || git(['rev-parse', 'HEAD'], cwd)).slice(0, 7) || null;
  const dirty = !fromEnv && !!commit && git(['status', '--porcelain', '--untracked-files=no'], cwd) !== '';
  const tag = `v${version}`;
  const tagged =
    env.LIBRARIA_RELEASE === '1' ||
    (env.GITHUB_REF_TYPE === 'tag' && env.GITHUB_REF_NAME === tag) ||
    (!fromEnv && git(['tag', '--points-at', 'HEAD'], cwd).split('\n').includes(tag));
  const release = tagged && !dirty;
  const full = release || !commit ? version : `${version}+${commit}${dirty ? '.dirty' : ''}`;
  return { version, full, commit, dirty, release, date: new Date().toISOString() };
}
