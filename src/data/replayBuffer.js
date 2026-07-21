// Chunked streaming replay buffer.
//
// The session is divided into windows of `windowMs` of *session time*. For the
// window containing the playback cursor and PREFETCH_AHEAD windows in front, we
// fetch /location (and /intervals for races) for ALL drivers in one request
// each. Windows far behind the cursor are evicted to cap memory.
//
// SPEED-AWARE WINDOW SIZING (see data/windowPlan.js): at high playback speeds a
// fixed 90 s window cannot be prefetched inside the 30 req/min budget, so the
// window duration scales with speed (one fetch covers ≥ 15 s of wall-clock)
// and the intervals feed is subsampled (every Nth window). Because the window
// grid can therefore change at runtime, fetched session-time COVERAGE is
// tracked as merged [start,end] ranges independent of the grid — a re-grid
// keeps everything already fetched and never refetches covered spans.
//
// Location rows feed per-driver DriverTrack instances (engine/interp.js), which
// own the interpolation. Intervals are stored as time-sorted arrays per driver.

import { LiveBlockError } from '../api/openf1.js';
import { OpenF1Provider } from './providers/openf1Provider.js';
import { DriverTrack } from '../engine/interp.js';
import { BASE_WINDOW_MS, windowMsForSpeed, intervalStrideForSpeed } from './windowPlan.js';

const WINDOW_MS = BASE_WINDOW_MS; // re-exported for back-compat
const PREFETCH_AHEAD = 3; // keep 3 windows ahead of the cursor
const KEEP_BEHIND = 1; // keep 1 window behind before eviction

export class ReplayBuffer {
  constructor(store, source) {
    this.store = store;
    // Data-source facade (ProviderManager) or provider with
    // getLocationWindow/getIntervals(session, aISO, bISO). Defaults to OpenF1.
    this.source = source || new OpenF1Provider();
    this.sessionKey = store.sessionKey;
    this.isRace = store.isRace();
    const { start, end } = store.timeWindow();
    this.startMs = Date.parse(start);
    this.endMs = Date.parse(end);
    if (isNaN(this.startMs)) this.startMs = Date.now() - 3600000;
    if (isNaN(this.endMs)) this.endMs = this.startMs + 3600000;

    this.windowMs = BASE_WINDOW_MS; // current grid pitch (scales with speed)
    this._ivStride = 1; // fetch intervals every Nth window
    this._gridGen = 0; // bumped on re-grid; stale fetches re-sync via coverage
    this.coverage = []; // merged, sorted [startMs, endMs] fetched ranges

    this.tracks = new Map(); // driver_number -> DriverTrack
    this.intervals = new Map(); // driver_number -> [{t, gap, interval}]
    this.windows = new Map(); // windowIndex -> 'pending' | 'loaded' | 'error' | 'liveblock'
    this.onLiveBlock = null; // callback
    this.onProgress = null; // callback(loadedWindowSet)
    this._inflight = new Set();
  }

  track(num) {
    let t = this.tracks.get(num);
    if (!t) { t = new DriverTrack(num); this.tracks.set(num, t); }
    return t;
  }

  windowIndex(tMs) {
    return Math.floor((tMs - this.startMs) / this.windowMs);
  }
  windowRange(idx) {
    const a = this.startMs + idx * this.windowMs;
    // Small overlap so interpolation across window seams has neighbor samples.
    return { start: a - 500, end: a + this.windowMs + 500 };
  }
  totalWindows() {
    return Math.max(1, Math.ceil((this.endMs - this.startMs) / this.windowMs));
  }

  // Rescale the window grid for the current playback speed. Cheap when nothing
  // changes. On change, already-fetched coverage is kept and mapped onto the
  // new grid (fully covered windows are marked 'loaded' so they never refetch).
  setSpeed(speed) {
    this._ivStride = intervalStrideForSpeed(speed);
    const target = windowMsForSpeed(speed);
    if (target === this.windowMs) return;
    this.windowMs = target;
    this._gridGen++;
    // Rebuild the grid: fetched coverage is kept; anything not fully covered is
    // refetched by update(). (A live-blocked window simply re-detects the block
    // on its next fetch and re-fires onLiveBlock — no state is lost.)
    this.windows = new Map();
    this._markCoveredWindows();
  }

