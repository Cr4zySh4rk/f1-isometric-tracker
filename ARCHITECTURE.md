# F1 Isometric Tracker — Architecture

A fully client-side web app that visualizes Formula 1 sessions on an isometric 3D track with real car positions, replaying any session since 2023 and going near-live when the API allows.

Live site: https://cr4zysh4rk.github.io/f1-isometric-tracker/

## 1. Data source: OpenF1 (https://api.openf1.org/v1)

Free tier: all historical sessions since 2023, no auth, CORS-enabled, JSON.
Constraints that shape the design:

- **Rate limits: 3 req/s, 30 req/min.** All requests go through a client-side throttled queue.
- **Live restriction:** from 30 min before to 30 min after a session, free access is blocked and the API returns `{"detail": "Live F1 session in progress..."}` with the full API restricted. The app must detect this, show a banner, and auto-retry with backoff. If the user has a paid OpenF1 key, they can paste it in Settings and live mode works (3 s behind real time).

Endpoints used:

| Endpoint | Use | Notes |
|---|---|---|
| `/meetings?year=Y` | Race weekend picker | |
| `/sessions?meeting_key=K` | Session picker (FP/Quali/Sprint/Race) | |
| `/drivers?session_key=K` | Names, numbers, `team_colour`, acronyms | |
| `/location?session_key=K&date>A&date<B` | Car x/y/z at ~3.7 Hz, all drivers per window | Core of the visualization |
| `/position?session_key=K` | Running order | |
| `/intervals?session_key=K&date>A&date<B` | Gap to leader / interval (races) | ~4 s cadence |
| `/laps?session_key=K` | Lap numbers, lap/sector times | |
| `/race_control?session_key=K` | Flags, SC/VSC, incidents | Drives flag banner + track tint |
| `/session_result?session_key=K` | Final classification | |

## 2. Data volume strategy — chunked streaming replay

A race = 20 cars × 3.7 Hz × ~2 h ≈ 500k location rows. Never fetched at once.

- **Time-windowed chunks:** location (and intervals) are fetched in windows of ~90 s of session time for **all drivers in one request** using `date>` / `date<` filters.
- **Prefetch ring buffer:** the replay engine keeps ~3 windows ahead of the playback cursor, fetching within rate limits. Consumed windows behind the cursor are evicted (cap memory ~50 MB).
- Small tables (drivers, laps, positions, race_control) are fetched once per session and kept whole.
- Every response cached in-memory keyed by URL; laps/drivers additionally in `localStorage` (small).

## 3. Modules (ES modules, no framework — Vite + three.js only)

```
src/
  api/openf1.js        throttled queue (3/s, 30/min), retry, live-block detection, cache
  data/sessionStore.js session metadata, drivers, laps, positions, race control
  data/replayBuffer.js chunked location/interval prefetcher + time-indexed lookup
                        (window size + interval stride scale with playback speed)
  data/windowPlan.js   pure speed→window-size math keeping prefetch ≤ 30 req/min
  data/entrants.js     classify telemetry numbers not in /drivers as SC/MED cars
  engine/clock.js      playback clock: play/pause, 0.5–30× speed, seek, live mode
  engine/bufferGate.js hold/release "Buffering…" state machine (cars never vanish)
  engine/interp.js     per-driver position interpolation (Catmull-Rom over samples)
  track/trackMath.js   pure geometry: median-of-laps centerline, adaptive resample,
                        curvature-aware smoothing, normals, arc length
  track/trackBuilder.js derive centerline from several clean fast laps → median →
                        adaptive resample → smooth → ribbon mesh, kerbs, S/F, walls
  scene/renderer.js    three.js scene, OrthographicCamera in isometric attitude
                       (rotated 45° yaw, ~35.26° pitch), soft shadows, sky gradient
  scene/cars.js        3D car model per driver, tinted with team_colour,
                       floating number/acronym labels, selected-driver highlight
  ui/hud.js            leaderboard (order, gaps, last lap), lap counter, flag banner
  ui/controls.js       session picker, transport bar (play/pause/speed/scrub), settings
  main.js              wiring + game loop (requestAnimationFrame)
```

