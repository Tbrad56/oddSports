(function(){
  renderNav('cheatsheet');

  // ---------- Team search + full stat glossary (any team, any sport we track) ----------
  const teamState = { query: '', results: [], team: null, stats: null, loading: false, searchTimer: null, searchSeq: 0 };

  document.getElementById('teamSearchInput').addEventListener('input', (e)=>{
    teamState.query = e.target.value.trim();
    clearTimeout(teamState.searchTimer);
    if(teamState.query.length < 2){
      teamState.results = [];
      renderTeamSearch();
      return;
    }
    teamState.searchTimer = setTimeout(runTeamSearch, 250);
  });

  async function runTeamSearch(){
    const seq = ++teamState.searchSeq;
    try{
      const res = await fetch(`/api/teams/search?q=${encodeURIComponent(teamState.query)}`);
      if(!res.ok) throw new Error('Team search failed — try again shortly.');
      const data = await res.json();
      if(seq !== teamState.searchSeq) return;
      teamState.results = data.results || [];
      renderTeamSearch();
    }catch(e){
      if(seq === teamState.searchSeq) showError(e.message || 'Team search failed.');
    }
  }

  function renderTeamSearch(){
    const host = document.getElementById('teamSearchResults');
    if(!teamState.query || teamState.query.length < 2){
      host.innerHTML = '';
      return;
    }
    if(!teamState.results.length){
      host.innerHTML = `<div class="empty-state"><h3>No teams found</h3><p>No matches for "${escapeHtml(teamState.query)}" across NBA, NFL, or MLB.</p></div>`;
      return;
    }
    host.innerHTML = teamState.results.map(r=>`<div class="game-card team-result" data-sport="${escapeHtml(r.sport)}" data-id="${escapeHtml(String(r.id))}">
      ${r.logo ? `<img src="${escapeHtml(r.logo)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : ''}
      <div class="team-result-name">${escapeHtml(r.name)}</div>
      <span class="team-result-sport">${escapeHtml(r.sportLabel)}</span>
    </div>`).join('');
    host.querySelectorAll('.team-result').forEach(el=>{
      el.addEventListener('click', ()=>loadTeamStats(el.dataset.sport, el.dataset.id));
    });
  }

  async function loadTeamStats(sport, id){
    teamState.loading = true;
    teamState.stats = null;
    teamState.results = [];
    document.getElementById('teamSearchInput').value = '';
    teamState.query = '';
    resetRoster();
    renderTeamSearch();
    renderTeamStats();
    clearError();
    try{
      const res = await fetch(`/api/teams/stats?sport=${encodeURIComponent(sport)}&id=${encodeURIComponent(id)}`);
      if(!res.ok){
        let msg = 'Could not load stats for this team.';
        try{ const j = await res.json(); if(j.error) msg = j.error; }catch(_){}
        throw new Error(msg);
      }
      teamState.stats = await res.json();
    }catch(e){
      showError(e.message || 'Could not load stats for this team.');
    }finally{
      teamState.loading = false;
      renderTeamStats();
    }
  }

  // ---------- Roster: from a loaded team, jump straight to any player's stats ----------
  const rosterState = { open: false, loading: false, players: [], open2: {}, detail: {}, detailLoading: {} };

  function resetRoster(){
    rosterState.open = false;
    rosterState.loading = false;
    rosterState.players = [];
    rosterState.open2 = {};
    rosterState.detail = {};
    rosterState.detailLoading = {};
  }

  function rosterEndpoint(sport, teamId){
    if(sport === 'nba') return `/api/nba/roster?team=${encodeURIComponent(teamId)}`;
    if(sport === 'nfl') return `/api/nfl/roster?team=${encodeURIComponent(teamId)}`;
    return `/api/mlb/roster?team=${encodeURIComponent(teamId)}`;
  }
  function leagueKeyFor(sport){
    return sport === 'nba' ? 'basketball/nba' : sport === 'nfl' ? 'football/nfl' : 'baseball/mlb';
  }

  async function toggleRoster(){
    rosterState.open = !rosterState.open;
    if(rosterState.open && !rosterState.players.length && !rosterState.loading){
      rosterState.loading = true;
      renderTeamStats();
      try{
        const res = await fetch(rosterEndpoint(teamState.stats.sport, teamState.stats.team.id));
        if(!res.ok) throw new Error();
        const data = await res.json();
        rosterState.players = data.players || [];
      }catch(e){
        rosterState.players = [];
        showError('Could not load the roster — try again shortly.');
      }finally{
        rosterState.loading = false;
        renderTeamStats();
      }
      return;
    }
    renderTeamStats();
  }

  function playerStatTable(labels, statsRow){
    return `<div class="table-scroll"><table class="props-table"><thead><tr>${labels.map(l=>`<th>${escapeHtml(String(l))}</th>`).join('')}</tr></thead><tbody>
      <tr>${labels.map((_,i)=>`<td>${statsRow[i] !== undefined && statsRow[i] !== null && statsRow[i] !== '' ? escapeHtml(String(statsRow[i])) : '—'}</td>`).join('')}</tr>
    </tbody></table></div>`;
  }

  function playerDetailHtml(player, sport){
    if(rosterState.detailLoading[player.id]){
      return `<div class="hr-note" style="padding:0 0 12px;"><span class="spinner"></span> Loading stats…</div>`;
    }
    const d = rosterState.detail[player.id];
    if(!d) return '';
    let html = '';
    if(sport === 'mlb'){
      const m = d.mlb;
      if(!m || (!m.hitting && !m.pitching)){
        html += `<div class="hr-note">No season stats yet.</div>`;
      } else {
        if(m.hitting){
          const h = m.hitting;
          html += playerStatTable(['G','AB','H','HR','RBI','AVG','OBP','SLG','OPS','SB'],
            [h.gamesPlayed, h.atBats, h.hits, h.homeRuns, h.rbi, h.avg, h.obp, h.slg, h.ops, h.stolenBases]);
        }
        if(m.pitching){
          const p = m.pitching;
          html += playerStatTable(['G','IP','W-L','ERA','WHIP','K','BB','HR'],
            [p.gamesPlayed, p.inningsPitched, `${p.wins}-${p.losses}`, p.era, p.whip, p.strikeOuts, p.baseOnBalls, p.homeRuns]);
        }
      }
    } else {
      const e = d.espn;
      if(e && e.labels.length && e.splits.length){
        const split = e.splits[0];
        html += playerStatTable(e.labels, split.stats);
      } else {
        html += `<div class="hr-note">No season stats available for this player right now.</div>`;
      }
    }
    return html;
  }

  async function togglePlayerDetail(player, sport){
    if(rosterState.open2[player.id]){
      rosterState.open2[player.id] = false;
      renderTeamStats();
      return;
    }
    rosterState.open2[player.id] = true;
    if(!rosterState.detail[player.id] && !rosterState.detailLoading[player.id]){
      rosterState.detailLoading[player.id] = true;
      renderTeamStats();
      try{
        const url = sport === 'mlb'
          ? `/api/teams/roster-player?mlbId=${encodeURIComponent(player.mlbId)}`
          : `/api/stats/player?leagueKey=${encodeURIComponent(leagueKeyFor(sport))}&id=${encodeURIComponent(player.id)}&name=${encodeURIComponent(player.name)}`;
        const res = await fetch(url);
        rosterState.detail[player.id] = res.ok ? await res.json() : null;
      }catch(e){
        rosterState.detail[player.id] = null;
      }finally{
        rosterState.detailLoading[player.id] = false;
        renderTeamStats();
      }
      return;
    }
    renderTeamStats();
  }

  function rosterHtml(sport){
    if(!rosterState.open) return '';
    if(rosterState.loading){
      return `<div class="panel" style="margin-top:14px;"><div class="hr-note"><span class="spinner"></span> Loading roster…</div></div>`;
    }
    if(!rosterState.players.length){
      return `<div class="panel" style="margin-top:14px;"><div class="hr-note">No roster available right now.</div></div>`;
    }
    return `<div class="panel" style="margin-top:14px;">
      <h2 style="font-family:var(--font-display); font-size:22px; margin-bottom:12px;">Roster</h2>
      ${rosterState.players.map(p=>{
        const open = rosterState.open2[p.id];
        const photo = p.headshot
          ? `<img class="stat-headshot" src="${escapeHtml(p.headshot)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`
          : `<span class="stat-headshot stat-headshot-empty"></span>`;
        return `<div class="stat-card">
          <div class="stat-card-head" data-player-id="${escapeHtml(String(p.id))}">
            ${photo}
            <div class="stat-card-name">
              <div class="stat-player">${escapeHtml(p.name)}</div>
              <div class="stat-league">${escapeHtml(p.position || '')}</div>
            </div>
            <span class="market-arrow">${open?'▾':'▸'}</span>
          </div>
          <div class="stat-detail" style="display:${open?'block':'none'};">${open ? playerDetailHtml(p, sport) : ''}</div>
        </div>`;
      }).join('')}
    </div>`;
  }

  function glossaryRow(row){
    const cls = row.available ? 'glossary-value' : 'glossary-value na';
    const title = !row.available && row.why ? ` title="${escapeHtml(row.why)}"` : '';
    return `<div class="glossary-row">
      <span class="glossary-label">${escapeHtml(row.label)}</span>
      <span class="${cls}"${title}>${row.available ? escapeHtml(row.value) : 'N/A'}</span>
    </div>`;
  }

  function renderTeamStats(){
    const area = document.getElementById('teamStatsArea');
    if(teamState.loading){
      area.innerHTML = `<div class="panel"><div class="hr-note"><span class="spinner"></span> Loading team stats…</div></div>`;
      return;
    }
    const s = teamState.stats;
    if(!s){
      area.innerHTML = '';
      return;
    }
    area.innerHTML = `<div class="panel">
      <div class="glossary-head">
        ${s.team.logo ? `<img src="${escapeHtml(s.team.logo)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : ''}
        <div style="flex:1;">
          <div class="glossary-head-name">${escapeHtml(s.team.name)}</div>
          <div class="glossary-head-record">${s.record ? escapeHtml(s.record) : 'Record unavailable'}${s.homeRecord ? ` · Home ${escapeHtml(s.homeRecord)}` : ''}${s.roadRecord ? ` · Road ${escapeHtml(s.roadRecord)}` : ''}</div>
        </div>
        <button class="ghost" id="viewRosterBtn">${rosterState.open ? 'Hide Roster' : 'View Roster →'}</button>
      </div>
      <div class="glossary-groups">
        ${s.groups.map(g=>`<div class="game-card" style="padding:14px 16px;">
          <div class="glossary-group-title">${escapeHtml(g.title)}</div>
          ${g.rows.map(glossaryRow).join('')}
        </div>`).join('')}
      </div>
      <div class="hr-note" style="margin-top:10px;">Stats marked <em>N/A</em> aren't available from any free public data source — hover for why. Everything else is pulled live from ESPN / MLB StatsAPI.</div>
    </div>
    ${rosterHtml(s.sport)}`;
    staggerIn(area.querySelector('.panel'), 20);

    document.getElementById('viewRosterBtn').addEventListener('click', toggleRoster);
    area.querySelectorAll('.stat-card-head').forEach(head=>{
      const player = rosterState.players.find(p=>String(p.id)===head.dataset.playerId);
      if(!player) return;
      head.addEventListener('click', ()=>togglePlayerDetail(player, s.sport));
    });
  }

  // ---------- your current Slip, ranked (unchanged from before) ----------
  function renderSlipSection(){
    const slip = getSlip();
    const area = document.getElementById('cheatsheetArea');
    if(!slip.length){
      area.innerHTML = '';
      return;
    }

    let html = '<div class="hero-sub" style="margin-top:22px;">Your current Slip, every book compared — pick which one to actually bet with back on the Slip page.</div>';

    if(slip.length > 1){
      const bookSets = slip.map(leg => new Set(leg.rows.map(r=>r.bookKey)));
      const common = [...bookSets[0]].filter(k => bookSets.every(s=>s.has(k)));
      if(common.length){
        const results = common.map(bookKey=>{
          let decimal = 1;
          slip.forEach(leg=>{
            const row = leg.rows.find(r=>r.bookKey===bookKey);
            decimal *= americanToDecimal(row.odds);
          });
          return {bookKey, decimal};
        }).sort((a,b)=>b.decimal-a.decimal);

        html += `<div class="panel" style="margin-top:14px;">
          <h2>Parlay price by book</h2>
          <div style="font-size:12px; color:var(--text-dim); margin-bottom:6px;">All ${slip.length} legs, combined — every book that covers the full slip, ranked best to worst.</div>`;
        results.forEach(r=>{
          html += `<div class="parlay-line">
            ${linkedBadge(r.bookKey)}
            <span class="odds">${fmtAmerican(decimalToAmerican(r.decimal))}</span>
          </div>`;
        });
        html += `</div>`;
      }
    }

    slip.forEach(leg=>{
      html += `<div class="panel" style="margin-top:14px;">
        <h2>${escapeHtml(leg.side)}</h2>
        <div style="font-size:11.5px; color:var(--text-dim); margin-bottom:8px;">${escapeHtml(leg.matchup)}</div>`;
      leg.rows.forEach(r=>{
        const mine = r.bookKey === leg.selectedBookKey;
        html += `<div class="parlay-line"${mine ? ' style="background:rgba(187,0,0,0.08); border-radius:6px; padding-left:6px; padding-right:6px;"' : ''}>
          <div style="display:flex; align-items:center; gap:8px;">
            ${linkedBadge(r.bookKey, r.bookTitle)}
            ${mine ? '<span style="font-size:10.5px; color:var(--accent); font-weight:700;">YOUR PICK</span>' : ''}
          </div>
          <span class="odds">${fmtAmerican(r.odds)}</span>
        </div>`;
      });
      html += `</div>`;
    });

    area.innerHTML = html;
  }

  renderSlipSection();

  // fill the ticker quietly (server cache makes this cheap); ignore failures
  fetchOddsFor(getSport()).then(r=>updateTicker(r.games)).catch(()=>{});
})();
