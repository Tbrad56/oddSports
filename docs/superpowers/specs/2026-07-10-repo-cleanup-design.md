# LineWatch Repo Cleanup — Design

**Date:** 2026-07-10
**Status:** Approved

## Context

LineWatch (`linewatch_8.html`) is a working Claude-artifact prototype: a sports
odds comparison tool pulling moneylines and player props from The Odds API,
with line-shopping across ~10 US sportsbooks, consensus-devig value detection,
a cheatsheet of best edges, and a parlay-price calculator. It is a single
1,421-line HTML file with three problems blocking real use:

1. A real Odds API key is hardcoded in source (`DEFAULT_KEY`, never committed —
   repo has no commits yet). Key must be rotated by the owner and removed.
2. It depends on artifact-only APIs (`window.storage`) and an unauthenticated
   Anthropic API call that only work inside the Claude artifact runtime.
3. Monolithic single file — unmaintainable as the project grows.

## Decisions (locked with user)

| Decision | Choice |
|---|---|
| Audience | Hosted publicly for others; shared Odds API key |
| Stack | Node/Express on Railway (matches user's moneyTracker) |
| Screenshot AI parser | **Dropped for v1** (cost/abuse risk; was broken outside artifacts anyway) |
| Odds freshness | Server-side cache, **10-minute TTL** |
| Structure | Split into `public/` static frontend + `server.js` proxy |

## Repo structure

```
oddSports/
├── public/
│   ├── index.html      # markup only
│   ├── styles.css      # all CSS from the old <style> block
│   └── app.js          # all JS, minus key handling + screenshot parser
├── server.js           # Express: static serving + API proxy + cache
├── package.json        # express, dotenv; "start" script
├── .env.example        # ODDS_API_KEY=, PORT=
├── .gitignore          # node_modules/, .env
└── README.md           # what it is, local run, Railway deploy
```

`linewatch_8.html` is deleted after the split. The real key lives only in
Railway env vars and local `.env` (gitignored).

## Server design (`server.js`)

Thin proxy, no DB, no sessions.

- `GET /api/odds/:sport` → upstream
  `GET /v4/sports/{sport}/odds?regions=us,us2&markets=h2h&oddsFormat=american`
- `GET /api/props/:sport/:eventId` → upstream event-odds endpoint. The
  market list comes from a server-side `PROP_MARKETS` table (copied from the
  prototype); clients cannot request arbitrary markets (quota protection).
- `:sport` validated against the 8-sport allowlist
  (NFL, NBA, MLB, NHL, NCAAF, NCAAB, EPL, MMA — same keys as prototype).
- In-memory cache: `Map` keyed by upstream URL, 10-min TTL. Hit = no upstream
  call. Cache dies on restart; acceptable.
- Response passthrough: JSON body, plus `x-requests-remaining` header and a
  cache-age header so the client can show quota and staleness.
- Key is appended server-side from `process.env.ODDS_API_KEY`; never logged,
  never echoed in errors.

### Error handling

| Condition | Client sees |
|---|---|
| Upstream 401 (bad key) | 502 "Odds service unavailable" (detail server-log only) |
| Upstream 429 (quota out) | 429 "Monthly odds quota exhausted — resets on the 1st" |
| Invalid sport param | 400 |
| Server down | Existing red error banner (`showError`) |

## Frontend changes (`public/app.js`)

Behavior-preserving port of the prototype JS, except:

- Fetch URLs become `/api/odds/${sport}` and `/api/props/${sport}/${game.id}`.
- **Deleted:** API-key Settings field and save flow, `window.storage` helpers,
  `DEFAULT_KEY`, screenshot drop-zone + Anthropic call + the manual-entry
  code path tied to screenshots.
- **Kept:** link-paste reference entries, all rendering (board, props tables,
  collapse state, book filter, ticker, search), slip + parlay math,
  cheatsheet/value detection.
- Settings panel becomes a small info panel (books tracked, quota note);
  Settings rail button stays.
- Status line: initial text "Pick a sport and hit Get Odds"; shows remaining
  quota from the proxied header and "cached X min ago" from the cache-age
  header.
- Auto-refresh interval changes 5m → 10m to match cache TTL.

## Verification

1. `npm start` locally with a real (rotated) key in `.env`:
   - Load NBA or MLB odds; load props on one game.
   - Add legs from board + props; sanity-check parlay prices.
   - Fetch same sport again within 10 min → served from cache (server log
     shows no upstream call; quota header unchanged).
2. `git grep 4256ff9b` (old key) before every commit — must return nothing.
3. Deploy to Railway with `ODDS_API_KEY` env var; repeat smoke test on the
   public URL.

## Out of scope (v1)

- Screenshot bet-slip parsing (re-add later behind rate limiting if wanted)
- Spreads/totals markets, live in-game odds
- Accounts, persistence of slips, paid Odds API tier
