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
  // First pick ever: default to whichever book best covers the WHOLE slip
  // (the same ranking the "Parlay at" chips use), not this leg's own best
  // price in isolation — that in-isolation default was exactly what
  // fragmented multi-leg slips across different books before you ever got
  // a say. Falls back to this leg's best price only when no book in common
  // with the rest of the slip exists (or it's the only leg).
  function selectedRowFor(leg, slip){
    const pickList = pickListFor(leg);
    let row = pickList.find(r=>r.bookKey===leg.selectedBookKey);
    if(!row){
      const coverage = slip ? computeBookCoverage(slip) : [];
      const shared = coverage.find(c => pickList.some(r=>r.bookKey===c.bookKey));
      row = (shared && pickList.find(r=>r.bookKey===shared.bookKey)) || pickList[0];
      updateLegBook(leg.id, row.bookKey);
    }
    return row;
  }

  // Every book that quotes at least one leg, ranked so books covering EVERY
  // leg (a real single-book parlay) come first — but a book missing only a
  // leg or two still shows, ranked by how much it covers, so there's a
  // useful default even when nothing covers 100%. Checks every book that
  // actually appears on the slip, not a hardcoded shortlist of two or three.
  // Among books with equal coverage, FanDuel wins, then DraftKings, then
  // best combined price — those two are the default/majority preference,
  // not just whichever happens to price a hair better.
  const BOOK_PRIORITY = { fanduel: 0, draftkings: 1 };
  function computeBookCoverage(slip){
    const bookKeys = new Set();
    slip.forEach(leg => pickListFor(leg).forEach(r => bookKeys.add(r.bookKey)));
    const coverage = [...bookKeys].map(bookKey=>{
      let count = 0, decimal = 1;
      slip.forEach(leg=>{
        const row = pickListFor(leg).find(r=>r.bookKey===bookKey);
        if(row){ count++; decimal *= americanToDecimal(row.odds); }
      });
      return { bookKey, count, decimal };
    });
    coverage.sort((a,b)=>{
      if(b.count !== a.count) return b.count - a.count;
      const pa = BOOK_PRIORITY[a.bookKey] ?? 99, pb = BOOK_PRIORITY[b.bookKey] ?? 99;
      if(pa !== pb) return pa - pb;
      return b.decimal - a.decimal;
    });
    return coverage;
  }

  // One-tap "combine everything at this book" instead of reopening each
  // leg's dropdown by hand. Only shown for 2+ legs, since one leg is never
  // a parlay in the first place.
  function renderParlayPicker(slip){
    const host = document.getElementById('parlayPicker');
    if(!host) return;
    if(slip.length < 2){ host.innerHTML = ''; return; }
    const coverage = computeBookCoverage(slip);
    if(!coverage.length){ host.innerHTML = ''; return; }
    const currentBooks = new Set(slip.map(l=>l.selectedBookKey));
    const allSameBook = currentBooks.size === 1 ? [...currentBooks][0] : null;
    host.innerHTML = `<div class="parlay-picker-label">Parlay at</div>
      <div class="parlay-picker">${coverage.map(c=>{
        const style = bookStyleFor(c.bookKey);
        const name = style ? style.name : c.bookKey;
        const full = c.count === slip.length;
        const active = allSameBook === c.bookKey;
        const priceLabel = fmtAmerican(decimalToAmerican(c.decimal));
        const title = full ? `Covers all ${slip.length} legs at ${priceLabel}` : `Covers ${c.count} of ${slip.length} legs (combined ${priceLabel} for those) — the rest stay on their own book`;
        return `<button type="button" class="parlay-chip${active?' active':''}${full?'':' partial'}" data-book-key="${escapeHtml(c.bookKey)}" title="${escapeHtml(title)}">
          <span class="parlay-chip-name">${escapeHtml(name)}${full?'':` <span class="parlay-chip-count">${c.count}/${slip.length}</span>`}</span>
          <span class="parlay-chip-odds">${escapeHtml(priceLabel)}</span>
        </button>`;
      }).join('')}</div>`;
    host.querySelectorAll('.parlay-chip').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const bookKey = btn.dataset.bookKey;
        slip.forEach(leg=>{
          if(pickListFor(leg).some(r=>r.bookKey===bookKey)) updateLegBook(leg.id, bookKey);
        });
        renderSlip();
      });
    });
  }

  function renderSlip(){
    const slip = getSlip();
    const legsEl = document.getElementById('slipLegs');
    const emptyEl = document.getElementById('slipEmpty');
    const countEl = document.getElementById('slipCount');
    countEl.textContent = slip.length + ' leg' + (slip.length===1?'':'s');
    legsEl.innerHTML = '';
    emptyEl.style.display = slip.length ? 'none' : 'block';
    document.getElementById('saveBetBtn').disabled = !slip.length;
    renderParlayPicker(slip);

    slip.forEach(leg=>{
      const pickList = pickListFor(leg);
      const selected = selectedRowFor(leg, slip);
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
        <div class="leg-book-tabs" role="tablist" aria-label="Book">
          ${pickList.map(r=>{
            const style = bookStyleFor(r.bookKey);
            const active = r.bookKey === selected.bookKey;
            return `<button type="button" class="leg-book-tab${active?' active':''}" data-book-key="${escapeHtml(r.bookKey)}" role="tab" aria-selected="${active}">
              <span>${escapeHtml(style ? style.name : r.bookTitle)}</span>
              <span class="leg-book-tab-odds">${fmtAmerican(r.odds)}</span>
            </button>`;
          }).join('')}
        </div>
        ${(()=>{
          if(!leg.pendingRows) return '';
          const freshRow = leg.pendingRows.find(r=>r.bookKey===selected.bookKey);
          if(!freshRow) return '';
          const style = bookStyleFor(selected.bookKey);
          return `<div class="leg-odds-moved">
            <span>Price moved at ${escapeHtml(style ? style.name : selected.bookTitle)}: ${fmtAmerican(selected.odds)} → <b>${fmtAmerican(freshRow.odds)}</b></span>
            <button type="button" class="ghost leg-update-btn">Update</button>
          </div>`;
        })()}
      `;
      div.querySelector('.remove-btn').addEventListener('click', ()=>{
        div.classList.add('removing');
        setTimeout(()=>{
          removeLegFromSlip(leg.id);
          renderSlip();
        }, 200);
      });
      div.querySelectorAll('.leg-book-tab').forEach(btn=>{
        btn.addEventListener('click', ()=>{
          updateLegBook(leg.id, btn.dataset.bookKey);
          div.querySelectorAll('.leg-book-tab').forEach(b=>{
            const isActive = b === btn;
            b.classList.toggle('active', isActive);
            b.setAttribute('aria-selected', String(isActive));
          });
          // Switching tabs means whatever "price moved" notice was pinned to
          // the old selection no longer applies to what's now showing —
          // drop it without a full re-render, same lightweight update as
          // the tab switch itself.
          const s = getSlip();
          const l = s.find(x=>x.id===leg.id);
          if(l && l.pendingRows){
            delete l.pendingRows;
            saveSlip(s);
            const notice = div.querySelector('.leg-odds-moved');
            if(notice) notice.remove();
          }
          renderParlay();
        });
      });
      const updateBtn = div.querySelector('.leg-update-btn');
      if(updateBtn){
        updateBtn.addEventListener('click', ()=>{
          const s = getSlip();
          const l = s.find(x=>x.id===leg.id);
          if(l && l.pendingRows){ l.rows = l.pendingRows; delete l.pendingRows; saveSlip(s); }
          renderSlip();
        });
      }
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

    const selectedRows = slip.map(leg => selectedRowFor(leg, slip));

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
      const row = leg.rows.find(r=>r.bookKey===bookKey) || selectedRowFor(leg, slip);
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

  // ---------- saved bets ----------
  // A saved leg's rows/selectedBookKey are a frozen snapshot from when it was
  // saved — no My-Books re-filtering, no writing back to the active slip.
  // Purely for display until (if) it's loaded back into the active slip.
  function bestRowForSavedLeg(leg){
    return (leg.rows || []).find(r=>r.bookKey===leg.selectedBookKey) || leg.rows[0] || null;
  }
  function fmtSavedDate(ts){
    const d = new Date(ts);
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString(undefined, {month:'short', day:'numeric', year: sameYear ? undefined : 'numeric'})
      + ' · ' + d.toLocaleTimeString(undefined, {hour:'numeric', minute:'2-digit'});
  }
  function renderSavedBets(){
    const saved = getSavedBets();
    const area = document.getElementById('savedBetsArea');
    const countEl = document.getElementById('savedBetsCount');
    countEl.textContent = saved.length ? saved.length + ' saved' : '';
    if(!saved.length){
      area.innerHTML = `<div style="color:var(--text-faint); font-size:12.5px;">Bets you save from the slip above show up here — come back anytime to review or load one back in.</div>`;
      return;
    }
    area.innerHTML = '';
    saved.forEach(bet=>{
      const card = document.createElement('div');
      card.className = 'leg-item';
      card.style.marginBottom = '10px';
      const legsHtml = bet.legs.map(leg=>{
        const row = bestRowForSavedLeg(leg);
        const style = row ? bookStyleFor(row.bookKey) : null;
        return `<div class="parlay-line" style="padding:4px 0;">
          <div style="min-width:0;">
            <div class="leg-title" style="font-size:12.5px;">${escapeHtml(leg.side)}</div>
            <div class="leg-sub">${escapeHtml(leg.matchup)}</div>
          </div>
          ${row ? `<span class="odds" style="margin-left:auto; display:flex; align-items:center; gap:6px;">${escapeHtml(style ? style.name : row.bookTitle)} ${fmtAmerican(row.odds)}</span>` : ''}
        </div>`;
      }).join('');
      card.innerHTML = `
        <div class="leg-top">
          <div>
            <div class="leg-title">${bet.legs.length} leg${bet.legs.length===1?'':'s'}</div>
            <div class="leg-sub">Saved ${escapeHtml(fmtSavedDate(bet.savedAt))}</div>
          </div>
          <button class="remove-btn" title="Delete">×</button>
        </div>
        ${legsHtml}
        <button type="button" class="ghost load-saved-btn" style="width:100%; margin-top:8px; font-size:11.5px; padding:6px 10px;">↩ Load into Slip</button>
      `;
      card.querySelector('.remove-btn').addEventListener('click', ()=>{
        card.classList.add('removing');
        setTimeout(()=>{
          deleteSavedBet(bet.id);
          renderSavedBets();
        }, 200);
      });
      card.querySelector('.load-saved-btn').addEventListener('click', ()=>{
        loadSavedBetIntoSlip(bet.id);
        showToast('Loaded into Slip ✓');
        renderSlip();
        renderSavedBets();
      });
      area.appendChild(card);
    });
    staggerIn(area, 30);
  }

  document.getElementById('saveBetBtn').addEventListener('click', ()=>{
    if(!saveCurrentSlipAsBet()) return;
    showToast('Bet saved ✓');
    renderSlip();
    renderSavedBets();
  });

  // Board-added legs carry `meta` (sport/market/selection/point) — enough to
  // look the same outcome back up in a fresh odds fetch instead of trusting
  // whatever price was frozen in when "+ Slip" was clicked, which can be
  // hours or days stale if the leg's just been sitting here. Cache-only,
  // same reasoning as the ticker fetch below — this never spends a fresh
  // credit, just picks up whatever's already warmed the cache (e.g. from
  // using Board). Prop legs have no meta and are left as-is.
  // Board-added legs (moneyline/spread/total, via `meta`) get checked against
  // the cached feed on load. A price change on a book you're not even looking
  // at gets folded in silently — nothing about that affects what you'd see or
  // place. But if the book your leg's tab is actually sitting on moved, this
  // doesn't just swap the number out from under you (that's what the parlay
  // handoff bug in section 8 was, minus the crash) — it holds the new price
  // as `leg.pendingRows` and renderSlip() surfaces it as an explicit "price
  // moved, Update?" on that leg, same idea as FanDuel's own "odds have
  // changed, accept?" prompt on a real bet slip.
  async function refreshSlipOdds(){
    const slip = getSlip();
    const sports = [...new Set(slip.filter(l=>l.meta).map(l=>l.meta.sport))];
    if(!sports.length) return false;
    const gamesBySport = {};
    await Promise.all(sports.map(async sport=>{
      try{ gamesBySport[sport] = (await fetchOddsFor(sport, {cacheOnly:true})).games; }
      catch(e){ gamesBySport[sport] = []; }
    }));
    let changed = false;
    slip.forEach(leg=>{
      if(!leg.meta) return;
      const games = gamesBySport[leg.meta.sport] || [];
      const game = games.find(g => leg.matchup === `${g.away_team} @ ${g.home_team}`);
      if(!game) return;
      const pool = poolFor(game.bookmakers);
      const freshRows = leg.meta.market === 'h2h'
        ? rowsFor(pool, leg.meta.market, leg.meta.selection)
        : modalPointRows(pool, leg.meta.market, leg.meta.selection);
      if(!freshRows.length) return;
      const oldRow = leg.rows.find(r => r.bookKey === leg.selectedBookKey);
      const freshRow = freshRows.find(r => r.bookKey === leg.selectedBookKey);
      if(oldRow && freshRow && oldRow.odds !== freshRow.odds){
        leg.pendingRows = freshRows;
      } else {
        leg.rows = freshRows;
        delete leg.pendingRows;
      }
      changed = true;
    });
    if(changed) saveSlip(slip);
    return changed;
  }

  renderSlip();
  renderManual();
  renderSavedBets();

  // Re-renders only if a leg's price actually moved since it was added.
  refreshSlipOdds().then(changed => { if(changed) renderSlip(); }).catch(()=>{});

  // fill the ticker quietly, cache-only — never spends a fresh credit just to decorate this page
  fetchOddsFor(getSport(), {cacheOnly:true}).then(r=>updateTicker(r.games)).catch(()=>{});
})();
