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

    gamesToShow.forEach(game=>{
      const card = document.createElement('div');
      card.className = 'game-card';

      const head = document.createElement('div');
      head.className = 'game-head';
      const when = new Date(game.commence_time);
      head.innerHTML = `
        <div class="game-teams">${escapeHtml(game.away_team)}<span class="vs">@</span>${escapeHtml(game.home_team)}</div>
        <div class="game-time">${when.toLocaleDateString(undefined,{month:'short',day:'numeric'})} · ${when.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})}</div>
      `;
      card.appendChild(head);

      // gather per-outcome (team) prices across bookmakers, tracked books only, fallback to all if none tracked found
      const teams = [game.away_team, game.home_team];
      const trackedBookmakers = game.bookmakers.filter(b => TRACKED_KEYS.includes(b.key.toLowerCase()));
      const bookmakersToUse = trackedBookmakers.length ? trackedBookmakers : game.bookmakers;

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

        rows.forEach((r, idx)=>{
          const row = document.createElement('div');
          const isValue = fairDecimal && americanToDecimal(r.odds) > fairDecimal * 1.015;
          row.className = 'book-row' + (idx===0 ? ' best' : '');
          const style = bookStyleFor(r.bookKey);
          const badgeHtml = style
            ? `<div class="book-badge" style="background:${style.color};">${escapeHtml(style.name)}</div>`
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
          row.querySelector('.add-leg-btn').addEventListener('click', ()=>{
            addLegToSlip({
              id: Date.now()+Math.random(),
              matchup: `${game.away_team} @ ${game.home_team}`,
              side: team,
              rows: rows
            });
            showToast('Added ✓');
          });
          block.appendChild(row);
        });
        card.appendChild(block);
      });

      wrap.appendChild(card);
    });
    area.appendChild(wrap);
  }

  refresh();
})();
