export interface Groupable {
  title: string;
  series?: string | null;
  customGroup?: string | null;
  lastReadAt?: number | null;
}

export interface BookGroup<T extends Groupable> {
  key: string;
  name: string;
  isSeries: boolean;
  items: T[];
}

// First volume/chapter keyword followed by a digit. Non-greedy so we keep
// everything before the indicator.
const KEYWORD_RE =
  /^(.*?)[\s_-]+(?:v(?:ol(?:ume)?)?|ch(?:apter)?|c(?=\d)|part|episode|ep|tome|book)\.?\s*\d/i;
const HASH_RE = /^(.*?)[\s_-]*#\s*\d/;
const BARE_NUMBER_RE = /[\s_-]+\d+[\w.-]*$/;

export function extractSeriesName(title: string): string {
  const kw = KEYWORD_RE.exec(title);
  if (kw?.[1]?.trim()) return kw[1].trim().replace(/[\s_-]+$/, '');

  const hm = HASH_RE.exec(title);
  if (hm?.[1]?.trim()) return hm[1].trim().replace(/[\s_-]+$/, '');

  const stripped = title.replace(BARE_NUMBER_RE, '').trim();
  if (stripped.length > 0 && stripped !== title.trim()) return stripped;

  return title;
}

export function groupKey(item: Groupable): string {
  return item.customGroup || item.series || extractSeriesName(item.title);
}

/**
 * Group already-sorted items by series. Order of items inside a group is kept.
 * With sortBy 'lastRead', groups are ordered by their most recently read item.
 */
export function groupBooks<T extends Groupable>(
  sorted: T[],
  sortBy: 'name' | 'lastRead' | 'added',
  renames?: Record<string, string>,
): BookGroup<T>[] {
  const map = new Map<string, T[]>();
  for (const item of sorted) {
    const key = groupKey(item);
    const list = map.get(key);
    if (list) list.push(item);
    else map.set(key, [item]);
  }
  const groups = Array.from(map, ([key, items]) => ({
    key,
    name: renames?.[key] ?? key,
    isSeries: items.length >= 2,
    items,
  }));
  if (sortBy === 'lastRead') {
    const latest = (g: BookGroup<T>) => Math.max(0, ...g.items.map((i) => i.lastReadAt ?? 0));
    groups.sort((a, b) => latest(b) - latest(a));
  }
  return groups;
}
