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

  const state = { manual: getManualLinks(), selectedBook: null };

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

  // One URL that lands the whole slip pre-filled in the book, built from the
  // sids The Odds API returns. FanDuel's addToBetslip format is stable and
  // documented in the wild; DraftKings and BetMGM use best-effort community
  // patterns — worst case the book opens without the slip and the per-leg
  // buttons below still work. Other books only take one selection per link.
  function multiLegUrlFor(bookKey, rowsPerLeg){
    const key = bookKey.toLowerCase();
    if(!rowsPerLeg.length || !rowsPerLeg.every(r => r && r.sid)) return null;
    if(key === 'fanduel' && rowsPerLeg.every(r => r.marketSid)){
      const params = rowsPerLeg.map((r,i)=>`marketId[${i}]=${encodeURIComponent(r.marketSid)}&selectionId[${i}]=${encodeURIComponent(r.sid)}`).join('&');
      return `https://sportsbook.fanduel.com/addToBetslip?${params}`;
    }
    if(key === 'draftkings'){
      // DK event pages accept +-chained outcome ids in one ?outcomes= param.
      // Reuse the first leg's own event link as the base so the page is real.
      const base = rowsPerLeg[0].link ? rowsPerLeg[0].link.split('?')[0] : null;
      if(!base || !/^https:\/\/sportsbook\.draftkings\.com\//.test(base)) return null;
      return `${base}?outcomes=${rowsPerLeg.map(r=>encodeURIComponent(r.sid)).join('+')}`;
    }
    if(key === 'betmgm'){
      return `https://sports.betmgm.com/en/sports?options=${rowsPerLeg.map(r=>encodeURIComponent(r.sid)).join('-')}&type=Multi`;
    }
    return null;
  }

  // Books where the combined URL is a community pattern, not an official one.
  const BEST_EFFORT_MULTI = new Set(['draftkings', 'betmgm']);

  // The Gambly-style handoff block: one tap opens the book with the slip loaded.
  function placeButtonsHtml(bookKey, bookName, rowsPerLeg){
    const n = rowsPerLeg.length;
    const multiUrl = multiLegUrlFor(bookKey, rowsPerLeg);
    let html = '';
    if(multiUrl){
      const beta = BEST_EFFORT_MULTI.has(bookKey.toLowerCase());
      html += `<a class="place-all-btn" href="${escapeHtml(multiUrl)}" target="_blank" rel="noopener">
          Place all ${n} bet${n===1?'':'s'} on ${escapeHtml(bookName)} ↗
        </a>
        <div class="place-note">Opens ${escapeHtml(bookName)} with your slip pre-filled — set your wager there.${beta ? ' If the slip arrives empty, use the per-leg buttons below.' : ''}</div>`;
      if(!beta) return html;
    }
    if(rowsPerLeg.every(r => r.link)){
      const slip = getSlip();
      const btns = rowsPerLeg.map((r,i)=>
        `<a class="place-leg-btn" href="${escapeHtml(r.link)}" target="_blank" rel="noopener">${escapeHtml(slip[i] ? slip[i].side : 'Leg '+(i+1))} ↗</a>`
      ).join('');
      html += `<div class="place-note" style="margin-top:8px;">${multiUrl ? 'Backup — add ' : escapeHtml(bookName) + ' takes '}one leg per link${multiUrl ? '' : ' — tap each to add it to your slip'}:</div>
        <div class="place-leg-list">${btns}</div>`;
    }
    return html;
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
      const results = common.map(bookKey=>{
        let decimal = 1;
        slip.forEach(leg=>{
          const row = leg.rows.find(r=>r.bookKey===bookKey);
          decimal *= americanToDecimal(row.odds);
        });
        return {bookKey, decimal};
      }).sort((a,b)=>b.decimal-a.decimal);

      // Selected book: sticky across re-renders while it still covers every leg;
      // defaults to the best-priced book.
      if(!state.selectedBook || !results.some(r=>r.bookKey===state.selectedBook)){
        state.selectedBook = results[0].bookKey;
      }
      const selected = results.find(r=>r.bookKey===state.selectedBook);
      const rowsFor = bookKey => slip.map(leg => leg.rows.find(r=>r.bookKey===bookKey));

      html += `<div style="font-size:12px; color:var(--text-dim); margin-bottom:8px;">Pick a book — all ${slip.length} legs priced together</div>`;
      html += `<div class="slip-book-chips">`;
      results.forEach(r=>{
        const style = bookStyleFor(r.bookKey);
        const name = style ? style.name : r.bookKey;
        const isBest = r === results[0];
        html += `<button type="button" class="slip-book-chip${r.bookKey===state.selectedBook?' active':''}" data-book-key="${escapeHtml(r.bookKey)}">
          <span class="chip-book-name">${escapeHtml(name)}</span>
          <span class="chip-book-odds">${fmtAmerican(decimalToAmerican(r.decimal))}</span>
          ${isBest ? '<span class="chip-best-tag">Best</span>' : ''}
        </button>`;
      });
      html += `</div>`;

      const selStyle = bookStyleFor(selected.bookKey);
      const selName = selStyle ? selStyle.name : selected.bookKey;
      html += `<div class="parlay-line" style="margin-top:10px;">
        ${linkedBadge(selected.bookKey)}
        <span class="odds">${fmtAmerican(decimalToAmerican(selected.decimal))}</span>
      </div>`;
      html += placeButtonsHtml(selected.bookKey, selName, rowsFor(selected.bookKey));

      html += `<div class="copy-block">${buildCopyText(selected.bookKey, selName)}</div>
        <button type="button" class="ghost copy-btn" data-book-key="${escapeHtml(selected.bookKey)}" data-book-name="${escapeHtml(selName)}" style="margin-top:6px; font-size:11.5px; padding:6px 10px;">Copy</button>`;
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
    area.querySelectorAll('.slip-book-chip').forEach(chip=>{
      chip.addEventListener('click', ()=>{
        state.selectedBook = chip.dataset.bookKey;
        renderParlay();
      });
    });
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
