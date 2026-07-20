// Playback clock. Maps wall-clock time to "session time T" (ms epoch).
//
// Modes:
//  - replay: T advances by (speed × real elapsed) between start and end bounds.
//  - live:   T = Date.now() - liveDelay (3 s). Speed is forced to 1.
//
// The clock does not run a timer itself; callers tick() it each animation frame
// with the current performance.now() timestamp.

export const SPEEDS = [0.5, 1, 2, 5, 10, 30];

export class PlaybackClock {
  constructor({ start, end }) {
    this.start = start; // ms epoch
    this.end = end; // ms epoch
    this.t = start; // current session time (ms)
    this.speed = 1;
    this.playing = false;
    this.live = false;
    this.liveDelay = 3000;
    this._lastWall = null;
    this.listeners = new Set();
  }

  setBounds(start, end) {
    this.start = start;
    this.end = end;
    this.t = clamp(this.t, start, end);
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  _emit(kind) {
    for (const fn of this.listeners) {
      try { fn(this, kind); } catch { /* ignore */ }
    }
  }

  play() {
    if (this.playing) return;
    this.playing = true;
    this._lastWall = null;
    this._emit('play');
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this._emit('pause');
  }

  toggle() {
    this.playing ? this.pause() : this.play();
  }

  setSpeed(s) {
    this.speed = s;
    this._emit('speed');
  }

  seek(tMs) {
    this.t = clamp(tMs, this.start, this.end);
    this._emit('seek');
  }

  // Seek by normalized fraction [0,1] over the session.
  seekFraction(f) {
    this.seek(this.start + clamp(f, 0, 1) * (this.end - this.start));
  }

  fraction() {
    if (this.end <= this.start) return 0;
    return (this.t - this.start) / (this.end - this.start);
  }

  setLive(on) {
    this.live = on;
    if (on) {
      this.speed = 1;
      this.playing = true;
    }
    this._emit('live');
  }

  // Hold playback for this frame without pausing: resets the wall reference so
  // the next tick() advances T by ~0. Used while the cursor window is still
  // buffering, so the clock doesn't run through unfetched data.
  hold(wallNow) {
    this._lastWall = wallNow;
  }

  // Advance the clock. `wallNow` is a monotonic ms timestamp (performance.now()).
  tick(wallNow) {
    if (this.live) {
      this.t = Date.now() - this.liveDelay;
      this._lastWall = wallNow;
      return this.t;
    }
    if (!this.playing) {
      this._lastWall = wallNow;
      return this.t;
    }
    if (this._lastWall == null) {
      this._lastWall = wallNow;
      return this.t;
    }
    const dReal = wallNow - this._lastWall;
    this._lastWall = wallNow;
    this.t += dReal * this.speed;
    if (this.t >= this.end) {
      this.t = this.end;
      this.pause();
    }
    return this.t;
  }
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
