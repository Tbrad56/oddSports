# LineWatch Repo Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the `linewatch_8.html` artifact prototype into a static frontend + Express proxy so the Odds API key lives server-side, and delete artifact-only code.

**Architecture:** `public/` holds the static frontend (markup, CSS, JS extracted from the prototype). `server.js` is an Express app that serves `public/` and proxies two Odds API endpoints with a 10-minute in-memory cache; the API key is appended server-side from `ODDS_API_KEY`. No DB, no sessions.

**Tech Stack:** Node 18+ (global `fetch`), Express 4, dotenv. Tests: built-in `node --test` + supertest (dev dep).

**Source material:** All frontend code is extracted from `linewatch_8.html` (1,421 lines) at repo root. Line references below are to that file as committed on branch start. Spec: `docs/superpowers/specs/2026-07-10-repo-cleanup-design.md`.

## Global Constraints

- The Odds API key must NEVER appear in any committed file, client-visible response, or log line. Server reads it from `process.env.ODDS_API_KEY` only.
- Cache TTL: 10 minutes (`10*60*1000` ms).
- Sports allowlist (exact keys): `americanfootball_nfl`, `basketball_nba`, `baseball_mlb`, `icehockey_nhl`, `americanfootball_ncaaf`, `basketball_ncaab`, `soccer_epl`, `mma_mixed_martial_arts`.
- Upstream base URL: `https://api.the-odds-api.com`.
- Client-facing error copy (exact): quota → `Monthly odds quota exhausted — resets on the 1st`; upstream failure → `Odds service unavailable`.
- The screenshot/Anthropic feature is dropped; the link-paste "reference" entries stay.
- Before EVERY commit run `git grep 4256ff9b` — must output nothing.

---

### Task 1: Branch + project scaffold

**Files:**
- Create: `package.json`, `.gitignore`, `.env.example`
- Create (local only, never committed): `.env`

**Interfaces:**
- Produces: npm scripts `start` (`node server.js`) and `test` (`node --test test/`), used by every later task.

- [ ] **Step 1: Create branch**

```bash
git checkout -b repo-cleanup
```

- [ ] **Step 2: Create package.json**

```json
{
  "name": "linewatch",
  "version": "1.0.0",
  "description": "Sports odds comparison — line shopping, value detection, parlay pricing",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "test": "node --test test/"
  },
  "engines": { "node": ">=18" },
  "license": "UNLICENSED",
  "private": true
}
```

- [ ] **Step 3: Create .gitignore**

```
node_modules/
.env
```

- [ ] **Step 4: Create .env.example**

```
# Get a key at https://the-odds-api.com (never commit the real one)
ODDS_API_KEY=
PORT=3000
```

- [ ] **Step 5: Install dependencies**

```bash
npm install express dotenv && npm install --save-dev supertest
```
Expected: `package.json` gains dependencies `express`, `dotenv` and devDependency `supertest`; `package-lock.json` created.

- [ ] **Step 6: Create local .env (NOT committed)** — copy `.env.example` to `.env`, paste the user's ROTATED Odds API key. Verify `git status` does not list `.env`.

- [ ] **Step 7: Commit**

```bash
git grep 4256ff9b || git add package.json package-lock.json .gitignore .env.example && git commit -m "chore: scaffold Node project for Express proxy"
```

---

### Task 2: Express app — odds endpoint with cache

**Files:**
- Create: `server.js`
- Test: `test/server.test.js`

**Interfaces:**
- Produces: `createApp({apiKey, fetchFn, cacheTtlMs, now})` exported from `server.js`. Returns an Express app with `GET /api/odds/:sport` and static serving of `public/`. The entrypoint (`require.main` block) is included here too. Task 3 adds `/api/props` to this same file.

- [ ] **Step 1: Write failing tests**

