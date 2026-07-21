// T4 safety car: telemetry driver_numbers absent from the session /drivers list
// are the FIA safety / medical cars. classifyEntrant is the single source of
// truth CarManager uses to give SC/MED entries a road-car model + SC/MED label
// and to keep them out of raycast picking (and the timing tower).
import { describe, it, expect } from 'vitest';
import { classifyEntrant, SAFETY_CAR_LABELS } from '../src/data/entrants.js';

// The real store exposes driversByNumber as a Map; classifyEntrant only needs
// `.has(num)`, so a Set works too.
const drivers = new Map([[1, {}], [16, {}], [44, {}], [81, {}]]);

describe('classifyEntrant (T4)', () => {
  it('a registered driver is a pickable driver', () => {
    expect(classifyEntrant(44, drivers)).toEqual({ type: 'driver' });
    expect(classifyEntrant(1, new Set([1, 44]))).toEqual({ type: 'driver' });
  });

  it('the verified real safety-car numbers 241/242 → safety "SC"', () => {
    expect(classifyEntrant(241, drivers)).toEqual({ type: 'safety', label: 'SC' });
    expect(classifyEntrant(242, drivers)).toEqual({ type: 'safety', label: 'SC' });
  });

  it('the verified real medical-car number 243 → medical "MED"', () => {
    expect(classifyEntrant(243, drivers)).toEqual({ type: 'medical', label: 'MED' });
  });

  it('any unknown non-driver number defaults to a safety-class entrant', () => {
    const r = classifyEntrant(999, drivers);
    expect(r.type).toBe('safety');
    expect(r.label).toBe('SC');
  });

  it('label table matches the numbers verified against real SC deployments', () => {
    expect(SAFETY_CAR_LABELS).toMatchObject({ 241: 'SC', 242: 'SC', 243: 'MED' });
  });
});
