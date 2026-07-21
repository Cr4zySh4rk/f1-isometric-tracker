// T1: the hold/release "Buffering…" state machine. Guarantees cars are never
// invisible-while-running: either the cursor sits on buffered data, or the clock
// is held (frozen in place) with the buffering chip shown.
import { describe, it, expect } from 'vitest';
import { BufferGate } from '../src/engine/bufferGate.js';

describe('BufferGate (T1 buffering hold/release)', () => {
  it('holds the clock when playback runs into unbuffered territory', () => {
    const g = new BufferGate();
    const r = g.update({ buffered: false, playing: true, live: false });
    expect(r.hold).toBe(true);
    expect(r.chip).toBe(true);
  });

  it('releases automatically the moment the cursor window data arrives', () => {
    const g = new BufferGate();
    g.update({ buffered: false, playing: true, live: false }); // holding
    const r = g.update({ buffered: true, playing: true, live: false });
    expect(r.hold).toBe(false);
    expect(r.chip).toBe(false);
  });

  it('never holds in live mode (T tracks the wall clock)', () => {
    const g = new BufferGate();
    const r = g.update({ buffered: false, playing: true, live: true });
    expect(r.hold).toBe(false);
    expect(r.chip).toBe(false);
  });

  it('does not hold while paused (a user can seek/scrub freely)', () => {
    const g = new BufferGate();
    const r = g.update({ buffered: false, playing: false, live: false });
    expect(r.hold).toBe(false);
    // chip still reflects that the cursor is starved.
    expect(r.chip).toBe(true);
  });

  it('flowing → holding → flowing across a seek into and back onto data', () => {
    const g = new BufferGate();
    expect(g.update({ buffered: true, playing: true, live: false }).hold).toBe(false);
    expect(g.update({ buffered: false, playing: true, live: false }).hold).toBe(true);
    expect(g.update({ buffered: false, playing: true, live: false }).hold).toBe(true);
    expect(g.update({ buffered: true, playing: true, live: false }).hold).toBe(false);
  });
});
