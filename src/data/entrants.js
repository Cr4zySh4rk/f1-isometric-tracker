// Entrant classification: OpenF1 location/position feeds can include
// NON-DRIVER entries — the FIA safety & medical cars — with high car numbers.
//
// Verified against real data (Jeddah 2024 race 9480 + Silverstone 2026 race
// 11326, both with "SAFETY CAR DEPLOYED" in /race_control): /location carries
// driver_numbers 241, 242 and 243 that are absent from /drivers. During the
// Silverstone SC period, 242 was the car actually lapping the circuit
// (~11.7 km of path over two laps — the deployed safety car) while the others
// sat at (0,0). 241/242 are the two safety cars (they alternate per event);
// 243 is the medical car.
//
// Anything in the telemetry that is not in the session's /drivers list is
// treated as a safety-car-class entrant: rendered with the road-car model,
// labelled below, excluded from the timing tower / fastest-lap / sector logic
// and not clickable-focusable.

export const SAFETY_CAR_LABELS = { 241: 'SC', 242: 'SC', 243: 'MED' };

// Classify a telemetry driver_number against the session's driver numbers
// (a Set, or anything with .has). Returns:
//   { type: 'driver' }                              — a real session driver
//   { type: 'safety',  label: 'SC' }                — safety car
//   { type: 'medical', label: 'MED' }               — medical car
export function classifyEntrant(num, driverNumbers) {
  if (driverNumbers && driverNumbers.has(num)) return { type: 'driver' };
  const label = SAFETY_CAR_LABELS[num] || 'SC';
  return { type: label === 'MED' ? 'medical' : 'safety', label };
}
