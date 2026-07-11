# Get Props Lineup Filtering — Design

**Date:** 2026-07-11
**Status:** Approved

## Context

Get Props currently analyzes every player the books quote, including pitchers
who aren't starting and batters who won't be in the lineup — the books know
this and price accordingly, which is a large share of the model's false
"edges." MLB StatsAPI (already integrated, free) publishes probable pitchers
a day ahead and starting lineups ~2–4 hours before first pitch. This feature
filters and flags Get Props picks using that data.

This is sub-project A of the deeper-StatsAPI work. Sub-project B
(box-score pick-outcome tracking) is a separate spec — it requires
persistent storage (Railway wipes the filesystem on deploy) and that
decision should not block this stateless improvement.

## Decisions (locked with user)

| Decision | Choice |
|---|---|
| Sequencing | A (this spec) first; B (outcome tracking) next, own spec |
| Pre-lineup behavior | Hybrid: pitcher props always filtered by probable starters; batter props filtered only once the lineup is posted, otherwise analyzed and flagged `lineup_unconfirmed` |
| Data source | One schedule call: `GET https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=<YYYY-MM-DD>&hydrate=probablePitcher,lineups` — cached 15 minutes via the existing `fetchStats` helper |
| Failure posture | Filtering is an enhancement, never a blocker: schedule fetch failure or unmatched game → analyze unfiltered, `lineupStatus: 'unavailable'` |

## Server changes (`server.js`, inside `handleAnalyze`)

1. Fetch today's schedule (date from `new Date(now())` as the US Eastern (America/New_York) game day — amended from UTC after review: UTC rolls to tomorrow at ~8pm ET and misses evening games;
   cache TTL 15 min = `15*60*1000`, reusing `fetchStats`).
2. Match the analyzed event to a schedule game by comparing BOTH team names:
   normalize odds-event `home_team`/`away_team` and schedule
   `teams.home.team.name`/`teams.away.team.name` with the existing
   `normName`. The odds event's team names come from the already-fetched
   props response's `home_team`/`away_team` fields. No match → skip
   filtering, `lineupStatus: 'unavailable'`.
3. From the matched game build:
   - `probablePitcherIds`: `teams.home.probablePitcher.id` and
     `teams.away.probablePitcher.id` (either may be absent)
   - `lineupIds`: union of `game.lineups.homePlayers[].id` and
     `game.lineups.awayPlayers[].id` (shape verified live against
     statsapi.mlb.com on 2026-07-11; when lineups are not yet posted the
     arrays are absent/empty — treat as not posted)
   - `lineupsPosted`: true when both `homePlayers` and `awayPlayers` are
     non-empty
4. Per grouped prop, after `mlbPlayerId` resolves:
   - Market group `pitching` (i.e. `pitcher_strikeouts`): if
     `probablePitcherIds` is non-empty and does not contain the player id →
     do not analyze; push `{player, reason: 'not_probable_starter'}` to
     `filtered`. If no probables known, analyze normally (no flag — starts
     are usually known; absence means data gap, not bench).
   - Market group `hitting`: if `lineupsPosted` and player id not in
     `lineupIds` → do not analyze; push `{player, reason: 'not_in_lineup'}`.
     If not posted → analyze and append `'lineup_unconfirmed'` to the pick's
     `analysis.flags` (server-side, after `analyzeProp` returns —
     `analysis.js` is untouched).
5. Response gains three fields alongside `picks`/`skipped`/`generatedAt`:
   - `filtered: [{player, reason}]`
   - `lineupStatus: 'confirmed' | 'pending' | 'unavailable'`
     (confirmed = lineups posted; pending = matched but lineups not posted;
     unavailable = schedule failed or game unmatched)
   - `propCount`: number of grouped prop lines before any filtering — lets
     the client distinguish "no props posted by books" from "no edges found."
6. The analysis cache stores the full response as before (10 min TTL) —
   short enough that a lineup posting mid-window self-corrects quickly.

## Page changes (`public/getprops.js`, plus one CSS chip variant if needed)

- Results header line per game: `Lineups posted ✓` (confirmed) /
  `Lineups pending — batter picks unconfirmed` (pending) /
  nothing (unavailable).
- New flag chip mapping: `lineup_unconfirmed` → info chip
  "Lineup unconfirmed" (existing `.flag-chip.info` style).
- Filtered players listed under the table like skipped:
  `Not starting today: <names>` (both reasons merged into one line, since
  the distinction is visible in context).
- Empty-state fix (bug found in use): when `picks` is empty —
  `propCount === 0` → "No props posted for this game yet — books usually
  post player props closer to game time." Otherwise keep
  "No edges ≥ 3% found in this game's props."

## Errors

- Schedule fetch/parse failure: caught inside `handleAnalyze`, filtering
  skipped, `lineupStatus: 'unavailable'` — never converts a working analysis
  into an error response.
- Everything else inherits existing analyze-route error handling unchanged.

## Testing

- Endpoint tests with faked schedule fixtures routed via the existing
  `routedFetch` pattern:
  1. probables known, lineups posted → non-starter pitcher and
     non-lineup batter land in `filtered` with correct reasons;
     `lineupStatus: 'confirmed'`
  2. probables known, lineups not posted → batter analyzed with
     `lineup_unconfirmed` flag; `lineupStatus: 'pending'`
  3. schedule route returns 500 → analysis still succeeds,
     `lineupStatus: 'unavailable'`, no `filtered` entries
  4. unmatched team names → same as 3
  5. `propCount` reflects grouped lines (present in every case above)
- Existing 25 tests untouched and passing.
- Live verification: analyze a real game before lineups post (morning) and
  after (evening); confirm status line flips and a benched batter drops out.

## Out of scope

- IL/injury status (lineups subsume it once posted)
- Pick-outcome tracking / box scores (sub-project B, next spec)
- Non-MLB sports
