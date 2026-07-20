// Only sessions whose data is published (ended + ~30 min) may be offered in
// the picker; fully future weekends are hidden.
import { describe, it, expect } from 'vitest';
import {
  isSessionAvailable,
  filterAvailableSessions,
  isMeetingStarted,
  filterStartedMeetings,
  PUBLISH_DELAY_MS,
} from '../src/data/availability.js';

const NOW = Date.parse('2026-07-20T12:00:00Z');
const s = (start, end) => ({ date_start: start, date_end: end });

describe('isSessionAvailable', () => {
  it('true for a session that ended more than 30 min ago', () => {
    expect(isSessionAvailable(s('2026-07-19T13:00:00+00:00', '2026-07-19T15:00:00+00:00'), NOW)).toBe(true);
  });
  it('false for a future session', () => {
    expect(isSessionAvailable(s('2026-12-04T09:30:00+00:00', '2026-12-04T10:30:00+00:00'), NOW)).toBe(false);
  });
  it('false while in progress and false until 30 min after the end', () => {
    const end = new Date(NOW - 10 * 60 * 1000).toISOString(); // ended 10 min ago
    expect(isSessionAvailable(s('2026-07-20T09:00:00Z', end), NOW)).toBe(false);
    const end2 = new Date(NOW - PUBLISH_DELAY_MS - 1000).toISOString();
    expect(isSessionAvailable(s('2026-07-20T08:00:00Z', end2), NOW)).toBe(true);
  });
  it('falls back to date_start + 4 h when date_end is missing', () => {
    expect(isSessionAvailable({ date_start: '2026-07-19T13:00:00Z' }, NOW)).toBe(true);
    expect(isSessionAvailable({ date_start: '2026-07-20T10:00:00Z' }, NOW)).toBe(false);
  });
  it('false for garbage', () => {
    expect(isSessionAvailable(null, NOW)).toBe(false);
    expect(isSessionAvailable({}, NOW)).toBe(false);
  });
});

describe('filters', () => {
  it('filterAvailableSessions keeps only published sessions', () => {
    const list = [
      s('2026-07-17T11:30:00Z', '2026-07-17T12:30:00Z'), // done
      s('2026-12-04T09:30:00Z', '2026-12-04T10:30:00Z'), // future
    ];
    expect(filterAvailableSessions(list, NOW)).toHaveLength(1);
    expect(filterAvailableSessions(undefined, NOW)).toEqual([]);
  });
  it('meeting filters hide fully future weekends', () => {
    expect(isMeetingStarted({ date_start: '2026-07-17T00:00:00Z' }, NOW)).toBe(true);
    expect(isMeetingStarted({ date_start: '2026-12-04T00:00:00Z' }, NOW)).toBe(false);
    expect(filterStartedMeetings([
      { date_start: '2026-07-17T00:00:00Z' },
      { date_start: '2026-12-04T00:00:00Z' },
    ], NOW)).toHaveLength(1);
  });
});
