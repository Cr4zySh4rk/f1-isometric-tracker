// Build track geometry from real telemetry.
//
// Pipeline:
//   1. Pick the fastest complete lap (from the SessionStore).
//   2. Fetch that driver's /location trace spanning the lap.
//   3. Project to 2D, resample by arc length, smooth, close loop (trackMath).
//   4. Build a flat ribbon (split into 3 sector meshes so a focused driver's
//      sector colors can be tinted) + kerbs + checkered start/finish + walls.
//   5. Return a THREE.Group plus a coordinate transform shared with the cars,
//      and a `sectors` controller for per-sector recoloring.
//
// The resampled centerline is cached in localStorage per session_key (tiny).

import * as THREE from 'three';
import { OpenF1Provider } from '../data/providers/openf1Provider.js';
import {
  resampleByArcLength, fitTransform, computeNormals,
  curvature, arcLengths, syntheticOval,
  medianCenterline, resampleAdaptive, smoothAdaptive,
  nearestIndex, smoothedTangent, tangentHeadingAt,
} from './trackMath.js';
import { splitSectorsByLength, SECTOR_COLORS } from '../data/sectors.js';

const SCENE_SIZE = 200; // target max horizontal extent of the track in scene units
const TRACK_WIDTH = 12; // scene units (~ real metres after scaling, roughly)
const RESAMPLE_POINTS = 700;
const WORKING_POINTS = 900; // dense uniform resolution before the adaptive pass
const MEDIAN_LAPS = 5; // aggregate up to this many clean fast laps
// v2: median-of-laps centerline + adaptive resampling (key bump invalidates the
// oversmoothed v1 shapes users may have cached).
// v3: cache now carries meta.startRaw (the real S/F world coordinate) so the
// start/finish line re-anchors to the true lap-start point rather than assuming
// centerline index 0.
const TRACK_CACHE_VERSION = 3;
const LS_KEY = (k) => `f1iso.track.v${TRACK_CACHE_VERSION}.${k}`;

// Public: coordinate transform from OpenF1 world (x,y) to scene (x,z).
//
// ORIENTATION: scene z is the NEGATED world y. Verified against real circuit
// maps (Silverstone / Spielberg / Spa, all driven clockwise): the raw traces
// run clockwise when plotted y-UP, so mapping world +y to scene +z (which the
// top-down camera shows pointing down-screen) rendered every circuit MIRRORED.
// The flip lives here — the one transform shared by track, cars and camera —
// so all consumers stay in a single consistent frame (evidence:
// test/evidence/*_orient.png, scripts/trackDump.mjs).
export function makeTransform(centerRaw, scale) {
  return {
    cx: centerRaw.x,
    cy: centerRaw.y,
    scale,
    toScene(wx, wy) {
      return { x: (wx - centerRaw.x) * scale, z: -(wy - centerRaw.y) * scale };
    },
  };
}

// Main entry. Returns { group, transform, centerline, centerlineRaw, sectors,
// dispose, meta }. `source` supplies location telemetry; when it returns null
// (Approximate mode / no telemetry) the track falls back to a synthetic oval.
export async function buildTrack(store, source) {
  const src = source || new OpenF1Provider();
  const cached = loadCached(store.sessionKey);
  let centerRaw, meta;
  if (cached) {
    centerRaw = cached.centerline;
    meta = cached.meta;
  } else {
    const built = await deriveCenterlineFromData(store, src);
    centerRaw = built.centerline;
    meta = built.meta;
    // Only cache real (telemetry-derived) centerlines — never the synthetic
    // oval, so a later live-mode load rebuilds the real circuit.
    if (!meta.synthetic) saveCached(store.sessionKey, { centerline: centerRaw, meta });
  }

  const { center, scale } = fitTransform(centerRaw, SCENE_SIZE);
  const transform = makeTransform(center, scale);

  // Scene-space centerline as THREE.Vector2.
  const pts = centerRaw.map((p) => {
    const s = transform.toScene(p.x, p.y);
    return new THREE.Vector2(s.x, s.z);
  });

  const group = new THREE.Group();
  group.name = 'track';
  const disposables = [];

  const normals = computeNormals(pts.map((v) => ({ x: v.x, y: v.y })));
  const { cumLen, totalLen } = arcLengths(pts.map((v) => ({ x: v.x, y: v.y })));
  const sectorRanges = splitSectorsByLength(cumLen, totalLen);

  const { group: ribbonGroup, sectors } = buildSectorRibbon(pts, normals, TRACK_WIDTH, sectorRanges, disposables);
  group.add(ribbonGroup);
  // Kerbs and outer walls removed for a cleaner isometric look — the asphalt
  // ribbon alone defines the track.
  // Re-anchor the start/finish line to the real S/F crossing: the median +
  // adaptive resample can shift which centerline index is point 0, so map the
  // true S/F world coordinate (meta.startRaw) to its nearest centerline point.
  let startIndex = meta.startIndex || 0;
  if (meta.startRaw) {
    const s = transform.toScene(meta.startRaw.x, meta.startRaw.y);
    startIndex = nearestIndex(pts.map((v) => ({ x: v.x, y: v.y })), s.x, s.z);
  }
  const sf = buildStartFinish(pts, normals, TRACK_WIDTH, startIndex, disposables);
  group.add(sf.group);

  const dispose = () => disposeTrack(group, disposables);

  return {
    group,
    transform,
    centerline: pts, // Vector2 in scene space
    centerlineRaw: centerRaw, // {x,y} in provider-world space (for ApproxBuffer arc)
    startFinish: sf.start,
    startIndex,
    sectors, // { setColors(['purple',...], lerp?), reset() }
    // Track-tangent heading at an arbitrary provider-world (x,y). Same angle
    // convention as a car's velocity heading (atan2(dy,dx) in OpenF1-world), so
    // callers can feed it through the same model-forward offset. Used to orient
    // stationary/grid cars along the track.
    tangentAt: (x, y) => tangentHeadingAt(centerRaw, x, y, 3),
    dispose,
    meta: { ...meta, totalLen, scale, sectorRanges, startIndex },
  };
}

