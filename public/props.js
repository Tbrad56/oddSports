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

  function buildPropsHtml(game, data, markets){
    let bms = (data.bookmakers || []).filter(b => TRACKED_KEYS.includes(b.key.toLowerCase()));
    let bookmakersToUse = bms.length ? bms : (data.bookmakers || []);
    if(state.propsBookFilter !== 'all'){
      bookmakersToUse = bookmakersToUse.filter(b => b.key.toLowerCase() === state.propsBookFilter);
    }
    const term = state.searchTerm.trim().toLowerCase();
    const matchup = `${game.away_team} @ ${game.home_team}`;

    let html = '<div class="props-block">';
    let any = false;
    markets.forEach(marketKey=>{
      const perPlayer = {}; // "playerName|side|point" -> {player, side, point, rows}
      bookmakersToUse.forEach(bm=>{
        const market = bm.markets.find(m=>m.key===marketKey);
        if(!market) return;
        market.outcomes.forEach(o=>{
          const playerName = o.description || o.name;
          const rowKey = playerName + '|' + o.name + '|' + (o.point ?? '');
          if(!perPlayer[rowKey]) perPlayer[rowKey] = {player:playerName, side:o.name, point:o.point, rows:[]};
          perPlayer[rowKey].rows.push({bookKey:bm.key, bookTitle:bm.title, odds:o.price});
        });
      });
      let rowKeys = Object.keys(perPlayer);
      if(term){
        rowKeys = rowKeys.filter(rk => perPlayer[rk].player.toLowerCase().includes(term) || matchup.toLowerCase().includes(term));
      }
      if(!rowKeys.length) return;
      any = true;
      const sectionKey = game.id + '|' + marketKey;
      const collapsed = !!state.marketCollapsed[sectionKey];
      html += `<div class="props-market-label prop-market-head" data-section-key="${escapeHtml(sectionKey)}" title="Click to ${collapsed?'expand':'collapse'}">
        <span class="market-arrow">${collapsed?'▸':'▾'}</span>${escapeHtml(marketLabel(marketKey))}
        <span class="market-count">(${rowKeys.length})</span>
      </div>`;
      html += `<div class="market-body" style="${collapsed?'display:none;':''}">`;
      html += `<table class="props-table"><thead><tr><th>Player</th><th>Line</th><th>Line shop (best → worst)</th><th></th></tr></thead><tbody>`;
      rowKeys.slice(0,20).forEach(rk=>{
        const entry = perPlayer[rk];
        const rows = entry.rows.sort((a,b)=>americanToDecimal(b.odds)-americanToDecimal(a.odds));
        const pointTxt = entry.point !== undefined && entry.point !== null ? `${entry.side} ${entry.point}` : entry.side;
        const chips = rows.map((r,idx)=>{
          const style = bookStyleFor(r.bookKey);
          const label = style ? style.name : r.bookTitle;
          const link = BOOK_LINKS[r.bookKey.toLowerCase()];
          const chip = `<span class="odds-chip${idx===0?' best':''}" title="${escapeHtml(label)}">${escapeHtml(label)} ${fmtAmerican(r.odds)}</span>`;
          return link ? `<a href="${link}" target="_blank" rel="noopener" style="text-decoration:none;">${chip}</a>` : chip;
        }).join('');
        // register this prop so the + Slip button can add it as a parlay leg
        const propId = 'p' + (++state.propIdCounter);
        state.propRegistry[propId] = {
          side: `${entry.player} ${pointTxt} ${marketLabel(marketKey)}`,
          matchup, rows
        };
        html += `<tr>
          <td style="font-weight:600; white-space:nowrap;">${escapeHtml(entry.player)}</td>
          <td style="color:var(--text-dim); white-space:nowrap;">${escapeHtml(pointTxt)}</td>
          <td><div class="line-shop">${chips}</div></td>
          <td><button class="add-leg-btn prop-slip-btn" data-prop-id="${propId}">+ Slip</button></td>
        </tr>`;
      });
      html += `</tbody></table></div>`;
    });
    if(!any){
      html += `<span style="color:var(--text-faint); font-size:12.5px;">No player props posted for this game yet — check back closer to game time.</span>`;
    }
    html += '</div>';
    return html;
  }

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
