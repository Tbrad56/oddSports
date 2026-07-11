(function(){
  const state = { manual: [] };

  renderNav('slip');

  function renderSlip(){
    const slip = getSlip();
    const legsEl = document.getElementById('slipLegs');
    const emptyEl = document.getElementById('slipEmpty');
    const countEl = document.getElementById('slipCount');
    countEl.textContent = slip.length + ' leg' + (slip.length===1?'':'s');
    legsEl.innerHTML = '';
    emptyEl.style.display = slip.length ? 'none' : 'block';

    slip.forEach(leg=>{
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
      div.querySelector('.remove-btn').addEventListener('click', ()=>{
        removeLegFromSlip(leg.id);
        renderSlip();
      });
      legsEl.appendChild(div);
    });

    renderParlay();
  }

  function renderParlay(){
    const slip = getSlip();
    const area = document.getElementById('parlayArea');
    if(slip.length < 1){ area.innerHTML=''; return; }

    if(slip.length === 1){
      const leg = slip[0];
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
    const bookSets = slip.map(leg => new Set(leg.rows.map(r=>r.bookKey)));
    const common = [...bookSets[0]].filter(k => bookSets.every(s=>s.has(k)));

    let html = '<div class="parlay-result">';
    if(common.length){
      html += `<div style="font-size:12px; color:var(--text-dim); margin-bottom:6px;">Parlay price by book (all legs on one book)</div>`;
      const results = common.map(bookKey=>{
        let decimal = 1;
        slip.forEach(leg=>{
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
      slip.forEach(leg=>{
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

  function buildCopyText(bookKey, bookName){
    const slip = getSlip();
    let lines = [`${escapeHtml(bookName)} parlay slip:`];
    slip.forEach(leg=>{
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

  renderSlip();

  // fill the ticker quietly (server cache makes this cheap); ignore failures
  fetchOddsFor(getSport()).then(r=>updateTicker(r.games)).catch(()=>{});
})();
