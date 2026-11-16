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
function errResponse(status, body = {}) {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    json: async () => body
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
  const res = await request(app).get('/api/odds/basketball_madeup');
  assert.equal(res.status, 400);
  assert.equal(f.calls.length, 0);
});

test('proxies a valid sport, appends key upstream, passes body and quota header back', async () => {
  const games = [{ id: 'abc', home_team: 'A', away_team: 'B' }];
  const f = fakeFetch(() => okResponse(games, '123'));
  const app = createApp({ apiKey: 'sekret', fetchFn: f });
  const res = await request(app).get('/api/odds/soccer_epl');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, games);
  assert.equal(res.headers['x-requests-remaining'], '123');
  assert.equal(res.headers['x-cache-age-seconds'], '0');
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0], /^https:\/\/api\.the-odds-api\.com\/v4\/sports\/soccer_epl\/odds\/\?regions=us&markets=h2h&oddsFormat=american&includeLinks=true&includeSids=true&apiKey=sekret$/);
});

test('MLB odds request includes full-game spreads/totals in one call', async () => {
  const f = fakeFetch(() => okResponse([]));
  const app = createApp({ apiKey: 'k', fetchFn: f });
  const res = await request(app).get('/api/odds/baseball_mlb');
  assert.equal(res.status, 200);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0], /markets=h2h,spreads,totals&/);
});

test('MLB odds request omits F5 markets (bulk endpoint 422s the whole request if asked for them)', async () => {
  const f = fakeFetch(() => okResponse([]));
  const app = createApp({ apiKey: 'k', fetchFn: f });
  await request(app).get('/api/odds/baseball_mlb');
  assert.doesNotMatch(f.calls[0], /1st_5_innings/);
});

test('non-MLB odds request does not include F5 markets', async () => {
  const f = fakeFetch(() => okResponse([]));
  const app = createApp({ apiKey: 'k', fetchFn: f });
  const res = await request(app).get('/api/odds/basketball_nba');
  assert.equal(res.status, 200);
  assert.match(f.calls[0], /markets=h2h,spreads,totals&/);
  assert.doesNotMatch(f.calls[0], /1st_5_innings/);
});

test('NFL odds request includes full-game spreads/totals in one call, same as MLB', async () => {
  const f = fakeFetch(() => okResponse([]));
  const app = createApp({ apiKey: 'k', fetchFn: f });
  const res = await request(app).get('/api/odds/americanfootball_nfl');
  assert.equal(res.status, 200);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0], /markets=h2h,spreads,totals&/);
});

test('NHL/NBA/WNBA odds requests include full-game spreads/totals too (grid applies to them now)', async () => {
  for (const sport of ['icehockey_nhl', 'basketball_nba', 'basketball_wnba']) {
    const f = fakeFetch(() => okResponse([]));
    const app = createApp({ apiKey: 'k', fetchFn: f });
    const res = await request(app).get(`/api/odds/${sport}`);
    assert.equal(res.status, 200);
    assert.match(f.calls[0], /markets=h2h,spreads,totals&/);
  }
});

