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
