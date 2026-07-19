import { describe, it, expect } from 'vitest';
import { DriverTrack, catmullRom } from '../src/engine/interp.js';

describe('catmullRom', () => {
  it('passes through control points at u=0 and u=1', () => {
    expect(catmullRom(0, 1, 2, 3, 0)).toBeCloseTo(1, 9);
    expect(catmullRom(0, 1, 2, 3, 1)).toBeCloseTo(2, 9);
  });
  it('is linear for evenly-spaced collinear points', () => {
    expect(catmullRom(0, 1, 2, 3, 0.5)).toBeCloseTo(1.5, 9);
  });
});

describe('DriverTrack', () => {
  it('interpolates smoothly between samples', () => {
    const tr = new DriverTrack(44);
    tr.addBatch([
      { t: 0, x: 0, y: 0, z: 0 },
      { t: 100, x: 1, y: 0, z: 0 },
      { t: 200, x: 2, y: 0, z: 0 },
      { t: 300, x: 3, y: 0, z: 0 },
    ]);
    const s = tr.sampleAt(150);
    expect(s.present).toBe(true);
    expect(s.x).toBeCloseTo(1.5, 6);
    expect(s.alpha).toBe(1);
  });

  it('fades out across a large data gap (pits)', () => {
    const tr = new DriverTrack(44);
    tr.addBatch([
      { t: 0, x: 0, y: 0, z: 0 },
      { t: 200, x: 2, y: 0, z: 0 },
      { t: 20000, x: 2, y: 0, z: 0 }, // 19.8s gap
    ]);
    const s = tr.sampleAt(10000);
    expect(s.present).toBe(false);
    expect(s.alpha).toBeLessThan(1);
  });

  it('sorts + dedups samples and reports bounds', () => {
    const tr = new DriverTrack(1);
    tr.addBatch([
      { t: 200, x: 2, y: 0, z: 0 },
      { t: 0, x: 0, y: 0, z: 0 },
      { t: 200, x: 2, y: 0, z: 0 }, // duplicate timestamp
      { t: 100, x: 1, y: 0, z: 0 },
    ]);
    const b = tr.bounds();
    expect(b).toEqual({ start: 0, end: 200 });
    expect(tr.samples.length).toBe(3);
  });

  it('evicts old samples but keeps one before the cutoff', () => {
    const tr = new DriverTrack(1);
    tr.addBatch([
      { t: 0, x: 0, y: 0, z: 0 },
      { t: 100, x: 1, y: 0, z: 0 },
      { t: 200, x: 2, y: 0, z: 0 },
      { t: 300, x: 3, y: 0, z: 0 },
    ]);
    tr.evictBefore(250);
    // keeps the sample just before 250 (t=200) so interpolation still works
    expect(tr.samples[0].t).toBe(200);
    expect(tr.samples.length).toBe(2);
  });
});
