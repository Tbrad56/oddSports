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

// ESPN's public logo CDN, one real per-league mark per sport (verified live
// against ESPN's own API responses, not guessed URLs). NCAA football/
// basketball don't have a distinct per-sport crest on ESPN's side — their
// own scoreboard API returns the same generic sport-icon ESPN itself uses,
// so that's what's used here too.
const SPORT_LOGOS = {
  americanfootball_nfl: "https://a.espncdn.com/i/teamlogos/leagues/500/nfl.png",
  basketball_nba: "https://a.espncdn.com/i/teamlogos/leagues/500/nba.png",
  baseball_mlb: "https://a.espncdn.com/i/teamlogos/leagues/500/mlb.png",
  icehockey_nhl: "https://a.espncdn.com/i/teamlogos/leagues/500/nhl.png",
  americanfootball_ncaaf: "https://a.espncdn.com/redesign/assets/img/icons/ESPN-icon-football-college.png",
  basketball_ncaab: "https://a.espncdn.com/redesign/assets/img/icons/ESPN-icon-basketball.png",
  soccer_epl: "https://a.espncdn.com/i/leaguelogos/soccer/500/23.png",
  mma_mixed_martial_arts: "https://a.espncdn.com/i/teamlogos/leagues/500/ufc.png"
};

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
// College sports (NCAAF, NCAAB) intentionally have no entry here — many
// states, including Ohio, prohibit betting on individual college athletes'
// performance, so the "Load player props" UI never appears for those sports
// (every call site below already guards on PROP_MARKETS[sportKey] existing).
const PROP_MARKETS = {
  americanfootball_nfl:["player_pass_yds","player_pass_tds","player_rush_yds","player_receptions","player_reception_yds","player_anytime_td"],
  basketball_nba:["player_points","player_rebounds","player_assists","player_threes","player_points_rebounds_assists"],
  baseball_mlb:["batter_hits","batter_home_runs","batter_total_bases","batter_rbis","pitcher_strikeouts"],
  icehockey_nhl:["player_points","player_assists","player_shots_on_goal","player_goal_scorer_anytime"]
};

// Binary anytime-scorer markets have exactly one line (yes/no) — no alt
// lines exist for these (mirrors server.js's NO_ALT_MARKETS).
const NO_ALT_MARKETS = new Set(['player_anytime_td', 'player_goal_scorer_anytime']);

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

