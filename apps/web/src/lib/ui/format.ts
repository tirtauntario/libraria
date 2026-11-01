import type { BookFormat } from '@libraria/core';

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatPercent(fraction: number | null | undefined): string {
  if (fraction == null) return '';
  return `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
}

const rtf = typeof Intl !== 'undefined' ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }) : null;

export function formatRelative(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return 'Never';
  const diff = (ms - now) / 1000;
  const abs = Math.abs(diff);
  if (!rtf) return new Date(ms).toLocaleDateString();
  if (abs < 60) return 'Just now';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), 'day');
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export const FORMAT_LABEL: Record<BookFormat, string> = { cbz: 'CBZ', cbr: 'CBR', epub: 'EPUB', pdf: 'PDF' };

export function plural(n: number, word: string, pluralWord = word + 's'): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}
