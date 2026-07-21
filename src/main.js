// App entry: wiring + requestAnimationFrame loop.

import './style.css';
import * as THREE from 'three';
import { IsoRenderer, webglAvailable } from './scene/renderer.js';
import { CarManager } from './scene/cars.js';
import { SessionStore } from './data/sessionStore.js';
import { ReplayBuffer } from './data/replayBuffer.js';
import { ApproxBuffer } from './data/approxBuffer.js';
import { PlaybackClock } from './engine/clock.js';
import { BufferGate } from './engine/bufferGate.js';
import { buildTrack } from './track/trackBuilder.js';
import { Hud } from './ui/hud.js';
import { DriverPanel } from './ui/driverPanel.js';
import { WeatherWidget } from './ui/weatherWidget.js';
import { StandingsWidget } from './ui/standingsWidget.js';
import { RadioController } from './ui/radio.js';
import { FocusedTelemetry } from './data/telemetry.js';
import { SessionPicker, Transport, initSettings } from './ui/controls.js';
import { LiveBlockError } from './api/openf1.js';
import { ProviderManager } from './data/providers/manager.js';
import { OpenF1Provider } from './data/providers/openf1Provider.js';
import { JolpicaProvider } from './data/providers/jolpicaProvider.js';
import { focusTrackColors } from './data/timing.js';

// Multi-provider data source with automatic OpenF1 → Jolpica failover and a
// 60 s recovery poll. Every data call routes through this facade.
const providers = new ProviderManager({
  primary: new OpenF1Provider(),
  fallback: new JolpicaProvider(),
});

const CAR_GLTF_URL = `${import.meta.env.BASE_URL}assets/car.glb`;

const dom = {
  loading: document.getElementById('loading'),
  loadingText: document.getElementById('loading-text'),
  banner: document.getElementById('banner'),
};

let renderer, carMgr, store, buffer, clock, hud, transport, driverPanel, track;
let focusTelemetry, radio, weatherWidget, standingsWidget; // enriched-panel + right stack
let focused = false; // a driver is focused (camera follow + sector track tint)
let running = false;
let liveRetryTimer = null;
let currentSession = null; // for reload on provider recovery

function showLoading(msg) {
  dom.loadingText.textContent = msg || 'Loading…';
  dom.loading.classList.remove('hidden');
}
function hideLoading() {
  dom.loading.classList.add('hidden');
}

function showBanner(msg, kind = 'warn', actionLabel, action) {
  dom.banner.className = `banner banner-${kind}`;
  dom.banner.innerHTML = `<span>${msg}</span>`;
  if (actionLabel) {
    const b = document.createElement('button');
    b.textContent = actionLabel;
    b.className = 'banner-btn';
    b.addEventListener('click', action);
    dom.banner.appendChild(b);
  }
  dom.banner.classList.remove('hidden');
}
function hideBanner() {
  dom.banner.classList.add('hidden');
}

// Small "Buffering…" chip while the playback cursor sits in an unloaded window.
let bufferingShown = false;
function setBuffering(on) {
  if (on === bufferingShown) return;
  bufferingShown = on;
  let el = document.getElementById('buffering');
  if (!el) {
    el = document.createElement('div');
    el.id = 'buffering';
    el.className = 'buffering hidden';
    el.textContent = 'Buffering…';
    document.getElementById('app').appendChild(el);
  }
  el.classList.toggle('hidden', !on);
}

// Transient, self-dismissing notice (does not persist like showBanner). Used for
// the startup "Latest race" toast so the loaded session never feels random.
let toastTimer = null;
function showToast(msg, kind = 'ok', ms = 5000) {
  showBanner(msg, kind);
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { hideBanner(); toastTimer = null; }, ms);
}

// Human-readable session title for the top bar, e.g. "2026 Silverstone — Race".
// Composed from the session metadata so the HUD always shows exactly what loaded.
function sessionTitle(session) {
  if (!session) return 'F1 Session';
  const yr = session.year || (session.date_start ? new Date(session.date_start).getUTCFullYear() : '');
  const place = session.circuit_short_name || session.location || session.country_name || 'Session';
  const name = session.session_name || session.session_type || 'Session';
  return `${yr ? yr + ' ' : ''}${place} — ${name}`.trim();
}

