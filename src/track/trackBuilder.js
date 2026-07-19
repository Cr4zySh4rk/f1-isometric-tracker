// Build track geometry from real telemetry.
//
// Pipeline:
//   1. Pick the fastest complete lap (from the SessionStore).
//   2. Fetch that driver's /location trace spanning the lap.
//   3. Project to 2D, resample by arc length, smooth (Catmull-Rom), close loop.
//   4. Build a flat ribbon mesh (~track width) + kerbs on high-curvature
//      sections + a checkered start/finish line + low outer walls.
//   5. Return a THREE.Group plus a coordinate transform shared with the cars.
//
// The resampled centerline is cached in localStorage per session_key (tiny).

import * as THREE from 'three';
import { OpenF1 } from '../api/openf1.js';
import { catmullRom } from '../engine/interp.js';

const SCENE_SIZE = 200; // target max horizontal extent of the track in scene units
const TRACK_WIDTH = 12; // scene units (~ real metres after scaling, roughly)
const RESAMPLE_POINTS = 600;
const LS_KEY = (k) => `f1iso.track.${k}`;

// Public: coordinate transform from OpenF1 world (x,y) to scene (x,z).
export function makeTransform(centerRaw, scale) {
  return {
    cx: centerRaw.x,
    cy: centerRaw.y,
    scale,
    toScene(wx, wy) {
      return { x: (wx - centerRaw.x) * scale, z: (wy - centerRaw.y) * scale };
    },
  };
}

// Main entry. Returns { group, transform, centerline, meta }.
export async function buildTrack(store) {
  const cached = loadCached(store.sessionKey);
  let centerRaw, meta;
  if (cached) {
    centerRaw = cached.centerline;
    meta = cached.meta;
  } else {
    const built = await deriveCenterlineFromData(store);
    centerRaw = built.centerline;
    meta = built.meta;
    saveCached(store.sessionKey, { centerline: centerRaw, meta });
  }

  // Compute transform (center + scale) from the raw centerline bbox.
  const { center, scale } = fitTransform(centerRaw);
  const transform = makeTransform(center, scale);

  // Scene-space centerline.
  const pts = centerRaw.map((p) => {
    const s = transform.toScene(p.x, p.y);
    return new THREE.Vector2(s.x, s.z);
  });

  const group = new THREE.Group();
  group.name = 'track';

  const { ribbon, normals, cumLen, totalLen } = buildRibbon(pts, TRACK_WIDTH);
  group.add(ribbon);
  group.add(buildKerbs(pts, normals, TRACK_WIDTH));
  group.add(buildWalls(pts, normals, TRACK_WIDTH));
  const sf = buildStartFinish(pts, normals, TRACK_WIDTH, meta.startIndex || 0);
  group.add(sf.group);

  return {
    group,
    transform,
    centerline: pts, // Vector2 in scene space
    startFinish: sf.start,
    meta: { ...meta, totalLen, scale },
  };
}

// --- centerline derivation from location data ------------------------------

async function deriveCenterlineFromData(store) {
  const lap = store.fastestLap();
  if (!lap) {
    // No usable lap → synthesize a generic oval so the app still renders.
    return { centerline: syntheticOval(), meta: { synthetic: true, startIndex: 0 } };
  }
  const driver = lap.driver_number;
  const t0 = Date.parse(lap.date_start);
  const dur = (lap.lap_duration || 100) * 1000;
  // Pad the window a little each side.
  const startISO = new Date(t0 - 3000).toISOString();
  const endISO = new Date(t0 + dur + 3000).toISOString();

  let rows = [];
  try {
    rows = await OpenF1.location(store.sessionKey, startISO, endISO);
  } catch (e) {
    if (e && e.isLiveBlock) throw e;
    rows = [];
  }

  const trace = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && r.driver_number === driver && r.x != null && r.y != null)
    .filter((r) => !(r.x === 0 && r.y === 0))
    .map((r) => ({ t: Date.parse(r.date), x: r.x, y: r.y }))
    .filter((r) => !isNaN(r.t))
    .sort((a, b) => a.t - b.t);

  if (trace.length < 20) {
    return { centerline: syntheticOval(), meta: { synthetic: true, startIndex: 0 } };
  }

  const resampled = resampleByArcLength(trace, RESAMPLE_POINTS);
  const smooth = smoothClosed(resampled, 2);
  return { centerline: smooth, meta: { synthetic: false, startIndex: 0, driver } };
}

