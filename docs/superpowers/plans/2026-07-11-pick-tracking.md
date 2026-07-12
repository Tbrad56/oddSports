# Pick-Outcome Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically log every Get Props model pick, grade it against MLB game logs, and show the model's real track record on a new Record page.

**Architecture:** New `store.js` module: append-only JSONL persistence (Railway volume / `DATA_DIR`; memory-only when no dataDir — the test default) folded into an in-memory Map, plus pure `computeRecord` aggregation. `server.js`: logs picks at the end of fresh analyses, runs a 6-hourly grading sweep against the already-cached StatsAPI game logs, serves `GET /api/record`. New `record.html`/`record.js` page + nav entry.

**Tech Stack:** existing only (node:fs, Express 4, node:test + supertest, vanilla JS). Zero new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-11-pick-tracking-design.md`. Branch: `pick-tracking` (stacked on `lineup-filtering`). Current suite: 31 tests.

## Global Constraints

- Storage strictly append-only: pick records and grade records are separate appended lines; no file rewrites.
- Record shapes exact — Pick: `{type:'pick', id, ts, eventId, gameDate, matchup, player, mlbId, market, line, side, modelP, impliedP, edge, bestBook:{bookKey,odds}|null, flags}`; Grade: `{type:'grade', id, actual, result, gradedTs}`; `id` = `eventId|player|market|line|side`; `result ∈ 'hit'|'miss'|'push'|'void'`.
- Grading rules exact: Over hit ⇔ `actual > line`; Under hit ⇔ `actual < line`; push ⇔ `actual === line`; void when no game-log split for `gameDate` and that date is ≥ 2 days past (ET); otherwise remain pending. Grade eligibility: `gameDate` before today (ET), or same-day with pick `ts` > 8 h old.
- Hit rate and calibration exclude pushes and voids from the denominator.
- Buckets exact: `0-50` [0,0.5), `50-60` [0.5,0.6), `60-70` [0.6,0.7), `70+` [0.7,1.01).
- Store/grading failures never affect analyze responses or crash the process; StatsAPI failure during sweep leaves picks pending for the next sweep.
- `createApp` gains `{dataDir = null, enableSweep = false}`; `dataDir: null` → memory-only store (no fs) so existing tests are untouched. The entrypoint passes `dataDir: process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || './data'` and `enableSweep: true`. All sweep timers `.unref()`ed.
- Grading costs zero Odds API credits (StatsAPI only).
- `data/` gitignored.
- Commit guard: stage, then `! git diff --cached | grep -q 4256ff9b`, then commit.

---

### Task 1: store.js — persistence + aggregation, with unit tests

**Files:**
- Create: `store.js`
- Test: `test/store.test.js`

**Interfaces:**
- Produces (Task 2 consumes): `createStore({dataDir})` → `{logPick(pick)→bool, grade(id, actual, result, gradedTs)→bool, pending()→[], all()→[], file}`; `computeRecord(records)` → `{summary, buckets, byMarket, recent}` per the spec's `/api/record` shape.

- [ ] **Step 1: Write failing tests** — create `test/store.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore, computeRecord } = require('../store');

function tmpDir(){ return fs.mkdtempSync(path.join(os.tmpdir(), 'lw-store-')); }
function pick(over = {}){
  return {
    id: 'ev1|P One|batter_hits|0.5|Over', ts: '2026-07-11T18:00:00.000Z',
    eventId: 'ev1', gameDate: '2026-07-11', matchup: 'A @ B',
    player: 'P One', mlbId: 111, market: 'batter_hits', line: 0.5, side: 'Over',
    modelP: 0.65, impliedP: 0.5, edge: 0.15,
    bestBook: { bookKey: 'fanduel', odds: -110 }, flags: [],
    ...over
  };
}

test('logPick appends, dedupes, and survives reload', () => {
  const dir = tmpDir();
  const s1 = createStore({ dataDir: dir });
  assert.equal(s1.logPick(pick()), true);
  assert.equal(s1.logPick(pick()), false);            // dedupe
  assert.equal(fs.readFileSync(s1.file, 'utf8').trim().split('\n').length, 1);
  const s2 = createStore({ dataDir: dir });            // reload folds
  assert.equal(s2.all().length, 1);
  assert.equal(s2.all()[0].player, 'P One');
});

