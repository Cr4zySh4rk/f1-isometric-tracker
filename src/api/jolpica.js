// Jolpica-F1 API client (Ergast successor) — the CORS-friendly fallback data
// source used when OpenF1 is live-blocked or down.
//
// Base: https://api.jolpi.ca/ergast/f1/...  (returns the classic Ergast JSON
// envelope: `{ MRData: { ... , total, limit, offset } }`).
//
// Verified from a GitHub Pages origin:
//   curl -H "Origin: https://cr4zysh4rk.github.io" \
//        https://api.jolpi.ca/ergast/f1/2024/1/results.json
//   → HTTP 200, `access-control-allow-origin: *`  ✅ browser-usable
//
// Rate limits (unauthenticated, from their docs): 4 req/s burst, 500 req/hour
// sustained. We throttle to 4/s and page through large collections (laps) with
// the shared RateLimitedQueue.

import { RateLimitedQueue } from './queue.js';
import { ApiError } from './openf1.js';

const BASE = 'https://api.jolpi.ca/ergast/f1';

// 4/s burst; keep well under the 500/hour sustained cap (a full race's laps is
// ~40 paged requests — one session load stays comfortably within budget).
const queue = new RateLimitedQueue({ perSec: 4, perMin: 240 });

export function onJolpicaQueueChange(fn) {
  return queue.onChange(fn);
}

const cache = new Map();

export function clearJolpicaCache() {
  cache.clear();
}

async function doFetch(url) {
  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' }, mode: 'cors' });
  } catch (netErr) {
    throw new ApiError(`Network error: ${netErr.message}`, 0, { isNetwork: true });
  }
  if (res.status === 429) {
    const e = new Error('rate limited');
    e.__retry429 = Math.max(1000, (parseFloat(res.headers.get('Retry-After')) || 5) * 1000);
    throw e;
  }
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  if (res.status >= 400 || !body || !body.MRData) {
    throw new ApiError(`Jolpica request failed (${res.status})`, res.status);
  }
  return body.MRData;
}

// Fetch a single Ergast path (e.g. "2024/1/results"), returning MRData.
export function jolpicaRaw(path, params = {}) {
  const qs = Object.entries(params)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const url = `${BASE}/${path}.json${qs ? `?${qs}` : ''}`;
  if (cache.has(url)) return Promise.resolve(cache.get(url));
  return queue.enqueue(() => doFetch(url)).then((data) => {
    cache.set(url, data);
    return data;
  });
}

// Page through a collection, concatenating one array field out of each MRData
// page until `total` rows have been gathered. `pick(mrData)` returns the array
// to accumulate from a page. Guards against runaway loops.
export async function jolpicaPaged(path, pick, { limit = 100, maxPages = 60 } = {}) {
  const out = [];
  let offset = 0;
  for (let page = 0; page < maxPages; page++) {
    const mr = await jolpicaRaw(path, { limit, offset });
    const rows = pick(mr) || [];
    out.push(...rows);
    const total = parseInt(mr.total, 10) || out.length;
    offset += limit;
    if (offset >= total || rows.length === 0) break;
  }
  return out;
}

export { BASE as JOLPICA_BASE };
