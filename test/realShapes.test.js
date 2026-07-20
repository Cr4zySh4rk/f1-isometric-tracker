// Real-data shape validation: guards our parsers against the *actual* OpenF1 v1
// response shapes captured live from session 11334 (2026-07-19 Spa Race) — the
// microsecond+`+00:00` date format, `team_colour` hex without '#',
// `duration_sector_N` field names, nullable intervals, etc. Plus a full
// integration regression for the HTTP-200 live-block bug through the real client.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import real from './fixtures/openf1_real.json';
import { normalizeRaceControl, trackStatusAt } from '../src/data/raceControl.js';
import { fastestLapAt, lapSectors } from '../src/data/timing.js';

describe('OpenF1 real date formats', () => {
  it('Date.parse handles 6-digit microseconds + `+00:00` offset (laps) and no-fraction + offset (race_control)', () => {
    const lapDate = real.laps.find((l) => l.date_start).date_start;
    expect(lapDate).toMatch(/\+00:00$/); // real offset form, not `Z`
    expect(Number.isFinite(Date.parse(lapDate))).toBe(true);
    const rcDate = real.race_control[0].date;
    expect(Number.isFinite(Date.parse(rcDate))).toBe(true);
  });
});

describe('OpenF1 real driver shape', () => {
  it('team_colour is a bare 6-hex string (no leading #)', () => {
    for (const d of real.drivers) {
      expect(d.team_colour).toMatch(/^[0-9A-Fa-f]{6}$/);
    }
    expect(real.drivers[0].name_acronym).toBeTruthy();
    expect(typeof real.drivers[0].driver_number).toBe('number');
  });
});

describe('OpenF1 real lap shape → timing parsers', () => {
  it('fastestLapAt reads real laps (duration_sector_N + lap_duration + microsecond dates)', () => {
    const fl = fastestLapAt(real.laps, Infinity);
    expect(fl).toBeTruthy();
    expect(fl.lap_duration).toBeGreaterThan(0);
    // sector fields present under the real key names
    const secs = lapSectors(fl);
    expect(secs.length).toBe(3);
    expect(secs.every((s) => s == null || s > 0)).toBe(true);
  });
});

describe('OpenF1 real race_control shape → status machine', () => {
  it('normalizeRaceControl parses real dates and trackStatusAt yields a valid status', () => {
    const events = normalizeRaceControl(real.race_control);
    expect(events.length).toBe(real.race_control.length);
    expect(events.every((e) => Number.isFinite(e.tMs))).toBe(true);
    const last = events[events.length - 1];
    const st = trackStatusAt(events, last.tMs);
    expect(['GREEN', 'YELLOW', 'DOUBLE_YELLOW', 'RED', 'SC', 'VSC', 'CHEQUERED']).toContain(st.status);
  });
});

describe('OpenF1 real intervals shape', () => {
  it('interval can be null; gap_to_leader is numeric', () => {
    const iv = real.intervals[0];
    expect('interval' in iv).toBe(true); // may be null (leader / first sample)
    expect(iv.gap_to_leader === null || typeof iv.gap_to_leader === 'number').toBe(true);
  });
});

// --- Full client regression for the reported live-block bug -------------------
describe('OpenF1 client: HTTP 200 live-block object → LiveBlockError (not connection error)', () => {
  let origFetch;
  beforeEach(() => { origFetch = global.fetch; });
  afterEach(() => { global.fetch = origFetch; vi.restoreAllMocks(); });

  it('throws a LiveBlockError (isLiveBlock), never an isNetwork ApiError, for the 200+object body', async () => {
    const { api, clearCache, LiveBlockError } = await import('../src/api/openf1.js');
    clearCache();
    // Simulate the live block: HTTP 200, CORS ok, body = a JSON OBJECT.
    global.fetch = vi.fn(async () => ({
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ detail: 'Live F1 session in progress. Retry after the session.' }),
    }));
    let caught;
    try {
      await api('sessions', { year: 2026 }, { cache: false });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(LiveBlockError);
    expect(caught.isLiveBlock).toBe(true);
    expect(caught.isNetwork).toBeFalsy(); // NOT a connectivity error
  });

  it('only a genuine fetch rejection becomes an isNetwork ApiError', async () => {
    const { api, clearCache, ApiError } = await import('../src/api/openf1.js');
    clearCache();
    global.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    let caught;
    try {
      await api('sessions', { year: 2026 }, { cache: false });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught.isNetwork).toBe(true);
  });
});
