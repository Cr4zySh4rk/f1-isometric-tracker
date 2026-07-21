// Pure team-radio selection (FEATURE 2): normalise a driver's clips, pick the
// latest clip ≤ T (never a future clip), and list all clips ≤ T most-recent
// first. Verified against real OpenF1 /team_radio shapes.
import { describe, it, expect } from 'vitest';
import {
  normalizeClips, latestClipAtOrBefore, clipsUpTo,
} from '../src/data/radio.js';

const RAW = [
  { driver_number: 1, date: '2026-07-05T15:37:28.033000+00:00', recording_url: 'https://x/NOR_c.mp3' },
  { driver_number: 1, date: '2026-07-05T14:20:00.000000+00:00', recording_url: 'https://x/NOR_a.mp3' },
  { driver_number: 1, date: '2026-07-05T15:00:00.000000+00:00', recording_url: 'https://x/NOR_b.mp3' },
  { driver_number: 44, date: '2026-07-05T14:30:00.000000+00:00', recording_url: 'https://x/HAM.mp3' },
  { driver_number: 1, date: 'bad-date', recording_url: 'https://x/skip.mp3' },
  { driver_number: 1, date: '2026-07-05T14:10:00.000000+00:00' }, // no url → skipped
];

describe('normalizeClips', () => {
  it('filters to one driver, drops bad/urless rows, sorts ascending', () => {
    const c = normalizeClips(RAW, 1);
    expect(c.map((x) => x.url)).toEqual(['https://x/NOR_a.mp3', 'https://x/NOR_b.mp3', 'https://x/NOR_c.mp3']);
  });
  it('tolerates junk input', () => {
    expect(normalizeClips(null, 1)).toEqual([]);
  });
});

describe('latestClipAtOrBefore (replay-time-aware, no future clips)', () => {
  const c = normalizeClips(RAW, 1);
  it('returns the most recent clip at or before T', () => {
    const t = Date.parse('2026-07-05T15:10:00+00:00');
    expect(latestClipAtOrBefore(c, t).url).toBe('https://x/NOR_b.mp3');
  });
  it('never returns a future clip', () => {
    const t = Date.parse('2026-07-05T14:00:00+00:00');
    expect(latestClipAtOrBefore(c, t)).toBeNull();
  });
  it('returns the newest once T is past all clips', () => {
    const t = Date.parse('2026-07-05T16:00:00+00:00');
    expect(latestClipAtOrBefore(c, t).url).toBe('https://x/NOR_c.mp3');
  });
});

describe('clipsUpTo', () => {
  const c = normalizeClips(RAW, 1);
  it('lists clips ≤ T most-recent first', () => {
    const t = Date.parse('2026-07-05T15:10:00+00:00');
    expect(clipsUpTo(c, t).map((x) => x.url)).toEqual(['https://x/NOR_b.mp3', 'https://x/NOR_a.mp3']);
  });
  it('is empty before the first clip', () => {
    expect(clipsUpTo(c, Date.parse('2026-07-05T13:00:00+00:00'))).toEqual([]);
  });
});
