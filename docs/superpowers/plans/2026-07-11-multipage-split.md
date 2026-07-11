# LineWatch Multi-Page Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-page UI with four real pages (Home, Board, Props, Slip) behind clickable nav links, keeping the current visual design and the Express server unchanged.

**Architecture:** Plain multi-page static site: each page is its own HTML file sharing `styles.css`; `common.js` holds shared consts/helpers/state (slip in localStorage, sport in localStorage, nav + badge + toast); each page has one small script that wires only its own DOM. The old `public/app.js` is dismantled: every function moves verbatim to `common.js` or exactly one page script, with only the modifications this plan lists.

**Tech Stack:** Vanilla JS (no modules, no build step — plain `<script>` globals, matching current style), Express 4 static serving (already in place, zero server changes).

**Source material:** `public/app.js`, `public/index.html`, `public/styles.css` as committed at branch `multipage-split` (HEAD ffcf556). Move instructions reference FUNCTION NAMES, not line numbers — locate with grep. Spec: `docs/superpowers/specs/2026-07-11-multipage-split-design.md`.

## Global Constraints

- Visual design unchanged: same CSS variables, class names, fonts. New CSS only ADDS rules (badge, toast, CTA cards, 2-col layout variant) — never edits existing rules.
- Server untouched: no changes to `server.js` or `test/server.test.js`; `npm test` must stay 11/11.
- localStorage keys (exact): slip `lw_slip` (JSON array of `{id, matchup, side, rows}`), sport `lw_sport` (default `americanfootball_nfl`).
- Page files (exact): `public/index.html` (Home), `public/board.html`, `public/props.html`, `public/slip.html`; scripts `public/common.js`, `public/home.js`, `public/board.js`, `public/props.js`, `public/slip.js`. `public/app.js` deleted in the final task.
- Every page loads `<script src="common.js"></script>` before its page script, at the end of `<body>`.
- Nav rail pages + hrefs (exact): Home `/`, Board `/board.html`, Props `/props.html`, Slip `/slip.html`. Active page gets class `active` on its rail link.
- Corrupt/missing `lw_slip` → treated as empty array, never a crash.
- No key material anywhere; commit guard before every commit: stage, then `! git diff --cached | grep -q 4256ff9b`, then commit.
- Moved functions are copied VERBATIM unless a task shows a modification; show-code rule applies to every modification.

---

### Task 1: common.js + CSS additions

**Files:**
- Create: `public/common.js`
- Modify: `public/styles.css` (append only)

**Interfaces:**
- Produces (page scripts rely on these exact names):
  - Consts: `SPORTS`, `BOOK_STYLES`, `TRACKED_KEYS`, `BOOK_LINKS`, `PROP_MARKETS`
  - Helpers: `americanToDecimal(a)`, `decimalToAmerican(d)`, `fmtAmerican(a)`, `computeFairDecimal(sideARows, sideBRows)`, `escapeHtml(s)`, `bookStyleFor(key)`, `marketLabel(key)`, `linkedBadge(bookKey, fallbackTitle)`
  - `getSlip()` → array; `addLegToSlip(leg)`; `removeLegFromSlip(id)`; `updateSlipBadge()`
  - `getSport()` → sport key; `setSport(key)`
  - `renderNav(activePage)` — activePage ∈ `'home'|'board'|'props'|'slip'`; renders into `#navRail`
  - `showToast(text)` — 2s toast linking to `/slip.html`
  - `renderSportChips(containerEl, onSelect)` — chips from `SPORTS`, active = `getSport()`; click = `setSport` + active swap + `onSelect(key)`
  - `fetchOddsFor(sport)` → `Promise<{games, remaining, cacheAge}>`, throws `Error` with server `{error}` message on non-ok
  - `oddsStatusText(count, remaining, cacheAge)` → status string
  - `setStatus(live, text)`, `showError(msg)`, `clearError()` — no-ops when the page lacks the target elements
  - `updateTicker(games)` — takes games as a PARAMETER (signature change from app.js)

- [ ] **Step 1: Create public/common.js**