### Track from data (no track asset needed)
`trackBuilder` picks the fastest complete lap from `/laps`, fetches its `/location`
trace for that driver, resamples + smooths it (Catmull-Rom), closes the loop, and
extrudes a flat ribbon (~12 m wide) with alternating red/white kerb strips on
curvature peaks, a checkered start/finish line and low walls. Ground plane +
subtle grid gives the isometric diorama look.

### Cars
Primary: low-poly formula-style glTF model (CC0, Kenney racing assets), cloned 20×,
body material tinted per `team_colour`. Fallback: procedural low-poly F1 built from
three.js primitives (body, nose, wings, 4 wheels, halo) — guaranteed to work offline.
Cars orient along velocity vector; wheels spin with speed.

### Recent upgrades (T1–T4)
- **T1 — cars never vanish on seek / at high speed.** `data/windowPlan.js` scales
  the prefetch window duration and interval-feed stride with playback speed so one
  fetch always covers ≥ 15 s of wall-clock playback; `requestBudgetPerMin(30) ≈ 6`,
  well under the OpenF1 30 req/min limit (at 1× the classic 90 s window is kept).
  `engine/bufferGate.js` is a hold/release state machine wired into the main loop:
  when the cursor sits on an unbuffered window it HOLDS the clock (with a
  "Buffering…" chip) and releases the instant data arrives — so playback is never
  running blindly over unfetched data. `main.js` passes `clock.speed` to
  `buffer.update()` and drives the gate every frame.
- **T2 — track fidelity.** `track/trackMath.js` builds the centerline from the
  pointwise MEDIAN of several clean fast laps (kills GPS jitter without rounding
  corners), then resamples adaptively (dense in corners) and smooths with a
  curvature-attenuated Laplacian. The localStorage cache key is bumped to `v2` so
  users get the new shapes. Derived lap lengths match official circuit lengths to
  ~1 % (Silverstone/Spielberg/Spa; OpenF1 /location units are decimetres).
- **T3 — lap counter.** `data/timing.js#lapAtTime` (pure, replay-time-aware) gives
  "LAP n / total" as the leader's lap; rendered in the tower header by `ui/hud.js`.
- **T4 — safety / medical cars.** Telemetry numbers absent from `/drivers`
  (241/242 = SC, 243 = MED, verified against real deployments) are classified by
  `data/entrants.js` and drawn by `scene/cars.js` as a distinct closed-cockpit
  road car with an amber light bar and an SC/MED label — with no raycast hit-proxy,
  so they are not pickable/followable, and they are excluded from the timing tower,
  fastest-lap and sector logic.

### Recent upgrades (T5–T7)
- **T5 — grid / stationary heading.** A car's heading is a finite difference of
  its telemetry velocity, which is undefined when it's stopped — so on the grid
  cars pointed in random directions (real data: Silverstone 2026 grid reads ~0
  dm/s vs 400–850 dm/s racing). `engine/interp.js` now exposes a per-sample
  `speed` (dm/s), and `trackMath.js` adds `nearestIndex` / `smoothedTangent` /
  `tangentHeadingAt`. `buildTrack` returns `track.tangentAt(worldX,worldY)` — the
  forward track direction at the nearest centerline point (same angle convention
  as a velocity heading). `scene/cars.js` chooses the heading with the pure
  `chooseHeading()`: below `SLOW_SPEED` (40 dm/s ≈ 14 km/h) it orients along the
  track tangent, otherwise along velocity, and it damps the heading lerp harder
  at low speed. The harness proves all 21 stationary grid cars square to the
  tangent (≤ 20°) where the raw velocity heading was misaligned for the field.
- **T6 — start/finish line.** `buildStartFinish` orients the checkerboard from a
  **smoothed tangent** (`smoothedTangent`, ±3 centerline points) instead of a
  single noisy segment (Silverstone S/F skew 23° → 0.2°), and re-anchors
  `startIndex` to the real S/F crossing (`meta.startRaw`, the first sample of the
  trimmed fast-lap trace → nearest centerline point; cache bumped to **v3**). The
  band is rebuilt as merged full-width quads flush to both ribbon edges, just
  above the asphalt (Y 0.06, ribbon 0.05 — no z-fighting), with a thin white
  leading line. `scripts/trackDump.mjs` draws the S/F line + tangent arrow and
  reports the skew (evidence: `test/evidence/<circuit>_{before,after}.svg`).
