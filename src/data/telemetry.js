// Pure telemetry helpers for the focused-driver /car_data feed (no DOM/network).
//
// /car_data rows (~3.7 Hz): { date, speed(km/h), throttle(0-100), brake(0/100),
// rpm, n_gear, drs }. We HOLD the nearest sample at or before T (no interpolation
// of discrete fields like gear/DRS; speed/throttle read as the held sample) so
// the panel is smooth and never flickers or reads the future.

// DRS status from OpenF1's coded value. Codes (verified): 0/1 = off, 8 = eligible
// (not yet open), 10/12/14 = open. Treat ≥ 10 as OPEN, else CLOSED. null → CLOSED.
export function drsState(code) {
  const n = Number(code);
  return Number.isFinite(n) && n >= 10 ? 'OPEN' : 'CLOSED';
}

// Gear label: 0 (or null) → "N" (neutral), else the gear number.
export function gearLabel(nGear) {
  const n = Number(nGear);
  if (!Number.isFinite(n) || n <= 0) return 'N';
  return String(n);
}

// Parse a raw /car_data row to { t, speed, throttle, brake, rpm, gear, drs } with
// t = epoch ms. Returns null if the timestamp is unparseable.
export function parseCarSample(row) {
  if (!row) return null;
  const t = Date.parse(row.date);
  if (!Number.isFinite(t)) return null;
  return {
    t,
    speed: numOr(row.speed, null),
    throttle: clamp01to100(row.throttle),
    brake: clamp01to100(row.brake),
    rpm: numOr(row.rpm, null),
    gear: row.n_gear == null ? null : Number(row.n_gear),
    drs: row.drs == null ? null : Number(row.drs),
  };
}

// Latest sample at or before tMs from a time-sorted array (binary search).
// Returns the sample or null (never a future sample). `getT` extracts the epoch
// ms from an element (defaults to `.t`).
export function latestAtOrBefore(sorted, tMs, getT = (s) => s.t) {
  if (!Array.isArray(sorted) || !sorted.length) return null;
  let lo = 0, hi = sorted.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (getT(sorted[mid]) <= tMs) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans >= 0 ? sorted[ans] : null;
}

