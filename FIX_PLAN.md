# FIX_PLAN — review of 2026-08-03

Findings from a full-game iPad-landscape review of `485753d`. Baseline before any work:
**350 tests passing** (`node run-tests.js`, ~45s).

Read this file first. Each item is self-contained — root cause, exact edit sites, and how
to prove it — so a session can open with "start F4" and need nothing else. Tick the
status column as they land.

Browser checks go on the throwaway origin `http://127.0.0.1:8765` (never `localhost:8765`).
Take a `screenshot` before any layout measurement — a hidden pane freezes rAF and `ui.js`'s
`fit()` never runs, so the numbers lie. The finished scratch card already on that origin
(Astros 3 – Rangers 4, 10 innings, one sub, a pitching change, an error) is a good fixture.

Do **not** bump `SHELL_VERSION` in `sw.js` by hand — the pre-commit hook does it.

| | Fix | Severity | Size | Status |
|---|---|---|---|---|
| **F1** | Reloaded card loses its inning zeros and the X | data fidelity | XS | **done** |
| **F2** | Empty fielder entry silently loses the out | data loss | XS | **done** |
| **F3** | Every entry point refuses silently with no cell selected | trust | S | **done** |
| **F4** | Live readout goes stale when a name is typed | trust | XS | **done** |
| **F5** | `newGame()` skips the unsaved-changes check | data loss | XS | **done** |
| **F6** | Popups are not modal to touch | correctness | M | **done** |
| **F7** | `markSub()` shows nothing at all | usability | S | **done** |
| **F8** | A lone SB option auto-applies — including steal of home | correctness | XS | **done** |
| **F9** | Open drawer covers the card, nothing scrolls | iPad | M | **done** |
| **F10** | Fielder entry is a text field → iOS alphabetic keyboard | iPad | M | **done** |
| **F11** | Advance Runners: no defaults, no cancel, silent refusal | iPad | M | **done** |
| **F12** | Spray prompt fires on every hit with no way to turn it off | iPad | S | **done** (won't-fix + 2) |
| **F13** | Jersey numbers clip at 1024px | polish | XS | **done** |
| **F14** | Win-probability chart never re-themed | polish | S | **done** |
| **F15** | "PO" collision and "CLR All" mislabel | polish | XS | todo |
| **F16** | Zero prints blank in one linescore, `0` in the other | polish | XS | todo |
| **F17** | Hotkey help unreachable without a keyboard | polish | XS | todo |
| **F18** | Details doesn't prefill today's date | polish | XS | todo |
| **F19** | Lineup entry is 54 taps with no reuse | feature | L | **needs a ruling** |

Suggested order: **F1 → F2 → F5 → F4 → F3 → F8 → F7 → F6**, then decide F9/F11/F12
together (they are all "how much does entry cost per play"), then F10, then the polish
batch F13–F18 in one pass. F19 last, or never.

---

## Tier 1 — data fidelity and silent failure

These are small, independent and carry the most risk-per-byte. Do them first.

### F1 — a reloaded card loses its inning zeros and the unplayed-half X — **done**

**One correction to the finding.** The zeros are lost exactly as described. The **X is not**:
nobody bats in that half, so the load path has no `updateInningRuns` to blank it with, and it
comes back from the store intact. What the load path could not do was *derive* one that isn't
there — a card from a build that never wrote it, or a hand-edited one. The test is written
that way rather than as a plain round-trip, which would have passed without the fix.


**Symptom.** Score a game to FINAL and reload. The linescore that read
`2 1 0 0 0 0 0 0 0 0` now reads `2 1 · · · · · · · ·` — only the scoring innings. On a
normal home win the **X** for the unplayed bottom half is missing too. It comes back the
moment you tap any cell, which is why it is easy to miss.

**Root cause.** `fillLinescoreZeros()` (app.js:4569) works correctly — calling it directly
restores `["2","1","0","0",…]`. Its **only** caller is `updateSituation()` (app.js:3389),
which opens with `if (!selectedCell) return;` (app.js:3332). After a reload nothing is
selected, so it never runs. Separately, `updateInningRuns` (app.js:2793) writes `''` for a
0-run inning, so the load path blanks the values that `localStorage` had held correctly —
verified: stored `["2","1","0","0",…]` vs in-memory `["2","1","","",…]` after load.
`markUnplayedHomeHalf()` is called from the tail of `fillLinescoreZeros()`, so it is lost
by the same path.

**Fix.** Call it once from the end of `applyState()`, independent of selection. Insert
before the timer-restore block at app.js:5112:

```js
  // The line's derived figures — a 0 in every completed half, an X in a bottom half the
  // game never reached — come from fillLinescoreZeros, whose only other caller is
  // updateSituation, and that returns early with nothing selected. A freshly loaded card
  // has nothing selected, so without this a finished card reads as if only the scoring
  // innings were played until the first tap (F1).
  fillLinescoreZeros();
```

**Verify.** Add to `tests-scoring.js`: score a half-inning to 3 outs with no runs, round-trip
through `collectState()` → `applyState()` with `selectedCell` nulled, assert the inning input
is `'0'` and `gameState.linescore` agrees. Second test: a home win leaves `X` in the bottom of
the last inning after the same round-trip. Then in the browser, reload the scratch card and
read the line before touching anything.

**Risk.** Low. `fillLinescoreZeros` only ever writes into a cell whose value is `''`, and
`markUnplayedHomeHalf` deliberately never writes over a figure already on the line.

---

### F2 — confirming an empty fielder field silently loses the out — **done**

**Symptom.** Tap GO (or FO / PO / LO / DP / TP / FC / E), then confirm without typing. The
popup closes, **no out is recorded**, and nothing is said. Very reachable on iPad: tap GO,
the keyboard slides up over the deck, tap Return out of reflex. The `6-3` you see in the box
is `input.placeholder` (app.js:5159) — not a value.

**Root cause.** app.js:5174 — `if (val) applyPlay(normalizePlayCode(prefix + val), t);`.
The falsy branch closes the popup and returns with no message.

**Fix.** Speak the refusal and keep the popup open so the entry can be completed:

```js
      const val = input.value.trim();
      if (!val) { showPlayReject('Type the fielder(s) first — e.g. 6-3.'); return; }
      popup.style.display = 'none';
      hidePopupBackdrop();
      input.blur();
      applyPlay(normalizePlayCode(prefix + val), t);
```

Note the reorder: the popup must now close *after* the guard, not before it.

**Verify.** Test: open the popup via `promptGroundout()`, fire Enter with an empty input,
assert the at-bat still has no play, the popup is still open, and `#play-reject` is visible.
A second test that a real value still records and closes (guards the reorder).

**Risk.** Low. Escape still cancels. Pairs naturally with F10 but does not depend on it.

---

### F3 — every entry point refuses silently when no cell is selected — **done**

All 19 `if (!selectedCell) return;` sites plus the three `if (!t) return;` sites now speak.
`updateSituation` and the global keydown handler stay silent, as specified. No existing test
asserted silence on any of them. The auto-select suggestion at the end is still open.

**Symptom.** On a fresh card with lineups entered, no cell is pre-selected and the readout
reads `—`. Tapping **1B** — the likeliest first tap of a game — does nothing and says
nothing. Same for every pitch button and every drawer button.

**Root cause.** ~22 entry points return bare. `applyPlay` uses
`const t = target || currentTarget(); if (!t) return;` (app.js:1752); the rest use
`if (!selectedCell) return;`. `applyPlay`'s own comment two lines below says a refused play
that says nothing is how a scorer ends up trusting a card that does not hold what they
entered — which is exactly this case.

**Fix.** One shared guard next to `showPlayReject` (app.js ~1520):

```js
// The card has no selection until a cell is tapped, and on a fresh card that is the state
// the first play button meets. Named, like every other refusal (F3).
const NO_CELL = 'Tap the batter\'s cell on the card first.';
function requireSelection() {
  if (selectedCell) return true;
  showPlayReject(NO_CELL);
  return false;
}
```

Then at each **user-facing** entry point replace `if (!selectedCell) return;` with
`if (!requireSelection()) return;`:

```
3147 addPitch          3187 removePitch       3531 promptSBBase      3593 promptCSBase
3635 promptPickoff     3768 applyRunnerEvent  3943 editPlayType      4080 editRunners
4121 moveRunner        4227 clearPlayKeepPitches                     4271 editSprayChart
4298 adjustRBI         4388 reviewEarnedRuns  4449 clearSelectedCell 5400 changePitcher
5443 markSub           5472 markPinchRunner   5874 changeFieldPos    5945 setPitcher
```

And for the three `if (!t) return;` sites — 1752 `applyPlay`, 3270 `showStrikeoutPopup`,
5144 `showPositionPopup` — use `if (!t) { showPlayReject(NO_CELL); return; }`. All three are
only ever passed a non-null `target` by internal callers, so the message can only reach a
genuine no-selection tap.

**Leave silent, deliberately:** app.js:3332 `updateSituation` (runs on every repaint) and
app.js:7309 the global keydown handler (the function it dispatches to will speak for
itself; toasting on every stray keypress would be worse).

**Verify.** Test: with `selectedCell === null`, each of `applyPlay('1B')`, `addPitch('S')`,
`promptSBBase()`, `markSub()` leaves state untouched **and** shows `#play-reject`.
⚠️ Run the full suite — an existing test may assert silence on one of these paths and need
its expectation updated rather than the fix reverted.

**Also worth considering** (separate, ask first): auto-select cell 1 / inning 1 when a card
has a lineup and no plays, so the first tap has somewhere to land.

---

### F4 — the live readout goes stale when a name is typed — **done**

**Symptom.** Tap SUB, type the substitute's name, and the "At Bat" panel keeps naming the
man he replaced (`#7 Jung` after `#25 Carter` was typed). Same for a reliever written in
mid-inning. It corrects itself on the next play — i.e. after the moment you needed it.

**Root cause.** The three `document.addEventListener('input', …)` handlers (app.js:7424,
7430, 7436) call `runAction`, `autoSave()` and `fitName()` — never `updateSituation()`.
`getActivePlayerName` / `livePitcherLabel` already read off the input, so only the repaint
is missing.

**Fix.** Extend the existing name/number handler rather than adding a fourth listener:

```js
document.addEventListener('input', function (e) {
  const t = e.target;
  if (!t || !t.matches) return;
  if (t.matches(NAME_FIT_SELECTOR)) fitName(t);
  // The readout names the batter and the pitcher off these very inputs, and nothing was
  // repainting it — so a substitute typed in under the scorer's fingers left the panel
  // naming the man he replaced until the next play (F4).
  if (t.dataset.field === 'name' || t.dataset.field === 'num') updateSituation();
});
```

`updateSituation()` already no-ops with nothing selected, so no extra guard is needed.

**Verify.** Test: select a cell, `markSub()`, set the sub row's name input and dispatch
`input`, assert `#ls-batter` names the substitute without any other call. In the browser,
watch the panel while typing.

**Risk.** Low, but `updateSituation` also runs `fillLinescoreZeros` and
`updateBackupReminder`. Both are idempotent. If per-keystroke cost shows up on the iPad,
coalesce on a rAF the way `refit()` does.

---

### F5 — `newGame()` clears an unsaved card without saying so — **done**

**Symptom.** More → New Game asks "Clear all data and start a new scorecard?" — the same
question whether the card is saved or has an inning of unsaved work in it.

**Root cause.** `newGame()` (app.js:5123) confirms unconditionally.
`loadGameFromLibrary()` (app.js:6423) already does this properly:
`collectState()` then `currentGameHasUnsavedChanges()` then a specific warning.

**Fix.** Borrow that pattern:

```js
function newGame() {
  collectState();   // catch live DOM edits before comparing
  const warning = currentGameHasUnsavedChanges()
    ? 'This card has unsaved changes that will be lost. Start a new scorecard anyway?'
    : 'Clear all data and start a new scorecard?';
  if (!confirm(warning)) return;
```

**Verify.** Test both branches by stubbing `window.confirm` and asserting the message text.

---

## Tier 2 — trap removal

### F6 — popups are not modal to touch  ← headline — **done**

**What landed**, with two rulings taken on 2026-08-03:

- *Scope: all eleven, not the eight above.* Select Pitcher, Position Change and the
  W/L/SV picker render over the card with no backdrop too, and `setPitcher` reads the
  **live** selection when its button is pressed — so a cell tapped behind Select Pitcher
  took the pitching change. Same bug, same fix.
- *A backdrop tap dismisses what can be dismissed.* Making eleven popups modal without
  this trades a popup you can tap past for one you can see past but not close. So a tap
  outside closes any popup that already had a Cancel; `runner-popup`, `outcome-popup` and
  `dh-popup` still swallow it and say why. `dh-popup` is on that list because the illegal
  lineup it is asking about is already on the card — closing it unanswered leaves exactly
  what it exists to resolve. Escape follows the same rule, so the Magic Keyboard path
  matches the finger.

Rather than pairing `showPopupBackdrop`/`hidePopupBackdrop` by hand at each site — which is
how the list came to be missing seven popups — every open and close goes through
`openPopup`/`closePopup`, and `syncPopupBackdrop()` re-derives the backdrop from the DOM.
A missed call can now only leave the backdrop up until the next one, not permanently.
New Cancels on `k-popup`, `base-picker` and `decision-popup`. `sprayClickHandler` is
released on every close path, not just Skip — a handler left attached wrote the next hit's
location onto the previous at-bat. 7 new tests, 357 green.

Original finding follows.

**Symptom, reproduced by touch alone at 1194×834.** Tap **PO** (pickoff) in the Runners
drawer → the picker opens with no dimmed backdrop → tap the *Visiting* tab → the card
switches under it → tap the picker's option, and it applies against the half-inning it
captured when it opened. Separately, a spray popup from a first-inning single stayed on
screen across two half-innings. Two popups can stack and hide each other.

**Root cause.** `showPopupBackdrop()` has exactly **four** call sites — app.js:2221
(`outcome-popup`), 2679 (`runner-popup`), 3291 (`k-popup`), 5160 (`pos-popup`). These render
with none: `spray-popup`, `base-picker`, `edit-play-popup`, `move-runner-popup`,
`er-review-popup`, `recompute-popup`, `sub-popup`, `dh-popup`. Most *are* in
`PENDING_ENTRY_POPUPS` (app.js:1612), so while one is open **Undo/Redo refuse** — but
`entryInProgress()` lists only two, so `applyPlay` does not. Plays land behind a live popup.
`BACKDROP_GUARDED` (app.js:1568) lists only the same four, so a backdrop tap runs
`hidePopupBackdrop()` and orphans anything else.

**Fix, in three parts.**

1. **Derive the guard list** so it cannot drift again:
   ```js
   const BACKDROP_GUARDED = PENDING_ENTRY_POPUPS.concat(['spray-popup']);
   ```
   `PENDING_ENTRY_POPUPS` is declared at app.js:1612, *after* `BACKDROP_GUARDED` at 1568 —
   move the declaration up, or make the guard a function. A function is safer.

2. **Install a backdrop** on each of the seven that lacks one, and drop it on every close
   path. `showBasePickerPopup` (app.js:3695) is the worst offender — it sets
   `popup.style.display = 'block'` with no backdrop at all, and its `.bp-opt` handler closes
   the popup without one either.

3. **Give every dismissible popup a Cancel.** Today only *Select Pitcher* has one. Most
   important is `showStrikeoutPopup` (app.js:3268): it fires **automatically** at three
   strikes, offers only K and ꓘ, and — being in `PENDING_ENTRY_POPUPS` — disables the Undo
   that would be the way out. A foul tip caught, or a dropped third strike, currently has no
   exit. Its Cancel should close, drop the backdrop, and record nothing, leaving the count
   where it was.

**Do this incrementally**, one popup per commit, `base-picker` and `k-popup` first — those
are the two I reproduced damage through.

**Verify.** Per popup, a test that opening it makes `#popup-backdrop` visible and closing it
hides it. One integration test for the F6 case: open `base-picker`, `switchTab()`, assert the
picker is gone or its option refuses. In the browser, re-run the pickoff sequence above and
confirm the tab tap no longer reaches the card.

**Risk.** Medium — a missed close path leaves the backdrop over the app and it stops
responding. The existing `bd.onclick` already self-heals ("If whatever it was guarding is
already gone, get out of the way rather than leaving the app unclickable"), which is the
safety net; make sure `spray-popup` and `base-picker` are in the derived list so that branch
can see them.

---

### F7 — `markSub()` shows nothing at all — **done**

**Built the Note's version, not the main proposal.** The CSS already reveals a sub row on
`:focus-within` — but a `visibility: collapse` row *refuses focus* (verified in the browser:
`inp.focus()` leaves `activeElement` unchanged), so that rule can never fire from a cold
start. That deadlock is the whole finding. One new rule, `tr.pos-sub.revealed`, opens the
one slot's row so the caret can land in it; the class is dropped again on blur if nothing was
typed, so a SUB pressed by mistake leaves no stray blank row.

This makes the proposed `.show-subs` route unnecessary, and with it the `ui.js` label sync —
`app.js` never touches that class, so the button and the rows cannot disagree. It also avoids
the cost the Note flagged: 9 batting slots stay visible instead of about 4.

One harness change came with it. `markSub` now focuses an input, and the keydown handler
ignores hotkeys while an input has focus — correct in the app, but it crossed into later
cases and broke nine of them. `reset()` now blurs and closes any opened row.


**Symptom.** Tap SUB. Nothing visible happens — no toast, no mark, no new row. The
substitution *is* recorded (`subChange: 1`), but the row holding the name field is hidden,
and nothing points at "Show sub rows" (far right of the section bar) as the next step.

**Root cause.** `markSub()` (app.js:5443) calls `pushUndo` then
`setSubLine(team, pIdx, innIdx, INNINGS - 1, 1)` (app.js:5452) and returns. No
`announce()`, no toast. The sub row stays collapsed because the CSS reveals it only on
`:has(input[data-field="name"]:not(:placeholder-shown))` — so it appears only *after* a
name exists, which is the thing you cannot yet reach. `markPinchRunner` (app.js:5471), by
contrast, ends with an `announce()`.

**Fix.** Make one tap land the cursor where the name goes:

```js
  pushUndo(team, pIdx, innIdx);
  setSubLine(team, pIdx, innIdx, INNINGS - 1, 1);
  // The row this just created is hidden until it has a name in it, and the name field is
  // in that row — so without revealing it and taking the scorer there, SUB is a press with
  // no visible effect and no next step (F7).
  const wrap = selectedCell.closest('.main-area').querySelector('.grid-wrap');
  if (wrap) wrap.classList.add('show-subs');
  const nameInp = document.querySelector(`input[data-field="name"][data-team="${team}"][data-p="${pIdx + 1}"]`);
  if (nameInp) { nameInp.scrollIntoView({ block: 'center' }); nameInp.focus(); }
  announce('Substitute for ' + rowLabel(team, pIdx) + ' — enter his name.');
  showPlayNotice('Enter the substitute\'s name.');
```

Also sync the `Show sub rows` button label, which `ui.js` owns (it toggles the text on
click, so a class added from `app.js` leaves it reading "Show sub rows" while the rows are
shown). Cleanest: move the label out of the click handler in `ui.js` into a small
`syncSubToggle()` that reads the class, and call it from both places.

**Note.** Showing all 18 sub rows drops the fit to ~4 of 9 slots visible (measured; the page
then scrolls 504px, which is `ui.js`'s deliberate "let it scroll" branch). Revealing only the
affected slot's row would be better but needs a per-slot class rather than the one
`.show-subs` on the wrap — worth doing if it stays annoying.

**Verify.** Test that `markSub()` sets `subChange`, adds `show-subs`, and focuses the row's
name input. Browser: tap SUB and confirm the caret lands in the right field.

---

### F8 — a lone SB option auto-applies, including a steal of home — **done**

**The shortcut was deleted, not guarded.** It never served the common case it reads as
serving: every stealable base also offers its `+E` variant, so a runner with a clear path
always produces *two* options. Enumerating all eight occupancy combinations against the real
`runnerPathClear`, the only single-option states are the three whose single option is SBH
(3rd alone, 2nd+3rd, loaded). So the shortcut fired for exactly one play — the steal of home.
Adding `options[0].from < 2` would have left a branch nothing can reach.

`promptCSBase`'s shortcut is genuine and stays: CS has no `+E` variants, so one option there
really does mean one runner on base.


**Symptom.** Runners on 2nd and 3rd. Tap **SB** meaning the man on 2nd. A steal of 3rd is
blocked (occupied), so the *only* legal option is 3rd→home — and it was applied
immediately, scoring a run, with no picker and no confirmation.

**Root cause.** app.js:3556 — `if (options.length === 1) { applySBAtBase(team, innIdx,
options[0].from, false); return; }`. The shortcut is right for the common case (one runner,
one base) but wrong when the single option puts a run on the board.

**Fix.** Exclude the plate from the shortcut:

```js
  // One option is applied straight — except a steal of home, which is a rare play that
  // changes the score, and the scorer who tapped SB with two men on almost certainly meant
  // the other runner (F8).
  if (options.length === 1 && options[0].from < 2) {
    applySBAtBase(team, innIdx, options[0].from, false); return;
  }
```

`showBasePickerPopup` renders a single option fine, so the fall-through needs nothing.
`promptCSBase` (app.js:3603) has the same shortcut, but a lone CS only ever *removes* a
runner — leave it, or mirror it for symmetry if you prefer.

**Verify.** Test: runners on 2nd and 3rd, `promptSBBase()`, assert `#base-picker` is open
and no run scored. Existing single-runner tests must still auto-apply.

---

## Tier 3 — iPad ergonomics (three of these want a decision first)

### F9 — the open drawer covers the card and nothing scrolls  ← ruled 2026-08-03: **B + A**

**Adam:** B at ≥ 1100px (flat two-row drawer, no accordion), with A as the fallback below it.

**Measured before building, and the option text was wrong.** The preview said `--cell-h` would
settle around 36px and still fit nine slots. It cannot: `FIT_MIN` is 44px, so instead of
shrinking gracefully the fit hits the floor and the page scrolls. Re-measured at 1194×834, the
flat drawer is exactly 2 rows / 98px of buttons and takes the deck from 63px to 177px:

| | accordion (before) | flat, permanent |
|---|---|---|
| normal card | 57px rows, no scroll | **45px rows, no scroll, slot 9 fully visible** |
| backup banner up | 51px rows, no scroll | 44px rows (the floor) + 46px scroll |

Adam took that trade with the real numbers in front of him. The banner is dismissible, and a
scroll that exists is still better than the old `pageScroll: 0` with the rows unreachable.

**What landed.** `display: contents` on the five `.qbg-panel`s so their buttons wrap as one set
— panels wrap as unbreakable blocks otherwise, which gave three ragged rows. `fit()` reserves
the whole `.quick-bar` above 1100px instead of just `.qb-core`; below it, it keeps reserving
only the core *and* now hands the grid a `--grid-max-h` for as long as the drawer is open, so
the covered rows can be reached (A). `toggleQBDrawer` sets `body.drawer-open` — what the CSS
keys that scroll off — and scrolls the selected cell back into view. Verified at 1024×768: grid
bottom 576 vs deck top 594, scrollable by 110px, and it scrolls itself to the selected cell.

Two things fell out for free, both listed in the finding: at ≥1100px only one group being
reachable at a time is gone, and so is the group resetting to Outs on every half-inning change.

**Measured at 1194×834.** Drawer open: grid bottom 753 vs deck top 657 — batting slots 8
and 9 are behind the deck, and `pageScroll` is **0**, so they cannot be brought into view.
Recording for batter #8 the selected cell had **40 of its 56px hidden**. At 1024×768 with
the drawer open only 6.5 of 9 slots remain. This bites exactly when it matters: SB, CS, WP,
SUB and PR all live in the drawer, and the bottom of the order is up as often as any other
part of it.

This is deliberate — `ui.js`'s `fit()` reserves only `.qb-core`: *"The More-plays drawer
expands over the card; it must not push 400px of padding in."* So it is a trade to re-make,
not a bug to fix. Three ways out:

- **A (smallest).** On drawer open, scroll the selected cell into view. Give `.grid-wrap`
  its own `overflow-y: auto` with a max-height while `.qb-drawer.open`, so covered rows are
  reachable. `--cell-h` unchanged, nothing shrinks. ~15 lines in `ui.js` + a CSS rule.
- **B (the real iPad answer, recommended).** At ≥1100px drop the five-group accordion and
  lay all ~30 drawer buttons out in two rows. They fit at 1194px, and it also kills two
  other annoyances: only one group is reachable at a time, and the group resets to "Outs"
  on every half-inning change (each tab owns its own drawer copy). Costs ~110px of
  permanent deck height, so `--cell-h` gives up ~12px per row.
- **C.** Reserve the drawer's real height in `--deck-h` while it is open. Simplest, but
  every row shrinks the moment the drawer appears and grows back when it closes — the card
  visibly jumps.

**A and B compose.** My recommendation is **B for ≥1100px with A as the fallback below it**,
but the cost is real card pixels and that is your call. Tell me which and I'll spec it out.

---

### F10 — fielder entry raises the iOS alphabetic keyboard — **done**

**Done — both stages, in one pass.** Stage 1 alone would have left the keyboard up, so the
keypad went in with it rather than after it.

**What landed.** `showPositionPopup` now draws a 3×3 pad of fielder positions (each key its
digit plus `P`/`C`/`1B`… from `FIELDING_POS`), a **⌫ Back**, a **Type it**, and **Cancel** /
**DONE**. The pad writes into `#pos-input`, which is still what Enter and Done read — one
source of truth, so all 380 existing cases keep driving the same boundary. Dashes are supplied
by the pad (`posPadTap` inserts one after a digit), capped at `POS_MAX` = 7 = four fielders,
since `maxlength` doesn't apply to a value set from script. Restyled from `#333` to the
card/navy of `base-picker` and `k-popup`.

**The field is `readonly`, not hidden.** That is what keeps the keyboard down — iOS raises
nothing for a readonly field — while still taking focus and keydown, so the Magic Keyboard
path is unchanged: `1`–`9` reach the pad, `Backspace` deletes, a typed `-` is a no-op because
the pad already put one there, `Enter` confirms, `Escape` cancels. **Type it** clears
`readonly`, switches `inputmode` back to `text` (a numeric keyboard would be the wrong one for
the only case that wants a keyboard) and keeps what the pad built with the caret at the end —
that is the way in for `6/4-3` and `3U`. A reopen hands back the keypad.

**Verified.** 9 new cases (**389 green**, from 380): the pad's `6-3` / `F7` / `DP 6-4-3` reach
`applyPlay` with the code the text path produced, Back drops the digit and its dash, the fifth
fielder is ignored, hardware digits and the no-op dash, Cancel writes nothing, Done on an empty
field is refused with the message, and Type it round-trips `E6/4-3` before the next entry gets
the pad back. Browser at 1024×768: two taps give `6-3`, `readOnly` is true and the field is
focused, the popup is 355×348 with the deck fully visible, and Cancel leaves the cell empty.

**Symptom.** GO / FO / PO / LO / DP / TP / FC / E all open a text field. On iPad that
raises the full **alphabetic** keyboard over the entire play deck, to type two digits and a
dash. For the most common out in baseball.

**Root cause.** app.js:5151 — `<input id="pos-input" type="text" maxlength="7" …>`. No
`inputmode`. The popup is also styled `#333` — the only dark popup in an otherwise
white/navy set — and has no Cancel or Done, only "Enter to confirm".

**Fix, two stages.**

1. **Cheap, do it with F2.** Add `inputmode="numeric"` (keep `type="text"` — the value can
   contain `-`, and `type="number"` would reject it), and add visible **Done** and
   **Cancel** buttons so the popup is completable and escapable without a hardware Return.
   Restyle to the app's card/navy to match `base-picker` and `k-popup`.
2. **The real fix.** Replace the field with a 3×3 keypad of fielder positions 1–9 —
   tap-tap for `6-3`, with a backspace and the typed value echoed. Two taps, no keyboard,
   no scrolling. Keep the text field behind a "type it" affordance for the odd `E6/4-3`
   case, and keep the hardware-keyboard path working for the Magic Keyboard setup.

**Verify.** Test that a keypad tap sequence produces the same `normalizePlayCode` input the
text path produced, so every existing groundout/DP test stays valid. Browser: confirm no
keyboard appears and the deck stays visible.

---

### F11 — Advance Runners: no defaults, no cancel, silent refusal  ← ruled 2026-08-03

**Done.** One thing the build turned up that the finding did not: a pre-selected force also
*blocks*, because the collision check reads every choice that is set. With men on 1st and 2nd
the lead runner's own base came up greyed out — the trailing runner's *default* was already
pointing at it — so "he held at 2nd" could only be entered by changing the other man first.
A row that has not been tapped is therefore left out of the collision check, and a default the
scorer invalidates by answering another row is dropped rather than left standing behind a
greyed-out button. Confirm validates the real set, defaults included.

**Adam on F11c:** the middle path — pre-select only when *every* runner is forced, so no
judgement is ever pre-recorded. Any unforced runner and the popup reverts to always-ask with
nothing selected. F11a and F11b go in as written.

**Symptom.** The most frequent popup in the app. On a routine single with a man on first
it is three taps (runner, batter, Confirm) plus the spray prompt. Nothing is pre-selected —
every enabled button renders plain white. Confirm with nothing chosen only outlines the
unanswered row in accent for 800ms and says nothing. There is no Cancel and Escape does
nothing, so a wrong play button means completing a wrong entry and then undoing it —
`ab.play` is already committed before the popup opens.

**Root cause.** `showRunnerPopup` (app.js:2596) sets `defaultDest: undefined` under an
explicit *"// Never skip — always ask"*. The refusal is `flashRow()` (app.js:2741) with no
`showPlayReject`. Contrast the DP/FC `outcome-popup`, which **does** pre-select sensible
defaults (Hold 2nd / Out at 2nd / Out) and uses the app's navy chrome — the inconsistency
between two popups doing the same job is the sharpest part of this finding.

**Three separable changes.** The first two I'd just do; the third is the ruling:

- **F11a (no decision needed).** Give the empty-Confirm refusal a sentence —
  `showPlayReject('Pick a base for every runner.')` alongside the flash. The collision case
  two lines below already speaks; this one should too.
- **F11b (no decision needed).** Restyle to match `outcome-popup` — navy Confirm, card
  background — and make the *chosen* state unmistakable. Add a **Cancel** that rolls the
  play back (it needs to undo the committed `ab.play` and its result pitch, which is what
  `takeBackPlay` already does for `clearPlayKeepPitches`).
- **F11c — the ruling.** Pre-select the standard advance (forced runners to their forced
  base, batter to his), so a routine play is *one* tap on Confirm and you only touch a
  runner to override. That directly contradicts "never skip — always ask", which exists so
  the card never records a guess. Your call: **speed** (defaults, one tap) or **certainty**
  (keep always-ask). If you want a middle path, defaults only when every runner is *forced*
  — no judgement involved — and always-ask otherwise.

---

### F12 — the spray prompt fires on every hit  ← ruled 2026-08-03: **leave it**

**Adam:** no preference, no change to when it fires. Only the two things the finding says to
fix regardless — label the field diagram (LF/CF/RF/infield) and stop the popup covering the
row of the batter just recorded.

**Symptom.** "Where was it hit?" opens automatically after every hit and every error, with
Skip as the only dismissal. Scoring pitch-by-pitch live that is one extra modal per hit —
and on a hit with runners on it is the *second* modal in a row, after Advance Runners.

**Root cause.** By design: `applyPlay` calls `showSprayChart` for any hit or error. It is
deliberately kept out of `PENDING_ENTRY_POPUPS` because it opens on the commonest path and
all it writes is `hitLoc`.

**Fix, once you've ruled.** Add a persisted preference (Details panel or the More menu):
*Ask for hit location — always / never*. When off, `showSprayChart` returns early and
locations are added after the fact via the Fix group's **Spray** button, which already
exists (`editSprayChart`). Default to the current behaviour so nothing changes for you
unless you turn it off.

**Ruling needed:** do you want the prompt on every hit, off by default, or a third
behaviour (e.g. only for extra-base hits)? Worth knowing whether you actually use the spray
chart during a live game or fill it in afterwards.

Two small things to fix regardless: the field diagram is unlabelled (no LF/CF/RF/infield
hints), and the popup covers the row of the batter you just recorded.

---

## Tier 4 — polish (one pass, one commit each or all together)

### F13 — jersey numbers clip at 1024px — **done**

**Done, and neither of the fixes this finding suggested is the right one.** The padding was
the clip: the input is centre-aligned with `padding: 6px 6px`, so 12 of the column's 24px went
on padding a centred number doesn't need, leaving 11px for ~16px of digits. One rule in
`styles.css` gives the digits the cell — nothing is taken from `AVG`, `POS` or the at-bat
columns, and no font shrinks.

**Widening the column would not have worked.** `.scoring-grid` is `table-layout: fixed` and
already over-constrained at ≤1100px — declared widths are scaled to fit, so a wider `width`
on `td.num-cell` changes nothing there (measured: 30px declared renders 24px at 1024px, 19px
at 834px, and declaring 38px moved neither). The lever that works is content width.

`AVG` had the same clip from the same rule and is fixed with it: `.333` was 38px in a 35px box.
A five-character `1.000` still overflows in portrait (36 in 29) — a font step doesn't rescue
that one either (33 in 29), and it is only on the card until the first out, so it stays.

**Verified** at 1280 / 1024 / 834 / 560: no rendered `#` or `AVG` value is clipped at any of
them, and the fixture's numbers read `12 3 27 44 1 18 9 21 30` where they read `1: 2: 4: 2: 3(`
before. The pitcher grid's own `#` was measured too — 33px box, 33px content, already fine.

**Measurement gotcha:** an input's `scrollWidth` sits 1px above its `clientWidth` even with an
8px font and zero padding, so `scrollWidth > clientWidth` is only real clipping at ≥2px.

**The finding as filed.** `input[data-field="num"]` measures 23px wide against a `scrollWidth`
of 28 — every 2-digit number is cut mid-glyph on a 10.2"/10.9" iPad. Widen the `#` column at
`≤1100px`, or shrink the number's font a step. Note 1024×768 is also right at the fit limit
(`--cell-h` at its 44px floor), so take the pixels from `AVG` or `POS`, not from the at-bat
columns.

### F14 — win-probability chart never re-themed — **done**

**Worse than filed: the curve was invisible too, not just the labels.** It is stroked
`var(--gold)`, and this theme defines `--gold: var(--rb-white)` — #ffffff — because
everywhere else in the app that token is ink *on* the navy ground. Over the plot's own
`rgba(0,0,0,0.2)` wash that put the line at **1.6:1**. So the chart had no readable content
at all, captions or curve. Every colour now comes from the palette: `--cream` ground,
`--navy` curve and upper band, `--accent` lower band, `--text-light` axes. Measured on the
fixture at 1194×834: worst label **5.07:1** (from ≈1.2), curve **10.8:1** on the ground and
**8.4:1** over its own bands, captions 10.8 and 5.6.

**Width comes from the container, not a scaled 560.** `width="100%"` + `preserveAspectRatio`
would have scaled a 560px drawing up 1.5× and thickened every stroke and glyph with it, so
`W` is `clamp(320, container.clientWidth, 900)` instead and the type stays at its drawn size.
Verified 834px in the 834px panel (the ~270px dead strip is gone) and 336 in a 390px phone
column with no overflow. `container.clientWidth` is 0 in jsdom and in a closed modal, so it
falls back to 560; `showGameSummary` renders after `classList.add('active')`, which is what
makes the measurement real.

**Two things the finding did not mention.** The `N inn.` caption is right-anchored on the
same baseline as the tick numbers — clear at a fixed 560, a collision at 336 — so a tick
inside the caption's width now keeps its gridline and gives up its number. And the team
names went into the SVG **unescaped**; they are hand-typed, so both are through
`escapeHtml` now. The upper and lower bands are also named (`Rangers win% (est.)` /
`Astros ahead`), since navy-above / red-below is the one thing a reader has to be told. The
bands themselves are only ~1.27:1 against the ground, which is fine — they are tints, and
the curve and the 50% rule carry the reading. 6 new tests, **395 green**.

**The finding as filed.** Axis labels are `rgba(255,255,255,0.45)` (y) and `0.35` (x) at 9px over a
`rgba(0,0,0,0.2)` plot ground — **≈1.2:1**, invisible; they were styled for the old dark
skin. The gold "Rangers win% (est.)" caption is the same story. Also `viewBox="0 0 560 160"`
is fixed, so it renders 560px inside an 834px panel with ~270px dead to the right.
Fix in `renderWinProbSVG` (app.js:7218): navy/`--text-light` labels against the light
ground, and make the width fluid (`width="100%"` +
`preserveAspectRatio="xMidYMid meet"`, or compute the viewBox from the container).

### F15 — "PO" collision and "CLR All" mislabel
**PO** means *pop out* in the core deck and *pickoff* in the Runners group, both visible at
once (index.html:161 and 197). Rename the pickoff one to **PK** — the `o` hotkey and the
`promptPickoff` action stay as they are. And **CLR All** (`clearSelectedCell`, app.js:4449)
clears only the *selected cell*, not the card; next to "CLR Play" and in accent red it reads
like a full wipe. Rename to **Clear Cell** / **Clear Play**.

### F16 — zero prints blank in one linescore and `0` in the other
The main linescore leaves E and LOB blank at 0 (`updateLinescoreErrors` app.js:2842 writes
`''`; `writeTeamLOB` app.js:1033), while the Game Summary's own linescore prints `0`. Pick
one — printing `0` matches a paper scorecard and is what the summary already does. Note the
per-inning cells are correctly blank until played (that is F1's job) — this is only about
the R/H/E/LOB totals.

### F17 — hotkey help is unreachable without a keyboard
The hotkey modal (46 rows, 8 sections, including "Buttons with no hotkey") is the app's only
documentation and opens **only** on `?` or `/` (app.js:7307). On an iPad with no hardware
keyboard there is no way in. Add **Shortcuts** to the More menu (index.html:82) — it is
genuinely useful with a Magic Keyboard, which is a common iPad setup.

### F18 — Details doesn't prefill today's date
A new card opens with an empty Date. Prefill `createEmptyState()` with today in the format
the field expects, and leave it editable for scoring a card after the fact.

---

## Tier 5 — feature

### F19 — lineup entry is 54 taps  ← **needs a ruling**
Two lineups is 18 numbers, 18 names and 18 position selects before first pitch, every game,
with no reuse — and it is the one part of the app you do under time pressure at the park.
Options, cheapest first: (a) save/load a **roster** per team name in `localStorage` and offer
it when the team name matches; (b) "copy lineup from a saved game" in the Game Library;
(c) paste a block of `12 Altuve 2B` lines and parse it. (a) is probably the best
value-for-effort and reuses the library storage that already exists. Only worth building if
you score the same teams repeatedly — tell me if you do.

---

## Things that are working — don't "fix" these while nearby

Auto-BB at four balls. The auto-K popup at three strikes. The automatic half-inning
transition *with* the tab switch. The 10th inning opening by itself on a tie after 9. Rule
5.08(a) explained in words with Home greyed out. The Earned Run Review naming the runner and
pre-selecting Unearned. SH and SF correctly not charged an at-bat. W/L/SV computed correctly.
The FINAL readout. The backup banner. Every destructive path behind a `confirm()`. The
Select Pitcher popup's Cancel. And the one-page fit itself: 10 innings + a sub row + the
58px FINAL banner all fit at 1194×834 with zero scroll, `--cell-h` dropping 56→48px to
absorb it.
