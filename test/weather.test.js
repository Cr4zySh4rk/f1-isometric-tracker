// Pure weather selection (FEATURE 3): latest sample ≤ T, rain flag, wind
// compass. Verified against real OpenF1 /weather shapes (2026 British GP).
import { describe, it, expect } from 'vitest';
import {
  normalizeWeather, weatherAt, isRaining, windCompass,
} from '../src/data/weather.js';

const RAW = [
  { date: '2026-07-05T13:09:59.184000+00:00', air_temperature: 22.8, track_temperature: 38.2, humidity: 56.5, wind_speed: 1.1, wind_direction: 212, rainfall: 0 },
  { date: '2026-07-05T13:08:59.164000+00:00', air_temperature: 22.8, track_temperature: 37.9, humidity: 55.9, wind_speed: 1.4, wind_direction: 212, rainfall: 0 },
  { date: '2026-07-05T13:10:59.200000+00:00', air_temperature: 23.1, track_temperature: 39.0, humidity: 54.0, wind_speed: 2.0, wind_direction: 90, rainfall: 1 },
];

describe('normalizeWeather', () => {
  it('sorts ascending by time and attaches epoch ms', () => {
    const n = normalizeWeather(RAW);
    expect(n.map((r) => r.t)).toEqual([...n.map((r) => r.t)].sort((a, b) => a - b));
    expect(n[0].track_temperature).toBe(37.9); // earliest
  });
  it('drops rows with unparseable dates and tolerates junk', () => {
    expect(normalizeWeather(null)).toEqual([]);
    expect(normalizeWeather([{ date: 'nope' }, null])).toEqual([]);
  });
});

describe('weatherAt (replay-time-aware)', () => {
  const n = normalizeWeather(RAW);
  it('returns the latest sample at or before T', () => {
    const t = Date.parse('2026-07-05T13:09:30+00:00');
    expect(weatherAt(n, t).track_temperature).toBe(37.9); // the 13:08:59 sample
  });
  it('returns the first sample when T precedes the timeline', () => {
    const t = Date.parse('2026-07-05T12:00:00+00:00');
    expect(weatherAt(n, t).track_temperature).toBe(37.9);
  });
  it('returns the last sample when T is past the end', () => {
    const t = Date.parse('2026-07-05T18:00:00+00:00');
    expect(weatherAt(n, t).track_temperature).toBe(39.0);
  });
  it('is null on empty', () => {
    expect(weatherAt([], 1)).toBeNull();
  });
});

describe('isRaining', () => {
  it('flags rainfall > 0', () => {
    expect(isRaining({ rainfall: 1 })).toBe(true);
    expect(isRaining({ rainfall: 0 })).toBe(false);
    expect(isRaining(null)).toBe(false);
  });
});

describe('windCompass', () => {
  it('maps degrees to 8-point compass (direction FROM)', () => {
    expect(windCompass(0)).toBe('N');
    expect(windCompass(90)).toBe('E');
    expect(windCompass(180)).toBe('S');
    expect(windCompass(270)).toBe('W');
    expect(windCompass(212)).toBe('SW');
    expect(windCompass(360)).toBe('N');
  });
  it('handles junk', () => {
    expect(windCompass(NaN)).toBe('');
  });
});