Create `test/server.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { createApp } = require('../server');

// Minimal fake of a fetch Response
function okResponse(body, remaining = '499') {
  return {
    ok: true,
    status: 200,
    headers: { get: (h) => (h === 'x-requests-remaining' ? remaining : null) },
    json: async () => body
  };
}
function errResponse(status) {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    json: async () => ({})
  };
}
function fakeFetch(responder) {
  const fn = async (url) => { fn.calls.push(url); return responder(url); };
  fn.calls = [];
  return fn;
}

test('rejects unknown sport with 400 and never calls upstream', async () => {
  const f = fakeFetch(() => okResponse([]));
  const app = createApp({ apiKey: 'k', fetchFn: f });
  const res = await request(app).get('/api/odds/basketball_wnba');
  assert.equal(res.status, 400);
  assert.equal(f.calls.length, 0);
});

test('proxies a valid sport, appends key upstream, passes body and quota header back', async () => {
  const games = [{ id: 'abc', home_team: 'A', away_team: 'B' }];
  const f = fakeFetch(() => okResponse(games, '123'));
  const app = createApp({ apiKey: 'sekret', fetchFn: f });
  const res = await request(app).get('/api/odds/basketball_nba');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, games);
  assert.equal(res.headers['x-requests-remaining'], '123');
  assert.equal(res.headers['x-cache-age-seconds'], '0');
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0], /^https:\/\/api\.the-odds-api\.com\/v4\/sports\/basketball_nba\/odds\/\?regions=us,us2&markets=h2h&oddsFormat=american&apiKey=sekret$/);
});

test('second request within TTL is served from cache', async () => {
  let t = 1000000;
  const f = fakeFetch(() => okResponse([{ id: 'x' }]));
  const app = createApp({ apiKey: 'k', fetchFn: f, cacheTtlMs: 600000, now: () => t });
  await request(app).get('/api/odds/basketball_nba');
  t += 120000; // +2 min
  const res2 = await request(app).get('/api/odds/basketball_nba');
  assert.equal(res2.status, 200);
  assert.equal(f.calls.length, 1);
  assert.equal(res2.headers['x-cache-age-seconds'], '120');
});

test('cache expires after TTL', async () => {
  let t = 1000000;
  const f = fakeFetch(() => okResponse([]));
  const app = createApp({ apiKey: 'k', fetchFn: f, cacheTtlMs: 600000, now: () => t });
  await request(app).get('/api/odds/basketball_nba');
  t += 600001;
  await request(app).get('/api/odds/basketball_nba');
  assert.equal(f.calls.length, 2);
});

test('upstream 401 maps to 502 generic message, key not leaked', async () => {
  const f = fakeFetch(() => errResponse(401));
  const app = createApp({ apiKey: 'sekret', fetchFn: f });
  const res = await request(app).get('/api/odds/basketball_nba');
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'Odds service unavailable');
  assert.ok(!JSON.stringify(res.body).includes('sekret'));
});

test('upstream 429 maps to quota message', async () => {
  const f = fakeFetch(() => errResponse(429));
  const app = createApp({ apiKey: 'k', fetchFn: f });
  const res = await request(app).get('/api/odds/basketball_nba');
  assert.equal(res.status, 429);
  assert.equal(res.body.error, 'Monthly odds quota exhausted — resets on the 1st');
});

test('upstream network failure maps to 502', async () => {
  const f = async () => { throw new Error('ECONNREFUSED'); };
  const app = createApp({ apiKey: 'k', fetchFn: f });
  const res = await request(app).get('/api/odds/basketball_nba');
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'Odds service unavailable');
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../server'`.

- [ ] **Step 3: Write server.js**

