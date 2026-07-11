(function(){
  renderNav('home');
  renderSportChips(document.getElementById('sportChips'), load);

  async function load(){
    clearError();
    setStatus(false, 'Loading value spots…');
    try{
      const {games, remaining, cacheAge} = await fetchOddsFor(getSport());
      renderCheatsheet(games);
      updateTicker(games);
      const freshness = cacheAge >= 60 ? `cached ${Math.round(cacheAge/60)} min ago` : `updated ${new Date().toLocaleTimeString()}`;
      setStatus(true, `Live — ${games.length} games scanned${remaining ? ' · '+remaining+' requests left this month' : ''} · ${freshness}`);
    }catch(e){
      setStatus(false, 'Fetch failed.');
      showError(e.message || 'Could not fetch odds — try again shortly.');
      document.getElementById('cheatBody').textContent = 'Value spots unavailable right now.';
    }
  }

  function renderCheatsheet(games){
    const body = document.getElementById('cheatBody');
    const countEl = document.getElementById('cheatCount');
    const picks = [];

    games.forEach(game=>{
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
      body.innerHTML = games.length
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

  load();
})();