Top of file, MOVE VERBATIM from `public/app.js` (copy each whole declaration; they currently sit inside app.js's IIFE — in common.js they are top-level):
`SPORTS`, `BOOK_STYLES`, `TRACKED_KEYS`, `BOOK_LINKS`, `PROP_MARKETS` (the five consts), then the functions `americanToDecimal`, `decimalToAmerican`, `fmtAmerican`, `computeFairDecimal`, `escapeHtml`, `bookStyleFor`, `marketLabel`, `linkedBadge`.

Then MOVE WITH MODIFICATION — `setStatus`, `showError`, `clearError`, `updateTicker` become element-guarded / parameterized:

```js
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
```

Then NEW code, verbatim:

```js
// ---------- slip storage (localStorage, shared across pages) ----------
const SLIP_KEY = 'lw_slip';
function getSlip(){
  try{
    const v = JSON.parse(localStorage.getItem(SLIP_KEY));
    return Array.isArray(v) ? v : [];
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
  const v = localStorage.getItem(SPORT_KEY);
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
```

- [ ] **Step 2: Append to public/styles.css** (append only — do not edit existing rules):

```css
/* ---------- Multi-page additions ---------- */
a.rail-btn{text-decoration:none;}
a.rail-logo{text-decoration:none;}
.layout.no-side{grid-template-columns:76px 1fr;}
@media (max-width:980px){
  .layout.no-side{grid-template-columns:1fr;}
}
.slip-badge{
  font-family:var(--font-mono); font-size:9px; font-weight:700;
  background:var(--accent); color:#061E45; border-radius:8px;
  padding:1px 5px; margin-left:3px; display:none; line-height:1.4;
}
.slip-badge.on{display:inline-block;}
.toast{
  position:fixed; bottom:24px; right:24px; z-index:60;
  background:var(--accent); color:#061E45; padding:11px 16px;
  border-radius:8px; font-weight:600; font-size:13px; text-decoration:none;
  opacity:0; pointer-events:none; transition:opacity .2s ease;
  box-shadow:0 4px 18px rgba(0,0,0,0.35);
}
.toast.show{opacity:1; pointer-events:auto;}
.cta-row{display:grid; grid-template-columns:1fr 1fr; gap:14px; margin:18px 0;}
.cta-card{
  display:block; background:var(--bg-card); border:1px solid var(--border);
  border-radius:10px; padding:20px 18px; text-decoration:none; color:var(--text);
  transition:all .15s ease;
}
.cta-card:hover{background:var(--bg-card-hover); border-color:var(--accent-dim);}
.cta-card h3{font-family:var(--font-display); font-size:24px; font-weight:600; margin-bottom:6px;}
.cta-card p{font-size:12.5px; color:var(--text-dim); line-height:1.5;}
.cta-card .go{color:var(--accent); font-weight:700; font-size:12px; margin-top:10px; display:inline-block;}
@media (max-width:640px){.cta-row{grid-template-columns:1fr;}}
```

- [ ] **Step 3: Verify**

Run: `node --check public/common.js`
Expected: silent (exit 0).
Run: `grep -c 'function ' public/common.js`
Expected: ≥ 20.
Sanity: `node -e "const fs=require('fs');const src=fs.readFileSync('public/common.js','utf8');['SPORTS','BOOK_STYLES','TRACKED_KEYS','BOOK_LINKS','PROP_MARKETS','computeFairDecimal','linkedBadge','marketLabel','fetchOddsFor','renderNav','addLegToSlip','getSport'].forEach(n=>{if(!src.includes(n)) throw new Error('missing '+n)});console.log('names ok')"`
Expected: `names ok`.
Note: app.js still exists and index.html still loads it — pages are untouched until later tasks; common.js is additive and loaded by nothing yet.

- [ ] **Step 4: Commit**

```bash
git add public/common.js public/styles.css && ! git diff --cached | grep -q 4256ff9b && git commit -m "feat: shared common.js and CSS for multi-page split"
```

---

### Task 2: Board page

**Files:**
- Create: `public/board.html`, `public/board.js`

**Interfaces:**
- Consumes from common.js: `renderNav('board')`, `renderSportChips`, `getSport`, `fetchOddsFor`, `oddsStatusText`, `setStatus`, `showError`, `clearError`, `updateTicker`, `computeFairDecimal`, `americanToDecimal`, `fmtAmerican`, `escapeHtml`, `bookStyleFor`, `BOOK_LINKS`, `TRACKED_KEYS`, `addLegToSlip`, `showToast`
- Produces: nothing consumed by later tasks (pages are independent).

- [ ] **Step 1: Create public/board.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>LineWatch — Odds Board</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Teko:wght@500;600;700&family=Inter:wght@400;500;600;700&family=Roboto+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="styles.css">
</head>
<body>

<header class="app-header">
  <div class="header-top">
    <div class="brand">
      <h1>Line<span>Watch</span></h1>
      <div class="tag">Your Odds Copilot</div>
    </div>
    <div class="header-controls">
      <button id="autoBtn" class="ghost" title="Toggle auto-refresh">Auto: Off</button>
    </div>
  </div>
  <div class="ticker-wrap">
    <div class="ticker-track" id="tickerTrack">
      <span>Pick a sport and pull odds to populate this ticker →</span>
    </div>
  </div>
</header>

<div class="layout no-side">
  <nav class="nav-rail" id="navRail"></nav>

  <main>
    <div class="hero-line">Odds Board</div>
    <div class="hero-sub">Compare moneylines across books — best price first, value flagged.</div>
    <div class="chip-row" id="sportChips"></div>
    <div class="status-row">
      <div class="dot" id="statusDot"></div>
      <span id="statusText">Loading odds…</span>
    </div>
    <div class="search-row">
      <input type="text" id="searchInput" placeholder="Search a team or matchup (e.g. Lakers, Chiefs)…">
      <button id="fetchBtn" class="primary">Get Odds</button>
    </div>
    <div id="errorArea"></div>
    <div id="gamesArea">
      <div class="empty-state">
        <h3>No odds loaded yet</h3>
        <p>Pick a sport chip above. Odds are ranked best → worst per side, with a badge for each sportsbook. Player props live on the <a href="/props.html">Props page</a>.</p>
      </div>
    </div>
  </main>
</div>

<footer class="disclaimer">
  <strong>Informational tool only.</strong> LineWatch pulls publicly available odds data and does not place bets, hold funds, or connect to any sportsbook account.
  Combined "parlay" figures are for comparison only — always confirm the exact price on the sportsbook itself before betting, as odds move quickly.
  Must be 21+ and located in a state where sports betting is legal. If gambling stops being fun or feels out of control, Ohio's problem gambling helpline is
  1-800-589-9966, or text 4HOPE to 741741. National Problem Gambling Helpline: 1-800-522-4700.
</footer>

<script src="common.js"></script>
<script src="board.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create public/board.js**

Structure (write exactly; the body of `renderGames` is MOVED from app.js with listed modifications):

```js
(function(){
  const state = { games: [], searchTerm: '', autoRefresh: false, autoTimer: null };

  renderNav('board');
  renderSportChips(document.getElementById('sportChips'), refresh);

  async function refresh(){
    clearError();
    const btn = document.getElementById('fetchBtn');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
    setStatus(false, 'Fetching latest odds…');
    try{
      const {games, remaining, cacheAge} = await fetchOddsFor(getSport());
      state.games = games;
      renderGames();
      updateTicker(games);
      setStatus(true, oddsStatusText(games.length, remaining, cacheAge));
    }catch(e){
      setStatus(false, 'Fetch failed.');
      showError(e.message || 'Could not fetch odds — try again shortly.');
    }finally{
      btn.disabled = false; btn.textContent = 'Get Odds';
    }
  }
  document.getElementById('fetchBtn').addEventListener('click', refresh);

  document.getElementById('autoBtn').addEventListener('click', function(){
    state.autoRefresh = !state.autoRefresh;
    this.textContent = 'Auto: ' + (state.autoRefresh ? 'On (10m)' : 'Off');
    if(state.autoRefresh){
      state.autoTimer = setInterval(refresh, 10*60*1000);
    }else{
      clearInterval(state.autoTimer);
    }
  });

  document.getElementById('searchInput').addEventListener('input', (e)=>{
    state.searchTerm = e.target.value;
    if(state.games.length) renderGames();
  });

  // renderGames: MOVED from app.js — see modifications below
  function renderGames(){ /* moved body */ }

  refresh();
})();
```

`renderGames` modifications relative to the app.js original (everything else verbatim):
1. DELETE the entire player-props block: from the comment `// ---- player props (opt-in) ----` through the closing of the `if(PROP_MARKETS[sportKey]){...}` block (the `toggleWrap`/`propsHost`/`toggleBtn` code). Also delete the now-unused `const sportKey = sportSelect.value;` line directly above it.
2. The `+ Slip` click handler changes from `addLeg(game, team, rows)` to:
```js
          row.querySelector('.add-leg-btn').addEventListener('click', ()=>{
            addLegToSlip({
              id: Date.now()+Math.random(),
              matchup: `${game.away_team} @ ${game.home_team}`,
              side: team,
              rows: rows
            });
            showToast('Added ✓');
          });
```
(The old `addLeg`/`removeLeg`/`renderSlip` functions are NOT moved to board.js — they belong to the Slip page.)
3. The empty-search message and empty-games message stay verbatim.

- [ ] **Step 3: Verify**

Run: `node --check public/board.js` → exit 0.
Run: `grep -nE 'addLeg\(|renderSlip|sportSelect|propsHost|toggleBtn|PROP_MARKETS' public/board.js` → no output (`addLegToSlip(` does not match `addLeg\(`).
Cross-check ids: `node -e "const fs=require('fs');const js=fs.readFileSync('public/board.js','utf8');const html=fs.readFileSync('public/board.html','utf8');const ids=[...js.matchAll(/getElementById\('([^']+)'\)/g)].map(m=>m[1]);const missing=[...new Set(ids)].filter(id=>!html.includes('id=\"'+id+'\"'));if(missing.length) throw new Error('missing: '+missing);console.log('ids ok:', new Set(ids).size)"` → `ids ok: <n>` (note: `slipBadge`/`lwToast` are created by common.js at runtime, not in HTML — the check above only sees board.js so they won't appear).
Live check (server must be running with a key in .env; start with `node server.js` in background if not): `curl -s http://localhost:3000/board.html | grep -c 'board.js'` → 1. Then open-in-browser verification happens at final task.

- [ ] **Step 4: Commit**

```bash
git add public/board.html public/board.js && ! git diff --cached | grep -q 4256ff9b && git commit -m "feat: standalone Board page"
```

---

### Task 3: Props page

**Files:**
- Create: `public/props.html`, `public/props.js`

**Interfaces:**
- Consumes from common.js: `renderNav('props')`, `renderSportChips`, `getSport`, `fetchOddsFor`, `oddsStatusText`, `setStatus`, `showError`, `clearError`, `updateTicker`, `escapeHtml`, `fmtAmerican`, `americanToDecimal`, `bookStyleFor`, `marketLabel`, `BOOK_LINKS`, `TRACKED_KEYS`, `PROP_MARKETS`, `addLegToSlip`, `showToast`

- [ ] **Step 1: Create public/props.html**

Same skeleton as board.html (head block identical except `<title>LineWatch — Player Props</title>`; header, ticker, footer, `layout no-side`, `navRail` identical) with this `<main>`:

```html
  <main>
    <div class="hero-line">Player Props</div>
    <div class="hero-sub">Props load per game to protect API quota — expand a game and hit "Load props".</div>
    <div class="chip-row" id="sportChips"></div>
    <div class="status-row">
      <div class="dot" id="statusDot"></div>
      <span id="statusText">Loading games…</span>
    </div>
    <div class="search-row">
      <input type="text" id="searchInput" placeholder="Search a player, team, or matchup…">
    </div>
    <div id="errorArea"></div>
    <div class="chip-row" id="bookFilterChips"></div>
    <div id="propsArea">
      <div class="empty-state">
        <h3>No games loaded yet</h3>
        <p>Pick a sport above. Each game card has a "Load props" button — props cost ~12 API credits per game, so load only games you care about.</p>
      </div>
    </div>
  </main>
```

And the closing scripts: `<script src="common.js"></script><script src="props.js"></script>`.

- [ ] **Step 2: Create public/props.js**

```js
(function(){
  const state = {
    games: [], searchTerm: '',
    propsCache: {},   // gameId -> {game, data}
    propRegistry: {}, // propId -> {side, matchup, rows}
    propIdCounter: 0,
    propsBookFilter: 'all',
    propsCollapsed: {},
    marketCollapsed: {},
    autoRefresh: false, autoTimer: null
  };

  renderNav('props');
  renderSportChips(document.getElementById('sportChips'), ()=>{
    state.propsCache = {}; state.propRegistry = {}; state.propsCollapsed = {}; state.marketCollapsed = {};
    state.propsBookFilter = 'all';
    loadGames();
  });

  async function loadGames(){
    clearError();
    setStatus(false, 'Loading games…');
    try{
      const {games, remaining, cacheAge} = await fetchOddsFor(getSport());
      state.games = games;
      renderPage();
      updateTicker(games);
      setStatus(true, oddsStatusText(games.length, remaining, cacheAge));
    }catch(e){
      setStatus(false, 'Fetch failed.');
      showError(e.message || 'Could not fetch games — try again shortly.');
    }
  }

  document.getElementById('autoBtn').addEventListener('click', function(){
    state.autoRefresh = !state.autoRefresh;
    this.textContent = 'Auto: ' + (state.autoRefresh ? 'On (10m)' : 'Off');
    if(state.autoRefresh){ state.autoTimer = setInterval(loadGames, 10*60*1000); }
    else{ clearInterval(state.autoTimer); }
  });

  document.getElementById('searchInput').addEventListener('input', (e)=>{
    state.searchTerm = e.target.value;
    renderPage();
  });

  function renderBookFilter(){
    const el = document.getElementById('bookFilterChips');
    const cached = Object.values(state.propsCache);
    if(!cached.length){ el.innerHTML = ''; return; }
    const booksPresent = new Set();
    cached.forEach(({data})=>{
      (data.bookmakers||[]).forEach(b=>{
        const k = b.key.toLowerCase();
        if(TRACKED_KEYS.includes(k)) booksPresent.add(k);
      });
    });
    let html = `<button class="chip props-filter-chip${state.propsBookFilter==='all'?' active':''}" data-book="all">All books</button>`;
    const orderedBooks = [...booksPresent].sort((a,b)=> (a==='fanduel'?-1:b==='fanduel'?1:a.localeCompare(b)));
    orderedBooks.forEach(k=>{
      const style = bookStyleFor(k);
      html += `<button class="chip props-filter-chip${state.propsBookFilter===k?' active':''}" data-book="${k}">${escapeHtml(style?style.name:k)}</button>`;
    });
    el.innerHTML = html;
  }

  function renderPage(){
    renderBookFilter();
    const area = document.getElementById('propsArea');
    const term = state.searchTerm.trim().toLowerCase();
    const gamesToShow = term
      ? state.games.filter(g => (g.home_team+' '+g.away_team).toLowerCase().includes(term) || state.propsCache[g.id])
      : state.games;
    if(!state.games.length){
      area.innerHTML = '<div class="empty-state"><h3>No games found</h3><p>Try a different sport — this one may be out of season.</p></div>';
      return;
    }
    if(!gamesToShow.length){
      area.innerHTML = `<div class="empty-state"><h3>No matches</h3><p>Nothing found for "${escapeHtml(state.searchTerm)}".</p></div>`;
      return;
    }
    let html = '';
    gamesToShow.forEach(game=>{
      const when = new Date(game.commence_time);
      const collapsed = state.propsCollapsed[game.id];
      const cached = state.propsCache[game.id];
      html += `<div class="game-card" style="margin-bottom:14px;" id="propgame-${escapeHtml(game.id)}">
        <div class="game-head prop-game-head" data-game-id="${escapeHtml(game.id)}" style="cursor:pointer;" title="Click to ${collapsed?'expand':'collapse'}">
          <div class="game-teams">${escapeHtml(game.away_team)}<span class="vs">@</span>${escapeHtml(game.home_team)}</div>
          <div class="game-time">${when.toLocaleDateString(undefined,{month:'short',day:'numeric'})} · ${when.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})} &nbsp;${collapsed?'▸':'▾'}</div>
        </div>
        <div class="prop-body" style="${collapsed?'display:none;':''}">
          ${cached
            ? buildPropsHtml(game, cached.data, PROP_MARKETS[getSport()] || [])
            : `<div class="props-toggle" style="padding:14px 16px; margin:0;"><button class="ghost load-props-btn" data-game-id="${escapeHtml(game.id)}">Load player props</button></div>`}
        </div>
      </div>`;
    });
    area.innerHTML = html;
  }

  async function loadProps(game){
    try{
      const res = await fetch(`/api/props/${getSport()}/${game.id}`);
      if(!res.ok){
        state.propsCache[game.id] = {game, data:{bookmakers:[]}, unavailable:true};
        renderPage();
        return;
      }
      const data = await res.json();
      state.propsCache[game.id] = {game, data};
      renderPage();
    }catch(e){
      showError("Couldn't load props right now.");
    }
  }

  // buildPropsHtml: MOVED from app.js — see modifications below
  function buildPropsHtml(game, data, markets){ /* moved body */ }

  // Delegated clicks: load buttons, collapse headers, filter chips, market headers, + Slip
  document.getElementById('propsArea').addEventListener('click', (e)=>{
    const loadBtn = e.target.closest('.load-props-btn');
    if(loadBtn){
      const game = state.games.find(g=>g.id===loadBtn.dataset.gameId);
      if(game){
        loadBtn.disabled = true;
        loadBtn.innerHTML = '<span class="spinner"></span> Loading…';
        loadProps(game);
      }
      return;
    }
    const marketHead = e.target.closest('.prop-market-head');
    if(marketHead){
      const key = marketHead.dataset.sectionKey;
      const nowCollapsed = !state.marketCollapsed[key];
      state.marketCollapsed[key] = nowCollapsed;
      const body = marketHead.nextElementSibling;
      if(body && body.classList.contains('market-body')){
        body.style.display = nowCollapsed ? 'none' : '';
      }
      const arrow = marketHead.querySelector('.market-arrow');
      if(arrow) arrow.textContent = nowCollapsed ? '▸' : '▾';
      marketHead.title = 'Click to ' + (nowCollapsed ? 'expand' : 'collapse');
      return;
    }
    const slipBtn = e.target.closest('.prop-slip-btn');
    if(slipBtn){
      const prop = state.propRegistry[slipBtn.dataset.propId];
      if(!prop) return;
      addLegToSlip({
        id: Date.now()+Math.random(),
        matchup: prop.matchup,
        side: prop.side,
        rows: prop.rows
      });
      showToast('Added ✓');
      slipBtn.textContent = 'Added ✓';
      setTimeout(()=>{ slipBtn.textContent = '+ Slip'; }, 1200);
      return;
    }
    const head = e.target.closest('.prop-game-head');
    if(head){
      const id = head.dataset.gameId;
      state.propsCollapsed[id] = !state.propsCollapsed[id];
      renderPage();
    }
  });

  document.getElementById('bookFilterChips').addEventListener('click', (e)=>{
    const chip = e.target.closest('.props-filter-chip');
    if(!chip) return;
    state.propsBookFilter = chip.dataset.book;
    renderPage();
  });

  loadGames();
})();
```

