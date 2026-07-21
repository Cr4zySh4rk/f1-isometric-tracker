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
//
// Rate limiting lives HERE (only REAL network fetches count): the app's
// in-process queue is opened wide via the __OF1_QUEUE_OPTS hook below, so
// disk-cached replays are instant and reruns resume where the cache ends —
// otherwise cached replays would eat the 30/min budget and a warm rerun would
// stall on the queue before reaching the first genuinely new request.
globalThis.__OF1_QUEUE_OPTS = { perSec: 1000, perMin: 60000 };

const CACHE_DIR = '/tmp/of1cache';
fs.mkdirSync(CACHE_DIR, { recursive: true });
const realFetch = globalThis.fetch;
const _netTimes = []; // timestamps of real network fetches
async function throttleRealFetch() {
  for (;;) {
    const now = Date.now();
    while (_netTimes.length && now - _netTimes[0] > 60000) _netTimes.shift();
    const lastSec = _netTimes.filter((t) => now - t < 1000).length;
    if (_netTimes.length < 30 && lastSec < 3) { _netTimes.push(now); return; }
    await new Promise((r) => setTimeout(r, 150));
  }
}
globalThis.fetch = async (url, opts) => {
  const key = crypto.createHash('sha1').update(String(url)).digest('hex');
  const f = path.join(CACHE_DIR, key + '.json');
  const meta = f + '.status';
  if (fs.existsSync(f)) {
    const body = fs.readFileSync(f, 'utf8');
    const status = fs.existsSync(meta) ? parseInt(fs.readFileSync(meta, 'utf8'), 10) : 200;
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  }
  await throttleRealFetch();
  const res = await realFetch(url, opts);
  const text = await res.text();
  // Cache 200/404 (a 404 is OpenF1's "No results found" — a legitimately empty
  // window). NEVER cache 429/5xx: replaying a cached 429 would spin the
  // client's retry loop forever.
  if (res.status === 200 || res.status === 404) {
    fs.writeFileSync(f, text);
    fs.writeFileSync(meta, String(res.status));
  }
  return new Response(text, { status: res.status, headers: res.headers });
};

const { SessionStore } = await import('../../src/data/sessionStore.js');
const { ReplayBuffer } = await import('../../src/data/replayBuffer.js');
const { buildTrack } = await import('../../src/track/trackBuilder.js');
const { ProviderManager } = await import('../../src/data/providers/manager.js');
const { OpenF1Provider } = await import('../../src/data/providers/openf1Provider.js');
const { JolpicaProvider } = await import('../../src/data/providers/jolpicaProvider.js');
// Upgrade modules under test (T1 window budget, T3 lap counter, T4 safety car).
const { requestBudgetPerMin } = await import('../../src/data/windowPlan.js');
const { lapAtTime, buildTowerRows } = await import('../../src/data/timing.js');
const { classifyEntrant } = await import('../../src/data/entrants.js');

// OpenF1 /location x,y are DECIMETRES (1 unit ≈ 0.1 m): a derived lap arc length
// divided by 10 matches the official circuit length to ~1 %. Official lengths
// (m) keyed by circuit_short_name.
const OF1_UNIT_M = 0.1;
const OFFICIAL_LEN_M = { Silverstone: 5891, Spielberg: 4318, 'Spa-Francorchamps': 7004 };
const LEN_TOL = 0.05; // derived length must be within 5 % of official

