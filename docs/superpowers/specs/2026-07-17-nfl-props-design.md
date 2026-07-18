# NFL Props Buildout — Design

**Date:** 2026-07-17
**Status:** Approved

## Goal

Expand NFL player-props coverage from the current 6 markets to ~20, organized
into on-demand market groups so quota spend stays proportional to what the
user actually views. Add NFL player headshots using the same pattern MLB
photos use today. NFL only — NCAAF keeps its current 6 markets.

## Background

- The props endpoint (`/api/props/:sport/:eventId`) fetches one fixed,
  server-controlled market list per sport in a single upstream request
  (`regions=us`). Cost per event view = number of markets requested.
- The Odds API bills 1 credit per market per region per event on the
  event-odds endpoint. 20 markets × a full Sunday slate would burn 250+
  credits if fetched eagerly; on-demand groups avoid that.
- MLB props responses carry an `mlbIds` name→personId map the client uses to
  render headshots, with a hidden/placeholder fallback. NFL mirrors this.

## Design

### 1. Server: NFL market groups

`PROP_MARKETS.americanfootball_nfl` becomes five named groups. Other sports
keep flat lists, treated as a single implicit `core` group.

| Group | Markets |
|---|---|
| `core` | `player_pass_yds`, `player_pass_tds`, `player_rush_yds`, `player_receptions`, `player_reception_yds`, `player_anytime_td` (unchanged) |
| `alts` | `player_pass_yds_alternate`, `player_pass_tds_alternate`, `player_rush_yds_alternate`, `player_receptions_alternate`, `player_reception_yds_alternate` |
| `volume` | `player_pass_attempts`, `player_pass_completions`, `player_pass_interceptions`, `player_rush_attempts`, `player_rush_longest`, `player_reception_longest` |
| `td` | `player_1st_td`, `player_last_td` |
| `kicker_defense` | `player_kicking_points`, `player_field_goals`, `player_tackles_assists`, `player_sacks`, `player_defensive_interceptions` |

Market keys are to be verified against The Odds API docs during
implementation; any key the API rejects gets corrected or dropped.

**Endpoint:** `/api/props/:sport/:eventId?group=<name>`

- Missing `group` → `core`. Existing clients and all other sports are
  untouched.
- A `group` value not defined for the sport → 400.
- The group changes the upstream URL, so the existing path-keyed cache
  naturally holds one entry per (event, group) at the same 10-minute TTL.
  One upstream spend per group per event per TTL, shared by all viewers.
- Clients still cannot request arbitrary markets — quota protection stays
  server-controlled, now at group granularity.

### 2. Client: group tabs on the props page

For NFL events, `getprops` shows group chips above the props table:
**Core · Alt lines · Volume · TD scorers · Kicker & D**.

- Core loads by default, exactly as today.
- Clicking a chip fetches that group (skeleton rows while loading) and caches
  the result client-side keyed by group; revisiting a fetched group is
  instant and free.
- The existing per-market filter operates within the active group.
- Non-NFL sports render no chips; nothing changes for them.
- Alt lines and first/last TD are one-sided markets (no Over/Under pair) —
  same shape as anytime TD, rendered through the same path.

### 3. NFL headshots

- Server fetches Sleeper's free public player dump
  (`https://api.sleeper.app/v1/players/nfl`, no key) at most once per 24h,
  in-memory cache, and builds a lowercased full-name → Sleeper player ID map
  for active players.
- NFL props responses get an `nflIds` field alongside the odds body, exactly
  like `mlbIds`.
- The client avatar helper gains an NFL source:
  `https://sleepercdn.com/content/nfl/players/{id}.jpg`, with the existing
  `onerror`-hide / placeholder-bubble fallback for unmatched players.

### 4. Error handling

- Sleeper unavailable → props responses still succeed, just without `nflIds`
  (best-effort, matching MLB ID lookups).
- Quota exhaustion → existing 429 path, unchanged.
- Books often post nothing for some groups until game week (especially alts
  and kicker/defense). An empty group renders "No lines posted yet for this
  group" instead of an error or a broken table.

### 5. Testing

Extend the existing mocked-fetch suites:

- `group` param validation: default to core, unknown group → 400, non-NFL
  sport with explicit group → 400 unless `core`.
- Per-group cache separation: two groups for one event = two upstream calls;
  repeat of one group within TTL = no new call.
- `nflIds` attached from a mocked Sleeper response; Sleeper failure leaves
  props intact without `nflIds`.
- One-sided alt-market fixtures flow through `analysis.js` without breaking
  ranking.

Live verification is limited mid-July (preseason lines appear ~August), so
mocked tests carry the load; do a real-API smoke check once preseason props
post.

## Out of scope

- NCAAF expansion, NFL matchup-analysis features, alternate regions,
  Sportradar integration, persistent (disk) caching of the Sleeper dump.
