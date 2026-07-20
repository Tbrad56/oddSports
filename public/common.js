// ---------- LineWatch shared common.js for multi-page split ----------

// ---------- sports & books ----------
const SPORTS = [
  ["americanfootball_nfl","NFL"],
  ["basketball_nba","NBA"],
  ["baseball_mlb","MLB"],
  ["icehockey_nhl","NHL"],
  ["americanfootball_ncaaf","NCAA Football"],
  ["basketball_ncaab","NCAA Basketball"],
  ["soccer_epl","EPL Soccer"],
  ["mma_mixed_martial_arts","MMA"]
];

const BOOK_STYLES = {
  fanduel:      {name:"FanDuel",   color:"#1493FF"},
  draftkings:   {name:"DraftKings",color:"#53D337"},
  betmgm:       {name:"BetMGM",    color:"#B4975A"},
  williamhill_us:{name:"Caesars",  color:"#B79D62"},
  caesars:      {name:"Caesars",   color:"#B79D62"},
  espnbet:      {name:"ESPN BET",  color:"#D00023"},
  bet365:       {name:"Bet365",    color:"#FFDD00"},
  fanatics:     {name:"Fanatics",  color:"#F97316"},
  betrivers:    {name:"BetRivers", color:"#1F7A8C"},
  pointsbetus:  {name:"PointsBet", color:"#EE3124"}
};

const TRACKED_KEYS = Object.keys(BOOK_STYLES);

// General sportsbook links — these open the book's site/app, they do NOT preload
// a specific bet. No public sportsbook offers real third-party bet-slip deep-linking.
const BOOK_LINKS = {
  fanduel:"https://sportsbook.fanduel.com/",
  draftkings:"https://sportsbook.draftkings.com/",
  betmgm:"https://sports.betmgm.com/",
  williamhill_us:"https://www.caesars.com/sportsbook",
  caesars:"https://www.caesars.com/sportsbook",
  espnbet:"https://espnbet.com/",
  bet365:"https://www.bet365.com/",
  fanatics:"https://sportsbook.fanatics.com/",
  betrivers:"https://betrivers.com/",
  pointsbetus:"https://pointsbet.com/"
};

// Player prop markets to try per sport when the user opts in on a game.
// These are real market keys from The Odds API. Note: quota cost per props
// load = number of markets × number of regions, so this list is deliberately capped.
const PROP_MARKETS = {
  americanfootball_nfl:["player_pass_yds","player_pass_tds","player_rush_yds","player_receptions","player_reception_yds","player_anytime_td"],
  americanfootball_ncaaf:["player_pass_yds","player_pass_tds","player_rush_yds","player_receptions","player_reception_yds","player_anytime_td"],
  basketball_nba:["player_points","player_rebounds","player_assists","player_threes","player_points_rebounds_assists"],
  basketball_ncaab:["player_points","player_rebounds","player_assists","player_threes"],
  baseball_mlb:["batter_hits","batter_home_runs","batter_total_bases","batter_rbis","pitcher_strikeouts"],
  icehockey_nhl:["player_points","player_assists","player_shots_on_goal","player_goal_scorer_anytime"]
};

// ---------- odds math ----------
function americanToDecimal(a){
  a = Number(a);
  return a > 0 ? 1 + a/100 : 1 + 100/Math.abs(a);
}

function decimalToAmerican(d){
  if(d >= 2) return Math.round((d-1)*100);
  return Math.round(-100/(d-1));
}

function fmtAmerican(a){
  a = Number(a);
  return a > 0 ? '+'+a : String(a);
}

// For a two-sided market, devig each book that quotes both sides, then average
// the resulting fair probabilities to get a consensus "fair" line. A book whose
// actual price pays out better than that fair line is flagged as value.
function computeFairDecimal(sideARows, sideBRows){
  const byBookB = {};
  sideBRows.forEach(r => byBookB[r.bookKey] = r.odds);
  const fairProbs = [];
  sideARows.forEach(r=>{
    if(byBookB[r.bookKey] === undefined) return;
    const pA = 1/americanToDecimal(r.odds);
    const pB = 1/americanToDecimal(byBookB[r.bookKey]);
    const sum = pA + pB;
    if(sum > 0) fairProbs.push(pA/sum);
  });
  if(!fairProbs.length) return null;
  const avg = fairProbs.reduce((a,b)=>a+b,0) / fairProbs.length;
  return 1/avg; // fair decimal odds for side A
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ---------- book styling & labels ----------
function bookStyleFor(key){
  const k = key.toLowerCase();
  return BOOK_STYLES[k] || null;
}

// Relative luminance of a brand color -> pick readable badge text color (audit 5.5).
function badgeTextColor(hex){
  const n = hex.replace('#','');
  const chan = s => { const c = parseInt(s,16)/255; return c <= 0.03928 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4); };
  const L = 0.2126*chan(n.substr(0,2)) + 0.7152*chan(n.substr(2,2)) + 0.0722*chan(n.substr(4,2));
  const contrast = (l1,l2) => (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05);
  return contrast(1.0, L) >= contrast(L, 0.010960094) ? '#FFFFFF' : '#1B1B1B';
}