- **T7 — DNF / retirement.** `data/retirement.js` (pure) + `/session_result`
  (loaded by `sessionStore.js`) handle retired cars, all replay-time-aware:
  `classifiedOut` (dnf/dns/dsq), `retirementTimeMs` (estimated from `/laps`),
  `isRetiredAt` (tower classification at T) and `retirementDisplayAt` (per-frame
  car state). A retired car is shown racing until it comes to REST after its
  retirement, then STOPPED (greyed "OUT" label), then faded and REMOVED a few
  seconds later — driven by *either* telemetry ending *or* a replay-time
  rest-timer (`scene/cars.js`), because a real wreck keeps transmitting its
  parked position for many minutes (#27 pinged for ~35 min). It is fully
  time-aware: scrubbing back before the retirement re-shows the car moving. The
  timing tower greys retired drivers and sorts them to the classified tail
  (`buildTowerRows` `retiredFn`), and the follow camera releases with a toast if
  the followed car retires (`main.js`).

### Playback vs live
One code path: the replay engine always renders "session time T". In replay, T is
driven by the playback clock. In live mode, T = now − 3 s and the buffer polls the
newest window; if the API returns the live-block error, show "Live data restricted
(free tier) — session replay available ~30 min after the flag" and poll every 60 s
until data appears.

## 4. Hosting & CI

- **GitHub Pages** from the `github-pages` Actions artifact (no gh-pages branch).
- `.github/workflows/deploy.yml`: on push to `main` → checkout → Node 20 →
  `npm ci` → `vite build` (base `/f1-isometric-tracker/`) → upload `dist` →
  `actions/deploy-pages`.
- 100% static; the browser talks to OpenF1 directly (CORS is open).

## 5. V2 — timing tower, focus mode & sector coloring

Everything below is **replay-time-aware**: state is computed as of session time
T, never end-of-session. The timing/parse logic lives in pure, unit-tested
modules (no DOM) so it can be validated in node against fixtures:

```
src/util/format.js      lap/delta/interval/clock/live-lap formatting
src/data/raceControl.js flag + SC/VSC state, penalty parsing (all at time T)
src/data/timing.js      fastest-lap-at-T, order, deltas, pit, sector bests,
                        buildTowerRows() model, focusTrackColors()
src/data/sectors.js     sector-color state machine + centerline sector split
src/track/trackMath.js  resample/smooth/normals/curvature/arc-length (no three)
src/api/queue.js        RateLimitedQueue (injectable clock) + classifyResponse
```

- **Timing tower** (`ui/hud.js`) renders `buildTowerRows()`: position, ▲/▼ change
  vs grid, team bar, acronym, delta column, and P / penalty / FL badges. Races
  show LEADER + interval (click the header to toggle interval ↔ gap-to-leader);
  practice/quali show P1's best time, "+Δ" to P1, or NO TIME. A status strip
  (green/yellow/double-yellow/red/SC/VSC/chequered, pulsing for red & SC)
  reflects `/race_control`.
- **Fastest lap**: purple FL marker on the current session-fastest-lap holder,
  recomputed at T (`fastestLapAt` only counts laps *completed* before T).
- **Penalties**: parsed from `/race_control` messages ("N SECOND … CAR X" →
  "+Ns", "STOP/GO" → SG, "DRIVE THROUGH" → DT); shown as a badge with the full
  message as tooltip.
- **Pit detection** (`isInPitAt`): a driver is "in pit" when T falls in
  `[exit − pit_duration − 4s, exit + 4s]` from a `/pit` row (OpenF1's pit `date`
  is the rejoin time). Robust without needing location gaps.
- **Floating car labels** (`scene/cars.js`): acronym + live current-lap time
  (T − current lap's `date_start`), scaled with camera zoom; the lap time hides
  when zoomed far out.
- **Click-to-focus** (`scene/cars.js` raycast + `main.js`): clicking a car/label
  selects it → camera follows, tower row highlights, and the driver panel
  (`ui/driverPanel.js`) shows name/team/number/position, current lap & live
  time, last/best lap, and S1/S2/S3 colored purple (session best) / green
  (personal best) / yellow / red. Click empty ground or press Esc to unfocus.
- **Sector track coloring**: the ribbon is split into 3 meshes. Sector
  boundaries are **equal thirds of the centerline arc length**
  (`splitSectorsByLength`, default proportions — pass session-typical sector
  time proportions to weight them). Each sector is tinted by the focused
  driver's most recent completed sector: purple = session best, green = personal
  best, yellow = slower, red = >2 s slower. A red/yellow/SC/VSC track status
  overrides the whole track (flag takes priority). Colors lerp smoothly.
- **Memory**: switching sessions disposes all track and car geometries /
  materials / textures (`track.dispose()`, `carMgr.dispose()`).

## 6. Failure modes handled

- Live-block error → banner + backoff retry (no crash, UI stays interactive).
- 429 → queue pauses, resumes after window.
- Missing intervals (practice/quali) → leaderboard falls back to lap-time order.
- Sparse location samples (red flags, pits, in-lap gaps) → interpolation clamps,
  cars fade when data gap > 10 s.
- WebGL unavailable → friendly message.

## 7. Data providers & Approximate mode (multi-provider failover)

The app talks to data through a **provider interface**, so it can survive OpenF1
being live-blocked or down by seamlessly falling back to a second source.

```
src/data/providers/
  openf1Provider.js   primary  — full telemetry (x/y/z location, intervals, race control…)
  jolpicaProvider.js  fallback — schedule/results/lap-times/order, NO telemetry
  jolpicaMap.js       pure Ergast→OpenF1-shape mappers (unit-tested vs real fixtures)
  manager.js          ProviderManager: failover state machine + recovery poll
src/data/approxPosition.js  lap-time → position-on-centerline estimator (pure)
src/data/approxBuffer.js    ReplayBuffer-shaped sampler for Approximate mode
```

Provider interface (all async, return OpenF1-shaped records):
`getMeetings(year)`, `getSessions(params)`, `getDrivers/getLaps/getPositions/
getRaceControl/getPit/getSessionResult(session)`,
`getLocationWindow(session, aISO, bISO)` → rows **or `null`** (no telemetry),
`getIntervals(...)`, `probe()`, plus `capabilities.telemetry`.

### Failover state machine (`ProviderManager`)
- Every data call routes through `manager.run(fn)`. In **live** mode it uses the
  OpenF1 provider; if a call fails with a **live-block** or a **genuine network
  error** (`isNetwork` — offline/DNS/CORS/timeout), it **demotes to Approximate
  mode** and retries the same call on Jolpica. A plain HTTP/API error (400/404…)
  is *not* a failover trigger and surfaces to the caller.
- **Recovery:** while degraded it polls `OpenF1.probe()` every 60 s
  (`checkRecovery`); on success it **promotes back to live** and fires
  `onModeChange`, so `main.js` reloads the session with real telemetry
  (auto-reload for OpenF1-native sessions; a "reopen picker" prompt for a
  Jolpica session whose key can't be mapped to OpenF1).
- The whole machine is deterministic — providers, `probe`, and the poll
  scheduler are injectable — and unit-tested in `test/providerFailover.test.js`.

### Approximate mode (no telemetry)
When the active provider has no x/y (`getLocationWindow → null`):
- **UI is clearly labeled** with a persistent info banner: *"Approximate mode —
  live telemetry unavailable…"*. Session picker / results / lap-by-lap order come
  from Jolpica.
- The track is a **synthetic oval** (`syntheticOval`, since Ergast has no GPS),
  and cars animate via `approxPosition`: `progress = elapsed-in-lap /
  lap_duration` mapped to arc length along the closed centerline (one lap = one
  loop). Missing/absent `lap_duration` (pit in/out) is backfilled with the
  driver's median lap; before their first lap a car sits faded on the grid.
- `ApproxBuffer` mirrors `ReplayBuffer`'s `sampleAll(t)` contract, so the render
  loop, HUD and transport are agnostic to which mode is active.

### Why no *direct* F1 provider (openf1-project findings + exact CORS/auth results)
The [openf1](https://github.com/br-g/openf1) project ingests **server-side**
Python from F1's live-timing endpoints and decodes them into the same records
OpenF1 serves us:
- Source of truth: `https://livetiming.formula1.com/static/<session>/…` topics,
  notably **`Position.z`** (car x/y/z) and `CarData.z` — **deflate-compressed,
  base64 line-delimited** feeds. `LocationCollection` (source topic `Position.z`)
  yields `{driver_number, date, x, y, z}` per `Entries` timestamp — i.e. OpenF1's
  `/location` is exactly this feed decoded. Live ingestion uses SignalR
  (`/signalr/negotiate` → `/connect`).

Re-tested from a static GitHub-Pages origin (`curl -H "Origin:
https://cr4zysh4rk.github.io" …`, July 2026):

| URL | Result | Browser-usable? |
|---|---|---|
| `…/static/StreamingStatus.json` | **HTTP 200, but NO `access-control-allow-origin` header** | ❌ blocked by CORS |
| `…/signalr/negotiate?…` | **HTTP 401** | ❌ auth required |

So a client-side app **cannot** read F1 live-timing directly (no CORS on
`/static`, negotiate is 401). **What we ported: nothing executable in-browser** —
the *understanding* that OpenF1's `/location` == decoded `Position.z` guides our
design, and the Jolpica fallback + `approxPosition` estimator substitute for the
unreachable telemetry using lap times. A direct F1 provider is intentionally
omitted for the reasons above.

### Jolpica (fallback) specifics
- Base `https://api.jolpi.ca/ergast/f1/…`; classic Ergast `{MRData:…}` envelope.
- **CORS verified:** `access-control-allow-origin: *` from the Pages origin ✅.
- **Rate limits** (unauthenticated): ~4 req/s burst, 500 req/hour — the client
  throttles to 4/s via the shared `RateLimitedQueue` and pages `laps` (~1000
  timing rows/race) at `limit=100`.
- Mappers (`jolpicaMap.js`) turn schedule→sessions/meetings, results→drivers/
  classification/grid, and per-lap timings→OpenF1-shaped `laps`
  (`date_start` + `lap_duration`, cumulative from the green flag) + running order.

## 8. Real-data validation (performed against the live API, session 11334)

Validated the parsers/track math against **real** OpenF1 v1 responses (2026-07-19
Spa Race) and real Jolpica 2025 data via node scripts; fixtures in
`test/fixtures/openf1_real.json` and `jolpica_real.json` are faithful subsets.

- **Shapes confirmed / guarded** (`test/realShapes.test.js`): dates are
  microsecond precision with a **`+00:00` offset** (not `Z`) — `Date.parse`
  handles both; `team_colour` is a **bare 6-hex** string (no `#`);
  laps use **`duration_sector_1/2/3`** + `lap_duration`; `intervals.interval`
  is **nullable**; `session_result` carries `dnf/dns/dsq/duration/gap_to_leader`.
  Our existing parsers already matched these — no shape fixes were required.
- **Track math verdict — PASS.** Ran the real fastest-lap `/location` trace
  (driver 1, lap 44, 445 samples) through `trackMath`: closed loop, **length
  ≈ 7148 m vs Spa's real 7004 m (~2%)**, **no NaNs**, 16 curvature peaks
  (corners), endpoint gap ≈ one segment. OpenF1 `location` x/y are in ~1/10 m
  units (only relative geometry matters after `fitTransform`).
- **Jolpica path — PASS.** Mapped the real 2025 season (30 sessions), round 1
  (Norris/McLaren win, 921 lap rows → synthesized `date_start`+`lap_duration`),
  and confirmed `approxPosition` animates monotonically along the oval.
