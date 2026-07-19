import { describe, it, expect } from 'vitest';
import {
  sectorColorState, driverSectorColors, trackFlagOverride,
  splitSectorsByLength, sectorOfIndex,
} from '../src/data/sectors.js';
import { arcLengths } from '../src/track/trackMath.js';

describe('sectorColorState', () => {
  it('purple when at or below the session best', () => {
    expect(sectorColorState(29.9, 30.2, 29.9, null)).toBe('purple');
  });
  it('green when at personal best but not session best', () => {
    expect(sectorColorState(32.984, 32.984, 32.918, null)).toBe('green');
  });
  it('yellow when slower than personal best (within 2s)', () => {
    expect(sectorColorState(33.5, 33.1, 32.918, null)).toBe('yellow');
  });
  it('red when > 2s slower than personal best', () => {
    expect(sectorColorState(35.5, 33.1, 32.918, null)).toBe('red');
  });
  it('none when there is no sector time', () => {
    expect(sectorColorState(null, 33.1, 32.918, null)).toBe('none');
  });
  it('flag override takes priority', () => {
    expect(sectorColorState(29.9, 30.2, 29.9, 'RED')).toBe('red');
    expect(sectorColorState(29.9, 30.2, 29.9, 'YELLOW')).toBe('yellow');
  });
});

describe('driverSectorColors + trackFlagOverride', () => {
  it('colors all three sectors', () => {
    const latest = [29.9, 33.1, 32.984];
    const pb = [29.9, 33.1, 32.984];
    const sess = [29.9, 33.1, 32.918];
    expect(driverSectorColors(latest, pb, sess, null)).toEqual(['purple', 'purple', 'green']);
  });
  it('maps track status to a per-sector flag override', () => {
    expect(trackFlagOverride('RED')).toBe('RED');
    expect(trackFlagOverride('YELLOW')).toBe('YELLOW');
    expect(trackFlagOverride('SC')).toBe('YELLOW');
    expect(trackFlagOverride('VSC')).toBe('YELLOW');
    expect(trackFlagOverride('GREEN')).toBe(null);
  });
  it('applies a red flag to the whole track', () => {
    const c = driverSectorColors([30, 33, 33], [30, 33, 33], [30, 33, 33], 'RED');
    expect(c).toEqual(['red', 'red', 'red']);
  });
});

describe('splitSectorsByLength', () => {
  const cumLen = Array.from({ length: 90 }, (_, i) => i); // total ~89
  const totalLen = 90;

  it('splits into three contiguous ranges covering all points', () => {
    const ranges = splitSectorsByLength(cumLen, totalLen);
    expect(ranges[0][0]).toBe(0);
    expect(ranges[2][1]).toBe(90);
    expect(ranges[0][1]).toBe(ranges[1][0]);
    expect(ranges[1][1]).toBe(ranges[2][0]);
    // equal thirds -> boundaries near 30 and 60
    expect(Math.abs(ranges[0][1] - 30)).toBeLessThanOrEqual(1);
    expect(Math.abs(ranges[1][1] - 60)).toBeLessThanOrEqual(1);
  });

  it('respects weighted proportions', () => {
    const ranges = splitSectorsByLength(cumLen, totalLen, [0.5, 0.25, 0.25]);
    expect(Math.abs(ranges[0][1] - 45)).toBeLessThanOrEqual(1);
  });

  it('assigns indices to the correct sector', () => {
    const ranges = splitSectorsByLength(cumLen, totalLen);
    expect(sectorOfIndex(0, ranges)).toBe(0);
    expect(sectorOfIndex(45, ranges)).toBe(1);
    expect(sectorOfIndex(80, ranges)).toBe(2);
  });

  it('works with real arc lengths', () => {
    const pts = Array.from({ length: 60 }, (_, i) => {
      const th = (i / 60) * Math.PI * 2;
      return { x: Math.cos(th), y: Math.sin(th) };
    });
    const { cumLen: cl, totalLen: tl } = arcLengths(pts);
    const ranges = splitSectorsByLength(cl, tl);
    expect(ranges[2][1]).toBe(60);
  });
});
