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

---

## Step 2 — DH enforcement *(additive, do regardless of the spike)*

`DH` is a selectable position with no rules behind it. Decide what "enforced"
should mean here — most likely: the DH doesn't take a fielding position, the
pitcher isn't in the batting order when a DH is used, and losing the DH is
recorded rather than prevented. Scorer's-judgment cases should prompt, not
guess — the pattern Phase 8b used for Rule 9.17(b).

## Step 3 — Re-entry *(additive, do regardless of the spike)*

`markSub` allows a substitution to be toggled back off, which is re-entry by
accident rather than by rule. Under most rule sets a replaced starter may not
return; under others (youth, some leagues) they may. Make it a recorded decision
with a warning rather than a silent toggle.

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

## Conventions to keep

- Tests drive the real DOM through the UI's own entry points (`selectCell`,
  `applyPlay`, popup confirms) — see the header of `tests-scoring.js`.
- Any new markup uses `data-act` dispatch, not inline `on*`: the CSP added in
  Phase 10 forbids inline script, and a test asserts no `on*` attribute survives.
- New at-bat state needs a default in `createEmptyState`, a backfill in
  `mergeStateDefaults`, and a thought about `stateForStorage`.
- New cells or labels need `aria-label` upkeep — see `describeCellForScreenReader`
  and `refreshCellAria`.
