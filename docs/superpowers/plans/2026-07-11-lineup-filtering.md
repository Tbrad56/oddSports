# Get Props Lineup Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Filter Get Props picks by MLB probable pitchers and posted lineups, flag batter picks made before lineups post, and fix the misleading empty-results message.

**Architecture:** All filtering happens server-side inside `handleAnalyze` using one cached MLB StatsAPI schedule call (`hydrate=probablePitcher,lineups`, 15-min TTL via the existing `fetchStats`). `analysis.js` is untouched — the new `lineup_unconfirmed` flag is appended to picks after `analyzeProp` returns. The analyze response gains `filtered`, `lineupStatus`, and `propCount`; `getprops.js` renders them.

**Tech Stack:** existing (Express 4, node:test + supertest, vanilla JS).

**Spec:** `docs/superpowers/specs/2026-07-11-lineup-filtering-design.md`. Branch: `lineup-filtering`.

## Global Constraints

- Filtering is an enhancement, never a blocker: any schedule failure or unmatched game → analysis proceeds unfiltered with `lineupStatus: 'unavailable'`.
- Schedule call exact: `/api/v1/schedule?sportId=1&date=<YYYY-MM-DD UTC>&hydrate=probablePitcher,lineups`, TTL `15*60*1000`, via existing `fetchStats`.
- AMENDED during execution (review findings): date is the America/New_York game day via toLocaleDateString('en-CA'), not UTC; filteredMap is keyed player+market with {player, reason} values, deduped by player+reason on emit.
- Verified StatsAPI shapes: probables at `game.teams.{home,away}.probablePitcher.id`; lineups at `game.lineups.homePlayers[]/awayPlayers[]` with `{id}`; arrays absent/empty until posted.
- `lineupStatus` values exact: `'confirmed'` (lineups posted), `'pending'` (game matched, lineups not posted), `'unavailable'` (schedule failed / game unmatched).
- Filter reasons exact: `'not_probable_starter'` (pitching market, probables known, player not among them), `'not_in_lineup'` (hitting market, lineups posted, player absent).
- `lineup_unconfirmed` flag ONLY when `lineupStatus === 'pending'` and market group is hitting.
- `analysis.js` and all existing 25 tests untouched and passing.
- Client empty-state copy exact: `propCount === 0` → `No props posted for this game yet — books usually post player props closer to game time.`; otherwise → `No edges ≥ 3% found in this game's props.`
- Commit guard: stage, then `! git diff --cached | grep -q 4256ff9b`, then commit.

---

### Task 1: Server — schedule-based filtering in handleAnalyze

**Files:**
- Modify: `server.js` (only inside `handleAnalyze`)
- Test: `test/server.test.js` (append)

**Interfaces:**
- Consumes: existing `fetchStats(path, ttlMs)`, `normName(s)`, `mlbPlayerId`, `MLB_MARKET_STATS` (has `.group`), `analyzeProp`, `rankPicks`, `routedFetch`/`okResponse`/`errResponse` test helpers.
- Produces (Task 2 consumes): analyze response `{picks, skipped, filtered:[{player,reason}], lineupStatus, propCount, generatedAt}`.

- [ ] **Step 1: Append failing tests to test/server.test.js**