// Resample a polyline to N points evenly spaced by arc length, closing the loop.
function resampleByArcLength(trace, n) {
  const pts = trace.map((p) => ({ x: p.x, y: p.y }));
  // Ensure the loop is closed: append the first point if far from the last.
  const first = pts[0], last = pts[pts.length - 1];
  const gap = Math.hypot(last.x - first.x, last.y - first.y);
  const seg = totalPerimeter(pts) / pts.length;
  if (gap > seg * 3) pts.push({ x: first.x, y: first.y });

  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  const total = cum[cum.length - 1];
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
function smoothClosed(pts, passes) {
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

function totalPerimeter(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return s || 1;
}

function fitTransform(centerRaw) {
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
  const scale = SCENE_SIZE / extent;
  return { center: { x: cx, y: cy }, scale };
}

// --- geometry builders (scene space) ---------------------------------------

// Compute per-point outward normals for a closed centerline.
function computeNormals(pts) {
  const n = pts.length;
  const normals = new Array(n);
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const next = pts[(i + 1) % n];
    const tx = next.x - prev.x;
    const ty = next.y - prev.y;
    const len = Math.hypot(tx, ty) || 1;
    // Left normal of the tangent.
    normals[i] = new THREE.Vector2(-ty / len, tx / len);
  }
  return normals;
}

function buildRibbon(pts, width) {
  const n = pts.length;
  const normals = computeNormals(pts);
  const half = width / 2;
  const positions = [];
  const uvs = [];
  const cumLen = [0];
  for (let i = 1; i < n; i++) {
    cumLen.push(cumLen[i - 1] + pts[i].distanceTo(pts[i - 1]));
  }
  const totalLen = cumLen[n - 1] + pts[0].distanceTo(pts[n - 1]);

  // Two vertices per station (left/right), y slightly above ground.
  const Y = 0.05;
  for (let i = 0; i <= n; i++) {
    const idx = i % n;
    const p = pts[idx];
    const nm = normals[idx];
    const l = { x: p.x + nm.x * half, z: p.y + nm.y * half };
    const r = { x: p.x - nm.x * half, z: p.y - nm.y * half };
    positions.push(l.x, Y, l.z, r.x, Y, r.z);
    const v = (i / n);
    uvs.push(0, v, 1, v);
  }
  const indices = [];
  for (let i = 0; i < n; i++) {
    const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
    indices.push(a, c, b, b, c, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    color: 0x2b2f36,
    roughness: 0.95,
    metalness: 0.0,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'ribbon';
  return { ribbon: mesh, normals, cumLen, totalLen };
}

// Kerbs: red/white alternating strips on the outer & inner edges of
// high-curvature sections.
function buildKerbs(pts, normals, width) {
  const n = pts.length;
  const half = width / 2;
  const kerbW = 1.6;
  const group = new THREE.Group();
  group.name = 'kerbs';

  // Curvature estimate via turning angle.
  const curv = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n];
    const b = pts[i];
    const c = pts[(i + 1) % n];
    const v1 = new THREE.Vector2(b.x - a.x, b.y - a.y);
    const v2 = new THREE.Vector2(c.x - b.x, c.y - b.y);
    const ang = Math.abs(signedAngle(v1, v2));
    curv[i] = ang;
  }
  const maxCurv = Math.max(...curv, 0.0001);
  const thresh = Math.max(0.03, maxCurv * 0.28);

  const redMat = new THREE.MeshStandardMaterial({ color: 0xd21b1b, roughness: 0.7 });
  const whiteMat = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.7 });

  let stripe = 0;
  for (let side = -1; side <= 1; side += 2) {
    const positions = { red: [], white: [] };
    for (let i = 0; i < n; i++) {
      if (curv[i] < thresh) continue;
      const i2 = (i + 1) % n;
      const inner = half * side;
      const outer = (half + kerbW) * side;
      const p0 = pts[i], p1 = pts[i2];
      const nm0 = normals[i], nm1 = normals[i2];
      const Y = 0.07;
      const a = { x: p0.x + nm0.x * inner, z: p0.y + nm0.y * inner };
      const b = { x: p0.x + nm0.x * outer, z: p0.y + nm0.y * outer };
      const c = { x: p1.x + nm1.x * inner, z: p1.y + nm1.y * inner };
      const d = { x: p1.x + nm1.x * outer, z: p1.y + nm1.y * outer };
      const tgt = (Math.floor(i / 2) % 2 === 0) ? positions.red : positions.white;
      tgt.push(a.x, Y, a.z, c.x, Y, c.z, b.x, Y, b.z);
      tgt.push(b.x, Y, b.z, c.x, Y, c.z, d.x, Y, d.z);
    }
    group.add(triMesh(positions.red, redMat));
    group.add(triMesh(positions.white, whiteMat));
  }
  return group;
}

