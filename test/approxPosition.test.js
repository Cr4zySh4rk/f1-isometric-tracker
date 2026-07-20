import { describe, it, expect } from 'vitest';
import {
  buildCenterlineArc, sampleAlongArc, driverLapTimeline,
  lapProgressAt, approxPositionAt,
} from '../src/data/approxPosition.js';
import { syntheticOval } from '../src/track/trackMath.js';

const arc = buildCenterlineArc(syntheticOval(200, 8000, 5000));

describe('buildCenterlineArc / sampleAlongArc', () => {
  it('wraps arc length around the closed loop', () => {
    const a = sampleAlongArc(arc, 0);
    const b = sampleAlongArc(arc, arc.total); // full loop == start
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1);
    const c = sampleAlongArc(arc, -arc.total * 0.25); // negative wraps
    expect(Number.isFinite(c.x) && Number.isFinite(c.y)).toBe(true);
  });
  it('returns a finite heading everywhere', () => {
    for (let s = 0; s < arc.total; s += arc.total / 17) {
      const p = sampleAlongArc(arc, s);
      expect(Number.isFinite(p.heading)).toBe(true);
    }
  });
});

const START = Date.parse('2025-03-16T04:00:00.000Z');
function laps(driver, durations) {
  let t = START;
  return durations.map((d, i) => {
    const row = { driver_number: driver, lap_number: i + 1, date_start: new Date(t).toISOString(), lap_duration: d };
    if (d != null) t += d * 1000;
    else t += 95000; // advance for the null case so subsequent laps have sane starts
    return row;
  });
}

describe('driverLapTimeline', () => {
  it('sorts, parses, and fills missing durations with the median lap', () => {
    const rows = laps(1, [90, null, 92, 91]);
    const tl = driverLapTimeline(rows, 1);
    expect(tl.map((r) => r.lap)).toEqual([1, 2, 3, 4]);
    // The null lap_duration is backfilled with a positive (median) value.
    const filled = tl.find((r) => r.lap === 2);
    expect(filled.durMs).toBeGreaterThan(0);
  });
  it('ignores other drivers and unparseable rows', () => {
    const rows = [
      { driver_number: 1, lap_number: 1, date_start: '2025-03-16T04:00:00Z', lap_duration: 90 },
      { driver_number: 2, lap_number: 1, date_start: '2025-03-16T04:00:00Z', lap_duration: 91 },
      { driver_number: 1, lap_number: 2, date_start: 'garbage', lap_duration: 90 },
    ];
    expect(driverLapTimeline(rows, 1).length).toBe(1);
  });
});

describe('lapProgressAt', () => {
  const tl = driverLapTimeline(laps(1, [100, 100, 100]), 1);
  it('marks before-first-lap as on the grid (frac 0)', () => {
    const p = lapProgressAt(tl, START - 10000);
    expect(p).toEqual({ lap: 1, frac: 0, before: true });
  });
  it('advances progress monotonically inside a lap', () => {
    const p0 = lapProgressAt(tl, START + 0);
    const p1 = lapProgressAt(tl, START + 50000);
    const p2 = lapProgressAt(tl, START + 99000);
    expect(p0.frac).toBeLessThan(p1.frac);
    expect(p1.frac).toBeLessThan(p2.frac);
    expect(p1.lap).toBe(1);
  });
  it('rolls to the next lap at the boundary', () => {
    const p = lapProgressAt(tl, START + 100000 + 10000);
    expect(p.lap).toBe(2);
    expect(p.frac).toBeGreaterThan(0);
  });
  it('clamps after the last lap (retired/finished)', () => {
    const p = lapProgressAt(tl, START + 10 * 60000);
    expect(p.lap).toBe(3);
    expect(p.frac).toBe(1);
    expect(p.after).toBe(true);
  });
});

describe('approxPositionAt', () => {
  const rows = laps(44, [100, 100, 100]);
  it('produces finite {x,y,heading} on the loop and is present during running', () => {
    const p = approxPositionAt({ laps: rows, driverNumber: 44, tMs: START + 50000, arc });
    expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.heading)).toBe(true);
    expect(p.present).toBe(true);
    expect(p.lap).toBe(1);
  });
  it('is faded (alpha<1) and not present on the grid before lap 1', () => {
    const p = approxPositionAt({ laps: rows, driverNumber: 44, tMs: START - 5000, arc });
    expect(p.present).toBe(false);
    expect(p.alpha).toBeLessThan(1);
  });
  it('advances arc position monotonically across a lap', () => {
    const timeline = driverLapTimeline(rows, 44);
    let prev = -1;
    for (const dt of [0, 20000, 40000, 60000, 80000]) {
      const p = approxPositionAt({ driverNumber: 44, tMs: START + dt, arc, timeline });
      expect(p.frac).toBeGreaterThanOrEqual(prev);
      prev = p.frac;
    }
  });
  it('returns null with an empty arc', () => {
    const emptyArc = buildCenterlineArc([]);
    expect(approxPositionAt({ laps: rows, driverNumber: 44, tMs: START, arc: emptyArc })).toBe(null);
  });
});
