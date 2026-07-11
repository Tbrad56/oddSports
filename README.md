# LineWatch

Sports odds comparison: line-shop moneylines and player props across US
sportsbooks, spot value against the consensus fair line, and price parlays
per book. Informational only — no bets placed, no sportsbook accounts.

## Stack

Static frontend (`public/`) served by an Express proxy (`server.js`) that
holds The Odds API key server-side and caches responses for 10 minutes.

The Get Props page estimates MLB prop hit probabilities from player game
logs (MLB StatsAPI, free) and flags lines where the model disagrees with
the books — informational only.

## Run locally

1. `npm install`
2. `cp .env.example .env` and set `ODDS_API_KEY` (free key at
   [the-odds-api.com](https://the-odds-api.com), 500 credits/month)
3. `npm start` → http://localhost:3000

## Tests

`npm test`

## Deploy (Railway)

Point Railway at this repo; it runs `npm start`. Set the `ODDS_API_KEY`
environment variable in the Railway dashboard. `PORT` is provided by
Railway automatically.

## Quota notes

- Moneyline pull ≈ 2 credits (2 US regions); props ≈ 12 credits per game.
- The 10-minute server cache is shared by all visitors — only cache
  misses spend credits.
