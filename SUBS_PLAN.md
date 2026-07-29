# Substitutions & DH — plan

Next body of work after the 2026-07-28 correctness audit, which is closed
(`FIX_PLAN.md`, all 10 phases, merged to `main` as `c2ab7b9`).

**Where things stand.** Branch `subs-and-dh`, cut from merged `main`, no commits
yet. Suite: 168 passing, 0 failures (`npm test`). No build step. `.githooks/pre-commit`
runs the tests and bumps `sw.js`, so no manual cache bump.

**Scope.** Three gaps from `FIX_PLAN.md` Appendix B, which records them as design
gaps rather than defects:

1. **A second PH in the same lineup slot can't be recorded** — one sub row per
   position, so the slot holds at most two occupants.
2. **No re-entry rules and no re-entry prevention** (`markSub`).
3. **DH is a position option only** — nothing enforced.

(2) and (3) are additive and independent. (1) is structural and is the one to
scope before committing to it.

---

## Step 1 — Spike: can a slot hold more than two occupants without more rows?

**Read-only. No code changes. Ends in a yes/no.** Do this first: it decides
whether (1) is cheap or a rewrite, and therefore whether this branch is worth
its name.

### How substitution works today

A lineup slot is two player rows: `sp = pos * ROWS_PER_POS` (the starter) and
`sp + 1` (the sub). Every at-bat cell on the card carries the **starter's** row
index — the sub bats on the starter's line.

`markSub` (app.js:4019) sets a boolean `subChange` on the starter's at-bat for
that column and every column after it. `getActivePlayer` (app.js:750) reads that
boolean and returns the sub row if it's set, the starter otherwise. So the model
is a one-way binary switch per slot.

### The question to answer

> Can a slot carry a *list* of occupants instead of the grid carrying more rows?

The shape of the cheap version: `ab.subChange` (boolean) becomes an occupant
index (0 = starter, 1 = first sub, 2 = second, …), and `getActivePlayer`
resolves that index against a per-slot list. If that works, the 28
`ROWS_PER_POS` references never move and the change is additive.

### What to check, and the honest obstacle

- **Where does a third occupant's *identity* live?** The sub row is a player
  record (`num`/`name`/`pos`/`avg`) with a name input rendered in the grid. A
  third occupant needs a record and somewhere to type the name. Candidates: a
  list hanging off the sub row, or a parallel per-slot array. *Note:* the sub
  row's own `atBats` array is dead — at-bat cells only ever use the starter's
  index, which is why `stateForStorage` (app.js:132) strips it — but that is
  dead space for at-bats, **not** a place to put a player record. Don't plan
  around it.
- **Does the grid need a third row?** This is the crux. If the sub row's name
  field can cycle or pick among occupants, no. If each occupant needs its own
  visible row, `buildScoringGrid` (app.js:265) and the `ROWS_PER_POS` arithmetic
  are all in scope and the answer is "expensive".
- **Migration.** Old saves carry `subChange` as a boolean. `mergeStateDefaults`
  is the place to convert.
- **Storage.** `stateForStorage` / `refillAtBats` (app.js:118, 132) assume odd
  rows are empty; confirm any new shape doesn't break that or `stateSignature`.

### Where to read

| What | Where |
|---|---|
| Slot arithmetic, 28 refs | `ROWS_PER_POS` app.js:97 |
| Resolve who is batting | `getActivePlayer` app.js:750, `getActivePlayerName` app.js:758 |
| Make a substitution | `markSub` app.js:4019 |
| Grid rows per position | `buildScoringGrid` app.js:265 |
| Storage assumes odd rows empty | `stateForStorage` app.js:132, `refillAtBats` app.js:118 |
| Every `subChange` reader | `grep -n subChange app.js` (23 sites) |

### Spike result (2026-07-28) — **no**, but not for the reason feared

**The state can carry a list. The card can't show one without `buildScoringGrid`
becoming re-runnable.** The occupant-index half is as cheap as sketched; the
identity-and-display half is the cost, and it is medium, not a rewrite.

**Cheap, confirmed.** `ab.subChange` boolean → occupant index is nearly free:

- `false` → `0` is falsy-compatible, so the `clearSelectedCell` guard (`!ab.subChange`)
  and all four `hasSub = some(a => a.subChange)` scans keep working untouched.