test('EPL/MMA odds requests stay moneyline-only (no reliable spreads market for either, verified live)', async () => {
  for (const sport of ['soccer_epl', 'mma_mixed_martial_arts']) {
    const f = fakeFetch(() => okResponse([]));
    const app = createApp({ apiKey: 'k', fetchFn: f });
    const res = await request(app).get(`/api/odds/${sport}`);
    assert.equal(res.status, 200);
    assert.match(f.calls[0], /markets=h2h&/);
  }
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

test('?cacheOnly=1 with nothing cached returns 204, never calls upstream', async () => {
  const f = fakeFetch(() => okResponse([{ id: 'x' }]));
  const app = createApp({ apiKey: 'k', fetchFn: f });
  const res = await request(app).get('/api/odds/basketball_nba?cacheOnly=1');
  assert.equal(res.status, 204);
  assert.equal(f.calls.length, 0, 'a decorative ticker fetch must never spend a real credit');
});

test('?cacheOnly=1 serves an existing cache hit without a fresh upstream call', async () => {
  let t = 1000000;
  const f = fakeFetch(() => okResponse([{ id: 'x' }], '77'));
  const app = createApp({ apiKey: 'k', fetchFn: f, cacheTtlMs: 600000, now: () => t });
  await request(app).get('/api/odds/basketball_nba'); // warms the cache (e.g. from Board)
  t += 90000;
  const res = await request(app).get('/api/odds/basketball_nba?cacheOnly=1');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, [{ id: 'x' }]);
  assert.equal(res.headers['x-cache-age-seconds'], '90');
  assert.equal(res.headers['x-requests-remaining'], '77');
  assert.equal(f.calls.length, 1, 'only the original warming call, not a second one for cacheOnly');
});

test('?cacheOnly=1 does not serve an expired cache entry — falls back to 204', async () => {
  let t = 1000000;
  const f = fakeFetch(() => okResponse([{ id: 'x' }]));
  const app = createApp({ apiKey: 'k', fetchFn: f, cacheTtlMs: 600000, now: () => t });
  await request(app).get('/api/odds/basketball_nba');
  t += 600001; // past TTL
  const res = await request(app).get('/api/odds/basketball_nba?cacheOnly=1');
  assert.equal(res.status, 204);
  assert.equal(f.calls.length, 1, 'expired cache must not trigger a fresh upstream call under cacheOnly');
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

test('upstream 401 OUT_OF_USAGE_CREDITS maps to quota message, not generic 502', async () => {
  // The Odds API signals an exhausted monthly quota with 401 + this error_code,
  // not with 429 — treat it the same as 429 so users see the real reason.
  const f = fakeFetch(() => errResponse(401, {
    message: 'Usage quota has been reached. See usage plans at https://the-odds-api.com',
    error_code: 'OUT_OF_USAGE_CREDITS'
  }));
  const app = createApp({ apiKey: 'k', fetchFn: f });
  const res = await request(app).get('/api/odds/basketball_nba');
  assert.equal(res.status, 429);
  assert.equal(res.body.error, 'Monthly odds quota exhausted — resets on the 1st');
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
  assert.match(f.calls[0], /\/v4\/sports\/basketball_nba\/events\/0a1b2c3d4e5f\/odds\/\?regions=us&markets=player_points,player_rebounds,player_assists,player_threes,player_points_rebounds_assists&oddsFormat=american&includeLinks=true&includeSids=true&apiKey=k$/);
});

test('props: empty bookmakers skips headshot resolution entirely (no extra fetches)', async () => {
  const payload = { id: 'e1', bookmakers: [] };
  const f = fakeFetch(() => okResponse(payload));
  const app = createApp({ apiKey: 'k', fetchFn: f });
  await request(app).get('/api/props/basketball_nba/0a1b2c3d4e5f');
  assert.equal(f.calls.length, 1, 'no team/roster lookups should fire when there are no player names to resolve');
});

test('props: MLB resolves a real headshot URL per matched player', async () => {
  const propsPayload = {
    id: 'ev1', home_team: 'Los Angeles Dodgers', away_team: 'Colorado Rockies',
    bookmakers: [{ key: 'draftkings', title: 'DraftKings', markets: [{ key: 'batter_home_runs',
      outcomes: [{ name: 'Over', description: 'Shohei Ohtani', price: 150, point: 0.5 }] }] }]
  };
  const f = routedFetch([
    ['/events/ev1/odds', okResponse(propsPayload)],
    ['/api/v1/sports/1/players', okResponse({ people: [{ id: 660271, fullName: 'Shohei Ohtani' }] })]
  ]);
  const app = createApp({ apiKey: 'k', fetchFn: f });
  const res = await request(app).get('/api/props/baseball_mlb/ev1');
  assert.equal(res.status, 200);
  assert.equal(res.body.headshots['shohei ohtani'], 'https://img.mlbstatic.com/mlb-photos/image/upload/w_180,q_100/v1/people/660271/headshot/67/current.png');
});

test('props: NBA resolves headshots via the two teams\' ESPN rosters, matched name-insensitively', async () => {
  const propsPayload = {
    id: 'ev2', home_team: 'Los Angeles Lakers', away_team: 'Boston Celtics',
    bookmakers: [{ key: 'fanduel', title: 'FanDuel', markets: [{ key: 'player_points',
      outcomes: [{ name: 'Over', description: 'Jayson Tatum', price: -110, point: 27.5 }] }] }]
  };
  const teamsPayload = { sports: [{ leagues: [{ teams: [
    { team: { id: '2', displayName: 'Boston Celtics', abbreviation: 'BOS', logos: [] } },
    { team: { id: '13', displayName: 'Los Angeles Lakers', abbreviation: 'LAL', logos: [] } }
  ] }] }] };
  const f = routedFetch([
    ['/events/ev2/odds', okResponse(propsPayload)],
    ['/teams?limit=32', okResponse(teamsPayload)],
    ['/teams/2/roster', okResponse({ athletes: [{ id: '4065648', displayName: 'Jayson Tatum', position: { abbreviation: 'SF' }, headshot: { href: 'https://a.espncdn.com/tatum.png' } }] })],
    ['/teams/13/roster', okResponse({ athletes: [] })]
  ]);
  const app = createApp({ apiKey: 'k', fetchFn: f });
  const res = await request(app).get('/api/props/basketball_nba/ev2');
  assert.equal(res.status, 200);
  assert.equal(res.body.headshots['jayson tatum'], 'https://a.espncdn.com/tatum.png');
});

test('props: NBA gracefully has no headshots if team/roster lookup fails (props still work)', async () => {
  const propsPayload = {
    id: 'ev3', home_team: 'Unknown Team', away_team: 'Also Unknown',
    bookmakers: [{ key: 'fanduel', title: 'FanDuel', markets: [{ key: 'player_points',
      outcomes: [{ name: 'Over', description: 'Some Player', price: -110, point: 10.5 }] }] }]
  };
  const f = routedFetch([
    ['/events/ev3/odds', okResponse(propsPayload)],
    ['/teams?limit=32', () => { throw new Error('ESPN unreachable'); }]
  ]);
  const app = createApp({ apiKey: 'k', fetchFn: f });
  const res = await request(app).get('/api/props/basketball_nba/ev3');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, propsPayload);
});

test('props-alt: fetches the {market}_alternate market for one game, opt-in', async () => {
  const altPayload = { id: 'ev4', bookmakers: [{ key: 'draftkings', title: 'DraftKings', markets: [{ key: 'batter_hits_alternate',
    outcomes: [{ name: 'Over', description: 'Shohei Ohtani', price: 200, point: 0.5 }, { name: 'Over', description: 'Shohei Ohtani', price: -150, point: 1.5 }] }] }] };
  const f = fakeFetch(() => okResponse(altPayload));
  const app = createApp({ apiKey: 'k', fetchFn: f });
  const res = await request(app).get('/api/props-alt/baseball_mlb/ev4/batter_hits');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, altPayload);
  assert.match(f.calls[0], /\/v4\/sports\/baseball_mlb\/events\/ev4\/odds\/\?regions=us&markets=batter_hits_alternate&oddsFormat=american&includeLinks=true&includeSids=true&apiKey=k$/);
});

test('props-alt: rejects a binary anytime-scorer market — no alternates exist', async () => {
  const f = fakeFetch(() => okResponse({}));
  const app = createApp({ apiKey: 'k', fetchFn: f });
  const res = await request(app).get('/api/props-alt/americanfootball_nfl/ev5/player_anytime_td');
  assert.equal(res.status, 400);
  assert.equal(f.calls.length, 0);
});

test('props-alt: rejects a market not offered for this sport', async () => {
  const f = fakeFetch(() => okResponse({}));
  const app = createApp({ apiKey: 'k', fetchFn: f });
  const res = await request(app).get('/api/props-alt/baseball_mlb/ev6/batter_walks');
  assert.equal(res.status, 400);
  assert.equal(f.calls.length, 0);
});

test('props-alt: rejects a malformed event id, nothing fetched', async () => {
  const f = fakeFetch(() => okResponse({}));
  const app = createApp({ apiKey: 'k', fetchFn: f });
  const res = await request(app).get('/api/props-alt/baseball_mlb/bad..id/batter_hits');
  assert.equal(res.status, 400);
  assert.equal(f.calls.length, 0);
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

// ---------- /api/scores/:sport ----------
test('scores: rejects unknown sport with 400, never calls upstream', async () => {
  const f = fakeFetch(() => okResponse([]));
  const app = createApp({ apiKey: 'k', fetchFn: f });
  const res = await request(app).get('/api/scores/basketball_madeup');
  assert.equal(res.status, 400);
  assert.equal(f.calls.length, 0);
});

test('scores: served free from ESPN scoreboard, normalized to the legacy shape', async () => {
  const espn = { events: [{
    id: 'e1', date: '2026-07-19T23:00Z',
    status: { type: { state: 'in', completed: false } },
    competitions: [{ competitors: [
      { homeAway: 'home', team: { displayName: 'Pittsburgh Pirates' }, score: '3' },
      { homeAway: 'away', team: { displayName: 'Milwaukee Brewers' }, score: '5' }
    ] }]
  }] };
  const f = fakeFetch(() => okResponse(espn));
  const app = createApp({ apiKey: 'sekret', fetchFn: f });
  const res = await request(app).get('/api/scores/baseball_mlb');
  assert.equal(res.status, 200);
  assert.match(f.calls[0], /^https:\/\/site\.api\.espn\.com\/apis\/site\/v2\/sports\/baseball\/mlb\/scoreboard$/);
  assert.ok(!f.calls[0].includes('sekret')); // no key ever sent to ESPN
  assert.deepEqual(res.body, [{
    id: 'e1', commence_time: '2026-07-19T23:00Z', completed: false,
    home_team: 'Pittsburgh Pirates', away_team: 'Milwaukee Brewers',
    scores: [
      { name: 'Pittsburgh Pirates', score: '3' },
      { name: 'Milwaukee Brewers', score: '5' }
    ]
  }]);
});

test('scores: pre-game events have null scores', async () => {
  const espn = { events: [{
    id: 'e2', date: '2026-07-19T23:00Z',
    status: { type: { state: 'pre', completed: false } },
    competitions: [{ competitors: [
      { homeAway: 'home', team: { displayName: 'A' }, score: '0' },
      { homeAway: 'away', team: { displayName: 'B' }, score: '0' }
    ] }]
  }] };
  const f = fakeFetch(() => okResponse(espn));
  const app = createApp({ apiKey: 'k', fetchFn: f });
  const res = await request(app).get('/api/scores/basketball_nba');
  assert.equal(res.body[0].scores, null);
});

test('scores: second request within TTL served from cache', async () => {
  let t = 1000000;
  const f = fakeFetch(() => okResponse({ events: [] }));
  const app = createApp({ apiKey: 'k', fetchFn: f, now: () => t });
  await request(app).get('/api/scores/basketball_nba');
  t += 10000; // +10s, within the 30s scores TTL
  const res2 = await request(app).get('/api/scores/basketball_nba');
  assert.equal(res2.status, 200);
  assert.equal(f.calls.length, 1);
});

test('scores: cache expires after its own (shorter) TTL', async () => {
  let t = 1000000;
  const f = fakeFetch(() => okResponse({ events: [] }));
  const app = createApp({ apiKey: 'k', fetchFn: f, now: () => t });
  await request(app).get('/api/scores/basketball_nba');
  t += 31000; // past the 30s scores TTL
  await request(app).get('/api/scores/basketball_nba');
  assert.equal(f.calls.length, 2);
});

test('scores: ESPN failure maps to 502 stats message, key not leaked', async () => {
  const f = fakeFetch(() => errResponse(500));
  const app = createApp({ apiKey: 'sekret', fetchFn: f });
  const res = await request(app).get('/api/scores/basketball_nba');
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'Stats service unavailable');
  assert.ok(!JSON.stringify(res.body).includes('sekret'));
});

// ---------- /api/live/mlb ----------
function mlbLiveScheduleBody(){
  return {
    dates: [{
      games: [{
        teams: {
          home: { team: { name: 'New York Yankees' } },
          away: { team: { name: 'Boston Red Sox' } }
        },
        status: { abstractGameState: 'Live', detailedState: 'In Progress' },
        linescore: { currentInning: 4, inningState: 'Bottom', outs: 2, balls: 1, strikes: 2 }
      }]
    }]
  };
}

test('live/mlb: maps schedule+linescore to a flat games array', async () => {
  const f = routedFetch([['/api/v1/schedule', okResponse(mlbLiveScheduleBody())]]);
  const app = createApp({ apiKey: 'k', fetchFn: f });
  const res = await request(app).get('/api/live/mlb');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.games, [{
    home_team: 'New York Yankees', away_team: 'Boston Red Sox',
    abstractGameState: 'Live', detailedState: 'In Progress',
    inning: 4, inningState: 'Bottom', outs: 2, balls: 1, strikes: 2
  }]);
});

test('live/mlb: StatsAPI failure maps to 502 Stats service unavailable', async () => {
  const f = fakeFetch(() => errResponse(500));
  const app = createApp({ apiKey: 'k', fetchFn: f });
  const res = await request(app).get('/api/live/mlb');
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'Stats service unavailable');
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

test('logged gameDate comes from the game commence_time, not the clock', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-track-'));
  const body = JSON.parse(JSON.stringify(ANALYZE_PROPS_BODY));
  body.commence_time = '2026-07-13T23:00:00Z'; // 7pm ET July 13 — tomorrow relative to the fixed clock
  const f = routedFetch([
    ['api.the-odds-api.com', okResponse(body)],
    ['/api/v1/schedule', errResponse(500)],
    ['/api/v1/sports/1/players', okResponse(PLAYERS_BODY)],
    ['/api/v1/people/', okResponse(GAMELOG_BODY)]
  ]);
  const app = createApp({ apiKey: 'k', fetchFn: f, dataDir: dir, now: () => Date.parse('2026-07-12T16:00:00Z') });
  await request(app).get('/api/analyze/mlb/ev1');
  const rec = JSON.parse(fs.readFileSync(path.join(dir, 'picks.jsonl'), 'utf8').trim().split('\n')[0]);
  assert.equal(rec.gameDate, '2026-07-13');
});

// ---------- /api/hr-matchups/mlb (previously untested) ----------
function hrScheduleBody(){
  return { dates: [{ games: [{
    teams: {
      home: { team: { name: 'Home Nine' }, probablePitcher: { id: 501, fullName: 'Home Ace' } },
      away: { team: { name: 'Away Nine' }, probablePitcher: { id: 502, fullName: 'Away Ace' } }
    },
    lineups: { homePlayers: [{ id: 601 }], awayPlayers: [{ id: 701 }] }
  }] }] };
}
// MLB's people?hydrate=stats(...,type=[season,statSplits],...) response nests
// season and statSplits as separate stats[] group entries — the season split
// has no .split.code (hence getPeopleSplits' 'season' fallback in server.js).
const HR_PEOPLE_BODY = { people: [
  { id: 501, fullName: 'Home Ace', pitchHand: { code: 'R' }, stats: [
    { splits: [{ stat: { inningsPitched: '95.0', whip: '1.15', homeRuns: 12, homeRunsPer9: 1.14 } }] },
    { splits: [
      { split: { code: 'vl' }, stat: { inningsPitched: '40.1', whip: '1.20', homeRuns: 6, homeRunsPer9: 1.34 } },
      { split: { code: 'vr' }, stat: { inningsPitched: '38.0', whip: '1.35', homeRuns: 9, homeRunsPer9: 2.13 } }
    ] }
  ] },
  { id: 502, fullName: 'Away Ace', pitchHand: { code: 'L' }, stats: [
    { splits: [{ stat: { inningsPitched: '70.0', whip: '1.25', homeRuns: 9 } }] },
    { splits: [
      { split: { code: 'vl' }, stat: { inningsPitched: '20.0', whip: '1.10', homeRuns: 2 } },
      { split: { code: 'vr' }, stat: { inningsPitched: '50.0', whip: '1.30', homeRuns: 7 } }
    ] }
  ] },
  { id: 601, fullName: 'Home Slugger', batSide: { code: 'R' }, stats: [
    { splits: [{ stat: { homeRuns: 13, avg: .270, obp: .335, slg: .460 } }] },
    { splits: [
      { split: { code: 'vl' }, stat: { homeRuns: 4, avg: .255, obp: .320, slg: .410 } },
      { split: { code: 'vr' }, stat: { homeRuns: 9, avg: .295, obp: .360, slg: .520 } }
    ] }
  ] },
  { id: 701, fullName: 'Away Slugger', batSide: { code: 'L' }, stats: [
    { splits: [{ stat: { homeRuns: 11, avg: .258, obp: .318, slg: .440 } }] },
    { splits: [
      { split: { code: 'vl' }, stat: { homeRuns: 3, avg: .240, obp: .300, slg: .380 } },
      { split: { code: 'vr' }, stat: { homeRuns: 8, avg: .280, obp: .340, slg: .490 } }
    ] }
  ] }
]};
function hrApp(overrides = {}){
  // overrides first: routedFetch returns the first substring match, so an
  // override for a path also covered by a default below must be checked first.
  const f = routedFetch([
    ...(overrides.routes || []),
    ['/api/v1/schedule', okResponse(hrScheduleBody())],
    ['/api/v1/people', okResponse(HR_PEOPLE_BODY)]
  ]);
  return { app: createApp({ apiKey: 'k', fetchFn: f, ...(overrides.opts || {}) }), f };
}
const HR_QUERY = { home: 'Home Nine', away: 'Away Nine', date: '2026-07-12' };

test('hr-matchups: missing home/away/date -> 400, nothing fetched', async () => {
  const { app, f } = hrApp();
  const res = await request(app).get('/api/hr-matchups/mlb').query({ home: 'Home Nine' });
  assert.equal(res.status, 400);
  assert.equal(f.calls.length, 0);
});

test('hr-matchups: malformed date -> 400, nothing fetched', async () => {
  const { app, f } = hrApp();
  const res = await request(app).get('/api/hr-matchups/mlb').query({ home: 'Home Nine', away: 'Away Nine', date: '07/12/2026' });
  assert.equal(res.status, 400);
  assert.equal(f.calls.length, 0);
});

test('hr-matchups: no schedule match -> matched:false, no error', async () => {
  const { app } = hrApp({ routes: [['/api/v1/schedule', okResponse({ dates: [] })]] });
  const res = await request(app).get('/api/hr-matchups/mlb').query(HR_QUERY);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { matched: false });
});

