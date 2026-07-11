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
    ? `<div class="book-badge" style="background:${style.color};">${escapeHtml(style.name)}</div>`
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
  track.innerHTML = items.length ? items.join('&nbsp;&nbsp;•&nbsp;&nbsp;') : 'No odds loaded yet.';
}

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
    ['slip','/slip.html','🎟️','Slip']
  ];
  rail.innerHTML = '<a class="rail-logo" href="/">LW</a>' + items.map(([key,href,icon,label])=>
    `<a class="rail-btn${key===activePage?' active':''}" href="${href}" title="${label}">
      <span>${icon}</span><span class="rail-label">${label}${key==='slip'?'<span class="slip-badge" id="slipBadge"></span>':''}</span>
    </a>`).join('');
  updateSlipBadge();
}
function updateSlipBadge(){
  const badge = document.getElementById('slipBadge');
  if(!badge) return;
  const n = getSlip().length;
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
    document.body.appendChild(t);
  }
  t.textContent = text + ' — View slip';
  t.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(()=>t.classList.remove('show'), 2000);
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
function myBookKeys(){
  const mine = getMyBooks();
  return mine.length ? mine : TRACKED_KEYS;
}
// Never filters a bookmaker list down to nothing — falls back to the full list
// so a market never appears to vanish just because none of "my books" quote it.
function filterToMyBooks(bookmakers){
  const mine = getMyBooks();
  if(!mine.length) return bookmakers;
  const filtered = bookmakers.filter(b => mine.includes(b.key.toLowerCase()));
  return filtered.length ? filtered : bookmakers;
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

// ---------- Kalshi reference prices ----------
// Kalshi is a CFTC-regulated prediction exchange, not a licensed sportsbook —
// prices are shown as a reference row only, excluded from Best/Value ranking.
const KALSHI_SERIES = {
  baseball_mlb: 'KXMLBGAME',
  basketball_nba: 'KXNBAGAME',
  americanfootball_nfl: 'KXNFLGAME',
  icehockey_nhl: 'KXNHLGAME',
  soccer_epl: 'KXEPLGAME'
};

let kalshiEventsCache = [];

async function fetchKalshi(sport){
  kalshiEventsCache = [];
  const series = KALSHI_SERIES[sport];
  if(!series) return;
  const url = `https://api.elections.kalshi.com/trade-api/v2/events?series_ticker=${series}&status=open&with_nested_markets=true&limit=200`;
  const res = await fetch(url);
  if(!res.ok) return;
  const data = await res.json();
  kalshiEventsCache = (data && data.events) ? data.events : [];
}

// Name candidates for fuzzy matching Odds API team names against Kalshi titles
function teamNameCandidates(teamName){
  const words = teamName.split(' ');
  const c = new Set([teamName]);
  if(words.length > 1){
    c.add(words.slice(1).join(' '));   // drop city: "Red Sox", "White Sox"
    c.add(words[words.length-1]);      // nickname: "Yankees", "Lakers"
  }
  return [...c].filter(x=>x.length > 3);
}
function textMatchesTeam(text, teamName){
  if(!text) return false;
  const t = text.toLowerCase();
  return teamNameCandidates(teamName).some(c => t.includes(c.toLowerCase()));
}

// cents (implied probability) -> American odds
function centsToAmerican(cents){
  const p = cents / 100;
  if(p <= 0 || p >= 1) return null;
  return p >= 0.5 ? Math.round(-100 * p / (1 - p)) : Math.round(100 * (1 - p) / p);
}

// Find Kalshi's price for one side of a game. Returns {american, cents, link} or null.
function kalshiRowFor(game, team){
  if(!kalshiEventsCache.length) return null;
  const ev = kalshiEventsCache.find(e =>
    textMatchesTeam(e.title, game.home_team) && textMatchesTeam(e.title, game.away_team)
  );
  if(!ev || !ev.markets) return null;
  const mkt = ev.markets.find(m =>
    textMatchesTeam(m.yes_sub_title || m.subtitle || m.title, team)
  );
  if(!mkt) return null;
  // Prefer bid/ask midpoint; fall back to last trade. All in cents (1-99).
  let cents = null;
  if(mkt.yes_bid > 0 && mkt.yes_ask > 0 && mkt.yes_ask < 100) cents = (mkt.yes_bid + mkt.yes_ask) / 2;
  else if(mkt.last_price > 0 && mkt.last_price < 100) cents = mkt.last_price;
  if(cents === null) return null;
  const american = centsToAmerican(cents);
  if(american === null) return null;
  return { american, cents: Math.round(cents), link: `https://kalshi.com/events/${encodeURIComponent(ev.event_ticker)}` };
}
