// FEATURE 1 telemetry: pure car_data helpers (DRS/gear/parse/latest-≤-T) and the
// FocusedTelemetry windowed buffer (prefetch around T, evict behind, sample ≤ T,
// dispose on stop). Verified against real OpenF1 /car_data shapes (2026 GB GP).
import { describe, it, expect } from 'vitest';
import {
  drsState, gearLabel, parseCarSample, latestAtOrBefore, FocusedTelemetry,
} from '../src/data/telemetry.js';

describe('drsState (≥10 OPEN else CLOSED)', () => {
  it('classifies coded DRS values', () => {
    expect(drsState(0)).toBe('CLOSED');
    expect(drsState(1)).toBe('CLOSED');
    expect(drsState(8)).toBe('CLOSED'); // eligible but not open
    expect(drsState(10)).toBe('OPEN');
    expect(drsState(12)).toBe('OPEN');
    expect(drsState(14)).toBe('OPEN');
    expect(drsState(null)).toBe('CLOSED');
    expect(drsState(undefined)).toBe('CLOSED');
  });
});

describe('gearLabel', () => {
  it('0/null → N, else the gear', () => {
    expect(gearLabel(0)).toBe('N');
    expect(gearLabel(null)).toBe('N');
    expect(gearLabel(8)).toBe('8');
    expect(gearLabel(1)).toBe('1');
  });
});

describe('parseCarSample (real /car_data row)', () => {
  it('parses a real straight-line sample', () => {
    const s = parseCarSample({
      date: '2026-07-05T14:10:00.211000+00:00',
      drs: null, rpm: 11260, n_gear: 8, speed: 311, brake: 0, throttle: 100,
    });
    expect(s.speed).toBe(311);
    expect(s.gear).toBe(8);
    expect(s.throttle).toBe(100);
    expect(s.brake).toBe(0);
    expect(Number.isFinite(s.t)).toBe(true);
  });
  it('clamps throttle/brake to 0..100 and null-guards', () => {
    const s = parseCarSample({ date: '2026-07-05T14:10:00Z', throttle: 140, brake: -5 });
    expect(s.throttle).toBe(100);
    expect(s.brake).toBe(0);
    expect(s.speed).toBeNull();
  });
  it('returns null on bad timestamp', () => {
    expect(parseCarSample({ date: 'nope' })).toBeNull();
    expect(parseCarSample(null)).toBeNull();
  });
});

describe('latestAtOrBefore', () => {
  const arr = [{ t: 10 }, { t: 20 }, { t: 30 }];
  it('binary-searches the latest ≤ T', () => {
    expect(latestAtOrBefore(arr, 25).t).toBe(20);
    expect(latestAtOrBefore(arr, 30).t).toBe(30);
    expect(latestAtOrBefore(arr, 5)).toBeNull();
  });
});

// --- FocusedTelemetry buffer ------------------------------------------------

// A deterministic fake source: getCarData returns ~3.7 Hz samples inside the
// requested window and records every call for prefetch/evict assertions.
function makeSource({ nullData = false } = {}) {
  const calls = [];
  return {
    calls,
    async getCarData(session, num, aISO, bISO) {
      calls.push({ num, a: Date.parse(aISO), b: Date.parse(bISO) });
      if (nullData) return null;
      const a = Date.parse(aISO), b = Date.parse(bISO);
      const rows = [];
      for (let t = a; t <= b; t += 270) {
        rows.push({ date: new Date(t).toISOString(), speed: 300, n_gear: 7, throttle: 100, brake: 0, rpm: 11000, drs: 12 });
      }
      return rows;
    },
  };
}

const startMs = Date.parse('2026-07-05T14:00:00Z');
const store = {
  session: { session_key: 11326 },
  sessionKey: 11326,
  timeWindow: () => ({ start: '2026-07-05T14:00:00Z', end: '2026-07-05T16:00:00Z' }),
};
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('FocusedTelemetry buffer', () => {
  it('prefetches a window around T and samples the latest ≤ T', async () => {
    const src = makeSource();
    const ft = new FocusedTelemetry(store, src);
    ft.start(44);
    const T = startMs + 600000; // 10 min in
    ft.update(T, 1);
    await flush();
    expect(src.calls.length).toBeGreaterThan(0);
    expect(src.calls.every((c) => c.num === 44)).toBe(true);
    const s = ft.sampleAt(T);
    expect(s).not.toBeNull();
    expect(Number.isFinite(s.speed)).toBe(true);
    expect(s.t).toBeLessThanOrEqual(T);
  });

  it('does not refetch already-covered windows', async () => {
    const src = makeSource();
    const ft = new FocusedTelemetry(store, src);
    ft.start(1);
    const T = startMs + 600000;
    ft.update(T, 1);
    await flush();
    const n = src.calls.length;
    ft.update(T, 1); // same cursor → everything covered
    await flush();
    expect(src.calls.length).toBe(n);
  });

  it('evicts samples behind the cursor as replay advances', async () => {
    const src = makeSource();
    const ft = new FocusedTelemetry(store, src);
    ft.start(1);
    ft.update(startMs + 120000, 1);
    await flush();
    const early = ft.samples.length;
    expect(early).toBeGreaterThan(0);
    // Jump far ahead: the old samples fall behind the eviction cutoff.
    ft.update(startMs + 1200000, 1);
    await flush();
    expect(ft.samples.every((s) => s.t >= startMs + 1200000 - 3 * ft.windowMs)).toBe(true);
  });

  it('flags unavailable when the provider has no telemetry (approx mode)', async () => {
    const src = makeSource({ nullData: true });
    const ft = new FocusedTelemetry(store, src);
    ft.start(1);
    ft.update(startMs + 600000, 1);
    await flush();
    expect(ft.isUnavailable()).toBe(true);
    expect(ft.sampleAt(startMs + 600000)).toBeNull();
  });

  it('disposes cleanly (no leaked samples / focus)', async () => {
    const src = makeSource();
    const ft = new FocusedTelemetry(store, src);
    ft.start(1);
    ft.update(startMs + 600000, 1);
    await flush();
    ft.dispose();
    expect(ft.num).toBeNull();
    expect(ft.samples.length).toBe(0);
    expect(ft.hasData()).toBe(false);
  });

  it('drops in-flight results when focus changes mid-fetch', async () => {
    const src = makeSource();
    const ft = new FocusedTelemetry(store, src);
    ft.start(1);
    ft.update(startMs + 600000, 1);
    ft.start(44); // switch driver before the fetch resolves
    await flush();
    // Samples for #1's window must not have landed under #44's focus.
    expect(ft.num).toBe(44);
    expect(ft.samples.length).toBe(0);
  });
});
