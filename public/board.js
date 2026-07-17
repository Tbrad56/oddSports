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
    pitchers: {}   // gameId -> {matched, home:{id,name}|null, away:{id,name}|null}
  };
  let renderScheduled = false;
  // Coalesces multiple renderGames() requests (weather/pitchers post-fetches, audit 6.2)
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
        fetchStartingPitchers(games).then(scheduleRender).catch(()=>{});
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
          perPlayer[rowKey].rows.push({bookKey:bm.key, bookTitle:bm.title, odds:o.price, link:o.link||bm.link||null, sid:o.sid||null, marketSid:market.sid||null});
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
        const mlbId = data.mlbIds && data.mlbIds[entry.player.toLowerCase()];
        const avatar = mlbId ? playerAvatarHtml(mlbId, 20) : emptyAvatarHtml(20);
        html += `<tr>
          <td style="font-weight:600; white-space:nowrap;">${avatar}${escapeHtml(entry.player)}</td>
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
    html += `<table class="props-table"><thead><tr><th>Split</th><th>IP</th><th>WHIP</th><th>HR</th><th>HR/9</th></tr></thead><tbody>`;
    rows.forEach(([code, label])=>{
      const st = pitcher.rows[code];
      if(!st) return;
      html += `<tr><td>${label}</td><td>${st.ip !== null ? escapeHtml(String(st.ip)) : '—'}</td><td>${st.whip !== null ? escapeHtml(String(st.whip)) : '—'}</td>`
        + `<td>${st.hr !== null ? st.hr : '—'}</td>`
        + statCell(st.hr9, 1.4, 0.8, n=>n.toFixed(2))
        + `</tr>`;
    });
    html += `</tbody></table>`;
    return html;
  }

  function batterTableHtml(teamName, side, hrOdds, statcast){
    if(!side.lineupPosted){
      return `<div class="hr-pitcher" style="margin-top:12px;">${escapeHtml(teamName)} lineup</div>`
        + `<div class="hr-note">Lineups usually post 2-4 hours before first pitch.</div>`;
    }
    const scCols = statcast ? '<th>EV</th><th>Barrel%</th><th>HardHit%</th>' : '';
    let html = `<div class="hr-pitcher" style="margin-top:12px;">${escapeHtml(teamName)} lineup <span class="lineup-tag confirmed">✓ Confirmed</span></div>`;
    html += `<table class="props-table"><thead><tr><th>Batter</th><th>HR odds</th><th>HR</th><th>BA</th><th>OBP</th><th>SLG</th><th>ISO</th>${scCols}</tr></thead><tbody>`;
    side.batters.forEach(b=>{
      const odds = hrOdds[b.name.toLowerCase()];
      const style = odds ? bookStyleFor(odds.bookKey) : null;
      const link = odds ? BOOK_LINKS[odds.bookKey.toLowerCase()] : null;
      const oddsCell = odds
        ? `<td><span class="odds-chip best">${escapeHtml(style ? style.name : odds.bookTitle)} ${fmtAmerican(odds.odds)}</span>${link ? ` <a class="book-link-btn" href="${link}" target="_blank" rel="noopener">↗</a>` : ''}</td>`
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
        + `<td>${b.hr !== null ? b.hr : '—'}</td>`
        + statCell(b.ba, 0.280, 0.230, n=>n.toFixed(3))
        + statCell(b.obp, 0.350, 0.300, n=>n.toFixed(3))
        + statCell(b.slg, 0.480, 0.370, n=>n.toFixed(3))
        + statCell(b.iso, 0.200, 0.130, n=>n.toFixed(3))
        + scCells
        + `</tr>`;
    });
    html += `</tbody></table>`;
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
    html += `<div class="hr-note">Bands are league-average context, not picks.</div>`;
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
        const weatherHtml = buildWeatherStrip(game);
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
      if(sportKey === 'baseball_mlb'){
        const view = state.oddsView[game.id] === 'f5' ? 'f5' : 'full';
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

        if(view === 'f5'){
          const renderedAny = renderOddsBlocks('h2h_1st_5_innings');
          if(!renderedAny){
            const note = document.createElement('div');
            note.className = 'empty-state f5-empty';
            note.innerHTML = '<p>F5 lines not posted yet.</p>';
            card.appendChild(note);
          }
        } else {
          renderOddsBlocks('h2h');
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
