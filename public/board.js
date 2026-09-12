(function(){
  const state = {
    games: [], searchTerm: '', autoRefresh: false, autoTimer: null,
    propsCache: {},    // gameId -> {game, data}
    propRegistry: {},  // propId -> {side, matchup, rows}
    propIdCounter: 0,
    propsBookFilter: 'all',
    marketCollapsed: {},
    propsOpen: {},        // gameId -> bool, survives re-renders (audit 6.1)
    propsUnavailable: {}, // gameId -> cached "no props" / error message html
    scores: [], mlbLive: [], scoresTimer: null,
    hrCache: {},   // gameId -> hr-matchups API response
    statcast: undefined, // batters map from /statcast/statcast.json, or null if unavailable
    oddsView: {},  // gameId -> 'full' | 'f5', survives re-renders like propsOpen
    pitchers: {},  // gameId -> {matched, home:{id,name}|null, away:{id,name}|null}
    altPropsCache: {},   // "gameId|marketKey" -> raw {market}_alternate response body, once loaded
    altPropsLoading: {}, // "gameId|marketKey" -> bool, while that fetch is in flight
    altPropsView: {}     // "gameId|marketKey" -> 'standard' | 'alt' (default standard)
  };
  let renderScheduled = false;
  // Coalesces multiple renderGames() requests (weather/pitchers post-fetches, audit 6.2)
  // into a single call per animation frame, instead of re-rendering the whole board twice more.
  function scheduleRender(){
    if(renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(()=>{ renderScheduled = false; if(state.games.length) renderGames(); });
  }

  // Nav deep-links (e.g. the NBA/NFL group's "Board" item) land here as
  // /board.html?sport=basketball_nba — honor it before anything else reads
  // the persisted sport, so both the chip and the nav's active-group
  // highlight are correct on first paint, not just after a manual click.
  (function applySportFromUrl(){
    const requested = new URLSearchParams(location.search).get('sport');
    if(requested && SPORTS.some(([k])=>k===requested)) setSport(requested);
  })();

  renderNav('board');
  renderSportChips(document.getElementById('sportChips'), ()=>{
    state.propsCache = {}; state.propRegistry = {}; state.marketCollapsed = {};
    state.propsBookFilter = 'all'; state.propsOpen = {}; state.propsUnavailable = {};
    state.altPropsCache = {}; state.altPropsLoading = {}; state.altPropsView = {};
    refresh();
  });
  renderMyBooksList();

  // ---------- Value Finder (moved here from Cheatsheet — reuses the games
  // this page already fetched, so it doesn't cost a second odds request) ----------
  const EDGE_THRESHOLD = 0.02; // 2% — below this it's just book-to-book noise, not a real edge
  const fmtPct = p => (p*100).toFixed(1) + '%';

  // Scans one game's markets for outcomes whose best price beats the
  // multi-book consensus fair line by at least EDGE_THRESHOLD. Reuses the
  // exact devig math (computeFairDecimal) the Game Lines grid's single
  // "Value" tag already relies on — this just runs it across every outcome
  // and ranks the results instead of leaving it buried per-row.
  function scanGame(game, sportKey){
    const pool = poolFor(game.bookmakers);
    const candidates = [];

    function consider(sideRows, oppRows, label, marketLabel){
      if(!sideRows.length || !oppRows.length) return;
      const fair = computeFairDecimal(sideRows, oppRows);
      if(!fair) return;
      const best = sideRows[0];
      const edge = americanToDecimal(best.odds) / fair - 1;
      if(edge < EDGE_THRESHOLD) return;
      candidates.push({ matchup: `${game.away_team} @ ${game.home_team}`, side: label, marketLabel, edge, rows: sideRows, best });
    }

    const ml = { away: rowsFor(pool, 'h2h', game.away_team), home: rowsFor(pool, 'h2h', game.home_team) };
    consider(ml.away, ml.home, `${game.away_team} to win`, 'Moneyline');
    consider(ml.home, ml.away, `${game.home_team} to win`, 'Moneyline');

    // Spreads/totals are only fetched for MLB and NFL (see server.js's
    // gridSports) — same two sports the Game Lines grid shows them for.
    if(sportKey === 'baseball_mlb' || sportKey === 'americanfootball_nfl'){
      const spread = { away: modalPointRows(pool, 'spreads', game.away_team), home: modalPointRows(pool, 'spreads', game.home_team) };
      if(spread.away.length && spread.home.length && spread.away[0].point != null){
        const p = spread.away[0].point;
        consider(spread.away, spread.home, `${game.away_team} ${p>0?'+':''}${p}`, 'Spread');
        const hp = spread.home[0].point;
        consider(spread.home, spread.away, `${game.home_team} ${hp>0?'+':''}${hp}`, 'Spread');
      }
      const total = { over: modalPointRows(pool, 'totals', 'Over'), under: modalPointRows(pool, 'totals', 'Under') };
      if(total.over.length && total.under.length){
        consider(total.over, total.under, `Over ${total.over[0].point}`, 'Total');
        consider(total.under, total.over, `Under ${total.under[0].point}`, 'Total');
      }
    }
    return candidates;
  }

  function valueCard(c){
    return `<div class="value-row">
      <div class="value-row-main">
        <div class="value-row-side">${escapeHtml(c.side)}</div>
        <div class="value-row-sub">${escapeHtml(c.matchup)} · ${escapeHtml(c.marketLabel)}</div>
      </div>
      <div class="value-row-edge">
        <span class="value-edge-pct">+${fmtPct(c.edge)}</span>
        <span class="value-edge-label">vs consensus</span>
      </div>
      <div class="value-row-book">
        ${linkedBadge(c.best.bookKey, c.best.bookTitle)}
        <span class="odds">${fmtAmerican(c.best.odds)}</span>
      </div>
      <button class="add-leg-btn value-add-btn">+ Slip</button>
    </div>`;
  }

  // Synchronous — runs over state.games, which refresh() already fetched, so
  // picking a sport costs exactly one odds request, same as before this
  // lived on its own page.
  function renderValueFinder(){
    const area = document.getElementById('valueArea');
    if(!area) return;
    if(!state.games.length){ area.innerHTML = ''; return; }
    const sportKey = getSport();
    const candidates = state.games.flatMap(g => scanGame(g, sportKey)).sort((a,b)=>b.edge-a.edge).slice(0, 25);
    if(!candidates.length){
      area.innerHTML = `<div class="panel"><h2>Value Finder</h2><div class="hr-note">Nothing beats the market consensus by ${fmtPct(EDGE_THRESHOLD)}+ right now — books are in close agreement. Check back closer to game time.</div></div>`;
      return;
    }
    area.innerHTML = `<div class="panel">
      <h2>Value Finder</h2>
      <div class="hr-note" style="margin-bottom:10px;">Best price on each outcome vs. the de-vigged consensus of every book scanned — not a pick, just where the market disagrees with itself. Top ${candidates.length}, best edge first.</div>
      ${candidates.map(valueCard).join('')}
    </div>`;
    area.querySelectorAll('.value-row').forEach((row, i)=>{
      row.querySelector('.value-add-btn').addEventListener('click', ()=>{
        const c = candidates[i];
        addLegToSlip({ id: Date.now()+Math.random(), matchup: c.matchup, side: c.side, rows: c.rows });
        showToast('Added ✓');
        flashEl(row);
      });
    });
    staggerIn(area.querySelector('.panel'), 20);
  }

  // Pages that used to live in a per-sport nav flyout (now flattened to one
  // link per sport) but aren't part of this merged page — kept reachable via
  // a quiet in-context row instead of nav clutter.
  const RELATED_PAGES = {
    baseball_mlb: [['/getprops.html','🎯','Get Props'], ['/record.html','📈','Record']],
    basketball_nba: [['/nba.html','📈','NBA Dashboard']],
    americanfootball_nfl: [['/nfl.html','📈','NFL Dashboard']]
  };
  function renderRelatedLinks(){
    const el = document.getElementById('relatedLinks');
    if(!el) return;
    const pages = RELATED_PAGES[getSport()];
    el.innerHTML = pages
      ? 'Also see: ' + pages.map(([href,icon,label])=>`<a href="${href}">${icon} ${escapeHtml(label)}</a>`).join(' · ')
      : '';
  }

  async function refresh(){
    clearError();
    const btn = document.getElementById('fetchBtn');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
    setStatus(false, 'Fetching latest odds…');
    renderSkeletonCards(document.getElementById('gamesArea'), 3);
    try{
      const {games, remaining, cacheAge} = await fetchOddsFor(getSport());
      state.games = games;
      renderGames();
      renderValueFinder();
      renderRelatedLinks();
      updateTicker(games);
      setStatus(true, oddsStatusText(games.length, remaining, cacheAge));

      const sport = getSport();
      // MLB: pull hourly stadium forecasts (free Open-Meteo, no key), re-render with weather strips
      if(sport === 'baseball_mlb' && games.length){
        fetchStadiumWeather(games).then(scheduleRender).catch(()=>{});
        fetchStartingPitchers(games).then(scheduleRender).catch(()=>{});
        fetchTopHitters(games).then(scheduleRender).catch(()=>{});
      }
      // NFL: same free Open-Meteo forecast pull, no top-performers box yet —
      // season stat leaders aren't available cheaply pregame (see note where
      // this was scoped) and the season hasn't started as of this feature
      // landing, so there's nothing real to show there yet anyway.
      if(sport === 'americanfootball_nfl' && games.length){
        fetchNflStadiumWeather(games).then(scheduleRender).catch(()=>{});
      }
      // Live scores: fetch now, then keep polling every 30s while this sport is loaded
      state.scores = []; state.mlbLive = [];
      clearInterval(state.scoresTimer);
      if(games.length){
        refreshScores();
        state.scoresTimer = setInterval(refreshScores, 30*1000);
      }
    }catch(e){
      setStatus(false, 'Fetch failed.');
      const message = e.message || 'Could not fetch odds — try again shortly.';
      showError(message);
      state.games = [];
      document.getElementById('valueArea').innerHTML = '';
      document.getElementById('gamesArea').innerHTML = '<div class="empty-state"><h3>Couldn\'t load games</h3><p>' + escapeHtml(message) + '</p><button class="primary" id="retryBtn">Retry</button></div>';
      const retryBtn = document.getElementById('retryBtn');
      if(retryBtn) retryBtn.addEventListener('click', refresh);
    }finally{
      btn.disabled = false; btn.textContent = 'Get Odds';
    }
  }
  document.getElementById('fetchBtn').addEventListener('click', refresh);

  // Patches the live-score slot inside each already-rendered game card in place —
  // does NOT call renderGames(), so it never collapses open props or replays the
  // card entrance animation (audit 6.1b). Falls back to one full render only if
  // a card is missing (e.g. the game list itself changed underneath the poll).
  function patchScores(){
    const sportKey = getSport();
    let missingCard = false;
    state.games.forEach(game=>{
      const card = document.querySelector('[data-game-id="' + CSS.escape(String(game.id)) + '"]');
      if(!card){ missingCard = true; return; }
      const slot = card.querySelector('.live-score-slot');
      if(!slot) return;
      const scoreEntry = findScoreFor(state.scores, game);
      const liveDetail = sportKey === 'baseball_mlb' ? findMlbLiveFor(state.mlbLive, game) : null;
      slot.innerHTML = buildScoreBadgeHtml(game, scoreEntry, liveDetail);
    });
    if(missingCard) renderGames();
  }

  async function refreshScores(){
    const sport = getSport();
    try{
      const completedBefore = new Set(
        state.games.filter(g => (findScoreFor(state.scores, g) || {}).completed).map(g => g.id)
      );
      state.scores = await fetchScoresFor(sport);
      if(sport === 'baseball_mlb'){
        state.mlbLive = await fetchMlbLive().catch(()=>[]);
      }
      if(state.games.length){
        // A game just finishing means renderGames() needs to drop its card —
        // patchScores() only updates the score badge in place, it can't remove
        // a card. Everything else (nothing newly completed) stays on the cheap
        // in-place patch so open props/scroll position survive the 30s poll.
        const justFinished = state.games.some(g =>
          !completedBefore.has(g.id) && (findScoreFor(state.scores, g) || {}).completed
        );
        if(justFinished) renderGames();
        else patchScores();
      }
    }catch(e){
      // scores are a bonus overlay — quietly skip on failure, odds board still works
    }
  }

  // ---------- My books panel ----------
  document.getElementById('myBooksToggle').addEventListener('click', ()=>{
    const panel = document.getElementById('myBooksPanel');
    if(panel.classList.contains('is-open')) revealHide(panel);
    else revealShow(panel);
  });
  function renderMyBooksList(){
    const host = document.getElementById('myBooksList');
    const mine = getMyBooks();
    host.innerHTML = '';
    SELECTABLE_BOOKS.forEach(k=>{
      const style = bookStyleFor(k);
      const row = document.createElement('label');
      row.innerHTML = `<input type="checkbox" value="${k}" ${mine.includes(k)?'checked':''}> ${escapeHtml(style.name)}`;
      row.querySelector('input').addEventListener('change', ()=>{
        const checked = [...host.querySelectorAll('input:checked')].map(i=>i.value);
        setMyBooks(checked);
        if(state.games.length){ renderGames(); renderValueFinder(); }
      });
      host.appendChild(row);
    });
  }

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

  // ---------- player props (opt-in per game) ----------
  function renderBookFilter(){
    const el = document.getElementById('bookFilterChips');
    const label = document.getElementById('bookFilterLabel');
    const cached = Object.values(state.propsCache);
    if(!cached.length){ el.innerHTML = ''; if(label) label.style.display = 'none'; return; }
    if(label) label.style.display = '';
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
  document.getElementById('bookFilterChips').addEventListener('click', (e)=>{
    const chip = e.target.closest('.props-filter-chip');
    if(!chip) return;
    state.propsBookFilter = chip.dataset.book;
    renderBookFilter();
    // repaint every already-loaded game's props in place, no refetch
    document.querySelectorAll('.props-host[data-loaded="1"]').forEach(host=>{
      const gameId = host.dataset.gameId;
      const cached = state.propsCache[gameId];
      if(cached) host.innerHTML = buildPropsHtml(cached.game, cached.data, PROP_MARKETS[getSport()] || []);
    });
  });

  async function loadProps(game, sportKey, hostEl){
    try{
      const res = await fetch(`/api/props/${sportKey}/${game.id}`);
      if(!res.ok){
        const msg = `<div class="props-block"><span style="color:var(--text-faint); font-size:12.5px;">Props aren't available for this game right now (either not offered yet, or the server couldn't reach the odds provider).</span></div>`;
        state.propsUnavailable[game.id] = msg;
        hostEl.innerHTML = msg;
        return;
      }
      const data = await res.json();
      delete state.propsUnavailable[game.id];
      state.propsCache[game.id] = {game, data};
      hostEl.innerHTML = buildPropsHtml(game, data, PROP_MARKETS[sportKey]);
      renderBookFilter();
    }catch(e){
      const msg = `<div class="props-block"><span style="color:var(--text-faint); font-size:12.5px;">Couldn't load props right now.</span></div>`;
      state.propsUnavailable[game.id] = msg;
      hostEl.innerHTML = msg;
    }
  }

  // Alt Lines shows a condensed ladder of round thresholds (150+, 175+,
  // 200+...) instead of every raw line the books happen to quote (which can
  // be as fine as every 5-10 yards) — matches how sportsbook apps present
  // alt lines themselves. Step size adapts to the player's actual range so
  // a big-number market like passing yards lands on ~25s while a small-range
  // market like hits lands on ~1s, without hardcoding either.
  const NICE_STEPS = [1, 2, 5, 10, 25, 50, 100];
  function niceStep(range, targetCount){
    if(range <= 0) return NICE_STEPS[0];
    const raw = range / targetCount;
    return NICE_STEPS.find(s => s >= raw) || NICE_STEPS[NICE_STEPS.length-1];
  }
  // pointRows: [{point, best, rows}] sorted ascending by point (already
  // deduped to one entry per line). Picks the real line closest to each
  // round checkpoint instead of inventing one that isn't actually offered.
  function condenseAltPoints(pointRows, targetCount){
    if(pointRows.length <= targetCount) return pointRows;
    const min = pointRows[0].point, max = pointRows[pointRows.length-1].point;
    const step = niceStep(max - min, targetCount);
    const picked = [];
    const used = new Set();
    for(let target = Math.ceil(min/step)*step; target <= max + step/2; target += step){
      let best = null, bestDiff = Infinity;
      pointRows.forEach(pr=>{
        if(used.has(pr.point)) return;
        const diff = Math.abs(pr.point - target);
        if(diff < bestDiff){ bestDiff = diff; best = pr; }
      });
      if(best && bestDiff <= step * 0.6){ picked.push(best); used.add(best.point); }
    }
    return picked.length ? picked : pointRows.slice(0, targetCount);
  }

  function filterBookmakers(bookmakers){
    const tracked = (bookmakers || []).filter(b => TRACKED_KEYS.includes(b.key.toLowerCase()));
    let out = tracked.length ? tracked : (bookmakers || []);
    if(state.propsBookFilter !== 'all'){
      out = out.filter(b => b.key.toLowerCase() === state.propsBookFilter);
    }
    return out;
  }

  function buildPropsHtml(game, data, markets){
    const bookmakersToUse = filterBookmakers(data.bookmakers);

    // First pass: which markets actually have rows for this game (with the
    // current book filter applied) — needed up front to build the quick
    // category-filter chips before the sections themselves.
    // Each market section can independently be toggled to its "Alt Lines"
    // tab (every line the books quote, not just the one standard line) —
    // once that data's been fetched for this game it's cached, so flipping
    // the tab back and forth afterward is instant/free.
    const marketData = markets.map(marketKey=>{
      const sectionKey = game.id+'|'+marketKey;
      const altBody = state.altPropsCache[sectionKey];
      const useAlt = state.altPropsView[sectionKey] === 'alt' && !!altBody;
      const effectiveKey = useAlt ? marketKey+'_alternate' : marketKey;
      const sourceBookmakers = useAlt ? filterBookmakers(altBody.bookmakers) : bookmakersToUse;
      const perPlayer = {}; // "playerName|side|point" -> {player, side, point, rows}
      sourceBookmakers.forEach(bm=>{
        const market = bm.markets.find(m=>m.key===effectiveKey);
        if(!market) return;
        market.outcomes.forEach(o=>{
          const playerName = o.description || o.name;
          const rowKey = playerName + '|' + o.name + '|' + (o.point ?? '');
          if(!perPlayer[rowKey]) perPlayer[rowKey] = {player:playerName, side:o.name, point:o.point, rows:[]};
          perPlayer[rowKey].rows.push({bookKey:bm.key, bookTitle:bm.title, odds:o.price, link:o.link||bm.link||null, sid:o.sid||null, marketSid:market.sid||null});
        });
      });
      return {
        marketKey, perPlayer, rowKeys: Object.keys(perPlayer),
        useAlt, altLoaded: !!altBody, altLoading: !!state.altPropsLoading[sectionKey]
      };
    }).filter(m => m.rowKeys.length || m.altLoading);

    let html = '<div class="props-block">';

    // Quick category filter: every prop market shows collapsed by default (a
    // game can have 5-6 of these — all expanded at once is exactly what was
    // jumbled) — tap a chip to jump straight to just that category, or "All"
    // to go back to browsing them yourself. Same chips row style/behavior
    // works for every sport since it's just built off whatever markets this
    // game actually has data for.
    if(marketData.length > 1){
      const noneForcedOpen = marketData.every(m => state.marketCollapsed[game.id+'|'+m.marketKey] !== false);
      html += `<div class="chip-row props-market-filter" data-game-id="${escapeHtml(String(game.id))}" style="margin:0 0 10px;">
        <span class="chip prop-filter-chip${noneForcedOpen?' active':''}" data-filter="all">All</span>
        ${marketData.map(m=>{
          const active = state.marketCollapsed[game.id+'|'+m.marketKey] === false;
          return `<span class="chip prop-filter-chip${active?' active':''}" data-filter="${escapeHtml(m.marketKey)}">${escapeHtml(marketLabel(m.marketKey))}</span>`;
        }).join('')}
      </div>`;
    }

    marketData.forEach(({marketKey, perPlayer, rowKeys, useAlt, altLoaded, altLoading})=>{
      const sectionKey = game.id + '|' + marketKey;
      // Collapsed by default — only stays open once the user (or a filter
      // chip) has explicitly opened it.
      const collapsed = state.marketCollapsed[sectionKey] !== false;
      html += `<div class="props-market-label prop-market-head" data-section-key="${escapeHtml(sectionKey)}" tabindex="0" role="button" aria-expanded="${!collapsed}" title="Click to ${collapsed?'expand':'collapse'}">
        <span class="market-arrow">${collapsed?'▸':'▾'}</span>${escapeHtml(marketLabel(marketKey))}
        <span class="market-count">(${rowKeys.length})</span>
      </div>`;
      html += `<div class="market-body" style="${collapsed?'display:none;':''}">`;
      // Alt Lines sub-tab: every line the books quote for this stat, not
      // just the one standard line — a real sub-tab within the category,
      // same as Board's Full game/First 5 innings tabs. Anytime-scorer
      // markets skip this entirely since there's only ever one line.
      if(!NO_ALT_MARKETS.has(marketKey)){
        html += `<div class="line-view-tabs" data-game-id="${escapeHtml(String(game.id))}" data-market-key="${escapeHtml(marketKey)}">
          <button type="button" class="line-view-tab${!useAlt?' active':''}" data-view="standard">Standard</button>
          <button type="button" class="line-view-tab${useAlt?' active':''}" data-view="alt">${altLoading ? '<span class="spinner"></span> Alt Lines' : 'Alt Lines'}</button>
        </div>`;
      }
      html += `<div class="table-scroll">`;
      // One row per player, always — never the player's name repeated once
      // per line/side. Standard shows a pill per side at the book's one
      // line (Over/Under, or just "Yes" for anytime-scorer markets). Alt
      // Lines shows a condensed ladder of Over thresholds (150+, 175+,
      // 200+...) instead of every raw line the books happen to quote. No
      // per-book chip list either way — book comparison for whatever
      // ends up in the slip lives on the Slip/Cheatsheet pages instead.
      const byPlayer = {};
      if(useAlt){
        rowKeys.forEach(rk=>{
          const entry = perPlayer[rk];
          if(entry.side !== 'Over') return;
          const best = entry.rows.slice().sort((a,b)=>americanToDecimal(b.odds)-americanToDecimal(a.odds))[0];
          (byPlayer[entry.player] = byPlayer[entry.player] || []).push({ side: entry.side, point: entry.point, best, rows: entry.rows });
        });
      } else {
        // Standard is exactly one pill per side (Over/Under, or "Yes") —
        // even when books quote slightly different points for that side,
        // pick whichever point the most tracked books share (same "modal
        // point" convention the Game Lines grid already uses for
        // spreads/totals), then the best price within it.
        const bySidePoint = {}; // "player|side" -> [{point, rows}]
        rowKeys.forEach(rk=>{
          const entry = perPlayer[rk];
          const key = entry.player + '|' + entry.side;
          (bySidePoint[key] = bySidePoint[key] || []).push({ point: entry.point, rows: entry.rows });
        });
        Object.keys(bySidePoint).forEach(key=>{
          const sep = key.lastIndexOf('|');
          const player = key.slice(0, sep), side = key.slice(sep+1);
          const modal = bySidePoint[key].slice().sort((a,b)=>b.rows.length-a.rows.length)[0];
          const best = modal.rows.slice().sort((a,b)=>americanToDecimal(b.odds)-americanToDecimal(a.odds))[0];
          (byPlayer[player] = byPlayer[player] || []).push({ side, point: modal.point, best, rows: modal.rows });
        });
      }
      const players = Object.keys(byPlayer).sort((a,b)=>a.localeCompare(b)).slice(0, 20);
      html += `<table class="props-table alt-lines-table"><tbody>`;
      players.forEach(playerName=>{
        let pointRows = byPlayer[playerName];
        pointRows = useAlt
          ? condenseAltPoints(pointRows.sort((a,b)=>a.point-b.point), 12)
          : pointRows.sort((a,b)=> a.side === b.side ? 0 : a.side === 'Over' ? -1 : b.side === 'Over' ? 1 : a.side.localeCompare(b.side));
        const headshotUrl = data.headshots && data.headshots[playerName.toLowerCase()];
        const avatar = headshotUrl ? avatarUrlHtml(headshotUrl, 20) : emptyAvatarHtml(20);
        const pills = pointRows.map(pr=>{
          const hasPoint = pr.point !== undefined && pr.point !== null;
          const sideLabel = useAlt ? 'Over' : pr.side;
          const pillLabel = useAlt ? `${Math.ceil(pr.point)}+` : (hasPoint ? `${pr.side === 'Over' ? 'O' : pr.side === 'Under' ? 'U' : pr.side} ${pr.point}` : pr.side);
          const propId = 'p' + (++state.propIdCounter);
          state.propRegistry[propId] = {
            side: `${playerName} ${sideLabel}${hasPoint ? ' '+pr.point : ''} ${marketLabel(marketKey)}`,
            matchup: `${game.away_team} @ ${game.home_team}`, rows: pr.rows
          };
          return `<button type="button" class="alt-line-pill prop-slip-btn" data-prop-id="${propId}" title="Best price across your tracked books">
            <span class="alt-line-point">${escapeHtml(pillLabel)}</span>
            <span class="alt-line-price">${fmtAmerican(pr.best.odds)}</span>
          </button>`;
        }).join('');
        html += `<tr>
          <td style="font-weight:600; white-space:nowrap;">${avatar}${escapeHtml(playerName)}</td>
          <td><div class="alt-line-row">${pills}</div></td>
        </tr>`;
      });
      html += `</tbody></table>`;
      html += `</div></div>`;
    });
    if(!marketData.length){
      if(state.propsBookFilter !== 'all'){
        const filterStyle = bookStyleFor(state.propsBookFilter);
        const filterName = filterStyle ? filterStyle.name : state.propsBookFilter;
        html += `<span style="color:var(--text-faint); font-size:12.5px;">No ${escapeHtml(filterName)} props for this game — clear the book filter to see all.</span>`;
      } else {
        html += `<span style="color:var(--text-faint); font-size:12.5px;">No player props posted for this game yet — check back closer to game time.</span>`;
      }
    }
    html += '</div>';
    return html;
  }

  // ---------- HR matchups (opt-in per game, MLB only) ----------
  async function loadStatcastData(){
    if(state.statcast !== undefined) return state.statcast;
    try{
      const res = await fetch('/statcast/statcast.json');
      state.statcast = res.ok ? (await res.json()).batters || null : null;
    }catch(e){ state.statcast = null; }
    return state.statcast;
  }

  function statCell(val, goodAbove, badBelow, fmt){
    if(val === undefined || val === null || val === '' || isNaN(Number(val))) return '<td>—</td>';
    const n = Number(val);
    const cls = n >= goodAbove ? ' class="stat-g"' : n <= badBelow ? ' class="stat-r"' : '';
    return `<td${cls}>${fmt ? fmt(n) : n}</td>`;
  }

  // Best HR odds per (lowercased) player name, read from already-fetched props — no extra fetch.
  function hrOddsFor(gameId){
    const cached = state.propsCache[gameId];
    const out = {};
    if(!cached) return out;
    (cached.data.bookmakers || []).forEach(bm=>{
      const m = (bm.markets || []).find(mk=>mk.key === 'batter_home_runs');
      if(!m) return;
      (m.outcomes || []).forEach(o=>{
        if(o.name !== 'Over') return;
        const nm = (o.description || '').toLowerCase();
        if(!nm) return;
        if(!out[nm] || americanToDecimal(o.price) > americanToDecimal(out[nm].odds)){
          out[nm] = { odds: o.price, bookKey: bm.key, bookTitle: bm.title };
        }
      });
    });
    return out;
  }

  // MLB's public headshot CDN, keyed by the same personId the stats came from — no key needed.
  function playerAvatarHtml(id, size){
    if(!id) return '';
    const url = `https://img.mlbstatic.com/mlb-photos/image/upload/w_180,q_100/v1/people/${encodeURIComponent(id)}/headshot/67/current.png`;
    return `<img class="player-avatar" src="${url}" width="${size}" height="${size}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`;
  }

  // Placeholder bubble for sports without a wired-up photo source yet (everything but MLB).
  function emptyAvatarHtml(size){
    return `<span class="player-avatar player-avatar-empty" style="width:${size}px; height:${size}px;"></span>`;
  }

  // Same markup as playerAvatarHtml, but for a ready-made URL — used by the
  // props table, where the server already resolved a headshot per sport
  // (MLB/NBA/NFL alike) instead of just an MLB id.
  function avatarUrlHtml(url, size){
    if(!url) return '';
    return `<img class="player-avatar" src="${escapeHtml(url)}" width="${size}" height="${size}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`;
  }

  // Both starting pitchers, one request per game (server-cached per date so
  // every card sharing a slate hits the same cached StatsAPI schedule fetch,
  // not a fresh one). Best-effort — a miss just means the card shows nothing.
  async function fetchStartingPitchers(games){
    await Promise.all(games.map(async game=>{
      if(state.pitchers[game.id]) return;
      const dateStr = new Date(game.commence_time).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      try{
        const res = await fetch(`/api/pitchers/mlb?home=${encodeURIComponent(game.home_team)}&away=${encodeURIComponent(game.away_team)}&date=${dateStr}`);
        if(!res.ok) return;
        state.pitchers[game.id] = await res.json();
      }catch(e){ /* best-effort */ }
    }));
  }

  // Same endpoint the opt-in HR Matchups section below uses — fetching it up
  // front here means that section finds state.hrCache already warm and skips
  // its own fetch (see the hrAlreadyLoaded check further down), so this box
  // doesn't cost a second StatsAPI call per game.
  async function fetchTopHitters(games){
    await Promise.all(games.map(async game=>{
      if(state.hrCache[game.id]) return;
      const dateStr = new Date(game.commence_time).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      try{
        const res = await fetch(`/api/hr-matchups/mlb?home=${encodeURIComponent(game.home_team)}&away=${encodeURIComponent(game.away_team)}&date=${dateStr}`);
        if(!res.ok) return;
        state.hrCache[game.id] = await res.json();
      }catch(e){ /* best-effort */ }
    }));
  }

  // Top 3 home-run threats across both lineups (by season HR count), shown
  // beside the weather slots — empty until lineups post (2-4 hours before
  // first pitch), same as the opt-in HR Matchups section below.
  function buildTopHittersHtml(game){
    const data = state.hrCache[game.id];
    if(!data || !data.matched) return '';
    const withTeam = (batters, team) => (batters || []).map(b=>({...b, team}));
    const pool = [
      ...withTeam(data.away.batters, game.away_team),
      ...withTeam(data.home.batters, game.home_team)
    ].filter(b => b.hr !== null && b.hr !== undefined);
    if(!pool.length) return '';
    const top = pool.sort((a,b)=>b.hr-a.hr).slice(0,3);
    return `<div class="top-hitters-box">
      <div class="top-hitters-title">Top HR threats</div>
      ${top.map(b=>`<div class="hitter-row">
        <div><div class="hitter-name">${escapeHtml(b.name)}</div><div class="hitter-team">${escapeHtml(b.team)}</div></div>
        <div><span class="hitter-stat">${b.hr}</span><span class="hitter-stat-sub">HR</span></div>
      </div>`).join('')}
    </div>`;
  }

  function buildStartingPitchersHtml(game){
    const info = state.pitchers[game.id];
    if(!info || !info.matched) return '';
    const side = (p, team) => `
      <div class="pitcher-card">
        ${p ? playerAvatarHtml(p.id, 36) : emptyAvatarHtml(36)}
        <div>
          <div class="pitcher-name">${p ? escapeHtml(p.name) : 'TBD'}</div>
          <div class="pitcher-team">${escapeHtml(team)}</div>
        </div>
      </div>`;
    return `<div class="pitchers-strip">
      ${side(info.away, game.away_team)}
      <div class="pitcher-vs">vs</div>
      ${side(info.home, game.home_team)}
    </div>`;
  }

  function pitcherTableHtml(pitcher){
    if(!pitcher){
      return `<div class="hr-note">Probable pitcher not announced yet.</div>`;
    }
    const rows = [['season','Season'], ['vl','vs LHB'], ['vr','vs RHB']];
    let html = `<div class="hr-pitcher">${playerAvatarHtml(pitcher.id, 28)}Facing: ${escapeHtml(pitcher.name)} <span class="hand-tag">${escapeHtml(pitcher.hand)}HP</span></div>`;
    html += `<div class="table-scroll"><table class="props-table"><thead><tr><th>Split</th><th>IP</th><th>WHIP</th><th>HR</th><th>HR/9</th></tr></thead><tbody>`;
    rows.forEach(([code, label])=>{
      const st = pitcher.rows[code];
      if(!st) return;
      html += `<tr><td>${label}</td><td>${st.ip !== null ? escapeHtml(String(st.ip)) : '—'}</td><td>${st.whip !== null ? escapeHtml(String(st.whip)) : '—'}</td>`
        + `<td>${st.hr !== null ? st.hr : '—'}</td>`
        + statCell(st.hr9, 1.4, 0.8, n=>n.toFixed(2))
        + `</tr>`;
    });
    html += `</tbody></table></div>`;
    return html;
  }

  function batterTableHtml(teamName, side, hrOdds, statcast){
    if(!side.lineupPosted){
      return `<div class="hr-pitcher" style="margin-top:12px;">${escapeHtml(teamName)} lineup</div>`
        + `<div class="hr-note">Lineups usually post 2-4 hours before first pitch.</div>`;
    }
    const scCols = statcast ? '<th>EV</th><th>Barrel%</th><th>HardHit%</th>' : '';
    let html = `<div class="hr-pitcher" style="margin-top:12px;">${escapeHtml(teamName)} lineup <span class="lineup-tag confirmed">✓ Confirmed</span></div>`;
    html += `<div class="table-scroll"><table class="props-table"><thead><tr><th>Batter</th><th>HR odds</th><th>vs This P</th><th>HR</th><th>BA</th><th>OBP</th><th>SLG</th><th>ISO</th>${scCols}</tr></thead><tbody>`;
    side.batters.forEach(b=>{
      const odds = hrOdds[b.name.toLowerCase()];
      const style = odds ? bookStyleFor(odds.bookKey) : null;
      const link = odds ? BOOK_LINKS[odds.bookKey.toLowerCase()] : null;
      const oddsCell = odds
        ? `<td><span class="odds-chip best">${escapeHtml(style ? style.name : odds.bookTitle)} ${fmtAmerican(odds.odds)}</span>${link ? ` <a class="book-link-btn" href="${link}" target="_blank" rel="noopener">↗</a>` : ''}</td>`
        : '<td>—</td>';
      // Career numbers against today's opposing pitcher; green when he's taken
      // this pitcher deep before. Tiny samples — context, not signal.
      const bvpCell = b.bvp && b.bvp.ab > 0
        ? `<td${b.bvp.hr > 0 ? ' class="stat-g"' : ''} title="${escapeHtml(`${b.bvp.hits}-for-${b.bvp.ab}${b.bvp.avg ? ', ' + b.bvp.avg + ' AVG' : ''}${b.bvp.ops ? ', ' + b.bvp.ops + ' OPS' : ''} career vs this pitcher`)}">${b.bvp.hr} HR/${b.bvp.ab} AB</td>`
        : '<td>—</td>';
      let scCells = '';
      if(statcast){
        const m = statcast[b.name.toLowerCase()];
        scCells = m
          ? statCell(m.ev, 90, 86, n=>n.toFixed(1)) + statCell(m.barrel, 10, 5, n=>n.toFixed(1)+'%') + statCell(m.hardhit, 42, 33, n=>n.toFixed(1)+'%')
          : '<td>—</td><td>—</td><td>—</td>';
      }
      html += `<tr><td style="font-weight:600; white-space:nowrap;">${playerAvatarHtml(b.id, 22)}${escapeHtml(b.name)} <span class="hand-tag">${escapeHtml(b.hand)}</span></td>`
        + oddsCell
        + bvpCell
        + `<td>${b.hr !== null ? b.hr : '—'}</td>`
        + statCell(b.ba, 0.280, 0.230, n=>n.toFixed(3))
        + statCell(b.obp, 0.350, 0.300, n=>n.toFixed(3))
        + statCell(b.slg, 0.480, 0.370, n=>n.toFixed(3))
        + statCell(b.iso, 0.200, 0.130, n=>n.toFixed(3))
        + scCells
        + `</tr>`;
    });
    html += `</tbody></table></div>`;
    return html;
  }

  function buildHrHtml(game, data){
    if(!data.matched){
      return `<div class="hr-block"><span class="hr-note">Couldn't match this game in the MLB schedule.</span></div>`;
    }
    const hrOdds = hrOddsFor(game.id);
    const statcast = state.statcast;
    let html = '<div class="hr-block">';
    // Away lineup faces the home pitcher, and vice versa
    html += pitcherTableHtml(data.home.pitcher);
    html += batterTableHtml(game.away_team, data.away, hrOdds, statcast);
    html += '<div style="height:10px;"></div>';
    html += pitcherTableHtml(data.away.pitcher);
    html += batterTableHtml(game.home_team, data.home, hrOdds, statcast);
    html += `<div class="hr-note">Bands are league-average context, not picks. "vs This P" is career batter-vs-pitcher — samples are tiny, treat as color not signal.</div>`;
    html += '</div>';
    return html;
  }

  async function loadHrMatchups(game, hostEl){
    try{
      // Game day in ET, not a naive UTC slice — a late-evening ET game can
      // already be the next calendar day in UTC, which would miss the schedule.
      const dateStr = new Date(game.commence_time).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const [res] = await Promise.all([
        fetch(`/api/hr-matchups/mlb?home=${encodeURIComponent(game.home_team)}&away=${encodeURIComponent(game.away_team)}&date=${dateStr}`),
        loadStatcastData()
      ]);
      if(!res.ok){
        hostEl.innerHTML = `<div class="hr-block"><span class="hr-note">Couldn't load matchup data right now.</span></div>`;
        return;
      }
      const data = await res.json();
      state.hrCache[game.id] = data;
      hostEl.innerHTML = buildHrHtml(game, data);
    }catch(e){
      hostEl.innerHTML = `<div class="hr-block"><span class="hr-note">Couldn't load matchup data right now.</span></div>`;
    }
  }

  // Delegated clicks for props content that gets repainted without a full renderGames(): market
  // collapse headers and + Slip buttons live inside per-game hosts rebuilt by loadProps/filter.
  function toggleMarketHead(marketHead){
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
    marketHead.setAttribute('aria-expanded', String(!nowCollapsed));
  }

  // Jump straight to one prop category: collapses every other market for
  // this game and opens just the clicked one (or, for "All", back to
  // everything collapsed — the default browsing state). Re-renders that
  // game's props host in place, same as the book-filter chips already do.
  function applyPropFilter(gameId, marketKey){
    if(!state.propsCache[gameId]) return;
    (PROP_MARKETS[getSport()] || []).forEach(mk=>{
      state.marketCollapsed[gameId+'|'+mk] = (marketKey !== 'all' && mk === marketKey) ? false : true;
    });
    rerenderPropsHost(gameId);
  }

  function rerenderPropsHost(gameId){
    const cached = state.propsCache[gameId];
    if(!cached) return;
    const host = document.querySelector(`.props-host[data-game-id="${CSS.escape(String(gameId))}"]`);
    if(host) host.innerHTML = buildPropsHtml(cached.game, cached.data, PROP_MARKETS[getSport()] || []);
  }

  // Opt-in fetch of every line for one market on one game — the credit cost
  // (a second upstream request, same as the standard props call) only
  // happens the first time someone actually flips a category to its Alt
  // Lines tab; flipping back and forth after that is free (already cached).
  async function loadAltLines(gameId, marketKey){
    const key = gameId+'|'+marketKey;
    if(state.altPropsCache[key] || state.altPropsLoading[key]) return;
    state.altPropsLoading[key] = true;
    rerenderPropsHost(gameId);
    try{
      const res = await fetch(`/api/props-alt/${getSport()}/${gameId}/${marketKey}`);
      if(res.ok) state.altPropsCache[key] = await res.json();
    }catch(e){ /* best-effort — tab just stays on Standard so it can be retried */ }
    finally{
      state.altPropsLoading[key] = false;
      rerenderPropsHost(gameId);
    }
  }

  function setLineView(gameId, marketKey, view){
    const key = gameId+'|'+marketKey;
    if(view === 'alt' && !state.altPropsCache[key]){
      state.altPropsView[key] = 'alt'; // optimistic — the tab shows active/loading right away
      loadAltLines(gameId, marketKey);
      return;
    }
    state.altPropsView[key] = view;
    rerenderPropsHost(gameId);
  }

  document.getElementById('gamesArea').addEventListener('click', (e)=>{
    const lineTab = e.target.closest('.line-view-tab');
    if(lineTab){
      const tabsEl = lineTab.closest('.line-view-tabs');
      setLineView(tabsEl.dataset.gameId, tabsEl.dataset.marketKey, lineTab.dataset.view);
      return;
    }
    const filterChip = e.target.closest('.prop-filter-chip');
    if(filterChip){
      const gameId = filterChip.closest('.props-market-filter').dataset.gameId;
      applyPropFilter(gameId, filterChip.dataset.filter);
      return;
    }
    const marketHead = e.target.closest('.prop-market-head');
    if(marketHead){
      toggleMarketHead(marketHead);
      return;
    }
    const slipBtn = e.target.closest('.prop-slip-btn');
    if(slipBtn){
      const prop = state.propRegistry[slipBtn.dataset.propId];
      if(!prop) return;
      addLegToSlip({ id: Date.now()+Math.random(), matchup: prop.matchup, side: prop.side, rows: prop.rows });
      showToast('Added ✓');
      const row = slipBtn.closest('tr');
      if(row) flashEl(row);
    }
  });

  document.getElementById('gamesArea').addEventListener('keydown', (e)=>{
    if((e.key==='Enter'||e.key===' ') && e.target.closest('.props-market-label')){
      e.preventDefault();
      const marketHead = e.target.closest('.props-market-label');
      if(marketHead) toggleMarketHead(marketHead);
    }
  });

  function renderGames(){
    const area = document.getElementById('gamesArea');
    if(!state.games.length){
      area.innerHTML = '<div class="empty-state"><h3>No games found</h3><p>Try a different sport — this one may be out of season.</p></div>';
      const sport = getSport();
      // Free (ESPN), long-cached shared helper — turns a bare "no games" into
      // "season starts Aug 6" when that's why.
      fetchSeasonStatus().then(all=>{
        // Bail if the user switched sports or games loaded while this was in flight
        const st = all[sport];
        if(getSport() !== sport || state.games.length) return;
        const p = area.querySelector('.empty-state p');
        if(!p || !st) return;
        if(st.inSeason){
          p.textContent = `Currently in season (${st.name || ''}) — no games on the board right now, check back soon.`;
        } else if(st.daysUntilStart !== null){
          p.textContent = `Season starts ${fmtSeasonDate(st.startDate)} — ${st.daysUntilStart} day${st.daysUntilStart===1?'':'s'} away.`;
        } else {
          p.textContent = `Off season — last window was ${fmtSeasonDate(st.startDate)} to ${fmtSeasonDate(st.endDate)}.`;
        }
      });
      return;
    }

    const term = state.searchTerm.trim().toLowerCase();
    const termFiltered = term
      ? state.games.filter(g => (g.home_team+' '+g.away_team).toLowerCase().includes(term))
      : state.games;
    // Drop finished games once ESPN's score poll confirms them complete — keeps
    // the list scrolled to live/upcoming games instead of growing all session.
    const gamesToShow = termFiltered.filter(g => !(findScoreFor(state.scores, g) || {}).completed);

    if(!termFiltered.length){
      area.innerHTML = `<div class="empty-state"><h3>No matches</h3><p>Nothing found for "${escapeHtml(state.searchTerm)}". Try a different team name.</p></div>`;
      return;
    }
    if(!gamesToShow.length){
      area.innerHTML = '<div class="empty-state"><h3>All caught up</h3><p>Every game on this slate has finished — check back for the next one, or hit Get Odds to refresh.</p></div>';
      return;
    }

    area.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'games';
    const sportKey = getSport();

    gamesToShow.forEach(game=>{
      const card = document.createElement('div');
      card.className = 'game-card';
      card.dataset.gameId = game.id;

      const head = document.createElement('div');
      head.className = 'game-head';
      const when = new Date(game.commence_time);
      head.innerHTML = `
        <div class="game-teams">${teamLogoImg(sportKey, game.away_team)}${escapeHtml(game.away_team)}<span class="vs">@</span>${teamLogoImg(sportKey, game.home_team)}${escapeHtml(game.home_team)}</div>
        <div class="game-time">${when.toLocaleDateString(undefined,{month:'short',day:'numeric'})} · ${when.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})}</div>
      `;
      card.appendChild(head);

      // Live/final score badge, when the game has started. This slot is always
      // present (even empty) so the 30s scores poll can patch it in place via
      // patchScores() instead of re-rendering the whole board (audit 6.1b).
      const scoreEntry = findScoreFor(state.scores, game);
      const liveDetail = sportKey === 'baseball_mlb' ? findMlbLiveFor(state.mlbLive, game) : null;
      const scoreSlot = document.createElement('div');
      scoreSlot.className = 'live-score-slot';
      scoreSlot.innerHTML = buildScoreBadgeHtml(game, scoreEntry, liveDetail);
      card.appendChild(scoreSlot);

      // MLB: stadium weather strip, then both starting pitchers with photos
      if(sportKey === 'baseball_mlb'){
        const weatherHtml = buildWeatherStrip(game, buildTopHittersHtml(game));
        if(weatherHtml){
          const w = document.createElement('div');
          w.innerHTML = weatherHtml;
          card.appendChild(w.firstElementChild);
        }
        const pitchersHtml = buildStartingPitchersHtml(game);
        if(pitchersHtml){
          const p = document.createElement('div');
          p.innerHTML = pitchersHtml;
          card.appendChild(p.firstElementChild);
        }
      }
      // NFL: stadium weather strip (no top-performers box yet — see note
      // in buildNflWeatherStrip's caller in refresh() about why), plus the
      // live line-of-scrimmage/down/possession field tracker. NCAAF gets the
      // same field tracker (ESPN's live situation data works the same way)
      // but no weather strip — hundreds of schools, no stadium map to key off.
      if(sportKey === 'americanfootball_nfl' || sportKey === 'americanfootball_ncaaf'){
        if(sportKey === 'americanfootball_nfl'){
          const weatherHtml = buildNflWeatherStrip(game);
          if(weatherHtml){
            const w = document.createElement('div');
            w.innerHTML = weatherHtml;
            card.appendChild(w.firstElementChild);
          }
        }
        const f = document.createElement('div');
        f.innerHTML = footballFieldTrackerSvg(sportKey, game, scoreEntry);
        card.appendChild(f.firstElementChild);
      }

      // MLB only: Spread/Total/Moneyline grid like a sportsbook's own game-lines
      // page, one row per team. Each cell is the best price across whichever
      // pool applies (My Books if set, else all tracked books) — same rule the
      // rest of Board already uses, just one number per cell instead of a list.
      // Returns true if at least one cell had data.
      function renderGameLinesGrid(view){
        const suffix = view === 'f5' ? '_1st_5_innings' : '';
        const tag = view === 'f5' ? ' (F5)' : '';
        const [awayTeam, homeTeam] = [game.away_team, game.home_team];
        const pool = poolFor(game.bookmakers);

        const ml = { away: rowsFor(pool, 'h2h'+suffix, awayTeam), home: rowsFor(pool, 'h2h'+suffix, homeTeam) };
        const spread = { away: modalPointRows(pool, 'spreads'+suffix, awayTeam), home: modalPointRows(pool, 'spreads'+suffix, homeTeam) };
        const total = { over: modalPointRows(pool, 'totals'+suffix, 'Over'), under: modalPointRows(pool, 'totals'+suffix, 'Under') };

        if(![ml.away, ml.home, spread.away, spread.home, total.over, total.under].some(r=>r.length)) return false;

        const addLeg = (side, rows, cellEl)=>{
          if(!rows.length) return;
          addLegToSlip({ id: Date.now()+Math.random(), matchup: `${awayTeam} @ ${homeTeam}`, side, rows });
          showToast('Added ✓');
          flashEl(cellEl);
        };

        function cell(rows, lineLabel, side){
          const div = document.createElement('div');
          if(!rows.length){
            div.className = 'gl-cell gl-empty';
            div.textContent = '—';
            return div;
          }
          div.className = 'gl-cell';
          div.title = 'Tap to add to Slip';
          const best = rows[0];
          div.innerHTML = `${lineLabel ? `<div class="gl-line">${escapeHtml(lineLabel)}</div>` : ''}<div class="gl-price ${Number(best.odds)>0?'pos':''}">${fmtAmerican(best.odds)}</div>`;
          div.addEventListener('click', ()=>addLeg(side, rows, div));
          return div;
        }

        const grid = document.createElement('div');
        grid.className = 'gl-grid';
        grid.appendChild(document.createElement('div'));
        ['Spread','Total','Money'].forEach(label=>{
          const h = document.createElement('div');
          h.className = 'gl-head';
          h.textContent = label;
          grid.appendChild(h);
        });

        function teamRow(team, spreadRows, totalRows, totalSide, mlRows){
          const name = document.createElement('div');
          name.className = 'gl-team';
          name.textContent = team;
          grid.appendChild(name);
          const spreadLabel = spreadRows.length ? fmtAmerican(spreadRows[0].point) : '';
          grid.appendChild(cell(spreadRows, spreadLabel, `${team}${tag} ${spreadLabel}`.trim()));
          const totalLabel = totalRows.length ? (totalSide === 'Over' ? 'O ' : 'U ') + totalRows[0].point : '';
          grid.appendChild(cell(totalRows, totalLabel, `${totalSide} ${totalRows.length ? totalRows[0].point : ''}${tag}`.trim()));
          grid.appendChild(cell(mlRows, '', `${team}${tag}`));
        }
        teamRow(awayTeam, spread.away, total.over, 'Over', ml.away);
        teamRow(homeTeam, spread.home, total.under, 'Under', ml.home);

        card.appendChild(grid);
        return true;
      }

      // Renders the per-team moneyline grid for a given market key (full-game
      // 'h2h' or MLB's 'h2h_1st_5_innings'). Same best-price/My Books logic
      // either way — only which market's outcomes get gathered changes.
      // Returns true if at least one team had rows to show.
      function renderOddsBlocks(marketKey){
        const teams = [game.away_team, game.home_team];
        const trackedBookmakers = game.bookmakers.filter(b => TRACKED_KEYS.includes(b.key.toLowerCase()));
        const bookmakersToUse = trackedBookmakers.length ? trackedBookmakers : game.bookmakers;
        const myBooks = getMyBooks();

        const rowsByTeam = {};
        teams.forEach(team=>{
          const rows = [];
          bookmakersToUse.forEach(bm=>{
            const market = bm.markets.find(m=>m.key === marketKey);
            if(!market) return;
            const outcome = market.outcomes.find(o=>o.name === team);
            if(!outcome) return;
            rows.push({bookKey: bm.key, bookTitle: bm.title, odds: outcome.price, link: outcome.link || bm.link || null, sid: outcome.sid || null, marketSid: market.sid || null});
          });
          rows.sort((a,b)=> americanToDecimal(b.odds) - americanToDecimal(a.odds));
          rowsByTeam[team] = rows;
        });

        let renderedAny = false;
        teams.forEach(team=>{
          const rows = rowsByTeam[team];
          if(!rows.length) return;
          renderedAny = true;
          const otherTeam = teams.find(t=>t!==team);
          const fairDecimal = computeFairDecimal(rows, rowsByTeam[otherTeam] || []);
          const sideLabel = marketKey === 'h2h' ? team : team + ' (F5)';

          const block = document.createElement('div');
          block.className = 'outcome-block';
          const label = document.createElement('div');
          label.className = 'outcome-label';
          label.textContent = sideLabel + ' to win';
          block.appendChild(label);

          const addLeg = (rowEl)=>{
            addLegToSlip({
              id: Date.now()+Math.random(),
              matchup: `${game.away_team} @ ${game.home_team}`,
              side: sideLabel,
              rows: rows
            });
            showToast('Added ✓');
            if(rowEl) flashEl(rowEl);
          };

          const myRows = myBooks.length ? filterToMyBooks(rows, r=>r.bookKey) : [];
          const otherRows = myBooks.length ? rows.filter(r=>!myBooks.includes(r.bookKey.toLowerCase())) : [];

          // Board never names the book — just the price. The link icon still
          // opens the right book (its title attr carries the name for hover/
          // screen readers); picking which book to actually bet with happens
          // on the Slip page's book selector instead.
          if(myBooks.length && myRows.length){
            // Clean grid of just the user's books — no Best/Value ranking noise
            const grid = document.createElement('div');
            grid.className = 'mybook-grid';
            myRows.forEach(r=>{
              const style = bookStyleFor(r.bookKey);
              const link = BOOK_LINKS[r.bookKey.toLowerCase()];
              const cell = document.createElement('div');
              cell.className = 'mybook-cell';
              cell.innerHTML = `
                <span class="book-odds ${Number(r.odds)>0?'pos':'neg'}">${fmtAmerican(r.odds)}</span>
                <button class="add-leg-btn">+ Slip</button>
                ${link ? `<a class="book-link-btn" href="${link}" target="_blank" rel="noopener" title="Open ${escapeHtml(style?style.name:r.bookTitle)}">↗</a>` : ''}
              `;
              cell.querySelector('.add-leg-btn').addEventListener('click', ()=>addLeg(cell));
              grid.appendChild(cell);
            });
            block.appendChild(grid);
            const bestMine = myRows[0], bestOther = otherRows[0];
            if(bestOther && americanToDecimal(bestOther.odds) > americanToDecimal(bestMine.odds)){
              const oLink = BOOK_LINKS[bestOther.bookKey.toLowerCase()];
              const hint = document.createElement('div');
              hint.className = 'elsewhere-hint';
              hint.innerHTML = `A better price is available elsewhere: ${fmtAmerican(bestOther.odds)}${oLink?` <a href="${oLink}" target="_blank" rel="noopener">↗</a>`:''}`;
              block.appendChild(hint);
            }
          } else {
            rows.forEach((r, idx)=>{
              const row = document.createElement('div');
              const isValue = fairDecimal && americanToDecimal(r.odds) > fairDecimal * 1.015;
              row.className = 'book-row' + (idx===0 ? ' best' : '');
              const style = bookStyleFor(r.bookKey);
              const link = BOOK_LINKS[r.bookKey.toLowerCase()];
              row.innerHTML = `
                ${idx===0 ? '<span class="best-tag">Best</span>' : ''}
                ${isValue ? '<span class="value-tag" title="Pays better than the market-consensus fair line">Value</span>' : ''}
                <span class="book-odds ${Number(r.odds)>0?'pos':'neg'}">${fmtAmerican(r.odds)}</span>
                <button class="add-leg-btn">+ Slip</button>
                ${link ? `<a class="book-link-btn" href="${link}" target="_blank" rel="noopener" title="Open ${escapeHtml(style?style.name:r.bookTitle)}">↗</a>` : ''}
              `;
              row.querySelector('.add-leg-btn').addEventListener('click', ()=>addLeg(row));
              block.appendChild(row);
            });
          }
          card.appendChild(block);
        });
        return renderedAny;
      }

      // MLB: F5 toggle swaps the same grid between full-game and first-5-innings lines.
      // NFL: same Spread/Total/Money grid, just without the F5 tabs (no NFL period-market equivalent yet).
      if(sportKey === 'baseball_mlb' || sportKey === 'americanfootball_nfl'){
        let view = 'full';
        if(sportKey === 'baseball_mlb'){
          view = state.oddsView[game.id] === 'f5' ? 'f5' : 'full';
          const tabs = document.createElement('div');
          tabs.className = 'f5-tabs';
          tabs.innerHTML = `
            <button class="f5-tab${view==='full'?' active':''}" data-view="full">Full game</button>
            <button class="f5-tab${view==='f5'?' active':''}" data-view="f5">First 5 innings</button>
          `;
          tabs.querySelectorAll('.f5-tab').forEach(btn=>{
            btn.addEventListener('click', ()=>{
              state.oddsView[game.id] = btn.dataset.view;
              renderGames();
            });
          });
          card.appendChild(tabs);
        }

        const renderedAny = renderGameLinesGrid(view);
        if(!renderedAny){
          const note = document.createElement('div');
          note.className = 'empty-state f5-empty';
          note.innerHTML = `<p>${view === 'f5' ? 'F5 lines not posted yet.' : 'Odds not posted yet.'}</p>`;
          card.appendChild(note);
        }
      } else {
        renderOddsBlocks('h2h');
      }

      // ---- player props (opt-in per game, protects API quota) ----
      if(PROP_MARKETS[sportKey]){
        const toggleWrap = document.createElement('div');
        toggleWrap.className = 'props-toggle';
        const alreadyLoaded = !!state.propsCache[game.id];
        const unavailableMsg = state.propsUnavailable[game.id];
        // Props open/closed state lives in state.propsOpen so it survives re-renders
        // triggered by the weather/pitchers batch or a fallback score render (audit 6.1a).
        const isOpen = !!state.propsOpen[game.id];
        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'ghost';
        toggleBtn.textContent = isOpen
          ? 'Hide player props'
          : ((alreadyLoaded || unavailableMsg) ? 'Show player props' : 'Load player props');
        toggleWrap.appendChild(toggleBtn);
        card.appendChild(toggleWrap);

        const propsHost = document.createElement('div');
        propsHost.className = 'props-host reveal' + (isOpen ? ' is-open' : '');
        propsHost.dataset.gameId = game.id;
        propsHost.style.display = isOpen ? 'block' : 'none';
        card.appendChild(propsHost);

        if(alreadyLoaded){
          propsHost.innerHTML = buildPropsHtml(game, state.propsCache[game.id].data, PROP_MARKETS[sportKey]);
          propsHost.dataset.loaded = '1';
        } else if(unavailableMsg){
          propsHost.innerHTML = unavailableMsg;
          propsHost.dataset.loaded = '1';
        }

        toggleBtn.addEventListener('click', async ()=>{
          if(propsHost.classList.contains('is-open')){
            revealHide(propsHost);
            toggleBtn.textContent = 'Show player props';
            state.propsOpen[game.id] = false;
            return;
          }
          if(!propsHost.dataset.loaded){
            toggleBtn.disabled = true;
            toggleBtn.innerHTML = '<span class="spinner"></span> Loading…';
            await loadProps(game, sportKey, propsHost);
            propsHost.dataset.loaded = '1';
            toggleBtn.disabled = false;
          }
          toggleBtn.textContent = 'Hide player props';
          state.propsOpen[game.id] = true;
          revealShow(propsHost);
        });
      }

      // ---- HR matchups (opt-in per game, MLB only) ----
      if(sportKey === 'baseball_mlb'){
        const hrToggleWrap = document.createElement('div');
        hrToggleWrap.className = 'hr-toggle';
        const hrAlreadyLoaded = !!state.hrCache[game.id];
        const hrToggleBtn = document.createElement('button');
        hrToggleBtn.className = 'ghost';
        hrToggleBtn.textContent = hrAlreadyLoaded ? 'Show HR matchups' : 'Load HR matchups';
        hrToggleWrap.appendChild(hrToggleBtn);
        card.appendChild(hrToggleWrap);

        const hrHost = document.createElement('div');
        hrHost.className = 'hr-host reveal';
        hrHost.dataset.gameId = game.id;
        hrHost.style.display = 'none';
        card.appendChild(hrHost);

        if(hrAlreadyLoaded){
          hrHost.innerHTML = buildHrHtml(game, state.hrCache[game.id]);
          hrHost.dataset.loaded = '1';
        }

        hrToggleBtn.addEventListener('click', async ()=>{
          if(hrHost.classList.contains('is-open')){
            revealHide(hrHost);
            hrToggleBtn.textContent = 'Show HR matchups';
            return;
          }
          if(!hrHost.dataset.loaded){
            hrToggleBtn.disabled = true;
            hrToggleBtn.innerHTML = '<span class="spinner"></span> Loading…';
            await loadHrMatchups(game, hrHost);
            hrHost.dataset.loaded = '1';
            hrToggleBtn.disabled = false;
          }
          hrToggleBtn.textContent = 'Hide HR matchups';
          revealShow(hrHost);
        });
      }

      wrap.appendChild(card);
    });
    area.appendChild(wrap);
    staggerIn(wrap);
    renderBookFilter();
  }

  refresh();
})();
