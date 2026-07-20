// Session/meeting availability — only offer sessions whose data actually
// exists. OpenF1 free-tier data is published ~30 min after a session ends, so
// a session is "available" once date_end + 30 min has passed. Future and
// in-progress sessions are hidden from the picker entirely.

export const PUBLISH_DELAY_MS = 30 * 60 * 1000;
const FALLBACK_SESSION_MS = 4 * 60 * 60 * 1000; // if date_end missing

export function isSessionAvailable(session, now = Date.now()) {
  if (!session) return false;
  let end = session.date_end ? Date.parse(session.date_end) : NaN;
  if (Number.isNaN(end)) {
    const start = session.date_start ? Date.parse(session.date_start) : NaN;
    if (Number.isNaN(start)) return false;
    end = start + FALLBACK_SESSION_MS;
  }
  return end + PUBLISH_DELAY_MS <= now;
}

export function filterAvailableSessions(sessions, now = Date.now()) {
  return (Array.isArray(sessions) ? sessions : []).filter((s) => isSessionAvailable(s, now));
}

// A meeting is worth showing once its weekend has started (it may already have
// completed sessions); fully future weekends are hidden.
export function isMeetingStarted(meeting, now = Date.now()) {
  if (!meeting || !meeting.date_start) return false;
  const start = Date.parse(meeting.date_start);
  return !Number.isNaN(start) && start <= now;
}

export function filterStartedMeetings(meetings, now = Date.now()) {
  return (Array.isArray(meetings) ? meetings : []).filter((m) => isMeetingStarted(m, now));
}
