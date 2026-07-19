# Every API this app uses — what's free, where to get keys, how to add them

Last updated: 2026-07-19

## The short version

**Only ONE key is required to run the whole app: `ODDS_API_KEY`.**
Everything else — every stat, photo, logo, weather forecast, and prediction-market
price — comes from free public endpoints that need no signup and no key.

---

## 1. APIs that need a key

### The Odds API (required)
- **What it powers:** every odds screen — Board lines, player props, scores.
- **Where to get it:** https://the-odds-api.com → "Get a Free API Key" → sign up
  with an email. The free tier gives 500 credits/month; paid tiers start ~$30/mo
  if you outgrow it.
- **Cost notes:** each Board refresh for MLB costs 6 credits (3 markets × 2
  regions); props cost more per game. The server caches every response for 10
  minutes so repeated visitors don't re-spend credits.

**How to add it — local development, step by step:**
1. In the repo root (`oddSports/`), copy the example file:
   ```
   cp .env.example .env
   ```
2. Open `.env` in any editor and paste your key after the equals sign:
   ```
   ODDS_API_KEY=your_key_here
   PORT=3000
   ```
3. Save. Never commit this file — `.gitignore` already excludes it.
4. Start the app: `npm start` — it refuses to boot if the key is missing,
   so a clean startup means the key loaded.

**How to add it — Railway (production), step by step:**
1. Railway dashboard → your project → the service → **Variables** tab.
2. Click **New Variable**. Name: `ODDS_API_KEY`. Value: your key. Save.
3. Railway redeploys automatically. Watch the deploy logs for
   `LineWatch listening on :<port>` — that confirms the key was seen.
4. Do NOT set `PORT` on Railway — it injects its own.

---

## 2. Free, keyless APIs already wired in

Nothing to sign up for, nothing to add to `.env` — these work out of the box.

| API | What it powers | Base URL |
|---|---|---|
| **MLB StatsAPI** | HR matchups, batter-vs-pitcher, probable pitchers, lineups, live inning detail, pick grading, MLB player search | `statsapi.mlb.com` |
| **ESPN site API** (unofficial) | Player Stats search across every league; season/career stat tables for NBA, NFL, NHL, NCAA, EPL, UFC, WNBA | `site.web.api.espn.com` |
| **NHL api-web** | Available for deeper NHL stats (not yet wired) | `api-web.nhle.com` |
| **Open-Meteo** | Stadium weather strips on MLB cards | `api.open-meteo.com` |
| **Kalshi** | Prediction-market reference prices | `api.elections.kalshi.com` |
| **Baseball Savant** | Nightly Statcast EV/Barrel%/HardHit% (fetched by GitHub Actions, served as static JSON) | `baseballsavant.mlb.com` |
| **MLB headshot CDN** | Player photos in props + HR matchups | `img.mlbstatic.com` |
| **ESPN logo/headshot CDN** | Team logos, search-result headshots | `a.espncdn.com` |

### Reliability fine print
- **MLB StatsAPI** is official and stable — safe to build on.
- **ESPN's site API and CDNs are unofficial.** They've been stable for years and
  power many fan sites, but ESPN could change them without notice. Everything
  built on them fails soft: a stat panel goes empty, a photo hides itself —
  the app never crashes because of them.
- **Open-Meteo** is free for non-commercial use at our volume.
- **Kalshi's** market-data endpoints are public and documented.

---

## 3. Optional paid upgrades (not wired in — future ideas)

| API | What it would add | Free tier? |
|---|---|---|
| SportsDataIO | Official-grade multi-sport stats, injuries, projections | Trial only |
| Sportradar | Same tier, enterprise | Trial only |
| API-Sports (api-football etc.) | Broad soccer/basketball coverage | 100 req/day free |

If one of these is ever added, the pattern is the same as `ODDS_API_KEY`:
add `NEW_API_KEY=...` to `.env` locally and to Railway Variables in production,
then read it in `server.js` via `process.env.NEW_API_KEY` — never in frontend
code, so the key can't leak to browsers.
