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
  resampleByArcLength, smoothClosed, fitTransform, computeNormals,
  curvature, arcLengths, syntheticOval,
} from './trackMath.js';
import { splitSectorsByLength, SECTOR_COLORS } from '../data/sectors.js';

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
  group.add(buildKerbs(pts, normals, TRACK_WIDTH, disposables));
  group.add(buildWalls(pts, normals, TRACK_WIDTH, disposables));
  const sf = buildStartFinish(pts, normals, TRACK_WIDTH, meta.startIndex || 0, disposables);
  group.add(sf.group);

  const dispose = () => disposeTrack(group, disposables);

  return {
    group,
    transform,
    centerline: pts, // Vector2 in scene space
    centerlineRaw: centerRaw, // {x,y} in provider-world space (for ApproxBuffer arc)
    startFinish: sf.start,
    sectors, // { setColors(['purple',...], lerp?), reset() }
    dispose,
    meta: { ...meta, totalLen, scale, sectorRanges },
  };
}

// --- centerline derivation from location data ------------------------------

async function deriveCenterlineFromData(store, source) {
  const lap = store.fastestLap();
  if (!lap) {
    return { centerline: syntheticOval(), meta: { synthetic: true, startIndex: 0 } };
  }
  const driver = lap.driver_number;
  const t0 = Date.parse(lap.date_start);
  const dur = (lap.lap_duration || 100) * 1000;
  const startISO = new Date(t0 - 3000).toISOString();
  const endISO = new Date(t0 + dur + 3000).toISOString();

  let rows = [];
  try {
    // null => provider has no telemetry (Approximate mode) => synthetic oval.
    rows = await source.getLocationWindow(store.session, startISO, endISO);
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

function buildStartFinish(pts, normals, width, startIndex, disposables) {
  const group = new THREE.Group();
  group.name = 'startfinish';
  const i = startIndex % pts.length;
  const p = pts[i];
  const nm = normals[i];
  const half = width / 2;
  const depth = 2.2;
  const i2 = (i + 1) % pts.length;
  const tx = pts[i2].x - p.x, tz = pts[i2].y - p.y;
  const tlen = Math.hypot(tx, tz) || 1;
  const tux = tx / tlen, tuz = tz / tlen;

  const cols = 8;
  const rows = 4;
  const cellW = width / cols;
  const cellD = depth / rows;
  const Y = 0.09;
  const black = new THREE.MeshStandardMaterial({ color: 0x111417, roughness: 0.6 });
  const white = new THREE.MeshStandardMaterial({ color: 0xf5f5f5, roughness: 0.6 });
  disposables.push(black, white);
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
      disposables.push(geo);
    }
  }
  return { start: p, group };
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
