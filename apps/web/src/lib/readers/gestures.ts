/**
 * Touch gestures shared by the readers, as Svelte actions.
 */
export const SWIPE_THRESHOLD = 50;
const SWIPE_EARLY = 25;
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 4;
export const ZOOM_STEP = 0.25;

export const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));

export interface SwipeOptions {
  onSwipe: (dir: 'left' | 'right') => void;
  enabled?: boolean;
}

/** Horizontal swipe. Ignored while the content can scroll horizontally (zoomed in). */
export function swipe(node: HTMLElement, options: SwipeOptions) {
  let opts = options;
  let start: { x: number; y: number } | null = null;
  let multi = false;

  const roomX = () => node.scrollWidth > node.clientWidth + 1;

  const onStart = (e: TouchEvent) => {
    if (e.touches.length !== 1) {
      multi = true;
      start = null;
      return;
    }
    multi = false;
    start = { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY };
  };
  const onMove = (e: TouchEvent) => {
    if (!start || e.touches.length !== 1 || opts.enabled === false) return;
    const dx = e.touches[0]!.clientX - start.x;
    const dy = e.touches[0]!.clientY - start.y;
    if (Math.abs(dx) > SWIPE_EARLY && Math.abs(dx) > Math.abs(dy) && !roomX() && e.cancelable) e.preventDefault();
  };
  const onEnd = (e: TouchEvent) => {
    if (!start || multi || opts.enabled === false) {
      start = null;
      return;
    }
    const t = e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    start = null;
    if (Math.abs(dx) >= SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy) * 1.2 && !roomX()) {
      opts.onSwipe(dx < 0 ? 'left' : 'right');
    }
  };

  node.addEventListener('touchstart', onStart, { passive: true });
  node.addEventListener('touchmove', onMove, { passive: false });
  node.addEventListener('touchend', onEnd, { passive: true });
  return {
    update(next: SwipeOptions) {
      opts = next;
    },
    destroy() {
      node.removeEventListener('touchstart', onStart);
      node.removeEventListener('touchmove', onMove);
      node.removeEventListener('touchend', onEnd);
    },
  };
}

export interface PinchOptions {
  getZoom: () => number;
  setZoom: (zoom: number) => void;
}

/** Two-finger pinch and ctrl/⌘ + wheel (trackpad pinch) zoom. */
export function pinch(node: HTMLElement, options: PinchOptions) {
  let opts = options;
  let startDist = 0;
  let startZoom = 1;

  const dist = (e: TouchEvent) => {
    const [a, b] = [e.touches[0]!, e.touches[1]!];
    return Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
  };
  const onStart = (e: TouchEvent) => {
    if (e.touches.length === 2) {
      startDist = dist(e);
      startZoom = opts.getZoom();
    }
  };
  const onMove = (e: TouchEvent) => {
    if (e.touches.length !== 2 || !startDist) return;
    if (e.cancelable) e.preventDefault();
    opts.setZoom(clampZoom((startZoom * dist(e)) / startDist));
  };
  const onEnd = (e: TouchEvent) => {
    if (e.touches.length < 2) startDist = 0;
  };
  const onWheel = (e: WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    opts.setZoom(clampZoom(opts.getZoom() * Math.exp(-e.deltaY / 200)));
  };

  node.addEventListener('touchstart', onStart, { passive: true });
  node.addEventListener('touchmove', onMove, { passive: false });
  node.addEventListener('touchend', onEnd, { passive: true });
  node.addEventListener('wheel', onWheel, { passive: false });
  return {
    update(next: PinchOptions) {
      opts = next;
    },
    destroy() {
      node.removeEventListener('touchstart', onStart);
      node.removeEventListener('touchmove', onMove);
      node.removeEventListener('touchend', onEnd);
      node.removeEventListener('wheel', onWheel);
    },
  };
}

/** Which third of the element a click landed in. */
export function clickZone(e: MouseEvent, el: Element): 'left' | 'middle' | 'right' {
  const rect = el.getBoundingClientRect();
  const x = e.clientX - rect.left;
  if (x < rect.width / 3) return 'left';
  if (x > (rect.width * 2) / 3) return 'right';
  return 'middle';
}

/** Keep the visual centre when zoom changes. */
export function keepCenter(el: HTMLElement, ratio: number): void {
  el.scrollLeft = (el.scrollLeft + el.clientWidth / 2) * ratio - el.clientWidth / 2;
  el.scrollTop = (el.scrollTop + el.clientHeight / 2) * ratio - el.clientHeight / 2;
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

export function toggleFullscreen(el: Element = document.documentElement): void {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  else void el.requestFullscreen?.().catch(() => {});
}
