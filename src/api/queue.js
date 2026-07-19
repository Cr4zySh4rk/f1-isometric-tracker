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
// the fetch layer and unit-tested for live-block / 429 handling.
export function classifyResponse(status, body, retryAfterHeader) {
  if (status === 429) {
    const retryAfter = parseFloat(retryAfterHeader) || 5;
    return { kind: 'retry429', retryMs: Math.max(1000, retryAfter * 1000) };
  }
  const detail =
    body && typeof body === 'object' && !Array.isArray(body) ? body.detail : null;
  if (detail && /live f1 session/i.test(String(detail))) {
    return { kind: 'liveblock', detail: String(detail) };
  }
  if (status >= 400) {
    return {
      kind: 'error',
      status,
      message: typeof detail === 'string' ? detail : `Request failed (${status})`,
    };
  }
  return { kind: 'ok', body };
}
