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
  engine/clock.js      playback clock: play/pause, 0.5–30× speed, seek, live mode
  engine/interp.js     per-driver position interpolation (Catmull-Rom over samples)
  track/trackBuilder.js derive centerline from a clean flying lap → smooth →
                        ribbon mesh (track), kerbs, start/finish line, walls
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
