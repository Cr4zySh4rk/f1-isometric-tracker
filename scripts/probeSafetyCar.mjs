// T4 evidence: find a race with a SAFETY CAR DEPLOYED message, fetch a location
// window during the deployment, and list driver_numbers present in /location
// that are NOT in /drivers for the session (the SC / medical car entries).
// Usage: node scripts/probeSafetyCar.mjs [year]
import { cachedJson, OF1 } from './cachedFetch.mjs';

const year = parseInt(process.argv[2] || '2024', 10);
const sessions = await cachedJson(`${OF1}/sessions?year=${year}`);
const races = sessions.filter((s) => s.session_name === 'Race');
console.log(`${year}: ${races.length} races`);

for (const race of races) {
  const rc = await cachedJson(`${OF1}/race_control?session_key=${race.session_key}`);
  const sc = rc.filter((m) => /SAFETY CAR DEPLOYED/i.test(m.message || ''));
  if (!sc.length) continue;
  console.log(`\n=== ${race.circuit_short_name} (session ${race.session_key}) — ${sc.length} SC deployment(s) ===`);
  const deploy = sc[0];
  console.log(`deploy: ${deploy.date} "${deploy.message}"`);

  const drivers = await cachedJson(`${OF1}/drivers?session_key=${race.session_key}`);
  const driverNums = new Set(drivers.map((d) => d.driver_number));

  const t0 = Date.parse(deploy.date);
  // Sample 30 s of location one minute into the deployment (SC already on track).
  const a = new Date(t0 + 60000).toISOString();
  const b = new Date(t0 + 90000).toISOString();
  const loc = await cachedJson(`${OF1}/location?session_key=${race.session_key}&date>${a}&date<${b}`);
  const present = new Map();
  for (const r of loc) present.set(r.driver_number, (present.get(r.driver_number) || 0) + 1);
  const extras = [...present.keys()].filter((n) => !driverNums.has(n)).sort((x, y) => x - y);
  console.log(`location rows=${loc.length} distinct numbers=${present.size}`);
  console.log(`drivers list: [${[...driverNums].sort((x, y) => x - y).join(', ')}]`);
  console.log(`EXTRA (non-driver) numbers: ${extras.map((n) => `${n} (${present.get(n)} samples)`).join(', ') || 'none'}`);
  break; // one race is enough evidence; keep the rate budget
}