function setSessionTitle(session) {
  const el = document.getElementById('session-name');
  const title = sessionTitle(session);
  if (el) el.textContent = title;
  document.title = `${title} · F1 Isometric Tracker`;
}

// Is the session currently inside its "live window" (30 min pre → 30 min post)?
function inLiveWindow(session) {
  const start = Date.parse(session.date_start);
  const end = Date.parse(session.date_end);
  if (isNaN(start) || isNaN(end)) return false;
  const now = Date.now();
  return now >= start - 30 * 60000 && now <= end + 30 * 60000;
}

async function boot() {
  if (!webglAvailable()) {
    hideLoading();
    showBanner('WebGL is not available in this browser, so the 3D view cannot render. Try a modern desktop browser.', 'error');
    return;
  }

  renderer = new IsoRenderer(document.getElementById('scene'));
  // A manual pan disengages follow (the focused panel stays); re-clicking a car
  // or pressing F re-engages it.
  renderer.onFollowBreak = () => {
    const btn = document.getElementById('follow-btn');
    btn && btn.classList.remove('active');
  };
  initClickToFocus();

  // If a CC0 car model is bundled at public/assets/car.glb, use it; otherwise
  // the procedural low-poly F1 is used. HEAD-probe first so there's no console
  // error in the (default) no-asset build.
  fetch(CAR_GLTF_URL, { method: 'HEAD' })
    .then((r) => { if (r.ok) return CarManager.tryLoadGLTF(CAR_GLTF_URL); })
    .catch(() => {});

  initSettings({ onChange: () => { /* key changed; live retry will pick it up */ } });

  // React to provider mode changes (OpenF1 ⇄ Jolpica). On recovery, offer to
  // reload with real telemetry.
  providers.onModeChange((info) => handleModeChange(info));

  const picker = new SessionPicker({
    source: providers,
    onPick: (session, meta) => loadSession(session, meta),
    onError: (e) => {
      if (e instanceof LiveBlockError || (e && e.isLiveBlock)) {
        showBanner('Live F1 session in progress — free OpenF1 access is paused until ~30 min after the session. Retrying automatically…', 'warn', 'Retry now', () => picker.open(false));
        scheduleLiveRetry(() => picker.open(false));
      }
    },
  });

  // Expose a way to reopen the picker.
  document.getElementById('session-title').addEventListener('click', () => picker.open(false));

  // Open the picker and let the user choose — nothing auto-loads on startup.
  await picker.open(false);

  startLoop();
}

// Generation guard: rapid session switches (double-pick, auto-reload on
// provider recovery, live-retry timers) must not let an in-flight older load
// clobber the newer one. Only the latest generation may commit scene state.
let loadGen = 0;

