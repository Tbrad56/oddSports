(function(){
  const state = {
    teams: [],
    matchup: null,     // /api/nba/matchup payload
    rosters: {},       // teamId -> players[]
    playerForm: {},    // playerId -> form payload
    analyzerPlayer: null,
    hotScan: null      // null | 'loading' | [{player, form}]
  };

  renderNav('nba');

  // ---------- boot: teams into the pickers ----------
  (async function loadTeams(){
    try{
      const res = await fetch('/api/nba/teams');
      const data = await res.json();
      state.teams = data.teams || [];
      const opts = state.teams.map(t=>`<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`).join('');
      document.getElementById('awaySelect').innerHTML = opts;
      document.getElementById('homeSelect').innerHTML = opts;
      // A recognizable default matchup
      const bos = state.teams.find(t=>t.abbrev==='BOS'), lal = state.teams.find(t=>t.abbrev==='LAL');
      if(lal) document.getElementById('awaySelect').value = lal.id;
      if(bos) document.getElementById('homeSelect').value = bos.id;
    }catch(e){
      showError('Could not load NBA teams — try a refresh.');
    }
  })();

  document.getElementById('analyzeBtn').addEventListener('click', analyze);

  async function analyze(){
    const away = document.getElementById('awaySelect').value;
    const home = document.getElementById('homeSelect').value;
    if(away === home){ showError('Pick two different teams.'); return; }
    clearError();
    const btn = document.getElementById('analyzeBtn');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Crunching…';
    document.getElementById('nbaArea').innerHTML = '<div class="empty-state"><h3><span class="spinner"></span> Building the dashboard…</h3><p>First run computes league-wide ratings (30 teams) — later runs are cached and fast.</p></div>';
    try{
      const res = await fetch(`/api/nba/matchup?home=${encodeURIComponent(home)}&away=${encodeURIComponent(away)}`);
      if(!res.ok) throw new Error('Matchup data unavailable right now.');
      state.matchup = await res.json();
      state.analyzerPlayer = null; state.hotScan = null; state.playerForm = {};
      render();
      loadRosters();
    }catch(e){
      showError(e.message || 'Could not analyze this matchup.');
      document.getElementById('nbaArea').innerHTML = '';
    }finally{
      btn.disabled = false; btn.textContent = 'Analyze matchup';
    }
  }

  async function loadRosters(){
    const m = state.matchup;
    for(const side of [m.away, m.home]){
      try{
        const res = await fetch(`/api/nba/roster?team=${encodeURIComponent(side.team.id)}`);
        const data = await res.json();
        state.rosters[side.team.id] = data.players || [];
      }catch(e){ state.rosters[side.team.id] = []; }
    }
    render();
  }

  // ---------- rendering ----------
  const fmt1 = v => v === null || v === undefined ? '—' : (Math.round(v*10)/10).toFixed(1);
  const rankChip = (rank, invert) => {
    if(!rank) return '';
    const good = rank <= 10, bad = rank >= 21;
    const cls = (invert ? bad : good) ? 'nba-rank good' : ((invert ? good : bad) ? 'nba-rank bad' : 'nba-rank');
    return `<span class="${cls}">#${rank}</span>`;
  };

  function teamHead(side){
    return `<div class="nba-team-head">
      ${side.team.logo ? `<img src="${escapeHtml(side.team.logo)}" width="26" height="26" alt="" loading="lazy">` : ''}
      <strong>${escapeHtml(side.team.name)}</strong>
      <span class="nba-record">${escapeHtml(side.record || '')}</span>
    </div>`;
  }

  function paceCard(m){
    const rows = [
      ['Pace', s=>`${fmt1(s.pace)} ${rankChip(s.ranks.pace)}`],
      ['Off Rating', s=>`${fmt1(s.ortg)} ${rankChip(s.ranks.ortg)}`],
      ['Def Rating', s=>`${fmt1(s.drtg)} ${rankChip(s.ranks.drtg, false)}`],
      ['Net Rating', s=>`<span class="${s.net>0?'stat-pos':'stat-neg'}">${s.net>0?'+':''}${fmt1(s.net)}</span> ${rankChip(s.ranks.net)}`],
      ['PPG', s=>fmt1(s.ppg)],
      ['Last 10 PPG', s=>{
        const l10 = s.schedule.last10Ppg, season = s.ppg;
        if(l10 === null) return '—';
        const arrow = season !== null && l10 - season > 2 ? ' <span class="stat-pos">▲</span>' : (season !== null && season - l10 > 2 ? ' <span class="stat-neg">▼</span>' : '');
        return fmt1(l10) + arrow;
      }]
    ];
    return card('Pace & Efficiency', `
      <div class="table-scroll"><table class="props-table"><thead>
        <tr><th></th><th>${escapeHtml(m.away.team.abbrev)}</th><th>${escapeHtml(m.home.team.abbrev)}</th></tr></thead><tbody>
        ${rows.map(([label, fn])=>`<tr><td style="font-weight:600;">${label}</td><td>${fn(m.away)}</td><td>${fn(m.home)}</td></tr>`).join('')}
      </tbody></table></div>`);
  }

  function restCard(m){
    const flag = (on, label) => `<span class="nba-flag${on?' on':''}">${label}</span>`;
    const side = s => `
      ${teamHead(s)}
      <div class="nba-flags">
        ${flag(s.schedule.backToBack, 'Back-to-back')}
        ${flag(s.schedule.threeInFour, '3 in 4 nights')}
        ${flag(s.schedule.fourInSix, '4 in 6 nights')}
        ${s.schedule.streakLen > 1 ? flag(true, `${s.schedule.streakLen}-game ${s.schedule.streakType === 'home' ? 'home stand' : 'road trip'}`) : ''}
      </div>
      <div class="hr-note" style="margin-top:4px;">${s.schedule.daysRest !== null ? `${s.schedule.daysRest} day${s.schedule.daysRest===1?'':'s'} of rest` : 'No games played yet'}${s.schedule.gamesPlayed ? ` · ${s.schedule.gamesPlayed} games played` : ''}</div>`;
    const rd = (m.home.schedule.daysRest ?? 0) - (m.away.schedule.daysRest ?? 0);
    const edge = rd === 0 ? 'Rest is even.' :
      `${(rd > 0 ? m.home : m.away).team.name} hold the rest edge (+${Math.abs(rd)} day${Math.abs(rd)===1?'':'s'}).`;
    return card('Rest & Scheduling', `
      <div class="nba-two-col">
        <div>${side(m.away)}</div>
        <div>${side(m.home)}</div>
      </div>
      <div class="nba-insight">${escapeHtml(edge)}</div>`);
  }

  function injuryCard(m){
    const side = s => `
      ${teamHead(s)}
      ${s.injuries.length
        ? `<ul class="nba-injury-list">${s.injuries.map(i=>`<li><strong>${escapeHtml(i.name)}</strong> — ${escapeHtml(i.status || 'listed')}${i.detail ? ` (${escapeHtml(i.detail)})` : ''}</li>`).join('')}</ul>`
        : '<div class="hr-note">No players listed right now.</div>'}`;
    return card('Injury Report', `
      <div class="nba-two-col">
        <div>${side(m.away)}</div>
        <div>${side(m.home)}</div>
      </div>
      <div class="hr-note" style="margin-top:8px;">With/without-player efficiency splits need play-by-play data that no free feed provides — this card lists the report itself.</div>`);
  }

  function analyzerCard(m){
    const options = [m.away, m.home].map(s=>{
      const roster = state.rosters[s.team.id] || [];
      return `<optgroup label="${escapeHtml(s.team.name)}">${roster.map(p=>`<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} (${escapeHtml(p.position)})</option>`).join('')}</optgroup>`;
    }).join('');
    let body = `<div class="search-row" style="margin-bottom:10px;">
      <select id="analyzerSelect" class="nba-team-select">${options || '<option>Loading rosters…</option>'}</select>
      <button class="ghost" id="analyzerBtn">Check form</button>
    </div>`;
    const pf = state.analyzerPlayer && state.playerForm[state.analyzerPlayer];
    if(pf === 'loading'){
      body += `<div class="hr-note"><span class="spinner"></span> Pulling game logs (3 seasons for the head-to-head)…</div>`;
    } else if(pf){
      const vs = pf.vsOpponent;
      const rows = [['Last 10', pf.last10], ['Season', pf.season], ['Home', pf.home], ['Away', pf.away]];
      if(vs && vs.games) rows.push([`vs ${vs.abbrev || 'OPP'} (3 seasons)`, vs]);
      body += `<div class="table-scroll"><table class="props-table"><thead>
        <tr><th>Split</th><th>G</th><th>PTS</th><th>REB</th><th>AST</th><th>MIN</th><th>FG%</th></tr></thead><tbody>
        ${rows.map(([label, r])=>`<tr><td style="font-weight:600;">${label}</td><td>${r.games}</td><td>${fmt1(r.pts)}</td><td>${fmt1(r.reb)}</td><td>${fmt1(r.ast)}</td><td>${fmt1(r.min)}</td><td>${fmt1(r.fgPct)}</td></tr>`).join('')}
      </tbody></table></div>`;
      if(vs && vs.meetings && vs.meetings.length){
        body += `<div class="nfl-pos-group" style="margin-top:8px;">Last meetings vs ${escapeHtml(vs.abbrev || '')}</div>
          <div class="table-scroll"><table class="props-table"><thead>
          <tr><th>Date</th><th>Site</th><th>PTS</th><th>REB</th><th>AST</th></tr></thead><tbody>
          ${vs.meetings.map(mt=>`<tr><td>${escapeHtml(mt.date || '')}</td><td>${mt.home?'Home':'Away'}</td><td>${mt.pts ?? '—'}</td><td>${mt.reb ?? '—'}</td><td>${mt.ast ?? '—'}</td></tr>`).join('')}
        </tbody></table></div>`;
      } else if(vs){
        body += `<div class="hr-note" style="margin-top:6px;">No meetings against this opponent in the last 3 seasons.</div>`;
      }
      if(pf.last10.pts !== null && pf.season.pts !== null){
        const d = pf.last10.pts - pf.season.pts;
        body += `<div class="nba-insight">${Math.abs(d) < 2 ? 'Scoring right at season norm over the last 10.' : d > 0 ? `Scoring ${fmt1(d)} above season average over the last 10 — trending up.` : `Scoring ${fmt1(-d)} below season average over the last 10 — trending down.`}</div>`;
      }
      if(vs && vs.games >= 2 && vs.pts !== null && pf.season.pts !== null){
        const d = vs.pts - pf.season.pts;
        if(Math.abs(d) >= 2){
          body += `<div class="nba-insight">Averages ${fmt1(Math.abs(d))} ${d > 0 ? 'MORE' : 'fewer'} points against this opponent than his overall norm (${vs.games}-game sample).</div>`;
        }
      }
    }
    body += `<div class="hr-note" style="margin-top:8px;">Positional "opponent allows to PGs" splits aren't on any free feed — this card covers real game-log form and home/away splits.</div>`;
    return card('Player Matchup Analyzer', body);
  }

  function hotCard(m){
    let body;
    if(state.hotScan === null){
      body = `<button class="ghost" id="hotScanBtn">Scan both rosters for hot & cold players</button>
        <div class="hr-note" style="margin-top:6px;">Compares each rotation player's last 10 games to their season averages (free, cached).</div>`;
    } else if(state.hotScan === 'loading'){
      body = `<div class="hr-note"><span class="spinner"></span> Scanning rosters — first run takes ~20s, cached after…</div>`;
    } else if(!state.hotScan.length){
      body = `<div class="hr-note">No rotation players deviating meaningfully from their season averages.</div>`;
    } else {
      body = `<div class="table-scroll"><table class="props-table"><thead>
        <tr><th>Player</th><th>Team</th><th>L10 PTS</th><th>Season</th><th>Δ</th><th>L10 MIN</th><th>Trend</th></tr></thead><tbody>
        ${state.hotScan.map(row=>{
          const d = row.form.last10.pts - row.form.season.pts;
          return `<tr>
            <td style="font-weight:600; white-space:nowrap;">${escapeHtml(row.player.name)}</td>
            <td>${escapeHtml(row.teamAbbrev)}</td>
            <td>${fmt1(row.form.last10.pts)}</td>
            <td>${fmt1(row.form.season.pts)}</td>
            <td class="${d>0?'stat-pos':'stat-neg'}">${d>0?'+':''}${fmt1(d)}</td>
            <td>${fmt1(row.form.last10.min)}</td>
            <td>${d>0?'<span class="stat-pos">▲ Hot</span>':'<span class="stat-neg">▼ Cold</span>'}</td>
          </tr>`;
        }).join('')}
      </tbody></table></div>`;
    }
    return card('Hot & Cold Players (last 10 vs season)', body);
  }

  function summaryCard(m){
    const s = m.summary;
    return card('Auto Game Read', `
      <ul class="nba-summary-list">${s.insights.map(i=>`<li>${escapeHtml(i)}</li>`).join('')}</ul>
      ${s.leans.length ? `<div class="nba-leans">${s.leans.map(l=>`<span class="nba-lean">${escapeHtml(l)}</span>`).join('')}</div>` : ''}
      <div class="nba-confidence">Signal strength: <strong>${s.confidence}/10</strong></div>
      <div class="hr-note" style="margin-top:6px;">${escapeHtml(s.note)}</div>`, true);
  }

  function card(title, bodyHtml, accent){
    return `<div class="game-card nba-card${accent?' nba-card-accent':''}">
      <div class="nba-card-title">${escapeHtml(title)}</div>
      <div class="nba-card-body">${bodyHtml}</div>
    </div>`;
  }

  function render(){
    const m = state.matchup;
    if(!m) return;
    document.getElementById('nbaArea').innerHTML = `
      <div class="nba-matchup-title">${escapeHtml(m.away.team.name)} <span class="vs">@</span> ${escapeHtml(m.home.team.name)}</div>
      ${summaryCard(m)}
      ${paceCard(m)}
      ${restCard(m)}
      ${injuryCard(m)}
      ${analyzerCard(m)}
      ${hotCard(m)}
    `;
    wire();
  }

  function wire(){
    const analyzerBtn = document.getElementById('analyzerBtn');
    if(analyzerBtn) analyzerBtn.addEventListener('click', async ()=>{
      const id = document.getElementById('analyzerSelect').value;
      state.analyzerPlayer = id;
      if(!state.playerForm[id]){
        state.playerForm[id] = 'loading';
        render();
        // The opponent is whichever matchup team the player does NOT belong to
        const m = state.matchup;
        const onAway = (state.rosters[m.away.team.id] || []).some(p => String(p.id) === String(id));
        const oppId = onAway ? m.home.team.id : m.away.team.id;
        try{
          const res = await fetch(`/api/nba/player-form?id=${encodeURIComponent(id)}&vsTeam=${encodeURIComponent(oppId)}`);
          state.playerForm[id] = res.ok ? await res.json() : null;
        }catch(e){ state.playerForm[id] = null; }
      }
      render();
    });

    const hotBtn = document.getElementById('hotScanBtn');
    if(hotBtn) hotBtn.addEventListener('click', async ()=>{
      state.hotScan = 'loading';
      render();
      const m = state.matchup;
      const jobs = [];
      [m.away, m.home].forEach(side=>{
        (state.rosters[side.team.id] || []).forEach(p=>{
          jobs.push({ player: p, teamAbbrev: side.team.abbrev });
        });
      });
      const results = [];
      // Small batches to be polite to the free API
      for(let i = 0; i < jobs.length; i += 5){
        await Promise.all(jobs.slice(i, i+5).map(async job=>{
          try{
            const res = await fetch(`/api/nba/player-form?id=${encodeURIComponent(job.player.id)}`);
            if(!res.ok) return;
            const form = await res.json();
            // rotation players only, with a real deviation
            if(form.last10.games >= 5 && form.last10.min >= 15 && form.last10.pts !== null && form.season.pts !== null
               && Math.abs(form.last10.pts - form.season.pts) >= 3){
              results.push({ ...job, form });
            }
          }catch(e){}
        }));
      }
      results.sort((a,b)=>(b.form.last10.pts - b.form.season.pts) - (a.form.last10.pts - a.form.season.pts));
      state.hotScan = results;
      render();
    });
  }
})();
