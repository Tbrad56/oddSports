# LineWatch Multi-Page Split — Design

**Date:** 2026-07-11
**Status:** Approved (pending user spec review)

## Context

LineWatch is currently a single page (`public/index.html` + `public/app.js`):
nav-rail buttons toggle in-page views and scroll to sidebar panels. The user
dislikes the single-page scroll and wants real pages behind clickable links
with a standard homepage — keeping the current visual design exactly
(colors, fonts, cards, rail, ticker).

## Decisions (locked with user)

| Decision | Choice |
|---|---|
| Pages | Home (`/`), Board, Props, Slip — 4 pages |
| Slip access from other pages | Live leg-count badge on nav Slip link + "Added ✓ — View slip" toast on add |
| Props data flow | Self-sufficient Props page (own sport chips, game list, per-game "Load props"); Board loses its props buttons |
| Architecture | Plain multi-page static: real HTML files, shared CSS, `common.js` + one small script per page. No build step, no framework, server unchanged |
| Future | A "Get Props" page (best statistical odds reporting) is planned — separate spec later. This design only requires the nav rail to accommodate a 5th link without layout change (it already does) |

## Pages

All pages share: sticky header (brand + auto-refresh button where relevant),
ticker, nav rail (now real `<a>` links with `.active` on the current page),
disclaimer footer. Visual design byte-identical to today — same class names,
same `styles.css` (plus small additions for badge/toast/CTA cards).

- **Home — `public/index.html`**: hero line, ticker, sport chips, cheatsheet
  (top value spots for the selected sport, auto-loaded on page load — the
  server cache makes this cheap), two CTA cards linking to Board and Props.
  About/quota copy moves to a small panel or footer area.
- **Board — `public/board.html`**: sport chips, search, status row, game
  cards with ranked book rows, Best/Value tags, "+ Slip" buttons. No props
  toggle (moved to Props page).
- **Props — `public/props.html`**: sport chips, search, game list as
  collapsible cards each with a "Load props" button (opt-in per game, quota
  copy retained), book-filter chips, props tables with line-shop chips and
  "+ Slip".
- **Slip — `public/slip.html`**: legs with remove buttons, single-bet best
  price / parlay price per common book, copy block, reference-links panel
  (link paste + entries, session-only as today).

## Shared state and JS layout

```
public/
├── styles.css        # existing + badge/toast/CTA additions
├── common.js         # shared: consts, helpers, storage, nav, ticker
├── index.html + home.js
├── board.html + board.js
├── props.html + props.js
└── slip.html  + slip.js
```

`common.js` owns (moved verbatim from app.js unless noted):
- Consts: `SPORTS`, `BOOK_STYLES`, `TRACKED_KEYS`, `BOOK_LINKS`, `PROP_MARKETS`
- Helpers: `americanToDecimal`, `decimalToAmerican`, `fmtAmerican`,
  `computeFairDecimal`, `escapeHtml`, `marketLabel`, `bookStyleFor`,
  `linkedBadge`
- Fetch wrapper: `fetchOddsFor(sport)` → GET `/api/odds/${sport}`, returns
  `{games, remaining, cacheAge}`; throws with server `{error}` message
- Slip storage (new): `getSlip()`, `addLeg(leg)`, `removeLeg(id)`,
  key `lw_slip` in localStorage (JSON array of `{id, matchup, side, rows}`);
  corrupt/missing value → empty array (try/catch)
- Sport persistence (new): `getSport()`/`setSport(key)`, key `lw_sport`,
  default `americanfootball_nfl`
- Nav (new): `renderNav(activePage)` injects the rail links and sets the
  slip badge count; `updateSlipBadge()`; `showToast(text)` (2s, links to
  slip.html)
- Ticker fill: `updateTicker(games)` (existing logic)

Per-page scripts wire only their own DOM; each page loads
`<script src="common.js"></script>` then its own script. No ES modules —
plain globals, matching the current codebase style.

The old `public/app.js` is deleted; every function it held moves to
`common.js` or exactly one page script. Rendering logic (game cards, props
tables, cheatsheet, slip, parlay) is cut-and-moved, not rewritten —
diff-vs-original discipline as in the original port.

## Error handling

- Per-page fetch failures → existing `.error-msg` banner pattern; empty
  states retained ("No odds loaded yet", "No games found", props empty state,
  slip empty state).
- localStorage unavailable or corrupt → slip treated as empty; adds
  overwrite; no crash.
- Server: zero changes (routes are page-agnostic; static middleware already
  serves the new files; `/` → `index.html` by default).

## Verification

1. `npm test` — 11/11 server tests still pass (nothing server-side changed).
2. Smoke test each page: Home loads cheatsheet for default sport; Board
   fetch + add leg → badge increments + toast; Props page loads games, loads
   props for one game, add prop leg; Slip page shows both legs, parlay
   prices by common book, copy block; remove leg updates badge; browser
   back/forward navigates real pages; sport chosen on Home persists on
   Board/Props.
3. Grep: no `getElementById` in any page script referencing an id absent
   from its own HTML page; no references to deleted app.js.

## Out of scope

- "Get Props" statistical-best-odds page (own spec, later)
- Auto-refresh redesign (button stays on Board/Props as today)
- Persisting reference links or props cache across pages
- URL routing beyond plain files (no hash/history routing)