// --- centerline derivation from location data ------------------------------

// Pick up to `count` clean fast laps for the centerline: plausible flying laps
// (no pit-out, sane duration, within 107% of the session's fastest), preferring
// distinct drivers so per-car GPS bias doesn't survive the median.
export function selectCenterlineLaps(laps, count = MEDIAN_LAPS) {
  const clean = (Array.isArray(laps) ? laps : [])
    .filter((l) => l && l.date_start && typeof l.lap_duration === 'number')
    .filter((l) => l.lap_duration >= 40 && l.lap_duration <= 300 && !l.is_pit_out_lap)
    .sort((a, b) => a.lap_duration - b.lap_duration);
  if (!clean.length) return [];
  const cutoff = clean[0].lap_duration * 1.07;
  const eligible = clean.filter((l) => l.lap_duration <= cutoff);
  const picked = [];
  const drivers = new Set();
  for (const l of eligible) { // distinct drivers first
    if (picked.length >= count) break;
    if (drivers.has(l.driver_number)) continue;
    drivers.add(l.driver_number);
    picked.push(l);
  }
  for (const l of eligible) { // then fill with extra laps from the same drivers
    if (picked.length >= count) break;
    if (!picked.includes(l)) picked.push(l);
  }
  return picked;
}

// Fetch one lap's location trace, trimmed to exactly [date_start, +duration]
// so every lap starts at the start/finish line (this aligns the laps for the
// pointwise median). Returns [{x,y}] or [] on failure.
async function fetchLapTrace(store, source, lap) {
  const driver = lap.driver_number;
  const t0 = Date.parse(lap.date_start);
  const dur = (lap.lap_duration || 100) * 1000;
  const startISO = new Date(t0 - 3000).toISOString();
  const endISO = new Date(t0 + dur + 3000).toISOString();
  let rows = [];
  try {
    // null => provider has no telemetry (Approximate mode).
    rows = await source.getLocationWindow(store.session, startISO, endISO);
  } catch (e) {
    if (e && e.isLiveBlock) throw e;
    rows = [];
  }
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r && r.driver_number === driver && r.x != null && r.y != null)
    .filter((r) => !(r.x === 0 && r.y === 0))
    .map((r) => ({ t: Date.parse(r.date), x: r.x, y: r.y }))
    .filter((r) => !isNaN(r.t) && r.t >= t0 && r.t <= t0 + dur)
    .sort((a, b) => a.t - b.t);
}

