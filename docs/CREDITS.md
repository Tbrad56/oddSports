# Stretching your Odds API credits

The Odds API is the only paid/quota'd service in the app (free tier: 500
credits/month). Everything else is free. Here's where credits go and what
this app does to spend as few as possible.

## What costs credits

| Action | Cost | Notes |
|---|---|---|
| Board refresh (MLB) | 3 | h2h+spreads+totals × 1 region |
| Board refresh (other sports) | 1 | h2h only |
| Player props load (per game) | 5-6 | one per market in that sport's list |
| Get Props analyze (per game) | 5 | same props call, then free StatsAPI work |
| Live scores | **0** | served free from ESPN's public scoreboard |
| HR matchups, weather, Kalshi, stats search, photos | **0** | all free public APIs |

## Built-in savers

1. **Live scores are free now.** They used to cost 2 credits per 30-second
   poll (~240/hour with one open tab — the single biggest drain). They now
   come from ESPN's public scoreboard at zero cost, same 30s freshness.
2. **One region instead of two.** Every odds/props call uses `regions=us`
   only — half the old per-call cost. (`us2` added a couple of smaller books;
   re-add it in `server.js` if you ever miss them.)
3. **Server-side caching.** Every odds response is shared by all visitors for
   `ODDS_CACHE_MINUTES` (default 10). Two people loading the Board within the
   window costs one fetch.
4. **Props are opt-in per game** — nothing is fetched until someone taps.
5. **Quota detection.** When credits run out (429 or the API's 401
   OUT_OF_USAGE_CREDITS), users see a clear "resets on the 1st" message
   instead of silent failures.

## Dials you can turn

- **`ODDS_CACHE_MINUTES`** in `.env` / Railway Variables: raise to `30` or
  `60`. Odds move, but for casual browsing 30-minute-old lines are fine and
  cut Board spend 3-6×.
- Load props sparingly — each game's props load is the most expensive single
  tap in the app.

## Free-odds reality check

There is no free multi-sportsbook odds API — line-shopping data is exactly
what the paid product is. The closest free option is ESPN's scoreboard, which
carries a single book's line (ESPN BET) per game. If you ever want a
zero-credit fallback mode ("show ESPN BET lines when quota is out"), that's
buildable on the same free endpoint the scores already use.
