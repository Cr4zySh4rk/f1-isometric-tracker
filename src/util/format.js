// Pure formatting helpers for the timing tower and HUD. DOM-free & side-effect
// free so they can be unit-tested in node.

// A lap/sector time in seconds -> "M:SS.mmm" (e.g. 96.584 -> "1:36.584").
export function fmtLapTime(sec) {
  if (typeof sec !== 'number' || !isFinite(sec) || sec <= 0) return '';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

// A signed delta in seconds -> "+0.334" / "-0.121". 0 -> "+0.000".
export function fmtDelta(sec) {
  if (typeof sec !== 'number' || !isFinite(sec)) return '';
  const sign = sec < 0 ? '-' : '+';
  return `${sign}${Math.abs(sec).toFixed(3)}`;
}

// Race interval/gap value. Numbers -> "+0.334"; already-formatted strings like
// "+1 LAP" pass through; null/undefined -> "" (caller decides fallback text).
export function fmtInterval(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v; // "+1 LAP", "LAP" etc.
  if (typeof v === 'number') {
    if (!isFinite(v)) return '';
    return `+${v.toFixed(3)}`;
  }
  return String(v);
}

// A duration in ms -> session clock "H:MM:SS" or "M:SS".
export function fmtSessionClock(ms) {
  if (!isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

// Live current-lap time in ms -> "M:SS.s" (tenths) for floating car labels.
export function fmtLiveLap(ms) {
  if (!isFinite(ms) || ms < 0) return '';
  const total = ms / 1000;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

// Position-change arrow glyph from a delta (start - current). >0 gained places.
export function positionArrow(startPos, curPos) {
  if (startPos == null || curPos == null) return { dir: 'same', glyph: '—' };
  if (curPos < startPos) return { dir: 'up', glyph: '▲' };
  if (curPos > startPos) return { dir: 'down', glyph: '▼' };
  return { dir: 'same', glyph: '—' };
}
