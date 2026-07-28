# Scorecard PWA — Correctness Fix Plan

Follows the correctness audit of 2026-07-28 (34 findings). Grounded against
current code at `f7ff87d`. **Appendix A** is a self-contained index of every
finding, so this document stands alone — phases below refer to findings by number.

**Decisions confirmed by Adam, 2026-07-28** (see *Decisions* below).

> ## ▶ Phases 1, 2, 3 and 4 — all ✅ **done**
> Test harness, then every result-changing bug fixed surgically, then the
> `recordOut` chokepoint, then the runner-placement chokepoint. **Stopped here for
> review.** Phases 5–10 are planned but **not** authorised yet.
> Suite: **81 passing, 0 known failures** (`npm test`).

**How this is ordered.** The 34 findings collapse into 9 root causes. Fixing
causes retires whole families at once — but three of the six result-changing bugs
are one-line guards, and this app gets used at live games. So Phase 2 ships
surgical guards now, and Phases 3–7 replace those guards with structural fixes
later. That overlap is deliberate, not duplicated work: Phase 2 buys safety
immediately, Phases 3+ make the bug class impossible.

Each phase is independently shippable. `.githooks/pre-commit` auto-bumps
`SHELL_VERSION` in `sw.js` on any asset change, so no manual cache bump is needed.
There is no build step.

---

## Root causes

| # | Root cause | Findings |
|---|---|---|
| RC-A | Popups resolve `selectedCell` at **confirm** time, not open time | 1, 29 |
| RC-B | No chokepoint for recording an out — 8 sites do `inn.outs++` with inconsistent guards and `outsRecorded` bookkeeping | 2, 7, 8, 10, 21 |
| RC-C | No occupancy check when placing a runner on a base | 4, 16 |
| RC-D | Runner events (SB/CS/PO/WP/PB/BK) are a parallel path that skips `finishPlay`'s post-processing | 3, 5, 13, 20 |
| RC-E | `inn.bases` stores a bare player index, so a batter's two PAs in one inning are indistinguishable | 9, 19, 30 |
| RC-F | Derived state is patched per play, never recomputed from the at-bat records | 16, 21, 22, 23 |
| RC-G | Play codes are free-form strings matched by a regex pile | 15 |
| RC-H | Failure paths swallow silently | 25, 28 |
| RC-I | Orphaned DOM ids and dead state left by removed features | 31, 32, 33 |

Findings 11, 12, 14, 17, 18, 26, 27, 34 are standalone → Phases 8–9.

---

## Decisions