```js
// ---------- lineup filtering ----------
const LINEUP_PROPS_BODY = {
  id: 'ev2', home_team: 'Home Nine', away_team: 'Away Nine',
  bookmakers: [{
    key: 'fanduel', title: 'FanDuel',
    markets: [
      { key: 'pitcher_strikeouts', outcomes: [
        { name: 'Over',  description: 'Test Pitcher',  point: 5.5, price: -110 },
        { name: 'Under', description: 'Test Pitcher',  point: 5.5, price: -110 },
        { name: 'Over',  description: 'Bench Pitcher', point: 4.5, price: -110 },
        { name: 'Under', description: 'Bench Pitcher', point: 4.5, price: -110 }
      ]},
      { key: 'batter_hits', outcomes: [
        { name: 'Over',  description: 'Lineup Batter', point: 0.5, price: -110 },
        { name: 'Under', description: 'Lineup Batter', point: 0.5, price: -110 },
        { name: 'Over',  description: 'Bench Batter',  point: 0.5, price: -110 },
        { name: 'Under', description: 'Bench Batter',  point: 0.5, price: -110 }
      ]}
    ]
  }]
};
const LINEUP_PLAYERS_BODY = { people: [
  { id: 660271, fullName: 'Test Pitcher' },
  { id: 999,    fullName: 'Bench Pitcher' },
  { id: 111,    fullName: 'Lineup Batter' },
  { id: 333,    fullName: 'Bench Batter' }
]};
const COMBO_GAMELOG_BODY = { stats: [{ splits: Array(10).fill(0).map(() => ({
  stat: { strikeOuts: 8, gamesStarted: 1, hits: 2, totalBases: 3, rbi: 1, homeRuns: 0 }
})) }] };
function scheduleBody(lineupsPosted, homeName = 'Home Nine', awayName = 'Away Nine'){
  return { dates: [{ games: [{
    teams: {
      home: { team: { name: homeName }, probablePitcher: { id: 660271, fullName: 'Test Pitcher' } },
      away: { team: { name: awayName } }
    },
    lineups: lineupsPosted
      ? { homePlayers: [{ id: 111 }, { id: 112 }], awayPlayers: [{ id: 222 }] }
      : {}
  }] }] };
}
function lineupApp(scheduleResp){
  const f = routedFetch([
    ['api.the-odds-api.com', okResponse(LINEUP_PROPS_BODY)],
    ['/api/v1/schedule', scheduleResp],
    ['/api/v1/sports/1/players', okResponse(LINEUP_PLAYERS_BODY)],
    ['/api/v1/people/', okResponse(COMBO_GAMELOG_BODY)]
  ]);
  return { app: createApp({ apiKey: 'k', fetchFn: f }), f };
}

test('lineups posted: bench pitcher and bench batter filtered with reasons', async () => {
  const { app } = lineupApp(okResponse(scheduleBody(true)));
  const res = await request(app).get('/api/analyze/mlb/ev2');
  assert.equal(res.status, 200);
  assert.equal(res.body.lineupStatus, 'confirmed');
  assert.equal(res.body.propCount, 4);
  const pickNames = res.body.picks.map(p => p.player).sort();
  assert.deepEqual(pickNames, ['Lineup Batter', 'Test Pitcher']);
  const reasons = Object.fromEntries(res.body.filtered.map(f => [f.player, f.reason]));
  assert.equal(reasons['Bench Pitcher'], 'not_probable_starter');
  assert.equal(reasons['Bench Batter'], 'not_in_lineup');
  res.body.picks.forEach(p => assert.ok(!p.analysis.flags.includes('lineup_unconfirmed')));
});

test('lineups pending: batters analyzed with lineup_unconfirmed flag, bench pitcher still filtered', async () => {
  const { app } = lineupApp(okResponse(scheduleBody(false)));
  const res = await request(app).get('/api/analyze/mlb/ev2');
  assert.equal(res.body.lineupStatus, 'pending');
  const byName = Object.fromEntries(res.body.picks.map(p => [p.player, p]));
  assert.ok(byName['Lineup Batter'].analysis.flags.includes('lineup_unconfirmed'));
  assert.ok(byName['Bench Batter'].analysis.flags.includes('lineup_unconfirmed'));
  assert.ok(!byName['Test Pitcher'].analysis.flags.includes('lineup_unconfirmed'));
  assert.equal(res.body.filtered.length, 1);
  assert.equal(res.body.filtered[0].player, 'Bench Pitcher');
});

test('schedule failure: analysis unfiltered, lineupStatus unavailable', async () => {
  const { app } = lineupApp(errResponse(500));
  const res = await request(app).get('/api/analyze/mlb/ev2');
  assert.equal(res.status, 200);
  assert.equal(res.body.lineupStatus, 'unavailable');
  assert.equal(res.body.filtered.length, 0);
  assert.equal(res.body.picks.length, 4);
  res.body.picks.forEach(p => assert.ok(!p.analysis.flags.includes('lineup_unconfirmed')));
});

test('unmatched team names: same as unavailable', async () => {
  const { app } = lineupApp(okResponse(scheduleBody(true, 'Other Club', 'Different Club')));
  const res = await request(app).get('/api/analyze/mlb/ev2');
  assert.equal(res.body.lineupStatus, 'unavailable');
  assert.equal(res.body.filtered.length, 0);
  assert.equal(res.body.picks.length, 4);
});
```

