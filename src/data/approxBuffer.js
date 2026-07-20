// Approximate-mode replay "buffer": a drop-in for ReplayBuffer's sampling
// interface used when the active provider has NO x/y telemetry (Jolpica
// fallback). Instead of fetching /location windows, it estimates each driver's
// position from their lap timeline (progress = elapsed-in-lap / lap_duration)
// mapped onto a cached/derived/synthetic centerline via approxPosition.
//
// It exposes the same shape the main loop / HUD / transport expect:
//   sampleAll(tMs) -> Map(num -> { x, y, heading, alpha, present })  (world coords)
//   update(tMs)          no-op (nothing to prefetch)
//   loadedFractions()    the whole timeline is "buffered"
//   intervalAt()         null (Ergast has no windowed intervals)
//   isCursorBuffered()   always true

import { buildCenterlineArc, driverLapTimeline, approxPositionAt } from './approxPosition.js';

export class ApproxBuffer {
  constructor(store, centerlineRaw) {
    this.store = store;
    this.arc = buildCenterlineArc(centerlineRaw || []);
    this.approx = true;
    this._timelines = new Map(); // driver_number -> normalized lap timeline
    this.onLiveBlock = null;
    this.onProgress = null;
  }

  _timeline(num) {
    let tl = this._timelines.get(num);
    if (!tl) { tl = driverLapTimeline(this.store.laps, num); this._timelines.set(num, tl); }
    return tl;
  }

  update() { /* nothing to prefetch */ }

  loadedFractions() { return [[0, 1]]; }
  isCursorBuffered() { return true; }
  intervalAt() { return null; }

  sampleAll(tMs) {
    const out = new Map();
    if (!this.arc || !this.arc.n) return out;
    for (const d of this.store.drivers) {
      const num = d.driver_number;
      const p = approxPositionAt({
        driverNumber: num, tMs, arc: this.arc, timeline: this._timeline(num),
      });
      if (p) out.set(num, { x: p.x, y: p.y, heading: p.heading, alpha: p.alpha, present: p.present });
    }
    return out;
  }
}
