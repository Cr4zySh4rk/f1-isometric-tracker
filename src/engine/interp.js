// Per-driver position interpolation over sparse (~3.7 Hz) location samples.
//
// Each driver has a time-sorted array of samples { t (ms), x, y, z }. Given a
// query time we find the bracketing samples and interpolate with a centripetal
// Catmull-Rom spline for smooth curves, falling back to linear at the ends.
// We also expose a velocity/heading estimate and a "data gap" flag so cars can
// fade out when the driver's samples stop (pits/garage/red flag).

const GAP_FADE_START = 10000; // ms — begin fading when the surrounding gap exceeds this
const GAP_FADE_FULL = 13000; // ms — fully faded

// Below this local speed a car's velocity direction is unreliable (grid,
// stationary, crawling), so orientation should come from the track tangent
// instead of the noisy finite-difference heading. Units: OpenF1 location units
// (decimetres) per second. Real data: cars on the grid read ~0 dm/s; even a
// slow racing car reads > 350 dm/s (≈ 130 km/h); the pit limit is ~220 dm/s.
export const SLOW_SPEED = 40; // ≈ 14 km/h

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
   * Returns { x, y, z, heading, speed, present, alpha, endGap } or null if there
   * is no data at all.
   *  - present: false if t is outside the sample range.
   *  - alpha: 0..1 opacity accounting for data gaps (pits) and edges.
   *  - speed: local speed in location-units (dm) per second; ~0 when stationary
   *    (grid / stopped) so callers can orient by the track tangent instead of a
   *    noisy velocity heading.
   *  - endGap: ms elapsed since the driver's LAST sample (0 while t is within the
   *    sampled range). Lets callers detect "telemetry has stopped updating"
   *    (retirements) independently of the pit/coverage gap fade.
   */
  sampleAt(t) {
    this.ensureSorted();
    const s = this.samples;
    if (!s.length) return null;

    if (t <= s[0].t) {
      const near = (s[0].t - t) < 2000;
      return { x: s[0].x, y: s[0].y, z: s[0].z, heading: this._headingAt(0), speed: this._speedAt(0), present: near, alpha: near ? 1 : 0, endGap: 0 };
    }
    if (t >= s[s.length - 1].t) {
      const gap = t - s[s.length - 1].t;
      return {
        x: s[s.length - 1].x, y: s[s.length - 1].y, z: s[s.length - 1].z,
        heading: this._headingAt(s.length - 1), speed: 0, present: gap < 2000,
        alpha: gapAlpha(gap * 2), endGap: gap,
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
        speed: 0, present: false, alpha: gapAlpha(localGap), endGap: 0,
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

    // Local speed (dm/s) from the two bracketing samples — used to decide when
    // the velocity heading is trustworthy vs. the car is stationary/crawling.
    const speed = dt > 0 ? Math.hypot(p2.x - p1.x, p2.y - p1.y) / (dt / 1000) : 0;

    return { x, y, z, heading, speed, present: true, alpha: 1, endGap: 0 };
  }

  _headingAt(i) {
    const s = this.samples;
    const a = s[Math.max(0, i - 1)];
    const b = s[Math.min(s.length - 1, i + 1)];
    if (!a || !b || a === b) return 0;
    return Math.atan2(b.y - a.y, b.x - a.x);
  }

  // Local speed (dm/s) around sample index i, from the pair (i, i+1) or (i-1, i).
  _speedAt(i) {
    const s = this.samples;
    const a = s[i], b = s[i + 1] || s[i - 1];
    if (!a || !b || a === b) return 0;
    const dt = Math.abs(b.t - a.t);
    return dt > 0 ? Math.hypot(b.x - a.x, b.y - a.y) / (dt / 1000) : 0;
  }
}

// Pure decision: which heading should a car use given its telemetry velocity
// heading and the local track-tangent heading? When the car is moving faster
// than `threshold` the velocity heading is reliable; below it (grid, stopped,
// crawling) the finite-difference velocity is noise, so fall back to the track
// tangent so grid cars face straight down the track. Returns an angle (radians)
// in the same convention as the inputs.
export function chooseHeading({ velocityHeading, tangentHeading, speed, threshold = SLOW_SPEED }) {
  const velOk = velocityHeading != null && isFinite(velocityHeading);
  const tanOk = tangentHeading != null && isFinite(tangentHeading);
  if (!tanOk) return velOk ? velocityHeading : 0;
  if (!velOk) return tangentHeading;
  return speed < threshold ? tangentHeading : velocityHeading;
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
