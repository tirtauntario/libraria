/**
 * Tiny pub/sub for "data changed" notifications. Views re-query when a topic
 * they show changes. Changes are also relayed to other tabs of the app.
 */
export type Topic = 'books' | 'progress' | 'bookmarks' | 'libraries' | 'sources' | 'settings' | 'offline';

type Listener = (topics: Set<Topic>) => void;

export class ChangeBus {
  private listeners = new Set<Listener>();
  private channel: BroadcastChannel | null = null;
  private pending = new Set<Topic>();
  private scheduled = false;

  constructor(channelName?: string) {
    if (channelName && typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(channelName);
      this.channel.onmessage = (e: MessageEvent<Topic[]>) => this.dispatch(new Set(e.data));
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Notify listeners. Bursts of emits within one task are coalesced. */
  emit(...topics: Topic[]): void {
    for (const t of topics) this.pending.add(t);
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      const batch = this.pending;
      this.pending = new Set();
      this.scheduled = false;
      this.channel?.postMessage([...batch]);
      this.dispatch(batch);
    });
  }

  private dispatch(topics: Set<Topic>): void {
    for (const l of this.listeners) l(topics);
  }

  close(): void {
    this.channel?.close();
    this.listeners.clear();
  }
}
