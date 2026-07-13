require('dotenv').config();
const express = require('express');
const path = require('path');
const { analyzeProp, rankPicks } = require('./analysis');
const { createStore, computeRecord } = require('./store');

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
const SCORES_TTL_MS = 30 * 1000;
const LIVE_TTL_MS = 20 * 1000;

// market key -> which MLB game-log stat backs it
const MLB_MARKET_STATS = {
  pitcher_strikeouts: { group: 'pitching', stat: 'strikeOuts', window: 10, startsOnly: true },
  batter_hits:        { group: 'hitting',  stat: 'hits',       window: 15 },
  batter_total_bases: { group: 'hitting',  stat: 'totalBases', window: 15 },
  batter_rbis:        { group: 'hitting',  stat: 'rbi',        window: 15 },
  batter_home_runs:   { group: 'hitting',  stat: 'homeRuns',   window: 15 }
};

function createApp({ apiKey, fetchFn = fetch, cacheTtlMs = 10 * 60 * 1000, now = Date.now, dataDir = null, enableSweep = false } = {}) {
  const app = express();
  const cache = new Map(); // upstreamPath -> {body, remaining, cachedAt, expires}
  const statsCache = new Map(); // statsapi path -> {body, expires}
  const analysisCache = new Map(); // eventId -> {body, expires}
  const store = createStore({ dataDir });

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

  // newest-first [{value, started, date}]
  async function mlbGameValues(personId, group, statName, season, ttlMs = 6 * 60 * 60 * 1000){
    const data = await fetchStats(`/api/v1/people/${personId}/stats?stats=gameLog&season=${season}&group=${group}`, ttlMs);
    const splits = (((data.stats || [])[0] || {}).splits) || [];
    return splits.slice().reverse().map(s => ({
      value: Number((s.stat || {})[statName] || 0),
      started: Number((s.stat || {}).gamesStarted || 0) > 0,
      date: s.date
    }));
  }

  app.get('/api/odds/:sport', (req, res) => {
    const { sport } = req.params;
    if (!SPORTS.has(sport)) return res.status(400).json({ error: 'Unknown sport' });
    proxy(`/v4/sports/${sport}/odds/?regions=us,us2&markets=h2h&oddsFormat=american`, res);
  });

  // Live/recent scores. Cached on a much shorter TTL than odds (SCORES_TTL_MS)
  // since games change state every few minutes, not every 10 min like odds.
  const scoresCache = new Map(); // sport -> {body, remaining, cachedAt, expires}
  async function getScores(sport){
    const hit = scoresCache.get(sport);
    if (hit && now() < hit.expires) {
      return { body: hit.body, remaining: hit.remaining, cacheAge: Math.round((now() - hit.cachedAt) / 1000) };
    }
    let upstream;
    try {
      upstream = await fetchFn(`${UPSTREAM}/v4/sports/${sport}/scores/?daysFrom=1&apiKey=${encodeURIComponent(apiKey)}`);
    } catch (e) {
      console.error(`Upstream fetch failed for scores/${sport}: ${e.message}`);
      throw { kind: 'unavailable' };
    }
    if (upstream.status === 429) throw { kind: 'quota' };
    if (!upstream.ok) {
      console.error(`Upstream ${upstream.status} for scores/${sport}`);
      throw { kind: 'unavailable' };
    }
    let body;
    try {
      body = await upstream.json();
    } catch (e) {
      console.error(`Upstream returned unparseable JSON for scores/${sport}`);
      throw { kind: 'unavailable' };
    }
    const remaining = upstream.headers.get('x-requests-remaining');
    scoresCache.set(sport, { body, remaining, cachedAt: now(), expires: now() + SCORES_TTL_MS });
    return { body, remaining, cacheAge: 0 };
  }
  app.get('/api/scores/:sport', (req, res) => {
    const { sport } = req.params;
    if (!SPORTS.has(sport)) return res.status(400).json({ error: 'Unknown sport' });
    getScores(sport).then(r => {
      if (r.remaining) res.set('x-requests-remaining', r.remaining);
      res.set('x-cache-age-seconds', String(r.cacheAge));
      res.json(r.body);
    }).catch(err => sendUpstreamError(res, err));
  });

  // MLB live in-game detail (inning, outs, balls/strikes) — MLB StatsAPI only
  // has this; The Odds API scores endpoint only gives the running score.
  app.get('/api/live/mlb', (req, res) => {
    (async () => {
      const dateStr = new Date(now()).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const sched = await fetchStats(`/api/v1/schedule?sportId=1&date=${dateStr}&hydrate=linescore`, LIVE_TTL_MS);
      const games = ((sched.dates || [])[0] || {}).games || [];
      res.json({
        games: games.map(g => ({
          home_team: g.teams?.home?.team?.name || '',
          away_team: g.teams?.away?.team?.name || '',
          abstractGameState: g.status?.abstractGameState || '',
          detailedState: g.status?.detailedState || '',
          inning: g.linescore?.currentInning || null,
          inningState: g.linescore?.inningState || null,
          outs: g.linescore?.outs ?? null,
          balls: g.linescore?.balls ?? null,
          strikes: g.linescore?.strikes ?? null
        }))
      });
    })().catch(err => sendUpstreamError(res, err));
  });

  app.get('/api/props/:sport/:eventId', (req, res) => {
    handlePropsRequest(req, res).catch(err => {
      console.error(`Props fetch failed: ${err && err.message || err}`);
      if (!res.headersSent) sendUpstreamError(res, err);
    });
  });

  async function handlePropsRequest(req, res){
    const { sport, eventId } = req.params;
    const markets = PROP_MARKETS[sport];
    if (!markets) return res.status(400).json({ error: 'Props not supported for this sport' });
    if (!/^[a-z0-9]{1,64}$/i.test(eventId)) return res.status(400).json({ error: 'Bad event id' });

    let r;
    try {
      r = await getUpstream(`/v4/sports/${sport}/events/${eventId}/odds/?regions=us,us2&markets=${markets.join(',')}&oddsFormat=american`);
    } catch (err) {
      return sendUpstreamError(res, err);
    }

    let body = r.body;
    // MLB only: resolve each player name to a StatsAPI personId (cached lookup,
    // same helper /api/analyze uses) so the frontend can show a real headshot.
    if (sport === 'baseball_mlb') {
      const names = new Set();
      (body.bookmakers || []).forEach(bm => (bm.markets || []).forEach(m => (m.outcomes || []).forEach(o => {
        const nm = o.description || o.name;
        if (nm) names.add(nm);
      })));
      const season = new Date(now()).getFullYear();
      const mlbIds = {};
      for (const nm of names) {
        try {
          const id = await mlbPlayerId(nm, season);
          if (id) mlbIds[nm.toLowerCase()] = id;
        } catch (e) { /* best-effort — a missed id just means no photo for that player */ }
      }
      body = { ...body, mlbIds };
    }

    if (r.remaining) res.set('x-requests-remaining', r.remaining);
    res.set('x-cache-age-seconds', String(r.cacheAge));
    res.json(body);
  }

  // HR matchup context for a scheduled MLB game: each probable pitcher's
  // Season / vs LHB / vs RHB rows, plus (when lineups are posted) each
  // batter's splits vs the opposing pitcher's hand. Identified by team names
  // + date rather than an Odds API event id — this only talks to StatsAPI.
  function ip9(hr, ip){
    if(!ip) return null;
    const parts = String(ip).split('.');
    const outs = (Number(parts[0]) || 0) * 3 + (Number(parts[1]) || 0);
    if(!outs) return null;
    return (Number(hr) || 0) * 27 / outs;
  }

  async function getMlbScheduleGame(dateStr, home, away){
    const sched = await fetchStats(`/api/v1/schedule?sportId=1&date=${dateStr}&hydrate=probablePitcher,lineups`, 15 * 60 * 1000);
    const games = ((sched.dates || [])[0] || {}).games || [];
    return games.find(g =>
      g.teams && normName(g.teams.home?.team?.name || '') === normName(home) &&
      normName(g.teams.away?.team?.name || '') === normName(away)
    ) || null;
  }

  // Batched people call with season + vs-hand splits hydrated (one request per group of players)
  async function getPeopleSplits(personIds, group, season){
    if (!personIds.length) return {};
    const path = `/api/v1/people?personIds=${personIds.join(',')}&hydrate=stats(group=[${group}],type=[season,statSplits],sitCodes=[vl,vr],season=${season})`;
    const data = await fetchStats(path, 6 * 60 * 60 * 1000);
    const out = {};
    (data.people || []).forEach(p => {
      const splits = {};
      (p.stats || []).forEach(sg => {
        (sg.splits || []).forEach(sp => {
          const code = (sp.split && sp.split.code) || 'season';
          splits[code] = sp.stat || {};
        });
      });
      out[p.id] = { name: p.fullName, hand: (p.pitchHand && p.pitchHand.code) || (p.batSide && p.batSide.code) || '?', splits };
    });
    return out;
  }

  app.get('/api/hr-matchups/mlb', (req, res) => {
    handleHrMatchups(req, res).catch(err => {
      console.error(`HR matchups failed: ${err && err.message || err}`);
      if (!res.headersSent) res.status(502).json({ error: 'Stats service unavailable' });
    });
  });

  async function handleHrMatchups(req, res){
    const { home, away, date } = req.query;
    if (!home || !away || !date) return res.status(400).json({ error: 'home, away, and date are required' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Bad date' });

    let mg;
    try {
      mg = await getMlbScheduleGame(date, home, away);
    } catch (err) {
      return sendUpstreamError(res, err);
    }
    if (!mg) return res.json({ matched: false });

    const homeP = mg.teams.home.probablePitcher || null;
    const awayP = mg.teams.away.probablePitcher || null;
    const lineups = mg.lineups || {};
    const homeBatIds = (lineups.homePlayers || []).map(p => p.id);
    const awayBatIds = (lineups.awayPlayers || []).map(p => p.id);
    const pitcherIds = [homeP, awayP].filter(Boolean).map(p => p.id);
    const season = date.slice(0, 4);

    let pitchers, homeHit, awayHit;
    try {
      [pitchers, homeHit, awayHit] = await Promise.all([
        getPeopleSplits(pitcherIds, 'pitching', season),
        getPeopleSplits(homeBatIds, 'hitting', season),
        getPeopleSplits(awayBatIds, 'hitting', season)
      ]);
    } catch (err) {
      return sendUpstreamError(res, err);
    }

    function pitcherPayload(pObj){
      if (!pObj || !pitchers[pObj.id]) return null;
      const pd = pitchers[pObj.id];
      const rows = {};
      ['season', 'vl', 'vr'].forEach(code => {
        const st = pd.splits[code];
        if (!st) return;
        const ip = st.inningsPitched || null;
        const hr = st.homeRuns !== undefined ? Number(st.homeRuns) : null;
        const hr9 = st.homeRunsPer9 !== undefined ? Number(st.homeRunsPer9) : ip9(hr, ip);
        rows[code] = { ip, whip: st.whip || null, hr, hr9 };
      });
      return { id: pObj.id, name: pd.name, hand: pd.hand, rows };
    }

    function battersPayload(batterIds, batterMap, oppHand){
      const sitCode = oppHand === 'L' ? 'vl' : oppHand === 'R' ? 'vr' : null;
      return batterIds.map(id => {
        const b = batterMap[id];
        if (!b) return null;
        const st = (sitCode && b.splits[sitCode]) || {};
        const ba = st.avg !== undefined ? Number(st.avg) : null;
        const obp = st.obp !== undefined ? Number(st.obp) : null;
        const slg = st.slg !== undefined ? Number(st.slg) : null;
        const hr = st.homeRuns !== undefined ? Number(st.homeRuns) : null;
        const iso = (slg !== null && ba !== null) ? Math.round((slg - ba) * 1000) / 1000 : null;
        return { id, name: b.name, hand: b.hand, hr, ba, obp, slg, iso };
      }).filter(Boolean);
    }

    const homePitcherHand = homeP && pitchers[homeP.id] ? pitchers[homeP.id].hand : null;
    const awayPitcherHand = awayP && pitchers[awayP.id] ? pitchers[awayP.id].hand : null;

    res.json({
      matched: true,
      home: {
        pitcher: pitcherPayload(homeP),
        lineupPosted: homeBatIds.length > 0,
        batters: battersPayload(homeBatIds, homeHit, awayPitcherHand)
      },
      away: {
        pitcher: pitcherPayload(awayP),
        lineupPosted: awayBatIds.length > 0,
        batters: battersPayload(awayBatIds, awayHit, homePitcherHand)
      }
    });
  }

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
    const etDate = new Date(Date.parse(props.body.commence_time || '') || now()).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    // ---- lineup / probable-starter context (enhancement — never blocks analysis) ----
    let lineupStatus = 'unavailable';
    const probablePitcherIds = new Set();
    const lineupIds = new Set();
    let lineupsPosted = false;
    try {
      const sched = await fetchStats(`/api/v1/schedule?sportId=1&date=${etDate}&hydrate=probablePitcher,lineups`, 15 * 60 * 1000);
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
    const pickMlbIds = new Map();
    try {
      for (const gk of Object.keys(grouped)) {
        const prop = grouped[gk];
        const cfg = MLB_MARKET_STATS[prop.market];
        const pid = await mlbPlayerId(prop.player, season);
        if (!pid) { skipped.add(prop.player); continue; }
        pickMlbIds.set(prop.player, pid);
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
    analysisCache.set(eventId, { body, expires: now() + cacheTtlMs });
    res.json(body);
  }

  async function gradePendingPicks(){
    const todayET = new Date(now()).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    for (const p of store.pending()) {
      if (!p.gameDate || !p.mlbId) continue;
      const cfg = MLB_MARKET_STATS[p.market];
      if (!cfg) continue;
      const daysPast = (Date.parse(todayET) - Date.parse(p.gameDate)) / 86400000;
      if (daysPast < 1) continue;
      let games;
      try {
        games = await mlbGameValues(p.mlbId, cfg.group, cfg.stat, new Date(Date.parse(p.gameDate)).getFullYear(), 5 * 60 * 1000);
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
  if (process.env.RAILWAY_ENVIRONMENT && !process.env.RAILWAY_VOLUME_MOUNT_PATH) {
    console.warn('store: RAILWAY detected but no volume attached — picks will be LOST on redeploy (attach a volume mounted at /data)');
  }
  createApp({
    apiKey: process.env.ODDS_API_KEY,
    dataDir: process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || './data',
    enableSweep: true
  }).listen(port, () => {
    console.log(`LineWatch listening on :${port}`);
  });
}