// ---------- shared odds-scanning helpers (Board's Game Lines grid + Value Finder) ----------
// Pool of books to scan/show: My Books if set, else every tracked book. Never
// surfaces a book you can't actually see prices from elsewhere in the app.
function poolFor(bookmakers){
  const tracked = bookmakers.filter(b => TRACKED_KEYS.includes(b.key.toLowerCase()));
  const bookmakersToUse = tracked.length ? tracked : bookmakers;
  const myBooks = getMyBooks();
  const scoped = myBooks.length ? bookmakersToUse.filter(b => myBooks.includes(b.key.toLowerCase())) : [];
  return scoped.length ? scoped : bookmakersToUse;
}
function rowsFor(pool, marketKey, outcomeName){
  const rows = [];
  pool.forEach(bm=>{
    const market = bm.markets.find(m=>m.key===marketKey);
    if(!market) return;
    const outcome = market.outcomes.find(o=>o.name===outcomeName);
    if(!outcome) return;
    rows.push({bookKey:bm.key, bookTitle:bm.title, odds:outcome.price, point:outcome.point, link:outcome.link||bm.link||null, sid:outcome.sid||null, marketSid:market.sid||null});
  });
  rows.sort((a,b)=>americanToDecimal(b.odds)-americanToDecimal(a.odds));
  return rows;
}
// Books can quote slightly different lines (mostly spreads/totals) — group by
// point, keep whichever point the most books share so the comparison stays
// apples-to-apples, best price within it.
function modalPointRows(pool, marketKey, outcomeName){
  const all = rowsFor(pool, marketKey, outcomeName);
  if(!all.length) return [];
  const byPoint = {};
  all.forEach(r=>{ const k=String(r.point); (byPoint[k]=byPoint[k]||[]).push(r); });
  const bestKey = Object.keys(byPoint).sort((a,b)=>byPoint[b].length-byPoint[a].length)[0];
  return byPoint[bestKey];
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// Avatar bubble for a ready-made URL (the server already resolved a
// headshot). Shared across pages — Board's props table and the NFL
// breakdown's Player Form panel both use it.
function avatarUrlHtml(url, size){
  if(!url) return '';
  return `<img class="player-avatar" src="${escapeHtml(url)}" width="${size}" height="${size}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`;
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
    player_shots_on_goal:"Shots on Goal", player_goal_scorer_anytime:"Anytime Goalscorer",
    h2h:"Moneyline", spreads:"Spread", totals:"Total"
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
// Slip lives only in this browser's localStorage — the server has no idea
// what you've bet unless something tells it. This is that something: a
// fire-and-forget sync so a moneyline/spread/total leg can actually get
// graded later and show up in Record, instead of just vanishing once it's
// off the Slip. Never blocks the UI or surfaces an error — losing a grading
// opportunity is fine, breaking "add to slip" over it is not.
function trackBet({sport, homeTeam, awayTeam, commenceTime, matchup, market, selection, point}){
  fetch('/api/track-bet', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({sport, homeTeam, awayTeam, commenceTime, matchup, market, selection, point})
  }).catch(()=>{});
}
// Same idea as trackBet, for a player prop leg — only MLB and NFL are
// gradable server-side right now (no stat-lookup infra for other sports yet).
const PROP_TRACKABLE_SPORTS = new Set(['baseball_mlb', 'americanfootball_nfl']);
function trackProp({sport, player, market, line, side, matchup, homeTeam, awayTeam, commenceTime}){
  if(!PROP_TRACKABLE_SPORTS.has(sport)) return;
  fetch('/api/track-prop', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({sport, player, market, line, side, matchup, homeTeam, awayTeam, commenceTime})
  }).catch(()=>{});
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

// ---------- saved bets (localStorage) ----------
// Distinct from the active slip: "Save Bet" archives the current slip's legs
// as a dated snapshot here, then clears the active slip so a new one can be
// built. Saved bets can be reloaded back into the active slip later, or just
// kept around for reference.
const SAVED_BETS_KEY = 'lw_saved_bets';
function getSavedBets(){
  try{
    const v = JSON.parse(localStorage.getItem(SAVED_BETS_KEY));
    return Array.isArray(v) ? v : [];
  }catch(e){ return []; }
}
function saveSavedBets(list){
  try{ localStorage.setItem(SAVED_BETS_KEY, JSON.stringify(list)); }catch(e){}
}
function saveCurrentSlipAsBet(){
  const legs = getSlip();
  if(!legs.length) return null;
  const bet = { id: Date.now()+Math.random(), savedAt: Date.now(), legs };
  const all = getSavedBets();
  all.unshift(bet);
  saveSavedBets(all);
  saveSlip([]);
  updateSlipBadge();
  return bet;
}
function deleteSavedBet(id){
  saveSavedBets(getSavedBets().filter(b=>b.id!==id));
}
// Loads a saved bet back into the active slip, adding to whatever's already
// there rather than overwriting it (so you can combine a saved bet with legs
// you're currently building) — removes it from Saved Bets in the same step.
function loadSavedBetIntoSlip(id){
  const all = getSavedBets();
  const bet = all.find(b=>b.id===id);
  if(!bet) return;
  const s = getSlip();
  bet.legs.forEach(leg=>s.push({...leg, id: Date.now()+Math.random()}));
  saveSlip(s);
  saveSavedBets(all.filter(b=>b.id!==id));
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
// Grouped by sport so the rail reads as "MLB / NBA / NFL / More / Tools"
// instead of nine flat, same-weight links. Each sport-group's Board link
// deep-links straight to that sport (?sport=...), which board.js honors on
// load — so picking "NBA" from the nav actually lands on the NBA board,
// not just the Board page in general.
const NAV_GROUPS = [
  { key:'home', href:'/', icon:'🏠', label:'Home' },
  { key:'mlb', href:'/board.html?sport=baseball_mlb', icon:'⚾', label:'MLB' },
  { key:'nba', href:'/board.html?sport=basketball_nba', icon:'🏀', label:'NBA' },
  { key:'nfl', href:'/board.html?sport=americanfootball_nfl', icon:'🏈', label:'NFL' },
  { key:'more', icon:'🏆', label:'More', children:[
    ['board','/board.html?sport=icehockey_nhl','🏒','NHL'],
    ['board','/board.html?sport=americanfootball_ncaaf','🎓','NCAA Football'],
    ['board','/board.html?sport=basketball_ncaab','🎓','NCAA Basketball'],
    ['board','/board.html?sport=soccer_epl','⚽','EPL Soccer'],
    ['board','/board.html?sport=mma_mixed_martial_arts','🥊','MMA']
  ]},
  { key:'tools', icon:'🧰', label:'Tools', children:[
    ['stats','/stats.html','🔎','Stats'],
    ['cheatsheet','/cheatsheet.html','📋','Cheatsheet'],
    ['notifications','/notifications.html','🔔','Notifications']
  ]},
  { key:'slip', href:'/slip.html', icon:'🎟️', label:'Slip', badge:true }
];
// Which group lights up for a page not itself in the group list.
const PAGE_TO_GROUP = { getprops:'mlb', record:'mlb', nba:'nba', stats:'tools', cheatsheet:'tools', notifications:'tools' };
const SPORT_TO_GROUP = { baseball_mlb:'mlb', basketball_nba:'nba', americanfootball_nfl:'nfl' };

function renderNav(activePage){
  const rail = document.getElementById('navRail');
  if(!rail) return;

  // On the Board page itself, highlight whichever sport group matches the
  // currently-selected sport chip rather than guessing.
  let activeGroup = PAGE_TO_GROUP[activePage] || activePage;
  if(activePage === 'board') activeGroup = SPORT_TO_GROUP[getSport()] || 'more';

  const groupHtml = NAV_GROUPS.map(g=>{
    if(!g.children){
      // Flat sport links (MLB/NBA/NFL) light up off activeGroup, same as the
      // flyout groups below, so landing on Board with that sport selected
      // highlights the right one — not just an exact page-key match.
      const flatActive = g.key===activePage || g.key===activeGroup;
      return `<a class="rail-btn${flatActive?' active':''}" href="${g.href}">
        <span aria-hidden="true">${g.icon}</span><span class="rail-label">${escapeHtml(g.label)}${g.badge?'<span class="slip-badge" id="slipBadge"></span>':''}</span>
      </a>`;
    }
    const isActive = g.key === activeGroup;
    return `<div class="rail-group${isActive?' active':''}">
      <button type="button" class="rail-btn rail-group-btn" data-group="${g.key}" aria-expanded="false">
        <span aria-hidden="true">${g.icon}</span><span class="rail-label">${escapeHtml(g.label)}<span class="rail-caret" aria-hidden="true">▾</span></span>
      </button>
      <div class="rail-flyout" data-group-menu="${g.key}">
        ${g.children.map(([key,href,icon,label])=>
          `<a class="rail-flyout-item" href="${href}">
            <span aria-hidden="true">${icon}</span>${escapeHtml(label)}
          </a>`).join('')}
      </div>
    </div>`;
  }).join('');

  rail.innerHTML = '<a class="rail-logo" href="/">LW</a>' + groupHtml;

  // Click-to-toggle (not hover — behaves the same on touch and desktop).
  // Exactly one flyout open at a time; outside click or Escape closes it.
  function closeAllGroups(){
    rail.querySelectorAll('.rail-group.open').forEach(g=>g.classList.remove('open'));
    rail.querySelectorAll('.rail-group-btn[aria-expanded="true"]').forEach(b=>b.setAttribute('aria-expanded','false'));
  }
  rail.querySelectorAll('.rail-group-btn').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      e.stopPropagation();
      const groupEl = btn.closest('.rail-group');
      const willOpen = !groupEl.classList.contains('open');
      closeAllGroups();
      if(willOpen){ groupEl.classList.add('open'); btn.setAttribute('aria-expanded','true'); }
    });
  });
  document.addEventListener('click', closeAllGroups);
  document.addEventListener('keydown', e=>{ if(e.key==='Escape') closeAllGroups(); });
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
// Faint full-size league logo behind the page content, if that page has a
// #sportWatermark element — a no-op everywhere else. Kept in one place so
// every page that uses renderSportChips gets it automatically instead of
// each page having to wire it up itself.
function updateSportWatermark(sportKey){
  const el = document.getElementById('sportWatermark');
  if(!el) return;
  const logo = SPORT_LOGOS[sportKey];
  el.style.backgroundImage = logo ? `url("${logo}")` : 'none';
}

function renderSportChips(containerEl, onSelect){
  containerEl.innerHTML = '';
  const current = getSport();
  updateSportWatermark(current);
  SPORTS.forEach(([key,label])=>{
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (key===current ? ' active' : '');
    const logo = SPORT_LOGOS[key];
    chip.innerHTML = (logo ? `<img class="chip-logo" src="${logo}" width="16" height="16" alt="" loading="lazy" onerror="this.style.display='none'">` : '') + escapeHtml(label);
    chip.addEventListener('click', ()=>{
      setSport(key);
      [...containerEl.children].forEach(c=>c.classList.remove('active'));
      chip.classList.add('active');
      updateSportWatermark(key);
      onSelect(key);
    });
    containerEl.appendChild(chip);
  });
}

