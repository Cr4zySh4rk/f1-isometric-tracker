// Focused-driver panel: identity + timing (position, current/last/best lap,
// S1/S2/S3 colours) PLUS replay-time-aware telemetry at T (speed, throttle/brake
// bars, gear, rpm, DRS), the current tyre (compound-coloured dot + age), and a
// team-radio control. Telemetry/tyre/radio come from real /car_data + /stints +
// /team_radio; in Approximate (Jolpica) mode they read "telemetry unavailable".
//
// DOM is thin: the pure logic (drsState/gearLabel/parseCarSample, compoundInfo,
// tyreAgeAt, radio selection) lives in unit-tested data modules. The panel keeps
// a stable skeleton (a rebuilt #dp-body plus a radio mount the RadioController
// owns) so re-rendering never tears down active audio.

import {
  inProgressLap, lastCompletedLap, bestLapByDriverAt, sectorBestsAt,
  lapSectors, currentLapAt,
} from '../data/timing.js';
import { raceOrderAt, practiceOrderAt } from '../data/timing.js';
import { sectorColorState } from '../data/sectors.js';
import { fmtLapTime, fmtLiveLap } from '../util/format.js';
import { drsState, gearLabel } from '../data/telemetry.js';
import { compoundInfo } from '../data/stints.js';

export class DriverPanel {
  constructor({ store }) {
    this.store = store;
    this.num = null;
    this.el = document.getElementById('driver-panel');
    this.telemetry = null; // FocusedTelemetry (set by main.js)
    this.radio = null;     // RadioController (set by main.js)
    this._built = false;
  }

  show(num) {
    this.num = num;
    this._built = false; // force skeleton rebuild for the new driver
    this.el.classList.remove('hidden');
  }

  hide() {
    this.num = null;
    this._built = false;
    this.el.classList.add('hidden');
    this.el.innerHTML = '';
  }

  // Build the stable skeleton once per focus: a #dp-body (rebuilt each frame)
  // and a #dp-radio mount the RadioController owns (never clobbered here).
  _buildSkeleton() {
    this.el.innerHTML = '<div id="dp-body"></div><div id="dp-radio" class="dp-radio"></div>';
    this._body = this.el.querySelector('#dp-body');
    if (this.radio) this.radio.attach(this.el.querySelector('#dp-radio'));
    this._built = true;
  }

  update(tMs) {
    if (this.num == null) return;
    if (!this._built || this._lastNum !== this.num) this._buildSkeleton();
    // Throttle DOM rebuilds to ~10 Hz (wall clock); live timer shows tenths.
    const wall = Date.now();
    if (this._lastWall && wall - this._lastWall < 90 && this._lastNum === this.num) return;
    this._lastWall = wall;
    this._lastNum = this.num;
    const num = this.num;
    const d = this.store.driver(num) || {};
    const color = this.store.teamColour(num);

    // Position at T.
    const driverNums = this.store.drivers.map((x) => x.driver_number);
    const order = this.store.isRace()
      ? raceOrderAt(this.store.positions, driverNums, tMs)
      : practiceOrderAt(this.store.laps, driverNums, tMs);
    const me = order.find((o) => o.num === num);
    const pos = me ? (me.position ?? me.rank) : '—';

    const curLap = inProgressLap(this.store.laps, num, tMs);
    const lapNo = curLap ? curLap.lap_number : this.store.currentLapAt(tMs).current;
    const liveMs = curLap && curLap.date_start
      ? tMs - Date.parse(curLap.date_start) : NaN;

    const last = lastCompletedLap(this.store.laps, num, tMs);
    const best = bestLapByDriverAt(this.store.laps, tMs).get(num);
    const { session: sessBest, byDriver } = sectorBestsAt(this.store.laps, tMs);
    const pb = byDriver.get(num) || [null, null, null];

    // Sector times to show: prefer the last completed lap's sectors.
    const secs = last ? lapSectors(last) : [null, null, null];
    const secCells = secs.map((s, i) => {
      const state = sectorColorState(s, pb[i], sessBest[i], null);
      return { time: s, state };
    });

    this._body.innerHTML = `
      <div class="dp-head" style="border-left-color:${color}">
        <span class="dp-num">${num}</span>
        <div class="dp-id">
          <div class="dp-name">${escapeHtml(d.full_name || d.broadcast_name || this.store.acronym(num))}</div>
          <div class="dp-team">${escapeHtml(d.team_name || '')}</div>
        </div>
        <button class="dp-close" id="dp-close" title="Unfocus (Esc)">×</button>
      </div>
      ${this._telemetryHtml(num, tMs)}
      <div class="dp-grid">
        <div class="dp-cell"><span class="dp-k">POS</span><span class="dp-v">${pos}</span></div>
        <div class="dp-cell"><span class="dp-k">LAP</span><span class="dp-v">${lapNo || '—'}</span></div>
        <div class="dp-cell"><span class="dp-k">CURRENT</span><span class="dp-v dp-live">${fmtLiveLap(liveMs) || '—'}</span></div>
      </div>
      <div class="dp-grid">
        <div class="dp-cell"><span class="dp-k">LAST</span><span class="dp-v">${last ? fmtLapTime(last.lap_duration) : '—'}</span></div>
        <div class="dp-cell"><span class="dp-k">BEST</span><span class="dp-v">${best ? fmtLapTime(best.lap_duration) : '—'}</span></div>
      </div>
      <div class="dp-sectors">
        ${secCells.map((c, i) => `
          <div class="dp-sec dp-sec-${c.state}">
            <span class="dp-sec-k">S${i + 1}</span>
            <span class="dp-sec-v">${c.time != null ? c.time.toFixed(3) : '—'}</span>
          </div>`).join('')}
      </div>`;

    const closeBtn = this._body.querySelector('#dp-close');
    if (closeBtn && this.onClose) closeBtn.addEventListener('click', () => this.onClose());

    // Radio list refresh (owns its own mount; audio persists across renders).
    if (this.radio) this.radio.update(tMs);
  }