- `getActivePlayer` becomes a list lookup — three lines. Written as
  `list[Number(ab.subChange)]` it reads an *old* boolean save correctly with no
  migration at all; `mergeStateDefaults` only needs a coerce for tidiness.
- `stateForStorage` / `refillAtBats` / `stateSignature` are indifferent to number
  vs boolean.
- `renderPitcherChange`'s `isSubStart` gets *better*: `occ !== prevOcc && occ > 0`
  draws the red line at every change instead of only the first.
- The four stat-splitting sites (`updatePlayerStats` 3893, `playerBox` 4865,
  and the two summary scans 4933/4994) each turn from two tallies into a loop over
  occupants. 3–5 lines apiece.

**The actual blocker: identity is bound to a fixed-length array through the DOM.**
`collectState` reads `num`/`name`/`pos`/`avg` from `[data-p]` and writes
`players[+dataset.p]`; `applyState` reverse-queries the same way; `writeStats`
targets `st-{f}-{team}-{pIdx}`. So a third occupant needs *a line in the table* to
own its name — there is no other input, and a scorecard that can't show who batted
isn't a record. Cycling one name field fails the print path, so that option is out.

Three ways to give it a line, priced:

1. **`ROWS_PER_POS = 3`** — mechanically *smaller* than this plan assumed. 20 of the
   28 refs are `pos * ROWS_PER_POS` or `Math.floor(pIdx / ROWS_PER_POS)` and are
   correct at any constant; `i % ROWS_PER_POS === 0` generalises too. Only the ~8
   literal `sp + 1` "the sub" sites break (752, 281, 3890, 4078, 4861, 4932, 4993).
   **But** it re-indexes every player: index 2 is slot 1's starter today and slot
   0's third row after, so every existing save needs an 18→27 *identity* remap, not
   a field backfill. Plus 27 rows a side of vertical and print layout, and still a
   hard cap at three.
2. **Variable rows per slot** — the expensive one, and for a reason this plan
   doesn't name: *the row↔slot map stops being arithmetic*. All 20 of those
   `pos * ROWS_PER_POS` / `Math.floor(...)` sites become table lookups, including
   keyboard nav (5252), `selectNextBatter` (2138), `markNextInningLeadoff` (2231),
   `refreshCellAria` (226) and `computePitcherPlan` (4156). Don't.
3. **Extra lines inside the existing sub row** (recommended if this is taken up) —
   occupants 2+ get player records appended at indices 18+, and the sub row's
   `<td>`s stack a name input and stat cell per occupant. All 20 arithmetic sites
   are untouched, appending is additive so **no save migrates**, and the render
   functions are already null-safe for a row with no DOM (`renderDiamond` 401,
   `renderOut` 427 all guard). Costs: `stateForStorage`'s `i % ROWS_PER_POS === 0`
   needs to stop treating index 18 as a starter (it would retain 15 empty at-bats),
   and `buildScoringGrid` must become re-runnable because it needs the occupant
   count at build time. **That last part is already safe** — every handler is
   delegated at `document` (5348–5396), so `wrap.innerHTML = html` loses nothing;
   it is called once today (5401) and would need a rebuild + `applyState()`, which
   is the existing load path. The `.pos-sub td` bottom border (styles.css:379) is
   the slot separator and would move to the last line.