async function loadSession(session, meta = {}) {
  const gen = ++loadGen;
  hideBanner();
  clearLiveRetry();
  currentSession = session;
  // Always reflect the loaded session in the top bar so it never feels random.
  setSessionTitle(session);
  // A Jolpica-origin session (string 'jol-…' key) can only be served in
  // Approximate mode; make sure the manager is degraded before we load it.
  if (isJolpicaSession(session) && providers.mode !== 'approx') {
    providers.forceApprox('jolpica session');
  }
  showLoading(`Loading ${session.session_name || 'session'}…`);

  // Tear down previous scene objects, disposing GPU resources to avoid leaks.
  unfocus();
  if (carMgr) { carMgr.dispose(); carMgr = null; }
  if (track) { renderer.remove(track.group); track.dispose && track.dispose(); track = null; }
  // Dispose per-session enriched-panel + widget state (telemetry buffer, audio).
  if (focusTelemetry) { focusTelemetry.dispose(); focusTelemetry = null; }
  if (radio) { radio.dispose(); radio = null; }
  weatherWidget = null;
  standingsWidget = null;

  try {
    const newStore = new SessionStore(session, providers);
    await newStore.load();
    if (gen !== loadGen) return; // a newer load superseded this one
    store = newStore;

    const approx = !providers.telemetry;
    showLoading(approx ? 'Building an approximate circuit…' : 'Building the circuit from telemetry…');
    const newTrack = await buildTrack(store, providers);
    if (gen !== loadGen) {
      // Stale: never attach — dispose the GPU resources we just built.
      newTrack.dispose && newTrack.dispose();
      return;
    }
    track = newTrack;
    renderer.add(track.group);
    renderer.frameTrack(track.centerline);

    // Telemetry present → chunked location replay; otherwise → approximate
    // lap-time-driven animation along the (synthetic/derived) centerline.
    buffer = approx
      ? new ApproxBuffer(store, track.centerlineRaw)
      : new ReplayBuffer(store, providers);
    // Gen-guarded: a stale buffer's in-flight fetch must not resurrect banners
    // or retry timers for a session the user has already switched away from.
    buffer.onLiveBlock = () => { if (gen === loadGen) handleLiveBlock(session); };
    if (approx) showApproxBanner();

    carMgr = new CarManager(renderer, store, track.transform);
    // Orient stationary/grid cars along the track tangent (not their noisy
    // near-zero velocity heading).
    if (track.tangentAt) carMgr.setTangentProvider(track.tangentAt);

    const { start, end } = store.timeWindow();
    let startMs = Date.parse(start), endMs = Date.parse(end);
    if (isNaN(startMs)) startMs = Date.now() - 3600000;
    if (isNaN(endMs)) endMs = startMs + 3600000;
    clock = new PlaybackClock({ start: startMs, end: endMs });

    const canGoLive = inLiveWindow(session);
    transport = new Transport({
      clock, buffer, store,
      canGoLive,
      onLiveToggle: (on) => { if (on) enterLiveMode(session); },
    });

    hud = new Hud({
      store, buffer, clock,
      onSelectDriver: (num) => selectDriver(num, true),
    });
    hud.onStatusChange = (st) => renderer.setFlagTint(mapStatusTint(st.status));

    driverPanel = new DriverPanel({ store });
    driverPanel.onClose = () => unfocus();

    // Focused-driver telemetry buffer + team-radio controller (wired into the
    // panel). Both are session-scoped and disposed on the next loadSession.
    focusTelemetry = new FocusedTelemetry(store, providers);
    radio = new RadioController({ store });
    driverPanel.telemetry = focusTelemetry;
    driverPanel.radio = radio;

    // Right-hand stack: weather (replay-time-aware) + championship standings
    // (going into this race, from Jolpica). Shown whenever a session is loaded.
    weatherWidget = new WeatherWidget({ store, el: document.getElementById('weather-widget') });
    standingsWidget = new StandingsWidget({ el: document.getElementById('standings-widget') });
    weatherWidget.update(startMs);
    const rightStack = document.getElementById('right-stack');
    if (rightStack) rightStack.classList.remove('hidden');
    // Standings load from Jolpica (independent of OpenF1 mode); non-blocking.
    const stSeason = session.year || (session.date_start ? new Date(session.date_start).getUTCFullYear() : new Date().getUTCFullYear());
    standingsWidget.load(stSeason, Date.parse(session.date_start));

    // Default selection: leader/pole highlighted (no camera focus yet).
    const firstOrder = store.drivers.length ? [store.drivers[0].driver_number] : [];
    if (firstOrder.length) selectDriver(firstOrder[0], false);

    // Prime the buffer and start playing.
    buffer.update(startMs);
    clock.seek(startMs);
    clock.play();

    hideLoading();

    // Startup auto-load: a transient toast reassures the user which session was
    // chosen (the newest completed race) so it never feels random.
    if (meta.auto && !approx) {
      showToast(`Latest race — ${sessionTitle(session)}`, 'ok');
    }
  } catch (e) {
    if (gen !== loadGen) return; // superseded — its errors are irrelevant
    hideLoading();
    if (e instanceof LiveBlockError || (e && e.isLiveBlock)) {
      handleLiveBlock(session);
    } else {
      console.error(e);
      showBanner(`Could not load this session (${e.message || 'error'}).`, 'error', 'Pick another', () => reopenPicker());
    }
  }
}

