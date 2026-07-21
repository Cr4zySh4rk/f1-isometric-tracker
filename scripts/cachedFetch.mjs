// Disk-cached, rate-limited fetch for debug/evidence scripts (same cache dir as
// the real-pipeline harness, so runs share responses and stay inside OpenF1's
// 3/s / 30/min budget). 200/404 are cached; 429/5xx never are.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const CACHE_DIR = '/tmp/of1cache';
fs.mkdirSync(CACHE_DIR, { recursive: true });

const _netTimes = [];
async function throttle() {
  for (;;) {
    const now = Date.now();
    while (_netTimes.length && now - _netTimes[0] > 60000) _netTimes.shift();
    const lastSec = _netTimes.filter((t) => now - t < 1000).length;
    if (_netTimes.length < 28 && lastSec < 3) { _netTimes.push(now); return; }
    await new Promise((r) => setTimeout(r, 200));
  }
}

export async function cachedJson(url) {
  const key = crypto.createHash('sha1').update(String(url)).digest('hex');
  const f = path.join(CACHE_DIR, key + '.json');
  const meta = f + '.status';
  if (fs.existsSync(f)) {
    const status = fs.existsSync(meta) ? parseInt(fs.readFileSync(meta, 'utf8'), 10) : 200;
    if (status === 404) return [];
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  }
  await throttle();
  const res = await fetch(url);
  const text = await res.text();
  if (res.status === 200 || res.status === 404) {
    fs.writeFileSync(f, text);
    fs.writeFileSync(meta, String(res.status));
  }
  if (res.status === 404) return [];
  if (res.status !== 200) throw new Error(`HTTP ${res.status} for ${url}`);
  return JSON.parse(text);
}

export const OF1 = 'https://api.openf1.org/v1';
