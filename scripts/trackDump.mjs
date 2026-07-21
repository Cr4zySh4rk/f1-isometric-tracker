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
const { resampleByArcLength, smoothClosed, totalPerimeter } = await import('../src/track/trackMath.js');
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

// SVG in the app's top-view orientation: screen-x = raw x, screen-y follows the
// scene mapping used by makeTransform/renderer (see trackBuilder.toScene).
function dumpSvg(file, pts, title) {
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
  const sf = pts[0];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="100%" height="100%" fill="#0d1117"/>
  <text x="20" y="34" fill="#e6edf3" font-family="monospace" font-size="18">${title}</text>
  <path d="${d}" fill="none" stroke="#58a6ff" stroke-width="3" stroke-linejoin="round"/>
  <circle cx="${px(sf)}" cy="${py(sf)}" r="6" fill="#f85149"/>
  <text x="${px(sf)}" y="${(parseFloat(py(sf)) - 10).toFixed(1)}" fill="#f85149" font-family="monospace" font-size="12">S/F</text>
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
  console.log(`${c.name}: official=${c.official} m  before=${lb.toFixed(0)} m (${(100 * (lb - c.official) / c.official).toFixed(1)}%)  after=${la.toFixed(0)} m (${(100 * (la - c.official) / c.official).toFixed(1)}%)  lapsUsed=${(track.meta.lapsUsed || []).length}`);

  dumpSvg(path.join(OUT_DIR, `${c.name}_before.svg`), before, `${c.name} BEFORE (v1 single-lap, oversmoothed) ~${lb.toFixed(0)} m`);
  dumpSvg(path.join(OUT_DIR, `${c.name}_after.svg`), after, `${c.name} AFTER (v2 median+adaptive) ~${la.toFixed(0)} m / official ${c.official} m`);
  fs.writeFileSync(path.join(OUT_DIR, `${c.name}_after.json`), JSON.stringify(after));
  fs.writeFileSync(path.join(OUT_DIR, `${c.name}_before.json`), JSON.stringify(before));
  track.dispose();
}
console.log(`SVGs written to ${OUT_DIR}`);
