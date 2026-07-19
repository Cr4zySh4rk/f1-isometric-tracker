import { describe, it, expect } from 'vitest';
import { ReplayBuffer } from '../src/data/replayBuffer.js';
import intervals from './fixtures/intervals.json';

function fakeStore() {
  return {
    sessionKey: 1,
    isRace: () => true,
    timeWindow: () => ({ start: '2025-07-01T13:00:00.000Z', end: '2025-07-01T14:00:00.000Z' }),
  };
}
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
