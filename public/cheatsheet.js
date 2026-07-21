(function(){
  const state = { games: [], loading: false };
  const EDGE_THRESHOLD = 0.02; // 2% — below this it's just book-to-book noise, not a real edge
  const fmtPct = p => (p*100).toFixed(1) + '%';

  renderNav('cheatsheet');
  renderSportChips(document.getElementById('sportChips'), ()=>{ loadAndScan(); });

  // Pool of books to scan: My Books if set (same rule the Board and Slip
  // already use), else every tracked book. Never scans a book you can't
  // actually see prices from elsewhere in the app.
  function poolFor(bookmakers){
    const tracked = bookmakers.filter(b => TRACKED_KEYS.includes(b.key.toLowerCase()));
    const bookmakersToUse = tracked.length ? tracked : bookmakers;
    const myBooks = getMyBooks();
    const scoped = myBooks.length ? bookmakersToUse.filter(b => myBooks.includes(b.key.toLowerCase())) : [];
    return scoped.length ? scoped : bookmakersToUse;
  }

  function rowsFor(pool, marketKey, outcomeName){
    const rows = [];
    pool.forEach(bm=>{
      const market = bm.markets.find(m=>m.key===marketKey);
      if(!market) return;
      const outcome = market.outcomes.find(o=>o.name===outcomeName);
      if(!outcome) return;
      rows.push({bookKey:bm.key, bookTitle:bm.title, odds:outcome.price, point:outcome.point, link:outcome.link||bm.link||null, sid:outcome.sid||null, marketSid:market.sid||null});
    });
    rows.sort((a,b)=>americanToDecimal(b.odds)-americanToDecimal(a.odds));
    return rows;
  }
  // Books can quote slightly different lines (mostly totals/spreads) — group
  // by point, keep whichever point the most books share so the comparison
  // stays apples-to-apples (same convention Board's Game Lines grid uses).
  function modalPointRows(pool, marketKey, outcomeName){
    const all = rowsFor(pool, marketKey, outcomeName);
    if(!all.length) return [];
    const byPoint = {};
    all.forEach(r=>{ const k=String(r.point); (byPoint[k]=byPoint[k]||[]).push(r); });
    const bestKey = Object.keys(byPoint).sort((a,b)=>byPoint[b].length-byPoint[a].length)[0];
    return byPoint[bestKey];
  }

  // Scans one game's markets for outcomes whose best price beats the
  // multi-book consensus fair line by at least EDGE_THRESHOLD. Reuses the
  // exact devig math (computeFairDecimal) Board already uses for its single
  // "Value" tag — this just runs it across every outcome and ranks the results
  // instead of leaving it buried per-row on a page you'd have to scan by eye.
  function scanGame(game, sportKey){
    const pool = poolFor(game.bookmakers);
    const candidates = [];

    function consider(sideRows, oppRows, label, marketLabel){
      if(!sideRows.length || !oppRows.length) return;
      const fair = computeFairDecimal(sideRows, oppRows);
      if(!fair) return;
      const best = sideRows[0];
      const edge = americanToDecimal(best.odds) / fair - 1;
      if(edge < EDGE_THRESHOLD) return;
      candidates.push({ matchup: `${game.away_team} @ ${game.home_team}`, side: label, marketLabel, edge, rows: sideRows, best });
    }

    const ml = { away: rowsFor(pool, 'h2h', game.away_team), home: rowsFor(pool, 'h2h', game.home_team) };
    consider(ml.away, ml.home, `${game.away_team} to win`, 'Moneyline');
    consider(ml.home, ml.away, `${game.home_team} to win`, 'Moneyline');

    if(sportKey === 'baseball_mlb'){
      const spread = { away: modalPointRows(pool, 'spreads', game.away_team), home: modalPointRows(pool, 'spreads', game.home_team) };
      if(spread.away.length && spread.home.length && spread.away[0].point != null){
        const p = spread.away[0].point;
        consider(spread.away, spread.home, `${game.away_team} ${p>0?'+':''}${p}`, 'Spread');
        const hp = spread.home[0].point;
        consider(spread.home, spread.away, `${game.home_team} ${hp>0?'+':''}${hp}`, 'Spread');
      }
      const total = { over: modalPointRows(pool, 'totals', 'Over'), under: modalPointRows(pool, 'totals', 'Under') };
      if(total.over.length && total.under.length){
        consider(total.over, total.under, `Over ${total.over[0].point}`, 'Total');
        consider(total.under, total.over, `Under ${total.under[0].point}`, 'Total');
      }
    }
    return candidates;
  }

  function valueCard(c){
    const style = bookStyleFor(c.best.bookKey);
    const link = BOOK_LINKS[c.best.bookKey.toLowerCase()];
    return `<div class="value-row">
      <div class="value-row-main">
        <div class="value-row-side">${escapeHtml(c.side)}</div>
        <div class="value-row-sub">${escapeHtml(c.matchup)} · ${escapeHtml(c.marketLabel)}</div>
      </div>
      <div class="value-row-edge">
        <span class="value-edge-pct">+${fmtPct(c.edge)}</span>
        <span class="value-edge-label">vs consensus</span>
      </div>
      <div class="value-row-book">
        ${linkedBadge(c.best.bookKey, c.best.bookTitle)}
        <span class="odds">${fmtAmerican(c.best.odds)}</span>
      </div>
      <button class="add-leg-btn value-add-btn">+ Slip</button>
    </div>`;
  }

  function renderValueArea(candidates){
    const area = document.getElementById('valueArea');
    if(state.loading){
      area.innerHTML = `<div class="panel"><div class="hr-note"><span class="spinner"></span> Scanning ${state.games.length || ''} games…</div></div>`;
      return;
    }
    if(!state.games.length){
      area.innerHTML = `<div class="panel"><div class="hr-note">No games loaded for this sport right now.</div></div>`;
      return;
    }
    if(!candidates.length){
      area.innerHTML = `<div class="panel"><h2>Value Finder</h2><div class="hr-note">Nothing beats the market consensus by ${fmtPct(EDGE_THRESHOLD)}+ right now — books are in close agreement. Check back closer to game time, or try another sport.</div></div>`;
      return;
    }
    area.innerHTML = `<div class="panel">
      <h2>Value Finder</h2>
      <div class="hr-note" style="margin-bottom:10px;">Best price on each outcome vs. the de-vigged consensus of every book scanned — not a pick, just where the market disagrees with itself. Top ${candidates.length}, best edge first.</div>
      ${candidates.map(valueCard).join('')}
    </div>`;

    area.querySelectorAll('.value-row').forEach((row, i)=>{
      row.querySelector('.value-add-btn').addEventListener('click', ()=>{
        const c = candidates[i];
        addLegToSlip({ id: Date.now()+Math.random(), matchup: c.matchup, side: c.side, rows: c.rows });
        showToast('Added ✓');
        flashEl(row);
      });
    });
    staggerIn(area.querySelector('.panel'), 20);
  }

  async function loadAndScan(){
    state.loading = true;
    renderValueArea([]);
    clearError();
    try{
      const sportKey = getSport();
      const { games } = await fetchOddsFor(sportKey);
      state.games = games;
      updateTicker(games);
      const all = games.flatMap(g => scanGame(g, sportKey)).sort((a,b)=>b.edge-a.edge);
      state.loading = false;
      renderValueArea(all.slice(0, 25));
    }catch(e){
      state.loading = false;
      state.games = [];
      showError(e.message || 'Could not load odds for this sport.');
      renderValueArea([]);
    }
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

  loadAndScan();
  renderSlipSection();
})();
