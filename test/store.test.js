const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore, computeRecord } = require('../store');

function tmpDir(){ return fs.mkdtempSync(path.join(os.tmpdir(), 'lw-store-')); }
function pick(over = {}){
  return {
    id: 'ev1|P One|batter_hits|0.5|Over', ts: '2026-07-11T18:00:00.000Z',
    eventId: 'ev1', gameDate: '2026-07-11', matchup: 'A @ B',
    player: 'P One', mlbId: 111, market: 'batter_hits', line: 0.5, side: 'Over',
    modelP: 0.65, impliedP: 0.5, edge: 0.15,
    bestBook: { bookKey: 'fanduel', odds: -110 }, flags: [],
    ...over
  };
}

test('logPick appends, dedupes, and survives reload', () => {
  const dir = tmpDir();
  const s1 = createStore({ dataDir: dir });
  assert.equal(s1.logPick(pick()), true);
  assert.equal(s1.logPick(pick()), false);            // dedupe
  assert.equal(fs.readFileSync(s1.file, 'utf8').trim().split('\n').length, 1);
  const s2 = createStore({ dataDir: dir });            // reload folds
  assert.equal(s2.all().length, 1);
  assert.equal(s2.all()[0].player, 'P One');
});

test('grade overlays in memory, appends a grade line, survives reload', () => {
  const dir = tmpDir();
  const s1 = createStore({ dataDir: dir });
  s1.logPick(pick());
  assert.equal(s1.grade(pick().id, 2, 'hit', '2026-07-12T12:00:00.000Z'), true);
  assert.equal(s1.grade(pick().id, 2, 'hit', '2026-07-12T12:00:00.000Z'), false); // already graded
  assert.equal(s1.pending().length, 0);
  assert.equal(fs.readFileSync(s1.file, 'utf8').trim().split('\n').length, 2);
  const s2 = createStore({ dataDir: dir });
  assert.equal(s2.all()[0].result, 'hit');
  assert.equal(s2.all()[0].actual, 2);
});

test('corrupt trailing line is skipped on load', () => {
  const dir = tmpDir();
  const s1 = createStore({ dataDir: dir });
  s1.logPick(pick());
  fs.appendFileSync(s1.file, '{"type":"pick","id":"trunc');
  const s2 = createStore({ dataDir: dir });
  assert.equal(s2.all().length, 1);
});

test('memory-only mode: no dataDir, no file, still dedupes', () => {
  const s = createStore({ dataDir: null });
  assert.equal(s.logPick(pick()), true);
  assert.equal(s.logPick(pick()), false);
  assert.equal(s.all().length, 1);
});

test('computeRecord: hit rate excludes pushes and voids; calibration gap', () => {
  const recs = [
    { ...pick({ id: 'a' }), modelP: 0.6, result: 'hit' },
    { ...pick({ id: 'b' }), modelP: 0.6, result: 'miss' },
    { ...pick({ id: 'c' }), modelP: 0.6, result: 'push' },
    { ...pick({ id: 'd' }), modelP: 0.6, result: 'void' },
    { ...pick({ id: 'e' }), modelP: 0.6 }               // pending
  ];
  const r = computeRecord(recs);
  assert.equal(r.summary.graded, 4);
  assert.equal(r.summary.pending, 1);
  assert.equal(r.summary.hits, 1);
  assert.equal(r.summary.misses, 1);
  assert.equal(r.summary.pushes, 1);
  assert.equal(r.summary.voids, 1);
  assert.equal(r.summary.hitRate, 0.5);                 // 1 of 2 scored
  assert.ok(Math.abs(r.summary.avgModelP - 0.6) < 1e-9);
  assert.ok(Math.abs(r.summary.calibrationGap - 0.1) < 1e-9);
});

test('computeRecord: bucket boundaries', () => {
  const recs = [
    { ...pick({ id: 'a' }), modelP: 0.49, result: 'hit' },
    { ...pick({ id: 'b' }), modelP: 0.50, result: 'miss' },
    { ...pick({ id: 'c' }), modelP: 0.69, result: 'hit' },
    { ...pick({ id: 'd' }), modelP: 0.70, result: 'hit' }
  ];
  const byRange = Object.fromEntries(computeRecord(recs).buckets.map(b => [b.range, b]));
  assert.equal(byRange['0-50'].n, 1);
  assert.equal(byRange['50-60'].n, 1);
  assert.equal(byRange['60-70'].n, 1);
  assert.equal(byRange['70+'].n, 1);
  assert.equal(byRange['70+'].actualRate, 1);
});

test('computeRecord: byMarket and recent (sorted by gradedTs desc, max 25)', () => {
  const recs = [];
  for (let i = 0; i < 30; i++) {
    recs.push({ ...pick({ id: 'p' + i }), market: i % 2 ? 'batter_hits' : 'pitcher_strikeouts',
      result: 'hit', gradedTs: `2026-07-${String(10 + (i % 20)).padStart(2, '0')}T00:00:00.000Z` });
  }
  const r = computeRecord(recs);
  assert.equal(r.byMarket.length, 2);
  assert.equal(r.recent.length, 25);
  assert.ok(r.recent[0].gradedTs >= r.recent[24].gradedTs);
});

test('empty store: nulls not NaNs', () => {
  const r = computeRecord([]);
  assert.equal(r.summary.hitRate, null);
  assert.equal(r.summary.avgModelP, null);
  assert.equal(r.summary.calibrationGap, null);
});
