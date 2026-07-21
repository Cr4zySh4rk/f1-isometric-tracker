// Pure championship-standings mapping (no DOM/network) — Jolpica/Ergast shapes.
//
// Standings are shown "AS OF THIS RACE" — i.e. going INTO the weekend, which is
// the classification AFTER THE PREVIOUS ROUND. So for a meeting mapped to round
// R we request the standings after round R-1. If R is round 1 there is no prior
// round, so we show nothing (empty / "—"). This choice is documented in
// ARCHITECTURE.md.

import { constructorColour } from './providers/jolpicaMap.js';

// Map a loaded meeting to (season, round) using the Ergast season schedule.
// season = the meeting's year; round = the scheduled race whose date is CLOSEST
// to the meeting's date_start. Returns { season, round } or null if unmappable.
export function meetingToRound(scheduleRaces, meetingDateMs, season) {
  if (!Array.isArray(scheduleRaces) || !scheduleRaces.length) return null;
  if (!Number.isFinite(meetingDateMs)) {
    // No date to match on: fall back to round 1 so at least the schedule resolves.
    const r0 = parseInt(scheduleRaces[0].round, 10);
    return Number.isFinite(r0) ? { season, round: r0 } : null;
  }
  let best = null, bestDiff = Infinity;
  for (const race of scheduleRaces) {
    const t = Date.parse(`${race.date}T${race.time || '00:00:00Z'}`);
    if (!Number.isFinite(t)) continue;
    const diff = Math.abs(t - meetingDateMs);
    if (diff < bestDiff) { bestDiff = diff; best = race; }
  }
  if (!best) return null;
  const round = parseInt(best.round, 10);
  return Number.isFinite(round) ? { season, round } : null;
}

// Which round's *finished* standings to display for a meeting at `round`.
// Returns the previous round, or 0 when round ≤ 1 (⇒ "no standings yet").
export function standingsRoundToShow(round) {
  const r = parseInt(round, 10);
  if (!Number.isFinite(r) || r <= 1) return 0;
  return r - 1;
}

// Map an Ergast DriverStandings list to compact rows for the widget.
export function mapDriverStandings(standingsList) {
  const rows = standingsList?.DriverStandings || [];
  return rows.map((r) => {
    const d = r.Driver || {};
    const c = (r.Constructors && r.Constructors[r.Constructors.length - 1]) || {};
    return {
      position: parseInt(r.position, 10) || null,
      code: d.code || (d.familyName || '').slice(0, 3).toUpperCase(),
      name: `${d.givenName || ''} ${d.familyName || ''}`.trim(),
      points: parseFloat(r.points) || 0,
      wins: parseInt(r.wins, 10) || 0,
      constructor: c.name || '',
      color: `#${constructorColour(c.constructorId)}`,
    };
  });
}

// Map an Ergast ConstructorStandings list to compact rows for the widget.
export function mapConstructorStandings(standingsList) {
  const rows = standingsList?.ConstructorStandings || [];
  return rows.map((r) => {
    const c = r.Constructor || {};
    return {
      position: parseInt(r.position, 10) || null,
      name: c.name || '',
      points: parseFloat(r.points) || 0,
      wins: parseInt(r.wins, 10) || 0,
      color: `#${constructorColour(c.constructorId)}`,
    };
  });
}