function buildWalls(pts, normals, width) {
  const n = pts.length;
  const half = width / 2 + 2.5;
  const wallH = 1.4;
  const group = new THREE.Group();
  group.name = 'walls';
  const mat = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.8, side: THREE.DoubleSide });
  for (let side = -1; side <= 1; side += 2) {
    const positions = [];
    for (let i = 0; i <= n; i++) {
      const idx = i % n;
      const p = pts[idx], nm = normals[idx];
      const off = half * side;
      const x = p.x + nm.x * off, z = p.y + nm.y * off;
      positions.push(x, 0, z, x, wallH, z);
    }
    const indices = [];
    for (let i = 0; i < n; i++) {
      const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
      indices.push(a, c, b, b, c, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

function buildStartFinish(pts, normals, width, startIndex) {
  const group = new THREE.Group();
  group.name = 'startfinish';
  const i = startIndex % pts.length;
  const p = pts[i];
  const nm = normals[i];
  const half = width / 2;
  const depth = 2.2;
  // Tangent direction.
  const i2 = (i + 1) % pts.length;
  const tx = pts[i2].x - p.x, tz = pts[i2].y - p.y;
  const tlen = Math.hypot(tx, tz) || 1;
  const tux = tx / tlen, tuz = tz / tlen;

  const cols = 8;
  const rows = 4;
  const cellW = (width) / cols;
  const cellD = depth / rows;
  const Y = 0.09;
  const black = new THREE.MeshStandardMaterial({ color: 0x111417, roughness: 0.6 });
  const white = new THREE.MeshStandardMaterial({ color: 0xf5f5f5, roughness: 0.6 });
  const baseX = p.x + nm.x * half - tux * (depth / 2);
  const baseZ = p.y + nm.y * half - tuz * (depth / 2);
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const mat = (c + r) % 2 === 0 ? black : white;
      const geo = new THREE.PlaneGeometry(cellW, cellD);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      const acx = baseX - nm.x * (c * cellW) + tux * (r * cellD);
      const acz = baseZ - nm.y * (c * cellW) + tuz * (r * cellD);
      mesh.position.set(acx + nm.x * cellW / 2, Y, acz + nm.y * cellW / 2);
      mesh.rotation.z = Math.atan2(tuz, tux);
      group.add(mesh);
    }
  }
  return { start: p, group };
}

// --- helpers ---------------------------------------------------------------

function triMesh(positions, mat) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, mat);
  m.receiveShadow = true;
  return m;
}

function signedAngle(v1, v2) {
  const dot = v1.x * v2.x + v1.y * v2.y;
  const det = v1.x * v2.y - v1.y * v2.x;
  return Math.atan2(det, dot);
}

function syntheticOval() {
  const pts = [];
  const N = 400;
  const a = 8000, b = 5000;
  for (let i = 0; i < N; i++) {
    const th = (i / N) * Math.PI * 2;
    pts.push({ x: a * Math.cos(th), y: b * Math.sin(th) * (0.7 + 0.3 * Math.cos(th * 2)) });
  }
  return pts;
}

// --- localStorage cache ----------------------------------------------------

function loadCached(sessionKey) {
  try {
    const raw = localStorage.getItem(LS_KEY(sessionKey));
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (obj && Array.isArray(obj.centerline) && obj.centerline.length > 10) return obj;
  } catch { /* ignore */ }
  return null;
}

function saveCached(sessionKey, data) {
  try {
    localStorage.setItem(LS_KEY(sessionKey), JSON.stringify(data));
  } catch { /* ignore */ }
}

// buildStartFinish returns {start, group}; buildTrack expects .group added. Fix
// by normalizing here since we used it inline above.
