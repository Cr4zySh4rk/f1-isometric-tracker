// Weather widget (top-right stack): replay-time-aware conditions at session
// time T — air °C, track °C, humidity %, wind (speed + direction arrow) and a
// DRY/RAIN droplet. Reads store.weatherAt(T) (pure selection in data/weather.js);
// this module is the thin DOM shell. Always visible while a session is loaded.

import { isRaining, windCompass } from '../data/weather.js';

export class WeatherWidget {
  constructor({ store, el }) {
    this.store = store;
    this.el = el;
    this._sig = null; // last-rendered signature (skip identical repaints)
  }

  update(tMs) {
    if (!this.el) return;
    const w = this.store.weatherAt(tMs);
    if (!w) {
      if (this._sig !== 'none') { this.el.innerHTML = '<div class="wx-empty">Weather unavailable</div>'; this._sig = 'none'; }
      return;
    }
    const air = fmt(w.air_temperature, '°');
    const track = fmt(w.track_temperature, '°');
    const hum = fmt(w.humidity, '%', 0);
    const wind = fmt(w.wind_speed, '', 1);
    const dir = Number(w.wind_direction);
    const rain = isRaining(w);
    const sig = `${air}|${track}|${hum}|${wind}|${dir}|${rain}`;
    if (sig === this._sig) return;
    this._sig = sig;

    // Arrow points the way the wind BLOWS TO (meteorological direction is where
    // it comes FROM, so add 180°). 0° = pointing up (north).
    const rot = Number.isFinite(dir) ? (dir + 180) % 360 : 0;
    const compass = Number.isFinite(dir) ? windCompass(dir) : '';

    this.el.innerHTML = `
      <div class="wx-head"><span class="wx-title">WEATHER</span>
        <span class="wx-rain ${rain ? 'is-rain' : 'is-dry'}">${rain ? '💧 RAIN' : '☀ DRY'}</span>
      </div>
      <div class="wx-grid">
        <div class="wx-cell"><span class="wx-k">AIR</span><span class="wx-v">${air}</span></div>
        <div class="wx-cell"><span class="wx-k">TRACK</span><span class="wx-v">${track}</span></div>
        <div class="wx-cell"><span class="wx-k">HUM</span><span class="wx-v">${hum}</span></div>
        <div class="wx-cell wx-wind">
          <span class="wx-k">WIND</span>
          <span class="wx-v">
            <svg class="wx-arrow" viewBox="0 0 24 24" width="13" height="13" style="transform:rotate(${rot}deg)">
              <path d="M12 2 L18 20 L12 15 L6 20 Z" fill="currentColor"/>
            </svg>
            ${wind}<small>m/s ${compass}</small>
          </span>
        </div>
      </div>`;
  }
}

function fmt(v, unit, digits = 1) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `${digits ? n.toFixed(digits) : Math.round(n)}${unit}`;
}
