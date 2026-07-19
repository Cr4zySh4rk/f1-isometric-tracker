// Pure track geometry math on plain {x,y} points — no three.js, no DOM. The
// trackBuilder consumes these and lifts the results into THREE meshes.

import { catmullRom } from '../engine/interp.js';

export function totalPerimeter(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) {
    s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  return s || 1;
}

// Resample a polyline to N points evenly spaced by arc length, closing the loop
// when the endpoints are far apart.
export function resampleByArcLength(trace, n) {
  const pts = trace.map((p) => ({ x: p.x, y: p.y }));
  if (pts.length < 2) return pts;
  const first = pts[0];
  const last = pts[pts.length - 1];
  const gap = Math.hypot(last.x - first.x, last.y - first.y);
  const seg = totalPerimeter(pts) / pts.length;
  if (gap > seg * 3) pts.push({ x: first.x, y: first.y });

  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  const total = cum[cum.length - 1] || 1;
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = (i / n) * total;
    let j = 1;
    while (j < cum.length && cum[j] < d) j++;
    j = Math.min(j, cum.length - 1);
    const segLen = cum[j] - cum[j - 1] || 1;
    const u = (d - cum[j - 1]) / segLen;
    out.push({
      x: pts[j - 1].x + (pts[j].x - pts[j - 1].x) * u,
      y: pts[j - 1].y + (pts[j].y - pts[j - 1].y) * u,
    });
  }
  return out;
}

// Catmull-Rom smoothing over a closed loop, `passes` times.
export function smoothClosed(pts, passes) {
  let cur = pts;
  for (let p = 0; p < passes; p++) {
    const n = cur.length;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const p0 = cur[(i - 1 + n) % n];
      const p1 = cur[i];
      const p2 = cur[(i + 1) % n];
      const p3 = cur[(i + 2) % n];
      out[i] = {
        x: catmullRom(p0.x, p1.x, p2.x, p3.x, 0.5),
        y: catmullRom(p0.y, p1.y, p2.y, p3.y, 0.5),
      };
    }
    cur = out;
  }
  return cur;
}

// Center + uniform scale that fits a raw centerline to a target scene extent.
export function fitTransform(centerRaw, sceneSize) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of centerRaw) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const extent = Math.max(maxX - minX, maxY - minY) || 1;
  return { center: { x: cx, y: cy }, scale: sceneSize / extent };
}

function signedAngle(v1, v2) {
  const dot = v1.x * v2.x + v1.y * v2.y;
  const det = v1.x * v2.y - v1.y * v2.x;
  return Math.atan2(det, dot);
}

// Per-point outward (left) normals for a closed centerline. Returns {x,y}.
export function computeNormals(pts) {
  const n = pts.length;
  const normals = new Array(n);
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const next = pts[(i + 1) % n];
    const tx = next.x - prev.x;
    const ty = next.y - prev.y;
    const len = Math.hypot(tx, ty) || 1;
    normals[i] = { x: -ty / len, y: tx / len };
  }
  return normals;
}

// Per-point curvature (absolute turning angle) around a closed centerline.
export function curvature(pts) {
  const n = pts.length;
  const curv = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n];
    const b = pts[i];
    const c = pts[(i + 1) % n];
    const v1 = { x: b.x - a.x, y: b.y - a.y };
    const v2 = { x: c.x - b.x, y: c.y - b.y };
    curv[i] = Math.abs(signedAngle(v1, v2));
  }
  return curv;
}

// Cumulative arc length per point + total (closed loop) for a scene-space
// centerline of {x,y}.
export function arcLengths(pts) {
  const n = pts.length;
  const cumLen = [0];
  for (let i = 1; i < n; i++) {
    cumLen.push(cumLen[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  const totalLen = cumLen[n - 1] + Math.hypot(pts[0].x - pts[n - 1].x, pts[0].y - pts[n - 1].y);
  return { cumLen, totalLen };
}

export function syntheticOval(N = 400, a = 8000, b = 5000) {
  const pts = [];
  for (let i = 0; i < N; i++) {
    const th = (i / N) * Math.PI * 2;
    pts.push({ x: a * Math.cos(th), y: b * Math.sin(th) * (0.7 + 0.3 * Math.cos(th * 2)) });
  }
  return pts;
}
