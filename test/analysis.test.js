const { test } = require('node:test');
const assert = require('node:assert');
const A = require('../analysis');

function close(a, b, eps = 1e-6){ assert.ok(Math.abs(a-b) < eps, `${a} !~ ${b}`); }

test('poisson pmf/cdf known values', () => {
  close(A.poissonPmf(0, 2), Math.exp(-2));
  close(A.poissonPmf(2, 2), 2*Math.exp(-2));
  close(A.poissonCdf(2, 2), 5*Math.exp(-2));
  close(A.pOver(2.5, 2), 1 - 5*Math.exp(-2));
  assert.equal(A.poissonPmf(0, 0), 1);
  assert.equal(A.poissonPmf(3, 0), 0);
});

test('weightedRate: newest-first decay 0.9', () => {
  close(A.weightedRate([2]), 2);
  close(A.weightedRate([3, 1]), (3*1 + 1*0.9) / 1.9);
  assert.equal(A.weightedRate([]), 0);
});

test('blendedLambda: 0.7 recent + 0.3 season', () => {
  close(A.blendedLambda([2], [4]), 0.7*2 + 0.3*4);
});

test('analyzeProp: two-sided devig, Over pick with positive edge', () => {
  // book quotes -110/-110 -> fair over prob 0.5; model gives ~0.68 over
  const prop = { player: 'P One', market: 'pitcher_strikeouts', line: 5.5,
    overRows: [{bookKey:'fanduel', bookTitle:'FanDuel', odds:-110}],
    underRows:[{bookKey:'fanduel', bookTitle:'FanDuel', odds:-110}] };
  // 10 identical starts of 7 Ks -> lambda 7; P(X>5.5)=1-CDF(5,7)
  const stats = { recentValues: Array(10).fill(7), seasonValues: Array(10).fill(7) };
  const pick = A.analyzeProp(prop, stats);
  assert.ok(pick);
  assert.equal(pick.side, 'Over');
  close(pick.impliedP, 0.5);
  close(pick.modelP, A.pOver(5.5, 7));
  close(pick.edge, pick.modelP - pick.impliedP);
  assert.equal(pick.analysis.hitCount, 10);       // all 10 games > 5.5
  assert.equal(pick.analysis.windowSize, 10);
  assert.equal(pick.analysis.trend, 'flat');
  assert.deepEqual(pick.bestBook, pick.rows[0]);
  assert.ok(pick.analysis.flags.includes('check_news')); // edge here is > 0.15
});

test('analyzeProp: Under side wins when model is low', () => {
  const prop = { player: 'P Two', market: 'batter_hits', line: 1.5,
    overRows: [{bookKey:'fanduel', bookTitle:'FanDuel', odds:-110}],
    underRows:[{bookKey:'fanduel', bookTitle:'FanDuel', odds:-110}] };
  // lambda ~0.5 hits/game -> P(over 1.5) tiny -> Under edge large
  const stats = { recentValues: Array(15).fill(0.5), seasonValues: Array(15).fill(0.5) };
  const pick = A.analyzeProp(prop, stats);
  assert.ok(pick);
  assert.equal(pick.side, 'Under');
  close(pick.modelP, 1 - A.pOver(1.5, 0.5));
});

test('analyzeProp: below edge threshold returns null', () => {
  const prop = { player: 'P Three', market: 'batter_hits', line: 0.5,
    overRows: [{bookKey:'fanduel', bookTitle:'FanDuel', odds:-316}],
    underRows:[{bookKey:'fanduel', bookTitle:'FanDuel', odds:+317}] };
  // implied over ~0.76 devig; model lambda 1.4 -> P(over 0.5) ~0.75 -> |edge| < 0.03 both sides
  const stats = { recentValues: Array(15).fill(1.4), seasonValues: Array(15).fill(1.4) };
  assert.equal(A.analyzeProp(prop, stats), null);
});

test('analyzeProp: one-sided market flagged, thin sample flagged', () => {
  const prop = { player: 'P Four', market: 'batter_total_bases', line: 1.5,
    overRows: [{bookKey:'fanduel', bookTitle:'FanDuel', odds:+150}],
    underRows: [] };
  const stats = { recentValues: Array(5).fill(3), seasonValues: Array(5).fill(3) };
  const pick = A.analyzeProp(prop, stats);
  assert.ok(pick);
  assert.ok(pick.analysis.flags.includes('one_sided'));
  assert.ok(pick.analysis.flags.includes('thin_sample'));
});

test('analyzeProp: no odds rows at all returns null', () => {
  const prop = { player: 'P Five', market: 'batter_hits', line: 0.5, overRows: [], underRows: [] };
  assert.equal(A.analyzeProp(prop, { recentValues: [1], seasonValues: [1] }), null);
});

test('rankPicks sorts by edge desc and drops nulls', () => {
  const ranked = A.rankPicks([{edge:0.05}, null, {edge:0.12}, {edge:0.03}]);
  assert.deepEqual(ranked.map(p=>p.edge), [0.12, 0.05, 0.03]);
});
