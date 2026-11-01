/**
 * Page-turn geometry for the paginated EPUB reader. Pure functions of the
 * turn progress and the page size, so they can be tested without a DOM.
 *
 * Progress `p` runs from 0 (the earlier page lies flat on top) to 1 (it has
 * turned away and the later page shows). Forward turns animate 0 → 1 and
 * backward turns 1 → 0, so the earlier page is always the one that moves.
 */
export interface Point {
  x: number;
  y: number;
}

export type Corner = 'top' | 'bottom';

export interface CurlGeometry {
  /** Visible front of the turning page. Empty once it has turned away. */
  front: Point[];
  /** The folded-over part, showing the back of the sheet. Empty when flat. */
  flap: Point[];
  /** CSS gradient angle (deg) pointing from the fold towards the lifted corner. */
  angle: number;
  /** Fold line and lifted corner, as px offsets along that gradient's line. */
  fold: number;
  edge: number;
}

export const TURN_MS = { slide: 280, curl: 520 } as const;

/** How far the finger must travel (share of the page) to commit a dragged turn. */
const COMMIT_SHARE = 0.25;
/** A flick this fast (px/ms, towards the turn) commits however short it was. */
const FLICK_SPEED = 0.35;

const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;

/** Part of a convex polygon on the side of the line through `m` where `side(dot(x - m, n)) ≥ 0`. */
function clip(poly: Point[], m: Point, n: Point, side: 1 | -1): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const da = side * dot(sub(a, m), n);
    const db = side * dot(sub(b, m), n);
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  // Drop slivers along the line (a page that has just finished turning).
  return out.length >= 3 && area(out) >= 0.5 ? out : [];
}

function area(poly: Point[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

/**
 * A page lifted by one outer corner and folded back over itself. The corner
 * travels to the far side of the spine, rising a little mid-turn, which tilts
 * the fold. The fold is the perpendicular bisector of the corner's start and
 * current position; the lifted part is mirrored across it.
 */
export function curlGeometry(p: number, w: number, h: number, opts: { rtl: boolean; corner: Corner }): CurlGeometry {
  const rect: Point[] = [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ];
  const t = Math.min(1, Math.max(0, p));
  const top = opts.corner === 'top';
  const cy = top ? 0 : h;
  const corner = { x: w, y: cy };
  const lift = Math.min(h * 0.12, w * 0.25) * Math.sin(Math.PI * t);
  let to = { x: w - 2 * w * t, y: top ? lift : h - lift };
  // The spine edge stays put, so the corner can never be further than w from it.
  const spine = { x: 0, y: cy };
  const reach = Math.hypot(to.x - spine.x, to.y - spine.y);
  if (reach > w) to = { x: spine.x + ((to.x - spine.x) * w) / reach, y: spine.y + ((to.y - spine.y) * w) / reach };

  const v = sub(to, corner);
  const len = Math.hypot(v.x, v.y);
  if (len < 0.5) return mirror({ front: rect, flap: [], angle: 270, fold: 0, edge: 0 }, w, opts.rtl);
  const n = { x: v.x / len, y: v.y / len };
  const m = { x: (corner.x + to.x) / 2, y: (corner.y + to.y) / 2 };
  const front = clip(rect, m, n, 1);
  const flap = clip(rect, m, n, -1).map((pt) => {
    const d = 2 * dot(sub(pt, m), n);
    return { x: pt.x - d * n.x, y: pt.y - d * n.y };
  });
  // CSS linear-gradient: the line runs through the centre and is |w·nx| + |h·ny| long.
  const length = Math.abs(w * n.x) + Math.abs(h * n.y);
  const fold = dot(sub(m, { x: w / 2, y: h / 2 }), n) + length / 2;
  const angle = (Math.atan2(n.x, -n.y) * 180) / Math.PI;
  return mirror({ front, flap, angle, fold, edge: fold + len / 2 }, w, opts.rtl);
}

/** Right-to-left books turn from the left edge: mirror horizontally. */
function mirror(g: CurlGeometry, w: number, rtl: boolean): CurlGeometry {
  if (!rtl) return g;
  const flip = (pts: Point[]) => pts.map((pt) => ({ x: w - pt.x, y: pt.y }));
  // Mirroring x keeps offsets along the gradient line; only its angle flips.
  return { ...g, front: flip(g.front), flap: flip(g.flap), angle: -g.angle };
}

export function polygonCss(pts: Point[]): string {
  if (pts.length < 3) return 'polygon(0 0, 0 0, 0 0)';
  return `polygon(${pts.map((pt) => `${pt.x.toFixed(1)}px ${pt.y.toFixed(1)}px`).join(', ')})`;
}

/** Share of the turn (0..1) a horizontal drag of `dx` px covers. */
export function dragShare(dx: number, width: number, forward: boolean, rtl: boolean): number {
  if (width <= 0) return 0;
  // Forward in a left-to-right book means dragging to the left.
  const towards = forward !== rtl ? -dx : dx;
  return Math.min(1, Math.max(0, towards / width));
}

/** Whether a released drag completes the turn. `speed` is px/ms towards the turn. */
export function commitDrag(share: number, speed: number): boolean {
  return share >= COMMIT_SHARE || (speed >= FLICK_SPEED && share > 0.02);
}

export const easeOutCubic = (k: number) => 1 - (1 - k) ** 3;
