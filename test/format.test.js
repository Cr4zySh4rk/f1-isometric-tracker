import { describe, it, expect } from 'vitest';
import {
  fmtLapTime, fmtDelta, fmtInterval, fmtSessionClock, fmtLiveLap, positionArrow,
} from '../src/util/format.js';

describe('format', () => {
  it('formats lap times as M:SS.mmm', () => {
    expect(fmtLapTime(96.584)).toBe('1:36.584');
    expect(fmtLapTime(95.984)).toBe('1:35.984');
    expect(fmtLapTime(60)).toBe('1:00.000');
    expect(fmtLapTime(9.5)).toBe('0:09.500');
    expect(fmtLapTime(0)).toBe('');
    expect(fmtLapTime(NaN)).toBe('');
  });

  it('formats signed deltas', () => {
    expect(fmtDelta(0.334)).toBe('+0.334');
    expect(fmtDelta(-0.121)).toBe('-0.121');
    expect(fmtDelta(0)).toBe('+0.000');
  });

  it('formats race intervals incl "+1 LAP" and null', () => {
    expect(fmtInterval(0.334)).toBe('+0.334');
    expect(fmtInterval('+1 LAP')).toBe('+1 LAP');
    expect(fmtInterval(null)).toBe('');
    expect(fmtInterval(undefined)).toBe('');
  });

  it('formats session clock', () => {
    expect(fmtSessionClock(63000)).toBe('1:03');
    expect(fmtSessionClock(3723000)).toBe('1:02:03');
    expect(fmtSessionClock(-5)).toBe('0:00');
  });

  it('formats live lap time to tenths', () => {
    expect(fmtLiveLap(83400)).toBe('1:23.4');
    expect(fmtLiveLap(9500)).toBe('0:09.5');
  });

  it('derives position-change arrows', () => {
    expect(positionArrow(5, 3)).toEqual({ dir: 'up', glyph: '▲' });
    expect(positionArrow(3, 5)).toEqual({ dir: 'down', glyph: '▼' });
    expect(positionArrow(4, 4)).toEqual({ dir: 'same', glyph: '—' });
    expect(positionArrow(null, 4).dir).toBe('same');
  });
});
