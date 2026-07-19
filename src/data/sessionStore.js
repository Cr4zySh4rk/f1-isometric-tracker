// Session-scoped data store: metadata, drivers, laps, positions, race control.
// Small tables are fetched once and kept whole; drivers + laps are also mirrored
// to localStorage (they're small and let the track/leaderboard render instantly).

import { OpenF1 } from '../api/openf1.js';

const LS_PREFIX = 'f1iso.session.';

function lsGet(key) {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function lsSet(key, value) {
  try {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage full / disabled — non-fatal */
  }
}

export class SessionStore {
  constructor(session) {
    this.session = session; // the /sessions row
    this.sessionKey = session.session_key;
    this.drivers = [];
    this.driversByNumber = new Map();
    this.laps = [];
    this.positions = [];
    this.raceControl = [];
    this.result = [];
    this._loaded = false;
  }

  isRace() {
    const t = (this.session.session_type || '').toLowerCase();
    const n = (this.session.session_name || '').toLowerCase();
    return t === 'race' || n.includes('race') || n.includes('sprint');
  }

  // Load all the small tables. Robust: a failure in one endpoint (e.g. no
  // intervals for practice) does not break the others.
  async load() {
    if (this._loaded) return this;
    const k = this.sessionKey;

    const cachedDrivers = lsGet(`drivers.${k}`);
    const cachedLaps = lsGet(`laps.${k}`);

    const [drivers, laps, positions, raceControl] = await Promise.all([
      cachedDrivers ? Promise.resolve(cachedDrivers) : safe(() => OpenF1.drivers(k), []),
      cachedLaps ? Promise.resolve(cachedLaps) : safe(() => OpenF1.laps(k), []),
      safe(() => OpenF1.position(k), []),
      safe(() => OpenF1.raceControl(k), []),
    ]);

    this.drivers = normalizeDrivers(drivers);
    this.laps = Array.isArray(laps) ? laps : [];
    this.positions = Array.isArray(positions) ? positions : [];
    this.raceControl = Array.isArray(raceControl) ? raceControl : [];

    for (const d of this.drivers) this.driversByNumber.set(d.driver_number, d);

    if (!cachedDrivers && this.drivers.length) lsSet(`drivers.${k}`, this.drivers);
    if (!cachedLaps && this.laps.length) lsSet(`laps.${k}`, this.laps);

    this._loaded = true;
    return this;
  }

  driver(num) {
    return this.driversByNumber.get(num);
  }

  teamColour(num) {
    const d = this.driver(num);
    const c = d && d.team_colour ? d.team_colour : null;
    return c ? `#${String(c).replace(/^#/, '')}` : '#cccccc';
  }

  acronym(num) {
    const d = this.driver(num);
    return (d && (d.name_acronym || d.broadcast_name)) || String(num);
  }

  // The session time-window (ISO strings) from the metadata.
  timeWindow() {
    return {
      start: this.session.date_start,
      end: this.session.date_end,
    };
  }

  // Fastest complete (non-pit-out, plausible) lap across all drivers.
  fastestLap() {
    let best = null;
    for (const lap of this.laps) {
      const d = lap.lap_duration;
      if (typeof d !== 'number' || !isFinite(d) || d <= 0) continue;
      if (lap.is_pit_out_lap) continue;
      if (!lap.date_start) continue;
      if (d < 40 || d > 300) continue; // sanity: F1 lap times
      if (!best || d < best.lap_duration) best = lap;
    }
    // Fallback: any lap with a duration + date_start
    if (!best) {
      for (const lap of this.laps) {
        if (typeof lap.lap_duration === 'number' && lap.lap_duration > 0 && lap.date_start) {
          if (!best || lap.lap_duration < best.lap_duration) best = lap;
        }
      }
    }
    return best;
  }

  // Best lap time per driver (for practice/quali leaderboard fallback).
  bestLapByDriver() {
    const map = new Map();
    for (const lap of this.laps) {
      const d = lap.lap_duration;
      if (typeof d !== 'number' || d <= 0) continue;
      const cur = map.get(lap.driver_number);
      if (!cur || d < cur.lap_duration) map.set(lap.driver_number, lap);
    }
    return map;
  }

  // Latest lap number seen up to session time T (ms epoch).
  currentLapAt(tMs) {
    let maxLap = 0;
    let total = 0;
    for (const lap of this.laps) {
      if (lap.lap_number > total) total = lap.lap_number;
      const ds = lap.date_start ? Date.parse(lap.date_start) : NaN;
      if (!isNaN(ds) && ds <= tMs && lap.lap_number > maxLap) maxLap = lap.lap_number;
    }
    return { current: maxLap || 1, total: total || 0 };
  }

  // Last completed lap for a driver at time T.
  lastLapFor(num, tMs) {
    let best = null;
    for (const lap of this.laps) {
      if (lap.driver_number !== num) continue;
      if (typeof lap.lap_duration !== 'number' || lap.lap_duration <= 0) continue;
      const ds = lap.date_start ? Date.parse(lap.date_start) : NaN;
      const done = isNaN(ds) ? true : ds + lap.lap_duration * 1000 <= tMs;
      if (!done) continue;
      if (!best || lap.lap_number > best.lap_number) best = lap;
    }
    return best;
  }

  // Race-control state (flag / SC / VSC) active at time T.
  flagStateAt(tMs) {
    let state = { flag: null, message: null, category: null, safetyCar: null };
    const events = this.raceControl
      .filter((e) => e.date && Date.parse(e.date) <= tMs)
      .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    for (const e of events) {
      const flag = (e.flag || '').toUpperCase();
      const msg = (e.message || '').toUpperCase();
      const cat = (e.category || '').toUpperCase();
      if (cat === 'FLAG') {
        if (flag === 'CHEQUERED') state = { ...state, flag: 'CHEQUERED', message: e.message };
        else if (flag === 'CLEAR' || flag === 'GREEN') state.flag = null;
        else if (['YELLOW', 'DOUBLE YELLOW', 'RED'].includes(flag)) state.flag = flag;
      }
      if (cat === 'SAFETYCAR' || msg.includes('SAFETY CAR') || msg.includes('VIRTUAL SAFETY')) {
        if (msg.includes('VIRTUAL SAFETY CAR') && msg.includes('DEPLOY')) state.safetyCar = 'VSC';
        else if (msg.includes('SAFETY CAR') && (msg.includes('DEPLOY') || msg.includes('IN THIS LAP') === false && msg.includes('DEPLOYED'))) state.safetyCar = 'SC';
        if (msg.includes('ENDING') || msg.includes('IN THIS LAP') || msg.includes('CLEAR')) {
          // fades out below when a clear/green flag arrives
        }
        if ((msg.includes('SAFETY CAR') || msg.includes('VIRTUAL SAFETY CAR')) && (msg.includes('ENDING') || msg.includes('RETURN') || msg.includes('IN THIS LAP'))) {
          state.safetyCar = null;
        }
      }
    }
    return state;
  }
}

function normalizeDrivers(list) {
  if (!Array.isArray(list)) return [];
  // Deduplicate by driver_number (OpenF1 can return per-session duplicates).
  const seen = new Map();
  for (const d of list) {
    if (d && d.driver_number != null) seen.set(d.driver_number, d);
  }
  return [...seen.values()].sort((a, b) => a.driver_number - b.driver_number);
}

async function safe(fn, fallback) {
  try {
    const v = await fn();
    return v == null ? fallback : v;
  } catch (e) {
    if (e && e.isLiveBlock) throw e; // live-block must bubble up
    return fallback;
  }
}
