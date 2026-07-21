// Pure tyre-stint logic (no DOM, no network) — unit-tested against real OpenF1
// /stints shapes. A stint row is:
//   { stint_number, lap_start, lap_end, compound, tyre_age_at_start }
// compound ∈ SOFT | MEDIUM | HARD | INTERMEDIATE | WET (OpenF1 upper-case).
//
// Everything is keyed off a driver's LAP NUMBER at replay time T (the caller
// resolves T → lap via timing.inProgressLap); this module just answers
// "which compound / how old is the tyre on lap N".

// Compound → dot colour + short label, matching F1 TV tyre marking.
//   red = soft, yellow = medium, white = hard, green = intermediate, blue = wet.
const COMPOUND_INFO = {
  SOFT: { color: '#e8443b', label: 'SOFT', short: 'S' },
  MEDIUM: { color: '#f5d23a', label: 'MED', short: 'M' },
  HARD: { color: '#e9edf3', label: 'HARD', short: 'H' },
  INTERMEDIATE: { color: '#3fc65a', label: 'INT', short: 'I' },
  WET: { color: '#3a7bef', label: 'WET', short: 'W' },
};

export function compoundInfo(compound) {
  const key = String(compound || '').toUpperCase();
  return COMPOUND_INFO[key] || { color: '#8a94a3', label: key || '—', short: '?' };
}

// Group a flat /stints array into Map(driver_number -> stints[] sorted by lap_start).
export function stintsByDriver(rows) {
  const out = new Map();
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    if (!r || r.driver_number == null) continue;
    const arr = out.get(r.driver_number) || [];
    arr.push(r);
    out.set(r.driver_number, arr);
  }
  for (const arr of out.values()) arr.sort((a, b) => (a.lap_start || 0) - (b.lap_start || 0));
  return out;
}

// The stint active on `lapNumber` for one driver's (sorted) stint list. Prefers
// the stint whose [lap_start, lap_end] contains the lap; otherwise the latest
// stint that has started on/before the lap (covers tail laps / off-by-one from
// OpenF1's inclusive lap_end). Returns the stint row or null.
export function stintAt(driverStints, lapNumber) {
  if (!Array.isArray(driverStints) || !driverStints.length || lapNumber == null) return null;
  let fallback = null;
  for (const s of driverStints) {
    const ls = s.lap_start ?? -Infinity;
    const le = s.lap_end ?? Infinity;
    if (lapNumber >= ls && lapNumber <= le) return s;
    if (lapNumber >= ls) fallback = s; // started already → most recent so far
  }
  return fallback || driverStints[0];
}

// Compound in use on `lapNumber` (string, upper-case) or null.
export function compoundAt(driverStints, lapNumber) {
  const s = stintAt(driverStints, lapNumber);
  return s && s.compound ? String(s.compound).toUpperCase() : null;
}

// Tyre age (laps) on `lapNumber`: the stint's tyre_age_at_start plus laps run in
// this stint up to and including the current lap. Clamped ≥ 0. null if unknown.
export function tyreAgeAt(driverStints, lapNumber) {
  const s = stintAt(driverStints, lapNumber);
  if (!s || lapNumber == null) return null;
  const base = Number.isFinite(s.tyre_age_at_start) ? s.tyre_age_at_start : 0;
  const ls = Number.isFinite(s.lap_start) ? s.lap_start : lapNumber;
  const run = Math.max(0, lapNumber - ls);
  return Math.max(0, base + run);
}