test('hr-matchups: matched game returns Season/vl/vr pitcher rows and batter splits vs correct handedness', async () => {
  const { app } = hrApp();
  const res = await request(app).get('/api/hr-matchups/mlb').query(HR_QUERY);
  assert.equal(res.status, 200);
  assert.equal(res.body.matched, true);

  // home.pitcher is the HOME team's own starting pitcher (Home Ace, R) — the
  // Season row uses the explicit homeRunsPer9 field when StatsAPI provides one.
  assert.equal(res.body.home.pitcher.name, 'Home Ace');
  assert.equal(res.body.home.pitcher.hand, 'R');
  assert.equal(res.body.home.pitcher.rows.season.hr9, 1.14);
  assert.equal(res.body.home.pitcher.rows.vl.hr9, 1.34);
  assert.equal(res.body.home.pitcher.rows.vr.hr9, 2.13);

  // home.batters face the AWAY pitcher's hand (Away Ace, L) -> read the vl split
  assert.equal(res.body.home.lineupPosted, true);
  const homeSlugger = res.body.home.batters.find(b => b.name === 'Home Slugger');
  assert.equal(homeSlugger.hr, 4);              // vl split, since facing an L pitcher
  assert.equal(homeSlugger.seasonHr, 13);       // full-season total, not the split
  assert.equal(homeSlugger.slg, 0.41);
  assert.ok(Math.abs(homeSlugger.iso - (0.41 - 0.255)) < 1e-9);

  // away.pitcher is the AWAY team's own starting pitcher (Away Ace, L) — no
  // homeRunsPer9 field given for this one, so hr9 falls back to ip9() math.
  assert.equal(res.body.away.pitcher.name, 'Away Ace');
  assert.equal(res.body.away.pitcher.hand, 'L');
  assert.ok(Math.abs(res.body.away.pitcher.rows.season.hr9 - 1.1571428571428573) < 1e-9); // ip9(9, '70.0')
  assert.equal(res.body.away.pitcher.rows.vl.hr9, 0.9);  // ip9(2, '20.0')
  assert.equal(res.body.away.pitcher.rows.vr.hr9, 1.26); // ip9(7, '50.0')

  // away.batters face the HOME pitcher's hand (Home Ace, R) -> read the vr split
  const awaySlugger = res.body.away.batters.find(b => b.name === 'Away Slugger');
  assert.equal(awaySlugger.hr, 8);               // vr split, since facing an R pitcher
  assert.equal(awaySlugger.seasonHr, 11);        // full-season total, not the split
});

