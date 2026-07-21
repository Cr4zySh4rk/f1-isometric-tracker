// Pure timing/leaderboard logic — everything is "as of replay time T" (ms epoch)
// so it can be unit-tested without the DOM or the network. Operates on plain
// OpenF1-shaped arrays (laps, positions, pit) rather than the SessionStore.

import { fmtLapTime, fmtDelta, fmtInterval, positionArrow } from '../util/format.js';
import { driverSectorColors, trackFlagOverride } from './sectors.js';

// --- lap completion helpers -------------------------------------------------

// A lap is "completed" (its time & sectors are known) once its start + duration
// has elapsed. Laps without a date_start fall back to lap_number ordering only.
export function lapCompletedAt(lap, tMs) {
  if (typeof lap.lap_duration !== 'number' || !(lap.lap_duration > 0)) return false;
  if (!lap.date_start) return true; // no timestamp: assume known
  const ds = Date.parse(lap.date_start);
  if (isNaN(ds)) return true;
  return ds + lap.lap_duration * 1000 <= tMs;
}

function plausible(dur) {
  return typeof dur === 'number' && isFinite(dur) && dur > 0;
}

// Best completed lap per driver up to T. Map(driver_number -> lap).
export function bestLapByDriverAt(laps, tMs) {
  const map = new Map();
  for (const lap of laps) {
    if (!plausible(lap.lap_duration)) continue;
    if (!lapCompletedAt(lap, tMs)) continue;
    const cur = map.get(lap.driver_number);
    if (!cur || lap.lap_duration < cur.lap_duration) map.set(lap.driver_number, lap);
  }
  return map;
}

// Session-fastest completed lap up to T (for the purple FL marker). Time-aware:
// laps not yet finished at T are excluded.
export function fastestLapAt(laps, tMs) {
  let best = null;
  for (const lap of laps) {
    if (!plausible(lap.lap_duration)) continue;
    if (lap.is_pit_out_lap) continue;
    if (lap.lap_duration < 40 || lap.lap_duration > 300) continue; // sane F1 range
    if (!lapCompletedAt(lap, tMs)) continue;
    if (!best || lap.lap_duration < best.lap_duration) best = lap;
  }
  return best;
}

// Last completed lap for a driver at T (for "last lap" column).
export function lastCompletedLap(laps, driver, tMs) {
  let best = null;
  for (const lap of laps) {
    if (lap.driver_number !== driver) continue;
    if (!plausible(lap.lap_duration)) continue;
    if (!lapCompletedAt(lap, tMs)) continue;
    if (!best || lap.lap_number > best.lap_number) best = lap;
  }
  return best;
}

// The lap a driver is currently on at T (greatest date_start <= T). Used for
// the live current-lap timer. Returns the lap row or null.
export function inProgressLap(laps, driver, tMs) {
  let best = null;
  let bestT = -Infinity;
  for (const lap of laps) {
    if (lap.driver_number !== driver || !lap.date_start) continue;
    const ds = Date.parse(lap.date_start);
    if (isNaN(ds) || ds > tMs) continue;
    if (ds > bestT) { bestT = ds; best = lap; }
  }
  return best;
}

// Current lap number / total up to T.
export function currentLapAt(laps, tMs) {
  const { lap, total } = lapAtTime(laps, tMs);
  return { current: lap || 1, total };
}

// The race lap counter at replay time T — pure and replay-time-aware.
// "Current lap" is the LEADER's lap: the greatest lap_number whose date_start
// (for any driver) is ≤ T, since the leader is the first to start each lap.
// Returns { lap, total, phase }:
//   phase 'pre'      — T before any lap started (formation / grid) → lap 1
//   phase 'racing'   — clamped to [1, total]
//   phase 'finished' — T at/after the last lap's completion → lap = total
//   total 0 / phase 'unknown' — no lap data at all (caller: show "LAP n" or hide)
export function lapAtTime(laps, tMs) {
  let total = 0;
  let current = 0;
  let firstStart = Infinity;
  let lastEnd = -Infinity;
  for (const lap of laps || []) {
    if (typeof lap.lap_number === 'number' && lap.lap_number > total) total = lap.lap_number;
    const ds = lap.date_start ? Date.parse(lap.date_start) : NaN;
    if (isNaN(ds)) continue;
    if (ds < firstStart) firstStart = ds;
    const dur = typeof lap.lap_duration === 'number' && lap.lap_duration > 0 ? lap.lap_duration * 1000 : 0;
    if (ds + dur > lastEnd) lastEnd = ds + dur;
    if (ds <= tMs && lap.lap_number > current) current = lap.lap_number;
  }
  if (!total) return { lap: 0, total: 0, phase: 'unknown' };
  if (tMs < firstStart) return { lap: 1, total, phase: 'pre' };
  const lap = Math.min(Math.max(current, 1), total); // post-chequered clamp
  const phase = tMs >= lastEnd ? 'finished' : 'racing';
  return { lap, total, phase };
}

