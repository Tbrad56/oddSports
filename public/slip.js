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

  // Books this leg can be placed with — scoped to "My Books" (audit: picking a
  // book is now the user's call, not an auto "best price" pick), falling back
  // to every book on the leg when My Books is empty or none of them quote it.
  function pickListFor(leg){
    return filterToMyBooks(leg.rows, r=>r.bookKey);
  }
  // Resolves (and persists, if unset) which book a leg is placed with.
  function selectedRowFor(leg){
    const pickList = pickListFor(leg);
    let row = pickList.find(r=>r.bookKey===leg.selectedBookKey);
    if(!row){
      row = pickList[0];
      updateLegBook(leg.id, row.bookKey);
    }
    return row;
  }

  function renderSlip(){
    const slip = getSlip();
    const legsEl = document.getElementById('slipLegs');
    const emptyEl = document.getElementById('slipEmpty');
    const countEl = document.getElementById('slipCount');
    countEl.textContent = slip.length + ' leg' + (slip.length===1?'':'s');
    legsEl.innerHTML = '';
    emptyEl.style.display = slip.length ? 'none' : 'block';

    slip.forEach(leg=>{
      const pickList = pickListFor(leg);
      const selected = selectedRowFor(leg);
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
        <label class="leg-book-row">
          <span class="leg-book-label">Book</span>
          <select class="leg-book-select">
            ${pickList.map(r=>{
              const style = bookStyleFor(r.bookKey);
              return `<option value="${escapeHtml(r.bookKey)}" ${r.bookKey===selected.bookKey?'selected':''}>${escapeHtml(style ? style.name : r.bookTitle)} · ${fmtAmerican(r.odds)}</option>`;
            }).join('')}
          </select>
        </label>
      `;
      div.querySelector('.remove-btn').addEventListener('click', ()=>{
        div.classList.add('removing');
        setTimeout(()=>{
          removeLegFromSlip(leg.id);
          renderSlip();
        }, 200);
      });
      div.querySelector('.leg-book-select').addEventListener('change', (e)=>{
        updateLegBook(leg.id, e.target.value);
        renderParlay();
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

    const selectedRows = slip.map(selectedRowFor);

    if(slip.length === 1){
      const row = selectedRows[0];
      const style = bookStyleFor(row.bookKey);
      area.innerHTML = `
        <div class="parlay-result">
          <div style="font-size:12px; color:var(--text-dim); margin-bottom:6px;">Single bet</div>
          <div class="parlay-line">
            ${linkedBadge(row.bookKey, row.bookTitle)}
            <span class="odds">${fmtAmerican(row.odds)}</span>
          </div>
          ${row.link ? `<a class="place-all-btn" href="${escapeHtml(row.link)}" target="_blank" rel="noopener">Place bet on ${escapeHtml(style ? style.name : row.bookTitle)} ↗</a>
          <div class="place-note">Opens with this selection in your slip — set your wager there.</div>` : ''}
        </div>
      `;
      staggerIn(area);
      return;
    }

    // Every leg is placed with whichever book the user picked for it above —
    // if they all landed on the same book this is a real parlay; otherwise
    // it's a set of separate single bets, each opened with its own leg's link.
    const bookKeys = new Set(selectedRows.map(r=>r.bookKey));
    let html = '<div class="parlay-result">';
    if(bookKeys.size === 1){
      const bookKey = selectedRows[0].bookKey;
      const style = bookStyleFor(bookKey);
      const bookName = style ? style.name : selectedRows[0].bookTitle;
      let decimal = 1;
      selectedRows.forEach(r=> decimal *= americanToDecimal(r.odds));
      html += `<div style="font-size:12px; color:var(--text-dim); margin-bottom:6px;">Parlay on ${escapeHtml(bookName)}</div>
        <div class="parlay-line">
          ${linkedBadge(bookKey, selectedRows[0].bookTitle)}
          <span class="odds">${fmtAmerican(decimalToAmerican(decimal))}</span>
        </div>`;

      const buttonsHtml = placeButtonsHtml(bookKey, bookName, selectedRows);
      html += buttonsHtml;

      // Copy/paste is a last resort — only shown when this book offers no
      // deep link at all, so the default path is always one-tap.
      if(!buttonsHtml){
        html += `<div class="copy-block">${buildCopyText(bookKey, bookName)}</div>
          <button type="button" class="ghost copy-btn" data-book-key="${escapeHtml(bookKey)}" data-book-name="${escapeHtml(bookName)}" style="margin-top:6px; font-size:11.5px; padding:6px 10px;">Copy</button>`;
      }
    } else {
      html += `<div style="font-size:12px; color:var(--text-dim); margin-bottom:6px;">Your picks span ${bookKeys.size} books — these can't combine into one parlay, so each opens as its own single bet:</div>`;
      const legBtns = [];
      slip.forEach((leg,i)=>{
        const row = selectedRows[i];
        html += `<div class="parlay-line">
          ${linkedBadge(row.bookKey, row.bookTitle)}
          <span class="odds">${fmtAmerican(row.odds)}</span>
        </div>`;
        if(row.link){
          const style = bookStyleFor(row.bookKey);
          legBtns.push(`<a class="place-leg-btn" href="${escapeHtml(row.link)}" target="_blank" rel="noopener">${escapeHtml(leg.side)} on ${escapeHtml(style ? style.name : row.bookTitle)} ↗</a>`);
        }
      });
      if(legBtns.length){
        html += `<div class="place-leg-list" style="margin-top:8px;">${legBtns.join('')}</div>`;
      }
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
      const row = leg.rows.find(r=>r.bookKey===bookKey) || selectedRowFor(leg);
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