test('hr-matchups: lineup not posted -> lineupPosted false, empty batters, pitcher still returned', async () => {
  const { app } = hrApp({
    routes: [['/api/v1/schedule', okResponse({ dates: [{ games: [{
      teams: {
        home: { team: { name: 'Home Nine' }, probablePitcher: { id: 501, fullName: 'Home Ace' } },
        away: { team: { name: 'Away Nine' }, probablePitcher: { id: 502, fullName: 'Away Ace' } }
      },
      lineups: {}
    }] }] })]]
  });
  const res = await request(app).get('/api/hr-matchups/mlb').query(HR_QUERY);
  assert.equal(res.body.home.lineupPosted, false);
  assert.deepEqual(res.body.home.batters, []);
  assert.equal(res.body.home.pitcher.name, 'Home Ace');
});

test('hr-matchups: schedule StatsAPI failure -> 502 Stats service unavailable', async () => {
  const { app } = hrApp({ routes: [['/api/v1/schedule', errResponse(500)]] });
  const res = await request(app).get('/api/hr-matchups/mlb').query(HR_QUERY);
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'Stats service unavailable');
});

// ---------- /api/pitchers/mlb ----------
test('pitchers: missing home/away/date -> 400, nothing fetched', async () => {
  const { app, f } = hrApp();
  const res = await request(app).get('/api/pitchers/mlb').query({ home: 'Home Nine' });
  assert.equal(res.status, 400);
  assert.equal(f.calls.length, 0);
});

