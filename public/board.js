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
    scores: [], mlbLive: [], scoresTimer: null
  };
  let renderScheduled = false;
  // Coalesces multiple renderGames() requests (weather + Kalshi post-fetches, audit 6.2)
  // into a single call per animation frame, instead of re-rendering the whole board twice more.
  function scheduleRender(){
    if(renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(()=>{ renderScheduled = false; if(state.games.length) renderGames(); });
  }

  renderNav('board');
  renderSportChips(document.getElementById('sportChips'), ()=>{
    state.propsCache = {}; state.propRegistry = {}; state.marketCollapsed = {};
    state.propsBookFilter = 'all'; state.propsOpen = {}; state.propsUnavailable = {};
    refresh();
  });
  renderMyBooksList();

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
      updateTicker(games);
      setStatus(true, oddsStatusText(games.length, remaining, cacheAge));

      const sport = getSport();
      // MLB: pull hourly stadium forecasts (free Open-Meteo, no key), re-render with weather strips
      if(sport === 'baseball_mlb' && games.length){
        fetchStadiumWeather(games).then(scheduleRender).catch(()=>{});
      }
      // Kalshi reference prices (public market data, no key) for supported sports
      kalshiEventsCache = [];
      if(KALSHI_SERIES[sport] && games.length){
        fetchKalshi(sport).then(scheduleRender).catch(()=>{});
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
      state.scores = await fetchScoresFor(sport);
      if(sport === 'baseball_mlb'){
        state.mlbLive = await fetchMlbLive().catch(()=>[]);
      }
      if(state.games.length) patchScores();
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
        if(state.games.length) renderGames();
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

  function buildPropsHtml(game, data, markets){
    let bms = (data.bookmakers || []).filter(b => TRACKED_KEYS.includes(b.key.toLowerCase()));
    let bookmakersToUse = bms.length ? bms : (data.bookmakers || []);
    if(state.propsBookFilter !== 'all'){
      bookmakersToUse = bookmakersToUse.filter(b => b.key.toLowerCase() === state.propsBookFilter);
    }

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
      const rowKeys = Object.keys(perPlayer);
      if(!rowKeys.length) return;
      any = true;
      const sectionKey = game.id + '|' + marketKey;
      const collapsed = !!state.marketCollapsed[sectionKey];
      html += `<div class="props-market-label prop-market-head" data-section-key="${escapeHtml(sectionKey)}" tabindex="0" role="button" aria-expanded="${!collapsed}" title="Click to ${collapsed?'expand':'collapse'}">
        <span class="market-arrow">${collapsed?'▸':'▾'}</span>${escapeHtml(marketLabel(marketKey))}
        <span class="market-count">(${rowKeys.length})</span>
      </div>`;
      html += `<div class="market-body" style="${collapsed?'display:none;':''}"><div class="table-scroll">`;
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
          matchup: `${game.away_team} @ ${game.home_team}`, rows
        };
        html += `<tr>
          <td style="font-weight:600; white-space:nowrap;">${escapeHtml(entry.player)}</td>
          <td style="color:var(--text-dim); white-space:nowrap;">${escapeHtml(pointTxt)}</td>
          <td><div class="line-shop">${chips}</div></td>
          <td><button class="add-leg-btn prop-slip-btn" data-prop-id="${propId}">+ Slip</button></td>
        </tr>`;
      });
      html += `</tbody></table></div></div>`;
    });
    if(!any){
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

  document.getElementById('gamesArea').addEventListener('click', (e)=>{
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
      return;
    }

    const term = state.searchTerm.trim().toLowerCase();
    const gamesToShow = term
      ? state.games.filter(g => (g.home_team+' '+g.away_team).toLowerCase().includes(term))
      : state.games;

    if(!gamesToShow.length){
      area.innerHTML = `<div class="empty-state"><h3>No matches</h3><p>Nothing found for "${escapeHtml(state.searchTerm)}". Try a different team name.</p></div>`;
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
        <div class="game-teams">${escapeHtml(game.away_team)}<span class="vs">@</span>${escapeHtml(game.home_team)}</div>
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

      // MLB: stadium weather strip sits above the odds
      if(sportKey === 'baseball_mlb'){
        const weatherHtml = buildWeatherStrip(game);
        if(weatherHtml){
          const w = document.createElement('div');
          w.innerHTML = weatherHtml;
          card.appendChild(w.firstElementChild);
        }
      }

      // gather per-outcome (team) prices across bookmakers, tracked books only, fallback to all if none tracked found
      const teams = [game.away_team, game.home_team];
      const trackedBookmakers = game.bookmakers.filter(b => TRACKED_KEYS.includes(b.key.toLowerCase()));
      const bookmakersToUse = trackedBookmakers.length ? trackedBookmakers : game.bookmakers;
      const myBooks = getMyBooks();

      const rowsByTeam = {};
      teams.forEach(team=>{
        const rows = [];
        bookmakersToUse.forEach(bm=>{
          const market = bm.markets.find(m=>m.key === 'h2h');
          if(!market) return;
          const outcome = market.outcomes.find(o=>o.name === team);
          if(!outcome) return;
          rows.push({bookKey: bm.key, bookTitle: bm.title, odds: outcome.price});
        });
        rows.sort((a,b)=> americanToDecimal(b.odds) - americanToDecimal(a.odds));
        rowsByTeam[team] = rows;
      });

      teams.forEach(team=>{
        const rows = rowsByTeam[team];
        if(!rows.length) return;
        const otherTeam = teams.find(t=>t!==team);
        const fairDecimal = computeFairDecimal(rows, rowsByTeam[otherTeam] || []);

        const block = document.createElement('div');
        block.className = 'outcome-block';
        const label = document.createElement('div');
        label.className = 'outcome-label';
        label.textContent = team + ' to win';
        block.appendChild(label);

        const addLeg = (rowEl)=>{
          addLegToSlip({
            id: Date.now()+Math.random(),
            matchup: `${game.away_team} @ ${game.home_team}`,
            side: team,
            rows: rows
          });
          showToast('Added ✓');
          if(rowEl) flashEl(rowEl);
        };

        const myRows = myBooks.length ? filterToMyBooks(rows, r=>r.bookKey) : [];
        const otherRows = myBooks.length ? rows.filter(r=>!myBooks.includes(r.bookKey.toLowerCase())) : [];

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
              <div class="book-badge" style="background:${style?style.color:'var(--bg-raised)'}; color:${style?badgeTextColor(style.color):'#F5F5F5'};">${escapeHtml(style?style.name:r.bookTitle)}</div>
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
            const oStyle = bookStyleFor(bestOther.bookKey);
            const oLink = BOOK_LINKS[bestOther.bookKey.toLowerCase()];
            const hint = document.createElement('div');
            hint.className = 'elsewhere-hint';
            hint.innerHTML = `Better elsewhere: ${escapeHtml(oStyle?oStyle.name:bestOther.bookTitle)} ${fmtAmerican(bestOther.odds)}${oLink?` <a href="${oLink}" target="_blank" rel="noopener">↗</a>`:''}`;
            block.appendChild(hint);
          }
        } else {
          rows.forEach((r, idx)=>{
            const row = document.createElement('div');
            const isValue = fairDecimal && americanToDecimal(r.odds) > fairDecimal * 1.015;
            row.className = 'book-row' + (idx===0 ? ' best' : '');
            const style = bookStyleFor(r.bookKey);
            const badgeHtml = style
              ? `<div class="book-badge" style="background:${style.color}; color:${badgeTextColor(style.color)};">${escapeHtml(style.name)}</div>`
              : `<div class="book-name-fallback">${escapeHtml(r.bookTitle)}</div>`;
            const link = BOOK_LINKS[r.bookKey.toLowerCase()];
            row.innerHTML = `
              ${badgeHtml}
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

        // Kalshi reference row (prediction market, not a licensed book; excluded from Best/Value ranking)
        const kRow = kalshiRowFor(game, team);
        if(kRow){
          const kr = document.createElement('div');
          kr.className = 'book-row kalshi-row';
          kr.innerHTML = `
            <div class="kalshi-badge">Kalshi</div>
            <span class="kalshi-note">prediction market · ${kRow.cents}¢</span>
            <span class="book-odds ${kRow.american>0?'pos':'neg'}">${fmtAmerican(kRow.american)}</span>
            <a class="book-link-btn" href="${kRow.link}" target="_blank" rel="noopener" title="Open this market on Kalshi">↗</a>
          `;
          block.appendChild(kr);
        }
        card.appendChild(block);
      });

      // ---- player props (opt-in per game, protects API quota) ----
      if(PROP_MARKETS[sportKey]){
        const toggleWrap = document.createElement('div');
        toggleWrap.className = 'props-toggle';
        const alreadyLoaded = !!state.propsCache[game.id];
        const unavailableMsg = state.propsUnavailable[game.id];
        // Props open/closed state lives in state.propsOpen so it survives re-renders
        // triggered by the weather/Kalshi batch or a fallback score render (audit 6.1a).
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

      wrap.appendChild(card);
    });
    area.appendChild(wrap);
    staggerIn(wrap);
    renderBookFilter();
  }

  refresh();
})();
