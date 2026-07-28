/*
 * Scoring-flow regression suite.
 *
 * Runs against the full index.html DOM with app.js loaded in the same script
 * realm — see run-tests.js (`npm test`). Cases drive the app through the entry
 * points the UI uses (selectCell, applyPlay, popup buttons, keydown) rather than
 * poking state, so a fix has to work on the real user path.
 *
 * test(...)         must pass; a failure fails the run.
 * xfail('#n', ...)  asserts the CORRECT behaviour for audit finding #n, which
 *                   the code does not have yet (see FIX_PLAN.md Appendix A).
 *                   A failure is expected and reported as a known failure. When
 *                   the fixing phase lands, the case starts passing and the
 *                   runner tells you to drop the marker.
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
    'pitcher-popup', 'recompute-popup', 'popup-backdrop', 'play-reject'
  ];

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
    pendingTransitionTimer = null;
    if (selectedCell) selectedCell.classList.remove('selected');
    selectedCell = null;

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

    rawAll('input[data-ls]').forEach(i => { i.value = ''; });
    ['visiting', 'home'].forEach(t => { updateLinescoreTotals(t); updatePlayerStats(t); updatePitcherStats(t); });
    rawAll('.at-bat-cell.selected').forEach(c => c.classList.remove('selected'));
    // Only the cases that reveal extra innings need the (expensive) re-toggle.
    if (visibilityDirty) updateInningVisibility();
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
  function innHeaderCell(team, col) {
    const gridId = team === 'visiting' ? 'grid-visiting' : 'grid-home';
    return rawAll(`#${gridId} .scoring-grid thead th.inn-col`)[col];
  }
  function innHeader(team, col) { return innHeaderCell(team, col).textContent; }
  function setInnHeader(team, col, text) { innHeaderCell(team, col).textContent = text; }
  function lsInput(team, i) { return document.querySelector(`input[data-ls="${team}"][data-inn="${i}"]`); }
  function rTotal(team) { return document.querySelector(`input[data-ls="${team}"][data-stat="r"]`).value; }
  function lobTotal(team) { return document.querySelector(`input[data-ls="${team}"][data-stat="lob"]`).value; }

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
    eq('next batter selected', curP(), 2);
    eq('no run scored', rTotal('visiting'), '');
  });

  test('three strikeouts end the half-inning with numbered outs', () => {
    sel('visiting', 0, 0);
    play('K'); play('K'); play('K');
    eq('outs', inn('visiting', 0).outs, 3);
    eq('first out', ab('visiting', 0, 0).out, 1);
    eq('second out', ab('visiting', 2, 0).out, 2);
    eq('third out', ab('visiting', 4, 0).out, 3);
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
    eq('RBI on the homer', ab('visiting', 4, 0).rbi, 3);
    eq('bases cleared', inn('visiting', 0).bases.filter(b => b !== null).length, 0);
  });

  test('a bases-loaded walk forces in a run', () => {
    sel('visiting', 0, 0);
    play('1B'); play('BB'); play('BB'); play('BB');
    eq('R total', rTotal('visiting'), '1');
    eq('RBI on the walk', ab('visiting', 6, 0).rbi, 1);
    eq('bases still loaded', inn('visiting', 0).bases.filter(b => b !== null).length, 3);
  });

  test('the batter after the 3rd out leads off the next inning', () => {
    sel('visiting', 0, 0);
    play('K'); play('K'); play('K');   // 3rd out made by p4 (batting 3rd)
    flushTimers();                     // half-inning transition
    eq('stored leadoff for column 1', gameState.nextLeadoff.visiting[1], 6);
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
    sel('visiting', 8, 0);                       // scorer taps batter 5's cell meanwhile
    clickId('k-swinging');
    eq('batter 1 play', ab('visiting', 0, 0).play, 'K');
    eq('batter 5 play', ab('visiting', 8, 0).play, '');
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
    eq('play not recorded', ab('visiting', 4, 0).play, '');
    eq('outs', inn('visiting', 0).outs, 2);
    eq('no pitch left behind', ab('visiting', 4, 0).pitches.length, 0);
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
    sel('visiting', 6, 0);                         // a batter who never came up
    pitch('B'); pitch('B'); pitch('B'); pitch('B');
    eq('pitches', ab('visiting', 6, 0).pitches.length, 0);
    eq('play', ab('visiting', 6, 0).play, '');
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
    eq('batter on 1st', onB('visiting', 0, 0), 2);
    eq('outs', inn('visiting', 0).outs, 0);
  });

  // #4 — the batter is out on a sacrifice, so a runner holding 1st is no clash.
  test('a sacrifice is not refused when a runner holds the base the batter would take', () => {
    sel('visiting', 0, 0);
    play('1B');                                    // p0 on 1st
    play('SH'); runnerPopup({ 0: 0, batter: 0 });   // runner holds, batter is out
    eq('outs', inn('visiting', 0).outs, 1);
    eq('runner still on 1st', onB('visiting', 0, 0), 0);
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
    eq('batter on 2nd', onB('visiting', 0, 1), 2);
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
    eq('outs charged to the batter', ab('visiting', 2, 0).outsRecorded, 2);
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
    eq('leadoff for the next inning', gameState.nextLeadoff.visiting[1], 6);
  });

  test('the inning after a caught-stealing-ending inning leads off with the batter at the plate', () => {
    sel('visiting', 0, 0);
    play('K'); play('K');                          // p0, p2 out
    play('1B');                                    // p4 on 1st, p6 now up
    promptCSBase();
    eq('outs', inn('visiting', 0).outs, 3);
    flushTimers();
    eq('leadoff for the next inning', gameState.nextLeadoff.visiting[1], 6);
  });

  test('the inning after a pickoff-ending inning leads off with the batter at the plate', () => {
    sel('visiting', 0, 0);
    play('K'); play('K');
    play('1B');                                    // p4 on 1st, p6 now up
    promptPickoff();
    basePicker(0);
    eq('outs', inn('visiting', 0).outs, 3);
    flushTimers();
    eq('leadoff for the next inning', gameState.nextLeadoff.visiting[1], 6);
  });

  // #21 — clearing an older play has to give back every out it made, not just the
  // batter's. The old code left the doubled-off runner recorded as out.
  test('clearing an older double play gives back both of its outs', () => {
    sel('visiting', 0, 0);
    play('1B');                                    // p0 on 1st
    promptPositionPlay('DP ');
    positionPopup('6-4-3');
    outcomePopup({ 0: ['out', 1], batter: ['out'] });
    sel('visiting', 4, 0);
    play('K');                                     // a later play, so the DP is not the newest
    eq('outs before the clear', inn('visiting', 0).outs, 3);
    sel('visiting', 2, 0);
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
    sel('visiting', 2, 0);
    clearSelectedCell();                           // clear the 2nd out
    eq('outs', inn('visiting', 0).outs, 2);
    eq('first out', ab('visiting', 0, 0).out, 1);
    eq('the 3rd out is now the 2nd', ab('visiting', 4, 0).out, 2);
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
    eq('play not recorded', ab('visiting', 6, 0).play, '');
    eq('outs', inn('visiting', 0).outs, 1);
    eq('no pitch left behind', ab('visiting', 6, 0).pitches.length, 0);
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
    eq('runner on 3rd came up in column 0', onBaseFrom('visiting', 1, 2), '12@0');
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
    eq('the runner is back on 3rd', onB('visiting', 1, 2), 12);
    eq('his column-0 cell shows no run', ab('visiting', 12, 0).bases[3], false);
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
    eq('batter has no play', ab('visiting', 2, 0).play, '');
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
    eq('batter on 1st', onB('visiting', 0, 0), 2);
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
    eq('batter on 2nd', onB('visiting', 0, 1), 4);
    basesConsistent('visiting', 0);
  });

  // #4 — the batter used to be put on 1st before the popup opened, which erased
  // the runner standing there and dropped him out of the popup's own runner list.
  test('a K+WP does not erase the runner on 1st', () => {
    sel('visiting', 0, 0);
    play('1B');                                    // p0 on 1st
    play('K+WP'); runnerPopup({ 0: 1, batter: 0 }); // runner to 2nd, batter to 1st
    eq('runner on 2nd', onB('visiting', 0, 1), 0);
    eq('batter on 1st', onB('visiting', 0, 0), 2);
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
    eq('batter on 1st', onB('visiting', 0, 0), 2);
  });

  test('the DP outcome popup lets a runner hold when the batter is out', () => {
    sel('visiting', 0, 0);
    play('1B');                                    // p0 on 1st
    promptPositionPlay('DP ');
    positionPopup('6-4-3');                        // batter is out by default on a DP
    ok('holding 1st is allowed', !ocBtn(0, 'safe', 0).disabled);
    outcomePopup({ 0: ['safe', 0] });
    eq('runner still on 1st', onB('visiting', 0, 0), 0);
    eq('outs', inn('visiting', 0).outs, 1);
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
    eq('the runner on 2nd stayed put', onB('visiting', 0, 1), 2);
    eq('the runner on 2nd did not advance', ab('visiting', 2, 0).bases[2], false);
    basesConsistent('visiting', 0);
  });

  // #4 — with 3rd occupied this used to send the runner on 2nd all the way home,
  // inventing a run out of a stolen base that never happened.
  test('a blocked bulk steal does not invent a run', () => {
    sel('visiting', 0, 0);
    play('3B');                                    // p0 on 3rd
    play('2B'); runnerPopup({ 2: 2, batter: 1 });   // p0 holds 3rd, p2 on 2nd
    sel('visiting', 4, 0);
    applyRunnerEvent('SB');
    eq('R total', rTotal('visiting'), '');
    eq('the runner did not reach home', ab('visiting', 2, 0).bases[3], false);
    eq('runner still on 2nd', onB('visiting', 0, 1), 2);
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
    sel('visiting', 2, 0);
    editPlay('1B');                                // would put p2 on an occupied 1st
    eq('play unchanged', ab('visiting', 2, 0).play, 'K');
    eq('runner on 1st unchanged', onB('visiting', 0, 0), 0);
    eq('outs', inn('visiting', 0).outs, 1);
    // The refusal is judged after the old play has been taken off the card, so the
    // rollback has to put all of it back — the out log included.
    eq('out log intact', inn('visiting', 0).outsLog.length, 1);
    eq('the out number is still on his cell', ab('visiting', 2, 0).out, 1);
    basesConsistent('visiting', 0);
  });

  test('changing a play type to a double is allowed when 2nd is open', () => {
    sel('visiting', 0, 0);
    play('1B');                                    // p0 on 1st
    play('K');
    sel('visiting', 2, 0);
    editPlay('2B', { 0: 2, batter: 1 });           // the change re-asks the runners
    eq('play', ab('visiting', 2, 0).play, '2B');
    eq('batter on 2nd', onB('visiting', 0, 1), 2);
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
    eq('trailing runner on 2nd', onB('visiting', 0, 1), 2);
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
    eq('1st', onB('visiting', 0, 0), 6);
    eq('2nd', onB('visiting', 0, 1), 4);
    eq('3rd', onB('visiting', 0, 2), 2);
    basesConsistent('visiting', 0);
  });

  test('a walk with 1st and 3rd occupied does not force the runner on 3rd', () => {
    sel('visiting', 0, 0);
    play('3B');                                    // p0 on 3rd
    play('1B'); runnerPopup({ 2: 2, batter: 0 });   // p0 holds 3rd, p2 on 1st
    play('BB');
    eq('no run scored', rTotal('visiting'), '');
    eq('runner still on 3rd', onB('visiting', 0, 2), 0);
    eq('forced runner on 2nd', onB('visiting', 0, 1), 2);
    eq('batter on 1st', onB('visiting', 0, 0), 4);
  });

  test('a grand slam clears the bases and scores four', () => {
    sel('visiting', 0, 0);
    play('1B');
    play('1B'); runnerPopup({ 0: 1, batter: 0 });
    play('1B'); runnerPopup({ 1: 2, 0: 1, batter: 0 });   // bases loaded
    play('HR');
    eq('runs', lsInput('visiting', 0).value, '4');
    eq('RBI', ab('visiting', 6, 0).rbi, 4);
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

  // #22 — the change wrote the batter's four bases and stopped, so the runners a
  // home run had just cleared were still standing on their bases: a three-run
  // homer that scored one.
  test('changing a play to a home run brings the runners round with him', () => {
    sel('visiting', 0, 0);
    play('1B');
    play('1B'); runnerPopup({ 0: 1, batter: 0 });    // p0 on 2nd, p2 on 1st
    play('K');                                       // p4 strikes out
    sel('visiting', 4, 0);
    editPlay('HR');
    eq('three runs', lsInput('visiting', 0).value, '3');
    eq('three RBI', ab('visiting', 4, 0).rbi, 3);
    eq('lead runner scored', ab('visiting', 0, 0).bases[3], true);
    eq('trailing runner scored', ab('visiting', 2, 0).bases[3], true);
    eq('bases empty', JSON.stringify(inn('visiting', 0).bases), '[null,null,null]');
    eq('the out came off', inn('visiting', 0).outs, 0);
  });

  test('changing a home run back to a strikeout empties the bases again', () => {
    sel('visiting', 0, 0);
    play('1B');
    sel('visiting', 2, 0);
    play('HR');
    eq('two runs', lsInput('visiting', 0).value, '2');
    sel('visiting', 2, 0);
    editPlay('K');
    eq('the batter is not on a base', onB('visiting', 0, 0), 0);
    eq('one out', inn('visiting', 0).outs, 1);
    // The rest of #22: the home run's advancement comes back off too, so the
    // runner it brought round is back on the base he was standing on and the run
    // is off the board. A strikeout advances nobody, so there is nothing to re-ask.
    eq('the runner he drove in goes back to 1st', ab('visiting', 0, 0).bases[3], false);
    eq('no runs', lsInput('visiting', 0).value, '');
    eq('no RBI', ab('visiting', 2, 0).rbi, 0);
  });

  /* The rest of #22. A change of play type used to adjust the batter's own bases
     and out and nothing else: the runners it had moved stayed where the old play
     put them, and the new play never asked where they should go instead. */

  test('a hit rewritten as a strikeout takes back the bases it gave', () => {
    sel('visiting', 0, 0);
    play('1B');                                      // p0 on 1st
    play('1B'); runnerPopup({ 0: 2, batter: 0 });     // p0 sent to 3rd, p2 on 1st
    sel('visiting', 2, 0);
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
    sel('visiting', 2, 0);
    // The single's advancement comes off first, so the popup asks from 1st — and
    // this time the sacrifice moves him to 2nd rather than the single doing it.
    editPlay('SH', { 0: 1 });
    eq('the runner is on 2nd', onB('visiting', 0, 1), 0);
    eq('the batter is out', inn('visiting', 0).outs, 1);
    eq('nobody else on base', occupants('visiting', 0).join(','), '0');
    // The advance is stamped to the new play, so clearing it takes it back again.
    eq('stamped to the batter who sacrificed', JSON.stringify(ab('visiting', 0, 0).advSrc[1]), '{"p":2,"col":0}');
  });

  test('a strikeout rewritten as a double play is judged on the outs left', () => {
    sel('visiting', 0, 0);
    play('1B');                                      // p0 on 1st
    play('K'); play('K');                            // 2 outs
    sel('visiting', 2, 0);
    // Legal: this cell's own out comes off first, leaving one out and a runner to
    // double off. Entered as a DP it makes both outs, ending the inning.
    editPlayCustom('DP 6-4-3', { 0: ['out', 1], batter: ['out'] });
    eq('play', ab('visiting', 2, 0).play, 'DP 6-4-3');
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
    sel('visiting', 2, 0);
    clearSelectedCell();                             // clear p2's single
    eq('the runner is back on 1st', onB('visiting', 0, 0), 0);
    eq('nobody on 2nd', onB('visiting', 0, 1), null);
    eq('his 2nd-base mark is gone', ab('visiting', 0, 0).bases[1], false);
    eq('he keeps the base he singled to', ab('visiting', 0, 0).bases[0], true);
    eq('the batter is gone from the card', ab('visiting', 2, 0).play, '');
  });

  test('clearing an older play leaves a base the runner stole', () => {
    sel('visiting', 0, 0);
    play('1B');                                      // p0 on 1st
    promptSBBase(); basePicker(0);                    // steals 2nd — his own, not a play's
    play('1B'); runnerPopup({ 1: 2, batter: 0 });     // p2 singles, p0 to 3rd
    play('K');
    sel('visiting', 2, 0);
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
    sel('visiting', 2, 0);
    clearSelectedCell();                             // clear the single that drove p0 in
    // p0 would go back to 1st, but p4 is standing there off a later single.
    eq('p0 keeps the run', ab('visiting', 0, 0).bases[3], true);
    eq('the run stays on the board', lsInput('visiting', 0).value, '1');
    eq('p4 keeps 1st', onB('visiting', 0, 0), 4);
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
    sel('visiting', 2, 0);
    clearSelectedCell();
    eq('p0 is back on 1st', onB('visiting', 0, 0), 0);
    eq('his run came off', ab('visiting', 0, 0).bases[3], false);
    eq('and off the linescore', lsInput('visiting', 0).value, '');
  });

  test('clearing a double play gives back both outs and the runner', () => {
    sel('visiting', 0, 0);
    play('1B');                                      // p0 on 1st
    promptPositionPlay('DP ');
    positionPopup('6-4-3');
    outcomePopup({ 0: ['out', 1], batter: ['out'] });
    play('K');                                       // 3rd out, so the DP isn't the latest
    eq('three outs', inn('visiting', 0).outs, 3);
    sel('visiting', 2, 0);
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
    sel('visiting', 2, 0);
    clearPlayKeepPitches();
    eq('one out left', inn('visiting', 0).outs, 1);
    eq('out log', inn('visiting', 0).outsLog.length, 1);
    eq('IP', pStat('visiting', 0, 'ip'), '0.1');
  });

  test('clearing a play but keeping its pitches also sends the runners back', () => {
    sel('visiting', 0, 0);
    play('1B');
    sel('visiting', 2, 0);
    pitch('S'); pitch('B');
    play('1B'); runnerPopup({ 0: 1, batter: 0 });     // p0 to 2nd
    play('K'); play('K');                            // no longer the latest play
    sel('visiting', 2, 0);
    clearPlayKeepPitches();
    eq('the runner is back on 1st', onB('visiting', 0, 0), 0);
    eq('pitches kept', ab('visiting', 2, 0).pitches.join(''), 'SB');
    eq('play cleared', ab('visiting', 2, 0).play, '');
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
    sel('visiting', 2, 0);
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
    sel('visiting', 2, 0);
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
})();
