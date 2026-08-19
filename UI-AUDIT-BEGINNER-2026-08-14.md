# UI audit — teaching a new scorer, and building a play as it happened

2026-08-14. Read-only audit; no source file was changed.

> **Status: built, 2026-08-16.** All eight steps of Part D shipped, `14ac015`
> through `5ebb93a` (588 tests green, service worker v130). Step 0 at `14ac015`,
> 1 at `934f509`, 2 at `92b0448`, 3 at `19c7f7c`, 4 at `258d71c`, 5 across
> `d03ea1c` `52f65c2` `06ba6cb` `756a5e0`, 6 at `8c921a1`, 7 at `5ebb93a`.
>
> **This file is kept current, and a test keeps it honest.**
>
> *Every `file:line` reference has been repointed at the source as it stands*,
> and `run-tests.js` now checks them — a reference past the end of its file, or
> one written as `` `symbol` (`file:N`) `` whose symbol is no longer at line N,
> fails the suite. Eight steps moved most of this code (roughly 1,300 lines into
> `app.js` alone), so do not trust a line number here that the suite has not
> seen; run it after moving code, and fix what it reports rather than deleting
> the reference.
>
> *The budget figures have been re-measured and corrected in place*, with what
> the audit originally estimated kept alongside — several of the estimates were
> wrong in ways worth seeing. Where a finding has since been fixed, the fix is
> noted in italics at the finding rather than the finding being deleted: what
> was wrong and why is the part worth keeping.
>
> The measured target table in `styles.css` (search `F27`) remains the primary
> record for layout figures; this file agrees with it and says so where it
> matters.

**The ask.** Someone who has never scored a baseball game should be able to learn on this
app, and entering a play should follow the order the play actually happened rather than
requiring the scorer to already know the code that summarizes it.

**The one-line finding.** The app is excellent at *recording* a play and says almost nothing
about *what it recorded or why*. Every piece a beginner needs already exists somewhere in the
codebase — a plain-English glossary, an English sentence renderer, a step-by-step runner
walkthrough, centrally-named refusal messages. None of it is pointed at the beginner. The
work is mostly re-aiming what's here, not building new machinery.

Decisions taken before writing this: teaching ships behind an explicit **Beginner / Expert
toggle** (Expert stays byte-identical to today), and "build the play as it happened" means all
four of guided builder, field-map picker, plain-English echo, and context-aware controls.

---

## Part A — Findings

### The glossary already exists. It is filed under the wrong name.

**B1 — The plain-English glossary is real, buried, and partial.**
`index.html:498-585` is a modal titled **"Keyboard Shortcuts."** Its last section, "Buttons with
no hotkey," is in fact a glossary — *"K+WP — dropped third strike"*, *"CI — catcher's
interference"*, *"IF — infield fly"*, *"SH — sacrifice bunt"*, *"FC — fielder's choice"*, *"BK —
balk"*, *"PB — passed ball"*. That is exactly the content a beginner needs, written in exactly
the right register.

Three things are wrong with it, none of them the writing:

- It is **titled for a keyboard**, on an app whose primary device is an iPad with no keyboard.
  Six of its eight sections are irrelevant to a beginner, and `app.js:10806` concedes the modal
  "is the only documentation the app has."
- It is **incomplete in the opposite direction**: the codes a beginner meets *first* — the ones
  on the always-visible core row — are the ones the glossary section omits, because they have
  hotkeys and were filed under those instead. `GO`/`FO`/`PO`/`LO` are glossed only as "Ground
  out"/"Fly out" etc. in the Outs table; `SB`, `CS`, `PK`, `E` likewise.
- It is **reached by pressing `?`** or by finding More → Shortcuts. A first-time scorer has no
  reason to go looking.

**B2 — Two rows of it are stale, and one is a rules claim.**

| Row | Says | Actually |
|---|---|---|
| `index.html:516` | Foul is a **"Black ✕"** | Renders navy — `rgba(0,50,120,0.88)`, `styles.css:918` |
| `index.html:549` | WP/PB — **"All runners advance 1"** | Opens a popup asking *who moved* unless exactly one runner is on (`applyRunnerEvent`, `app.js:5587`) |