// --- running order ----------------------------------------------------------

// Race order from the changes-only /position feed as of T.
export function raceOrderAt(positions, driverNums, tMs) {
  const pos = new Map();
  for (const p of positions) {
    if (!p.date) continue;
    if (Date.parse(p.date) > tMs) continue;
    pos.set(p.driver_number, p.position);
  }
  const order = driverNums
    .map((n) => ({ num: n, position: pos.get(n) }))
    .filter((o) => o.position != null)
    .sort((a, b) => a.position - b.position);
  const have = new Set(order.map((o) => o.num));
  for (const n of driverNums) if (!have.has(n)) order.push({ num: n, position: null });
  // Assign display ranks 1..N.
  return order.map((o, i) => ({ ...o, rank: i + 1 }));
}

// Practice/quali order: by best completed lap; drivers without a time go last
// (marked noTime) preserving their driver-number order.
export function practiceOrderAt(laps, driverNums, tMs) {
  const best = bestLapByDriverAt(laps, tMs);
  const withTime = [];
  const without = [];
  for (const n of driverNums) {
    const lap = best.get(n);
    if (lap) withTime.push({ num: n, best: lap.lap_duration });
    else without.push({ num: n, best: null, noTime: true });
  }
  withTime.sort((a, b) => a.best - b.best);
  return [...withTime, ...without].map((o, i) => ({ ...o, rank: i + 1 }));
}

// Starting position per driver from the earliest /position sample (grid order).
export function startingPositions(positions) {
  const first = new Map();
  const seenAt = new Map();
  for (const p of positions) {
    if (p.position == null || !p.date) continue;
    const t = Date.parse(p.date);
    if (isNaN(t)) continue;
    if (!seenAt.has(p.driver_number) || t < seenAt.get(p.driver_number)) {
      seenAt.set(p.driver_number, t);
      first.set(p.driver_number, p.position);
    }
  }
  return first;
}

// --- pit detection ----------------------------------------------------------

// Driver is "in pit" if T falls inside a pit stop window derived from /pit rows.
// Each pit row {date, pit_duration, driver_number} marks the moment of the stop;
// we treat [date - pit_duration, date + 1s] as the in-pit window (pit `date` is
// the exit/rejoin time in OpenF1, pit_duration is time stationary+pit-lane).
// Documented approximation — robust without location gaps.
export function isInPitAt(pitRows, driver, tMs, pad = 4000) {
  if (!Array.isArray(pitRows)) return false;
  for (const r of pitRows) {
    if (r.driver_number !== driver || !r.date) continue;
    const exit = Date.parse(r.date);
    if (isNaN(exit)) continue;
    const dur = (typeof r.pit_duration === 'number' ? r.pit_duration : 20) * 1000;
    const start = exit - dur - pad;
    const end = exit + pad;
    if (tMs >= start && tMs <= end) return true;
  }
  return false;
}

// --- sector bests -----------------------------------------------------------

const SECTOR_KEYS = ['duration_sector_1', 'duration_sector_2', 'duration_sector_3'];

export function lapSectors(lap) {
  return SECTOR_KEYS.map((k) => (typeof lap[k] === 'number' && lap[k] > 0 ? lap[k] : null));
}

// Session-best and per-driver-best sector times up to T.
// Returns { session:[s1,s2,s3], byDriver:Map(num -> [s1,s2,s3]) } (null = none).
export function sectorBestsAt(laps, tMs) {
  const session = [null, null, null];
  const byDriver = new Map();
  for (const lap of laps) {
    if (!lapCompletedAt(lap, tMs)) continue;
    const secs = lapSectors(lap);
    let pd = byDriver.get(lap.driver_number);
    if (!pd) { pd = [null, null, null]; byDriver.set(lap.driver_number, pd); }
    for (let i = 0; i < 3; i++) {
      const v = secs[i];
      if (v == null) continue;
      if (session[i] == null || v < session[i]) session[i] = v;
      if (pd[i] == null || v < pd[i]) pd[i] = v;
    }
  }
  return { session, byDriver };
}

