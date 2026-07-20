import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimitedQueue, classifyResponse } from '../src/api/queue.js';

describe('classifyResponse', () => {
  it('detects the live-block body', () => {
    const d = classifyResponse(403, { detail: 'Live F1 session in progress. Please retry.' });
    expect(d.kind).toBe('liveblock');
    expect(d.detail).toMatch(/live f1/i);
  });

  it('detects 429 and computes a retry delay from Retry-After', () => {
    const d = classifyResponse(429, null, '7');
    expect(d.kind).toBe('retry429');
    expect(d.retryMs).toBe(7000);
    const dflt = classifyResponse(429, null, null);
    expect(dflt.retryMs).toBe(5000);
  });

  it('passes through OK array bodies and flags other errors', () => {
    expect(classifyResponse(200, [{ a: 1 }])).toEqual({ kind: 'ok', body: [{ a: 1 }] });
    expect(classifyResponse(404, { detail: 'nope' }).kind).toBe('error');
  });

  // --- REGRESSION: the reported "Could not reach OpenF1. Check your connection."
  // bug. During a live block the free tier replies HTTP 200, CORS-enabled, with a
  // JSON OBJECT {"detail":"Live F1 session in progress..."} — NOT an array, NOT a
  // 4xx. The classifier must recognise the live block by BODY SHAPE at status 200
  // so it never reaches array-parsing code (which threw and got mislabeled as a
  // network/connection failure).
  it('classifies the exact HTTP 200 live-block object as liveblock (not error, not connection)', () => {
    const status = 200; // <-- the deceptive part: a 200, not a 4xx
    const body = { detail: 'Live F1 session in progress. Please try again after the session ends.' };
    const d = classifyResponse(status, body, null);
    expect(d.kind).toBe('liveblock');
    expect(d.detail).toMatch(/live f1 session/i);
    // It must NOT be an ok/data body and must NOT be a generic api error.
    expect(d.kind).not.toBe('ok');
    expect(d.kind).not.toBe('error');
  });

  it('routes a non-live-block detail OBJECT at 200 to api-error, never ok/connection', () => {
    const d = classifyResponse(200, { detail: 'Some other server message' }, null);
    expect(d.kind).toBe('error');
    expect(d.message).toMatch(/some other server message/i);
  });

  it('is case-insensitive and tolerant of a longer live-block detail string', () => {
    const d = classifyResponse(200, { detail: 'LIVE F1 SESSION IN PROGRESS — free access paused until ~30 min after the session.' });
    expect(d.kind).toBe('liveblock');
  });
});

describe('RateLimitedQueue timing', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('enforces the per-second limit (3/s)', async () => {
    const q = new RateLimitedQueue({ perSec: 3, perMin: 30 });
    const done = [];
    for (let i = 0; i < 5; i++) q.enqueue(() => Promise.resolve(i)).then((v) => done.push(v));

    await vi.advanceTimersByTimeAsync(0);
    expect(done.length).toBe(3); // 3 immediately

    await vi.advanceTimersByTimeAsync(1000);
    expect(done.length).toBe(5); // rest after the 1s window
  });

  it('pauses and resumes on a 429 (__retry429)', async () => {
    const q = new RateLimitedQueue({ perSec: 3, perMin: 30 });
    let calls = 0;
    let result;
    q.enqueue(() => {
      calls++;
      if (calls === 1) {
        const e = new Error('rate limited');
        e.__retry429 = 2000;
        return Promise.reject(e);
      }
      return Promise.resolve('ok');
    }).then((v) => { result = v; });

    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    expect(result).toBeUndefined(); // queue paused

    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toBe(2);
    expect(result).toBe('ok');
  });
});

describe('RateLimitedQueue.nextSlotDelay', () => {
  it('waits out the per-second window', () => {
    const q = new RateLimitedQueue();
    q.secWindow = [500, 600, 700]; // 3 in flight this second
    q.minWindow = [];
    expect(q.nextSlotDelay(800)).toBe(1000 - (800 - 500)); // 700
  });

  it('waits out the per-minute window (30/min)', () => {
    const q = new RateLimitedQueue();
    q.secWindow = [];
    q.minWindow = Array.from({ length: 30 }, () => 0);
    expect(q.nextSlotDelay(1000)).toBe(60000 - 1000);
  });

  it('honours a global pause', () => {
    const q = new RateLimitedQueue();
    q.pausedUntil = 5000;
    expect(q.nextSlotDelay(1000)).toBe(4000);
  });
});
