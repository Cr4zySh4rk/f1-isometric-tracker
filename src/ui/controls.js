// UI controls: session picker, transport bar, settings.

import { OpenF1, getApiKey, setApiKey } from '../api/openf1.js';
import { SPEEDS } from '../engine/clock.js';

// -----------------------------------------------------------------------------
// Session picker: year → meeting → session. Defaults to the most recent
// completed race.
// -----------------------------------------------------------------------------

export class SessionPicker {
  constructor({ onPick, onError }) {
    this.el = document.getElementById('picker');
    this.onPick = onPick;
    this.onError = onError;
    this.year = new Date().getFullYear();
    this.meetings = [];
    this.selectedMeeting = null;
    this.sessions = [];
  }

  async open(auto = false) {
    this.el.classList.add('open');
    this.el.innerHTML = this._shell();
    this._wire();
    await this._loadYear(this.year, auto);
  }

  close() {
    this.el.classList.remove('open');
    this.el.innerHTML = '';
  }

  _shell() {
    const years = [];
    for (let y = new Date().getFullYear(); y >= 2023; y--) years.push(y);
    return `
      <div class="picker-card">
        <div class="picker-head">
          <div class="picker-title"><span class="brand">F1</span> Session Picker</div>
          <button class="picker-close" id="pk-close" title="Close">×</button>
        </div>
        <div class="picker-row">
          <label>Season</label>
          <select id="pk-year">${years.map((y) => `<option value="${y}" ${y === this.year ? 'selected' : ''}>${y}</option>`).join('')}</select>
        </div>
        <div class="picker-cols">
          <div class="picker-col">
            <div class="picker-col-title">Race weekend</div>
            <div id="pk-meetings" class="picker-list"><div class="pk-loading">Loading…</div></div>
          </div>
          <div class="picker-col">
            <div class="picker-col-title">Session</div>
            <div id="pk-sessions" class="picker-list"><div class="pk-hint">Select a weekend</div></div>
          </div>
        </div>
        <div class="picker-status" id="pk-status"></div>
      </div>`;
  }

