// OpenF1 API client.
//
// Responsibilities:
//  - Global throttled request queue: max 3 requests/second AND 30 requests/minute.
//  - 429 handling: pause the queue, resume after a cool-off (respecting Retry-After).
//  - Live-block detection: the free tier returns a 4xx with a JSON body
//    {"detail": "Live F1 session in progress..."} during live windows.
//  - In-memory response cache keyed by full URL.
//  - Optional paid API key (Authorization: Bearer) read from settings.

import { RateLimitedQueue, classifyResponse } from './queue.js';

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
  constructor(message, status, opts = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    // `isNetwork` distinguishes a genuine fetch rejection / timeout (no
    // connectivity, CORS failure, DNS…) from an HTTP-level API error where the
    // server *did* respond. Only the former should surface "Could not reach
    // OpenF1. Check your connection." to the user.
    this.isNetwork = !!opts.isNetwork;
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

// Limits are overridable via a global hook for offline test harnesses that
// replay disk-cached responses (they throttle REAL network fetches themselves,
// at the fetch layer). In the browser the hook is undefined → real limits.
const queue = new RateLimitedQueue(globalThis.__OF1_QUEUE_OPTS || { perSec: 3, perMin: 30 });

// Observers can watch queue depth / pause state (used by a subtle UI indicator).
export function onQueueChange(fn) {
  return queue.onChange(fn);
}

function enqueue(run) {
  return queue.enqueue(run);
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
    // Genuine fetch rejection (offline, DNS, CORS, aborted) — the only case that
    // should read as a connectivity problem.
    throw new ApiError(`Network error: ${netErr.message}`, 0, { isNetwork: true });
  }

  const text = res.status === 429 ? '' : await res.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }

  const decision = classifyResponse(res.status, body, res.headers.get('Retry-After'));
  switch (decision.kind) {
    case 'retry429': {
      const e = new Error('rate limited');
      e.__retry429 = decision.retryMs; // queue pauses & re-queues on this
      throw e;
    }
    case 'liveblock':
      throw new LiveBlockError(decision.detail);
    case 'error':
      throw new ApiError(decision.message, decision.status);
    default:
      return decision.body;
  }
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
    // Keys starting with "_" are internal hints for other providers (e.g. the
    // session picker's `_year` used by the Jolpica mapper) — never send them
    // to OpenF1: unknown filters make the API 404 with "No results found."
    if (k.startsWith('_')) continue;
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
  pit: (session_key) => api('pit', { session_key }),
  sessionResult: (session_key) => api('session_result', { session_key }),
  // Small per-session tables (fetched once, URL-cached): tyre stints, team radio
  // clip list, and weather timeline. All return every driver's rows in one call.
  stints: (session_key) => api('stints', { session_key }),
  teamRadio: (session_key) => api('team_radio', { session_key }),
  weather: (session_key) => api('weather', { session_key }),
  // Windowed requests: not URL-cached — the ReplayBuffer / focused telemetry
  // buffer own eviction, so caching raw JSON here would duplicate memory and
  // grow unbounded.
  location: (session_key, startISO, endISO) =>
    api('location', { session_key, date_gt: startISO, date_lt: endISO }, { cache: false }),
  intervals: (session_key, startISO, endISO) =>
    api('intervals', { session_key, date_gt: startISO, date_lt: endISO }, { cache: false }),
  // Focused-driver telemetry window (single driver, windowed like /location).
  carData: (session_key, driver_number, startISO, endISO) =>
    api('car_data', { session_key, driver_number, date_gt: startISO, date_lt: endISO }, { cache: false }),
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
