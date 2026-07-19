import { describe, it, expect } from 'vitest';
import {
  resampleByArcLength, smoothClosed, fitTransform, computeNormals,
  curvature, arcLengths, totalPerimeter, syntheticOval,
} from '../src/track/trackMath.js';
import trace from './fixtures/location_trace.json';

function circle(n, r = 1) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const th = (i / n) * Math.PI * 2;
    pts.push({ x: r * Math.cos(th), y: r * Math.sin(th) });
  }
  return pts;
}

describe('trackMath resample/closure', () => {
  it('resamples a fixture trace to N evenly-spaced points', () => {
    const pts = resampleByArcLength(trace, 200);
    expect(pts.length).toBe(200);
    // Even arc-length spacing: segment lengths should be near-uniform.
    let min = Infinity, max = -Infinity;
    for (let i = 1; i < pts.length; i++) {
      const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      min = Math.min(min, d); max = Math.max(max, d);
    }
    expect(max / min).toBeLessThan(1.6);
  });

  it('closes the loop (last point near the first)', () => {
    const pts = resampleByArcLength(trace, 120);
    const total = totalPerimeter(pts);
    const gap = Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y);
    expect(gap).toBeLessThan(total / 20);
  });

  it('smoothing preserves point count and stays near the ring', () => {
    const c = circle(60, 100);
    const sm = smoothClosed(c, 2);
    expect(sm.length).toBe(60);
    for (const p of sm) {
      const r = Math.hypot(p.x, p.y);
      expect(r).toBeGreaterThan(80);
      expect(r).toBeLessThan(105);
    }
  });
});

describe('trackMath geometry', () => {
  it('fits a transform centered on the bbox with the right scale', () => {
    const { center, scale } = fitTransform(trace, 200);
    expect(center.x).toBeCloseTo(500, 0);
    expect(center.y).toBeCloseTo(-200, 0);
    // ellipse extent is 6000 (2a); scale maps it to 200 scene units
    expect(scale).toBeCloseTo(200 / 6000, 6);
  });

  it('computes unit outward normals', () => {
    const c = circle(40, 10);
    const nms = computeNormals(c);
    expect(nms.length).toBe(40);
    for (const n of nms) expect(Math.hypot(n.x, n.y)).toBeCloseTo(1, 6);
  });

  it('curvature is ~uniform on a circle and ~0 on a straight line', () => {
    const c = circle(80, 50);
    const cu = curvature(c);
    const avg = cu.reduce((a, b) => a + b, 0) / cu.length;
    expect(avg).toBeGreaterThan(0);
    for (const k of cu) expect(Math.abs(k - avg)).toBeLessThan(avg * 0.5 + 1e-6);

    const line = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }];
    const straight = curvature(line);
    // interior points have zero turning angle
    expect(straight[1]).toBeCloseTo(0, 9);
    expect(straight[2]).toBeCloseTo(0, 9);
  });

  it('arc lengths increase monotonically and total is positive', () => {
    const c = circle(50, 10);
    const { cumLen, totalLen } = arcLengths(c);
    expect(cumLen[0]).toBe(0);
    for (let i = 1; i < cumLen.length; i++) expect(cumLen[i]).toBeGreaterThan(cumLen[i - 1]);
    expect(totalLen).toBeGreaterThan(cumLen[cumLen.length - 1]);
  });

  it('generates a synthetic oval fallback', () => {
    const o = syntheticOval();
    expect(o.length).toBeGreaterThan(100);
  });
});
