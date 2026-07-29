# Scorecard PWA — Functional Fix Plan

Follows the functional audit of **2026-07-29** (20 findings). Grounded against
current code at **`faf15c0`**. **Appendix A** is a self-contained index of every
finding with its repro, so this document stands alone — phases refer to findings
by id.

**Baseline when the audit ran:** `npm test` → **206 passed, 0 failed, 0 known
failures**. Every finding here is new and uncovered by the suite. That matters
for method: the 2026-07-28 audit's findings were all promoted to plain tests, so
the suite is now a regression net, not a to-do list. Same discipline applies —
**each finding below gets a test case in `tests-scoring.js` before or with its
fix.** Appendix A gives every repro in the suite's own driver vocabulary
(`sel` / `play` / `runnerPopup` / `outcomePopup` / `editPlay` / `flushTimers`),
so no new harness is needed.

**How the audit was done** (so a re-check can be reproduced): read the scoring
engine end to end, then drove the real `app.js` against the real `index.html`
DOM in jsdom — 47 diagnostic probes — and reproduced C1, C2 and H1 by hand in a
live browser at `http://localhost:8765` (`preview_start` → `scorecard`).

**Progress:** Phases 1–4 are done (C1, C2, C3, H1, H4, M1, M2, H2, H3) — one commit
per fix. What is left is **Phase 5 polish**: M3–M7 and L1–L5, whose decisions are
D8–D11 below. This document is the whole state of the work.

---

## Root causes

The 20 findings collapse into 7 causes plus standalones. Fixing causes retires
families at once.

| # | Root cause | Findings |
|---|---|---|
| RC-A | The entry path has no pending-popup guard, and `applyPlay` commits `ab.play` + the result pitch **before** the popup that decides the play resolves | C1 |
| RC-B | The DP/FC/TP outcome popup accepts unanswered defaults and never validates its out count against the play code it is labelled with | C2, M4 |
| RC-C | `recomputeInning` owns outs / bases / runs / LOB but **not** `ab.rbi`, which is frozen at entry time | C3 ✅ |
| RC-D | `editPlayType` ends with its own render tail instead of routing through `afterStateChange` | H4 |
| RC-E | Box-score **E** has no derivation and no batting-team → fielding-team attribution | H1 |
| RC-F | A lineup slot is two fixed rows, and a substitution is a *column range* on the starter's row | H2, H3 |
| RC-G | Nothing marks the game closed once it is final | M1 |

Standalone: M2, M3, M5, M6, M7, L1–L7.

---

## Decisions — **all eleven answered (D4–D6 and D8–D11 on 2026-07-29, each as recommended)**

D8–D11 are Phase 5's. The rest of Phase 5 needed no decision: M3 (drop the discarded
row), M6 (`0.0` for an appearance), L2 (say the inning is over), L4 (say the card is
full) and L5 (`X`) each have one obviously right answer.