test('pitchers: malformed date -> 400, nothing fetched', async () => {
  const { app, f } = hrApp();
  const res = await request(app).get('/api/pitchers/mlb').query({ home: 'Home Nine', away: 'Away Nine', date: '07/12/2026' });
  assert.equal(res.status, 400);
  assert.equal(f.calls.length, 0);
});

test('pitchers: no schedule match -> matched:false, no error', async () => {
  const { app } = hrApp({ routes: [['/api/v1/schedule', okResponse({ dates: [] })]] });
  const res = await request(app).get('/api/pitchers/mlb').query(HR_QUERY);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { matched: false });
});

test('pitchers: matched game returns both starting pitchers by id/name, no splits fetched', async () => {
  const { app, f } = hrApp();
  const res = await request(app).get('/api/pitchers/mlb').query(HR_QUERY);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    matched: true,
    home: { id: 501, name: 'Home Ace' },
    away: { id: 502, name: 'Away Ace' }
  });
  // lighter than hr-matchups: only the schedule call, never /api/v1/people
  assert.ok(!f.calls.some(u => u.includes('/api/v1/people')), 'must not fetch splits for this endpoint');
});

test('pitchers: probable pitcher not yet announced -> that side is null, not an error', async () => {
  const { app } = hrApp({ routes: [['/api/v1/schedule', okResponse({ dates: [{ games: [{
    teams: {
      home: { team: { name: 'Home Nine' }, probablePitcher: null },
      away: { team: { name: 'Away Nine' }, probablePitcher: { id: 502, fullName: 'Away Ace' } }
    },
    lineups: {}
  }] }] })]] });
  const res = await request(app).get('/api/pitchers/mlb').query(HR_QUERY);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { matched: true, home: null, away: { id: 502, name: 'Away Ace' } });
});

