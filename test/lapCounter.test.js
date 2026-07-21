// T3 lap counter: the pure, replay-time-aware `lapAtTime` fn that drives the
// tower header "LAP n / total". Time-aware, monotonic, clamped post-chequered.
import { describe, it, expect } from 'vitest';
import { lapAtTime, currentLapAt } from '../src/data/timing.js';

// Build a simple race: `drivers` cars each running `total` laps of `lapMs`,
// the leader starting each lap `leadMs` before the backmarker. date_start is the
// moment a lap BEGINS (as in OpenF1 /laps).
function makeRace({ base = 1_000_000_000_000, total = 5, lapMs = 90_000, drivers = 3, leadMs = 4_000 } = {}) {
  const laps = [];
  for (let d = 0; d < drivers; d++) {
    for (let n = 1; n <= total; n++) {
      laps.push({
        driver_number: d + 1,
        lap_number: n,
        date_start: new Date(base + d * leadMs + (n - 1) * lapMs).toISOString(),
        lap_duration: lapMs / 1000,
      });
    }
  }
  return { laps, base, total, lapMs };
}

describe('lapAtTime (T3 lap counter)', () => {
  it('reports total laps and the LEADER lap (earliest starter of each lap)', () => {
    const { laps, base, total, lapMs } = makeRace();
    // Just after lap 3 started for the leader (driver 1) but before backmarkers.
    const t = base + 2 * lapMs + 10; // leader is on lap 3
    const r = lapAtTime(laps, t);
    expect(r.total).toBe(total);
    expect(r.lap).toBe(3);
    expect(r.phase).toBe('racing');
  });

  it('phase "pre": before any lap starts → lap 1', () => {
    const { laps, base } = makeRace();
    const r = lapAtTime(laps, base - 5_000);
    expect(r).toMatchObject({ lap: 1, phase: 'pre' });
    expect(r.total).toBe(5);
  });

  it('is monotonic non-decreasing as T advances across the race', () => {
    const { laps, base, total, lapMs } = makeRace();
    let prev = 0;
    for (let t = base - 10_000; t <= base + total * lapMs + 10_000; t += 3_000) {
      const { lap } = lapAtTime(laps, t);
      expect(lap).toBeGreaterThanOrEqual(prev);
      expect(lap).toBeLessThanOrEqual(total);
      prev = lap;
    }
  });

  it('phase "finished": at/after the last lap completes, lap clamps to total', () => {
    const { laps, base, total, lapMs } = makeRace();
    const end = base + (total - 1) * lapMs + 2 * lapMs; // well past the last completion
    const r = lapAtTime(laps, end);
    expect(r.lap).toBe(total);
    expect(r.phase).toBe('finished');
  });

  it('phase "unknown" with no lap data → total 0 (caller hides the counter)', () => {
    expect(lapAtTime([], Date.now())).toMatchObject({ lap: 0, total: 0, phase: 'unknown' });
    expect(lapAtTime(null, Date.now())).toMatchObject({ total: 0, phase: 'unknown' });
  });

  it('currentLapAt wraps lapAtTime for the HUD (current defaults to >=1)', () => {
    const { laps, base } = makeRace();
    const { current, total } = currentLapAt(laps, base - 1);
    expect(current).toBe(1);
    expect(total).toBe(5);
  });
});