| # | Question | My recommendation |
|---|---|---|
| ~~D1~~ **answered: Block** | **C1 fix shape.** Block the tap (backdrop + `pendingEntryPopupOpen()` guard), or let the tap through and *cancel* the pending play? | **Block.** Add `runner-popup` / `outcome-popup` to `BACKDROP_GUARDED` and refuse `applyPlay` / `selectCell` while one is open, with a `showPlayReject('Finish or close the open entry first.')` — the message `undoLastPlay` already uses. Consistent with how undo/redo already treat these popups. |
| ~~D2~~ **answered: Both** | **C2 fix shape.** Require an explicit outcome for every runner on a DP/TP (the way `showRunnerPopup` flashes unanswered rows), or default the forced runner to *out*? | **Both.** Default the lead forced runner to `out` (that is what a DP *means*), **and** refuse Confirm when a play labelled `DP` would record fewer than 2 outs / `TP` fewer than 3. A DP that records one out is not a DP. |
| ~~D3~~ **answered: Derive, read-only, count every signal** | **H1 scope.** Derive E from `E`-play cells and credit it to the fielding team, or leave E manual and just stop pretending? | **Derive it.** Count cells where `isErrorPlay(ab.play)`, plus `advReason` containing `'E'` (throwing errors on steals/pickoffs, which leave no error play), and write it to the *other* team's E input. Adam's call: the box becomes **read-only** like R/H/LOB, and **every signal counts** — so a man who reaches on E5 and then takes an extra base on a bad throw is two errors, which is right. The two `'E'` advancement writers are steals and pickoffs, always a physically separate error from any batter's error play, so nothing double-counts. |
| ~~D4~~ **answered: a distinct PR action** | **H2 pinch runner.** New mechanism, or overload SUB? | A distinct **PR** action that transfers the *run* to the sub row while leaving AB/H on the starter. Overloading SUB can't work — `setSubLine` skipping the played column is correct for a PH. |
| ~~D5~~ **answered: `ROWS_PER_POS = 3`** | **H3 third player in a slot.** Raise `ROWS_PER_POS` to 3, or make sub rows dynamic? | **`ROWS_PER_POS = 3`** is the cheap correct answer — it is already a constant that sizes the grid, the state and ~12 loops, and `stateForStorage` / `refillAtBats` already handle "rows whose at-bats are dropped on the way out". Dynamic rows are a much larger change for a rarer case. Confirm the row-height cost on iPad is acceptable. |
| ~~D6~~ **answered: warn once and allow** | **M1 lock.** Hard-refuse entry after the game is final, or warn once and allow? | **Warn and allow.** A scorer sometimes needs to correct a final card, and this app's standing policy is "record what happened, never refuse" (see the re-entry prompt). A one-time toast + a FINAL marker is enough. |
| ~~D7~~ **answered: Yes** | **M2 LOB in a walk-off.** Count runners left on when the half ends without 3 outs? | **Yes** — official scoring counts them. Change the `outs >= 3` condition to "the half-inning is over", which now includes a game-ending run. |
| ~~D8~~ **answered: cap at 1, with a toast** | **M4 FC out cap.** Cap the popup at one out (auto-revert, the DP/TP mechanism), or let it hold more and refuse on Confirm the way `requiredOuts` does? | **`maxOuts = 1` for FC**, so the existing cap does the work and the three plays read as one rule (FC 1, DP 2, TP 3). Add a **toast naming what flipped** — the auto-revert is silent today, which reads as a dead button, and that fix lands on the DP/TP flips too. One mechanism policing the popup's out count, not two. |
| ~~D9~~ **answered: leave it, say so** | **M5 undo across a refresh.** Persist the history, or keep it session-scoped? | **Keep it memory-only** — this re-confirms the 2026-07-28 call rather than reversing it. A snapshot is ~6.8 KB, so even a capped 20 would add ~135 KB to every autosave, and the real cost is the load path having to survive snapshots written by an older state shape. What changes is the silence: undo on an empty history **toasts** instead of doing nothing. |
| ~~D10~~ **answered: synthesize** | **M7 pitch track.** Pad a button-entered BB/K's pitch track to the count its outcome implies, or leave the track as a record of what was tapped? | **Synthesize the missing pitches** — a walk is four balls and a strikeout three strikes, so pad to them (pushing `'S'`, never the undrawable `'X'`). The track, the PC column and the play then agree. Not marked apart from tracked pitches: a second glyph on a cell this dense costs more than the distinction is worth. |
| ~~D11~~ **answered: leave the line** | **L3 balk / L1 no-op.** Give the pitcher line a BK column, or leave the balk uncounted? | **Leave the pitcher line alone** and demote L3 to the design-gap list. The line has no WP or PB count either, a balk has no at-bat to hang on (attribution would be inferred from the column's pitcher), and a 9th stat column costs iPad width. This settles **L1**: with nothing to record, a bases-empty WP/PB/BK is **refused with a toast** and pushes no undo entry. |

---

## Phase 1 — the two live-game correctness bugs ✅ DONE

These are the only findings that silently produce a **wrong card during a live
game from ordinary taps**. Both are small. Do these before anything else.

### C1 — pending-popup bypass (RC-A) — ✅ **FIXED**
Fixed per D1 (block). `runner-popup` / `outcome-popup` joined `BACKDROP_GUARDED`,
both now call `showPopupBackdrop()` / `hidePopupBackdrop()`, and a new
`entryInProgress()` guard refuses `applyPlay` and `selectCell` with
`showPlayReject('Finish the open entry first.')` — worded that way because
neither popup has a Cancel, so "close" isn't an option the scorer has. Covered by
4 cases in `tests-scoring.js` under the #29 heading (the same failure family).
Suite: **210 passed, 0 failed**. Verified live too: with the popup open,
`elementFromPoint` over an at-bat cell now returns `popup-backdrop` rather than
the cell's diamond.


`applyPlay` [app.js:1360], `selectCell` [app.js:420], `BACKDROP_GUARDED` [app.js:1199]

`runner-popup` and `outcome-popup` are in `PENDING_ENTRY_POPUPS` (so undo/redo
refuse while they are open) but **not** in `BACKDROP_GUARDED`, so no backdrop is
drawn. Verified live: with the popup open, **18 at-bat cells and every play
button are hit-testable**.

Because `applyPlay` writes `ab.play` and pushes the result pitch *before*
opening the popup, a tap-through causes two distinct failures:

- **(a) the first play is orphaned** — cell reads `1B`, `bases` all false,
  `out: 0`, `seq: 0`, no `playHistory` entry. The `if (ab.play) return` guard
  then blocks re-entry, so the scorer must clear the cell. `updateLinescoreHits`
  counts it → **H = 2 with one runner ever on base.**
- **(b) the stale Confirm corrupts the board later** — the popup stays on screen
  with a live `rp-confirm` closing over the old `prev`/`src`. Answering it two
  plate appearances later ran `applyChosenAdvancements` against *current*
  `inn.bases`: **R went 2 → 3** and a runner who never moved was marked as
  having scored. This is finding #29's failure mode, which undo already guards
  against; the entry path does not.

Fix per **D1**. Note both halves need covering — a guard that only blocks
`selectCell` still lets a play button fire at the already-selected cell.

### C2 — DP/TP on the popup's own defaults records one out and advances the runner (RC-B) — ✅ **FIXED**
Fixed per D2 (both halves). `showRunnerOutcomePopup` now computes
`requiredOuts` (3 for TP, 2 for DP, 0 otherwise) and a `forcedBases` chain — a
runner is forced only while every base behind him is occupied — then opens with
the forced runners nearest the batter already marked **out**, so the popup starts
on what the label asserts. Confirm additionally refuses any DP under 2 outs or TP
under 3 with `A double play needs 2 outs — 1 marked.`, flashing the rows that
aren't outs. When the force chain is short (nobody on 1st) no runner gets a
default out and the scorer has to name the tag out himself — the refusal is what
makes him.

Covered by 3 new cases in `tests-scoring.js` (DP and TP on untouched defaults, and
a DP with nobody forced). The existing case at the same spot asserted the bug's
`outs === 1` outcome; it now asserts that the hold is still *offered* — it
collides with nobody — but no longer confirmable. Suite: **213 passed, 0 failed**.

Verified live at `localhost:8765` on `DP 6-4-3` with a runner on 1st: the popup
opens with pink `Out at 2nd` + pink `Out` and no green Safe; Confirm untouched
gives `outs: 2 · outsRecorded: 2 · bases empty`. Marking the runner `Safe 2nd`
and confirming leaves `outs: 0`, the runner on 1st, and the popup open with the
refusal shown.

**M4 was deliberately left open** — the plan notes it folds into this work, but
the FC out cap is a separate call and stays in Phase 5.

`showRunnerOutcomePopup` [app.js:1695], `applyRunnerOutcomes` [app.js:1863]

Defaults were `{action:'safe', dest: base+1}` for every runner and `out` for the
batter, and unlike `showRunnerPopup` nothing required a runner selection.
Verified in the browser on `DP 6-4-3` with a runner on 1st — the popup showed a
**green "Safe 2nd"** for the runner and **pink "Out"** for the batter; Confirm
gave:

```
outs: 1 · outsRecorded: 1 · runner now on 2nd · card text "DP 6-4-3" · out badge "1"
```

The card asserted a 6-4-3 double play while the state recorded the *opposite* of
its second out. The inning was one out short, and the green default actively
steered the scorer into it. `TP` was identical (1 out).

---

## Phase 2 — make the box score reconcile ✅ DONE

### C3 — RBI is never recomputed when a non-latest play is cleared or edited (RC-C) — ✅ **FIXED**
Fixed in `takeBackPlay`, the one function all three take-back paths share
(`clearSelectedCell`, `editPlayType`, clear-and-keep-pitches). It now snapshots
who is credited with a run and *off whose play* (`scoredRunsWithSource`, reading
the `advSrc[3]` stamp) before the take-back, and afterwards
`dropRbiForLostRuns` debits one RBI from the stamped play for each run that
disappeared. `recomputeInning` still doesn't own RBI, per the fix direction — only
lost runs debit anybody, so an `adjustRBI` override survives anything it doesn't
contradict, and a run with no stamp (steal of home, wild pitch) debits nobody
because no RBI was credited for it either.

Covered by 4 new cases in `tests-scoring.js` next to the existing clear/revert
group: the plan's repro (clear the man who scored), the edit variant
(`editPlay('K')` on him), the cascade case (clear a play that only *set up* the
run — the RBI comes off the batter who drove it in, not off the cleared cell), and
a negative case (an unrelated clear leaves a credited RBI alone). Suite:
**217 passed, 0 failed**.

Not verified in a live browser — the suite drives the real `app.js` against the
real `index.html` DOM, and this is state logic with no layout surface.

One pre-existing oddity surfaced while testing, **not** part of C3: when a revert
takes back only a *middle* segment of a runner who scored, his cell keeps `bases[3]`
marked while the segment below it goes false. He correctly stops counting as a
run everywhere (`runScored` needs all four), but the diamond draws home filled
with a gap beneath it. Cosmetic; worth a Phase 5 line if it bothers you.

`clearSelectedCell` [app.js:3296], `editPlayType` [app.js:2896], `recomputeInning` [app.js:712]

`recomputeInning` re-derives outs, bases, runs and LOB but not `ab.rbi`, which
`countRunnersScored` freezes at entry. **Undo is safe** — `captureInning`
deep-copies every at-bat, so RBI is restored — but the `takeBackPlay` path used
for older plays is not:

- clear the man who scored → **R 2 → 1, batter keeps 2 RBI**
- rewrite an earlier single as a strikeout → **R → 0, batter still shows 1 RBI**

So team RBI can exceed team runs. This is the direct answer to "do downstream
totals recalculate": outs/bases/R/LOB do, RBI doesn't.

**Fix direction.** RBI can't be fully derived — it is a scorer judgement
(9.04(b) suppresses it on a DP, on a K+WP, and `adjustRBI` exists precisely so a
human can override). So don't make `recomputeInning` own it outright. Instead:
after a take-back, **re-derive each surviving at-bat's RBI ceiling** and clamp —
an at-bat cannot be credited with more RBI than runs that actually scored on it.
Cheapest correct version: on take-back, for every at-bat in the inning, drop the
RBI credited for runs whose scorer is no longer marked as having scored. The
`advSrc` stamps already record which play drove whom in, so the attribution is
available without guessing.

Watch out: `adjustRBI` overrides must survive a clamp that doesn't contradict
them, or the scorer's manual correction gets silently undone.

### H1 — linescore **E** is never derived; errors never reach the box score (RC-E) — ✅ **FIXED**
`updateLinescoreTotals` [app.js:3410], input built at [app.js:411], read back at [app.js:3523]

R, H and LOB are computed; **E is a hand-typed input only.** Confirmed in both
jsdom and the browser: `E: ""` after an `E5`. Compounding it, errors are
recorded as plays on the **batting** team's card, so a derivation must credit
them to the *fielding* team — that mapping exists nowhere.

In the full-inning simulation the card produced a correct R/H/LOB (2/3/1) and
pitcher line (1.0 IP, 3 H, 2 R, 1 ER) but **E blank despite a fielded error in
the inning**.

Fix per **D3**.

**What was done.** `countErrorSignals(battingTeam)` scans that team's card for the two
signals — an error play (`E`, `E5`, …) and an exact `'E'` advancement reason — and
`updateLinescoreErrors()` writes each team's box from the *opposing* card, since an
error is recorded where the batting was. It hangs off `updateLinescoreTotals`
alongside `updateLinescoreHits`, so every path that already re-derives R/H/LOB
(`afterStateChange` → `recomputeInning` → `updateInningRuns`, plus the load path)
re-derives E too. The input at [app.js:411] is now `readonly tabindex="-1"` like the
other three, so a save carrying a hand-typed E from an older build is corrected on
load rather than kept.

Only the exact string `'E'` counts as the second signal. `showRunnerPopup`'s out path
stamps the *batter's* play as the advancement reason, so a runner thrown out during an
E5 carries `'E5'` — a label for an error already counted, not a second one.

Verified: 10 new tests (227 passed · 0 failed), and in the browser an `E5` by a
visiting batter puts `1` in the **home** E box, blank in the visiting one, and does
not touch H.

**Noticed while verifying, not fixed (out of H1's scope):** `clearSelectedCell` does
not dismiss a runner popup that is still open, which leaves the popup up over a cell
whose play is gone — and `entryInProgress()` then refuses all further entry until it
is closed. Only reachable if Clear can be tapped while a popup is open, i.e. if Clear
is outside the C1 guard. Worth a look when M1/H4 are in hand.

---

## Phase 3 — game flow

### H4 — `editPlayType` never calls `afterStateChange` (RC-D) — ✅ **FIXED** in `1b9278a`
[app.js:2997–3007]

It ends with its own render/recompute tail. Consequences:

- an edit that creates the 3rd out doesn't flip the half-inning (`outs: 3`, no
  transition timer scheduled)
- an edit that scores the winning run in the bottom of the final inning doesn't
  end the game (home 2, visiting 1, bottom 9th, `gameOverShown: false`)

Every other mutator routes through `afterStateChange` [app.js:1943]. This should
be close to a one-line redirect — but check the interaction with the rollback
path at [app.js:2975], which pops the undo snapshot on a refused change, and
make sure a transition isn't scheduled from a change that then gets rolled back.

### M1 — nothing locks the card once the game is final (RC-G) — ✅ **FIXED**
`checkGameOver` [app.js:2093]

After a walk-off (`gameOverShown: true`), another HR was accepted and moved R
from 1 to 2. Fix per **D6** — a one-time toast plus a FINAL marker, entry still
allowed.

Fold in while in this code: the leftover H1 noticed above — `clearSelectedCell`
does not dismiss an open runner popup, so Clear tapped over one leaves it up on a
cell whose play is gone, and `entryInProgress()` then refuses *all* entry until it
is closed. Same guard family as M1's toast, and a lockup is worse than the bug it
came from.

**What was done.** The audit found the missing lock; the code turned out to have a
*third* copy of the game-over condition as well. `updateLiveStatsFromState` carried
its own `isComplete`, and it had drifted from the other two: it had no walk-off
clause (so the card that ends on the winning run never read FINAL) and no
`vR !== hR` (so a tied bottom of the 9th read FINAL on the way to extras). All
three now go through one `halfEndsGame(team, realInn, outs)`; `halfInningIsOver`
asks it for its walk-off case rather than restating it, and `checkGameOver` is two
lines.

The FINAL marker is the live panel's `ls-inning` readout, which already existed and
was already tested — it was just never refreshed. `updateSituation` is the one
writer that repaints on every selection, and it unconditionally wrote `▼ 9`, so a
reloaded final card showed FINAL until the scorer's first tap and then went back to
reading a live count for a game that was over. It now ends by handing off to
`renderFinalReadout()` when `gameIsFinal()`.

`gameIsFinal()` is derived on every call, not read off the memory-only
`gameOverShown` flag: it survives a reload, and taking the winning run back off the
card restores the live panel with nothing having to remember to clear a flag. It
asks `halfEndsGame` about `lastHalfWithPlays()` — the half the card is furthest
into — because the condition can't be applied to a half nobody has batted in, or a
home team leading in the 5th would satisfy the home clause and a mid-game card
would read FINAL.

The toast is `showPlayNotice`, a neutral-navy tone split out of `showPlayReject`
(both now wrap `showPlayToast`, so the ~15 existing reject call sites are
untouched). An accepted entry must not be dressed in the refusal's red. It fires
from `noteEntryAfterFinal()` on `applyPlay`'s accepted path, before the play lands,
so a *rejected* play doesn't burn the one notice. The flag re-arms itself — an entry
made while the game is not final clears it — so there is nothing to reset alongside
`gameOverShown`, and a card corrected back to a live game and finished again warns
again.

The folded-in leftover: `clearSelectedCell` now takes the same
`entryInProgress()` guard `applyPlay` and `selectCell` use, with the same message
(D1's shape). Clear reaches past the popup backdrop through the `c` hotkey, and it
was deleting the play the popup was still deciding.

Verified: 5 new tests (235 passed · 0 failed). Reverting the three changes
individually fails exactly their own tests and nothing else (4 failures, since the
FINAL-marker revert also takes down the clear-the-winning-run case). In the browser,
a walk-off HR reads `FINAL · 0-1` and still reads FINAL after tapping a cell back in
the 2nd; a second HR is recorded (R 1 → 2) with `Game is final — recording anyway.`
in navy, and no notice on the third entry; `c` over an open runner popup leaves the
popup up and the play intact, and the popup still confirms afterwards.

### M2 — LOB is 0 in a walk-off — ✅ **FIXED**
`recomputeInning` [app.js:748]

`lob = outs >= 3 ? … : 0`, so a half-inning ending on the winning run reports no
runners left on. Repro: a runner standing on 1st, `innLob: 0`, LOB total blank.
Fix per **D7**.

**What was done.** `halfInningIsOver(team, realInn, outs)` replaces the bare
`outs >= 3` test: three outs, *or* the home half of the last inning with the home
team ahead — a walk-off, which ends the half on a run with nobody out. Both it and
`checkGameOver` now read the score through one `runsOnLine(team)` helper, so the
card can't call a game final while its LOB column still says the inning is being
played. `runsOnLine` reads the **line**, not the records, because an inning a
scorer typed in by hand (picking a game up in the 4th) still counts towards who is
ahead — the same figures `checkGameOver` has always used.

Ordering inside `recomputeInning` changed: `updateInningRuns` now runs *before* LOB
is settled, since on a walk-off the run that ends the game is the one the recompute
has just derived. The LOB total the line shows is therefore re-added afterwards
through `writeTeamLOB(team)`, split out of `updateLinescoreTotals` so both callers
write it one way.

Verified: 3 new tests (230 passed · 0 failed) — the walk-off strands its runner,
a run that only *ties* the last inning leaves the half live (LOB still 0), and the
visiting team going ahead in the top of the 9th strands nobody, since the walk-off
clause is the home half's alone. Reverting just the condition to `outs >= 3` fails
the first and passes the other two, which is the shape a real repro should have.
In the browser, a bottom-of-the-9th triple then an RBI single reads `9: 1 · R 1 ·
LOB 1` on the line with 0 outs.

---

## Phase 4 — roster (RC-F) ✅ DONE

The two real feature gaps. Both need a state-shape change: a distinct **PR** action
(D4) and **`ROWS_PER_POS = 3`** (D5). Split into two commits — the rows and their
migration first, so the index remap is reviewable on its own, then PR on top.

### H2 — no pinch runner; the run is credited to the starter — ✅ **FIXED**
`setSubLine` [app.js:4141]

`const start = (on && player.atBats[from].play) ? from + 1 : from` — the sub
line skips a column that already has a play. Correct for a pinch hitter arriving
*after* the at-bat, but it means a pinch runner can never own the column he is
running in. Repro: starter singles, PR comes in, PR scores →
`starterR: "1"`, `subR: ""`. There is no separate PR mechanism.

**What was done.** A `PR` button beside `SUB` (both panels), and one new field:
`ab.prRow`, the row that did the running. The plate appearance is left exactly where
it is — that is the whole difference from `SUB`, which takes the column over and
therefore can't express a man arriving *inside* one.

The attribution split is the substance. A column now credits two rows
independently: the plate appearance goes to the row that **batted** it (`subRowOf`),
the run to the row that **ran** it (`runRowOf`, which is `prRow` when set and
`subRowOf` otherwise). They were one test before, which is why the run landed on the
starter. `tallyAtBats` and `findPlayerOfGame`'s `consider` both took a `filterFn`
that was always `ab => subRowOf(ab) === r` at every call site; both now take the row
itself, since the function has to make the batting/running distinction internally
and a caller-supplied predicate can't.

`markPinchRunner` also hands the line forward (`innIdx + 1` on), because a pinch
runner stays in the game and bats in that spot next time up — one press for the
whole act rather than PR followed by SUB. It refuses four ways: no play in the
column (nobody has reached yet), a runner already marked there, no row left in the
slot, and a man who is no longer on base. The sub-change mark now also fires on a
`prRow` column, since a pinch runner changes hands inside a column rather than at
its edge. `clearSelectedCell` clears `prRow` with the rest of the at-bat.

Fixed in passing, because H2 requires it: the box score's "did this row appear"
test was `ab > 0 || bb > 0 || hbp > 0`, so a pinch runner who scored and never came
to the plate was **left off the box score entirely** while his run counted in the
totals — the R column didn't add up. It now counts a run as an appearance.

**Known limitations, both deliberate:**
- A stolen base after the pinch runner comes on is still attributed by `advReason`
  segment, which `scanNotable` reads without reference to `prRow`. D4 scoped H2 to
  the run; per-segment base-running credit is a larger change.
- `prRow` is a row *offset* within the slot, not an absolute index, so
  `migrateLineupRows` deliberately does **not** remap it.

Verified: 251 passed · 0 failed. 7 new cases, the first of them the plan's own repro
(starter keeps the AB and the hit, the runner takes the run and has neither), plus
the runner batting his own next time up, the entry mark, all the refusals, clearing
taking the runner with the play, and the box score printing both men with the run on
the right line. Reverting the attribution split, the box-score clause and the mark
fails 3 of them and nothing else. In the browser, through the real `PR` button:
`prRow: 1`, Alou `1/1/-/-`, Ruiz `-/-/1/-`.

**Separately flagged, not fixed here:** the same box-score appearance test still
omits a batter whose only plate appearance was a **sacrifice** — `sacrificeExemptsAB`
means no AB, and with no walk or HBP he has nothing to qualify on, yet his RBI is in
the totals. Pre-existing and unrelated to the pinch runner, so it was left out of
this commit rather than smuggled in; spun off as its own task.

### H3 — only two players per lineup slot — ✅ **FIXED**
`ROWS_PER_POS = 2` [app.js:97]

A pinch hitter followed by a defensive replacement in the same spot — routine —
has nowhere to go. The third `markSub` press opens the re-entry/undo prompt
(`promptSubRemoval`) rather than adding a row.

Touch points if `ROWS_PER_POS` changes: `buildScoringGrid` (rowspan on the
at-bat cells is `2`, hard-coded at [app.js:330]), `getActivePlayerIndex`
[app.js:791], `updatePlayerStats` [app.js:3967], `stateForStorage`
[app.js:160], `rowLabel` [app.js:4175], `promptSubRemoval` [app.js:4204]
(`pIdx + 1` assumes exactly one sub), `dhState`, and the `pos * ROWS_PER_POS`
loops throughout. `mergeStateDefaults` / `refillAtBats` must migrate a saved
2-row game.

**iPad row-height check first (D5's gate).** Measured on a throwaway origin, with
the third row simulated in the DOM (`rowspan` 3 plus a cloned sub row) rather than
extrapolated. Per-row height does not change — 24.5px starter, 23.8px sub — so tap
targets are no worse; the grid grows 48%, 464px → 685px.

| iPad | grid before | after | page scroll before | after |
|---|---|---|---|---|
| Pro 12.9″ landscape | 464px | 685px | **16px** | **237px** |
| 10.9″/Air landscape | 464px | 685px | 220px | 441px |
| 10.9″ portrait | 590px | 878px | 202px | 490px |

The cost that matters: the 12.9″ in landscape currently fits the whole card in one
screen and stops doing so. Adam's call: **proceed** — a third player in a slot is
routine and was impossible, and scrolling a card beats losing a substitution.

**What was done.** Raising the constant was the small half. `subChange` was a
*boolean*, which cannot say *which* sub owns a column once there are two, so it is
now the row number (0 = starter) with one reader, `subRowOf` — which still accepts
`true` and resolves it to row 1, for a library entry or an imported file that
reached a reader without passing a migration.

Everything that split a slot's figures "starter vs sub" now loops the rows:
`updatePlayerStats`, the box score, player of the game, and the notable-performance
scan. `getActivePlayerIndex` adds `subRowOf` instead of `+ 1`. `subLineRun` bounds a
run by row number rather than truthiness — on truthiness it would swallow a *later*
substitution's columns into the first one's run and offer to clear them both.
`clearSelectedCell` and the re-entry path hand columns back to the row above rather
than all the way to the starter, since with two sub rows the man before this one may
be another sub. The sub-change mark triggers on a *change* of owner, so a second
substitution is marked too. `defChanges` names the current occupant through a new
`currentSlotRow` — "has a sub been used at all" stopped being that question.

`promptSubRemoval` gains a third option, `<next row> takes over at T5`, offered
whenever a row is free; the heading becomes "Change this spot?". Known limitation,
deliberate: if the sitting sub has recorded *nothing*, the second press still takes
the line back without ceremony (the existing mis-press path), so reaching the second
sub row requires the first to have batted. That is the real sequence — a PH who
never came up is a card correction, not a substitution.

`rowLabel`'s fallback had to change too: "Sub 3" meant *spot* 3, so both sub rows of
a slot read identically and the prompt offered "Sub 1 takes over" about a spot whose
occupant was also "Sub 1". Unnamed sub rows now read "Sub 2 in spot 1", numbered the
way the row's own placeholder is.

**The migration** (`migrateLineupRows`, beside `migrateBaseRunners`) is the part
worth reviewing. A row index *is* a player's place in the slot, so widening a slot
is a remap, not an append: old row 2 is spot 1's starter, and in a 3-row card that
index belongs to spot 0's second sub. Left alone every lineup below the first would
shift up a spot and its at-bats would go with it. So each old row moves to
`slot * ROWS_PER_POS + row`, and every stored player index goes through the same
map — `bases[].p` (including a pre-Phase-7 bare index), `lastPA.pIdx`, the out log's
`pIdx`/`srcP`, `nextLeadoff`, `reentries[].pIdx` and `defChanges[].changes[].pIdx`.
It runs before `refillAtBats` (no point padding rows about to be inserted), infers
the old width from the row count, refuses anything that isn't a whole number of rows
per slot, and is idempotent on a save already at the current width — which is what
makes it safe on the `loadGameFromLibrary` and import paths too.

Verified: 244 passed · 0 failed. The 235 existing cases needed their hard-coded row
indices remapped (`0, 2, 4 …` → `0, 3, 6 …`) — mechanical, and the failures were the
proof the app was right and the literals stale. 9 new cases: three men in one spot
each keeping their own line, both changes marked, clearing the second sub handing
back to the first, undoing the first not taking the second with it, a one-sub slot
reading exactly as before, and four on the migration (rows re-laid-out, every stored
index moved, a legacy boolean becoming row 1, idempotency). Reverting the migration,
the takeover option and the run-bounding fails 8 of them and nothing else. In the
browser: 27 rows a side, `rowspan="3"`, placeholders "PH / Sub 1"/"PH / Sub 2", and a
single-double-homer across the three rows of spot 1 splitting 1/1 · 1/1 · 1/1/1/1.

---

## Phase 5 — polish

| # | Finding | Location |
|---|---|---|
| M3 ✅ | The runner popup offers a **batter-destination row on `SF`/`SH`** that is silently discarded. `defaultAdv` is 1 for a sacrifice → `batterDefaultBase` is 0 → the row renders (3 buttons); the callback then calls `recordBatterOut` and ignores the choice. Also excluded from collision validation, since `rpParties` only adds the batter when `batterTakesBase`. | [app.js:1460], [app.js:2046], [app.js:2081] |
| M4 ✅ | An **`FC` can record three outs** — `maxOuts` is 3 for anything not DP/TP, and `playEntryReject` doesn't constrain FC. (Folds into the D2 work — **it did not**; see below.) | [app.js:1761], [app.js:1344] |
| M5 | **Undo history is memory-only** — after a refresh `undoLastPlay` does nothing (`historyDepth: 0`, state unchanged). `clearSelectedCell` still works correctly post-refresh. The 2026-07-28 plan deliberately left this; re-confirm rather than assume. | [app.js:2817] |
| M6 | A pitcher who records **no outs shows blank IP**, not `0.0` — `s.outs > 0 ? fullInnings : ''`. Run/ER attribution across a mid-inning change is otherwise **correct** (`ab.pitcher` is frozen at entry). | [app.js:4047] |
| M7 | **Manually-entered `BB`/`K` leave the pitch count inconsistent.** A `BB` tapped on a 3-ball count stays at 3 pitches (the `push('B')` only fires when `pitches.length === 0`); a `K` tapped by button pushes `'X'`, which `getPitchCount` reads as 0 strikes and `renderPitches` draws as nothing — so the cell shows "1 pitch" over an empty pitch track. | [app.js:1382–1392], [app.js:2327] |
| L1 | `WP`/`PB`/`BK` with the bases empty record nothing but still **push an undo entry** (2 no-op undos to press through). | [app.js:2748] |
| L2 | A play refused because the inning already has 3 outs **returns silently** — no `showPlayReject`, unlike every other refusal. | [app.js:1368] |
| L3 | A **balk** is visible only as a `BK` advancement label on the runner's diamond; no BK count on the pitcher line. | [app.js:2809] |
| L4 | Batting around in the **15th column can't overflow** (`nextCol >= INNINGS` returns), leaving the selection on a filled cell and further batters silently unenterable. | [app.js:2211] |
| L5 | A home half **never played stays blank** rather than showing `X`. | [app.js:3394] |

### M3 — the `SF`/`SH` runner popup offers a batter destination it discards — ✅ **FIXED**
`showRunnerPopup` [app.js:2245]

**What was done.** The row rendered off `defaultAdv` alone: a sacrifice advances its
runners by 1, the same default a single uses, so `batterDefaultBase` came out 0 and
three destination buttons appeared for a man the callback then handed straight to
`recordBatterOut`. Picking one changed nothing, and nothing validated it either —
`rpParties` only ranks a batter who ends the play on a base, so the choice sat outside
the collision check as well.

It now renders only when `opts.batterTakesBase` is set, which is the condition the rest
of the popup already used for the batter and the one honest test of whether he has a
destination at all. `batterTakesBase` is hoisted to a local so the row and `rpParties`
read the same thing. Deliberately not the play code: a `K+WP` is a strikeout whose
batter *does* reach, and his row is real.

Verified: 3 new cases (258 passed · 0 failed) — a sacrifice offering no batter row, a
hit still offering three, and the K+WP case. Four existing cases answered the row on a
sacrifice (`batter: 0`); dropping those picks is the fix's own proof, since the driver
fails on an option that isn't there. Reverting the gate fails all three new cases and
nothing else.

### M4 — an `FC` can record three outs — ✅ **FIXED**
`showRunnerOutcomePopup` [app.js:1879]

Checked before assuming, since the plan expected this to fold into D2's work: it did
not. C2 added `requiredOuts`, a *floor* for DP and TP; the ceiling was still
`maxOuts = 3` for anything that wasn't one of them, and `playEntryReject` says nothing
about FC. Reproduced against the real DOM — `FC 6` with men on 1st and 2nd, all three
marked out, gave `outs: 3 · outsRecorded: 3 · play "FC 6"`, accepted with the popup
closing and no complaint. Two outs on an FC was equally free.

**What was done.** Fix per D8. `maxOuts` gains an FC clause of 1, so the cap that
already existed does the work and the three plays that own this popup read as one
rule — FC 1, DP 2, TP 3, each beside its floor. `playLabel` is now computed once
next to them and the Confirm refusal's own `label` reads from it, so the two messages
can't drift apart.

The other half of D8 is that the cap stopped being silent. Exceeding it reverts an
*earlier* row to safe, and it did so with nothing said — the scorer marks an out and
watches a different row go green, which reads as a dead button. It now toasts what it
flipped (`A fielder's choice records one out — batter set back to safe.`), naming
runners by the base they started on, the way their own row is labelled. That lands on
the DP and TP flips too, which were just as silent.

Verified: 4 new cases (255 passed · 0 failed) — the plan's own repro, the two-out FC
with the flip and its message, a one-out FC left alone, and the DP flip now announcing
itself. Reverting the FC clause fails the first two and nothing else; reverting only
the toast fails the two that assert it. Not verified in a live browser: the suite
drives the real popup through its own buttons, and the toast is `showPlayReject`, whose
surface M1 already verified.

**Not defects — design gaps, listed so they aren't re-found:**

- **L6** Force out vs tag out isn't distinguished — the popup offers "Out at *N*"
  and the scorer picks which runner. Notation-level; the *right runner* is always
  recorded.
- **L7** No batting-out-of-order detection — any cell can be selected.

---

## Appendix A — findings index

Severity, one-line statement, location, and a repro in `tests-scoring.js`
driver vocabulary. `sel(team, p, col)` selects, `play(code)` enters,
`runnerPopup({from: dest, batter: dest})` answers Advance Runners (negative dest
= out at |dest|), `outcomePopup({from|'batter': [action, dest]})` answers
DP/FC/TP, `editPlay(newPlay, picks)` changes a play type, `flushTimers()` runs
queued transitions. A player index is a lineup *row*, `spot * ROWS_PER_POS + subRow`
— so since H3 raised `ROWS_PER_POS` to 3, the batters are `0, 3, 6, …` and each has
two sub rows above the next batter. The repros below still read `0, 2, 4, …`, which
is where those rows were when the finding was written.

| id | sev | statement | where | repro |
|---|---|---|---|---|
| **C1a** ✅ | critical | A play entered while a runner/outcome popup is pending is orphaned: play on the card, nobody on base, no out, but counted in **H** | applyPlay [1360], selectCell [420], BACKDROP_GUARDED [1199] | `sel(v,0,0); play('1B'); sel(v,2,0); play('1B'); sel(v,4,0); play('K')` → `ab(v,2,0).play==='1B'` but `bases` all false, `H` reads 2 |
| **C1b** ✅ | critical | Answering the stale popup afterwards writes runs/advancement into a state that never happened | same | continue C1a, then click `.rp-btn[data-base="0"][data-dest="3"]` + confirm → phantom run, `R` +1, `p0.bases===[t,t,t,t]` |
| **C2** ✅ | critical | `DP`/`TP` confirmed on popup defaults records 1 out and **advances** the runner | showRunnerOutcomePopup [1695], applyRunnerOutcomes [1863] | `sel(v,0,0); play('1B'); sel(v,2,0); play('DP 6-4-3'); outcomePopup({})` → `outs===1`, runner on 2nd, card reads `DP 6-4-3` |
| **C3** ✅ | critical | RBI is never recomputed when a non-latest play is cleared or edited → team RBI can exceed team R | clearSelectedCell [3296], editPlayType [2896] | `sel(v,0,0); play('1B'); sel(v,2,0); play('HR')` → R 2, p2 RBI 2. Then `sel(v,0,0); clearSelectedCell()` → R 1, **p2 RBI still 2** |
| **H1** ✅ | high | Linescore **E** is never derived from error plays, and errors aren't attributed to the fielding team | updateLinescoreTotals [3410] | `sel(v,0,0); play('E6')` → both E inputs stay `''` |
| **H2** | high | No pinch runner — the run goes to the starter | setSubLine [4141] | `sel(v,0,0); play('1B'); sel(v,0,0); markSub(); sel(v,2,0); play('HR')` → starter R 1, sub R blank |
| **H3** | high | Only two players per lineup slot; a PH then a defensive replacement can't be recorded | ROWS_PER_POS [97] | third `markSub()` on the same slot opens `sub-popup` instead of adding a row |
| **H4** ✅ | high | `editPlayType` never calls `afterStateChange` → no half-inning flip on a 3rd out, no game-over on a walk-off | editPlayType [2997] | 2 outs + a single, then `editPlay('K')` → `outs===3`, `pendingTransitionTimer === null` |
| **M1** | med | Nothing locks the card once the game is final | checkGameOver [1916] | walk-off, `flushTimers()`, then another `play('HR')` → accepted, R +1 |
| **M2** ✅ | med | LOB is 0 in a walk-off | recomputeInning [748] | walk-off single with a man left on 1st → `inn.lob === 0` |
| **M3** | med | `SF`/`SH` runner popup shows a batter-destination row that is discarded and unvalidated | [1460], [2046], [2081] | `sel(v,0,0); play('3B'); sel(v,2,0); play('SF')` → popup has 3 `[data-base="batter"]` buttons; picking one changes nothing |
| **M4** | med | An `FC` can record three outs | [1761], [1344] | `FC 6` with 2 on → `outcomePopup({1:['out',2],0:['out',1],batter:['out']})` → `outs===3` |
| **M5** | med | Undo history is memory-only; after a refresh the last play can't be undone | playHistory [2817] | `flushSave(); loadState(); applyState();` with `playHistory` empty → `undoLastPlay()` is a no-op |
| **M6** | med | A pitcher with 0 outs shows blank IP, not `0.0` | updatePitcherStats [4047] | single, then mid-inning `usePitcher(1)` → starter IP `''` |
| **M7** | med | Manually-entered `BB`/`K` leave the pitch count inconsistent (3-ball walk; `K` as an `'X'` pitch with 0 strikes) | [1382], [2327] | `pitch('B')×3; play('BB')` → 3 pitches. `play('K')` cold → `pitches===['X']`, `getPitchCount` 0/0 |
| **L1** | low | `WP`/`PB`/`BK` with bases empty record nothing but push an undo entry | applyRunnerEvent [2748] | `applyRunnerEvent('BK')` with nobody on → `playHistory.length` +1, card unchanged |
| **L2** | low | A play refused for 3 outs gives no feedback | applyPlay [1368] | enter a play in a 3-out inning → silent return |
| **L3** | low | Balk isn't counted on the pitcher line | [2809] | — |
| **L4** | low | Bat-around in the 15th column can't overflow; further batters silently unenterable | overflowToNextColumn [2211] | 9 × `play('BB')` in col 14 → selection stuck on a filled cell |
| **L5** | low | A home half never played stays blank rather than `X` | fillLinescoreZeros [3394] | visitor wins in the top of the 9th → home 9th cell blank |
| **L6** | gap | Force out vs tag out not distinguished (notation-level; correct runner always recorded) | — | — |
| **L7** | gap | No batting-out-of-order detection | — | — |

---

## Appendix B — verified correct, do not re-audit

Confirmed by probe, not by reading. Useful as the "don't regress this" list.

- **Full complex inning** — single, stolen base, reached-on-error, RBI single,
  6-4-3 DP with the runner forced, pinch hitter, double, flyout to end it. Every
  intermediate state matched a human scorer: outs 0→2→3 in order, out log
  `1:runner:p4 / 2:batter:p6 / 3:batter:p10`, R 2, H 3, LOB 1, six ABs across six
  batters, RBI on the right two men, pitcher 1.0 IP / 3 H / 2 R / **1 ER** (the
  error-reached run correctly unearned), sub row correctly owning the pinch
  hitter's double. **Only E was wrong (H1).**
- Balls/strikes/fouls with auto-walk and the swinging/looking K popup.
- Walks, IBB and HBP forcing only forced runners — IBB with the bases loaded:
  1 run, 1 RBI, no AB, pitcher BB 3.
- Sacrifices per 9.02(a)(1) — SF exempts the AB only with a run; SH only if a
  runner advanced.
- Mixed runner advancement on one play, incl. 1st-and-3rd with the lead runner
  scoring and the trailing runner taking two.
- WP/PB earned-run treatment per 9.16 — a PB flags every runner it moved, so the
  run comes back unearned (pitcher R 1, ER blank).
- **No 4th out, ever** — CS, bulk CS and a later K after 3 outs all refused, out
  log stayed at 3. Outs never exceeded 3 in any probe; `adjustRBI` clamps at 0;
  no impossible base state was reachable through the UI.
- Half-inning transitions; batting-around column overflow with a shared inning
  record and correct headers; extra innings through the real transition path with
  `visibleInnings` auto-revealed and a correct visitor win in the 10th.
- Walk-off on a wild pitch in the bottom of the 9th; shortened-regulation games.
- **Persistence round-trip** — bases, runs and play codes survive
  `flushSave` → `loadState` → `applyState`; `clearSelectedCell` works correctly
  after a refresh.
- Double-tap of the same cell is guarded; DH rules (one to a side, second-DH
  prompt) are implemented.
- Run/ER attribution across a mid-inning pitching change (`ab.pitcher` frozen at
  entry).

---

## Notes for whoever picks this up

- No build step. `.githooks/pre-commit` runs the suite and auto-bumps
  `SHELL_VERSION` in `sw.js` on any asset change — no manual cache bump.
- Test the app over HTTP, never `file://` (`preview_start` → `scorecard`, or
  `python3 -m http.server 8000`). `file://` breaks the service worker and drops
  `localStorage` to the in-memory fallback.
- `npm test` must stay at **0 failed**. A finding fixed → its test case drops the
  `xfail` marker (the runner *fails the run* if an `xfail` starts passing, which
  is the signal to promote it).
- Phases 1–3 are independently shippable and touch little. Phase 4 is the only
  one that changes state shape, and it needs D4 + D5 answered first.