  _wire() {
    this.el.querySelector('#pk-close').addEventListener('click', () => this.close());
    this.el.querySelector('#pk-year').addEventListener('change', (e) => {
      this.year = parseInt(e.target.value, 10);
      this._loadYear(this.year, false);
    });
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.close();
    });
  }

  _status(msg, kind = '') {
    const s = this.el.querySelector('#pk-status');
    if (s) { s.textContent = msg || ''; s.className = `picker-status ${kind}`; }
  }

  async _loadYear(year, auto) {
    const list = this.el.querySelector('#pk-meetings');
    list.innerHTML = '<div class="pk-loading">Loading race weekends…</div>';
    this._status('');
    try {
      const meetings = await OpenF1.meetings(year);
      this.meetings = (Array.isArray(meetings) ? meetings : []).sort(
        (a, b) => Date.parse(b.date_start) - Date.parse(a.date_start)
      );
      this._renderMeetings();
      if (auto && this.meetings.length) {
        await this._autoSelectLatestRace();
      }
    } catch (e) {
      if (e && e.isLiveBlock) {
        list.innerHTML = '<div class="pk-hint">Live session in progress.</div>';
        this._status('Live data restricted (free tier). Try again after the session ends.', 'warn');
        this.onError && this.onError(e);
      } else {
        list.innerHTML = '<div class="pk-hint">Failed to load. Retry.</div>';
        this._status('Could not reach OpenF1. Check your connection.', 'warn');
      }
    }
  }

  _renderMeetings() {
    const list = this.el.querySelector('#pk-meetings');
    if (!this.meetings.length) { list.innerHTML = '<div class="pk-hint">No weekends.</div>'; return; }
    list.innerHTML = this.meetings.map((m) => `
      <button class="pk-item" data-key="${m.meeting_key}">
        <span class="pk-item-name">${escapeHtml(m.meeting_name || m.circuit_short_name || 'Meeting')}</span>
        <span class="pk-item-sub">${escapeHtml(m.country_name || '')} · ${fmtDate(m.date_start)}</span>
      </button>`).join('');
    list.querySelectorAll('.pk-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        list.querySelectorAll('.pk-item').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this._loadSessions(parseInt(btn.dataset.key, 10));
      });
    });
  }

  async _loadSessions(meetingKey) {
    const col = this.el.querySelector('#pk-sessions');
    col.innerHTML = '<div class="pk-loading">Loading…</div>';
    try {
      const sessions = await OpenF1.sessions({ meeting_key: meetingKey });
      this.sessions = (Array.isArray(sessions) ? sessions : []).sort(
        (a, b) => Date.parse(a.date_start) - Date.parse(b.date_start)
      );
      this._renderSessions();
    } catch (e) {
      if (e && e.isLiveBlock) { col.innerHTML = '<div class="pk-hint">Live restricted.</div>'; this.onError && this.onError(e); }
      else col.innerHTML = '<div class="pk-hint">Failed to load sessions.</div>';
    }
  }

  _renderSessions() {
    const col = this.el.querySelector('#pk-sessions');
    if (!this.sessions.length) { col.innerHTML = '<div class="pk-hint">No sessions.</div>'; return; }
    const now = Date.now();
    col.innerHTML = this.sessions.map((s) => {
      const ended = s.date_end && Date.parse(s.date_end) < now;
      return `<button class="pk-item" data-key="${s.session_key}">
        <span class="pk-item-name">${escapeHtml(s.session_name || s.session_type || 'Session')}</span>
        <span class="pk-item-sub">${fmtDate(s.date_start)} ${ended ? '' : '· upcoming/live'}</span>
      </button>`;
    }).join('');
    col.querySelectorAll('.pk-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        const s = this.sessions.find((x) => x.session_key === parseInt(btn.dataset.key, 10));
        if (s) { this.close(); this.onPick(s); }
      });
    });
  }

  // Choose the most recent completed race across recent weekends.
  async _autoSelectLatestRace() {
    const now = Date.now();
    for (const m of this.meetings) {
      if (Date.parse(m.date_start) > now) continue; // future weekend
      let sessions;
      try {
        sessions = await OpenF1.sessions({ meeting_key: m.meeting_key });
      } catch (e) {
        if (e && e.isLiveBlock) { this.onError && this.onError(e); return; }
        continue;
      }
      const races = (Array.isArray(sessions) ? sessions : [])
        .filter((s) => /race/i.test(s.session_name || s.session_type || ''))
        .filter((s) => s.date_end && Date.parse(s.date_end) < now)
        .sort((a, b) => Date.parse(b.date_start) - Date.parse(a.date_start));
      if (races.length) {
        this.close();
        this.onPick(races[0]);
        return;
      }
    }
    // No completed race found — leave picker open for manual choice.
    this._status('Pick a weekend and session to begin.');
  }
}

// -----------------------------------------------------------------------------
// Transport bar
// -----------------------------------------------------------------------------

export class Transport {
  constructor({ clock, buffer, store, onLiveToggle, canGoLive }) {
    this.clock = clock;
    this.buffer = buffer;
    this.store = store;
    this.onLiveToggle = onLiveToggle;
    this.canGoLive = canGoLive;
    this.el = document.getElementById('transport');
    this.el.classList.remove('hidden');
    this._scrubbing = false;
    this._build();
    this._wire();
    clock.on(() => this._sync());
    this._sync();
  }

  _build() {
    const speedOpts = SPEEDS.map((s) => `<option value="${s}" ${s === 1 ? 'selected' : ''}>${s}×</option>`).join('');
    this.el.innerHTML = `
      <button class="tp-btn tp-play" id="tp-play" title="Play/Pause">▶</button>
      <div class="tp-time" id="tp-time">0:00</div>
      <div class="tp-seek">
        <div class="tp-buffered" id="tp-buffered"></div>
        <input type="range" min="0" max="1000" value="0" id="tp-slider" />
      </div>
      <div class="tp-time tp-dur" id="tp-dur">0:00</div>
      <select class="tp-speed" id="tp-speed" title="Playback speed">${speedOpts}</select>
      ${this.canGoLive ? '<button class="tp-btn tp-live" id="tp-live" title="Live mode">LIVE</button>' : ''}
    `;
  }