function numOr(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function clamp01to100(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

// ---------------------------------------------------------------------------
// FocusedTelemetry — a small windowed /car_data buffer for the ONE focused
// driver. Modelled on data/replayBuffer.js but single-driver and lightweight:
// on focus we prefetch a small window around the cursor T, keep the parsed
// samples time-sorted, and evict behind. The window duration scales with the
// playback speed (shared data/windowPlan.js) so prefetch stays inside the
// OpenF1 30 req/min budget at high speed. All fetches route through the same
// ProviderManager (rate-limited queue), and everything disposes on unfocus /
// session switch so nothing leaks.
// ---------------------------------------------------------------------------
import { windowMsForSpeed } from './windowPlan.js';

const AHEAD = 2;   // prefetch this many windows ahead of the cursor
const BEHIND = 1;  // keep this many windows behind before eviction

export class FocusedTelemetry {
  // `source` is the data-source facade (ProviderManager / provider) with
  // getCarData(session, driverNumber, aISO, bISO) → rows or null (no telemetry).
  constructor(store, source, { ahead = AHEAD, behind = BEHIND } = {}) {
    this.store = store;
    this.source = source;
    this.session = store.session;
    const { start, end } = store.timeWindow();
    this.startMs = Date.parse(start);
    this.endMs = Date.parse(end);
    if (!Number.isFinite(this.startMs)) this.startMs = Date.now() - 3600000;
    if (!Number.isFinite(this.endMs)) this.endMs = this.startMs + 3600000;
    this.ahead = ahead;
    this.behind = behind;
    this.windowMs = windowMsForSpeed(1);
    this.num = null;         // focused driver number (null = idle/disposed)
    this.samples = [];       // time-sorted parsed car-data samples
    this.coverage = [];      // merged [a,b] fetched session-time ranges
    this._inflight = new Set();
    this._unavailable = false; // provider returned null (no telemetry)
  }

  // Focus a driver: reset state and immediately allow prefetch. Idempotent for
  // the same driver so repeated focus calls don't wipe the warm buffer.
  start(num) {
    if (this.num === num) return;
    this.num = num;
    this.samples = [];
    this.coverage = [];
    this._inflight.clear();
    this._unavailable = false;
  }

  // Stop + release everything (unfocus / session switch).
  stop() {
    this.num = null;
    this.samples = [];
    this.coverage = [];
    this._inflight.clear();
  }
  dispose() { this.stop(); }

  hasData() { return this.samples.length > 0; }
  isUnavailable() { return this._unavailable; }

  windowIndex(tMs) { return Math.floor((tMs - this.startMs) / this.windowMs); }

  // Ensure the windows around T are fetched; evict behind. Call every frame
  // while focused. `speed` scales the window size (windowPlan).
  update(tMs, speed) {
    if (this.num == null) return;
    if (speed != null) this.windowMs = windowMsForSpeed(speed);
    const cur = this.windowIndex(tMs);
    const lastIdx = Math.floor((this.endMs - this.startMs) / this.windowMs);
    for (let i = cur - this.behind; i <= cur + this.ahead; i++) {
      if (i < 0 || i > lastIdx) continue;
      const a = this.startMs + i * this.windowMs;
      const b = a + this.windowMs;
      // Coverage is tracked as the pure window span [a, b] (adjacent windows
      // merge), so check against that — the fetch itself pads a ±500 ms seam for
      // neighbour samples, but that padding is not part of the stored coverage.
      if (this._coversRange(a, b)) continue;
      this._fetchWindow(a, b);
    }
    this._evict(cur);
  }

  _evict(cur) {
    const cutoffMs = this.startMs + (cur - this.behind) * this.windowMs;
    if (cutoffMs <= this.startMs) return;
    if (this.samples.length && this.samples[0].t < cutoffMs) {
      this.samples = this.samples.filter((s) => s.t >= cutoffMs);
    }
    this.coverage = this.coverage
      .map(([a, b]) => [Math.max(a, cutoffMs), b])
      .filter(([a, b]) => b - a > 1000);
  }

  async _fetchWindow(a, b) {
    const key = Math.round(a);
    if (this._inflight.has(key)) return;
    this._inflight.add(key);
    const num = this.num;
    const sISO = new Date(a - 500).toISOString();
    const eISO = new Date(b + 500).toISOString();
    try {
      const rows = await this.source.getCarData(this.session, num, sISO, eISO);
      if (this.num !== num) return; // focus changed mid-flight → drop
      if (rows == null) { this._unavailable = true; return; } // no telemetry (approx)
      this._ingest(rows);
      this._addCoverage(a, b);
    } catch {
      // transient failure — leave the window uncovered so a later update() retries.
    } finally {
      this._inflight.delete(key);
    }
  }

  _ingest(rows) {
    if (!Array.isArray(rows) || !rows.length) return;
    const seen = new Set(this.samples.map((s) => s.t));
    for (const r of rows) {
      const s = parseCarSample(r);
      if (!s || seen.has(s.t)) continue;
      seen.add(s.t);
      this.samples.push(s);
    }
    this.samples.sort((x, y) => x.t - y.t);
  }

  _addCoverage(a, b) {
    const ranges = [...this.coverage, [a, b]].sort((r, s) => r[0] - s[0]);
    const merged = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
      else merged.push([r[0], r[1]]);
    }
    this.coverage = merged;
  }

  _coversRange(a, b) {
    for (const [x, y] of this.coverage) if (a >= x && b <= y) return true;
    return false;
  }

  // The telemetry sample to display at T: the latest sample at or before T
  // (never a future sample). null if nothing has been fetched around T yet.
  sampleAt(tMs) {
    return latestAtOrBefore(this.samples, tMs);
  }
}
