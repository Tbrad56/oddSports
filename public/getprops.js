(function(){
  const state = { games: [], results: {}, loading: {}, expanded: {}, scores: [], mlbLive: [], scoresTimer: null };

  renderNav('getprops');

  async function loadGames(){
    clearError();
    setStatus(false, "Loading today's games…");
    renderSkeletonCards(document.getElementById('gamesArea'), 3);
    try{
      const {games, remaining, cacheAge} = await fetchOddsFor('baseball_mlb');
      state.games = games;
      updateTicker(games);
      renderPage();
      staggerIn(document.getElementById('gamesArea'));
      setStatus(true, oddsStatusText(games.length, remaining, cacheAge));

      clearInterval(state.scoresTimer);
      if(games.length){
        refreshScores();
        state.scoresTimer = setInterval(refreshScores, 30*1000);
      }
    }catch(e){
      setStatus(false, 'Fetch failed.');
      const message = e.message || 'Could not fetch games — try again shortly.';
      showError(message);
      document.getElementById('gamesArea').innerHTML = '<div class="empty-state"><h3>Couldn\'t load games</h3><p>' + escapeHtml(message) + '</p><button class="primary" id="retryBtn">Retry</button></div>';
      const retryBtn = document.getElementById('retryBtn');
      if(retryBtn) retryBtn.addEventListener('click', loadGames);
    }
  }

  async function refreshScores(){
    try{
      state.scores = await fetchScoresFor('baseball_mlb');
      state.mlbLive = await fetchMlbLive().catch(()=>[]);
      if(state.games.length) renderPage();
    }catch(e){
      // scores are a bonus overlay — quietly skip on failure
    }
  }

  function pct(p){ return (p*100).toFixed(1) + '%'; }

  function renderPage(){
    const area = document.getElementById('gamesArea');
    if(!state.games.length){
      area.innerHTML = '<div class="empty-state"><h3>No MLB games found</h3><p>Check back on a game day.</p></div>';
      return;
    }
    let html = '';
    state.games.forEach(game=>{
      const when = new Date(game.commence_time);
      const result = state.results[game.id];
      const loading = state.loading[game.id];
      const scoreEntry = findScoreFor(state.scores, game);
      const liveDetail = findMlbLiveFor(state.mlbLive, game);
      html += `<div class="game-card" id="getprops-game-${escapeHtml(game.id)}" style="margin-bottom:14px;">
        <div class="game-head">
          <div class="game-teams">${escapeHtml(game.away_team)}<span class="vs">@</span>${escapeHtml(game.home_team)}</div>
          <div class="game-time">${when.toLocaleDateString(undefined,{month:'short',day:'numeric'})} · ${when.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})}</div>
        </div>
        ${buildScoreBadgeHtml(game, scoreEntry, liveDetail)}
        <div style="padding:14px 16px;">`;
      if(loading){
        html += `<span class="spinner"></span> <span style="font-size:12.5px; color:var(--text-dim);">Analyzing props…</span>`;
      } else if(result){
        html += renderResults(game, result);
      } else {
        html += `<button class="ghost analyze-btn" data-game-id="${escapeHtml(game.id)}">Analyze props</button>
                 <span class="analyze-cost">~12 API credits · cached 10 min for everyone</span>`;
      }
      html += `</div></div>`;
    });
    area.innerHTML = html;
  }

  function flagChips(flags){
    const labels = { thin_sample:['warn','Thin sample'], check_news:['warn','Check news'], one_sided:['info','One-sided line'], lineup_unconfirmed:['info','Lineup unconfirmed'] };
    return flags.map(f=>{
      const [cls, label] = labels[f] || ['info', f];
      return `<span class="flag-chip ${cls}">${escapeHtml(label)}</span>`;
    }).join('');
  }

  function renderResults(game, result){
    let head = '';
    if(result.lineupStatus === 'confirmed'){
      head = `<div style="font-size:11.5px; color:var(--good); margin-bottom:8px;">Lineups posted ✓</div>`;
    } else if(result.lineupStatus === 'pending'){
      head = `<div style="font-size:11.5px; color:var(--warn); margin-bottom:8px;">Lineups pending — batter picks unconfirmed</div>`;
    }
    if(!result.picks.length){
      const msg = result.propCount === 0
        ? 'No props posted for this game yet — books usually post player props closer to game time.'
        : 'No edges ≥ 3% found in this game\'s props.';
      return head + `<span style="font-size:12.5px; color:var(--text-faint);">${msg}</span>`;
    }
    let html = head + `<div class="table-scroll"><table class="props-table"><thead><tr>
      <th>Player</th><th>Prop</th><th>Side</th><th>Model</th><th>Book</th><th>Edge</th><th>Best price</th><th></th>
    </tr></thead><tbody>`;
    result.picks.forEach((pick, i)=>{
      const key = game.id + '|' + i;
      const style = bookStyleFor(pick.bestBook.bookKey);
      const isExpanded = !!state.expanded[key];
      html += `<tr class="pick-row" data-key="${escapeHtml(key)}" tabindex="0" role="button" aria-expanded="${isExpanded}">
        <td style="font-weight:600; white-space:nowrap;">${escapeHtml(pick.player)}</td>
        <td style="white-space:nowrap;">${escapeHtml(marketLabel(pick.market))} ${escapeHtml(String(pick.line))}</td>
        <td>${escapeHtml(pick.side)}</td>
        <td style="font-family:var(--font-mono);">${pct(pick.modelP)}</td>
        <td style="font-family:var(--font-mono); color:var(--text-dim);">${pct(pick.impliedP)}</td>
        <td class="edge-cell">+${pct(pick.edge)}</td>
        <td style="white-space:nowrap;">${escapeHtml(style ? style.name : pick.bestBook.bookTitle)} ${fmtAmerican(pick.bestBook.odds)}</td>
        <td><button class="add-leg-btn pick-slip-btn" data-key="${escapeHtml(key)}">+ Slip</button></td>
      </tr>`;
      if(state.expanded[key]){
        const a = pick.analysis;
        const maxV = Math.max(...a.recentValues, pick.line, 1);
        const bars = a.recentValues.slice().reverse().map(v=>
          `<div class="bar${v > pick.line ? ' hit' : ''}" style="height:${Math.max(6, Math.round(v/maxV*44))}px;" title="${escapeHtml(String(v))}"></div>`
        ).join('');
        html += `<tr class="pick-detail"><td colspan="8">
          ${flagChips(a.flags)}
          <div style="font-size:12.5px; color:var(--text-dim); margin-top:6px;">
            Cleared ${escapeHtml(String(pick.line))} in <strong style="color:var(--text);">${a.hitCount} of last ${a.windowSize}</strong> ·
            weighted rate ${a.lambda.toFixed(2)} vs line ${escapeHtml(String(pick.line))} ·
            recent ${a.recentRate.toFixed(2)} / season ${a.seasonRate.toFixed(2)}
            ${a.trend==='up' ? '▲ trending up' : a.trend==='down' ? '▼ trending down' : '— flat'}
          </div>
          <div class="bar-strip">${bars}</div>
          <div style="font-size:10.5px; color:var(--text-faint);">Last ${a.windowSize} games, oldest → newest. Green = cleared the line.</div>
        </td></tr>`;
      }
    });
    html += `</tbody></table></div>`;
    if(result.skipped.length){
      html += `<div style="font-size:11px; color:var(--text-faint); margin-top:8px;">No stats match: ${result.skipped.map(escapeHtml).join(', ')}</div>`;
    }
    if(result.filtered && result.filtered.length){
      html += `<div style="font-size:11px; color:var(--text-faint); margin-top:8px;">Not starting today: ${result.filtered.map(f=>escapeHtml(f.player)).join(', ')}</div>`;
    }
    return html;
  }

  async function analyze(gameId){
    state.loading[gameId] = true;
    renderPage();
    try{
      const res = await fetch(`/api/analyze/mlb/${gameId}`);
      if(!res.ok){
        let msg = `Error ${res.status}`;
        try{ const j = await res.json(); if(j.error) msg = j.error; }catch(_){}
        throw new Error(msg);
      }
      state.results[gameId] = await res.json();
    }catch(e){
      showError(e.message || 'Analysis failed — try again shortly.');
    }finally{
      state.loading[gameId] = false;
      renderPage();
      const card = document.getElementById('getprops-game-' + gameId);
      if(card) card.classList.add('enter');
    }
  }

  document.getElementById('gamesArea').addEventListener('click', (e)=>{
    const analyzeBtn = e.target.closest('.analyze-btn');
    if(analyzeBtn){ analyze(analyzeBtn.dataset.gameId); return; }
    const slipBtn = e.target.closest('.pick-slip-btn');
    if(slipBtn){
      const [gameId, idx] = slipBtn.dataset.key.split('|');
      const pick = (state.results[gameId] || {picks:[]}).picks[Number(idx)];
      if(!pick) return;
      const game = state.games.find(g=>g.id===gameId);
      addLegToSlip({
        id: Date.now()+Math.random(),
        matchup: game ? `${game.away_team} @ ${game.home_team}` : 'MLB',
        side: `${pick.player} ${pick.side} ${pick.line} ${marketLabel(pick.market)}`,
        rows: pick.rows
      });
      showToast('Added ✓');
      const row = slipBtn.closest('tr');
      if(row) flashEl(row);
      return;
    }
    const row = e.target.closest('.pick-row');
    if(row){
      const key = row.dataset.key;
      state.expanded[key] = !state.expanded[key];
      renderPage();
    }
  });

  document.getElementById('gamesArea').addEventListener('keydown', (e)=>{
    if(e.target.closest('.pick-slip-btn,.analyze-btn')) return; // let the button handle its own Enter/Space
    if((e.key==='Enter'||e.key===' ') && e.target.closest('.pick-row,.props-market-label')){
      e.preventDefault();
      const row = e.target.closest('.pick-row');
      if(row){
        const key = row.dataset.key;
        state.expanded[key] = !state.expanded[key];
        renderPage();
      }
    }
  });

  loadGames();
})();
