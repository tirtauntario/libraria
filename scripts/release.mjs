/**
 * Cut a release:
 *
 *   pnpm release patch|minor|major      next version from the current one
 *   pnpm release 1.2.0                  an exact version (also 1.2.0-rc.1)
 *   pnpm release minor --dry-run        show what would happen
 *
 * Sets the version in every package.json (the app, the server and core share
 * one version), turns the "Unreleased" notes in CHANGELOG.md into the new
 * version, commits "Release vX.Y.Z" and creates the annotated tag vX.Y.Z.
 * Nothing is pushed. Run it on a clean main.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bumpVersion, compareVersions, parseVersion, releaseChangelog } from '../packages/core/src/version.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = ['package.json', 'apps/web/package.json', 'apps/server/package.json', 'packages/core/package.json'];

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const target = args.find((a) => !a.startsWith('--'));

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
const read = (file) => readFileSync(join(root, file), 'utf8');

if (!target) fail('usage: pnpm release <patch|minor|major|x.y.z> [--dry-run]');

const current = JSON.parse(read('package.json')).version;
const next = ['major', 'minor', 'patch'].includes(target) ? bumpVersion(current, target) : target.replace(/^v/, '');
const parsed = parseVersion(next);
if (!parsed) fail(`"${target}" is not patch, minor, major or a semantic version.`);
if (parsed.build.length) fail('a release version cannot carry build metadata (+...).');
const tag = `v${next}`;
if (git('tag', '--list', tag)) fail(`tag ${tag} already exists.`);
// The current version may be released once if it never was (the first release).
if (compareVersions(next, current) < 0) fail(`${next} is lower than the current version ${current}.`);
if (compareVersions(next, current) === 0 && git('tag', '--list', 'v*')) fail(`${next} is the current version; pick a higher one.`);

if (!dryRun) {
  if (git('status', '--porcelain')) fail('the working tree has uncommitted changes.');
  const branch = git('branch', '--show-current');
  if (branch !== 'main') fail(`releases are cut on main (you are on ${branch || 'a detached HEAD'}).`);
}

const date = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local time
let changelog;
try {
  changelog = releaseChangelog(read('CHANGELOG.md'), next, date);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

console.log(`${current} → ${next} (${date})`);
if (dryRun) {
  console.log(`Would update ${PACKAGES.join(', ')} and CHANGELOG.md, commit "Release ${tag}" and tag ${tag}.`);
  process.exit(0);
}

for (const file of PACKAGES) {
  const text = read(file);
  const updated = text.replace(/("version":\s*")[^"]*(")/, `$1${next}$2`);
  if (updated === text && !text.includes(`"version": "${next}"`)) fail(`no "version" field in ${file}.`);
  writeFileSync(join(root, file), updated);
}
writeFileSync(join(root, 'CHANGELOG.md'), changelog);

git('add', 'CHANGELOG.md', ...PACKAGES);
git('commit', '-q', '-m', `Release ${tag}`);
git('tag', '-a', tag, '-m', `Libraria ${next}`);

console.log(`Committed and tagged ${tag}. To publish it:\n\n  git push origin main ${tag}\n`);
