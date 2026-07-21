import { describe, it, expect } from 'vitest';
import {
  fastestLapAt, bestLapByDriverAt, lastCompletedLap, currentLapAt, inProgressLap,
  lapCompletedAt, raceOrderAt, practiceOrderAt, startingPositions, isInPitAt,
  sectorBestsAt, driverLatestSectors, focusTrackColors, buildTowerRows,
} from '../src/data/timing.js';
import laps from './fixtures/laps.json';
import positions from './fixtures/positions.json';
import pit from './fixtures/pit.json';
import intervals from './fixtures/intervals.json';

const NUMS = [1, 44, 16, 4];
const T = (iso) => Date.parse(`2025-07-01T${iso}Z`);
const intervalFn = (num) => intervals.find((i) => i.driver_number === num && i.date.includes('13:15:00')) || null;

describe('fastest lap at time T (time-aware)', () => {
  it('only counts laps completed before T', () => {
    const early = fastestLapAt(laps, T('13:03:40'));
    expect(early.driver_number).toBe(44);
    expect(early.lap_duration).toBe(96.584); // HAM lap2; VER/LEC not finished yet
  });
  it('updates as more laps complete', () => {
    const late = fastestLapAt(laps, T('13:06:00'));
    expect(late.driver_number).toBe(44);
    expect(late.lap_duration).toBe(95.984); // HAM lap3
  });
  it('excludes pit-out laps', () => {
    const f = fastestLapAt(laps, T('13:06:00'));
    expect(f.is_pit_out_lap).toBeFalsy();
  });
});

describe('lap helpers', () => {
  it('lapCompletedAt respects start+duration', () => {
    const ham2 = laps.find((l) => l.driver_number === 44 && l.lap_number === 2);
    expect(lapCompletedAt(ham2, T('13:03:00'))).toBe(false);
    expect(lapCompletedAt(ham2, T('13:04:00'))).toBe(true);
  });
  it('bestLapByDriverAt', () => {
    const best = bestLapByDriverAt(laps, T('13:06:00'));
    expect(best.get(44).lap_duration).toBe(95.984);
    expect(best.get(1).lap_duration).toBe(96.918);
    expect(best.get(16).lap_duration).toBe(96.500);
    expect(best.has(4)).toBe(false);
  });
  it('lastCompletedLap returns latest by lap number', () => {
    expect(lastCompletedLap(laps, 44, T('13:06:00')).lap_number).toBe(3);
  });
  it('currentLapAt + inProgressLap', () => {
    expect(currentLapAt(laps, T('13:04:00')).current).toBe(3);
    expect(inProgressLap(laps, 44, T('13:04:00')).lap_number).toBe(3);
  });
});

describe('running order', () => {
  it('race order reflects position changes over time', () => {
    expect(raceOrderAt(positions, NUMS, T('13:05:00')).map((o) => o.num)).toEqual([1, 44, 16, 4]);
    expect(raceOrderAt(positions, NUMS, T('13:15:00')).map((o) => o.num)).toEqual([44, 1, 16, 4]);
  });
  it('practice order is by best lap with NO TIME drivers last', () => {
    const order = practiceOrderAt(laps, NUMS, T('13:06:00'));
    expect(order.map((o) => o.num)).toEqual([44, 16, 1, 4]);
    expect(order[3].noTime).toBe(true);
  });
  it('starting positions come from the earliest sample', () => {
    const sp = startingPositions(positions);
    expect(sp.get(1)).toBe(1);
    expect(sp.get(44)).toBe(2);
  });
});

describe('pit detection', () => {
  it('flags a driver inside a pit window', () => {
    expect(isInPitAt(pit, 16, T('13:08:20'))).toBe(true);
    expect(isInPitAt(pit, 16, T('13:09:00'))).toBe(false);
    expect(isInPitAt(pit, 1, T('13:08:20'))).toBe(false);
  });
});

