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
