/**
 * The app's version, build details and release notes (CHANGELOG.md, bundled
 * at build time), plus the "updated to vX" notice after an update.
 */
import { compareVersions, parseChangelog, UNRELEASED, type ChangelogEntry } from '@libraria/core';
import changelog from '../../../../CHANGELOG.md?raw';
import { toasts } from './stores/toasts.svelte';

export const APP_VERSION = __APP_VERSION__;
export const APP_BUILD = __APP_BUILD__;

/** One line about this build, e.g. "Build 9d74586 · 1 Nov 2026". */
export function buildLabel(build = APP_BUILD, dev = import.meta.env.DEV): string {
  if (dev) return 'Development build';
  const date = new Date(build.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  if (build.release) return `Release · ${date}`;
  const parts = [build.commit ? `Build ${build.commit}` : 'Build', date];
  if (build.dirty) parts.push('local changes');
  return parts.join(' · ');
}

/** Release notes to show: Unreleased only in builds that are not a release. */
export function releaseNotes(build = APP_BUILD, md: string = changelog): ChangelogEntry[] {
  return parseChangelog(md).filter((e) => e.version !== UNRELEASED || !build.release);
}

const SEEN_KEY = 'libraria:version-seen';

/** After an update, say so once, with a link to what changed. */
export function announceUpdate(version = APP_VERSION): void {
  let seen: string | null = null;
  try {
    seen = localStorage.getItem(SEEN_KEY);
    localStorage.setItem(SEEN_KEY, version);
  } catch {
    return;
  }
  if (!seen || seen === version) return;
  let newer = false;
  try {
    newer = compareVersions(version, seen) > 0;
  } catch {
    return;
  }
  if (newer) {
    toasts.show(`Libraria is updated to ${version}.`, {
      kind: 'success',
      action: { label: "What's new", run: () => (location.hash = '#/changelog') },
    });
  }
}
