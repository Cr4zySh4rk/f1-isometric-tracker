// OpenF1 data provider — the primary source (full telemetry: x/y/z location,
// intervals, race control, pit…). Thin adapter over the OpenF1 client that
// exposes the shared Provider interface consumed by SessionStore / ReplayBuffer
// / the session picker.
//
// Provider interface (all async; return OpenF1-shaped records):
//   id, capabilities:{ telemetry }
//   getMeetings(year)                       -> meeting rows
//   getSessions({ year|meeting_key })       -> session rows
//   getDrivers(session)                     -> driver rows
//   getLaps(session)                        -> lap rows
//   getPositions(session)                   -> position rows
//   getRaceControl(session)                 -> race_control rows
//   getPit(session)                         -> pit rows
//   getSessionResult(session)               -> session_result rows
//   getLocationWindow(session, aISO, bISO)  -> location rows | null (null=no telemetry)
//   getIntervals(session, aISO, bISO)       -> interval rows
//   probe()                                 -> true if currently serving data
//
// LiveBlockError / network errors propagate unchanged so the ProviderManager can
// react (failover) — they are NOT swallowed here.

import { OpenF1, LiveBlockError, probeAvailable } from '../../api/openf1.js';

export class OpenF1Provider {
  constructor() {
    this.id = 'openf1';
    this.label = 'OpenF1';
    this.capabilities = { telemetry: true };
  }

  getMeetings(year) { return OpenF1.meetings(year); }
  getSessions(params) { return OpenF1.sessions(params); }
  getDrivers(session) { return OpenF1.drivers(keyOf(session)); }
  getLaps(session) { return OpenF1.laps(keyOf(session)); }
  getPositions(session) { return OpenF1.position(keyOf(session)); }
  getRaceControl(session) { return OpenF1.raceControl(keyOf(session)); }
  getPit(session) { return OpenF1.pit(keyOf(session)); }
  getSessionResult(session) { return OpenF1.sessionResult(keyOf(session)); }

  getLocationWindow(session, aISO, bISO) {
    return OpenF1.location(keyOf(session), aISO, bISO);
  }
  getIntervals(session, aISO, bISO) {
    return OpenF1.intervals(keyOf(session), aISO, bISO);
  }

  probe() { return probeAvailable(); }
}

function keyOf(session) {
  return typeof session === 'object' && session ? session.session_key : session;
}

export { LiveBlockError };
