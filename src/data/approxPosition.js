// Approximate-position estimator (used in "Approximate mode" when live
// telemetry is unavailable — e.g. the Jolpica fallback, which has per-lap times
// but no x/y).
//
// Idea: a driver at session time T is somewhere along the lap they're currently
// on. progress = elapsed-in-lap / lap_duration, mapped to arc length along the
// (cached / derived / synthetic) centerline — the start/finish line is arc 0.
// One lap == one loop of the closed centerline.
//
// Pure and framework-free (operates on {x,y} points in ANY 2D space) so it is
// unit-tested for monotonicity and pit/missing-lap robustness.

// Precompute cumulative arc length for a closed centerline of {x,y} points.
export function buildCenterlineArc(points) {
  const pts = (points || []).map((p) => ({ x: p.x, y: p.y }));
  const n = pts.length;
  const cum = new Array(n + 1);
  cum[0] = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    cum[i + 1] = cum[i] + Math.hypot(b.x - a.x, b.y - a.y);
  }
  return { points: pts, cum, total: cum[n] || 1, n };
}

// Point + heading at arc-length s (wrapped into [0,total)) along the loop.
export function sampleAlongArc(arc, s) {
  const { points, cum, total, n } = arc;
  if (!n) return null;
  let d = ((s % total) + total) % total;
  // Binary search for the segment containing d.
  let lo = 0, hi = n, idx = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) { idx = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  idx = Math.min(idx, n - 1);
  const segLen = cum[idx + 1] - cum[idx] || 1;
  const u = (d - cum[idx]) / segLen;
  const a = points[idx];
  const b = points[(idx + 1) % n];
  const x = a.x + (b.x - a.x) * u;
  const y = a.y + (b.y - a.y) * u;
  const heading = Math.atan2(b.y - a.y, b.x - a.x);
  return { x, y, heading };
}

// Normalise a driver's laps to sorted { lap, startMs, durMs }, filling missing
// durations with the driver's median lap so progress still advances sensibly
// (e.g. an out-of-range or absent lap_duration during a pit in/out).
export function driverLapTimeline(laps, driverNumber) {
  const rows = (laps || [])
    .filter((l) => l && l.driver_number === driverNumber)
    .map((l) => ({
      lap: l.lap_number,
      startMs: Date.parse(l.date_start),
      durMs: l.lap_duration != null ? l.lap_duration * 1000 : null,
    }))
    .filter((l) => isFinite(l.startMs) && l.lap != null)
    .sort((a, b) => a.lap - b.lap);

  const known = rows.map((r) => r.durMs).filter((d) => d != null && d > 0).sort((a, b) => a - b);
  const median = known.length ? known[Math.floor(known.length / 2)] : 95000;
  for (const r of rows) {
    if (r.durMs == null || r.durMs <= 0) r.durMs = median;
  }
  return rows;
}

// Estimate a driver's fractional lap progress at time T.
// Returns { lap, frac, before } or null.
//   frac  — 0..1 position within the current lap (monotonic within a lap)
//   before — true if T is before the driver's first lap (sitting on the grid)
export function lapProgressAt(timeline, tMs) {
  if (!timeline || !timeline.length) return null;
  const first = timeline[0];
  if (tMs < first.startMs) return { lap: first.lap, frac: 0, before: true };

  for (const r of timeline) {
    const end = r.startMs + r.durMs;
    if (tMs < end) {
      const frac = Math.min(1, Math.max(0, (tMs - r.startMs) / r.durMs));
      return { lap: r.lap, frac, before: false };
    }
  }
  const last = timeline[timeline.length - 1];
  return { lap: last.lap, frac: 1, before: false, after: true };
}

// Full estimate: driver's {x,y,heading,present,lap,frac} at time T along `arc`.
// `present` is false before the driver's first lap (parked on the grid) or after
// they retire — the caller can fade the car accordingly.
export function approxPositionAt({ laps, driverNumber, tMs, arc, timeline }) {
  const tl = timeline || driverLapTimeline(laps, driverNumber);
  const prog = lapProgressAt(tl, tMs);
  if (!prog || !arc || !arc.n) return null;
  const s = prog.frac * arc.total;
  const p = sampleAlongArc(arc, s);
  if (!p) return null;
  return {
    x: p.x,
    y: p.y,
    heading: p.heading,
    lap: prog.lap,
    frac: prog.frac,
    present: !prog.before && !prog.after,
    alpha: prog.before ? 0.6 : 1,
  };
}
