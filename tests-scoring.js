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

  /* ------------------------------------------------------------- state ---
     Reset by mutating the shared gameState object (the module's binding can't
     be reassigned from here) and re-rendering only the columns a case touched.
     A full applyState() per case re-renders 18 players x 15 innings and is what
     made the audit harness take ~10 minutes. */
  const PLAYERS = POSITIONS * ROWS_PER_POS;
  const dirtyCols = new Set();

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
  function lsInput(team, i) { return document.querySelector(`input[data-ls="${team}"][data-inn="${i}"]`); }
  function rTotal(team) { return document.querySelector(`input[data-ls="${team}"][data-stat="r"]`).value; }

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

  // "Change Play Type" popup: pick a play from the grid, then Apply.
  function editPlay(newPlay) {
    editPlayType();
    const popup = document.getElementById('edit-play-popup');
    if (!visible('edit-play-popup')) fail('edit-play popup is not open');
    const btn = popup.querySelector(`.ep-btn[data-play="${newPlay}"]`);
    if (!btn) fail(`edit-play popup has no ${newPlay} button`);
    btn.onclick();
    clickId('ep-confirm');
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
    eq('runner on 1st', inn('visiting', 0).bases[0], 0);
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
    eq('runner on 1st', inn('visiting', 0).bases[0], 0);
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
    eq('1st empty', inn('visiting', 0).bases[0], null);
    eq('runner on 2nd', inn('visiting', 0).bases[1], 0);
    eq('R total', rTotal('visiting'), '');
  });

  test('caught stealing records an out and clears the base', () => {
    sel('visiting', 0, 0);
    play('1B');
    key('j');                          // only one runner: applied without a picker
    eq('outs', inn('visiting', 0).outs, 1);
    eq('1st empty', inn('visiting', 0).bases[0], null);
    eq('runner marked out on the way to 2nd', ab('visiting', 0, 0).outOnBase, 1);
  });

  test('undo reverts a single', () => {
    sel('visiting', 0, 0);
    play('1B');
    key('u');
    eq('play cleared', ab('visiting', 0, 0).play, '');
    eq('bases cleared', inn('visiting', 0).bases[0], null);
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
    const bases = inn('visiting', 0).bases;
    ok('the runner who held 2nd is still on a base', bases.indexOf(0) !== -1);
    const occupied = bases.filter(b => b !== null);
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
    const bases = inn('visiting', 0).bases;
    eq('runner on 2nd', bases[1], 0);
    eq('batter on 1st', bases[0], 2);
    eq('outs', inn('visiting', 0).outs, 0);
  });

  // #4 — the batter is out on a sacrifice, so a runner holding 1st is no clash.
  test('a sacrifice is not refused when a runner holds the base the batter would take', () => {
    sel('visiting', 0, 0);
    play('1B');                                    // p0 on 1st
    play('SH'); runnerPopup({ 0: 0, batter: 0 });   // runner holds, batter is out
    eq('outs', inn('visiting', 0).outs, 1);
    eq('runner still on 1st', inn('visiting', 0).bases[0], 0);
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
    eq('batter on 2nd', inn('visiting', 0).bases[1], 2);
    eq('outs', inn('visiting', 0).outs, 0);
  });
})();