test('pitchers: schedule StatsAPI failure -> 502 Stats service unavailable', async () => {
  const { app } = hrApp({ routes: [['/api/v1/schedule', errResponse(500)]] });
  const res = await request(app).get('/api/pitchers/mlb').query(HR_QUERY);
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'Stats service unavailable');
});

// ---------- NFL: odds markets, prop groups, nflIds ----------

const SLEEPER_DUMP = {
  '6770': { full_name: 'Joe Burrow', position: 'QB', team: 'CIN', status: 'Active', depth_chart_order: 1 },
  '9509': { full_name: 'Chase Brown', position: 'RB', team: 'CIN', status: 'Active', depth_chart_order: 1 },
  '1111': { full_name: 'Old Retired', position: 'QB', team: null, status: 'Inactive', depth_chart_order: null }
};

const NFL_PROPS_BODY = {
  id: 'ev9',
  bookmakers: [{
    key: 'draftkings', title: 'DraftKings',
    markets: [{
      key: 'player_pass_yds',
      outcomes: [
        { name: 'Over',  description: 'Joe Burrow', point: 267.5, price: -110 },
        { name: 'Under', description: 'Joe Burrow', point: 267.5, price: -110 }
      ]
    }]
  }]
};

function nflApp(overrides = {}){
  const f = routedFetch([
    ...(overrides.routes || []),
    ['api.the-odds-api.com', okResponse(NFL_PROPS_BODY)],
    ['api.sleeper.app/v1/players/nfl', okResponse(SLEEPER_DUMP)]
  ]);
  const app = createApp({ apiKey: 'k', fetchFn: f, ...(overrides.opts || {}) });
  return { app, f };
}

test('NFL odds request includes spreads and totals, no F5 markets', async () => {
  const f = fakeFetch(() => okResponse([]));
  const app = createApp({ apiKey: 'k', fetchFn: f });
  const res = await request(app).get('/api/odds/americanfootball_nfl');
  assert.equal(res.status, 200);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0], /markets=h2h,spreads,totals&/);
  assert.doesNotMatch(f.calls[0], /1st_5_innings/);
});

test('NCAAF odds request stays moneyline-only', async () => {
  const f = fakeFetch(() => okResponse([]));
  const app = createApp({ apiKey: 'k', fetchFn: f });
  await request(app).get('/api/odds/americanfootball_ncaaf');
  assert.match(f.calls[0], /markets=h2h&/);
});

test('NFL props: missing group defaults to the popular markets', async () => {
  const { app, f } = nflApp();
  const res = await request(app).get('/api/props/americanfootball_nfl/0a1b2c3d4e5f');
  assert.equal(res.status, 200);
  const oddsCall = f.calls.find(u => u.includes('api.the-odds-api.com'));
  assert.match(oddsCall, /markets=player_pass_yds,player_pass_tds,player_rush_yds,player_receptions,player_reception_yds,player_anytime_td&/);
});

test('NFL props: explicit group swaps the upstream market list', async () => {
  const { app, f } = nflApp();
  const res = await request(app).get('/api/props/americanfootball_nfl/0a1b2c3d4e5f').query({ group: 'passing' });
  assert.equal(res.status, 200);
  const oddsCall = f.calls.find(u => u.includes('api.the-odds-api.com'));
  assert.match(oddsCall, /markets=player_pass_attempts,player_pass_completions,player_pass_interceptions,player_pass_yds_alternate,player_pass_tds_alternate&/);
});

test('NFL props: unknown group -> 400, upstream not called', async () => {
  const { app, f } = nflApp();
  const res = await request(app).get('/api/props/americanfootball_nfl/0a1b2c3d4e5f').query({ group: 'nope' });
  assert.equal(res.status, 400);
  assert.equal(f.calls.filter(u => u.includes('api.the-odds-api.com')).length, 0);
});

test('props: explicit group on a flat-list sport -> 400, upstream not called', async () => {
  const f = fakeFetch(() => okResponse({}));
  const app = createApp({ apiKey: 'k', fetchFn: f });
  const res = await request(app).get('/api/props/basketball_nba/0a1b2c3d4e5f').query({ group: 'passing' });
  assert.equal(res.status, 400);
  assert.equal(f.calls.length, 0);
});