  // Telemetry + tyre block. In Approximate mode (no telemetry) → a clear notice.
  _telemetryHtml(num, tMs) {
    if (!this.store.hasTelemetry()) {
      return '<div class="dp-telem dp-telem-off">Telemetry unavailable (Approx mode)</div>';
    }
    const s = this.telemetry ? this.telemetry.sampleAt(tMs) : null;
    const compound = this.store.compoundAt(num, tMs);
    const age = this.store.tyreAgeAt(num, tMs);
    const ci = compoundInfo(compound);

    if (!s) {
      // Buffer warming up around T (or a gap) — show the tyre, telemetry pending.
      return `
        <div class="dp-telem">
          <div class="dp-speed"><span class="dp-speed-v">—</span><span class="dp-speed-u">km/h</span></div>
          <div class="dp-telem-pending">telemetry…</div>
          ${this._tyreHtml(ci, age)}
        </div>`;
    }

    const speed = s.speed != null ? Math.round(s.speed) : '—';
    const thr = s.throttle != null ? Math.round(s.throttle) : 0;
    const brk = s.brake != null ? Math.round(s.brake) : 0;
    const gear = gearLabel(s.gear);
    const rpm = s.rpm != null ? Math.round(s.rpm).toLocaleString() : '—';
    const drs = drsState(s.drs);

    return `
      <div class="dp-telem">
        <div class="dp-speed">
          <span class="dp-speed-v">${speed}</span><span class="dp-speed-u">km/h</span>
        </div>
        <div class="dp-bars">
          <div class="dp-bar"><span class="dp-bar-k">THR</span><div class="dp-bar-track"><div class="dp-bar-fill dp-thr" style="width:${thr}%"></div></div></div>
          <div class="dp-bar"><span class="dp-bar-k">BRK</span><div class="dp-bar-track"><div class="dp-bar-fill dp-brk" style="width:${brk}%"></div></div></div>
        </div>
        <div class="dp-telem-row">
          <div class="dp-chip"><span class="dp-chip-k">GEAR</span><span class="dp-chip-v">${gear}</span></div>
          <div class="dp-chip"><span class="dp-chip-k">RPM</span><span class="dp-chip-v">${rpm}</span></div>
          <div class="dp-chip dp-drs ${drs === 'OPEN' ? 'drs-open' : 'drs-closed'}"><span class="dp-chip-k">DRS</span><span class="dp-chip-v">${drs}</span></div>
        </div>
        ${this._tyreHtml(ci, age)}
      </div>`;
  }

  _tyreHtml(ci, age) {
    const ageLabel = Number.isFinite(age) ? `${age} lap${age === 1 ? '' : 's'}` : '—';
    return `
      <div class="dp-tyre">
        <span class="dp-tyre-dot" style="background:${ci.color}"></span>
        <span class="dp-tyre-label">${ci.label}</span>
        <span class="dp-tyre-age">${ageLabel}</span>
      </div>`;
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
