(function(){
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
  const PROP_MARKETS = {
    americanfootball_nfl:["player_pass_yds","player_pass_tds","player_rush_yds","player_receptions","player_reception_yds","player_anytime_td"],
    americanfootball_ncaaf:["player_pass_yds","player_pass_tds","player_rush_yds","player_receptions","player_reception_yds","player_anytime_td"],
    basketball_nba:["player_points","player_rebounds","player_assists","player_threes","player_points_rebounds_assists"],
    basketball_ncaab:["player_points","player_rebounds","player_assists","player_threes"],
    baseball_mlb:["batter_hits","batter_home_runs","batter_total_bases","batter_rbis","pitcher_strikeouts"],
    icehockey_nhl:["player_points","player_assists","player_shots_on_goal","player_goal_scorer_anytime"]
  };

  let state = {
    games: [],
    slip: [],       // {id, matchup, side, odds:{bookKey: americanOdds}, chosenBook}
    manual: [],
    autoRefresh: false,
    autoTimer: null,
    searchTerm: '',
    propsCache: {},  // gameId -> {game, data, sportKey}
    propRegistry: {},// propId -> {side, matchup, rows} for + Slip buttons
    propIdCounter: 0,
    propsBookFilter: 'all', // 'all' or a book key like 'fanduel'
    propsCollapsed: {},     // gameId -> true when a game's props section is collapsed
    marketCollapsed: {}     // "gameId|marketKey" -> true when a market section is collapsed
  };

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

  // ---------- populate sport select (hidden, kept as the source of truth) + chips ----------
  const sportSelect = document.getElementById('sportSelect');
  const chipRow = document.getElementById('sportChips');
  SPORTS.forEach(([key,label], idx)=>{
    const o = document.createElement('option');
    o.value = key; o.textContent = label;
    sportSelect.appendChild(o);

    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (idx===0 ? ' active' : '');
    chip.textContent = label;
    chip.addEventListener('click', ()=>{
      sportSelect.value = key;
      [...chipRow.children].forEach(c=>c.classList.remove('active'));
      chip.classList.add('active');
      fetchOdds();
    });
    chipRow.appendChild(chip);
  });

  // ---------- nav rail (Board / Props / Bet Slip / Screenshots / Settings) ----------
  const settingsPanel = document.getElementById('settingsPanel');
  const slipPanel = document.getElementById('slipPanel');
  const shotsPanel = document.getElementById('shotsPanel');
  const gamesArea = document.getElementById('gamesArea');
  const propsArea = document.getElementById('propsArea');
  const navBoardBtn = document.getElementById('navBoard');

  function setActiveRail(id){
    ['navBoard','navProps','navSlip','navShots','navSettings'].forEach(rid=>{
      document.getElementById(rid).classList.toggle('active', rid===id);
    });
  }
  function showView(view){ // 'board' | 'props'
    gamesArea.style.display = view==='board' ? 'block' : 'none';
    propsArea.style.display = view==='props' ? 'block' : 'none';
  }
  navBoardBtn.addEventListener('click', ()=>{
    setActiveRail('navBoard');
    settingsPanel.style.display = 'none';
    showView('board');
    gamesArea.scrollIntoView({behavior:'smooth', block:'start'});
  });
  document.getElementById('navProps').addEventListener('click', ()=>{
    setActiveRail('navProps');
    settingsPanel.style.display = 'none';
    renderPropsView();
    showView('props');
    propsArea.scrollIntoView({behavior:'smooth', block:'start'});
  });
  document.getElementById('navSlip').addEventListener('click', ()=>{
    setActiveRail('navSlip');
    settingsPanel.style.display = 'none';
    slipPanel.scrollIntoView({behavior:'smooth', block:'start'});
  });
  document.getElementById('navShots').addEventListener('click', ()=>{
    setActiveRail('navShots');
    settingsPanel.style.display = 'none';
    shotsPanel.scrollIntoView({behavior:'smooth', block:'start'});
  });
  document.getElementById('navSettings').addEventListener('click', ()=>{
    setActiveRail('navSettings');
    settingsPanel.style.display = settingsPanel.style.display === 'none' ? 'block' : 'none';
    if(settingsPanel.style.display === 'block') settingsPanel.scrollIntoView({behavior:'smooth', block:'start'});
  });

  function setStatus(live, text){
    document.getElementById('statusDot').className = 'dot' + (live ? ' live' : '');
    document.getElementById('statusText').textContent = text;
  }

  function showError(msg){
    const area = document.getElementById('errorArea');
    area.innerHTML = '<div class="error-msg">'+escapeHtml(msg)+'</div>';
  }
  function clearError(){ document.getElementById('errorArea').innerHTML = ''; }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // ---------- fetch odds ----------
  async function fetchOdds(){
    clearError();
    const sport = sportSelect.value;
    const btn = document.getElementById('fetchBtn');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
    setStatus(false, 'Fetching latest odds…');
    try{
      const res = await fetch(`/api/odds/${sport}`);
      if(!res.ok){
        let msg = `Error ${res.status}`;
        try{ const j = await res.json(); if(j.error) msg = j.error; }catch(_){}
        throw new Error(msg);
      }
      const data = await res.json();
      state.games = data;
      state.propsCache = {};
      state.propRegistry = {};
      state.propsCollapsed = {};
      state.marketCollapsed = {};
      renderGames();
      updateTicker();
      renderCheatsheet();
      renderPropsView();
      const remaining = res.headers.get('x-requests-remaining');
      const cacheAge = Number(res.headers.get('x-cache-age-seconds') || 0);
      const freshness = cacheAge >= 60
        ? `cached ${Math.round(cacheAge/60)} min ago`
        : `updated ${new Date().toLocaleTimeString()}`;
      setStatus(true, `Live — ${data.length} games loaded${remaining ? ' · '+remaining+' requests left this month' : ''} · ${freshness}`);
    }catch(e){
      setStatus(false, 'Fetch failed.');
      showError(e.message || 'Could not fetch odds — try again shortly.');
    }finally{
      btn.disabled = false; btn.textContent = 'Get Odds';
    }
  }
  document.getElementById('fetchBtn').addEventListener('click', fetchOdds);

  document.getElementById('autoBtn').addEventListener('click', function(){
    state.autoRefresh = !state.autoRefresh;
    this.textContent = 'Auto: ' + (state.autoRefresh ? 'On (10m)' : 'Off');
    if(state.autoRefresh){
      state.autoTimer = setInterval(fetchOdds, 10*60*1000);
    }else{
      clearInterval(state.autoTimer);
    }
  });

  // ---------- render games ----------
  function bookStyleFor(key){
    const k = key.toLowerCase();
    return BOOK_STYLES[k] || null;
  }

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
            addLeg(game, team, rows);
          });
          block.appendChild(row);
        });
        card.appendChild(block);
      });

      // ---- player props (opt-in) ----
      const sportKey = sportSelect.value;
      if(PROP_MARKETS[sportKey]){
        const toggleWrap = document.createElement('div');
        toggleWrap.className = 'props-toggle';
        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'ghost';
        toggleBtn.textContent = 'Load player props';
        toggleWrap.appendChild(toggleBtn);
        card.appendChild(toggleWrap);

        const propsHost = document.createElement('div');
        propsHost.style.display = 'none';
        card.appendChild(propsHost);

        toggleBtn.addEventListener('click', async ()=>{
          if(propsHost.style.display === 'none' && !propsHost.dataset.loaded){
            toggleBtn.disabled = true;
            toggleBtn.innerHTML = '<span class="spinner"></span> Loading…';
            await loadProps(game, sportKey, propsHost);
            propsHost.dataset.loaded = '1';
            toggleBtn.disabled = false;
            toggleBtn.textContent = 'Hide player props';
            propsHost.style.display = 'block';
            // add a jump link to this game's section in the Props tab
            if(state.propsCache[game.id] && !toggleWrap.querySelector('.props-jump')){
              const jump = document.createElement('button');
              jump.className = 'ghost props-jump';
              jump.style.marginLeft = '8px';
              jump.textContent = 'View in Props tab →';
              jump.addEventListener('click', ()=>{
                document.getElementById('navProps').click();
                setTimeout(()=>{
                  const el = document.getElementById('propgame-' + game.id);
                  if(el) el.scrollIntoView({behavior:'smooth', block:'start'});
                }, 80);
              });
              toggleWrap.appendChild(jump);
            }
          } else {
            const showing = propsHost.style.display !== 'none';
            propsHost.style.display = showing ? 'none' : 'block';
            toggleBtn.textContent = showing ? 'Show player props' : 'Hide player props';
          }
        });
      }

      wrap.appendChild(card);
    });
    area.appendChild(wrap);
  }

  document.getElementById('searchInput').addEventListener('input', (e)=>{
    state.searchTerm = e.target.value;
    if(state.games.length) renderGames();
    if(propsArea.style.display !== 'none') renderPropsView();
  });

  // ---------- player props (PropFinder-style dense table with line-shop chips) ----------
  async function loadProps(game, sportKey, hostEl){
    const markets = PROP_MARKETS[sportKey];
    try{
      const res = await fetch(`/api/props/${sportKey}/${game.id}`);
      if(!res.ok){
        hostEl.innerHTML = `<div class="props-block"><span style="color:var(--text-faint); font-size:12.5px;">Props aren't available for this game right now (either not offered yet, or not included on your API plan).</span></div>`;
        return;
      }
      const data = await res.json();
      state.propsCache[game.id] = {game, data, sportKey};
      hostEl.innerHTML = buildPropsHtml(game, data, markets, false);
      renderPropsView();
    }catch(e){
      hostEl.innerHTML = `<div class="props-block"><span style="color:var(--text-faint); font-size:12.5px;">Couldn't load props right now.</span></div>`;
    }
  }

  // Shared renderer for a game's props. showGameCol adds a Game column and applies
  // the book filter (both used in the Props view).
  function buildPropsHtml(game, data, markets, showGameCol){
    let bms = (data.bookmakers || []).filter(b => TRACKED_KEYS.includes(b.key.toLowerCase()));
    let bookmakersToUse = bms.length ? bms : (data.bookmakers || []);
    if(showGameCol && state.propsBookFilter !== 'all'){
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
      if(term && showGameCol){
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
      html += `<table class="props-table"><thead><tr><th>Player</th><th>Line</th>${showGameCol?'<th>Game</th>':''}<th>Line shop (best → worst)</th><th></th></tr></thead><tbody>`;
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
          ${showGameCol?`<td style="color:var(--text-faint); font-size:11px; white-space:nowrap;">${escapeHtml(matchup)}</td>`:''}
          <td><div class="line-shop">${chips}</div></td>
          <td><button class="add-leg-btn prop-slip-btn" data-prop-id="${propId}">+ Slip</button></td>
        </tr>`;
      });
      html += `</tbody></table></div>`;
    });
    if(!any){
      html += `<span style="color:var(--text-faint); font-size:12.5px;">${term && showGameCol ? 'No props match your search in this game.' : 'No player props posted for this game yet — check back closer to game time.'}</span>`;
    }
    html += '</div>';
    return html;
  }

  // Event delegation: + Slip buttons and collapsible market headers inside props tables
  document.addEventListener('click', (e)=>{
    const marketHead = e.target.closest('.prop-market-head');
    if(marketHead){
      const key = marketHead.dataset.sectionKey;
      const nowCollapsed = !state.marketCollapsed[key];
      state.marketCollapsed[key] = nowCollapsed;
      // toggle in-place (works in both Board and Props views without a re-render)
      const body = marketHead.nextElementSibling;
      if(body && body.classList.contains('market-body')){
        body.style.display = nowCollapsed ? 'none' : '';
      }
      const arrow = marketHead.querySelector('.market-arrow');
      if(arrow) arrow.textContent = nowCollapsed ? '▸' : '▾';
      marketHead.title = 'Click to ' + (nowCollapsed ? 'expand' : 'collapse');
      return;
    }
    const btn = e.target.closest('.prop-slip-btn');
    if(!btn) return;
    const prop = state.propRegistry[btn.dataset.propId];
    if(!prop) return;
    state.slip.push({
      id: Date.now()+Math.random(),
      matchup: prop.matchup,
      side: prop.side,
      rows: prop.rows
    });
    renderSlip();
    btn.textContent = 'Added ✓';
    setTimeout(()=>{ btn.textContent = '+ Slip'; }, 1200);
  });

  // ---------- Props view (aggregated sections across loaded games) ----------
  function renderPropsView(){
    const area = document.getElementById('propsArea');
    const cached = Object.values(state.propsCache);
    if(!cached.length){
      area.innerHTML = `<div class="empty-state">
        <h3>No props loaded yet</h3>
        <p>Player props load per game to protect your API quota. Go to the Board, hit "Load player props" on any game, and each game's props will collect here in market sections.</p>
      </div>`;
      return;
    }

    // Book filter chips: All + each tracked book actually present in cached props
    const booksPresent = new Set();
    cached.forEach(({data})=>{
      (data.bookmakers||[]).forEach(b=>{
        const k = b.key.toLowerCase();
        if(TRACKED_KEYS.includes(k)) booksPresent.add(k);
      });
    });
    let html = '<div class="chip-row">';
    html += `<button class="chip props-filter-chip${state.propsBookFilter==='all'?' active':''}" data-book="all">All books</button>`;
    // FanDuel pinned first when present
    const orderedBooks = [...booksPresent].sort((a,b)=> (a==='fanduel'?-1:b==='fanduel'?1:a.localeCompare(b)));
    orderedBooks.forEach(k=>{
      const style = bookStyleFor(k);
      html += `<button class="chip props-filter-chip${state.propsBookFilter===k?' active':''}" data-book="${k}">${escapeHtml(style?style.name:k)}</button>`;
    });
    html += '</div>';

    // Game-jump chips
    html += '<div class="chip-row">';
    cached.forEach(({game})=>{
      html += `<button class="chip game-jump-chip" data-game-id="${escapeHtml(game.id)}">${escapeHtml(game.away_team)} @ ${escapeHtml(game.home_team)}</button>`;
    });
    html += '</div>';

    cached.forEach(({game, data, sportKey})=>{
      const when = new Date(game.commence_time);
      const collapsed = state.propsCollapsed[game.id];
      html += `<div class="game-card" style="margin-bottom:14px;" id="propgame-${escapeHtml(game.id)}">
        <div class="game-head prop-game-head" data-game-id="${escapeHtml(game.id)}" style="cursor:pointer;" title="Click to ${collapsed?'expand':'collapse'}">
          <div class="game-teams">${escapeHtml(game.away_team)}<span class="vs">@</span>${escapeHtml(game.home_team)}</div>
          <div class="game-time">${when.toLocaleDateString(undefined,{month:'short',day:'numeric'})} · ${when.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})} &nbsp;${collapsed?'▸':'▾'}</div>
        </div>
        <div class="prop-body" style="${collapsed?'display:none;':''}">
          ${buildPropsHtml(game, data, PROP_MARKETS[sportKey] || [], true)}
        </div>
      </div>`;
    });
    area.innerHTML = html;
  }

  // Delegated clicks inside the Props view: filter chips, game jump chips, collapsible headers
  document.getElementById('propsArea').addEventListener('click', (e)=>{
    const filterChip = e.target.closest('.props-filter-chip');
    if(filterChip){
      state.propsBookFilter = filterChip.dataset.book;
      renderPropsView();
      return;
    }
    const jumpChip = e.target.closest('.game-jump-chip');
    if(jumpChip){
      const el = document.getElementById('propgame-' + jumpChip.dataset.gameId);
      if(el){
        state.propsCollapsed[jumpChip.dataset.gameId] = false;
        renderPropsView();
        document.getElementById('propgame-' + jumpChip.dataset.gameId).scrollIntoView({behavior:'smooth', block:'start'});
      }
      return;
    }
    const head = e.target.closest('.prop-game-head');
    if(head){
      const id = head.dataset.gameId;
      state.propsCollapsed[id] = !state.propsCollapsed[id];
      renderPropsView();
    }
  });

  function marketLabel(key){
    const labels = {
      player_pass_yds:"Passing Yards", player_pass_tds:"Passing TDs", player_rush_yds:"Rushing Yards",
      player_receptions:"Receptions", player_reception_yds:"Receiving Yards", player_anytime_td:"Anytime TD",
      player_points:"Points", player_rebounds:"Rebounds", player_assists:"Assists",
      player_threes:"Threes Made", player_points_rebounds_assists:"Pts + Reb + Ast",
      batter_hits:"Batter Hits", batter_home_runs:"Home Runs", batter_total_bases:"Total Bases",
      batter_rbis:"RBIs", pitcher_strikeouts:"Pitcher Strikeouts",
      player_shots_on_goal:"Shots on Goal", player_goal_scorer_anytime:"Anytime Goalscorer"
    };
    return labels[key] || key;
  }

  function updateTicker(){
    const track = document.getElementById('tickerTrack');
    const items = [];
    state.games.slice(0,12).forEach(game=>{
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

  // ---------- cheatsheet (PropFinder-style "best value" quick list) ----------
  function renderCheatsheet(){
    const body = document.getElementById('cheatBody');
    const countEl = document.getElementById('cheatCount');
    const picks = [];

    state.games.forEach(game=>{
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
        if(!fairDecimal) return;
        const best = rows[0];
        const edgePct = (americanToDecimal(best.odds)/fairDecimal - 1) * 100;
        if(edgePct > 1.5){
          const style = bookStyleFor(best.bookKey);
          picks.push({
            side: team, matchup: `${game.away_team} @ ${game.home_team}`,
            odds: best.odds, bookName: style ? style.name : best.bookTitle, edgePct
          });
        }
      });
    });

    picks.sort((a,b)=>b.edgePct - a.edgePct);
    const top = picks.slice(0,8);
    countEl.textContent = top.length ? top.length + ' spots' : '';

    if(!top.length){
      body.innerHTML = state.games.length
        ? 'No standout value spots in this batch of games right now — odds are tightly bunched across books.'
        : 'Load odds for a sport and the best value spots will show up here.';
      return;
    }
    body.innerHTML = top.map(p=>`
      <div class="cheat-row">
        <div>
          <div class="cheat-side">${escapeHtml(p.side)}</div>
          <div class="cheat-sub">${escapeHtml(p.matchup)} · ${escapeHtml(p.bookName)}</div>
        </div>
        <div class="cheat-odds">${fmtAmerican(p.odds)}</div>
      </div>
    `).join('');
  }
  function addLeg(game, team, rows){
    const leg = {
      id: Date.now()+Math.random(),
      matchup: `${game.away_team} @ ${game.home_team}`,
      side: team,
      rows: rows // sorted best->worst, each {bookKey,bookTitle,odds}
    };
    state.slip.push(leg);
    renderSlip();
  }
  function removeLeg(id){
    state.slip = state.slip.filter(l=>l.id!==id);
    renderSlip();
  }

  function renderSlip(){
    const legsEl = document.getElementById('slipLegs');
    const emptyEl = document.getElementById('slipEmpty');
    const countEl = document.getElementById('slipCount');
    countEl.textContent = state.slip.length + ' leg' + (state.slip.length===1?'':'s');
    legsEl.innerHTML = '';
    emptyEl.style.display = state.slip.length ? 'none' : 'block';

    state.slip.forEach(leg=>{
      const best = leg.rows[0];
      const style = bookStyleFor(best.bookKey);
      const div = document.createElement('div');
      div.className = 'leg-item';
      div.innerHTML = `
        <div class="leg-top">
          <div>
            <div class="leg-title">${escapeHtml(leg.side)}</div>
            <div class="leg-sub">${escapeHtml(leg.matchup)}</div>
          </div>
          <button class="remove-btn" title="Remove">×</button>
        </div>
        <div class="leg-odds">${fmtAmerican(best.odds)} · best at ${
          BOOK_LINKS[best.bookKey.toLowerCase()]
            ? `<a href="${BOOK_LINKS[best.bookKey.toLowerCase()]}" target="_blank" rel="noopener">${escapeHtml(style ? style.name : best.bookTitle)} ↗</a>`
            : escapeHtml(style ? style.name : best.bookTitle)
        }</div>
      `;
      div.querySelector('.remove-btn').addEventListener('click', ()=>removeLeg(leg.id));
      legsEl.appendChild(div);
    });

    renderParlay();
  }

  function renderParlay(){
    const area = document.getElementById('parlayArea');
    if(state.slip.length < 1){ area.innerHTML=''; return; }

    if(state.slip.length === 1){
      const leg = state.slip[0];
      const best = leg.rows[0];
      const style = bookStyleFor(best.bookKey);
      area.innerHTML = `
        <div class="parlay-result">
          <div style="font-size:12px; color:var(--text-dim); margin-bottom:6px;">Single bet — best price</div>
          <div class="parlay-line">
            ${linkedBadge(best.bookKey, best.bookTitle)}
            <span class="odds">${fmtAmerican(best.odds)}</span>
          </div>
        </div>
      `;
      return;
    }

    // find books common to every leg
    const bookSets = state.slip.map(leg => new Set(leg.rows.map(r=>r.bookKey)));
    const common = [...bookSets[0]].filter(k => bookSets.every(s=>s.has(k)));

    let html = '<div class="parlay-result">';
    if(common.length){
      html += `<div style="font-size:12px; color:var(--text-dim); margin-bottom:6px;">Parlay price by book (all legs on one book)</div>`;
      const results = common.map(bookKey=>{
        let decimal = 1;
        state.slip.forEach(leg=>{
          const row = leg.rows.find(r=>r.bookKey===bookKey);
          decimal *= americanToDecimal(row.odds);
        });
        return {bookKey, decimal};
      }).sort((a,b)=>b.decimal-a.decimal);

      results.forEach(r=>{
        const american = decimalToAmerican(r.decimal);
        html += `<div class="parlay-line">
          ${linkedBadge(r.bookKey)}
          <span class="odds">${fmtAmerican(american)}</span>
        </div>`;
      });

      const bestBookKey = results[0].bookKey;
      const bestStyle = bookStyleFor(bestBookKey);
      html += `<div class="copy-block">${buildCopyText(bestBookKey, bestStyle ? bestStyle.name : bestBookKey)}</div>`;
    } else {
      html += `<div style="font-size:12px; color:var(--text-dim); margin-bottom:6px;">No single book covers every leg. Best price per leg (mixed books, informational only):</div>`;
      let decimal = 1;
      state.slip.forEach(leg=>{
        const best = leg.rows[0];
        decimal *= americanToDecimal(best.odds);
        html += `<div class="parlay-line">
          ${linkedBadge(best.bookKey, best.bookTitle)}
          <span class="odds">${fmtAmerican(best.odds)}</span>
        </div>`;
      });
      html += `<div style="font-size:11.5px; color:var(--text-faint); margin-top:6px;">Combined (theoretical, can't actually be placed as one parlay): ${fmtAmerican(decimalToAmerican(decimal))}</div>`;
    }
    html += '</div>';
    area.innerHTML = html;
  }

  // Wrap a book badge in a link to that sportsbook when we have one
  function linkedBadge(bookKey, fallbackTitle){
    const style = bookStyleFor(bookKey);
    const inner = style
      ? `<div class="book-badge" style="background:${style.color};">${escapeHtml(style.name)}</div>`
      : `<span>${escapeHtml(fallbackTitle || bookKey)}</span>`;
    const link = BOOK_LINKS[bookKey.toLowerCase()];
    return link ? `<a href="${link}" target="_blank" rel="noopener" style="text-decoration:none;" title="Open ${escapeHtml(style?style.name:fallbackTitle||bookKey)}">${inner}</a>` : inner;
  }

  function buildCopyText(bookKey, bookName){
    let lines = [`${escapeHtml(bookName)} parlay slip:`];
    state.slip.forEach(leg=>{
      const row = leg.rows.find(r=>r.bookKey===bookKey);
      lines.push(`• ${escapeHtml(leg.side)} (${escapeHtml(leg.matchup)}) — ${fmtAmerican(row.odds)}`);
    });
    return lines.join('\n');
  }

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
  function renderManual(){
    const area = document.getElementById('manualEntries');
    area.innerHTML = '';
    state.manual.forEach((m,i)=>{
      const div = document.createElement('div');
      div.className = 'manual-entry';
      const body = m.isLink ? `<a href="${escapeHtml(m.text)}" target="_blank" rel="noopener">${escapeHtml(m.text)}</a>` : escapeHtml(m.text);
      div.innerHTML = `<div class="tagline">${escapeHtml(m.tagline)}</div><div>${body}</div>`;
      area.appendChild(div);
    });
  }

  // ---------- init ----------
  renderSlip();
})();
