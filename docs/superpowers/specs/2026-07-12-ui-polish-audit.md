# LineWatch Frontend UI/UX Audit

Audited: `public/styles.css`, `public/common.js`, all 5 pages + page JS. Findings verified empirically where possible (headless Chrome layout probes at exact 390px viewport via same-origin iframe, with stubbed `/api` data to exercise loaded states — no analyze/props API credits spent).

Severity legend: **breaks-usage** / **ugly** / **polish**.

---

## 1. Reported bug — "Get Props" hover shading bleeds out of the nav rail

### 1.1 Root cause: label wraps to two lines and spills out of the fixed 44×44 button box
- **Where:** `public/styles.css:106-111` (`.rail-btn` `width:44px; height:44px`, `.rail-label` `font-size:8.5px`), markup generated at `public/common.js:215-218` (`renderNav`).
- **Mechanism (measured):** "GET PROPS" at 8.5px/600/uppercase has a max-content width of ~52px — wider than the 44px button — so it wraps to two lines ("GET" / "PROPS", label box measures 42×26px). Total content (18px icon at line-height 1.5 = 27px + 2px gap + 26px label = ~55px) exceeds the fixed 44px height. Because `.rail-btn` uses `justify-content:center` and overflow is visible, the content is centered and spills ~5-6px past the button's top and bottom edges (measured: button box y 277→321, label bottom at 327). The `:hover` background and the `.active` red border paint only the 44×44 rounded box, so the second text line sits visibly **outside** the shaded/bordered box, and hovering that stray text still triggers the button's hover — which reads as "the hover shading extends outside the border." The spill eats the entire 6px gap to the next button ("Record"), so the stray "PROPS" line visually attaches to the Record button.
- **Siblings:** measured label widths — Home 27px, Board 31px, **Record 37px**, Slip 19px: all fit on one line inside 44px. **Only "Get Props" wraps.** Record is safe today but has just 7px of headroom; a slightly wider font fallback (Inter not loaded) could push it over.
- **Mobile too:** in the ≤980px row-mode rail the same wrap happens (label bottom measured 6px past the button box, poking toward the page content below the rail's border-bottom).
- **Fix:** any one of: (a) `white-space:nowrap` on `.rail-label` + drop the fixed `width:44px` in favor of `min-width:44px; padding:0 6px;`; (b) rename the label to "Props"; (c) `height:auto; min-height:44px` so the box grows with the wrapped label. Option (a) or (b) keeps the rail rhythm uniform.
- **Severity:** ugly (highly visible, on every page).

---

## 2. Mobile / responsive

Viewport meta is present and correct on all 5 pages (good). `chip-row`, `header-top`, `search-row`, `cta-row` all wrap/reflow correctly at 390px (verified). The problems are the data-loaded states, which the existing `@media (max-width:980px)` rules never address:

### 2.1 Board with games loaded: page min-width 449px → horizontal scroll on every phone
- **Where:** `public/styles.css:189-197` (`.book-row` — flex, no wrap) and `styles.css:131-137` (`.layout` grid `1fr` column, grid-item `min-width:auto`).
- **What (measured at 390px):** a `.book-row` carrying badge (88px min) + "Best" + "Value" tags + odds + "+ Slip" button + "↗" link + five 12px gaps has a min-content of **383px**; + `.outcome-block` padding (32) + card border (2) + `main` padding (32) = **449px document min-width**. The whole page — header, nav rail, footer — stretches to 449px and scrolls sideways on a 390px phone (~60px overflow; ~90px on 360px devices).
- **Why it matters:** every page element shifts; users must pan to reach the "+ Slip" buttons and the Auto/search controls; it looks broken on any phone.
- **Fix:** at a small breakpoint let `.book-row` wrap (`flex-wrap:wrap`) or drop the `↗` link / shrink gaps; and add `min-width:0` to `.layout main` so a single row can never widen the page.
- **Severity:** breaks-usage.

### 2.2 Board props table: page min-width grows to 473px when props are open
- **Where:** `public/styles.css:237-243` (`.props-table`), `public/board.js:190-215` (4-col table, `white-space:nowrap` on player/line cells), no scroll wrapper anywhere.
- **What (measured):** with a full 8-book line-shop the table's min-content is **407px**; page min-width becomes **473px** at a 390px viewport. There is no `overflow-x:auto` container — the table widens the grid column (grid `min-width:auto` propagation) instead of scrolling locally. Note `.game-card{overflow:hidden}` (`styles.css:168`) means that if the column were ever constrained, the table would be **clipped with no way to scroll** — the wrong failure mode in both directions.
- **Fix:** wrap `.props-table` (or `.props-block`/`.market-body`) in a `div{overflow-x:auto}`; add `min-width:0` on `main`.
- **Severity:** breaks-usage.

### 2.3 Record page tables: 760px wide at a 390px viewport (docWidth 826px)
- **Where:** `public/record.js:56-70` ("Recent results", 6 columns, 4 of them `white-space:nowrap` including matchup + date) inside `.panel` with no overflow wrapper.
- **What (measured with representative graded data):** recent-results table min-content **760px** → document width **826px**, more than 2× the viewport. The calibration and by-market panels stretch to match. Record is unusable on a phone once real picks exist.
- **Fix:** `overflow-x:auto` wrapper per table; consider dropping/stacking the matchup·date column on small screens.
- **Severity:** breaks-usage.

### 2.4 Get Props picks table: 636px wide at 390px (docWidth 702px)
- **Where:** `public/getprops.js:95-110` — 8 columns (Player, Prop, Side, Model, Book, Edge, Best price, + Slip), several `white-space:nowrap`.
- **What (measured with a stubbed analysis result):** table min-content **636px** → page min-width **702px**. The expanded `.pick-detail` row and `.bar-strip` fit within the already-oversized table, so the whole page pans.
- **Fix:** `overflow-x:auto` wrapper; on ≤640px consider merging Model/Book/Edge into the expandable detail row.
- **Severity:** breaks-usage.

### 2.5 Tap targets well below 44px
- **Where:** `.odds-chip` (`styles.css:255-259`, ~19px tall — and each is an individually tappable link into a sportsbook, `board.js:200`), `.add-leg-btn` (`styles.css:215`, ~26px), `.remove-btn` (`styles.css:300-303`, ~18px), `.book-link-btn` (`styles.css:223`, ~24px), `.props-market-label` collapse header (~17px).
- **Why:** primary mobile actions (add leg, remove leg, open book) are fiddly; adjacent chips make mis-taps likely.
- **Fix:** bump padding/min-height at the mobile breakpoint (`min-height:32-44px`), enlarge remove-btn hit area with padding.
- **Severity:** ugly.

### 2.6 Hover-only affordances with no touch equivalent
- **Where:** ticker pause is hover-only (`styles.css:84`); all weather explanations live in `title` tooltips — `.weather-slot` (`common.js:569`), `.rating-tag` (`common.js:585`), wind SVG (`common.js:531`), plus `.odds-chip` book-name titles (`board.js:199`).
- **Why:** on touch devices the carry-conditions rationale, wind explanation, and pause control simply don't exist.
- **Fix:** move key tooltip content to visible microcopy or a tap-to-open popover; add a pause control for the ticker (also an a11y win, see 5.2).
- **Severity:** ugly.

### 2.7 Small fixed-size leftovers
- `.bar-strip .bar{width:14px}` (`styles.css:407`) doesn't scale with sample size — fine at 10 bars, overflows its cell if the window ever grows past ~25 games. `styles.css:406-408`. Severity: polish.
- Sticky `header.app-header` + ticker consume ~130px of a phone's viewport height on every page (`styles.css:32-36`); consider unsticking or collapsing the ticker on ≤640px. Severity: polish.

---

## 3. Dead code

### 3.1 `input[type=password]` selector — `styles.css:51`
No password input exists on any page (leftover from the removed API-key settings panel). Severity: polish.

### 3.2 `select` styling — `styles.css:51,57`
No `<select>` exists anywhere (sport dropdown was replaced by chips). Severity: polish.

### 3.3 `.settings-field` block — `styles.css:285-287`
Three rules; zero markup uses the class (settings-panel era). `.settings-hint` IS still used — keep that one. Severity: polish.

### 3.4 `button.icon-btn` — `styles.css:70`
No element carries the class. Severity: polish.

### 3.5 `myBookKeys()` — `common.js:409-412`
Defined, never called from any file. Severity: polish.

### 3.6 `filterToMyBooks()` — `common.js:415-420`
Defined, never called — `board.js:351-352` re-implements the same filtering inline (without the documented "never filter to nothing" fallback, incidentally). Either use the helper or delete it. Severity: polish.

### 3.7 `.props-table th{position:sticky; top:0}` — `styles.css:241`
Orphan of the old standalone props page. Today: inside `.game-card{overflow:hidden}` (board, getprops) sticky never engages; in record's `.panel` (no overflow ancestor) the header sticks to the *viewport* top and immediately slides **under** the sticky app header (z-index 40), so it's invisible while stuck. Non-functional in every current context. Severity: polish.

### 3.8 `.props-toggle` class reused for the My Sportsbooks toggle — `board.html:45`
The wrapper reuses the props-era class purely for its styling and immediately overrides its margin inline. Misleading name, fragile coupling. Severity: polish.

### 3.9 `id="shotsPanel"` on the "Reference Links" panel — `slip.html:43`
Legacy "screenshots" era id; nothing references it in JS. Severity: polish.

---

## 4. Theme / copy

### 4.1 Old-palette rgba remnants in weather + error styles
- `.weather-slot.w-mod` / `.rating-tag.w-mod` use `rgba(255,216,77,…)` = old warn **#FFD84D**, but `--warn` is now **#FFB443** (`styles.css:472,479`).
- `.weather-slot.w-bad` / `.rating-tag.w-bad` use `rgba(255,92,92,…)` = old bad **#FF5C5C**, but `--bad` is now **#FF6B6B** (`styles.css:473,480`); `.error-msg` also uses the old value + hardcoded `#ffb2b2` text (`styles.css:338-342`).
- **Fix:** re-derive from the current tokens (or add `--warn-rgb`/`--bad-rgb` custom props).
- **Note:** the suspected lime `#d7ff70` / `rgba(200,255,77)` hover remnants are **already gone** — confirmed absent from the entire public/ tree.
- Severity: polish.

### 4.2 `button.primary:hover` hardcoded `#E0102B` — `styles.css:67`
Not derived from the scarlet family (`--accent #BB0000` / `--accent-dim #8C0000`); it's a visibly different, bluer red on hover of the main CTA. Severity: polish.

### 4.3 Brand tagline inconsistency — `index.html:17` vs everywhere else
Home says "All odds everywhere"; board/getprops/record/slip all say "Your Odds Copilot" (`board.html:17`, `getprops.html:17`, `record.html:17`, `slip.html:17`). Pick one. Severity: polish.

### 4.4 Stale ticker placeholder copy on pages with no sport picker
"Pick a sport and pull odds to populate this ticker →" appears on `getprops.html:24`, `record.html:23`, `slip.html:23` — none of those pages has sport chips or a pull button; they auto-fill the ticker. Severity: polish.

### 4.5 Misleading empty-props message under an active book filter — `board.js:218`
With a props book-filter selected, a game whose props lack that book renders "No player props posted for this game yet" — the props exist, the filter hid them. Say "No [book] props for this game — clear the filter." Severity: polish.

### 4.6 Kalshi accent hardcoded `#00D991` — `styles.css:424`
Near-but-not `--good` (#3DDC84). If intentional brand color, fine — otherwise tokenize. Severity: polish.

### 4.7 Page title vs hero mismatch on Record
`record.html:6` titles it "LineWatch — Record", nav label "Record", hero says "Model Record" (`record.html:32`). Minor, but the only page where the three disagree. Severity: polish.

---

## 5. Accessibility

### 5.1 `outline:none` on inputs/selects — `styles.css:55`
Keyboard focus on the search input / link input is only a faint border-color shift (`styles.css:57`). Add a visible `:focus-visible` ring (accent outline) globally. Severity: ugly.

### 5.2 Ticker: animated marquee with no ARIA and no non-hover pause
`index.html:21-25` (and 4 clones), `common.js:145-169`. It's decorative-but-updating content: no `aria-hidden` or `aria-live="off"`, no pause button (hover-pause only — nothing on touch/keyboard). `prefers-reduced-motion` IS handled (`styles.css:91-93`) — good. Fix: `aria-hidden="true"` on the track + a visible pause toggle. Severity: ugly.

### 5.3 Toast has no `role`/`aria-live` and a 2s window — `common.js:237-250`
Screen readers never announce "Added ✓ — View slip", and 2000ms is too short for anyone to actually tap the "View slip" link it doubles as. Fix: `role="status"` and ~4-5s timeout (or dismiss on scroll). Severity: ugly.

### 5.4 `--text-faint` (#808080) fails contrast on card surfaces
≈3.9:1 on `--bg-card` #242424 and ≈4.4:1 on #1B1B1B — below WCAG AA 4.5:1, and it's used for *small* text everywhere: `.game-time` 11.5px, table `th` 10px, `.kalshi-note` 10px, `.cheat-sub` 11px, `.analyze-cost` 10.5px, skipped-players lines 11px. Bump to ~#8E8E8E+ or reserve faint for ≥14px. `styles.css:10` and usages. Severity: ugly.

### 5.5 Book-badge dark text fails contrast on some brand colors
`#1B1B1B` text (`styles.css:202`) on ESPN BET `#D00023` ≈3.0:1 and BetRivers `#1F7A8C` ≈3.5:1 (`common.js:21,24`) — under 4.5:1 at 15px. Use white text for dark brand colors (compute per-color luminance). Severity: ugly.

### 5.6 Click-only expandable rows with no keyboard/ARIA
`.pick-row` toggles its detail row via `tr` click (`getprops.js:181-186`), `.props-market-label` collapses markets via div click (`board.js:226-240`) — neither is focusable, no `aria-expanded`, no Enter/Space handling. Fix: use `<button>` inside the cell/header or `tabindex=0` + key handler + `aria-expanded`. Severity: ugly.

### 5.7 Emoji as icons without `aria-hidden` — `common.js:215-218`
Nav accessible names read "🏠 Home", "🎯 Get Props" etc.; screen readers announce the emoji first. Wrap icons in `aria-hidden="true"` spans (the `title`/label already name the link — note `title` also duplicates the visible label, harmless but redundant). Severity: polish.

### 5.8 Heading structure skips
Each page's `h1` is the brand; the actual page name ("Odds Board", "Get Props"…) is a styled `div.hero-line` (`board.html:34` etc.), then content jumps to panel `h2`s. Make hero-line an `h2` (or the page `h1`). Severity: polish.

### 5.9 Search input has no label — `board.html:42`
Placeholder-only. Add `aria-label="Search teams"`. Severity: polish.

### 5.10 8.5px nav labels / 9.5-10px weather-and-tag type — `styles.css:111,454,466`
Below any comfortable legibility floor, especially on high-DPI phones. Severity: polish.

---

## 6. Misc / behavioral kinks

### 6.1 30-second scores poll fully re-renders the board, collapsing open props — `board.js:46-48,59-70` + `board.js:252-466`
`refreshScores()` runs every 30s for **every** sport with games and calls `renderGames()`, which rebuilds all cards from scratch. Open/closed props state lives only in the DOM, so: an open props section snaps shut every 30 seconds, the toggle resets to "Show player props", a mid-flight props load's spinner is wiped, and every card replays its `.enter` stagger animation (visible flicker). This is the biggest regression from merging props into the board page. Fix: only re-render when scores actually changed AND patch score badges in place (or persist open-state in `state` like `getprops.js` does with `state.expanded`). Severity: breaks-usage.

### 6.2 Board renders up to 4 times on MLB load — `board.js:36,41,47`
Odds render, then weather fetch → `renderGames()`, kalshi fetch → `renderGames()`, scores fetch → `renderGames()` — each replays entrance animations and re-registers props state. Debounce/batch the re-renders or patch in place. Severity: ugly.

### 6.3 Fetch failure leaves skeleton shimmer running forever
`board.js:50-53` and `getprops.js:23-26` show the error banner but never replace `renderSkeletonCards()` output — an infinite fake-loading shimmer sits below the error. Clear `gamesArea` (empty-state with retry button) in the catch. Severity: ugly.

### 6.4 Record load failure blanks the page — `record.js:12-15`
On error `recordArea` is set to `''` — error message only, no empty-state, no retry. Severity: polish.

### 6.5 Slip "Reference Links": not persisted + `javascript:` URLs become live links — `slip.js:2,125-147`
`state.manual` is in-memory only — entries vanish on refresh while everything else (slip, sport, books) persists in localStorage; and `href="${escapeHtml(m.text)}"` doesn't sanitize the scheme, so pasting `javascript:...` creates a clickable script link (self-XSS only, but trivial to guard: require `^https?://`). Severity: ugly.

### 6.6 Slip badge "bump" animation plays on every page load — `common.js:221-231`
`_lastSlipBadgeCount` starts at 0, so any non-empty slip triggers the bump on nav render of every page. Initialize it lazily from `getSlip().length` before first compare. Severity: polish.

### 6.7 `.copy-block` has no copy button — `slip.js:96`, `styles.css:314-319`
The block exists to be copied into a sportsbook; add a "Copy" button using `navigator.clipboard` (no clipboard code exists anywhere). Severity: polish.

### 6.8 Ticker loop has a full blank gap each cycle — `styles.css:79-90`
Track starts at `padding-left:100%` and translates -100% of its own width, so after the content passes, the viewport is empty until the loop restarts (40s cycle). Standard fix: duplicate the items and translate -50%. Severity: polish.

### 6.9 Two disconnected book-filter systems on the board
"My sportsbooks" checkboxes (`board.js:78-93`) filter the moneyline rows; the separate `propsBookFilter` chips (`board.js:111-141`) filter props — same mental model, two UIs, neither affects the other. Unify or visually connect them. Severity: polish.

### 6.10 Kalshi is fetched browser-side cross-origin — `common.js:621-630`
Works only while `api.elections.kalshi.com` serves permissive CORS; failures are silent (row just vanishes). Consider proxying server-side like the other feeds for consistency/observability. Severity: polish.

---

## Tally

| Severity | Count |
|---|---|
| breaks-usage | 5 (2.1, 2.2, 2.3, 2.4, 6.1) |
| ugly | 12 (1.1, 2.5, 2.6, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 6.2, 6.3, 6.5) |
| polish | 28 (2.7×2, 3.1-3.9, 4.1-4.7, 5.7-5.10, 6.4, 6.6-6.10) |

---

## Resolution

All 45 catalogued items, mapped to the commit (or explicit reassignment) that resolved them.

| Item | Fixing commit / disposition |
|---|---|
| 1.1 | 9f20316 |
| 2.1 | 9f20316 |
| 2.2 | 9f20316 |
| 2.3 | 9f20316 |
| 2.4 | 9f20316 |
| 2.5 | 299bff7 / 8f69314 / 5ff0e67 |
| 2.6 | partial: ticker-pause done Task 3 (299bff7/8f69314/5ff0e67); weather microcopy reassigned (not implemented — hover-only weather tooltips remain; visible microcopy would need a design pass, out of scope for this batch) |
| 2.7a | 9f20316 |
| 2.7b | this commit (`header.app-header{position:static}` at ≤640px) |
| 3.1 | this commit (deleted `input[type=password]` from selector list) |
| 3.2 | this commit (deleted `select` from selector lists) |
| 3.3 | this commit (deleted `.settings-field` rules, kept `.settings-hint`) |
| 3.4 | this commit (deleted `button.icon-btn`) |
| 3.5 | this commit (deleted `myBookKeys()`) |
| 3.6 | this commit (board.js now calls the documented `filterToMyBooks()` helper instead of its own inline filter/fallback) |
| 3.7 | 9f20316 (verified gone this task — zero `position:sticky` hits outside the header) |
| 3.8 | this commit (board.html:45 wrapper renamed `.props-toggle`→`.books-toggle`, own CSS rule) |
| 3.9 | this commit (`shotsPanel`→`linksPanel` in slip.html) |
| 4.1 | this commit (weather/error rgba values re-derived from `--warn`/`--bad`) |
| 4.2 | this commit (`button.primary:hover` now `var(--accent-dim)`) |
| 4.3 | this commit ("All odds everywhere" tagline rolled out to board/getprops/record/slip) |
| 4.4 | this commit (ticker placeholder → "Loading the ticker →" on getprops/record/slip) |
| 4.5 | this commit (book-filtered empty-props message names the filtered book) |
| 4.6 | this commit (Kalshi badge tokenized to `var(--good)`) |
| 4.7 | this commit (Record hero "Model Record" → "Record") |
| 5.1 | 299bff7 / 8f69314 / 5ff0e67 |
| 5.2 | 299bff7 / 8f69314 / 5ff0e67 |
| 5.3 | 299bff7 / 8f69314 / 5ff0e67 |
| 5.4 | 299bff7 / 8f69314 / 5ff0e67 |
| 5.5 | 299bff7 / 8f69314 / 5ff0e67 |
| 5.6 | 299bff7 / 8f69314 / 5ff0e67 |
| 5.7 | this commit (nav emoji wrapped `aria-hidden="true"`, redundant `title` dropped) |
| 5.8 | this commit (`.hero-line` div → `<h2>` on all five pages) |
| 5.9 | this commit (`aria-label="Search teams or matchups"` on the board search input — it's the only search input in the app; the slip page's link-paste field is a different control with its own visible label) |
| 5.10 | this commit (`.rail-label` 8.5px→9.5px; `.roof-tag`/`.rating-tag` bumped to a 10.5px floor; probe-verified no wrap at 390px) |
| 6.1 | 629f67c |
| 6.2 | 629f67c |
| 6.3 | 629f67c |
| 6.4 | this commit (record load failure now shows empty-state + Retry, matching Task 1's board/getprops pattern) |
| 6.5 | this commit (`state.manual` persists to `lw_links` with the same guarded-JSON pattern as `lw_slip`; links only render as `<a>` when they match `/^https?:\/\//i`, else plain text) |
| 6.6 | this commit (`_lastSlipBadgeCount` seeded from `getSlip().length` at load instead of `0`) |
| 6.7 | this commit (`.copy-block` gained a Copy button using `navigator.clipboard.writeText`, flashes "Copied ✓") |
| 6.8 | this commit (ticker track renders its item sequence twice; animation translates -50% with `padding-left:0`) |
| 6.9 | this commit (minimal connect: "My sportsbooks — moneylines" toggle label + "Props — book filter" heading above the props chip row) |
| 6.10 | reassigned: kalshi spec §3 |

Zero unexplained rows — all 45 items accounted for.

45 catalogued kinks total. Positives worth keeping: viewport meta on all pages, thorough `prefers-reduced-motion` coverage, consistent element-guarded shared JS, escapeHtml discipline everywhere except 6.5.