- [ ] **Step 2: Run, verify the 4 new tests fail**

Run: `npm test`
Expected: 4 new tests FAIL (`lineupStatus` undefined / picks length 4 vs 2 etc.), existing 25 pass.
(Note: the pre-existing analyze tests don't route `/api/v1/schedule`. `routedFetch` throws on unrouted URLs, which `fetchStats` catches as `{kind:'stats'}` — but the schedule call must be caught by the new enhancement try/catch so those tests keep passing with `lineupStatus:'unavailable'`. If any old analyze test fails after Step 3, the schedule call is not properly inside the enhancement try/catch.)

- [ ] **Step 3: Modify handleAnalyze in server.js**

(a) After the props fetch + `grouped` construction, before the picks loop, insert:

```js
    const propCount = Object.keys(grouped).length;

    // ---- lineup / probable-starter context (enhancement — never blocks analysis) ----
    let lineupStatus = 'unavailable';
    const probablePitcherIds = new Set();
    const lineupIds = new Set();
    let lineupsPosted = false;
    try {
      const dateStr = new Date(now()).toISOString().slice(0, 10);
      const sched = await fetchStats(`/api/v1/schedule?sportId=1&date=${dateStr}&hydrate=probablePitcher,lineups`, 15 * 60 * 1000);
      const home = normName(props.body.home_team || '');
      const away = normName(props.body.away_team || '');
      const games = ((sched.dates || [])[0] || {}).games || [];
      const match = games.find(g =>
        normName(g.teams?.home?.team?.name || '') === home &&
        normName(g.teams?.away?.team?.name || '') === away
      );
      if (match) {
        [match.teams?.home?.probablePitcher, match.teams?.away?.probablePitcher].forEach(p => {
          if (p && p.id) probablePitcherIds.add(p.id);
        });
        const homePlayers = match.lineups?.homePlayers || [];
        const awayPlayers = match.lineups?.awayPlayers || [];
        lineupsPosted = homePlayers.length > 0 && awayPlayers.length > 0;
        homePlayers.concat(awayPlayers).forEach(p => { if (p && p.id) lineupIds.add(p.id); });
        lineupStatus = lineupsPosted ? 'confirmed' : 'pending';
      }
    } catch (e) {
      lineupStatus = 'unavailable';
    }
```

(b) In the picks loop, immediately after `if (!pid) { skipped.add(prop.player); continue; }`, insert:

```js
        if (cfg.group === 'pitching' && probablePitcherIds.size && !probablePitcherIds.has(pid)) {
          filteredMap.set(prop.player, 'not_probable_starter');
          continue;
        }
        if (cfg.group === 'hitting' && lineupsPosted && !lineupIds.has(pid)) {
          filteredMap.set(prop.player, 'not_in_lineup');
          continue;
        }
```

and declare `const filteredMap = new Map();` next to `const skipped = new Set();`.

(c) Where a pick is accepted (`if (pick) picks.push(pick);`), replace with:

```js
        if (pick) {
          if (cfg.group === 'hitting' && lineupStatus === 'pending') {
            pick.analysis.flags.push('lineup_unconfirmed');
          }
          picks.push(pick);
        }
```

(d) Response object becomes:

```js
    const body = {
      picks: rankPicks(picks),
      skipped: [...skipped],
      filtered: [...filteredMap].map(([player, reason]) => ({ player, reason })),
      lineupStatus,
      propCount,
      generatedAt: new Date(now()).toISOString()
    };
```

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: 29 pass (25 existing + 4 new), 0 fail. Pay special attention that the three pre-existing analyze tests still pass (their fixture routes lack `/api/v1/schedule` — the enhancement try/catch must absorb that).

- [ ] **Step 5: Commit**

```bash
git add server.js test/server.test.js && ! git diff --cached | grep -q 4256ff9b && git commit -m "feat: filter Get Props picks by probable pitchers and posted lineups"
```

---

### Task 2: Page — lineup status, flags, filtered list, empty-state fix

**Files:**
- Modify: `public/getprops.js` (inside `renderResults` and `flagChips` only)

**Interfaces:**
- Consumes: analyze response fields from Task 1 (`filtered`, `lineupStatus`, `propCount`); existing `escapeHtml`.

- [ ] **Step 1: Update flagChips labels map** — add one entry:

```js
    const labels = { thin_sample:['warn','Thin sample'], check_news:['warn','Check news'], one_sided:['info','One-sided line'], lineup_unconfirmed:['info','Lineup unconfirmed'] };
```

- [ ] **Step 2: Update renderResults** — replace the function's opening (the `if(!result.picks.length)` block) with:

```js
  function renderResults(game, result){
    let head = '';
    if(result.lineupStatus === 'confirmed'){
      head = `<div style="font-size:11.5px; color:var(--good); margin-bottom:8px;">Lineups posted ✓</div>`;
    } else if(result.lineupStatus === 'pending'){
      head = `<div style="font-size:11.5px; color:var(--warn); margin-bottom:8px;">Lineups pending — batter picks unconfirmed</div>`;
    }
    if(!result.picks.length){
      const msg = result.propCount === 0
        ? 'No props posted for this game yet — books usually post player props closer to game time.'
        : 'No edges ≥ 3% found in this game\'s props.';
      return head + `<span style="font-size:12.5px; color:var(--text-faint);">${msg}</span>`;
    }
    let html = head + `<table class="props-table"><thead><tr>
```

(the rest of the table construction is unchanged — only `let html = \`<table...\`` becomes `let html = head + \`<table...\``).