// Select a driver's row (and optionally focus: camera follow + panel + track
// sector tint). Selecting from the tower focuses; the default startup selection
// only highlights.
function selectDriver(num, focus = true) {
  if (carMgr) carMgr.setSelected(num);
  if (hud) hud.setSelected(num);
  if (focus) focusDriver(num);
}

function focusDriver(num) {
  focused = true;
  if (driverPanel) driverPanel.show(num);
  // Start the focused-driver telemetry buffer for this one driver and prefetch
  // a window around the current cursor; start team radio. Focus is always a user
  // action (tower click / car click / 'f'), so autoplay is permitted (gesture).
  const t = clock ? clock.t : (store ? Date.parse(store.timeWindow().start) : Date.now());
  if (focusTelemetry) {
    focusTelemetry.start(num);
    focusTelemetry.update(t, clock ? clock.speed : 1);
  }
  if (radio) radio.focus(num, t, true);
  // Follow by INTENT, not by momentary availability: the renderer resolves this
  // function every frame, so follow engages as soon as the car has a sample
  // (and survives brief gaps — buffering, pits) instead of silently never
  // engaging when the car happened to be hidden at click time.
  if (renderer) renderer.setFollow(() => (carMgr ? carMgr.selectedWorldPos() : null));
  const btn = document.getElementById('follow-btn');
  btn && btn.classList.toggle('active', true);
}

function unfocus() {
  focused = false;
  if (driverPanel) driverPanel.hide();
  if (focusTelemetry) focusTelemetry.stop();
  if (radio) radio.stop();
  if (renderer) renderer.setFollow(null);
  if (track && track.sectors) track.sectors.reset();
  const btn = document.getElementById('follow-btn');
  btn && btn.classList.remove('active');
}

function mapStatusTint(status) {
  if (status === 'RED') return 'RED';
  if (status === 'YELLOW' || status === 'DOUBLE_YELLOW' || status === 'SC' || status === 'VSC') {
    return 'YELLOW';
  }
  return null; // GREEN / CHEQUERED
}

// Click-to-focus: a click (not a drag) on a car/label selects+focuses it; a
// click on empty ground unfocuses.
function initClickToFocus() {
  const canvas = document.getElementById('scene');
  let downX = 0, downY = 0, downT = 0;
  canvas.addEventListener('pointerdown', (e) => {
    downX = e.clientX; downY = e.clientY; downT = Date.now();
  });
  canvas.addEventListener('pointerup', (e) => {
    const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
    if (moved > 6 || Date.now() - downT > 450) return; // was a drag
    if (!carMgr || !renderer) return;
    const rect = canvas.getBoundingClientRect();
    const ndc = {
      x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
      y: -((e.clientY - rect.top) / rect.height) * 2 + 1,
    };
    const num = carMgr.pick(ndc, renderer.camera);
    if (num != null) selectDriver(num, true);
    else unfocus();
  });
}

function isJolpicaSession(session) {
  return !!(session && (session._jolpica || String(session.session_key).startsWith('jol-')));
}

// Persistent "Approximate mode" banner shown whenever the active provider has no
// telemetry (Jolpica fallback). Cars are estimated from lap times, not live x/y.
function showApproxBanner() {
  showBanner(
    'Approximate mode — live telemetry unavailable. Order, laps and timing are from Jolpica (Ergast); cars are estimated from lap times along a schematic circuit. Checking for OpenF1 every 60 s…',
    'info'
  );
}

// Fired by ProviderManager when the mode flips.
function handleModeChange(info) {
  if (info.mode === 'approx') {
    showApproxBanner();
  } else {
    // OpenF1 recovered. If the current session is OpenF1-native (numeric key),
    // reload it with full telemetry automatically; otherwise offer the picker.
    if (currentSession && !isJolpicaSession(currentSession)) {
      showBanner('Live telemetry available again — reloading with full 3D…', 'ok');
      loadSession(currentSession);
    } else {
      showBanner('OpenF1 telemetry available again. Reopen the session picker to load full 3D telemetry.', 'ok', 'Pick session', () => reopenPicker());
    }
  }
}

function handleLiveBlock(session) {
  showBanner(
    'Live data restricted (free tier) — session replay available ~30 min after the flag. Add a paid OpenF1 key in Settings for live mode.',
    'warn', 'Retry now', () => loadSession(session)
  );
  scheduleLiveRetry(() => loadSession(session));
}