The "Red ✕" for a strike is fair — `#8f0c14` (`styles.css:2178`) is a dark red. The foul row is
simply wrong, and the WP/PB row teaches a beginner a rule the app itself doesn't follow.

**B3 — There is no legend for the card at all.**
The card carries at least nine distinct visual signals, and not one is explained anywhere:

filled diamond (scored) · thickened basepath (base reached) · on-path slash (out at that base) ·
`UE` glyph (unearned) · four corner advancement labels (`SB`/`CS`/`E`/`WP`/`PB`/`BK`) · RBI dots ·
red top border (pitcher change) · red left border (substitution) · five play-type cell tints
(hit / HR / K / BB / DP).

The tints are the loudest thing on the card and the least documented. A beginner sees a green
cell and a purple cell and has no way to learn what the difference means.

### Entry demands the answer before the observation

**B4 — Order of operations is inverted for a novice.**
The app asks for the summary code first (`GO`), then the fielders, then the runners. The
scorer's own observation order is: *ball → who fielded it → what happened to the batter → what
happened to each runner.* Every one of those pieces already exists as a step in the app. Only
the entry point demands you know `GO` before you can describe a ground ball.

**B5 — Fielder numbers are taught in the worst possible layout.**
`showPositionPopup` (`app.js:7191`) was a 3×3 numeric grid, `1 P` … `9 RF`, laid out in
reading order — which is not where those players stand. Fielder numbering is the single most
important thing a new scorer must internalize, it is inherently spatial, and it was presented as
a phone dialpad. *Fixed at step 2: the grid is now the positioned field map, whose geometry is
the single table `FIELD_MAP` (`app.js:7064`) and whose markup both mounts share through
`fieldMapMarkup` (`app.js:7174`).*

**B6 — Success is silent.**
After entry the cell shows `6-3` and nothing more. `showPlayToast` (`app.js:2461`) fires only for
refusals and caveats. A beginner has no way to tell whether the app understood them.

The renderer for this already exists: `describeCellForScreenReader` (`app.js:1296`) produces
*"Visiting, batting order 3, inning 5: 2B, 1 RBI, scored"* for the screen-reader live region, and
`updateCellAria` (`app.js:1405`) keeps it in sync from every paint path so it cannot drift. It is
one adaptation away from being the beginner's feedback loop.

**B7 — Nothing is ever context-disabled.**
`SB`/`CS`/`PK` with the bases empty, `DP` with two out, `IF` with nobody forced — all pressable,
all the time. The refusal arrives afterwards as a red toast, and only for the cases someone
explicitly coded. The button's own state never teaches the rule.

The messages are already centralized and well-written (`NO_CELL`, `INNING_OVER`, `NO_RUN_508A`,
`NOTHING_TO_MOVE`, `SHARE_BASE_MSG`, `PASS_RUNNER_MSG`). They are being spent as punishment
after the tap instead of as instruction before it.

**B8 — The best "as it happened" surface doesn't say what it's resolving.**
`showRunnerPopup` (`app.js:4137`) is genuinely good design: it walks each runner by name, offers
`Hold / 2nd / 3rd / Home` and `Out at…`, and carries a separate `on E` tick because *which* base
he took and *why* are two questions. But it titles itself the generic **"Advance Runners"** for
every hit and every error; only WP and PB passed a specific title, through `RUNNER_EVENT_TITLE`.
The scorer is answering a question without being told which play they're answering it for.
*Fixed at step 0.3: the table `PLAY_TITLE` (`app.js:2176`) and its reader `playTitle`
(`app.js:2187`) name the play, and the popup titles itself "Single — Who Moved" in
`RUNNER_EVENT_TITLE`'s register (`app.js:5569`).*

