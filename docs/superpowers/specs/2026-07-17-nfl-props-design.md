# NFL Buildout — Props, Game Lines, Matchups — Design

**Date:** 2026-07-17 (revised 2026-07-19)
**Status:** Approved

## Goal

Bring the NFL Board experience up to parity with baseball's, styled after
DraftKings' props presentation:

1. Expand NFL player-props coverage from 6 markets to ~24, organized into
   DraftKings-style category tabs with on-demand fetching so quota spend stays
   proportional to what the user actually views.
2. Give NFL game cards the same Spread/Total/Moneyline grid MLB cards have.
3. Add an opt-in per-game "matchups" section (the NFL equivalent of MLB's HR
   matchups): each team's key offensive players with per-game stats, plus the
   opposing defense's yards/points allowed and league rank.
4. Add NFL player headshots using the same pattern MLB photos use today.

NFL only — NCAAF keeps its current 6 flat markets and moneyline blocks.

## Background

- The props endpoint (`/api/props/:sport/:eventId`) fetches one fixed,
  server-controlled market list per sport in a single upstream request. The
  Odds API bills 1 credit per market per region per event on the event-odds
  endpoint; fetching ~24 markets eagerly across a full Sunday slate would burn
  hundreds of credits, so markets are fetched in on-demand groups.
- `/api/odds/americanfootball_nfl` currently requests only `h2h`; the Board
  renders plain moneyline blocks for NFL. MLB requests
  `h2h,spreads,totals` (+F5) in one call and renders a game-lines grid.
- MLB props responses carry an `mlbIds` name→personId map the client uses to
  render headshots, with a hidden/placeholder fallback. NFL mirrors this via
  Sleeper.
- MLB cards have an opt-in "HR matchups" section backed by a server-side
  aggregation endpoint (`/api/hr-matchups/mlb`) with its own stats cache. The
  NFL matchups section follows the same shape.

## Design

### 1. Server: NFL odds call gains spreads/totals

`/api/odds/americanfootball_nfl` requests `h2h,spreads,totals` (like MLB,
minus the F5 period markets). Same single upstream call; cost rises from 2 to
6 credits per board load. NCAAF and all other sports unchanged.

### 2. Server: NFL prop fetch groups

`PROP_MARKETS.americanfootball_nfl` becomes five named fetch groups. Other
sports keep flat lists, treated as a single implicit default group.

| Fetch group | Markets |
|---|---|
| `popular` (default) | `player_pass_yds`, `player_pass_tds`, `player_rush_yds`, `player_receptions`, `player_reception_yds`, `player_anytime_td` (the existing 6) |
| `passing` | `player_pass_attempts`, `player_pass_completions`, `player_pass_interceptions`, `player_pass_yds_alternate`, `player_pass_tds_alternate` |
| `rush_receive` | `player_rush_attempts`, `player_rush_longest`, `player_reception_longest`, `player_rush_yds_alternate`, `player_receptions_alternate`, `player_reception_yds_alternate` |
| `td` | `player_1st_td`, `player_last_td` |
| `kicker_defense` | `player_kicking_points`, `player_field_goals`, `player_tackles_assists`, `player_sacks`, `player_defensive_interceptions` |

Groups are **fetch bundles**, not display categories: each bundle contains
only markets the default `popular` fetch hasn't already loaded, so no market
is ever paid for twice. All five groups for one game = 24 credits, only if
the user opens every tab.

Market keys are to be verified against The Odds API docs during
implementation; any key the API rejects gets corrected or dropped.

**Endpoint:** `/api/props/:sport/:eventId?group=<name>`

- Missing `group` → `popular`. Existing clients and all other sports are
  untouched.
- A `group` value not defined for the sport → 400.
- The group changes the upstream URL, so the existing path-keyed cache
  naturally holds one entry per (event, group) at the same 10-minute TTL.
  One upstream spend per group per event per TTL, shared by all viewers.
- Clients still cannot request arbitrary markets — quota protection stays
  server-controlled, now at group granularity.

### 3. Client: DraftKings-style category tabs in the props section

For NFL events, the props section shows tab chips:
**Popular · Passing · Rush/Receive · TD Scorers · Kick & Def**.

Each tab renders its category's markets by **merging** what's cached
client-side:

| Tab | Markets shown | Fetches on first click |
|---|---|---|
| Popular | the 6 core markets | nothing (loaded with the section) |
| Passing | pass yds, pass TDs (from `popular`) + the `passing` bundle | `passing` |
| Rush/Receive | rush yds, receptions, rec yds (from `popular`) + the `rush_receive` bundle | `rush_receive` |
| TD Scorers | anytime TD (from `popular`) + first/last TD | `td` |
| Kick & Def | the `kicker_defense` bundle | `kicker_defense` |

