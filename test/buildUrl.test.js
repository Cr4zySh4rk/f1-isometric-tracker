// Regression: internal underscore-prefixed params (e.g. the session picker's
// `_year` hint consumed by the Jolpica mapper) must never reach the OpenF1
// query string — unknown filters make the API return 404 "No results found.",
// which surfaced to users as "Failed to load sessions." on every meeting.
import { describe, it, expect } from 'vitest';
import { buildUrl } from '../src/api/openf1.js';

describe('buildUrl internal-param stripping', () => {
  it('drops keys starting with "_"', () => {
    const url = buildUrl('sessions', { meeting_key: 1290, _year: 2026 });
    expect(url).toBe('https://api.openf1.org/v1/sessions?meeting_key=1290');
  });

  it('keeps normal keys and operator keys intact', () => {
    const url = buildUrl('location', {
      session_key: 11327,
      date_gt: '2026-07-17T11:30:00.000Z',
      _hint: 'x',
    });
    expect(url).toContain('session_key=11327');
    expect(url).toContain('date>2026-07-17T11:30:00.000Z');
    expect(url).not.toContain('_hint');
  });

  it('still skips null/undefined values', () => {
    const url = buildUrl('sessions', { meeting_key: 1290, year: undefined, x: null });
    expect(url).toBe('https://api.openf1.org/v1/sessions?meeting_key=1290');
  });
});