`buildPropsHtml` modifications relative to the app.js original (everything else verbatim):
1. Signature: `function buildPropsHtml(game, data, markets)` — the `showGameCol` parameter is REMOVED. Delete the `showGameCol &&`-guarded pieces: the Game `<th>`, the Game `<td>`, and the `matchup.toLowerCase().includes(term)` clause becomes part of the standard filter. Concretely, the filter line becomes:
```js
      if(term){
        rowKeys = rowKeys.filter(rk => perPlayer[rk].player.toLowerCase().includes(term) || matchup.toLowerCase().includes(term));
      }
```
2. The book filter is ALWAYS applied (it was previously gated on `showGameCol`):
```js
    let bms = (data.bookmakers || []).filter(b => TRACKED_KEYS.includes(b.key.toLowerCase()));
    let bookmakersToUse = bms.length ? bms : (data.bookmakers || []);
    if(state.propsBookFilter !== 'all'){
      bookmakersToUse = bookmakersToUse.filter(b => b.key.toLowerCase() === state.propsBookFilter);
    }
```
3. The no-props message becomes: `'No player props posted for this game yet — check back closer to game time.'` in all cases (drop the search-specific variant).
4. Everything else — perPlayer grouping, market label header with collapse arrow and `sectionKey`, line-shop chips, `propRegistry` registration, 20-row cap — verbatim.

