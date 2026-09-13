(function(){
  renderNav('notifications');
  fetchOddsFor(getSport(), {cacheOnly:true}).then(r=>updateTicker(r.games)).catch(()=>{});

  const SPORT_LABEL = Object.fromEntries(SPORTS);
  let watchlist = [];
  let prefs = { gameStart: true, betGraded: true };

  function fillSportSelect(){
    const sel = document.getElementById('watchSportSelect');
    sel.innerHTML = SPORTS.map(([key, label]) => `<option value="${key}">${escapeHtml(label)}</option>`).join('');
  }

  async function refreshPushStatus(){
    const body = document.getElementById('pushStatusBody');
    const btn = document.getElementById('pushToggleBtn');
    if(!pushSupported()){
      body.textContent = "This browser doesn't support push notifications.";
      btn.disabled = true;
      return;
    }
    const sub = await getPushSubscription();
    if(sub){
      body.textContent = 'Notifications are on for this browser.';
      btn.textContent = 'Disable notifications';
      btn.onclick = async () => { await unsubscribeFromPush(); refreshPushStatus(); };
    } else if(Notification.permission === 'denied'){
      body.textContent = 'Notifications are blocked for this site in your browser settings — enable them there, then reload this page.';
      btn.disabled = true;
    } else {
      body.textContent = 'Off — turn these on to get real push alerts, even when LineWatch isn\'t open in a tab.';
      btn.textContent = 'Enable notifications';
      btn.onclick = async () => {
        const res = await subscribeToPush();
        if(!res.ok) showError(res.reason === 'not_configured' ? 'Push isn\'t configured on this server yet.' : 'Could not enable notifications.');
        refreshPushStatus();
      };
    }
  }

  function renderWatchlist(){
    const host = document.getElementById('watchlistBody');
    if(!watchlist.length){
      host.innerHTML = '<div class="settings-hint">Nothing on your watchlist yet.</div>';
      return;
    }
    host.innerHTML = watchlist.map(w => `
      <div class="watchlist-row">
        <span class="watchlist-sport">${escapeHtml(SPORT_LABEL[w.sport] || w.sport)}</span>
        <span class="watchlist-team">${escapeHtml(w.team)}</span>
        <button class="ghost watchlist-remove-btn" data-sport="${escapeHtml(w.sport)}" data-team="${escapeHtml(w.team)}">Remove</button>
      </div>
    `).join('');
    host.querySelectorAll('.watchlist-remove-btn').forEach(btn=>{
      btn.addEventListener('click', async () => {
        await fetch('/api/watchlist', { method:'DELETE', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ sport: btn.dataset.sport, team: btn.dataset.team }) });
        await loadWatchlist();
      });
    });
  }

  async function loadWatchlist(){
    const res = await fetch('/api/watchlist');
    if(!res.ok) return;
    const data = await res.json();
    watchlist = data.watchlist || [];
    prefs = data.prefs || prefs;
    document.getElementById('prefBetGraded').checked = !!prefs.betGraded;
    document.getElementById('prefGameStart').checked = !!prefs.gameStart;
    renderWatchlist();
  }

  document.getElementById('watchAddBtn').addEventListener('click', async () => {
    const sport = document.getElementById('watchSportSelect').value;
    const teamInput = document.getElementById('watchTeamInput');
    const team = teamInput.value.trim();
    if(!team) return;
    const res = await fetch('/api/watchlist', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ sport, team }) });
    if(res.ok){
      teamInput.value = '';
      await loadWatchlist();
      showToast('Added to watchlist ✓');
    }
  });
  document.getElementById('watchTeamInput').addEventListener('keydown', (e)=>{
    if(e.key === 'Enter') document.getElementById('watchAddBtn').click();
  });

  ['prefBetGraded','prefGameStart'].forEach(id=>{
    document.getElementById(id).addEventListener('change', async () => {
      await fetch('/api/notify/prefs', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({
        betGraded: document.getElementById('prefBetGraded').checked,
        gameStart: document.getElementById('prefGameStart').checked
      }) });
    });
  });

  fillSportSelect();
  refreshPushStatus();
  loadWatchlist();
})();
