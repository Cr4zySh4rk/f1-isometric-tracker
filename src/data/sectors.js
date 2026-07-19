// Sector-color state machine + track centerline sector split. Pure & testable.
//
// Colors follow the F1 TV convention:
//   purple = session-best sector, green = personal-best sector,
//   yellow = slower than personal best, red = >2 s slower than personal best.
// Flag state takes priority: red flag -> red, yellow/SC -> yellow (handled by
// the caller / focusTrackColors which passes a flag override per sector).

export const SECTOR_COLORS = {
  purple: 0x8b3ffb,
  green: 0x37d67a,
  yellow: 0xffd23a,
  red: 0xe1301f,
  none: 0x2b2f36, // default asphalt
};

const RED_THRESHOLD = 2.0; // seconds slower than personal best -> red

// Decide the color for one sector.
//  sectorTime    : driver's most-recent completed time in this sector (s) | null
//  personalBest  : driver's best time in this sector (s) | null
//  sessionBest   : session-best time in this sector (s) | null
//  flag          : optional override 'RED' | 'YELLOW' | null (takes priority)
export function sectorColorState(sectorTime, personalBest, sessionBest, flag) {
  if (flag === 'RED') return 'red';
  if (flag === 'YELLOW') return 'yellow';
  if (sectorTime == null) return 'none';
  const eps = 1e-6;
  if (sessionBest != null && sectorTime <= sessionBest + eps) return 'purple';
  if (personalBest != null && sectorTime > personalBest + RED_THRESHOLD) return 'red';
  if (personalBest != null && sectorTime <= personalBest + eps) return 'green';
  return 'yellow';
}

// Colors for all three sectors given the focused driver's latest sector times,
// personal + session bests, and a whole-track flag override.
//  latest        : [s1,s2,s3] latest completed sector times (null allowed)
//  personalBest  : [s1,s2,s3]
//  sessionBest   : [s1,s2,s3]
//  trackFlag     : 'RED' | 'YELLOW' | null — applied to every sector
export function driverSectorColors(latest, personalBest, sessionBest, trackFlag) {
  const out = [];
  for (let i = 0; i < 3; i++) {
    out.push(
      sectorColorState(
        latest ? latest[i] : null,
        personalBest ? personalBest[i] : null,
        sessionBest ? sessionBest[i] : null,
        trackFlag || null
      )
    );
  }
  return out;
}

// Map the general track status to a per-sector flag override for coloring.
export function trackFlagOverride(status) {
  if (status === 'RED') return 'RED';
  if (status === 'YELLOW' || status === 'DOUBLE_YELLOW' || status === 'SC' || status === 'VSC') {
    return 'YELLOW';
  }
  return null;
}

// Split a centerline (given cumulative arc-length per point + total length) into
// 3 sectors. `proportions` default to equal thirds; pass session-typical sector
// time proportions to weight them. Returns the point index ranges per sector:
// [[start,end],[start,end],[start,end]] with end exclusive (last is inclusive).
export function splitSectorsByLength(cumLen, totalLen, proportions = [1 / 3, 1 / 3, 1 / 3]) {
  const n = cumLen.length;
  if (n === 0) return [[0, 0], [0, 0], [0, 0]];
  const sum = proportions.reduce((a, b) => a + b, 0) || 1;
  const p = proportions.map((x) => x / sum);
  const b1 = totalLen * p[0];
  const b2 = totalLen * (p[0] + p[1]);

  const idxAtLength = (target) => {
    // First index whose cumulative length exceeds target.
    let i = 0;
    while (i < n && cumLen[i] < target) i++;
    return Math.min(i, n - 1);
  };
  const i1 = idxAtLength(b1);
  const i2 = idxAtLength(b2);
  return [
    [0, i1],
    [i1, i2],
    [i2, n],
  ];
}

// For a segment index (station i), which sector [0,1,2] does it belong to given
// the ranges from splitSectorsByLength.
export function sectorOfIndex(i, ranges) {
  if (i < ranges[0][1]) return 0;
  if (i < ranges[1][1]) return 1;
  return 2;
}