**B9 — Two runner surfaces, two vocabularies.**
`showRunnerPopup` said `Hold / 2nd / 3rd / Home / Out 2nd`. The DP/FC/TP outcome popup, whose
chips are built by `ocChip` (`app.js:3483`), says `Hold 1st / Safe 2nd / Out at 2nd`. Same
question, two dialects — and the *visual* version of this problem had already been noticed and
fixed, with the wording left behind. *Fixed at step 0.3, the explicit dialect winning: the
advancement popup adopted `Hold 1st / Safe 2nd / Out at 2nd` and took the height cost.*

**B10 — Correction is spelled as nine separate concepts.**
Undo · Redo · Edit · Rnrs · Spray · RBI+ · RBI− · E/UE · Clear Play · Clear Cell. A beginner who
mis-entered has to already know which of nine applies. Worse, Undo is session-only and says so
only *after* you try it.

**B11 — No practice mode.** First use is a live game with real consequences.
`welcome|onboard|tutorial|firstRun` matches nothing in the repo.

**B12 — Pitch tracking reads as mandatory.** `Pitch: S F B` leads the core row with no sign it's
optional, and the count lives up in the linescore strip, far from the buttons producing it.

### Hygiene

- **H1 — The popups don't look like the app.** ~160 hardcoded hex values in `app.js` inline
  styles, in a Material palette that exists nowhere in the token set: `#ccc` ×38, `#fff` ×34,
  `#f5f5f5` ×14, `#555` ×13, **`#2e7d32` ×13**, `#e8f5e9` ×6, `#fce4ec` ×4, `#1565c0` ×4. The
  green/pink selected-state pair was the runner-outcome and edit-play popups.
  *Fixed at step 3: every one of those inline styles is gone, and a hex literal in generated
  popup markup now fails a test. The shell is `.jsp` (`styles.css:1110`) and the chips are
  `.jsp-chip` (`styles.css:1243`).*
- **H2 — The JS-built popup controls were never touch-audited.** The stylesheet carries a
  measured target table (`styles.css:1759`) covering the deck, lineup and linescore. It did
  not cover the popups, which ran 13–25px tall: `font-size:9px;padding:1px 5px` on the pitching-
  decision "change" button (≈13px), `padding:3px 8px;font-size:10px` on every runner-outcome
  button (≈19px), `padding:2px 7px` on "↻ Fix Stats" (`app.js:1062`, ≈18px). These are controls
  a scorer uses mid-play. *Fixed at step 3: the popups are on the 40px standard and are in the
  target table now — the second half of it, under "The popups app.js builds (I11)".*
- **H3 — The sub-row placeholder is effectively invisible.** `styles.css:813` paints the "PH /
  Sub" placeholder in `--border-light` = `rgba(0,50,120,0.2)` on `--row-alt` — ≈**1.48:1**. It is
  the only thing identifying which slot a sub row belongs to, and the rest of the file holds
  itself to 4.5:1 with measured evidence. *Fixed at step 0.4; `run-tests.js` pins the contrast.*
- **H4 — Popup selected state is colour-only**, with no `aria-pressed`. *Fixed at step 3: an
  inset ring and 700 weight carry it through greyscale, and `aria-pressed` is on every chip.*
- **H5 — No keyboard entry into the grid.** No `tabindex` on `.at-bat-cell`, and arrow
  navigation bails early without a prior tap (`app.js:10587`).

---

## Part B — Ideas, ranked

### Tier 1 — the four you picked, in build order

**I1 · Beginner / Expert toggle.**
The container for everything below. Persisted per device. Expert mode is today's app, unchanged
— which is what makes the rest of this safe to build.

**I2 · Guided play builder — "Walk me through it."**
A full-screen sheet in Beginner mode. Four questions, in the order a scorer watches them happen:

1. **Was the ball hit?** — *On the ground · In the air · Never put in play*
2. **Who got it?** — the field map from I3
3. **What happened to the batter?** — *Out · Safe on an error · Safe, fielder took another runner*
4. **What happened to each runner?** — the existing runner walkthrough

A strip across the top assembles the scorebook code live — `6` … `6-3` — with the plain-English
sentence under it. **The beginner learns the notation by watching it get built out of answers
they already knew.**

