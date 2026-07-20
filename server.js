require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { analyzeProp, rankPicks } = require('./analysis');
const { createStore, computeRecord } = require('./store');
const { createAuthStore } = require('./auth');
const {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse
} = require('@simplewebauthn/server');

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

function createApp({
  apiKey, fetchFn = fetch, cacheTtlMs = 10 * 60 * 1000, now = Date.now, dataDir = null, enableSweep = false,
  enableAuth = false, sessionSecret = null
} = {}) {
  const app = express();
  app.set('trust proxy', 1); // Railway terminates TLS; this makes req.secure/req.protocol honor X-Forwarded-Proto
  app.use(express.json({ limit: '64kb' }));
  const cache = new Map(); // upstreamPath -> {body, remaining, cachedAt, expires}
  const statsCache = new Map(); // statsapi path -> {body, expires}
  const analysisCache = new Map(); // eventId -> {body, expires}
  const store = createStore({ dataDir });

  // ---------- Auth gate: single-user password + optional WebAuthn (Face ID /
  // Touch ID / Windows Hello) lock screen. Opt-in via enableAuth so every
  // existing test and the local-dev default keep working with zero setup;
  // the real production boot below turns it on. ----------
  if (enableAuth) {
    if (!sessionSecret) throw new Error('enableAuth requires a sessionSecret');
    const authStore = createAuthStore({ dataDir });
    const SESSION_COOKIE = 'lw_session';
    const SESSION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

    function signSession(payload){
      const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const sig = crypto.createHmac('sha256', sessionSecret).update(body).digest('base64url');
      return `${body}.${sig}`;
    }
    function verifySessionToken(token){
      if (!token || typeof token !== 'string' || !token.includes('.')) return null;
      const [body, sig] = token.split('.');
      const expected = crypto.createHmac('sha256', sessionSecret).update(body).digest('base64url');
      const a = Buffer.from(sig), b = Buffer.from(expected);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
      try {
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
        if (!payload.exp || Date.now() > payload.exp) return null;
        return payload;
      } catch (e) { return null; }
    }
    function parseCookies(req){
      const header = req.headers.cookie || '';
      const out = {};
      header.split(';').forEach(part => {
        const i = part.indexOf('=');
        if (i === -1) return;
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
      });
      return out;
    }
    function getSession(req){
      return verifySessionToken(parseCookies(req)[SESSION_COOKIE]);
    }
    function setSessionCookie(req, res, username){
      const token = signSession({ u: username, exp: Date.now() + SESSION_MS });
      const attrs = [`${SESSION_COOKIE}=${token}`, 'HttpOnly', 'Path=/', 'SameSite=Lax', `Max-Age=${Math.floor(SESSION_MS/1000)}`];
      if (req.secure) attrs.push('Secure');
      res.set('Set-Cookie', attrs.join('; '));
    }
    function clearSessionCookie(req, res){
      const attrs = [`${SESSION_COOKIE}=`, 'HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=0'];
      if (req.secure) attrs.push('Secure');
      res.set('Set-Cookie', attrs.join('; '));
    }
    function rpIdOf(req){ return req.hostname || 'localhost'; }
    function originOf(req){ return `${req.protocol}://${req.get('host')}`; }

    // Basic brute-force throttle on the password endpoint. In-memory, so it
    // resets on restart and doesn't share state across instances — acceptable
    // for a single-instance personal deployment, not a substitute for real
    // rate limiting at scale.
    const loginAttempts = new Map(); // ip -> {count, resetAt}
    function tooManyAttempts(ip){
      const hit = loginAttempts.get(ip);
      if (!hit || Date.now() > hit.resetAt) return false;
      return hit.count >= 10;
    }
    function recordAttempt(ip){
      const hit = loginAttempts.get(ip);
      if (!hit || Date.now() > hit.resetAt) {
        loginAttempts.set(ip, { count: 1, resetAt: Date.now() + 15 * 60 * 1000 });
      } else {
        hit.count++;
      }
    }

    // Single pending challenge slots — fine for a single-user app; a second
    // in-flight attempt just invalidates the first rather than causing any
    // security issue.
    let pendingRegChallenge = null;
    let pendingLoginChallenge = null;

    app.get('/api/auth/status', (req, res) => {
      res.json({
        configured: authStore.hasCredentials(),
        username: authStore.hasCredentials() ? authStore.username() : null,
        webauthnEnabled: authStore.webauthnCredentials().length > 0,
        authenticated: !!getSession(req)
      });
    });

    app.post('/api/auth/setup', (req, res) => {
      if (authStore.hasCredentials()) return res.status(409).json({ error: 'Already configured' });
      const { username, password } = req.body || {};
      if (typeof username !== 'string' || !username.trim() || username.length > 64) {
        return res.status(400).json({ error: 'Choose a username (1-64 characters)' });
      }
      if (typeof password !== 'string' || password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      }
      authStore.setPassword(username.trim(), password);
      setSessionCookie(req, res, username.trim());
      res.json({ ok: true });
    });

    app.post('/api/auth/login', (req, res) => {
      const ip = req.ip || 'unknown';
      if (tooManyAttempts(ip)) return res.status(429).json({ error: 'Too many attempts — try again in 15 minutes' });
      const { username, password } = req.body || {};
      if (typeof username !== 'string' || typeof password !== 'string' || !authStore.verifyPassword(username, password)) {
        recordAttempt(ip);
        return res.status(401).json({ error: 'Invalid username or password' });
      }
      setSessionCookie(req, res, username);
      res.json({ ok: true });
    });

    app.post('/api/auth/logout', (req, res) => {
      clearSessionCookie(req, res);
      res.json({ ok: true });
    });

    // Register a new Face ID / Touch ID / Windows Hello credential — only
    // once already logged in via password, so this can't be used to create
    // a backdoor without first proving the password.
    app.post('/api/auth/webauthn/register-options', async (req, res) => {
      const session = getSession(req);
      if (!session) return res.status(401).json({ error: 'Log in with your password first' });
      try {
        const options = await generateRegistrationOptions({
          rpName: 'LineWatch',
          rpID: rpIdOf(req),
          userName: authStore.username(),
          userID: Buffer.from(authStore.username()),
          attestationType: 'none',
          excludeCredentials: authStore.webauthnCredentials().map(c => ({ id: c.credentialID, transports: c.transports })),
          authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred', authenticatorAttachment: 'platform' }
        });
        pendingRegChallenge = { challenge: options.challenge, expires: Date.now() + 5 * 60 * 1000 };
        res.json(options);
      } catch (e) {
        res.status(500).json({ error: 'Could not start biometric setup' });
      }
    });

    app.post('/api/auth/webauthn/register-verify', async (req, res) => {
      const session = getSession(req);
      if (!session) return res.status(401).json({ error: 'Log in with your password first' });
      if (!pendingRegChallenge || Date.now() > pendingRegChallenge.expires) {
        return res.status(400).json({ error: 'Registration expired — try again' });
      }
      try {
        const verification = await verifyRegistrationResponse({
          response: req.body,
          expectedChallenge: pendingRegChallenge.challenge,
          expectedOrigin: originOf(req),
          expectedRPID: rpIdOf(req)
        });
        pendingRegChallenge = null;
        if (!verification.verified || !verification.registrationInfo) {
          return res.status(400).json({ error: 'Could not verify biometric registration' });
        }
        const { credential } = verification.registrationInfo;
        authStore.addWebauthnCredential({
          credentialID: credential.id,
          publicKey: Buffer.from(credential.publicKey).toString('base64'),
          counter: credential.counter,
          transports: (req.body.response && req.body.response.transports) || []
        });
        res.json({ ok: true });
      } catch (e) {
        res.status(400).json({ error: 'Could not verify biometric registration' });
      }
    });

    // Unauthenticated by design — this IS how you log in without a password.
    app.post('/api/auth/webauthn/login-options', async (req, res) => {
      const creds = authStore.webauthnCredentials();
      if (!creds.length) return res.status(400).json({ error: 'No biometric login set up yet' });
      try {
        const options = await generateAuthenticationOptions({
          rpID: rpIdOf(req),
          allowCredentials: creds.map(c => ({ id: c.credentialID, transports: c.transports })),
          userVerification: 'preferred'
        });
        pendingLoginChallenge = { challenge: options.challenge, expires: Date.now() + 5 * 60 * 1000 };
        res.json(options);
      } catch (e) {
        res.status(500).json({ error: 'Could not start biometric login' });
      }
    });

    app.post('/api/auth/webauthn/login-verify', async (req, res) => {
      if (!pendingLoginChallenge || Date.now() > pendingLoginChallenge.expires) {
        return res.status(400).json({ error: 'Login expired — try again' });
      }
      const stored = authStore.webauthnCredentials().find(c => c.credentialID === req.body.id);
      if (!stored) return res.status(400).json({ error: 'Unrecognized credential' });
      try {
        const verification = await verifyAuthenticationResponse({
          response: req.body,
          expectedChallenge: pendingLoginChallenge.challenge,
          expectedOrigin: originOf(req),
          expectedRPID: rpIdOf(req),
          credential: {
            id: stored.credentialID,
            publicKey: Buffer.from(stored.publicKey, 'base64'),
            counter: stored.counter,
            transports: stored.transports
          }
        });
        pendingLoginChallenge = null;
        if (!verification.verified) return res.status(400).json({ error: 'Could not verify biometric login' });
        authStore.updateWebauthnCounter(stored.credentialID, verification.authenticationInfo.newCounter);
        setSessionCookie(req, res, authStore.username());
        res.json({ ok: true });
      } catch (e) {
        res.status(400).json({ error: 'Could not verify biometric login' });
      }
    });

    // The actual gate. Registered before every other route below, so nothing
    // — API or static file — is reachable without a valid session, except
    // the /api/auth/* endpoints above and the self-contained lock screen.
    app.use((req, res, next) => {
      if (req.path.startsWith('/api/auth/') || req.path === '/lock.html') return next();
      if (getSession(req)) return next();
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
      res.sendFile(path.join(__dirname, 'public', 'lock.html'));
    });
  }

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
            id: athlete.id || null,
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

  // Parses one gamelog response into per-game rows tagged with opponent id.
  function gamelogRows(data){
    const games = [];
    Object.values(data.seasonTypes || {}).forEach(stype => {
      ((stype && stype.categories) || []).forEach(cat => {
        (cat.events || []).forEach(ev => { if (ev.stats) games.push(ev); });
      });
    });
    const evMeta = data.events || {};
    return games.map(g => {
      const meta = evMeta[g.eventId] || {};
      return {
        eventId: g.eventId, stats: g.stats,
        home: meta.atVs === 'vs', date: meta.gameDate,
        oppId: meta.opponent ? String(meta.opponent.id) : null,
        oppAbbrev: meta.opponent ? meta.opponent.abbreviation : null
      };
    });
  }

  // Current gamelog plus up to two prior seasons (each a cached call) —
  // enough history for a real "vs this opponent" sample without hammering ESPN.
  async function gamelogMultiSeason(sportPath, id, endYear){
    const base = await fetchExternal(
      `https://site.web.api.espn.com/apis/common/v3/sports/${sportPath}/athletes/${id}/gamelog`,
      STATS_TTL_MS
    );
    const labels = base.labels || base.names || [];
    const seen = new Set();
    const rows = [];
    const add = data => gamelogRows(data).forEach(r => {
      if (!seen.has(r.eventId)) { seen.add(r.eventId); rows.push(r); }
    });
    add(base);
    for (const y of [endYear - 1, endYear - 2]) {
      try {
        add(await fetchExternal(
          `https://site.web.api.espn.com/apis/common/v3/sports/${sportPath}/athletes/${id}/gamelog?season=${y}`,
          STATS_TTL_MS
        ));
      } catch (e) { /* season may not exist for this player */ }
    }
    rows.sort((a,b)=> new Date(b.date||0) - new Date(a.date||0));
    return { labels, rows };
  }

  // Player form: last-10 vs season, home/away split, and (when vsTeam is the
  // opposing ESPN team id) a 3-season history against that specific opponent.
  app.get('/api/nba/player-form', (req, res) => {
    (async () => {
      const { id, vsTeam } = req.query;
      if (!/^\d{1,10}$/.test(String(id||''))) return res.status(400).json({ error: 'player id required' });
      const wantVs = /^\d{1,4}$/.test(String(vsTeam||''));
      const endYear = new Date(now()).getFullYear();

      let labels, allRows;
      if (wantVs) {
        ({ labels, rows: allRows } = await gamelogMultiSeason('basketball/nba', id, endYear));
      } else {
        const data = await fetchExternal(
          `https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/${id}/gamelog`,
          STATS_TTL_MS
        );
        labels = data.labels || data.names || [];
        allRows = gamelogRows(data).sort((a,b)=> new Date(b.date||0) - new Date(a.date||0));
      }
      const idx = k => labels.indexOf(k);
      const num = (r, k) => { const i = idx(k); return i === -1 ? null : Number(r.stats[i]); };
      const avg = (list, k) => {
        const v = list.map(r => num(r, k)).filter(x => x !== null && !isNaN(x));
        return v.length ? Math.round(v.reduce((s,x)=>s+x,0) / v.length * 10) / 10 : null;
      };
      const pack = list => ({ games: list.length, pts: avg(list,'PTS'), reb: avg(list,'REB'), ast: avg(list,'AST'), min: avg(list,'MIN'), fgPct: avg(list,'FG%') });

      // Current-season rows = most recent gamelog's worth (first fetch covers it);
      // season splits below intentionally use only the newest ~season of rows.
      const seasonRows = wantVs ? allRows.slice(0, 82).filter(r => new Date(r.date) > new Date(now() - 370*86400000)) : allRows;
      const out = {
        last10: pack(seasonRows.slice(0, 10)),
        season: pack(seasonRows),
        home: pack(seasonRows.filter(r=>r.home)),
        away: pack(seasonRows.filter(r=>!r.home))
      };
      if (wantVs) {
        const vsRows = allRows.filter(r => r.oppId === String(vsTeam));
        out.vsOpponent = {
          ...pack(vsRows),
          abbrev: vsRows[0] ? vsRows[0].oppAbbrev : null,
          meetings: vsRows.slice(0, 5).map(r => ({
            date: r.date ? String(r.date).slice(0, 10) : null,
            home: r.home,
            pts: num(r,'PTS'), reb: num(r,'REB'), ast: num(r,'AST')
          }))
        };
      }
      res.json(out);
    })().catch(err => sendUpstreamError(res, err));
  });

  // ---------- NFL betting dashboard (all free ESPN + Open-Meteo) ----------
  const ESPN_NFL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
  const NFL_TTL_MS = 12 * 60 * 60 * 1000;

  // Stadium coords + roof flags for the weather card (approximate venue lat/lon).
  const NFL_STADIUMS = {
    ARI:{lat:33.5276,lon:-112.2626,dome:true},  ATL:{lat:33.7554,lon:-84.4008,dome:true},
    BAL:{lat:39.2780,lon:-76.6227},             BUF:{lat:42.7738,lon:-78.7870},
    CAR:{lat:35.2258,lon:-80.8528},             CHI:{lat:41.8623,lon:-87.6167},
    CIN:{lat:39.0955,lon:-84.5161},             CLE:{lat:41.5061,lon:-81.6995},
    DAL:{lat:32.7473,lon:-97.0945,dome:true},   DEN:{lat:39.7439,lon:-105.0201},
    DET:{lat:42.3400,lon:-83.0456,dome:true},   GB:{lat:44.5013,lon:-88.0622},
    HOU:{lat:29.6847,lon:-95.4107,dome:true},   IND:{lat:39.7601,lon:-86.1639,dome:true},
    JAX:{lat:30.3240,lon:-81.6373},             KC:{lat:39.0489,lon:-94.4839},
    LAC:{lat:33.9535,lon:-118.3392,dome:true},  LAR:{lat:33.9535,lon:-118.3392,dome:true},
    LV:{lat:36.0909,lon:-115.1833,dome:true},   MIA:{lat:25.9580,lon:-80.2389},
    MIN:{lat:44.9736,lon:-93.2575,dome:true},   NE:{lat:42.0909,lon:-71.2643},
    NO:{lat:29.9511,lon:-90.0812,dome:true},    NYG:{lat:40.8128,lon:-74.0742},
    NYJ:{lat:40.8128,lon:-74.0742},             PHI:{lat:39.9008,lon:-75.1675},
    PIT:{lat:40.4468,lon:-80.0158},             SEA:{lat:47.5952,lon:-122.3316},
    SF:{lat:37.4030,lon:-121.9696},             TB:{lat:27.9759,lon:-82.5033},
    TEN:{lat:36.1665,lon:-86.7713},             WSH:{lat:38.9076,lon:-76.8645}
  };

  async function nflTeams(){
    const data = await fetchExternal(`${ESPN_NFL}/teams?limit=34`, 24 * 60 * 60 * 1000);
    const teams = [];
    (data.sports?.[0]?.leagues?.[0]?.teams || []).forEach(t => {
      const team = t.team || {};
      teams.push({ id: team.id, name: team.displayName, abbrev: team.abbreviation,
        logo: (team.logos || [])[0]?.href || null });
    });
    return teams;
  }

  async function nflStandingsMap(){
    const data = await fetchExternal('https://site.api.espn.com/apis/v2/sports/football/nfl/standings', NFL_TTL_MS);
    const map = {};
    (data.children || []).forEach(conf => {
      (conf.standings?.entries || []).forEach(e => {
        const stats = {};
        (e.stats || []).forEach(s => { stats[s.name] = s.value; });
        // NFL standings expose season totals, not per-game averages
        const g = (stats.wins || 0) + (stats.losses || 0) + (stats.ties || 0);
        map[e.team.id] = { wins: stats.wins, losses: stats.losses, ties: stats.ties,
          pf: g ? stats.pointsFor / g : null, pa: g ? stats.pointsAgainst / g : null };
      });
    });
    return map;
  }

  // Offense per-game numbers + defense activity from the team statistics feed.
  // Yards-allowed splits are not on any free feed — defense is represented by
  // points allowed (standings) plus sacks/INTs from here.
  async function nflTeamMetrics(teamId){
    const y = new Date(now()).getFullYear();
    const year = new Date(now()).getMonth() >= 7 ? y : y - 1; // season year flips in August
    const data = await fetchExternal(`${ESPN_NFL}/teams/${teamId}/statistics?season=${year}&seasontype=2`, NFL_TTL_MS);
    const vals = {};
    const walk = (o) => {
      if (Array.isArray(o)) return o.forEach(walk);
      if (o && typeof o === 'object') {
        if (o.name && typeof o.value === 'number' && vals[o.name] === undefined) vals[o.name] = o.value;
        Object.values(o).forEach(walk);
      }
    };
    walk(data);
    const g = vals.gamesPlayed || 1;
    return {
      games: g,
      rushYpg: (vals.rushingYards || 0) / g,
      passYpg: vals.netPassingYardsPerGame ?? ((vals.netPassingYards || 0) / g),
      thirdDownPct: vals.thirdDownConvPct ?? null,
      redZoneTdPct: vals.redzoneTouchdownPct ?? vals.redzoneScoringPct ?? null,
      explosive: ((vals.rushingBigPlays || 0) + (vals.receivingBigPlays || 0)) / g,
      sacks: (vals.sacks || 0) / g,
      ints: (vals.interceptions || 0) / g,
      turnovers: ((vals.fumblesLost || 0) + (vals.interceptionPct !== undefined ? 0 : 0)) / g
    };
  }

  async function nflSchedule(teamId){
    let data = await fetchExternal(`${ESPN_NFL}/teams/${teamId}/schedule?seasontype=2`, NFL_TTL_MS);
    if (!(data.events || []).length) data = await fetchExternal(`${ESPN_NFL}/teams/${teamId}/schedule`, NFL_TTL_MS);
    const done = (data.events || []).map(ev => {
      const comp = (ev.competitions || [])[0] || {};
      const mine = (comp.competitors || []).find(c => String(c.team?.id) === String(teamId)) || {};
      return {
        date: ev.date,
        completed: !!comp.status?.type?.completed,
        won: mine.winner === true
      };
    }).filter(e => e.completed).sort((a,b)=>new Date(a.date)-new Date(b.date));
    const last10 = done.slice(-10);
    // A 12+ day gap between games during the season = coming off the bye
    let offBye = false;
    if (done.length >= 2) {
      const a = new Date(done[done.length-2].date), b = new Date(done[done.length-1].date);
      offBye = (b - a) / 86400000 >= 12;
    }
    let streak = 0, streakWin = null;
    for (let i = done.length - 1; i >= 0; i--) {
      if (streakWin === null) streakWin = done[i].won;
      if (done[i].won !== streakWin) break;
      streak++;
    }
    return {
      last10: last10.length ? `${last10.filter(e=>e.won).length}-${last10.filter(e=>!e.won).length}` : null,
      streak: streak > 1 ? `${streak}-game ${streakWin ? 'win' : 'loss'} streak` : null,
      offBye,
      gamesPlayed: done.length
    };
  }

  // One depth-chart call powers both the Injury Center (grouped, statused) and
  // Fantasy Impact (who steps in behind an injured player).
  async function nflDepthAndInjuries(teamId){
    const data = await fetchExternal(`${ESPN_NFL}/teams/${teamId}/depthcharts`, 60 * 60 * 1000);
    const units = [];
    (data.depthchart || data.items || []).forEach(unit => {
      Object.entries(unit.positions || {}).forEach(([key, pos]) => {
        const players = (pos.athletes || []).map(a => ({
          id: a.id, name: a.displayName || '',
          injuries: (a.injuries || []).map(i => i.status || i.type?.description || 'listed')
        })).filter(p => p.name);
        if (players.length) units.push({
          unit: unit.name || '',
          position: pos.position?.abbreviation || key.toUpperCase(),
          players
        });
      });
    });
    const injuries = [];
    const nextMen = [];
    units.forEach(u => {
      u.players.forEach((p, depth) => {
        if (p.injuries.length) {
          injuries.push({ id: p.id, name: p.name, position: u.position, status: p.injuries[0], starter: depth === 0 });
          if (depth === 0 && u.players[1]) {
            nextMen.push({ outId: p.id, out: p.name, position: u.position, inId: u.players[1].id, in: u.players[1].name, status: p.injuries[0] });
          }
        }
      });
    });
    return { injuries, nextMen };
  }

  async function nflWeather(abbrev){
    const st = NFL_STADIUMS[abbrev];
    if (!st) return null;
    if (st.dome) return { dome: true };
    try {
      const w = await fetchExternal(
        `https://api.open-meteo.com/v1/forecast?latitude=${st.lat}&longitude=${st.lon}&current=temperature_2m,precipitation,rain,snowfall,wind_speed_10m&wind_speed_unit=mph&temperature_unit=fahrenheit`,
        30 * 60 * 1000
      );
      const c = w.current || {};
      return {
        dome: false,
        tempF: c.temperature_2m ?? null,
        windMph: c.wind_speed_10m ?? null,
        rain: (c.rain || 0) > 0 || (c.precipitation || 0) > 0.05,
        snow: (c.snowfall || 0) > 0
      };
    } catch (e) { return null; }
  }

  app.get('/api/nfl/teams', (req, res) => {
    nflTeams().then(t => res.json({ teams: t })).catch(err => sendUpstreamError(res, err));
  });

  app.get('/api/nfl/matchup', (req, res) => {
    (async () => {
      const { home, away } = req.query;
      if (!/^\d{1,4}$/.test(String(home||'')) || !/^\d{1,4}$/.test(String(away||''))) {
        return res.status(400).json({ error: 'home and away team ids required' });
      }
      const [teams, standings] = await Promise.all([nflTeams(), nflStandingsMap()]);
      const teamOf = id => teams.find(t => String(t.id) === String(id));
      const hTeam = teamOf(home), aTeam = teamOf(away);
      if (!hTeam || !aTeam) return res.status(400).json({ error: 'Unknown team id' });

      // League-wide metric rows for true 1-32 ranks (cached 12h)
      const metricRows = (await Promise.all(teams.map(async t => {
        try { return { id: t.id, pa: (standings[t.id] || {}).pa, ...(await nflTeamMetrics(t.id)) }; }
        catch (e) { return null; }
      }))).filter(Boolean);
      const rankOf = (id, key, desc = true) => {
        const rows = metricRows.filter(r => r[key] !== null && r[key] !== undefined);
        const sorted = rows.slice().sort((a,b)=> desc ? b[key]-a[key] : a[key]-b[key]);
        const i = sorted.findIndex(r => String(r.id) === String(id));
        return i === -1 ? null : i + 1;
      };

      async function sideFor(team){
        const st = standings[team.id] || {};
        const m = metricRows.find(r => String(r.id) === String(team.id)) || {};
        const [sched, depth] = await Promise.all([nflSchedule(team.id), nflDepthAndInjuries(team.id)]);
        return {
          team,
          record: st.wins !== undefined ? `${st.wins}-${st.losses}${st.ties ? '-' + st.ties : ''}` : null,
          pf: st.pf ?? null, pa: st.pa ?? null,
          metrics: {
            rushYpg: m.rushYpg ?? null, passYpg: m.passYpg ?? null,
            thirdDownPct: m.thirdDownPct ?? null, redZoneTdPct: m.redZoneTdPct ?? null,
            explosive: m.explosive ?? null, sacks: m.sacks ?? null, ints: m.ints ?? null
          },
          ranks: {
            rushYpg: rankOf(team.id, 'rushYpg'), passYpg: rankOf(team.id, 'passYpg'),
            thirdDownPct: rankOf(team.id, 'thirdDownPct'), redZoneTdPct: rankOf(team.id, 'redZoneTdPct'),
            explosive: rankOf(team.id, 'explosive'), sacks: rankOf(team.id, 'sacks'),
            ints: rankOf(team.id, 'ints'), pa: rankOf(team.id, 'pa', false)
          },
          schedule: sched,
          injuries: depth.injuries,
          nextMen: depth.nextMen
        };
      }
      const [h, a] = await Promise.all([sideFor(hTeam), sideFor(aTeam)]);
      const weather = await nflWeather(hTeam.abbrev);

      // ---- rule-based insight engine ----
      const insights = [];
      const leans = [];
      let confidence = 5;
      // Cross-matchup: A's rush attack vs B's run-stop proxy, pass rush vs protection
      [[a, h, 'away'], [h, a, 'home']].forEach(([off, def]) => {
        if (off.ranks.rushYpg && off.ranks.rushYpg <= 8 && def.ranks.pa && def.ranks.pa >= 22) {
          insights.push(`${off.team.name}'s #${off.ranks.rushYpg} rush offense meets a defense allowing bottom-10 points.`);
          confidence += 0.5;
        }
        if (def.ranks.sacks && def.ranks.sacks <= 6) {
          insights.push(`${def.team.name} bring a top-6 pass rush (${def.metrics.sacks.toFixed(1)} sacks/game) at ${off.team.name}'s protection.`);
          confidence += 0.4;
        }
      });
      if (h.pf !== null && a.pf !== null) {
        const diff = (h.pf - h.pa) - (a.pf - a.pa);
        const better = diff > 0 ? h : a;
        if (Math.abs(diff) >= 5) {
          insights.push(`${better.team.name} hold a ${Math.abs(diff).toFixed(1)}-point average scoring-margin edge.`);
          leans.push(`${better.team.name} side`); confidence += Math.min(1.5, Math.abs(diff) * 0.12);
        }
      }
      [h, a].forEach(s => {
        if (s.schedule.offBye) { insights.push(`${s.team.name} are coming off their bye week.`); confidence += 0.4; }
        const startersOut = s.injuries.filter(i => i.starter).length;
        if (startersOut) {
          insights.push(`${s.team.name} have ${startersOut} starter${startersOut===1?'':'s'} on the injury report.`);
          confidence += 0.3;
        }
      });
      if (weather && !weather.dome) {
        if ((weather.windMph ?? 0) >= 15) {
          insights.push(`${Math.round(weather.windMph)} mph wind at ${hTeam.abbrev} — passing and kicking downgrade, running upgrade.`);
          leans.push('Weather leans Under'); confidence += 0.6;
        }
        if (weather.rain || weather.snow) {
          insights.push(`${weather.snow ? 'Snow' : 'Rain'} in the forecast — ball-security and ground games matter more.`);
          leans.push('Running-game upgrade'); confidence += 0.4;
        }
      }
      if (!insights.length) insights.push('No strong statistical edges detected — this projects close to even.');

      res.json({
        home: h, away: a, weather,
        summary: {
          insights,
          leans: [...new Set(leans)],
          confidence: Math.round(Math.min(9.5, confidence) * 10) / 10,
          note: 'Auto-generated from the numbers above — context, not picks. ATS/over-under trend history and yards-allowed splits are not on any free feed, so they are not modeled; win-loss form here is straight-up.'
        }
      });
    })().catch(err => sendUpstreamError(res, err));
  });

  app.get('/api/nfl/roster', (req, res) => {
    (async () => {
      const { team } = req.query;
      if (!/^\d{1,4}$/.test(String(team||''))) return res.status(400).json({ error: 'team id required' });
      const data = await fetchExternal(`${ESPN_NFL}/teams/${team}/roster`, NFL_TTL_MS);
      const players = [];
      (data.athletes || []).forEach(group => {
        (group.items || []).forEach(a => {
          players.push({ id: a.id, name: a.displayName, position: a.position?.abbreviation || '', headshot: a.headshot?.href || null });
        });
      });
      res.json({ players });
    })().catch(err => sendUpstreamError(res, err));
  });

  // Position-aware game-log form. NFL gamelogs repeat labels across stat
  // groups (passing YDS then rushing YDS), so values are picked by scanning
  // label positions in order.
  app.get('/api/nfl/player-form', (req, res) => {
    (async () => {
      const { id, vsTeam } = req.query;
      if (!/^\d{1,10}$/.test(String(id||''))) return res.status(400).json({ error: 'player id required' });
      const wantVs = /^\d{1,4}$/.test(String(vsTeam||''));
      const endYear = new Date(now()).getFullYear();

      let labels, allRows;
      if (wantVs) {
        ({ labels, rows: allRows } = await gamelogMultiSeason('football/nfl', id, endYear));
      } else {
        const data = await fetchExternal(
          `https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/${id}/gamelog`,
          STATS_TTL_MS
        );
        labels = data.labels || data.names || [];
        allRows = gamelogRows(data).sort((a,b)=> new Date(b.date||0) - new Date(a.date||0));
      }
      const idxAll = key => labels.map((l,i)=> l === key ? i : -1).filter(i=>i!==-1);
      const avgAt = (list, i) => {
        if (i === undefined) return null;
        const v = list.map(r => Number(r.stats[i])).filter(x => !isNaN(x));
        return v.length ? Math.round(v.reduce((s,x)=>s+x,0) / v.length * 10) / 10 : null;
      };
      const yds = idxAll('YDS'), td = idxAll('TD'), rec = idxAll('REC');
      const pack = list => ({
        games: list.length,
        yds1: avgAt(list, yds[0]), yds2: avgAt(list, yds[1]),
        td1: avgAt(list, td[0]), td2: avgAt(list, td[1]),
        rec: avgAt(list, rec[0])
      });
      const seasonRows = wantVs ? allRows.filter(r => new Date(r.date) > new Date(now() - 370*86400000)) : allRows;
      const out = { labels, last5: pack(seasonRows.slice(0, 5)), season: pack(seasonRows) };
      if (wantVs) {
        const vsRows = allRows.filter(r => r.oppId === String(vsTeam));
        const at = (r, i) => i === undefined ? null : (isNaN(Number(r.stats[i])) ? null : Number(r.stats[i]));
        out.vsOpponent = {
          ...pack(vsRows),
          abbrev: vsRows[0] ? vsRows[0].oppAbbrev : null,
          meetings: vsRows.slice(0, 5).map(r => ({
            date: r.date ? String(r.date).slice(0, 10) : null,
            home: r.home,
            yds1: at(r, yds[0]), yds2: at(r, yds[1]), td1: at(r, td[0]), rec: at(r, rec[0])
          }))
        };
      }
      res.json(out);
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

  // Season windows for every tracked sport (college + pro) — free from the
  // same ESPN scoreboard each sport already uses for scores, which stamps
  // its response with the active season's own name/type/date range whether
  // or not any games are on today. One cached call per sport, long TTL.
  const SEASON_STATUS_TTL_MS = 12 * 60 * 60 * 1000;
  async function getSeasonStatus(sport){
    const path = ESPN_SCOREBOARDS[sport];
    if (!path || path.startsWith('mma')) return null; // UFC is event-based, no season window
    const data = await fetchExternal(`https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard`, SEASON_STATUS_TTL_MS);
    const season = (data.leagues || [])[0]?.season;
    if (!season || !season.startDate || !season.endDate) return null;
    const start = new Date(season.startDate), end = new Date(season.endDate), n = new Date(now());
    return {
      name: season.displayName || null,
      phase: season.type?.name || null,
      startDate: season.startDate,
      endDate: season.endDate,
      inSeason: n >= start && n <= end,
      daysUntilStart: n < start ? Math.ceil((start - n) / 86400000) : null
    };
  }
  app.get('/api/season-status', (req, res) => {
    (async () => {
      const entries = await Promise.all(Object.keys(ESPN_SCOREBOARDS).map(async sport => {
        try { return [sport, await getSeasonStatus(sport)]; }
        catch (e) { return [sport, null]; }
      }));
      res.json(Object.fromEntries(entries));
    })().catch(err => sendUpstreamError(res, err));
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
  // The lock screen is always on in the real server. SESSION_SECRET should be
  // set so logins survive a restart/redeploy; without it a random secret is
  // generated each boot, which works fine but signs everyone out on restart.
  let sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    console.warn('auth: SESSION_SECRET not set — using a random one for this boot only. Set SESSION_SECRET in your environment so logins survive a restart.');
    sessionSecret = crypto.randomBytes(32).toString('hex');
  }
  createApp({
    apiKey: process.env.ODDS_API_KEY,
    cacheTtlMs: cacheMinutes * 60 * 1000,
    dataDir: process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || './data',
    enableSweep: true,
    enableAuth: true,
    sessionSecret
  }).listen(port, () => {
    console.log(`LineWatch listening on :${port} (odds cached ${cacheMinutes} min, lock screen on)`);
  });
}
