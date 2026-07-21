// Timing tower (F1 TV style): header (session label + clock), track-status
// strip, and per-driver rows with position-change arrows, team-color bars,
// delta column, pit / penalty / fastest-lap badges. Everything is replay-time
// aware — state is computed as of session time T.
//
// All timing decisions live in ../data/timing.js and ../data/raceControl.js
// (pure, unit-tested); this module only renders the model to the DOM.

import { buildTowerRows, lapAtTime } from '../data/timing.js';
import { fmtSessionClock } from '../util/format.js';

export function sessionLabel(session) {
  const name = (session.session_name || session.session_type || '').toLowerCase();
  if (/sprint\s*(shootout|qual)/.test(name)) return 'SQ';
  if (name.includes('sprint')) return 'SPRINT';
  if (name.includes('race')) return 'RACE';
  if (name.includes('qualifying') || name === 'q') return 'Q';
  const m = name.match(/practice\s*(\d)/) || name.match(/fp\s*(\d)/);
  if (m) return `P${m[1]}`;
  return (session.session_name || 'SESSION').toUpperCase().slice(0, 8);
}

export class Hud {
  constructor({ store, buffer, clock, onSelectDriver }) {
    this.store = store;
    this.buffer = buffer;
    this.clock = clock;
    this.onSelectDriver = onSelectDriver;

    this.elTower = document.getElementById('leaderboard');
    this.elLap = document.getElementById('lap-counter');
    this.elFlag = document.getElementById('flag-banner'); // legacy top banner (kept hidden)

    this.selected = null;
    this.intervalMode = 'interval'; // race delta column: 'interval' | 'gap'
    this._lastStatus = undefined;
    this._lastRenderMs = 0;

    this._buildShell();
    this.elTower.classList.remove('hidden');
    this.elLap.classList.remove('hidden');
  }

  _buildShell() {
    this.elTower.classList.add('tower');
    this.elTower.innerHTML = `
      <div class="tw-header">
        <span class="tw-mark">F1</span>
        <span class="tw-session" id="tw-session">${sessionLabel(this.store.session)}</span>
        <span class="tw-hlap" id="tw-hlap"></span>
        <span class="tw-clock" id="tw-clock">--:--</span>
      </div>
      <div class="tw-status tw-status-green" id="tw-status">TRACK CLEAR</div>
      <div class="tw-rows" id="tw-rows"></div>`;
    this.elRows = this.elTower.querySelector('#tw-rows');
    this.elClock = this.elTower.querySelector('#tw-clock');
    this.elHeadLap = this.elTower.querySelector('#tw-hlap');
    this.elStatus = this.elTower.querySelector('#tw-status');

    // Event delegation: row press selects driver; status/delta header toggles.
    // Selection listens on POINTERDOWN, not 'click': rows are rebuilt every
    // ~120 ms of session time (every frame at high replay speeds), so a click
    // whose pointerdown/up straddle a rebuild retargets to the container and
    // `closest('.tw-row')` misses — making tower clicks silently unreliable.
    // pointerdown always targets the live row the user actually pressed.
    this.elRows.addEventListener('pointerdown', (e) => {
      const row = e.target.closest('.tw-row');
      if (row && row.dataset.num != null) {
        this.onSelectDriver && this.onSelectDriver(parseInt(row.dataset.num, 10));
      }
    });
    this.elTower.querySelector('.tw-header').addEventListener('click', () => {
      // Toggle race delta column between interval and gap-to-leader.
      if (this.store.isRace()) {
        this.intervalMode = this.intervalMode === 'interval' ? 'gap' : 'interval';
      }
    });
  }

  setSelected(num) { this.selected = num; }

  render(tMs) {
    if (tMs - this._lastRenderMs < 120 && this._lastRenderMs) return;
    this._lastRenderMs = tMs;
    this._renderClock(tMs);
    this._renderLap(tMs);
    this._renderStatus(tMs);
    this._renderRows(tMs);
  }

