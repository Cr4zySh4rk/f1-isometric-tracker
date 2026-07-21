// DNF / retirement handling — pure, replay-time-aware, DOM/network free.
//
// Rule (documented; validated against real OpenF1 data — Silverstone 2026 race
// 11326, driver 27/HUL retired on lap 37: /session_result marks dnf=true and the
// car's /location stops updating at ~+3934 s while the session runs to +7200 s):
//
//   * A driver is CLASSIFIED OUT for the session when /session_result marks them
//     dnf / dns / dsq. This is a whole-session fact.
//   * A classified-out driver is RETIRED *at replay time T* only once their
//     telemetry has stopped updating by T (the car has come to rest / been
//     recovered). This is derived per frame from telemetry availability
//     (`endGap`), so it is fully time-aware: scrubbing the cursor back to before
//     the retirement makes the car race normally again.
//   * On the track a retired car is shown STOPPED for a moment, then fades out
//     and is REMOVED a few seconds after it stops updating (marshals recover it).
//   * In the timing tower the driver is classified as retired (greyed, sorted to
//     the classified tail) once T passes their estimated retirement time.

// Show the stopped car fully for this long after telemetry ends, then fade over
// `RETIRE_FADE_MS` before it is removed (≈ 6 s total — the recovery window).
export const RETIRE_STOP_HOLD_MS = 2500;
export const RETIRE_FADE_MS = 3500;

// Map(driver_number -> { dnf, dns, dsq, laps }) for every classified-out driver
// in a /session_result payload.
export function classifiedOut(result) {
  const map = new Map();
  for (const r of Array.isArray(result) ? result : []) {
    if (!r || r.driver_number == null) continue;
    if (r.dnf || r.dns || r.dsq) {
      map.set(r.driver_number, {
        dnf: !!r.dnf, dns: !!r.dns, dsq: !!r.dsq,
        laps: r.number_of_laps != null ? r.number_of_laps : null,
      });
    }
  }
  return map;
}

// Estimated retirement time (ms epoch) for a driver from /laps: the end of their
// last lap. If that lap has no duration (retired mid-lap) estimate it as the
// lap's start plus the driver's median completed-lap duration. Returns null when
// the driver has no dated laps.
export function retirementTimeMs(laps, num) {
  const mine = (Array.isArray(laps) ? laps : []).filter((l) => l && l.driver_number === num && l.date_start);
  if (!mine.length) return null;
  mine.sort((a, b) => (a.lap_number || 0) - (b.lap_number || 0));
  const last = mine[mine.length - 1];
  const ds = Date.parse(last.date_start);
  if (isNaN(ds)) return null;
  if (typeof last.lap_duration === 'number' && last.lap_duration > 0) {
    return ds + last.lap_duration * 1000;
  }
  const durs = mine
    .map((l) => l.lap_duration)
    .filter((d) => typeof d === 'number' && d > 0)
    .sort((a, b) => a - b);
  const med = durs.length ? durs[durs.length >> 1] : 90;
  return ds + med * 1000;
}

// Per-frame CAR display for a classified-out driver. Removal is driven by two
// independent "the car has stopped" signals, whichever fires first:
//   - endGapMs     : ms since the driver's telemetry stopped updating (the car
//                    dropped off coverage / transponder off / went off track).
//   - restElapsedMs: ms (replay time) the car has been AT REST after its
//                    retirement (a real retired car often keeps transmitting its
//                    parked position for many minutes — we must not wait for that
//                    feed to end; once it has come to rest it is recovered).
// Returns null for drivers who are NOT classified out (normal handling applies).
// Otherwise { state: 'racing' | 'stopped' | 'removed', retired, alpha } — the car
// is shown STOPPED for `stopHold`, fades over `fade`, then is REMOVED (alpha 0).
// Fully time-aware: scrubbing back before the retirement yields racing again
// (the caller passes endGapMs 0 / restElapsedMs 0).
export function retirementDisplayAt({
  isClassifiedOut, present, endGapMs = 0, restElapsedMs = 0,
  stopHold = RETIRE_STOP_HOLD_MS, fade = RETIRE_FADE_MS,
}) {
  if (!isClassifiedOut) return null;
  // A live-but-moving retiree (limping back to the pits / to a stop) keeps racing.
  const telemetryGap = present ? 0 : Math.max(0, endGapMs);
  const gap = Math.max(telemetryGap, Math.max(0, restElapsedMs));
  if (gap <= 0) return { state: 'racing', retired: false, alpha: 1 };
  if (gap >= stopHold + fade) return { state: 'removed', retired: true, alpha: 0 };
  if (gap <= stopHold) return { state: 'stopped', retired: true, alpha: 1 };
  return { state: 'stopped', retired: true, alpha: 1 - (gap - stopHold) / fade };
}

// Tower classification: a classified-out driver is shown as retired once replay
// time T has passed their (estimated) retirement time. Time-aware.
export function isRetiredAt(retireMs, tMs) {
  return retireMs != null && tMs >= retireMs;
}
