# Kalshi Integration — Design

**Date:** 2026-07-12
**Status:** Draft — argue in the PR before this becomes buildable
**Priority direction (Tai):** B — get Kalshi into the value math, done right.

## 1. Where we are today

The Board shows a Kalshi reference row per game side (`public/common.js`,
`kalshiRowFor` and friends):

- Browser calls Kalshi's **public** API directly:
  `GET https://api.elections.kalshi.com/trade-api/v2/events?series_ticker=<S>&status=open&with_nested_markets=true`
  — no key, no auth. Series: `KXMLBGAME`, `KXNBAGAME`, `KXNFLGAME`,
  `KXNHLGAME`, `KXEPLGAME`.
- Prices come from bid/ask midpoint (fallback: last trade), in cents
  (1–99 = implied probability %), converted to American odds for display.
- Matching Odds-API team names to Kalshi event titles is **fuzzy**
  (drop-city / nickname candidates) — works, but it's the fragile joint.
- Deliberately **excluded** from Best/Value ranking today. Reference only.

Known weaknesses of the current setup:

- **Client-side fetch** — every visitor hits Kalshi separately (no shared
  cache), ad-blockers/CORS changes can kill it silently, and server-side
  features (value math, tracking) can't see the data at all.
- **No liquidity awareness** — a market with 12 contracts traded shows a
  "price" that is really just noise between two resting orders.
- **No fee adjustment** — Kalshi charges trading fees (roughly
  `0.07 × price × (1-price)` per contract, ~1.75¢ at 50¢); the screen price
  understates the true cost of taking a position, exactly like vig does.

## 2. Kalshi price semantics (the part that matters for math)

A Kalshi YES price of 62¢ is a direct implied probability: the crowd, with
real money, says 62%. Unlike a sportsbook line there is **no vig baked into
one number** — instead the cost lives in:

1. **The spread** — bid 60 / ask 64 means "62%" is a midpoint of a 4-point
   disagreement zone. Wide spread = low conviction/liquidity.
2. **Fees** — taker fees shave effective edge, worst near 50¢.

So the honest "Kalshi fair probability" for consensus purposes is the
**midpoint, gated on liquidity, with the spread treated as an error bar** —
not the raw last-trade print.

Useful fields the API already returns per market: `yes_bid`, `yes_ask`,
`last_price`, `volume`, `open_interest`, `liquidity`.

## 3. Direction B (priority): Kalshi in the value math

**Goal:** the fair-line consensus that drives Value tags and the Home
cheatsheet currently averages devigged sportsbook pairs
(`computeFairDecimal`). Add Kalshi as one more voice in that average —
a real-money prediction market is an *independent* opinion, which is
exactly what a consensus wants.

**Why not just average it in tomorrow:** three honest objections, each with
a concrete answer —

| Objection | Answer in the design |
|---|---|
| Thin markets produce noise prices | **Liquidity gate:** include Kalshi only when `volume ≥ V` (draft: 100 contracts) AND spread ≤ S (draft: 6¢). Below the gate, Kalshi contributes nothing — same as a book that doesn't quote the game. |
| One noisy voice can swamp an average of 5-8 books | **Weighting:** Kalshi enters at weight `w` (draft: 1.0 — one book-equivalent vote — tunable down to 0 = today's behavior). Optionally scale `w` by liquidity tier later. |
| Different economics (fees vs vig) bias the comparison | **Symmetric treatment:** books get devigged; Kalshi's midpoint is already vig-free, so it enters as-is (fees affect *tradability*, not the crowd's probability estimate — for consensus we want the estimate). |

**Where it lives:** this forces the Kalshi fetch **server-side** —
`/api/odds/:sport` (or a sibling) fetches Kalshi events through the same
cache machinery (10-min TTL, shared by all visitors), matches them
server-side, and ships each game an optional `kalshi: {prob, spread,
volume, cents}` block. The client stops calling Kalshi directly (fixes
every weakness in §1 at once). `computeFairDecimal` (client) grows an
optional Kalshi argument, or — cleaner — the fair-line computation moves
server-side with everything else someday.

**Blast radius:** Value tags and cheatsheet output change wherever Kalshi
passes the gate. Get Props is untouched (Kalshi has no player-prop
markets). Slip/parlay math untouched.

**Rollout switch:** ship with the weight configurable and the Board
divergence display (§4) live first, so we can *see* what Kalshi would have
said before letting it move the tags. Flip from observe → vote after a
couple weeks of eyeballing (or after §5's tracking says the crowd earns it).

## 4. Direction A: divergence signal (supporting act)

Even with Kalshi in the consensus, the *disagreement itself* is information:

- **Definition:** `divergence = kalshi_prob − book_consensus_prob` for a
  game side, computed only when Kalshi passes the liquidity gate.
- **Display:** Board badge on the Kalshi row when `|divergence| ≥ 4` points
  ("Kalshi +7 vs books"); optional Home panel listing today's biggest
  disagreements.
- **Reading it:** Kalshi high vs books can mean the crowd knows something
  (weather, lineup news travels fast on exchanges) — or that a thin market
  hasn't caught up. That ambiguity is why A displays and B gates.

A is nearly free once the server-side fetch from B exists — it's the same
numbers rendered instead of averaged.

## 5. Parked (but designed-adjacent)

- **Divergence tracking:** log `{game, side, kalshi_prob, book_prob,
  divergence, outcome}` through the existing `store.js` append-only
  machinery and grade who was right — the evidence that would justify
  raising Kalshi's consensus weight above 1.0 (or cutting it to 0). Cheap
  to add once §3 lands server-side; deliberately after, not with, v1.
- **More Kalshi markets:** series/tournament winners and totals-style
  event contracts exist for some sports; nothing player-prop-shaped worth
  integrating yet. Revisit next season.
- **Authenticated/trading API:** RSA-signed requests, order placement,
  positions. Out of scope for an informational tool; separate doc if ever.

## 6. Open questions (argue here)

1. Gate values: `volume ≥ 100` and `spread ≤ 6¢` are educated guesses —
   check them against a week of real MLB Kalshi markets before committing.
2. Weight `w = 1.0`: is one book-vote right for a venue with different
   participants than sportsbooks, or should it start at 0.5?
3. Does the fair-line computation move server-side wholesale (cleaner,
   bigger change), or does the client's `computeFairDecimal` grow a Kalshi
   parameter (smaller, keeps math in two places)?
4. EPL soccer has three outcomes (win/draw/win) — Kalshi's binary
   game contracts don't map cleanly; MLB/NBA/NFL/NHL first, EPL excluded?
5. Fuzzy title matching: good enough with a server-side cache + logging of
   match failures, or do we build a proper team-name map per sport?

## Next steps

1. PR this doc; both of us mark up §6.
2. Spec (superpowers flow) for: server-side Kalshi fetch + game-payload
   `kalshi` block + Board divergence badge (observe mode).
3. Spec for the consensus weight flip once observe mode looks sane.