- [ ] **Step 3: Add the filtered-players line** — directly after the existing `result.skipped.length` block at the end of `renderResults`, insert:

```js
    if(result.filtered && result.filtered.length){
      html += `<div style="font-size:11px; color:var(--text-faint); margin-top:8px;">Not starting today: ${result.filtered.map(f=>escapeHtml(f.player)).join(', ')}</div>`;
    }
```

- [ ] **Step 4: Verify**

1. `node --check public/getprops.js` → exit 0.
2. `grep -n 'lineup_unconfirmed\|Lineups posted\|Not starting today\|No props posted' public/getprops.js` → all four present.
3. `npm test` → 29 pass (nothing server-side changed in this task; regression check).
4. Live (server restarted so new server.js is loaded; one analyze ≈12 credits unless cached): analyze a real game, confirm the lineup status line renders and, if pre-lineup, batter picks carry the "Lineup unconfirmed" chip.

- [ ] **Step 5: Commit**

```bash
git add public/getprops.js && ! git diff --cached | grep -q 4256ff9b && git commit -m "feat: show lineup status, unconfirmed flags, and filtered players on Get Props"
```

---

## Post-plan verification (from spec)

1. `npm test` — 29 pass.
2. Live: analyze a real game morning (pending) and evening (confirmed) — status line flips; a benched batter drops from picks after lineups post. (The evening check can wait for a natural revisit; don't spend credits solely for it.)
3. Merge via superpowers:finishing-a-development-branch (branch `lineup-filtering` → PR → main → Railway auto-deploy).