- [ ] **Step 3: Verify**

Run: `node --check public/props.js` → exit 0.
Run: `grep -nE 'showGameCol|renderPropsView|game-jump-chip|sportSelect' public/props.js` → no output.
Cross-check ids with the same node one-liner as Task 2 (substituting props.js/props.html).
`curl -s http://localhost:3000/props.html | grep -c 'props.js'` → 1.

- [ ] **Step 4: Commit**

```bash
git add public/props.html public/props.js && ! git diff --cached | grep -q 4256ff9b && git commit -m "feat: standalone Props page"
```

---

### Task 4: Slip page

**Files:**
- Create: `public/slip.html`, `public/slip.js`

**Interfaces:**
- Consumes from common.js: `renderNav('slip')`, `getSlip`, `removeLegFromSlip`, `updateSlipBadge`, `linkedBadge`, `bookStyleFor`, `americanToDecimal`, `decimalToAmerican`, `fmtAmerican`, `escapeHtml`, `BOOK_LINKS`, `fetchOddsFor`, `getSport`, `updateTicker`

- [ ] **Step 1: Create public/slip.html**

Same skeleton (title `LineWatch — Bet Slip`; NO `autoBtn` — the `header-controls` div stays but empty), 3-column layout:

```html
<div class="layout">
  <nav class="nav-rail" id="navRail"></nav>

  <main>
    <div class="hero-line">Bet Slip</div>
    <div class="hero-sub">Legs you've added from the Board and Props pages — parlay priced per book.</div>
    <div class="panel" id="slipPanel">
      <h2>Bet Slip <span class="count" id="slipCount">0 legs</span></h2>
      <div id="slipLegs"></div>
      <div id="slipEmpty" style="color:var(--text-faint); font-size:12.5px;">Add selections from the <a href="/board.html">odds board</a> or <a href="/props.html">props page</a> to build a parlay.</div>
      <div id="parlayArea"></div>
    </div>
  </main>

  <aside class="sidebar">
    <div class="panel" id="shotsPanel">
      <h2>Reference Links</h2>
      <div class="link-add-row">
        <input type="text" id="linkInput" placeholder="Paste a link to a game/odds page">
        <button id="linkAddBtn">Add</button>
      </div>
      <div id="manualEntries"></div>
    </div>
  </aside>
</div>
```

