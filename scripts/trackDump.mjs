// T2 debug/evidence: derive a circuit centerline with BOTH pipelines and dump
// top-view SVGs (exactly the app's top-down orientation) plus length stats
// against the official lap length.
//
//   before = v1: single fastest lap, uniform resample, 2× Catmull-Rom midpoint
//   after  = v2: median of clean laps, adaptive resample, corner-keeping smooth
//
// Usage: node scripts/trackDump.mjs            (Silverstone, Spielberg, Spa)
// Output: test/evidence/<circuit>_{before,after}.svg (+ .json point dumps)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// --- browser shims + disk-cached fetch (same cache as the real harness) -----
const _ls = new Map();
globalThis.localStorage = {
  getItem: (k) => (_ls.has(k) ? _ls.get(k) : null),
  setItem: (k, v) => _ls.set(k, String(v)),
  removeItem: (k) => _ls.delete(k),
  clear: () => _ls.clear(),
};
globalThis.__OF1_QUEUE_OPTS = { perSec: 1000, perMin: 60000 };
const CACHE_DIR = '/tmp/of1cache';
fs.mkdirSync(CACHE_DIR, { recursive: true });
const realFetch = globalThis.fetch;
const _netTimes = [];
async function throttle() {
  for (;;) {
    const now = Date.now();
    while (_netTimes.length && now - _netTimes[0] > 60000) _netTimes.shift();
    if (_netTimes.length < 28 && _netTimes.filter((t) => now - t < 1000).length < 3) {
      _netTimes.push(now);
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}
globalThis.fetch = async (url, opts) => {
  const key = crypto.createHash('sha1').update(String(url)).digest('hex');
  const f = path.join(CACHE_DIR, key + '.json');
  const meta = f + '.status';
  if (fs.existsSync(f)) {
    const status = fs.existsSync(meta) ? parseInt(fs.readFileSync(meta, 'utf8'), 10) : 200;
    return new Response(fs.readFileSync(f, 'utf8'), { status, headers: { 'content-type': 'application/json' } });
  }
  await throttle();
  const res = await realFetch(url, opts);
  const text = await res.text();
  if (res.status === 200 || res.status === 404) {
    fs.writeFileSync(f, text);
    fs.writeFileSync(meta, String(res.status));
  }
  return new Response(text, { status: res.status, headers: res.headers });
};

const { SessionStore } = await import('../src/data/sessionStore.js');
const { OpenF1Provider } = await import('../src/data/providers/openf1Provider.js');
const { buildTrack } = await import('../src/track/trackBuilder.js');
const { resampleByArcLength, smoothClosed, totalPerimeter, smoothedTangent } = await import('../src/track/trackMath.js');
const { fastestLapAt } = await import('../src/data/timing.js');

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'evidence');
fs.mkdirSync(OUT_DIR, { recursive: true });

// session_key, name, official lap length (m)
const CIRCUITS = [
  { key: 11326, name: 'silverstone', official: 5891 },
  { key: 11315, name: 'spielberg', official: 4318 },
  { key: 11334, name: 'spa', official: 7004 },
];

const RAW_TO_M = 0.1; // OpenF1 location x/y are ~1/10 m units

function closedLength(pts) {
  let s = totalPerimeter(pts);
  const a = pts[0], b = pts[pts.length - 1];
  return s + Math.hypot(a.x - b.x, a.y - b.y);
}

// Compute the S/F line + normal for a centerline at index `si`, using the same
// SMOOTHED tangent (±window points) the real S/F builder uses. Returns raw-space
// geometry: the S/F point, the across-track line endpoints (perpendicular to the
// smoothed tangent) and a short tangent (direction-of-travel) arrow. When
// window=1 this reproduces the OLD single-segment tangent for the "before" dump.
function sfGeom(pts, si, halfW, window) {
  const n = pts.length;
  const i = ((si % n) + n) % n;
  const c = pts[i];
  let t;
  if (window <= 1) {
    const a = pts[i], b = pts[(i + 1) % n];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    t = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
  } else {
    t = smoothedTangent(pts, i, window);
  }
  const nm = { x: -t.y, y: t.x }; // across-track
  return {
    c,
    a: { x: c.x + nm.x * halfW, y: c.y + nm.y * halfW },
    b: { x: c.x - nm.x * halfW, y: c.y - nm.y * halfW },
    tip: { x: c.x + t.x * halfW * 1.4, y: c.y + t.y * halfW * 1.4 },
  };
}

// SVG in the app's top-view orientation: screen-x = raw x, screen-y follows the
// scene mapping used by makeTransform/renderer (see trackBuilder.toScene).
function dumpSvg(file, pts, title, sf) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const W = 800;
  const scale = (W - 60) / Math.max(maxX - minX, maxY - minY);
  const H = Math.ceil((maxY - minY) * scale) + 90;
  const px = (p) => (30 + (p.x - minX) * scale).toFixed(1);
  const py = (p) => (60 + (maxY - p.y) * scale).toFixed(1); // raw +y = screen up (see orientation note)
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${px(p)},${py(p)}`).join(' ') + ' Z';
  const marker = sf || { c: pts[0] };
  const sfLine = sf
    ? `<line x1="${px(sf.a)}" y1="${py(sf.a)}" x2="${px(sf.b)}" y2="${py(sf.b)}" stroke="#f5f5f5" stroke-width="4"/>
  <line x1="${px(sf.c)}" y1="${py(sf.c)}" x2="${px(sf.tip)}" y2="${py(sf.tip)}" stroke="#3fb950" stroke-width="3" marker-end="url(#arw)"/>`
    : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs><marker id="arw" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="#3fb950"/></marker></defs>
  <rect width="100%" height="100%" fill="#0d1117"/>
  <text x="20" y="34" fill="#e6edf3" font-family="monospace" font-size="18">${title}</text>
  <path d="${d}" fill="none" stroke="#58a6ff" stroke-width="3" stroke-linejoin="round"/>
  ${sfLine}
  <circle cx="${px(marker.c)}" cy="${py(marker.c)}" r="5" fill="#f85149"/>
  <text x="${px(marker.c)}" y="${(parseFloat(py(marker.c)) - 10).toFixed(1)}" fill="#f85149" font-family="monospace" font-size="12">S/F</text>
</svg>\n`;
  fs.writeFileSync(file, svg);
}

