import { describe, it, expect } from 'vitest';
import {
  normalizeRaceControl, trackStatusAt, penaltiesAt, parsePenalty,
} from '../src/data/raceControl.js';
import rc from './fixtures/race_control.json';

const events = normalizeRaceControl(rc);
const T = (iso) => Date.parse(`2025-07-01T${iso}Z`);

describe('normalizeRaceControl', () => {
  it('sorts by date and attaches tMs', () => {
    for (let i = 1; i < events.length; i++) {
      expect(events[i].tMs).toBeGreaterThanOrEqual(events[i - 1].tMs);
    }
  });
});

describe('trackStatusAt (time-aware)', () => {
  const at = (iso) => trackStatusAt(events, T(iso)).status;
  it('green at the start', () => expect(at('13:00:30')).toBe('GREEN'));
  it('yellow', () => expect(at('13:05:30')).toBe('YELLOW'));
  it('double yellow', () => expect(at('13:06:30')).toBe('DOUBLE_YELLOW'));
  it('clears to green', () => expect(at('13:08:00')).toBe('GREEN'));
  it('safety car deployed', () => expect(at('13:11:00')).toBe('SC'));
  it('safety car ends (in this lap)', () => expect(at('13:13:00')).toBe('GREEN'));
  it('virtual safety car', () => expect(at('13:20:30')).toBe('VSC'));
  it('vsc ends', () => expect(at('13:22:00')).toBe('GREEN'));
  it('red flag', () => expect(at('13:41:00')).toBe('RED'));
  it('chequered', () => expect(at('13:56:00')).toBe('CHEQUERED'));

  it('reports label + pulse metadata', () => {
    const red = trackStatusAt(events, T('13:41:00'));
    expect(red.label).toBe('RED FLAG');
    expect(red.pulse).toBe(true);
    const green = trackStatusAt(events, T('13:00:30'));
    expect(green.pulse).toBe(false);
  });
});

describe('parsePenalty', () => {
  it('parses a time penalty', () => {
    const p = parsePenalty('5 SECOND TIME PENALTY FOR CAR 44 (HAM)');
    expect(p).toMatchObject({ driver: 44, type: '+5s', seconds: 5 });
  });
  it('parses stop/go and drive-through', () => {
    expect(parsePenalty('10 SECOND STOP/GO PENALTY FOR CAR 1 (VER)').type).toBe('SG');
    expect(parsePenalty('DRIVE THROUGH PENALTY FOR CAR 16 (LEC)').type).toBe('DT');
  });
  it('returns null for non-penalty messages', () => {
    expect(parsePenalty('GREEN LIGHT')).toBe(null);
    expect(parsePenalty('YELLOW IN TRACK SECTOR 5')).toBe(null);
  });
});

describe('penaltiesAt (time-aware)', () => {
  it('has no penalties before they are issued', () => {
    expect(penaltiesAt(events, T('13:24:00')).size).toBe(0);
  });
  it('accumulates penalties per driver up to T', () => {
    const map = penaltiesAt(events, T('13:30:00'));
    expect(map.get(44)[0].type).toBe('+5s');
    expect(map.get(1)[0].type).toBe('SG');
    expect(map.get(16)[0].type).toBe('DT');
  });
});