test('grade overlays in memory, appends a grade line, survives reload', () => {
  const dir = tmpDir();
  const s1 = createStore({ dataDir: dir });
  s1.logPick(pick());
  assert.equal(s1.grade(pick().id, 2, 'hit', '2026-07-12T12:00:00.000Z'), true);
  assert.equal(s1.grade(pick().id, 2, 'hit', '2026-07-12T12:00:00.000Z'), false); // already graded
  assert.equal(s1.pending().length, 0);
  assert.equal(fs.readFileSync(s1.file, 'utf8').trim().split('\n').length, 2);
  const s2 = createStore({ dataDir: dir });
  assert.equal(s2.all()[0].result, 'hit');
  assert.equal(s2.all()[0].actual, 2);
});

test('corrupt trailing line is skipped on load', () => {
  const dir = tmpDir();
  const s1 = createStore({ dataDir: dir });
  s1.logPick(pick());
  fs.appendFileSync(s1.file, '{"type":"pick","id":"trunc');
  const s2 = createStore({ dataDir: dir });
  assert.equal(s2.all().length, 1);
});

test('memory-only mode: no dataDir, no file, still dedupes', () => {
  const s = createStore({ dataDir: null });
  assert.equal(s.logPick(pick()), true);
  assert.equal(s.logPick(pick()), false);
  assert.equal(s.all().length, 1);
});

test('computeRecord: hit rate excludes pushes and voids; calibration gap', () => {
  const recs = [
    { ...pick({ id: 'a' }), modelP: 0.6, result: 'hit' },
    { ...pick({ id: 'b' }), modelP: 0.6, result: 'miss' },
    { ...pick({ id: 'c' }), modelP: 0.6, result: 'push' },
    { ...pick({ id: 'd' }), modelP: 0.6, result: 'void' },
    { ...pick({ id: 'e' }), modelP: 0.6 }               // pending
  ];
  const r = computeRecord(recs);
  assert.equal(r.summary.graded, 4);
  assert.equal(r.summary.pending, 1);
  assert.equal(r.summary.hits, 1);
  assert.equal(r.summary.misses, 1);
  assert.equal(r.summary.pushes, 1);
  assert.equal(r.summary.voids, 1);
  assert.equal(r.summary.hitRate, 0.5);                 // 1 of 2 scored
  assert.ok(Math.abs(r.summary.avgModelP - 0.6) < 1e-9);
  assert.ok(Math.abs(r.summary.calibrationGap - 0.1) < 1e-9);
});

test('computeRecord: bucket boundaries', () => {
  const recs = [
    { ...pick({ id: 'a' }), modelP: 0.49, result: 'hit' },
    { ...pick({ id: 'b' }), modelP: 0.50, result: 'miss' },
    { ...pick({ id: 'c' }), modelP: 0.69, result: 'hit' },
    { ...pick({ id: 'd' }), modelP: 0.70, result: 'hit' }
  ];
  const byRange = Object.fromEntries(computeRecord(recs).buckets.map(b => [b.range, b]));
  assert.equal(byRange['0-50'].n, 1);
  assert.equal(byRange['50-60'].n, 1);
  assert.equal(byRange['60-70'].n, 1);
  assert.equal(byRange['70+'].n, 1);
  assert.equal(byRange['70+'].actualRate, 1);
});

test('computeRecord: byMarket and recent (sorted by gradedTs desc, max 25)', () => {
  const recs = [];
  for (let i = 0; i < 30; i++) {
    recs.push({ ...pick({ id: 'p' + i }), market: i % 2 ? 'batter_hits' : 'pitcher_strikeouts',
      result: 'hit', gradedTs: `2026-07-${String(10 + (i % 20)).padStart(2, '0')}T00:00:00.000Z` });
  }
  const r = computeRecord(recs);
  assert.equal(r.byMarket.length, 2);
  assert.equal(r.recent.length, 25);
  assert.ok(r.recent[0].gradedTs >= r.recent[24].gradedTs);
});

test('empty store: nulls not NaNs', () => {
  const r = computeRecord([]);
  assert.equal(r.summary.hitRate, null);
  assert.equal(r.summary.avgModelP, null);
  assert.equal(r.summary.calibrationGap, null);
});
```

- [ ] **Step 2: Run, verify fail** — `npm test` → store tests FAIL (module not found), existing 31 pass.

- [ ] **Step 3: Create store.js**

```js
// Append-only pick/outcome store + record aggregation. JSONL on disk when
// dataDir is provided; memory-only otherwise (tests, or missing volume).
const fs = require('fs');
const path = require('path');