| Question | Decision | Phase |
|---|---|---|
| Execution scope | **Phases 1 + 2 this pass**, then review | — |
| DP entered with 2 outs (#7) | **Reject the entry** — the inning ends on the first out, so a DP is not legal at 2 outs. Brief toast, don't silently record. | 2 |
| SF/SH with nobody on base (#17) | **Charge an AB** when no run scored — it's an ordinary flyout. | 8 |
| ER model (#11, #13, #14) | **Keep** the provisional + manual-review model. The fix is that *every* error-ish path must set `reachedOnError` and flag the inning, so the review badge actually appears. No inning-reconstruction engine. | 8 |
| Undo history across reloads | **Leave memory-only.** | — |
| Play-by-play log (#31) | **Delete the feature** — `generatePlayDescription`, `addPlayLogEntry`, `rebuildPlayLog`, `refreshPlayLogDisplay`, `gameState.log`. Removes the log-reordering bug for free. | 9 |
| `overflowAtBats` (#30) | **Delete it**, along with the other confirmed-dead state (#33). Phase 7 makes the `columnMap` design correct, which is what it was working around. | 7 |
| Pitcher W/L/SV (#18) | **Implement it properly** — real Rule 9.17/9.19 logic off a chronological run timeline, not the current heuristic. Full design in Phase 8b. Depends on Phase 3. | 8b |

---

## Phase 1 — Test harness (prerequisite) ✅ **done**

Everything below needs a way to assert behaviour without hand-playing a game on
an iPad. `tests.html` already worked and passed **16/16**; it just couldn't run
from the CLI.

**Shipped**
- `package.json` — declares `jsdom` 30.0.0 as a devDependency (it was installed
  but undeclared, and `node_modules/` is gitignored, so a fresh clone couldn't run
  anything) plus `npm test`.
- `run-tests.js` — runs both suites in jsdom, prints every assertion, exits
  non-zero on failure. `-q` prints failures only (what the hook uses). app.js is
  **inlined** in place of its `<script src>` rather than fetched, so parse order
  matches the browser *and* app.js + suite share one script realm — the only way
  to reach app.js's top-level `let gameState` / `let selectedCell`.
- `tests-scoring.js` — the flow suite, run against the **full `index.html` DOM**.
  Cases drive `selectCell` + `applyPlay` + popup confirm buttons + `keydown`, the
  same entry points the UI uses. This is where every later phase adds its
  regression assertions. **A `.js` file rather than the planned
  `tests-scoring.html`:** the runner boots the real `index.html`, so a second
  page would have had to duplicate that markup (and, opened in a browser over
  http, would write test games into the app's own localStorage). `tests.html`
  stays browser-openable; the flow suite is CLI-only.
- `.githooks/pre-commit` — runs the suite before the cache bump and aborts the
  commit on failure. Gated on staged changes to `index.html`, `app.js`, the
  suites or the runner; `SKIP_TESTS=1 git commit …` overrides (a live game is not
  the moment to argue with a hook).

**Known-failure (xfail) convention.** A case for a finding that is not fixed yet
asserts the **correct** behaviour and is marked `xfail('#n', …)`. It reports as a
known failure and does not break the build. When the fixing phase lands the case
starts passing and the runner **fails** with "promote it: drop the xfail marker".
So Phase 2's test work is mostly deleting markers, and no fix can land silently
un-asserted. At the end of Phase 1: **30 passing, 13 known failures** (#1, #2 ×2,
#3, #4, #5, #6, #7, #8, #15 ×2, #26, #27 — the Phase 2 list). All 13 were promoted
in Phase 2; the `xfail` helper stays for Phase 3+.

**Performance.** Two things mattered, both handled in the suite rather than in
app code:
- Reset mutates `gameState` in place and re-renders only the columns a case
  touched. A full `applyState()` per case is what made the audit harness take
  ~10 minutes.
- jsdom has no selector index, so a document-level attribute query walks ~15k
  nodes (~6ms); app.js issues 60+ per recorded play, mostly writing the pitcher
  table. The suite memoises **only** selectors whose matched element set is fixed
  after boot (grid / pitcher / linescore tables) and lets changing ones like
  `td.ls-active` through. 102s → **6.5s** for the whole run, with identical
  results.

**Size:** one sitting. **Risk:** none — additive, no app code touched.

---

## Phase 2 — Result-changing bugs, surgically ✅ **done**

Closes everything that makes the scorecard say the wrong thing about the game.
Guards and target-capture only — no refactoring, safe to ship mid-season.

| # | Fix | Where |
|---|---|---|
| 1 | Capture `{team, pIdx, innIdx}` when the popup **opens**; apply to the captured cell, not `selectedCell`. Add a click-blocking backdrop to both popups so selection can't change underneath. | `showStrikeoutPopup` app.js:1410, `showPositionPopup` app.js:2692 |
| 2 | Add the `if (inn.outs >= 3) return;` guard that `applyRunnerEvent` (app.js:1721) already has | `applyCSAtBase` app.js:1601, `applyPickoff` app.js:1649 |
| 3 | Same guard | `applySBAtBase` app.js:1564 |
| 5 | Extract the game-over/walk-off check from `finishPlay` (app.js:1005-1028) into `checkGameOver(team, innIdx)`; call it from the CS and PO 3rd-out branches | app.js:1618, app.js:1675 |
| 6 | If the target column ≥ `visibleInnings`, raise `visibleInnings` and call `updateInningVisibility()` before selecting | `selectNextBatterForInning` app.js:1288 |
| 7 | Reject the entry when `inn.outs >= 2`; clear the pitch `applyPlay` already pushed | app.js:658 |
| 8 | Guard the `inn.outs++` | app.js:1943 |
| 4 | Minimal version: occupancy check that **refuses** the move and flashes the popup row instead of overwriting. Proper fix in Phase 4. | app.js:602, 671, 710, 935 |
| 15 | Normalize at the input boundary — strip a leading `GO `/`FO `/`LO `/`PO ` prefix so only canonical codes (`6-3`, `F7`, `P4`, `L9`) reach state. Also widen `isOutPlay` to accept the prefixed forms, for games already saved with them. | `isOutPlay` app.js:492, app.js:1907, app.js:2712 |
| 26 | Add the outs guard to `addPitch` | app.js:1310 |
| 27 | Pop the pitch on the reject path | app.js:641 |

**Tests:** already written in `tests-scoring.js` as xfails — 4 outs via CS and via
PO; SB-after-3-outs leaves R empty; K lands on the batter with 3 strikes after the
selection moves; the held runner isn't erased (#4); game over on a CS 3rd out;
tied 9th selects a visible cell; DP at 2 outs is rejected; edit-play caps at 3;
`isOutPlay('GO 6-3')` and a prefixed groundout records an out; no pitches after
3 outs; the rejected TP leaves no pitch. Each fix flips its case to passing —
then drop the `xfail` marker so it guards the fix from then on.

**Size:** one to two sittings. **Risk:** low; each change is local and guarded.

### Shipped

All 13 xfails promoted to enforced tests. **47 passing, 0 known failures.**

New shared helpers in `app.js`: `currentTarget()` (popup target capture),
`baseFreeFor()` (#4 occupancy predicate), `normalizePlayCode()` (#15),
`checkGameOver()` (#5), `showPlayReject()` (a brief toast) and
`showPopupBackdrop()`/`hidePopupBackdrop()`.

Notes where the implementation differs from the outline above:

- **#1 was an `applyPlay` signature change,** not just a popup change:
  `applyPlay(play, target)`. Popups pass the `{team, pIdx, innIdx}` they captured
  on open; every other caller omits it and falls back to the selection, so no
  existing call site changed behaviour. `checkAutoTrigger` now passes the batter
  explicitly for the auto-BB too. The strikeout popup's button handlers moved out
  of its create-once block — they have to rebind per open to see the fresh capture.
- **#4's real fix is validation in the runner popup's Confirm handler.** It refuses
  a set of destinations that would put two men on one base, flashes the offending
  rows and keeps the popup open (reusing the existing unselected-row flash), so the
  refusal is recoverable. The four low-level sites (602, `placeBatter`,
  `applyChosenAdvancements`, `applyRunnerOutcomes`) got `baseFreeFor` guards as a
  backstop for imported or hand-edited state; they now decline to overwrite rather
  than erasing the runner already on the base. `showRunnerPopup` took an `opts`
  argument (`batterTakesBase`, `batterPIdx`) — the batter only counts toward a
  collision when he actually ends up on a base, so a sacrifice behind a held runner
  is still legal.
- **#7 and #27 became entry rejects,** checked before the at-bat is touched, rather
  than popping a pitch back off afterwards. Same observable result, one less way to
  leave a half-written at-bat. The old late TP runner-count check is gone.
- **#8 rejects the whole play change** instead of just skipping the `inn.outs++`.
  Skipping the increment alone would have left a second at-bat stamped `out = 3`.
  The guard runs before `pushUndo`, and the popup stays open.
- **#2/#3 guard the `apply*` functions only, not the `prompt*` pickers.** The
  pickoff case asserts the base picker still opens and the *apply* refuses, so
  guarding the prompt would have broken the authored contract.
- **Backdrop** covers `k-popup` and `pos-popup` at `z-index:180` (both popups sit
  at 200/300). Verified in a real browser: `elementFromPoint` over a grid cell
  returns the backdrop while the popup's own buttons and text input stay topmost
  and focusable. It self-dismisses if clicked when neither popup is open, so a
  stray state can't leave the card unclickable.

Three tests were added beyond the promoted 13, all guarding against over-reach —
a legal advance, a sacrifice behind a held runner, and re-answering the popup after
a refusal — plus one for the #15 input-boundary normalisation, which the promoted
cases only covered via `isOutPlay`.

**Deferred, found while fixing #7:** a **triple play entered with 1 or 2 outs**
has the same shape as #7 — `applyRunnerOutcomes` caps at 3 outs, so the extra outs
are silently dropped and the card under-reports. Not fixed here because only DP was
authorised in *Decisions*. One line next to the #7 reject, or free with Phase 3's
`recordOut`. → **closed in Phase 3.**

---

## Phase 3 — One way to record an out ✅ **done**

Retires RC-B, so the Phase 2 guards stop being load-bearing.

- Add `recordOut(team, innIdx, { kind, pIdx, col })`, `kind` = `'batter' | 'runner'`.
  Refuses at 3 outs, increments `inn.outs`, stamps the out number, appends to a new
  **`inn.outsLog`**: `[{ n, kind, pIdx, col, pitcher }]`.
- Replace all `inn.outs++` sites: app.js:607, 609, 611, 635, 637, 659, 664, 666,
  697, 921, 953, 1610, 1667, 1757, 1943.
- Rewrite pitcher-out attribution to **count `outsLog` entries**, deleting the
  `outsRecorded`/`outOnBase` heuristic at app.js:2831-2837 and its duplicate at
  app.js:2863-2868. This is what makes #10 structurally impossible rather than patched.
- Replace `markNextInningLeadoff`'s search for `out === 3` (app.js:1271) with
  `inn.lastPA = { pIdx, col }`, updated in `finishPlay`. The rule is "the batter
  after the last completed plate appearance" — correct for a DP, a CS-ending
  inning, and a PO-ending inning, all three of which the current search gets wrong.
- Also stamp `ab.seq` from a new `gameState.playSeq` counter here — Phase 8b needs
  chronological ordering and Phase 6 benefits from it.

**Closes:** 2, 7, 8, 10, 21 (out-count half).
**Migration:** backfill `outsLog`/`lastPA`/`seq` in `mergeStateDefaults` from
existing `out`/`outsRecorded` fields, or accept degraded IP for pre-existing games
and say so in the UI.
**Tests:** IP is exactly 0.1 for a CS out, a PO out, and a runner thrown out
advancing on a single; a DP charges exactly 2 outs and 0.2 IP; leadoff correct
after a DP-ending and a CS-ending inning.
**Size:** half a day. **Risk:** medium — touches every out path.

### Shipped

**64 passing, 0 known failures.** 17 new cases, no xfails — every finding this
phase closes was already asserted or is asserted now.

New in `app.js`: `recordOut()` (the chokepoint), `recordBatterOut()` (the
batter-out shorthand the old inline `inn.outs++; ab.out = …; ab.outsRecorded = 1`
became), `inningOutsLog()`, `outsFromPlay()`, `removeOutsFromPlay()`,
`renumberOuts()` and `backfillOutsLog()`. New state: `inn.outsLog`, `inn.lastPA`,
`ab.seq`, `gameState.playSeq`. **Every `inn.outs` mutation in the file is now
inside `recordOut` or `removeOutsFromPlay`** — grep `\.outs++` to confirm.

Notes where the implementation differs from the outline above:

- **Log entries carry `srcP`/`srcCol` as well as `pIdx`/`col`.** `pIdx`/`col` is the
  at-bat cell the out is *shown* on (the runner's own cell for a base out);
  `srcP`/`srcCol` is the cell whose play *caused* it. That second pair is what
  closes #21: clearing a double play now removes both of its outs, where the old
  code subtracted `ab.outsRecorded` and left the doubled-off runner recorded as
  out. `applyChosenAdvancements` took a 5th `src` argument so a runner thrown out
  advancing is attributed to the batter's PA.
- **`outsLog` is not copied forward into batting-around columns.** `inn.outs` still
  is (that's the 3-out ceiling), but each column logs only the outs made while it
  was the active one, and `inningOutsLog()` concatenates the columns of a real
  inning. Copying it forward the way `outs` is copied would have double-counted
  every pre-overflow out. A test bats around with one out already recorded and
  asserts IP reads exactly `1`.
- **`markNextInningLeadoff` keeps the old `out === 3` search as a fallback.**
  `lastPA` can't be backfilled reliably from a pre-Phase-3 save (the batting order
  can wrap inside a single column, so "highest position with a play" isn't the last
  PA), so an old game keeps its old — sometimes wrong — leadoff rather than losing
  the order entirely. New games never hit the fallback.
- **The ad-hoc `nextLeadoff` writes in `applyCSAtBase`/`applyPickoff` are gone,**
  along with the "don't overwrite if already set" guard in `markNextInningLeadoff`
  that existed to protect them. `lastPA` gets all three cases right on its own.
- **`rab.pitcher = getEffectivePitcher(…)` is deleted from both the CS and PO
  paths.** Those lines existed to make IP work under the old scheme, and they
  moved the runner's *hit and run* onto whoever happened to be on the mound for the
  steal attempt. The out's pitcher now lives in the log entry, so `rab.pitcher`
  goes back to meaning "the pitcher this batter faced." Asserted.
- **`updatePitcherStats` was missing from three callers** — `applyCSAtBase`,
  `applyPickoff`, `applyRunnerEvent`. #10 was two bugs: IP wasn't counted *and*
  wasn't recomputed after a runner event even if it had been.
- **Removing an out renumbers the survivors,** log entries and the visible out
  badges both. Clearing the 2nd out of an inning used to leave the card reading
  "1" and "3" for two outs.
- **The deferred triple-play case from Phase 2 is closed here** (the plan called it
  "free with Phase 3's `recordOut`" — it isn't quite free, since `recordOut`
  *refuses* the overflow outs rather than dropping them silently, which still
  under-reports). A TP entered with an out already recorded is now rejected at
  entry, exactly like the #7 DP reject.
- **A DP entered with nobody on base** now records its second out as a log entry
  with `pIdx: null` and stamps `dpOuts`, instead of `inn.outs = Math.min(inn.outs +
  2, 3)`. Still a nonsense entry; at least the out count and IP are right.

**Known limitation, deferred to Phase 6.** After batting around, recording or
clearing an out in the *earlier* column of the inning updates that column's count
and log, not the active column's. `inn.outs` has always diverged this way, so this
is not a regression — but `recomputeInning()` is what actually fixes it.

---

## Phase 4 — One way to move a runner ✅ **done**

- Add `setRunnerOn(inn, base, runner)` / `clearRunner(inn, base)`; assert the
  target base is empty or holds the same runner, log loudly instead of overwriting.
- Route app.js:602, 671-674, 710, 935 through it.
- Constrain the popups so the illegal choice isn't offered: a trailing runner can't
  be sent past a lead runner who's holding, and a runner can't hold on the base the
  batter must occupy. `showRunnerPopup` app.js:1035, `showRunnerOutcomePopup` app.js:788.

**Closes:** 4 properly. **Size:** one sitting. **Risk:** low-medium — don't
over-restrict legal odd plays.

### Shipped

**81 passing, 0 known failures.** 17 new cases.

New in `app.js`: `setRunnerOn()`, `clearRunner()`, `moveRunnerTo()`,
`removeRunnerFromBases()`, `runnerPathClear()`, `runnerOrderConflicts()`,
`runnerOrderMessage()`, `reportRunnerCollision()`, `setOptionBlocked()` /
`isOptionBlocked()`. **Every `inn.bases` write in the file is now inside
`setRunnerOn`, `clearRunner` or `moveRunnerTo`** — grep `inn\.bases\[.*\] *=` to
confirm; the only hits are the three definitions. A refused placement logs a
`console.warn` naming both runners *and* shows the toast, so it can't pass
unnoticed either live or in a log.

Notes where the implementation differs from the outline above:

- **`moveRunnerTo` is the third helper the outline didn't ask for,** and it's the one
  most sites use. Checking occupancy, clearing the old base and setting the new one
  have to be one step: split apart, a refused destination left the runner cleared off
  his base, which is the very bug being fixed. Callers mark up the at-bat only on a
  `true` return, so a refusal leaves no half-written advancement.
- **The popups constrain by *runner order*, not by occupancy.** One rule covers both
  cases the plan lists: everyone still on a base after the play must finish in the
  same order they started (the batter starting from behind 1st), with home exempt
  since any number of runners can score. `runnerOrderConflicts` returns the offending
  rows, and it drives two things — greying out an option the moment another row makes
  it illegal, and a final check on Confirm for the rows left on their defaults.
- **`showRunnerOutcomePopup` (DP/FC/TP) had no Confirm-time validation at all;** a
  collision was swallowed by `applyRunnerOutcomes`'s early `return`. It now gets the
  same greying-out and the same refusal as the advancement popup.
- **The base pickers filter their own options.** SB/PO no longer offer a steal or an
  error-advance whose destination is occupied, and `runnerPathClear` also rejects one
  that would run *through* an occupied base (1st→3rd past a runner on 2nd, 2nd→home
  past a runner on 3rd). With runners on 1st and 2nd a double steal is now entered as
  two events, lead runner first — which is the order it happens in.
- **`applyRunnerEvent('SB')` was inventing runs.** With 3rd occupied it sent the
  runner from 2nd *all the way home* rather than colliding — a run out of a steal that
  never happened. It refuses the move now. (That path isn't wired to a button today;
  only WP/PB/BK are. Left in place rather than deleted — dead code is Phase 9.)
- **K+WP no longer places the batter before the popup opens.** It used to write him
  onto 1st first, which erased the runner standing there *and* dropped that runner out
  of the popup's own list, so there was nothing left to advance. He's placed from the
  popup's batter row like every other batter who reaches, which also means the
  order check covers him.
- **`editPlayType` rejects a change with nowhere to put the batter** (a K rewritten as
  a single with 1st occupied), before `pushUndo`, same shape as the Phase 2 #8 guard.
  Changing a play to `HR` still doesn't advance the runners on base — that's #22, Phase 6.
- **`advanceRunners` and `advanceForcedRunners` became loops** over the bases,
  lead runner first, instead of three and then nine hand-written branches. Same
  outcomes for both call patterns (WP/PB/BK at 1, HR at 4) — the new cases assert a
  wild pitch, a bases-loaded walk, a 1st-and-3rd walk and a grand slam. Forced-runner
  logic is now stated once: a runner is forced only while every base behind him is
  occupied.
- **`moveRunner` (the manual override) stops offering an occupied base.** It's the
  escape hatch for odd states, but two men on one base is never one of them.
- **Verified in a real browser** as well as jsdom: a blocked option renders greyed at
  35% opacity, a real click on it does nothing, and blocking updates live as the other
  rows are answered.

---

## Phase 5 — Runner events go through `finishPlay` *(not yet authorised)*

- Extract the tail of `finishPlay` (app.js:975-1032) into
  `afterStateChange(team, innIdx, { endsHalfInning })`: run/linescore update, stat
  recompute, ER flags, game-over check, transition timer via the single
  `pendingTransitionTimer`, leadoff, `updateSituation`, `autoSave`.
- Call it from all four runner-event paths. Fixes the bare `setTimeout` at
  app.js:1767 that undo can't cancel, and makes every transition timer
  cancel-before-set.

**Closes:** 3, 5, 13 (plumbing), 20. **Size:** half a day. **Risk:** medium.

---

## Phase 6 — Recompute instead of patch *(not yet authorised)*

- Add `recomputeInning(team, realInn)`: rebuild `outs`, `bases`, runs, LOB and the
  linescore cell for every column of that real inning from the at-bat records alone.
  **Hinges on:** a runner's current base being derivable — the highest `i < 3` with
  `bases[i]` true, where `!bases[3] && outOnBase == null`. Verify this holds before
  committing to the phase; the plan fails loudly rather than quietly if not.
- Have `editPlayType` (1883), `clearSelectedCell` (2271), `clearPlayKeepPitches`
  (2067) and `restoreSnapshot` (1825) call it instead of patching; delete the
  partial-revert loop at 2313-2322 (whose `inn.outs = Math.max(0, inn.outs)` at
  2317 is a no-op).
- Fix `fillLinescoreZeros` (2378) to write state by real inning, not column index;
  drop the dead `realInn >= INNINGS` check.
- Settle LOB on one definition — end-of-half-inning from `inn.bases` — deleting the
  mid-inning at-bat scan at 2407-2424 and the unused `calculateLOB` (3246).
- `editPlayType` → `HR` must advance the runners on base, not just fill the batter's
  four bases (1959).

**Closes:** 16, 21, 22, 23. **Size:** multi-session — highest value, fiddliest.
**Risk:** medium-high. Do right after Phase 3; `outsLog` makes it verifiable.

---

## Phase 7 — Batting-around plate-appearance identity *(not yet authorised)*

Retires RC-E and `getRunnerCol` entirely.

- Change `inn.bases[b]` from a bare player index to `{ p, col }` — the base state
  then knows which *cell* the runner came from, so a batter's second PA in a
  batted-around inning is unambiguous.
- Delete `getRunnerCol` (416) and its ~20 call sites; read `.col` from the base entry.
- Widen the undo snapshot: `prevRunners` captures only `atBats[innIdx]` today
  (538, 1790). Snapshot every column of the real inning.
- Call `updateColumnHeaders` from `applyState` so real inning numbers survive a
  reload (#24 — reasoned from code, **not** reproduced; verify by hand).
- Delete `overflowAtBats` and its 11 read sites (101, 106, 1151, 1169, 2166, 2186,
  2416, 2787, 2855, 3089, 3584).

**Closes:** 9, 19, 24, 30.
**Migration:** old saves hold bare ints in `inn.bases`. Upgrade in
`mergeStateDefaults` (2519): `n → { p: n, col: <first PA column in that inning> }`
— today's `getRunnerCol` semantics, correct for every save that didn't bat around.
**Size:** multi-session. **Risk:** high. Last of the structural phases, with
Phases 1–6 tests green as the safety net.

---

## Phase 8 — Box-score rules *(not yet authorised)*

### 8a — Rule fixes (independent, can be pulled forward after Phase 1)

- **#12** No RBI on a force double play (Rule 9.04(b)) — app.js:653; no RBI on a run
  scored via wild pitch on K+WP — app.js:587.
- **#11** Set `reachedOnError` on the extra-base error path (599-605), currently
  skipped whenever `choices.batterDest > 0`.
- **#13** Set `reachedOnError` for SB+E (1576) and PO+E (1661); make
  `inningErProvisional` (2177) also treat an `'E'` advancement reason as a signal.
- **#14** Flag every runner a passed ball advances as unearned, not just the runner
  on 3rd (1726).
- **#17** Charge an AB for SF/SH when no run scored — `tallyAtBats` (2761).

**Size:** one to two sittings. **Risk:** low.

### 8b — Pitcher decisions (W/L/SV), real implementation

Replaces the heuristic in `findPitcherDecisions` (app.js:3626). **Depends on
Phase 3** for `ab.seq` (chronological ordering) and `outsLog` (the save rule's
⅓-inning test, and trustworthy IP once #10 is fixed).

**Step 1 — run timeline.** Add `runTimeline()`: for each run (an at-bat with all
four bases and `outOnBase == null`) emit
`{ seq, battingTeam, realInn, half, chargedPitcher: ab.pitcher, scoreAfter }`,
sorted by `(column, seq)`. `ab.pitcher` is already stamped as the pitcher who put
that runner on base, which is exactly Rule 9.16's charged pitcher — so no new
attribution logic is needed. Without `ab.seq` (old saves), fall back to
`(column, batting-order position)` ordering and mark the result approximate.

**Step 2 — lead for good.** Walk the timeline to find the last run after which the
winning team held a lead it never relinquished. That run is the go-ahead run.

**Step 3 — apply the rules.**
- **Win (9.17):** the winning team's pitcher of record at the go-ahead run. Derive
  via `getEffectivePitcher(losingTeam, col)` — that function returns the pitcher
  *facing* the batting team, so passing the losing team yields the winning team's
  pitcher.
- **Starter 5-inning rule (9.17(b)):** if the pitcher of record is the starter with
  < 5 IP in a game of 6+ innings, the win goes to the most effective reliever —
  explicitly scorer's judgment. **Don't guess:** compute the candidate set and
  surface a picker.
- **Loss (9.17(d)):** the pitcher charged with the go-ahead run — read
  `chargedPitcher` straight off that timeline entry.
- **Save (9.19):** the winning team's pitcher who finished the game, is not the
  winner, and is charged with ≥ ⅓ inning (≥ 1 `outsLog` entry), **and** one of:
  entered with a lead ≤ 3 and pitched ≥ 1 inning; entered with the potential tying
  run on base, at bat, or on deck; or pitched ≥ 3 innings. "Entered with" needs the
  score and base state at the pitching change — derivable from the change marker's
  column plus the timeline.
- **Holds / blown saves:** out of scope unless asked.

**Step 4 — override.** Persist `gameState.decisions = { wp, lp, sv }` when the user
overrides; the summary shows computed values unless overridden. Judgment clauses
(starter < 5 IP, ineffective short relief per 9.17(b)) prompt rather than guess.
Drop the "unofficial" labelling once this lands — but keep the win-probability
chart's "(est.)".

**Tests:** a lead taken and relinquished twice attributes W and L to the right
pitchers; a starter pulled at 4 IP triggers the picker instead of auto-crediting;
each of the three save conditions in isolation; a tie game yields no decisions.

**Size:** multi-session. **Risk:** medium — self-contained (summary only), but the
rules have real edge cases. Land after Phase 3.

---

## Phase 9 — Silent failures, escaping, dead code *(not yet authorised)*

- **#25** `loadState` (2543) discards a corrupt save and lets the next `autoSave`
  overwrite it. Instead: stash the raw string under `baseball-scorecard-corrupt`,
  show the existing storage banner with a "Download unreadable save" action, and do
  **not** auto-overwrite. Same for `getGameLibrary` (3313), where a parse failure
  currently reads as "no saved games yet". Do this one before a game.
- **#28** Run `mergeStateDefaults` in `loadGameFromLibrary` (3441), as
  `importGameJSON` (3502) already does.
- **#34** Escape names in the six remaining `innerHTML` sinks: 815, 1068, 1087,
  2021, 2931, 2978. Add `'` to `escapeHtml` (30).
- **#31** Delete the play-log feature (decided): `generatePlayDescription` (3140),
  `addPlayLogEntry` (3177), `refreshPlayLogDisplay` (3184), `rebuildPlayLog` (3223),
  `gameState.log`, and the `rebuildPlayLog()` calls in `restoreSnapshot`,
  `clearSelectedCell` and `recomputePitcherAssignments`.
- **#32** Delete the `#sit-lob` branch (1480) — no such element.
- **#33** Delete `standings`/`STANDINGS_ROWS` (39, 65 — still serialized every save),
  `ab.extraOuts` (2334), and the sub rows' unused `atBats` arrays.

**Size:** one sitting. **Risk:** low.

---

## Phase 10 — Accessibility + CSP *(not yet authorised)*

Carried unchanged from `PLAN.md` #6: `for`/`id` label pairing, `aria-label` on
at-bat cells, announce selected-cell state. The keyboard-shortcut guard that item
asked for already exists (app.js:3994). A strict CSP still requires converting
~100 inline `on*` handlers in `index.html` to `addEventListener` first.

---

## Sequencing

| Phase | Closes | Size | Risk | Status |
|---|---|---|---|---|
| 1 Test harness | — | 1 sitting | none | ✅ **done** |
| 2 Surgical result bugs | 1, 2, 3, 4†, 5, 6, 7, 8, 15, 26, 27 | 1–2 sittings | low | ✅ **done** |
| 3 `recordOut` chokepoint | 2, 7, 8, 10, 21† | half day | medium | ✅ **done** |
| 4 Runner placement chokepoint | 4 | 1 sitting | low-med | ✅ **done** |
| 5 Runner events via `finishPlay` | 3, 5, 13†, 20 | half day | medium | planned |
| 6 Recompute instead of patch | 16, 21, 22, 23 | multi-session | med-high | planned |
| 7 PA identity + delete dead state | 9, 19, 24, 30 | multi-session | high | planned |
| 8a Box-score rule fixes | 11, 12, 13, 14, 17 | 1–2 sittings | low | planned |
| 8b W/L/SV real implementation | 18 | multi-session | medium | planned (unblocked — Phase 3 shipped `ab.seq` + `outsLog`) |
| 9 Silent failures / escaping / dead code | 25, 28, 31, 32, 33, 34 | 1 sitting | low | planned |
| 10 a11y + CSP | — | — | low | planned |

† partially in that phase, completed later.

8a and 9 are independent of the structural work and can be pulled forward whenever
there's a spare sitting. 8b's dependency on Phase 3 is satisfied. Phase 7 goes last
of the structural phases.

---

# Appendix A — Findings index

From the 2026-07-28 audit. **Verified** = reproduced in a jsdom harness driving the
real `index.html`; **reasoned** = from code reading only. Severity: **GAME** = wrong
game result on the card · **STATS** = result OK, box score wrong · **STATE** =
corruption or data-loss risk · **DEAD** = orphaned code.

| # | Sev | Finding · repro | Where |
|---|---|---|---|
| 1 | GAME | Strikeout/position popup applies to whatever cell is selected at **confirm** time, not the batter who reached 3 strikes. *Repro: batter 1 gets S,S,S → popup opens → tap batter 5's cell → tap "K swinging". Batter 5 gets the K; batter 1 keeps 3 strikes and no play.* **Verified** | `showStrikeoutPopup` 1410, `showPositionPopup` 2692, `applyPlay` 524 |
| 2 | GAME | Outs can exceed 3 — CS/PO lack the `outs >= 3` guard `applyRunnerEvent` (1721) has, and an ended inning keeps its stranded runners. *Repro: single, 3 strikeouts, press `j` or `o` → `inn.outs === 4`.* **Verified** | `applyCSAtBase` 1610, `applyPickoff` 1667 |
| 3 | GAME | Stolen base after 3 outs adds a run to the linescore. *Repro: triple, 3 strikeouts, `r` → "SBH" → inning R becomes 1.* **Verified** | `applySBAtBase` 1564 |
| 4 | GAME | Two runners can occupy one base; the overwritten runner keeps his at-bat marks but is gone from `inn.bases` and can never score. *Repro: double; next batter doubles with the runner told to "Hold 2nd"; next batter homers → the 3-run homer scores 2.* **Verified** | 602, `placeBatter` 671, `applyChosenAdvancements` 710, `applyRunnerOutcomes` 935 |
| 5 | GAME | No game-over/walk-off check when the 3rd out is a CS or pickoff — those checks live only in `finishPlay`. *Repro: home leads 2-0, top of the 9th ends on a CS → no summary, app advances to the bottom of the 9th.* **Verified** | 1618, 1675; checks at 1005-1028 |
| 6 | GAME | After a tied 9th the app selects column 9, which is `hidden-inning` (`display:none`) until `+EI` is pressed; nothing auto-raises `visibleInnings`. *Repro: complete 9 tied innings → `selectedCell` is visiting p0 col9, hidden.* **Verified** | `selectNextBatterForInning` 1288, `updateInningVisibility` 3201, styles.css:544 |
| 7 | GAME | DP entered with 2 outs records **2** outs and sets `ab.out = 2`, so IP reads 1.1 for a 3-out inning and no at-bat carries `out === 3` — `markNextInningLeadoff` bails and the next inning starts at the top of the order. *Repro: 2 strikeouts, then DP.* **Verified** | 658; `markNextInningLeadoff` 1275 |
| 8 | GAME | "Change Play Type" can push the inning past 3 outs. *Repro: leadoff single, 3 strikeouts, change the single to K → `inn.outs === 4`, badge renders 4.* **Verified** | 1943 |
| 9 | GAME | In a batted-around inning a batter's **second** PA has its runner advancement written to his **first** at-bat cell — `getRunnerCol` returns the first column in the inning where the player has a play. *Repro: bat around, leadoff man reaches again and is driven in → col 0 shows the run, col 1 stays at 1st.* **Verified** | `getRunnerCol` 416 |
| 10 | STATS | Pitcher IP misses every out that isn't the batter's own. The `outOnBase && !outsRecorded` skip is valid for DP/TP (summed onto the batter at 964) but wrong for standalone base outs, which never set `outsRecorded`. *Repro: CS out, PO out, and runner thrown out at 3rd on a single — all three leave IP blank.* **Verified** | `updatePitcherStats` 2831-2837, dup 2863-2868; sites 1611, 1668, 697, 1757 |
| 11 | STATS | `reachedOnError` is never set when the batter takes an extra base on the error — the `batterDest > 0` branch skips `placeBatter`, the only setter. Run then counts as **earned** and the ER-review badge never appears. *Repro: E6 with a runner on, batter sent to 2nd → false; batter held at 1st → true.* **Verified** | 599-605; setter 672 |
| 12 | STATS | RBI credited on a force double play (Rule 9.04(b) says none) and on a run scored via wild pitch on K+WP. *Repro: runner on 3rd scores on `DP 6-4-3` → batter credited 1 RBI.* **Verified** | 653, 587 |
| 13 | STATS | SB+E and PO+E write `advReason = 'E'` but never set `reachedOnError`, and `inningErProvisional` doesn't look at advancement reasons — a runner who reaches on a throwing error and scores counts as earned with no review prompt. **reasoned** | 1576, 1661; `inningErProvisional` 2177 |
| 14 | STATS | Passed ball flags only the runner on 3rd as unearned; runners moved up from 1st/2nd score as earned runs later. (Rule 9.16: PB runs unearned, WP runs earned — the WP side is correct by doing nothing.) **reasoned** | `applyRunnerEvent` 1726 |
| 15 | STATS | `isOutPlay` rejects `GO 6-3`, `FO 8`, `LO 7`, `PO 3` — and `GO 6-3` is the first example in the Edit-Play placeholder. Such a play records no out, doesn't advance the inning, doesn't credit the pitcher, and is styled as an on-base play. Quick-buttons are fine (they emit `6-3`). **Verified** | `isOutPlay` 492, placeholder 1907, `renderPlayText` 332/366 |
| 16 | STATS | LOB has two conflicting definitions — `finishPlay` sets it from `inn.bases` at the 3rd out, then `updateLinescoreTotals` overwrites it with an at-bat scan across all columns including innings in progress, so it inflates mid-inning and counts #4's vanished runner. A third impl is dead. **reasoned** | 998 vs 2407-2424; `calculateLOB` 3246 |
| 17 | STATS | SF/SH never charge an at-bat, even with the bases empty — but a sac fly requires a run to score, else it's an ordinary flyout. *Repro: SF with bases empty → AB 0.* **Verified** | `tallyAtBats` 2761 |
| 18 | STATS | W/L/SV is a heuristic (most IP wins, most ER loses); with no ER recorded, `worstIdx` stays 0 so the losing team's row-1 pitcher always gets the L. Save test (`margin <= 3 \|\| IP >= 3`) isn't the save rule. Presented as fact in the summary. **reasoned** | `findPitcherDecisions` 3626, 3662 |
| 19 | STATE | Undo snapshots only `atBats[innIdx]`; combined with #9, a play in a batted-around inning mutates a different column that undo won't restore. **reasoned** | 538, `pushUndo` 1790 |
| 20 | STATE | The CS half-inning transition uses a bare `setTimeout` not assigned to `pendingTransitionTimer`, so undo's `clearTimeout` can't reach it. That global is also written from five sites with no clear-before-set. **reasoned** | 1767; sites 1013, 1015, 1026, 1624, 1680 |
| 21 | STATE | Clearing an older play subtracts only `ab.outsRecorded`; the loop meant to revert runner outs contains a no-op (`inn.outs = Math.max(0, inn.outs)`), so those outs are never subtracted and runners the play advanced keep their advancement. **reasoned** | `clearSelectedCell` 2305-2350, no-op 2317 |
| 22 | STATE | `editPlayType` adjusts only the batter's own bases/outs — no runner re-prompt, no out renumbering, no RBI recompute; changing a play to HR fills the batter's four bases without scoring the runners on base. **reasoned** | 1883, 1959 |
| 23 | STATE | `fillLinescoreZeros` reads the input by real inning but writes `linescore.innings[i]` by **column** index; the `realInn >= INNINGS` check is dead (runs after the lookup). *Repro: after batting around, DOM `["0","","",""]` vs state `["","0","",""]`. Usually corrected by the next `updateLinescoreTotals`, but a save landing in between persists a zero in the wrong inning.* **Verified** | 2378-2391 |
| 24 | STATE | `updateColumnHeaders` has exactly one caller (`overflowToNextColumn`); `init` builds headers 1…15 and `applyState` never re-derives them from `columnMap`, so real inning numbers are lost on reload. **reasoned — verify by hand** | 121, caller 1219 |
| 25 | STATE | A corrupt saved game is silently discarded (console only) and the next `autoSave` overwrites the salvageable JSON. A corrupt library key reads as "no saved games yet". **reasoned** | `loadState` 2543, `getGameLibrary` 3313 |
| 26 | STATE | `addPitch` checks only `ab.play`, not outs, so pitches can be charged to a batter who never came up; at 4 balls `applyPlay` bails on the outs guard and the walk is silently dropped (the 4 pitches still count toward PC). *Repro: after 3 outs, 4 B taps → `pitches: ["B","B","B","B"]`, `play: ""`.* **Verified** | `addPitch` 1310, guard 531 |
| 27 | STATE | Triple play rejected for too few runners resets `ab.play` but leaves the result pitch pushed at 550. *Repro: TP with nobody on → `play: ""`, `pitches: ["X"]`.* **Verified** | 641 |
| 28 | STATE | `loadGameFromLibrary` assigns the snapshot directly, skipping the `mergeStateDefaults` backfill that `importGameJSON` runs. **reasoned** | 3441 vs 3502 |
| 29 | STATE | Popup callbacks close over `ab`/`inn` captured before the popup opened; pressing `u` while a runner popup is open restores an older snapshot, then confirming applies advancements on top of it. No overlay prevents this. **reasoned** | — |
| 30 | DEAD | `overflowAtBats` is read in 11 places and written in **none** — always empty, so every "batting-around overflow" branch is unreachable. Real batting-around uses `columnMap` + inserted columns. **Verified** | 95; reads 101, 106, 1151, 1169, 2166, 2186, 2416, 2787, 2855, 3089, 3584 |
| 31 | DEAD | `#play-log` doesn't exist in `index.html` and there's no `.play-log-section` CSS, so `refreshPlayLogDisplay` returns on its first line — the log is never displayed. Entries are still generated per play and `gameState.log` grows unbounded in localStorage. Separately, `rebuildPlayLog` sorts by out number (`|| 999`), so after any undo all safe plays reorder after the outs. *Both verified.* | `refreshPlayLogDisplay` 3184, `rebuildPlayLog` 3223 |
| 32 | DEAD | `#sit-lob` doesn't exist — the LOB readout never renders. **Verified** | `updateSituation` 1480 |
| 33 | DEAD | Unused but still serialized/present: `standings`/`STANDINGS_ROWS`, `calculateLOB`, `ab.extraOuts` (written once, never read), sub rows' own `atBats` arrays (at-bat cells only carry the starter's index). **Verified** | 39, 65, 3246, 2334 |
| 34 | STATE | Player/pitcher names flow unescaped into `innerHTML` in six popups (the log/library/summary sinks were fixed in `f7ff87d`, these were missed). `escapeHtml` also omits `'`. **reasoned** | 815, 1068, 1087, 2021, 2931, 2978; `escapeHtml` 30 |

## Appendix B — Not implemented (design gaps, not defects)

Recorded so they aren't re-discovered as bugs:

- **Force vs tag outs** not distinguished; no automatic force logic — the scorer
  picks every runner destination.
- **Substitutions:** one sub row per lineup slot, so a second PH at the same spot
  can't be recorded; no re-entry rules and no re-entry prevention (`markSub` 2947).
- **DH / pitcher batting:** `DH` is a position option only; nothing enforced.
- **Runner passing another runner** not tracked (#4 is the mechanical version).
- **Derived stats:** only AVG is computed (`H/AB`, correctly, 3574) plus
  IP/PC/H/R/ER/K/BB. No OBP, SLG, OPS, WHIP. `era` is a manual field that
  `updatePitcherStats` never computes or overwrites.
- **Innings:** hard cap at 15, and batting around consumes an inning column, so a
  batted-around game can't reach the 15th. `overflowToNextColumn` returns silently
  at the cap (1199), leaving no batter selected.
- **Game-over logic hardcodes 9 innings** (`realInn >= 8` at 1009, 1024, 1515).
- **Test coverage before Phase 1:** `tests.html` covers only extra-inning linescore
  columns and R totals (16/16 passing). No coverage of outs, transitions, batting
  order, RBI, ER, undo, or persistence.