// The most recently completed lap's sector times for a driver up to T.
export function driverLatestSectors(laps, driver, tMs) {
  const lap = lastCompletedLap(laps, driver, tMs);
  return lap ? lapSectors(lap) : [null, null, null];
}

// The 3 sector color names for the focus-mode track tint, given the focused
// driver's data at T and the current track status (flag override applies to the
// whole track). Returns e.g. ['purple','green','yellow'].
export function focusTrackColors(laps, driver, tMs, trackStatus) {
  const latest = driverLatestSectors(laps, driver, tMs);
  const { session, byDriver } = sectorBestsAt(laps, tMs);
  const pb = byDriver.get(driver) || [null, null, null];
  const flag = trackFlagOverride(trackStatus);
  return driverSectorColors(latest, pb, session, flag);
}

// --- timing tower row model -------------------------------------------------

// Build the full timing-tower row model as of T. Pure — the HUD renders DOM from
// this. All timing is time-aware.
//
// opts:
//   isRace       : boolean
//   driverNums   : number[] (all drivers in the session)
//   laps, positions
//   tMs
//   intervalFn   : (num) => { gap_to_leader, interval } | null  (race only)
//   intervalMode : 'interval' | 'gap'  (toggled by clicking the column header)
//   startPositions : Map(num -> gridPos)
//   penalties    : Map(num -> [{type,...}])
//   pitFn        : (num) => boolean
//   fastestNum   : number | null (session-fastest-lap holder at T)
//   retiredFn    : (num) => boolean (classified out & retired at T) — retired
//                  drivers are flagged and sorted to the classified tail.
export function buildTowerRows(opts) {
  const {
    isRace, driverNums, laps, positions, tMs,
    intervalFn = () => null, intervalMode = 'interval',
    startPositions = new Map(), penalties = new Map(), pitFn = () => false,
    fastestNum = null, retiredFn = () => false,
  } = opts;

  let order = isRace
    ? raceOrderAt(positions, driverNums, tMs)
    : practiceOrderAt(laps, driverNums, tMs);

  // Retired (dnf/dns/dsq) drivers are classified below the running cars, ordered
  // among themselves by their last running order. A frozen /position feed would
  // otherwise leave a retired car parked mid-field.
  const anyRetired = driverNums.some((n) => retiredFn(n));
  if (anyRetired) {
    const active = order.filter((o) => !retiredFn(o.num));
    const retired = order.filter((o) => retiredFn(o.num));
    order = [...active, ...retired].map((o, i) => ({ ...o, rank: i + 1 }));
  }

  const best = isRace ? null : bestLapByDriverAt(laps, tMs);
  const p1Best = !isRace && order.length && order[0].best != null ? order[0].best : null;

  return order.map((o) => {
    const num = o.num;
    const retired = retiredFn(num);
    const arrow = positionArrow(startPositions.get(num), o.position ?? o.rank);
    const pen = penalties.get(num) || null;

    let delta, deltaKind, noTime = false;
    if (retired) {
      delta = 'OUT';
      deltaKind = 'retired';
    } else if (isRace) {
      if (o.rank === 1) {
        delta = 'LEADER';
        deltaKind = 'leader';
      } else {
        const iv = intervalFn(num);
        const val = iv ? (intervalMode === 'gap' ? iv.gap_to_leader : iv.interval) : null;
        const s = fmtInterval(val);
        delta = s || '—';
        deltaKind = 'interval';
      }
    } else {
      if (o.noTime || o.best == null) {
        delta = 'NO TIME';
        deltaKind = 'notime';
        noTime = true;
      } else if (o.rank === 1) {
        delta = fmtLapTime(o.best);
        deltaKind = 'best';
      } else {
        delta = p1Best != null ? fmtDelta(o.best - p1Best) : fmtLapTime(o.best);
        deltaKind = 'delta';
      }
    }

    return {
      rank: o.rank,
      num,
      position: o.position ?? o.rank,
      arrow: arrow.dir,
      arrowGlyph: arrow.glyph,
      delta,
      deltaKind,
      noTime,
      retired,
      isFastest: !retired && fastestNum != null && num === fastestNum,
      inPit: !retired && !!pitFn(num),
      penalty: pen && pen.length ? pen[pen.length - 1] : null,
      penalties: pen,
    };
  });
}