function createStore({ dataDir } = {}){
  const file = dataDir ? path.join(dataDir, 'picks.jsonl') : null;
  const picks = new Map(); // id -> pick record with grade overlay
  let warned = false;

  if (file) {
    try {
      if (fs.existsSync(file)) {
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          let rec;
          try { rec = JSON.parse(line); } catch (e) { console.error('store: skipping corrupt line'); continue; }
          if (rec.type === 'pick' && !picks.has(rec.id)) {
            picks.set(rec.id, rec);
          } else if (rec.type === 'grade' && picks.has(rec.id)) {
            Object.assign(picks.get(rec.id), { actual: rec.actual, result: rec.result, gradedTs: rec.gradedTs });
          }
        }
      }
    } catch (e) {
      console.error(`store: load failed (${e.message}) — starting empty`);
    }
  }

  function append(rec){
    if (!file) return;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.appendFileSync(file, JSON.stringify(rec) + '\n');
    } catch (e) {
      if (!warned) console.error(`store: write failed (${e.message}) — continuing in-memory only`);
      warned = true;
    }
  }

  function logPick(p){
    if (picks.has(p.id)) return false;
    const rec = { type: 'pick', ...p };
    picks.set(p.id, rec);
    append(rec);
    return true;
  }

  function grade(id, actual, result, gradedTs){
    const rec = picks.get(id);
    if (!rec || rec.result) return false;
    Object.assign(rec, { actual, result, gradedTs });
    append({ type: 'grade', id, actual, result, gradedTs });
    return true;
  }

  return {
    logPick,
    grade,
    pending: () => [...picks.values()].filter(r => !r.result),
    all: () => [...picks.values()],
    file
  };
}

function computeRecord(records){
  const graded = records.filter(r => r.result);
  const scored = graded.filter(r => r.result === 'hit' || r.result === 'miss');
  const hits = scored.filter(r => r.result === 'hit').length;
  const avg = (rs, f) => rs.length ? rs.reduce((a, r) => a + f(r), 0) / rs.length : null;
  const summary = {
    graded: graded.length,
    pending: records.length - graded.length,
    hits,
    misses: scored.length - hits,
    pushes: graded.filter(r => r.result === 'push').length,
    voids: graded.filter(r => r.result === 'void').length,
    hitRate: scored.length ? hits / scored.length : null,
    avgModelP: avg(scored, r => r.modelP)
  };
  summary.calibrationGap = summary.hitRate === null ? null : summary.avgModelP - summary.hitRate;

  const bucketDefs = [['0-50', 0, 0.5], ['50-60', 0.5, 0.6], ['60-70', 0.6, 0.7], ['70+', 0.7, 1.01]];
  const buckets = bucketDefs.map(([range, lo, hi]) => {
    const rs = scored.filter(r => r.modelP >= lo && r.modelP < hi);
    const h = rs.filter(r => r.result === 'hit').length;
    return { range, n: rs.length, avgModelP: avg(rs, r => r.modelP), actualRate: rs.length ? h / rs.length : null };
  });

  const markets = {};
  scored.forEach(r => {
    const m = markets[r.market] || (markets[r.market] = { market: r.market, n: 0, hits: 0, sumP: 0 });
    m.n++; m.sumP += r.modelP; if (r.result === 'hit') m.hits++;
  });
  const byMarket = Object.values(markets).map(m => ({
    market: m.market, n: m.n, hitRate: m.hits / m.n, avgModelP: m.sumP / m.n
  }));

  const recent = graded.slice()
    .sort((a, b) => String(b.gradedTs || '').localeCompare(String(a.gradedTs || '')))
    .slice(0, 25);

  return { summary, buckets, byMarket, recent };
}

