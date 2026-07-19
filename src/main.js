// App entry: wiring + requestAnimationFrame loop.

import './style.css';
import * as THREE from 'three';
import { IsoRenderer, webglAvailable } from './scene/renderer.js';
import { CarManager } from './scene/cars.js';
import { SessionStore } from './data/sessionStore.js';
import { ReplayBuffer } from './data/replayBuffer.js';
import { PlaybackClock } from './engine/clock.js';
import { buildTrack } from './track/trackBuilder.js';
import { Hud } from './ui/hud.js';
import { SessionPicker, Transport, initSettings } from './ui/controls.js';
import { LiveBlockError } from './api/openf1.js';

const CAR_GLTF_URL = `${import.meta.env.BASE_URL}assets/car.glb`;

const dom = {
  loading: document.getElementById('loading'),
  loadingText: document.getElementById('loading-text'),
  banner: document.getElementById('banner'),
};

let renderer, carMgr, store, buffer, clock, hud, transport;
let running = false;
let liveRetryTimer = null;

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

  // If a CC0 car model is bundled at public/assets/car.glb, use it; otherwise
  // the procedural low-poly F1 is used. HEAD-probe first so there's no console
  // error in the (default) no-asset build.
  fetch(CAR_GLTF_URL, { method: 'HEAD' })
    .then((r) => { if (r.ok) return CarManager.tryLoadGLTF(CAR_GLTF_URL); })
    .catch(() => {});

  initSettings({ onChange: () => { /* key changed; live retry will pick it up */ } });

  const picker = new SessionPicker({
    onPick: (session) => loadSession(session),
    onError: (e) => {
      if (e instanceof LiveBlockError || (e && e.isLiveBlock)) {
        showBanner('Live data restricted (free tier) — session replay is available ~30 min after the flag. Retrying…', 'warn', 'Retry now', () => picker.open(true));
        scheduleLiveRetry(() => picker.open(true));
      }
    },
  });

  // Expose a way to reopen the picker.
  document.getElementById('session-title').addEventListener('click', () => picker.open(false));

  showLoading('Finding the latest race…');
  await picker.open(true);
  // If auto-select found a race, loadSession runs; otherwise picker stays open.
  hideLoading();

  startLoop();
}

async function loadSession(session) {
  hideBanner();
  clearLiveRetry();
  showLoading(`Loading ${session.session_name || 'session'}…`);

  // Tear down previous scene objects.
  if (carMgr) { renderer.remove(carMgr.group); carMgr = null; }
  if (window.__trackGroup) { renderer.remove(window.__trackGroup); window.__trackGroup = null; }

  try {
    store = new SessionStore(session);
    await store.load();

    showLoading('Building the circuit from telemetry…');
    const track = await buildTrack(store);
    renderer.add(track.group);
    window.__trackGroup = track.group;
    renderer.frameTrack(track.centerline);

    buffer = new ReplayBuffer(store);
    buffer.onLiveBlock = (e) => handleLiveBlock(session);

    carMgr = new CarManager(renderer, store, track.transform);

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
      onSelectDriver: (num) => selectDriver(num),
    });
    hud.onFlagChange = (kind) => renderer.setFlagTint(mapFlagTint(kind));

    // Default selection: pole/leader if available.
    const firstOrder = hud.orderAt(startMs);
    if (firstOrder.length) selectDriver(firstOrder[0].num);

    // Prime the buffer and start playing.
    buffer.update(startMs);
    clock.seek(startMs);
    clock.play();

    hideLoading();
  } catch (e) {
    hideLoading();
    if (e instanceof LiveBlockError || (e && e.isLiveBlock)) {
      handleLiveBlock(session);
    } else {
      console.error(e);
      showBanner(`Could not load this session (${e.message || 'error'}).`, 'error', 'Pick another', () => reopenPicker());
    }
  }
}

function selectDriver(num) {
  if (carMgr) carMgr.setSelected(num);
  if (hud) hud.setSelected(num);
}

function mapFlagTint(kind) {
  if (!kind) return null;
  if (kind === 'RED') return 'RED';
  if (kind === 'CHEQUERED') return null;
  return 'YELLOW';
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
  const picker = new SessionPicker({ onPick: loadSession, onError: () => {} });
  picker.open(false);
}

// --- main loop -------------------------------------------------------------

let lastFrame = 0;
function startLoop() {
  if (running) return;
  running = true;
  const loop = (now) => {
    requestAnimationFrame(loop);
    const dt = now - lastFrame;
    lastFrame = now;

    if (clock && buffer && carMgr) {
      const t = clock.tick(now);
      buffer.update(t);
      const samples = buffer.sampleAll(t);
      carMgr.update(samples, dt);

      // Follow selected driver.
      if (renderer.followEnabled) {
        const p = carMgr.selectedWorldPos();
        if (p) renderer.setFollow(p);
      }

      if (hud) hud.render(t);
      if (transport) transport.update();
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
  } else {
    const p = carMgr.selectedWorldPos();
    renderer.setFollow(p);
    btn && btn.classList.toggle('active', !!p);
  }
}

// Follow toggle via keyboard 'f' and the corner button.
window.addEventListener('keydown', (e) => {
  if (e.key === 'f' && e.target.tagName !== 'INPUT') toggleFollow();
});
document.getElementById('follow-btn').addEventListener('click', toggleFollow);

boot();
