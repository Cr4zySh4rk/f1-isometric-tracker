// Evidence probe for the grid-heading + DNF work (items 1 & 3). For a race it
// prints: (a) per-driver speed just before lights-out — proving the field is
// stationary on the grid (~0 dm/s) so velocity headings are meaningless there;
// (b) each classified-out (session_result dnf) driver's retirement, telemetry
// tail extent and whether the car keeps transmitting its parked position.
// Usage: node scripts/probeItems.mjs [session_key]   (default Silverstone 11326)
import { cachedJson, OF1 } from './cachedFetch.mjs';

const KEY = parseInt(process.argv[2] || '11326', 10);
const session = (await cachedJson(`${OF1}/sessions?session_key=${KEY}`))[0];
const startMs = Date.parse(session.date_start);
const endMs = Date.parse(session.date_end);
const laps = await cachedJson(`${OF1}/laps?session_key=${KEY}`);
console.log(`${session.circuit_short_name} ${session.date_start} .. ${session.date_end}`);

// --- ITEM 1: grid is stationary just before lights-out (lap 1 start) ---
let lap1 = Infinity;
for (const l of laps) if (l.lap_number === 1 && l.date_start) lap1 = Math.min(lap1, Date.parse(l.date_start));
const a = new Date(lap1 - 9000).toISOString();
const b = new Date(lap1 - 3000).toISOString();
const grid = await cachedJson(`${OF1}/location?session_key=${KEY}&date>${a}&date<${b}`);
const byD = new Map();
for (const r of grid) {
  if (r.x == null || (r.x === 0 && r.y === 0)) continue;
  (byD.get(r.driver_number) || byD.set(r.driver_number, []).get(r.driver_number)).push({ t: Date.parse(r.date), x: r.x, y: r.y });
}
let stationary = 0;
for (const [, arr] of byD) {
  arr.sort((p, q) => p.t - q.t);
  let d = 0;
  for (let i = 1; i < arr.length; i++) d += Math.hypot(arr[i].x - arr[i - 1].x, arr[i].y - arr[i - 1].y);
  const sp = d / (((arr[arr.length - 1].t - arr[0].t) / 1000) || 1);
  if (sp < 40) stationary++;
}
console.log(`\nITEM1 grid @ lights-out-6s: ${byD.size} cars, ${stationary} stationary (<40 dm/s)`);

// --- ITEM 3: classified-out drivers + telemetry tail ---
const result = await cachedJson(`${OF1}/session_result?session_key=${KEY}`);
const outs = result.filter((r) => r.dnf || r.dns || r.dsq);
console.log(`\nITEM3 classified out: ${outs.map((o) => `#${o.driver_number}(dnf=${o.dnf},laps=${o.number_of_laps})`).join(', ') || 'none'}`);
for (const o of outs.slice(0, 1)) {
  const num = o.driver_number;
  const dl = laps.filter((l) => l.driver_number === num && l.date_start).sort((x, y) => x.lap_number - y.lap_number);
  const lastStart = Date.parse(dl[dl.length - 1].date_start);
  const loc = await cachedJson(`${OF1}/location?session_key=${KEY}&driver_number=${num}&date>${new Date(lastStart - 30000).toISOString()}&date<${session.date_end}`);
  const pts = loc.filter((r) => r.x != null && !(r.x === 0 && r.y === 0)).map((r) => Date.parse(r.date)).sort((x, y) => x - y);
  const tail = loc.filter((r) => r.x != null && !(r.x === 0 && r.y === 0)).map((r) => ({ t: Date.parse(r.date), x: r.x, y: r.y })).sort((p, q) => p.t - q.t).slice(-20);
  let d = 0;
  for (let i = 1; i < tail.length; i++) d += Math.hypot(tail[i].x - tail[i - 1].x, tail[i].y - tail[i - 1].y);
  console.log(`  #${num}: lastLap#${dl[dl.length - 1].lap_number}@+${((lastStart - startMs) / 1000).toFixed(0)}s  telemetry ends +${((pts[pts.length - 1] - startMs) / 1000).toFixed(0)}s (session end +${((endMs - startMs) / 1000).toFixed(0)}s)  tailSpeed=${(d / (((tail[tail.length - 1].t - tail[0].t) / 1000) || 1)).toFixed(1)} dm/s (0 = parked but still transmitting)`);
}
