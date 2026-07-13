# UI Polish Pass — Design

**Date:** 2026-07-12
**Status:** Approved
**Inventory:** `2026-07-12-ui-polish-audit.md` (same directory) — the full
45-item catalog from the headless-browser audit at 390px. This design sets
the approach per group; the audit file is the authoritative item list.

## Context

The site accumulated kinks across two parallel development streams: a
reported nav hover bug, no real mobile support, a board re-render bug that
collapses open props sections every 30 s, dead CSS/JS from removed features,
and old-palette remnants after the scarlet re-theme. Tai wants all 45
audited items fixed in one pass, plus his tagline rebrand rolled out.

## Decisions (locked with user)

| Decision | Choice |
|---|---|
| Scope | All 45 audit items (5 breaks-usage, 12 ugly, 28 polish) |
| Tagline | "All odds everywhere" on all five pages (replaces "Your Odds Copilot"; Tai's uncommitted Home edit is adopted and extended) |
| Mobile approach | Wide tables scroll inside their own wrapper (page body never scrolls horizontally); flex rows reflow; rail already responsive |
| Poll bug | Live-scores tick updates score elements in place — never a full board re-render |

## Approach by group

### 1. Breaks-usage (5 items — each gets its own fix + verification)

- **Board 30 s poll re-render** (board.js): the scores tick currently calls
  the full `renderGames()`. Change to targeted DOM patching: locate each
  game card by `data-game-id` and update only the score/status elements
  (`.game-time` / score spans). Open props sections, search text, and
  scroll position survive ticks. This is the largest single change in the
  pass; it gets a focused verification (open a props section, wait/force a
  tick, assert still open).
- **Record/Board/Get Props horizontal overflow at phone widths**: every
  `.props-table` (and the Record tables) gets wrapped in
  `<div class="table-scroll">` with `overflow-x:auto;
  -webkit-overflow-scrolling:touch;` — content keeps its natural width,
  the wrapper scrolls, the page body never exceeds the viewport.
  Acceptance: at 390 px, `document.documentElement.scrollWidth === 390`
  on every page with stub data.
- Remaining breaks-usage items per audit file (§breaks) — individually
  listed there with fixes.

### 2. Reported hover bug + rail

`.rail-btn` fixed `width:44px` can't hold the "GET PROPS" label (needs
~52 px). Fix: `min-width:44px; width:auto; padding:0 6px;` so buttons size
to their label; the hover/active shading then encloses the text on every
button. Verify all six rail states hover cleanly (Home/Board/Get Props/
Record/Slip + logo).

### 3. Mobile pass (audit §mobile)

- Table wrapping as above (Record recent-results, Get Props picks, Board
  props tables).
- `.book-row` reflows: allow wrap at ≤480 px (`flex-wrap:wrap`) so the
  badge/odds/buttons stack instead of forcing 449 px.
- `.cta-row`, chip rows, `.bar-strip` spot-checks per audit items.
- Tap targets: anything interactive below 40 px height at phone width gets
  padding (audit lists the offenders).
- Acceptance for the whole group: no page exceeds viewport width at 390 px
  and 360 px with stubbed data; all listed tap targets ≥ 40 px.

### 4. Dead code removal (audit §dead)

Delete: `input[type=password]` and `select` styling, `.settings-field`
rules, `.icon-btn`, orphaned sticky `th` rule, `myBookKeys()` /
`filterToMyBooks()` dead JS, plus every item in the audit's dead-code
section. Each removal verified by `grep` showing zero remaining references.

### 5. Theme & copy (audit §theme, §copy)

- Replace surviving old-palette literals (`rgba(255,216,77)`,
  `rgba(255,92,92)`, and the audit's full list) with the scarlet-theme CSS
  variables they should reference.
- Tagline: `<div class="tag">All odds everywhere</div>` on all five pages.
- Copy mismatches per audit (nav titles, empty states).

### 6. Accessibility low-hangers (audit §a11y)

Focus-visible states for rail links/chips/buttons (reuse the accent
outline), `aria-hidden` on the decorative ticker, contrast fixes the audit
flagged. No ARIA architecture project — just the listed items.

## What this pass does NOT do

- No visual redesign — the scarlet theme and layout stay as they are
- No new features, no server changes (server untouched entirely)
- No JS framework/module refactors; smallest change per item

## Verification

1. `npm test` — 52 pass (server untouched; regression only).
2. Headless-Chrome layout probe (same method as the audit): every page at
   390 px and 360 px with stubbed data → no horizontal document overflow;
   the board-poll test (props stay open across a tick).
3. Manual pass on desktop: rail hover on all buttons, theme spot-checks.
4. Audit file re-walk: every item checked off with its fixing commit noted,
   or explicitly marked "won't fix" with a reason (target: zero of those).

## Out of scope

- Get Props model changes, Kalshi work (own specs)
- The Statcast pipeline (backend, other workstream)