// v2 pipeline: 3–5 clean fast laps → per-lap arc-length resample → pointwise
// MEDIAN centerline (kills GPS jitter without rounding corners) → adaptive
// resample (dense where curvature is high) → light curvature-aware smoothing
// (attenuated in corners so chicanes/hairpins keep their true shape).
async function deriveCenterlineFromData(store, source) {
  const laps = selectCenterlineLaps(store.laps);
  if (!laps.length) {
    return { centerline: syntheticOval(), meta: { synthetic: true, startIndex: 0 } };
  }

  const traces = [];
  for (const lap of laps) {
    const t = await fetchLapTrace(store, source, lap);
    if (t.length >= 100) traces.push(t);
    if (!traces.length && lap !== laps[0]) break; // provider has no telemetry
  }

  if (!traces.length || traces[0].length < 20) {
    return { centerline: syntheticOval(), meta: { synthetic: true, startIndex: 0 } };
  }

  const base = traces.length >= 2
    ? medianCenterline(traces, WORKING_POINTS)
    : resampleByArcLength(traces[0], WORKING_POINTS);
  const adaptive = resampleAdaptive(base, RESAMPLE_POINTS, { tension: 3 });
  // Single-lap fallback carries raw jitter → smooth a touch harder.
  const smooth = smoothAdaptive(adaptive, {
    lambda: traces.length >= 2 ? 0.35 : 0.5,
    passes: 2,
    cornerKeep: 0.85,
  });
  // The true start/finish crossing: each lap trace is trimmed to begin at the
  // lap's date_start, i.e. the S/F line, so the first raw sample of the primary
  // trace is the real S/F world coordinate. Kept so the S/F line re-anchors to
  // it (the median/adaptive resample can nudge which centerline index is point 0).
  const startRaw = { x: traces[0][0].x, y: traces[0][0].y };
  return {
    centerline: smooth,
    meta: {
      synthetic: false,
      startIndex: 0,
      startRaw,
      driver: laps[0].driver_number,
      lapsUsed: laps.slice(0, traces.length).map((l) => ({
        driver_number: l.driver_number, lap_number: l.lap_number,
      })),
      version: TRACK_CACHE_VERSION,
    },
  };
}

// --- geometry builders (scene space) ---------------------------------------

// Build the ribbon split into 3 sector meshes so each sector can be tinted.
// Returns { group, sectors } where sectors exposes setColors/reset for the
// focus-mode sector coloring (with smooth lerp toward targets).
function buildSectorRibbon(pts, normals, width, sectorRanges, disposables) {
  const n = pts.length;
  const half = width / 2;
  const Y = 0.05;
  const group = new THREE.Group();
  group.name = 'ribbon';

  const meshes = [];
  const materials = [];
  for (let sec = 0; sec < 3; sec++) {
    const [a, b] = sectorRanges[sec];
    const positions = [];
    const indices = [];
    let vi = 0;
    for (let i = a; i < b; i++) {
      const i0 = i % n;
      const i1 = (i + 1) % n;
      const p0 = pts[i0], p1 = pts[i1];
      const nm0 = normals[i0], nm1 = normals[i1];
      const l0 = { x: p0.x + nm0.x * half, z: p0.y + nm0.y * half };
      const r0 = { x: p0.x - nm0.x * half, z: p0.y - nm0.y * half };
      const l1 = { x: p1.x + nm1.x * half, z: p1.y + nm1.y * half };
      const r1 = { x: p1.x - nm1.x * half, z: p1.y - nm1.y * half };
      positions.push(l0.x, Y, l0.z, r0.x, Y, r0.z, l1.x, Y, l1.z, r1.x, Y, r1.z);
      indices.push(vi, vi + 2, vi + 1, vi + 1, vi + 2, vi + 3);
      vi += 4;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      color: SECTOR_COLORS.none, roughness: 0.95, metalness: 0.0,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.name = `ribbon-sector-${sec}`;
    group.add(mesh);
    meshes.push(mesh);
    materials.push(mat);
    disposables.push(geo, mat);
  }

  // Sector coloring controller with per-frame lerp toward target colors.
  const targets = [
    new THREE.Color(SECTOR_COLORS.none),
    new THREE.Color(SECTOR_COLORS.none),
    new THREE.Color(SECTOR_COLORS.none),
  ];
  const sectors = {
    setColors(colorNames) {
      for (let i = 0; i < 3; i++) {
        const hex = SECTOR_COLORS[colorNames[i]] ?? SECTOR_COLORS.none;
        targets[i].setHex(hex);
      }
    },
    reset() {
      this.setColors(['none', 'none', 'none']);
    },
    // Call each frame; lerp material colors toward targets for smooth transitions.
    tick(alpha = 0.08) {
      for (let i = 0; i < 3; i++) materials[i].color.lerp(targets[i], alpha);
    },
  };

  return { group, sectors };
}

// Kerbs: red/white alternating strips on high-curvature sections.
// Kept for reference but no longer added to the scene (kerbs removed).
// eslint-disable-next-line no-unused-vars
function buildKerbs(pts, normals, width, disposables) {
  const n = pts.length;
  const half = width / 2;
  const kerbW = 1.6;
  const group = new THREE.Group();
  group.name = 'kerbs';

  const curv = curvature(pts.map((v) => ({ x: v.x, y: v.y })));
  const maxCurv = Math.max(...curv, 0.0001);
  const thresh = Math.max(0.03, maxCurv * 0.28);

  const redMat = new THREE.MeshStandardMaterial({ color: 0xd21b1b, roughness: 0.7 });
  const whiteMat = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.7 });
  disposables.push(redMat, whiteMat);

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
    group.add(triMesh(positions.red, redMat, disposables));
    group.add(triMesh(positions.white, whiteMat, disposables));
  }
  return group;
}