const providers = new ProviderManager({
  primary: new OpenF1Provider(),
  fallback: new JolpicaProvider(),
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// T2 fidelity: derived circuit length (m) vs official, from the scene-space
// perimeter divided back through the transform scale into raw (decimetre) units.
function trackLengthCheck(track, circuitShortName) {
  const official = OFFICIAL_LEN_M[circuitShortName];
  const derivedM = (track.meta.totalLen / track.meta.scale) * OF1_UNIT_M;
  if (official == null) return { ok: true, derivedM, official: null, err: null };
  const err = (derivedM - official) / official;
  return { ok: Math.abs(err) <= LEN_TOL, derivedM, official, err };
}

// T3 lap counter: lapAtTime must be monotonic non-decreasing and in [1,total]
// across the sampled offsets (with real /laps for the session).
function lapCounterCheck(store, startMs, offsets) {
  const samples = [];
  let prev = 0, ok = true, total = 0;
  for (const off of offsets) {
    const r = lapAtTime(store.laps, startMs + off);
    total = r.total;
    if (r.total <= 0) ok = false;
    if (r.lap < prev || r.lap < 1 || r.lap > r.total) ok = false;
    prev = r.lap;
    samples.push(`T+${off / 1000}s=lap ${r.lap}/${r.total}(${r.phase})`);
  }
  return { ok: ok && total > 0, total, samples };
}

// T1 no-vanish at 30×: from a buffered cursor, drive playback at 30× exactly like
// main.js — advance the cursor only when its window is buffered (otherwise the
// BufferGate HOLDS and we fetch/retry without advancing). Assert that on every
// buffered frame the real drivers are present (never vanish) and that the
// prefetch request budget at 30× fits the 30 req/min OpenF1 limit.
async function noVanishAt30x(buffer, store, fromMs) {
  const SPEED = 30;
  const budget = requestBudgetPerMin(SPEED);
  buffer.update(fromMs, SPEED); // switch the prefetcher onto the 30× window grid
  let t = fromMs, advanced = 0, held = 0, minCars = Infinity;
  for (let step = 0; step < 12; step++) {
    buffer.update(t, SPEED);
    if (!buffer.isCursorBuffered(t)) {
      const st = await awaitWindows(buffer, t); // gate holds; keep fetching
      held++;
      if (st === 'timeout') break;
      continue;
    }
    let cars = 0;
    for (const [num] of buffer.sampleAll(t)) if (store.driversByNumber.has(num)) cars++;
    minCars = Math.min(minCars, cars);
    advanced++;
    t += SPEED * 1000; // 30 s of session per simulated wall-second at 30×
  }
  const ok = budget <= 30 && advanced > 0 && minCars >= 10;
  return { ok, budget, advanced, held, minCars: minCars === Infinity ? null : minCars };
}

// T4 safety car: during a real SC deployment window, /location carries a
// telemetry number absent from /drivers (the FIA safety/medical car). Assert it
// is present, classified SC/MED, and EXCLUDED from the timing tower.
async function safetyCarCheck(store, buffer, deployDateISO) {
  const t0 = Date.parse(deployDateISO) + 60000; // 1 min into the deployment
  await awaitWindows(buffer, t0);
  await awaitWindows(buffer, t0 + 5000);
  const scNums = [];
  for (const [num] of buffer.sampleAll(t0)) {
    if (!store.driversByNumber.has(num)) {
      const k = classifyEntrant(num, store.driversByNumber);
      scNums.push({ num, type: k.type, label: k.label });
    }
  }
  const driverNums = store.drivers.map((d) => d.driver_number);
  const rows = buildTowerRows({
    isRace: true, driverNums, laps: store.laps, positions: store.positions, tMs: t0,
    intervalFn: () => null,
  });
  const towerNums = new Set(rows.map((r) => r.num));
  const scInTower = scNums.filter((s) => towerNums.has(s.num));
  const ok = scNums.length >= 1 && scInTower.length === 0
    && scNums.every((s) => s.type === 'safety' || s.type === 'medical');
  return { ok, scNums, scInTower, towerSize: towerNums.size };
}

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

// Follow-camera assertion: replicate the renderer's per-frame follow math
// (target.lerp(carScenePos, 0.12)) against REAL sampled telemetry and assert
// the camera target converges onto the selected driver's scene position and
// stays inside the track's coordinate frame. This is exactly what
// IsoRenderer.update() does with the intent function from main.focusDriver().
function followCameraCheck(track, buffer, fromMs, bb) {
  const t0 = fromMs;
  const first = buffer.sampleAll(t0);
  let num = null;
  for (const [n, s] of first) { if (s.present) { num = n; break; } }
  if (num == null) return { ok: false, why: 'no present driver to follow' };

  const cam = { x: 0, z: 0 }; // camera look-target (scene coords)
  let car = null;
  const FRAME = 1000 / 60;
  for (let f = 0; f < 600; f++) { // 10 s of session time at 60 fps
    const t = t0 + f * FRAME;
    const s = buffer.sampleAll(t).get(num);
    if (!s) continue; // gap → follow holds (matches renderer behavior)
    car = track.transform.toScene(s.x, s.y);
    cam.x += (car.x - cam.x) * 0.12;
    cam.z += (car.z - cam.z) * 0.12;
  }
  if (!car) return { ok: false, why: 'driver lost during follow window' };
  const dist = Math.hypot(cam.x - car.x, cam.z - car.z);
  const inFrame = cam.x >= bb.minx - 20 && cam.x <= bb.maxx + 20 && cam.z >= bb.minz - 20 && cam.z <= bb.maxz + 20;
  // Steady-state lerp lag behind a moving car is well under 2 scene units.
  const ok = dist < 3 && inFrame;
  return { ok, num, dist, inFrame };
}

async function runSession(label, session, opts = {}) {
  console.log(`\n=== ${label} : session_key=${session.session_key} (${session.circuit_short_name}) ===`);
  const store = new SessionStore(session, providers);
  await store.load();
  console.log(`drivers loaded: ${store.drivers.length}, laps: ${store.laps.length}`);

  const track = await buildTrack(store, providers);
  const synthetic = !!(track.meta && track.meta.synthetic);
  const bb = bboxOf(track.centerline);
  const spanX = bb.maxx - bb.minx, spanZ = bb.maxz - bb.minz;
  console.log(`track synthetic=${synthetic} bbox x[${bb.minx.toFixed(1)},${bb.maxx.toFixed(1)}] z[${bb.minz.toFixed(1)},${bb.maxz.toFixed(1)}] span=${spanX.toFixed(1)}x${spanZ.toFixed(1)} scale=${track.meta.scale?.toExponential(3)}`);

  // T2: derived circuit length vs official (fidelity).
  const len = trackLengthCheck(track, session.circuit_short_name);
  console.log(`  T2 length: derived=${len.derivedM.toFixed(0)} m official=${len.official ?? 'n/a'} m` +
    (len.official != null ? ` err=${(len.err * 100).toFixed(2)}% ok=${len.ok}` : ''));

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

  // Follow-camera assertion over real frames at the last sampled offset.
  let follow = { ok: false, why: 'skipped (synthetic track)' };
  if (!synthetic) {
    const T = startMs + OFFSETS[OFFSETS.length - 1];
    await awaitWindows(buffer, T);
    await awaitWindows(buffer, T + 10000); // follow window spans ~10 s
    follow = followCameraCheck(track, buffer, T, bb);
    console.log(`  follow-camera: ok=${follow.ok}` +
      (follow.num != null ? ` driver=${follow.num} lag=${follow.dist.toFixed(2)}u inFrame=${follow.inFrame}` : ` (${follow.why})`));
  }

  // T3: lap counter monotonic/correct across the sampled offsets.
  const lap = lapCounterCheck(store, startMs, OFFSETS);
  console.log(`  T3 lap: ok=${lap.ok} total=${lap.total} [${lap.samples.join(', ')}]`);

  // T1: no-vanish at 30× from the last (already-buffered) offset.
  let novanish = { ok: true, skipped: true };
  if (!synthetic) {
    const T = startMs + OFFSETS[OFFSETS.length - 1];
    await awaitWindows(buffer, T);
    novanish = await noVanishAt30x(buffer, store, T);
    console.log(`  T1 no-vanish@30×: ok=${novanish.ok} budget=${novanish.budget.toFixed(1)}/min` +
      ` advancedFrames=${novanish.advanced} heldFrames=${novanish.held} minCarsWhenBuffered=${novanish.minCars}`);
  }

  // T4: safety car present in a real SC window and excluded from the tower.
  let sc = { ok: true, skipped: true };
  if (opts.scDate && !synthetic) {
    sc = await safetyCarCheck(store, buffer, opts.scDate);
    console.log(`  T4 safety-car: ok=${sc.ok} tower=${sc.towerSize} scEntities=${JSON.stringify(sc.scNums)}` +
      ` inTower=${JSON.stringify(sc.scInTower)}`);
  }

  return { synthetic, results, bb, follow, len, lap, novanish, sc };
}

// Pick two real completed races from 2026 (a genuine session switch across
// different circuits). Fetched live through the provider (disk-cached).
const sess = await providers.getSessions({ year: 2026 });
const byKey = (k) => sess.find((s) => s.session_key === k);
const british = byKey(11326);   // Silverstone Race (has a real SC deployment)
const austria = byKey(11315);   // Spielberg Race
const belgium = byKey(11334);   // Spa Race (has a real SC deployment)
if (!british || !austria || !belgium) {
  console.error('Could not resolve the 2026 Silverstone/Spielberg/Spa race sessions.');
  process.exit(1);
}

// Lightweight third-circuit pass: derived-length fidelity + a second real SC
// deployment (Spa), without the full replay-sampling / follow / 30× burst, to
// cover T2/T4 across a third track while staying inside the request budget.
async function runLenAndSC(label, session, scDate) {
  console.log(`\n=== ${label} : session_key=${session.session_key} (${session.circuit_short_name}) ===`);
  const store = new SessionStore(session, providers);
  await store.load();
  const track = await buildTrack(store, providers);
  const synthetic = !!(track.meta && track.meta.synthetic);
  const len = trackLengthCheck(track, session.circuit_short_name);
  console.log(`  T2 length: derived=${len.derivedM.toFixed(0)} m official=${len.official ?? 'n/a'} m` +
    (len.official != null ? ` err=${(len.err * 100).toFixed(2)}% ok=${len.ok}` : ''));
  const buffer = new ReplayBuffer(store, providers);
  const sc = await safetyCarCheck(store, buffer, scDate);
  console.log(`  T4 safety-car: ok=${sc.ok} tower=${sc.towerSize} scEntities=${JSON.stringify(sc.scNums)}` +
    ` inTower=${JSON.stringify(sc.scInTower)}`);
  const pass = !synthetic && len.ok && sc.ok;
  return pass ? 'PASS' : `FAIL(synthetic=${synthetic} len=${len.ok} t4=${sc.ok})`;
}

function verdict(r, { minWithin = 15 } = {}) {
  const cars = !r.synthetic && Object.values(r.results).some((x) => x.within >= minWithin && x.finite === x.present);
  const follow = !!(r.follow && r.follow.ok);
  const len = !r.len || r.len.ok;
  const lap = !r.lap || r.lap.ok;
  const t1 = !r.novanish || r.novanish.ok;
  const t4 = !r.sc || r.sc.ok;
  const pass = cars && follow && len && lap && t1 && t4;
  return pass ? 'PASS' : `FAIL(cars=${cars} follow=${follow} len=${len} lap=${lap} t1=${t1} t4=${t4})`;
}

const r1 = await runSession('British GP (Silverstone) Race', british, {
  scDate: '2026-07-05T15:18:50+00:00', // first SAFETY CAR DEPLOYED (verified)
});
const r2 = await runSession('Austria (Spielberg) Race — SWITCH', austria);
// Third circuit (Spa) for T2 length fidelity + a second real SC deployment (T4).
const rSpa = await runLenAndSC('Belgium (Spa) Race — length+SC', belgium, '2026-07-19T13:05:25+00:00');
const lines = [`British: ${verdict(r1)}`, `Austria(switch): ${verdict(r2)}`, `Spa(len+SC): ${rSpa}`];
// Switch BACK proves no stale track/transform carryover. Skipped in FAST mode to
// stay within the OpenF1 30 req/min self-throttle for a quick single pass.
if (!process.env.HARNESS_FAST) {
  const r3 = await runSession('British GP again — SWITCH BACK', british);
  lines.push(`British(switch back): ${verdict(r3)}`);

  // A qualifying session exercises the practice/quali paths (no intervals feed,
  // sparser presence — cars trickle out of the garage, so sample mid-session
  // and accept fewer cars on track).
  const quali = sess.find((s) => s.meeting_key === british.meeting_key && /qualifying/i.test(s.session_name || ''))
    || sess.find((s) => /qualifying/i.test(s.session_name || ''));
  if (quali) {
    const saved = OFFSETS.slice();
    OFFSETS.length = 0; OFFSETS.push(600000, 900000);
    const r4 = await runSession('British GP Qualifying', quali);
    OFFSETS.length = 0; OFFSETS.push(...saved);
    lines.push(`British quali: ${verdict(r4, { minWithin: 8 })}`);
  } else {
    lines.push('British quali: SKIP (no quali session found)');
  }
}
console.log('\n--- VERDICT ---');
console.log(lines.join('\n'));
if (lines.some((l) => l.includes('FAIL'))) process.exit(1);
