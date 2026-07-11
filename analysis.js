// Pure computation for Get Props hit-probability analysis. No I/O.

const EDGE_MIN = 0.03;
const EDGE_CHECK_NEWS = 0.15;
const THIN_SAMPLE = 8;

function americanToDecimal(a){
  a = Number(a);
  return a > 0 ? 1 + a/100 : 1 + 100/Math.abs(a);
}

function poissonPmf(k, lambda){
  if(lambda <= 0) return k === 0 ? 1 : 0;
  let p = Math.exp(-lambda);
  for(let i = 1; i <= k; i++) p *= lambda / i;
  return p;
}

function poissonCdf(k, lambda){
  if(lambda <= 0) return 1;
  let sum = 0;
  let p = Math.exp(-lambda);
  for(let i = 0; i <= k; i++){
    if(i > 0) p *= lambda / i;
    sum += p;
  }
  return Math.min(sum, 1);
}

function pOver(line, lambda){
  return 1 - poissonCdf(Math.floor(line), lambda);
}

// values newest-first; weight decay^k for a value k games old
function weightedRate(values, decay = 0.9){
  if(!values.length) return 0;
  let num = 0, den = 0;
  values.forEach((v, i) => {
    const w = Math.pow(decay, i);
    num += v * w;
    den += w;
  });
  return num / den;
}

function mean(values){
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function blendedLambda(recentValues, seasonValues){
  return 0.7 * weightedRate(recentValues) + 0.3 * mean(seasonValues);
}

// prop: {player, market, line, overRows, underRows}; rows: {bookKey, bookTitle, odds}
// stats: {recentValues (newest-first), seasonValues}
function analyzeProp(prop, stats){
  const lambda = blendedLambda(stats.recentValues, stats.seasonValues);
  const modelOver = pOver(prop.line, lambda);
  const flags = [];
  if(stats.recentValues.length < THIN_SAMPLE) flags.push('thin_sample');

  // devig book-by-book where both sides are quoted
  const underBy = {};
  prop.underRows.forEach(r => underBy[r.bookKey] = r.odds);
  const fairOvers = [];
  prop.overRows.forEach(r => {
    if(underBy[r.bookKey] === undefined) return;
    const pO = 1 / americanToDecimal(r.odds);
    const pU = 1 / americanToDecimal(underBy[r.bookKey]);
    const s = pO + pU;
    if(s > 0) fairOvers.push(pO / s);
  });

  const candidates = [];
  if(fairOvers.length){
    const impOver = mean(fairOvers);
    candidates.push({ side:'Over',  modelP: modelOver,     impliedP: impOver,     rows: prop.overRows,  oneSided: false });
    candidates.push({ side:'Under', modelP: 1 - modelOver, impliedP: 1 - impOver, rows: prop.underRows, oneSided: false });
  } else {
    if(prop.overRows.length){
      candidates.push({ side:'Over', modelP: modelOver,
        impliedP: mean(prop.overRows.map(r => 1 / americanToDecimal(r.odds))),
        rows: prop.overRows, oneSided: true });
    }
    if(prop.underRows.length){
      candidates.push({ side:'Under', modelP: 1 - modelOver,
        impliedP: mean(prop.underRows.map(r => 1 / americanToDecimal(r.odds))),
        rows: prop.underRows, oneSided: true });
    }
  }
  if(!candidates.length) return null;

  let best = null;
  candidates.forEach(c => {
    c.edge = c.modelP - c.impliedP;
    if(!best || c.edge > best.edge) best = c;
  });
  if(best.edge < EDGE_MIN) return null;
  if(best.edge > EDGE_CHECK_NEWS) flags.push('check_news');
  if(best.oneSided) flags.push('one_sided');

  const rows = best.rows.slice().sort((a, b) => americanToDecimal(b.odds) - americanToDecimal(a.odds));
  const recentRate = weightedRate(stats.recentValues);
  const seasonRate = mean(stats.seasonValues);
  return {
    player: prop.player, market: prop.market, line: prop.line,
    side: best.side, modelP: best.modelP, impliedP: best.impliedP, edge: best.edge,
    rows, bestBook: rows[0] || null,
    analysis: {
      lambda, recentRate, seasonRate,
      trend: recentRate > seasonRate ? 'up' : recentRate < seasonRate ? 'down' : 'flat',
      recentValues: stats.recentValues,
      hitCount: stats.recentValues.filter(v => v > prop.line).length,
      windowSize: stats.recentValues.length,
      flags
    }
  };
}

function rankPicks(picks){
  return picks.filter(Boolean).sort((a, b) => b.edge - a.edge);
}

module.exports = {
  americanToDecimal, poissonPmf, poissonCdf, pOver,
  weightedRate, mean, blendedLambda, analyzeProp, rankPicks,
  EDGE_MIN, EDGE_CHECK_NEWS, THIN_SAMPLE
};
