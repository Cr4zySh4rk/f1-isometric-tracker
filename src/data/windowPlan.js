// Pure window-sizing math for the chunked replay prefetcher.
//
// The problem: windows are WINDOW of session time, but the rate-limited queue
// allows only 30 req/min. At 30× playback the app consumes session time at
// 30 s/s of wall clock; with fixed 90 s windows that's 20 windows/min, and each
// race window can cost 2 requests (location + intervals) — mathematically more
// than the queue allows, so prefetch starves and cars vanish.
//
// Fix: scale the window duration with playback speed so ONE window fetch covers
// at least TARGET_WALL_SEC of wall-clock playback, capped so a single /location
// response stays well under ~8 MB (20 cars × 3.7 Hz × cap ≈ 44k rows ≈ 6 MB).

export const BASE_WINDOW_MS = 90000; // 90 s — the classic window at 1×
export const MAX_WINDOW_MS = 600000; // cap: keeps responses < ~8 MB
export const TARGET_WALL_SEC = 15; // one fetch must cover ≥ this much wall time

// Window duration (ms of session time) for a playback speed.
//  0.5–5×  → 90 s (base)   10× → 150 s   30× → 450 s
export function windowMsForSpeed(speed) {
  const s = Math.max(1, Number(speed) || 1);
  const target = Math.ceil(s * TARGET_WALL_SEC) * 1000;
  return Math.min(MAX_WINDOW_MS, Math.max(BASE_WINDOW_MS, target));
}

// Intervals are ~4 s cadence data — at high speed fetching them for every
// window doubles the request cost for little visible benefit. Fetch them for
// every Nth window instead (the tower shows the latest sample ≤ T anyway).
export function intervalStrideForSpeed(speed) {
  const s = Math.max(1, Number(speed) || 1);
  return s >= 10 ? 2 : 1;
}

// Worst-case request budget (req/min) the prefetcher can generate at a given
// speed — used by tests to prove the plan fits the 30/min limit.
export function requestBudgetPerMin(speed) {
  const s = Math.max(1, Number(speed) || 1);
  const winMs = windowMsForSpeed(speed);
  const windowsPerMin = (s * 60000) / winMs; // consumed per wall-minute
  const ivPerMin = windowsPerMin / intervalStrideForSpeed(speed);
  return windowsPerMin + ivPerMin;
}