function marketLabel(key){
  const labels = {
    player_pass_yds:"Passing Yards", player_pass_tds:"Passing TDs", player_rush_yds:"Rushing Yards",
    player_receptions:"Receptions", player_reception_yds:"Receiving Yards", player_anytime_td:"Anytime TD",
    player_points:"Points", player_rebounds:"Rebounds", player_assists:"Assists",
    player_threes:"Threes Made", player_points_rebounds_assists:"Pts + Reb + Ast",
    batter_hits:"Batter Hits", batter_home_runs:"Home Runs", batter_total_bases:"Total Bases",
    batter_rbis:"RBIs", pitcher_strikeouts:"Pitcher Strikeouts",
    player_shots_on_goal:"Shots on Goal", player_goal_scorer_anytime:"Anytime Goalscorer"
  };
  return labels[key] || key;
}

// Wrap a book badge in a link to that sportsbook when we have one
function linkedBadge(bookKey, fallbackTitle){
  const style = bookStyleFor(bookKey);
  const inner = style
    ? `<div class="book-badge" style="background:${style.color}; color:${badgeTextColor(style.color)};">${escapeHtml(style.name)}</div>`
    : `<span>${escapeHtml(fallbackTitle || bookKey)}</span>`;
  const link = BOOK_LINKS[bookKey.toLowerCase()];
  return link ? `<a href="${link}" target="_blank" rel="noopener" style="text-decoration:none;" title="Open ${escapeHtml(style?style.name:fallbackTitle||bookKey)}">${inner}</a>` : inner;
}

// ---------- UI elements (element-guarded, safe across pages) ----------
function setStatus(live, text){
  const dot = document.getElementById('statusDot');
  const txt = document.getElementById('statusText');
  if(!dot || !txt) return;
  dot.className = 'dot' + (live ? ' live' : '');
  txt.textContent = text;
}

function showError(msg){
  const area = document.getElementById('errorArea');
  if(!area) return;
  area.innerHTML = '<div class="error-msg">'+escapeHtml(msg)+'</div>';
}

function clearError(){
  const area = document.getElementById('errorArea');
  if(area) area.innerHTML = '';
}

function updateTicker(games){
  const track = document.getElementById('tickerTrack');
  if(!track) return;
  const items = [];
  (games || []).slice(0,12).forEach(game=>{
    const bms = game.bookmakers.filter(b=>TRACKED_KEYS.includes(b.key.toLowerCase()));
    [game.away_team, game.home_team].forEach(team=>{
      let best = null;
      bms.forEach(bm=>{
        const m = bm.markets.find(mk=>mk.key==='h2h');
        if(!m) return;
        const o = m.outcomes.find(x=>x.name===team);
        if(!o) return;
        if(!best || americanToDecimal(o.price) > americanToDecimal(best.price)){
          best = {price:o.price, book:bm.title};
        }
      });
      if(best){
        const cls = Number(best.price) > 0 ? 'hi' : 'lo';
        items.push(`${escapeHtml(team)} <span class="${cls}">${fmtAmerican(best.price)}</span> (${escapeHtml(best.book)})`);
      }
    });
  });
  if(!items.length){ track.innerHTML = 'No odds loaded yet.'; return; }
  const sep = '&nbsp;&nbsp;•&nbsp;&nbsp;';
  const html = items.join(sep);
  // Render the sequence twice so the -50% translate loop is seamless — otherwise
  // the viewport sits empty from when the single copy exits until it restarts
  // (audit 6.8). The track stays aria-hidden, so the duplicate copy doesn't
  // double-announce anything to screen readers.
  track.innerHTML = html + sep + html;
}

