import type { Role, SubmissionStatus } from '@libraria/core';
import { settings } from '../../lib/stores/settings.svelte';

/** Shown in the server's session list. */
export function deviceName(): string {
  if (settings.device.deviceName) return settings.device.deviceName;
  if (typeof navigator === 'undefined') return 'Libraria';
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

export function normalizeUsername(u: string): string {
  return u.trim().toLowerCase();
}

export const USERNAME_HINT = '3–32 characters: a–z, 0–9, _ . -';
export const USERNAME_PATTERN = '[A-Za-z0-9_.\\-]{3,32}';

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export const ROLE_LABEL: Record<Role, string> = { owner: 'Owner', curator: 'Curator', member: 'Member' };

export const SUBMISSION_LABEL: Record<SubmissionStatus, string> = {
  uploading: 'Uploading',
  pending: 'Waiting for review',
  approved: 'Approved',
  rejected: 'Rejected',
};
