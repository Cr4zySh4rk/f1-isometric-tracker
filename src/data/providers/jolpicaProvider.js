// Jolpica-F1 (Ergast successor) data provider — the CORS-friendly fallback used
// when OpenF1 is live-blocked or unreachable. Implements the same Provider
// interface as OpenF1Provider, but with `capabilities.telemetry === false`:
// Jolpica has schedule / results / classification / grid / per-lap lap times &
// running order, but NO x/y car telemetry. Callers detect the missing telemetry
// (getLocationWindow -> null) and switch the renderer into "Approximate mode",
// animating cars along a synthetic/cached centerline via the lap-time estimator.
//
// Sessions produced by this provider carry `_jolpica: { year, round, kind }` so
// per-round results/laps can be fetched on demand.

import { jolpicaRaw, jolpicaPaged } from '../../api/jolpica.js';
import {
  mapSchedule, mapMeetings, mapResults, mapLaps,
} from './jolpicaMap.js';

export class JolpicaProvider {
  constructor() {
    this.id = 'jolpica';
    this.label = 'Jolpica (Ergast)';
    this.capabilities = { telemetry: false };
    this._bundles = new Map(); // session_key -> { drivers, laps, positions, result, grid }
  }

  async getMeetings(year) {
    const mr = await jolpicaRaw(`${year}`);
    return mapMeetings(mr, year);
  }

  // Accepts { year } (season schedule) or { meeting_key, _year } to list that
  // round's sessions. Returns OpenF1-shaped session rows.
  async getSessions(params = {}) {
    const year = params.year || params._year || new Date().getFullYear();
    const mr = await jolpicaRaw(`${year}`);
    let sessions = mapSchedule(mr, year);
    if (params.meeting_key != null) {
      sessions = sessions.filter((s) => s.meeting_key === Number(params.meeting_key));
    }
    return sessions;
  }

  async getDrivers(session) { return (await this._bundle(session)).drivers; }
  async getLaps(session) { return (await this._bundle(session)).laps; }
  async getPositions(session) { return (await this._bundle(session)).positions; }
  async getSessionResult(session) { return (await this._bundle(session)).result; }

  // Ergast has no live race-control feed. Return empty so flag/SC logic degrades
  // gracefully (green, no incidents) rather than crashing.
  async getRaceControl() { return []; }
  async getPit() { return []; }

  // No telemetry: signal callers to use Approximate mode. null (not []) is the
  // explicit "provider has no location data at all" contract.
  async getLocationWindow() { return null; }

  // Ergast interval-to-leader is per-lap only; the approximate leaderboard uses
  // lap-derived order instead, so windowed intervals are empty here.
  async getIntervals() { return []; }

  probe() { return Promise.resolve(true); }

  // Fetch+map a round's results and laps once, memoised per session_key.
  async _bundle(session) {
    const key = session && session.session_key;
    if (this._bundles.has(key)) return this._bundles.get(key);
    const j = (session && session._jolpica) || {};
    const year = j.year;
    const round = j.round;
    if (!year || !round) {
      const empty = { drivers: [], laps: [], positions: [], result: [], grid: [] };
      this._bundles.set(key, empty);
      return empty;
    }

    const resultsMr = await jolpicaRaw(`${year}/${round}/results`);
    const { drivers, result, grid, byDriverId, startMs } = mapResults(resultsMr);

    // Laps are paged (a race has ~1000+ timing rows). Rebuild an MRData-like
    // object whose Races[0].Laps is the concatenation of every page's laps.
    let laps = [];
    let positions = [];
    try {
      const lapArrays = await jolpicaPaged(
        `${year}/${round}/laps`,
        (mr) => mr?.RaceTable?.Races?.[0]?.Laps || [],
        { limit: 100 },
      );
      const synthMr = { RaceTable: { Races: [{ Laps: lapArrays }] } };
      const mapped = mapLaps(synthMr, byDriverId, startMs);
      laps = mapped.laps;
      positions = mapped.positions;
    } catch {
      laps = [];
      positions = grid; // fall back to grid as the only known ordering
    }
    if (!positions.length) positions = grid;

    const bundle = { drivers, laps, positions, result, grid };
    this._bundles.set(key, bundle);
    return bundle;
  }
}