test('NFL props: each group is cached separately, repeats within TTL are free', async () => {
  let t = 1000000;
  const { app, f } = nflApp({ opts: { cacheTtlMs: 600000, now: () => t } });
  const oddsCalls = () => f.calls.filter(u => u.includes('api.the-odds-api.com')).length;
  await request(app).get('/api/props/americanfootball_nfl/0a1b2c3d4e5f');
  assert.equal(oddsCalls(), 1);
  await request(app).get('/api/props/americanfootball_nfl/0a1b2c3d4e5f').query({ group: 'passing' });
  assert.equal(oddsCalls(), 2, 'a second group must cost a second upstream call');
  t += 120000;
  await request(app).get('/api/props/americanfootball_nfl/0a1b2c3d4e5f').query({ group: 'passing' });
  assert.equal(oddsCalls(), 2, 'a repeat of a fetched group within TTL must be served from cache');
});

test('NFL props: response carries nflIds for active players only', async () => {
  const { app } = nflApp();
  const res = await request(app).get('/api/props/americanfootball_nfl/0a1b2c3d4e5f');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.nflIds, { 'joe burrow': '6770' });
});

test('NFL props: Sleeper failure leaves props intact without nflIds', async () => {
  const { app } = nflApp({ routes: [['api.sleeper.app', errResponse(500)]] });
  const res = await request(app).get('/api/props/americanfootball_nfl/0a1b2c3d4e5f');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.bookmakers, NFL_PROPS_BODY.bookmakers);
  assert.equal(res.body.nflIds, undefined);
});

test('NFL props: Sleeper dump is fetched once across requests (24h cache)', async () => {
  let t = 1000000;
  const { app, f } = nflApp({ opts: { cacheTtlMs: 1000, now: () => t } });
  await request(app).get('/api/props/americanfootball_nfl/0a1b2c3d4e5f');
  t += 2000; // odds cache expired, sleeper cache (24h) still fresh
  await request(app).get('/api/props/americanfootball_nfl/0a1b2c3d4e5f');
  assert.equal(f.calls.filter(u => u.includes('api.sleeper.app')).length, 1);
  assert.equal(f.calls.filter(u => u.includes('api.the-odds-api.com')).length, 2);
});

// ---------- /api/matchups/nfl ----------

const MATCHUP_DUMP = {
  // Bengals
  'qb1': { full_name: 'Joe Burrow', position: 'QB', team: 'CIN', status: 'Active', depth_chart_order: 1 },
  'qb2': { full_name: 'Backup Guy', position: 'QB', team: 'CIN', status: 'Active', depth_chart_order: 2 },
  'rb1': { full_name: 'Chase Brown', position: 'RB', team: 'CIN', status: 'Active', depth_chart_order: 1 },
  'rb2': { full_name: 'Second Back', position: 'RB', team: 'CIN', status: 'Active', depth_chart_order: 2 },
  'rb3': { full_name: 'Third Back', position: 'RB', team: 'CIN', status: 'Active', depth_chart_order: 3 },
  'wr1': { full_name: 'Top Wideout', position: 'WR', team: 'CIN', status: 'Active', depth_chart_order: 1 },
  'wr2': { full_name: 'Deep Threat', position: 'WR', team: 'CIN', status: 'Active', depth_chart_order: 2 },
  'te1': { full_name: 'Tight Endman', position: 'TE', team: 'CIN', status: 'Active', depth_chart_order: 1 },
  'wr3': { full_name: 'Fourth Option', position: 'WR', team: 'CIN', status: 'Active', depth_chart_order: 3 },
  // Steelers
  'pqb': { full_name: 'Steel Passer', position: 'QB', team: 'PIT', status: 'Active', depth_chart_order: 1 },
  'prb': { full_name: 'Steel Runner', position: 'RB', team: 'PIT', status: 'Active', depth_chart_order: 1 },
  'pwr': { full_name: 'Steel Catcher', position: 'WR', team: 'PIT', status: 'Active', depth_chart_order: 1 },
  // noise
  'k1': { full_name: 'Some Kicker', position: 'K', team: 'CIN', status: 'Active', depth_chart_order: 1 }
};

const MATCHUP_STATS_2025 = {
  qb1: { gp: 17, pass_yd: 4500, pass_td: 34 },
  qb2: { gp: 3, pass_yd: 300, pass_td: 2 },
  rb1: { gp: 17, rush_yd: 990, rush_td: 7, rec: 34 },
  rb2: { gp: 10, rush_yd: 450, rush_td: 2, rec: 10 },
  rb3: { gp: 8, rush_yd: 120, rush_td: 0, rec: 2 },
  wr1: { gp: 16, rec: 117, rec_yd: 1500, rec_td: 12 },
  wr2: { gp: 17, rec: 68, rec_yd: 900, rec_td: 6 },
  te1: { gp: 17, rec: 51, rec_yd: 510, rec_td: 3 },
  wr3: { gp: 12, rec: 20, rec_yd: 190, rec_td: 1 },
  pqb: { gp: 17, pass_yd: 3400, pass_td: 17 },
  prb: { gp: 17, rush_yd: 1190, rush_td: 9, rec: 17 },
  pwr: { gp: 17, rec: 85, rec_yd: 1020, rec_td: 5 }
};

const ESPN_TEAMS_BODY = { sports: [{ leagues: [{ teams: [
  { team: { id: '4', displayName: 'Cincinnati Bengals' } },
  { team: { id: '23', displayName: 'Pittsburgh Steelers' } }
] }] }] };

function espnStatsBody(passYds, passRank, rushYds, rushRank, pts, ptsRank){
  return { results: { opponent: [
    { name: 'passing', stats: [{ name: 'passingYardsPerGame', value: passYds, rank: passRank }] },
    { name: 'rushing', stats: [{ name: 'rushingYardsPerGame', value: rushYds, rank: rushRank }] },
    { name: 'scoring', stats: [{ name: 'totalPointsPerGame', value: pts, rank: ptsRank }] }
  ] } };
}

