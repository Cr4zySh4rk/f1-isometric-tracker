// Team-radio controller for the focused-driver panel.
//
// Plays a driver's most-recent clip whose date ≤ replay time T via a PLAIN
// <audio> element (the OpenF1 recording_url mp3 plays without CORS / WebAudio).
// Everything is replay-time-aware (only clips ≤ T are ever surfaced/played) and
// keyed off the focused driver, so it stops/replaces on unfocus, focus change
// and session switch.
//
// Autoplay policy: focus by a user click is a gesture, so by default we autoplay
// the latest clip ≤ T — UNLESS muted (persisted in localStorage, default
// UNMUTED). If audio.play() rejects (autoplay blocked — e.g. focus wasn't a
// gesture), we fall back to a "tap to play" state with no error.
//
// The pure clip-selection logic (normalise / latest-≤-T / list-≤-T) lives in
// data/radio.js and is unit-tested; this module is the thin DOM/audio shell.

import { normalizeClips, clipsForList, clipToAutoplay } from '../data/radio.js';

const LS_MUTE = 'f1iso.radio.muted';

function readMute() {
  try { return localStorage.getItem(LS_MUTE) === '1'; } catch { return false; }
}
function writeMute(v) {
  try { localStorage.setItem(LS_MUTE, v ? '1' : '0'); } catch { /* ignore */ }
}

