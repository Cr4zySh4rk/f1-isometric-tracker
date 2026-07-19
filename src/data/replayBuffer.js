// Chunked streaming replay buffer.
//
// The session is divided into fixed windows of WINDOW_MS of *session time*.
// For the window containing the playback cursor and PREFETCH_AHEAD windows in
// front, we fetch /location (and /intervals for races) for ALL drivers in one
// request each. Windows far behind the cursor are evicted to cap memory.
//
// Location rows feed per-driver DriverTrack instances (engine/interp.js), which
// own the interpolation. Intervals are stored as time-sorted arrays per driver.

import { OpenF1, LiveBlockError } from '../api/openf1.js';
import { DriverTrack } from '../engine/interp.js';

const WINDOW_MS = 90000; // 90 s windows
const PREFETCH_AHEAD = 3; // keep 3 windows ahead of the cursor
const KEEP_BEHIND = 1; // keep 1 window behind before eviction

export class ReplayBuffer {
  constructor(store) {
    this.store = store;
    this.sessionKey = store.sessionKey;
    this.isRace = store.isRace();
    const { start, end } = store.timeWindow();
    this.startMs = Date.parse(start);
    this.endMs = Date.parse(end);
    if (isNaN(this.startMs)) this.startMs = Date.now() - 3600000;
    if (isNaN(this.endMs)) this.endMs = this.startMs + 3600000;

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
    return Math.floor((tMs - this.startMs) / WINDOW_MS);
  }
  windowRange(idx) {
    const a = this.startMs + idx * WINDOW_MS;
    // Small overlap so interpolation across window seams has neighbor samples.
    return { start: a - 500, end: a + WINDOW_MS + 500 };
  }
  totalWindows() {
    return Math.max(1, Math.ceil((this.endMs - this.startMs) / WINDOW_MS));
  }

  // Which windows are currently loaded (for the transport buffered indicator).
  loadedFractions() {
    const total = this.totalWindows();
    const ranges = [];
    for (const [idx, st] of this.windows) {
      if (st === 'loaded') ranges.push([idx / total, (idx + 1) / total]);
    }
    return ranges;
  }

  // Ensure windows around the cursor are fetched. Call every frame (cheap).
  update(tMs) {
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
    const cutoffMs = this.startMs + cutoff * WINDOW_MS;
    for (const [idx, st] of [...this.windows]) {
      if (idx < cutoff && st === 'loaded') {
        this.windows.delete(idx); // allow refetch if we seek back
      }
    }
    for (const t of this.tracks.values()) t.evictBefore(cutoffMs);
    for (const [num, arr] of this.intervals) {
      let i = 0;
      while (i < arr.length && arr[i].t < cutoffMs) i++;
      if (i > 1) this.intervals.set(num, arr.slice(i - 1));
    }
  }

  async _fetchWindow(idx) {
    if (this._inflight.has(idx)) return;
    this._inflight.add(idx);
    this.windows.set(idx, 'pending');
    const { start, end } = this.windowRange(idx);
    const sISO = new Date(start).toISOString();
    const eISO = new Date(end).toISOString();
    try {
      const jobs = [OpenF1.location(this.sessionKey, sISO, eISO)];
      if (this.isRace) jobs.push(OpenF1.intervals(this.sessionKey, sISO, eISO));
      const [loc, ivals] = await Promise.all(jobs);
      this._ingestLocation(loc);
      if (ivals) this._ingestIntervals(ivals);
      this.windows.set(idx, 'loaded');
      if (this.onProgress) this.onProgress();
    } catch (err) {
      if (err instanceof LiveBlockError || (err && err.isLiveBlock)) {
        this.windows.set(idx, 'liveblock');
        if (this.onLiveBlock) this.onLiveBlock(err);
      } else {
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

  // Is the window at cursor loaded yet? (for a "buffering" spinner)
  isCursorBuffered(tMs) {
    return this.windows.get(this.windowIndex(tMs)) === 'loaded';
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

export { WINDOW_MS };