  // Which windows are currently loaded (for the transport buffered indicator).
  loadedFractions() {
    const span = this.endMs - this.startMs || 1;
    return this.coverage.map(([a, b]) => [
      Math.max(0, (a - this.startMs) / span),
      Math.min(1, (b - this.startMs) / span),
    ]);
  }

  // Ensure windows around the cursor are fetched. Call every frame (cheap).
  // `speed` (optional) is the playback speed — drives the window-sizing math.
  update(tMs, speed) {
    if (speed != null) this.setSpeed(speed);
    const cur = this.windowIndex(tMs);
    const last = this.totalWindows() - 1;
    for (let i = cur; i <= Math.min(last, cur + PREFETCH_AHEAD); i++) {
      if (i < 0) continue;
      const st = this.windows.get(i);
      // Fetch never-seen windows; retry previously errored ones (but not
      // in-flight, loaded or live-blocked ones).
      if (st === undefined || st === 'error') this._fetchWindow(i);
    }
    this._evict(cur);
  }

  _evict(cur) {
    const cutoff = cur - KEEP_BEHIND;
    if (cutoff <= 0) return;
    const cutoffMs = this.startMs + cutoff * this.windowMs;
    for (const [idx, st] of [...this.windows]) {
      if (idx < cutoff && st === 'loaded') {
        this.windows.delete(idx); // allow refetch if we seek back
      }
    }
    // Trim coverage behind the cutoff — those samples are being evicted, so a
    // seek back must refetch them.
    this.coverage = this.coverage
      .map(([a, b]) => [Math.max(a, cutoffMs), b])
      .filter(([a, b]) => b - a > 1000);
    for (const t of this.tracks.values()) t.evictBefore(cutoffMs);
    for (const [num, arr] of this.intervals) {
      let i = 0;
      while (i < arr.length && arr[i].t < cutoffMs) i++;
      if (i > 1) this.intervals.set(num, arr.slice(i - 1));
    }
  }

  // --- coverage bookkeeping (grid-independent fetched ranges) ---------------

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

  coversPoint(tMs) {
    for (const [a, b] of this.coverage) if (tMs >= a && tMs <= b) return true;
    return false;
  }

  _coversRange(a, b) {
    for (const [x, y] of this.coverage) if (a >= x && b <= y) return true;
    return false;
  }

  // Mark current-grid windows fully inside fetched coverage as 'loaded'.
  _markCoveredWindows() {
    for (const [a, b] of this.coverage) {
      const i0 = Math.max(0, Math.ceil((a - this.startMs) / this.windowMs));
      const i1 = Math.floor((b - this.startMs) / this.windowMs) - 1;
      for (let i = i0; i <= i1; i++) {
        const ws = this.startMs + i * this.windowMs;
        const we = ws + this.windowMs;
        if (ws >= a && we <= b && this.windows.get(i) === undefined) {
          this.windows.set(i, 'loaded');
        }
      }
    }
  }

