// Per-driver position interpolation over sparse (~3.7 Hz) location samples.
//
// Each driver has a time-sorted array of samples { t (ms), x, y, z }. Given a
// query time we find the bracketing samples and interpolate with a centripetal
// Catmull-Rom spline for smooth curves, falling back to linear at the ends.
// We also expose a velocity/heading estimate and a "data gap" flag so cars can
// fade out when the driver's samples stop (pits/garage/red flag).

const GAP_FADE_START = 10000; // ms — begin fading when the surrounding gap exceeds this
const GAP_FADE_FULL = 13000; // ms — fully faded

export class DriverTrack {
  constructor(driverNumber) {
    this.driverNumber = driverNumber;
    this.samples = []; // { t, x, y, z }
    this._sorted = true;
  }

  addSample(t, x, y, z) {
    this.samples.push({ t, x, y, z });
    this._sorted = false;
  }

  // Merge a batch of raw location rows (already parsed to {t,x,y,z}).
  addBatch(rows) {
    if (!rows || !rows.length) return;
    for (const r of rows) this.samples.push(r);
    this._sorted = false;
  }

  ensureSorted() {
    if (this._sorted) return;
    this.samples.sort((a, b) => a.t - b.t);
    // Deduplicate identical timestamps.
    const out = [];
    let last = -Infinity;
    for (const s of this.samples) {
      if (s.t === last) continue;
      out.push(s);
      last = s.t;
    }
    this.samples = out;
    this._sorted = true;
  }

  // Drop samples strictly before tMs (buffer eviction). Keeps one sample before
  // the cutoff so interpolation across the boundary still works.
  evictBefore(tMs) {
    this.ensureSorted();
    const s = this.samples;
    if (!s.length) return;
    let i = 0;
    while (i < s.length && s[i].t < tMs) i++;
    if (i > 1) this.samples = s.slice(i - 1);
  }

  bounds() {
    this.ensureSorted();
    if (!this.samples.length) return null;
    return { start: this.samples[0].t, end: this.samples[this.samples.length - 1].t };
  }

  // Binary search: index of the last sample with t <= query.
  _floorIndex(t) {
    const s = this.samples;
    let lo = 0, hi = s.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (s[mid].t <= t) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  /**
   * Sample the driver's state at time t (ms epoch).
   * Returns { x, y, z, heading, present, alpha } or null if no data at all.
   *  - present: false if t is outside the sample range.
   *  - alpha: 0..1 opacity accounting for data gaps (pits) and edges.
   */
  sampleAt(t) {
    this.ensureSorted();
    const s = this.samples;
    if (!s.length) return null;

    if (t <= s[0].t) {
      const near = (s[0].t - t) < 2000;
      return { x: s[0].x, y: s[0].y, z: s[0].z, heading: this._headingAt(0), present: near, alpha: near ? 1 : 0 };
    }
    if (t >= s[s.length - 1].t) {
      const gap = t - s[s.length - 1].t;
      return {
        x: s[s.length - 1].x, y: s[s.length - 1].y, z: s[s.length - 1].z,
        heading: this._headingAt(s.length - 1), present: gap < 2000,
        alpha: gapAlpha(gap * 2),
      };
    }

    const i = this._floorIndex(t);
    const p1 = s[i], p2 = s[i + 1];
    const dt = p2.t - p1.t;
    const localGap = dt;

    // Big gap between the two bracketing samples ⇒ the driver was in the pits /
    // out of coverage. Hold position and fade rather than teleport.
    if (localGap > GAP_FADE_START) {
      const frac = (t - p1.t) / dt;
      const hold = frac < 0.5 ? p1 : p2;
      return {
        x: hold.x, y: hold.y, z: hold.z, heading: this._headingAt(frac < 0.5 ? i : i + 1),
        present: false, alpha: gapAlpha(localGap),
      };
    }

    const u = (t - p1.t) / dt;
    const p0 = s[i - 1] || p1;
    const p3 = s[i + 2] || p2;
    const x = catmullRom(p0.x, p1.x, p2.x, p3.x, u);
    const y = catmullRom(p0.y, p1.y, p2.y, p3.y, u);
    const z = catmullRom(p0.z, p1.z, p2.z, p3.z, u);

    // Heading from the tangent of the spline (finite difference).
    const eps = 0.02;
    const u2 = Math.min(1, u + eps);
    const x2 = catmullRom(p0.x, p1.x, p2.x, p3.x, u2);
    const y2 = catmullRom(p0.y, p1.y, p2.y, p3.y, u2);
    let heading = Math.atan2(y2 - y, x2 - x);
    if (!isFinite(heading)) heading = this._headingAt(i);

    return { x, y, z, heading, present: true, alpha: 1 };
  }

  _headingAt(i) {
    const s = this.samples;
    const a = s[Math.max(0, i - 1)];
    const b = s[Math.min(s.length - 1, i + 1)];
    if (!a || !b || a === b) return 0;
    return Math.atan2(b.y - a.y, b.x - a.x);
  }
}

function gapAlpha(gap) {
  if (gap <= GAP_FADE_START) return 1;
  if (gap >= GAP_FADE_FULL) return 0;
  return 1 - (gap - GAP_FADE_START) / (GAP_FADE_FULL - GAP_FADE_START);
}

// Centripetal-ish Catmull-Rom on a single component (uniform param). Good enough
// for evenly-ish spaced telemetry and cheap.
export function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (
    2 * p1 +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  );
}