```js
require('dotenv').config();
const express = require('express');
const path = require('path');

const UPSTREAM = 'https://api.the-odds-api.com';

const SPORTS = new Set([
  'americanfootball_nfl', 'basketball_nba', 'baseball_mlb', 'icehockey_nhl',
  'americanfootball_ncaaf', 'basketball_ncaab', 'soccer_epl', 'mma_mixed_martial_arts'
]);

function createApp({ apiKey, fetchFn = fetch, cacheTtlMs = 10 * 60 * 1000, now = Date.now } = {}) {
  const app = express();
  const cache = new Map(); // upstreamPath -> {body, remaining, cachedAt, expires}

  async function proxy(upstreamPath, res) {
    const hit = cache.get(upstreamPath);
    if (hit && now() < hit.expires) {
      if (hit.remaining) res.set('x-requests-remaining', hit.remaining);
      res.set('x-cache-age-seconds', String(Math.round((now() - hit.cachedAt) / 1000)));
      return res.json(hit.body);
    }
    let upstream;
    try {
      upstream = await fetchFn(`${UPSTREAM}${upstreamPath}&apiKey=${encodeURIComponent(apiKey)}`);
    } catch (e) {
      console.error(`Upstream fetch failed for ${upstreamPath}: ${e.message}`);
      return res.status(502).json({ error: 'Odds service unavailable' });
    }
    if (upstream.status === 429) {
      return res.status(429).json({ error: 'Monthly odds quota exhausted — resets on the 1st' });
    }
    if (!upstream.ok) {
      console.error(`Upstream ${upstream.status} for ${upstreamPath}`);
      return res.status(502).json({ error: 'Odds service unavailable' });
    }
    const body = await upstream.json();
    const remaining = upstream.headers.get('x-requests-remaining');
    cache.set(upstreamPath, { body, remaining, cachedAt: now(), expires: now() + cacheTtlMs });
    if (remaining) res.set('x-requests-remaining', remaining);
    res.set('x-cache-age-seconds', '0');
    res.json(body);
  }

  app.get('/api/odds/:sport', (req, res) => {
    const { sport } = req.params;
    if (!SPORTS.has(sport)) return res.status(400).json({ error: 'Unknown sport' });
    proxy(`/v4/sports/${sport}/odds/?regions=us,us2&markets=h2h&oddsFormat=american`, res);
  });

  app.use(express.static(path.join(__dirname, 'public')));
  return app;
}

module.exports = { createApp };

if (require.main === module) {
  if (!process.env.ODDS_API_KEY) {
    console.error('Missing ODDS_API_KEY in environment');
    process.exit(1);
  }
  const port = process.env.PORT || 3000;
  createApp({ apiKey: process.env.ODDS_API_KEY }).listen(port, () => {
    console.log(`LineWatch listening on :${port}`);
  });
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test`
Expected: 7 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git grep 4256ff9b || git add server.js test/server.test.js && git commit -m "feat: Express proxy for h2h odds with 10-min cache"
```

---

### Task 3: Props endpoint

**Files:**
- Modify: `server.js` (add `PROP_MARKETS` const and `/api/props` route)
- Test: `test/server.test.js` (append)

**Interfaces:**
- Consumes: `createApp`, `proxy()` from Task 2.
- Produces: `GET /api/props/:sport/:eventId` — same header contract as `/api/odds`. Market list is server-controlled via `PROP_MARKETS`.

- [ ] **Step 1: Append failing tests to test/server.test.js**

```js
test('props: 400 for sport without prop markets, upstream not called', async () => {
  const f = fakeFetch(() => okResponse({}));
  const app = createApp({ apiKey: 'k', fetchFn: f });
  const res = await request(app).get('/api/props/soccer_epl/abc123');
  assert.equal(res.status, 400);
  assert.equal(f.calls.length, 0);
});

test('props: 400 for malformed event id', async () => {
  const f = fakeFetch(() => okResponse({}));
  const app = createApp({ apiKey: 'k', fetchFn: f });
  // dots are outside [a-z0-9], single path segment so it still hits the route
  const res = await request(app).get('/api/props/basketball_nba/bad..id');
  assert.equal(res.status, 400);
  assert.equal(f.calls.length, 0);
});

