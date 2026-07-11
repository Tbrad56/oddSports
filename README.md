# LineWatch

A sports odds comparison app — line-shop moneylines and player props across
US sportsbooks, spot value against the consensus fair line, build a parlay,
and (for MLB) find props the market may be mispricing. Informational only:
no bets placed, no sportsbook accounts.

A Node/Express server (`server.js`) holds the shared Odds API key
server-side and serves the static frontend (`public/`) — nobody visiting
the app needs their own key.

## Pages

- **Home** — cheatsheet of top value spots across the selected sport, sorted by edge
- **Board** — moneyline odds per game across FanDuel, DraftKings, BetMGM,
  Caesars, ESPN BET, Bet365, Fanatics, and BetRivers, ranked best → worst,
  with auto-refresh (10 min). Each game card also has an opt-in player props
  section (protects API quota) with a per-book filter and line-shop chips,
  plus MLB stadium weather and a Kalshi reference price where available
- **Slip** — parlay builder: finds every book covering all your legs, prices
  the combined parlay per book, and gives you a copyable slip text to paste
  into that book's app
- **Get Props** — MLB-only: estimates hit probability for each posted prop
  from recent game logs (free MLB StatsAPI) using a Poisson model, and
  surfaces picks where the model disagrees with the book's implied odds by
  a meaningful edge

## Features

### Odds & value
- **Value tags** — each two-sided market is devigged into a fair consensus
  line; books paying above it get flagged
- **Cheatsheet** — Home page surfaces the top value spots across every
  loaded game
- Team search + sport chips: NFL, NBA, MLB, NHL, NCAAF, NCAAB, EPL, MMA

### Player props
- **Markets** — NFL: pass yds/TDs, rush yds, receptions, receiving yds,
  anytime TD · NBA: points, rebounds, assists, threes, PRA · MLB: hits,
  HRs, total bases, RBIs, strikeouts · NHL: points, assists, SOG, anytime goal
- **Line-shop chips** — every prop shows all books' prices best-first; any
  prop can be added to the bet slip alongside moneylines

### Get Props (MLB hit-probability model)
- Pulls each player's recent game log from MLB StatsAPI (free, no key) and
  fits a Poisson model to estimate the probability of clearing the posted line
- Devigs the book's two-sided price to an implied probability and flags
  picks where the model's edge is ≥ 3%
- Flags thin samples, one-sided lines, and situations worth a news check
  before trusting the number
- Informational only — a season-to-date model, not a guarantee

### Bet slip
- Finds every book that covers all legs in your slip and ranks the combined
  parlay price per book
- If no single book covers every leg, shows best price per leg with a
  clearly labeled "can't actually be placed as one parlay" note
- Copyable plain-text summary of the slip to paste into your sportsbook's app

## Setup

1. `npm install`
2. `cp .env.example .env` and set `ODDS_API_KEY` (free key at
   [the-odds-api.com](https://the-odds-api.com), 500 credits/month)
3. `npm start` → http://localhost:3000

New collaborators: see `docs/ONBOARDING.md` for a from-scratch walkthrough
(installing tools, getting the key, git workflow).

## Tests

`npm test`

## Deploy (Railway)

Point Railway at this repo; it runs `npm start`. Set the `ODDS_API_KEY`
environment variable in the Railway dashboard. `PORT` is provided by
Railway automatically.

## Quota notes

The free tier is 500 credits/month, **shared across everyone using this
key**. Moneyline pull ≈ 2 credits (2 US regions); props ≈ 12 credits per
game; Get Props analysis ≈ 12 credits per game. The 10-minute server cache
is shared by all visitors — only cache misses spend credits, so don't spam
"Analyze props" or "Load props" on every game.

## Limitations (honest ones)

- **No auto-built parlays.** No sportsbook lets a third-party app construct
  a bet slip in their product — the slip's "copy text + link to the book"
  is the legitimate ceiling here
- Odds coverage per book varies by sport/market; Bet365 and Fanatics
  coverage is spottier than FanDuel/DraftKings/BetMGM
- Sportsbook links go to each book's homepage/app, not a specific bet page
  — no public sportsbook API offers real bet-level deep linking
- Get Props is a simple Poisson model on recent games, not a full
  projection system — treat edges as a starting point, not a lock
- Odds move fast — always confirm the price on the sportsbook before betting

## Legal & responsible gambling

Informational tool only: LineWatch places no bets, holds no funds, and
connects to no accounts.

Must be 21+ in a jurisdiction where sports betting is legal. Ohio problem
gambling helpline: 1-800-589-9966, or text 4HOPE to 741741. National
Problem Gambling Helpline: 1-800-522-4700.

## Repo docs

- `docs/ONBOARDING.md` — collaborator setup guide and git workflow
- `docs/WEATHER_FEATURE_PLAN.md` — planning doc for an MLB stadium weather
  feature from an earlier single-file prototype; not present in the current
  multi-page app
- `docs/superpowers/plans/` and `docs/superpowers/specs/` — design specs and
  implementation plans for each shipped feature