The important structural point: this ends by calling the existing `applyPlay` /
`normalizePlayCode` path. It is a new front end on the existing engine — no new scoring logic,
no new state shape, no scoring-test churn. And being full-screen, it costs nothing against the
height budgets in Part C.

*That structural point held exactly — question four is `applyPlayEffects` opening the popup it
always opens, and the whole feature cost the scoring suite nothing. But the four questions above
have a hole in them, found while building and closed by ruling:* **there is no path to a hit.**
Question two asks "who got it?" with no *nobody did*, and all three of question three's outcomes
are fielder-got-it outcomes, so a ground ball through the hole cannot be entered. The built
version adds "Nobody got it" to the map, "Safe — he beat the throw" to the batter question, and
a *how far did he get?* screen routing to 1B/2B/3B/HR. The reasoning: deciding hit-vs-out on a
grounder to short is the judgment a beginner **cannot** make, so it has to be something the
walkthrough helps with rather than a precondition for opening it.

Two smaller amendments from the same pass. "Never put in play" finishes *inside* the sheet
(K / ꓘ / BB / HBP) rather than handing back to the deck. And "in the air" is three answers, not
one — `F8`, `L7` and `P2` are three codes, and writing a catcher's pop-up as `F2` teaches wrong
notation in a feature whose whole purpose is teaching notation.

**I3 · Field-map fielder picker.**
Replace the 3×3 keypad's *layout* (`app.js:7191`) with a positioned diamond-and-outfield
SVG: 6 between second and third, 8 in dead center, 3 by the first-base bag. Keep the numbers,
keep `posPadTap`, keep "Type it" as the escape hatch for a fast scorer. Follows the existing
inline-SVG pattern (`diamondSVG` `app.js:449`; the scoreboard mini-diamond `index.html:141`).

Worth offering in **both** modes — an expert taps a spatial target faster than they read a grid.

**I4 · Plain-English echo after every play.**
Cheapest item here per unit of value, because `describeCellForScreenReader` (`app.js:1296`)
already does most of it. Extend it from *"2B, 1 RBI, scored"* toward *"Doubled to left field.
Ramirez scored from second. 1 out."* Then:

- **Beginner mode** — a persistent line under the deck.
- **Expert mode** — the existing toast, `notice` tone. No layout change at all.

Same renderer serves I7 and the screen-reader region, so the three cannot drift apart.

**I5 · Context-aware controls.**
Dim what can't happen, and say why on the dimmed control. Everything needed is already in state
(`inn.bases`, `inn.outs`, `ab.play`), and the sentences are already written and named. This is
mostly a matter of promoting `NOTHING_TO_MOVE`, `INNING_OVER` and `NO_RUN_508A` from post-hoc
toasts to pre-emptive labels — the refusal teaches the rule instead of just blocking the tap.

### Tier 2

- **I6 · "What's on the card?" legend.** An annotated sample cell covering all nine signals from
  B3. Fold the stale-row corrections (B2) in at the same time, and re-title the hotkey modal so
  the glossary isn't filed under a keyboard.
- **I7 · Long-press any cell → plain-English readout.** Reuses I4's renderer. Turns the whole
  finished card into something a beginner can read back and check themselves against.

  *Shipped at step 7 as a Beginner deck key ("Read"), not a long-press.* Three reasons: this app
  has no touch or pointer handlers anywhere, so a long-press would be a gesture vocabulary
  nothing else uses and nothing teaches; on iOS a long-press on a table cell raises the
  text-selection callout; and after I2's swap the deck could actually afford a labelled,
  discoverable control, which it could not have before. It works on the selected cell — the same
  tap-the-cell-you-mean pattern as `Fix that`.

  *It could not reuse I4's renderer, and this is the interesting part.* `describePlayInWords`
  needs `before` — the inning as it stood when the play began — because "Ramirez scored from
  second" is a claim about two moments, and only `finishPlay` ever holds both. Reading a cell an
  hour later, that is gone. So the readout renders from `cellOutcome`, which is what
  `describeCellForScreenReader` renders from: the two share their **facts** rather than a
  string, which is the arrangement step 1 had already settled on. The consequence is that the
  readout says nothing about runners, because a finished cell does not know.
