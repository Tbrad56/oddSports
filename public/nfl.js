(function(){
  const state = {
    teams: [],
    matchup: null,
    rosters: {},      // teamId -> players[]
    playerForm: {},   // playerId -> form payload | 'loading' | null
    analyzerPlayer: null
  };

  renderNav('nfl');

  // Positions bucketed the way bettors think about them
  const POS_BUCKETS = [
    ['QB', ['QB']],
    ['RB', ['RB', 'FB']],
    ['WR/TE', ['WR', 'TE']],
    ['OL', ['LT', 'LG', 'C', 'RG', 'RT', 'OT', 'G', 'OL']],
    ['Defense', ['LDE','RDE','DE','DT','NT','LILB','RILB','MLB','ILB','OLB','LOLB','ROLB','LB','LCB','RCB','CB','SS','FS','S','DB']],
    ['Special Teams', ['PK','K','P','LS','H','PR','KR']]
  ];
  const bucketFor = pos => (POS_BUCKETS.find(([, list]) => list.includes(pos)) || ['Other'])[0];

  const STATUS_CLASS = s => {
    const t = (s || '').toLowerCase();
    if (t.includes('out') || t.includes('injured reserve') || t.includes('ir')) return 'nfl-status out';
    if (t.includes('doubtful')) return 'nfl-status out';
    if (t.includes('questionable')) return 'nfl-status quest';
    return 'nfl-status limited';
  };

  (async function loadTeams(){
    try{
      const res = await fetch('/api/nfl/teams');
      const data = await res.json();
      state.teams = data.teams || [];
      const opts = state.teams.map(t=>`<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`).join('');
      document.getElementById('awaySelect').innerHTML = opts;
      document.getElementById('homeSelect').innerHTML = opts;
      const kc = state.teams.find(t=>t.abbrev==='KC'), buf = state.teams.find(t=>t.abbrev==='BUF');
      if(buf) document.getElementById('awaySelect').value = buf.id;
      if(kc) document.getElementById('homeSelect').value = kc.id;
    }catch(e){ showError('Could not load NFL teams — try a refresh.'); }
  })();

  document.getElementById('analyzeBtn').addEventListener('click', analyze);

  async function analyze(){
    const away = document.getElementById('awaySelect').value;
    const home = document.getElementById('homeSelect').value;
    if(away === home){ showError('Pick two different teams.'); return; }
    clearError();
    const btn = document.getElementById('analyzeBtn');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Crunching…';
    document.getElementById('nflArea').innerHTML = '<div class="empty-state"><h3><span class="spinner"></span> Building the dashboard…</h3><p>First run computes league-wide ranks (32 teams) — later runs are cached and fast.</p></div>';
    try{
      const res = await fetch(`/api/nfl/matchup?home=${encodeURIComponent(home)}&away=${encodeURIComponent(away)}`);
      if(!res.ok) throw new Error('Matchup data unavailable right now.');
      state.matchup = await res.json();
      state.analyzerPlayer = null; state.playerForm = {};
      render();
      loadRosters();
    }catch(e){
      showError(e.message || 'Could not analyze this matchup.');
      document.getElementById('nflArea').innerHTML = '';
    }finally{
      btn.disabled = false; btn.textContent = 'Analyze matchup';
    }
  }

  async function loadRosters(){
    const m = state.matchup;
    for(const side of [m.away, m.home]){
      try{
        const res = await fetch(`/api/nfl/roster?team=${encodeURIComponent(side.team.id)}`);
        const data = await res.json();
        state.rosters[side.team.id] = data.players || [];
      }catch(e){ state.rosters[side.team.id] = []; }
    }
    render();
  }

  const fmt1 = v => v === null || v === undefined ? '—' : (Math.round(v*10)/10).toFixed(1);
  const rankChip = (rank) => {
    if(!rank) return '';
    const cls = rank <= 10 ? 'nba-rank good' : rank >= 23 ? 'nba-rank bad' : 'nba-rank';
    return `<span class="${cls}">#${rank}</span>`;
  };

  function teamHead(side){
    return `<div class="nba-team-head">
      ${side.team.logo ? `<img src="${escapeHtml(side.team.logo)}" width="26" height="26" alt="" loading="lazy">` : ''}
      <strong>${escapeHtml(side.team.name)}</strong>
      <span class="nba-record">${escapeHtml(side.record || '')}</span>
    </div>`;
  }

  function card(title, bodyHtml, accent){
    return `<div class="game-card nba-card${accent?' nba-card-accent':''}">
      <div class="nba-card-title">${escapeHtml(title)}</div>
      <div class="nba-card-body">${bodyHtml}</div>
    </div>`;
  }

  // ---- 1. Injury Center (first, per spec) ----
  function injuryCard(m){
    const side = s => {
      if(!s.injuries.length) return `${teamHead(s)}<div class="hr-note">No players listed right now.</div>`;
      const byBucket = {};
      s.injuries.forEach(i => { (byBucket[bucketFor(i.position)] = byBucket[bucketFor(i.position)] || []).push(i); });
      return `${teamHead(s)}` + Object.entries(byBucket).map(([bucket, list])=>`
        <div class="nfl-pos-group">${escapeHtml(bucket)}</div>
        <ul class="nba-injury-list">${list.map(i=>
          `<li><strong>${escapeHtml(i.name)}</strong> <span class="hand-tag">${escapeHtml(i.position)}</span>
           <span class="${STATUS_CLASS(i.status)}">${escapeHtml(i.status)}</span>${i.starter ? ' <span class="nfl-starter-tag">Starter</span>' : ''}</li>`).join('')}
        </ul>`).join('');
    };
    return card('Injury Center', `
      <div class="nba-two-col">
        <div>${side(m.away)}</div>
        <div>${side(m.home)}</div>
      </div>`);
  }

  // ---- 2. Matchup Breakdown: cross-compare offense vs the other defense ----
  function matchupCard(m){
    const cross = (off, def, label) => `
      <div class="nfl-cross-row">
        <div class="nfl-cross-side">
          <span class="nfl-cross-team">${escapeHtml(off.team.abbrev)}</span> ${label.off}
          <div class="nfl-cross-val">${label.offVal(off)} ${rankChip(label.offRank(off))}</div>
        </div>
        <span class="nfl-cross-vs">vs</span>
        <div class="nfl-cross-side">
          <span class="nfl-cross-team">${escapeHtml(def.team.abbrev)}</span> ${label.def}
          <div class="nfl-cross-val">${label.defVal(def)} ${rankChip(label.defRank(def))}</div>
        </div>
      </div>`;
    const rush = { off:'Rush offense', def:'Points allowed', offVal:s=>fmt1(s.metrics.rushYpg)+' ypg', offRank:s=>s.ranks.rushYpg, defVal:s=>fmt1(s.pa)+' pa/g', defRank:s=>s.ranks.pa };
    const pass = { off:'Pass offense', def:'Pass rush', offVal:s=>fmt1(s.metrics.passYpg)+' ypg', offRank:s=>s.ranks.passYpg, defVal:s=>fmt1(s.metrics.sacks)+' sacks/g', defRank:s=>s.ranks.sacks };
    const rows = [
      ['Red Zone TD%', s=>`${fmt1(s.metrics.redZoneTdPct)}% ${rankChip(s.ranks.redZoneTdPct)}`],
      ['Third Down %', s=>`${fmt1(s.metrics.thirdDownPct)}% ${rankChip(s.ranks.thirdDownPct)}`],
      ['Explosive plays/g (20+ yds)', s=>`${fmt1(s.metrics.explosive)} ${rankChip(s.ranks.explosive)}`],
      ['Takeaway INTs/g', s=>`${fmt1(s.metrics.ints)} ${rankChip(s.ranks.ints)}`]
    ];
    return card('Matchup Breakdown', `
      ${cross(m.away, m.home, rush)}
      ${cross(m.home, m.away, rush)}
      ${cross(m.away, m.home, pass)}
      ${cross(m.home, m.away, pass)}
      <div class="table-scroll" style="margin-top:10px;"><table class="props-table"><thead>
        <tr><th></th><th>${escapeHtml(m.away.team.abbrev)}</th><th>${escapeHtml(m.home.team.abbrev)}</th></tr></thead><tbody>
        ${rows.map(([label, fn])=>`<tr><td style="font-weight:600;">${label}</td><td>${fn(m.away)}</td><td>${fn(m.home)}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="hr-note" style="margin-top:8px;">Yards-allowed defensive splits aren't on any free feed — defense here is points allowed, pass rush, and takeaways.</div>`);
  }

  // ---- 3. Weather ----
  function weatherCard(m){
    const w = m.weather;
    let body;
    if(!w){ body = '<div class="hr-note">Weather unavailable for this venue.</div>'; }
    else if(w.dome){ body = `<div class="hr-note">Indoor stadium — weather doesn't affect play.</div>`; }
    else {
      const flags = [];
      if((w.windMph ?? 0) >= 15) flags.push(['Passing downgrade', 'bad'], ['Running upgrade', 'good']);
      if(w.rain || w.snow) flags.push(['Ball security matters', 'bad'], ['Running upgrade', 'good']);
      body = `
        <div class="nba-flags" style="margin-bottom:8px;">
          <span class="nba-flag on">${w.tempF !== null ? Math.round(w.tempF) + '°F' : '—'}</span>
          <span class="nba-flag${(w.windMph ?? 0) >= 15 ? ' on' : ''}">Wind ${w.windMph !== null ? Math.round(w.windMph) + ' mph' : '—'}</span>
          <span class="nba-flag${w.rain ? ' on' : ''}">Rain</span>
          <span class="nba-flag${w.snow ? ' on' : ''}">Snow</span>
        </div>
        ${flags.length
          ? `<div class="nba-leans">${flags.map(([t, cls])=>`<span class="nba-lean">${escapeHtml(t)}</span>`).join('')}</div>`
          : '<div class="hr-note">Current conditions look neutral for both phases.</div>'}
        <div class="hr-note" style="margin-top:6px;">Current conditions at ${escapeHtml(m.home.team.abbrev)}'s stadium — check again close to kickoff.</div>`;
    }
    return card('Weather', body);
  }

  // ---- 4. Form (straight-up, honestly labeled) ----
  function formCard(m){
    const side = s => `
      ${teamHead(s)}
      <div class="hr-note">
        ${s.schedule.last10 ? `Last 10 (straight-up): <strong>${escapeHtml(s.schedule.last10)}</strong>` : 'No completed games yet this season.'}
        ${s.schedule.streak ? ` · ${escapeHtml(s.schedule.streak)}` : ''}
        ${s.schedule.offBye ? ' · <span class="stat-pos">Off the bye</span>' : ''}
      </div>`;
    return card('Recent Form', `
      <div class="nba-two-col">
        <div>${side(m.away)}</div>
        <div>${side(m.home)}</div>
      </div>
      <div class="hr-note" style="margin-top:8px;">Against-the-spread and over/under trend history requires paid closing-line data — form shown here is straight-up wins and losses from the schedule.</div>`);
  }

  // ---- 5. Player form (props context) ----
  function analyzerCard(m){
    const options = [m.away, m.home].map(s=>{
      const roster = (state.rosters[s.team.id] || []).filter(p=>['QB','RB','WR','TE'].includes(p.position));
      return `<optgroup label="${escapeHtml(s.team.name)}">${roster.map(p=>`<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} (${escapeHtml(p.position)})</option>`).join('')}</optgroup>`;
    }).join('');
    let body = `<div class="search-row" style="margin-bottom:10px;">
      <select id="analyzerSelect" class="nba-team-select">${options || '<option>Loading rosters…</option>'}</select>
      <button class="ghost" id="analyzerBtn">Check form</button>
    </div>`;
    const pf = state.analyzerPlayer && state.playerForm[state.analyzerPlayer];
    if(pf === 'loading'){
      body += `<div class="hr-note"><span class="spinner"></span> Pulling game logs…</div>`;
    } else if(pf && pf.season.games){
      // Label the two YDS columns from the gamelog's own label order
      const ydsLabels = [];
      let seen = 0;
      (pf.labels || []).forEach((l, i)=>{
        if(l === 'YDS'){
          seen++;
          const before = pf.labels.slice(0, i).join(',');
          ydsLabels.push(before.includes('CMP') && seen === 1 ? 'Pass YDS' : before.includes('REC') ? 'Rec YDS' : 'Rush YDS');
        }
      });
      const rows = [['Last 5', pf.last5], ['Season', pf.season]];
      body += `<div class="table-scroll"><table class="props-table"><thead>
        <tr><th>Split</th><th>G</th>${ydsLabels[0]?`<th>${ydsLabels[0]}</th>`:''}${ydsLabels[1]?`<th>${ydsLabels[1]}</th>`:''}<th>TD</th>${pf.season.rec !== null ? '<th>REC</th>' : ''}</tr></thead><tbody>
        ${rows.map(([label, r])=>`<tr><td style="font-weight:600;">${label}</td><td>${r.games}</td>${ydsLabels[0]?`<td>${fmt1(r.yds1)}</td>`:''}${ydsLabels[1]?`<td>${fmt1(r.yds2)}</td>`:''}<td>${fmt1(r.td1)}</td>${pf.season.rec !== null ? `<td>${fmt1(r.rec)}</td>` : ''}</tr>`).join('')}
      </tbody></table></div>`;
      if(pf.last5.yds1 !== null && pf.season.yds1 !== null){
        const d = pf.last5.yds1 - pf.season.yds1;
        body += `<div class="nba-insight">${Math.abs(d) < 15 ? 'Producing right at season norm over the last 5.' : d > 0 ? `Averaging ${fmt1(d)} yards above season norm over the last 5 — favorable form for Over props.` : `Averaging ${fmt1(-d)} yards below season norm over the last 5 — caution on Overs.`}</div>`;
      }
    } else if(pf === null){
      body += `<div class="hr-note">No game-log data for this player.</div>`;
    }
    body += `<div class="hr-note" style="margin-top:8px;">Prop lines and odds live on the Board's player-props panel — this card is the form behind them.</div>`;
    return card('Player Form (props context)', body);
  }

  // ---- 6. Fantasy Impact / next man up ----
  function fantasyCard(m){
    const rows = [...m.away.nextMen.map(n=>({...n, team: m.away.team.abbrev})), ...m.home.nextMen.map(n=>({...n, team: m.home.team.abbrev}))];
    const body = rows.length
      ? `<div class="table-scroll"><table class="props-table"><thead>
          <tr><th>Team</th><th>Pos</th><th>Injured starter</th><th>Status</th><th>Next man up</th></tr></thead><tbody>
          ${rows.map(r=>`<tr>
            <td>${escapeHtml(r.team)}</td><td>${escapeHtml(r.position)}</td>
            <td style="font-weight:600;">${escapeHtml(r.out)}</td>
            <td><span class="${STATUS_CLASS(r.status)}">${escapeHtml(r.status)}</span></td>
            <td class="stat-pos">${escapeHtml(r.in)}</td>
          </tr>`).join('')}
        </tbody></table></div>
        <div class="hr-note" style="margin-top:6px;">Straight from each team's depth chart — the player listed directly behind an injured starter.</div>`
      : '<div class="hr-note">No injured starters with a clear next man up right now.</div>';
    return card('Fantasy Impact — who steps up', body);
  }

  function summaryCard(m){
    const s = m.summary;
    return card('Auto Game Read', `
      <ul class="nba-summary-list">${s.insights.map(i=>`<li>${escapeHtml(i)}</li>`).join('')}</ul>
      ${s.leans.length ? `<div class="nba-leans">${s.leans.map(l=>`<span class="nba-lean">${escapeHtml(l)}</span>`).join('')}</div>` : ''}
      <div class="nba-confidence">Signal strength: <strong>${s.confidence}/10</strong></div>
      <div class="hr-note" style="margin-top:6px;">${escapeHtml(s.note)}</div>`, true);
  }

  function render(){
    const m = state.matchup;
    if(!m) return;
    document.getElementById('nflArea').innerHTML = `
      <div class="nba-matchup-title">${escapeHtml(m.away.team.name)} <span class="vs">@</span> ${escapeHtml(m.home.team.name)}</div>
      ${injuryCard(m)}
      ${summaryCard(m)}
      ${matchupCard(m)}
      ${weatherCard(m)}
      ${formCard(m)}
      ${analyzerCard(m)}
      ${fantasyCard(m)}
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
        try{
          const res = await fetch(`/api/nfl/player-form?id=${encodeURIComponent(id)}`);
          state.playerForm[id] = res.ok ? await res.json() : null;
        }catch(e){ state.playerForm[id] = null; }
      }
      render();
    });
  }
})();