  // Tower header: races show the LEADER's current lap ("LAP n / total"); in
  // live mode the total is not yet knowable, so just "LAP n". Practice/quali
  // show the session time remaining instead. Replay-time-aware (recomputed at
  // T as the cursor moves/seeks).
  _renderClock(tMs) {
    if (this.store.isRace()) {
      const { lap, total, phase } = lapAtTime(this.store.laps, tMs);
      if (phase === 'pre') {
        // Before racing lap 1 starts, the field is on the formation lap /
        // grid — not "LAP 1". Call it out clearly.
        this.elHeadLap.innerHTML = `<span class="tw-formation">FORMATION LAP</span>`;
      } else if (total > 0) {
        const showTotal = total > 0 && !this.clock.live;
        this.elHeadLap.innerHTML = showTotal
          ? `LAP <b>${lap}</b><span class="tw-lap-total">/${total}</span>`
          : `LAP <b>${lap}</b>`;
      } else {
        this.elHeadLap.textContent = '';
      }
      this.elClock.classList.add('tw-clock-race');
    } else {
      this.elHeadLap.textContent = '';
    }
    const remaining = Math.max(0, this.clock.end - tMs);
    this.elClock.textContent = fmtSessionClock(remaining);
  }

  _renderLap(tMs) {
    const { lap, total, phase } = lapAtTime(this.store.laps, tMs);
    if (phase === 'pre') {
      this.elLap.innerHTML = `<span class="lap-word lap-formation">FORMATION LAP</span>`;
      this.elLap.classList.remove('hidden');
    } else if (total > 0) {
      this.elLap.innerHTML = `<span class="lap-word">LAP</span> <b>${lap}</b><span class="lap-total">/${total}</span>`;
      this.elLap.classList.remove('hidden');
    } else {
      this.elLap.classList.add('hidden');
    }
  }

  _renderStatus(tMs) {
    const st = this.store.trackStatusAt(tMs);
    if (st.status !== this._lastStatus) {
      this._lastStatus = st.status;
      this.elStatus.textContent = st.label;
      this.elStatus.className = `tw-status tw-status-${st.status.toLowerCase().replace(/_/g, '-')}`
        + (st.pulse ? ' tw-pulse' : '');
      if (this.onStatusChange) this.onStatusChange(st);
    }
  }

  _renderRows(tMs) {
    const driverNums = this.store.drivers.map((d) => d.driver_number);
    const isRace = this.store.isRace();
    const fastest = this.store.fastestLapAt(tMs);
    const rows = buildTowerRows({
      isRace, driverNums, laps: this.store.laps, positions: this.store.positions, tMs,
      intervalFn: (num) => {
        const iv = this.buffer && this.buffer.intervalAt(num, tMs);
        return iv ? { gap_to_leader: iv.gap, interval: iv.interval } : null;
      },
      intervalMode: this.intervalMode,
      startPositions: this.store._startPositions || new Map(),
      penalties: this.store.penaltiesAt(tMs),
      pitFn: (num) => this.store.isInPitAt(num, tMs),
      fastestNum: fastest ? fastest.driver_number : null,
    });

    const frag = document.createDocumentFragment();
    for (const r of rows) {
      const acronym = this.store.acronym(r.num);
      const color = this.store.teamColour(r.num);
      const el = document.createElement('div');
      el.className = 'tw-row'
        + (r.num === this.selected ? ' tw-selected' : '')
        + (r.isFastest ? ' tw-fl' : '')
        + (r.inPit ? ' tw-inpit' : '');
      el.dataset.num = r.num;

      const badges = [];
      if (r.isFastest) badges.push('<span class="tw-badge tw-badge-fl" title="Fastest lap">FL</span>');
      if (r.inPit) badges.push('<span class="tw-badge tw-badge-pit" title="In pit">P</span>');
      if (r.penalty) {
        badges.push(`<span class="tw-badge tw-badge-pen" title="${escapeHtml(r.penalty.message)}">${escapeHtml(r.penalty.type)}</span>`);
      }

      el.innerHTML =
        `<span class="tw-pos">${r.position}</span>` +
        `<span class="tw-arrow tw-arrow-${r.arrow}">${r.arrowGlyph}</span>` +
        `<span class="tw-bar" style="background:${color}"></span>` +
        `<span class="tw-acr">${escapeHtml(acronym)}</span>` +
        `<span class="tw-badges">${badges.join('')}</span>` +
        `<span class="tw-delta tw-delta-${r.deltaKind}">${escapeHtml(r.delta)}</span>`;
      frag.appendChild(el);
    }
    this.elRows.replaceChildren(frag);
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
