// Session-scoped data store: metadata, drivers, laps, positions, race control.
// Small tables are fetched once and kept whole; drivers + laps are also mirrored
// to localStorage (they're small and let the track/leaderboard render instantly).

import { OpenF1Provider } from './providers/openf1Provider.js';
import { normalizeRaceControl, trackStatusAt, penaltiesAt } from './raceControl.js';
import {
  fastestLapAt, bestLapByDriverAt, currentLapAt, lastCompletedLap,
  startingPositions, isInPitAt,
} from './timing.js';

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
  constructor(session, source) {
    this.session = session; // the /sessions row
    this.sessionKey = session.session_key;
    // `source` is the data-source facade (ProviderManager) or any object with
    // getDrivers/getLaps/getPositions/getRaceControl/getPit(session). Defaults
    // to a plain OpenF1 provider so the store works standalone.
    this.source = source || new OpenF1Provider();
    this.drivers = [];
    this.driversByNumber = new Map();
    this.laps = [];
    this.positions = [];
    this.raceControl = [];
    this.rcEvents = []; // normalized + sorted race_control (with tMs)
    this.pit = [];
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

    const src = this.source;
    const s = this.session;
    const [drivers, laps, positions, raceControl, pit] = await Promise.all([
      cachedDrivers ? Promise.resolve(cachedDrivers) : safe(() => src.getDrivers(s), []),
      cachedLaps ? Promise.resolve(cachedLaps) : safe(() => src.getLaps(s), []),
      safe(() => src.getPositions(s), []),
      safe(() => src.getRaceControl(s), []),
      safe(() => src.getPit(s), []),
    ]);

    this.drivers = normalizeDrivers(drivers);
    this.laps = Array.isArray(laps) ? laps : [];
    this.positions = Array.isArray(positions) ? positions : [];
    this.raceControl = Array.isArray(raceControl) ? raceControl : [];
    this.rcEvents = normalizeRaceControl(this.raceControl);
    this.pit = Array.isArray(pit) ? pit : [];
    this._startPositions = startingPositions(this.positions);

    for (const d of this.drivers) this.driversByNumber.set(d.driver_number, d);

    // Only cache once the session has settled (ended > 1 h ago): caching a
    // still-running / freshly-finished session would freeze partial laps and
    // drivers in localStorage and serve them stale forever.
    const endMs = Date.parse(s.date_end);
    const settled = isFinite(endMs) && Date.now() - endMs > 60 * 60000;
    if (settled && !cachedDrivers && this.drivers.length) lsSet(`drivers.${k}`, this.drivers);
    if (settled && !cachedLaps && this.laps.length) lsSet(`laps.${k}`, this.laps);

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

  // Fastest complete (non-pit-out, plausible) lap across all drivers, as of the
  // end of the session (used by the track builder to pick a clean flying lap).
  fastestLap() {
    return fastestLapAt(this.laps, Infinity);
  }

  // Best lap time per driver up to T (for practice/quali leaderboard fallback).
  bestLapByDriver(tMs = Infinity) {
    return bestLapByDriverAt(this.laps, tMs);
  }

  // Latest lap number / total up to session time T (ms epoch).
  currentLapAt(tMs) {
    return currentLapAt(this.laps, tMs);
  }

  // Last completed lap for a driver at time T.
  lastLapFor(num, tMs) {
    return lastCompletedLap(this.laps, num, tMs);
  }

  // Session-fastest completed lap up to T (purple FL marker).
  fastestLapAt(tMs) {
    return fastestLapAt(this.laps, tMs);
  }

  // Track status (green/yellow/SC/red/…) active at time T.
  trackStatusAt(tMs) {
    return trackStatusAt(this.rcEvents, tMs);
  }

  // Active penalties by driver up to T.
  penaltiesAt(tMs) {
    return penaltiesAt(this.rcEvents, tMs);
  }

  // Grid/starting position for a driver.
  startingPosition(num) {
    return this._startPositions ? this._startPositions.get(num) : undefined;
  }

  // Is the driver in the pits at time T?
  isInPitAt(num, tMs) {
    return isInPitAt(this.pit, num, tMs);
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
