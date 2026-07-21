// Pure tyre-stint logic (FEATURE 1 tyre): compound + age at a driver's lap N,
// verified against real OpenF1 /stints shapes (2026 British GP, driver 1).
import { describe, it, expect } from 'vitest';
import {
  compoundInfo, stintsByDriver, stintAt, compoundAt, tyreAgeAt,
} from '../src/data/stints.js';

// Real driver-1 stints from session 11326 (verified against the live API).
const REAL = [
  { driver_number: 1, stint_number: 1, lap_start: 1, lap_end: 28, compound: 'MEDIUM', tyre_age_at_start: 0 },
  { driver_number: 1, stint_number: 2, lap_start: 29, lap_end: 38, compound: 'HARD', tyre_age_at_start: 0 },
  { driver_number: 1, stint_number: 3, lap_start: 39, lap_end: 48, compound: 'MEDIUM', tyre_age_at_start: 6 },
];

describe('compoundInfo', () => {
  it('maps each compound to the F1 TV marking colour', () => {
    expect(compoundInfo('SOFT').color).toBe('#e8443b');
    expect(compoundInfo('MEDIUM').color).toBe('#f5d23a');
    expect(compoundInfo('HARD').color).toBe('#e9edf3');
    expect(compoundInfo('INTERMEDIATE').color).toBe('#3fc65a');
    expect(compoundInfo('WET').color).toBe('#3a7bef');
  });
  it('is case-insensitive and falls back for unknowns', () => {
    expect(compoundInfo('soft').label).toBe('SOFT');
    expect(compoundInfo('mystery').short).toBe('?');
    expect(compoundInfo(null).label).toBe('—');
  });
});

describe('stintsByDriver', () => {
  it('groups and sorts by lap_start', () => {
    const m = stintsByDriver([REAL[2], REAL[0], REAL[1]]);
    const arr = m.get(1);
    expect(arr.map((s) => s.stint_number)).toEqual([1, 2, 3]);
  });
  it('tolerates junk input', () => {
    expect(stintsByDriver(null).size).toBe(0);
    expect(stintsByDriver([null, {}]).size).toBe(0);
  });
});

describe('compoundAt / tyreAgeAt (replay-time-aware by lap)', () => {
  it('picks the compound in force on a given lap', () => {
    expect(compoundAt(REAL, 1)).toBe('MEDIUM');
    expect(compoundAt(REAL, 28)).toBe('MEDIUM');
    expect(compoundAt(REAL, 29)).toBe('HARD');
    expect(compoundAt(REAL, 40)).toBe('MEDIUM');
  });
  it('ages the tyre within a stint (base age + laps run)', () => {
    expect(tyreAgeAt(REAL, 1)).toBe(0);   // lap 1 of a fresh medium
    expect(tyreAgeAt(REAL, 28)).toBe(27); // 27 laps into stint 1
    expect(tyreAgeAt(REAL, 29)).toBe(0);  // fresh hard
    expect(tyreAgeAt(REAL, 39)).toBe(6);  // used medium, age_at_start 6, lap 0 of stint
    expect(tyreAgeAt(REAL, 42)).toBe(9);  // +3 laps
  });
  it('handles the inclusive lap_end / tail-lap off-by-one', () => {
    // A lap beyond the last stint's lap_end still resolves to that stint.
    expect(compoundAt(REAL, 60)).toBe('MEDIUM');
    expect(stintAt(REAL, 60).stint_number).toBe(3);
  });
  it('returns null on empty input', () => {
    expect(compoundAt([], 5)).toBeNull();
    expect(tyreAgeAt(undefined, 5)).toBeNull();
  });
});
