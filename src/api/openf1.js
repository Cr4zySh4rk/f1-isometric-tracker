// OpenF1 API client.
//
// Responsibilities:
//  - Global throttled request queue: max 3 requests/second AND 30 requests/minute.
//  - 429 handling: pause the queue, resume after a cool-off (respecting Retry-After).
//  - Live-block detection: the free tier returns a 4xx with a JSON body
//    {"detail": "Live F1 session in progress..."} during live windows.
//  - In-memory response cache keyed by full URL.
//  - Optional paid API key (Authorization: Bearer) read from settings.

const BASE = 'https://api.openf1.org/v1';

// --- error types -----------------------------------------------------------

export class LiveBlockError extends Error {
  constructor(detail) {
    super(detail || 'Live F1 session in progress.');
    this.name = 'LiveBlockError';
    this.isLiveBlock = true;
  }
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

// --- settings (paid key) ---------------------------------------------------

const KEY_STORAGE = 'f1iso.apiKey';

export function getApiKey() {
  try {
    return localStorage.getItem(KEY_STORAGE) || '';
  } catch {
    return '';
  }
}

export function setApiKey(key) {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    /* ignore storage failures */
  }
}

// --- throttled queue -------------------------------------------------------

const MAX_PER_SEC = 3;
const MAX_PER_MIN = 30;

const state = {
  queue: [],
  running: false,
  secWindow: [], // timestamps of requests in the last 1s
  minWindow: [], // timestamps of requests in the last 60s
  pausedUntil: 0, // epoch ms; queue paused (e.g. after 429) until this time
  listeners: new Set(),
};

// Observers can watch queue depth / pause state (used by a subtle UI indicator).
export function onQueueChange(fn) {
  state.listeners.add(fn);
  return () => state.listeners.delete(fn);
}
function emit() {
  const info = { depth: state.queue.length, paused: Date.now() < state.pausedUntil };
  for (const fn of state.listeners) {
    try { fn(info); } catch { /* ignore */ }
  }
}

function prune(now) {
  state.secWindow = state.secWindow.filter((t) => now - t < 1000);
  state.minWindow = state.minWindow.filter((t) => now - t < 60000);
}

// How long until we're allowed to send the next request.
function nextSlotDelay(now) {
  if (now < state.pausedUntil) return state.pausedUntil - now;
  prune(now);
  let delay = 0;
  if (state.secWindow.length >= MAX_PER_SEC) {
    delay = Math.max(delay, 1000 - (now - state.secWindow[0]));
  }
  if (state.minWindow.length >= MAX_PER_MIN) {
    delay = Math.max(delay, 60000 - (now - state.minWindow[0]));
  }
  return delay;
}

async function pump() {
  if (state.running) return;
  state.running = true;
  while (state.queue.length) {
    const now = Date.now();
    const delay = nextSlotDelay(now);
    if (delay > 0) {
      await sleep(delay);
      continue;
    }
    const job = state.queue.shift();
    emit();
    const ts = Date.now();
    state.secWindow.push(ts);
    state.minWindow.push(ts);
    try {
      const result = await job.run();
      job.resolve(result);
    } catch (err) {
      if (err && err.__retry429) {
        // Re-queue at the front and pause the whole queue.
        state.pausedUntil = Date.now() + err.__retry429;
        state.queue.unshift(job);
        emit();
      } else {
        job.reject(err);
      }
    }
  }
  state.running = false;
}