Two notes on the plan's own text, now stale: `loadGameFromLibrary` **does** run
`mergeStateDefaults` (4440, fixed in #28) — the comment at 3503 saying otherwise is
out of date. And the sub row's dead `atBats` array is confirmed dead, as written.

**Verdict for Step 4:** not cheap, not a rewrite. Option 3 at roughly the size of
one audit phase. The branch-rename question is yours — see Sequencing.

---

## Step 2 — DH enforcement ✅ *done*

`DH` is a selectable position with no rules behind it. Decide what "enforced"
should mean here — most likely: the DH doesn't take a fielding position, the
pitcher isn't in the batting order when a DH is used, and losing the DH is
recorded rather than prevented. Scorer's-judgment cases should prompt, not
guess — the pattern Phase 8b used for Rule 9.17(b).

**What landed.** `checkDHRules` (OBR 5.11), run from the position selects via a
new `posSelectChanged` hook *and* from `applyFieldPos` (which sets the select by
hand and so fires no change event). Nothing is ever refused:

- **DH takes the field** → role terminated, recorded, announced. Not ambiguous,
  so no prompt.
- **A second DH** → prompts: keep this one and clear the other, or undo.
- **Pitcher in the order alongside a DH** → ambiguous between a lineup slip and
  the moment the DH was lost. Before the side has batted it's a transient notice
  (`showPlayReject`) so lineup entry isn't interrupted by a modal; once the game
  is under way it prompts — record the loss, or undo.

State: `gameState.dhTerminated` (one slot a side — once lost the role can't be
restored, 5.11(b)). Surfaced in a new **Lineup Rules** summary section.

*Not representable on this card:* "the pitcher moves to another position" as a
distinct way of losing the DH. In a DH lineup the pitcher isn't in the batting
order at all, so he has no position select to move.

## Step 3 — Re-entry ✅ *done*

`markSub` allows a substitution to be toggled back off, which is re-entry by
accident rather than by rule. Under most rule sets a replaced starter may not
return; under others (youth, some leagues) they may. Make it a recorded decision
with a warning rather than a silent toggle.

**What landed.** The second press of SUB now asks which of two different acts it
is, because the state can tell them apart: `subLineRun` reads the contiguous sub
line and counts the plate appearances either side of the pressed column.

- Nothing recorded under the sub anywhere in the run → a mis-press. The whole
  line comes back off with no prompt (the common path stays one press).
- The sub has batted → the starter is coming back. Prompts: **re-enter** (clears
  from here to the end of the run, logs it, flagged illegal under OBR 5.10(d)
  unless the league is marked as allowing it), **undo the substitution** (clears
  the whole run and says how many at-bats go back to the starter), or cancel.

State: `gameState.reentries` (a log, like `defChanges` — recorded when the
decision is made, not pruned when a cell is later cleared) and
`gameState.rules.allowReentry`, which the prompt's own checkbox sets so leagues
that allow re-entry stop being warned. `sub-popup` and `dh-popup` are both in
`PENDING_ENTRY_POPUPS`, so undo is refused while either is waiting.

### Picked up on the way

- **`--red` was never defined** — 7 `var(--red)` uses in `app.js` all fell back
  to the inherited colour, so the Position Change inning badge and the Rule
  9.17(b) judgment line were never red. Switched to `--accent` (`#c41e3a`).
- **Names in prompts were stale.** `collectState` only scrapes the lineup inputs
  on the debounced save (~400ms), so `getActivePlayerName` / `getBatterLabel` —
  and every runner popup, the situation line and the Position Change header —
  showed "Batter 3" for a player whose name was on screen. New
  `livePlayerField` reads the input with the state as fallback; caught by driving
  the tests through the inputs rather than writing state directly.

19 cases added to `tests-scoring.js`; suite at **188 passing, 0 failures**.

## Step 4 — The second PH

Sized by Step 1. If the spike says expensive, weigh it against the other
Appendix B item worth doing — **game-over logic hardcodes 9 innings**
(`realInn >= 8` at three sites), which is smaller and matters for any 6- or
7-inning game.

---

## Sequencing

Spike → (2) and (3) in either order → (1) if the spike says it's cheap.

**Branch name caveat.** `subs-and-dh` promises all three. If Step 1 says the
second PH is too invasive for now, rename to `dh-and-reentry`
(`git branch -m`) and let the second PH become its own decision rather than
quietly dropping it.

*Not renamed.* The spike came back "medium", not "too invasive", so whether the
second PH stays on this branch is the Step 4 call and hasn't been made. Rename
only if it moves off.

## Conventions to keep

- Tests drive the real DOM through the UI's own entry points (`selectCell`,
  `applyPlay`, popup confirms) — see the header of `tests-scoring.js`.
- Any new markup uses `data-act` dispatch, not inline `on*`: the CSP added in
  Phase 10 forbids inline script, and a test asserts no `on*` attribute survives.
- New at-bat state needs a default in `createEmptyState`, a backfill in
  `mergeStateDefaults`, and a thought about `stateForStorage`.
- New cells or labels need `aria-label` upkeep — see `describeCellForScreenReader`
  and `refreshCellAria`.
