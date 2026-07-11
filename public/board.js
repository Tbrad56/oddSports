(function(){
  const state = { games: [], searchTerm: '', autoRefresh: false, autoTimer: null };

  renderNav('board');
  renderSportChips(document.getElementById('sportChips'), refresh);
  renderMyBooksList();

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

      const sport = getSport();
      // MLB: pull hourly stadium forecasts (free Open-Meteo, no key), re-render with weather strips
      if(sport === 'baseball_mlb' && games.length){
        fetchStadiumWeather(games).then(renderGames).catch(()=>{});
      }
      // Kalshi reference prices (public market data, no key) for supported sports
      kalshiEventsCache = [];
      if(KALSHI_SERIES[sport] && games.length){
        fetchKalshi(sport).then(renderGames).catch(()=>{});
      }
    }catch(e){
      setStatus(false, 'Fetch failed.');
      showError(e.message || 'Could not fetch odds — try again shortly.');
    }finally{
      btn.disabled = false; btn.textContent = 'Get Odds';
    }
  }
  document.getElementById('fetchBtn').addEventListener('click', refresh);

  // ---------- My books panel ----------
  document.getElementById('myBooksToggle').addEventListener('click', ()=>{
    const panel = document.getElementById('myBooksPanel');
    const showing = panel.style.display !== 'none';
    panel.style.display = showing ? 'none' : 'block';
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

      // MLB: stadium weather strip sits above the odds
      if(getSport() === 'baseball_mlb'){
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

        const addLeg = ()=>{
          addLegToSlip({
            id: Date.now()+Math.random(),
            matchup: `${game.away_team} @ ${game.home_team}`,
            side: team,
            rows: rows
          });
          showToast('Added ✓');
        };

        const myRows = myBooks.length ? rows.filter(r=>myBooks.includes(r.bookKey.toLowerCase())) : [];
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
              <div class="book-badge" style="background:${style?style.color:'var(--bg-raised)'};">${escapeHtml(style?style.name:r.bookTitle)}</div>
              <span class="book-odds ${Number(r.odds)>0?'pos':'neg'}">${fmtAmerican(r.odds)}</span>
              <button class="add-leg-btn">+ Slip</button>
              ${link ? `<a class="book-link-btn" href="${link}" target="_blank" rel="noopener" title="Open ${escapeHtml(style?style.name:r.bookTitle)}">↗</a>` : ''}
            `;
            cell.querySelector('.add-leg-btn').addEventListener('click', addLeg);
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
            row.querySelector('.add-leg-btn').addEventListener('click', addLeg);
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

      wrap.appendChild(card);
    });
    area.appendChild(wrap);
  }

  refresh();
})();