- **I8 · Dual labels in Beginner mode.** The `<small>` slot currently holding the hotkey letter
  holds the word instead when there's no keyboard — `1B`/*single*, `GO`/*ground out*. Costs no
  new height anywhere, which matters given Part C.
- **I9 · Name the runner popup for its play.** "Single to left — where did each runner end up?"
  instead of "Advance Runners." Roughly a one-line change; disproportionate clarity. Align the
  two dialects (B9) in the same pass.
- **I10 · Practice game.** A seeded demo card in the Game Library with a scripted half-inning
  and a "try this one" prompt, so the first game isn't the real one.

  *Shipped at step 7, and "seeded" became "pinned".* A seeded entry is written into the
  scorer's own library, where it can be deleted by accident and where a half-scored practice
  game looks exactly like a real one. The built version is a row rendered at the top of the
  library and never stored at all — nothing to delete, nothing to overwrite, and no
  `currentGameId`, so "Update Saved Game" can never point at it.

  It carries **both** halves: the top of the first already scored, to read back against I7, and
  the bottom of the first empty with a written account of what happened to enter. The account
  names no notation anywhere in it — naming the codes would answer the only question it asks.

  The implementation decision worth keeping: **it is a script replayed through `applyPlay`, not
  a stored `gameState`.** A snapshot is a second copy of the state shape that goes stale the
  first time the shape changes and fails silently when it does; a script only knows play codes,
  which are the app's most stable interface. It also means the practice card is, by
  construction, a card this app can actually produce. Its expected outcome — 3 outs, 1 run, 1
  left on base — is pinned, so an engine change that rescores it fails loudly.

### Tier 3 — hygiene

- **I11** — restyle the JS popups onto the tokens. Closes H1, H2 and H4 in one pass, and gets
  the popup controls into the measured target table where they belong.
- **I12** — contrast and touch-target fixes: H3, plus the 16×23px linescore inputs.

  *H3 shipped early, at step 0.4. The linescore half was re-measured at step 7 and the result
  is the reverse of what "fix the 16×23 one" implies — the smallest input is on the size with
  the least to give.* Measured on a fitted card, Expert, sub rows hidden, counting how many
  batting rows stay on screen:

  | | before | after | why |
  |---|---|---|---|
  | 1194×834 | 25×28 | **25×31** | 32px keeps nine rows; 36px drops the ninth |
  | 1024×768 | 25×28 | **25×31** | would take 34; one rule covers both, so 32 |
  | 834×1194 | 25×26 | **31×39** | the only viewport fighting nothing — reaches the 40px standard |
  | 844×390 | 25×24 | *unchanged* | 2 batting rows today, 1 at 32px |
  | 390×844 | 16×23 | *unchanged* | 7 batting rows today, 6 at 28px |

  Two corrections to what the audit assumed. **The 16×23 at 390×844 is a floor, not an
  oversight** — the 52px that looks spare beside the table is the `+EI` caption sharing its
  line, and the table already runs flush to the box's right edge, so widening the cells moves
  nothing. And **834×1194 was the opportunity nobody had spotted**: caption on its own line,
  301px of column genuinely spare, card ending above the deck, so it takes the full standard on
  both axes. It has its own breakpoint now.

- **I13** — keyboard entry into the grid (H5).

  *Shipped at step 7 as a roving tab stop* — one `tabindex="0"` per card rather than 135, since
  putting every cell in the tab ring is the obvious wrong fix and would satisfy any test that
  only asked whether the grid was reachable. The second half of H5 mattered as much as the
  first: an arrow with nothing selected used to return, and since every hotkey acts on the
  selection, that left the whole hotkey layer dead on a fresh card.

---

## Part C — What the height budget allows

Two measured constraints govern how much Beginner mode may add. Both are documented in the
source with their arithmetic, and both are already spent.