function enqueue(run) {
  return new Promise((resolve, reject) => {
    state.queue.push({ run, resolve, reject });
    emit();
    pump();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- cache -----------------------------------------------------------------

const cache = new Map(); // url -> parsed JSON

export function clearCache() {
  cache.clear();
}

// --- low-level fetch (runs inside a queue slot) ----------------------------

async function doFetch(url) {
  const headers = { Accept: 'application/json' };
  const key = getApiKey();
  if (key) headers.Authorization = `Bearer ${key}`;

  let res;
  try {
    res = await fetch(url, { headers, mode: 'cors' });
  } catch (netErr) {
    throw new ApiError(`Network error: ${netErr.message}`, 0);
  }

  if (res.status === 429) {
    const retryAfter = parseFloat(res.headers.get('Retry-After')) || 5;
    const e = new Error('rate limited');
    e.__retry429 = Math.max(1000, retryAfter * 1000);
    throw e;
  }

  const text = await res.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }

  // Live-block: a 4xx whose JSON detail mentions the live restriction.
  const detail = body && typeof body === 'object' && !Array.isArray(body) ? body.detail : null;
  if (detail && /live f1 session/i.test(String(detail))) {
    throw new LiveBlockError(detail);
  }

  if (!res.ok) {
    throw new ApiError(
      typeof detail === 'string' ? detail : `Request failed (${res.status})`,
      res.status
    );
  }

  return body;
}

// --- public request helper -------------------------------------------------

/**
 * Fetch an OpenF1 endpoint through the throttled queue with caching.
 * @param {string} path e.g. "sessions"
 * @param {object} params query params; values with "date>"/"date<" style keys
 *                        are emitted literally.
 * @param {object} opts { cache?: boolean }
 */
export function api(path, params = {}, opts = {}) {
  const url = buildUrl(path, params);
  const useCache = opts.cache !== false;
  if (useCache && cache.has(url)) {
    return Promise.resolve(cache.get(url));
  }
  return enqueue(() => doFetch(url)).then((data) => {
    if (useCache) cache.set(url, data);
    return data;
  });
}

// Build a URL. OpenF1 uses comparison operators embedded directly in the query
// string, e.g. `date>2023-01-01T00:00:00` (a strict `>`, no `=` separator, and
// unencoded ISO datetime — matching the documented curl examples). We express
// those via "date_gt"/"date_lt"/"date_gte"/"date_lte" sugar keys; everything
// else is a normal `key=value` pair.
const OP_KEYS = {
  date_gt: 'date>',
  date_lt: 'date<',
  date_gte: 'date>=',
  date_lte: 'date<=',
};

export function buildUrl(path, params) {
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (OP_KEYS[k]) {
      // Emit the operator inline: `date>VALUE`. ISO datetimes are URL-safe
      // apart from `+` (timezone) and `:`; we keep `:`/`-`/`.`/`T` raw as the
      // API expects, and encode only `+` to %2B if present.
      const val = String(v).replace(/\+/g, '%2B');
      parts.push(`${OP_KEYS[k]}${val}`);
    } else {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    }
  }
  const qs = parts.length ? `?${parts.join('&')}` : '';
  return `${BASE}/${path}${qs}`;
}

// --- typed endpoint helpers ------------------------------------------------

export const OpenF1 = {
  meetings: (year) => api('meetings', { year }),
  sessions: (params) => api('sessions', params),
  drivers: (session_key) => api('drivers', { session_key }),
  laps: (session_key) => api('laps', { session_key }),
  position: (session_key) => api('position', { session_key }),
  raceControl: (session_key) => api('race_control', { session_key }),
  sessionResult: (session_key) => api('session_result', { session_key }),
  // Windowed requests: not URL-cached — the ReplayBuffer owns eviction, so
  // caching raw JSON here would duplicate memory and grow unbounded.
  location: (session_key, startISO, endISO) =>
    api('location', { session_key, date_gt: startISO, date_lt: endISO }, { cache: false }),
  intervals: (session_key, startISO, endISO) =>
    api('intervals', { session_key, date_gt: startISO, date_lt: endISO }, { cache: false }),
};

// Utility for callers that need a quick availability probe (returns true if the
// free API is currently serving data, false if live-blocked / errored).
export async function probeAvailable() {
  try {
    await api('sessions', { year: new Date().getFullYear() }, { cache: false });
    return true;
  } catch (e) {
    return false;
  }
}