- Popular renders by default, exactly as today's props section does.
- Clicking a tab fetches its bundle (skeleton rows while loading) and caches
  the result client-side keyed by group; revisiting a fetched tab is instant
  and free.
- Within a tab, the existing collapsible market sections, line-shop chips,
  book filter, headshots, and + Slip buttons work exactly as they do for MLB.
- Non-NFL sports render no tabs; nothing changes for them.
- Alt lines and first/last TD are one-sided markets (no Over/Under pair) —
  same shape as anytime TD, rendered through the same path.

### 4. Client: NFL game lines grid

`renderGameLinesGrid` (currently MLB-only) is generalized: NFL cards render
the same Spread/Total/Moneyline grid — one row per team, best price per cell
across the My Books pool (falling back to all tracked books), tap a cell to
add to Slip. No F5 toggle for NFL. Other sports keep their current moneyline
blocks.

### 5. NFL headshots

- Server fetches Sleeper's free public player dump
  (`https://api.sleeper.app/v1/players/nfl`, no key) at most once per 24h,
  in-memory cache, and builds a lowercased full-name → Sleeper player ID map
  for active players.
- NFL props responses get an `nflIds` field alongside the odds body, exactly
  like `mlbIds`.
- The client avatar helper gains an NFL source:
  `https://sleepercdn.com/content/nfl/players/{id}.jpg`, with the existing
  `onerror`-hide / placeholder-bubble fallback for unmatched players.

### 6. "Load matchups" section (NFL equivalent of HR matchups)

Opt-in button per NFL game card, mirroring the HR-matchups toggle pattern.

**Endpoint:** `/api/matchups/nfl?home=<team>&away=<team>`

Server composes, per team:

- **Key offense** — QB1, top 2 RBs, top 3 WR/TEs, chosen via Sleeper
  depth-chart data (falling back to stat totals) from the same cached player
  dump. Each row: headshot, position tag, and per-game stats from Sleeper's
  free stats API — pass yds/g + pass TDs (QB), rush yds/g + rush TDs (RB),
  receptions/g + rec yds/g + rec TDs (WR/TE).
- **Opposing defense** — pass yds allowed/g, rush yds allowed/g, points
  allowed/g, each with league rank (1 = stingiest), from ESPN's public
  team-stats API.

Implementation details:

- Server-side aggregation with its own cache, ~6h TTL — season aggregates
  don't move mid-day. One cached entry per team pair.
- **Season handling:** until the 2026 season has stats, serve completed 2025
  season stats; the response carries a `season` field and the client labels
  the section ("2025 season").
- The client renders the section with the same stat-table styling as the HR
  matchups block, with color banding on defense ranks (top-10 good,
  bottom-10 bad).

### 7. Error handling

- Sleeper player dump unavailable → props responses still succeed, just
  without `nflIds` (best-effort, matching MLB ID lookups).
- Sleeper stats unavailable → `/api/matchups/nfl` returns a body the client
  renders as "Player stats unavailable right now" — never a broken card.
- ESPN unavailable → matchups response simply omits the defense blocks;
  player stats still render.
- Quota exhaustion on odds calls → existing 429 path, unchanged.
- Books often post nothing for some groups until game week (especially alts
  and kicker/defense). An empty tab renders "No lines posted yet for this
  group" instead of an error or a broken table.

### 8. Testing

Extend the existing mocked-fetch suites:

- `group` param validation: default to `popular`, unknown group → 400,
  non-NFL sport with explicit group → 400 unless the default.
- Per-group cache separation: two groups for one event = two upstream calls;
  repeat of one group within TTL = no new call.
- NFL odds call requests `h2h,spreads,totals`.
- `nflIds` attached from a mocked Sleeper response; Sleeper failure leaves
  props intact without `nflIds`.
- Tab merge logic: Passing tab renders popular-cached markets plus the newly
  fetched bundle's markets.
- `/api/matchups/nfl` built from mocked Sleeper + ESPN responses: key-player
  selection, per-game averages, defense rank computation, and each
  best-effort failure path (Sleeper stats down, ESPN down).
- One-sided alt-market fixtures flow through the props rendering path
  without breaking.

Live verification is limited mid-July (preseason lines appear ~August), so
mocked tests carry the load; do a real-API smoke check once preseason props
post.

## Out of scope

- NCAAF expansion, quarter/half NFL period lines, inline per-prop-row stat
  context, the Get Props model-analysis page for NFL, alternate regions,
  Sportradar integration, persistent (disk) caching of the Sleeper dump.
