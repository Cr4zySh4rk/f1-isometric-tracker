// Buffering gate: a tiny hold/release state machine between the playback clock
// and the replay buffer. Whenever the cursor reaches unbuffered territory (a
// far seek, or sustained prefetch starvation at high speeds) the gate HOLDS the
// clock — playback freezes in place with a "Buffering…" chip — and RELEASES
// automatically the moment the cursor window's data arrives. Cars can therefore
// never be invisible-while-running: either the cursor sits on buffered data, or
// the clock is held.
//
// Pure and frame-driven: call update() once per frame with the current facts.

export class BufferGate {
  constructor() {
    this.state = 'flowing'; // 'flowing' | 'holding'
  }

  /**
   * @param {object} f  { buffered, playing, live }
   *   buffered: cursor window has settled data
   *   playing:  clock is playing (not paused)
   *   live:     live mode (never held — T tracks the wall clock)
   * @returns {{ hold: boolean, chip: boolean }}
   *   hold: caller must clock.hold(now) this frame (before tick)
   *   chip: show the "Buffering…" indicator
   */
  update({ buffered, playing, live }) {
    const starved = !buffered && !live;
    if (this.state === 'flowing') {
      if (starved && playing) this.state = 'holding';
    } else if (!starved || !playing) {
      this.state = 'flowing';
    }
    return { hold: this.state === 'holding', chip: starved };
  }
}
