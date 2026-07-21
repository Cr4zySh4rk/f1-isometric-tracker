// Pure team-radio selection (no DOM/audio). /team_radio rows:
//   { date, driver_number, recording_url }  (recording_url is an mp3)
// Everything is replay-time-aware: we only ever surface clips whose date ≤ T, so
// autoplay is contextual to the replay cursor and never jumps to a future clip.

// Normalise + sort a driver's clips ascending by time; attach epoch-ms `t`.
export function normalizeClips(rows, driverNumber) {
  const out = [];
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    if (!r || !r.recording_url) continue;
    if (driverNumber != null && r.driver_number !== driverNumber) continue;
    const t = Date.parse(r.date);
    if (!Number.isFinite(t)) continue;
    out.push({ t, url: r.recording_url, driver_number: r.driver_number });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

// The most recent clip whose time ≤ T, or null (do NOT return a future clip).
export function latestClipAtOrBefore(clips, tMs) {
  if (!Array.isArray(clips) || !clips.length) return null;
  let lo = 0, hi = clips.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (clips[mid].t <= tMs) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans >= 0 ? clips[ans] : null;
}

// All clips with time ≤ T, most-recent first (for the panel list).
export function clipsUpTo(clips, tMs) {
  if (!Array.isArray(clips)) return [];
  return clips.filter((c) => c.t <= tMs).sort((a, b) => b.t - a.t);
}

// The whole session's clips for a driver, most-recent first, each flagged with
// `upcoming` = its time is after the current replay cursor T. We show the full
// list (not just ≤ T) because radio is sparse — gating the list to ≤ T made it
// read "no team radio" for almost every driver/cursor. Upcoming clips are still
// playable (this is a replay of a completed race).
export function clipsForList(clips, tMs) {
  if (!Array.isArray(clips)) return [];
  return clips
    .map((c) => ({ ...c, upcoming: c.t > tMs }))
    .sort((a, b) => b.t - a.t);
}

// Which clip to auto-play when a driver is focused: prefer the most recent clip
// at/or before T (contextual to the cursor); if none has happened yet, fall back
// to the earliest clip so focusing a driver who has radio always plays something.
export function clipToAutoplay(clips, tMs) {
  const before = latestClipAtOrBefore(clips, tMs);
  if (before) return before;
  return (Array.isArray(clips) && clips.length) ? clips[0] : null;
}
