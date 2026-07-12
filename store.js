// Append-only pick/outcome store + record aggregation. JSONL on disk when
// dataDir is provided; memory-only otherwise (tests, or missing volume).
const fs = require('fs');
const path = require('path');

function createStore({ dataDir } = {}){
  const file = dataDir ? path.join(dataDir, 'picks.jsonl') : null;
  const picks = new Map(); // id -> pick record with grade overlay
  let warned = false;

  if (file) {
    try {
      if (fs.existsSync(file)) {
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          let rec;
          try { rec = JSON.parse(line); } catch (e) { console.error('store: skipping corrupt line'); continue; }
          if (rec.type === 'pick' && !picks.has(rec.id)) {
            picks.set(rec.id, rec);
          } else if (rec.type === 'grade' && picks.has(rec.id)) {
            Object.assign(picks.get(rec.id), { actual: rec.actual, result: rec.result, gradedTs: rec.gradedTs });
          }
        }
      }
    } catch (e) {
      console.error(`store: load failed (${e.message}) — starting empty`);
    }
    console.log('store: persisting to ' + file + ' (' + picks.size + ' records loaded)');
  }

  function append(rec){
    if (!file) return;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.appendFileSync(file, JSON.stringify(rec) + '\n');
    } catch (e) {
      if (!warned) console.error(`store: write failed (${e.message}) — continuing in-memory only`);
      warned = true;
    }
  }

  function logPick(p){
    if (picks.has(p.id)) return false;
    const rec = { type: 'pick', ...p };
    picks.set(p.id, rec);
    append(rec);
    return true;
  }

  function grade(id, actual, result, gradedTs){
    const rec = picks.get(id);
    if (!rec || rec.result) return false;
    Object.assign(rec, { actual, result, gradedTs });
    append({ type: 'grade', id, actual, result, gradedTs });
    return true;
  }

  return {
    logPick,
    grade,
    pending: () => [...picks.values()].filter(r => !r.result),
    all: () => [...picks.values()],
    file
  };
}

function computeRecord(records){
  const graded = records.filter(r => r.result);
  const scored = graded.filter(r => r.result === 'hit' || r.result === 'miss');
  const hits = scored.filter(r => r.result === 'hit').length;
  const avg = (rs, f) => rs.length ? rs.reduce((a, r) => a + f(r), 0) / rs.length : null;
  const summary = {
    graded: graded.length,
    pending: records.length - graded.length,
    hits,
    misses: scored.length - hits,
    pushes: graded.filter(r => r.result === 'push').length,
    voids: graded.filter(r => r.result === 'void').length,
    hitRate: scored.length ? hits / scored.length : null,
    avgModelP: avg(scored, r => r.modelP)
  };
  summary.calibrationGap = summary.hitRate === null ? null : summary.avgModelP - summary.hitRate;

  const bucketDefs = [['0-50', 0, 0.5], ['50-60', 0.5, 0.6], ['60-70', 0.6, 0.7], ['70+', 0.7, 1.01]];
  const buckets = bucketDefs.map(([range, lo, hi]) => {
    const rs = scored.filter(r => r.modelP >= lo && r.modelP < hi);
    const h = rs.filter(r => r.result === 'hit').length;
    return { range, n: rs.length, avgModelP: avg(rs, r => r.modelP), actualRate: rs.length ? h / rs.length : null };
  });

  const markets = {};
  scored.forEach(r => {
    const m = markets[r.market] || (markets[r.market] = { market: r.market, n: 0, hits: 0, sumP: 0 });
    m.n++; m.sumP += r.modelP; if (r.result === 'hit') m.hits++;
  });
  const byMarket = Object.values(markets).map(m => ({
    market: m.market, n: m.n, hitRate: m.hits / m.n, avgModelP: m.sumP / m.n
  }));

  const recent = graded.slice()
    .sort((a, b) => String(b.gradedTs || '').localeCompare(String(a.gradedTs || '')))
    .slice(0, 25);

  return { summary, buckets, byMarket, recent };
}

module.exports = { createStore, computeRecord };
