import { describe, expect, it } from 'vitest';
import { commitDrag, curlGeometry, dragShare, polygonCss, type Point } from '../src/lib/readers/epub/turn';

const W = 400;
const H = 600;

function area(pts: Point[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

describe('page curl geometry', () => {
  it('is a flat page at the start and gone at the end', () => {
    const start = curlGeometry(0, W, H, { rtl: false, corner: 'bottom' });
    expect(area(start.front)).toBeCloseTo(W * H);
    expect(start.flap).toEqual([]);
    const end = curlGeometry(1, W, H, { rtl: false, corner: 'bottom' });
    expect(end.front).toEqual([]);
    // The flap lies entirely left of the page.
    expect(Math.max(...end.flap.map((p) => p.x))).toBeLessThanOrEqual(0.5);
  });

  it('folds paper over without creating or losing any', () => {
    for (const p of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      for (const corner of ['top', 'bottom'] as const) {
        const g = curlGeometry(p, W, H, { rtl: false, corner });
        // The part folded over (flap) is the part no longer flat: front + flap = page.
        expect(area(g.front) + area(g.flap)).toBeCloseTo(W * H, 0);
        expect(g.edge).toBeGreaterThan(g.fold);
      }
    }
  });

  it('turns more of the page as it progresses', () => {
    const shares = [0.2, 0.4, 0.6, 0.8].map((p) => area(curlGeometry(p, W, H, { rtl: false, corner: 'bottom' }).front));
    for (let i = 1; i < shares.length; i++) expect(shares[i]!).toBeLessThan(shares[i - 1]!);
  });

  it('lifts the bottom corner first, so the bottom of the fold is further left', () => {
    const g = curlGeometry(0.3, W, H, { rtl: false, corner: 'bottom' });
    const right = (y: number) => Math.max(...g.front.filter((p) => Math.abs(p.y - y) < 0.01).map((p) => p.x));
    expect(right(H)).toBeLessThan(right(0));
  });

  it('mirrors right-to-left books', () => {
    const ltr = curlGeometry(0.4, W, H, { rtl: false, corner: 'bottom' });
    const rtl = curlGeometry(0.4, W, H, { rtl: true, corner: 'bottom' });
    expect(rtl.front.map((p) => ({ x: W - p.x, y: p.y }))).toEqual(ltr.front);
    expect(rtl.angle).toBeCloseTo(-ltr.angle);
    expect(rtl.fold).toBeCloseTo(ltr.fold);
  });

  it('formats clip-path polygons', () => {
    expect(polygonCss([])).toBe('polygon(0 0, 0 0, 0 0)');
    expect(polygonCss([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5.25 }])).toBe('polygon(0.0px 0.0px, 10.0px 0.0px, 10.0px 5.3px)');
  });
});

describe('dragged page turns', () => {
  it('measures the drag towards the turn', () => {
    expect(dragShare(-100, W, true, false)).toBeCloseTo(0.25);
    expect(dragShare(100, W, true, false)).toBe(0);
    expect(dragShare(100, W, false, false)).toBeCloseTo(0.25);
    expect(dragShare(100, W, true, true)).toBeCloseTo(0.25);
    expect(dragShare(-9999, W, true, false)).toBe(1);
  });

  it('commits long drags and quick flicks', () => {
    expect(commitDrag(0.3, 0)).toBe(true);
    expect(commitDrag(0.1, 0)).toBe(false);
    expect(commitDrag(0.1, 0.5)).toBe(true);
    expect(commitDrag(0.1, -0.5)).toBe(false);
  });
});