Scripts at body end: `common.js` then `slip.js`. Footer identical to board.html.

- [ ] **Step 2: Create public/slip.js**

```js
(function(){
  const state = { manual: [] };

  renderNav('slip');

  // renderSlip / renderParlay / buildCopyText: MOVED from app.js — modifications below
  function renderSlip(){ /* moved body */ }
  function renderParlay(){ /* moved body */ }
  function buildCopyText(bookKey, bookName){ /* moved body */ }

  document.getElementById('linkAddBtn').addEventListener('click', ()=>{
    const input = document.getElementById('linkInput');
    const val = input.value.trim();
    if(!val) return;
    addManualEntry({tagline:'Reference link', text: val, isLink:true});
    input.value = '';
  });
  function addManualEntry(entry){
    state.manual.push(entry);
    renderManual();
  }
  // renderManual: MOVED from app.js verbatim

  renderSlip();

  // fill the ticker quietly (server cache makes this cheap); ignore failures
  fetchOddsFor(getSport()).then(r=>updateTicker(r.games)).catch(()=>{});
})();
```

Modifications to the moved functions (everything else verbatim):
1. `renderSlip`: replace every `state.slip` read with a local `const slip = getSlip();` at the top and use `slip` throughout (`slip.length`, `slip.forEach`). The remove handler becomes:
```js
      div.querySelector('.remove-btn').addEventListener('click', ()=>{
        removeLegFromSlip(leg.id);
        renderSlip();
      });
```
2. `renderParlay`: same substitution — `const slip = getSlip();` at top; all `state.slip` → `slip`.
3. `buildCopyText`: same substitution — `const slip = getSlip();`; `state.slip.forEach` → `slip.forEach`. (Keep the `escapeHtml` calls added by commit 71f3d9c.)
4. `renderManual`: verbatim (it reads `state.manual`, which exists locally).