// Ticker pause control (audit 5.2 + 2.6): hover-pause already exists in CSS, but
// touch/keyboard users have no way to stop the marquee. The track itself stays
// aria-hidden (decorative, updating content); the pause button is a real
// control, so it's focusable with its own aria-label instead.
(function initTickerPause(){
  const wrap = document.querySelector('.ticker-wrap');
  if(!wrap || wrap.querySelector('.ticker-pause')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ticker-pause';
  btn.setAttribute('aria-label','Pause ticker');
  btn.title = 'Pause ticker';
  btn.textContent = '⏸';
  btn.addEventListener('click', ()=>{
    const paused = wrap.classList.toggle('paused');
    btn.textContent = paused ? '▶' : '⏸';
    btn.title = paused ? 'Resume ticker' : 'Pause ticker';
    btn.setAttribute('aria-label', paused ? 'Resume ticker' : 'Pause ticker');
  });
  wrap.appendChild(btn);
})();

// ---------- slip storage (localStorage, shared across pages) ----------
const SLIP_KEY = 'lw_slip';
function getSlip(){
  try{
    const v = JSON.parse(localStorage.getItem(SLIP_KEY));
    return Array.isArray(v) ? v.filter(l => l && Array.isArray(l.rows) && l.rows.length) : [];
  }catch(e){ return []; }
}
function saveSlip(slip){
  try{ localStorage.setItem(SLIP_KEY, JSON.stringify(slip)); }catch(e){}
}
function addLegToSlip(leg){
  const s = getSlip();
  s.push(leg);
  saveSlip(s);
  updateSlipBadge();
}
function removeLegFromSlip(id){
  saveSlip(getSlip().filter(l=>l.id!==id));
  updateSlipBadge();
}
// Records which of a leg's books the user picked to bet with — the slip page
// no longer auto-picks "best price"; the ranking of the rest lives on Cheatsheet.
function updateLegBook(id, bookKey){
  const s = getSlip();
  const leg = s.find(l=>l.id===id);
  if(leg) leg.selectedBookKey = bookKey;
  saveSlip(s);
}

// ---------- sport persistence ----------
const SPORT_KEY = 'lw_sport';
function getSport(){
  let v = null;
  try{ v = localStorage.getItem(SPORT_KEY); }catch(e){}
  return SPORTS.some(([k])=>k===v) ? v : SPORTS[0][0];
}
function setSport(key){
  try{ localStorage.setItem(SPORT_KEY, key); }catch(e){}
}

// ---------- nav rail ----------
function renderNav(activePage){
  const rail = document.getElementById('navRail');
  if(!rail) return;
  const items = [
    ['home','/','🏠','Home'],
    ['board','/board.html','📊','Board'],
    ['getprops','/getprops.html','🎯','Get Props'],
    ['stats','/stats.html','🔎','Stats'],
    ['nba','/nba.html','🏀','NBA'],
    ['nfl','/nfl.html','🏈','NFL'],
    ['cheatsheet','/cheatsheet.html','📋','Cheatsheet'],
    ['record','/record.html','📈','Record'],
    ['slip','/slip.html','🎟️','Slip']
  ];
  rail.innerHTML = '<a class="rail-logo" href="/">LW</a>' + items.map(([key,href,icon,label])=>
    `<a class="rail-btn${key===activePage?' active':''}" href="${href}">
      <span aria-hidden="true">${icon}</span><span class="rail-label">${label}${key==='slip'?'<span class="slip-badge" id="slipBadge"></span>':''}</span>
    </a>`).join('');
  updateSlipBadge();
}
// Seed from the persisted slip so a non-empty slip doesn't fake-trigger the
// bump animation on every page's first nav render (audit 6.6).
let _lastSlipBadgeCount = getSlip().length;
function updateSlipBadge(){
  const badge = document.getElementById('slipBadge');
  if(!badge) return;
  const n = getSlip().length;
  if(n > _lastSlipBadgeCount){
    badge.classList.remove('bump');
    void badge.offsetWidth; // restart the animation even if it's already mid-bump
    badge.classList.add('bump');
  }
  _lastSlipBadgeCount = n;
  badge.textContent = n || '';
  badge.classList.toggle('on', n > 0);
}

// ---------- toast ----------
function showToast(text){
  let t = document.getElementById('lwToast');
  if(!t){
    t = document.createElement('a');
    t.id = 'lwToast';
    t.className = 'toast';
    t.href = '/slip.html';
    t.setAttribute('role','status');
    document.body.appendChild(t);
  }
  t.textContent = text + ' — View slip';
  t.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(()=>t.classList.remove('show'), 4500);
}

// ---------- motion helpers ----------
// Staggered fade/slide-in entrance for a freshly rendered list of elements.
function staggerIn(container, stepMs){
  const step = stepMs || 40;
  [...container.children].forEach((el, i)=>{
    el.classList.add('enter');
    el.style.animationDelay = (i * step) + 'ms';
  });
}

// Smoothly reveal/hide a collapsible element (expects the "reveal" class on el).
// Caller is still responsible for populating el's content.
function revealShow(el){
  el.style.display = 'block';
  requestAnimationFrame(()=>requestAnimationFrame(()=>el.classList.add('is-open')));
}
function revealHide(el){
  el.classList.remove('is-open');
  setTimeout(()=>{ if(!el.classList.contains('is-open')) el.style.display = 'none'; }, 200);
}

// Brief highlight flash on an element — visual confirmation beyond the toast.
function flashEl(el){
  el.classList.remove('flash');
  void el.offsetWidth; // restart the animation if it's already flashing
  el.classList.add('flash');
}

// Skeleton loading placeholders shown while a fetch is in flight.
function renderSkeletonCards(container, count){
  let html = '';
  for(let i=0; i<(count||3); i++){
    html += `<div class="skeleton-card">
      <div class="skeleton-line tall" style="width:60%;"></div>
      <div class="skeleton-line" style="width:90%;"></div>
      <div class="skeleton-line short"></div>
    </div>`;
  }
  container.innerHTML = html;
}

// ---------- sport chips ----------
function renderSportChips(containerEl, onSelect){
  containerEl.innerHTML = '';
  const current = getSport();
  SPORTS.forEach(([key,label])=>{
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (key===current ? ' active' : '');
    chip.textContent = label;
    chip.addEventListener('click', ()=>{
      setSport(key);
      [...containerEl.children].forEach(c=>c.classList.remove('active'));
      chip.classList.add('active');
      onSelect(key);
    });
    containerEl.appendChild(chip);
  });
}

// ---------- odds fetch ----------
async function fetchOddsFor(sport){
  const res = await fetch(`/api/odds/${sport}`);
  if(!res.ok){
    let msg = `Error ${res.status}`;
    try{ const j = await res.json(); if(j.error) msg = j.error; }catch(_){}
    throw new Error(msg);
  }
  const games = await res.json();
  return {
    games,
    remaining: res.headers.get('x-requests-remaining'),
    cacheAge: Number(res.headers.get('x-cache-age-seconds') || 0)
  };
}

function oddsStatusText(count, remaining, cacheAge){
  const freshness = cacheAge >= 60
    ? `cached ${Math.round(cacheAge/60)} min ago`
    : `updated ${new Date().toLocaleTimeString()}`;
  return `Live — ${count} games loaded${remaining ? ' · '+remaining+' requests left this month' : ''} · ${freshness}`;
}

// ---------- live scores ----------
// The Odds API's scores endpoint: current score + completed/not-completed,
// no in-game clock. Covers every sport this app tracks.
async function fetchScoresFor(sport){
  const res = await fetch(`/api/scores/${sport}`);
  if(!res.ok) throw new Error(`scores fetch failed (${res.status})`);
  return await res.json();
}

// MLB-only: inning/outs/balls-strikes from MLB StatsAPI, keyed by team names
// (not event id — StatsAPI doesn't share Odds API's event ids).
async function fetchMlbLive(){
  const res = await fetch('/api/live/mlb');
  if(!res.ok) throw new Error(`live/mlb fetch failed (${res.status})`);
  const data = await res.json();
  return data.games || [];
}

function findScoreFor(scores, game){
  // Scores now come from ESPN, whose event ids differ from The Odds API's —
  // match on team names (id kept as a fast path if they ever align).
  const home = (game.home_team || '').trim().toLowerCase();
  const away = (game.away_team || '').trim().toLowerCase();
  return (scores || []).find(s =>
    s.id === game.id ||
    ((s.home_team || '').trim().toLowerCase() === home &&
     (s.away_team || '').trim().toLowerCase() === away)
  ) || null;
}
function findMlbLiveFor(liveGames, game){
  const home = (game.home_team || '').trim().toLowerCase();
  const away = (game.away_team || '').trim().toLowerCase();
  return (liveGames || []).find(g =>
    (g.home_team || '').trim().toLowerCase() === home &&
    (g.away_team || '').trim().toLowerCase() === away
  ) || null;
}

// Builds a small LIVE/FINAL score strip for a game card. scoreEntry is one
// element from fetchScoresFor (has .completed, .scores:[{name,score}]);
// liveDetail (MLB only) is one element from fetchMlbLive with inning/count.
// Returns '' when the game hasn't started yet (nothing to show).
function buildScoreBadgeHtml(game, scoreEntry, liveDetail){
  if(!scoreEntry || !scoreEntry.scores) return '';
  const homeScore = scoreEntry.scores.find(s=>s.name===game.home_team);
  const awayScore = scoreEntry.scores.find(s=>s.name===game.away_team);
  if(!homeScore || !awayScore) return '';

  const completed = !!scoreEntry.completed;
  let detail = '';
  if(!completed && liveDetail && liveDetail.inning){
    const half = liveDetail.inningState ? escapeHtml(liveDetail.inningState.slice(0,3)) : '';
    detail = `${half} ${liveDetail.inning}`;
    if(liveDetail.outs !== null && liveDetail.outs !== undefined){
      detail += ` · ${liveDetail.outs} out${liveDetail.outs===1?'':'s'}`;
    }
    if(liveDetail.balls !== null && liveDetail.balls !== undefined && liveDetail.strikes !== null && liveDetail.strikes !== undefined){
      detail += ` · ${liveDetail.balls}-${liveDetail.strikes}`;
    }
  }

  return `<div class="score-badge ${completed ? 'final' : 'live'}">
    <span class="score-status">${completed ? 'FINAL' : '<span class="live-dot"></span>LIVE'}</span>
    ${detail ? `<span class="score-detail">${detail}</span>` : ''}
    <span class="score-line">${escapeHtml(game.away_team)} <strong>${escapeHtml(String(awayScore.score))}</strong> — <strong>${escapeHtml(String(homeScore.score))}</strong> ${escapeHtml(game.home_team)}</span>
  </div>`;
}

// ---------- My books (which sportsbooks the user actually uses) ----------
// Canonical keys; Caesars maps to williamhill_us in the Odds API.
const SELECTABLE_BOOKS = ['fanduel','draftkings','betmgm','williamhill_us','espnbet','bet365','fanatics','betrivers'];
const MYBOOKS_KEY = 'lw_myBooks';
function getMyBooks(){
  try{
    const raw = localStorage.getItem(MYBOOKS_KEY);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v : [];
  }catch(e){ return []; }
}
function setMyBooks(list){
  try{ localStorage.setItem(MYBOOKS_KEY, JSON.stringify(list)); }catch(e){}
}
// Never filters a bookmaker/row list down to nothing — falls back to the full
// list so a market never appears to vanish just because none of "my books"
// quote it. keyOf extracts the book key from each entry (defaults to `.key`,
// board.js's per-team rows use `.bookKey` instead).
function filterToMyBooks(entries, keyOf){
  const getKey = keyOf || (b => b.key);
  const mine = getMyBooks();
  if(!mine.length) return entries;
  const filtered = entries.filter(b => mine.includes(getKey(b).toLowerCase()));
  return filtered.length ? filtered : entries;
}

// ---------- MLB stadium weather ----------
// bearing = approximate compass direction (deg) from home plate to center
// field, used to classify wind as blowing out/in/cross. Values are ±15° estimates.
const MLB_STADIUMS = {
  "Arizona Diamondbacks":{bearing:0,lat:33.4453,lon:-112.0667,park:"Chase Field, Phoenix",roof:"retractable"},
  "Atlanta Braves":{bearing:150,lat:33.8907,lon:-84.4677,park:"Truist Park, Atlanta",roof:"open"},
  "Baltimore Orioles":{bearing:31,lat:39.2839,lon:-76.6217,park:"Camden Yards, Baltimore",roof:"open"},
  "Boston Red Sox":{bearing:45,lat:42.3467,lon:-71.0972,park:"Fenway Park, Boston",roof:"open"},
  "Chicago Cubs":{bearing:35,lat:41.9484,lon:-87.6553,park:"Wrigley Field, Chicago",roof:"open"},
  "Chicago White Sox":{bearing:127,lat:41.8299,lon:-87.6338,park:"Rate Field, Chicago",roof:"open"},
  "Cincinnati Reds":{bearing:120,lat:39.0975,lon:-84.5066,park:"Great American Ball Park, Cincinnati",roof:"open"},
  "Cleveland Guardians":{bearing:15,lat:41.4962,lon:-81.6852,park:"Progressive Field, Cleveland",roof:"open"},
  "Colorado Rockies":{bearing:15,lat:39.7559,lon:-104.9942,park:"Coors Field, Denver",roof:"open"},
  "Detroit Tigers":{bearing:150,lat:42.3390,lon:-83.0485,park:"Comerica Park, Detroit",roof:"open"},
  "Houston Astros":{bearing:345,lat:29.7573,lon:-95.3555,park:"Daikin Park, Houston",roof:"retractable"},
  "Kansas City Royals":{bearing:45,lat:39.0517,lon:-94.4803,park:"Kauffman Stadium, Kansas City",roof:"open"},
  "Los Angeles Angels":{bearing:65,lat:33.8003,lon:-117.8827,park:"Angel Stadium, Anaheim",roof:"open"},
  "Los Angeles Dodgers":{bearing:25,lat:34.0739,lon:-118.2400,park:"Dodger Stadium, Los Angeles",roof:"open"},
  "Miami Marlins":{bearing:40,lat:25.7781,lon:-80.2197,park:"loanDepot park, Miami",roof:"retractable"},
  "Milwaukee Brewers":{bearing:135,lat:43.0280,lon:-87.9712,park:"American Family Field, Milwaukee",roof:"retractable"},
  "Minnesota Twins":{bearing:90,lat:44.9817,lon:-93.2776,park:"Target Field, Minneapolis",roof:"open"},
  "New York Mets":{bearing:15,lat:40.7571,lon:-73.8458,park:"Citi Field, New York",roof:"open"},
  "New York Yankees":{bearing:75,lat:40.8296,lon:-73.9262,park:"Yankee Stadium, New York",roof:"open"},
  "Athletics":{bearing:60,lat:38.5802,lon:-121.5133,park:"Sutter Health Park, Sacramento",roof:"open"},
  "Oakland Athletics":{bearing:60,lat:38.5802,lon:-121.5133,park:"Sutter Health Park, Sacramento",roof:"open"},
  "Philadelphia Phillies":{bearing:10,lat:39.9061,lon:-75.1665,park:"Citizens Bank Park, Philadelphia",roof:"open"},
  "Pittsburgh Pirates":{bearing:115,lat:40.4469,lon:-80.0057,park:"PNC Park, Pittsburgh",roof:"open"},
  "San Diego Padres":{bearing:0,lat:32.7076,lon:-117.1570,park:"Petco Park, San Diego",roof:"open"},
  "San Francisco Giants":{bearing:85,lat:37.7786,lon:-122.3893,park:"Oracle Park, San Francisco",roof:"open"},
  "Seattle Mariners":{bearing:45,lat:47.5914,lon:-122.3325,park:"T-Mobile Park, Seattle",roof:"retractable"},
  "St. Louis Cardinals":{bearing:60,lat:38.6226,lon:-90.1928,park:"Busch Stadium, St. Louis",roof:"open"},
  "Tampa Bay Rays":{bearing:90,lat:27.7683,lon:-82.6534,park:"Tropicana Field, St. Petersburg",roof:"dome"},
  "Texas Rangers":{bearing:45,lat:32.7473,lon:-97.0847,park:"Globe Life Field, Arlington",roof:"retractable"},
  "Toronto Blue Jays":{bearing:345,lat:43.6414,lon:-79.3894,park:"Rogers Centre, Toronto",roof:"retractable"},
  "Washington Nationals":{bearing:30,lat:38.8730,lon:-77.0074,park:"Nationals Park, Washington DC",roof:"open"}
};

let weatherCache = {}; // home team name -> {time[], temp[], precip[], wind[], windDir[]}

async function fetchStadiumWeather(games){
  weatherCache = {};
  const teams = [...new Set(games.map(g=>g.home_team).filter(t=>MLB_STADIUMS[t]))];
  if(!teams.length) return;
  const lats = teams.map(t=>MLB_STADIUMS[t].lat).join(',');
  const lons = teams.map(t=>MLB_STADIUMS[t].lon).join(',');
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}`
    + `&hourly=temperature_2m,precipitation_probability,wind_speed_10m,wind_direction_10m`
    + `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=UTC&forecast_days=7`;
  const res = await fetch(url);
  if(!res.ok) return;
  let data = await res.json();
  if(!Array.isArray(data)) data = [data]; // single-location responses aren't wrapped in an array
  teams.forEach((team, i)=>{
    const h = data[i] && data[i].hourly;
    if(!h || !h.time) return;
    weatherCache[team] = {
      time: h.time,
      temp: h.temperature_2m,
      precip: h.precipitation_probability,
      wind: h.wind_speed_10m,
      windDir: h.wind_direction_10m
    };
  });
}

function windCompass(deg){
  if(deg === null || deg === undefined) return '';
  const dirs = ['N','NE','E','SE','S','SW','W','NW'];
  return dirs[Math.round(((deg % 360) / 45)) % 8];
}

// Wind direction from Open-Meteo is where wind comes FROM; the ball cares where
// it's blowing TO, relative to the park's home-plate->CF bearing.
// Returns {label, component}: component = mph of wind along the out-to-CF axis
// (positive = blowing out, negative = blowing in).
function windRelativeToPark(windFromDeg, windMph, bearing){
  const windTo = (windFromDeg + 180) % 360;
  const diff = Math.abs(((windTo - bearing + 540) % 360) - 180); // 0 = straight out, 180 = straight in
  const component = windMph * Math.cos(diff * Math.PI / 180);
  let label;
  if(diff < 45) label = 'out';
  else if(diff > 135) label = 'in';
  else label = 'cross';
  return {label, component};
}

// Heuristic hitting/carry-conditions score, grounded in ball-flight physics:
// warm air = better carry (~+0.15 pts/°F above 70), wind out adds carry
// (~+0.6 pts/mph of outward component), rain risk suppresses.
// This rates CONDITIONS only — it is not a betting signal or an over/under model.
function hittingScore(tempF, windFromDeg, windMph, precipPct, bearing){
  const rel = windRelativeToPark(windFromDeg, windMph, bearing);
  let score = rel.component * 0.6 + (tempF - 70) * 0.15;
  if(precipPct >= 60) score -= 5;
  else if(precipPct >= 35) score -= 2;
  return {score, rel};
}
function scoreClass(score){
  if(score >= 4)  return {cls:'w-good', label:'HR-friendly',  dot:'▲'};
  if(score <= -4) return {cls:'w-bad',  label:'Carry-killing', dot:'▼'};
  return {cls:'w-mod', label:'Neutral', dot:'●'};
}

// Mini baseball field with a wind arrow, drawn relative to the park:
// center field always points up, so an up arrow = wind blowing straight out.
function windFieldSvg(windFromDeg, windMph, bearing){
  const rel = windRelativeToPark(windFromDeg, windMph, bearing);
  const rotation = ((windFromDeg + 180) - bearing + 360) % 360; // 0 = out to CF
  const arrowColor = rel.label === 'out' ? 'var(--good)' : rel.label === 'in' ? 'var(--bad)' : 'var(--warn)';
  return `<span class="wind-field-wrap" title="Wind ${Math.round(windMph)} mph, blowing ${rel.label === 'cross' ? 'across the field' : rel.label + (rel.label==='out' ? ' toward CF' : ' from CF')} (field shown with CF up; park orientation approx.)">
    <svg class="wind-field" viewBox="0 0 100 100" width="46" height="46" aria-hidden="true">
      <path d="M50,92 L13,55 A 52 52 0 0 1 87,55 Z" fill="none" stroke="var(--border)" stroke-width="3"/>
      <path d="M50,92 L36,78 L50,64 L64,78 Z" fill="none" stroke="var(--border-soft)" stroke-width="2.5"/>
      <g transform="rotate(${rotation.toFixed(0)} 50 54)">
        <circle cx="50" cy="54" r="15" fill="${arrowColor}" opacity="0.92"/>
        <path d="M50,62 L50,47 M50,47 l-5.5,5.5 M50,47 l5.5,5.5" stroke="#1B1B1B" stroke-width="3.5" fill="none" stroke-linecap="round"/>
      </g>
    </svg>
    <span class="wind-mph">${Math.round(windMph)}<br>mph</span>
  </span>`;
}

// Builds the hourly weather strip for an MLB game card (first pitch through +4 hours)
function buildWeatherStrip(game){
  const stadium = MLB_STADIUMS[game.home_team];
  if(!stadium) return '';
  const w = weatherCache[game.home_team];

  let slotsHtml = '';
  let firstPitchRating = null;
  let firstPitchWind = null;
  if(w){
    const gameHourUtc = game.commence_time.slice(0,13) + ':00'; // floor to the hour, matches Open-Meteo's UTC time format
    const startIdx = w.time.indexOf(gameHourUtc);
    if(startIdx !== -1){
      for(let i = startIdx; i < Math.min(startIdx + 5, w.time.length); i++){
        const local = new Date(w.time[i] + ':00Z');
        const precip = w.precip[i];
        const {score, rel} = hittingScore(w.temp[i], w.windDir[i], w.wind[i], precip, stadium.bearing);
        const rating = scoreClass(score);
        if(i === startIdx){
          firstPitchRating = rating;
          firstPitchWind = {dir: w.windDir[i], mph: w.wind[i]};
        }
        const windTxt = rel.label === 'cross'
          ? `${Math.round(w.wind[i])} mph cross`
          : `${Math.round(w.wind[i])} mph ${rel.label}`;
        slotsHtml += `<div class="weather-slot ${rating.cls}" title="${rating.label} conditions · wind ${windCompass(w.windDir[i])} ${Math.round(w.wind[i])} mph, ${rel.label === 'out' ? 'blowing out toward CF' : rel.label === 'in' ? 'blowing in from CF' : 'crosswind'} (park orientation approx.)">
          <div class="w-time">${local.toLocaleTimeString([], {hour:'numeric'})}${i===startIdx ? ' · 1st pitch' : ''}</div>
          <div class="w-temp">${Math.round(w.temp[i])}°F</div>
          <div class="w-wind">${windTxt}</div>
          <div class="w-rain${precip >= 30 ? ' wet' : ''}">${precip}% rain</div>
        </div>`;
      }
    }
  }

  const roofTag = stadium.roof === 'dome'
    ? '<span class="roof-tag">Dome — weather n/a</span>'
    : stadium.roof === 'retractable'
      ? '<span class="roof-tag">Retractable roof</span>'
      : '';
  const ratingTag = (firstPitchRating && stadium.roof !== 'dome')
    ? `<span class="rating-tag ${firstPitchRating.cls}" title="Carry-conditions heuristic (temp + park-relative wind + rain risk) at first pitch. Rates weather only — not a betting signal.">${firstPitchRating.dot} ${firstPitchRating.label}</span>`
    : '';
  const fieldSvg = (firstPitchWind && stadium.roof !== 'dome')
    ? windFieldSvg(firstPitchWind.dir, firstPitchWind.mph, stadium.bearing)
    : '';

  let body;
  if(stadium.roof === 'dome'){
    body = '<div class="weather-note">Indoor stadium — conditions don\'t affect play.</div>';
  } else if(slotsHtml){
    body = `<div class="weather-slots">${slotsHtml}</div>`;
  } else if(weatherCache[game.home_team]){
    body = '<div class="weather-note">Game is beyond the 7-day forecast window — check back closer to game day.</div>';
  } else {
    body = '<div class="weather-note">Forecast unavailable right now.</div>';
  }

  return `<div class="weather-strip">
    <div class="weather-head">☁ ${escapeHtml(stadium.park)} ${roofTag} ${ratingTag} ${fieldSvg}</div>
    ${body}
  </div>`;
}

// ---------- team logos ----------
// ESPN's public logo CDN, keyed by the exact team-name strings The Odds API
// returns. Only the four major pro leagues are mapped — NCAA football/
// basketball (hundreds of schools) and EPL don't have a small, reliably
// accurate abbreviation list to hand-maintain, so those sports (and MMA,
// which has fighters, not teams) just show team names with no logo, same
// as before this feature existed.
const TEAM_LOGOS = {
  baseball_mlb: {
    "Arizona Diamondbacks":"ari", "Atlanta Braves":"atl", "Baltimore Orioles":"bal",
    "Boston Red Sox":"bos", "Chicago Cubs":"chc", "Chicago White Sox":"chw",
    "Cincinnati Reds":"cin", "Cleveland Guardians":"cle", "Colorado Rockies":"col",
    "Detroit Tigers":"det", "Houston Astros":"hou", "Kansas City Royals":"kc",
    "Los Angeles Angels":"laa", "Los Angeles Dodgers":"lad", "Miami Marlins":"mia",
    "Milwaukee Brewers":"mil", "Minnesota Twins":"min", "New York Mets":"nym",
    "New York Yankees":"nyy", "Athletics":"ath", "Oakland Athletics":"ath",
    "Philadelphia Phillies":"phi", "Pittsburgh Pirates":"pit", "San Diego Padres":"sd",
    "San Francisco Giants":"sf", "Seattle Mariners":"sea", "St. Louis Cardinals":"stl",
    "Tampa Bay Rays":"tb", "Texas Rangers":"tex", "Toronto Blue Jays":"tor",
    "Washington Nationals":"wsh"
  },
  basketball_nba: {
    "Atlanta Hawks":"atl", "Boston Celtics":"bos", "Brooklyn Nets":"bkn",
    "Charlotte Hornets":"cha", "Chicago Bulls":"chi", "Cleveland Cavaliers":"cle",
    "Dallas Mavericks":"dal", "Denver Nuggets":"den", "Detroit Pistons":"det",
    "Golden State Warriors":"gs", "Houston Rockets":"hou", "Indiana Pacers":"ind",
    "LA Clippers":"lac", "Los Angeles Clippers":"lac", "Los Angeles Lakers":"lal",
    "Memphis Grizzlies":"mem", "Miami Heat":"mia", "Milwaukee Bucks":"mil",
    "Minnesota Timberwolves":"min", "New Orleans Pelicans":"no", "New York Knicks":"ny",
    "Oklahoma City Thunder":"okc", "Orlando Magic":"orl", "Philadelphia 76ers":"phi",
    "Phoenix Suns":"phx", "Portland Trail Blazers":"por", "Sacramento Kings":"sac",
    "San Antonio Spurs":"sa", "Toronto Raptors":"tor", "Utah Jazz":"utah",
    "Washington Wizards":"wsh"
  },
  americanfootball_nfl: {
    "Arizona Cardinals":"ari", "Atlanta Falcons":"atl", "Baltimore Ravens":"bal",
    "Buffalo Bills":"buf", "Carolina Panthers":"car", "Chicago Bears":"chi",
    "Cincinnati Bengals":"cin", "Cleveland Browns":"cle", "Dallas Cowboys":"dal",
    "Denver Broncos":"den", "Detroit Lions":"det", "Green Bay Packers":"gb",
    "Houston Texans":"hou", "Indianapolis Colts":"ind", "Jacksonville Jaguars":"jax",
    "Kansas City Chiefs":"kc", "Las Vegas Raiders":"lv", "Los Angeles Chargers":"lac",
    "Los Angeles Rams":"lar", "Miami Dolphins":"mia", "Minnesota Vikings":"min",
    "New England Patriots":"ne", "New Orleans Saints":"no", "New York Giants":"nyg",
    "New York Jets":"nyj", "Philadelphia Eagles":"phi", "Pittsburgh Steelers":"pit",
    "San Francisco 49ers":"sf", "Seattle Seahawks":"sea", "Tampa Bay Buccaneers":"tb",
    "Tennessee Titans":"ten", "Washington Commanders":"wsh"
  },
  icehockey_nhl: {
    "Anaheim Ducks":"ana", "Boston Bruins":"bos", "Buffalo Sabres":"buf",
    "Calgary Flames":"cgy", "Carolina Hurricanes":"car", "Chicago Blackhawks":"chi",
    "Colorado Avalanche":"col", "Columbus Blue Jackets":"cbj", "Dallas Stars":"dal",
    "Detroit Red Wings":"det", "Edmonton Oilers":"edm", "Florida Panthers":"fla",
    "Los Angeles Kings":"la", "Minnesota Wild":"min", "Montreal Canadiens":"mtl",
    "Nashville Predators":"nsh", "New Jersey Devils":"nj", "New York Islanders":"nyi",
    "New York Rangers":"nyr", "Ottawa Senators":"ott", "Philadelphia Flyers":"phi",
    "Pittsburgh Penguins":"pit", "San Jose Sharks":"sj", "Seattle Kraken":"sea",
    "St. Louis Blues":"stl", "Tampa Bay Lightning":"tb", "Toronto Maple Leafs":"tor",
    "Utah Hockey Club":"utah", "Utah Mammoth":"utah", "Vancouver Canucks":"van",
    "Vegas Golden Knights":"vgk", "Washington Capitals":"wsh", "Winnipeg Jets":"wpg"
  }
};
function teamLogoUrl(sportKey, teamName){
  const league = TEAM_LOGOS[sportKey];
  const abbrev = league ? league[teamName] : null;
  return abbrev ? `https://a.espncdn.com/i/teamlogos/${sportKey === 'baseball_mlb' ? 'mlb' : sportKey === 'basketball_nba' ? 'nba' : sportKey === 'americanfootball_nfl' ? 'nfl' : 'nhl'}/500/${abbrev}.png` : null;
}
// Returns an <img> tag, or '' when this sport/team has no mapped logo (NCAA,
// EPL, MMA, or an unmapped name) — callers can just concatenate the result.
function teamLogoImg(sportKey, teamName){
  const url = teamLogoUrl(sportKey, teamName);
  if(!url) return '';
  return `<img class="team-logo" src="${url}" width="24" height="24" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`;
}