test('props: proxies valid request with server-side market list', async () => {
  const payload = { id: 'e1', bookmakers: [] };
  const f = fakeFetch(() => okResponse(payload));
  const app = createApp({ apiKey: 'k', fetchFn: f });
  const res = await request(app).get('/api/props/basketball_nba/0a1b2c3d4e5f');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, payload);
  assert.match(f.calls[0], /\/v4\/sports\/basketball_nba\/events\/0a1b2c3d4e5f\/odds\/\?regions=us,us2&markets=player_points,player_rebounds,player_assists,player_threes,player_points_rebounds_assists&oddsFormat=american&apiKey=k$/);
});
```

- [ ] **Step 2: Run tests, verify the 3 new ones fail**

Run: `npm test`
Expected: the three `props:` tests FAIL (404 route not found), earlier 7 still pass.

- [ ] **Step 3: Add to server.js** — insert below the `SPORTS` const:

```js
// Server-controlled prop markets per sport (quota protection: clients
// cannot request arbitrary markets). Copied from the prototype.
const PROP_MARKETS = {
  americanfootball_nfl: ['player_pass_yds', 'player_pass_tds', 'player_rush_yds', 'player_receptions', 'player_reception_yds', 'player_anytime_td'],
  americanfootball_ncaaf: ['player_pass_yds', 'player_pass_tds', 'player_rush_yds', 'player_receptions', 'player_reception_yds', 'player_anytime_td'],
  basketball_nba: ['player_points', 'player_rebounds', 'player_assists', 'player_threes', 'player_points_rebounds_assists'],
  basketball_ncaab: ['player_points', 'player_rebounds', 'player_assists', 'player_threes'],
  baseball_mlb: ['batter_hits', 'batter_home_runs', 'batter_total_bases', 'batter_rbis', 'pitcher_strikeouts'],
  icehockey_nhl: ['player_points', 'player_assists', 'player_shots_on_goal', 'player_goal_scorer_anytime']
};
```

Insert below the `/api/odds/:sport` route, above `express.static`:

```js
  app.get('/api/props/:sport/:eventId', (req, res) => {
    const { sport, eventId } = req.params;
    const markets = PROP_MARKETS[sport];
    if (!markets) return res.status(400).json({ error: 'Props not supported for this sport' });
    if (!/^[a-z0-9]{1,64}$/i.test(eventId)) return res.status(400).json({ error: 'Bad event id' });
    proxy(`/v4/sports/${sport}/events/${eventId}/odds/?regions=us,us2&markets=${markets.join(',')}&oddsFormat=american`, res);
  });
```

- [ ] **Step 4: Run tests, verify all pass**

Run: `npm test`
Expected: 10 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git grep 4256ff9b || git add server.js test/server.test.js && git commit -m "feat: player props proxy endpoint with server-side market allowlist"
```

---

### Task 4: Frontend — styles.css and index.html

**Files:**
- Create: `public/styles.css` — extracted from `linewatch_8.html` lines 10–353 (the `<style>` contents)
- Create: `public/index.html` — extracted from `linewatch_8.html` lines 1–8 + 355–470, modified as below

**Interfaces:**
- Produces: DOM ids consumed by Task 5's `app.js`: `tickerTrack`, `autoBtn`, `navBoard`, `navProps`, `navSlip`, `navShots`, `navSettings`, `sportChips`, `statusDot`, `statusText`, `searchInput`, `fetchBtn`, `sportSelect`, `errorArea`, `gamesArea`, `propsArea`, `settingsPanel`, `cheatPanel`, `cheatCount`, `cheatBody`, `slipPanel`, `slipCount`, `slipLegs`, `slipEmpty`, `parlayArea`, `shotsPanel`, `linkInput`, `linkAddBtn`, `manualEntries`.
- Removed ids (Task 5 must not reference them): `apiKeyInput`, `saveKeyBtn`, `dropZone`, `fileInput`.

- [ ] **Step 1: Create public/styles.css**

Copy `linewatch_8.html` lines 10–353 verbatim (everything between `<style>` and `</style>`), then DELETE the `.drop-zone` rules (the three rule blocks `.drop-zone{...}`, `.drop-zone:hover, .drop-zone.drag{...}`, `.drop-zone input{...}`, lines 317–323 of the source).

- [ ] **Step 2: Create public/index.html**

Head (replaces source lines 1–9 + 354):

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>LineWatch</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Teko:wght@500;600;700&family=Inter:wght@400;500;600;700&family=Roboto+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="styles.css">
</head>
```

Body: copy source lines 355–470 verbatim, then apply these modifications:

(a) Ticker placeholder (source line 369) becomes:
```html
<span>Pick a sport and pull odds to populate this ticker →</span>
```

(b) Status text (source line 400) becomes:
```html
<span id="statusText">Pick a sport and hit "Get Odds."</span>
```

(c) Empty state (source lines 409–413) becomes:
```html
<div class="empty-state">
  <h3>No odds loaded yet</h3>
  <p>Pick a sport chip above and hit "Get Odds." Odds are ranked best → worst per side, with a badge for each sportsbook.</p>