function scheduleLiveRetry(fn) {
  clearLiveRetry();
  liveRetryTimer = setTimeout(fn, 60000);
}
function clearLiveRetry() {
  if (liveRetryTimer) { clearTimeout(liveRetryTimer); liveRetryTimer = null; }
}

function enterLiveMode(session) {
  clock.setLive(true);
  // Buffer will poll newest windows via update(now-3s) in the loop.
}

function reopenPicker() {
  const picker = new SessionPicker({ source: providers, onPick: loadSession, onError: () => {} });
  picker.open(false);
}

// --- main loop -------------------------------------------------------------

let lastFrame = 0;
const bufferGate = new BufferGate(); // hold/release "Buffering…" state machine
function startLoop() {
  if (running) return;
  running = true;
  const loop = (now) => {
    requestAnimationFrame(loop);
    const dt = now - lastFrame;
    lastFrame = now;

    if (clock && buffer && carMgr) {
      // Buffering gate: while the cursor window isn't loaded yet (e.g. a seek far
      // outside the fetched windows, or prefetch starvation at high speed), HOLD
      // the clock so playback doesn't run blindly through unfetched data, and show
      // a small indicator. The buffer keeps fetching/retrying via update() below,
      // so this can't get stuck — the gate releases the moment data arrives.
      const buffered = !buffer.isCursorBuffered || buffer.isCursorBuffered(clock.t);
      const gate = bufferGate.update({ buffered, playing: clock.playing, live: clock.live });
      if (gate.hold) clock.hold(now);
      setBuffering(gate.chip);

      const t = clock.tick(now);
      // Pass the playback speed so the prefetcher scales its window size / interval
      // stride to stay inside the OpenF1 30 req/min budget (data/windowPlan.js) —
      // otherwise fixed 90 s windows starve at 30× and cars vanish.
      buffer.update(t, clock.speed);
      const samples = buffer.sampleAll(t);
      carMgr.update(samples, dt, t);

      // If the followed car retires (recovered off track), gracefully release
      // the camera with a toast instead of following an empty patch of track.
      if (focused && carMgr.selected != null && store && store.retiredAt(carMgr.selected, t)) {
        const acr = store.acronym(carMgr.selected);
        unfocus();
        showToast(`${acr} retired — camera released`, 'warn');
      }

      // (Camera follow is resolved inside renderer.update() every frame.)

      // Focused-driver telemetry prefetch (only while a driver is focused): keep
      // a window around the cursor loaded, scaled by playback speed, evicting
      // behind. Stopped/disposed on unfocus + session switch (no leak).
      if (focused && carMgr.selected != null && focusTelemetry) {
        focusTelemetry.update(t, clock.speed);
      }

      if (hud) hud.render(t);
      if (driverPanel) driverPanel.update(t);
      if (weatherWidget) weatherWidget.update(t);
      if (transport) transport.update();

      // Sector-based track coloring for the focused driver (smooth lerp).
      if (track && track.sectors) {
        if (focused && carMgr.selected != null) {
          const status = store.trackStatusAt(t).status;
          const colors = focusTrackColors(store.laps, carMgr.selected, t, status);
          track.sectors.setColors(colors);
        }
        track.sectors.tick(0.08);
      }
    }

    renderer.update();
    renderer.render();
  };
  requestAnimationFrame(loop);
}

function toggleFollow() {
  if (!renderer || !carMgr) return;
  const btn = document.getElementById('follow-btn');
  if (renderer.followEnabled) {
    renderer.setFollow(null);
    btn && btn.classList.remove('active');
  } else if (carMgr.selected != null) {
    // Engage by intent — works even while the selected car is briefly hidden.
    renderer.setFollow(() => (carMgr ? carMgr.selectedWorldPos() : null));
    btn && btn.classList.add('active');
  }
}

// Follow toggle via keyboard 'f' and the corner button; Esc unfocuses.
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === 'f') toggleFollow();
  else if (e.key === 'Escape') unfocus();
});
document.getElementById('follow-btn').addEventListener('click', toggleFollow);

boot();