  async _fetchWindow(idx) {
    if (this._inflight.has(idx)) return;
    this._inflight.add(idx);
    const gen = this._gridGen;
    this.windows.set(idx, 'pending');
    const { start, end } = this.windowRange(idx);
    const sISO = new Date(start).toISOString();
    const eISO = new Date(end).toISOString();
    const sess = this.store.session;
    // Intervals subsampling: at high speed fetch intervals only every Nth
    // window (windowPlan.intervalStrideForSpeed) — they're 4 s cadence data.
    const wantIntervals = this.isRace && idx % this._ivStride === 0;
    try {
      // Location and intervals are fetched INDEPENDENTLY. Intervals legitimately
      // return 404 "No results found" in the first ~90 s of a race (no gaps
      // exist yet) and intermittently elsewhere; a failed intervals feed must
      // never discard the location samples (which is what a shared Promise.all
      // rejection did — leaving the cursor window in 'error' and every car
      // invisible at the default start-of-race cursor).
      const [locRes, ivRes] = await Promise.allSettled([
        this.source.getLocationWindow(sess, sISO, eISO),
        wantIntervals ? this.source.getIntervals(sess, sISO, eISO) : Promise.resolve(null),
      ]);

      const sameGrid = gen === this._gridGen;

      // A live-block on either feed pauses the whole session (free-tier window).
      const lb = liveBlockOf(locRes) || liveBlockOf(ivRes);
      if (lb) {
        if (sameGrid) this.windows.set(idx, 'liveblock');
        if (this.onLiveBlock) this.onLiveBlock(lb);
        return;
      }

      // Location is required. A genuine (network / transient) failure marks the
      // window 'error' so update() can retry it later. An OpenF1 "No results
      // found" (404) is NOT a failure — it is a legitimately empty window (e.g.
      // a coverage gap), so we ingest nothing and mark it 'loaded' rather than
      // hammering the rate-limited queue re-requesting it forever.
      if (locRes.status === 'rejected') {
        if (!isNoResults(locRes.reason)) {
          if (sameGrid) this.windows.set(idx, 'error');
          return;
        }
      } else {
        this._ingestLocation(locRes.value);
      }

      // Intervals are optional: ingest when present, ignore any failure.
      if (ivRes.status === 'fulfilled' && ivRes.value) this._ingestIntervals(ivRes.value);

      // Record fetched session-time coverage (the pure window span, without the
      // ±500 ms seam overlap, so adjacent windows merge exactly).
      this._addCoverage(start + 500, end - 500);
      if (sameGrid) this.windows.set(idx, 'loaded');
      else this._markCoveredWindows(); // re-gridded mid-flight: sync new grid
      if (this.onProgress) this.onProgress();
    } catch (err) {
      // Defensive: an unexpected throw outside allSettled.
      if (err instanceof LiveBlockError || (err && err.isLiveBlock)) {
        if (gen === this._gridGen) this.windows.set(idx, 'liveblock');
        if (this.onLiveBlock) this.onLiveBlock(err);
      } else if (gen === this._gridGen) {
        this.windows.set(idx, 'error');
      }
    } finally {
      this._inflight.delete(idx);
    }
  }

  _ingestLocation(rows) {
    if (!Array.isArray(rows)) return;
    const byDriver = new Map();
    for (const r of rows) {
      if (r == null || r.driver_number == null) continue;
      if (r.x == null || r.y == null) continue;
      // Filter obvious (0,0,0) dropouts.
      if (r.x === 0 && r.y === 0 && (r.z == null || r.z === 0)) continue;
      const t = Date.parse(r.date);
      if (isNaN(t)) continue;
      let arr = byDriver.get(r.driver_number);
      if (!arr) { arr = []; byDriver.set(r.driver_number, arr); }
      arr.push({ t, x: r.x, y: r.y, z: r.z == null ? 0 : r.z });
    }
    for (const [num, arr] of byDriver) this.track(num).addBatch(arr);
  }

  _ingestIntervals(rows) {
    if (!Array.isArray(rows)) return;
    for (const r of rows) {
      if (r == null || r.driver_number == null) continue;
      const t = Date.parse(r.date);
      if (isNaN(t)) continue;
      let arr = this.intervals.get(r.driver_number);
      if (!arr) { arr = []; this.intervals.set(r.driver_number, arr); }
      arr.push({ t, gap: r.gap_to_leader, interval: r.interval });
    }
    for (const arr of this.intervals.values()) arr.sort((a, b) => a.t - b.t);
  }

  // Interval/gap for a driver at time T (latest sample at or before T).
  intervalAt(num, tMs) {
    const arr = this.intervals.get(num);
    if (!arr || !arr.length) return null;
    let lo = 0, hi = arr.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].t <= tMs) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans >= 0 ? arr[ans] : null;
  }

  // Is the cursor sitting on fetched data? (drives the buffering hold/chip)
  isCursorBuffered(tMs) {
    if (this.windows.get(this.windowIndex(tMs)) === 'loaded') return true;
    return this.coversPoint(tMs);
  }

  // Sample every driver at time T. Returns Map(driver_number -> state).
  sampleAll(tMs) {
    const out = new Map();
    for (const [num, track] of this.tracks) {
      const s = track.sampleAt(tMs);
      if (s) out.set(num, s);
    }
    return out;
  }
}

// A settled promise that rejected with a live-block → the LiveBlockError, else null.
function liveBlockOf(res) {
  return res && res.status === 'rejected' && res.reason && res.reason.isLiveBlock
    ? res.reason
    : null;
}

// True when an error represents OpenF1's "No results found" (HTTP 404) — an
// EMPTY result set, not a transient failure. A genuine network error (isNetwork)
// is retryable and must NOT be treated as empty.
export function isNoResults(err) {
  if (!err || err.isLiveBlock || err.isNetwork) return false;
  if (err.status === 404) return true;
  return /no results found/i.test(err.message || '');
}

export { WINDOW_MS };
