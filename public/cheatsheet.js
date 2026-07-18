(function(){
  renderNav('cheatsheet');

  function render(){
    const slip = getSlip();
    const area = document.getElementById('cheatsheetArea');
    if(!slip.length){
      area.innerHTML = `<div class="empty-state"><h3>Nothing to rank yet</h3>
        <p>Add a moneyline or prop to your <a href="/slip.html">Slip</a> from the <a href="/board.html">Board</a> or <a href="/getprops.html">Get Props</a> page, then come back here to see every book's price side by side.</p></div>`;
      return;
    }

    let html = '';

    // Parlay price by book — only meaningful when every leg is offered by the same book.
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

        html += `<div class="panel" style="margin-bottom:14px;">
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

    // Per-leg ranking — every book offering that specific leg, best to worst.
    slip.forEach(leg=>{
      html += `<div class="panel" style="margin-bottom:14px;">
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
    staggerIn(area, 30);
  }

  render();

  // fill the ticker quietly (server cache makes this cheap); ignore failures
  fetchOddsFor(getSport()).then(r=>updateTicker(r.games)).catch(()=>{});
})();
