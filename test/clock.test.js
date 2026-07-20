import { describe, it, expect } from 'vitest';
import { PlaybackClock, SPEEDS } from '../src/engine/clock.js';

describe('PlaybackClock', () => {
  it('advances by speed × real elapsed', () => {
    const c = new PlaybackClock({ start: 1000, end: 100000 });
    c.play();
    c.tick(0); // establishes _lastWall
    c.setSpeed(2);
    c.tick(1000); // 1000ms real × 2
    expect(c.t).toBe(3000);
  });

  it('does not advance while paused', () => {
    const c = new PlaybackClock({ start: 0, end: 100000 });
    c.tick(0);
    c.tick(5000);
    expect(c.t).toBe(0);
  });

  it('clamps seeks to bounds and seeks by fraction', () => {
    const c = new PlaybackClock({ start: 1000, end: 100000 });
    c.seek(999999);
    expect(c.t).toBe(100000);
    c.seek(-50);
    expect(c.t).toBe(1000);
    c.seekFraction(0.5);
    expect(c.t).toBe(1000 + 0.5 * 99000);
    expect(c.fraction()).toBeCloseTo(0.5, 6);
  });

  it('pauses when it reaches the end', () => {
    const c = new PlaybackClock({ start: 0, end: 5000 });
    c.play();
    c.setSpeed(10);
    c.tick(0);
    c.tick(1000); // 10×1000 = 10000 > end
    expect(c.t).toBe(5000);
    expect(c.playing).toBe(false);
  });

  it('live mode forces speed 1 and tracks now − delay', () => {
    const c = new PlaybackClock({ start: 0, end: Date.now() + 1e9 });
    c.setLive(true);
    expect(c.live).toBe(true);
    expect(c.speed).toBe(1);
    const t = c.tick(123);
    expect(Math.abs(t - (Date.now() - c.liveDelay))).toBeLessThan(100);
  });

  it('exposes the speed ladder', () => {
    expect(SPEEDS).toContain(1);
    expect(SPEEDS[0]).toBe(0.5);
  });

  it('hold() freezes T for the frame without pausing (buffering)', () => {
    const c = new PlaybackClock({ start: 0, end: 100000 });
    c.play();
    c.tick(0);
    c.tick(1000);
    expect(c.t).toBe(1000);
    // Cursor window not buffered: hold each frame → T must not advance.
    c.hold(2000);
    expect(c.tick(2000)).toBe(1000);
    c.hold(3000);
    expect(c.tick(3000)).toBe(1000);
    expect(c.playing).toBe(true); // still nominally playing
    // Buffered again → resumes advancing from the same T.
    expect(c.tick(4000)).toBe(2000);
  });
});
