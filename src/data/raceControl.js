// Pure parsing of the OpenF1 /race_control feed.
//
// Produces the timing-tower status strip state, penalty badges and a track flag
// state — all as-of a replay time T (ms epoch). DOM-free & testable.

// Parse + sort race_control rows once. Adds a numeric `tMs` for fast lookups.
export function normalizeRaceControl(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => r && r.date)
    .map((r) => ({ ...r, tMs: Date.parse(r.date) }))
    .filter((r) => !isNaN(r.tMs))
    .sort((a, b) => a.tMs - b.tMs);
}

// Status strip priority: RED beats safety car beats double-yellow beats
// yellow beats chequered beats green. Returns { status, label, pulse }.
const STATUS_META = {
  RED: { label: 'RED FLAG', pulse: true },
  SC: { label: 'SAFETY CAR', pulse: true },
  VSC: { label: 'VIRTUAL SAFETY CAR', pulse: true },
  DOUBLE_YELLOW: { label: 'DOUBLE YELLOW', pulse: false },
  YELLOW: { label: 'YELLOW FLAG', pulse: false },
  CHEQUERED: { label: 'CHEQUERED', pulse: false },
  GREEN: { label: 'TRACK CLEAR', pulse: false },
};

// Walk all events up to T, tracking the latest track-wide flag and SC/VSC state.
// Choice: safety-car state is a simple DEPLOYED->on, IN THIS LAP/ENDING->off
// machine; a GREEN/CLEAR flag also clears it. Documented in ARCHITECTURE.
export function trackStatusAt(events, tMs) {
  let flag = 'GREEN'; // GREEN | YELLOW | DOUBLE_YELLOW | RED | CHEQUERED
  let sc = null; // 'SC' | 'VSC' | null
  for (const e of events) {
    if (e.tMs > tMs) break;
    const cat = String(e.category || '').toUpperCase();
    const rawFlag = String(e.flag || '').toUpperCase();
    const msg = String(e.message || '').toUpperCase();

    if (cat === 'FLAG' || rawFlag) {
      if (rawFlag === 'CHEQUERED') flag = 'CHEQUERED';
      else if (rawFlag === 'CLEAR' || rawFlag === 'GREEN') flag = 'GREEN';
      else if (rawFlag === 'DOUBLE YELLOW') flag = 'DOUBLE_YELLOW';
      else if (rawFlag === 'YELLOW') flag = 'YELLOW';
      else if (rawFlag === 'RED') flag = 'RED';
      if (rawFlag === 'CLEAR' || rawFlag === 'GREEN') sc = null;
    }

    if (cat === 'SAFETYCAR' || msg.includes('SAFETY CAR')) {
      const isVirtual = msg.includes('VIRTUAL SAFETY CAR');
      const ending = msg.includes('IN THIS LAP') || msg.includes('ENDING');
      if (msg.includes('DEPLOYED') || (msg.includes('DEPLOY') && !ending)) {
        sc = isVirtual ? 'VSC' : 'SC';
      } else if (ending) {
        sc = null;
      }
    }
  }

  let status = flag;
  if (flag !== 'RED') {
    if (sc === 'SC') status = 'SC';
    else if (sc === 'VSC') status = 'VSC';
  }
  const meta = STATUS_META[status] || STATUS_META.GREEN;
  return { status, flag, sc, label: meta.label, pulse: meta.pulse };
}

// Parse a penalty from a race_control message. Returns null if not a penalty.
// Examples:
//   "5 SECOND TIME PENALTY FOR CAR 44 (HAM)"   -> { driver:44, type:'+5s', seconds:5 }
//   "10 SECOND STOP/GO PENALTY FOR CAR 1 (VER)"-> { driver:1, type:'SG' }
//   "DRIVE THROUGH PENALTY FOR CAR 16 (LEC)"   -> { driver:16, type:'DT' }
export function parsePenalty(message) {
  const msg = String(message || '').toUpperCase();
  if (!msg.includes('PENALTY')) return null;
  const carMatch = msg.match(/CAR\s+(\d+)/);
  const driver = carMatch ? parseInt(carMatch[1], 10) : null;
  if (driver == null || isNaN(driver)) return null;

  if (msg.includes('DRIVE THROUGH') || msg.includes('DRIVE-THROUGH')) {
    return { driver, type: 'DT', seconds: 0, message };
  }
  if (msg.includes('STOP/GO') || msg.includes('STOP-GO') || msg.includes('STOP GO')) {
    return { driver, type: 'SG', seconds: 0, message };
  }
  const secMatch = msg.match(/(\d+)\s*SECOND/);
  if (secMatch) {
    const seconds = parseInt(secMatch[1], 10);
    return { driver, type: `+${seconds}s`, seconds, message };
  }
  return { driver, type: 'PEN', seconds: 0, message };
}

// All active penalties up to T, keyed by driver_number. Later penalties for the
// same car accumulate into a list (a driver can hold more than one).
export function penaltiesAt(events, tMs) {
  const map = new Map();
  for (const e of events) {
    if (e.tMs > tMs) break;
    const p = parsePenalty(e.message);
    if (!p) continue;
    if (!map.has(p.driver)) map.set(p.driver, []);
    map.get(p.driver).push(p);
  }
  return map;
}
