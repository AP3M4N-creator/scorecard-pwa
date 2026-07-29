/*
 * Scoring-flow regression suite.
 *
 * Runs against the full index.html DOM with app.js loaded in the same script
 * realm — see run-tests.js (`npm test`). Cases drive the app through the entry
 * points the UI uses (selectCell, applyPlay, popup buttons, keydown) rather than
 * poking state, so a fix has to work on the real user path.
 *
 * test(...)         must pass; a failure fails the run.
 * xfail('#n', ...)  asserts the CORRECT behaviour for a known bug the code does
 *                   not have yet. A failure is expected and reported as a known
 *                   failure; once the fix lands the case starts passing and the
 *                   runner tells you to drop the marker. No cases currently use
 *                   it — the 2026-07-28 audit's findings were all promoted to
 *                   plain tests — but it stays for the next one.
 */
(function () {
  'use strict';

  const results = window.__TEST_RESULTS__ = [];

  /* ---------------------------------------------------------------- boot ---
     index.html ships empty containers; app.js's init() fills them. We call the
     builders directly instead of init() so nothing loads or applies a saved
     game (run-tests.js sets __NO_AUTO_INIT__). */
  buildScoringGrid('visiting', 'grid-visiting');
  buildScoringGrid('home', 'grid-home');
  buildPitcherTable('visiting', 'pitchers-visiting');
  buildPitcherTable('home', 'pitchers-home');
  buildLinescore();
  updateInningVisibility();

  /* ------------------------------------------------- selector memoising ---
     jsdom has no selector index, so a document-level attribute query walks the
     whole tree (~15k nodes once the grids are built) — about 6ms each. app.js
     issues 60+ of them per recorded play, mostly writing the pitcher table,
     which put this suite at ~100s.

     Memoise ONLY selectors whose matched elements are fixed for the life of the
     page: the generated grid, pitcher and linescore tables never change shape
     after the boot above, only their values and classes. Everything else —
     `.tab-btn.active`, `td.ls-active`, `.at-bat-cell.selected` — falls through
     uncached, because those matches change as the app runs. If a case ever
     rebuilds the grid (buildScoringGrid / buildLinescore) mid-run, clear
     oneCache/allCache. */
  const STABLE_ONE = [
    /^\.at-bat-cell\[data-team=/,
    /^\.out-num\[data-team=/,
    /^input\[data-ls=/,
    /^input\[data-team="(visiting|home)"\]\[data-pitcher=/,
    /^td\[data-field="era"\]\[data-team=/,
    /^input\[data-field="(num|name|avg)"\]\[data-team=/,
    /^select\[data-field="pos"\]\[data-team=/
  ];
  const STABLE_ALL = [
    /^\.inn-col\[data-inn=/,
    /^\.linescore tbody tr$/,
    /^\.spray-mini-svg$/,
    /^input\[data-field="(num|name|avg)"\]\[data-team=/,
    /^input\[data-team="(visiting|home)"\]\[data-field=/,
    /^select\[data-field="pos"\]\[data-team=/
  ];
  const rawOne = document.querySelector.bind(document);
  const rawAll = document.querySelectorAll.bind(document);
  const oneCache = new Map();
  const allCache = new Map();
  document.querySelector = function (sel) {
    if (!STABLE_ONE.some(re => re.test(sel))) return rawOne(sel);
    if (!oneCache.has(sel)) oneCache.set(sel, rawOne(sel));
    return oneCache.get(sel);
  };
  document.querySelectorAll = function (sel) {
    if (!STABLE_ALL.some(re => re.test(sel))) return rawAll(sel);
    if (!allCache.has(sel)) allCache.set(sel, Array.from(rawAll(sel)));
    return allCache.get(sel);
  };

  /* ------------------------------------------------------- fake timers ---
     finishPlay / applyCSAtBase / applyPickoff schedule the half-inning
     transition (and autoSave) with setTimeout. Queue them instead of letting
     them fire mid-case: flushTimers() runs them on demand, and reset() drops
     whatever is left so one case can't leak a transition into the next. */
  const queued = new Map();
  let nextTimerId = 1;
  window.setTimeout = function (fn, ms) {
    const id = nextTimerId++;
    queued.set(id, { fn, ms: ms || 0 });
    return id;
  };
  window.clearTimeout = function (id) { queued.delete(id); };

  function flushTimers() {
    const due = Array.from(queued.entries()).sort((a, b) => a[1].ms - b[1].ms);
    queued.clear();
    due.forEach(([, t]) => t.fn());
  }
  function timerQueued(id) { return queued.has(id); }

  /* ------------------------------------------------------------- state ---
     Reset by mutating the shared gameState object (the module's binding can't
     be reassigned from here) and re-rendering only the columns a case touched.
     A full applyState() per case re-renders 18 players x 15 innings and is what
     made the audit harness take ~10 minutes. */
  const PLAYERS = POSITIONS * ROWS_PER_POS;
  const dirtyCols = new Set();
  const POPUP_IDS = [
    'runner-popup', 'outcome-popup', 'base-picker', 'edit-play-popup',
    'move-runner-popup', 'pos-popup', 'k-popup', 'spray-popup', 'er-review-popup',
    'pitcher-popup', 'recompute-popup', 'popup-backdrop', 'play-reject',
    'sub-popup', 'dh-popup', 'pos-change-popup'
  ];

  // The lineup inputs and position selects hold state the grid never rebuilds
  // and `reset` does not re-render, so a case that fills any of them in has to
  // have them cleared — but only the cases that do pay for the sweep.
  let lineupDirty = false;

  function touch(col) {
    dirtyCols.add(col);
    if (col + 1 < INNINGS) dirtyCols.add(col + 1); // batting-around overflow
  }

  function reset() {
    queued.clear();
    const visibilityDirty = gameState.visibleInnings !== 9;
    const fresh = createEmptyState();
    for (const k of Object.keys(gameState)) delete gameState[k];
    Object.assign(gameState, fresh);
    playHistory.length = 0;
    redoHistory.length = 0;
    erReviewList.length = 0;
    gameOverShown = false;
    finalNoticeShown = false;   // one notice per final game, so it can't cross cases
    pendingTransitionTimer = null;
    if (selectedCell) selectedCell.classList.remove('selected');
    selectedCell = null;
    // The regulation-length select is a header field the grid never rebuilds, so a
    // case that shortened the game has to hand back a nine-inning card.
    const innSel = document.getElementById('info-innings');
    if (innSel && innSel.value !== String(DEFAULT_REGULATION)) innSel.value = String(DEFAULT_REGULATION);

    for (const col of dirtyCols) {
      for (const team of ['visiting', 'home']) {
        for (let p = 0; p < PLAYERS; p++) {
          renderDiamond(team, p, col);
          renderOut(team, p, col);
          renderPlayText(team, p, col);
          renderPitches(team, p, col);
          renderPitchCount(team, p, col);
          renderPitcherChange(team, p, col);
        }
      }
    }
    dirtyCols.clear();

    // The app leaves a popup open on purpose when it refuses an entry, so it can
    // be re-answered — and several cases end on exactly that. Close everything, or
    // the next case inherits a stale popup and reads it as one of its own.
    POPUP_IDS.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });

    // A case that batted around relabelled every cell on its side against the
    // shifted column map; restoring gameState doesn't undo that, and reset only
    // re-renders the columns the case touched.
    ['visiting', 'home'].forEach(refreshCellAria);
    rawAll('input[data-ls]').forEach(i => { i.value = ''; });
    ['visiting', 'home'].forEach(t => { updateLinescoreTotals(t); updatePlayerStats(t); updatePitcherStats(t); });
    rawAll('.at-bat-cell.selected').forEach(c => c.classList.remove('selected'));
    // Only the cases that reveal extra innings need the (expensive) re-toggle.
    if (visibilityDirty) updateInningVisibility();
    if (lineupDirty) {
      rawAll('select[data-field="pos"]').forEach(s => { s.value = ''; });
      rawAll('input[data-field="num"],input[data-field="name"]').forEach(i => { i.value = ''; });
      lineupDirty = false;
    }
  }

  /* -------------------------------------------------------- assertions ---*/
  function fail(msg) { throw new Error(msg); }
  function eq(what, actual, expected) {
    if (actual !== expected) fail(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  function ok(what, cond) { if (!cond) fail(what); }

  function record(name, fn, xfailFinding) {
    reset();
    try {
      fn();
      results.push({ name, pass: true, xfail: xfailFinding });
    } catch (e) {
      results.push({ name, pass: false, xfail: xfailFinding, error: (e && e.message) || String(e) });
    }
  }
  function test(name, fn) { record(name, fn); }
  function xfail(finding, name, fn) { record(name, fn, finding); }

  /* ------------------------------------------------------------ drivers ---*/
  /* `p` throughout is a lineup *row* index, not a batting spot: a row is
     `spot * ROWS_PER_POS + subRow`, so with ROWS_PER_POS = 3 the nine starters are
     0, 3, 6 … 24 and their subs are +1 and +2. The literals below were 0, 2, 4 …
     while a slot had two rows (H3 moved them). If ROWS_PER_POS changes again, every
     one of them moves with it — `p_new = floor(p_old / oldRows) * ROWS_PER_POS +
     p_old % oldRows`, which is the same remap `migrateLineupRows` applies to a save.
     Expected values compared against `onB`, `occupants`, `curP`, `onBaseFrom`,
     `nextLeadoff` and the `{p, col}` refs are row indices too. */
  function cellOf(team, p, col) {
    const cell = document.querySelector(`.at-bat-cell[data-team="${team}"][data-p="${p}"][data-inn="${col}"]`);
    if (!cell) fail(`no at-bat cell for ${team} p${p} col${col}`);
    return cell;
  }
  function sel(team, p, col) { touch(col); selectCell(cellOf(team, p, col)); return cellOf(team, p, col); }
  function play(code) { touch(curCol()); applyPlay(code); }
  function pitch(type) { touch(curCol()); addPitch(type); }
  function key(k) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  }
  function curCol() { return selectedCell ? parseInt(selectedCell.dataset.inn) : 0; }
  function curP() { return selectedCell ? parseInt(selectedCell.dataset.p) : -1; }

  function ab(team, p, col) { return gameState.teams[team].players[p].atBats[col]; }
  function inn(team, col) { return getInnState(team, col); }
  // Who is standing on `base` — the player index, or null. A base entry is a
  // `{ p, col }` ref to the plate appearance he is running from (Phase 7); most
  // cases only care about the man, so they go through here. `onBaseFrom` is for
  // the cases that assert *which* plate appearance it is.
  function onB(team, col, base) {
    const r = inn(team, col).bases[base];
    return r === null ? null : r.p;
  }
  function onBaseFrom(team, col, base) {
    const r = inn(team, col).bases[base];
    return r === null ? null : r.p + '@' + r.col;
  }
  // The players on base, as indices, for the "nobody shares a base" check.
  function occupants(team, col) {
    return inn(team, col).bases.filter(b => b !== null).map(b => b.p);
  }
  // Pitcher stats live on the *fielding* team's rows: when visiting bats, the
  // home pitchers are the ones charged.
  function pStat(battingTeam, i, field) {
    const t = battingTeam === 'visiting' ? 'home' : 'visiting';
    return document.querySelector(`input[data-team="${t}"][data-pitcher="${i}"][data-field="${field}"]`).value;
  }
  // ERA is derived, so it renders into a cell rather than an input.
  function pEra(battingTeam, i) {
    const t = battingTeam === 'visiting' ? 'home' : 'visiting';
    return document.querySelector(`td[data-field="era"][data-team="${t}"][data-pitcher="${i}"]`).textContent;
  }
  // Set regulation length the way the scorer does — through the select, so the
  // change handler and `setRegulationInnings` are both on the path.
  function setInnings(n) {
    const sel = document.getElementById('info-innings');
    if (!sel) fail('no #info-innings select');
    sel.value = String(n);
    sel.dispatchEvent(new window.Event('change'));
  }
  // Batting stats live on the batter's own row; writeStats blanks a zero, so an
  // empty string is what "none" reads as.
  function bStat(team, p, field) {
    return document.getElementById(`st-${field}-${team}-${p}`).textContent;
  }
  function innHeaderCell(team, col) {
    const gridId = team === 'visiting' ? 'grid-visiting' : 'grid-home';
    return rawAll(`#${gridId} .scoring-grid thead th.inn-col`)[col];
  }
  function innHeader(team, col) { return innHeaderCell(team, col).textContent; }
  function setInnHeader(team, col, text) { innHeaderCell(team, col).textContent = text; }
  function lsInput(team, i) { return document.querySelector(`input[data-ls="${team}"][data-inn="${i}"]`); }
  function rTotal(team) { return document.querySelector(`input[data-ls="${team}"][data-stat="r"]`).value; }
  function lobTotal(team) { return document.querySelector(`input[data-ls="${team}"][data-stat="lob"]`).value; }
  function eTotal(team) { return document.querySelector(`input[data-ls="${team}"][data-stat="e"]`).value; }

  function visible(id) {
    const el = document.getElementById(id);
    return !!el && !!el.style.display && el.style.display !== 'none';
  }
  function clickId(id) {
    const el = document.getElementById(id);
    if (!el) fail(`no #${id} to click`);
    if (!el.onclick) fail(`#${id} has no click handler`);
    el.onclick();
  }

  // "Advance Runners" popup. picks: { <fromBase>: dest, batter: dest }, where a
  // negative dest means "out at |dest|" (matches the popup's own data-dest).
  function runnerPopup(picks) {
    const popup = document.getElementById('runner-popup');
    if (!visible('runner-popup')) fail('runner popup is not open');
    Object.keys(picks).forEach(k => {
      const btn = popup.querySelector(`.rp-btn[data-base="${k}"][data-dest="${picks[k]}"]`);
      if (!btn) fail(`runner popup has no option base=${k} dest=${picks[k]}`);
      btn.onclick();
    });
    clickId('rp-confirm');
  }

  // DP/FC/TP outcome popup. picks: { <fromBase>|'batter': ['safe', dest] | ['out', dest] }
  function outcomePopup(picks) {
    const popup = document.getElementById('outcome-popup');
    if (!visible('outcome-popup')) fail('outcome popup is not open');
    Object.keys(picks).forEach(k => {
      const [action, dest] = picks[k];
      const q = dest === undefined
        ? `.oc-btn[data-base="${k}"][data-action="${action}"]`
        : `.oc-btn[data-base="${k}"][data-action="${action}"][data-dest="${dest}"]`;
      const btn = popup.querySelector(q);
      if (!btn) fail(`outcome popup has no option ${k} ${action} ${dest}`);
      btn.onclick();
    });
    clickId('oc-confirm');
  }

  // SB / CS / pickoff base picker.
  function basePicker(from, extra) {
    const popup = document.getElementById('base-picker');
    if (!visible('base-picker')) fail('base picker is not open');
    const btn = popup.querySelector(`.bp-opt[data-from="${from}"][data-extra="${extra || ''}"]`);
    if (!btn) fail(`base picker has no option from=${from} extra=${extra || ''}`);
    btn.onclick();
  }

  // Position-play popup (groundout / fly / DP …): type the fielders, press Enter.
  function positionPopup(text) {
    if (!visible('pos-popup')) fail('position popup is not open');
    const input = document.getElementById('pos-input');
    input.value = text;
    input.onkeydown({ key: 'Enter', preventDefault() {} });
  }

  // Pitching change. changePitcher() is what creates #pitcher-popup, which
  // setPitcher then hides, so go through both rather than calling setPitcher cold.
  function usePitcher(i) { changePitcher(); setPitcher(i); }

  // "Change Play Type" popup: pick a play from the grid, then Apply. `picks` is
  // for the advancement popup the change re-opens when there are runners on base —
  // same shape as runnerPopup's. Omit it when the change can't prompt (nobody on,
  // a plain K, a home run) or when the case expects the change to be refused.
  function editPlay(newPlay, picks) {
    editPlayType();
    const popup = document.getElementById('edit-play-popup');
    if (!visible('edit-play-popup')) fail('edit-play popup is not open');
    const btn = popup.querySelector(`.ep-btn[data-play="${newPlay}"]`);
    if (!btn) fail(`edit-play popup has no ${newPlay} button`);
    btn.onclick();
    clickId('ep-confirm');
    if (picks) runnerPopup(picks);
    else if (visible('runner-popup')) fail('the change re-opened the runner popup and the case did not answer it');
  }

  // The same popup's free-text field, for the position plays that have no button
  // (a groundout, a double play). `outcomes` answers the DP/FC/TP outcome popup.
  function editPlayCustom(text, outcomes, picks) {
    editPlayType();
    if (!visible('edit-play-popup')) fail('edit-play popup is not open');
    document.getElementById('ep-custom').value = text;
    clickId('ep-confirm');
    if (outcomes) outcomePopup(outcomes);
    if (picks) runnerPopup(picks);
  }

  /* =====================================================================
     Harness self-check
     ===================================================================== */

  test('the DOM builds one at-bat column per INNINGS for both teams', () => {
    eq('visiting at-bat cells', document.querySelectorAll('.at-bat-cell[data-team="visiting"]').length, POSITIONS * INNINGS);
    eq('home at-bat cells', document.querySelectorAll('.at-bat-cell[data-team="home"]').length, POSITIONS * INNINGS);
  });

  test('reset() leaves no plays, outs or runners behind', () => {
    // Dirty the state, then reset and prove nothing survived.
    sel('visiting', 0, 0); play('1B'); play('K');
    reset();
    for (const team of ['visiting', 'home']) {
      for (let col = 0; col < INNINGS; col++) {
        eq(`${team} col${col} outs`, inn(team, col).outs, 0);
        for (let p = 0; p < PLAYERS; p++) eq(`${team} p${p} col${col} play`, ab(team, p, col).play, '');
      }
    }
    eq('visiting R', rTotal('visiting'), '');
    eq('selected cell', selectedCell, null);
  });

  /* =====================================================================
     Plays that already work — these guard the fixes that follow
     ===================================================================== */

  test('a single puts the batter on 1st and advances the selection', () => {
    sel('visiting', 0, 0);
    play('1B');
    eq('runner on 1st', onB('visiting', 0, 0), 0);
    eq('batter reached 1st', ab('visiting', 0, 0).bases[0], true);
    eq('result pitch recorded', ab('visiting', 0, 0).pitches.length, 1);
    eq('next batter selected', curP(), 3);
    eq('no run scored', rTotal('visiting'), '');
  });

  test('three strikeouts end the half-inning with numbered outs', () => {
    sel('visiting', 0, 0);
    play('K'); play('K'); play('K');
    eq('outs', inn('visiting', 0).outs, 3);
    eq('first out', ab('visiting', 0, 0).out, 1);
    eq('second out', ab('visiting', 3, 0).out, 2);
    eq('third out', ab('visiting', 6, 0).out, 3);
  });

  test('three strikes auto-opens the strikeout popup and records the K', () => {
    sel('visiting', 0, 0);
    pitch('S'); pitch('S'); pitch('S');
    ok('strikeout popup opened', visible('k-popup'));
    clickId('k-swinging');
    eq('play', ab('visiting', 0, 0).play, 'K');
    eq('outs', inn('visiting', 0).outs, 1);
  });

  test('four balls walk the batter automatically', () => {
    sel('visiting', 0, 0);
    pitch('B'); pitch('B'); pitch('B'); pitch('B');
    eq('play', ab('visiting', 0, 0).play, 'BB');
    eq('runner on 1st', onB('visiting', 0, 0), 0);
    eq('pitch count', ab('visiting', 0, 0).pitches.length, 4);
  });

  test('a home run with two on scores three and credits three RBI', () => {
    sel('visiting', 0, 0);
    play('1B');
    play('1B'); runnerPopup({ 0: 1, batter: 0 });   // lead runner to 2nd, batter to 1st
    play('HR');
    eq('runs in the inning', lsInput('visiting', 0).value, '3');
    eq('R total', rTotal('visiting'), '3');
    eq('RBI on the homer', ab('visiting', 6, 0).rbi, 3);
    eq('bases cleared', inn('visiting', 0).bases.filter(b => b !== null).length, 0);
  });

  test('a bases-loaded walk forces in a run', () => {
    sel('visiting', 0, 0);
    play('1B'); play('BB'); play('BB'); play('BB');
    eq('R total', rTotal('visiting'), '1');
    eq('RBI on the walk', ab('visiting', 9, 0).rbi, 1);
    eq('bases still loaded', inn('visiting', 0).bases.filter(b => b !== null).length, 3);
  });

  test('the batter after the 3rd out leads off the next inning', () => {
    sel('visiting', 0, 0);
    play('K'); play('K'); play('K');   // 3rd out made by p4 (batting 3rd)
    flushTimers();                     // half-inning transition
    eq('stored leadoff for column 1', gameState.nextLeadoff.visiting[1], 9);
  });

  test('a run lands in the column it was scored in', () => {
    sel('visiting', 0, 4);
    play('HR');
    eq('5th-inning cell', lsInput('visiting', 4).value, '1');
    eq('R total', rTotal('visiting'), '1');
    eq('1st-inning cell untouched', lsInput('visiting', 0).value, '');
  });

  test('a stolen base moves the runner and leaves the score alone', () => {
    sel('visiting', 0, 0);
    play('1B');
    key('r');
    basePicker(0, '');                 // SB2 (1st -> 2nd), no error
    eq('1st empty', onB('visiting', 0, 0), null);
    eq('runner on 2nd', onB('visiting', 0, 1), 0);
    eq('R total', rTotal('visiting'), '');
  });

  test('caught stealing records an out and clears the base', () => {
    sel('visiting', 0, 0);
    play('1B');
    key('j');                          // only one runner: applied without a picker
    eq('outs', inn('visiting', 0).outs, 1);
    eq('1st empty', onB('visiting', 0, 0), null);
    eq('runner marked out on the way to 2nd', ab('visiting', 0, 0).outOnBase, 1);
  });

  test('undo reverts a single', () => {
    sel('visiting', 0, 0);
    play('1B');
    key('u');
    eq('play cleared', ab('visiting', 0, 0).play, '');
    eq('bases cleared', onB('visiting', 0, 0), null);
    eq('outs', inn('visiting', 0).outs, 0);
  });

  test('canonical out codes are recognised as outs', () => {
    ['K', 'ꓘ', '6-3', '5-4-3', 'F7', 'P4', 'L9', 'DP 6-4-3', 'FC 6', 'U3', '3U', 'SF', 'SH', 'IF']
      .forEach(code => ok(`isOutPlay(${JSON.stringify(code)})`, isOutPlay(code)));
    ['1B', '2B', '3B', 'HR', 'BB', 'IBB', 'HBP', 'E6', '']
      .forEach(code => ok(`isOutPlay(${JSON.stringify(code)}) is false`, !isOutPlay(code)));
  });

  /* =====================================================================
     Phase 2 — result-changing bugs, fixed. Promoted from xfail; each case now
     guards the fix for the audit finding named in its comment.
     ===================================================================== */

  // #1
  test('the strikeout popup applies to the batter who struck out, not the cell selected later', () => {
    sel('visiting', 0, 0);
    pitch('S'); pitch('S'); pitch('S');          // popup opens for batter 1
    sel('visiting', 12, 0);                       // scorer taps batter 5's cell meanwhile
    clickId('k-swinging');
    eq('batter 1 play', ab('visiting', 0, 0).play, 'K');
    eq('batter 5 play', ab('visiting', 12, 0).play, '');
    eq('outs', inn('visiting', 0).outs, 1);
  });

  // #2
  test('a caught stealing after the 3rd out cannot make a 4th out', () => {
    sel('visiting', 0, 0);
    play('1B'); play('K'); play('K'); play('K'); // 3 outs, runner stranded on 1st
    key('j');
    eq('outs', inn('visiting', 0).outs, 3);
    eq('stranded runner untouched', ab('visiting', 0, 0).outOnBase, null);
  });

  // #2
  test('a pickoff after the 3rd out cannot make a 4th out', () => {
    sel('visiting', 0, 0);
    play('1B'); play('K'); play('K'); play('K');
    key('o');
    basePicker(0, '');                           // PO 1st — Out
    eq('outs', inn('visiting', 0).outs, 3);
    eq('stranded runner untouched', ab('visiting', 0, 0).outOnBase, null);
  });

  // #3
  test('a stolen base after the 3rd out cannot score a run', () => {
    sel('visiting', 0, 0);
    play('3B'); play('K'); play('K'); play('K'); // 3 outs, runner stranded on 3rd
    key('r');                                    // only SBH is offered: applied directly
    eq('R total', rTotal('visiting'), '');
    eq('runner did not reach home', ab('visiting', 0, 0).bases[3], false);
  });

  // #4
  test('a runner told to hold is not erased by the batter taking that base', () => {
    sel('visiting', 0, 0);
    play('2B');                                  // p0 to 2nd
    play('2B'); runnerPopup({ 1: 1, batter: 1 }); // runner holds 2nd, batter sent to 2nd
    const occupied = occupants('visiting', 0);
    ok('the runner who held 2nd is still on a base', occupied.indexOf(0) !== -1);
    eq('no base holds two runners', occupied.length, new Set(occupied).size);
  });

  // #5
  test('the game ends when the 3rd out of the top of the 9th is a caught stealing', () => {
    lsInput('home', 0).value = '2';               // home leads 2-0
    updateLinescoreTotals('home');
    sel('visiting', 0, 8);                        // top of the 9th
    play('1B'); play('K'); play('K');
    key('j');                                     // CS for the 3rd out
    eq('outs', inn('visiting', 8).outs, 3);
    ok('game recognised as over', gameOverShown);
  });

  // #6
  test('a tied 9th selects a visible cell in the 10th', () => {
    gameState.visibleInnings = 9;
    updateInningVisibility();
    selectNextBatterForInning('visiting', 9);     // column 9 == the 10th inning
    ok('a cell is selected', !!selectedCell);
    ok('the selected cell is visible', !selectedCell.classList.contains('hidden-inning'));
    ok('extra inning revealed', gameState.visibleInnings >= 10);
  });

  // #7
  test('a double play entered with 2 outs is rejected', () => {
    sel('visiting', 0, 0);
    play('K'); play('K');                         // 2 outs
    promptPositionPlay('DP ');
    positionPopup('6-4-3');
    eq('play not recorded', ab('visiting', 6, 0).play, '');
    eq('outs', inn('visiting', 0).outs, 2);
    eq('no pitch left behind', ab('visiting', 6, 0).pitches.length, 0);
  });

  // #8
  test('changing a play to a strikeout cannot push the inning past 3 outs', () => {
    sel('visiting', 0, 0);
    play('1B'); play('K'); play('K'); play('K');   // 3 outs
    sel('visiting', 0, 0);
    editPlay('K');                                 // change the leadoff single to a K
    eq('outs', inn('visiting', 0).outs, 3);
  });

  // #15
  test('a prefixed groundout code is recognised as an out', () => {
    ['GO 6-3', 'FO 8', 'LO 7', 'PO 3'].forEach(code => ok(`isOutPlay(${JSON.stringify(code)})`, isOutPlay(code)));
  });

  // #15
  test('a prefixed groundout records an out', () => {
    sel('visiting', 0, 0);
    play('GO 6-3');
    eq('outs', inn('visiting', 0).outs, 1);
    eq('out numbered on the at-bat', ab('visiting', 0, 0).out, 1);
  });

  // #26
  test('pitches cannot be charged to a batter after the 3rd out', () => {
    sel('visiting', 0, 0);
    play('K'); play('K'); play('K');
    sel('visiting', 9, 0);                         // a batter who never came up
    pitch('B'); pitch('B'); pitch('B'); pitch('B');
    eq('pitches', ab('visiting', 9, 0).pitches.length, 0);
    eq('play', ab('visiting', 9, 0).play, '');
  });

  // #27
  test('a triple play rejected for too few runners leaves no pitch behind', () => {
    sel('visiting', 0, 0);
    play('TP 6-4-3');                              // nobody on base
    eq('play', ab('visiting', 0, 0).play, '');
    eq('pitches', ab('visiting', 0, 0).pitches.length, 0);
    eq('outs', inn('visiting', 0).outs, 0);
  });

  /* =====================================================================
     Phase 2 — the fixes must not over-reach. A guard that refuses a legal
     entry during a live game is worse than the bug it closes.
     ===================================================================== */

  // #15 — the other half of the fix: normalising at the input boundary, so a
  // typed prefix never reaches state in the first place.
  test('the position popup normalizes a typed "GO 6-3" to the canonical code', () => {
    sel('visiting', 0, 0);
    promptGroundout();
    positionPopup('GO 6-3');
    eq('play', ab('visiting', 0, 0).play, '6-3');
    eq('outs', inn('visiting', 0).outs, 1);
  });

  // #4
  test('a legal advance is not refused by the occupancy check', () => {
    sel('visiting', 0, 0);
    play('1B');                                    // p0 on 1st
    play('1B'); runnerPopup({ 0: 1, batter: 0 });   // runner to 2nd, batter to 1st
    eq('runner on 2nd', onB('visiting', 0, 1), 0);
    eq('batter on 1st', onB('visiting', 0, 0), 3);
    eq('outs', inn('visiting', 0).outs, 0);
  });

  // #4 — the batter is out on a sacrifice, so a runner holding 1st is no clash.
  test('a sacrifice is not refused when a runner holds the base the batter would take', () => {
    sel('visiting', 0, 0);
    play('1B');                                    // p0 on 1st
    play('SH'); runnerPopup({ 0: 0 });              // runner holds, batter is out
    eq('outs', inn('visiting', 0).outs, 1);
    eq('runner still on 1st', onB('visiting', 0, 0), 0);
  });

  // M3 — a sacrifice advances its runners by 1, the same default a single uses, and
  // the batter row rendered off that alone: three destinations for a man the callback
  // handed straight to `recordBatterOut`. Picking one changed nothing, and nothing
  // validated it either, since `rpParties` only ranks a batter who ends up on a base.
  test('a sacrifice offers the batter no destination', () => {
    sel('visiting', 0, 0);
    play('3B');                                    // p0 on 3rd
    play('SF');
    ok('the popup is up', visible('runner-popup'));
    eq('no batter row', document.getElementById('runner-popup')
      .querySelectorAll('.rp-btn[data-base="batter"]').length, 0);
    runnerPopup({ 2: 3 });
    eq('the batter is out', inn('visiting', 0).outs, 1);
    eq('and on no base', JSON.stringify(ab('visiting', 3, 0).bases), '[false,false,false,false]');
    eq('the run scored', ab('visiting', 0, 0).bases[3], true);
  });

  test('a hit still offers the batter one', () => {
    sel('visiting', 0, 0);
    play('1B');                                    // p0 on 1st
    play('1B');
    eq('three destinations', document.getElementById('runner-popup')
      .querySelectorAll('.rp-btn[data-base="batter"]').length, 3);
    runnerPopup({ 0: 2, batter: 1 });               // the batter takes 2nd on the throw
    eq('batter on 2nd', onB('visiting', 0, 1), 3);
  });

  // The batter reaches on a K+WP, so his row is real there even though the play is
  // a strikeout — the one case where "the batter is out" and "he takes a base" are
  // both true, and `batterTakesBase` rather than the play code is what decides it.
  test('a K+WP still offers the batter a destination', () => {
    sel('visiting', 0, 0);
    play('1B');                                    // p0 on 1st
    play('K+WP');
    eq('three destinations', document.getElementById('runner-popup')
      .querySelectorAll('.rp-btn[data-base="batter"]').length, 3);
    runnerPopup({ 0: 1, batter: 0 });
    eq('batter on 1st', onB('visiting', 0, 0), 3);
    eq('runner on 2nd', onB('visiting', 0, 1), 0);
  });

  // #4 — a refusal has to be recoverable: the popup stays open to be re-answered.
  test('after a refused destination the scorer can pick another and confirm', () => {
    sel('visiting', 0, 0);
    play('2B');                                    // p0 on 2nd
    play('2B');
    runnerPopup({ 1: 1, batter: 1 });               // refused — both want 2nd
    ok('popup still open', visible('runner-popup'));
    runnerPopup({ 1: 3 });                         // send the runner home instead
    eq('runner scored', ab('visiting', 0, 0).bases[3], true);
    eq('batter on 2nd', onB('visiting', 0, 1), 3);
    eq('outs', inn('visiting', 0).outs, 0);
  });

  /* =====================================================================
     Phase 3 — one way to record an out.

     Every out now goes through recordOut and lands in `inn.outsLog`, and
     pitcher IP counts those entries instead of re-deriving outs from the
     batter's at-bat. Closes #10 (IP missing every out that isn't the batter's
     own) and the out-count half of #21, and moves the leadoff rule onto
     `inn.lastPA`.
     ===================================================================== */

  // #10
  test('a caught stealing charges the pitcher a third of an inning', () => {
    sel('visiting', 0, 0);
    play('1B');
    promptCSBase();                                // only one runner — applies directly
    eq('outs', inn('visiting', 0).outs, 1);
    eq('IP', pStat('visiting', 0, 'ip'), '0.1');
  });

  // #10
  test('a pickoff charges the pitcher a third of an inning', () => {
    sel('visiting', 0, 0);
    play('1B');
    promptPickoff();
    basePicker(0);                                 // PO 1st — out
    eq('outs', inn('visiting', 0).outs, 1);
    eq('IP', pStat('visiting', 0, 'ip'), '0.1');
  });

  // #10
  test('a runner thrown out advancing on a single charges the pitcher an out', () => {
    sel('visiting', 0, 0);
    play('1B');                                    // p0 on 1st
    play('1B'); runnerPopup({ 0: -2, batter: 0 });  // runner out at 2nd, batter safe at 1st
    eq('outs', inn('visiting', 0).outs, 1);
    eq('runner out on the way to 2nd', ab('visiting', 0, 0).outOnBase, 2);
    eq('IP', pStat('visiting', 0, 'ip'), '0.1');
    eq('hits allowed', pStat('visiting', 0, 'h'), '2');
  });

  // #10 — the batter's own out was already counted; this guards against the
  // outsLog pass double-counting it.
  test('three strikeouts charge exactly one full inning', () => {
    sel('visiting', 0, 0);
    play('K'); play('K'); play('K');
    eq('out log length', inn('visiting', 0).outsLog.length, 3);
    eq('IP', pStat('visiting', 0, 'ip'), '1');
  });

  test('a double play charges two outs and two thirds of an inning', () => {
    sel('visiting', 0, 0);
    play('1B');                                    // p0 on 1st
    promptPositionPlay('DP ');
    positionPopup('6-4-3');
    outcomePopup({ 0: ['out', 1], batter: ['out'] });
    eq('outs', inn('visiting', 0).outs, 2);
    eq('outs charged to the batter', ab('visiting', 3, 0).outsRecorded, 2);
    eq('out log length', inn('visiting', 0).outsLog.length, 2);
    eq('IP', pStat('visiting', 0, 'ip'), '0.2');
  });

  test('an out is logged against the pitcher who was on the mound for it', () => {
    sel('visiting', 0, 0);
    play('K');                                     // starter gets this one
    usePitcher(1);                                 // reliever in
    play('K');
    eq('starter IP', pStat('visiting', 0, 'ip'), '0.1');
    eq('reliever IP', pStat('visiting', 1, 'ip'), '0.1');
  });

  // A runner's hit belongs to the pitcher he batted against, not to whoever is on
  // the mound when he's thrown out. The CS/PO paths used to overwrite it.
  test('a caught stealing does not move the runner\'s hit to the new pitcher', () => {
    sel('visiting', 0, 0);
    play('1B');                                    // single off the starter
    usePitcher(1);
    promptCSBase();
    eq('starter charged the hit', pStat('visiting', 0, 'h'), '1');
    eq('reliever charged no hit', pStat('visiting', 1, 'h'), '');
    eq('reliever charged the out', pStat('visiting', 1, 'ip'), '0.1');
  });

  // #7's other half: the leadoff rule is "the batter after the last completed
  // plate appearance", which the old `out === 3` search could not see.
  test('the inning after a double-play-ending inning leads off with the next batter', () => {
    sel('visiting', 0, 0);
    play('K');                                     // p0 out
    play('1B');                                    // p2 on 1st
    promptPositionPlay('DP ');                     // p4 grounds into a DP
    positionPopup('6-4-3');
    outcomePopup({ 0: ['out', 1], batter: ['out'] });
    eq('outs', inn('visiting', 0).outs, 3);
    flushTimers();
    eq('leadoff for the next inning', gameState.nextLeadoff.visiting[1], 9);
  });

  test('the inning after a caught-stealing-ending inning leads off with the batter at the plate', () => {
    sel('visiting', 0, 0);
    play('K'); play('K');                          // p0, p2 out
    play('1B');                                    // p4 on 1st, p6 now up
    promptCSBase();
    eq('outs', inn('visiting', 0).outs, 3);
    flushTimers();
    eq('leadoff for the next inning', gameState.nextLeadoff.visiting[1], 9);
  });

  test('the inning after a pickoff-ending inning leads off with the batter at the plate', () => {
    sel('visiting', 0, 0);
    play('K'); play('K');
    play('1B');                                    // p4 on 1st, p6 now up
    promptPickoff();
    basePicker(0);
    eq('outs', inn('visiting', 0).outs, 3);
    flushTimers();
    eq('leadoff for the next inning', gameState.nextLeadoff.visiting[1], 9);
  });

  // #21 — clearing an older play has to give back every out it made, not just the
  // batter's. The old code left the doubled-off runner recorded as out.
  test('clearing an older double play gives back both of its outs', () => {
    sel('visiting', 0, 0);
    play('1B');                                    // p0 on 1st
    promptPositionPlay('DP ');
    positionPopup('6-4-3');
    outcomePopup({ 0: ['out', 1], batter: ['out'] });
    sel('visiting', 6, 0);
    play('K');                                     // a later play, so the DP is not the newest
    eq('outs before the clear', inn('visiting', 0).outs, 3);
    sel('visiting', 3, 0);
    clearSelectedCell();                           // clear the DP
    eq('outs', inn('visiting', 0).outs, 1);
    eq('out log length', inn('visiting', 0).outsLog.length, 1);
    eq('runner no longer out', ab('visiting', 0, 0).out, 0);
    eq('IP', pStat('visiting', 0, 'ip'), '0.1');
  });

  // The surviving outs get renumbered, so the card can't show "1" and "3" for a
  // two-out inning.
  test('clearing the middle out renumbers the outs after it', () => {
    sel('visiting', 0, 0);
    play('K'); play('K'); play('K');
    sel('visiting', 3, 0);
    clearSelectedCell();                           // clear the 2nd out
    eq('outs', inn('visiting', 0).outs, 2);
    eq('first out', ab('visiting', 0, 0).out, 1);
    eq('the 3rd out is now the 2nd', ab('visiting', 6, 0).out, 2);
    eq('IP', pStat('visiting', 0, 'ip'), '0.2');
  });

  // Deferred from Phase 2, free with recordOut: a triple play with an out already
  // recorded can't fit, and recordOut would silently drop the overflow.
  test('a triple play entered with an out already recorded is rejected', () => {
    sel('visiting', 0, 0);
    play('K');                                     // 1 out
    play('1B'); play('1B'); runnerPopup({ 0: 1, batter: 0 });
    promptPositionPlay('TP ');
    positionPopup('6-4-3');
    eq('play not recorded', ab('visiting', 9, 0).play, '');
    eq('outs', inn('visiting', 0).outs, 1);
    eq('no pitch left behind', ab('visiting', 9, 0).pitches.length, 0);
  });

  // Batting around continues one real inning across two columns. Each column logs
  // the outs made while it was the active one, so the inning's outs are those logs
  // concatenated — count them twice and a 3-out inning reads as more.
  test('an inning batted around charges exactly one inning', () => {
    sel('visiting', 0, 0);
    play('K');                                     // 1 out
    for (let i = 0; i < 8; i++) play('BB');         // fills all 9 spots, forces runs
    eq('overflowed to the next column', curCol(), 1);
    eq('same real inning', getRealInning('visiting', 1), 0);
    play('K'); play('K');                          // outs 2 and 3, in column 1
    eq('outs', inn('visiting', 1).outs, 3);
    eq('IP', pStat('visiting', 0, 'ip'), '1');
  });

  // #9 — a batter's SECOND time up in a batted-around inning is a different runner
  // on the bases than his first. `getRunnerCol` scanned columns forward and found
  // the first PA, so the second one's advancement was written onto a cell that
  // already showed four bases: the run disappeared and two runners derived onto the
  // same base. Phase 6's recompute is only sound if a runner's cell is the one he is
  // actually running from, so this is the gate that phase hinges on.
  test('a run scored on a second plate appearance in the same inning counts', () => {
    sel('visiting', 0, 0);
    for (let i = 0; i < 9; i++) play('BB');         // fills all 9 spots, forces 6 in
    eq('overflowed to the next column', curCol(), 1);
    eq('six runs so far', lsInput('visiting', 0).value, '6');
    eq('leadoff man scored on his first PA', ab('visiting', 0, 0).bases[3], true);
    play('BB'); play('BB'); play('BB');             // p0 back on 1st, then forced round
    eq('leadoff man is on 3rd on his second PA', onB('visiting', 1, 2), 0);
    play('BB');                                     // forces him home again
    eq('he scored on his second PA too', ab('visiting', 0, 1).bases[3], true);
    eq('ten runs', lsInput('visiting', 0).value, '10');
    eq('his first PA cell is untouched', JSON.stringify(ab('visiting', 0, 0).bases), '[true,true,true,true]');
  });

  // The base entry names the plate appearance the runner is running from, so a
  // reader gets his cell without searching the inning for it.
  test('a base entry points at the plate appearance the runner came up in', () => {
    sel('visiting', 0, 0);
    for (let i = 0; i < 9; i++) play('BB');          // bats around; 6 in, bases loaded
    eq('overflowed to the next column', curCol(), 1);
    eq('runner on 3rd came up in column 0', onBaseFrom('visiting', 1, 2), '18@0');
    play('BB'); play('BB'); play('BB');              // p0 up again in column 1
    eq('runner on 3rd now came up in column 1', onBaseFrom('visiting', 1, 2), '0@1');
  });

  // The RBI count compared the batter's column before and after the play, so a
  // runner who had reached in an *earlier* column of the same inning scored
  // without anyone being credited for driving him in.
  test('driving in a runner who reached in an earlier column is an RBI', () => {
    sel('visiting', 0, 0);
    for (let i = 0; i < 9; i++) play('BB');          // bats around; 6 in, bases loaded
    play('1B'); runnerPopup({ 2: 3, 1: 2, 0: 1, batter: 0 });
    eq('seven runs', lsInput('visiting', 0).value, '7');
    eq('the single is credited with the RBI', ab('visiting', 0, 1).rbi, 1);
  });

  // #19 — a snapshot captured `atBats[innIdx]` and that column's inning record
  // only. A batted-around inning spans two columns, and a play in the later one
  // moves runners standing on bases they reached in the earlier one, so undo put
  // back half of what the play had changed and the run it drove in stayed.
  test('undo of a play in the overflow column takes back the run it drove in', () => {
    sel('visiting', 0, 0);
    for (let i = 0; i < 9; i++) play('BB');          // bats around; 6 in, bases loaded
    eq('six runs', lsInput('visiting', 0).value, '6');
    play('1B'); runnerPopup({ 2: 3, 1: 2, 0: 1, batter: 0 });
    eq('seven runs', lsInput('visiting', 0).value, '7');
    undoLastPlay();
    eq('back to six runs', lsInput('visiting', 0).value, '6');
    eq('the runner is back on 3rd', onB('visiting', 1, 2), 18);
    eq('his column-0 cell shows no run', ab('visiting', 18, 0).bases[3], false);
    eq('the batter has no play', ab('visiting', 0, 1).play, '');
    basesConsistent('visiting', 1);
  });

  test('undo reverts a caught stealing, out log included', () => {
    sel('visiting', 0, 0);
    play('1B');
    promptCSBase();
    undoLastPlay();
    eq('outs', inn('visiting', 0).outs, 0);
    eq('out log length', inn('visiting', 0).outsLog.length, 0);
    eq('runner back on 1st', onB('visiting', 0, 0), 0);
    eq('IP', pStat('visiting', 0, 'ip'), '');
  });

  test('undo reverts a double play, both outs included', () => {
    sel('visiting', 0, 0);
    play('1B');
    promptPositionPlay('DP ');
    positionPopup('6-4-3');
    outcomePopup({ 0: ['out', 1], batter: ['out'] });
    undoLastPlay();
    eq('outs', inn('visiting', 0).outs, 0);
    eq('out log length', inn('visiting', 0).outsLog.length, 0);
    eq('runner back on 1st', onB('visiting', 0, 0), 0);
    eq('batter has no play', ab('visiting', 3, 0).play, '');
    eq('IP', pStat('visiting', 0, 'ip'), '');
  });

  // A game saved before Phase 3 has no out log; IP has to come back from the
  // per-at-bat `out` fields rather than reading blank.
  test('a game saved without an out log is backfilled on load', () => {
    sel('visiting', 0, 0);
    play('K'); play('K');
    collectState();                                 // mutates gameState in place
    const saved = JSON.parse(JSON.stringify(gameState));
    saved.innings.visiting.forEach(i => { delete i.outsLog; delete i.lastPA; });
    const merged = mergeStateDefaults(saved);
    eq('log rebuilt', merged.innings.visiting[0].outsLog.length, 2);
    eq('first out', merged.innings.visiting[0].outsLog[0].n, 1);
    eq('second out', merged.innings.visiting[0].outsLog[1].n, 2);
    eq('pitcher carried over', merged.innings.visiting[0].outsLog[0].pitcher, 0);
  });

  // A pre-Phase-7 save holds a bare player index in `inn.bases`, not a
  // `{ p, col }` ref. Everything that reads a runner's cell would break on it.
  test('a game saved with bare base indices is migrated on load', () => {
    sel('visiting', 0, 0);
    play('1B');
    collectState();
    const saved = JSON.parse(JSON.stringify(gameState));
    saved.innings.visiting[0].bases = [0, null, null];       // the old shape
    const merged = mergeStateDefaults(saved);
    eq('upgraded to a ref', JSON.stringify(merged.innings.visiting[0].bases[0]), '{"p":0,"col":0}');
  });

  // #24 — buildScoringGrid writes the headers 1…15 and only
  // overflowToNextColumn ever re-derived them from the column map, so real inning
  // numbers were lost on reload: after batting around, column 2 read "3" when it
  // was still the 1st. Uses the real applyState, which is what a reload runs.
  test('column headers are re-derived from the column map on load', () => {
    sel('visiting', 0, 0);
    for (let i = 0; i < 9; i++) play('BB');          // bats around into column 1
    eq('overflowed', curCol(), 1);
    eq('the overflow column is still the 1st', innHeader('visiting', 1), '1');
    // What a reload starts from: the built header row, before any map is applied.
    for (let c = 0; c < INNINGS; c++) setInnHeader('visiting', c, String(c + 1));
    eq('reset for the reload', innHeader('visiting', 1), '2');
    applyState();
    eq('overflow column re-derived', innHeader('visiting', 1), '1');
    eq('the column after it is the 2nd', innHeader('visiting', 2), '2');
  });

  /* =====================================================================
     Phase 4 — one way to move a runner.

     Every write to `inn.bases` goes through setRunnerOn / clearRunner /
     moveRunnerTo, and the popups and base pickers stop offering a destination
     that would put two men on one base or send a runner past the man in front
     of him. Closes #4 properly.
     ===================================================================== */

  function rpBtn(base, dest) {
    const btn = document.getElementById('runner-popup').querySelector(`.rp-btn[data-base="${base}"][data-dest="${dest}"]`);
    if (!btn) fail(`runner popup has no option base=${base} dest=${dest}`);
    return btn;
  }
  function ocBtn(base, action, dest) {
    const q = dest === undefined
      ? `.oc-btn[data-base="${base}"][data-action="${action}"]`
      : `.oc-btn[data-base="${base}"][data-action="${action}"][data-dest="${dest}"]`;
    const btn = document.getElementById('outcome-popup').querySelector(q);
    if (!btn) fail(`outcome popup has no option ${base} ${action} ${dest}`);
    return btn;
  }
  function bpLabels() {
    return Array.from(document.getElementById('base-picker').querySelectorAll('.bp-opt')).map(b => b.textContent);
  }
  function mrDests(fromBase) {
    return Array.from(document.getElementById('move-runner-popup').querySelectorAll(`.mr-btn[data-from="${fromBase}"]`))
      .map(b => b.dataset.to);
  }
  // Nothing should ever leave two runners listed on one base, whatever was entered.
  function basesConsistent(team, col) {
    const occupied = occupants(team, col);
    eq('no base holds two runners', occupied.length, new Set(occupied).size);
  }

  test('the runner popup blocks the base the batter has to take', () => {
    sel('visiting', 0, 0);
    play('1B');                                    // p0 on 1st
    play('1B');                                    // popup opens: batter must take 1st
    ok('holding 1st is not offered', rpBtn(0, 0).disabled);
    ok('2nd is still offered', !rpBtn(0, 1).disabled);
    runnerPopup({ 0: 1, batter: 0 });
    eq('runner on 2nd', onB('visiting', 0, 1), 0);
    eq('batter on 1st', onB('visiting', 0, 0), 3);
  });

  test('the runner popup will not send a runner past a lead runner who holds', () => {
    sel('visiting', 0, 0);
    play('1B');
    play('1B'); runnerPopup({ 0: 1, batter: 0 });   // p0 on 2nd, p2 on 1st
    play('1B');                                    // popup: three-way decision
    rpBtn(1, 1).onclick();                          // lead runner holds 2nd
    ok('3rd is blocked for the trailing runner', rpBtn(0, 2).disabled);
    ok('2nd is blocked for the trailing runner', rpBtn(0, 1).disabled);
    ok('the out options stay open', !rpBtn(0, -2).disabled);
    clickId('rp-confirm');
    ok('the entry is not accepted', visible('runner-popup'));
    basesConsistent('visiting', 0);
  });

  test('two runners can both score without tripping the order check', () => {
    sel('visiting', 0, 0);
    play('2B');
    play('1B'); runnerPopup({ 1: 3, batter: 0 });   // p0 scores, p2 on 1st
    play('2B'); runnerPopup({ 0: 3, batter: 1 });   // p2 scores from 1st, p4 on 2nd
    eq('runs', lsInput('visiting', 0).value, '2');
    eq('batter on 2nd', onB('visiting', 0, 1), 6);
    basesConsistent('visiting', 0);
  });

  // #4 — the batter used to be put on 1st before the popup opened, which erased
  // the runner standing there and dropped him out of the popup's own runner list.
  test('a K+WP does not erase the runner on 1st', () => {
    sel('visiting', 0, 0);
    play('1B');                                    // p0 on 1st
    play('K+WP'); runnerPopup({ 0: 1, batter: 0 }); // runner to 2nd, batter to 1st
    eq('runner on 2nd', onB('visiting', 0, 1), 0);
    eq('batter on 1st', onB('visiting', 0, 0), 3);
    eq('the runner kept his advancement', ab('visiting', 0, 0).bases[1], true);
    basesConsistent('visiting', 0);
  });

  test('the DP outcome popup blocks a runner holding the base the batter takes', () => {
    sel('visiting', 0, 0);
    play('1B');                                    // p0 on 1st
    promptPositionPlay('FC ');
    positionPopup('6');                            // fielder's choice: batter is safe at 1st
    ok('the runner cannot hold 1st', ocBtn(0, 'safe', 0).disabled);
    ok('2nd is still offered', !ocBtn(0, 'safe', 1).disabled);
    ok('out at 2nd is still offered', !ocBtn(0, 'out', 1).disabled);
    outcomePopup({ 0: ['safe', 1], batter: ['safe', 0] });
    eq('runner on 2nd', onB('visiting', 0, 1), 0);
    eq('batter on 1st', onB('visiting', 0, 0), 3);
  });

  test('the DP outcome popup offers a hold but will not confirm one out', () => {
    sel('visiting', 0, 0);
    play('1B');                                    // p0 on 1st
    promptPositionPlay('DP ');
    positionPopup('6-4-3');                        // batter is out by default on a DP
    // Holding 1st collides with nobody — the batter is out, so the base is free.
    // It is still not a double play, and Confirm says so (C2).
    ok('holding 1st is allowed', !ocBtn(0, 'safe', 0).disabled);
    outcomePopup({ 0: ['safe', 0] });
    ok('the refusal is shown', visible('play-reject'));
    ok('the popup is still open', visible('outcome-popup'));
    eq('no outs reached state', inn('visiting', 0).outs, 0);
    eq('the runner is untouched', onB('visiting', 0, 0), 0);
  });

  // C2 — the popup used to default every runner to a green "Safe" and require no
  // selection, so Confirming a `DP 6-4-3` straight off recorded one out and
  // *advanced* the forced runner. The card asserted a double play while the state
  // recorded the opposite of its second out, leaving the inning an out short.
  test('a DP confirmed on its own defaults records two outs', () => {
    sel('visiting', 0, 0);
    play('1B');                                    // p0 on 1st
    promptPositionPlay('DP ');
    positionPopup('6-4-3');
    outcomePopup({});                              // Confirm, nothing touched
    eq('outs', inn('visiting', 0).outs, 2);
    eq('outs recorded on the play', ab('visiting', 3, 0).outsRecorded, 2);
    eq('the forced runner did not advance', onB('visiting', 0, 1), null);
    eq('and is off 1st', onB('visiting', 0, 0), null);
  });

  test('a TP confirmed on its own defaults records three outs', () => {
    sel('visiting', 0, 0);
    play('1B');                                    // p0 on 1st
    play('1B'); runnerPopup({ 0: 1, batter: 0 });   // p2 on 1st, p0 to 2nd
    promptPositionPlay('TP ');
    positionPopup('5-4-3');
    outcomePopup({});                              // Confirm, nothing touched
    eq('outs', inn('visiting', 0).outs, 3);
    eq('bases are empty', occupants('visiting', 0).length, 0);
  });

  test('a DP with nobody forced needs the scorer to name the second out', () => {
    sel('visiting', 0, 0);
    play('2B');                                    // p0 on 2nd — not a forced runner
    promptPositionPlay('DP ');
    positionPopup('8-6');
    // Nothing off the force chain to default, so the popup opens one out short.
    outcomePopup({});
    ok('the refusal is shown', visible('play-reject'));
    eq('no outs reached state', inn('visiting', 0).outs, 0);
    // Naming the tag out is accepted.
    outcomePopup({ 1: ['out', 2] });
    eq('outs', inn('visiting', 0).outs, 2);
  });

  // M4 — an FC's out count was capped at 3 like anything that isn't a DP or a TP, so
  // a `FC 6` with two on took the batter and both runners and recorded a triple play
  // under a fielder's choice's label. One out is what the play is: the fielder chose
  // which man to retire.
  test('an FC cannot record three outs', () => {
    sel('visiting', 0, 0);
    play('1B');                                    // p0 on 1st
    play('1B'); runnerPopup({ 0: 1, batter: 0 });   // p3 on 1st, p0 to 2nd
    promptPositionPlay('FC ');
    positionPopup('6');
    outcomePopup({ 1: ['out', 2], 0: ['out', 1], batter: ['out'] });
    eq('one out, not three', inn('visiting', 0).outs, 1);
    eq('outs recorded on the play', ab('visiting', 6, 0).outsRecorded, 1);
  });

  test('a second out on an FC sets the first one back, and says so', () => {
    sel('visiting', 0, 0);
    play('1B');                                    // p0 on 1st
    promptPositionPlay('FC ');
    positionPopup('6');
    ocBtn('batter', 'out').onclick();               // batter out …
    ocBtn(0, 'out', 1).onclick();                   // … then the runner: two on an FC
    ok('the cap said what it did', visible('play-reject'));
    ok('and named the row it flipped',
      document.getElementById('play-reject').textContent.indexOf('batter set back to safe') >= 0);
    clickId('oc-confirm');
    eq('outs', inn('visiting', 0).outs, 1);
    eq('the runner is the out', ab('visiting', 0, 0).outOnBase, 1);
    eq('the batter took the base he was given', onB('visiting', 0, 0), 3);
  });

  test('an FC that records its one out is unaffected', () => {
    sel('visiting', 0, 0);
    play('1B');                                    // p0 on 1st
    promptPositionPlay('FC ');
    positionPopup('6');
    outcomePopup({ 0: ['out', 1], batter: ['safe', 0] });
    ok('no refusal', !visible('play-reject'));
    eq('outs', inn('visiting', 0).outs, 1);
    eq('outs recorded on the play', ab('visiting', 3, 0).outsRecorded, 1);
    eq('batter on 1st', onB('visiting', 0, 0), 3);
  });

  // The cap itself is not new for a DP — the silence was. A third out flipped a row
  // green with nothing said, which reads as a dead button.
  test('a third out on a DP sets a row back, and says so', () => {
    sel('visiting', 0, 0);
    play('1B');                                    // p0 on 1st
    play('1B'); runnerPopup({ 0: 1, batter: 0 });   // p3 on 1st, p0 to 2nd
    promptPositionPlay('DP ');
    positionPopup('5-4-3');                        // opens on batter + the forced man out
    ocBtn(1, 'out', 2).onclick();                   // a third out
    ok('the cap said what it did', visible('play-reject'));
    ok('and named the double play',
      document.getElementById('play-reject').textContent.indexOf('double play records two outs') >= 0);
    clickId('oc-confirm');
    eq('outs', inn('visiting', 0).outs, 2);
  });

  // #4 — the steal picker used to offer a base someone was already standing on.
  test('a steal into an occupied base is not offered', () => {
    sel('visiting', 0, 0);
    play('1B');
    play('1B'); runnerPopup({ 0: 1, batter: 0 });   // p0 on 2nd, p2 on 1st
    key('r');
    const labels = bpLabels();
    ok('the lead runner can steal 3rd', labels.some(l => l.indexOf('SB3 ') === 0));
    ok('the trailing runner is not offered 2nd', !labels.some(l => l.indexOf('SB2 ') === 0));
    ok('the trailing runner is not offered 1st→3rd', !labels.some(l => l.indexOf('SB2+E') === 0));
  });

  // With 2nd and 3rd occupied the only legal steal is home: 2nd→3rd is blocked and
  // so is 2nd→home on the error, which would run straight through the man on 3rd.
  // One option left, so the picker applies it directly instead of opening.
  test('a steal through an occupied base is not offered', () => {
    sel('visiting', 0, 0);
    play('3B');                                    // p0 on 3rd
    play('2B'); runnerPopup({ 2: 2, batter: 1 });   // p0 holds 3rd, p2 on 2nd
    key('r');
    eq('the runner on 3rd stole home', lsInput('visiting', 0).value, '1');
    eq('the runner on 2nd stayed put', onB('visiting', 0, 1), 3);
    eq('the runner on 2nd did not advance', ab('visiting', 3, 0).bases[2], false);
    basesConsistent('visiting', 0);
  });

  // #4 — with 3rd occupied this used to send the runner on 2nd all the way home,
  // inventing a run out of a stolen base that never happened.
  test('a blocked bulk steal does not invent a run', () => {
    sel('visiting', 0, 0);
    play('3B');                                    // p0 on 3rd
    play('2B'); runnerPopup({ 2: 2, batter: 1 });   // p0 holds 3rd, p2 on 2nd
    sel('visiting', 6, 0);
    applyRunnerEvent('SB');
    eq('R total', rTotal('visiting'), '');
    eq('the runner did not reach home', ab('visiting', 3, 0).bases[3], false);
    eq('runner still on 2nd', onB('visiting', 0, 1), 3);
    eq('runner still on 3rd', onB('visiting', 0, 2), 0);
  });

  test('a pickoff error into an occupied base is not offered', () => {
    sel('visiting', 0, 0);
    play('1B');
    play('1B'); runnerPopup({ 0: 1, batter: 0 });   // p0 on 2nd, p2 on 1st
    promptPickoff();
    const labels = bpLabels();
    ok('both runners can be picked off', labels.filter(l => /— Out$/.test(l)).length === 2);
    ok('no error advance into 2nd', !labels.some(l => /1st — Error/.test(l)));
    ok('the error advance from 2nd is offered', labels.some(l => /2nd — Error/.test(l)));
  });

  test('the move-runner popup does not offer an occupied base', () => {
    sel('visiting', 0, 0);
    play('1B');
    play('1B'); runnerPopup({ 0: 1, batter: 0 });   // p0 on 2nd, p2 on 1st
    moveRunner();
    eq('the runner on 1st is offered 3rd, home and remove', mrDests(0).join(','), '2,3,off');
    eq('the runner on 2nd is offered 3rd, home and remove', mrDests(1).join(','), '2,3,off');
    ok('neither is offered the base the other is on', mrDests(0).indexOf('1') === -1 && mrDests(1).indexOf('0') === -1);
    basesConsistent('visiting', 0);
  });

  test('changing a play type cannot double up a base', () => {
    sel('visiting', 0, 0);
    play('1B');                                    // p0 on 1st
    play('K');                                     // p2 struck out
    sel('visiting', 3, 0);
    editPlay('1B');                                // would put p2 on an occupied 1st
    eq('play unchanged', ab('visiting', 3, 0).play, 'K');
    eq('runner on 1st unchanged', onB('visiting', 0, 0), 0);
    eq('outs', inn('visiting', 0).outs, 1);
    // The refusal is judged after the old play has been taken off the card, so the
    // rollback has to put all of it back — the out log included.
    eq('out log intact', inn('visiting', 0).outsLog.length, 1);
    eq('the out number is still on his cell', ab('visiting', 3, 0).out, 1);
    basesConsistent('visiting', 0);
  });

  test('changing a play type to a double is allowed when 2nd is open', () => {
    sel('visiting', 0, 0);
    play('1B');                                    // p0 on 1st
    play('K');
    sel('visiting', 3, 0);
    editPlay('2B', { 0: 2, batter: 1 });           // the change re-asks the runners
    eq('play', ab('visiting', 3, 0).play, '2B');
    eq('batter on 2nd', onB('visiting', 0, 1), 3);
    eq('the runner was sent to 3rd', onB('visiting', 0, 2), 0);
    eq('outs', inn('visiting', 0).outs, 0);
  });

  /* The rewritten advanceRunners / advanceForcedRunners have to move everyone the
     old chain of hand-written cases did. */

  test('a wild pitch advances every runner one base and scores from 3rd', () => {
    sel('visiting', 0, 0);
    play('3B');                                    // p0 on 3rd
    play('1B'); runnerPopup({ 2: 2, batter: 0 });   // p0 holds 3rd, p2 on 1st
    key('n');                                      // wild pitch
    eq('run scored', lsInput('visiting', 0).value, '1');
    eq('trailing runner on 2nd', onB('visiting', 0, 1), 3);
    eq('3rd empty', onB('visiting', 0, 2), null);
    basesConsistent('visiting', 0);
  });

  test('a bases-loaded walk forces in exactly one run', () => {
    sel('visiting', 0, 0);
    play('1B');
    play('1B'); runnerPopup({ 0: 1, batter: 0 });
    play('1B'); runnerPopup({ 1: 2, 0: 1, batter: 0 });   // bases loaded
    play('BB');
    eq('run scored', lsInput('visiting', 0).value, '1');
    eq('runner from 3rd scored', ab('visiting', 0, 0).bases[3], true);
    eq('1st', onB('visiting', 0, 0), 9);
    eq('2nd', onB('visiting', 0, 1), 6);
    eq('3rd', onB('visiting', 0, 2), 3);
    basesConsistent('visiting', 0);
  });

  test('a walk with 1st and 3rd occupied does not force the runner on 3rd', () => {
    sel('visiting', 0, 0);
    play('3B');                                    // p0 on 3rd
    play('1B'); runnerPopup({ 2: 2, batter: 0 });   // p0 holds 3rd, p2 on 1st
    play('BB');
    eq('no run scored', rTotal('visiting'), '');
    eq('runner still on 3rd', onB('visiting', 0, 2), 0);
    eq('forced runner on 2nd', onB('visiting', 0, 1), 3);
    eq('batter on 1st', onB('visiting', 0, 0), 6);
  });

  test('a grand slam clears the bases and scores four', () => {
    sel('visiting', 0, 0);
    play('1B');
    play('1B'); runnerPopup({ 0: 1, batter: 0 });
    play('1B'); runnerPopup({ 1: 2, 0: 1, batter: 0 });   // bases loaded
    play('HR');
    eq('runs', lsInput('visiting', 0).value, '4');
    eq('RBI', ab('visiting', 9, 0).rbi, 4);
    eq('bases empty', inn('visiting', 0).bases.filter(b => b !== null).length, 0);
  });

  /* =====================================================================
     Phase 5 — runner events go through afterStateChange.

     The four runner-event paths (SB / CS / pickoff / the bulk WP-PB-BK handler)
     used to each re-implement part of finishPlay's tail. Every case below is a
     thing that only happened on the batter's path before.
     ===================================================================== */

  // #20 — the transition after a base out has to use the one cancellable handle.
  test('a caught stealing that ends the inning arms a transition undo can cancel', () => {
    sel('visiting', 0, 0);
    play('K'); play('K');
    play('1B');                                    // p4 on 1st, p6 up
    promptCSBase();                                // single option, applies directly
    eq('outs', inn('visiting', 0).outs, 3);
    ok('a transition is pending', pendingTransitionTimer !== null);
    ok('the handle points at a live timer', timerQueued(pendingTransitionTimer));
    key('u');                                      // undo
    eq('undo cleared the handle', pendingTransitionTimer, null);
    flushTimers();
    eq('outs given back', inn('visiting', 0).outs, 2);
    eq('the half-inning did not switch', selectedCell.dataset.team, 'visiting');
  });

  // #20 — the bulk CS branch used a bare setTimeout that undo could not reach.
  test('the bulk caught-stealing path routes its transition through the same handle', () => {
    sel('visiting', 0, 0);
    play('K'); play('K');
    play('1B');
    applyRunnerEvent('CS');
    eq('outs', inn('visiting', 0).outs, 3);
    ok('a transition is pending', pendingTransitionTimer !== null);
    ok('the handle points at a live timer', timerQueued(pendingTransitionTimer));
    undoLastPlay();
    eq('undo cleared the handle', pendingTransitionTimer, null);
    flushTimers();
    eq('the half-inning did not switch', selectedCell.dataset.team, 'visiting');
  });

  // #5 — the pickoff sibling of the caught-stealing case above. Passed before this
  // phase too; it's here so routing both paths through one exit can't drop it.
  test('the game ends when the 3rd out of the top of the 9th is a pickoff', () => {
    lsInput('home', 0).value = '2';                // home leads 2-0
    updateLinescoreTotals('home');
    sel('visiting', 0, 8);                         // top of the 9th
    play('1B'); play('K'); play('K');
    promptPickoff();
    basePicker(0);
    eq('outs', inn('visiting', 8).outs, 3);
    ok('game recognised as over', gameOverShown);
  });

  // #5 — a walk-off is a run, not an out. The check only ever ran on the batter's
  // path, so a game won on a wild pitch just kept going.
  test('a walk-off wild pitch ends the game', () => {
    sel('home', 0, 8);                             // bottom of the 9th, 0-0
    play('3B');                                    // p0 on 3rd
    ok('not over yet', !gameOverShown);
    key('n');                                      // wild pitch scores him
    eq('run scored', lsInput('home', 8).value, '1');
    ok('game recognised as over', gameOverShown);
  });

  test('a walk-off steal of home ends the game', () => {
    sel('home', 0, 8);
    play('3B');
    promptSBBase();                                // only SBH is on offer
    eq('run scored', lsInput('home', 8).value, '1');
    ok('game recognised as over', gameOverShown);
  });

  test('a tying run in the bottom of the 9th does not end the game', () => {
    lsInput('visiting', 0).value = '1';
    updateLinescoreTotals('visiting');
    sel('home', 0, 8);
    play('3B');
    key('n');                                      // ties it 1-1
    eq('run scored', lsInput('home', 8).value, '1');
    ok('game still going', !gameOverShown);
  });

  // #3 / #13 plumbing — the SB path never recomputed the pitcher's line, so a run
  // stolen home (and any ER-review flag it raises) went unrecorded until the next
  // completed at-bat happened to refresh it.
  test('a run stolen home is charged to the pitcher immediately', () => {
    sel('visiting', 0, 0);
    play('3B');
    promptSBBase();                                // SBH
    eq('run on the line', lsInput('visiting', 0).value, '1');
    eq('pitcher charged the run', pStat('visiting', 0, 'r'), '1');
  });

  // `inn.lob` was written only when a batter made the 3rd out; a base out left it
  // to whatever updateLinescoreTotals' own scan happened to produce. Both write it
  // today — that's #16, Phase 6 — so this pins the value while they still disagree.
  test('a half-inning ended by a caught stealing still records LOB', () => {
    sel('visiting', 0, 0);
    play('K'); play('K');
    play('1B');                                    // p4 on 1st
    play('1B'); runnerPopup({ 0: 1, batter: 0 });   // p4 to 2nd, p6 on 1st
    promptCSBase();
    basePicker(0);                                 // CS the trailing runner off 1st
    eq('outs', inn('visiting', 0).outs, 3);
    eq('one runner stranded', inn('visiting', 0).lob, 1);
  });

  /* =====================================================================
     Phase 6 — recompute instead of patch.

     Outs, bases, runs and LOB are derived from the at-bat records and the out
     log by `recomputeInning`, which every mutator ends with. The cases below are
     the ones the per-mutator patching got wrong.
     ===================================================================== */

  // #16 — LOB had two writers. `updateLinescoreTotals` scanned every at-bat that
  // had reached and not scored, in innings still being played, so it climbed as
  // runners reached and dropped as they scored. Nobody is left on base until the
  // half-inning is over.
  test('LOB is nothing until the half-inning ends', () => {
    sel('visiting', 0, 0);
    play('1B');
    eq('no LOB with a man on and the inning live', inn('visiting', 0).lob, 0);
    eq('no LOB on the linescore either', lobTotal('visiting'), '');
    play('1B'); runnerPopup({ 0: 1, batter: 0 });
    eq('still none with two on', inn('visiting', 0).lob, 0);
    play('K'); play('K'); play('K');
    eq('two stranded once it ends', inn('visiting', 0).lob, 2);
    eq('and on the linescore', lobTotal('visiting'), '2');
  });

  test('a runner who scores is not left on base', () => {
    sel('visiting', 0, 0);
    play('3B');
    play('1B'); runnerPopup({ 2: 3, batter: 0 });   // run scores, batter on 1st
    play('K'); play('K'); play('K');
    eq('run scored', lsInput('visiting', 0).value, '1');
    eq('one stranded, not two', inn('visiting', 0).lob, 1);
    eq('linescore LOB', lobTotal('visiting'), '1');
  });

  test('LOB accumulates across innings', () => {
    sel('visiting', 0, 0);
    play('1B'); play('K'); play('K'); play('K');
    flushTimers();                                  // to the bottom of the 1st
    sel('visiting', 0, 1);                          // top of the 2nd
    play('2B');
    play('1B'); runnerPopup({ 1: 2, batter: 0 });
    play('K'); play('K'); play('K');
    eq('1st inning', inn('visiting', 0).lob, 1);
    eq('2nd inning', inn('visiting', 1).lob, 2);
    eq('three left on for the game', lobTotal('visiting'), '3');
  });

  // M2 — the only test for "the half-inning is over" was `outs >= 3`, so a walk-off
  // — a half that ends on a run, nobody out, men still standing — left nobody on
  // base. Official scoring counts them.
  test('runners standing when a walk-off lands are left on base', () => {
    sel('home', 0, 8);                              // bottom of the 9th, 0-0
    play('3B');                                     // p0 on 3rd
    play('1B'); runnerPopup({ 2: 3, batter: 0 });   // he scores it, batter on 1st
    eq('the winning run is in', lsInput('home', 8).value, '1');
    ok('game recognised as over', gameOverShown);
    eq('and it ended with nobody out', inn('home', 8).outs, 0);
    eq('the man on 1st was left there', inn('home', 8).lob, 1);
    eq('and the line says so', lobTotal('home'), '1');
  });

  test('a run that only ties the last inning leaves the half-inning live', () => {
    lsInput('visiting', 0).value = '1';
    updateLinescoreTotals('visiting');
    sel('home', 0, 8);
    play('3B');
    play('1B'); runnerPopup({ 2: 3, batter: 0 });   // 1-1, batter on 1st
    ok('game still going', !gameOverShown);
    eq('nobody is left on yet', inn('home', 8).lob, 0);
    eq('nor on the line', lobTotal('home'), '');
  });

  // The walk-off clause is the home half's alone: the visiting team going ahead in
  // the top of the last inning ends nothing.
  test('the visiting team going ahead in the 9th does not strand its runners', () => {
    sel('visiting', 0, 8);                          // top of the 9th
    play('HR');                                     // visiting 1-0
    play('1B');                                     // a man on, still nobody out
    eq('ahead', rTotal('visiting'), '1');
    eq('the inning is still being played', inn('visiting', 8).lob, 0);
  });

  /* M1 — nothing marked the card as closed once the game was final. After a
     walk-off another home run was accepted and moved R from 1 to 2 with no sign
     anything unusual had happened. Per D6 the entry is still allowed — a scorer
     does have to correct a final card — but it says so once, and the card carries
     a standing FINAL. */
  test('an entry made after a walk-off is accepted, with one notice', () => {
    sel('home', 0, 8);
    play('HR');                                     // walk-off, 1-0
    ok('game recognised as over', gameOverShown);
    ok('no notice for the play that ended it', !visible('play-reject'));
    sel('home', 3, 8);
    play('HR');                                     // the extra one
    eq('it was recorded', rTotal('home'), '2');
    ok('and the card said so', visible('play-reject'));
    eq('as a notice, not a refusal', document.getElementById('play-reject').dataset.tone, 'notice');
    // Once. A second correction on the same final card doesn't nag.
    document.getElementById('play-reject').style.display = 'none';
    sel('home', 6, 8);
    play('1B');
    ok('no second notice', !visible('play-reject'));
  });

  test('the live panel reads FINAL after a walk-off, and keeps reading it', () => {
    sel('home', 0, 8);
    play('HR');
    eq('the panel', document.getElementById('ls-inning').textContent, 'FINAL');
    eq('with the score', document.getElementById('ls-count').textContent, '0-1');
    // The one writer that repaints on every selection used to overwrite it, so the
    // marker survived until the scorer's next tap and no further.
    sel('visiting', 6, 2);
    eq('still FINAL after selecting an earlier cell', document.getElementById('ls-inning').textContent, 'FINAL');
  });

  test('a tied bottom of the last inning does not read FINAL', () => {
    lsInput('visiting', 0).value = '1';
    updateLinescoreTotals('visiting');
    sel('home', 0, 8);
    play('HR');                                     // ties it 1-1, headed for extras
    ok('game still going', !gameOverShown);
    eq('the panel', document.getElementById('ls-inning').textContent, '▼ 9');
  });

  // Derived, not remembered: taking the winning run back off the card puts the
  // panel back to the inning being played, with nothing having to clear a flag.
  test('clearing the winning run takes FINAL back off the card', () => {
    sel('home', 0, 8);
    play('HR');
    eq('final', document.getElementById('ls-inning').textContent, 'FINAL');
    sel('home', 0, 8);                              // back onto the home run itself
    clearSelectedCell();
    eq('no runs left', rTotal('home'), '');
    eq('the panel is live again', document.getElementById('ls-inning').textContent, '▼ 9');
  });

  // M1's folded-in leftover: Clear is reachable past the popup backdrop through the
  // `c` hotkey, and it deleted the play the popup was still deciding — leaving the
  // popup up over an empty cell, and `entryInProgress()` then refusing every other
  // entry until it was answered.
  test('Clear is refused while a runner popup is open', () => {
    sel('visiting', 0, 0);
    play('1B');                                     // p0 on 1st
    play('1B');                                     // opens the runner popup
    ok('the popup is open', visible('runner-popup'));
    key('c');                                       // CLR All, past the backdrop
    ok('the refusal is shown', visible('play-reject'));
    ok('the popup is still open', visible('runner-popup'));
    eq('the play is still there', ab('visiting', 3, 0).play, '1B');
    // And answering it still works — the refusal is not a lockup.
    runnerPopup({ 0: 1, batter: 0 });
    eq('runner on 2nd', onB('visiting', 0, 1), 0);
    eq('batter on 1st', onB('visiting', 0, 0), 3);
  });

  // H1 — E was a hand-typed input while R, H and LOB were all derived, so the card
  // read `E: ""` after an E5 and the box score never reconciled. Errors are recorded
  // on the card of the team that was batting, so the count belongs to the other team.
  test('an error charges E to the fielding team, not the batting team', () => {
    sel('visiting', 0, 0);
    play('E5');
    eq('the home fielders wear it', eTotal('home'), '1');
    eq('the batting team has none', eTotal('visiting'), '');
  });

  test('E is nothing until an error happens', () => {
    sel('visiting', 0, 0);
    play('1B');
    eq('a clean single charges nobody', eTotal('home'), '');
  });

  test('E adds up across errors and innings', () => {
    sel('visiting', 0, 0);
    play('E5'); play('K'); play('K'); play('K');
    flushTimers();                                  // to the bottom of the 1st
    sel('visiting', 0, 1);                          // top of the 2nd
    play('E');
    eq('two errors by the home team', eTotal('home'), '2');
  });

  // A throwing error on a steal leaves no error play on any cell — it is recorded
  // only as an 'E' advancement reason — so a scan of plays alone would miss it.
  test('a throwing error on a steal reaches the linescore', () => {
    sel('visiting', 0, 0);
    play('1B');
    applySBAtBase('visiting', 0, 0, true);          // steals 2nd, takes 3rd on the throw
    eq('the error is charged', eTotal('home'), '1');
    eq('the steal itself is not an error', ab('visiting', 0, 0).advReason[1], 'SB');
  });

  test('a throwing error on a pickoff reaches the linescore', () => {
    sel('visiting', 0, 0);
    play('1B');
    applyPickoff('visiting', 0, 0, true);           // bad throw, runner takes 2nd
    eq('the error is charged', eTotal('home'), '1');
  });

  // Two physical errors on one man's card: he reached on a fielding error, then took
  // an extra base on a throwing error. Both count (D3 — count every signal).
  test('one player can be the subject of two errors', () => {
    sel('visiting', 0, 0);
    play('E5');
    applySBAtBase('visiting', 0, 0, true);
    eq('both errors are charged', eTotal('home'), '2');
  });

  // The runner-popup out path stamps the *batter's* play as the advancement reason,
  // so a runner thrown out during an E5 carries 'E5' — a label for the error already
  // counted, not a second error. Only the exact string 'E' is a second signal.
  test('a runner retired on the error play does not double the count', () => {
    sel('visiting', 0, 0);
    play('1B');
    play('E5'); runnerPopup({ 0: -2, batter: 0 });  // lead runner out at 2nd
    eq('one error, not two', eTotal('home'), '1');
  });

  test('clearing the error play takes E back off the board', () => {
    sel('visiting', 0, 0);
    play('E5');
    eq('charged', eTotal('home'), '1');
    sel('visiting', 0, 0);                          // the play advanced the batter
    clearSelectedCell();
    eq('and back off', eTotal('home'), '');
  });

  test('the derived E is what gets persisted', () => {
    clearStorage();
    try {
      sel('visiting', 0, 0);
      play('E5');
      flushSave();
      const back = mergeStateDefaults(JSON.parse(safeStorage.getItem(CURRENT_GAME_KEY)));
      eq('charged to the fielders in storage', back.linescore.home.e, '1');
      eq('and not to the batting team', back.linescore.visiting.e, '');
    } finally { clearStorage(); }
  });

  // A save from an older build carries whatever the scorer typed into the old manual
  // box. The records are the authority now, so a recompute has to correct it — the
  // same reasoning that re-derives LOB on load.
  test('a stale hand-typed E is corrected, not kept', () => {
    sel('visiting', 0, 0);
    play('E5');
    document.querySelector('input[data-ls="home"][data-stat="e"]').value = '9';
    updateLinescoreErrors();
    eq('the card wins', eTotal('home'), '1');
  });

  // #22 — the change wrote the batter's four bases and stopped, so the runners a
  // home run had just cleared were still standing on their bases: a three-run
  // homer that scored one.
  test('changing a play to a home run brings the runners round with him', () => {
    sel('visiting', 0, 0);
    play('1B');
    play('1B'); runnerPopup({ 0: 1, batter: 0 });    // p0 on 2nd, p2 on 1st
    play('K');                                       // p4 strikes out
    sel('visiting', 6, 0);
    editPlay('HR');
    eq('three runs', lsInput('visiting', 0).value, '3');
    eq('three RBI', ab('visiting', 6, 0).rbi, 3);
    eq('lead runner scored', ab('visiting', 0, 0).bases[3], true);
    eq('trailing runner scored', ab('visiting', 3, 0).bases[3], true);
    eq('bases empty', JSON.stringify(inn('visiting', 0).bases), '[null,null,null]');
    eq('the out came off', inn('visiting', 0).outs, 0);
  });

  test('changing a home run back to a strikeout empties the bases again', () => {
    sel('visiting', 0, 0);
    play('1B');
    sel('visiting', 3, 0);
    play('HR');
    eq('two runs', lsInput('visiting', 0).value, '2');
    sel('visiting', 3, 0);
    editPlay('K');
    eq('the batter is not on a base', onB('visiting', 0, 0), 0);
    eq('one out', inn('visiting', 0).outs, 1);
    // The rest of #22: the home run's advancement comes back off too, so the
    // runner it brought round is back on the base he was standing on and the run
    // is off the board. A strikeout advances nobody, so there is nothing to re-ask.
    eq('the runner he drove in goes back to 1st', ab('visiting', 0, 0).bases[3], false);
    eq('no runs', lsInput('visiting', 0).value, '');
    eq('no RBI', ab('visiting', 3, 0).rbi, 0);
  });

  /* The rest of #22. A change of play type used to adjust the batter's own bases
     and out and nothing else: the runners it had moved stayed where the old play
     put them, and the new play never asked where they should go instead. */

  test('a hit rewritten as a strikeout takes back the bases it gave', () => {
    sel('visiting', 0, 0);
    play('1B');                                      // p0 on 1st
    play('1B'); runnerPopup({ 0: 2, batter: 0 });     // p0 sent to 3rd, p2 on 1st
    sel('visiting', 3, 0);
    editPlay('K');                                   // a strikeout advances nobody
    eq('the runner goes back to 1st', onB('visiting', 0, 0), 0);
    eq('nobody on 3rd', onB('visiting', 0, 2), null);
    eq('the batter is off the bases', occupants('visiting', 0).join(','), '0');
    eq('one out', inn('visiting', 0).outs, 1);
    eq('his cell shows only the base he earned', JSON.stringify(ab('visiting', 0, 0).bases), '[true,false,false,false]');
  });

  test('a hit rewritten as a sacrifice re-asks where the runner went', () => {
    sel('visiting', 0, 0);
    play('1B');                                      // p0 on 1st
    play('1B'); runnerPopup({ 0: 1, batter: 0 });     // p0 to 2nd, p2 on 1st
    sel('visiting', 3, 0);
    // The single's advancement comes off first, so the popup asks from 1st — and
    // this time the sacrifice moves him to 2nd rather than the single doing it.
    editPlay('SH', { 0: 1 });
    eq('the runner is on 2nd', onB('visiting', 0, 1), 0);
    eq('the batter is out', inn('visiting', 0).outs, 1);
    eq('nobody else on base', occupants('visiting', 0).join(','), '0');
    // The advance is stamped to the new play, so clearing it takes it back again.
    eq('stamped to the batter who sacrificed', JSON.stringify(ab('visiting', 0, 0).advSrc[1]), '{"p":3,"col":0}');
  });

  test('a strikeout rewritten as a double play is judged on the outs left', () => {
    sel('visiting', 0, 0);
    play('1B');                                      // p0 on 1st
    play('K'); play('K');                            // 2 outs
    sel('visiting', 3, 0);
    // Legal: this cell's own out comes off first, leaving one out and a runner to
    // double off. Entered as a DP it makes both outs, ending the inning.
    editPlayCustom('DP 6-4-3', { 0: ['out', 1], batter: ['out'] });
    eq('play', ab('visiting', 3, 0).play, 'DP 6-4-3');
    eq('three outs', inn('visiting', 0).outs, 3);
    eq('out log', inn('visiting', 0).outsLog.length, 3);
    eq('the runner is off the bases', occupants('visiting', 0).length, 0);
    eq('IP', pStat('visiting', 0, 'ip'), '1');
  });

  test('a double play with no room for its second out is refused and rolled back', () => {
    sel('visiting', 0, 0);
    play('1B');                                      // p0 on 1st
    play('K'); play('K');                            // 2 outs, made by p2 and p4
    sel('visiting', 0, 0);
    editPlayCustom('DP 6-4-3');                      // p0's single made neither out
    eq('play unchanged', ab('visiting', 0, 0).play, '1B');
    eq('outs unchanged', inn('visiting', 0).outs, 2);
    eq('out log intact', inn('visiting', 0).outsLog.length, 2);
    eq('the runner is still on 1st', onB('visiting', 0, 0), 0);
  });

  // #23 — the zero for a scoreless completed inning was looked up by real inning
  // and written to state by column index. After batting around those differ, and a
  // save landing before the next totals pass persisted the zero one inning out.
  test('the auto-zero for a scoreless inning is stored against the real inning', () => {
    sel('visiting', 0, 0);
    for (let i = 0; i < 9; i++) play('BB');          // bats around, spills into col 1
    eq('column 1 is still the 1st inning', getRealInning('visiting', 1), 0);
    play('K'); play('K'); play('K');                 // ends the 1st
    flushTimers();
    eq('the 2nd inning is column 2', getRealInning('visiting', 2), 1);
    sel('visiting', 0, 2);
    play('K'); play('K'); play('K');                 // scoreless 2nd
    const ls = gameState.linescore.visiting.innings;
    eq('the zero is on the 2nd inning', ls[1], '0');
    eq('nothing written past the innings played', ls[2], '');
  });

  // The Phase 3 known limitation: a batted-around inning keeps outs on every one
  // of its columns, and an edit in the earlier column used to move only that
  // column's count. The recompute writes the whole inning.
  test('clearing a play in the earlier column of a batted-around inning fixes the whole inning', () => {
    sel('visiting', 0, 0);
    play('K');                                       // out 1, column 0
    for (let i = 0; i < 8; i++) play('BB');           // fills column 0, spills to col 1
    eq('overflowed', curCol(), 1);
    play('K');                                        // out 2, column 1
    eq('outs on the overflow column', inn('visiting', 1).outs, 2);
    eq('outs on the first column', inn('visiting', 0).outs, 2);
    sel('visiting', 0, 0);
    clearSelectedCell();                              // clear the strikeout in column 0
    eq('one out left, first column', inn('visiting', 0).outs, 1);
    eq('one out left, overflow column', inn('visiting', 1).outs, 1);
    eq('log for the inning', inningOutsLog('visiting', 0).length, 1);
    eq('IP', pStat('visiting', 0, 'ip'), '0.1');
  });

  // Clearing an older play took its outs off the log in Phase 3; the inning's
  // bases had to be patched by hand, and a runner the play had put on stayed on.
  test('clearing an older play takes its runner off the bases', () => {
    sel('visiting', 0, 0);
    play('1B');                                      // p0 on 1st
    play('K'); play('K');                            // two outs after it
    sel('visiting', 0, 0);
    clearSelectedCell();
    eq('bases empty', JSON.stringify(inn('visiting', 0).bases), '[null,null,null]');
    eq('outs untouched', inn('visiting', 0).outs, 2);
  });

  // #21's other half — the play's outs came off in Phase 3, but the bases it had
  // handed the runners ahead of it stayed marked, so a runner it had driven to 2nd
  // was still standing there with nothing on the card that put him there.
  test('clearing an older play sends the runners it moved back', () => {
    sel('visiting', 0, 0);
    play('1B');                                      // p0 on 1st
    play('1B'); runnerPopup({ 0: 1, batter: 0 });     // p2 singles, p0 to 2nd
    play('K');                                       // an out after it, so it isn't the latest
    sel('visiting', 3, 0);
    clearSelectedCell();                             // clear p2's single
    eq('the runner is back on 1st', onB('visiting', 0, 0), 0);
    eq('nobody on 2nd', onB('visiting', 0, 1), null);
    eq('his 2nd-base mark is gone', ab('visiting', 0, 0).bases[1], false);
    eq('he keeps the base he singled to', ab('visiting', 0, 0).bases[0], true);
    eq('the batter is gone from the card', ab('visiting', 3, 0).play, '');
  });

  test('clearing an older play leaves a base the runner stole', () => {
    sel('visiting', 0, 0);
    play('1B');                                      // p0 on 1st
    promptSBBase(); basePicker(0);                    // steals 2nd — his own, not a play's
    play('1B'); runnerPopup({ 1: 2, batter: 0 });     // p2 singles, p0 to 3rd
    play('K');
    sel('visiting', 3, 0);
    clearSelectedCell();
    eq('back on the base he stole', onB('visiting', 0, 1), 0);
    eq('the stolen base is still marked', ab('visiting', 0, 0).bases[1], true);
    eq('the advance it gave him is not', ab('visiting', 0, 0).bases[2], false);
  });

  // The base a runner would go back to can be occupied by a play that only happened
  // because this one did. There is no honest answer to that, so he keeps what he was
  // given rather than sharing a base — refused loudly, like any other collision.
  test('a revert that would double up a base is refused, not forced', () => {
    sel('visiting', 0, 0);
    play('1B');                                      // p0 on 1st
    play('1B'); runnerPopup({ 0: 3, batter: 0 });     // p2 singles p0 home, p2 to 1st
    play('1B'); runnerPopup({ 0: 1, batter: 0 });     // p4 singles, p2 to 2nd, p4 to 1st
    play('K');                                       // so p2's single isn't the latest
    eq('a run scored', lsInput('visiting', 0).value, '1');
    sel('visiting', 3, 0);
    clearSelectedCell();                             // clear the single that drove p0 in
    // p0 would go back to 1st, but p4 is standing there off a later single.
    eq('p0 keeps the run', ab('visiting', 0, 0).bases[3], true);
    eq('the run stays on the board', lsInput('visiting', 0).value, '1');
    eq('p4 keeps 1st', onB('visiting', 0, 0), 6);
    eq('p2 is off the card, so 2nd is empty', onB('visiting', 0, 1), null);
    eq('nobody shares a base', new Set(occupants('visiting', 0)).size, 1);
  });

  // The same shape without the third play: the cleared batter's own base is free,
  // because he is coming off the card, so the runner does go back to it.
  test('a runner goes back onto the base the cleared batter was standing on', () => {
    sel('visiting', 0, 0);
    play('1B');                                      // p0 on 1st
    play('1B'); runnerPopup({ 0: 3, batter: 0 });     // p2 singles p0 home, p2 to 1st
    play('K');
    sel('visiting', 3, 0);
    clearSelectedCell();
    eq('p0 is back on 1st', onB('visiting', 0, 0), 0);
    eq('his run came off', ab('visiting', 0, 0).bases[3], false);
    eq('and off the linescore', lsInput('visiting', 0).value, '');
  });

  // #C3: `recomputeInning` owns outs, bases, runs and LOB but not `ab.rbi`, which is
  // frozen at entry — so a run taken off an older play used to leave the batter
  // credited with driving in a run that no longer existed, and team RBI could run
  // ahead of team R.
  test('clearing the man who scored takes the RBI off the batter who drove him in', () => {
    sel('visiting', 0, 0);
    play('1B');                                      // p0 on 1st
    play('HR');                                      // p2 drives him in and himself
    eq('two runs', lsInput('visiting', 0).value, '2');
    eq('two RBI', ab('visiting', 3, 0).rbi, 2);
    sel('visiting', 0, 0);
    clearSelectedCell();                             // the man who scored comes off
    eq('one run left', lsInput('visiting', 0).value, '1');
    eq('and one RBI', ab('visiting', 3, 0).rbi, 1);
  });

  test('rewriting the man who scored as an out takes the RBI with it', () => {
    sel('visiting', 0, 0);
    play('1B');
    play('HR');
    sel('visiting', 0, 0);
    editPlay('K');                                   // the leadoff single never happened
    eq('only the home run scored', lsInput('visiting', 0).value, '1');
    eq('so one RBI', ab('visiting', 3, 0).rbi, 1);
  });

  // The run is stamped to the play that drove it in, so clearing a play in the
  // middle of the chain debits the right batter: p4's single loses its RBI because
  // p0 is no longer standing on 2nd to be driven in from.
  test('clearing a play that only set up a run debits the batter who drove it in', () => {
    sel('visiting', 0, 0);
    play('1B');                                      // p0 on 1st
    play('1B'); runnerPopup({ 0: 1, batter: 0 });     // p2 singles, p0 to 2nd
    play('1B'); runnerPopup({ 1: 3, 0: 1, batter: 0 });  // p4 singles p0 home, p2 to 2nd
    eq('p4 has the RBI', ab('visiting', 6, 0).rbi, 1);
    sel('visiting', 3, 0);
    clearSelectedCell();                             // clear the single that moved p0 up
    eq('the run came off', lsInput('visiting', 0).value, '');
    eq('so did the RBI', ab('visiting', 6, 0).rbi, 0);
  });

  // A scorer's manual RBI override is not contradicted by a run that is still on the
  // board — only lost runs debit anybody.
  test('an unrelated clear leaves a credited RBI alone', () => {
    sel('visiting', 0, 0);
    play('1B');
    play('1B'); runnerPopup({ 0: 3, batter: 0 });     // p2 singles p0 home
    play('K');
    sel('visiting', 6, 0);
    clearSelectedCell();                             // clear the strikeout
    eq('the run stands', lsInput('visiting', 0).value, '1');
    eq('and so does the RBI', ab('visiting', 3, 0).rbi, 1);
  });

  test('clearing a double play gives back both outs and the runner', () => {
    sel('visiting', 0, 0);
    play('1B');                                      // p0 on 1st
    promptPositionPlay('DP ');
    positionPopup('6-4-3');
    outcomePopup({ 0: ['out', 1], batter: ['out'] });
    play('K');                                       // 3rd out, so the DP isn't the latest
    eq('three outs', inn('visiting', 0).outs, 3);
    sel('visiting', 3, 0);
    clearSelectedCell();                             // clear the double play
    eq('one out left', inn('visiting', 0).outs, 1);
    eq('the runner is back on 1st', onB('visiting', 0, 0), 0);
    eq('he is not out any more', ab('visiting', 0, 0).out, 0);
    eq('nor out on the bases', ab('visiting', 0, 0).outOnBase, null);
  });

  // Clear-and-keep-pitches rebuilt the inning from "the last undo snapshot", three
  // lines after taking that snapshot itself — so it restored the state onto itself
  // and cleared nothing but the result pitch.
  test('clearing a play but keeping its pitches clears the play', () => {
    sel('visiting', 0, 0);
    pitch('S'); pitch('B');
    play('1B');
    eq('the result pitch was added', ab('visiting', 0, 0).pitches.join(''), 'SBH');
    sel('visiting', 0, 0);
    clearPlayKeepPitches();
    eq('play cleared', ab('visiting', 0, 0).play, '');
    eq('batter off the bases', onB('visiting', 0, 0), null);
    eq('his own cell is blank', JSON.stringify(ab('visiting', 0, 0).bases), '[false,false,false,false]');
    eq('the pitches he saw are kept, less the result pitch', ab('visiting', 0, 0).pitches.join(''), 'SB');
  });

  test('clearing a play but keeping its pitches gives back its out', () => {
    sel('visiting', 0, 0);
    play('K'); play('K');
    sel('visiting', 3, 0);
    clearPlayKeepPitches();
    eq('one out left', inn('visiting', 0).outs, 1);
    eq('out log', inn('visiting', 0).outsLog.length, 1);
    eq('IP', pStat('visiting', 0, 'ip'), '0.1');
  });

  test('clearing a play but keeping its pitches also sends the runners back', () => {
    sel('visiting', 0, 0);
    play('1B');
    sel('visiting', 3, 0);
    pitch('S'); pitch('B');
    play('1B'); runnerPopup({ 0: 1, batter: 0 });     // p0 to 2nd
    play('K'); play('K');                            // no longer the latest play
    sel('visiting', 3, 0);
    clearPlayKeepPitches();
    eq('the runner is back on 1st', onB('visiting', 0, 0), 0);
    eq('pitches kept', ab('visiting', 3, 0).pitches.join(''), 'SB');
    eq('play cleared', ab('visiting', 3, 0).play, '');
  });

  // The #21 shape in the one path Phase 6 didn't rewire: the outs came off the log
  // but the runner doubled off kept his out number and `outOnBase`, so he stayed
  // off the bases with nothing recording that he was out.
  test('clearing a double play but keeping its pitches un-outs the runner too', () => {
    sel('visiting', 0, 0);
    play('1B');                                      // p0 on 1st
    promptPositionPlay('DP ');
    positionPopup('6-4-3');
    outcomePopup({ 0: ['out', 1], batter: ['out'] });
    eq('two outs', inn('visiting', 0).outs, 2);
    sel('visiting', 3, 0);
    clearPlayKeepPitches();
    eq('both outs came off', inn('visiting', 0).outs, 0);
    eq('out log empty', inn('visiting', 0).outsLog.length, 0);
    eq('the runner has no out number', ab('visiting', 0, 0).out, 0);
    eq('and was not put out on the bases', ab('visiting', 0, 0).outOnBase, null);
    eq('so he is back on 1st', onB('visiting', 0, 0), 0);
    eq('IP', pStat('visiting', 0, 'ip'), '');
  });

  // Loading a game re-derives every inning that has records, which is what fixes a
  // save written while LOB still had two disagreeing writers.
  test('a stale LOB on a saved inning is corrected from the records', () => {
    sel('visiting', 0, 0);
    play('1B'); play('K'); play('K'); play('K');
    inn('visiting', 0).lob = 7;                     // what an older build could store
    recomputeInning('visiting', 0);
    eq('corrected from the records', inn('visiting', 0).lob, 1);
  });

  // The load-time recompute is scoped to innings with records: an empty inning has
  // nothing to derive and its linescore cell may have been filled in by hand.
  test('an inning nobody batted in has no records to recompute from', () => {
    ok('the 5th is empty', !inningHasRecords('visiting', 4));
    sel('visiting', 0, 0);
    play('1B');
    ok('the 1st has records', inningHasRecords('visiting', 0));
    sel('visiting', 3, 0);
    pitch('B');
    ok('pitches alone count as records', inningHasRecords('visiting', 0));
  });

  // A recompute that disagreed with a live play would be a regression, not a fix:
  // on the ordinary path it has to reproduce exactly what the play just did.
  test('recomputing an inning mid-play changes nothing', () => {
    sel('visiting', 0, 0);
    play('K');
    play('1B');
    play('2B'); runnerPopup({ 0: 2, batter: 1 });
    const before = JSON.stringify([inn('visiting', 0).outs, inn('visiting', 0).bases, inn('visiting', 0).lob]);
    recomputeInning('visiting', 0);
    eq('inning state unchanged', JSON.stringify([inn('visiting', 0).outs, inn('visiting', 0).bases, inn('visiting', 0).lob]), before);
    eq('runs unchanged', lsInput('visiting', 0).value, '');
  });

  /* =====================================================================
     Phase 8a — box-score rules
     ===================================================================== */

  // #11 — `placeBatter` is the only thing that sets `reachedOnError`, and the
  // extra-base branch skips it, so the batter who took second on the throw was
  // recorded as having reached cleanly and his run counted as earned.
  test('a batter who takes an extra base on the error still reached on the error', () => {
    sel('visiting', 0, 0);
    play('1B');                                     // p0 on 1st
    play('E6'); runnerPopup({ 0: 2, batter: 1 });   // p0 to 3rd, batter takes 2nd
    eq('the batter is on 2nd', onB('visiting', 0, 1), 3);
    ok('and his card is charged to the error', ab('visiting', 3, 0).reachedOnError);
  });

  test('a batter held at first on the error is charged to it too', () => {
    sel('visiting', 0, 0);
    play('E6');
    ok('reached on the error', ab('visiting', 0, 0).reachedOnError);
  });

  // #12 — Rule 9.04(b)(1).
  test('a run that scores on a double play is nobody\'s RBI', () => {
    sel('visiting', 0, 0);
    play('3B');                                     // p0 on 3rd
    play('1B'); runnerPopup({ 2: 2, batter: 0 });   // p2 on 1st, p0 holds 3rd
    promptPositionPlay('DP ');
    positionPopup('6-4-3');
    outcomePopup({ 2: ['safe', 3], 0: ['out', 1], batter: ['out'] });
    eq('the run is on the board', lsInput('visiting', 0).value, '1');
    eq('but the double play earns no RBI', ab('visiting', 6, 0).rbi, 0);
  });

  // A fielder's choice is not covered by the rule — that run is the batter's.
  test('a run that scores on a fielder\'s choice is still an RBI', () => {
    sel('visiting', 0, 0);
    play('3B');                                     // p0 on 3rd
    play('1B'); runnerPopup({ 2: 2, batter: 0 });   // p2 on 1st, p0 holds 3rd
    promptPositionPlay('FC ');
    positionPopup('6');
    outcomePopup({ 2: ['safe', 3], 0: ['out', 1], batter: ['safe', 0] });
    eq('the run is on the board', lsInput('visiting', 0).value, '1');
    eq('and it is his RBI', ab('visiting', 6, 0).rbi, 1);
  });

  // #12 — the other half: a run scored on the wild pitch of a K+WP came in on the
  // pitch, and the batter struck out.
  test('a run scored on the wild pitch of a K+WP is nobody\'s RBI', () => {
    sel('visiting', 0, 0);
    play('3B');                                     // p0 on 3rd
    play('K+WP'); runnerPopup({ 2: 3, batter: 0 }); // he comes home on the wild pitch
    eq('the run is on the board', lsInput('visiting', 0).value, '1');
    eq('but a strikeout drives in nobody', ab('visiting', 3, 0).rbi, 0);
  });

  // #13 — a throwing error on a steal leaves no error play on any cell, so the
  // inning read as clean: the run counted as earned and nothing asked for review.
  test('a runner who takes an extra base on a throw is charged to the error', () => {
    sel('visiting', 0, 0);
    play('1B');                                     // p0 on 1st
    promptSBBase(); basePicker(0, 'error');         // steals 2nd, throw away → 3rd
    eq('he is on 3rd', onB('visiting', 0, 2), 0);
    ok('the extra base is the error\'s', ab('visiting', 0, 0).reachedOnError);
  });

  test('a runner moved up by a throw on a pickoff is charged to the error', () => {
    sel('visiting', 0, 0);
    play('1B');                                     // p0 on 1st
    promptPickoff(); basePicker(0, 'error');        // throw away → 2nd
    eq('he is on 2nd', onB('visiting', 0, 1), 0);
    ok('charged to the error', ab('visiting', 0, 0).reachedOnError);
  });

  test('an inning whose only error was a throw on a steal still asks for ER review', () => {
    sel('visiting', 0, 0);
    play('1B');                                     // p0 on 1st
    promptSBBase(); basePicker(0, 'error');         // → 3rd
    play('1B'); runnerPopup({ 2: 3, batter: 0 });   // driven in
    ok('the inning is provisional', inningErProvisional('visiting', 0));
    eq('the run counts', pStat('visiting', 0, 'r'), '1');
    eq('but is unearned until a human says otherwise', pStat('visiting', 0, 'er'), '');
  });

  // #14 — Rule 9.16. This flagged only the runner on 3rd, so a man moved up from
  // 1st by the same passed ball scored as an earned run later.
  test('a passed ball marks every runner it moves, not just the man on 3rd', () => {
    sel('visiting', 0, 0);
    play('1B');                                     // p0 on 1st
    applyRunnerEvent('PB');
    eq('he took 2nd on the passed ball', onB('visiting', 0, 1), 0);
    ok('and the base is the passed ball\'s', ab('visiting', 0, 0).reachedOnError);
  });

  test('a wild pitch leaves the runner it moves earned', () => {
    sel('visiting', 0, 0);
    play('1B');
    applyRunnerEvent('WP');
    eq('he took 2nd', onB('visiting', 0, 1), 0);
    ok('a wild pitch is the pitcher\'s own doing', !ab('visiting', 0, 0).reachedOnError);
  });

  // #17 — Rule 9.02(a)(1): the sacrifice has to achieve something.
  test('a sacrifice fly with the bases empty is charged as an at-bat', () => {
    sel('visiting', 0, 0);
    play('SF');
    eq('a fly ball that scored nobody is an ordinary out', bStat('visiting', 0, 'ab'), '1');
  });

  test('a sacrifice fly that scores a run costs no at-bat', () => {
    sel('visiting', 0, 0);
    play('3B');                                     // p0 on 3rd
    play('SF'); runnerPopup({ 2: 3 });              // he tags and scores
    eq('the run is his RBI', ab('visiting', 3, 0).rbi, 1);
    eq('and the sacrifice costs no at-bat', bStat('visiting', 3, 'ab'), '');
  });

  test('a sacrifice bunt that moves a runner costs no at-bat', () => {
    sel('visiting', 0, 0);
    play('1B');                                     // p0 on 1st
    play('SH'); runnerPopup({ 0: 1 });              // bunted to 2nd
    eq('the bunt did its job', onB('visiting', 0, 1), 0);
    eq('so it costs no at-bat', bStat('visiting', 3, 'ab'), '');
  });

  /* =====================================================================
     Phase 10 — no inline handlers, so the CSP can forbid inline script
     ===================================================================== */

  // Every element carrying an on* attribute is a hole in `script-src 'self'`.
  function inlineHandlerAttrs(root) {
    const found = [];
    root.querySelectorAll('*').forEach(el => {
      for (const a of el.attributes) if (/^on/i.test(a.name)) found.push(el.tagName + '@' + a.name);
    });
    return found;
  }

  test('the page carries no inline event handlers', () => {
    eq('none in the markup', JSON.stringify(inlineHandlerAttrs(document.body)), '[]');
  });

  test('every data-act names a function that exists', () => {
    const names = [...new Set([...document.querySelectorAll('[data-act]')].map(e => e.dataset.act))];
    ok('there are actions to check', names.length > 20);
    eq('and all of them resolve', JSON.stringify(names.filter(n => typeof window[n] !== 'function')), '[]');
  });

  test('a quick-play button records the play through the dispatcher', () => {
    sel('visiting', 0, 0);
    touch(0);
    document.querySelector('[data-act="applyPlay"][data-arg="1B"]').click();
    eq('the single is on the card', ab('visiting', 0, 0).play, '1B');
    eq('and the runner is on 1st', onB('visiting', 0, 0), 0);
  });

  test('a string argument and a numeric argument both survive dispatch', () => {
    sel('visiting', 0, 0);
    touch(0);
    document.querySelector('[data-act="addPitch"][data-arg="S"]').click();
    eq('the string arg arrived as a strike', ab('visiting', 0, 0).pitches.join(''), 'S');
    play('1B');
    sel('visiting', 0, 0);
    document.querySelector('[data-act="adjustRBI"][data-argnum="1"]').click();
    eq('the numeric arg arrived as a number', ab('visiting', 0, 0).rbi, 1);
  });

  test('the popups app.js builds carry no inline handlers either', () => {
    sel('visiting', 0, 0);
    changePitcher();
    eq('pitcher popup is clean', JSON.stringify(inlineHandlerAttrs(document.getElementById('pitcher-popup'))), '[]');
    document.getElementById('pitcher-popup').querySelector('[data-act="setPitcher"][data-argnum="1"]').click();
    eq('and its buttons still work', inn('visiting', 0).currentPitcher, 1);
  });

  /* =====================================================================
     Phase 10 — what a screen reader gets
     ===================================================================== */

  function aria(team, p, col) {
    return document.getElementById(`cell-${team}-${p}-${col}`).getAttribute('aria-label');
  }
  function liveRegion() { return document.getElementById('a11y-live').textContent; }

  // An at-bat cell is a diamond, a play code and an out number — all graphical.
  // The label has to say the same thing in words, and stay in step with it.
  test('an empty at-bat cell says where it is', () => {
    eq('by side, order and inning', aria('visiting', 12, 3), 'Visiting, batting order 5, inning 4, empty');
    eq('and the home side says so', aria('home', 0, 0), 'Home, batting order 1, inning 1, empty');
  });

  test('the label follows the play onto the cell', () => {
    sel('visiting', 0, 0);
    play('1B');
    eq('a single, and where he is', aria('visiting', 0, 0), 'Visiting, batting order 1, inning 1: 1B, on 1st');
    play('K');
    eq('and an out is numbered', aria('visiting', 3, 0), 'Visiting, batting order 2, inning 1: K, out 1');
  });

  test('a run and its RBI are in the label', () => {
    sel('visiting', 0, 0);
    play('1B');
    play('HR');
    eq('the man who came round', aria('visiting', 0, 0), 'Visiting, batting order 1, inning 1: 1B, scored');
    eq('and the man who drove him in', aria('visiting', 3, 0), 'Visiting, batting order 2, inning 1: HR, 2 RBI, scored');
  });

  test('an unearned run says so', () => {
    sel('visiting', 0, 0);
    play('E6');
    play('HR');
    eq('the run is flagged unearned', aria('visiting', 0, 0), 'Visiting, batting order 1, inning 1: E6, scored, unearned');
  });

  test('a runner thrown out on the bases says where', () => {
    sel('visiting', 0, 0);
    play('1B');
    promptCSBase();
    eq('caught stealing 2nd', aria('visiting', 0, 0), 'Visiting, batting order 1, inning 1: 1B, out at 2nd');
  });

  // The label follows the real inning, not the column, so batting around does
  // not tell a reader the 1st inning is the 2nd.
  test('a batted-around overflow column keeps the real inning in the label', () => {
    sel('visiting', 0, 0);
    for (let i = 0; i < 9; i++) play('BB');           // bats around into column 1
    eq('overflowed to the next column', curCol(), 1);
    eq('the leadoff man\'s second time up is still the 1st',
      aria('visiting', 0, 1), 'Visiting, batting order 1, inning 1, empty');
    eq('and the 2nd inning has moved to column 2',
      aria('visiting', 0, 2), 'Visiting, batting order 1, inning 2, empty');
  });

  test('selecting a cell announces it, and only one cell is current', () => {
    const a = sel('visiting', 0, 0);
    ok('the selected cell is marked current', a.getAttribute('aria-current') === 'true');
    ok('and announced', liveRegion().startsWith('Selected Visiting, batting order 1, inning 1'));
    const b = sel('visiting', 6, 2);
    ok('the old one is no longer current', !a.hasAttribute('aria-current'));
    ok('the new one is', b.getAttribute('aria-current') === 'true');
    ok('and it is announced too', liveRegion().indexOf('batting order 3, inning 3') > 0);
  });

  /* =====================================================================
     Phase 8b — W / L / SV by the rules, not by a heuristic
     ===================================================================== */

  // Solo homers are the cheapest way to put a specific number of runs on the
  // board in a specific half-inning with no popup to answer.
  function solo(team, p, col) { sel(team, p, col); play('HR'); }
  function threeK(team, p, col) { sel(team, p, col); play('K'); play('K'); play('K'); }
  function decisions() { return computePitcherDecisions(); }

  test('a tie yields no decisions at all', () => {
    solo('visiting', 0, 0); threeK('visiting', 3, 0);
    solo('home', 0, 0); threeK('home', 3, 0);
    const d = decisions();
    eq('nobody won', d.winTeam, null);
    eq('no W', d.wp, null);
    eq('no L', d.lp, null);
  });

  // Rules 9.17 and 9.17(d) against a lead taken, given back, and taken again:
  // the loss belongs to whoever put the go-ahead runner on, not to whoever gave
  // up the most earned runs.
  test('a lead taken, lost and retaken charges the L to the go-ahead run\'s pitcher', () => {
    solo('visiting', 0, 0); threeK('visiting', 3, 0);          // V 1-0, off home #0
    solo('home', 0, 0); solo('home', 3, 0);                    // H 2-1
    threeK('home', 6, 0);
    sel('visiting', 0, 1); usePitcher(1);                      // home goes to the pen
    solo('visiting', 0, 1);                                    // 2-2
    solo('visiting', 3, 1);                                    // V 3-2, and holds
    threeK('visiting', 6, 1);
    const d = decisions();
    eq('the visitors won', d.winTeam, 'visiting');
    eq('the go-ahead run is charged to the reliever', d.lp, 1);
    eq('and the W is the visitors\' pitcher of record', d.wp, 0);
    ok('nothing needs the scorer', !d.judgment);
    ok('and it is not approximate', !d.approximate);
  });

  // Rule 9.17(b): the starter did not go five in a game of six or more, so the
  // win is explicitly the scorer's call. Offer the relievers; don't pick one.
  test('a starter pulled short of 5 innings hands the win to the scorer', () => {
    solo('visiting', 0, 0);                                    // V 1-0, and it holds
    for (let i = 0; i < 6; i++) {
      threeK('visiting', i === 0 ? 3 : 0, i);
      if (i === 3) { sel('home', 0, 3); usePitcher(1); }       // visitors go to the pen
      threeK('home', 0, i);
    }
    const d = decisions();
    eq('the visitors won', d.winTeam, 'visiting');
    eq('six innings', inningsPlayed(), 6);
    eq('their starter went three', pitcherOutCounts('visiting')[0], 9);
    ok('so the win is not credited automatically', d.wp === null);
    ok('the scorer is told why', !!d.judgment);
    eq('and offered the reliever', JSON.stringify(d.winCandidates), '[1]');
  });

  test('the scorer\'s pick overrides what the rules worked out', () => {
    solo('visiting', 0, 0);
    for (let i = 0; i < 6; i++) {
      threeK('visiting', i === 0 ? 3 : 0, i);
      if (i === 3) { sel('home', 0, 3); usePitcher(1); }
      threeK('home', 0, i);
    }
    gameState.decisions = { wp: 1 };
    const d = decisions();
    eq('the reliever gets the win', d.wp, 1);
    ok('and the prompt is gone', !d.judgment);
  });

  // Rule 9.19, first condition: entered with a lead of three or fewer and
  // pitched at least an inning.
  test('a save for a reliever who enters with a small lead and finishes an inning', () => {
    solo('visiting', 0, 0); solo('visiting', 3, 0);            // V 2-0
    threeK('visiting', 6, 0);
    threeK('home', 0, 0);                                      // starter's inning
    threeK('visiting', 0, 1);
    sel('home', 0, 1); usePitcher(1);                          // reliever in for the 2nd
    threeK('home', 0, 1);
    const d = decisions();
    eq('W to the starter', d.wp, 0);
    eq('SV to the reliever', d.sv, 1);
  });

  // Third condition: three innings of relief, whatever the lead.
  test('a save for three innings of relief regardless of the lead', () => {
    for (let r = 0; r < 6; r++) solo('visiting', r * ROWS_PER_POS, 0);    // V 6-0
    threeK('visiting', 18, 0);
    threeK('home', 0, 0);
    sel('home', 0, 1); usePitcher(1);                          // reliever in for the 2nd
    for (let i = 1; i <= 3; i++) { threeK('visiting', 0, i); threeK('home', 0, i); }
    const d = decisions();
    eq('the reliever went three', pitcherOutCounts('visiting')[1], 9);
    eq('so the save stands on the innings alone', d.sv, 1);
  });

  // Second condition: he came in with the tying run on deck — lead of three with
  // a man on — and got only one out, so neither of the other conditions applies.
  test('a save for a reliever who enters with the tying run on deck', () => {
    solo('visiting', 0, 0); solo('visiting', 3, 0); solo('visiting', 6, 0);   // V 3-0
    threeK('visiting', 9, 0);
    sel('home', 0, 0);
    play('1B');                                                // a man on off the starter
    play('K'); play('K');                                      // two away
    sel('home', 9, 0); usePitcher(1);                          // reliever in
    play('K');                                                 // he gets the third
    const d = decisions();
    eq('he got one out', pitcherOutCounts('visiting')[1], 1);
    eq('not enough for the other two conditions, but the tying run was on deck', d.sv, 1);
  });

  test('no save for a reliever who enters with the game out of reach', () => {
    for (let r = 0; r < 6; r++) solo('visiting', r * ROWS_PER_POS, 0);    // V 6-0
    threeK('visiting', 18, 0);
    sel('home', 0, 0);
    play('K'); play('K');
    sel('home', 6, 0); usePitcher(1);
    play('K');
    const d = decisions();
    eq('he finished it', finishingPitcher('visiting'), 1);
    eq('but one out of a six-run game is no save', d.sv, null);
  });

  // No pitcher holds a win and a save in the same game, so handing the win to
  // the man who finished it has to take the save off him.
  test('giving the win to the pitcher who finished takes his save away', () => {
    solo('visiting', 0, 0); solo('visiting', 3, 0);
    threeK('visiting', 6, 0);
    threeK('home', 0, 0);
    threeK('visiting', 0, 1);
    sel('home', 0, 1); usePitcher(1);
    threeK('home', 0, 1);
    eq('the rules give him the save', decisions().sv, 1);
    gameState.decisions = { wp: 1 };
    const d = decisions();
    eq('now he has the win', d.wp, 1);
    eq('and no save', d.sv, null);
  });

  test('the scorer can take a save away', () => {
    solo('visiting', 0, 0); solo('visiting', 3, 0);
    threeK('visiting', 6, 0);
    threeK('home', 0, 0);
    threeK('visiting', 0, 1);
    sel('home', 0, 1); usePitcher(1);
    threeK('home', 0, 1);
    eq('the rules give one', decisions().sv, 1);
    gameState.decisions = { sv: -1 };
    eq('the scorer takes it back', decisions().sv, -1);
  });

  // A game saved before `ab.seq` existed has no play order to sort runs by, so
  // the timeline falls back to column-then-batting-order and says so.
  test('a game with no recorded play order is flagged approximate', () => {
    solo('visiting', 0, 0); threeK('visiting', 3, 0);
    threeK('home', 0, 0);
    gameState.teams.visiting.players[0].atBats[0].seq = 0;   // as an older save has it
    ok('the summary will say so', decisions().approximate);
  });

  /* =====================================================================
     #29 — a popup's Confirm holds state captured when it opened
     ===================================================================== */

  // Undo restored an older snapshot while the runner popup was still up, and
  // confirming then applied its advancements on top of that — the runners ended
  // on bases that no sequence of plays would have put them on.
  test('undo is refused while a runner popup is waiting to be answered', () => {
    sel('visiting', 0, 0);
    play('1B');                                     // p0 on 1st
    play('2B');                                     // opens the runner popup
    ok('the popup is up', visible('runner-popup'));
    const before = JSON.stringify(inn('visiting', 0).bases);
    key('u');
    ok('the popup is still up', visible('runner-popup'));
    eq('and nothing was reverted', JSON.stringify(inn('visiting', 0).bases), before);
    ok('the refusal is shown', visible('play-reject'));
    runnerPopup({ 0: 2, batter: 1 });               // answer it — the entry completes
    eq('the runner is on 3rd', onB('visiting', 0, 2), 0);
    eq('the batter on 2nd', onB('visiting', 0, 1), 3);
  });

  test('undo works again once the popup is answered', () => {
    sel('visiting', 0, 0);
    play('1B');
    play('2B'); runnerPopup({ 0: 2, batter: 1 });
    key('u');
    eq('the double is gone', ab('visiting', 3, 0).play, '');
    eq('and the runner is back on 1st', onB('visiting', 0, 0), 0);
  });

  // C1 — the same captured-state problem on the *entry* path. `applyPlay` commits
  // `ab.play` and the result pitch before the popup that decides the play opens, so
  // a tap that lands while it is pending orphaned the play underneath (on the card
  // and counted in H, but nobody on base and no out) and left a Confirm that would
  // later write advancements into an inning that never existed.
  test('a cell cannot be selected while a runner popup is waiting', () => {
    sel('visiting', 0, 0);
    play('1B');
    play('2B');                                     // opens the runner popup
    ok('the popup is up', visible('runner-popup'));
    sel('visiting', 6, 0);                          // the tap that used to get through
    ok('the popup is still up', visible('runner-popup'));
    eq('the selection did not move', curP(), 3);
    ok('the refusal is shown', visible('play-reject'));
    runnerPopup({ 0: 2, batter: 1 });
    eq('the runner is on 3rd', onB('visiting', 0, 2), 0);
  });

  test('a play cannot be entered while a runner popup is waiting', () => {
    sel('visiting', 0, 0);
    play('1B');
    play('2B');
    play('K');                                      // a play button under the popup
    ok('the popup is still up', visible('runner-popup'));
    eq('no play was written', ab('visiting', 3, 0).play, '2B');
    ok('the refusal is shown', visible('play-reject'));
    runnerPopup({ 0: 2, batter: 1 });
    eq('outs are untouched', inn('visiting', 0).outs, 0);
  });

  test('a play cannot be entered while an outcome popup is waiting', () => {
    sel('visiting', 0, 0);
    play('1B');
    sel('visiting', 3, 0);
    play('DP 6-4-3');                               // opens the outcome popup
    ok('the popup is up', visible('outcome-popup'));
    sel('visiting', 6, 0);
    eq('the selection did not move', curP(), 3);
    play('1B');
    eq('and no play was written', ab('visiting', 6, 0).play, '');
    ok('the popup is still up', visible('outcome-popup'));
  });

  // Both entry popups get a backdrop, so the tap never reaches the grid in the
  // first place — the guards above are the belt to its braces.
  test('the entry popups draw a backdrop over the card', () => {
    sel('visiting', 0, 0);
    play('1B');
    play('2B');
    ok('the backdrop is up with the runner popup', visible('popup-backdrop'));
    runnerPopup({ 0: 2, batter: 1 });
    ok('and gone once it is answered', !visible('popup-backdrop'));
  });

  // The spray popup opens by itself after every hit and only writes hitLoc, so
  // it must not stand between the scorer and undo.
  test('the spray popup does not block undo', () => {
    sel('visiting', 0, 0);
    play('1B');
    ok('the spray popup is up', visible('spray-popup'));
    key('u');
    eq('the single is gone', ab('visiting', 0, 0).play, '');
    ok('and the spray popup went with it', !visible('spray-popup'));
  });

  /* =====================================================================
     Phase 9 — storage that doesn't lose things quietly
     ===================================================================== */

  // Anything these cases put in storage has to come back out, and the
  // quarantine registry is module state the harness's reset() doesn't touch.
  function clearStorage() {
    [CURRENT_GAME_KEY, LIBRARY_KEY].forEach(k => {
      safeStorage.removeItem(k);
      safeStorage.removeItem(k + UNREADABLE_SUFFIX);
      delete _unreadable[k];
    });
    const banner = document.getElementById('unreadable-warning');
    if (banner) banner.style.display = 'none';
  }

  // #25 — a library that wouldn't parse read as "no saved games yet", and the
  // next save wrote one entry over however many were really in there.
  test('a saved-game library that will not parse is kept, not silently emptied', () => {
    clearStorage();
    try {
      const corrupt = '[{"id":"a","teams":"Jays vs Sox"';
      safeStorage.setItem(LIBRARY_KEY, corrupt);
      eq('it reads as no games', getGameLibrary().length, 0);
      eq('but the text is kept', safeStorage.getItem(LIBRARY_KEY + UNREADABLE_SUFFIX), corrupt);
      ok('and the user is told', visible('unreadable-warning'));
      ok('saving another game is allowed, the copy is safe', !saveBlockedFor(LIBRARY_KEY));
    } finally { clearStorage(); }
  });

  test('a library holding something that is not a list is quarantined too', () => {
    clearStorage();
    try {
      safeStorage.setItem(LIBRARY_KEY, '{"id":"a"}');
      eq('it reads as no games', getGameLibrary().length, 0);
      eq('and is kept', safeStorage.getItem(LIBRARY_KEY + UNREADABLE_SUFFIX), '{"id":"a"}');
    } finally { clearStorage(); }
  });

  test('an empty library is not mistaken for a corrupt one', () => {
    clearStorage();
    try {
      eq('no games', getGameLibrary().length, 0);
      eq('nothing quarantined', safeStorage.getItem(LIBRARY_KEY + UNREADABLE_SUFFIX), null);
      ok('no banner', !visible('unreadable-warning'));
    } finally { clearStorage(); }
  });

  // #25 — the current game: the parse failure used to be a console line, and
  // the autoSave 400ms later wrote over the only copy.
  test('a stored game that will not parse is kept before a fresh one starts', () => {
    clearStorage();
    try {
      const corrupt = '{"info":{"visitingTeam":"Jays"},"teams"';
      safeStorage.setItem(CURRENT_GAME_KEY, corrupt);
      loadState();
      eq('the text is kept', safeStorage.getItem(CURRENT_GAME_KEY + UNREADABLE_SUFFIX), corrupt);
      ok('and the user is told', visible('unreadable-warning'));
      flushSave();
      ok('the fresh game saves over the unreadable one, whose copy is safe',
        safeStorage.getItem(CURRENT_GAME_KEY) !== corrupt);
      eq('the copy is still there', safeStorage.getItem(CURRENT_GAME_KEY + UNREADABLE_SUFFIX), corrupt);
    } finally { clearStorage(); }
  });

  // When the copy could not be made — the quota case, which is what truncates a
  // save in the first place — the overwrite is the thing that loses it.
  test('when the unreadable save cannot be copied, nothing overwrites it', () => {
    clearStorage();
    try {
      const corrupt = '{"teams"';
      safeStorage.setItem(CURRENT_GAME_KEY, corrupt);
      _unreadable[CURRENT_GAME_KEY] = { raw: corrupt, stashed: false };
      ok('writes are refused', saveBlockedFor(CURRENT_GAME_KEY));
      flushSave();
      eq('the original is untouched', safeStorage.getItem(CURRENT_GAME_KEY), corrupt);
    } finally { clearStorage(); }
  });

  // #28 — `loadGameFromLibrary` assigned the snapshot raw, skipping the backfill
  // `importGameJSON` runs, so a game saved by an older build came back with
  // whatever has been added to the state since left undefined.
  test('loading a saved game backfills the fields its build did not have', () => {
    clearStorage();
    try {
      const old = JSON.parse(JSON.stringify(createEmptyState()));
      old.info.visitingTeam = 'Jays';
      delete old.defChanges;
      delete old.playSeq;
      delete old.columnMap;
      safeStorage.setItem(LIBRARY_KEY, JSON.stringify([{ id: 'x', date: '', teams: 'a vs b', score: '0 - 0', state: old }]));
      loadGameFromLibrary(0);
      ok('defChanges is there', Array.isArray(gameState.defChanges));
      ok('columnMap is there', !!gameState.columnMap);
      eq('and it is the right game', gameState.info.visitingTeam, 'Jays');
    } finally { clearStorage(); }
  });

  // #33 — a sub bats on the starter's line, so every odd player row is 15
  // untouched at-bats that were serialized into every save and library entry.
  test('sub rows are not written to storage and come back on load', () => {
    const stored = JSON.parse(JSON.stringify(stateForStorage(gameState)));
    eq('the starter keeps his line', stored.teams.visiting.players[0].atBats.length, INNINGS);
    eq('the sub row is dropped', stored.teams.visiting.players[1].atBats.length, 0);
    ok('and the live state is untouched', gameState.teams.visiting.players[1].atBats.length === INNINGS);
    refillAtBats(stored);
    eq('the row is rebuilt on the way in', stored.teams.visiting.players[1].atBats.length, INNINGS);
    eq('empty, as it was', stored.teams.visiting.players[1].atBats[0].play, '');
  });

  test('a game that round-trips through storage keeps its at-bats', () => {
    clearStorage();
    try {
      sel('visiting', 0, 0);
      play('1B');
      flushSave();
      const back = mergeStateDefaults(JSON.parse(safeStorage.getItem(CURRENT_GAME_KEY)));
      eq('the single survived', back.teams.visiting.players[0].atBats[0].play, '1B');
      eq('and the sub row is a full, empty line again', back.teams.visiting.players[1].atBats.length, INNINGS);
    } finally { clearStorage(); }
  });

  // #31/#33 — the play log grew unbounded in a key that never rendered, and the
  // standings table was serialized on every save without ever being read.
  test('an older save sheds the play log and the standings table', () => {
    const old = JSON.parse(JSON.stringify(createEmptyState()));
    old.log = ['T1: somebody singled'];
    old.standings = [{ team: 'Jays', rec: '1-0', gb: '-' }];
    const merged = mergeStateDefaults(old);
    eq('no log', merged.log, undefined);
    eq('no standings', merged.standings, undefined);
  });

  test('a bunt that moved nobody is charged as an at-bat', () => {
    sel('visiting', 0, 0);
    play('1B');                                     // p0 on 1st
    play('SH'); runnerPopup({ 0: 0 });              // the runner holds
    eq('nobody advanced', onB('visiting', 0, 0), 0);
    eq('so it is an ordinary out', bStat('visiting', 3, 'ab'), '1');
  });

  /* ============================== substitutions, re-entry and the DH ======
     SUB used to be a plain toggle, so the second press granted a re-entry with
     no record and no warning — and was indistinguishable from taking back a
     mis-press. `DH` was a position option with no rules behind it. */

  function posSel(team, p) {
    return document.querySelector(`select[data-field="pos"][data-team="${team}"][data-p="${p}"]`);
  }
  // Change a position the way a scorer does: set the select and let it fire.
  function setPos(team, p, value) {
    lineupDirty = true;
    const s = posSel(team, p);
    if (!s) fail(`no pos select for ${team} p${p}`);
    s.value = value;
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return s;
  }
  // Type a player in the way a scorer does — into the inputs. `collectState`
  // only scrapes them on the debounced save, so anything that names a player has
  // to work off the inputs, and a case that wrote straight to the state would
  // never notice.
  function setPlayer(team, p, num, name) {
    lineupDirty = true;
    [['num', num], ['name', name]].forEach(([f, v]) => {
      const inp = document.querySelector(`input[data-field="${f}"][data-team="${team}"][data-p="${p}"]`);
      if (!inp) fail(`no ${f} input for ${team} p${p}`);
      inp.value = v;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  // Click an option in one of the new popups by the text it starts with.
  function clickOpt(popupId, cls, startsWith) {
    if (!visible(popupId)) fail(`#${popupId} is not open`);
    const btns = Array.from(document.getElementById(popupId).querySelectorAll(cls));
    const btn = btns.find(b => b.textContent.startsWith(startsWith));
    if (!btn) fail(`#${popupId} has no option starting "${startsWith}" (got: ${btns.map(b => JSON.stringify(b.textContent.slice(0, 40))).join(', ')})`);
    btn.onclick();
  }
  // One digit per column: which row of the slot owns it. '0' is the starter, '1'
  // the first sub, '2' the second — so a line with two substitutions reads its own
  // history off the string.
  function subLine(team, p) {
    return gameState.teams[team].players[p].atBats.map(a => String(subRowOf(a))).join('');
  }

  test('SUB marks the sub in from the selected column to the end of the card', () => {
    sel('visiting', 0, 1);
    markSub();
    ok('no question asked on the way in', !visible('sub-popup'));
    eq('the line runs to the end', subLine('visiting', 0), '011111111111111');
  });

  test('taking a sub out who never batted is an undo, not a re-entry', () => {
    sel('visiting', 0, 1);
    markSub();
    markSub();                                      // second press, nothing recorded
    ok('nothing to decide, so nothing is asked', !visible('sub-popup'));
    eq('the line is gone', subLine('visiting', 0), '000000000000000');
    eq('and no re-entry was logged', gameState.reentries.length, 0);
  });

  test('taking out a sub who has batted asks instead of toggling', () => {
    sel('visiting', 0, 1);
    markSub();
    play('1B');                                     // the sub singles in the 2nd
    sel('visiting', 0, 3);
    markSub();
    ok('the question is put', visible('sub-popup'));
    eq('and nothing has changed yet', subLine('visiting', 0), '011111111111111');
  });

  test('a re-entry is recorded, and flagged illegal under OBR 5.10(d)', () => {
    setPlayer('visiting', 0, '12', 'Alou');
    setPlayer('visiting', 1, '30', 'Ruiz');
    sel('visiting', 0, 1);
    markSub();
    play('1B');
    sel('visiting', 0, 3);
    markSub();
    clickOpt('sub-popup', '.sub-opt', '#12 Alou re-enters');
    eq('the starter is back from the 4th on', subLine('visiting', 0), '011000000000000');
    eq('one re-entry logged', gameState.reentries.length, 1);
    const r = gameState.reentries[0];
    eq('in the right half-inning', r.inning, 'T4');
    eq('for the right spot', r.spot, 1);
    eq('naming the starter', r.starter, '#12 Alou');
    eq('and the man he replaced', r.sub, '#30 Ruiz');
    eq('flagged illegal by default', r.legal, false);
    eq('the sub keeps the hit', bStat('visiting', 1, 'h'), '1');
    eq('and the starter has none', bStat('visiting', 0, 'h'), '');
  });

  // `collectState` scrapes the lineup inputs on the debounced save, ~400ms after
  // the last keystroke. A scorer who types a name and reaches straight for SUB
  // was shown — and had recorded — "Batter 1".
  test('a name typed a moment ago is the name in the prompt and the log', () => {
    setPlayer('visiting', 0, '12', 'Alou');
    setPlayer('visiting', 1, '30', 'Ruiz');
    eq('the state has not caught up yet', gameState.teams.visiting.players[0].name, '');
    sel('visiting', 0, 1);
    markSub();
    play('1B');
    sel('visiting', 0, 3);
    markSub();
    ok('the prompt names the typed player',
      document.getElementById('sub-popup').innerHTML.includes('#12 Alou'));
    clickOpt('sub-popup', '.sub-opt', '#12 Alou re-enters');
    eq('and so does the record', gameState.reentries[0].starter, '#12 Alou');
    eq('on both sides of it', gameState.reentries[0].sub, '#30 Ruiz');
  });

  test('a league that allows re-entry says so once and the record shows it legal', () => {
    sel('visiting', 0, 1);
    markSub();
    play('1B');
    sel('visiting', 0, 3);
    markSub();
    document.getElementById('sub-allow-reentry').checked = true;
    clickOpt('sub-popup', '.sub-opt', 'Batter 1 re-enters');
    eq('the game now allows it', gameState.rules.allowReentry, true);
    eq('and the entry is not flagged', gameState.reentries[0].legal, true);
  });

  test('undoing the substitution clears the whole line and gives the at-bats back', () => {
    sel('visiting', 0, 1);
    markSub();
    play('1B');
    eq('the sub owns the hit first', bStat('visiting', 1, 'h'), '1');
    sel('visiting', 0, 3);
    markSub();
    clickOpt('sub-popup', '.sub-opt', 'Undo the substitution');
    eq('no sub line left', subLine('visiting', 0), '000000000000000');
    eq('nothing logged as a re-entry', gameState.reentries.length, 0);
    eq('the hit is the starter\'s again', bStat('visiting', 0, 'h'), '1');
    eq('and the sub row is empty', bStat('visiting', 1, 'h'), '');
  });

  test('cancelling the re-entry question leaves the card alone', () => {
    sel('visiting', 0, 1);
    markSub();
    play('1B');
    sel('visiting', 0, 3);
    markSub();
    clickOpt('sub-popup', '.sub-opt', 'Cancel');
    eq('the sub line stands', subLine('visiting', 0), '011111111111111');
    eq('and nothing was logged', gameState.reentries.length, 0);
  });

  test('undo is refused while the re-entry question is open', () => {
    sel('visiting', 0, 1);
    markSub();
    play('1B');
    sel('visiting', 0, 3);
    markSub();
    ok('the question is open', visible('sub-popup'));
    undoLastPlay();
    eq('the single is still there', ab('visiting', 0, 1).play, '1B');
    clickOpt('sub-popup', '.sub-opt', 'Cancel');
  });

  /* H3 — a lineup slot had two rows, so a pinch hitter followed by a defensive
     replacement in the same spot had nowhere to go: the second SUB press could only
     offer to undo the first. ROWS_PER_POS is 3, `subChange` is the row number
     rather than a boolean, and the prompt has a third option. */

  test('a spot takes a second substitution, and all three men keep their own line', () => {
    setPlayer('visiting', 0, '12', 'Alou');
    setPlayer('visiting', 1, '30', 'Ruiz');
    setPlayer('visiting', 2, '44', 'Mays');
    sel('visiting', 0, 0);
    play('1B');                                     // the starter singles in the 1st
    sel('visiting', 0, 1);
    markSub();                                      // pinch hitter in for the 2nd
    play('2B');                                     // and doubles
    sel('visiting', 0, 2);
    markSub();
    ok('the question is put', visible('sub-popup'));
    clickOpt('sub-popup', '.sub-opt', '#44 Mays takes over');
    eq('the card records all three', subLine('visiting', 0), '012222222222222');
    sel('visiting', 0, 2);
    play('HR');                                     // the second sub homers in the 3rd
    eq('the starter keeps his single', bStat('visiting', 0, 'h'), '1');
    eq('the first sub keeps his double', bStat('visiting', 1, 'h'), '1');
    eq('and the second sub his home run', bStat('visiting', 2, 'h'), '1');
    eq('nothing was logged as a re-entry', gameState.reentries.length, 0);
  });

  test('the second substitution is marked on the card like the first', () => {
    sel('visiting', 0, 1);
    markSub();
    play('1B');
    sel('visiting', 0, 2);
    markSub();
    clickOpt('sub-popup', '.sub-opt', 'Sub 2 in spot 1 takes over');
    const mark = col => document.getElementById(`scm-visiting-0-${col}`).classList.contains('active');
    ok('the first change is marked', mark(1));
    ok('and so is the second', mark(2));
    ok('a column inside a run is not', !mark(3));
  });

  test('clearing the second sub hands the columns back to the first, not the starter', () => {
    setPlayer('visiting', 0, '12', 'Alou');
    setPlayer('visiting', 1, '30', 'Ruiz');
    setPlayer('visiting', 2, '44', 'Mays');
    sel('visiting', 0, 1);
    markSub();
    play('1B');                                     // Ruiz singles
    sel('visiting', 0, 2);
    markSub();
    clickOpt('sub-popup', '.sub-opt', '#44 Mays takes over');
    sel('visiting', 0, 2);
    play('K');                                      // Mays strikes out
    sel('visiting', 0, 3);
    markSub();
    clickOpt('sub-popup', '.sub-opt', '#30 Ruiz re-enters');
    eq('Ruiz has the tail back', subLine('visiting', 0), '012111111111111');
    eq('and the re-entry names him, not the starter', gameState.reentries[0].starter, '#30 Ruiz');
    eq('over the man he replaced', gameState.reentries[0].sub, '#44 Mays');
  });

  // The run a prompt acts on is bounded by row number. On truthiness alone it would
  // swallow the second substitution's columns into the first one's run and offer to
  // clear them both.
  test('undoing the first sub does not take a later substitution with it', () => {
    sel('visiting', 0, 1);
    markSub();
    play('1B');
    sel('visiting', 0, 3);
    markSub();
    clickOpt('sub-popup', '.sub-opt', 'Sub 2 in spot 1 takes over');
    eq('two runs on the line', subLine('visiting', 0), '011222222222222');
    sel('visiting', 0, 1);
    markSub();
    clickOpt('sub-popup', '.sub-opt', 'Undo the substitution');
    eq('only the first run went back to the starter', subLine('visiting', 0), '000222222222222');
  });

  test('a slot with one sub still reads exactly as it did', () => {
    sel('visiting', 0, 1);
    markSub();
    play('1B');
    sel('visiting', 0, 3);
    markSub();
    ok('the heading is still about taking the sub out',
      document.getElementById('sub-popup').innerHTML.includes('Change this spot?'));
    clickOpt('sub-popup', '.sub-opt', 'Batter 1 re-enters');
    eq('the starter is back from the 4th on', subLine('visiting', 0), '011000000000000');
    eq('one re-entry logged', gameState.reentries.length, 1);
  });

  /* H2 — a pinch runner. SUB skips a column that already has a play (right for a
     pinch *hitter*, who arrives before the at-bat, not after), so a pinch runner
     could never own the at-bat he was running in: the run he scored landed on the
     starter's line and his own read blank. PR marks the column instead of taking it
     over — the plate appearance stays put and only the run follows the runner (D4). */

  // The plan's repro: starter singles, PR comes in, PR scores.
  test('a pinch runner takes the run and leaves the hit with the starter', () => {
    setPlayer('visiting', 0, '12', 'Alou');
    setPlayer('visiting', 1, '30', 'Ruiz');
    sel('visiting', 0, 0);
    play('1B');                                     // Alou singles
    sel('visiting', 0, 0);
    markPinchRunner();                              // Ruiz runs for him
    sel('visiting', 3, 0);
    play('HR');                                     // the next man homers him in
    eq('the starter keeps the at-bat', bStat('visiting', 0, 'ab'), '1');
    eq('and the hit', bStat('visiting', 0, 'h'), '1');
    eq('but not the run', bStat('visiting', 0, 'r'), '');
    eq('the pinch runner has the run', bStat('visiting', 1, 'r'), '1');
    eq('and no at-bat for it', bStat('visiting', 1, 'ab'), '');
    eq('nor a hit', bStat('visiting', 1, 'h'), '');
  });

  test('a pinch runner stays in the game and bats next time up', () => {
    sel('visiting', 0, 0);
    play('1B');
    sel('visiting', 0, 0);
    markPinchRunner();
    eq('the column he ran in still belongs to the batter', subLine('visiting', 0)[0], '0');
    eq('and he has the line from the next one on', subLine('visiting', 0), '011111111111111');
    sel('visiting', 0, 1);
    play('2B');                                     // his own at-bat, in the 2nd
    eq('the double is his', bStat('visiting', 1, 'h'), '1');
    eq('the starter still has only his single', bStat('visiting', 0, 'h'), '1');
    eq('and only his one at-bat', bStat('visiting', 0, 'ab'), '1');
  });

  test('the pinch runner is marked on the column he came into', () => {
    sel('visiting', 0, 0);
    play('1B');
    sel('visiting', 0, 0);
    markPinchRunner();
    ok('the change is marked where he entered',
      document.getElementById('scm-visiting-0-0').classList.contains('active'));
  });

  test('PR is refused where there is nobody to run for', () => {
    sel('visiting', 0, 0);
    markPinchRunner();                              // no play in the cell yet
    ok('the refusal is shown', visible('play-reject'));
    eq('and nothing was marked', ab('visiting', 0, 0).prRow, 0);
    play('K');                                      // he made an out
    sel('visiting', 0, 0);
    markPinchRunner();
    ok('still refused', visible('play-reject'));
    eq('nothing marked', ab('visiting', 0, 0).prRow, 0);
  });

  test('a second pinch runner in the same column is refused, not stacked', () => {
    sel('visiting', 0, 0);
    play('1B');
    sel('visiting', 0, 0);
    markPinchRunner();
    eq('the first is in', ab('visiting', 0, 0).prRow, 1);
    markPinchRunner();
    ok('the refusal is shown', visible('play-reject'));
    eq('and he is still the runner', ab('visiting', 0, 0).prRow, 1);
  });

  test('clearing the at-bat takes the pinch runner with it', () => {
    sel('visiting', 0, 0);
    play('1B');
    sel('visiting', 0, 0);
    markPinchRunner();
    eq('the runner is on the column', ab('visiting', 0, 0).prRow, 1);
    sel('visiting', 0, 0);
    clearSelectedCell();
    eq('and goes with the play', ab('visiting', 0, 0).prRow, 0);
  });

  // The box score has to agree with the card: three lines out of one slot, and the
  // run on the right one.
  test('the box score puts the pinch runner\'s run on his own line', () => {
    setPlayer('visiting', 0, '12', 'Alou');
    setPlayer('visiting', 1, '30', 'Ruiz');
    sel('visiting', 0, 0);
    play('1B');
    sel('visiting', 0, 0);
    markPinchRunner();
    sel('visiting', 3, 0);
    play('HR');
    collectState();   // the box score reads state, not the live inputs
    showGameSummary();
    const rows = [...document.querySelectorAll('#gs-inner tr')]
      .map(tr => [...tr.children].map(td => td.textContent.trim()))
      .filter(c => c[0] && (c[0].includes('Alou') || c[0].includes('Ruiz')));
    const alou = rows.find(c => c[0].includes('Alou'));
    const ruiz = rows.find(c => c[0].includes('Ruiz'));
    ok('the starter is on the box score', !!alou);
    ok('and so is the pinch runner', !!ruiz);
    eq('the starter: 1 AB, 0 R, 1 H', [alou[1], alou[2], alou[3]].join('/'), '1/0/1');
    eq('the runner: 0 AB, 1 R, 0 H', [ruiz[1], ruiz[2], ruiz[3]].join('/'), '0/1/0');
    document.getElementById('game-summary-modal').classList.remove('active');
  });

  /* The migration. A row index *is* a player's place in the slot, so widening a
     slot is a remap, not an append: row 2 of a 2-row save is spot 1's starter, and
     in a 3-row card that index belongs to spot 0's second sub. Every stored player
     index has to move with it. */

  // A save as the 2-row build wrote it: 18 rows a side, a play on spot 1's starter
  // (old index 2), and that man standing on 1st.
  function twoRowSave() {
    const mkAB = () => ({ bases:[false,false,false,false], advReason:['','','',''], outOnBase:null,
      play:'', out:0, outsRecorded:0, pitches:[], hitLoc:null, rbi:0, pitcher:0,
      reachedOnError:false, pitcherChangeNum:'', subChange:false, seq:0 });
    const mkTeam = () => ({
      players: Array(POSITIONS * 2).fill(null).map((_, i) => ({
        num: String(i), name: 'Row' + i, pos: '', avg: '',
        atBats: Array(INNINGS).fill(null).map(() => mkAB())
      })),
      pitchers: Array(PITCHER_ROWS).fill(null).map(() => ({ num:'', name:'', era:'', ip:'', pc:'', h:'', r:'', er:'', k:'', bb:'' }))
    });
    const st = {
      info: {}, umpires: {}, notes: '', linescore: {
        visiting: { innings: Array(INNINGS).fill(''), r:'', h:'', e:'' },
        home: { innings: Array(INNINGS).fill(''), r:'', h:'', e:'' }
      },
      innings: { visiting: [], home: [] },
      teams: { visiting: mkTeam(), home: mkTeam() },
      columnMap: { visiting: defaultColumnMap(), home: defaultColumnMap() },
      nextLeadoff: { visiting: { 1: 4 }, home: {} },   // old index 4 = spot 2's starter
      defChanges: [{ inning: 'T1', team: 'visiting', changes: [{ pIdx: 2, fromPos: 'LF', toPos: 'CF', name: 'Row2' }] }],
      reentries: [{ team: 'visiting', pIdx: 2, col: 0, inning: 'T1', spot: 2, starter: 'Row2', sub: 'Row3', legal: false }],
      rules: { allowReentry: false, regulationInnings: 9 },
      dhTerminated: { visiting: null, home: null }, playSeq: 1
    };
    ['visiting','home'].forEach(t => {
      st.innings[t] = Array(INNINGS).fill(null).map(() => ({ outs:0, bases:[null,null,null], currentPitcher:0, lob:0, outsLog:[], lastPA:null }));
    });
    st.teams.visiting.players[2].atBats[0].play = '1B';
    st.teams.visiting.players[2].atBats[0].bases[0] = true;
    st.innings.visiting[0].bases[0] = { p: 2, col: 0 };
    st.innings.visiting[0].lastPA = { pIdx: 2, col: 0 };
    st.innings.visiting[0].outsLog = [{ n: 1, kind: 'batter', pIdx: 4, col: 0, srcP: 4, srcCol: 0, pitcher: 0 }];
    return st;
  }

  test('a two-row save is re-laid-out, not appended to', () => {
    const st = mergeStateDefaults(twoRowSave());
    eq('the card is the current width', st.teams.visiting.players.length, POSITIONS * ROWS_PER_POS);
    // Old row 2 was spot 1's starter. It has to land on spot 1's starter again.
    eq('spot 1 keeps its starter', st.teams.visiting.players[3].name, 'Row2');
    eq('with his at-bat', st.teams.visiting.players[3].atBats[0].play, '1B');
    eq('spot 1 keeps its sub', st.teams.visiting.players[4].name, 'Row3');
    eq('spot 0 is untouched', st.teams.visiting.players[0].name, 'Row0');
    eq('and its sub too', st.teams.visiting.players[1].name, 'Row1');
    eq('the new second sub row is blank', st.teams.visiting.players[2].name, '');
    eq('the last spot moved all the way down', st.teams.visiting.players[24].name, 'Row16');
  });

  test('every stored player index moves with the rows', () => {
    const st = mergeStateDefaults(twoRowSave());
    eq('the runner on 1st', st.innings.visiting[0].bases[0].p, 3);
    eq('and the plate appearance he is running from', st.innings.visiting[0].bases[0].col, 0);
    eq('the last plate appearance', st.innings.visiting[0].lastPA.pIdx, 3);
    eq('the out log', st.innings.visiting[0].outsLog[0].pIdx, 6);
    eq('and its source', st.innings.visiting[0].outsLog[0].srcP, 6);
    eq('the stored leadoff', st.nextLeadoff.visiting[1], 6);
    eq('the re-entry log', st.reentries[0].pIdx, 3);
    eq('the defensive change log', st.defChanges[0].changes[0].pIdx, 3);
  });

  test('a boolean sub flag from an old save becomes the first sub row', () => {
    const raw = twoRowSave();
    raw.teams.visiting.players[2].atBats[1].subChange = true;
    const st = mergeStateDefaults(raw);
    eq('it is the first sub', st.teams.visiting.players[3].atBats[1].subChange, 1);
    eq('and an unset column is the starter', st.teams.visiting.players[3].atBats[0].subChange, 0);
  });

  test('a save already at the current width is left alone', () => {
    const once = mergeStateDefaults(twoRowSave());
    const before = JSON.stringify(once.teams.visiting.players.map(p => p.name));
    const twice = mergeStateDefaults(once);
    eq('re-running the migration changes nothing',
      JSON.stringify(twice.teams.visiting.players.map(p => p.name)), before);
    eq('and the runner stays put', twice.innings.visiting[0].bases[0].p, 3);
  });

  test('a second DH asks which one to keep', () => {
    setPlayer('visiting', 0, '12', 'Alou');
    setPos('visiting', 0, 'DH');
    ok('one DH raises nothing', !visible('dh-popup'));
    setPos('visiting', 2, 'DH');
    ok('two does', visible('dh-popup'));
    clickOpt('dh-popup', '.dh-opt', 'Keep this one');
    eq('the first DH is cleared', posSel('visiting', 0).value, '');
    eq('and the new one stands', posSel('visiting', 2).value, 'DH');
  });

  test('undoing the second DH puts the row back as it was', () => {
    setPos('visiting', 0, 'DH');
    setPos('visiting', 2, '1B');
    setPos('visiting', 2, 'DH');
    clickOpt('dh-popup', '.dh-opt', 'Undo');
    eq('the row goes back to 1B', posSel('visiting', 2).value, '1B');
    eq('and the DH is unchanged', posSel('visiting', 0).value, 'DH');
  });

  test('a pitcher listed alongside a DH is a notice while the lineup is being typed', () => {
    setPos('visiting', 0, 'DH');
    setPos('visiting', 2, 'P');
    ok('no modal in the way', !visible('dh-popup'));
    ok('but it says so', visible('play-reject'));
    eq('and the entry stands', posSel('visiting', 2).value, 'P');
    eq('nothing is recorded as terminated', gameState.dhTerminated.visiting, null);
  });

  test('once the game is under way, a pitcher in the order asks', () => {
    sel('visiting', 6, 0);
    play('1B');                                    // this side has batted
    setPos('visiting', 0, 'DH');
    setPos('visiting', 2, 'P');
    ok('the question is put', visible('dh-popup'));
    clickOpt('dh-popup', '.dh-opt', 'The DH was lost');
    ok('the DH is recorded lost', !!gameState.dhTerminated.visiting);
    eq('in the half-inning the card was on', gameState.dhTerminated.visiting.inning, 'T1');
    eq('with the reason', gameState.dhTerminated.visiting.reason, 'the pitcher entered the batting order');
  });

  test('calling it a mistake instead reverts the position', () => {
    sel('visiting', 6, 0);
    play('1B');
    setPos('visiting', 0, 'DH');
    setPos('visiting', 2, '3B');
    setPos('visiting', 2, 'P');
    clickOpt('dh-popup', '.dh-opt', 'A mistake');
    eq('the row is 3B again', posSel('visiting', 2).value, '3B');
    eq('and no termination is on the card', gameState.dhTerminated.visiting, null);
  });

  test('a DH who takes the field loses the role without being asked', () => {
    setPlayer('visiting', 0, '12', 'Alou');
    setPos('visiting', 0, 'DH');
    setPos('visiting', 0, 'LF');
    ok('no question — the rule is not ambiguous', !visible('dh-popup'));
    ok('it is recorded', !!gameState.dhTerminated.visiting);
    eq('naming who and where', gameState.dhTerminated.visiting.reason, '#12 Alou took the field at LF');
  });

  test('the mid-game position popup terminates the DH the same way', () => {
    setPlayer('visiting', 0, '12', 'Alou');
    setPos('visiting', 0, 'DH');
    sel('visiting', 0, 2);
    changeFieldPos();
    const btn = document.getElementById('pos-change-popup').querySelector('[data-pos="1B"]');
    if (!btn) fail('the position popup has no 1B option');
    btn.click();
    eq('the select moved', posSel('visiting', 0).value, '1B');
    ok('and the DH is recorded lost', !!gameState.dhTerminated.visiting);
    eq('in the inning the popup was opened on', gameState.dhTerminated.visiting.inning, 'T3');
    eq('with the defensive change alongside it', gameState.defChanges[0].changes[0].toPos, '1B');
  });

  test('a DH lineup with no pitcher in the order raises nothing', () => {
    sel('visiting', 6, 0);
    play('1B');
    setPos('visiting', 0, 'DH');
    setPos('visiting', 2, 'C');
    setPos('visiting', 4, '1B');
    ok('no question', !visible('dh-popup'));
    ok('and no notice', !visible('play-reject'));
    eq('nothing terminated', gameState.dhTerminated.visiting, null);
  });

  test('the DH and any re-entry survive a round trip through storage', () => {
    clearStorage();
    try {
      setPlayer('visiting', 0, '12', 'Alou');
      setPos('visiting', 0, 'DH');
      setPos('visiting', 0, 'LF');                 // terminates the DH
      sel('visiting', 3, 1);
      markSub();
      play('1B');
      sel('visiting', 3, 3);
      markSub();
      clickOpt('sub-popup', '.sub-opt', 'Batter 2 re-enters');
      flushSave();
      const back = mergeStateDefaults(JSON.parse(safeStorage.getItem(CURRENT_GAME_KEY)));
      eq('the termination came back', back.dhTerminated.visiting.reason, '#12 Alou took the field at LF');
      eq('and the re-entry', back.reentries.length, 1);
      eq('in the right inning', back.reentries[0].inning, 'T4');
    } finally { clearStorage(); }
  });

  test('an older save without the new logs gets them backfilled', () => {
    const old = JSON.parse(JSON.stringify(createEmptyState()));
    delete old.rules; delete old.reentries; delete old.dhTerminated;
    const merged = mergeStateDefaults(old);
    eq('re-entry is off by default', merged.rules.allowReentry, false);
    ok('the log is a list', Array.isArray(merged.reentries));
    ok('and both sides have a DH slot', 'visiting' in merged.dhTerminated && 'home' in merged.dhTerminated);
  });

  test('an old save carrying subChange as a boolean still resolves the batter', () => {
    const old = JSON.parse(JSON.stringify(createEmptyState()));
    old.teams.visiting.players[0].atBats[2].subChange = true;
    const merged = mergeStateDefaults(old);
    eq('the flag is intact', merged.teams.visiting.players[0].atBats[2].subChange, true);
    gameState.teams.visiting.players[0].atBats[2].subChange = true;
    setPlayer('visiting', 1, '30', 'Ruiz');
    eq('and the sub is the man batting', getActivePlayerName('visiting', 0, 2), '#30 Ruiz');
  });

  /* =====================================================================
     Regulation length — the three game-over comparisons used to be a literal
     `realInn >= 8`, so a 6- or 7-inning game (doubleheader, youth, softball)
     never reached a final and rolled on into an inning that doesn't exist.
     ===================================================================== */

  test('a 7-inning game is final when the 7th is complete', () => {
    setInnings(7);
    lsInput('home', 0).value = '2';                 // home leads 2-0
    updateLinescoreTotals('home');
    sel('visiting', 0, 6);                          // top of the 7th
    play('K'); play('K'); play('K');
    eq('three away', inn('visiting', 6).outs, 3);
    ok('game recognised as over', gameOverShown);
  });

  test('the same 7th inning leaves a 9-inning game running', () => {
    lsInput('home', 0).value = '2';
    updateLinescoreTotals('home');
    sel('visiting', 0, 6);
    play('K'); play('K'); play('K');
    eq('three away', inn('visiting', 6).outs, 3);
    ok('still four half-innings to play', !gameOverShown);
  });

  test('a walk-off in the bottom of the 7th ends a 7-inning game', () => {
    setInnings(7);
    sel('home', 0, 6);
    play('3B');
    ok('not over yet', !gameOverShown);
    key('n');                                       // wild pitch scores him
    eq('run scored', lsInput('home', 6).value, '1');
    ok('game recognised as over', gameOverShown);
  });

  test('a tie in the bottom of the 7th does not end a 7-inning game', () => {
    setInnings(7);
    lsInput('visiting', 0).value = '1';
    updateLinescoreTotals('visiting');
    sel('home', 0, 6);
    play('3B');
    key('n');                                       // ties it 1-1
    ok('game still going', !gameOverShown);
  });

  test('the linescore reads FINAL once a shortened game is complete', () => {
    setInnings(7);
    lsInput('home', 0).value = '2';
    updateLinescoreTotals('home');
    sel('visiting', 0, 6);
    play('K'); play('K'); play('K');
    updateLiveStatsFromState();
    eq('the readout', document.getElementById('ls-inning').textContent, 'FINAL');
  });

  test('shortening the game pulls the inning columns back with it', () => {
    setInnings(7);
    eq('regulation', regulationInnings(), 7);
    eq('columns shown', visibleInningCount(), 7);
    ok('the 8th is hidden', innHeaderCell('visiting', 7).classList.contains('hidden-inning'));
  });

  test('shortening the game never hides a column that has plays in it', () => {
    sel('visiting', 0, 8);                          // a play in the 9th
    play('1B');
    setInnings(7);
    eq('regulation is short', regulationInnings(), 7);
    eq('but the columns stay', visibleInningCount(), 9);
    ok('the 9th is still on the card', !innHeaderCell('visiting', 8).classList.contains('hidden-inning'));
  });

  test('+EI still extends a 7-inning game into extras', () => {
    setInnings(7);
    addExtraInning();
    eq('an 8th column appears', visibleInningCount(), 8);
    eq('regulation is untouched', regulationInnings(), 7);
  });

  test('regulation length survives a round trip through storage', () => {
    clearStorage();
    try {
      setInnings(6);
      flushSave();
      const back = mergeStateDefaults(JSON.parse(safeStorage.getItem(CURRENT_GAME_KEY)));
      eq('six innings came back', back.rules.regulationInnings, 6);
    } finally { clearStorage(); }
  });

  test('an older save with no regulation length gets nine', () => {
    const old = JSON.parse(JSON.stringify(createEmptyState()));
    delete old.rules.regulationInnings;             // `rules` exists, the key does not
    const merged = mergeStateDefaults(old);
    eq('backfilled inside the object', merged.rules.regulationInnings, 9);
  });

  test('a nonsense regulation length is refused, not stored', () => {
    setInnings(7);
    setRegulationInnings(0);
    eq('zero is not a game', regulationInnings(), 7);
    setRegulationInnings(INNINGS + 1);
    eq('nor is more than the card holds', regulationInnings(), 7);
  });

  /* =====================================================================
     ERA — the pitcher header promised "Pitcher / ERA" and no field for it
     ever existed, so `era` sat in state as an empty string forever.
     ===================================================================== */

  test('ERA is computed from this game\'s earned runs and innings', () => {
    sel('visiting', 0, 0);
    play('HR');                                     // 1 earned run
    play('K'); play('K'); play('K');                // one full inning
    eq('a full inning', pStat('visiting', 0, 'ip'), '1');
    eq('one earned run', pStat('visiting', 0, 'er'), '1');
    eq('ERA', pEra('visiting', 0), '9.00');
  });

  test('a partial inning is divided by outs, not by innings', () => {
    sel('visiting', 0, 0);
    play('HR');
    play('K');                                      // 1 ER in 1/3 of an inning
    eq('a third of an inning', pStat('visiting', 0, 'ip'), '0.1');
    eq('ERA', pEra('visiting', 0), '27.00');
  });

  test('an earned run without an out recorded reads INF', () => {
    sel('visiting', 0, 0);
    play('HR');
    eq('no outs', pStat('visiting', 0, 'ip'), '');
    eq('ERA', pEra('visiting', 0), 'INF');
  });

  test('a pitcher with no line yet has no ERA', () => {
    eq('blank, not 0.00', pEra('visiting', 0), '');
  });

  test('a scoreless inning is an ERA of 0.00, not a blank', () => {
    sel('visiting', 0, 0);
    play('K'); play('K'); play('K');
    eq('ERA', pEra('visiting', 0), '0.00');
  });

  test('an unearned run is left out of ERA', () => {
    sel('visiting', 0, 0);
    play('E6');                                     // reached on an error
    sel('visiting', 3, 0);                          // batter 2 — odd rows are sub rows
    play('HR');                                     // both score, one unearned
    play('K'); play('K'); play('K');
    eq('two runs', pStat('visiting', 0, 'r'), '2');
    eq('one of them earned', pStat('visiting', 0, 'er'), '1');
    eq('ERA counts only that one', pEra('visiting', 0), '9.00');
  });

  test('the computed ERA is what the summary box score prints', () => {
    setPlayer('visiting', 0, '7', 'Batter');
    sel('visiting', 0, 0);
    play('HR');
    play('K'); play('K'); play('K');
    const p = gameState.teams.home.pitchers[0];
    p.name = 'Reliever';
    eq('state carries it for the summary', p.era, '9.00');
  });
})();
