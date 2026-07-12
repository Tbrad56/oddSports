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

test('upstream malformed JSON maps to 502, not a crash', async () => {
  const f = fakeFetch(() => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => { throw new SyntaxError('Unexpected token < in JSON'); }
  }));
  const app = createApp({ apiKey: 'k', fetchFn: f });
  const res = await request(app).get('/api/odds/basketball_nba');
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'Odds service unavailable');
});

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

// ---------- /api/analyze/mlb ----------
function routedFetch(routes){
  const fn = async (url) => {
    fn.calls.push(url);
    for (const [substr, resp] of routes) {
      if (url.includes(substr)) return typeof resp === 'function' ? resp(url) : resp;
    }
    throw new Error('unrouted url: ' + url);
  };
  fn.calls = [];
  return fn;
}

const ANALYZE_PROPS_BODY = {
  id: 'ev1',
  bookmakers: [{
    key: 'fanduel', title: 'FanDuel',
    markets: [{
      key: 'pitcher_strikeouts',
      outcomes: [
        { name: 'Over',  description: 'Test Pitcher', point: 5.5, price: -110 },
        { name: 'Under', description: 'Test Pitcher', point: 5.5, price: -110 },
        { name: 'Over',  description: 'Unknown Guy',  point: 4.5, price: -110 },
        { name: 'Under', description: 'Unknown Guy',  point: 4.5, price: -110 }
      ]
    }]
  }]
};
const PLAYERS_BODY = { people: [{ id: 660271, fullName: 'Test Pitcher' }] };
const GAMELOG_BODY = { stats: [{ splits: Array(10).fill(0).map(() => ({ stat: { strikeOuts: 8, gamesStarted: 1 } })) }] };

function analyzeApp(overrides = {}){
  const f = routedFetch([
    ['api.the-odds-api.com', okResponse(ANALYZE_PROPS_BODY)],
    ['/api/v1/sports/1/players', okResponse(PLAYERS_BODY)],
    ['/api/v1/people/', okResponse(GAMELOG_BODY)],
    ...(overrides.routes || [])
  ]);
  if (overrides.prepend) f.prepend = true;
  const app = createApp({ apiKey: 'k', fetchFn: f, ...(overrides.opts || {}) });
  return { app, f };
}

test('analyze: bad event id -> 400, nothing fetched', async () => {
  const { app, f } = analyzeApp();
  const res = await request(app).get('/api/analyze/mlb/bad..id');
  assert.equal(res.status, 400);
  assert.equal(f.calls.length, 0);
});

test('analyze: returns ranked picks and skips unknown players', async () => {
  const { app } = analyzeApp();
  const res = await request(app).get('/api/analyze/mlb/ev1');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.picks));
  assert.equal(res.body.picks.length, 1); // 8 K/start vs 5.5 line -> big Over edge
  const pick = res.body.picks[0];
  assert.equal(pick.player, 'Test Pitcher');
  assert.equal(pick.market, 'pitcher_strikeouts');
  assert.equal(pick.side, 'Over');
  assert.ok(pick.edge > 0.03);
  assert.ok(pick.modelP > 0 && pick.modelP < 1);
  assert.ok(Math.abs(pick.edge - (pick.modelP - pick.impliedP)) < 1e-9);
  assert.equal(pick.analysis.windowSize, 10);
  assert.deepEqual(res.body.skipped, ['Unknown Guy']);
  assert.ok(res.body.generatedAt);
});

test('analyze: second call within TTL served from cache (no new fetches)', async () => {
  const { app, f } = analyzeApp();
  await request(app).get('/api/analyze/mlb/ev1');
  const n = f.calls.length;
  const res2 = await request(app).get('/api/analyze/mlb/ev1');
  assert.equal(res2.status, 200);
  assert.equal(f.calls.length, n);
});

test('analyze: StatsAPI failure -> 502 Stats service unavailable', async () => {
  const f = routedFetch([
    ['api.the-odds-api.com', okResponse(ANALYZE_PROPS_BODY)],
    ['/api/v1/sports/1/players', errResponse(500)],
  ]);
  const app = createApp({ apiKey: 'k', fetchFn: f });
  const res = await request(app).get('/api/analyze/mlb/ev1');
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'Stats service unavailable');
});

test('analyze: odds quota exhausted maps to 429 quota message', async () => {
  const f = routedFetch([['api.the-odds-api.com', errResponse(429)]]);
  const app = createApp({ apiKey: 'k', fetchFn: f });
  const res = await request(app).get('/api/analyze/mlb/ev1');
  assert.equal(res.status, 429);
  assert.equal(res.body.error, 'Monthly odds quota exhausted — resets on the 1st');
});

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

test('schedule date uses US Eastern game day, not UTC', async () => {
  // 2026-07-12T01:00:00Z is 9pm ET on 2026-07-11 — the MLB game day is still the 11th
  const { app, f } = (function(){
    const f2 = routedFetch([
      ['api.the-odds-api.com', okResponse(LINEUP_PROPS_BODY)],
      ['/api/v1/schedule', okResponse(scheduleBody(true))],
      ['/api/v1/sports/1/players', okResponse(LINEUP_PLAYERS_BODY)],
      ['/api/v1/people/', okResponse(COMBO_GAMELOG_BODY)]
    ]);
    return { app: createApp({ apiKey: 'k', fetchFn: f2, now: () => Date.parse('2026-07-12T01:00:00Z') }), f: f2 };
  })();
  await request(app).get('/api/analyze/mlb/ev2');
  const schedCall = f.calls.find(u => u.includes('/api/v1/schedule'));
  assert.ok(schedCall.includes('date=2026-07-11'), 'expected ET game day 2026-07-11, got: ' + schedCall);
});

test('filtered list dedupes a batter benched across multiple markets', async () => {
  const body = JSON.parse(JSON.stringify(LINEUP_PROPS_BODY));
  body.bookmakers[0].markets.push({ key: 'batter_total_bases', outcomes: [
    { name: 'Over',  description: 'Bench Batter', point: 1.5, price: -110 },
    { name: 'Under', description: 'Bench Batter', point: 1.5, price: -110 }
  ]});
  const f = routedFetch([
    ['api.the-odds-api.com', okResponse(body)],
    ['/api/v1/schedule', okResponse(scheduleBody(true))],
    ['/api/v1/sports/1/players', okResponse(LINEUP_PLAYERS_BODY)],
    ['/api/v1/people/', okResponse(COMBO_GAMELOG_BODY)]
  ]);
  const app = createApp({ apiKey: 'k', fetchFn: f });
  const res = await request(app).get('/api/analyze/mlb/ev2');
  const benchEntries = res.body.filtered.filter(x => x.player === 'Bench Batter');
  assert.equal(benchEntries.length, 1);
});

// ---------- pick tracking ----------
const fs = require('fs');
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
