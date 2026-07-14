(function(){
  // Reference links persist across refreshes just like the slip itself (audit 6.5).
  const LINKS_KEY = 'lw_links';
  function getManualLinks(){
    try{
      const v = JSON.parse(localStorage.getItem(LINKS_KEY));
      return Array.isArray(v) ? v : [];
    }catch(e){ return []; }
  }
  function saveManualLinks(list){
    try{ localStorage.setItem(LINKS_KEY, JSON.stringify(list)); }catch(e){}
  }

  const state = { manual: getManualLinks() };

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
        div.classList.add('removing');
        setTimeout(()=>{
          removeLegFromSlip(leg.id);
          renderSlip();
        }, 200);
      });
      legsEl.appendChild(div);
    });

    staggerIn(legsEl, 30);
    renderParlay();
  }

  // One URL that lands the whole slip pre-filled in the book. FanDuel supports
  // multi-leg addToBetslip built from the sids The Odds API returns; other books
  // only take one selection per link, so they fall back to per-leg buttons.
  function multiLegUrlFor(bookKey, rowsPerLeg){
    if(bookKey.toLowerCase() === 'fanduel' && rowsPerLeg.length && rowsPerLeg.every(r => r.sid && r.marketSid)){
      const params = rowsPerLeg.map((r,i)=>`marketId[${i}]=${encodeURIComponent(r.marketSid)}&selectionId[${i}]=${encodeURIComponent(r.sid)}`).join('&');
      return `https://sportsbook.fanduel.com/addToBetslip?${params}`;
    }
    return null;
  }

  // The Gambly-style handoff block: one tap opens the book with the slip loaded.
  function placeButtonsHtml(bookKey, bookName, rowsPerLeg){
    const n = rowsPerLeg.length;
    const multiUrl = multiLegUrlFor(bookKey, rowsPerLeg);
    if(multiUrl){
      return `<a class="place-all-btn" href="${escapeHtml(multiUrl)}" target="_blank" rel="noopener">
          Place all ${n} bet${n===1?'':'s'} on ${escapeHtml(bookName)} ↗
        </a>
        <div class="place-note">Opens ${escapeHtml(bookName)} with your slip pre-filled — set your wager there.</div>`;
    }
    if(rowsPerLeg.every(r => r.link)){
      const slip = getSlip();
      const btns = rowsPerLeg.map((r,i)=>
        `<a class="place-leg-btn" href="${escapeHtml(r.link)}" target="_blank" rel="noopener">${escapeHtml(slip[i] ? slip[i].side : 'Leg '+(i+1))} ↗</a>`
      ).join('');
      return `<div class="place-note" style="margin-top:8px;">${escapeHtml(bookName)} takes one leg per link — tap each to add it to your slip:</div>
        <div class="place-leg-list">${btns}</div>`;
    }
    return '';
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
          ${best.link ? `<a class="place-all-btn" href="${escapeHtml(best.link)}" target="_blank" rel="noopener">Place bet on ${escapeHtml(style ? style.name : best.bookTitle)} ↗</a>
          <div class="place-note">Opens with this selection in your slip — set your wager there.</div>` : ''}
        </div>
      `;
      staggerIn(area);
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
      const bestBookName = bestStyle ? bestStyle.name : bestBookKey;

      // Prefer a book that can take the whole slip in one tap; among those,
      // keep the by-price order so the button is also the best available price.
      const rowsFor = bookKey => slip.map(leg => leg.rows.find(r=>r.bookKey===bookKey));
      const oneTap = results.find(r => multiLegUrlFor(r.bookKey, rowsFor(r.bookKey)));
      const target = oneTap || results[0];
      const targetStyle = bookStyleFor(target.bookKey);
      html += placeButtonsHtml(target.bookKey, targetStyle ? targetStyle.name : target.bookKey, rowsFor(target.bookKey));

      html += `<div class="copy-block">${buildCopyText(bestBookKey, bestBookName)}</div>
        <button type="button" class="ghost copy-btn" data-book-key="${escapeHtml(bestBookKey)}" data-book-name="${escapeHtml(bestBookName)}" style="margin-top:6px; font-size:11.5px; padding:6px 10px;">Copy</button>`;
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
    staggerIn(area);
    wireCopyButton(area);
  }

  function buildCopyLines(bookKey, bookName){
    const slip = getSlip();
    const lines = [`${bookName} parlay slip:`];
    slip.forEach(leg=>{
      const row = leg.rows.find(r=>r.bookKey===bookKey);
      lines.push(`• ${leg.side} (${leg.matchup}) — ${fmtAmerican(row.odds)}`);
    });
    return lines;
  }
  // Escaped version for display inside the .copy-block (innerHTML).
  function buildCopyText(bookKey, bookName){
    return buildCopyLines(bookKey, bookName).map(escapeHtml).join('\n');
  }

  // Copy-to-clipboard for the parlay copy-block (audit 6.7) — flashes "Copied ✓"
  // on the button itself so the confirmation sits right where the click happened.
  function wireCopyButton(area){
    const btn = area.querySelector('.copy-btn');
    if(!btn) return;
    btn.addEventListener('click', async ()=>{
      const text = buildCopyLines(btn.dataset.bookKey, btn.dataset.bookName).join('\n');
      try{
        await navigator.clipboard.writeText(text);
        const original = btn.textContent;
        btn.textContent = 'Copied ✓';
        clearTimeout(btn._copyResetTimer);
        btn._copyResetTimer = setTimeout(()=>{ btn.textContent = original; }, 1500);
      }catch(e){
        btn.textContent = 'Copy failed';
        clearTimeout(btn._copyResetTimer);
        btn._copyResetTimer = setTimeout(()=>{ btn.textContent = 'Copy'; }, 1500);
      }
    });
  }

  document.getElementById('linkAddBtn').addEventListener('click', ()=>{
    const input = document.getElementById('linkInput');
    const val = input.value.trim();
    if(!val) return;
    // Only render as a clickable link when it's actually http(s) — guards against
    // javascript: URLs turning into live self-XSS links (audit 6.5).
    addManualEntry({tagline:'Reference link', text: val, isLink: /^https?:\/\//i.test(val)});
    input.value = '';
  });
  function addManualEntry(entry){
    state.manual.push(entry);
    saveManualLinks(state.manual);
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
    staggerIn(area, 30);
  }

  renderSlip();
  renderManual();

  // fill the ticker quietly (server cache makes this cheap); ignore failures
  fetchOddsFor(getSport()).then(r=>updateTicker(r.games)).catch(()=>{});
})();