const provider = new OpenF1Provider();

for (const c of CIRCUITS) {
  const store = new SessionStore({ session_key: c.key, session_name: 'Race', session_type: 'Race', date_end: '2000-01-01T00:00:00Z' }, provider);
  await store.load();

  // BEFORE (v1): single fastest lap -> uniform resample -> heavy smoothing.
  const lap = fastestLapAt(store.laps, Infinity);
  const t0 = Date.parse(lap.date_start);
  const dur = (lap.lap_duration || 100) * 1000;
  const rows = await provider.getLocationWindow(store.session, new Date(t0 - 3000).toISOString(), new Date(t0 + dur + 3000).toISOString());
  const trace = rows
    .filter((r) => r.driver_number === lap.driver_number && r.x != null && !(r.x === 0 && r.y === 0))
    .map((r) => ({ t: Date.parse(r.date), x: r.x, y: r.y }))
    .sort((a, b) => a.t - b.t);
  const before = smoothClosed(resampleByArcLength(trace, 600), 2);

  // AFTER (v2): the real app pipeline (median + adaptive), via buildTrack.
  const track = await buildTrack(store, provider);
  const after = track.centerlineRaw;

  const lb = closedLength(before) * RAW_TO_M;
  const la = closedLength(after) * RAW_TO_M;

  // S/F line evidence. Raw across-track half-width from the built scale
  // (TRACK_WIDTH=12 scene units). BEFORE = old single-segment tangent at index 0;
  // AFTER = smoothed tangent (±3) at the re-anchored startIndex.
  const rawHalfW = 6 / track.meta.scale;
  const sfBefore = sfGeom(before, 0, rawHalfW, 1);
  const sfAfter = sfGeom(after, track.startIndex || 0, rawHalfW, 3);
  // SKEW check: how far from truly perpendicular the drawn S/F line sits vs a
  // ROBUST reference track direction (±6-point smoothed tangent) at the same
  // point. 0° = perfectly square across the track. The single-segment tangent
  // (before) is noisy → skewed; the smoothed tangent (after) is square.
  const skewDeg = (pts, si, sf) => {
    const n = pts.length; const i = ((si % n) + n) % n;
    const ref = smoothedTangent(pts, i, 6);
    const lx = sf.a.x - sf.b.x, ly = sf.a.y - sf.b.y; // S/F line direction
    const cos = (lx * ref.x + ly * ref.y) / (Math.hypot(lx, ly) || 1);
    return Math.abs(90 - Math.acos(Math.min(1, Math.abs(cos))) * 180 / Math.PI);
  };
  console.log(`${c.name}: official=${c.official} m  before=${lb.toFixed(0)} m (${(100 * (lb - c.official) / c.official).toFixed(1)}%)  after=${la.toFixed(0)} m (${(100 * (la - c.official) / c.official).toFixed(1)}%)  lapsUsed=${(track.meta.lapsUsed || []).length}  startIndex=${track.startIndex}  S/F skew-from-square: before=${skewDeg(before, 0, sfBefore).toFixed(1)}° after=${skewDeg(after, track.startIndex || 0, sfAfter).toFixed(1)}° (0=perfect)`);

  dumpSvg(path.join(OUT_DIR, `${c.name}_before.svg`), before, `${c.name} BEFORE (v1 single-lap, oversmoothed) ~${lb.toFixed(0)} m`, sfBefore);
  dumpSvg(path.join(OUT_DIR, `${c.name}_after.svg`), after, `${c.name} AFTER (v2 median+adaptive) ~${la.toFixed(0)} m / official ${c.official} m`, sfAfter);
  fs.writeFileSync(path.join(OUT_DIR, `${c.name}_after.json`), JSON.stringify(after));
  fs.writeFileSync(path.join(OUT_DIR, `${c.name}_before.json`), JSON.stringify(before));
  track.dispose();
}
console.log(`SVGs written to ${OUT_DIR}`);