// ---------- odds fetch ----------
// cacheOnly: for pages where odds are just decoration (the ticker banner on
// Cheatsheet/Slip/Record/Stats) — never spends a fresh credit. Serves
// whatever's already cached server-side (e.g. from Board being used
// recently) and otherwise comes back empty, no upstream call at all.
async function fetchOddsFor(sport, { cacheOnly = false } = {}){
  const res = await fetch(`/api/odds/${sport}${cacheOnly ? '?cacheOnly=1' : ''}`);
  if(res.status === 204){
    return { games: [], remaining: null, cacheAge: 0 };
  }
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

// Compact baseball-field-with-wind-arrow icon, one per hourly weather slot —
// center field always points up, so an up arrow = wind blowing straight out
// for THAT hour specifically, which is why it's built fresh per slot rather
// than once for the whole card: as the hourly forecast changes, so does the
// arrow. No fence-distance labels here (removed — see park dims history).
function miniWindFieldSvg(windFromDeg, windMph, bearing){
  const rel = windRelativeToPark(windFromDeg, windMph, bearing);
  const rotation = ((windFromDeg + 180) - bearing + 360) % 360; // 0 = out to CF
  const arrowColor = rel.label === 'out' ? 'var(--good)' : rel.label === 'in' ? 'var(--bad)' : 'var(--warn)';
  return `<svg class="ws-field" viewBox="0 0 100 100" width="46" height="46" aria-hidden="true">
      <path d="M50,88 L4,44 A65,65 0 0 1 96,44 Z" fill="#2F6B3C" stroke="#1C3F24" stroke-width="2"/>
      <path d="M50,88 L74,64 L50,40 L26,64 Z" fill="#A5713F" stroke="#7A4F28" stroke-width="1.5"/>
      <path d="M50,76 L63,64 L50,52 L37,64 Z" fill="#3D8A4F" stroke="#276334" stroke-width="1"/>
      <circle cx="50" cy="64" r="4" fill="#8A5A34" stroke="#6B4527" stroke-width="1"/>
      <path d="M46,88 L54,88 L54,84 L50,80 L46,84 Z" fill="#F5F5F5" stroke="#999" stroke-width="0.6"/>
      <g transform="rotate(${rotation.toFixed(0)} 50 38)">
        <circle cx="50" cy="38" r="14" fill="${arrowColor}" opacity="0.94" stroke="#1B1B1B" stroke-width="1"/>
        <path d="M50,48 L50,28 M50,28 l-7,7 M50,28 l7,7" stroke="#1B1B1B" stroke-width="4" fill="none" stroke-linecap="round"/>
      </g>
    </svg>`;
}

// Builds the hourly weather strip for an MLB game card (first pitch through +4 hours).
// extraHtml (e.g. a top-HR-hitters box) renders alongside the slots, filling
// the leftover horizontal space to the right of them on wider cards.
// First-pitch carry-conditions rating for a game, shared by the weather strip
// and the HR Watch star rating below — a single source of truth so both
// agree on what "good hitting weather" means for this game.
function firstPitchWeatherRating(game){
  const stadium = MLB_STADIUMS[game.home_team];
  if(!stadium || stadium.roof === 'dome') return null;
  const w = weatherCache[game.home_team];
  if(!w) return null;
  const gameHourUtc = game.commence_time.slice(0,13) + ':00';
  const startIdx = w.time.indexOf(gameHourUtc);
  if(startIdx === -1) return null;
  const {score} = hittingScore(w.temp[startIdx], w.windDir[startIdx], w.wind[startIdx], w.precip[startIdx], stadium.bearing);
  return scoreClass(score);
}

function buildWeatherStrip(game, extraHtml){
  const stadium = MLB_STADIUMS[game.home_team];
  if(!stadium) return '';
  const w = weatherCache[game.home_team];

  let slotsHtml = '';
  let firstPitchRating = null;
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
        }
        const windTxt = rel.label === 'cross'
          ? `${Math.round(w.wind[i])} mph cross`
          : `${Math.round(w.wind[i])} mph ${rel.label}`;
        slotsHtml += `<div class="weather-slot ${rating.cls}" title="${rating.label} conditions · wind ${windCompass(w.windDir[i])} ${Math.round(w.wind[i])} mph, ${rel.label === 'out' ? 'blowing out toward CF' : rel.label === 'in' ? 'blowing in from CF' : 'crosswind'} (park orientation approx.)">
          ${miniWindFieldSvg(w.windDir[i], w.wind[i], stadium.bearing)}
          <div class="ws-info">
            <div class="w-time">${local.toLocaleTimeString([], {hour:'numeric'})}${i===startIdx ? ' · 1st pitch' : ''}</div>
            <div class="w-temp">${Math.round(w.temp[i])}°F</div>
            <div class="w-wind">${windTxt}</div>
            <div class="w-rain${precip >= 30 ? ' wet' : ''}">${precip}% rain</div>
          </div>
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
    <div class="weather-head">☁ ${escapeHtml(stadium.park)} ${roofTag} ${ratingTag}</div>
    <div class="weather-body-row">${body}</div>
    ${extraHtml || ''}
  </div>`;
}

// ---------- park dimensions (which fields are more HR-friendly) ----------
// Real fence distances from MLB's own venues API (see server.js's
// mlbParkDimensions for sourcing/methodology) — fetched once per session,
// since dimensions essentially never change mid-season.
let mlbParkDimsCache = null;
async function fetchMlbParkDimensions(){
  if(mlbParkDimsCache) return mlbParkDimsCache;
  try{
    const res = await fetch('/api/mlb/park-dimensions');
    if(!res.ok) return null;
    mlbParkDimsCache = await res.json();
  }catch(e){ return null; }
  return mlbParkDimsCache;
}
// Park dimensions no longer render on the card (the field diagram/fence
// numbers were removed) — mlbParkDimsCache is still fetched and used purely
// as a scoring input to hrWatchRating below (park tier + Coors altitude note).

// ---------- HR Watch: composite star rating per batter ----------
// Combines three things we already fetch for other cards — no extra API
// calls: (a) hand-split power vs today's specific opposing pitcher (from
// hr-matchups), (b) that park's fence-distance tier (park dimensions), and
// (c) first-pitch carry conditions (weather). Stars are a transparent sum of
// bounded pieces, not a black box — every piece shows up in the tooltip.
//
// MLB StatsAPI sitCodes are symmetric: 'vl' always means "vs lefties," so the
// same code that picks a batter's split vs a given pitcher hand also picks a
// pitcher's split vs a given batter hand.
function hrSitCodeForBatterHand(batterHand, pitcherHand){
  if(batterHand === 'S') return pitcherHand === 'L' ? 'vr' : 'vl'; // switch-hitters take the platoon side
  return batterHand === 'L' ? 'vl' : 'vr';
}

