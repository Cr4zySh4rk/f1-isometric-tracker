import { describe, it, expect } from 'vitest';
import { DriverTrack, catmullRom, chooseHeading, SLOW_SPEED } from '../src/engine/interp.js';

describe('catmullRom', () => {
  it('passes through control points at u=0 and u=1', () => {
    expect(catmullRom(0, 1, 2, 3, 0)).toBeCloseTo(1, 9);
    expect(catmullRom(0, 1, 2, 3, 1)).toBeCloseTo(2, 9);
  });
  it('is linear for evenly-spaced collinear points', () => {
    expect(catmullRom(0, 1, 2, 3, 0.5)).toBeCloseTo(1.5, 9);
  });
});

describe('chooseHeading (velocity vs track tangent by speed)', () => {
  const vel = 0.3; // some noisy velocity heading
  const tan = 1.2; // track tangent heading

  it('uses the track tangent when stationary/crawling', () => {
    expect(chooseHeading({ velocityHeading: vel, tangentHeading: tan, speed: 0 })).toBe(tan);
    expect(chooseHeading({ velocityHeading: vel, tangentHeading: tan, speed: SLOW_SPEED - 1 })).toBe(tan);
  });

  it('uses the velocity heading when moving normally', () => {
    expect(chooseHeading({ velocityHeading: vel, tangentHeading: tan, speed: 400 })).toBe(vel);
    expect(chooseHeading({ velocityHeading: vel, tangentHeading: tan, speed: SLOW_SPEED + 1 })).toBe(vel);
  });

  it('falls back gracefully when a heading is missing/non-finite', () => {
    expect(chooseHeading({ velocityHeading: vel, tangentHeading: null, speed: 0 })).toBe(vel);
    expect(chooseHeading({ velocityHeading: NaN, tangentHeading: tan, speed: 500 })).toBe(tan);
    expect(chooseHeading({ velocityHeading: null, tangentHeading: null, speed: 0 })).toBe(0);
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

  it('reports local speed ~0 when stationary and high when moving', () => {
    const still = new DriverTrack(1);
    still.addBatch([
      { t: 0, x: 100, y: 200, z: 0 },
      { t: 300, x: 100, y: 200, z: 0 },
      { t: 600, x: 100, y: 200, z: 0 },
    ]);
    expect(still.sampleAt(300).speed).toBeCloseTo(0, 6);

    const moving = new DriverTrack(2);
    // 30 dm every 100 ms ⇒ 300 dm/s
    moving.addBatch([
      { t: 0, x: 0, y: 0, z: 0 },
      { t: 100, x: 30, y: 0, z: 0 },
      { t: 200, x: 60, y: 0, z: 0 },
      { t: 300, x: 90, y: 0, z: 0 },
    ]);
    expect(moving.sampleAt(150).speed).toBeCloseTo(300, 3);
  });

  it('exposes endGap growing past the last sample (retirement signal)', () => {
    const tr = new DriverTrack(1);
    tr.addBatch([
      { t: 0, x: 0, y: 0, z: 0 },
      { t: 1000, x: 10, y: 0, z: 0 },
    ]);
    expect(tr.sampleAt(500).endGap).toBe(0);
    expect(tr.sampleAt(6000).endGap).toBe(5000);
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
