// Focused-driver panel: name, team, number, position, current lap + live lap
// time, last lap, best lap, and sector 1/2/3 times colored purple/green/yellow.

import {
  inProgressLap, lastCompletedLap, bestLapByDriverAt, sectorBestsAt,
  lapSectors, currentLapAt,
} from '../data/timing.js';
import { raceOrderAt, practiceOrderAt } from '../data/timing.js';
import { sectorColorState } from '../data/sectors.js';
import { fmtLapTime, fmtLiveLap } from '../util/format.js';

export class DriverPanel {
  constructor({ store }) {
    this.store = store;
    this.num = null;
    this.el = document.getElementById('driver-panel');
  }

  show(num) {
    this.num = num;
    this.el.classList.remove('hidden');
  }

  hide() {
    this.num = null;
    this.el.classList.add('hidden');
  }

  update(tMs) {
    if (this.num == null) return;
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

    this.el.innerHTML = `
      <div class="dp-head" style="border-left-color:${color}">
        <span class="dp-num">${num}</span>
        <div class="dp-id">
          <div class="dp-name">${escapeHtml(d.full_name || d.broadcast_name || this.store.acronym(num))}</div>
          <div class="dp-team">${escapeHtml(d.team_name || '')}</div>
        </div>
        <button class="dp-close" id="dp-close" title="Unfocus (Esc)">×</button>
      </div>
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

    const closeBtn = this.el.querySelector('#dp-close');
    if (closeBtn && this.onClose) closeBtn.addEventListener('click', () => this.onClose());
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