**1194×834 — the 11" iPad in landscape.**
Nine rows at the `FIT_MIN = 44` floor plus the flat deck came to 836px on an 834px screen; the
page scrolled by 2px. Fixed by trimming the flat drawer's padding to `4px 0 2px`, which
`run-tests.js` now pins. `ui.js` states the remaining margin is **≈5px**, and that growing that
padding back or lowering `FIT_MIN` both land back on a scrolling page.

> **Beginner mode cannot add a persistent deck row at this size.** The echo line (I4) and dual
> labels (I8) must *replace* existing content rather than add to it, and the guided builder (I2)
> must be full-screen.

*Held, and all three were built that way.* The ≈5px is the **deck-and-rows** axis. There turned
out to be a second, separate axis above it — the linescore strip — with a little room on it: see
the I12 note below. The two are not interchangeable, which is why growing the strip costs a
batting row rather than eating the 5px.

**Phone landscape (844×390).**
Deck line one measures **774px against a 798px box** — 24px of slack, reached by shaving three
things at once: 40px keys, 1px separator margins, 4px flex gap. "4px more per key overflows into
a second row," and a second row costs 45px of a screen with about 150px of card on it.

> Dual labels must stack into the `<small>` slot. They must never widen a key.

*Held, and it bound harder than this predicted.* Re-measured after I8 shipped: the words widen
every key they annotate, so Beginner's first line went to **789.4px in an 804px box — 14.6px of
slack, not 24**. (The 774/798 figures were Expert mode, before the words existed. The box is
804px, not 798, measured on `.qb-core`.) That left no room at all for I2's entry point, whose
cheapest possible key was 89.7px — six times the slack.

The way out was the `qb-fix-that` trade rather than a wider deck: **Beginner hides GO/FO/PO/LO
(219.5px with their gaps) and shows one `Guide` key (101.9px)**, which *returns* 117.5px instead
of spending any. I7's `Read` key later took 77.7px of that back. Final state at 844×390:

| | first deck line | slack in the 804px box |
|---|---|---|
| Expert (unchanged throughout) | 746.4px | 57.6px |
| Beginner, after I8 alone | 789.4px | 14.6px |
| Beginner, after I2's swap | 667.9px | 136.1px |
| Beginner, after I7's key | 745.6px | 58.4px |

The lesson worth keeping: **on this deck, a Beginner surface that swaps is affordable and one
that adds is not** — unless something has swapped first.

---

## Part D — Build order

Eight steps. Three of the ordering calls are non-obvious and carry their reasoning.

### 0 · Corrections — no new UI, no toggle, no layout risk

| | Fix | Why it leads |
|---|---|---|
| 0.1 | `index.html:549` — WP/PB row: "All runners advance 1" → "Pick who moved" | Actively misteaches a rule. Worst defect per character of fix. |
| 0.2 | `index.html:516` — foul "Black ✕" → navy | Wrong. |
| 0.3 | **I9** — runner popup names its play; align the two dialects (B8 + B9) | Roughly one line. Helps experts too. |
| 0.4 | **H3** — sub-row placeholder contrast | The only slot identifier, and it's invisible. |

### 1 · The sentence renderer — I4, engine half only

Extend `describeCellForScreenReader` into a full renderer; wire it to the **existing** toast in
`notice` tone. Expert-safe, zero height cost, shippable alone.

**Why this early:** three later items consume it — the Beginner echo line, I7's long-press
readout, and the screen-reader region. Build it once or watch three copies drift.

### 2 · Field map — I3

**Why before all the mode work:** highest learnability-per-line in the audit, self-contained in
one popup, needs no toggle, touches no height budget, helps experts. Nothing gates it. Build it
token-clean so step 3 need not revisit it.

### 3 · Popup hygiene sweep — I11, closing H1 / H2 / H4

**Why here and not last:** step 6 adds a *new* full-screen sheet. Restyle the existing eleven
popups onto tokens **before** adding a twelfth, or you build the new one against a palette you
are about to delete.

**Why not before step 2:** it is a mechanical sweep that blocks nothing. Ahead of the field map
it would delay the best learnability win behind ~160 find-and-replaces.

### 4 · The mode toggle — I1

