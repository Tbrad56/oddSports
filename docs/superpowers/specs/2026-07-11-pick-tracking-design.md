# Pick-Outcome Tracking — Design

**Date:** 2026-07-11
**Status:** Approved

## Context

Get Props produces model probabilities nobody can currently verify: the live
model runs optimistic (Poisson on clumpy count data), and tuning it (v2) is
guesswork without evidence. This feature logs every pick the model makes,
grades it automatically against real MLB results, and shows the track
record — the calibration data that makes model v2 an engineering problem
instead of a vibes problem. This is sub-project B of the deeper-StatsAPI
work (sub-project A, lineup filtering, shipped separately).

## Decisions (locked with user)

| Decision | Choice |
|---|---|
| Storage | Append-only JSONL on a Railway volume. No new deps, no new services. Upgrade path to SQLite/Postgres later if ever needed |
| Logging scope | Passive: every pick in every analyze response is logged automatically (measuring the model, not the user). No opt-in UI |
| Grading | Automatic sweep every 6 h + shortly after boot; graded from MLB StatsAPI game logs (free, already cached) |
| Display | New "Record" page (nav link 📈) with calibration headline, probability buckets, per-market table, recent picks |

## Storage design (`store.js`, new module)

- Data dir: `process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.DATA_DIR || './data'`
  (`./data/` gitignored; Railway sets `RAILWAY_VOLUME_MOUNT_PATH` when a
  volume is attached — the user's one manual step: attach a volume mounted
  at `/data` in the Railway dashboard).
- Single file `picks.jsonl`, strictly append-only. Two record types:
  - Pick: `{type:'pick', id, ts, eventId, gameDate, matchup, player, mlbId,
    market, line, side, modelP, impliedP, edge, bestBook:{bookKey,odds},
    flags}` — `id` is the dedupe key `eventId|player|market|line|side`;
    `gameDate` is the ET game day (same derivation as lineup filtering);
    `mlbId` recorded at log time (the analyze flow already resolved it).
  - Grade: `{type:'grade', id, actual, result, gradedTs}` with
    `result: 'hit'|'miss'|'push'|'void'`.
- Server folds the file into an in-memory Map at boot (pick records keyed by
  id; grade records overlay `actual`/`result`). Appends go to both the file
  (fs.appendFileSync of one JSON line) and the Map. Corrupt/partial trailing
  lines are skipped with a warning (crash-mid-append tolerance).
- Malformed or missing file → empty store; the file is created on first append.

## Logging (in `handleAnalyze`)

After a successful (non-cached) analysis, each pick in the response is
offered to the store; the store appends only ids it hasn't seen (first-seen
wins — earliest model/odds snapshot is the honest one; cached re-analyses
change nothing). Cache-hit responses skip logging entirely (their picks were
logged when first computed). Logging failure (volume missing locally, disk
error) is caught and logged to console — it never affects the analyze
response.

`mlbId` capture: the analyze loop already calls `mlbPlayerId(player)`;
the pick object passed to the store carries it.

## Grading (`store.js` + a sweep in `server.js`)

- Sweep runs on `setInterval` every 6 h, plus once ~60 s after boot
  (`.unref()`ed timers so tests exit cleanly; the sweep is skipped entirely
  when `createApp` is constructed with `enableSweep: false`, which tests
  use — tests call the sweep function directly instead).
- For each pending pick whose `gameDate` is before today (ET) — or equal to
  today with `ts` more than 8 h old — fetch the player's game log
  (`mlbGameValues`, existing 6 h cache, free) and find the split for
  `gameDate`:
  - split exists → `actual` = stat value; `result` = `hit` if the pick's
    side wins (`Over`: actual > line; `Under`: actual < line), `push` if
    `actual === line` (integer lines), else `miss`.
  - no split for that date and the date is ≥ 2 days past → `void` (didn't
    play). Between 1–2 days, leave pending (late data, suspended games).
- Doubleheaders: a player's game log can contain two splits for one date,
  and v1 cannot tell which game a pick belonged to. Grade against the FIRST
  split of that date — an accepted imprecision (doubleheaders are rare;
  tracked in the same follow-up as the lineup-filtering doubleheader fix,
  where matching by game start time would resolve both).
- Grading needs zero Odds API credits.

## API + page

- `GET /api/record` → computed from the in-memory store:
  `{summary:{graded, pending, hits, misses, pushes, voids, hitRate,
  avgModelP, calibrationGap}, buckets:[{range:'50-60', n, avgModelP,
  actualRate}...], byMarket:[{market, n, hitRate, avgModelP}...],
  recent:[last 25 graded picks with result]}`.
  Hit rate excludes pushes and voids from the denominator.
  Buckets: modelP 0–50 / 50–60 / 60–70 / 70+.
- `public/record.html` + `public/record.js`: nav link 📈 "Record"
  (`renderNav` items array — 6th entry, after Get Props, before Slip).
  Headline ("Model said X% on average; reality delivered Y%"), bucket table,
  per-market table, recent-picks list with ✓/✗/− chips. Same design system;
  no Odds API calls from this page (ticker seeded from the cached odds fetch
  like slip.html).
- Empty state: "No graded picks yet — analyses log automatically; results
  appear the day after the games."

## Errors

- Store I/O failures never break analyze or the record page (degrade to
  in-memory-only for the process lifetime, console warning).
- Grading sweep failures (StatsAPI down) leave picks pending; next sweep
  retries.

## Testing

- `store.js` unit tests in a temp dir (`fs.mkdtemp`): append + fold,
  dedupe (second append of same id ignored), grade overlay, corrupt trailing
  line tolerance, missing dir/file bootstrap.
- Grading logic tests: faked game logs → hit/miss/push/void paths, including
  the Over/Under win conditions and the ≥2-days void rule (injected `now`).
- `/api/record` endpoint test: seed a temp store, assert summary math
  (hit rate excluding pushes/voids, calibration gap) and bucket assignment.
- Analyze-logging integration test: run an analyze with faked upstreams and
  a temp DATA_DIR, assert the pick landed in the store once across two calls
  (cache-hit second call logs nothing).
- Existing 31 tests untouched.

## Out of scope

- Odds movement tracking (only first-seen odds are kept)
- User bet tracking / stake amounts (this measures the model)
- Model changes themselves (v2 uses this data, separate effort)
- Doubleheader-precise grading (accepted first-split imprecision, follow-up
  with the lineup-filtering doubleheader fix)
- Non-MLB sports
