// Pure weather selection (no DOM/network). /weather rows (~1/min):
//   { date, air_temperature, track_temperature, humidity, pressure,
//     wind_speed, wind_direction, rainfall }
// weatherAt returns the latest sample at or before T; if T precedes the first
// sample it returns the FIRST sample (so the widget shows plausible conditions
// from the moment a session loads, before the first in-session reading).

// Sort raw rows ascending by time, attaching epoch-ms `t`.
export function normalizeWeather(rows) {
  const out = [];
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    if (!r) continue;
    const t = Date.parse(r.date);
    if (!Number.isFinite(t)) continue;
    out.push({ ...r, t });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

// Latest sample ≤ T, or the first sample if T precedes all, or null if empty.
export function weatherAt(sorted, tMs) {
  if (!Array.isArray(sorted) || !sorted.length) return null;
  if (tMs < sorted[0].t) return sorted[0];
  let lo = 0, hi = sorted.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid].t <= tMs) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return sorted[ans];
}

// Rain flag from the rainfall reading (OpenF1 rainfall is 0/1-ish or mm).
export function isRaining(sample) {
  return !!(sample && Number(sample.rainfall) > 0);
}

// 8-point compass label for a wind_direction in degrees (meteorological: the
// direction the wind blows FROM). Used for a small text hint next to the arrow.
export function windCompass(deg) {
  const d = Number(deg);
  if (!Number.isFinite(d)) return '';
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(((d % 360) + 360) % 360 / 45) % 8];
}
