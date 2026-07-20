// Deterministic, testable rate-limited request queue.
//
// Enforces max N requests/second AND M requests/minute, and supports a global
// pause (used for 429 back-off): a job whose `run()` rejects with a numeric
// `__retry429` (ms) is re-queued at the front and the whole queue pauses.
//
// `now` and `sleep` are injectable so tests can drive a fake clock.

export class RateLimitedQueue {
  constructor(opts = {}) {
    this.perSec = opts.perSec ?? 3;
    this.perMin = opts.perMin ?? 30;
    this._now = opts.now || (() => Date.now());
    this._sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.queue = [];
    this.running = false;
    this.secWindow = [];
    this.minWindow = [];
    this.pausedUntil = 0;
    this.listeners = new Set();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  _emit() {
    const info = { depth: this.queue.length, paused: this._now() < this.pausedUntil };
    for (const fn of this.listeners) {
      try { fn(info); } catch { /* ignore */ }
    }
  }

  _prune(now) {
    this.secWindow = this.secWindow.filter((t) => now - t < 1000);
    this.minWindow = this.minWindow.filter((t) => now - t < 60000);
  }

  // How long (ms) until the next request may be sent.
  nextSlotDelay(now) {
    if (now < this.pausedUntil) return this.pausedUntil - now;
    this._prune(now);
    let delay = 0;
    if (this.secWindow.length >= this.perSec) {
      delay = Math.max(delay, 1000 - (now - this.secWindow[0]));
    }
    if (this.minWindow.length >= this.perMin) {
      delay = Math.max(delay, 60000 - (now - this.minWindow[0]));
    }
    return delay;
  }

  async _pump() {
    if (this.running) return;
    this.running = true;
    while (this.queue.length) {
      const now = this._now();
      const delay = this.nextSlotDelay(now);
      if (delay > 0) {
        await this._sleep(delay);
        continue;
      }
      const job = this.queue.shift();
      this._emit();
      const ts = this._now();
      this.secWindow.push(ts);
      this.minWindow.push(ts);
      try {
        const result = await job.run();
        job.resolve(result);
      } catch (err) {
        if (err && typeof err.__retry429 === 'number') {
          this.pausedUntil = this._now() + err.__retry429;
          this.queue.unshift(job);
          this._emit();
        } else {
          job.reject(err);
        }
      }
    }
    this.running = false;
  }

  enqueue(run) {
    return new Promise((resolve, reject) => {
      this.queue.push({ run, resolve, reject });
      this._emit();
      this._pump();
    });
  }
}

// Classify an OpenF1 HTTP response body into a control decision. Pure — used by
// the fetch layer and unit-tested for live-block / 429 / API-error handling.
//
// The subtle case this guards against (the user-reported "Could not reach
// OpenF1" bug): when the free tier is live-blocked, OpenF1 replies **HTTP 200,
// CORS enabled, body = a JSON OBJECT** `{"detail": "Live F1 session in
// progress…"}` — not an array and not a 4xx. We must therefore classify by the
// SHAPE of the body (object-with-`detail`), independent of the HTTP status, so
// the object never reaches array-expecting parse code (which would throw and be
// mislabeled as a network failure).
//
//   • any status, body = {detail: /live f1 session/i}  → liveblock
//   • any status, body = {detail: <other>}             → api error (distinct)
//   • status 429                                        → retry429 (back-off)
//   • status >= 400 (no usable detail)                  → api error
//   • otherwise                                         → ok (data body)
export function classifyResponse(status, body, retryAfterHeader) {
  const isObj = body && typeof body === 'object' && !Array.isArray(body);
  const detail = isObj ? body.detail : null;

  // Live-block is recognised by body shape at ANY status (incl. 200).
  if (detail != null && /live f1 session/i.test(String(detail))) {
    return { kind: 'liveblock', detail: String(detail) };
  }

  if (status === 429) {
    const retryAfter = parseFloat(retryAfterHeader) || 5;
    return { kind: 'retry429', retryMs: Math.max(1000, retryAfter * 1000) };
  }

  // A JSON object carrying a `detail` (OpenF1's error envelope) that is NOT a
  // live-block — at any status, including a deceptive 200 — is an API error, not
  // a data array. Route it to the distinct API-error state so it is never parsed
  // as records and never mistaken for a connectivity problem.
  if (detail != null) {
    const msg = typeof detail === 'string' ? detail : JSON.stringify(detail);
    return { kind: 'error', status, message: msg };
  }

  if (status >= 400) {
    return { kind: 'error', status, message: `Request failed (${status})` };
  }

  return { kind: 'ok', body };
}