describe('sector bests + focus colors', () => {
  it('computes session and per-driver sector bests', () => {
    const { session, byDriver } = sectorBestsAt(laps, T('13:06:00'));
    expect(session).toEqual([29.9, 33.1, 32.918]);
    expect(byDriver.get(44)).toEqual([29.9, 33.1, 32.984]);
  });
  it('driverLatestSectors uses the most recent completed lap', () => {
    expect(driverLatestSectors(laps, 44, T('13:06:00'))).toEqual([29.9, 33.1, 32.984]);
  });
  it('focusTrackColors reflects purple/green sector states', () => {
    expect(focusTrackColors(laps, 44, T('13:06:00'), 'GREEN')).toEqual(['purple', 'purple', 'green']);
  });
  it('focusTrackColors applies flag priority', () => {
    expect(focusTrackColors(laps, 44, T('13:06:00'), 'RED')).toEqual(['red', 'red', 'red']);
    expect(focusTrackColors(laps, 44, T('13:06:00'), 'YELLOW')).toEqual(['yellow', 'yellow', 'yellow']);
  });
});

describe('buildTowerRows', () => {
  it('race mode: leader marker, intervals, +1 LAP, arrows, FL badge', () => {
    const rows = buildTowerRows({
      isRace: true, driverNums: NUMS, laps, positions, tMs: T('13:15:30'),
      intervalFn, intervalMode: 'interval',
      startPositions: startingPositions(positions),
      fastestNum: fastestLapAt(laps, T('13:15:30')).driver_number,
    });
    expect(rows.map((r) => r.num)).toEqual([44, 1, 16, 4]);
    expect(rows[0].delta).toBe('LEADER');
    expect(rows[0].isFastest).toBe(true);
    expect(rows[0].arrow).toBe('up'); // HAM gained a place (grid 2 -> P1)
    expect(rows[1].delta).toBe('+0.334');
    expect(rows[1].arrow).toBe('down'); // VER lost a place
    expect(rows[2].delta).toBe('+1.200');
    expect(rows[3].delta).toBe('+1 LAP');
  });

  it('race mode: delta column toggles to gap-to-leader', () => {
    const rows = buildTowerRows({
      isRace: true, driverNums: NUMS, laps, positions, tMs: T('13:15:30'),
      intervalFn, intervalMode: 'gap',
      startPositions: startingPositions(positions),
    });
    expect(rows[2].delta).toBe('+1.534'); // LEC gap-to-leader, not interval
  });

  it('race mode: retired drivers are flagged OUT and sorted to the classified tail', () => {
    const rows = buildTowerRows({
      isRace: true, driverNums: NUMS, laps, positions, tMs: T('13:15:30'),
      intervalFn, intervalMode: 'interval',
      startPositions: startingPositions(positions),
      retiredFn: (num) => num === 1, // VER (would be P2) retires
    });
    // VER sinks to the bottom despite a live P2 in the /position feed.
    expect(rows[rows.length - 1].num).toBe(1);
    const ver = rows.find((r) => r.num === 1);
    expect(ver.retired).toBe(true);
    expect(ver.delta).toBe('OUT');
    expect(ver.deltaKind).toBe('retired');
    // Running order among the rest is preserved and re-ranked 1..N.
    expect(rows.filter((r) => !r.retired).map((r) => r.num)).toEqual([44, 16, 4]);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
  });

  it('practice mode: P1 best time, deltas, NO TIME', () => {
    const rows = buildTowerRows({
      isRace: false, driverNums: NUMS, laps, positions: [], tMs: T('13:06:00'),
      fastestNum: 44,
    });
    expect(rows.map((r) => r.num)).toEqual([44, 16, 1, 4]);
    expect(rows[0].delta).toBe('1:35.984');
    expect(rows[1].delta).toBe('+0.516');
    expect(rows[2].delta).toBe('+0.934');
    expect(rows[3].delta).toBe('NO TIME');
    expect(rows[3].noTime).toBe(true);
  });
});
