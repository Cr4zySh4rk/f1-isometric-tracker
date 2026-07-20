// ProviderManager — seamless multi-provider operation with automatic failover.
//
//   mode 'live'   → OpenF1 (full telemetry)         [primary]
//   mode 'approx' → Jolpica (schedule/results/laps)  [fallback, no telemetry]
//
// Failover: any call routed through `run()` that fails while in live mode with a
// live-block or a genuine network error demotes to Approximate mode and retries
// the same call on the fallback provider. A real API error (bad request, 404…)
// is NOT a failover trigger — it surfaces to the caller.
//
// Recovery: while degraded, `checkRecovery()` probes OpenF1; on success the
// manager promotes back to live and fires onModeChange so the app can reload the
// session with real telemetry. `startRecoveryPoll()` runs this every 60 s.
//
// Pure/deterministic: providers, `probe`, and the scheduler are injectable, so
// the failover state machine is unit-tested without network or real timers.

export const MODE_LIVE = 'live';
export const MODE_APPROX = 'approx';

// A failover-worthy error: the free tier is live-blocked, or the request never
// reached a responding server (offline / DNS / CORS / timeout). A server that
// responded with an HTTP error (ApiError without isNetwork) is NOT failover-worthy.
export function isFailoverError(err) {
  if (!err) return false;
  if (err.isLiveBlock) return true;
  if (err.isNetwork) return true;
  return false;
}

export class ProviderManager {
  constructor({ primary, fallback, scheduler } = {}) {
    this.primary = primary;
    this.fallback = fallback;
    this.mode = MODE_LIVE;
    this._listeners = new Set();
    this._scheduler = scheduler || {
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => clearInterval(h),
    };
    this._pollHandle = null;
  }

  get active() {
    return this.mode === MODE_LIVE ? this.primary : this.fallback;
  }
  get telemetry() {
    return !!(this.active && this.active.capabilities && this.active.capabilities.telemetry);
  }

  onModeChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }
  _emit(reason) {
    const info = { mode: this.mode, provider: this.active, reason };
    for (const fn of this._listeners) {
      try { fn(info); } catch { /* ignore listener errors */ }
    }
  }

  // Run an operation `fn(provider)` on the active provider, failing over to the
  // fallback (and switching to Approximate mode) on a live-block / network error.
  // A SINGLE transient network blip does not demote: the call is retried once on
  // the primary first, and only a second consecutive failure triggers failover.
  async run(fn, { reason = 'request failed' } = {}) {
    try {
      return await fn(this.active);
    } catch (err) {
      if (this.mode === MODE_LIVE && this.fallback && isFailoverError(err)) {
        if (err.isNetwork && !err.isLiveBlock) {
          try {
            return await fn(this.active); // one retry on the primary
          } catch (err2) {
            if (!isFailoverError(err2)) throw err2;
          }
        }
        this._demote(err.isLiveBlock ? 'live-block' : reason);
        return await fn(this.active); // active is now the fallback
      }
      throw err;
    }
  }

  _demote(reason) {
    if (this.mode === MODE_APPROX) return;
    this.mode = MODE_APPROX;
    this._emit(reason);
    this.startRecoveryPoll();
  }

  _promote(reason) {
    if (this.mode === MODE_LIVE) return;
    this.mode = MODE_LIVE;
    this.stopRecoveryPoll();
    this._emit(reason);
  }

  // Force approximate mode (e.g. user opted in, or a pre-flight probe failed).
  forceApprox(reason = 'forced') { this._demote(reason); }

  // Probe OpenF1; if it is serving data again, promote back to live. Returns the
  // new mode. Safe to call repeatedly.
  async checkRecovery() {
    if (this.mode === MODE_LIVE) return MODE_LIVE;
    let ok = false;
    try { ok = await this.primary.probe(); } catch { ok = false; }
    if (ok) this._promote('openf1 recovered');
    return this.mode;
  }

  // --- data-source facade: every call routes through run() so a live-block or
  // network failure on OpenF1 transparently fails over to Jolpica. -----------
  getMeetings(year) { return this.run((p) => p.getMeetings(year), { reason: 'meetings' }); }
  getSessions(params) { return this.run((p) => p.getSessions(params), { reason: 'sessions' }); }
  getDrivers(session) { return this.run((p) => p.getDrivers(session), { reason: 'drivers' }); }
  getLaps(session) { return this.run((p) => p.getLaps(session), { reason: 'laps' }); }
  getPositions(session) { return this.run((p) => p.getPositions(session), { reason: 'positions' }); }
  getRaceControl(session) { return this.run((p) => p.getRaceControl(session), { reason: 'race_control' }); }
  getPit(session) { return this.run((p) => p.getPit(session), { reason: 'pit' }); }
  getSessionResult(session) { return this.run((p) => p.getSessionResult(session), { reason: 'session_result' }); }
  getLocationWindow(session, a, b) { return this.run((p) => p.getLocationWindow(session, a, b), { reason: 'location' }); }
  getIntervals(session, a, b) { return this.run((p) => p.getIntervals(session, a, b), { reason: 'intervals' }); }

  startRecoveryPoll(ms = 60000) {
    if (this._pollHandle != null) return;
    this._pollHandle = this._scheduler.setInterval(() => { this.checkRecovery(); }, ms);
  }
  stopRecoveryPoll() {
    if (this._pollHandle != null) {
      this._scheduler.clearInterval(this._pollHandle);
      this._pollHandle = null;
    }
  }
}