const JULY_2026 = Date.UTC(2026, 6, 19);

function matchupApp(overrides = {}){
  const f = routedFetch([
    ...(overrides.routes || []),
    ['api.sleeper.app/v1/players/nfl', okResponse(MATCHUP_DUMP)],
    ['api.sleeper.app/v1/stats/nfl/regular/2026', okResponse({ qb1: { gp: 0 } })],
    ['api.sleeper.app/v1/stats/nfl/regular/2025', okResponse(MATCHUP_STATS_2025)],
    ['/nfl/teams/4/statistics', okResponse(espnStatsBody(245.6, 26, 147.1, 32, 28.9, 30))],
    ['/nfl/teams/23/statistics', okResponse(espnStatsBody(204.6, 8, 105.7, 9, 19.3, 6))],
    ['site.api.espn.com/apis/site/v2/sports/football/nfl/teams', okResponse(ESPN_TEAMS_BODY)]
  ]);
  const app = createApp({ apiKey: 'k', fetchFn: f, now: () => (overrides.now || JULY_2026), ...(overrides.opts || {}) });
  return { app, f };
}

const MATCHUP_QUERY = { home: 'Cincinnati Bengals', away: 'Pittsburgh Steelers' };

test('matchups: missing params -> 400, nothing fetched', async () => {
  const { app, f } = matchupApp();
  const res = await request(app).get('/api/matchups/nfl').query({ home: 'Cincinnati Bengals' });
  assert.equal(res.status, 400);
  assert.equal(f.calls.length, 0);
});

test('matchups: unknown team name -> matched:false', async () => {
  const { app } = matchupApp();
  const res = await request(app).get('/api/matchups/nfl').query({ home: 'Cincinnati Bengals', away: 'London Monarchs' });
  assert.equal(res.status, 200);
  assert.equal(res.body.matched, false);
});

test('matchups: key players ranked by season stat totals with per-game averages', async () => {
  const { app } = matchupApp();
  const res = await request(app).get('/api/matchups/nfl').query(MATCHUP_QUERY);
  assert.equal(res.status, 200);
  assert.equal(res.body.matched, true);
  assert.equal(res.body.season, 2025, 'must fall back to the completed season when the current one has no games played');

  const home = res.body.home;
  assert.equal(home.team, 'Cincinnati Bengals');
  const names = home.players.map(p => p.name);
  // QB1 by pass_yd, top-2 RBs by rush_yd, top-3 WR/TEs by rec_yd; kicker excluded
  assert.deepEqual(names, ['Joe Burrow', 'Chase Brown', 'Second Back', 'Top Wideout', 'Deep Threat', 'Tight Endman']);

  const qb = home.players[0];
  assert.equal(qb.pos, 'QB');
  assert.equal(qb.id, 'qb1');
  assert.equal(qb.gp, 17);
  assert.equal(qb.passYds, 264.7);  // 4500/17
  assert.equal(qb.passTds, 2.0);    // 34/17

  const rb = home.players[1];
  assert.equal(rb.rushYds, 58.2);   // 990/17
  assert.equal(rb.rushTds, 0.4);
  assert.equal(rb.rec, 2.0);

  const wr = home.players[3];
  assert.equal(wr.rec, 7.3);        // 117/16
  assert.equal(wr.recYds, 93.8);    // 1500/16
  assert.equal(wr.recTds, 0.8);

  assert.equal(res.body.away.players[0].name, 'Steel Passer');
});

test('matchups: defense blocks carry ESPN values and ranks', async () => {
  const { app } = matchupApp();
  const res = await request(app).get('/api/matchups/nfl').query(MATCHUP_QUERY);
  assert.deepEqual(res.body.home.defense, {
    passYdsAllowed: { value: 245.6, rank: 26 },
    rushYdsAllowed: { value: 147.1, rank: 32 },
    ptsAllowed: { value: 28.9, rank: 30 }
  });
  assert.equal(res.body.away.defense.ptsAllowed.rank, 6);
});

test('matchups: ESPN failure -> defense null, players still returned', async () => {
  const { app } = matchupApp({ routes: [['site.api.espn.com', errResponse(500)]] });
  const res = await request(app).get('/api/matchups/nfl').query(MATCHUP_QUERY);
  assert.equal(res.status, 200);
  assert.equal(res.body.matched, true);
  assert.equal(res.body.home.defense, null);
  assert.ok(res.body.home.players.length > 0);
});

test('matchups: Sleeper stats failure -> statsUnavailable body, not a 500', async () => {
  const { app } = matchupApp({ routes: [['api.sleeper.app/v1/stats', errResponse(500)]] });
  const res = await request(app).get('/api/matchups/nfl').query(MATCHUP_QUERY);
  assert.equal(res.status, 200);
  assert.equal(res.body.matched, true);
  assert.equal(res.body.statsUnavailable, true);
});

test('matchups: repeat request within TTL costs no new upstream calls', async () => {
  const { app, f } = matchupApp();
  await request(app).get('/api/matchups/nfl').query(MATCHUP_QUERY);
  const callsAfterFirst = f.calls.length;
  await request(app).get('/api/matchups/nfl').query(MATCHUP_QUERY);
  assert.equal(f.calls.length, callsAfterFirst, 'all Sleeper/ESPN data must be served from cache on a repeat');
});
