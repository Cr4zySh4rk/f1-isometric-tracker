# 🏎️ F1 Isometric Tracker

Isometric 3D visualizer for Formula 1 sessions — real car positions on a track derived from real telemetry, powered by the free [OpenF1 API](https://openf1.org).

**Live:** https://cr4zysh4rk.github.io/f1-isometric-tracker/

- Replay any session since 2023 (practice, quali, sprint, race) with play/pause, speed control and scrubbing
- Track geometry built from actual GPS traces — no track assets needed
- Live-ready: during sessions it polls for near-live data when the API allows
- Leaderboard with gaps, lap counter, flags/safety car states
- 100% static, deployed via GitHub Actions to GitHub Pages

See [ARCHITECTURE.md](ARCHITECTURE.md) for design details.

## Development

```bash
npm install
npm run dev     # local dev server
npm run build   # production build → dist/
```

Pushes to `main` auto-deploy via GitHub Actions.

*Unofficial project; not affiliated with Formula 1. Data © OpenF1 (CC BY-NC-SA 4.0).*
