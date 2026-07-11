require('dotenv').config();
const express = require('express');
const path = require('path');
const { analyzeProp, rankPicks } = require('./analysis');

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

const STATSAPI = 'https://statsapi.mlb.com';

// market key -> which MLB game-log stat backs it
const MLB_MARKET_STATS = {
  pitcher_strikeouts: { group: 'pitching', stat: 'strikeOuts', window: 10, startsOnly: true },
  batter_hits:        { group: 'hitting',  stat: 'hits',       window: 15 },
  batter_total_bases: { group: 'hitting',  stat: 'totalBases', window: 15 },
  batter_rbis:        { group: 'hitting',  stat: 'rbi',        window: 15 },
  batter_home_runs:   { group: 'hitting',  stat: 'homeRuns',   window: 15 }
};

function createApp({ apiKey, fetchFn = fetch, cacheTtlMs = 10 * 60 * 1000, now = Date.now } = {}) {
  const app = express();
  const cache = new Map(); // upstreamPath -> {body, remaining, cachedAt, expires}
  const statsCache = new Map(); // statsapi path -> {body, expires}
  const analysisCache = new Map(); // eventId -> {body, expires}

  // Fetch (or serve from cache) an Odds API path. Returns {body, remaining, cacheAge}.
  // Throws {kind:'quota'} or {kind:'unavailable'}.
  async function getUpstream(upstreamPath){
    const hit = cache.get(upstreamPath);
    if(hit && now() < hit.expires){
      return { body: hit.body, remaining: hit.remaining, cacheAge: Math.round((now() - hit.cachedAt) / 1000) };
    }
    let upstream;
    try {
      upstream = await fetchFn(`${UPSTREAM}${upstreamPath}&apiKey=${encodeURIComponent(apiKey)}`);
    } catch (e) {
      console.error(`Upstream fetch failed for ${upstreamPath}: ${e.message}`);
      throw { kind: 'unavailable' };
    }
    if (upstream.status === 429) throw { kind: 'quota' };
    if (!upstream.ok) {
      console.error(`Upstream ${upstream.status} for ${upstreamPath}`);
      throw { kind: 'unavailable' };
    }
    let body;
    try {
      body = await upstream.json();
    } catch (e) {
      console.error(`Upstream returned unparseable JSON for ${upstreamPath}`);
      throw { kind: 'unavailable' };
    }
    const remaining = upstream.headers.get('x-requests-remaining');
    cache.set(upstreamPath, { body, remaining, cachedAt: now(), expires: now() + cacheTtlMs });
    return { body, remaining, cacheAge: 0 };
  }

  function sendUpstreamError(res, err){
    if (err && err.kind === 'quota') {
      return res.status(429).json({ error: 'Monthly odds quota exhausted — resets on the 1st' });
    }
    if (err && err.kind === 'stats') {
      return res.status(502).json({ error: 'Stats service unavailable' });
    }
    return res.status(502).json({ error: 'Odds service unavailable' });
  }

  async function proxy(upstreamPath, res){
    let r;
    try {
      r = await getUpstream(upstreamPath);
    } catch (err) {
      return sendUpstreamError(res, err);
    }
    if (r.remaining) res.set('x-requests-remaining', r.remaining);
    res.set('x-cache-age-seconds', String(r.cacheAge));
    res.json(r.body);
  }

  async function fetchStats(path, ttlMs){
    const hit = statsCache.get(path);
    if (hit && now() < hit.expires) return hit.body;
    let resp;
    try {
      resp = await fetchFn(`${STATSAPI}${path}`);
    } catch (e) {
      console.error(`StatsAPI fetch failed for ${path}: ${e.message}`);
      throw { kind: 'stats' };
    }
    if (!resp.ok) {
      console.error(`StatsAPI ${resp.status} for ${path}`);
      throw { kind: 'stats' };
    }
    let body;
    try {
      body = await resp.json();
    } catch (e) {
      console.error(`StatsAPI returned unparseable JSON for ${path}`);
      throw { kind: 'stats' };
    }
    statsCache.set(path, { body, expires: now() + ttlMs });
    return body;
  }

  function normName(s){
    return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\./g, '').trim();
  }

  async function mlbPlayerId(name, season){
    // full active-player list, cached for the life of the process
    const data = await fetchStats(`/api/v1/sports/1/players?season=${season}`, Number.MAX_SAFE_INTEGER);
    const target = normName(name);
    const person = (data.people || []).find(p => normName(p.fullName) === target);
    return person ? person.id : null;
  }

  // newest-first [{value, started}]
  async function mlbGameValues(personId, group, statName, season){
    const data = await fetchStats(`/api/v1/people/${personId}/stats?stats=gameLog&season=${season}&group=${group}`, 6 * 60 * 60 * 1000);
    const splits = (((data.stats || [])[0] || {}).splits) || [];
    return splits.slice().reverse().map(s => ({
      value: Number((s.stat || {})[statName] || 0),
      started: Number((s.stat || {}).gamesStarted || 0) > 0
    }));
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

  app.get('/api/analyze/mlb/:eventId', (req, res) => {
    handleAnalyze(req, res).catch(err => {
      console.error(`Analyze failed: ${err && err.message || err}`);
      if (!res.headersSent) res.status(502).json({ error: 'Odds service unavailable' });
    });
  });

  async function handleAnalyze(req, res){
    const { eventId } = req.params;
    if (!/^[a-z0-9]{1,64}$/i.test(eventId)) return res.status(400).json({ error: 'Bad event id' });

    const hit = analysisCache.get(eventId);
    if (hit && now() < hit.expires) return res.json(hit.body);

    const markets = PROP_MARKETS.baseball_mlb;
    let props;
    try {
      props = await getUpstream(`/v4/sports/baseball_mlb/events/${eventId}/odds/?regions=us,us2&markets=${markets.join(',')}&oddsFormat=american`);
    } catch (err) {
      return sendUpstreamError(res, err);
    }

    // group outcomes: player|market|line -> {overRows, underRows}
    const grouped = {};
    (props.body.bookmakers || []).forEach(bm => {
      (bm.markets || []).forEach(m => {
        if (!MLB_MARKET_STATS[m.key]) return;
        (m.outcomes || []).forEach(o => {
          if (o.point === undefined || o.point === null) return;
          const player = o.description || '';
          if (!player) return;
          const gk = `${player}|${m.key}|${o.point}`;
          if (!grouped[gk]) grouped[gk] = { player, market: m.key, line: Number(o.point), overRows: [], underRows: [] };
          const row = { bookKey: bm.key, bookTitle: bm.title, odds: o.price };
          if (o.name === 'Over') grouped[gk].overRows.push(row);
          else if (o.name === 'Under') grouped[gk].underRows.push(row);
        });
      });
    });

    const propCount = Object.keys(grouped).length;

    // ---- lineup / probable-starter context (enhancement — never blocks analysis) ----
    let lineupStatus = 'unavailable';
    const probablePitcherIds = new Set();
    const lineupIds = new Set();
    let lineupsPosted = false;
    try {
      const dateStr = new Date(now()).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
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

    const season = new Date(now()).getFullYear();
    const picks = [];
    const skipped = new Set();
    const filteredMap = new Map();
    try {
      for (const gk of Object.keys(grouped)) {
        const prop = grouped[gk];
        const cfg = MLB_MARKET_STATS[prop.market];
        const pid = await mlbPlayerId(prop.player, season);
        if (!pid) { skipped.add(prop.player); continue; }
        if (cfg.group === 'pitching' && probablePitcherIds.size && !probablePitcherIds.has(pid)) {
          filteredMap.set(prop.player + '|' + prop.market, { player: prop.player, reason: 'not_probable_starter' });
          continue;
        }
        if (cfg.group === 'hitting' && lineupsPosted && !lineupIds.has(pid)) {
          filteredMap.set(prop.player + '|' + prop.market, { player: prop.player, reason: 'not_in_lineup' });
          continue;
        }
        let games = await mlbGameValues(pid, cfg.group, cfg.stat, season);
        if (cfg.startsOnly) games = games.filter(g => g.started);
        const values = games.map(g => g.value);
        if (!values.length) { skipped.add(prop.player); continue; }
        const pick = analyzeProp(prop, { recentValues: values.slice(0, cfg.window), seasonValues: values });
        if (pick) {
          if (cfg.group === 'hitting' && lineupStatus === 'pending') {
            pick.analysis.flags.push('lineup_unconfirmed');
          }
          picks.push(pick);
        }
      }
    } catch (err) {
      if (err && err.kind === 'stats') return sendUpstreamError(res, err);
      throw err;
    }

    const body = {
      picks: rankPicks(picks),
      skipped: [...skipped],
      filtered: [...new Map([...filteredMap.values()].map(f => [f.player + '|' + f.reason, f])).values()],
      lineupStatus,
      propCount,
      generatedAt: new Date(now()).toISOString()
    };
    analysisCache.set(eventId, { body, expires: now() + cacheTtlMs });
    res.json(body);
  }

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
