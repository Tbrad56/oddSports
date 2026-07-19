(function(){
  const state = {
    query: '',
    league: 'ALL',
    results: [],
    open: {},      // athleteId -> true when the stat panel is expanded
    detail: {},    // athleteId -> fetched detail payload
    loading: {},   // athleteId -> true while detail fetch in flight
    searchTimer: null,
    searchSeq: 0
  };

  const LEAGUE_FILTERS = ['ALL', 'MLB', 'NBA', 'NFL', 'NHL', 'NCAAM', 'NCAAF', 'EPL', 'UFC', 'WNBA'];

  renderNav('stats');
  renderLeagueChips();

  document.getElementById('statsSearchInput').addEventListener('input', (e)=>{
    state.query = e.target.value.trim();
    clearTimeout(state.searchTimer);
    if(state.query.length < 2){
      state.results = [];
      renderResults();
      return;
    }
    // Debounced so we search once per pause, not per keystroke
    state.searchTimer = setTimeout(runSearch, 300);
  });

  function renderLeagueChips(){
    const host = document.getElementById('leagueChips');
    host.innerHTML = LEAGUE_FILTERS.map(l=>
      `<button class="chip${state.league===l?' active':''}" data-league="${l}">${l==='ALL'?'All leagues':l}</button>`
    ).join('');
    host.querySelectorAll('.chip').forEach(chip=>{
      chip.addEventListener('click', ()=>{
        state.league = chip.dataset.league;
        renderLeagueChips();
        renderResults();
      });
    });
  }

  async function runSearch(){
    const seq = ++state.searchSeq;
    clearError();
    try{
      const res = await fetch(`/api/stats/search?q=${encodeURIComponent(state.query)}`);
      if(!res.ok) throw new Error('Search failed — try again shortly.');
      const data = await res.json();
      if(seq !== state.searchSeq) return; // a newer search superseded this one
      state.results = data.results || [];
      state.open = {}; state.detail = {};
      renderResults();
    }catch(e){
      if(seq === state.searchSeq) showError(e.message || 'Search failed.');
    }
  }

  function filteredResults(){
    return state.league === 'ALL'
      ? state.results
      : state.results.filter(r=>r.league === state.league);
  }

  function renderResults(){
    const area = document.getElementById('statsArea');
    const results = filteredResults();
    if(!state.query || state.query.length < 2){
      area.innerHTML = '<div class="empty-state"><h3>Look up any player</h3><p>Start typing a name — results appear as you type. Tap a player to open their stats.</p></div>';
      return;
    }
    if(!results.length){
      area.innerHTML = `<div class="empty-state"><h3>No players found</h3><p>No ${state.league==='ALL'?'':state.league+' '}matches for "${escapeHtml(state.query)}". Try the full last name.</p></div>`;
      return;
    }
    area.innerHTML = results.map(r=>{
      const open = state.open[r.athleteId];
      const photo = r.headshot
        ? `<img class="stat-headshot" src="${escapeHtml(r.headshot)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`
        : `<span class="stat-headshot stat-headshot-empty"></span>`;
      return `<div class="game-card stat-card" data-athlete="${escapeHtml(r.athleteId)}" data-league-key="${escapeHtml(r.leagueKey)}" data-name="${escapeHtml(r.name)}">
        <div class="stat-card-head">
          ${photo}
          <div class="stat-card-name">
            <div class="stat-player">${escapeHtml(r.name)}</div>
            <div class="stat-league">${escapeHtml(r.league)}</div>
          </div>
          <span class="market-arrow">${open?'▾':'▸'}</span>
        </div>
        <div class="stat-detail" style="display:${open?'block':'none'};">${open ? detailHtml(r) : ''}</div>
      </div>`;
    }).join('');

    area.querySelectorAll('.stat-card .stat-card-head').forEach(head=>{
      head.addEventListener('click', ()=>toggleCard(head.parentElement));
    });
  }

  function detailHtml(r){
    if(state.loading[r.athleteId]){
      return `<div class="hr-note" style="padding:0 0 12px;"><span class="spinner"></span> Loading stats…</div>`;
    }
    const d = state.detail[r.athleteId];
    if(!d) return '';
    let html = '';

    // MLB deep block from StatsAPI when we have it
    if(d.mlb){
      const meta = [d.mlb.team, d.mlb.position, `${d.mlb.season} season`].filter(Boolean).join(' · ');
      html += `<div class="hr-note" style="margin:0 0 6px;">${escapeHtml(meta)}</div>`;
      if(d.mlb.hitting){
        const h = d.mlb.hitting;
        html += statTable(['G','AB','H','HR','RBI','BA','OBP','SLG','OPS','SB'],
          [[h.gamesPlayed, h.atBats, h.hits, h.homeRuns, h.rbi, h.avg, h.obp, h.slg, h.ops, h.stolenBases]], ['Hitting']);
      }
      if(d.mlb.pitching){
        const p = d.mlb.pitching;
        html += statTable(['G','IP','W-L','ERA','WHIP','K','BB','HR'],
          [[p.gamesPlayed, p.inningsPitched, `${p.wins}-${p.losses}`, p.era, p.whip, p.strikeOuts, p.baseOnBalls, p.homeRuns]], ['Pitching']);
      }
    }

    // ESPN overview block (every league, including MLB as a career view)
    if(d.espn && d.espn.labels.length && d.espn.splits.length){
      html += statTable(d.espn.labels, d.espn.splits.map(s=>s.stats), d.espn.splits.map(s=>s.name));
    }

    if(!html){
      html = `<div class="hr-note">No stats available for this player right now.</div>`;
    }
    return html;
  }

  function statTable(labels, rowsOfStats, rowNames){
    let html = `<div class="table-scroll"><table class="props-table"><thead><tr><th></th>${labels.map(l=>`<th>${escapeHtml(String(l))}</th>`).join('')}</tr></thead><tbody>`;
    rowsOfStats.forEach((stats, i)=>{
      html += `<tr><td style="font-weight:600; white-space:nowrap;">${escapeHtml(String(rowNames[i] ?? ''))}</td>`
        + labels.map((_, j)=>`<td>${stats && stats[j] !== undefined && stats[j] !== null ? escapeHtml(String(stats[j])) : '—'}</td>`).join('')
        + `</tr>`;
    });
    html += `</tbody></table></div>`;
    return html;
  }

  async function toggleCard(card){
    const id = card.dataset.athlete;
    if(state.open[id]){
      state.open[id] = false;
      renderResults();
      return;
    }
    state.open[id] = true;
    if(!state.detail[id] && !state.loading[id]){
      state.loading[id] = true;
      renderResults();
      try{
        const res = await fetch(`/api/stats/player?leagueKey=${encodeURIComponent(card.dataset.leagueKey)}&id=${encodeURIComponent(id)}&name=${encodeURIComponent(card.dataset.name)}`);
        state.detail[id] = res.ok ? await res.json() : null;
      }catch(e){
        state.detail[id] = null;
      }finally{
        state.loading[id] = false;
      }
    }
    renderResults();
  }

  loadGamesTicker();
  async function loadGamesTicker(){
    try{
      const {games} = await fetchOddsFor('baseball_mlb');
      updateTicker(games);
    }catch(e){ /* ticker is decorative here */ }
  }
})();
