import { describe, it, expect } from 'vitest';
import {
  classifiedOut, retirementTimeMs, retirementDisplayAt, isRetiredAt,
  RETIRE_STOP_HOLD_MS, RETIRE_FADE_MS,
} from '../src/data/retirement.js';

describe('classifiedOut', () => {
  it('collects dnf/dns/dsq drivers with their flags', () => {
    const m = classifiedOut([
      { driver_number: 1, dnf: false, dns: false, dsq: false, number_of_laps: 52 },
      { driver_number: 27, dnf: true, dns: false, dsq: false, number_of_laps: 36 },
      { driver_number: 5, dnf: false, dns: true, dsq: false },
      { driver_number: 9, dnf: false, dns: false, dsq: true, number_of_laps: 40 },
    ]);
    expect(m.has(1)).toBe(false);
    expect(m.get(27)).toEqual({ dnf: true, dns: false, dsq: false, laps: 36 });
    expect(m.get(5).dns).toBe(true);
    expect(m.get(9).dsq).toBe(true);
  });

  it('is empty for missing/blank input', () => {
    expect(classifiedOut(null).size).toBe(0);
    expect(classifiedOut([]).size).toBe(0);
  });
});

describe('retirementTimeMs', () => {
  it('uses the last completed lap end when the final lap has a duration', () => {
    const laps = [
      { driver_number: 27, lap_number: 1, date_start: '2026-01-01T00:00:00Z', lap_duration: 90 },
      { driver_number: 27, lap_number: 2, date_start: '2026-01-01T00:01:30Z', lap_duration: 90 },
    ];
    // last lap starts at +90s and lasts 90s ⇒ ends at +180s
    expect(retirementTimeMs(laps, 27)).toBe(Date.parse('2026-01-01T00:03:00Z'));
  });

  it('estimates a mid-lap retirement from the median lap when the final lap has no duration', () => {
    const laps = [
      { driver_number: 27, lap_number: 1, date_start: '2026-01-01T00:00:00Z', lap_duration: 100 },
      { driver_number: 27, lap_number: 2, date_start: '2026-01-01T00:01:40Z', lap_duration: 100 },
      { driver_number: 27, lap_number: 3, date_start: '2026-01-01T00:03:20Z', lap_duration: null },
    ];
    // last lap starts at +200s; median completed lap = 100s ⇒ ~+300s
    expect(retirementTimeMs(laps, 27)).toBe(Date.parse('2026-01-01T00:05:00Z'));
  });

  it('returns null when the driver has no dated laps', () => {
    expect(retirementTimeMs([], 27)).toBe(null);
  });
});

describe('retirementDisplayAt (car removal)', () => {
  it('returns null for a non-retiree (normal handling)', () => {
    expect(retirementDisplayAt({ isClassifiedOut: false, present: false, endGapMs: 9999 })).toBe(null);
  });

  it('shows a retiree racing while telemetry still covers T and it has not rested', () => {
    const r = retirementDisplayAt({ isClassifiedOut: true, present: true, endGapMs: 0, restElapsedMs: 0 });
    expect(r).toEqual({ state: 'racing', retired: false, alpha: 1 });
  });

  it('a retiree still moving after retirement keeps racing (limping to a stop)', () => {
    // present + moving ⇒ restElapsedMs 0 (caller resets it while moving)
    const r = retirementDisplayAt({ isClassifiedOut: true, present: true, endGapMs: 0, restElapsedMs: 0 });
    expect(r.state).toBe('racing');
  });

  it('shows stopped then fades then removes as telemetry stays absent', () => {
    const stopped = retirementDisplayAt({ isClassifiedOut: true, present: false, endGapMs: 1000 });
    expect(stopped.state).toBe('stopped');
    expect(stopped.retired).toBe(true);
    expect(stopped.alpha).toBe(1);

    const fading = retirementDisplayAt({ isClassifiedOut: true, present: false, endGapMs: RETIRE_STOP_HOLD_MS + RETIRE_FADE_MS / 2 });
    expect(fading.state).toBe('stopped');
    expect(fading.alpha).toBeGreaterThan(0);
    expect(fading.alpha).toBeLessThan(1);

    const gone = retirementDisplayAt({ isClassifiedOut: true, present: false, endGapMs: RETIRE_STOP_HOLD_MS + RETIRE_FADE_MS + 1 });
    expect(gone).toEqual({ state: 'removed', retired: true, alpha: 0 });
  });

  it('removes a parked wreck that is still transmitting once it has rested', () => {
    // Car at rest, telemetry STILL present (parked transponder) — removal must
    // key off restElapsedMs, not wait for the feed to end.
    const justStopped = retirementDisplayAt({ isClassifiedOut: true, present: true, endGapMs: 0, restElapsedMs: 500 });
    expect(justStopped.state).toBe('stopped');
    expect(justStopped.alpha).toBe(1);

    const recovered = retirementDisplayAt({ isClassifiedOut: true, present: true, endGapMs: 0, restElapsedMs: RETIRE_STOP_HOLD_MS + RETIRE_FADE_MS + 1 });
    expect(recovered).toEqual({ state: 'removed', retired: true, alpha: 0 });
  });
});

describe('isRetiredAt (tower classification, time-aware)', () => {
  it('is false before the retirement time and true after', () => {
    expect(isRetiredAt(1000, 500)).toBe(false);
    expect(isRetiredAt(1000, 1500)).toBe(true);
    expect(isRetiredAt(null, 9e9)).toBe(false);
  });
});
