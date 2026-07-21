# 🏎️ F1 Isometric Tracker

Isometric 3D visualizer for Formula 1 sessions — real car positions on a track derived from real telemetry, powered by the free [OpenF1 API](https://openf1.org).

**Live:** https://cr4zysh4rk.github.io/f1-isometric-tracker/

- Replay any session since 2023 (practice, quali, sprint, race) with play/pause, speed control and scrubbing
- Track geometry built from actual GPS traces — no track assets needed
- F1 TV-style timing tower, penalties, fastest-lap marker, floating live-lap labels, click-to-focus with driver panel and sector-colored track
- **Rich focused-driver panel** — replay-time-aware live telemetry at T: speed, throttle/brake bars, gear, RPM, DRS chip, and the current tyre (compound-colored dot + age in laps), all from real `/car_data` + `/stints`
- **Team radio** — on focus, autoplays the driver's most recent clip ≤ the replay cursor (plain `<audio>`, no CORS), with a persisted mute toggle, "play latest", and a clickable timestamped clip list
- **Weather widget** (top-right) — air/track temperature, humidity, wind speed + direction arrow and a DRY/RAIN indicator, at session time T
- **Championship standings** (top-right) — the driver/constructor table *going into* the loaded race (classification after the previous round), from Jolpica, with a drivers ⇄ teams toggle
- Live-ready: during sessions it polls for near-live data when the API allows
- **Automatic multi-provider failover:** when OpenF1 is live-blocked or down, the app degrades to a clearly-labeled **Approximate mode** — session list, results and lap-by-lap order come from [Jolpica](https://jolpi.ca) (Ergast successor) and cars are estimated from lap times along a schematic circuit. It polls OpenF1 every 60 s and switches back to full 3D telemetry when it recovers.
- Leaderboard with gaps, lap counter, flags/safety car states
- 100% static, deployed via GitHub Actions to GitHub Pages

See [ARCHITECTURE.md](ARCHITECTURE.md) for design details.

## Development

```bash
npm install
npm run dev     # local dev server
npm run build   # production build → dist/
```

```bash
npm test          # vitest — pure logic + parsers + provider failover (no network)
npm run verify:real  # end-to-end assertions against the live OpenF1/Jolpica APIs
```

Pushes to `main` auto-deploy via GitHub Actions.

*Unofficial project; not affiliated with Formula 1. Data © OpenF1 (CC BY-NC-SA 4.0).*
