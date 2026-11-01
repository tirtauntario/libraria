/**
 * Network state. `net.online` is reactive; use it to disable server and
 * remote-source actions while offline. Nothing in the app *requires* the
 * network: reading local and offline books always works.
 */
interface NetworkInformationLike extends EventTarget {
  type?: string;
  effectiveType?: string;
  saveData?: boolean;
}

function connection(): NetworkInformationLike | undefined {
  return typeof navigator !== 'undefined' ? (navigator as Navigator & { connection?: NetworkInformationLike }).connection : undefined;
}

/** Best guess at a metered connection. The Network Information API only exists in Chromium. */
export function isMetered(): boolean {
  const c = connection();
  if (!c) return false;
  return !!c.saveData || c.type === 'cellular' || c.effectiveType === '2g' || c.effectiveType === 'slow-2g';
}

export function isOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine !== false;
}

class NetState {
  online = $state(isOnline());
  metered = $state(isMetered());

  constructor() {
    if (typeof window === 'undefined') return;
    window.addEventListener('online', () => (this.online = true));
    window.addEventListener('offline', () => (this.online = false));
    connection()?.addEventListener('change', () => (this.metered = isMetered()));
  }

  /** Run `fn` the next time the app comes online (immediately if online). */
  whenOnline(fn: () => void): () => void {
    if (this.online) {
      fn();
      return () => {};
    }
    const handler = () => fn();
    window.addEventListener('online', handler, { once: true });
    return () => window.removeEventListener('online', handler);
  }
}

export const net = new NetState();
