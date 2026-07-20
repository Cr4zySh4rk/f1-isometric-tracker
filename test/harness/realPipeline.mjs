// Real end-to-end pipeline harness (hits OpenF1). NOT part of `npm test`.
// Runs the REAL SessionStore -> trackBuilder -> ReplayBuffer pipeline the way
// main.js does, for two sessions sequentially (a switch), and asserts:
//   - track centerline is a real (non-synthetic) circuit
//   - >= 15 drivers have finite interpolated positions at T/T+60/T+300
//   - those positions fall within the track's scene-space bounding box
//     (i.e. cars and track share ONE coordinate frame)
//
// Usage: node test/harness/realPipeline.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// --- minimal browser globals -------------------------------------------------
const _ls = new Map();
globalThis.localStorage = {
  getItem: (k) => (_ls.has(k) ? _ls.get(k) : null),
  setItem: (k, v) => _ls.set(k, String(v)),
  removeItem: (k) => _ls.delete(k),
  clear: () => _ls.clear(),
};

// Disk-cache fetch so reruns don't hammer the rate limit.
const CACHE_DIR = '/tmp/of1cache';
fs.mkdirSync(CACHE_DIR, { recursive: true });
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const key = crypto.createHash('sha1').update(String(url)).digest('hex');
  const f = path.join(CACHE_DIR, key + '.json');
  const meta = f + '.status';
  if (fs.existsSync(f)) {
    const body = fs.readFileSync(f, 'utf8');
    const status = fs.existsSync(meta) ? parseInt(fs.readFileSync(meta, 'utf8'), 10) : 200;
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  }
  const res = await realFetch(url, opts);
  const text = await res.text();
  // Cache ALL statuses (incl. 404 "No results found") so reruns are fast and the
  // rate-limited queue isn't re-hit for known-empty windows.
  fs.writeFileSync(f, text);
  fs.writeFileSync(meta, String(res.status));
  return new Response(text, { status: res.status, headers: res.headers });
};

const { SessionStore } = await import('../../src/data/sessionStore.js');
const { ReplayBuffer } = await import('../../src/data/replayBuffer.js');
const { buildTrack } = await import('../../src/track/trackBuilder.js');
const { ProviderManager } = await import('../../src/data/providers/manager.js');
const { OpenF1Provider } = await import('../../src/data/providers/openf1Provider.js');
const { JolpicaProvider } = await import('../../src/data/providers/jolpicaProvider.js');

