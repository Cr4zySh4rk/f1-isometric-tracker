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

// Index of the centerline point nearest to (x, y). Plain linear scan — the
// centerline is only ~RESAMPLE_POINTS long, so this is cheap even per car per
// frame (20 cars × 700 points). Accepts {x,y} points (Vector2 works too).
export function nearestIndex(pts, x, y) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const dx = pts[i].x - x;
    const dy = pts[i].y - y;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// Smoothed unit tangent (direction of travel) at centerline index `i`, averaged
// over a ±window neighborhood so a single noisy segment can't skew it. The
// centerline is a closed loop, so neighbors wrap. Returns a unit {x,y} pointing
// in the centerline's winding direction (the direction cars drive).
export function smoothedTangent(pts, i, window = 3) {
  const n = pts.length;
  let tx = 0, ty = 0;
  for (let k = 1; k <= window; k++) {
    const a = pts[(i - k + n) % n];
    const b = pts[(i + k) % n];
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    tx += dx / len;
    ty += dy / len;
  }
  const len = Math.hypot(tx, ty) || 1;
  return { x: tx / len, y: ty / len };
}

// Forward-tangent heading (atan2) at the centerline point nearest to (x, y),
// smoothed over ±window points. Same angle convention as a velocity heading
// atan2(dy, dx) in whatever frame `pts` live in.
export function tangentHeadingAt(pts, x, y, window = 3) {
  if (!pts || pts.length < 2) return null;
  const i = nearestIndex(pts, x, y);
  const t = smoothedTangent(pts, i, window);
  return Math.atan2(t.y, t.x);
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

// --- fidelity pipeline (median centerline + adaptive resampling) ------------

// Pointwise-MEDIAN centerline from several laps of the same circuit.
// Each trace is resampled to n points by arc length, circularly aligned to the
// first trace (small phase offsets from differing racing lines / trim points),
// then the per-index median of x and y is taken. The median kills single-lap
// GPS jitter without rounding corners the way heavy smoothing does.
export function medianCenterline(traces, n) {
  const laps = traces
    .filter((t) => Array.isArray(t) && t.length >= 20)
    .map((t) => resampleByArcLength(t, n));
  if (!laps.length) return [];
  if (laps.length === 1) return laps[0];

  const ref = laps[0];
  const aligned = [ref];
  for (let j = 1; j < laps.length; j++) {
    aligned.push(alignCircular(laps[j], ref));
  }
  const out = new Array(n);
  const xs = new Array(aligned.length);
  const ys = new Array(aligned.length);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < aligned.length; j++) {
      xs[j] = aligned[j][i].x;
      ys[j] = aligned[j][i].y;
    }
    out[i] = { x: median(xs.slice()), y: median(ys.slice()) };
  }
  return out;
}

// Circularly shift `pts` so it best matches `ref` (both length n, same
// direction). Searches a small window of index offsets.
export function alignCircular(pts, ref, searchWindow = 12) {
  const n = pts.length;
  const stride = Math.max(1, Math.floor(n / 64)); // subsample the cost function
  let bestOff = 0;
  let bestCost = Infinity;
  for (let off = -searchWindow; off <= searchWindow; off++) {
    let cost = 0;
    for (let i = 0; i < n; i += stride) {
      const p = pts[(i + off + n) % n];
      const r = ref[i];
      cost += (p.x - r.x) ** 2 + (p.y - r.y) ** 2;
    }
    if (cost < bestCost) { bestCost = cost; bestOff = off; }
  }
  if (bestOff === 0) return pts;
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = pts[(i + bestOff + n) % n];
  return out;
}

function median(arr) {
  arr.sort((a, b) => a - b);
  const m = arr.length >> 1;
  return arr.length % 2 ? arr[m] : (arr[m - 1] + arr[m]) / 2;
}

// ADAPTIVE resampling of a closed loop: n points distributed by a curvature-
// weighted arc measure, so chicanes/hairpins get dense points (their true shape
// survives later smoothing) while straights use few. `tension` controls how
// strongly density follows curvature (0 = uniform).
export function resampleAdaptive(pts, n, { tension = 3 } = {}) {
  const m = pts.length;
  if (m < 3) return pts.slice();
  // Smooth the curvature signal a little so weighting is stable against noise.
  const rawCurv = curvature(pts);
  const curv = new Array(m);
  for (let i = 0; i < m; i++) {
    curv[i] = (rawCurv[(i - 1 + m) % m] + rawCurv[i] * 2 + rawCurv[(i + 1) % m]) / 4;
  }
  const maxCurv = Math.max(...curv, 1e-9);

  // Weighted cumulative measure around the closed loop.
  const wcum = new Array(m + 1);
  wcum[0] = 0;
  for (let i = 0; i < m; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % m];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    const c = (curv[i] + curv[(i + 1) % m]) / 2;
    wcum[i + 1] = wcum[i] + seg * (1 + tension * (c / maxCurv));
  }
  const total = wcum[m] || 1;

  const out = new Array(n);
  let j = 1;
  for (let i = 0; i < n; i++) {
    const d = (i / n) * total;
    while (j <= m && wcum[j] < d) j++;
    const k = Math.min(j, m);
    const segW = wcum[k] - wcum[k - 1] || 1;
    const u = (d - wcum[k - 1]) / segW;
    const a = pts[k - 1];
    const b = pts[k % m];
    out[i] = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
  }
  return out;
}

// Curvature-aware Laplacian smoothing of a closed loop: each point relaxes
// toward the midpoint of its neighbors by `lambda`, ATTENUATED where curvature
// is high so tight corners keep their true shape (straights get the full
// de-jitter). Position-preserving (no phase shift), unlike repeated
// Catmull-Rom midpoint passes.
export function smoothAdaptive(pts, { lambda = 0.35, passes = 2, cornerKeep = 0.85 } = {}) {
  let cur = pts;
  for (let p = 0; p < passes; p++) {
    const n = cur.length;
    const curv = curvature(cur);
    const maxCurv = Math.max(...curv, 1e-9);
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = cur[(i - 1 + n) % n];
      const b = cur[i];
      const c = cur[(i + 1) % n];
      const lam = lambda * (1 - cornerKeep * (curv[i] / maxCurv));
      out[i] = {
        x: b.x + ((a.x + c.x) / 2 - b.x) * lam,
        y: b.y + ((a.y + c.y) / 2 - b.y) * lam,
      };
    }
    cur = out;
  }
  return cur;
}

export function syntheticOval(N = 400, a = 8000, b = 5000) {
  const pts = [];
  for (let i = 0; i < N; i++) {
    const th = (i / N) * Math.PI * 2;
    pts.push({ x: a * Math.cos(th), y: b * Math.sin(th) * (0.7 + 0.3 * Math.cos(th * 2)) });
  }
  return pts;
}
