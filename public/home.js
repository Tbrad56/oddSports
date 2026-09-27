(function(){
  renderNav('home');
  renderSportChips(document.getElementById('sportChips'), load);

  async function load(){
    clearError();
    setStatus(false, "Loading today's games…");
    try{
      const {games, remaining, cacheAge} = await fetchOddsFor(getSport());
      updateTicker(games);
      const freshness = cacheAge >= 60 ? `cached ${Math.round(cacheAge/60)} min ago` : `updated ${new Date().toLocaleTimeString()}`;
      setStatus(true, `Live — ${games.length} games${remaining ? ' · '+remaining+' requests left this month' : ''} · ${freshness}`);
    }catch(e){
      setStatus(false, 'Fetch failed.');
      showError(e.message || 'Could not fetch odds — try again shortly.');
    }
  }

  load();
})();