- [ ] **Step 3: Verify**

`node --check public/slip.js` → exit 0.
`grep -n 'state.slip' public/slip.js` → no output.
`grep -c 'escapeHtml(leg.side)' public/slip.js` → 2 (one in renderSlip's leg-title path via template, one in buildCopyText) — if renderSlip uses `escapeHtml(leg.side)` once and buildCopyText once, expect 2.
Cross-check ids (same one-liner, slip.js/slip.html).
`curl -s http://localhost:3000/slip.html | grep -c 'slip.js'` → 1.

- [ ] **Step 4: Commit**

```bash
git add public/slip.html public/slip.js && ! git diff --cached | grep -q 4256ff9b && git commit -m "feat: standalone Slip page"
```

---

### Task 5: Home page, delete app.js, final verification

**Files:**
- Rewrite: `public/index.html` (becomes the Home page)
- Create: `public/home.js`
- Delete: `public/app.js`

**Interfaces:**
- Consumes from common.js: `renderNav('home')`, `renderSportChips`, `getSport`, `fetchOddsFor`, `setStatus`, `showError`, `clearError`, `updateTicker`, `computeFairDecimal`, `americanToDecimal`, `fmtAmerican`, `escapeHtml`, `bookStyleFor`, `TRACKED_KEYS`

- [ ] **Step 1: Rewrite public/index.html**

Same head (title `LineWatch`) and header as slip.html (no autoBtn), footer identical, 3-column layout:

```html
<div class="layout">
  <nav class="nav-rail" id="navRail"></nav>

  <main>
    <div class="hero-line">Find your next line</div>
    <div class="hero-sub">Compare odds across books, spot value, and build your slip.</div>
    <div class="chip-row" id="sportChips"></div>
    <div class="status-row">
      <div class="dot" id="statusDot"></div>
      <span id="statusText">Loading value spots…</span>
    </div>
    <div id="errorArea"></div>

    <div class="cta-row">
      <a class="cta-card" href="/board.html">
        <h3>Odds Board</h3>
        <p>Moneylines across every tracked book, ranked best → worst per side, best price and value plays flagged.</p>
        <span class="go">Open Board →</span>
      </a>
      <a class="cta-card" href="/props.html">
        <h3>Player Props</h3>
        <p>Per-game player prop lines with line-shop chips per book. Loaded on demand to protect API quota.</p>
        <span class="go">Open Props →</span>
      </a>
    </div>

    <div class="panel" id="cheatPanel">
      <h2>Cheatsheet <span class="count" id="cheatCount"></span></h2>
      <div id="cheatBody" style="color:var(--text-faint); font-size:12.5px;">Loading the best value spots…</div>
    </div>
  </main>

  <aside class="sidebar">
    <div class="panel" id="aboutPanel">
      <h2>About</h2>
      <div class="settings-hint">
        Books tracked: FanDuel, DraftKings, BetMGM, Caesars, ESPN BET, Bet365, Fanatics, BetRivers — whichever The Odds API returns for the selected sport. Availability varies by sport and market; not every book covers every game.
      </div>
      <div class="settings-hint" style="margin-top:10px;">
        Odds are cached for up to 10 minutes to conserve API quota — always confirm the live price on the sportsbook before betting.
      </div>
      <div class="settings-hint" style="margin-top:10px;">
        <strong style="color:var(--text-dim);">Player props</strong> load per game (they're expensive on quota) — use the Props page.
      </div>
    </div>
  </aside>
</div>
```

Scripts: `common.js` then `home.js`.

- [ ] **Step 2: Create public/home.js**

```js
(function(){
  renderNav('home');
  renderSportChips(document.getElementById('sportChips'), load);

  async function load(){
    clearError();
    setStatus(false, 'Loading value spots…');
    try{
      const {games, remaining, cacheAge} = await fetchOddsFor(getSport());
      renderCheatsheet(games);
      updateTicker(games);
      const freshness = cacheAge >= 60 ? `cached ${Math.round(cacheAge/60)} min ago` : `updated ${new Date().toLocaleTimeString()}`;
      setStatus(true, `Live — ${games.length} games scanned${remaining ? ' · '+remaining+' requests left this month' : ''} · ${freshness}`);
    }catch(e){
      setStatus(false, 'Fetch failed.');
      showError(e.message || 'Could not fetch odds — try again shortly.');
      document.getElementById('cheatBody').textContent = 'Value spots unavailable right now.';
    }
  }

  // renderCheatsheet: MOVED from app.js — modification: takes games as a parameter;
  // replace `state.games.forEach` with `games.forEach` and the
  // `state.games.length ? ... : ...` empty-message ternary with `games.length ? ... : ...`.
  function renderCheatsheet(games){ /* moved body */ }

  load();
})();
```

- [ ] **Step 3: Delete app.js and run full verification**

```bash
rm public/app.js
```

Checks:
1. `grep -rn 'app.js' public/` → no output.
2. For each of the 4 HTML files: the id cross-check one-liner from Task 2 (page script vs its page HTML) → all ok.
3. `grep -rn 'sportSelect\|navBoard\|navProps\|navSlip\|navShots\|navSettings\|settingsPanel' public/*.js` → no output (old SPA ids gone).
4. `npm test` → 11/11 pass (server untouched).
5. Live smoke (server running): `for p in "" board.html props.html slip.html; do curl -s -o /dev/null -w "/$p -> %{http_code}\n" http://localhost:3000/$p; done` → four 200s.
6. Browser walkthrough (controller/user): Home loads cheatsheet; sport chip on Home persists to Board; Board add leg → badge + toast; Props load props + add prop leg; Slip shows both legs, parlay per book, remove updates badge; back button navigates pages.

- [ ] **Step 4: Commit**

```bash
git add -A public/ && ! git diff --cached | grep -q 4256ff9b && git commit -m "feat: Home page, remove single-page app.js"
```

---

## Post-plan verification (from spec)

1. `npm test` — 11/11.
2. Full browser walkthrough (Task 5 Step 3 check 6).
3. Merge decision via superpowers:finishing-a-development-branch (branch `multipage-split`, stacked on `repo-cleanup`).