// Kept for reference but no longer added to the scene (outer walls removed).
// eslint-disable-next-line no-unused-vars
function buildWalls(pts, normals, width, disposables) {
  const n = pts.length;
  const half = width / 2 + 2.5;
  const wallH = 1.4;
  const group = new THREE.Group();
  group.name = 'walls';
  const mat = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.8, side: THREE.DoubleSide });
  disposables.push(mat);
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
    mesh.receiveShadow = true;
    group.add(mesh);
    disposables.push(geo);
  }
  return group;
}

// Start/finish line. Oriented from a SMOOTHED tangent (averaged over ±3
// centerline points) so it is straight and truly perpendicular to the track
// direction — a single-segment tangent is noisy and skews the line on some
// circuits. The checkerboard spans the full track width (both edges flush with
// the ribbon), sits just above the asphalt (no z-fighting), and carries a thin
// white leading line for legibility in the isometric view.
function buildStartFinish(pts, normals, width, startIndex, disposables) {
  const group = new THREE.Group();
  group.name = 'startfinish';
  const n = pts.length;
  const i = ((startIndex % n) + n) % n;
  const p = pts[i];
  const plain = pts.map((v) => ({ x: v.x, y: v.y }));

  // Forward (along-track) unit vector and the across-track perpendicular, both
  // from the smoothed tangent so the two axes are exactly orthogonal.
  const t = smoothedTangent(plain, i, 3);
  const w = { x: -t.y, y: t.x }; // perpendicular (across the track)

  const half = width / 2;
  const depth = 2.6; // along-track depth of the checkered band
  const cols = 10; // cells across the full width
  const rows = 3; // cells along the depth
  const cellW = width / cols;
  const cellD = depth / rows;
  const Y = 0.06; // just above the asphalt ribbon (Y = 0.05) → no z-fighting

  const blackPos = [];
  const whitePos = [];
  // Quad from across-track span [u0,u1] and along-track span [v0,v1], centered
  // on the S/F point. Pushed as two triangles (wound CCW seen from above).
  const quad = (arr, u0, u1, v0, v1) => {
    const P = (u, v) => [p.x + w.x * u + t.x * v, Y, p.y + w.y * u + t.y * v];
    const a = P(u0, v0), b = P(u1, v0), c = P(u1, v1), d = P(u0, v1);
    arr.push(...a, ...b, ...c, ...a, ...c, ...d);
  };
  for (let cx = 0; cx < cols; cx++) {
    const u0 = -half + cx * cellW;
    const u1 = u0 + cellW;
    for (let r = 0; r < rows; r++) {
      const v0 = -depth / 2 + r * cellD;
      const v1 = v0 + cellD;
      quad((cx + r) % 2 === 0 ? blackPos : whitePos, u0, u1, v0, v1);
    }
  }

  const black = new THREE.MeshStandardMaterial({ color: 0x111417, roughness: 0.65, side: THREE.DoubleSide });
  const white = new THREE.MeshStandardMaterial({ color: 0xf5f5f5, roughness: 0.6, side: THREE.DoubleSide });
  const lineMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, side: THREE.DoubleSide });
  disposables.push(black, white, lineMat);
  group.add(checkerMesh(blackPos, black, disposables));
  group.add(checkerMesh(whitePos, white, disposables));

  // Subtle solid white line along the leading (finish) edge, full width, a hair
  // higher so it reads cleanly over the checker.
  const linePos = [];
  const lineY = Y + 0.01;
  {
    const v1 = depth / 2, v0 = v1 - 0.35;
    const P = (u, v) => [p.x + w.x * u + t.x * v, lineY, p.y + w.y * u + t.y * v];
    const a = P(-half, v0), b = P(half, v0), c = P(half, v1), d = P(-half, v1);
    linePos.push(...a, ...b, ...c, ...a, ...c, ...d);
  }
  group.add(checkerMesh(linePos, lineMat, disposables));

  return { start: p, group };
}

function checkerMesh(positions, mat, disposables) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  disposables.push(geo);
  return mesh;
}

// --- helpers ---------------------------------------------------------------

function triMesh(positions, mat, disposables) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, mat);
  m.receiveShadow = true;
  disposables.push(geo);
  return m;
}

// Dispose all geometries/materials so switching sessions doesn't leak GPU memory.
export function disposeTrack(group, disposables) {
  if (disposables) {
    for (const d of disposables) { try { d.dispose && d.dispose(); } catch { /* ignore */ } }
  }
  group.traverse((o) => {
    if (o.geometry && o.geometry.dispose) o.geometry.dispose();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) { if (m && m.dispose) m.dispose(); }
    }
  });
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
