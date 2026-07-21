// T1 cars-vanish-on-seek / high-speed: the pure window-sizing math must keep the
// chunked prefetcher inside the OpenF1 30 req/min budget at every playback speed,
// so windows are always fetched ahead of the cursor and cars never vanish.
import { describe, it, expect } from 'vitest';
import {
  windowMsForSpeed, intervalStrideForSpeed, requestBudgetPerMin,
  BASE_WINDOW_MS, MAX_WINDOW_MS,
} from '../src/data/windowPlan.js';
import { SPEEDS } from '../src/engine/clock.js';

describe('windowPlan request budget (T1)', () => {
  it('requestBudgetPerMin(30) stays within the 30 req/min OpenF1 limit', () => {
    expect(requestBudgetPerMin(30)).toBeLessThanOrEqual(30);
  });

  it('every selectable playback speed fits the 30 req/min budget', () => {
    for (const s of SPEEDS) {
      expect(requestBudgetPerMin(s)).toBeLessThanOrEqual(30);
    }
  });

  it('window duration grows with speed but never exceeds the response-size cap', () => {
    expect(windowMsForSpeed(1)).toBe(BASE_WINDOW_MS);
    expect(windowMsForSpeed(30)).toBeGreaterThan(windowMsForSpeed(1));
    for (const s of [1, 2, 5, 10, 30, 100]) {
      expect(windowMsForSpeed(s)).toBeGreaterThanOrEqual(BASE_WINDOW_MS);
      expect(windowMsForSpeed(s)).toBeLessThanOrEqual(MAX_WINDOW_MS);
    }
  });

  it('intervals are subsampled at high speed to halve their request cost', () => {
    expect(intervalStrideForSpeed(1)).toBe(1);
    expect(intervalStrideForSpeed(5)).toBe(1);
    expect(intervalStrideForSpeed(10)).toBeGreaterThanOrEqual(2);
    expect(intervalStrideForSpeed(30)).toBeGreaterThanOrEqual(2);
  });

  it('is defensive against junk speeds (treated as >= 1x)', () => {
    for (const bad of [0, -5, NaN, undefined, null]) {
      expect(windowMsForSpeed(bad)).toBe(BASE_WINDOW_MS);
      expect(requestBudgetPerMin(bad)).toBeLessThanOrEqual(30);
    }
  });
});
