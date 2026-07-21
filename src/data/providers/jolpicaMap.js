// Pure mappers: Jolpica/Ergast JSON  →  the OpenF1-shaped records the rest of
// the app already understands (drivers, laps, positions, session_result,
// sessions/meetings). No DOM, no network — unit-tested against real fixtures.
//
// Ergast has schedule, per-round results (final classification + grid + fastest
// lap) and per-lap lap times & running order — but NO x/y telemetry. So the
// laps we synthesise carry `date_start` + `lap_duration`, which is exactly what
// the approximate-position estimator needs to animate cars along a cached or
// synthetic centerline.

// Constructor → hex colour (no leading '#', matching OpenF1's `team_colour`).
// Covers the modern grid; unknown constructors fall back to a neutral grey.
export const CONSTRUCTOR_COLOURS = {
  red_bull: '3671c6',
  ferrari: 'e8002d',
  mercedes: '27f4d2',
  mclaren: 'ff8000',
  aston_martin: '229971',
  alpine: '0093cc',
  williams: '64c4ff',
  rb: '6692ff',
  audi: '00e0c6',       // 2026 Audi works team (ex-Sauber)
  cadillac: 'c8a45c',   // 2026 Cadillac F1 entry
  alphatauri: '5e8faa',
  sauber: '52e252',
  alfa: 'c92d4b',
  haas: 'b6babd',
  racing_point: 'f596c8',
  renault: 'fff500',
  toro_rosso: '469bff',
  force_india: 'f596c8',
};

export function constructorColour(constructorId) {
  return CONSTRUCTOR_COLOURS[constructorId] || '999999';
}

// Parse an Ergast lap/fastest-lap time string to seconds.
//   "1:37.284" → 97.284   |   "97.284" → 97.284   |   "1:31:44.742" → 5504.742
export function parseErgastLapTime(str) {
  if (str == null) return null;
  const s = String(str).trim();
  if (!s) return null;
  const parts = s.split(':').map((p) => parseFloat(p));
  if (parts.some((n) => !isFinite(n))) return null;
  let secs = 0;
  for (const p of parts) secs = secs * 60 + p;
  return secs;
}

// A race gap string on a result row: "+22.457", "+1:24.310", "+1 Lap".
export function parseErgastGap(str) {
  if (str == null) return null;
  const s = String(str).trim();
  if (/lap/i.test(s)) return s.replace(/^\+?/, '+');
  const secs = parseErgastLapTime(s.replace(/^\+/, ''));
  return secs == null ? null : secs;
}

// --- schedule → sessions / meetings ---------------------------------------

// Combine an Ergast Race row's `date` + `time` into an epoch-ms start.
function raceStartMs(race) {
  const date = race.date;
  const time = race.time || '00:00:00Z';
  if (!date) return NaN;
  const iso = `${date}T${time.endsWith('Z') || time.includes('+') ? time : `${time}Z`}`;
  return Date.parse(iso);
}

// Map a season schedule (MRData.RaceTable.Races) to OpenF1-shaped `sessions`.
// One Race session per round (+ a Sprint session if the round has one).
export function mapSchedule(mrData, year) {
  const races = mrData?.RaceTable?.Races || [];
  const out = [];
  for (const race of races) {
    const round = parseInt(race.round, 10);
    const startMs = raceStartMs(race);
    const startISO = isNaN(startMs) ? null : new Date(startMs).toISOString();
    const endISO = isNaN(startMs) ? null : new Date(startMs + 2 * 3600 * 1000).toISOString();
    const circuit = race.Circuit || {};
    const base = {
      meeting_key: round,
      circuit_key: circuit.circuitId || `r${round}`,
      circuit_short_name: circuit.circuitName || race.raceName,
      country_name: circuit.Location?.country || '',
      location: circuit.Location?.locality || '',
      year: parseInt(year, 10) || parseInt(race.season, 10),
      _jolpica: { year: parseInt(year, 10) || parseInt(race.season, 10), round },
    };
    if (race.Sprint) {
      const sMs = raceStartMs(race.Sprint);
      out.push({
        ...base,
        session_key: `jol-${year}-${round}-sprint`,
        session_type: 'Race',
        session_name: 'Sprint',
        date_start: isNaN(sMs) ? startISO : new Date(sMs).toISOString(),
        date_end: isNaN(sMs) ? endISO : new Date(sMs + 3600 * 1000).toISOString(),
        _jolpica: { ...base._jolpica, kind: 'sprint' },
      });
    }
    out.push({
      ...base,
      session_key: `jol-${year}-${round}`,
      session_type: 'Race',
      session_name: 'Race',
      date_start: startISO,
      date_end: endISO,
      meeting_name: race.raceName,
    });
  }
  return out;
}

