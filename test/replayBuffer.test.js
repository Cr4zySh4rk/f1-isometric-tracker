import { describe, it, expect } from 'vitest';
import { ReplayBuffer, isNoResults } from '../src/data/replayBuffer.js';
import intervals from './fixtures/intervals.json';

function fakeStore() {
  return {
    session: { session_key: 1 },
    sessionKey: 1,
    isRace: () => true,
    timeWindow: () => ({ start: '2025-07-01T13:00:00.000Z', end: '2025-07-01T14:00:00.000Z' }),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const T = (iso) => Date.parse(`2025-07-01T${iso}Z`);

describe('ReplayBuffer intervals', () => {
  it('returns the latest interval sample at or before T', () => {
    const buf = new ReplayBuffer(fakeStore());
    buf._ingestIntervals(intervals);
    expect(buf.intervalAt(1, T('13:15:30')).interval).toBe(0.334);
    expect(buf.intervalAt(4, T('13:15:30')).interval).toBe('+1 LAP');
  });

  it('handles null interval samples', () => {
    const buf = new ReplayBuffer(fakeStore());
    buf._ingestIntervals(intervals);
    // Before the 13:15 update, VER only has the null sample at 13:14.
    expect(buf.intervalAt(1, T('13:14:30')).interval).toBe(null);
  });

  it('returns null when there is no sample yet', () => {
    const buf = new ReplayBuffer(fakeStore());
    buf._ingestIntervals(intervals);
    expect(buf.intervalAt(1, T('13:00:00'))).toBe(null);
  });

  it('ingests location rows into per-driver tracks, dropping (0,0) dropouts', () => {
    const buf = new ReplayBuffer(fakeStore());
    buf._ingestLocation([
      { driver_number: 44, date: '2025-07-01T13:00:00.000Z', x: 10, y: 20, z: 0 },
      { driver_number: 44, date: '2025-07-01T13:00:01.000Z', x: 11, y: 21, z: 0 },
      { driver_number: 44, date: '2025-07-01T13:00:02.000Z', x: 0, y: 0, z: 0 }, // dropout
    ]);
    const s = buf.sampleAll(T('13:00:00'));
    expect(s.has(44)).toBe(true);
    expect(buf.track(44).samples.length).toBe(2);
  });
});

describe('ReplayBuffer window fetch resilience', () => {
  const locRows = [
    { driver_number: 44, date: '2025-07-01T13:00:00.000Z', x: 10, y: 20, z: 0 },
    { driver_number: 44, date: '2025-07-01T13:00:01.000Z', x: 11, y: 21, z: 0 },
    { driver_number: 1, date: '2025-07-01T13:00:00.000Z', x: 30, y: 40, z: 0 },
  ];

  it('classifies OpenF1 "No results found" (404) as empty, not a retryable error', () => {
    expect(isNoResults({ status: 404, message: 'No results found.' })).toBe(true);
    expect(isNoResults({ message: 'No results found.' })).toBe(true);
    expect(isNoResults({ status: 500, message: 'boom' })).toBe(false);
    expect(isNoResults({ isNetwork: true })).toBe(false); // transient → retry
    expect(isNoResults({ isLiveBlock: true })).toBe(false);
  });

  it('still ingests location when intervals 404 (early-race no-gaps → cars visible)', async () => {
    const source = {
      getLocationWindow: async () => locRows,
      // Intervals legitimately 404 in the first ~90 s of a race.
      getIntervals: async () => { throw Object.assign(new Error('No results found.'), { status: 404 }); },
    };
    const buf = new ReplayBuffer(fakeStore(), source);
    await buf._fetchWindow(0);
    expect(buf.windows.get(0)).toBe('loaded'); // NOT 'error'
    expect(buf.track(44).samples.length).toBe(2);
    expect(buf.sampleAll(T('13:00:00')).size).toBe(2); // both cars present
  });

  it('does not retry-storm a window whose location legitimately 404s', async () => {
    let locCalls = 0;
    const source = {
      getLocationWindow: async () => { locCalls++; throw Object.assign(new Error('No results found.'), { status: 404 }); },
      getIntervals: async () => [],
    };
    const buf = new ReplayBuffer(fakeStore(), source);
    buf.update(buf.startMs);       // triggers _fetchWindow for cursor + prefetch
    await flush();
    const afterFirst = locCalls;   // windows settled as empty-but-loaded
    buf.update(buf.startMs);       // a later frame must NOT refire loaded windows
    await flush();
    expect(buf.windows.get(0)).toBe('loaded'); // empty but settled, not 'error'
    expect(locCalls).toBe(afterFirst); // no retry storm
  });

  it('marks the window "error" (retryable) on a genuine network failure', async () => {
    const source = {
      getLocationWindow: async () => { throw Object.assign(new Error('Network error'), { isNetwork: true }); },
      getIntervals: async () => [],
    };
    const buf = new ReplayBuffer(fakeStore(), source);
    await buf._fetchWindow(0);
    expect(buf.windows.get(0)).toBe('error');
  });
});