// ---------- season windows (free, ESPN) ----------
// Shared by Board's empty-state and the NBA/NFL dashboard headers.
let _seasonStatusPromise = null;
function fetchSeasonStatus(){
  if(!_seasonStatusPromise) _seasonStatusPromise = fetch('/api/season-status').then(r=>r.json()).catch(()=>({}));
  return _seasonStatusPromise;
}
function fmtSeasonDate(iso){
  return new Date(iso).toLocaleDateString(undefined, {month:'short', day:'numeric', year:'numeric'});
}
// Renders a compact season-window line into #seasonBanner, if present on the page.
async function renderSeasonBanner(sportKey){
  const host = document.getElementById('seasonBanner');
  if(!host) return;
  const all = await fetchSeasonStatus();
  const st = all[sportKey];
  if(!st){ host.innerHTML = ''; return; }
  let text;
  if(st.inSeason){
    text = `In season — ${escapeHtml(st.name || '')} · through ${fmtSeasonDate(st.endDate)}`;
  } else if(st.daysUntilStart !== null){
    text = `Off season — next season starts ${fmtSeasonDate(st.startDate)} (${st.daysUntilStart} day${st.daysUntilStart===1?'':'s'} away)`;
  } else {
    text = `Off season — last window ran ${fmtSeasonDate(st.startDate)} to ${fmtSeasonDate(st.endDate)}`;
  }
  host.innerHTML = `<div class="season-banner${st.inSeason?' in-season':''}">${text}</div>`;
}
