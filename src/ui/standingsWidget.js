// Championship standings widget (top-right, below weather). Shows the standings
// GOING INTO the loaded race — i.e. the classification AFTER THE PREVIOUS round
// (round 1 → nothing yet). Drivers by default with a small toggle to teams.
//
// Data is Jolpica/Ergast (always CORS-open, independent of the OpenF1 failover
// state). The round mapping + row shaping are pure (data/standings.js); this
// module fetches, caches per (season, round), and renders. Graceful
// "standings unavailable" on any failure.

import { jolpicaRaw } from '../api/jolpica.js';
import {
  meetingToRound, standingsRoundToShow, mapDriverStandings, mapConstructorStandings,
} from '../data/standings.js';

const cache = new Map(); // `${season}:${round}` -> { drivers, constructors }

export class StandingsWidget {
  constructor({ el }) {
    this.el = el;
    this.mode = 'drivers';
    this.data = null;
    this.state = 'idle';
    this.meetingRound = null;
    this.showRound = null;
    this._gen = 0;
    if (el && !el._standingsBound) {
      el._standingsBound = true;
      el.addEventListener('click', (e) => {
        const t = e.target.closest('[data-stmode]');
        if (t) this.setMode(t.getAttribute('data-stmode'));
      });
    }
  }

  // Load standings for a season + the meeting's start date (ms epoch).
  async load(season, meetingDateMs) {
    const gen = ++this._gen;
    this.state = 'loading';
    this.render();
    try {
      const schedMr = await jolpicaRaw(`${season}`);
      const races = schedMr?.RaceTable?.Races || [];
      const map = meetingToRound(races, meetingDateMs, season);
      if (!map) { if (gen === this._gen) { this.state = 'error'; this.render(); } return; }
      this.meetingRound = map.round;
      const showRound = standingsRoundToShow(map.round);
      this.showRound = showRound;

      if (showRound <= 0) {
        // Season opener: no prior round to show.
        this.data = { drivers: [], constructors: [] };
        this.state = 'empty';
        if (gen === this._gen) this.render();
        return;
      }

      const ck = `${season}:${showRound}`;
      let entry = cache.get(ck);
      if (!entry) {
        const [dMr, cMr] = await Promise.all([
          jolpicaRaw(`${season}/${showRound}/driverStandings`),
          jolpicaRaw(`${season}/${showRound}/constructorStandings`),
        ]);
        const dList = dMr?.StandingsTable?.StandingsLists?.[0] || {};
        const cList = cMr?.StandingsTable?.StandingsLists?.[0] || {};
        entry = {
          drivers: mapDriverStandings(dList),
          constructors: mapConstructorStandings(cList),
        };
        cache.set(ck, entry);
      }
      this.data = entry;
      this.state = (entry.drivers.length || entry.constructors.length) ? 'ready' : 'error';
      if (gen === this._gen) this.render();
    } catch {
      if (gen === this._gen) { this.state = 'error'; this.render(); }
    }
  }

  setMode(mode) {
    if (mode !== 'drivers' && mode !== 'constructors') return;
    this.mode = mode;
    this.render();
  }

  render() {
    if (!this.el) return;
    if (this.state === 'loading' || this.state === 'idle') {
      this.el.innerHTML = `${this._head()}<div class="st-msg">Loading standings…</div>`;
      return;
    }
    if (this.state === 'error') {
      this.el.innerHTML = `${this._head()}<div class="st-msg">Standings unavailable</div>`;
      return;
    }
    if (this.state === 'empty') {
      this.el.innerHTML = `${this._head()}<div class="st-msg">Season opener — no prior standings.</div>`;
      return;
    }
    const rows = this.mode === 'drivers' ? this._driverRows() : this._constructorRows();
    this.el.innerHTML = `${this._head()}<div class="st-list">${rows}</div>`;
  }

  _head() {
    const into = this.meetingRound ? `<span class="st-sub">into R${this.meetingRound}</span>` : '';
    const d = this.mode === 'drivers' ? ' active' : '';
    const c = this.mode === 'constructors' ? ' active' : '';
    return `
      <div class="st-head">
        <span class="st-title">STANDINGS</span>${into}
        <div class="st-toggle">
          <button class="st-tab${d}" data-stmode="drivers">Drivers</button>
          <button class="st-tab${c}" data-stmode="constructors">Teams</button>
        </div>
      </div>`;
  }

  _driverRows() {
    const rows = (this.data && this.data.drivers) || [];
    if (!rows.length) return '<div class="st-msg">No driver standings.</div>';
    return rows.map((r) => `
      <div class="st-row" style="border-left-color:${r.color}">
        <span class="st-pos">${r.position ?? '—'}</span>
        <span class="st-code">${escapeHtml(r.code || r.name)}</span>
        <span class="st-team">${escapeHtml(r.constructor)}</span>
        <span class="st-pts">${r.points}</span>
      </div>`).join('');
  }

  _constructorRows() {
    const rows = (this.data && this.data.constructors) || [];
    if (!rows.length) return '<div class="st-msg">No team standings.</div>';
    return rows.map((r) => `
      <div class="st-row" style="border-left-color:${r.color}">
        <span class="st-pos">${r.position ?? '—'}</span>
        <span class="st-code st-cname">${escapeHtml(r.name)}</span>
        <span class="st-pts">${r.points}</span>
      </div>`).join('');
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