**Why this late:** only now is there real content to put behind it — the renderer, the field map,
the corrected glossary. Building the toggle first gives you an empty switch.

### 5 · Beginner surfaces, in ascending layout risk

- **5.1** — I6 legend and re-titled glossary. New modal, no height risk; the corrected B2 text
  lands here. Fold in **I15**.
- **5.2** — I4 beginner half: the persistent echo line.
- **5.3** — I5 context-aware controls. No height cost, reuses the already-named messages. Fold in
  **I14**.
- **5.4** — I8 dual labels. **Last, because it is the only one that spends the budget.** Measure
  at all five sizes before committing.

### 6 · Guided play builder — I2

Last of the Tier-1 work, because it consumes every prior step: I3 becomes step 2 of the sheet,
I4 renders its live sentence, I1 gates it, I11 gives it its chrome.

### 7 · Remainder, any order

I7 long-press readout · I10 practice game · I13 keyboard grid entry · **I12 linescore targets
last** — it interacts with the strip height budget, which feeds the batting order.

*Built in the order I13 → I12 → I7 → I10, ascending risk rather than the order listed. The
"I12 last" instinct was right for the wrong reason: the strip budget is real, but the thing it
turned out to cost is a visible batting row rather than page scroll — the grid scrolls
internally, so nothing overflows and the damage is silent. Any future measurement of this axis
has to count rows on screen, not `scrollHeight`.*

### Two gaps in this audit

- **I14 — one "Fix that" entry point.** B10 named the problem (correction spelled as nine
  concepts) but no idea addressed it. A single Beginner-mode entry point that asks "what's wrong
  with this play?" and routes to the right one of the nine. Slots at 5.3.
- **I15 — make pitch tracking visibly optional.** B12 likewise had no idea attached. Cheap;
  slots at 5.1.

*Both shipped where they were slotted — I15 at `d03ea1c`, I14 at `06ba6cb`. I14 turned out to be
the precedent the whole of Beginner mode leans on: hiding nine keys to show one is what proved a
swap costs no width, which is what later made I2's entry point possible at all.*

---

## What I'd do first

If only one thing gets built: **I4, the plain-English echo.** It is the smallest change, it
reuses a renderer that already exists and is already kept in sync, it costs no height in Expert
mode, and it closes the loop that a beginner is missing most — *did the app understand what I
just saw?*

If two: add **I3, the field map.** It fixes the worst-taught concept in the app, helps experts
too, and is self-contained inside one popup.

The guided builder (I2) is the biggest idea here and the one that most directly answers "build
the play as it happened" — but it is worth building *after* I3 and I4, because it consumes both
of them as steps.

---

## What building it actually taught

Four things this audit could not have known, kept because they will govern the next change to
this app as much as they governed these.

**A swap is affordable; an addition is not.** The deck had 14.6px of slack in Beginner mode and
every good idea wanted 80–110px. Everything that shipped to the deck — I14's `Fix that`, I2's
`Guide`, I7's `Read` — got there by replacing something, and the two that added only fit because
a swap had gone first. Part C framed this as a height problem. On the deck it is a width problem,
and the answer is the same either way: find what the new thing makes redundant.

**The fit's failure mode is silent.** The grid scrolls inside its own box, so growing the strip
above it never overflows the page — it just pushes the ninth batting row out of sight. Every
figure in the I12 table was measured by counting rows on screen; `scrollHeight` reported zero
overflow the entire time and would have waved through a change that cost a batting slot.

**Two renderers, one set of facts.** The audit's instinct — "same renderer serves I7 and the
screen-reader region, so the three cannot drift apart" — was right in spirit and wrong in
mechanism. A finished cell does not retain what `describePlayInWords` needs. Sharing
`cellOutcome` and rendering it in two registers gives the same guarantee and is the only version
that works.

**Score the fixture, don't store it.** The practice card is replayed through `applyPlay` rather
than restored from a snapshot, which means it cannot drift from the state shape and cannot
contain a card the app could not produce. The same argument applies to any future fixture:
`FIELD_MAP` is one table for the same reason, and both are pinned by tests that read the source
rather than a copy of it.