// Session-relative clip time as M:SS.
function clockLabel(ms) {
  if (!Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export class RadioController {
  constructor({ store }) {
    this.store = store;
    this.el = null;      // mount element (#dp-radio), owned entirely by us
    this.num = null;     // focused driver
    this.clips = [];     // normalised clips (asc) for the focused driver
    this.startMs = Date.parse(store.timeWindow().start) || 0;
    this._lastT = this.startMs;

    this.muted = readMute();
    this.playingUrl = null;
    this.status = 'idle'; // 'idle' | 'loading' | 'playing' | 'error'
    this.needsGesture = false; // autoplay blocked → offer a tap-to-play

    // A real, DOM-attached <audio> element. Some browsers are flaky playing an
    // off-DOM Audio() object created via `new Audio()`; a hidden element in the
    // document plays reliably. It stays alive across clip-list re-renders because
    // it lives here (not inside the mount we rebuild).
    this.audio = document.createElement('audio');
    this.audio.preload = 'metadata';
    this.audio.hidden = true;
    // Do NOT set crossOrigin: the F1 mp3 host has no CORS headers, so a plain
    // media load works but a CORS/anonymous request would be blocked.
    try { document.body.appendChild(this.audio); } catch { /* non-DOM env (tests) */ }
    this.audio.addEventListener('playing', () => { this.status = 'playing'; this.render(this._lastT); });
    this.audio.addEventListener('ended', () => {
      this.status = 'idle'; this.playingUrl = null; this.render(this._lastT);
    });
    this.audio.addEventListener('error', () => {
      this.status = 'error'; this.playingUrl = null; this.render(this._lastT);
    });
  }

  // Bind the panel's radio mount; wire one delegated click handler.
  attach(el) {
    this.el = el;
    if (!el || el._radioBound) return;
    el._radioBound = true;
    el.addEventListener('click', (e) => {
      const t = e.target.closest('[data-radio]');
      if (!t) return;
      const action = t.getAttribute('data-radio');
      if (action === 'mute') this.toggleMute();
      else if (action === 'latest') this.playLatest();
      else if (action === 'clip') this._play(t.getAttribute('data-url'));
    });
  }

  // Focus a driver. `userGesture` true ⇒ autoplay is permitted (default clip).
  focus(num, tMs, userGesture) {
    this._stopAudio();
    this.num = num;
    this.clips = normalizeClips(this.store.teamRadio, num);
    this.needsGesture = false;
    this._lastT = tMs;
    if (userGesture && !this.muted) {
      const pick = clipToAutoplay(this.clips, tMs);
      if (pick) { this._play(pick.url, tMs); return; }
    }
    this.render(tMs);
  }

  // Per-frame refresh (new clips can cross the T threshold as replay advances).
  update(tMs) {
    if (this.num == null) return;
    this._lastT = tMs;
    this.render(tMs);
  }

  // Stop + release (unfocus / focus change / session switch).
  stop() {
    this._stopAudio();
    this.num = null;
    this.clips = [];
    this.needsGesture = false;
    if (this.el) this.el.innerHTML = '';
  }
  dispose() {
    this.stop();
    try { this.audio.src = ''; this.audio.remove(); } catch { /* ignore */ }
  }

  toggleMute() {
    this.muted = !this.muted;
    writeMute(this.muted);
    this.audio.muted = this.muted;
    if (this.muted) this._stopAudio(); // muted ⇒ never keep playing
    this.render(this._lastT);
  }

  playLatest() {
    const pick = clipToAutoplay(this.clips, this._lastT);
    if (pick) this._play(pick.url);
  }

  _play(url, tMs = this._lastT) {
    if (!url) return;
    this.needsGesture = false;
    this.playingUrl = url;
    this.status = 'loading';
    // A manual play is always unmuted (the mute toggle only governs AUTOplay);
    // if the user clicked a clip they clearly want to hear it.
    this.audio.muted = false;
    if (this.audio.src !== url) { this.audio.src = url; this.audio.load(); }
    else { this.audio.currentTime = 0; }
    const p = this.audio.play();
    if (p && p.catch) {
      p.catch(() => {
        // Autoplay blocked (no gesture) — offer tap-to-play, no error surfaced.
        this.needsGesture = true;
        this.status = 'idle';
        this.playingUrl = null;
        this.render(this._lastT);
      });
    }
    this.render(tMs);
  }

  _stopAudio() {
    try { this.audio.pause(); } catch { /* ignore */ }
    this.playingUrl = null;
    this.status = 'idle';
  }

  render(tMs = this._lastT) {
    if (!this.el) return;
    // Hidden entirely in Approximate mode (no radio feed).
    if (!this.store.hasTelemetry() || this.num == null) { this.el.innerHTML = ''; return; }

    const list = clipsForList(this.clips, tMs); // whole session, most-recent first
    const muteLabel = this.muted ? '🔇 Muted' : '🔊 Sound';
    const rows = list.length
      ? list.map((c) => {
          const playing = c.url === this.playingUrl;
          const loading = playing && this.status === 'loading';
          const icon = loading ? '⏳' : (playing ? '▶' : '▷');
          return `<button class="dp-clip${playing ? ' playing' : ''}${c.upcoming ? ' upcoming' : ''}" data-radio="clip" data-url="${c.url}" title="${c.upcoming ? 'Upcoming radio clip' : 'Play radio clip'}">
            <span class="dp-clip-dot">${icon}</span>
            <span class="dp-clip-t">${clockLabel(c.t - this.startMs)}</span>
            ${c.upcoming ? '<span class="dp-clip-up">↑</span>' : ''}
          </button>`;
        }).join('')
      : '<div class="dp-clip-empty">No team radio for this driver.</div>';

    const gestureHint = this.needsGesture
      ? '<div class="dp-radio-tap" data-radio="latest">Tap to play radio</div>'
      : '';
    const errHint = this.status === 'error'
      ? '<div class="dp-radio-err">Couldn’t play that clip.</div>'
      : '';

    this.el.innerHTML = `
      <div class="dp-radio-head">
        <span class="dp-radio-title">TEAM RADIO</span>
        <div class="dp-radio-ctl">
          <button class="dp-radio-btn" data-radio="mute" title="Mute/unmute auto-play (persisted)">${muteLabel}</button>
          <button class="dp-radio-btn" data-radio="latest" title="Play the most recent clip">▷ Play</button>
        </div>
      </div>
      ${gestureHint}${errHint}
      <div class="dp-clips">${rows}</div>`;
  }
}
