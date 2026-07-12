(function(){
  renderNav('record');

  function pct(p){ return p === null || p === undefined ? '—' : (p*100).toFixed(1) + '%'; }
  const RESULT_CHIP = { hit: ['good','✓ Hit'], miss: ['bad','✗ Miss'], push: ['dim','— Push'], void: ['dim','∅ Void'] };

  async function load(){
    try{
      const res = await fetch('/api/record');
      if(!res.ok) throw new Error('Error ' + res.status);
      render(await res.json());
    }catch(e){
      showError(e.message || 'Could not load record.');
      document.getElementById('recordArea').innerHTML = '';
    }
  }

  function render(r){
    const area = document.getElementById('recordArea');
    const s = r.summary;
    if(!s.graded && !s.pending){
      area.innerHTML = `<div class="empty-state"><h3>No picks logged yet</h3>
        <p>Analyses log automatically — run "Analyze props" on the <a href="/getprops.html">Get Props page</a> and results appear here the day after the games.</p></div>`;
      return;
    }
    let html = `<div class="panel" style="margin-bottom:14px;">
      <h2>Calibration</h2>
      <div style="font-size:14px; line-height:1.7;">
        Model said <strong style="font-family:var(--font-mono);">${pct(s.avgModelP)}</strong> on average —
        reality delivered <strong style="font-family:var(--font-mono); color:${s.calibrationGap > 0.05 ? 'var(--bad)' : 'var(--good)'};">${pct(s.hitRate)}</strong>
        <span style="color:var(--text-faint); font-size:12px;">(${s.hits}–${s.misses} over ${s.graded} graded · ${s.pushes} pushes · ${s.voids} voids · ${s.pending} pending)</span>
      </div>
    </div>`;

    html += `<div class="panel" style="margin-bottom:14px;"><h2>By model confidence</h2>
      <table class="props-table"><thead><tr><th>Model said</th><th>Picks</th><th>Avg model</th><th>Actual</th></tr></thead><tbody>`;
    r.buckets.forEach(b => {
      html += `<tr><td>${escapeHtml(b.range)}%</td><td>${b.n}</td>
        <td style="font-family:var(--font-mono);">${pct(b.avgModelP)}</td>
        <td style="font-family:var(--font-mono);">${pct(b.actualRate)}</td></tr>`;
    });
    html += `</tbody></table></div>`;

    if(r.byMarket.length){
      html += `<div class="panel" style="margin-bottom:14px;"><h2>By market</h2>
        <table class="props-table"><thead><tr><th>Market</th><th>Picks</th><th>Avg model</th><th>Hit rate</th></tr></thead><tbody>`;
      r.byMarket.forEach(m => {
        html += `<tr><td>${escapeHtml(marketLabel(m.market))}</td><td>${m.n}</td>
          <td style="font-family:var(--font-mono);">${pct(m.avgModelP)}</td>
          <td style="font-family:var(--font-mono);">${pct(m.hitRate)}</td></tr>`;
      });
      html += `</tbody></table></div>`;
    }

    if(r.recent.length){
      html += `<div class="panel"><h2>Recent results</h2>
        <table class="props-table"><thead><tr><th>Result</th><th>Player</th><th>Pick</th><th>Model</th><th>Actual</th><th>Game</th></tr></thead><tbody>`;
      r.recent.forEach(p => {
        const [cls, label] = RESULT_CHIP[p.result] || ['dim', p.result];
        const color = cls === 'good' ? 'var(--good)' : cls === 'bad' ? 'var(--bad)' : 'var(--text-faint)';
        html += `<tr>
          <td style="color:${color}; font-weight:700; white-space:nowrap;">${escapeHtml(label)}</td>
          <td style="font-weight:600; white-space:nowrap;">${escapeHtml(p.player)}</td>
          <td style="white-space:nowrap;">${escapeHtml(p.side)} ${escapeHtml(String(p.line))} ${escapeHtml(marketLabel(p.market))}</td>
          <td style="font-family:var(--font-mono);">${pct(p.modelP)}</td>
          <td style="font-family:var(--font-mono);">${p.actual === null || p.actual === undefined ? '—' : escapeHtml(String(p.actual))}</td>
          <td style="color:var(--text-faint); font-size:11px; white-space:nowrap;">${escapeHtml(p.matchup)} · ${escapeHtml(p.gameDate)}</td>
        </tr>`;
      });
      html += `</tbody></table></div>`;
    }

    area.innerHTML = html;
  }

  load();

  fetchOddsFor(getSport()).then(r => updateTicker(r.games)).catch(()=>{});
})();