// Builds a one-sentence, plain-English readout from the same numbers the
// score is built from — not a model call, just deterministic phrasing over
// real stats, so it's free and instant but still reads like an explanation
// rather than a stat dump.
function hrWatchSummary(batter, pitcher, park, weather, powerBand, pitcherHr9){
  const parts = [];
  const first = batter.name.split(' ')[0];

  if(powerBand === 'elite') parts.push(`${first} has real thump vs ${pitcher && pitcher.hand ? pitcher.hand + 'HP' : 'this hand'} (${batter.iso.toFixed(3)} ISO)`);
  else if(powerBand === 'good') parts.push(`${first} brings solid pop vs ${pitcher && pitcher.hand ? pitcher.hand + 'HP' : 'this hand'} (${batter.iso.toFixed(3)} ISO)`);
  else parts.push(`${first}'s power is modest here (${batter.iso.toFixed(3)} ISO)`);

  if(pitcher && pitcherHr9 != null){
    if(pitcherHr9 >= 1.3) parts.push(`facing a homer-prone ${pitcher.name} (${pitcherHr9.toFixed(2)} HR/9)`);
    else if(pitcherHr9 <= 0.8) parts.push(`against a stingy ${pitcher.name} (${pitcherHr9.toFixed(2)} HR/9)`);
  }

  if(park){
    if(park.altitudeNote) parts.push(`at altitude, which carries further than the fences suggest`);
    else if(park.tier === 'Compact') parts.push(`in a hitter-friendly park`);
    else if(park.tier === 'Spacious') parts.push(`in a pitcher-friendly park`);
  }

  if(weather){
    if(weather.label === 'HR-friendly') parts.push(`with the wind helping carry`);
    else if(weather.label === 'Carry-killing') parts.push(`fighting the wind tonight`);
  }

  if(batter.bvp && batter.bvp.ab >= 8 && batter.bvp.hr > 0){
    parts.push(`and has gone deep off him before (${batter.bvp.hr} HR in ${batter.bvp.ab} AB career)`);
  }

  // First clause reads as the subject/verb, the rest join as ", " clauses.
  return parts[0] + (parts.length > 1 ? ', ' + parts.slice(1).join(', ') : '') + '.';
}

function hrWatchRating(batter, pitcher, game){
  if(batter.iso == null) return null;
  const clamp = (v,lo,hi) => Math.max(lo, Math.min(hi, v));
  let score = 0;

  // Power at the plate, already hand-split vs today's opposing pitcher throwing hand.
  const isoPart = clamp(batter.iso / 0.200, 0, 1.5) * 2;
  score += isoPart;
  const powerBand = batter.iso >= 0.200 ? 'elite' : batter.iso >= 0.150 ? 'good' : 'modest';

  // How many HRs this pitcher gives up to same-handed batters.
  let pitcherHr9 = null;
  if(pitcher && pitcher.rows){
    const code = hrSitCodeForBatterHand(batter.hand, pitcher.hand);
    const st = pitcher.rows[code] || pitcher.rows.season;
    if(st && st.hr9 != null){
      pitcherHr9 = st.hr9;
      score += clamp(st.hr9 / 1.3, 0, 1.6) * 1;
    }
  }

  // Ballpark: real fence-distance tier, with the Coors altitude caveat overriding
  // a "Spacious"-by-distance park that's actually MLB's most HR-friendly.
  const park = mlbParkDimsCache && mlbParkDimsCache[game.home_team];
  if(park){
    let parkPart = park.tier === 'Compact' ? 0.7 : park.tier === 'Spacious' ? -0.7 : 0;
    if(park.altitudeNote) parkPart = 0.7;
    score += parkPart;
  }

  // First-pitch carry conditions (temp + park-relative wind + rain risk).
  const weather = firstPitchWeatherRating(game);
  if(weather){
    score += weather.label === 'HR-friendly' ? 0.5 : weather.label === 'Carry-killing' ? -0.5 : 0;
  }

  // Real career history vs this exact pitcher — tiny samples, small nudge only.
  if(batter.bvp && batter.bvp.ab >= 8 && batter.bvp.hr > 0){
    score += 0.3;
  }

  const stars = score >= 4 ? 5 : score >= 3 ? 4 : score >= 2 ? 3 : score >= 1 ? 2 : 1;
  const summary = hrWatchSummary(batter, pitcher, park, weather, powerBand, pitcherHr9);
  return { score, stars, summary };
}

function starsHtml(n){
  return `<span class="hr-stars" aria-hidden="true"><span class="hr-stars-fill">${'★'.repeat(n)}</span><span class="hr-stars-empty">${'☆'.repeat(5-n)}</span></span>`;
}

// ESPN's team-logo CDN, keyed by league path — driven by the numeric ESPN
// team id ESPN's own scoreboard already hands us in `situation.homeTeamId`,
// so this covers every NCAAF school with no name/abbreviation table to
// maintain (unlike TEAM_LOGOS, which only has the 4 hand-mapped pro leagues).
const ESPN_TEAM_LOGO_LEAGUE = { americanfootball_nfl: 'nfl', americanfootball_ncaaf: 'ncaa' };
function espnTeamLogoUrl(sportKey, teamId){
  const league = ESPN_TEAM_LOGO_LEAGUE[sportKey];
  if(!league || !teamId) return null;
  return `https://a.espncdn.com/i/teamlogos/${league}/500/${teamId}.png`;
}