module.exports = { createStore, computeRecord };
```

- [ ] **Step 4: Run, verify pass** — `npm test` → 39 pass (31 + 8), 0 fail.

- [ ] **Step 5: Commit**

```bash
git add store.js test/store.test.js && ! git diff --cached | grep -q 4256ff9b && git commit -m "feat: append-only pick store with record aggregation"
```

---

### Task 2: Server — pick logging, grading sweep, /api/record

**Files:**
- Modify: `server.js`
- Test: `test/server.test.js` (append)

**Interfaces:**
- Consumes: `createStore`, `computeRecord` (Task 1); existing `mlbGameValues`, `MLB_MARKET_STATS`, `fetchStats`, analyze flow internals.
- Produces (Task 3 consumes): `GET /api/record` → `computeRecord` shape. Test hooks: `app.locals.store`, `app.locals.gradePendingPicks`.

- [ ] **Step 1: Wire the store into createApp**

Top of server.js: `const { createStore, computeRecord } = require('./store');`
Signature: `createApp({ apiKey, fetchFn = fetch, cacheTtlMs = 10 * 60 * 1000, now = Date.now, dataDir = null, enableSweep = false } = {})`.
Inside `createApp`, next to the caches: `const store = createStore({ dataDir });`

- [ ] **Step 2: Add `date` to game-log values** — in `mlbGameValues`, the mapped object gains the split's date:

```js
    return splits.slice().reverse().map(s => ({
      value: Number((s.stat || {})[statName] || 0),
      started: Number((s.stat || {}).gamesStarted || 0) > 0,
      date: s.date
    }));
```

- [ ] **Step 3: Log picks in handleAnalyze**

(a) Hoist the ET date (the lineup block currently computes `dateStr` locally): immediately after `const propCount = ...`, add
```js
    const etDate = new Date(now()).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
```
and change the lineup block's `const dateStr = ...` line to use `etDate` (delete the local computation, use `etDate` in the schedule path).

(b) In the picks loop, collect resolved MLB ids: declare `const pickMlbIds = new Map();` next to `filteredMap`, and immediately after the `if (!pid) {...}` skip add `pickMlbIds.set(prop.player, pid);`

(c) After the `body` object is built and BEFORE `analysisCache.set(...)`, insert:

```js
    try {
      for (const p of body.picks) {
        store.logPick({
          id: `${eventId}|${p.player}|${p.market}|${p.line}|${p.side}`,
          ts: new Date(now()).toISOString(),
          eventId,
          gameDate: etDate,
          matchup: `${props.body.away_team || ''} @ ${props.body.home_team || ''}`,
          player: p.player, mlbId: pickMlbIds.get(p.player) || null,
          market: p.market, line: p.line, side: p.side,
          modelP: p.modelP, impliedP: p.impliedP, edge: p.edge,
          bestBook: p.bestBook ? { bookKey: p.bestBook.bookKey, odds: p.bestBook.odds } : null,
          flags: p.analysis.flags
        });
      }
    } catch (e) {
      console.error(`store: logging failed (${e.message})`);
    }
```

(Cache-hit responses return earlier and never reach this — logged once per fresh analysis.)

- [ ] **Step 4: Add the grading sweep + record route** (below the analyze route, above `express.static`):

```js
  async function gradePendingPicks(){
    const todayET = new Date(now()).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    for (const p of store.pending()) {
      if (!p.gameDate || !p.mlbId) continue;
      const cfg = MLB_MARKET_STATS[p.market];
      if (!cfg) continue;
      const daysPast = (Date.parse(todayET) - Date.parse(p.gameDate)) / 86400000;
      const sameDayOld = p.gameDate === todayET && (now() - Date.parse(p.ts)) > 8 * 60 * 60 * 1000;
      if (daysPast < 1 && !sameDayOld) continue;
      let games;
      try {
        games = await mlbGameValues(p.mlbId, cfg.group, cfg.stat, new Date(Date.parse(p.gameDate)).getFullYear());
      } catch (e) {
        continue; // StatsAPI down — retry next sweep
      }
      const split = games.find(g => g.date === p.gameDate);
      const gradedTs = new Date(now()).toISOString();
      if (!split) {
        if (daysPast >= 2) store.grade(p.id, null, 'void', gradedTs);
        continue;
      }
      const actual = split.value;
      let result;
      if (actual === p.line) result = 'push';
      else if (p.side === 'Over') result = actual > p.line ? 'hit' : 'miss';
      else result = actual < p.line ? 'hit' : 'miss';
      store.grade(p.id, actual, result, gradedTs);
    }
  }

  if (enableSweep) {
    const boot = setTimeout(() => gradePendingPicks().catch(e => console.error(`sweep failed: ${e.message}`)), 60 * 1000);
    boot.unref();
    const interval = setInterval(() => gradePendingPicks().catch(e => console.error(`sweep failed: ${e.message}`)), 6 * 60 * 60 * 1000);
    interval.unref();
  }

  app.get('/api/record', (req, res) => {
    res.json(computeRecord(store.all()));
  });

  app.locals.store = store;
  app.locals.gradePendingPicks = gradePendingPicks;
