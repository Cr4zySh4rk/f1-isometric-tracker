import { describe, it, expect } from 'vitest';
import {
  parseErgastLapTime, parseErgastGap, constructorColour,
  mapSchedule, mapMeetings, mapResults, mapLaps,
} from '../src/data/providers/jolpicaMap.js';
import real from './fixtures/jolpica_real.json';

describe('parseErgastLapTime', () => {
  it('parses m:ss.mmm, plain seconds and h:m:s', () => {
    expect(parseErgastLapTime('1:37.284')).toBeCloseTo(97.284, 3);
    expect(parseErgastLapTime('97.284')).toBeCloseTo(97.284, 3);
    expect(parseErgastLapTime('1:31:44.742')).toBeCloseTo(5504.742, 3);
  });
  it('handles null/garbage', () => {
    expect(parseErgastLapTime(null)).toBe(null);
    expect(parseErgastLapTime('')).toBe(null);
    expect(parseErgastLapTime('n/a')).toBe(null);
  });
});

describe('parseErgastGap', () => {
  it('keeps lapped strings and parses time gaps', () => {
    expect(parseErgastGap('+1 Lap')).toBe('+1 Lap');
    expect(parseErgastGap('+22.457')).toBeCloseTo(22.457, 3);
    expect(parseErgastGap('+1:24.310')).toBeCloseTo(84.310, 3);
  });
});

describe('constructorColour', () => {
  it('maps known constructors and falls back to grey', () => {
    expect(constructorColour('mclaren')).toBe('ff8000');
    expect(constructorColour('ferrari')).toBe('e8002d');
    expect(constructorColour('nonexistent_team')).toBe('999999');
  });
});

describe('mapSchedule / mapMeetings (real 2025 subset)', () => {
  const sessions = mapSchedule(real.schedule.MRData, 2025);
  it('emits a Race per round and an extra Sprint when present', () => {
    // fixture: round 1 (Australia, no sprint) + a sprint round (China).
    const keys = sessions.map((s) => s.session_key);
    expect(keys).toContain('jol-2025-1');
    expect(keys.some((k) => k.endsWith('-sprint'))).toBe(true);
    // Every session carries _jolpica {year, round} for on-demand fetch.
    for (const s of sessions) {
      expect(s._jolpica.year).toBe(2025);
      expect(typeof s._jolpica.round).toBe('number');
      expect(s.date_start).toMatch(/^2025-/);
    }
  });
  it('maps meetings one per round with circuit info', () => {
    const meetings = mapMeetings(real.schedule.MRData, 2025);
    expect(meetings.length).toBe(2);
    expect(meetings[0].meeting_name).toMatch(/Australian Grand Prix/);
    expect(meetings[0].country_name).toBeTruthy();
  });
});

describe('mapResults (real 2025 round 1 subset)', () => {
  const { drivers, result, grid, byDriverId, startMs } = mapResults(real.results.MRData);
  it('derives OpenF1-shaped drivers with team_colour (no #) and acronym', () => {
    const nor = drivers.find((d) => d.name_acronym === 'NOR');
    expect(nor).toBeTruthy();
    expect(nor.team_colour).toBe('ff8000'); // mclaren, hex without '#'
    expect(nor.driver_number).toBe(4);
    expect(nor.full_name).toMatch(/Lando Norris/);
  });
  it('derives classification, grid, and a driverId→number map', () => {
    expect(result[0].position).toBe(1);
    expect(result[0].points).toBe(25);
    expect(byDriverId.get('norris')).toBe(4);
    expect(grid.length).toBe(drivers.length);
    expect(Number.isFinite(startMs)).toBe(true);
  });
});

describe('mapLaps (real 2025 round 1 subset)', () => {
  const { byDriverId, startMs } = mapResults(real.results.MRData);
  const { laps, positions } = mapLaps(real.laps.MRData, byDriverId, startMs);
  it('synthesises lap rows with date_start + lap_duration from cumulative timings', () => {
    expect(laps.length).toBeGreaterThan(0);
    const first = laps[0];
    expect(first.lap_number).toBe(1);
    expect(first.lap_duration).toBeGreaterThan(0);
    // date_start of lap 1 equals the race start.
    expect(Date.parse(first.date_start)).toBe(startMs);
    // lap 2 for the same driver starts after lap 1's duration.
    const nor1 = laps.filter((l) => l.driver_number === 4).sort((a, b) => a.lap_number - b.lap_number);
    if (nor1.length >= 2) {
      const gap = Date.parse(nor1[1].date_start) - Date.parse(nor1[0].date_start);
      expect(gap).toBeCloseTo(nor1[0].lap_duration * 1000, -1);
    }
    expect(positions.length).toBe(laps.length);
  });
});