  _wire() {
    this.playBtn = this.el.querySelector('#tp-play');
    this.slider = this.el.querySelector('#tp-slider');
    this.timeEl = this.el.querySelector('#tp-time');
    this.durEl = this.el.querySelector('#tp-dur');
    this.bufferedEl = this.el.querySelector('#tp-buffered');
    this.speedEl = this.el.querySelector('#tp-speed');
    this.liveBtn = this.el.querySelector('#tp-live');

    this.playBtn.addEventListener('click', () => this.clock.toggle());
    this.speedEl.addEventListener('change', (e) => this.clock.setSpeed(parseFloat(e.target.value)));
    this.slider.addEventListener('pointerdown', () => { this._scrubbing = true; });
    this.slider.addEventListener('input', (e) => {
      this.clock.seekFraction(parseInt(e.target.value, 10) / 1000);
    });
    const stop = () => { this._scrubbing = false; };
    this.slider.addEventListener('pointerup', stop);
    this.slider.addEventListener('change', stop);

    if (this.liveBtn) {
      this.liveBtn.addEventListener('click', () => {
        const on = !this.clock.live;
        this.clock.setLive(on);
        this.liveBtn.classList.toggle('active', on);
        this.onLiveToggle && this.onLiveToggle(on);
      });
    }

    // keyboard: space = play/pause, arrows = seek
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.code === 'Space') { e.preventDefault(); this.clock.toggle(); }
      else if (e.code === 'ArrowRight') this.clock.seek(this.clock.t + 5000);
      else if (e.code === 'ArrowLeft') this.clock.seek(this.clock.t - 5000);
    });
  }

  _sync() {
    this.playBtn.textContent = this.clock.playing ? '❚❚' : '▶';
    this.durEl.textContent = fmtClock(this.clock.end - this.clock.start);
  }

  // Called each frame from main loop.
  update() {
    if (!this._scrubbing) {
      const f = this.clock.fraction();
      this.slider.value = Math.round(f * 1000);
    }
    this.timeEl.textContent = fmtClock(this.clock.t - this.clock.start);
    // buffered regions
    if (this.buffer) {
      const ranges = this.buffer.loadedFractions();
      this.bufferedEl.innerHTML = ranges
        .map(([a, b]) => `<span style="left:${a * 100}%;width:${(b - a) * 100}%"></span>`)
        .join('');
    }
  }
}

// -----------------------------------------------------------------------------
// Settings modal (API key)
// -----------------------------------------------------------------------------

export function initSettings({ onChange }) {
  const btn = document.getElementById('settings-btn');
  btn.addEventListener('click', () => openSettings(onChange));
}

function openSettings(onChange) {
  const overlay = document.createElement('div');
  overlay.className = 'settings-overlay open';
  overlay.innerHTML = `
    <div class="settings-card">
      <div class="picker-head">
        <div class="picker-title">Settings</div>
        <button class="picker-close" id="set-close">×</button>
      </div>
      <label class="set-label">OpenF1 API key (optional — enables live mode)</label>
      <input class="set-input" id="set-key" type="password" placeholder="paste key…" value="${escapeHtml(getApiKey())}" />
      <p class="set-note">Stored only in your browser (localStorage). Sent as a Bearer token to OpenF1. Without a key, live sessions are restricted and past data is available ~30 min after the flag.</p>
      <div class="set-actions">
        <button class="set-save" id="set-save">Save</button>
      </div>
      <p class="set-credit">Data © <a href="https://openf1.org" target="_blank" rel="noopener">OpenF1</a>. Unofficial — not affiliated with Formula 1.</p>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('#set-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#set-save').addEventListener('click', () => {
    setApiKey(overlay.querySelector('#set-key').value.trim());
    onChange && onChange();
    close();
  });
}

// -----------------------------------------------------------------------------

function fmtClock(ms) {
  if (!isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    : `${m}:${String(ss).padStart(2, '0')}`;
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
