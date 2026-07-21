// FEATURE 4 standings: pure round-mapping + Ergast→row shaping. Verified against
// the real 2026 Jolpica schedule (British GP = round 9) and round-8 standings.
import { describe, it, expect } from 'vitest';
import {
  meetingToRound, standingsRoundToShow, mapDriverStandings, mapConstructorStandings,
} from '../src/data/standings.js';

// A faithful subset of the real 2026 schedule (Races[].{round,date,time}).
const SCHEDULE_2026 = [
  { round: '1', date: '2026-03-08', time: '04:00:00Z' },
  { round: '8', date: '2026-06-28', time: '13:00:00Z' }, // Austria
  { round: '9', date: '2026-07-05', time: '14:00:00Z' }, // Britain
  { round: '10', date: '2026-07-19', time: '13:00:00Z' }, // Belgium
];

describe('meetingToRound (closest scheduled race to the meeting date)', () => {
  it('maps the 2026 British GP meeting to round 9', () => {
    const t = Date.parse('2026-07-05T14:00:00+00:00');
    expect(meetingToRound(SCHEDULE_2026, t, 2026)).toEqual({ season: 2026, round: 9 });
  });
  it('maps a date near Belgium to round 10', () => {
    const t = Date.parse('2026-07-19T13:00:00+00:00');
    expect(meetingToRound(SCHEDULE_2026, t, 2026).round).toBe(10);
  });
  it('falls back to the first round when the meeting has no date', () => {
    expect(meetingToRound(SCHEDULE_2026, NaN, 2026).round).toBe(1);
  });
  it('is null on empty schedule', () => {
    expect(meetingToRound([], 1, 2026)).toBeNull();
  });
});

describe('standingsRoundToShow (going INTO the race = after previous round)', () => {
  it('shows the previous round', () => {
    expect(standingsRoundToShow(9)).toBe(8);
    expect(standingsRoundToShow(2)).toBe(1);
  });
  it('shows nothing (0) for the season opener', () => {
    expect(standingsRoundToShow(1)).toBe(0);
    expect(standingsRoundToShow(0)).toBe(0);
  });
});

// A faithful subset of the real 2026 round-8 driverStandings.
const DRIVER_LIST = {
  DriverStandings: [
    { position: '1', points: '171', wins: '5', Driver: { code: 'ANT', givenName: 'Andrea Kimi', familyName: 'Antonelli' }, Constructors: [{ constructorId: 'mercedes', name: 'Mercedes' }] },
    { position: '19', points: '0', wins: '0', Driver: { code: 'HUL', givenName: 'Nico', familyName: 'Hülkenberg' }, Constructors: [{ constructorId: 'audi', name: 'Audi' }] },
    { position: '20', points: '0', wins: '0', Driver: { givenName: 'Valtteri', familyName: 'Bottas' }, Constructors: [{ constructorId: 'cadillac', name: 'Cadillac F1 Team' }] },
  ],
};

describe('mapDriverStandings', () => {
  const rows = mapDriverStandings(DRIVER_LIST);
  it('shapes compact rows with position/code/points/constructor colour', () => {
    expect(rows[0]).toMatchObject({ position: 1, code: 'ANT', points: 171, constructor: 'Mercedes' });
    expect(rows[0].color).toBe('#27f4d2');
  });
  it('derives a code from the surname when Ergast omits one', () => {
    expect(rows[2].code).toBe('BOT');
  });
  it('colours the 2026 newcomers (Audi/Cadillac)', () => {
    expect(rows[1].color).toBe('#00e0c6'); // audi
    expect(rows[2].color).toBe('#c8a45c'); // cadillac
  });
  it('is empty on junk', () => {
    expect(mapDriverStandings(null)).toEqual([]);
  });
});

describe('mapConstructorStandings', () => {
  const list = {
    ConstructorStandings: [
      { position: '1', points: '250', wins: '6', Constructor: { constructorId: 'mercedes', name: 'Mercedes' } },
    ],
  };
  it('shapes compact team rows', () => {
    const rows = mapConstructorStandings(list);
    expect(rows[0]).toMatchObject({ position: 1, name: 'Mercedes', points: 250 });
    expect(rows[0].color).toBe('#27f4d2');
  });
});