// Map schedule to meeting rows (one per round) for the weekend picker.
export function mapMeetings(mrData, year) {
  const races = mrData?.RaceTable?.Races || [];
  return races.map((race) => {
    const round = parseInt(race.round, 10);
    const startMs = raceStartMs(race);
    const circuit = race.Circuit || {};
    return {
      meeting_key: round,
      meeting_name: race.raceName,
      circuit_key: circuit.circuitId || `r${round}`,
      circuit_short_name: circuit.circuitName || race.raceName,
      country_name: circuit.Location?.country || '',
      location: circuit.Location?.locality || '',
      date_start: isNaN(startMs) ? null : new Date(startMs).toISOString(),
      year: parseInt(year, 10) || parseInt(race.season, 10),
      _jolpica: { year: parseInt(year, 10) || parseInt(race.season, 10), round },
    };
  });
}

// --- results → drivers / classification / grid ----------------------------

// From MRData.RaceTable.Races[0].Results, derive:
//   drivers:  OpenF1-shaped driver rows (number, acronym, name, team, colour)
//   result:   session_result-shaped rows (position, points, dnf…)
//   grid:     position rows for the start of the race (feeds startingPositions)
//   byDriverId: driverId → driver_number map (needed to map lap timings)
export function mapResults(mrData) {
  const race = mrData?.RaceTable?.Races?.[0];
  const results = race?.Results || [];
  const drivers = [];
  const result = [];
  const grid = [];
  const byDriverId = new Map();
  const startMs = race ? raceStartMs(race) : NaN;
  const startISO = isNaN(startMs) ? null : new Date(startMs).toISOString();

  for (const r of results) {
    const d = r.Driver || {};
    const c = r.Constructor || {};
    const number = parseInt(r.number, 10);
    if (!isFinite(number)) continue;
    byDriverId.set(d.driverId, number);

    drivers.push({
      driver_number: number,
      name_acronym: d.code || (d.familyName || '').slice(0, 3).toUpperCase(),
      broadcast_name: `${(d.givenName || '')[0] || ''} ${(d.familyName || '').toUpperCase()}`.trim(),
      full_name: `${d.givenName || ''} ${d.familyName || ''}`.trim(),
      first_name: d.givenName,
      last_name: d.familyName,
      team_name: c.name || '',
      team_colour: constructorColour(c.constructorId),
      country_code: d.nationality,
      _driverId: d.driverId,
    });

    const gridPos = parseInt(r.grid, 10);
    result.push({
      driver_number: number,
      position: parseInt(r.positionText, 10) || null,
      position_text: r.positionText,
      points: parseFloat(r.points) || 0,
      grid: isFinite(gridPos) ? gridPos : null,
      laps: parseInt(r.laps, 10) || null,
      status: r.status,
      dnf: !/^(\d+|Finished)$/i.test(r.status || '') && !/\+\d+ lap/i.test(r.status || ''),
      time: r.Time?.time || null,
      gap_to_leader: r.Time ? parseErgastGap(r.Time.time) : null,
      fastest_lap: r.FastestLap
        ? { lap: parseInt(r.FastestLap.lap, 10), duration: parseErgastLapTime(r.FastestLap.Time?.time) }
        : null,
    });

    // Grid position row (position 0 = pit start → put at back).
    grid.push({
      driver_number: number,
      position: isFinite(gridPos) && gridPos > 0 ? gridPos : results.length,
      date: startISO,
    });
  }
  return { drivers, result, grid, byDriverId, startMs };
}

// --- laps → OpenF1-shaped laps (+ synthetic positions) --------------------

// Build per-driver lap rows with `date_start` + `lap_duration` from Ergast lap
// timings. `byDriverId` maps Ergast driverId → car number; `raceStartMs` is the
// race green-flag epoch (lap 1 starts here). Also returns `positions`: running
// order rows (one per driver per lap) usable as the OpenF1 `position` table.
export function mapLaps(mrData, byDriverId, raceStartMs) {
  const race = mrData?.RaceTable?.Races?.[0];
  const laps = race?.Laps || [];
  const start = isFinite(raceStartMs) ? raceStartMs : (race ? raceStartMsFromRace(race) : 0);

  // Sort laps by number ascending so cumulative timing is correct.
  const ordered = [...laps].sort((a, b) => parseInt(a.number, 10) - parseInt(b.number, 10));

  const cum = new Map(); // driver_number → cumulative elapsed ms before current lap
  const lapRows = [];
  const positions = [];

  for (const lap of ordered) {
    const lapNumber = parseInt(lap.number, 10);
    for (const t of lap.Timings || []) {
      const number = byDriverId.get(t.driverId);
      if (number == null) continue;
      const durSec = parseErgastLapTime(t.time);
      const before = cum.get(number) || 0;
      const dateStartMs = start + before;
      const dateStartISO = new Date(dateStartMs).toISOString();

      lapRows.push({
        driver_number: number,
        lap_number: lapNumber,
        lap_duration: durSec,
        date_start: dateStartISO,
        is_pit_out_lap: false,
        _position: parseInt(t.position, 10) || null,
      });
      positions.push({
        driver_number: number,
        position: parseInt(t.position, 10) || null,
        date: dateStartISO,
      });

      if (durSec != null) cum.set(number, before + durSec * 1000);
    }
  }
  return { laps: lapRows, positions };
}

function raceStartMsFromRace(race) {
  return raceStartMs(race);
}
