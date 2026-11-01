/**
 * Reactive "something changed" counters, one per data topic. Views read the
 * counter inside an $effect / $derived so they re-query when it bumps:
 *
 *   $effect(() => { versions.books; void load(); });
 */
import type { ChangeBus, Topic } from '../db/events';

export const versions: Record<Topic, number> = $state({
  books: 0,
  progress: 0,
  bookmarks: 0,
  libraries: 0,
  sources: 0,
  settings: 0,
  offline: 0,
});

export function connectVersions(bus: ChangeBus): () => void {
  return bus.subscribe((topics) => {
    for (const t of topics) versions[t]++;
  });
}
