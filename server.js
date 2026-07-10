require('dotenv').config();
const express = require('express');
const path = require('path');

const UPSTREAM = 'https://api.the-odds-api.com';

const SPORTS = new Set([
  'americanfootball_nfl', 'basketball_nba', 'baseball_mlb', 'icehockey_nhl',
  'americanfootball_ncaaf', 'basketball_ncaab', 'soccer_epl', 'mma_mixed_martial_arts'
]);

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
    let body;
    try {
      body = await upstream.json();
    } catch (e) {
      console.error(`Upstream returned unparseable JSON for ${upstreamPath}`);
      return res.status(502).json({ error: 'Odds service unavailable' });
    }
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

  app.get('/api/props/:sport/:eventId', (req, res) => {
    const { sport, eventId } = req.params;
    const markets = PROP_MARKETS[sport];
    if (!markets) return res.status(400).json({ error: 'Props not supported for this sport' });
    if (!/^[a-z0-9]{1,64}$/i.test(eventId)) return res.status(400).json({ error: 'Bad event id' });
    proxy(`/v4/sports/${sport}/events/${eventId}/odds/?regions=us,us2&markets=${markets.join(',')}&oddsFormat=american`, res);
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