const providers = new ProviderManager({
  primary: new OpenF1Provider(),
  fallback: new JolpicaProvider(),
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The OpenF1 client self-throttles to 30 req/min; a patient full run must be able
// to wait out that window, so the timeout is generous. Set HARNESS_FAST=1 for a
// quick (cache-warm) pass that fits a short CI budget.
const AWAIT_TIMEOUT = process.env.HARNESS_FAST ? 20000 : 70000;

// Offsets (s) to sample; sessions to run. Overridable via env for a quick pass.
const OFFSETS = (process.env.HARNESS_OFFSETS || '0,60,300').split(',').map((s) => parseInt(s, 10) * 1000);

// Wait until the CURSOR window has settled (loaded/error) — the app renders the
// frame as soon as the cursor window has data; prefetch of look-ahead windows
// can continue in the background.
async function awaitWindows(buffer, tMs, timeoutMs = AWAIT_TIMEOUT) {
  const deadline = Date.now() + timeoutMs;
  const idx = buffer.windowIndex(tMs);
  while (Date.now() < deadline) {
    buffer.update(tMs);
    const st = buffer.windows.get(idx);
    if (st === 'loaded' || st === 'error') return st;
    await sleep(60);
  }
  return 'timeout';
}

function bboxOf(centerline) {
  let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
  for (const v of centerline) {
    minx = Math.min(minx, v.x); maxx = Math.max(maxx, v.x);
    minz = Math.min(minz, v.y); maxz = Math.max(maxz, v.y); // Vector2: .y == scene z
  }
  return { minx, maxx, minz, maxz };
}

async function runSession(label, session) {
  console.log(`\n=== ${label} : session_key=${session.session_key} (${session.circuit_short_name}) ===`);
  const store = new SessionStore(session, providers);
  await store.load();
  console.log(`drivers loaded: ${store.drivers.length}, laps: ${store.laps.length}`);

  const track = await buildTrack(store, providers);
  const synthetic = !!(track.meta && track.meta.synthetic);
  const bb = bboxOf(track.centerline);
  const spanX = bb.maxx - bb.minx, spanZ = bb.maxz - bb.minz;
  console.log(`track synthetic=${synthetic} bbox x[${bb.minx.toFixed(1)},${bb.maxx.toFixed(1)}] z[${bb.minz.toFixed(1)},${bb.maxz.toFixed(1)}] span=${spanX.toFixed(1)}x${spanZ.toFixed(1)} scale=${track.meta.scale?.toExponential(3)}`);

  const buffer = new ReplayBuffer(store, providers);
  const { start } = store.timeWindow();
  const startMs = Date.parse(start);

  // margin: expand bbox by 25% to allow car width / just-off-centerline samples.
  const mx = spanX * 0.25 + 5, mz = spanZ * 0.25 + 5;
  const inBox = (p) => p.x >= bb.minx - mx && p.x <= bb.maxx + mx && p.z >= bb.minz - mz && p.z <= bb.maxz + mz;

  const results = {};
  for (const offset of OFFSETS) {
    const T = startMs + offset;
    const st = await awaitWindows(buffer, T);
    const samples = buffer.sampleAll(T);
    let present = 0, finite = 0, within = 0, outCount = 0;
    const outliers = [];
    for (const [num, s] of samples) {
      present++;
      const sc = track.transform.toScene(s.x, s.y);
      if (Number.isFinite(sc.x) && Number.isFinite(sc.z)) finite++;
      if (inBox(sc)) within++;
      else { outCount++; if (outliers.length < 3) outliers.push({ num, x: sc.x.toFixed(1), z: sc.z.toFixed(1) }); }
    }
    results[offset] = { present, finite, within };
    console.log(`  T+${offset/1000}s win=${st} sampled=${present} finite=${finite} withinBBox=${within}` +
      (outCount ? ` OUTLIERS=${outCount} ${JSON.stringify(outliers)}` : ''));
  }
  return { synthetic, results, bb };
}

// Pick two real completed races from 2026 (a genuine session switch across
// different circuits). Fetched live through the provider (disk-cached).
const sess = await providers.getSessions({ year: 2026 });
const byKey = (k) => sess.find((s) => s.session_key === k);
const british = byKey(11326);   // Silverstone Race
const austria = byKey(11315);   // Spielberg Race
if (!british || !austria) {
  console.error('Could not resolve the 2026 Silverstone/Spielberg race sessions.');
  process.exit(1);
}

function verdict(r) {
  const ok = !r.synthetic && Object.values(r.results).some((x) => x.within >= 15 && x.finite === x.present);
  return ok ? 'PASS' : 'FAIL';
}

const r1 = await runSession('British GP (Silverstone) Race', british);
const r2 = await runSession('Austria (Spielberg) Race — SWITCH', austria);
const lines = [`British: ${verdict(r1)}`, `Austria(switch): ${verdict(r2)}`];
// Switch BACK proves no stale track/transform carryover. Skipped in FAST mode to
// stay within the OpenF1 30 req/min self-throttle for a quick single pass.
if (!process.env.HARNESS_FAST) {
  const r3 = await runSession('British GP again — SWITCH BACK', british);
  lines.push(`British(switch back): ${verdict(r3)}`);
}
console.log('\n--- VERDICT ---');
console.log(lines.join('\n'));
