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
    ['props','/props.html','🏀','Props'],
    ['getprops','/getprops.html','🎯','Get Props'],
    ['record','/record.html','📈','Record'],
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