```

- [ ] **Step 5: Entrypoint** — in the `require.main === module` block, `createApp({ apiKey: process.env.ODDS_API_KEY })` becomes:

```js
  createApp({
    apiKey: process.env.ODDS_API_KEY,
    dataDir: process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || './data',
    enableSweep: true
  }).listen(port, () => {
```

- [ ] **Step 6: Append endpoint/integration tests to test/server.test.js**

```js
// ---------- pick tracking ----------
const os = require('os');
const path = require('path');

const DATED_GAMELOG_BODY = { stats: [{ splits: [
  { date: '2026-07-09', stat: { strikeOuts: 4, gamesStarted: 1, hits: 1, totalBases: 1, rbi: 0, homeRuns: 0 } },
  { date: '2026-07-10', stat: { strikeOuts: 8, gamesStarted: 1, hits: 2, totalBases: 3, rbi: 1, homeRuns: 0 } }
] }] };

test('analyze logs picks once (cached second call logs nothing)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-track-'));
  const f = routedFetch([
    ['api.the-odds-api.com', okResponse(ANALYZE_PROPS_BODY)],
    ['/api/v1/schedule', errResponse(500)],
    ['/api/v1/sports/1/players', okResponse(PLAYERS_BODY)],
    ['/api/v1/people/', okResponse(GAMELOG_BODY)]
  ]);
  const app = createApp({ apiKey: 'k', fetchFn: f, dataDir: dir });
  await request(app).get('/api/analyze/mlb/ev1');
  await request(app).get('/api/analyze/mlb/ev1');
  const lines = fs.readFileSync(path.join(dir, 'picks.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1); // one pick from ev1, logged once
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.type, 'pick');
  assert.equal(rec.player, 'Test Pitcher');
  assert.equal(rec.mlbId, 660271);
  assert.ok(rec.gameDate);
});