</div>
```

(d) Settings panel (source lines 419–436) becomes an info-only panel:
```html
<div class="panel" id="settingsPanel" style="display:none;">
  <h2>About</h2>
  <div class="settings-hint">
    Books tracked: FanDuel, DraftKings, BetMGM, Caesars, ESPN BET, Bet365, Fanatics, BetRivers — whichever The Odds API returns for the selected sport. Availability varies by sport and market; not every book covers every game.
  </div>
  <div class="settings-hint" style="margin-top:10px;">
    Odds are cached for up to 10 minutes to conserve API quota — always confirm the live price on the sportsbook before betting.
  </div>
  <div class="settings-hint" style="margin-top:10px;">
    <strong style="color:var(--text-dim);">Player props</strong> load per game (they're expensive on quota) — hit "Load player props" on a game card.
  </div>
</div>
```

(e) Shots panel (source lines 450–461) loses the drop zone:
```html
<div class="panel" id="shotsPanel">
  <h2>Reference Links</h2>
  <div class="link-add-row">
    <input type="text" id="linkInput" placeholder="Paste a link to a game/odds page">
    <button id="linkAddBtn">Add</button>
  </div>
  <div id="manualEntries"></div>
</div>
```

(f) Nav rail Shots button label (source lines 386–388): change title/label from `Screenshot / Link` / `Shots` to:
```html
<button class="rail-btn" id="navShots" title="Reference Links">
  <span>📎</span><span class="rail-label">Links</span>
</button>
```

(g) Footer (source lines 465–470): keep verbatim.

(h) Close body with:
```html
<script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 3: Verify no dead references**

Run: `grep -nE 'apiKeyInput|saveKeyBtn|dropZone|fileInput|drop-zone' public/index.html public/styles.css`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git grep 4256ff9b || git add public/styles.css public/index.html && git commit -m "feat: extract static markup and styles from prototype"
```

---

### Task 5: Frontend — app.js port

**Files:**
- Create: `public/app.js` — extracted from `linewatch_8.html` lines 473–1418 (the `<script>` IIFE), modified as below

**Interfaces:**
- Consumes: DOM ids from Task 4; server endpoints `/api/odds/:sport`, `/api/props/:sport/:eventId` with headers `x-requests-remaining`, `x-cache-age-seconds`, error body `{error}`.

- [ ] **Step 1: Create public/app.js**

Copy the IIFE from `linewatch_8.html` lines 473–1418 verbatim, then apply exactly these modifications:

(a) **Delete** from `state` (source line 526): the `apiKey: null,` line.

(b) **Delete** the storage helpers section entirely (source lines 541–550: comment `// ---------- storage helpers ----------`, `loadKey`, `saveKey`).

(c) **Delete** the `saveKeyBtn` click handler (source lines 652–658).

(d) **Replace** `fetchOdds` (source lines 676–712) with:

```js
  async function fetchOdds(){
    clearError();
    const sport = sportSelect.value;
    const btn = document.getElementById('fetchBtn');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
    setStatus(false, 'Fetching latest odds…');
    try{
      const res = await fetch(`/api/odds/${sport}`);
      if(!res.ok){
        let msg = `Error ${res.status}`;
        try{ const j = await res.json(); if(j.error) msg = j.error; }catch(_){}
        throw new Error(msg);
      }
      const data = await res.json();
      state.games = data;
      state.propsCache = {};
      state.propRegistry = {};
      state.propsCollapsed = {};
      state.marketCollapsed = {};
      renderGames();
      updateTicker();
      renderCheatsheet();
      renderPropsView();
      const remaining = res.headers.get('x-requests-remaining');
      const cacheAge = Number(res.headers.get('x-cache-age-seconds') || 0);
      const freshness = cacheAge >= 60
        ? `cached ${Math.round(cacheAge/60)} min ago`
        : `updated ${new Date().toLocaleTimeString()}`;
      setStatus(true, `Live — ${data.length} games loaded${remaining ? ' · '+remaining+' requests left this month' : ''} · ${freshness}`);
    }catch(e){
      setStatus(false, 'Fetch failed.');
      showError(e.message || 'Could not fetch odds — try again shortly.');
    }finally{
      btn.disabled = false; btn.textContent = 'Get Odds';
    }
  }
```

(e) **Auto-refresh** (source lines 715–723): change `'On (5m)'` to `'On (10m)'` and `5*60*1000` to `10*60*1000`.

(f) **Replace** the fetch in `loadProps` (source lines 884–889) — the `url` const and fetch become:

```js
      const res = await fetch(`/api/props/${sportKey}/${game.id}`);
```
(delete the old `url` const line entirely; keep everything else in `loadProps` unchanged — the `markets` variable is still used by `buildPropsHtml`).

(g) **Delete** the screenshot/link section's screenshot half (source lines 1314–1371): the `dropZone`/`fileInput` consts and their four event listeners, `fileToBase64`, and `handleImageFile`. **Keep** the `linkAddBtn` handler (source lines 1373–1379).

(h) **Delete** `removeLastPendingManual` (source lines 1385–1388) — only screenshots used it. In `renderManual` (source lines 1389–1399), the `m.pending` spinner branch becomes dead; simplify the innerHTML line to:

```js
      div.innerHTML = `<div class="tagline">${escapeHtml(m.tagline)}</div><div>${body}</div>`;
```

(i) **Replace** the init block (source lines 1401–1417) with:

```js
  // ---------- init ----------
  renderSlip();
```

(j) `PROP_MARKETS`, `SPORTS`, `BOOK_STYLES`, `BOOK_LINKS` consts (source lines 474–523): keep verbatim — the client still needs them for rendering, labels, and links. (Server has its own authoritative copy of `PROP_MARKETS` for quota enforcement.)

- [ ] **Step 2: Verify no dead references or leaked key**

Run: `grep -nE 'apiKey|window\.storage|DEFAULT_KEY|anthropic|dropZone|fileInput|handleImageFile|fileToBase64|removeLastPendingManual|the-odds-api\.com' public/app.js`
Expected: no output.

- [ ] **Step 3: Smoke test locally**

Run: `npm start` (with `.env` holding the rotated key), open `http://localhost:3000`:
- Board loads with sport chips; click NBA or MLB chip → games render with book rows, Best tags.
- Click "Load player props" on one game → props table renders; Props tab shows the game.
- Add a board leg + a prop leg → slip shows 2 legs, parlay prices per book render.
- Click same sport chip again within 10 min → status line shows "cached X min ago" (or updated-just-now if <60s) and server console shows no second upstream call.
- Reference link paste → entry renders.

- [ ] **Step 4: Commit**

```bash
git grep 4256ff9b || git add public/app.js && git commit -m "feat: port frontend to server proxy; drop key handling and screenshot parser"
```

---

### Task 6: Delete prototype, add README, finish branch

**Files:**
- Delete: `linewatch_8.html`
- Create: `README.md`

**Interfaces:**
- Consumes: everything prior; this task finalizes the branch.

- [ ] **Step 1: Delete the prototype**

```bash
rm linewatch_8.html
```
(The live key inside it was never committed; after this the working tree is clean of it. User must still rotate the key at the-odds-api.com.)

- [ ] **Step 2: Create README.md**

```markdown
# LineWatch

Sports odds comparison: line-shop moneylines and player props across US
sportsbooks, spot value against the consensus fair line, and price parlays
per book. Informational only — no bets placed, no sportsbook accounts.

## Stack

Static frontend (`public/`) served by an Express proxy (`server.js`) that
holds The Odds API key server-side and caches responses for 10 minutes.

## Run locally

1. `npm install`
2. `cp .env.example .env` and set `ODDS_API_KEY` (free key at
   [the-odds-api.com](https://the-odds-api.com), 500 credits/month)
3. `npm start` → http://localhost:3000

## Tests

`npm test`

## Deploy (Railway)

Point Railway at this repo; it runs `npm start`. Set the `ODDS_API_KEY`
environment variable in the Railway dashboard. `PORT` is provided by
Railway automatically.

## Quota notes

- Moneyline pull ≈ 2 credits (2 US regions); props ≈ 12 credits per game.
- The 10-minute server cache is shared by all visitors — only cache
  misses spend credits.
```

- [ ] **Step 3: Run full test suite + key grep**

Run: `npm test && git grep 4256ff9b; echo "grep exit: $?"`
Expected: 10 tests pass; grep exit 1 (no match).

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore: remove prototype, add README"
```

- [ ] **Step 5: Merge decision** — use superpowers:finishing-a-development-branch skill (merge `repo-cleanup` → `main` or open PR on GitHub, given collaborator workflow).

---

## Post-plan verification (from spec)

1. Full local smoke test (Task 5 Step 3) passed.
2. `git grep 4256ff9b` clean on every commit.
3. After merge: push to GitHub, deploy on Railway with `ODDS_API_KEY` set, repeat smoke test on the public URL.
