# Get Props — Hit-Probability Analysis Page — Design

**Date:** 2026-07-11
**Status:** Approved

## Context

LineWatch currently finds value by comparing book prices against the market's
own consensus (devig). The user wants a "Get Props" page that goes further:
estimate the **actual hit probability** of MLB player props from real player
statistics, compare that against the books' implied probability, and present
ranked picks with supporting analysis a bettor can read and check.

## Decisions (locked with user)

| Decision | Choice |
|---|---|
| Sport | MLB only for v1 (free official StatsAPI, in season; architecture leaves room for more sports later) |
| Model | Transparent stats model: recency-weighted recent rate blended with season rate, Poisson tail for P(over). No black box, no matchup adjustments in v1 |
| Output | Ranked list by edge with expandable per-pick analysis |
| Quota | Per-game on-demand (user picks a game; ~12 Odds API credits via the existing shared 10-min cache). No slate scans on the free tier |
| Architecture | Server-side analysis module + endpoint; thin client page |

## Data flow

```
getprops.html → GET /api/analyze/mlb/:eventId → server:
  1. Prop odds for the game — internal reuse of the existing Odds API
     proxy path and cache (markets from PROP_MARKETS.baseball_mlb)
  2. Player name → MLB person ID — MLB StatsAPI people search,
     cached permanently in memory; unmatched names skipped and listed
  3. Game logs per player — MLB StatsAPI (statsapi.mlb.com, free, no key),
     cached in memory 6 hours per player
  4. analysis.js computes probabilities and edges → ranked JSON
```

No new API key and no new env var. MLB StatsAPI is called server-side only.

## The model (analysis.js — pure functions)

Applies to the five MLB count-stat markets already in `PROP_MARKETS`:
`pitcher_strikeouts`, `batter_hits`, `batter_total_bases`, `batter_rbis`,
`batter_home_runs`.

- **Rate estimate:** λ = 0.7 × recent + 0.3 × season, where *recent* is the
  recency-weighted per-game rate over the last 15 games (batters) or last 10
  starts (pitchers), weight 0.9^k for a game k games old; *season* is the
  season per-game rate.
- **Hit probability:** P(over line) = Poisson tail P(X > line) = 1 − CDF(⌊line⌋, λ).
- **Book probability:** devig each book quoting both Over and Under of the
  same line (same pairing logic as `computeFairDecimal`), average the fair
  probabilities. If only one side is quoted anywhere, use the raw implied
  probability and mark the pick `one_sided: true`.
- **Both sides evaluated:** each line yields an Over candidate
  (P = Poisson tail) and an Under candidate (P = 1 − tail), each compared
  against its own side's implied probability; a line contributes at most its
  better side to the picks.
- **Edge:** model P − book implied P. Report only edge ≥ 3%. Rank descending.
- **Flags:** `thin_sample` when fewer than 8 usable games; `check_news` when
  edge > 15% (a gap that large usually means the line knows something —
  injury, rest day, lineup change).

Per-pick analysis payload (everything the UI shows must come from here):
player, market, line, side, model P, implied P, edge, best book + price,
hit count vs the line over the recent window (e.g. "9 of last 15"),
recent-window per-game values (for a small bar strip), λ, season rate,
recent rate, trend direction (recent vs season), flags.

## Server changes

- `analysis.js` (new): pure functions — Poisson pmf/cdf, recency weighting,
  blending, devig pairing, edge computation, ranking, flag logic. No I/O.
- `server.js`: new route `GET /api/analyze/mlb/:eventId` — validates eventId
  (same regex as props route), orchestrates the three fetches (props via the
  existing internal proxy/cache; StatsAPI person search; StatsAPI game logs),
  calls analysis.js, returns `{picks: [...], skipped: [...], generatedAt}`.
  Analysis responses cached 10 minutes keyed by eventId (aligned with the
  props cache TTL).
- StatsAPI caches: person-ID map (no TTL), game logs (6 h). In-memory Maps,
  same pattern as the odds cache.
- StatsAPI failures → 502 `{error: "Stats service unavailable"}`; the Odds
  API error mapping is inherited from the existing proxy.

## Page + nav

- `public/getprops.html` + `public/getprops.js`, same skeleton and design
  system as the other pages (2-col `layout no-side`).
- Nav rail gains a 5th link: 🎯 "Get Props" → `/getprops.html`
  (one entry added to the items array in `renderNav`; shows on all pages).
- Page flow: today's MLB games listed as cards (from the cached
  `/api/odds/baseball_mlb` call); each card has an "Analyze props" button
  labeled with its quota cost ("~12 credits"); results render as a ranked
  table (player, prop + line, model %, book %, edge, best book); clicking a
  row expands the analysis panel (recent-game bar strip, hit count vs line,
  λ vs line, trend, flags); skipped/unmatched players listed at the bottom.
- Add-to-slip button per pick (reuses `addLegToSlip` + toast with the
  prop's line-shop rows).

## Honesty & disclaimers

The page footer (and an inline note above results) states: probabilities are
estimates from small samples of past performance; books price in injuries,
lineups, weather, and matchups that this model does not see; positive edge is
a research lead, not a guarantee. `check_news` flags render prominently.

## Testing

- `analysis.js` unit tests (node:test, no I/O): Poisson values against known
  results, recency weights, blend, devig pairing (reuse fixtures shaped like
  Odds API responses), edge threshold and ranking, both flags.
- Endpoint test with injected fake fetches (Odds API + StatsAPI shapes),
  asserting ranked output, skipped-player reporting, cache behavior, and
  error mapping. Extends the existing 11-test suite and patterns.
- Live verification: analyze one real MLB game; hand-check one pick's math
  (recompute λ and Poisson tail from the shown game log).

## Out of scope (v1)

- Other sports (NHL next candidate when season starts; NBA blocked by API
  access from cloud hosts; NFL needs a data pipeline)
- Matchup adjustments (opponent quality, park factors, platoon splits)
- Slate-wide daily scans (needs paid Odds API tier)
- Historical model-accuracy tracking (worth doing in v2 — log picks and
  outcomes to measure calibration)
- Non-count markets (e.g. anytime-HR "yes/no" is just line 0.5 and works;
  true binary markets without lines are excluded)
