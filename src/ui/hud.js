// HUD: leaderboard, lap counter, session title, flag/SC/VSC banner.
//
// Standings at session time T:
//  - Races: /position (changes-only) gives running order; /intervals gives gaps.
//  - Practice/Quali: fall back to best-lap order.

export class Hud {
  constructor({ store, buffer, clock, onSelectDriver }) {
    this.store = store;
    this.buffer = buffer;
    this.clock = clock;
    this.onSelectDriver = onSelectDriver;

    this.elLeaderboard = document.getElementById('leaderboard');
    this.elLap = document.getElementById('lap-counter');
    this.elFlag = document.getElementById('flag-banner');
    this.elTitle = document.getElementById('session-name');

    this.selected = null;
    this._lastFlag = undefined;
    this._rowCache = new Map();
    this._lastRenderMs = 0;
    this._orderCache = null;
    this._orderCacheAt = -1;

    this._buildTitle();
    this.elLeaderboard.classList.remove('hidden');
    this.elLap.classList.remove('hidden');
  }

  _buildTitle() {
    const s = this.store.session;
    const parts = [s.circuit_short_name || s.country_name || '', s.session_name || ''].filter(Boolean);
    this.elTitle.textContent = parts.join(' · ') || 'Session';
  }

  setSelected(num) {
    this.selected = num;
  }

  // Compute running order at time T.
  orderAt(tMs) {
    if (this._orderCacheAt === tMs && this._orderCache) return this._orderCache;

    let order;
    if (this.store.isRace() && this.store.positions.length) {
      const pos = new Map();
      for (const p of this.store.positions) {
        if (!p.date) continue;
        if (Date.parse(p.date) > tMs) continue;
        pos.set(p.driver_number, p.position);
      }
      const nums = this.store.drivers.map((d) => d.driver_number);
      order = nums
        .map((n) => ({ num: n, position: pos.get(n) }))
        .filter((o) => o.position != null)
        .sort((a, b) => a.position - b.position);
      // Append any drivers without a position at the end.
      const have = new Set(order.map((o) => o.num));
      for (const n of nums) if (!have.has(n)) order.push({ num: n, position: 99 });
    } else {
      // Best-lap order.
      const best = this.store.bestLapByDriver();
      order = [...best.entries()]
        .map(([num, lap]) => ({ num, position: null, best: lap.lap_duration }))
        .sort((a, b) => a.best - b.best)
        .map((o, i) => ({ ...o, position: i + 1 }));
      // Drivers without a lap yet.
      const have = new Set(order.map((o) => o.num));
      for (const d of this.store.drivers) {
        if (!have.has(d.driver_number)) order.push({ num: d.driver_number, position: order.length + 1 });
      }
    }
    this._orderCache = order;
    this._orderCacheAt = tMs;
    return order;
  }

  render(tMs) {
    // Throttle DOM updates to ~8 Hz.
    if (tMs - this._lastRenderMs < 120 && this._lastRenderMs) return;
    this._lastRenderMs = tMs;

    this._renderLap(tMs);
    this._renderFlag(tMs);
    this._renderBoard(tMs);
  }

  _renderLap(tMs) {
    const { current, total } = this.store.currentLapAt(tMs);
    if (total > 0) {
      this.elLap.innerHTML = `<span class="lap-word">LAP</span> <b>${current}</b><span class="lap-total">/${total}</span>`;
      this.elLap.classList.remove('hidden');
    } else {
      this.elLap.classList.add('hidden');
    }
  }

  _renderFlag(tMs) {
    const st = this.store.flagStateAt(tMs);
    let kind = null, text = null;
    if (st.safetyCar === 'SC') { kind = 'SC'; text = 'SAFETY CAR'; }
    else if (st.safetyCar === 'VSC') { kind = 'VSC'; text = 'VIRTUAL SAFETY CAR'; }
    else if (st.flag === 'RED') { kind = 'RED'; text = 'RED FLAG'; }
    else if (st.flag === 'YELLOW' || st.flag === 'DOUBLE YELLOW') { kind = st.flag === 'DOUBLE YELLOW' ? 'DOUBLE YELLOW' : 'YELLOW'; text = st.flag === 'DOUBLE YELLOW' ? 'DOUBLE YELLOW' : 'YELLOW FLAG'; }
    else if (st.flag === 'CHEQUERED') { kind = 'CHEQUERED'; text = 'CHEQUERED FLAG'; }

    if (kind === this._lastFlag) return;
    this._lastFlag = kind;
    if (this.onFlagChange) this.onFlagChange(kind);

    if (!kind) {
      this.elFlag.classList.add('hidden');
      this.elFlag.className = 'flag-banner hidden';
      return;
    }
    this.elFlag.textContent = text;
    this.elFlag.className = `flag-banner flag-${kind.replace(/\s+/g, '-').toLowerCase()}`;
  }

  _renderBoard(tMs) {
    const order = this.orderAt(tMs);
    const isRace = this.store.isRace();
    const frag = document.createDocumentFragment();
    let rank = 0;
    for (const o of order) {
      rank++;
      const num = o.num;
      const acronym = this.store.acronym(num);
      const color = this.store.teamColour(num);
      let gap = '';
      if (isRace) {
        const iv = this.buffer && this.buffer.intervalAt(num, tMs);
        if (rank === 1) gap = 'LEADER';
        else if (iv) gap = fmtGap(iv.interval != null ? iv.interval : iv.gap);
        else gap = '—';
      } else {
        gap = o.best ? fmtLap(o.best) : '—';
      }
      const last = this.store.lastLapFor(num, tMs);
      const lastStr = last ? fmtLap(last.lap_duration) : '';

      const row = document.createElement('div');
      row.className = 'lb-row' + (num === this.selected ? ' lb-selected' : '');
      row.dataset.num = num;
      row.innerHTML =
        `<span class="lb-pos">${rank}</span>` +
        `<span class="lb-chip" style="background:${color}"></span>` +
        `<span class="lb-acr">${acronym}</span>` +
        `<span class="lb-gap">${gap}</span>` +
        (isRace ? `<span class="lb-last">${lastStr}</span>` : '');
      row.addEventListener('click', () => this.onSelectDriver && this.onSelectDriver(num));
      frag.appendChild(row);
    }
    this.elLeaderboard.replaceChildren(frag);
  }
}

function fmtLap(sec) {
  if (typeof sec !== 'number' || !isFinite(sec)) return '';
  const m = Math.floor(sec / 60);
  const s = (sec - m * 60);
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

function fmtGap(v) {
  if (v == null) return '—';
  if (typeof v === 'string') return v; // e.g. "+1 LAP"
  if (typeof v === 'number') return v === 0 ? '—' : `+${v.toFixed(3)}`;
  return String(v);
}
