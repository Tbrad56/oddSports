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

// MLB "first 5 innings" alternate-period markets. NOTE: the bulk /odds
// endpoint used below only serves h2h/spreads/totals — asking it for these
// period markets returns 422 INVALID_MARKET for the *entire* request, which
// silently kills the full-game odds too. Period markets are only available
// per event via /v4/sports/{sport}/events/{eventId}/odds (one extra upstream
// call per game), which isn't wired up yet — so these are unused for now and
// the F5 tab just shows its "not posted yet" empty state.
const MLB_F5_MARKETS = ['h2h_1st_5_innings', 'totals_1st_5_innings', 'spreads_1st_5_innings'];

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
      // The Odds API reports an exhausted monthly quota as 401 OUT_OF_USAGE_CREDITS, not 429
      let errBody = null;
      try { errBody = await upstream.json(); } catch (e) {}
      if (errBody && errBody.error_code === 'OUT_OF_USAGE_CREDITS') throw { kind: 'quota' };
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

  // Generic cached JSON fetch for the free public hosts (ESPN's scoreboard
  // and site API, NHL's api-web). Same cache map and error shape as fetchStats.
  async function fetchExternal(url, ttlMs){
    const hit = statsCache.get(url);
    if (hit && now() < hit.expires) return hit.body;
    let resp;
    try {
      resp = await fetchFn(url);
    } catch (e) {
      console.error(`External fetch failed for ${url}: ${e.message}`);
      throw { kind: 'stats' };
    }
    if (!resp.ok) {
      console.error(`External ${resp.status} for ${url}`);
      throw { kind: 'stats' };
    }
    let body;
    try {
      body = await resp.json();
    } catch (e) {
      console.error(`External returned unparseable JSON for ${url}`);
      throw { kind: 'stats' };
    }
    statsCache.set(url, { body, expires: now() + ttlMs });
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

  // ---------- NBA betting dashboard (all free ESPN endpoints) ----------
  // stats.nba.com blocks datacenter traffic, so advanced metrics are computed
  // here from ESPN box-score totals: possessions ≈ FGA - ORB + TOV + 0.44·FTA,
  // Pace = possessions/game, ORtg = 100·Pts/poss, DRtg = 100·OppPts/poss.
  const ESPN_NBA = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
  const NBA_TTL_MS = 12 * 60 * 60 * 1000;

  async function nbaTeams(){
    const data = await fetchExternal(`${ESPN_NBA}/teams?limit=32`, 24 * 60 * 60 * 1000);
    const teams = [];
    (data.sports?.[0]?.leagues?.[0]?.teams || []).forEach(t => {
      const team = t.team || {};
      teams.push({ id: team.id, name: team.displayName, abbrev: team.abbreviation,
        logo: (team.logos || [])[0]?.href || null });
    });
    return teams;
  }

  async function nbaStandingsMap(){
    const data = await fetchExternal('https://site.api.espn.com/apis/v2/sports/basketball/nba/standings', NBA_TTL_MS);
    const map = {};
    (data.children || []).forEach(conf => {
      (conf.standings?.entries || []).forEach(e => {
        const stats = {};
        (e.stats || []).forEach(s => { stats[s.name] = s.value; });
        map[e.team.id] = {
          wins: stats.wins, losses: stats.losses,
          ppg: stats.avgPointsFor, oppPpg: stats.avgPointsAgainst
        };
      });
    });
    return map;
  }

  async function nbaTeamMetrics(teamId){
    // seasontype=2 pins regular-season totals — the bare endpoint can serve a
    // playoff-only sample, which would corrupt possessions/ratings.
    const year = new Date(now()).getFullYear() + (new Date(now()).getMonth() >= 9 ? 1 : 0);
    const data = await fetchExternal(`${ESPN_NBA}/teams/${teamId}/statistics?season=${year}&seasontype=2`, NBA_TTL_MS);
    const vals = {};
    (data.results?.stats?.categories || data.statistics?.splits?.categories || []).forEach(cat => {
      (cat.stats || []).forEach(s => { if (s.name && s.value !== undefined) vals[s.name] = s.value; });
    });
    // Fall back over both response shapes ESPN serves for this endpoint
    if (!Object.keys(vals).length) {
      const walk = (o) => {
        if (Array.isArray(o)) return o.forEach(walk);
        if (o && typeof o === 'object') {
          if (o.name && typeof o.value === 'number' && vals[o.name] === undefined) vals[o.name] = o.value;
          Object.values(o).forEach(walk);
        }
      };
      walk(data);
    }
    const g = vals.gamesPlayed || 1;
    const fga = (vals.fieldGoalsAttempted || 0) / g;
    const fta = (vals.freeThrowsAttempted || 0) / g;
    const orb = (vals.offensiveRebounds || 0) / g;
    const tov = (vals.turnovers ?? vals.totalTurnovers ?? 0) / g;
    const pts = vals.avgPoints || ((vals.points || 0) / g);
    const poss = fga - orb + tov + 0.44 * fta;
    return { games: g, pts, poss: poss > 0 ? poss : null };
  }

  // Rest & scheduling context from the team's completed-games dates.
  async function nbaSchedule(teamId){
    let data = await fetchExternal(`${ESPN_NBA}/teams/${teamId}/schedule?seasontype=2`, NBA_TTL_MS);
    if (!(data.events || []).length) data = await fetchExternal(`${ESPN_NBA}/teams/${teamId}/schedule`, NBA_TTL_MS);
    const events = (data.events || []).map(ev => {
      const comp = (ev.competitions || [])[0] || {};
      const mine = (comp.competitors || []).find(c => String(c.team?.id) === String(teamId)) || {};
      return {
        date: ev.date,
        completed: !!comp.status?.type?.completed,
        home: mine.homeAway === 'home',
        pointsFor: mine.score ? Number(mine.score.value ?? mine.score.displayValue ?? mine.score) : null
      };
    }).filter(e => e.date);
    const done = events.filter(e => e.completed).sort((a,b)=>new Date(a.date)-new Date(b.date));
    const today = new Date(now());
    const daysBetween = (a,b) => Math.round((b - a) / 86400000);
    const last = done[done.length - 1];
    const lastDates = done.slice(-8).map(e => new Date(e.date));
    const inWindow = (days) => lastDates.filter(d => daysBetween(d, today) < days).length;
    let streakType = null, streakLen = 0;
    for (let i = done.length - 1; i >= 0; i--) {
      const t = done[i].home ? 'home' : 'road';
      if (streakType === null) streakType = t;
      if (t !== streakType) break;
      streakLen++;
    }
    const last10 = done.slice(-10);
    return {
      daysRest: last ? Math.max(0, daysBetween(new Date(last.date), today) - 1) : null,
      backToBack: last ? daysBetween(new Date(last.date), today) <= 1 : false,
      threeInFour: inWindow(4) >= 3,
      fourInSix: inWindow(6) >= 4,
      streakType, streakLen,
      last10Ppg: last10.length ? last10.reduce((s,e)=>s+(e.pointsFor||0),0) / last10.length : null,
      gamesPlayed: done.length
    };
  }

  async function nbaInjuries(teamId){
    try {
      const data = await fetchExternal(`${ESPN_NBA}/teams/${teamId}/injuries`, 60 * 60 * 1000);
      const list = [];
      (data.injuries || []).forEach(group => {
        (group.injuries || [group]).forEach(inj => {
          const athlete = inj.athlete || {};
          if (athlete.displayName) list.push({
            name: athlete.displayName,
            status: inj.status || inj.type?.description || '',
            detail: inj.details?.type || inj.shortComment || ''
          });
        });
      });
      return list;
    } catch (e) { return []; }
  }

  app.get('/api/nba/teams', (req, res) => {
    nbaTeams().then(t => res.json({ teams: t })).catch(err => sendUpstreamError(res, err));
  });

  app.get('/api/nba/matchup', (req, res) => {
    (async () => {
      const { home, away } = req.query;
      if (!/^\d{1,4}$/.test(String(home||'')) || !/^\d{1,4}$/.test(String(away||''))) {
        return res.status(400).json({ error: 'home and away team ids required' });
      }
      const [teams, standings] = await Promise.all([nbaTeams(), nbaStandingsMap()]);
      const teamOf = id => teams.find(t => String(t.id) === String(id));
      const hTeam = teamOf(home), aTeam = teamOf(away);
      if (!hTeam || !aTeam) return res.status(400).json({ error: 'Unknown team id' });

      // League-wide metrics for real ranks (30 cached calls, 12h TTL)
      const metricRows = await Promise.all(teams.map(async t => {
        try {
          const m = await nbaTeamMetrics(t.id);
          const st = standings[t.id] || {};
          if (!m.poss || st.ppg === undefined) return null;
          const ortg = 100 * st.ppg / m.poss;
          const drtg = 100 * st.oppPpg / m.poss;
          return { id: t.id, pace: m.poss, ortg, drtg, net: ortg - drtg, ppg: st.ppg };
        } catch (e) { return null; }
      }));
      const rows = metricRows.filter(Boolean);
      const rankOf = (id, key, desc = true) => {
        const sorted = rows.slice().sort((a,b)=> desc ? b[key]-a[key] : a[key]-b[key]);
        const i = sorted.findIndex(r => String(r.id) === String(id));
        return i === -1 ? null : i + 1;
      };

      async function sideFor(team){
        const st = standings[team.id] || {};
        const row = rows.find(r => String(r.id) === String(team.id)) || {};
        const [sched, injuries] = await Promise.all([nbaSchedule(team.id), nbaInjuries(team.id)]);
        return {
          team,
          record: st.wins !== undefined ? `${st.wins}-${st.losses}` : null,
          ppg: st.ppg ?? null, oppPpg: st.oppPpg ?? null,
          pace: row.pace ?? null, ortg: row.ortg ?? null, drtg: row.drtg ?? null, net: row.net ?? null,
          ranks: {
            pace: rankOf(team.id, 'pace'),
            ortg: rankOf(team.id, 'ortg'),
            drtg: rankOf(team.id, 'drtg', false),
            net: rankOf(team.id, 'net')
          },
          schedule: sched,
          injuries
        };
      }
      const [h, a] = await Promise.all([sideFor(hTeam), sideFor(aTeam)]);

      // ---- rule-based insight engine (deterministic, no LLM) ----
      const insights = [];
      const leans = [];
      let confidence = 5;
      if (h.ranks.pace && a.ranks.pace && h.ranks.pace <= 10 && a.ranks.pace <= 10) {
        insights.push(`Both teams rank top-10 in pace (#${a.ranks.pace} and #${h.ranks.pace}) — a favorable environment for the Over.`);
        leans.push('Lean Over on the total'); confidence += 0.8;
      } else if (h.ranks.pace && a.ranks.pace && h.ranks.pace >= 21 && a.ranks.pace >= 21) {
        insights.push(`Both teams play bottom-10 pace — points may come slow.`);
        leans.push('Lean Under on the total'); confidence += 0.6;
      }
      if (h.net !== null && a.net !== null) {
        const diff = h.net - a.net;
        const better = diff > 0 ? h : a;
        if (Math.abs(diff) >= 4) {
          insights.push(`${better.team.name} hold a ${Math.abs(diff).toFixed(1)}-point Net Rating edge.`);
          leans.push(`${better.team.name} spread`); confidence += Math.min(1.5, Math.abs(diff) * 0.15);
        }
      }
      const restDiff = (h.schedule.daysRest ?? 0) - (a.schedule.daysRest ?? 0);
      [[h, a], [a, h]].forEach(([x, y]) => {
        if (x.schedule.backToBack && (y.schedule.daysRest ?? 0) >= 2) {
          insights.push(`${x.team.name} are on a back-to-back while ${y.team.name} have ${y.schedule.daysRest} days of rest.`);
          leans.push(`${y.team.name} rest edge`); confidence += 0.7;
        } else if (x.schedule.threeInFour) {
          insights.push(`${x.team.name} are playing their 3rd game in 4 nights.`);
          confidence += 0.3;
        }
      });
      [h, a].forEach(s => {
        if (s.injuries.length >= 3) {
          insights.push(`${s.team.name} list ${s.injuries.length} players on the injury report.`);
          confidence += 0.3;
        }
      });
      if (!insights.length) insights.push('No strong statistical edges detected — this projects as a fairly even matchup.');

      res.json({
        home: h, away: a,
        summary: {
          insights,
          leans: [...new Set(leans)],
          confidence: Math.round(Math.min(9.5, confidence) * 10) / 10,
          note: 'Auto-generated from the numbers above — context, not picks. No referee or positional-defense data exists on a free feed, so those factors are not modeled.'
        }
      });
    })().catch(err => sendUpstreamError(res, err));
  });

  app.get('/api/nba/roster', (req, res) => {
    (async () => {
      const { team } = req.query;
      if (!/^\d{1,4}$/.test(String(team||''))) return res.status(400).json({ error: 'team id required' });
      const data = await fetchExternal(`${ESPN_NBA}/teams/${team}/roster`, NBA_TTL_MS);
      const players = [];
      (data.athletes || []).forEach(a => {
        players.push({ id: a.id, name: a.displayName, position: a.position?.abbreviation || '', headshot: a.headshot?.href || null });
      });
      res.json({ players });
    })().catch(err => sendUpstreamError(res, err));
  });

  // Player form: last-10 vs season, plus home/away split — powers both the
  // Matchup Analyzer and the Hot Players scan.
  app.get('/api/nba/player-form', (req, res) => {
    (async () => {
      const { id } = req.query;
      if (!/^\d{1,10}$/.test(String(id||''))) return res.status(400).json({ error: 'player id required' });
      const data = await fetchExternal(
        `https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/${id}/gamelog`,
        STATS_TTL_MS
      );
      const labels = data.labels || data.names || [];
      const idx = k => labels.indexOf(k);
      const games = [];
      Object.values(data.seasonTypes || {}).forEach(stype => {
        ((stype && stype.categories) || []).forEach(cat => {
          (cat.events || []).forEach(ev => { if (ev.stats) games.push(ev); });
        });
      });
      const evMeta = data.events || {};
      const rows = games.map(g => {
        const meta = evMeta[g.eventId] || {};
        return { stats: g.stats, home: meta.atVs === 'vs', date: meta.gameDate };
      }).sort((a,b)=> new Date(b.date||0) - new Date(a.date||0));
      const num = (r, k) => { const i = idx(k); return i === -1 ? null : Number(r.stats[i]); };
      const avg = (list, k) => {
        const v = list.map(r => num(r, k)).filter(x => x !== null && !isNaN(x));
        return v.length ? Math.round(v.reduce((s,x)=>s+x,0) / v.length * 10) / 10 : null;
      };
      const pack = list => ({ games: list.length, pts: avg(list,'PTS'), reb: avg(list,'REB'), ast: avg(list,'AST'), min: avg(list,'MIN'), fgPct: avg(list,'FG%') });
      res.json({
        last10: pack(rows.slice(0, 10)),
        season: pack(rows),
        home: pack(rows.filter(r=>r.home)),
        away: pack(rows.filter(r=>!r.home))
      });
    })().catch(err => sendUpstreamError(res, err));
  });

  // ---------- Player stat search (all free, keyless public APIs) ----------
  // ESPN's search covers every league we track and returns headshots;
  // stats come from ESPN's athlete overview, except MLB which gets the far
  // richer StatsAPI treatment (plus Statcast via the static JSON on the page).
  const ESPN_LEAGUES = {
    // ESPN league label (from search results) -> [espn sport path, espn league path, our display tag]
    'NBA':   ['basketball', 'nba', 'NBA'],
    'WNBA':  ['basketball', 'wnba', 'WNBA'],
    'NFL':   ['football', 'nfl', 'NFL'],
    'NHL':   ['hockey', 'nhl', 'NHL'],
    'MLB':   ['baseball', 'mlb', 'MLB'],
    'NCAAM': ['basketball', 'mens-college-basketball', 'NCAAM'],
    'NCAAF': ['football', 'college-football', 'NCAAF'],
    'UFC':   ['mma', 'ufc', 'UFC'],
    'English Premier League': ['soccer', 'eng.1', 'EPL'],
    'Premier League': ['soccer', 'eng.1', 'EPL']
  };
  const STATS_TTL_MS = 6 * 60 * 60 * 1000;

  app.get('/api/stats/search', (req, res) => {
    (async () => {
      const q = String(req.query.q || '').trim();
      if (q.length < 2) return res.json({ results: [] });
      if (q.length > 60) return res.status(400).json({ error: 'Query too long' });
      const data = await fetchExternal(
        `https://site.web.api.espn.com/apis/search/v2?query=${encodeURIComponent(q)}&limit=40`,
        30 * 60 * 1000
      );
      const results = [];
      (data.results || []).forEach(r => {
        if (r.type !== 'player') return;
        (r.contents || []).forEach(c => {
          const league = ESPN_LEAGUES[c.description];
          if (!league) return; // league we don't track
          // uid like "s:40~l:46~a:1966" — the athlete id is the a: part
          const m = /~a:(\d+)/.exec(c.uid || '');
          if (!m) return;
          results.push({
            name: c.displayName,
            league: league[2],
            leagueKey: `${league[0]}/${league[1]}`,
            athleteId: m[1],
            headshot: (c.image && c.image.default) || null
          });
        });
      });
      res.json({ results: results.slice(0, 25) });
    })().catch(err => sendUpstreamError(res, err));
  });

  app.get('/api/stats/player', (req, res) => {
    (async () => {
      const { leagueKey, id, name } = req.query;
      if (!/^\d{1,10}$/.test(String(id || ''))) return res.status(400).json({ error: 'Bad athlete id' });
      const known = Object.values(ESPN_LEAGUES).some(([s, l]) => `${s}/${l}` === leagueKey);
      if (!known) return res.status(400).json({ error: 'Unknown league' });

      const out = { espn: null, mlb: null };
      try {
        const ov = await fetchExternal(
          `https://site.web.api.espn.com/apis/common/v3/sports/${leagueKey}/athletes/${id}/overview`,
          STATS_TTL_MS
        );
        const st = ov.statistics || {};
        out.espn = {
          labels: st.labels || [],
          splits: (st.splits || []).map(s => ({ name: s.displayName, stats: s.stats || [] }))
        };
      } catch (e) { /* stat block just stays empty for this league */ }

      // MLB bonus: season hitting/pitching from StatsAPI, matched by name
      if (leagueKey === 'baseball/mlb' && name) {
        try {
          const season = new Date(now()).getFullYear();
          const pid = await mlbPlayerId(name, season);
          if (pid) {
            const data = await fetchStats(
              `/api/v1/people/${pid}?hydrate=stats(group=[hitting,pitching],type=[season],season=${season}),currentTeam`,
              STATS_TTL_MS
            );
            const person = (data.people || [])[0];
            if (person) {
              const groups = {};
              (person.stats || []).forEach(sg => {
                const grp = sg.group && sg.group.displayName;
                const split = (sg.splits || [])[0];
                if (grp && split && split.stat) groups[grp] = split.stat;
              });
              out.mlb = {
                mlbId: pid,
                team: person.currentTeam ? person.currentTeam.name : null,
                position: person.primaryPosition ? person.primaryPosition.abbreviation : null,
                season,
                hitting: groups.hitting || null,
                pitching: groups.pitching || null
              };
            }
          }
        } catch (e) { /* MLB enrichment is a bonus */ }
      }
      res.json(out);
    })().catch(err => sendUpstreamError(res, err));
  });

  app.get('/api/odds/:sport', (req, res) => {
    const { sport } = req.params;
    if (!SPORTS.has(sport)) return res.status(400).json({ error: 'Unknown sport' });
    // MLB only: full-game spreads/totals alongside moneyline — Board's Game
    // Lines grid needs Spread/Total/Money for MLB specifically. F5 markets
    // are deliberately NOT requested here (see MLB_F5_MARKETS above).
    const markets = sport === 'baseball_mlb' ? ['h2h', 'spreads', 'totals'] : ['h2h'];
    proxy(`/v4/sports/${sport}/odds/?regions=us&markets=${markets.join(',')}&oddsFormat=american&includeLinks=true&includeSids=true`, res);
  });

  // Live/recent scores — served from ESPN's free public scoreboard instead of
  // The Odds API. The old upstream cost 2 credits per call on a 30s poll
  // (~240 credits/hour with one open Board tab); ESPN costs nothing. Response
  // is normalized to the same shape the frontend always used, with team-name
  // matching instead of Odds API event ids.
  const ESPN_SCOREBOARDS = {
    baseball_mlb: 'baseball/mlb',
    basketball_nba: 'basketball/nba',
    americanfootball_nfl: 'football/nfl',
    icehockey_nhl: 'hockey/nhl',
    americanfootball_ncaaf: 'football/college-football',
    basketball_ncaab: 'basketball/mens-college-basketball',
    soccer_epl: 'soccer/eng.1',
    mma_mixed_martial_arts: 'mma/ufc'
  };
  async function getScores(sport){
    const path = ESPN_SCOREBOARDS[sport];
    const data = await fetchExternal(`https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard`, SCORES_TTL_MS);
    return (data.events || []).map(ev => {
      const comp = (ev.competitions || [])[0] || {};
      const started = (ev.status && ev.status.type && ev.status.type.state) !== 'pre';
      return {
        id: ev.id,
        commence_time: ev.date,
        completed: !!(ev.status && ev.status.type && ev.status.type.completed),
        home_team: ((comp.competitors || []).find(c => c.homeAway === 'home') || {}).team?.displayName || '',
        away_team: ((comp.competitors || []).find(c => c.homeAway === 'away') || {}).team?.displayName || '',
        scores: started ? (comp.competitors || []).map(c => ({
          name: (c.team && c.team.displayName) || '',
          score: c.score != null ? String(c.score) : ''
        })) : null
      };
    });
  }
  app.get('/api/scores/:sport', (req, res) => {
    const { sport } = req.params;
    if (!SPORTS.has(sport)) return res.status(400).json({ error: 'Unknown sport' });
    getScores(sport).then(body => {
      res.set('x-cache-age-seconds', '0');
      res.json(body);
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
      r = await getUpstream(`/v4/sports/${sport}/events/${eventId}/odds/?regions=us&markets=${markets.join(',')}&oddsFormat=american&includeLinks=true&includeSids=true`);
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

    // Career batter-vs-pitcher numbers (one batched call per lineup).
    // Best-effort: a miss just means no "vs this pitcher" column data.
    async function getBvp(batterIds, pitcherId){
      if (!batterIds.length || !pitcherId) return {};
      const path = `/api/v1/people?personIds=${batterIds.join(',')}&hydrate=stats(group=[hitting],type=[vsPlayerTotal],opposingPlayerId=${pitcherId})`;
      const out = {};
      try {
        const data = await fetchStats(path, 6 * 60 * 60 * 1000);
        (data.people || []).forEach(p => {
          const split = (((p.stats || [])[0] || {}).splits || [])[0];
          if (!split || !split.stat) return;
          const st = split.stat;
          out[p.id] = {
            ab: Number(st.atBats) || 0,
            hits: Number(st.hits) || 0,
            hr: Number(st.homeRuns) || 0,
            avg: st.avg || null,
            ops: st.ops || null
          };
        });
      } catch (e) { /* column simply stays empty */ }
      return out;
    }

    let pitchers, homeHit, awayHit, homeBvp, awayBvp;
    try {
      [pitchers, homeHit, awayHit, homeBvp, awayBvp] = await Promise.all([
        getPeopleSplits(pitcherIds, 'pitching', season),
        getPeopleSplits(homeBatIds, 'hitting', season),
        getPeopleSplits(awayBatIds, 'hitting', season),
        getBvp(homeBatIds, awayP && awayP.id),   // home batters face the away pitcher
        getBvp(awayBatIds, homeP && homeP.id)    // away batters face the home pitcher
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

    function battersPayload(batterIds, batterMap, oppHand, bvpMap){
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
        return { id, name: b.name, hand: b.hand, hr, ba, obp, slg, iso, bvp: (bvpMap && bvpMap[id]) || null };
      }).filter(Boolean);
    }

    const homePitcherHand = homeP && pitchers[homeP.id] ? pitchers[homeP.id].hand : null;
    const awayPitcherHand = awayP && pitchers[awayP.id] ? pitchers[awayP.id].hand : null;

    res.json({
      matched: true,
      home: {
        pitcher: pitcherPayload(homeP),
        lineupPosted: homeBatIds.length > 0,
        batters: battersPayload(homeBatIds, homeHit, awayPitcherHand, homeBvp)
      },
      away: {
        pitcher: pitcherPayload(awayP),
        lineupPosted: awayBatIds.length > 0,
        batters: battersPayload(awayBatIds, awayHit, homePitcherHand, awayBvp)
      }
    });
  }

  // Both starting pitchers for a scheduled MLB game — a lighter sibling of
  // /api/hr-matchups/mlb (no splits/lineups), shown automatically on every
  // MLB board card rather than opt-in. Shares getMlbScheduleGame's cached
  // schedule fetch, so this doesn't cost an extra StatsAPI call per card.
  app.get('/api/pitchers/mlb', (req, res) => {
    handlePitchers(req, res).catch(err => {
      console.error(`Pitchers failed: ${err && err.message || err}`);
      if (!res.headersSent) res.status(502).json({ error: 'Stats service unavailable' });
    });
  });

  async function handlePitchers(req, res){
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

    const toPitcher = p => (p && p.id) ? { id: p.id, name: p.fullName || null } : null;
    res.json({
      matched: true,
      home: toPitcher(mg.teams.home.probablePitcher),
      away: toPitcher(mg.teams.away.probablePitcher)
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
      props = await getUpstream(`/v4/sports/baseball_mlb/events/${eventId}/odds/?regions=us&markets=${markets.join(',')}&oddsFormat=american&includeLinks=true&includeSids=true`);
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
          const row = { bookKey: bm.key, bookTitle: bm.title, odds: o.price, link: o.link || bm.link || null, sid: o.sid || null, marketSid: m.sid || null };
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
  // ODDS_CACHE_MINUTES stretches how long odds/props responses are reused
  // before spending fresh credits. Default 10; raise to 30–60 to sip quota.
  const cacheMinutes = Math.max(1, Number(process.env.ODDS_CACHE_MINUTES) || 10);
  createApp({
    apiKey: process.env.ODDS_API_KEY,
    cacheTtlMs: cacheMinutes * 60 * 1000,
    dataDir: process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || './data',
    enableSweep: true
  }).listen(port, () => {
    console.log(`LineWatch listening on :${port} (odds cached ${cacheMinutes} min)`);
  });
}