// Interactive football field: same green field / end-zone styling the old
// wind diagram used, now driven by ESPN's live `situation` (down, distance,
// line of scrimmage, possession) instead of wind direction. Pre-kickoff (no
// situation yet) it's just the bare field with a kickoff-time note — markers
// only appear once the game is actually live.
// `yardLine` (0=away goal → 100=home goal, left→right) and the down=-1/
// distance=-1 "between plays" sentinel were both confirmed against real
// live NCAAF games (Alabama@Kentucky, Arizona@BYU, 2026-09-12).
function footballFieldTrackerSvg(sportKey, game, scoreEntry){
  const sit = scoreEntry && scoreEntry.situation;
  const started = !!sit;
  const live = !!(sit && !sit.isHalftime && sit.down > 0 && sit.distance >= 0);
  let losMark = '', ballMark = '', firstDownMark = '', dirArrow = '', possessionMark = '';
  let badgeX = 150;
  if(live && sit.yardLine != null && sit.yardLine >= 0 && sit.yardLine <= 100){
    const x = 24 + (sit.yardLine / 100) * 252;
    losMark = `<line x1="${x.toFixed(1)}" y1="8" x2="${x.toFixed(1)}" y2="112" stroke="#F5D400" stroke-width="2"/>`;
    ballMark = `<ellipse cx="${x.toFixed(1)}" cy="60" rx="5" ry="3.2" fill="#7B4A22" stroke="#241609" stroke-width="1"/>`;
    // Possession drives toward the OPPONENT's goal: home team → toward the
    // away end (x decreasing, driveDir -1), away team → toward the home end
    // (x increasing, driveDir +1). Both the first-down marker and the drive
    // arrow have to move in that same direction from the LOS, or they end up
    // pointing the wrong way whenever the home team has the ball.
    const towardAway = sit.possessionTeamId && sit.possessionTeamId === sit.homeTeamId;
    const driveDir = towardAway ? -1 : 1;
    const fx = Math.max(24, Math.min(276, x + driveDir * sit.distance * 2.52));
    firstDownMark = `<line x1="${fx.toFixed(1)}" y1="8" x2="${fx.toFixed(1)}" y2="112" stroke="#FFA940" stroke-width="2" stroke-dasharray="4,3"/>`;
    if(sit.possessionTeamId && (sit.possessionTeamId === sit.homeTeamId || sit.possessionTeamId === sit.awayTeamId)){
      const ax = x + driveDir * 18;
      const tip = ax + driveDir * 10;
      dirArrow = `<path d="M${ax.toFixed(1)},52 L${tip.toFixed(1)},60 L${ax.toFixed(1)},68 Z" fill="#F5F5F5" opacity="0.9"/>`;
      // A small logo of whichever team actually has the ball, right above it —
      // the midfield logo is always the home team's turf logo, so on its own
      // it can't answer "who has the ball" once the away team is on offense.
      const posLogoUrl = espnTeamLogoUrl(sportKey, sit.possessionTeamId);
      if(posLogoUrl){
        possessionMark = `<g>
          <circle cx="${x.toFixed(1)}" cy="38" r="13" fill="#F5F5F5" opacity="0.95"/>
          <image href="${posLogoUrl}" x="${(x-11).toFixed(1)}" y="27" width="22" height="22" preserveAspectRatio="xMidYMid meet"/>
        </g>`;
      }
    }
    // Down & distance badge sits behind the LOS (the offense's own side, away
    // from the first-down marker) so it never covers the ball or the marker.
    badgeX = Math.max(60, Math.min(240, x - driveDir * 40));
  }
  let yardTicks = '', yardNumbers = '';
  const yardLabels = [10,20,30,40,50,40,30,20,10];
  let li = 0;
  for(let x = 49.2; x <= 250.8 + 0.1; x += 25.2, li++){
    yardTicks += `<line x1="${x.toFixed(1)}" y1="8" x2="${x.toFixed(1)}" y2="112" stroke="#1C3F24" stroke-width="0.6" opacity="0.5"/>`;
    const label = yardLabels[li];
    if(label != null){
      yardNumbers += `<text x="${x.toFixed(1)}" y="24" text-anchor="middle" font-size="11" font-weight="700" fill="#E8F0EA" opacity="0.55">${label}</text>`;
      yardNumbers += `<text x="${x.toFixed(1)}" y="102" text-anchor="middle" font-size="11" font-weight="700" fill="#E8F0EA" opacity="0.55">${label}</text>`;
    }
  }
  const homeLogoUrl = espnTeamLogoUrl(sportKey, sit && sit.homeTeamId);
  const homeLogoMark = homeLogoUrl
    ? `<image href="${homeLogoUrl}" x="122" y="32" width="56" height="56" opacity="0.3" preserveAspectRatio="xMidYMid meet"/>`
    : '';
  // Down & distance as a bold, centered badge ON the field itself (like a
  // broadcast scoreboard bug) instead of small corner text — reads at a
  // glance regardless of where the ball actually is.
  let downBadge = '';
  const badgeLabel = live ? (sit.downDistanceText || sit.possessionText || '')
    : (started ? (sit.isHalftime ? 'HALFTIME' : 'BETWEEN PLAYS') : '');
  if(badgeLabel){
    const label = badgeLabel.toUpperCase();
    const w = Math.max(76, label.length * 8.2 + 24);
    const bx = Math.max(26 + w/2, Math.min(274 - w/2, badgeX));
    downBadge = `<g>
      <rect x="${(bx - w/2).toFixed(1)}" y="47" width="${w.toFixed(1)}" height="26" rx="13" fill="#141414" opacity="0.72"/>
      <text x="${bx.toFixed(1)}" y="64" text-anchor="middle" font-size="15" font-weight="800" fill="#F5F5F5" letter-spacing="0.4">${escapeHtml(label)}</text>
    </g>`;
  }
  const clockBits = [];
  if(started && !sit.isHalftime && sit.period) clockBits.push('Q' + sit.period);
  if(started && !sit.isHalftime && sit.displayClock) clockBits.push(sit.displayClock);
  const redZoneTag = live && sit.isRedZone ? '<span class="rz-tag">RED ZONE</span>' : '';
  const banner = started
    ? `<div class="field-banner"><span>${escapeHtml(clockBits.join(' · '))}</span>${redZoneTag}</div>`
    : '';
  const kickoffNote = !started
    ? `<div class="field-note">Kickoff ${new Date(game.commence_time).toLocaleTimeString([], {hour:'numeric', minute:'2-digit'})} — live tracker starts at kickoff</div>`
    : '';
  // Live scorebox: score, timeouts, and a possession highlight for each team —
  // a fuller in-widget summary instead of relying only on the small score
  // badge above the card. Only renders once the game has actually started
  // (scoreEntry.scores is null pre-kickoff).
  let scorebox = '';
  if(scoreEntry && scoreEntry.scores){
    const homeScore = scoreEntry.scores.find(s => s.name === game.home_team);
    const awayScore = scoreEntry.scores.find(s => s.name === game.away_team);
    const timeoutPips = (n) => n == null ? '' : '<span class="fs-timeouts">' + '●'.repeat(Math.max(0, n)) + '○'.repeat(Math.max(0, 3 - n)) + '</span>';
    const teamRow = (teamId, name, score, timeouts) => {
      const logo = espnTeamLogoUrl(sportKey, teamId);
      const hasBall = started && sit.possessionTeamId && sit.possessionTeamId === teamId;
      return `<div class="fs-team${hasBall ? ' fs-possession' : ''}">
        ${logo ? `<img class="fs-logo" src="${logo}" width="20" height="20" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : ''}
        <span class="fs-name">${escapeHtml(name)}</span>
        <span class="fs-score">${score != null ? escapeHtml(String(score)) : '—'}</span>
        ${timeoutPips(timeouts)}
      </div>`;
    };
    if(homeScore && awayScore){
      scorebox = `<div class="field-scorebox">
        ${teamRow(sit && sit.awayTeamId, game.away_team, awayScore.score, sit && sit.awayTimeouts)}
        ${teamRow(sit && sit.homeTeamId, game.home_team, homeScore.score, sit && sit.homeTimeouts)}
      </div>`;
    }
  }
  return `<div class="nfl-field-wrap">
    ${scorebox}
    ${banner}
    <svg class="nfl-field" viewBox="0 0 300 120" width="100%" height="120" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <rect x="0" y="8" width="24" height="104" fill="#265C33" stroke="#1C3F24" stroke-width="1.5"/>
      <rect x="276" y="8" width="24" height="104" fill="#265C33" stroke="#1C3F24" stroke-width="1.5"/>
      <rect x="24" y="8" width="252" height="104" fill="#2F6B3C" stroke="#1C3F24" stroke-width="2"/>
      ${yardTicks}
      ${yardNumbers}
      ${homeLogoMark}
      <line x1="150" y1="8" x2="150" y2="112" stroke="#F5F5F5" stroke-width="1" opacity="0.6"/>
      ${firstDownMark}
      ${losMark}
      ${dirArrow}
      ${ballMark}
      ${possessionMark}
      ${downBadge}
    </svg>
    ${kickoffNote}
  </div>`;
}


// ---------- shared NFL position-bucket / injury-status helpers ----------
// Same grouping the NFL Dashboard's Injury Center already uses — shared here
// so Board's per-game version looks and reads identically, not like a
// simplified knockoff.
const NFL_POS_BUCKETS = [
  ['QB', ['QB']],
  ['RB', ['RB', 'FB']],
  ['WR/TE', ['WR', 'TE']],
  ['OL', ['LT', 'LG', 'C', 'RG', 'RT', 'OT', 'G', 'OL']],
  ['Defense', ['LDE','RDE','DE','DT','NT','LILB','RILB','MLB','ILB','OLB','LOLB','ROLB','LB','LCB','RCB','CB','SS','FS','S','DB']],
  ['Special Teams', ['PK','K','P','LS','H','PR','KR']]
];
function nflBucketFor(pos){ return (NFL_POS_BUCKETS.find(([, list]) => list.includes(pos)) || ['Other'])[0]; }
function nflStatusClass(s){
  const t = (s || '').toLowerCase();
  if(t.includes('out') || t.includes('injured reserve') || t.includes('ir')) return 'nfl-status out';
  if(t.includes('doubtful')) return 'nfl-status out';
  if(t.includes('questionable')) return 'nfl-status quest';
  return 'nfl-status limited';
}

// ---------- per-game injury report (replaces the old 5-hour weather grid's
// screen space) ----------
let nflInjuriesCache = {}; // "away|home" -> {home:{name,logo,record,injuries[]}, away:{...}}
async function fetchNflGameInjuries(games){
  const matchups = [...new Map(games.map(g=>[g.away_team+'|'+g.home_team, g])).values()];
  await Promise.all(matchups.map(async g=>{
    const key = g.away_team+'|'+g.home_team;
    if(nflInjuriesCache[key]) return;
    try{
      const res = await fetch(`/api/nfl/game-injuries?home=${encodeURIComponent(g.home_team)}&away=${encodeURIComponent(g.away_team)}`);
      if(!res.ok) return;
      nflInjuriesCache[key] = await res.json();
    }catch(e){ /* injuries are a bonus panel — quietly skip on failure */ }
  }));
}
function buildNflInjuriesHtml(game){
  const key = game.away_team+'|'+game.home_team;
  const data = nflInjuriesCache[key];
  if(!data) return `<div class="injuries-strip"><div class="injuries-head">🩺 Injury Report</div><div class="hr-note">Loading…</div></div>`;
  const teamBlock = (side)=>{
    const head = `<div class="nba-team-head">
      ${side.logo ? `<img src="${escapeHtml(side.logo)}" width="20" height="20" alt="" loading="lazy" onerror="this.style.display='none'">` : ''}
      <strong>${escapeHtml(side.name)}</strong>
      ${side.record ? `<span class="nba-record">${escapeHtml(side.record)}</span>` : ''}
    </div>`;
    if(!side.injuries.length) return `<div class="injuries-team">${head}<div class="hr-note">No players listed right now.</div></div>`;
    // Who steps in for an injured starter — keyed by the injured player's id
    // so it can render right on that player's own row instead of a separate
    // table (this used to be nfl.js's standalone "Fantasy Impact" card).
    const nextManByOutId = {};
    (side.nextMen || []).forEach(n => { nextManByOutId[n.outId] = n; });
    const byBucket = {};
    side.injuries.forEach(i => { (byBucket[nflBucketFor(i.position)] = byBucket[nflBucketFor(i.position)] || []).push(i); });
    const groups = Object.entries(byBucket).map(([bucket, list])=>`
      <div class="nfl-pos-group">${escapeHtml(bucket)}</div>
      <ul class="nba-injury-list">${list.map(i=>{
        const nextMan = nextManByOutId[i.id];
        return `<li>${escapeHtml(i.name)} <span class="hand-tag">${escapeHtml(i.position)}</span>
         <span class="${nflStatusClass(i.status)}">${escapeHtml(i.status)}</span>${i.starter ? ' <span class="nfl-starter-tag">Starter</span>' : ''}
         ${nextMan ? `<div class="next-man">→ ${escapeHtml(nextMan.in)}</div>` : ''}</li>`;
      }).join('')}</ul>`).join('');
    return `<div class="injuries-team">${head}${groups}</div>`;
  };
  return `<div class="injuries-strip">
    <div class="injuries-head">🩺 Injury Report</div>
    <div class="injuries-body">${teamBlock(data.away)}${teamBlock(data.home)}</div>
  </div>`;
}

// ---------- NFL "Full Breakdown" (ported from the retired standalone NFL
// Dashboard page, so Board can show it per-game on demand instead of a
// separate page with its own team pickers). Shares the exact nba-*/nfl-*
// CSS classes the old Dashboard used — same look, just a different host. ----------
const nflFmt1 = v => v === null || v === undefined ? '—' : (Math.round(v*10)/10).toFixed(1);
const nflRankChip = (rank) => {
  if(!rank) return '';
  const cls = rank <= 10 ? 'nba-rank good' : rank >= 23 ? 'nba-rank bad' : 'nba-rank';
  return `<span class="${cls}">#${rank}</span>`;
};
function nflBreakdownTeamHead(side){
  return `<div class="nba-team-head">
    ${side.team.logo ? `<img src="${escapeHtml(side.team.logo)}" width="26" height="26" alt="" loading="lazy">` : ''}
    <strong>${escapeHtml(side.team.name)}</strong>
    <span class="nba-record">${escapeHtml(side.record || '')}</span>
  </div>`;
}
function nflBreakdownCard(title, bodyHtml, accent){
  return `<div class="game-card nba-card${accent?' nba-card-accent':''}">
    <div class="nba-card-title">${escapeHtml(title)}</div>
    <div class="nba-card-body">${bodyHtml}</div>
  </div>`;
}
function nflMatchupCardHtml(m){
  // Every metric here is a season-to-date stat — before either team has
  // played a game, it's all nulls, which would render as a wall of "—"
  // that reads as broken rather than "too early." Say that plainly instead.
  if(!m.away.schedule.gamesPlayed && !m.home.schedule.gamesPlayed){
    return nflBreakdownCard('Matchup Breakdown', `<div class="hr-note">No games played yet this season — these are season-to-date stats, so there's nothing to show until Week 1 wraps. Check the Auto Game Read and Weather cards above for what's available now.</div>`);
  }
  const cross = (off, def, label) => `
    <div class="nfl-cross-row">
      <div class="nfl-cross-side">
        <span class="nfl-cross-team">${escapeHtml(off.team.abbrev)}</span> ${label.off}
        <div class="nfl-cross-val">${label.offVal(off)} ${nflRankChip(label.offRank(off))}</div>
      </div>
      <span class="nfl-cross-vs">vs</span>
      <div class="nfl-cross-side">
        <span class="nfl-cross-team">${escapeHtml(def.team.abbrev)}</span> ${label.def}
        <div class="nfl-cross-val">${label.defVal(def)} ${nflRankChip(label.defRank(def))}</div>
      </div>
    </div>`;
  const rush = { off:'Rush offense', def:'Points allowed', offVal:s=>nflFmt1(s.metrics.rushYpg)+' ypg', offRank:s=>s.ranks.rushYpg, defVal:s=>nflFmt1(s.pa)+' pa/g', defRank:s=>s.ranks.pa };
  const pass = { off:'Pass offense', def:'Pass rush', offVal:s=>nflFmt1(s.metrics.passYpg)+' ypg', offRank:s=>s.ranks.passYpg, defVal:s=>nflFmt1(s.metrics.sacksMadePerGame)+' sacks/g', defRank:s=>s.ranks.sacksMadePerGame };
  const rows = [
    ['Total YPG', s=>`${nflFmt1(s.metrics.ypg)} ${nflRankChip(s.ranks.ypg)}`],
    ['Yards/Play', s=>`${s.metrics.ypp !== null ? s.metrics.ypp.toFixed(2) : '—'}`],
    ['Comp %', s=>`${nflFmt1(s.metrics.completionPct)}%`],
    ['Time of Poss.', s=>s.metrics.topSecPerGame !== null ? `${Math.floor(s.metrics.topSecPerGame/60)}:${String(Math.round(s.metrics.topSecPerGame%60)).padStart(2,'0')}` : '—'],
    ['Red Zone TD%', s=>`${nflFmt1(s.metrics.redZoneTdPct)}% ${nflRankChip(s.ranks.redZoneTdPct)}`],
    ['Third Down %', s=>`${nflFmt1(s.metrics.thirdDownPct)}% ${nflRankChip(s.ranks.thirdDownPct)}`],
    ['ANY/A', s=>`${s.metrics.anyA !== null ? s.metrics.anyA.toFixed(2) : '—'} ${nflRankChip(s.ranks.anyA)}`],
    ['Explosive plays/g (20+ yds)', s=>`${nflFmt1(s.metrics.explosive)} ${nflRankChip(s.ranks.explosive)}`],
    ['Sacks allowed/g', s=>`${nflFmt1(s.metrics.sacksAllowedPerGame)} ${nflRankChip(s.ranks.sacksAllowedPerGame)}`],
    ['Takeaway INTs/g', s=>`${nflFmt1(s.metrics.intsCaughtPerGame)} ${nflRankChip(s.ranks.intsCaughtPerGame)}`],
    ['Turnover margin/g', s=>`${s.metrics.turnoverMargin !== null ? (s.metrics.turnoverMargin>0?'+':'')+s.metrics.turnoverMargin.toFixed(2) : '—'} ${nflRankChip(s.ranks.turnoverMargin)}`]
  ];
  return nflBreakdownCard('Matchup Breakdown', `
    ${cross(m.away, m.home, rush)}
    ${cross(m.home, m.away, rush)}
    ${cross(m.away, m.home, pass)}
    ${cross(m.home, m.away, pass)}
    <div class="table-scroll" style="margin-top:10px;"><table class="props-table"><thead>
      <tr><th></th><th>${escapeHtml(m.away.team.abbrev)}</th><th>${escapeHtml(m.home.team.abbrev)}</th></tr></thead><tbody>
      ${rows.map(([label, fn])=>`<tr><td style="font-weight:600;">${label}</td><td>${fn(m.away)}</td><td>${fn(m.home)}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="hr-note" style="margin-top:8px;">Yards-allowed defensive splits aren't on any free feed — defense here is points allowed, pass rush, and takeaways.</div>`);
}
function nflWeatherCardHtml(m){
  const w = m.weather;
  let body;
  if(!w){ body = '<div class="hr-note">Weather unavailable for this venue.</div>'; }
  else if(w.dome){ body = `<div class="hr-note">Indoor stadium — weather doesn't affect play.</div>`; }
  else {
    const flags = [];
    if((w.windMph ?? 0) >= 15) flags.push(['Passing downgrade', 'bad'], ['Running upgrade', 'good']);
    if(w.rain || w.snow) flags.push(['Ball security matters', 'bad'], ['Running upgrade', 'good']);
    body = `
      <div class="nba-flags" style="margin-bottom:8px;">
        <span class="nba-flag on">${w.tempF !== null ? Math.round(w.tempF) + '°F' : '—'}</span>
        <span class="nba-flag${(w.windMph ?? 0) >= 15 ? ' on' : ''}">Wind ${w.windMph !== null ? Math.round(w.windMph) + ' mph' : '—'}</span>
        <span class="nba-flag${w.rain ? ' on' : ''}">Rain</span>
        <span class="nba-flag${w.snow ? ' on' : ''}">Snow</span>
      </div>
      ${flags.length
        ? `<div class="nba-leans">${flags.map(([t])=>`<span class="nba-lean">${escapeHtml(t)}</span>`).join('')}</div>`
        : '<div class="hr-note">Current conditions look neutral for both phases.</div>'}
      <div class="hr-note" style="margin-top:6px;">Current conditions at ${escapeHtml(m.home.team.abbrev)}'s stadium — check again close to kickoff.</div>`;
  }
  return nflBreakdownCard('Weather', body);
}
function nflFormCardHtml(m){
  const side = s => `
    ${nflBreakdownTeamHead(s)}
    <div class="hr-note">
      ${s.schedule.last10 ? `Last 10 (straight-up): <strong>${escapeHtml(s.schedule.last10)}</strong>` : 'No completed games yet this season.'}
      ${s.schedule.streak ? ` · ${escapeHtml(s.schedule.streak)}` : ''}
      ${s.schedule.offBye ? ' · <span class="stat-pos">Off the bye</span>' : ''}
    </div>`;
  return nflBreakdownCard('Recent Form', `
    <div class="nba-two-col">
      <div>${side(m.away)}</div>
      <div>${side(m.home)}</div>
    </div>
    <div class="hr-note" style="margin-top:8px;">Against-the-spread and over/under trend history requires paid closing-line data — form shown here is straight-up wins and losses from the schedule.</div>`);
}
function nflSummaryCardHtml(m){
  const s = m.summary;
  return nflBreakdownCard('Auto Game Read', `
    <ul class="nba-summary-list">${s.insights.map(i=>`<li>${escapeHtml(i)}</li>`).join('')}</ul>
    ${s.leans.length ? `<div class="nba-leans">${s.leans.map(l=>`<span class="nba-lean">${escapeHtml(l)}</span>`).join('')}</div>` : ''}
    <div class="nba-confidence">Signal strength: <strong>${s.confidence}/10</strong></div>
    <div class="hr-note" style="margin-top:6px;">${escapeHtml(s.note)}</div>`, true);
}
// Player Form (props context) — the one interactive panel. Caller supplies
// rosters/analyzerPlayer/playerForm/gameId so this stays a pure render (all
// the fetch/state-tracking lives in board.js, same as everything else here).
function nflAnalyzerCardHtml(m, gameId, rosters, analyzerPlayerId, playerForm){
  const options = [m.away, m.home].map(s=>{
    const roster = (rosters[s.team.id] || []).filter(p=>['QB','RB','WR','TE'].includes(p.position));
    return `<optgroup label="${escapeHtml(s.team.name)}">${roster.map(p=>`<option value="${escapeHtml(p.id)}" ${String(p.id)===String(analyzerPlayerId)?'selected':''}>${escapeHtml(p.name)} (${escapeHtml(p.position)})</option>`).join('')}</optgroup>`;
  }).join('');
  let body = `<div class="search-row" style="margin-bottom:10px;">
    <select class="nba-team-select nfl-analyzer-select" data-game-id="${escapeHtml(gameId)}">${options || '<option>Loading rosters…</option>'}</select>
    <button class="ghost nfl-analyzer-btn" data-game-id="${escapeHtml(gameId)}">Check form</button>
  </div>`;
  const pf = analyzerPlayerId && playerForm[analyzerPlayerId];
  if(analyzerPlayerId && pf && pf !== 'loading'){
    const p = Object.values(rosters).flat().find(x=>String(x.id)===String(analyzerPlayerId));
    if(p) body += `<div class="nba-team-head" style="margin-bottom:8px;">${avatarUrlHtml(p.headshot, 32)}<strong>${escapeHtml(p.name)}</strong> <span class="nba-record">${escapeHtml(p.position)}</span></div>`;
  }
  if(pf === 'loading'){
    body += `<div class="hr-note"><span class="spinner"></span> Pulling game logs (3 seasons for the head-to-head)…</div>`;
  } else if(pf && pf.season.games){
    const ydsLabels = [];
    let seen = 0;
    (pf.labels || []).forEach((l, i)=>{
      if(l === 'YDS'){
        seen++;
        const before = pf.labels.slice(0, i).join(',');
        ydsLabels.push(before.includes('CMP') && seen === 1 ? 'Pass YDS' : before.includes('REC') ? 'Rec YDS' : 'Rush YDS');
      }
    });
    const vs = pf.vsOpponent;
    const rows = [['Last 5', pf.last5], ['Season', pf.season]];
    if(vs && vs.games) rows.push([`vs ${vs.abbrev || 'OPP'} (3 seasons)`, vs]);
    body += `<div class="table-scroll"><table class="props-table"><thead>
      <tr><th>Split</th><th>G</th>${ydsLabels[0]?`<th>${ydsLabels[0]}</th>`:''}${ydsLabels[1]?`<th>${ydsLabels[1]}</th>`:''}<th>TD</th>${pf.season.rec !== null ? '<th>REC</th>' : ''}</tr></thead><tbody>
      ${rows.map(([label, r])=>`<tr><td style="font-weight:600;">${label}</td><td>${r.games}</td>${ydsLabels[0]?`<td>${nflFmt1(r.yds1)}</td>`:''}${ydsLabels[1]?`<td>${nflFmt1(r.yds2)}</td>`:''}<td>${nflFmt1(r.td1)}</td>${pf.season.rec !== null ? `<td>${nflFmt1(r.rec)}</td>` : ''}</tr>`).join('')}
    </tbody></table></div>`;
    if(vs && vs.meetings && vs.meetings.length){
      body += `<div class="nfl-pos-group" style="margin-top:8px;">Last meetings vs ${escapeHtml(vs.abbrev || '')}</div>
        <div class="table-scroll"><table class="props-table"><thead>
        <tr><th>Date</th><th>Site</th>${ydsLabels[0]?`<th>${ydsLabels[0]}</th>`:''}<th>TD</th>${pf.season.rec !== null ? '<th>REC</th>' : ''}</tr></thead><tbody>
        ${vs.meetings.map(mt=>`<tr><td>${escapeHtml(mt.date || '')}</td><td>${mt.home?'Home':'Away'}</td>${ydsLabels[0]?`<td>${mt.yds1 ?? '—'}</td>`:''}<td>${mt.td1 ?? '—'}</td>${pf.season.rec !== null ? `<td>${mt.rec ?? '—'}</td>` : ''}</tr>`).join('')}
      </tbody></table></div>`;
    } else if(vs){
      body += `<div class="hr-note" style="margin-top:6px;">No meetings against this opponent in the last 3 seasons.</div>`;
    }
    if(vs && vs.games >= 2 && vs.yds1 !== null && pf.season.yds1 !== null){
      const d = vs.yds1 - pf.season.yds1;
      if(Math.abs(d) >= 15){
        body += `<div class="nba-insight">Averages ${nflFmt1(Math.abs(d))} ${d > 0 ? 'MORE' : 'fewer'} yards against this opponent than his overall norm (${vs.games}-game sample).</div>`;
      }
    }
    if(pf.last5.yds1 !== null && pf.season.yds1 !== null){
      const d = pf.last5.yds1 - pf.season.yds1;
      body += `<div class="nba-insight">${Math.abs(d) < 15 ? 'Producing right at season norm over the last 5.' : d > 0 ? `Averaging ${nflFmt1(d)} yards above season norm over the last 5 — favorable form for Over props.` : `Averaging ${nflFmt1(-d)} yards below season norm over the last 5 — caution on Overs.`}</div>`;
    }
  } else if(pf === null){
    body += `<div class="hr-note">No game-log data for this player.</div>`;
  }
  body += `<div class="hr-note" style="margin-top:8px;">Prop lines and odds live right above in this game's player-props panel — this card is the form behind them.</div>`;
  return nflBreakdownCard('Player Form (props context)', body);
}
function buildNflFullBreakdownHtml(m, gameId, rosters, analyzerPlayerId, playerForm){
  return `<div class="nfl-breakdown">
    ${nflSummaryCardHtml(m)}
    ${nflMatchupCardHtml(m)}
    ${nflWeatherCardHtml(m)}
    ${nflFormCardHtml(m)}
    ${nflAnalyzerCardHtml(m, gameId, rosters, analyzerPlayerId, playerForm)}
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

// ---------- push notifications ----------
function urlBase64ToUint8Array(base64String){
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}
function pushSupported(){
  return 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined';
}
async function getPushSubscription(){
  if(!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration('/sw.js');
  if(!reg) return null;
  return reg.pushManager.getSubscription();
}
async function subscribeToPush(){
  if(!pushSupported()) return { ok:false, reason:'unsupported' };
  const perm = await Notification.requestPermission();
  if(perm !== 'granted') return { ok:false, reason:'denied' };
  const keyRes = await fetch('/api/push/vapid-public-key');
  if(!keyRes.ok) return { ok:false, reason:'not_configured' };
  const { key } = await keyRes.json();
  const reg = await navigator.serviceWorker.register('/sw.js');
  const sub = await reg.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey: urlBase64ToUint8Array(key) });
  await fetch('/api/push/subscribe', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(sub) });
  return { ok:true };
}
async function unsubscribeFromPush(){
  const sub = await getPushSubscription();
  if(!sub) return;
  await fetch('/api/push/unsubscribe', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ endpoint: sub.endpoint }) });
  await sub.unsubscribe();
}