test('grading sweep grades a past Over pick as hit and appends a grade line', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-track-'));
  const f = routedFetch([
    ['/api/v1/people/', okResponse(DATED_GAMELOG_BODY)]
  ]);
  // fixed clock: 2026-07-12 noon ET
  const app = createApp({ apiKey: 'k', fetchFn: f, dataDir: dir, now: () => Date.parse('2026-07-12T16:00:00Z') });
  app.locals.store.logPick({
    id: 'evX|Test Pitcher|pitcher_strikeouts|5.5|Over', ts: '2026-07-10T18:00:00.000Z',
    eventId: 'evX', gameDate: '2026-07-10', matchup: 'A @ B',
    player: 'Test Pitcher', mlbId: 660271, market: 'pitcher_strikeouts', line: 5.5, side: 'Over',
    modelP: 0.6, impliedP: 0.5, edge: 0.1, bestBook: { bookKey: 'fanduel', odds: -110 }, flags: []
  });
  await app.locals.gradePendingPicks();
  const res = await request(app).get('/api/record');
  assert.equal(res.body.summary.graded, 1);
  assert.equal(res.body.summary.hits, 1);   // 8 Ks on 2026-07-10 > 5.5
  assert.equal(res.body.recent[0].actual, 8);
  const lines = fs.readFileSync(path.join(dir, 'picks.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2); // pick + grade
});

test('grading sweep voids a pick with no game-log split after 2 days', async () => {
  const f = routedFetch([[ '/api/v1/people/', okResponse(DATED_GAMELOG_BODY) ]]);
  const app = createApp({ apiKey: 'k', fetchFn: f, now: () => Date.parse('2026-07-12T16:00:00Z') });
  app.locals.store.logPick({
    id: 'evY|Test Pitcher|pitcher_strikeouts|5.5|Over', ts: '2026-07-08T18:00:00.000Z',
    eventId: 'evY', gameDate: '2026-07-08', matchup: 'A @ B',
    player: 'Test Pitcher', mlbId: 660271, market: 'pitcher_strikeouts', line: 5.5, side: 'Over',
    modelP: 0.6, impliedP: 0.5, edge: 0.1, bestBook: null, flags: []
  });
  await app.locals.gradePendingPicks();
  const res = await request(app).get('/api/record');
  assert.equal(res.body.summary.voids, 1);
});

test('record endpoint: empty store returns null rates', async () => {
  const app = createApp({ apiKey: 'k', fetchFn: async () => { throw new Error('no'); } });
  const res = await request(app).get('/api/record');
  assert.equal(res.status, 200);
  assert.equal(res.body.summary.graded, 0);
  assert.equal(res.body.summary.hitRate, null);
});
```

(Note: `fs` is already required in this test file? If not, add `const fs = require('fs');` with the other requires — check before adding a duplicate.)

- [ ] **Step 7: Run all tests** — `npm test` → 43 pass (39 + 4), 0 fail. Verify the three pre-existing analyze tests and four lineup tests still pass (they run with `dataDir: null` → memory-only store, no repo pollution).

- [ ] **Step 8: Commit**

```bash
git add server.js test/server.test.js && ! git diff --cached | grep -q 4256ff9b && git commit -m "feat: pick logging, grading sweep, and /api/record endpoint"
```

---

### Task 3: Record page + nav + housekeeping

**Files:**
- Create: `public/record.html`, `public/record.js`
- Modify: `public/common.js` (nav array), `.gitignore` (+`data/`), `README.md` (one paragraph)

**Interfaces:**
- Consumes: `GET /api/record` (Task 2 shape); common.js globals `renderNav`, `escapeHtml`, `fmtAmerican`, `marketLabel`, `fetchOddsFor`, `getSport`, `updateTicker`.

- [ ] **Step 1: Nav entry** — in `renderNav` items, insert between getprops and slip:

```js
    ['record','/record.html','📈','Record'],
```

- [ ] **Step 2: Create public/record.html** — same skeleton as slip.html (no autoBtn; title `LineWatch — Record`), 2-col `layout no-side`, with this `<main>`:

```html
  <main>
    <div class="hero-line">Model Record</div>
    <div class="hero-sub">Every Get Props pick is logged automatically and graded against real box scores — this is how honest the model actually is.</div>
    <div id="errorArea"></div>
    <div id="recordArea">
      <div class="empty-state"><h3>Loading…</h3></div>
    </div>
  </main>
```

Scripts: `common.js` then `record.js`. Footer identical to the other pages.

- [ ] **Step 3: Create public/record.js**

```js
(function(){
  renderNav('record');

  function pct(p){ return p === null || p === undefined ? '—' : (p*100).toFixed(1) + '%'; }
  const RESULT_CHIP = { hit: ['good','✓ Hit'], miss: ['bad','✗ Miss'], push: ['dim','— Push'], void: ['dim','∅ Void'] };

  async function load(){
    try{
      const res = await fetch('/api/record');
      if(!res.ok) throw new Error('Error ' + res.status);
      render(await res.json());
    }catch(e){
      showError(e.message || 'Could not load record.');
      document.getElementById('recordArea').innerHTML = '';
    }
  }

  function render(r){
    const area = document.getElementById('recordArea');
    const s = r.summary;
    if(!s.graded && !s.pending){
      area.innerHTML = `<div class="empty-state"><h3>No picks logged yet</h3>
        <p>Analyses log automatically — run "Analyze props" on the <a href="/getprops.html">Get Props page</a> and results appear here the day after the games.</p></div>`;
      return;
    }
    let html = `<div class="panel" style="margin-bottom:14px;">
      <h2>Calibration</h2>
      <div style="font-size:14px; line-height:1.7;">
        Model said <strong style="font-family:var(--font-mono);">${pct(s.avgModelP)}</strong> on average —
        reality delivered <strong style="font-family:var(--font-mono); color:${s.calibrationGap > 0.05 ? 'var(--bad)' : 'var(--good)'};">${pct(s.hitRate)}</strong>
        <span style="color:var(--text-faint); font-size:12px;">(${s.hits}–${s.misses} over ${s.graded} graded · ${s.pushes} pushes · ${s.voids} voids · ${s.pending} pending)</span>
      </div>
    </div>`;

    html += `<div class="panel" style="margin-bottom:14px;"><h2>By model confidence</h2>
      <table class="props-table"><thead><tr><th>Model said</th><th>Picks</th><th>Avg model</th><th>Actual</th></tr></thead><tbody>`;
    r.buckets.forEach(b => {
      html += `<tr><td>${escapeHtml(b.range)}%</td><td>${b.n}</td>
        <td style="font-family:var(--font-mono);">${pct(b.avgModelP)}</td>
        <td style="font-family:var(--font-mono);">${pct(b.actualRate)}</td></tr>`;
    });
    html += `</tbody></table></div>`;

    if(r.byMarket.length){
      html += `<div class="panel" style="margin-bottom:14px;"><h2>By market</h2>
        <table class="props-table"><thead><tr><th>Market</th><th>Picks</th><th>Avg model</th><th>Hit rate</th></tr></thead><tbody>`;
      r.byMarket.forEach(m => {
        html += `<tr><td>${escapeHtml(marketLabel(m.market))}</td><td>${m.n}</td>
          <td style="font-family:var(--font-mono);">${pct(m.avgModelP)}</td>
          <td style="font-family:var(--font-mono);">${pct(m.hitRate)}</td></tr>`;
      });
      html += `</tbody></table></div>`;
    }

    if(r.recent.length){
      html += `<div class="panel"><h2>Recent results</h2>
        <table class="props-table"><thead><tr><th>Result</th><th>Player</th><th>Pick</th><th>Model</th><th>Actual</th><th>Game</th></tr></thead><tbody>`;
      r.recent.forEach(p => {
        const [cls, label] = RESULT_CHIP[p.result] || ['dim', p.result];
        const color = cls === 'good' ? 'var(--good)' : cls === 'bad' ? 'var(--bad)' : 'var(--text-faint)';
        html += `<tr>
          <td style="color:${color}; font-weight:700; white-space:nowrap;">${escapeHtml(label)}</td>
          <td style="font-weight:600; white-space:nowrap;">${escapeHtml(p.player)}</td>
          <td style="white-space:nowrap;">${escapeHtml(p.side)} ${escapeHtml(String(p.line))} ${escapeHtml(marketLabel(p.market))}</td>
          <td style="font-family:var(--font-mono);">${pct(p.modelP)}</td>
          <td style="font-family:var(--font-mono);">${p.actual === null || p.actual === undefined ? '—' : escapeHtml(String(p.actual))}</td>
          <td style="color:var(--text-faint); font-size:11px; white-space:nowrap;">${escapeHtml(p.matchup)} · ${escapeHtml(p.gameDate)}</td>
        </tr>`;
      });
      html += `</tbody></table></div>`;
    }

    area.innerHTML = html;
  }

  load();

  fetchOddsFor(getSport()).then(r => updateTicker(r.games)).catch(()=>{});
})();
```

- [ ] **Step 4: .gitignore** — append line: `data/`

- [ ] **Step 5: README** — after the Get Props paragraph, append:

```markdown
Every Get Props pick is logged and auto-graded against MLB box scores; the
Record page shows the model's real calibration. Data persists on a Railway
volume (`RAILWAY_VOLUME_MOUNT_PATH`) or `DATA_DIR` (default `./data`) locally.
```

- [ ] **Step 6: Verify**

1. `node --check public/record.js` and `node --check public/common.js` → exit 0.
2. Id cross-check record.js vs record.html (`recordArea`, `errorArea`, `navRail`, `tickerTrack`).
3. `npm test` → 43 pass.
4. Live: restart local server (`DATA_DIR` defaults to `./data`), open `/record.html` → empty state renders; run one analyze on a cached game (free) → record page shows pending count ≥ 1.
5. `git status` → `data/` not listed (ignored).

- [ ] **Step 7: Commit**

```bash
git add public/record.html public/record.js public/common.js .gitignore README.md && ! git diff --cached | grep -q 4256ff9b && git commit -m "feat: Record page with model calibration and recent results"
```

---

## Post-plan verification (from spec)

1. `npm test` — 43 pass.
2. Live: analyze → pick appears pending on Record page; after attaching the Railway volume and deploying, verify picks survive a redeploy (analyze, redeploy, `/api/record` still shows the pick).
3. USER STEP at ship time: Railway → service → Settings → Volumes → attach volume, mount path `/data`.
4. Merge via superpowers:finishing-a-development-branch (branch `pick-tracking`, stacked on `lineup-filtering` — merge order: lineup-filtering PR first).
