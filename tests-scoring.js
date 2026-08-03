/*
 * Scoring-flow regression suite.
 *
 * Runs against the full index.html DOM with app.js loaded in the same script
 * realm — see run-tests.js (`npm test`). Cases drive the app through the entry
 * points the UI uses (selectCell, applyPlay, popup buttons, keydown) rather than
 * poking state, so a fix has to work on the real user path.
 *
 * test(...) must pass; a failure fails the run.
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
    'sub-popup', 'dh-popup', 'pos-change-popup', 'backup-reminder'
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
    backupPromptDismissed = false;   // and one backup ask, likewise
    pendingTransitionTimer = null;
    if (selectedCell) selectedCell.classList.remove('selected');
    selectedCell = null;
    // SUB puts the caret in the substitute's name field (F7), and the keyboard
    // handler ignores every hotkey while an input has focus — correct in the app,
    // where the scorer is typing a name, but it must not cross into the next case.
    // The row SUB opened is shared DOM too, so it comes back closed.
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    document.querySelectorAll('tr.pos-sub.revealed').forEach(tr => tr.classList.remove('revealed'));
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

  function test(name, fn) {
    reset();
    try {
      fn();
      results.push({ name, pass: true });
    } catch (e) {
      results.push({ name, pass: false, error: (e && e.message) || String(e) });
    }
  }

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
  // Any other key into that popup's own handler — Escape, which is its cancel,
  // and the digits a hardware keyboard sends to the keypad (F10).
  function keyPosPopup(k) {
    if (!visible('pos-popup')) fail('position popup is not open');
    document.getElementById('pos-input').onkeydown({ key: k, preventDefault() {} });
  }
  // The fielder keypad: `posPad('63')` taps 6 then 3. The value it builds is read
  // off #pos-input, which is what Done and Enter read too.
  function posPad(digits) {
    if (!visible('pos-popup')) fail('position popup is not open');
    String(digits).split('').forEach(d => {
      const btn = document.querySelector(`#pos-keypad .pos-key[data-d="${d}"]`);
      if (!btn) fail(`the fielder keypad has no ${d} key`);
      btn.onclick();
    });
    return document.getElementById('pos-input').value;
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

  // M7 — a play the scorer taps rather than pitches into left a count the play could
  // not have happened on. A `K` pushed one 'X', which `getPitchCount` reads as neither
  // a ball nor a strike and `renderPitches` draws as nothing: the cell claimed a pitch
  // over an empty track, at 0-0, on a strikeout.
  test('a strikeout entered by button is three strikes', () => {
    sel('visiting', 0, 0);
    play('K');
    eq('pitches', ab('visiting', 0, 0).pitches.join(''), 'SSS');
    eq('count', JSON.stringify(getPitchCount(ab('visiting', 0, 0).pitches)), '{"balls":0,"strikes":3}');
    ok('and the track draws them', document.getElementById('pt-visiting-0-0').innerHTML.indexOf('strike') >= 0);
  });

  test('a strikeout on a worked count only pads what is missing', () => {
    sel('visiting', 0, 0);
    pitch('B'); pitch('F'); pitch('B');
    play('ꓘ');
    eq('pitches', ab('visiting', 0, 0).pitches.join(''), 'BFBSS');
    eq('count', JSON.stringify(getPitchCount(ab('visiting', 0, 0).pitches)), '{"balls":2,"strikes":3}');
  });

  test('a walk entered by button is four balls', () => {
    sel('visiting', 0, 0);
    pitch('B'); pitch('B'); pitch('B');
    play('BB');
    eq('pitches', ab('visiting', 0, 0).pitches.join(''), 'BBBB');
    eq('count', JSON.stringify(getPitchCount(ab('visiting', 0, 0).pitches)), '{"balls":4,"strikes":0}');
  });

  // An intentional walk is awarded without a pitch under the current rule, so padding
  // one to four balls would invent them.
  test('an intentional walk is not padded to four balls', () => {
    sel('visiting', 0, 0);
    play('IBB');
    eq('pitches', ab('visiting', 0, 0).pitches.join(''), 'B');
  });

  test('an auto-triggered strikeout is not padded past three strikes', () => {
    sel('visiting', 0, 0);
    pitch('S'); pitch('S'); pitch('S');
    clickId('k-swinging');
    eq('pitches', ab('visiting', 0, 0).pitches.join(''), 'SSS');
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
     Phase 2 — result-changing bugs, fixed. Each case guards the fix for the
     audit finding named in its comment.
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
    ok('and the refusal says so (L2)', visible('play-reject'));
  });

  // #2
  test('a pickoff after the 3rd out cannot make a 4th out', () => {
    sel('visiting', 0, 0);
    play('1B'); play('K'); play('K'); play('K');
    key('o');
    basePicker(0, '');                           // PO 1st — Out
    eq('outs', inn('visiting', 0).outs, 3);
    eq('stranded runner untouched', ab('visiting', 0, 0).outOnBase, null);
    ok('and the refusal says so (L2)', visible('play-reject'));
  });

  // #3
  test('a stolen base after the 3rd out cannot score a run', () => {
    sel('visiting', 0, 0);
    play('3B'); play('K'); play('K'); play('K'); // 3 outs, runner stranded on 3rd
    key('r');                                    // only SBH is offered — and since F8 it is offered, not taken
    basePicker(2);
    eq('R total', rTotal('visiting'), '');
    eq('runner did not reach home', ab('visiting', 0, 0).bases[3], false);
    ok('and the refusal says so (L2)', visible('play-reject'));
  });

  // L2 — a play refused for the 3rd out returned bare, so a scorer who entered it saw
  // the card take nothing and say nothing. Every entry path now gives the same reason,
  // and the stranded-runner paths above are the same refusal reached another way.
  test('a play entered after the 3rd out is refused out loud', () => {
    sel('visiting', 0, 0);
    play('K'); play('K'); play('K');
    sel('visiting', 9, 0);                       // the 4th batter, inning already over
    play('1B');
    eq('nothing recorded', ab('visiting', 9, 0).play, '');
    ok('the refusal is shown', visible('play-reject'));
    ok('and it names the outs',
      document.getElementById('play-reject').textContent.indexOf('3 outs') >= 0);
  });

  test('a pitch charged after the 3rd out is refused out loud', () => {
    sel('visiting', 0, 0);
    play('K'); play('K'); play('K');
    sel('visiting', 9, 0);
    pitch('B');
    eq('no pitch charged', ab('visiting', 9, 0).pitches.length, 0);
    ok('the refusal is shown', visible('play-reject'));
  });

  // The other half of the same bare return: a filled cell is not an entry point. It is
  // also where a full card leaves the selection (L4), so silence here is a dead app.
  test('a play tapped onto a cell that already has one says so', () => {
    sel('visiting', 0, 0);
    play('1B');
    sel('visiting', 0, 0);                       // back onto the filled cell
    play('2B');
    eq('the single stands', ab('visiting', 0, 0).play, '1B');
    ok('the refusal is shown', visible('play-reject'));
    ok('and it points at the change',
      document.getElementById('play-reject').textContent.indexOf('change or clear') >= 0);
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

  /* F2 — the `6-3` in the box is the placeholder, not a value. Confirming an empty
     field closed the popup and recorded nothing, silently: on iPad the keyboard
     comes up over the deck and Return is the reflex, so the out simply vanished. */
  test('confirming an empty fielder field is refused, not lost', () => {
    sel('visiting', 0, 0);
    promptGroundout();
    positionPopup('');                              // Return with nothing typed
    eq('no play was written', ab('visiting', 0, 0).play, '');
    eq('and no out was recorded', inn('visiting', 0).outs, 0);
    ok('the popup is still open to finish', visible('pos-popup'));
    ok('and it says why', visible('play-reject'));
    ok('naming what to type',
      document.getElementById('play-reject').textContent.indexOf('6-3') >= 0);
    positionPopup('6-3');                           // finishing it still works
    eq('the out lands', ab('visiting', 0, 0).play, '6-3');
    eq('on the inning too', inn('visiting', 0).outs, 1);
    ok('and the popup closed behind it', !visible('pos-popup'));
    ok('with the backdrop', !visible('popup-backdrop'));
  });

  // Whitespace is not an entry either — `.trim()` is what the guard reads.
  test('a fielder field holding only spaces is refused too', () => {
    sel('visiting', 0, 0);
    promptGroundout();
    positionPopup('   ');
    eq('no play was written', ab('visiting', 0, 0).play, '');
    ok('the popup is still open', visible('pos-popup'));
    keyPosPopup('Escape');                          // and Escape is still the way out
    ok('Escape closes it', !visible('pos-popup'));
    eq('still nothing written', ab('visiting', 0, 0).play, '');
  });

  /* F10 — the fielders were typed into a text field, and on iPad that raises the
     full alphabetic keyboard over the whole play deck to enter two digits and a
     dash. The keypad is the entry path now. What these have to prove is that it
     reaches `applyPlay` with the same code the text field produced, because every
     groundout / DP / FC case in this suite still drives the text path. */
  test('the fielder keypad builds the same code the text field did', () => {
    sel('visiting', 0, 0);
    promptGroundout();
    const input = document.getElementById('pos-input');
    ok('the keypad is on screen', visible('pos-keypad'));
    ok('and the field is readonly, so no keyboard comes up', input.readOnly);
    eq('the pad joins the fielders with a dash', posPad('63'), '6-3');
    clickId('pos-done');
    eq('the out lands', ab('visiting', 0, 0).play, '6-3');
    eq('on the inning too', inn('visiting', 0).outs, 1);
    ok('the popup closed behind it', !visible('pos-popup'));
    ok('with the backdrop', !visible('popup-backdrop'));
  });

  // A single fielder takes no dash, and the prefix is still applied around it.
  test('a one-fielder keypad entry needs no dash', () => {
    sel('visiting', 0, 0);
    promptPositionPlay('F');
    eq('just the position', posPad('7'), '7');
    clickId('pos-done');
    eq('the fly out lands', ab('visiting', 0, 0).play, 'F7');
    eq('outs', inn('visiting', 0).outs, 1);
  });

  // Three of them, through the whole double-play flow the typed path uses.
  test('a three-fielder keypad entry drives a double play', () => {
    sel('visiting', 0, 0);
    play('1B');                                     // p0 on 1st
    promptPositionPlay('DP ');
    eq('two dashes', posPad('643'), '6-4-3');
    clickId('pos-done');
    outcomePopup({ 0: ['out', 1], batter: ['out'] });
    eq('the play as the card holds it', ab('visiting', 3, 0).play, 'DP 6-4-3');
    eq('both outs', inn('visiting', 0).outs, 2);
  });

  test('Back takes off the last fielder, and the dash that came with it', () => {
    sel('visiting', 0, 0);
    promptGroundout();
    posPad('64');
    clickId('pos-back');
    eq('the 4 and its dash are gone', document.getElementById('pos-input').value, '6');
    eq('and the next tap re-dashes', posPad('3'), '6-3');
    clickId('pos-back');
    clickId('pos-back');
    eq('back to empty', document.getElementById('pos-input').value, '');
    clickId('pos-back');                            // and Back on empty is harmless
    eq('still empty', document.getElementById('pos-input').value, '');
    clickId('pos-cancel');
  });

  // Four dashed fielders is the whole field the code can hold (1-6-4-3); a fifth
  // tap would push past it, and `maxlength` doesn't apply to a value set by script.
  test('the keypad stops at four fielders', () => {
    sel('visiting', 0, 0);
    promptGroundout();
    eq('four fit', posPad('1643'), '1-6-4-3');
    eq('the fifth is ignored', posPad('2'), '1-6-4-3');
    clickId('pos-cancel');
  });

  /* The Magic Keyboard path. The field is readonly, so these keys would do
     nothing at all if the popup didn't read them itself. */
  test('hardware digits drive the keypad, and a typed dash is a no-op', () => {
    sel('visiting', 0, 0);
    promptGroundout();
    keyPosPopup('6');
    keyPosPopup('-');                               // the reflex, already supplied
    keyPosPopup('3');
    eq('one dash, not two', document.getElementById('pos-input').value, '6-3');
    keyPosPopup('Backspace');
    eq('Backspace works there too', document.getElementById('pos-input').value, '6');
    keyPosPopup('3');
    keyPosPopup('Enter');                           // Enter still confirms
    eq('the out lands', ab('visiting', 0, 0).play, '6-3');
  });

  /* Before F10 the popup could only be completed with a hardware Return and only
     escaped with a hardware Escape — neither of which a scorer holding an iPad
     has. Both are buttons now. */
  test('Cancel closes the fielder popup and writes nothing', () => {
    sel('visiting', 0, 0);
    promptGroundout();
    posPad('63');
    clickId('pos-cancel');
    ok('the popup closed', !visible('pos-popup'));
    ok('and the backdrop with it', !visible('popup-backdrop'));
    eq('no play was written', ab('visiting', 0, 0).play, '');
    eq('no out either', inn('visiting', 0).outs, 0);
  });

  test('Done with nothing tapped is refused, not lost', () => {
    sel('visiting', 0, 0);
    promptGroundout();
    clickId('pos-done');
    eq('no play was written', ab('visiting', 0, 0).play, '');
    ok('the popup is still open to finish', visible('pos-popup'));
    ok('and it says why', visible('play-reject'));
    ok('naming what to tap',
      document.getElementById('play-reject').textContent.indexOf('6-3') >= 0);
    posPad('63');
    clickId('pos-done');                            // finishing it still works
    eq('the out lands', ab('visiting', 0, 0).play, '6-3');
  });

  /* "Type it" is the way in for the codes a pad of digits can't spell — `6/4-3`,
     `3U` — and it is the only path that should ever raise a keyboard. */
  test('"Type it" hands back the field, and the next entry gets the keypad again', () => {
    sel('visiting', 0, 0);
    promptPositionPlay('E');
    const input = document.getElementById('pos-input');
    posPad('6');
    clickId('pos-type');
    ok('the field takes typing now', !input.readOnly);
    eq('a keyboard, not a number pad', input.getAttribute('inputmode'), 'text');
    eq('what the pad built is still there', input.value, '6');
    input.value = '6/4-3';                          // what a keyboard is for
    keyPosPopup('Enter');
    eq('the typed code lands whole', ab('visiting', 0, 0).play, 'E6/4-3');

    sel('visiting', 3, 0);
    promptGroundout();
    ok('the next entry is readonly again', input.readOnly);
    eq('and numeric again', input.getAttribute('inputmode'), 'numeric');
    ok('with Type it back on offer', visible('pos-type'));
    eq('and the pad still builds codes', posPad('63'), '6-3');
    clickId('pos-cancel');
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

  // M6 — IP was blank at 0 outs, so a reliever who came in, gave up a hit and was
  // pulled read as a man who never pitched. The row he shares that blank with is the
  // one that genuinely never pitched, which is the whole problem.
  test('a pitcher who retires nobody has an IP of 0.0', () => {
    sel('visiting', 0, 0);
    play('1B');
    eq('IP', pStat('visiting', 0, 'ip'), '0.0');
    eq('and a hit against him', pStat('visiting', 0, 'h'), '1');
  });

  test('a pitcher who never came in still has no line', () => {
    sel('visiting', 0, 0);
    play('1B');
    eq('the reliever\'s IP', pStat('visiting', 1, 'ip'), '');
  });

  test('a walk with nobody retired is an appearance too', () => {
    sel('visiting', 0, 0);
    play('BB');
    eq('IP', pStat('visiting', 0, 'ip'), '0.0');
  });

  // #10 — the batter's own out was already counted; this guards against the
  // outsLog pass double-counting it.
  test('three strikeouts charge exactly one full inning', () => {
    sel('visiting', 0, 0);
    play('K'); play('K'); play('K');
    eq('out log length', inn('visiting', 0).outsLog.length, 3);
    eq('IP', pStat('visiting', 0, 'ip'), '1.0');
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
    eq('IP', pStat('visiting', 0, 'ip'), '1.0');
  });

  // L4 — batting around needs a column to spill into, and there is nothing after the
  // 15th. The overflow used to return bare, leaving the selection on the filled cell it
  // came from and the card looking dead.
  test('an inning that bats around in the last column says the card is full', () => {
    sel('visiting', 0, INNINGS - 1);
    for (let i = 0; i < 9; i++) play('BB');          // fills all 9 spots, inning still live
    eq('no column to spill into', curCol(), INNINGS - 1);
    ok('the wall is announced', visible('play-reject'));
    ok('and it names the card, not the cell',
      document.getElementById('play-reject').textContent.indexOf('card is full') >= 0);
    // The scorer is now parked on a filled cell, which is its own refusal (L2) — the
    // two walls have different answers, so they must not read the same.
    play('1B');
    eq('and the 10th batter is still not recorded anywhere', ab('visiting', 0, INNINGS - 1).play, 'BB');
    ok('the second wall speaks too',
      document.getElementById('play-reject').textContent.indexOf('already has a play') >= 0);
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
    // The single is still on the card, so he has faced a batter and retired nobody (M6).
    eq('IP', pStat('visiting', 0, 'ip'), '0.0');
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
    eq('IP', pStat('visiting', 0, 'ip'), '0.0');
  });

  // M5 — the history is memory-only by decision (D9), so a reload empties it.
  // What the finding was about is the silence: pressing Undo on a reloaded card
  // did nothing at all and read as a dead button.
  test('undo on a reloaded card says the history is gone rather than nothing', () => {
    clearStorage();
    try {
      sel('visiting', 0, 0);
      play('1B');
      flushSave();
      playHistory.length = 0;   // a real refresh reloads the module; the harness keeps it
      loadState();
      applyState();
      eq('the card came back', ab('visiting', 0, 0).play, '1B');
      undoLastPlay();
      ok('the press is answered', visible('play-reject'));
      ok('and it names the session limit',
        document.getElementById('play-reject').textContent.indexOf('this session only') >= 0);
      eq('the play is still on the card', ab('visiting', 0, 0).play, '1B');
      eq('and the runner is still on 1st', onB('visiting', 0, 0), 0);
    } finally { clearStorage(); }
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

  /* ----------------------------------------------------------------- F11 ---
     The app's most frequent popup. It pre-selected nothing, refused an empty
     Confirm with an 800ms outline and no words, and had no way out at all.

     F11c's ruling: fill in the runners only when every one of them is *forced* —
     the batter is on his way to the base behind him and he must vacate it, so
     nothing is being guessed. Any judgement in the play and it goes back to
     asking. Two conditions: the batter ends on first, and the occupied bases run
     in an unbroken chain from 1st. */

  test('a single with a man on first fills the force in', () => {
    sel('visiting', 0, 0);
    play('1B');
    clickId('spray-skip');
    play('1B');                                     // forced: 1st→2nd, batter→1st
    ok('the popup still opens', visible('runner-popup'));
    clickId('rp-confirm');                          // answered without touching a row
    eq('the forced runner took second', onB('visiting', 0, 1), 0);
    eq('and the batter has first', onB('visiting', 0, 0), 3);
    clickId('spray-skip');
    basesConsistent('visiting', 0);
  });

  test('bases loaded, a single forces the man on third home', () => {
    sel('visiting', 0, 0);
    play('1B'); clickId('spray-skip');
    play('1B'); clickId('rp-confirm'); clickId('spray-skip');
    play('1B'); clickId('rp-confirm'); clickId('spray-skip');   // loaded
    eq('the bases are loaded', occupants('visiting', 0).length, 3);
    play('1B');
    clickId('rp-confirm');
    eq('the run is forced in', lsInput('visiting', 0).value, '1');
    clickId('spray-skip');
    basesConsistent('visiting', 0);
  });

  // A man on 2nd may score or may hold at 3rd, and only the scorer saw which.
  test('a single with a man on second only is still asked', () => {
    sel('visiting', 0, 0);
    play('2B');
    clickId('spray-skip');
    play('1B');
    ok('the popup is open', visible('runner-popup'));
    clickId('rp-confirm');
    ok('an empty Confirm is refused', visible('runner-popup'));
    ok('and says so in words', visible('play-reject'));
    ok('naming what it wants',
      document.getElementById('play-reject').textContent.indexOf('base for every runner') >= 0);
    eq('nothing was written', onB('visiting', 0, 1), 0);
  });

  // On a double the man on 1st is forced out of 1st, but where he stops is
  // judgement — and his forced base is the one the batter is taking.
  test('a double with a man on first is not filled in', () => {
    sel('visiting', 0, 0);
    play('1B');
    clickId('spray-skip');
    play('2B');
    clickId('rp-confirm');
    ok('an empty Confirm is refused', visible('runner-popup'));
    runnerPopup({ 0: 2, batter: 1 });
    clickId('spray-skip');
  });

  // First and third: only the man on 1st is forced, so neither is filled in.
  test('a broken chain of runners is not filled in', () => {
    sel('visiting', 0, 0);
    play('3B');
    clickId('spray-skip');
    play('1B');
    runnerPopup({ 2: 2, batter: 0 });               // man holds 3rd, batter to 1st
    clickId('spray-skip');
    eq('first and third', onB('visiting', 0, 0), 3);
    eq('with 2nd empty', onB('visiting', 0, 1), null);
    play('1B');
    clickId('rp-confirm');
    ok('an empty Confirm is refused', visible('runner-popup'));
    runnerPopup({ 0: 1, 2: 3, batter: 0 });
    clickId('spray-skip');
  });

  /* F11b — there was no way out: no Cancel, and Escape did nothing. `ab.play` and
     its result pitch are committed before the popup opens, so a play button pressed
     by mistake meant completing a wrong entry and then undoing it. */
  test('Cancel takes the play back off the card', () => {
    sel('visiting', 0, 0);
    play('1B');
    clickId('spray-skip');
    sel('visiting', 3, 0);
    play('2B');                                     // the wrong button
    ok('the popup is open', visible('runner-popup'));
    clickId('rp-cancel');
    ok('the popup closed', !visible('runner-popup'));
    eq('the double came off the card', ab('visiting', 3, 0).play, '');
    eq('and its result pitch with it', (ab('visiting', 3, 0).pitches || []).length, 0);
    eq('the runner is where he was', onB('visiting', 0, 0), 0);
    eq('and nothing was left on the undo stack', playHistory.length, 1);
  });

  // A wild pitch writes nothing until Confirm, so its Cancel has nothing to undo —
  // it must not reach for a rollback that does not belong to it.
  test('Cancel on a wild pitch leaves the card alone', () => {
    sel('visiting', 0, 0);
    play('1B'); clickId('spray-skip');
    play('1B'); clickId('rp-confirm'); clickId('spray-skip');
    const depth = playHistory.length;
    key('n');                                       // wild pitch, two men on
    ok('the popup is open', visible('runner-popup'));
    clickId('rp-cancel');
    ok('the popup closed', !visible('runner-popup'));
    eq('both runners stayed', occupants('visiting', 0).length, 2);
    eq('and the undo stack is untouched', playHistory.length, depth);
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
  //
  // This state is also what the deleted 'a blocked bulk steal does not invent a run'
  // case drove: applyRunnerEvent's own SB branch, which the UI never reached and
  // which is gone (m2). The invariant it guarded — a blocked steal invents no run —
  // is the three assertions below, on the path the scorer actually presses.
  test('a steal through an occupied base is not offered', () => {
    sel('visiting', 0, 0);
    play('3B');                                    // p0 on 3rd
    play('2B'); runnerPopup({ 2: 2, batter: 1 });   // p0 holds 3rd, p2 on 2nd
    key('r');
    basePicker(2);                                  // SBH is the only legal steal, and F8 makes it a choice
    eq('the runner on 3rd stole home', lsInput('visiting', 0).value, '1');
    eq('the runner on 2nd stayed put', onB('visiting', 0, 1), 3);
    eq('the runner on 2nd did not advance', ab('visiting', 3, 0).bases[2], false);
    basesConsistent('visiting', 0);
  });

  /* F8 — that same shape is why the one-option shortcut had to lose the plate.
     Men on 2nd and 3rd: the steal of 3rd is blocked, so 3rd→home is the only
     legal option — and SB scored a run with no picker and no confirmation. A
     scorer who taps SB with two men on almost certainly means the other one. */
  test('a lone steal of home is offered, not applied', () => {
    sel('visiting', 0, 0);
    play('3B');                                     // p0 on 3rd
    play('2B'); runnerPopup({ 2: 2, batter: 1 });   // p0 holds 3rd, p3 on 2nd
    promptSBBase();
    ok('the picker opened instead', visible('base-picker'));
    eq('and nothing scored', lsInput('visiting', 0).value, '');
    eq('the man on third is still there', onB('visiting', 0, 2), 0);
    clickId('bp-cancel');
    eq('cancelling leaves him there too', onB('visiting', 0, 2), 0);
    eq('and the line clean', lsInput('visiting', 0).value, '');
  });

  /* The shortcut read as if it served the common case. It never did: every
     stealable base also offers its +E variant, so one runner with a clear path
     always produced two options and got a picker anyway. Pinned here so the
     shortcut is not reintroduced on the strength of how it read. */
  test('a steal with one runner was always a picker anyway', () => {
    sel('visiting', 0, 0);
    play('1B');
    promptSBBase();
    ok('a runner on first gets the picker', visible('base-picker'));
    ok('because the error variant is the second option',
      document.getElementById('base-picker').querySelectorAll('.bp-opt').length === 2);
    basePicker(0);
    eq('he took second', onB('visiting', 0, 1), 0);
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
    eq('the runner on 1st is offered 3rd, home and out', mrDests(0).join(','), '2,3,out');
    eq('the runner on 2nd is offered 3rd, home and out', mrDests(1).join(','), '2,3,out');
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

  // A balk is the forced-advance case now: rule 6.02(a) awards every runner a base,
  // so BK is what still goes through advanceRunners in bulk. A wild pitch with more
  // than one man on asks which of them moved (m1), and its cases are at the end.
  test('a balk advances every runner one base and scores from 3rd', () => {
    sel('visiting', 0, 0);
    play('3B');                                    // p0 on 3rd
    play('1B'); runnerPopup({ 2: 2, batter: 0 });   // p0 holds 3rd, p3 on 1st
    applyRunnerEvent('BK');
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

  // #20's second case was the same assertion against applyRunnerEvent's own CS
  // branch, which no button or key ever reached and which is gone (m2) — the case
  // above drives the path the scorer has, through undoLastPlay's sibling.
  test('undoLastPlay cancels a base out\'s transition the same way the key does', () => {
    sel('visiting', 0, 0);
    play('K'); play('K');
    play('1B');
    promptCSBase();                                // single option, applies directly
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
    basePicker(2);
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
    basePicker(2);
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

  /* L5 — the home team doesn't bat in the bottom of the last inning when it is already
     ahead. That half stayed blank, which on a linescore means "batted, scored nothing"
     — the 0 of a team that lost, printed on the row of the team that won. */
  test('a home half never played reads X once the game is final', () => {
    lsInput('home', 0).value = '2';                 // home leads 2-0
    updateLinescoreTotals('home');
    sel('visiting', 0, 8);                          // top of the 9th
    play('K'); play('K'); play('K');                // three outs, and that is the game
    ok('the game is final', gameIsFinal());
    eq('the home 9th', lsInput('home', 8).value, 'X');
    eq('and nothing else', lsInput('home', 7).value, '');
    eq('the R total is untouched by it', rTotal('home'), '2');
  });

  test('a home team that batted last gets no X', () => {
    sel('home', 0, 8);
    play('HR');                                     // walk-off, 1-0
    ok('the game is final', gameIsFinal());
    for (let i = 0; i < 9; i++) ok(`home inning ${i + 1} is not an X`, lsInput('home', i).value !== 'X');
  });

  // Derived on every pass, like FINAL: the X is not a mark anything has to remember to
  // take back off.
  test('correcting the score back to a tie takes the X away again', () => {
    lsInput('home', 0).value = '2';
    updateLinescoreTotals('home');
    sel('visiting', 0, 8);
    play('K'); play('K'); play('K');
    eq('the X is on the line', lsInput('home', 8).value, 'X');
    lsInput('home', 0).value = '';                  // those two runs were a mistake
    updateLinescoreTotals('home');
    sel('visiting', 9, 8);                          // any tap repaints the line
    eq('the X is gone', lsInput('home', 8).value, '');
    eq('and so is it in the state', gameState.linescore.home.innings[8], '');
  });

  /* F1 — both of those figures are derived by `fillLinescoreZeros`, whose only
     caller was `updateSituation`, and that returns early with nothing selected.
     A reloaded card has nothing selected, so a finished game came back reading as
     if only its scoring innings had been played. It corrected itself on the first
     tap, which is what made it easy to miss. `selectedCell = null` here is what a
     reload actually starts from. */
  test('a reloaded card keeps the zeros of its scoreless innings', () => {
    sel('visiting', 0, 0);
    play('K'); play('K'); play('K');
    eq('the scoreless half reads 0', lsInput('visiting', 0).value, '0');
    collectState();
    selectedCell = null;
    applyState();
    eq('and still reads 0 after the reload', lsInput('visiting', 0).value, '0');
    eq('with the state agreeing', gameState.linescore.visiting.innings[0], '0');
    eq('an inning nobody batted in stays blank', lsInput('visiting', 1).value, '');
  });

  /* The X, unlike the zeros, is restored from the store on a plain reload — the
     load path has no `updateInningRuns` to blank it with, because nobody batted in
     that half. What it could not do before was *derive* one that isn't there: a
     card from a build that never wrote it, or one hand-edited, stayed without it
     until the first tap. `markUnplayedHomeHalf` runs off the tail of
     `fillLinescoreZeros`, so it reaches the load path by the same fix. */
  test('a reloaded home win derives the X its save never had', () => {
    lsInput('home', 0).value = '2';
    updateLinescoreTotals('home');
    sel('visiting', 0, 8);
    play('K'); play('K'); play('K');
    eq('the X is on the line', lsInput('home', 8).value, 'X');
    collectState();
    gameState.linescore.home.innings[8] = '';       // the save that never held one
    lsInput('home', 8).value = '';
    selectedCell = null;
    applyState();
    eq('the reload works it out again', lsInput('home', 8).value, 'X');
    eq('with the state agreeing', gameState.linescore.home.innings[8], 'X');
    eq('the R total is untouched by it', rTotal('home'), '2');
  });

  // A figure already on the line is a scorer saying the half *was* played, with no
  // at-bats to find — the card of someone keeping the other side on the line only.
  test('a run already on the line is not overwritten by an X', () => {
    lsInput('home', 8).value = '2';                 // home scored in the 9th, line only
    updateLinescoreTotals('home');
    sel('visiting', 0, 8);
    play('K'); play('K'); play('K');
    ok('the game is final', gameIsFinal());
    eq('the figure stands', lsInput('home', 8).value, '2');
  });

  /* The backup prompt. A finished card lives in one browser's localStorage and nowhere
     else until it is exported, and nothing used to say so. Derived from the records the
     way FINAL and the X are, so it comes and goes with the game being over. */

  // exportGameJSON's download plumbing is Blob + createObjectURL + a synthetic anchor
  // click, none of which jsdom implements. Stub the writer only — the real
  // exportGameJSON, collectState and stateForStorage stay on the path.
  function exportWithoutDownloading() {
    const real = downloadTextFile;
    let written = null;
    downloadTextFile = function (name, text) { written = { name, text }; };
    try { exportGameJSON(); } finally { downloadTextFile = real; }
    return written;
  }

  test('a game in progress is not asked to be backed up', () => {
    sel('visiting', 0, 0);
    play('1B'); play('HR');
    ok('no banner mid-game', !visible('backup-reminder'));
  });

  test('a finished game asks to be backed up', () => {
    sel('home', 0, 8);
    play('HR');                                     // walk-off, 1-0
    ok('the game is final', gameIsFinal());
    ok('and the card asks for a backup', visible('backup-reminder'));
  });

  test('exporting answers the ask, and the file says it is the backup', () => {
    clearStorage();
    try {
      sel('home', 0, 8);
      play('HR');
      ok('asked first', visible('backup-reminder'));
      const written = exportWithoutDownloading();
      ok('a file was written', !!written && written.name.indexOf('.json') > 0);
      eq('and it carries the stamp', JSON.parse(written.text).backedUp, true);
      eq('the card knows it is backed up', gameState.backedUp, true);
      ok('so the banner is gone', !visible('backup-reminder'));
    } finally { clearStorage(); }
  });

  // A correction after the export means the file no longer matches the card.
  test('a change after the export asks again', () => {
    clearStorage();
    try {
      sel('home', 0, 8);
      play('HR');
      exportWithoutDownloading();
      ok('answered', !visible('backup-reminder'));
      sel('home', 3, 8);
      play('1B');                                   // correcting the final card (M1)
      eq('the stamp is off', gameState.backedUp, false);
      ok('and it asks again', visible('backup-reminder'));
    } finally { clearStorage(); }
  });

  // "Not now" is the session's answer, not the card's — nothing is written, so a
  // reload asks again. What it must not do is come back mid-session.
  test('Not now holds for the session, through later changes', () => {
    sel('home', 0, 8);
    play('HR');
    dismissBackupReminder();
    ok('hidden', !visible('backup-reminder'));
    eq('and nothing was recorded as backed up', gameState.backedUp, false);
    sel('home', 3, 8);
    play('1B');
    ok('still hidden', !visible('backup-reminder'));
  });

  test('taking the winning run back off the card takes the ask with it', () => {
    sel('home', 0, 8);
    play('HR');
    ok('asked', visible('backup-reminder'));
    sel('home', 0, 8);
    clearSelectedCell();
    ok('the game is live again', !gameIsFinal());
    ok('so nothing is asked', !visible('backup-reminder'));
  });

  test('a save written before the stamp existed reads as not backed up', () => {
    const saved = JSON.parse(JSON.stringify(createEmptyState()));
    delete saved.backedUp;
    eq('backfilled', mergeStateDefaults(saved).backedUp, false);
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
    eq('IP', pStat('visiting', 0, 'ip'), '1.0');
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
    eq('IP', pStat('visiting', 0, 'ip'), '0.0');
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

  // A balk moves everybody up one, like a wild pitch. The positive path, so the
  // bases-empty refusal below is a refusal of something that otherwise works.
  test('a balk moves the runners up a base', () => {
    sel('visiting', 0, 0);
    play('1B');                                     // p0 on 1st
    applyRunnerEvent('BK');
    eq('he took 2nd on the balk', onB('visiting', 0, 1), 0);
    eq('one entry to undo', playHistory.length, 2);  // the single, then the balk
  });

  // L1 — with nobody on, every branch of applyRunnerEvent is a no-op, and it used to
  // run them after pushing an undo snapshot: dead presses of Undo standing between
  // the scorer and the last play that really happened.
  test('a balk with the bases empty is refused, and pushes nothing to undo', () => {
    sel('visiting', 0, 0);
    applyRunnerEvent('BK');
    eq('nothing to undo', playHistory.length, 0);
    ok('the press is answered', visible('play-reject'));
    ok('and it says what a balk with nobody on is',
      document.getElementById('play-reject').textContent.indexOf('ball to the batter') >= 0);
  });

  test('a wild pitch with nobody on says why it is not charged', () => {
    sel('visiting', 0, 0);
    applyRunnerEvent('WP');
    eq('nothing to undo', playHistory.length, 0);
    ok('the press is answered', visible('play-reject'));
    ok('and it names the rule\'s condition',
      document.getElementById('play-reject').textContent.indexOf('when a runner advances') >= 0);
  });

  // The runner scored on the play, so the bases are empty again — the same state a
  // leadoff press sees, and it must not be mistaken for one.
  test('a passed ball after the bases empty out is refused too', () => {
    sel('visiting', 0, 0);
    play('HR');
    applyRunnerEvent('PB');
    eq('only the home run is on the history', playHistory.length, 1);
    ok('the press is answered', visible('play-reject'));
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
    // The RBI+ press needs a run in the inning to attach to (m4), so he triples and
    // scores on a wild pitch — a run the app credits to nobody, which is the case
    // the manual override exists for.
    play('3B');
    key('n');
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
  // first place — the guards above are the belt to its braces. The spray popup
  // that opens behind the answered runner popup keeps the backdrop up: it is
  // guarded too since F6, and this is the two-popups-in-a-row path.
  test('the entry popups draw a backdrop over the card', () => {
    sel('visiting', 0, 0);
    play('1B');
    play('2B');
    ok('the backdrop is up with the runner popup', visible('popup-backdrop'));
    runnerPopup({ 0: 2, batter: 1 });
    ok('the spray popup takes it over', visible('spray-popup'));
    clickId('spray-skip');
    ok('and it is gone once nothing is open', !visible('popup-backdrop'));
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
    ok('and the backdrop went with it too', !visible('popup-backdrop'));
  });

  /* ------------------------------------------------------------------ F6 ---
     A popup drawn over the card with no backdrop leaves the card live under it.
     The review reproduced the damage by touch: open the pickoff picker, tap the
     Visiting tab behind it, and the picker applied against the half-inning it
     had captured when it opened. Eleven popups render over the card; four had a
     backdrop. */

  // The guard list is derived rather than written out a second time, which is
  // how it came to be missing seven of the popups it names.
  test('every popup that renders over the card raises the backdrop', () => {
    const guarded = backdropGuarded();
    ['spray-popup', 'base-picker', 'edit-play-popup', 'move-runner-popup',
     'er-review-popup', 'recompute-popup', 'sub-popup', 'dh-popup',
     'pitcher-popup', 'pos-change-popup', 'decision-popup'].forEach(id => {
      ok(id + ' is guarded', guarded.indexOf(id) >= 0);
    });
  });

  test('the base picker raises the backdrop and drops it again', () => {
    sel('visiting', 0, 0);
    play('3B');
    clickId('spray-skip');
    sel('visiting', 3, 0);
    play('1B');
    runnerPopup({ 2: 2, batter: 0 });               // holds third, batter to first
    clickId('spray-skip');
    // First and third, so SB has two bases to offer rather than applying straight.
    promptSBBase();
    ok('the picker is open', visible('base-picker'));
    ok('and the backdrop with it', visible('popup-backdrop'));
    clickId('bp-cancel');
    ok('Cancel closes it', !visible('base-picker'));
    ok('and takes the backdrop down', !visible('popup-backdrop'));
    eq('the man on first stayed there', onB('visiting', 0, 0), 3);
    eq('and the man on third with him', onB('visiting', 0, 2), 0);
  });

  // The tap the review used to switch the card under the picker now lands on the
  // backdrop, and the backdrop closes the picker rather than swallowing in silence.
  test('a tap behind the base picker closes it instead of reaching the card', () => {
    sel('visiting', 0, 0);
    play('1B');
    clickId('spray-skip');
    promptPickoff();
    ok('the picker is open', visible('base-picker'));
    clickId('popup-backdrop');
    ok('the tap closed the picker', !visible('base-picker'));
    ok('and the backdrop went with it', !visible('popup-backdrop'));
    eq('the runner is still on first', onB('visiting', 0,0), 0);
    eq('and no out was recorded', inn('visiting', 0).outs, 0);
  });

  // The strikeout popup opens by itself at three strikes and is on the pending
  // list, so it disabled the undo that would have been the way out of it.
  test('the strikeout popup can be cancelled', () => {
    sel('visiting', 0, 0);
    pitch('S'); pitch('S'); pitch('S');
    ok('the popup opened by itself', visible('k-popup'));
    ok('behind a backdrop', visible('popup-backdrop'));
    clickId('k-cancel');
    ok('Cancel closes it', !visible('k-popup'));
    ok('and drops the backdrop', !visible('popup-backdrop'));
    eq('no strikeout was written', ab('visiting', 0, 0).play, '');
    eq('and the count is where it was', getPitchCount(ab('visiting', 0, 0).pitches).strikes, 3);
  });

  // The two that own a half-written entry are the exception: a tap outside says
  // so rather than dismissing them.
  test('a tap behind the runner popup is refused, not obeyed', () => {
    sel('visiting', 0, 0);
    play('1B');
    clickId('spray-skip');
    sel('visiting', 3, 0);
    play('2B');
    ok('the runner popup is open', visible('runner-popup'));
    clickId('popup-backdrop');
    ok('it is still open', visible('runner-popup'));
    ok('and the tap was answered', visible('play-reject'));
    ok('with the reason',
      document.getElementById('play-reject').textContent.indexOf('Finish the open entry') >= 0);
    runnerPopup({ 0: 3, batter: 2 });
    clickId('spray-skip');
  });

  // Escape closed the two modals and nothing else, so a Magic Keyboard was no
  // better off than a finger.
  test('Escape closes a popup that can be cancelled', () => {
    sel('visiting', 0, 0);
    play('1B');
    ok('the spray popup is up', visible('spray-popup'));
    key('Escape');
    ok('Escape closed it', !visible('spray-popup'));
    ok('and the backdrop with it', !visible('popup-backdrop'));
  });

  // The spray handler lives on the SVG, not on the popup, so every close path has
  // to take it off — a handler left attached belongs to the previous at-bat and
  // would write the next hit's location onto it. Asserted on the binding rather
  // than by clicking the field: jsdom has no SVG geometry to click with.
  test('a spray popup closed from outside releases the field', () => {
    sel('visiting', 0, 0);
    play('1B');
    ok('the field is listening', sprayClickHandler !== null);
    clickId('popup-backdrop');
    ok('the popup closed', !visible('spray-popup'));
    ok('and let go of the field', sprayClickHandler === null);
  });

  /* ------------------------------------------------------------------ F3 ---
     A fresh card with the lineups in has nothing selected, and around twenty
     entry points answered that with a bare `return`. Tapping 1B — the likeliest
     first tap of a game — did nothing and said nothing. */

  // Clears the toast first, so what it finds afterwards is this press's answer.
  function refusesWithNoCell(label, run) {
    selectedCell = null;
    const toast = document.getElementById('play-reject');
    if (toast) toast.style.display = 'none';
    const before = JSON.stringify(gameState.teams);
    run();
    ok(label + ' says why it refused', visible('play-reject'));
    ok(label + ' points at the card',
      document.getElementById('play-reject').textContent.indexOf('cell') >= 0);
    ok(label + ' wrote nothing', JSON.stringify(gameState.teams) === before);
  }

  test('every entry point says why it refuses with no cell selected', () => {
    refusesWithNoCell('1B', () => applyPlay('1B'));
    refusesWithNoCell('a pitch', () => addPitch('S'));
    refusesWithNoCell('removing a pitch', () => removePitch());
    refusesWithNoCell('GO', () => promptGroundout());
    refusesWithNoCell('the strikeout popup', () => showStrikeoutPopup());
    refusesWithNoCell('SB', () => promptSBBase());
    refusesWithNoCell('CS', () => promptCSBase());
    refusesWithNoCell('PK', () => promptPickoff());
    refusesWithNoCell('WP', () => applyRunnerEvent('WP'));
    refusesWithNoCell('SUB', () => markSub());
    refusesWithNoCell('PR', () => markPinchRunner());
    refusesWithNoCell('PIT', () => changePitcher());
    refusesWithNoCell('POS', () => changeFieldPos());
    refusesWithNoCell('Move', () => moveRunner());
    refusesWithNoCell('Adv', () => editRunners());
    refusesWithNoCell('Edit play', () => editPlayType());
    refusesWithNoCell('Spray', () => editSprayChart());
    refusesWithNoCell('RBI', () => adjustRBI(1));
    refusesWithNoCell('ER review', () => reviewEarnedRuns());
    refusesWithNoCell('CLR Play', () => clearPlayKeepPitches());
    refusesWithNoCell('Clear Cell', () => clearSelectedCell());
  });

  // Deliberately still silent: this one runs on every repaint, so a toast here
  // would fire on its own with nobody having pressed anything.
  test('the repaint stays quiet with nothing selected', () => {
    selectedCell = null;
    const toast = document.getElementById('play-reject');
    if (toast) toast.style.display = 'none';
    updateSituation();
    ok('no toast', !visible('play-reject'));
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

  /* F7 — all of that was invisible. The substitution went on the card, but the row
     holding the substitute's name is `visibility: collapse` until it has a name in
     it, and a collapsed row refuses focus — so the field the scorer needs could not
     be reached, and nothing pointed at "Show sub rows" as the way in. SUB was a
     press with no toast, no mark and no next step. */
  test('SUB opens the row it just created and puts the caret in it', () => {
    sel('visiting', 0, 1);
    markSub();
    const inp = document.querySelector('input[data-field="name"][data-team="visiting"][data-p="1"]');
    ok('the sub row is open', inp.closest('tr').classList.contains('revealed'));
    ok('with the caret in the name field', document.activeElement === inp);
    ok('and the press said so', visible('play-reject'));
    eq('as a notice, not a refusal',
      document.getElementById('play-reject').dataset.tone, 'notice');
  });

  // Only the one slot. `show-subs` opens all eighteen, which costs about half the
  // visible batting slots on an iPad — the reason this is per-row.
  test('SUB does not open every other slot\'s sub row', () => {
    sel('visiting', 0, 1);
    markSub();
    const opened = document.querySelectorAll('tr.pos-sub.revealed');
    eq('one row opened', opened.length, 1);
    ok('and the wrap was not switched to show-subs',
      !document.querySelector('.grid-wrap.show-subs'));
  });

  // A SUB pressed by mistake should not strand an open blank row on the card.
  test('a SUB left without a name closes its row again', () => {
    sel('visiting', 0, 1);
    markSub();
    const inp = document.querySelector('input[data-field="name"][data-team="visiting"][data-p="1"]');
    inp.blur();
    ok('the empty row closed', !inp.closest('tr').classList.contains('revealed'));
  });

  test('a SUB that was named keeps its row open', () => {
    lineupDirty = true;
    sel('visiting', 0, 1);
    markSub();
    const inp = document.querySelector('input[data-field="name"][data-team="visiting"][data-p="1"]');
    inp.value = 'Carter';
    inp.blur();
    ok('the named row stays open', inp.closest('tr').classList.contains('revealed'));
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
    eq('a full inning', pStat('visiting', 0, 'ip'), '1.0');
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
    eq('no outs, but he pitched', pStat('visiting', 0, 'ip'), '0.0');
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

  /* =====================================================================
     2026-07-31 audit.

     Eight findings in three families, one commit each — all landed. These are
     the regression cases; each one failed before its family's fix.

       Family A (C3, M1, M5)  editRunners / moveRunner skipped the common tail
                              `afterStateChange`, and applyChosenAdvancements
                              cleared a runner whose out was refused.
       Family B (C1, M3, M4)  columnMap was edited as a side effect of moving
                              the selection: an overflow relabelled an inning
                              already recorded, the next half-inning was chosen
                              by scanning for an empty column, and undo could
                              not take an inserted column back.
       Family C (C2, M2)      the DP/FC/TP popup advanced runners the scorer
                              never moved, and removePitch could not take back
                              an auto-triggered walk or strikeout.
     ===================================================================== */

  // The move-runner popup's destination buttons. `mrDests` above lists them;
  // this presses one.
  function mrClick(fromBase, to) {
    const btn = document.getElementById('move-runner-popup')
      .querySelector(`.mr-btn[data-from="${fromBase}"][data-to="${to}"]`);
    if (!btn) fail(`move-runner popup has no option from=${fromBase} to=${to}`);
    btn.onclick();
  }

  /* ---- Family A ---------------------------------------------------- */

  // C3 — `editRunners` ended at `updateInningRuns` and never reached
  // `afterStateChange`, so an out it recorded left the half-inning open: no side
  // flip, no leadoff, and every later entry refused as "3 outs".
  test('an out recorded through edit runners ends the half-inning', () => {
    sel('visiting', 0, 0);
    play('1B');                                     // p0 on 1st
    play('K'); play('K');                           // two out
    sel('visiting', 0, 0);
    editRunners(); runnerPopup({ 0: -1 });          // thrown out at 2nd
    eq('three outs', inn('visiting', 0).outs, 3);
    flushTimers();
    eq('the home side is up', selectedCell.dataset.team, 'home');
  });

  // C3 — and it passed no `src`, so the advancement was stamped to no play:
  // nothing credited the RBI, and taking the play back left the run standing.
  test('a run edit runners drives in is credited, and reverts with the play', () => {
    sel('visiting', 0, 0);
    play('3B');                                     // p0 on 3rd
    play('1B'); runnerPopup({ 2: 2, batter: 0 });    // he holds — no run yet
    eq('no run yet', rTotal('visiting'), '');
    sel('visiting', 3, 0);
    editRunners(); runnerPopup({ 2: 3, 0: 0 });      // the single did drive him in
    eq('the run is on the line', rTotal('visiting'), '1');
    eq('the single is credited the RBI', ab('visiting', 3, 0).rbi, 1);
    clearSelectedCell();
    eq('taking the single back takes the run with it', rTotal('visiting'), '');
  });

  // M1 — `moveRunner` skipped the tail too: no updatePitcherStats, so a run it
  // sent home never reached the pitcher's line, and no recomputeInning, so a
  // settled LOB went on counting a man who had scored.
  //
  // The move is made with two out rather than three: H1 refuses a runner move on a
  // half-inning that is already over, so the third out comes after it here and LOB
  // is read once the half really has ended.
  test('a runner moved home is charged to the pitcher and leaves LOB', () => {
    sel('visiting', 0, 0);
    play('1B');
    play('K'); play('K');                            // two out, he is still on 1st
    sel('visiting', 0, 0);
    moveRunner(); mrClick(0, 3);
    eq('the run is on the line', rTotal('visiting'), '1');
    eq('the pitcher is charged with it', pStat('visiting', 0, 'r'), '1');
    sel('visiting', 9, 0);
    play('K');                                       // the third out, nobody on
    flushTimers();
    eq('and nobody is left on', lobTotal('visiting'), '');
  });

  // M5 — `applyChosenAdvancements` cleared the runner off the base whether or not
  // `recordOut` accepted the out, so with the inning already at three he came off
  // the bases with nothing to show for it: no out, not left on, gone.
  //
  // H1 has since put the wall further forward: a finished half-inning is refused
  // before the popup opens, so the set of choices this used to answer can no longer
  // be entered at all. The mutator still refuses it on its own — which is what M5
  // was about — so that is asserted where it now lives.
  test('a runner is not taken off the bases without an out to show for it', () => {
    sel('visiting', 0, 0);
    play('1B');
    play('1B'); runnerPopup({ 0: 1, batter: 0 });    // p0 on 2nd, p3 on 1st
    play('K'); play('K'); play('K');
    flushTimers();
    eq('two left on', lobTotal('visiting'), '2');
    sel('visiting', 0, 0);
    editRunners();
    ok('the finished half-inning is refused, not asked about', !visible('runner-popup'));
    // The same choices, straight at the mutator: out at 2nd for the man on 2nd.
    applyChosenAdvancements('visiting', 0, { 1: -2, 0: 0 }, 'X', { pIdx: 0, col: 0 });
    eq('still three outs', inn('visiting', 0).outs, 3);
    eq('the runner is still on 2nd', onB('visiting', 0, 1), 0);
    eq('and both men are still left on', lobTotal('visiting'), '2');
    basesConsistent('visiting', 0);
  });

  /* ---- Family B ---------------------------------------------------- */

  // C1 — `overflowToNextColumn` shifted `columnMap` right to make room for the
  // batting-around column but left the at-bats where they were, so an inning
  // already recorded in that column was silently relabelled as this one.
  test('batting around does not relabel an inning already recorded', () => {
    sel('visiting', 0, 0);
    for (let i = 0; i < 8; i++) play('BB');          // eight on; the 9th spot still open
    sel('visiting', 0, 1);
    play('K'); play('K'); play('K');                 // the 2nd inning, recorded
    eq('the 2nd inning has its three outs', inningOutsLog('visiting', 1).length, 3);
    sel('visiting', 24, 0);
    play('BB');                                      // the 9th man forces an overflow
    eq('the 1st inning still made no outs', inningOutsLog('visiting', 0).length, 0);
    eq('the 2nd inning still has its three outs', inningOutsLog('visiting', 1).length, 3);
  });

  // M3 — `switchToNextHalf` asked `getNextFreeColumn` for the next column, which
  // is the first one with no plays in it. One half-inning nobody recorded and
  // every later transition landed back in it, scoring the wrong inning.
  test('a half nobody recorded does not derail the next transition', () => {
    sel('visiting', 0, 0); play('K'); play('K'); play('K'); flushTimers();
    sel('home', 0, 0); play('K'); play('K'); play('K'); flushTimers();
    sel('visiting', 0, 1); play('K'); play('K'); play('K'); flushTimers();
    // the bottom of the 2nd never gets recorded
    sel('visiting', 0, 2); play('K'); play('K'); play('K'); flushTimers();
    eq('the home side is up', selectedCell.dataset.team, 'home');
    eq('in the half that follows the top of the 3rd',
       getRealInning('home', parseInt(selectedCell.dataset.inn)), 2);
  });

  // M4 — the column insertion happens after the undo snapshot is taken, so undo
  // gave the runs and the bases back but left a phantom continuation column
  // behind — which then fed M3.
  test('undoing the play that batted around removes the column it inserted', () => {
    sel('visiting', 0, 0);
    for (let i = 0; i < 9; i++) play('BB');          // the 9th forces an overflow
    eq('the overflow column continues the 1st', getRealInning('visiting', 1), 0);
    undoLastPlay();
    eq('the 9th walk came off', ab('visiting', 24, 0).play, '');
    eq('and the column it inserted went with it', getRealInning('visiting', 1), 1);
    eq('the 2nd inning is column 1 again', getColumnsForInning('visiting', 1).join(','), '1');
  });

  /* ---- Family C ---------------------------------------------------- */

  // C2 — every runner the DP/FC/TP popup listed started on "safe, one base up",
  // so a scorer who accepted the defaults on a ground-ball double play scored the
  // man on 3rd. `showRunnerPopup` won't confirm until every runner is chosen;
  // this one silently advanced the ones nobody touched. A runner nobody has
  // spoken for now holds his base.
  test('a double play does not advance a runner the scorer never moved', () => {
    sel('visiting', 0, 0);
    play('3B');                                     // p0 on 3rd
    play('1B'); runnerPopup({ 2: 2, batter: 0 });    // p0 holds 3rd, p3 on 1st
    play('DP 6-4-3');
    clickId('oc-confirm');                           // the scorer accepts the defaults
    eq('no run scored', rTotal('visiting'), '');
    eq('the runner is still on 3rd', onB('visiting', 0, 2), 0);
    eq('two outs', inn('visiting', 0).outs, 2);
  });

  // M2 — the auto-play recovery branch read `playHistory[length - 2]` and hoped
  // that was the snapshot the walk had been applied over. It only ever is if
  // removePitch is the very next action, and it never is: entering the walk moves
  // the selection to the next batter. Pressed on the right cell it restored the
  // snapshot over the pitch it had just popped, so the ball never came off.
  test('removing a pitch takes back the walk the 4th ball forced', () => {
    sel('visiting', 0, 0);
    pitch('B'); pitch('B'); pitch('B'); pitch('B');
    eq('walked', ab('visiting', 0, 0).play, 'BB');
    eq('and the selection moved on', curP(), 3);
    sel('visiting', 0, 0);                           // back to the cell it happened on
    removePitch();
    eq('the walk came off', ab('visiting', 0, 0).play, '');
    eq('and so did the ball', getPitchCount(ab('visiting', 0, 0).pitches).balls, 3);
    eq('nobody on 1st', onB('visiting', 0, 0), null);
  });

  // M2 — and pressed with nothing to remove it did nothing at all, silently.
  test('removing a pitch with nothing to remove says so', () => {
    sel('visiting', 0, 0);
    pitch('B'); pitch('B'); pitch('B'); pitch('B');  // walk; selection is on p3 now
    removePitch();
    ok('the refusal is shown', visible('play-reject'));
    eq('the walk is untouched', ab('visiting', 0, 0).play, 'BB');
  });

  /* =====================================================================
     2026-07-31 audit — the minors.

     m1  a wild pitch or passed ball moved every runner one base, no choice
     m2  applyRunnerEvent's SB and CS branches were unreachable duplicates
     m3  the move-runner popup's "Remove" accounted for the runner nowhere
     m4  the manual RBI override could pass the runs the inning scored

     m5 and m6 have no cases. m5's premise was wrong — tallyAtBats' `k` and `hbp`
     both feed the game summary's box score, so nothing there is dead, and the
     card's five-column stat block omitting them is a design choice (a comment in
     app.js now says so). m6 is a null guard on a dereference only the popup that
     is its sole caller can reach, so there is no state a case could set up. m7 is
     closed as correct: a fielder's choice that retires nobody is a real play, and
     requiring an out would make it unenterable.
     ===================================================================== */

  /* ---- m1: who the ball moved ---------------------------------------- */

  // Rule 9.13 charges the event for an advance, but which runners advanced is the
  // scorer's to say. This used to advance all of them exactly one base, so a ball
  // to the backstop that only the man on 3rd could score on had one entry, and it
  // was the wrong one.
  test('a wild pitch with two men on asks which of them moved', () => {
    sel('visiting', 0, 0);
    play('3B');                                      // p0 on 3rd
    play('1B'); runnerPopup({ 2: 2, batter: 0 });     // p0 holds 3rd, p3 on 1st
    key('n');
    ok('the popup opened', visible('runner-popup'));
    runnerPopup({ 2: 3, 0: 0 });                      // only the man on 3rd came home
    eq('the run scored', lsInput('visiting', 0).value, '1');
    eq('the man on 1st held', onB('visiting', 0, 0), 3);
    eq('and took no base', ab('visiting', 3, 0).bases[1], false);
    basesConsistent('visiting', 0);
  });

  // One man on is the case with nothing to ask: he is the runner the event is
  // charged for and one base is where he goes, so it applies straight, the way
  // promptSBBase applies its single option.
  test('a wild pitch with one man on still applies without asking', () => {
    sel('visiting', 0, 0);
    play('1B');
    key('n');
    ok('no popup', !visible('runner-popup'));
    eq('he took 2nd', onB('visiting', 0, 1), 0);
  });

  // Rule 6.02(a) awards every runner a base on a balk — not a judgement call, so
  // BK keeps the forced advance whatever the popup would have offered.
  test('a balk with two men on advances both without asking', () => {
    sel('visiting', 0, 0);
    play('1B');
    play('1B'); runnerPopup({ 0: 1, batter: 0 });      // p0 on 2nd, p3 on 1st
    applyRunnerEvent('BK');
    ok('no popup', !visible('runner-popup'));
    eq('the lead runner took 3rd', onB('visiting', 0, 2), 0);
    eq('the trailing runner took 2nd', onB('visiting', 0, 1), 3);
  });

  test('a wild pitch nobody moved on is refused, and writes nothing', () => {
    sel('visiting', 0, 0);
    play('1B');
    play('1B'); runnerPopup({ 0: 1, batter: 0 });      // p0 on 2nd, p3 on 1st
    const undos = playHistory.length;
    key('n');
    runnerPopup({ 1: 1, 0: 0 });                       // both hold
    ok('the press is answered', visible('play-reject'));
    ok('and it names the rule\'s condition',
      document.getElementById('play-reject').textContent.indexOf('when a runner advances') >= 0);
    eq('nothing pushed to undo', playHistory.length, undos);
    eq('runner still on 2nd', onB('visiting', 0, 1), 0);
    eq('runner still on 1st', onB('visiting', 0, 0), 3);
  });

  // #14 through the popup: the unearned-run flag follows the ball, not the base.
  test('a passed ball marks the runner it moved and leaves the one it did not', () => {
    sel('visiting', 0, 0);
    play('3B');                                       // p0 on 3rd
    play('1B'); runnerPopup({ 2: 2, batter: 0 });      // p0 holds 3rd, p3 on 1st
    applyRunnerEvent('PB');
    runnerPopup({ 2: 3, 0: 0 });                       // the man on 3rd scores, the other holds
    ok('the run came in on the passed ball', ab('visiting', 0, 0).reachedOnError);
    ok('the man who held keeps his own reckoning', !ab('visiting', 3, 0).reachedOnError);
  });

  // The popup's "Out at" options come with it, so the runner thrown out trying for
  // the extra base is now enterable at all — the bulk advance had no way to say it.
  test('a runner thrown out trying to score on a wild pitch is out on the card', () => {
    sel('visiting', 0, 0);
    play('3B');                                       // p0 on 3rd
    play('1B'); runnerPopup({ 2: 2, batter: 0 });      // p0 holds 3rd, p3 on 1st
    key('n');
    runnerPopup({ 2: -3, 0: 1 });                      // out at home; the other takes 2nd
    eq('the out is recorded', inn('visiting', 0).outs, 1);
    eq('and shown on his own cell', ab('visiting', 0, 0).out, 1);
    eq('out at home', ab('visiting', 0, 0).outOnBase, 3);
    eq('the trailing runner took 2nd', onB('visiting', 0, 1), 3);
    eq('no run', rTotal('visiting'), '');
  });

  // The snapshot is pushed inside the callback, once the choices are in, so it has
  // to cover runners on rows the selected cell isn't on. captureInning does.
  test('undo takes back a wild pitch entered through the popup', () => {
    sel('visiting', 0, 0);
    play('3B');                                       // p0 on 3rd
    play('1B'); runnerPopup({ 2: 2, batter: 0 });      // p0 holds 3rd, p3 on 1st
    key('n'); runnerPopup({ 2: 3, 0: 1 });             // both move: run in, p3 to 2nd
    eq('the run is on the line', rTotal('visiting'), '1');
    undoLastPlay();
    eq('the run came off', rTotal('visiting'), '');
    eq('the man is back on 3rd', onB('visiting', 0, 2), 0);
    eq('and the other back on 1st', onB('visiting', 0, 0), 3);
    eq('with no base marked on the wild pitch', ab('visiting', 3, 0).bases[1], false);
  });

  /* ---- m2: the steal paths answer for themselves --------------------- */

  // The sentences for an empty diamond existed, but only applyRunnerEvent's
  // unreachable SB and CS branches could reach them: pressing either key with
  // nobody on did nothing, and said nothing.
  test('a steal with the bases empty says why there is nothing to enter', () => {
    sel('visiting', 0, 0);
    key('r');
    eq('nothing to undo', playHistory.length, 0);
    ok('the press is answered', visible('play-reject'));
    ok('and it names what is missing',
      document.getElementById('play-reject').textContent.indexOf('no runner to steal') >= 0);
  });

  test('a caught stealing with the bases empty is answered too', () => {
    sel('visiting', 0, 0);
    key('j');
    ok('the press is answered', visible('play-reject'));
    ok('and it names what is missing',
      document.getElementById('play-reject').textContent.indexOf('catch stealing') >= 0);
  });

  test('a pickoff with the bases empty is answered too', () => {
    sel('visiting', 0, 0);
    promptPickoff();
    ok('the press is answered', visible('play-reject'));
    ok('and it names what is missing',
      document.getElementById('play-reject').textContent.indexOf('pick off') >= 0);
  });

  /* ---- m3: a runner leaves the bases for a reason -------------------- */

  // "Remove" took him off with nothing recorded against him: no out, not left on
  // base, and the play, the hit and the at-bat still on the card with the man
  // accounted for nowhere.
  test('taking a runner off the bases records the out', () => {
    sel('visiting', 0, 0);
    play('1B');                                       // p0 on 1st
    sel('visiting', 0, 0);
    moveRunner(); mrClick(0, 'out');
    eq('the out is recorded', inn('visiting', 0).outs, 1);
    eq('and shown on his own cell', ab('visiting', 0, 0).out, 1);
    eq('out on the base he was standing on', ab('visiting', 0, 0).outOnBase, 0);
    eq('nobody on 1st', onB('visiting', 0, 0), null);
    eq('the single is still on the card', ab('visiting', 0, 0).play, '1B');
    eq('and still counts as a hit', bStat('visiting', 0, 'h'), '1');
  });

  test('the runner that out came off is not also left on base', () => {
    sel('visiting', 0, 0);
    play('1B');                                       // p0 on 1st
    play('K');                                        // one out
    sel('visiting', 0, 0);
    moveRunner(); mrClick(0, 'out');                   // two out
    sel('visiting', 6, 0);
    play('K');                                        // three
    eq('three outs', inn('visiting', 0).outs, 3);
    eq('nobody stranded', inn('visiting', 0).lob, 0);
  });

  test('undo puts the runner back on the base that out took him off', () => {
    sel('visiting', 0, 0);
    play('1B');
    sel('visiting', 0, 0);
    moveRunner(); mrClick(0, 'out');
    undoLastPlay();
    eq('the out is given back', inn('visiting', 0).outs, 0);
    eq('he is on 1st again', onB('visiting', 0, 0), 0);
    eq('with no out on his cell', ab('visiting', 0, 0).out, 0);
    eq('and no out-on-base mark', ab('visiting', 0, 0).outOnBase, null);
  });

  /* ---- m4: an RBI needs a run --------------------------------------- */

  test('an RBI with no run to drive in is refused', () => {
    sel('visiting', 0, 0);
    play('1B');
    sel('visiting', 0, 0);
    adjustRBI(1);
    eq('no RBI credited', ab('visiting', 0, 0).rbi, 0);
    ok('the press is answered', visible('play-reject'));
    ok('and it says what is missing',
      document.getElementById('play-reject').textContent.indexOf('needs a run') >= 0);
    eq('nothing pushed to undo but the single', playHistory.length, 1);
  });

  test('an RBI past the runs the inning scored is refused', () => {
    sel('visiting', 0, 0);
    play('3B');                                       // p0 on 3rd
    key('n');                                         // scores on a wild pitch: 1 run, no RBI
    sel('visiting', 0, 0);
    adjustRBI(1);
    eq('the run can be driven in once', ab('visiting', 0, 0).rbi, 1);
    adjustRBI(1);
    eq('but not twice', ab('visiting', 0, 0).rbi, 1);
    ok('the second press is answered', visible('play-reject'));
    ok('and it names the count',
      document.getElementById('play-reject').textContent.indexOf('1 run') >= 0);
  });

  // Taking one off can't invent anything, so the check leaves the decrement alone.
  test('an RBI can always be taken back off', () => {
    sel('visiting', 0, 0);
    play('HR');
    eq('the home run drove himself in', ab('visiting', 0, 0).rbi, 1);
    sel('visiting', 0, 0);
    adjustRBI(-1);
    eq('and the scorer can take it off', ab('visiting', 0, 0).rbi, 0);
    ok('with no refusal', !visible('play-reject'));
  });

  /* =====================================================================
     2026-07-31 audit — the third pass.

     Ten findings, one case each, asserting the behaviour the fix will have.
     One commit per severity family:

       High    H1  a run could be scored after the third out — the two manual
                   runner paths lacked the guard every sibling has
       Medium  M1  no 16th inning, and the refusal named the wrong wall
               M2  a pinch runner lost the at-bat his inning batted around into
               M3  "Fix Stats" moved the strikeout and left its out behind
       Minor   L1  Rnrs on an empty diamond burned an undo press
               L2  Move on an empty diamond said nothing at all
               L3  the summary printed a name the debounce had not scraped yet
               L4  the player-of-the-game line disagreed with the box score
                   above it on a sacrifice that achieved nothing
               L5  applyFieldPos dereferenced its popup unguarded
               L6  getNextFreeColumn was dead code
     ===================================================================== */

  /* ---- H1: no run after the third out -------------------------------- */

  // Three outs and the stranded runners are still standing in `inn.bases` — that
  // is how LOB is derived — so both manual runner paths would walk one of them
  // home: onto the linescore, onto the batter's R, onto the pitcher's R and ER,
  // and off LOB. Silently, and it survived a reload. `applySBAtBase`,
  // `applyCSAtBase`, `applyPickoff` and `applyRunnerEvent` all refuse with
  // INNING_OVER; `moveRunner`'s move branch and `applyChosenAdvancements`' advance
  // branch (which is what Rnrs reaches) did not.
  test('a stranded runner cannot be walked home after the third out', () => {
    sel('visiting', 0, 0);
    play('1B');                                      // p0 on 1st
    play('K'); play('K'); play('K');
    flushTimers();
    eq('the half ended with him on', lobTotal('visiting'), '1');

    sel('visiting', 0, 0);
    moveRunner(); mrClick(0, 3);                     // Move → Home
    eq('no run on the line', rTotal('visiting'), '');
    eq('nothing charged to the pitcher', pStat('visiting', 0, 'r'), '');
    eq('no run on the batter either', bStat('visiting', 0, 'r'), '');
    eq('he is still on 1st', onB('visiting', 0, 0), 0);
    eq('and still left on base', lobTotal('visiting'), '1');
    ok('the press is answered', visible('play-reject'));
    ok('and it names the wall',
       document.getElementById('play-reject').textContent.indexOf('3 outs') >= 0);

    sel('visiting', 0, 0);
    editRunners();                                   // Rnrs, the other path in
    ok('a dead half-inning is refused before the popup opens', !visible('runner-popup'));
    eq('still no run', rTotal('visiting'), '');
    eq('still left on base', lobTotal('visiting'), '1');
  });

  /* ---- M1: the end of the card -------------------------------------- */

  // `columnForInning` answered "the last column" for an inning the card has no
  // room for, so the transition out of the bottom of the 15th parked the leadoff
  // on column 14 — the 15th, three outs already on it — and every entry there was
  // refused as "the inning already has 3 outs", which names a wall the scorer can
  // clear by hand instead of the one he has really hit. `overflowToNextColumn`
  // already had the sentence for it.
  test('a 16th inning says the card is full, not that the inning has 3 outs', () => {
    sel('home', 0, INNINGS - 1);                     // the bottom of the 15th
    play('K'); play('K'); play('K');
    flushTimers();                                   // the transition looks for a 16th
    eq('the card has no column for a 16th inning', columnForInning('visiting', INNINGS), -1);
    ok('the press is answered', visible('play-reject'));
    ok('and it names the wall that was hit',
       document.getElementById('play-reject').textContent.indexOf('card is full') >= 0);
    eq('the selection did not cross to the other side', selectedCell.dataset.team, 'home');
    ok('and no leadoff was filed against a column that does not exist',
       !gameState.nextLeadoff || !gameState.nextLeadoff.visiting ||
       gameState.nextLeadoff.visiting[-1] === undefined);
  });

  /* ---- M2: the pinch runner's own column ---------------------------- */

  // `shiftColumnsRight` seeds the inserted column's sub line from
  // `subRowOf(atBats[at - 1])`, and a pinch runner does not live in `subChange` —
  // his column reports the row that *batted* it. So the overflow column was handed
  // back to the starter and the runner's line resumed one column late: rows read
  // 0, 0, 1, 1 down the slot, and the man he replaced was credited the at-bat.
  test('a pinch runner keeps the at-bat his inning bats around into', () => {
    sel('visiting', 0, 0);
    play('1B');                                      // p0 on 1st
    sel('visiting', 0, 0);
    markPinchRunner();                               // row 1 runs for him
    sel('visiting', 3, 0);
    for (let i = 0; i < 8; i++) play('BB');          // the side bats around
    eq('the overflow column continues the 1st', getRealInning('visiting', 1), 0);
    eq('the inserted column is the runner\'s', subRowOf(ab('visiting', 0, 1)), 1);
    eq('and so is the one after it', subRowOf(ab('visiting', 0, 2)), 1);

    sel('visiting', 0, 1);
    play('K');                                       // he comes up in the overflow
    const slot = gameState.teams.visiting.players[0].atBats;
    eq('the overflow at-bat is his', tallyAtBats('visiting', 0, slot, 1).ab, 1);
    eq('and the starter keeps only his own', tallyAtBats('visiting', 0, slot, 0).ab, 1);
  });

  /* ---- M3: Fix Stats keeps its promise ------------------------------ */

  // `recomputePitcherAssignments` reassigns `ab.pitcher` and nothing else, but IP
  // is counted from `inn.outsLog[].pitcher` — so a repair moved the strikeout and
  // left the out that made it behind: starter 0.2 IP with 1 K, reliever 0.0 IP
  // with 1 K. The popup promises "This updates IP, PC, H, R, ER, K and BB".
  test('fix stats moves the out along with the strikeout', () => {
    sel('visiting', 0, 0);
    play('K'); play('K');                            // two outs, both off the starter
    sel('visiting', 3, 0);                           // the 2nd K's cell, already played
    usePitcher(1);                                   // the change really happened before it
    recomputePitcherAssignments();
    clickId('rc-apply');
    eq('the starter keeps his own out', pStat('visiting', 0, 'ip'), '0.1');
    eq('with the K that goes with it', pStat('visiting', 0, 'k'), '1');
    eq('the reliever gets the out he made', pStat('visiting', 1, 'ip'), '0.1');
    eq('with his own K', pStat('visiting', 1, 'k'), '1');
  });

  /* ---- L1 / L2: a press that changes nothing says why ---------------- */

  // m1 fixed exactly this for `applyRunnerEvent`: with the bases empty
  // `showRunnerPopup` calls straight back with `{}`, so nothing changed — but the
  // snapshot had already been pushed and the redo stack cleared, leaving a dead
  // Undo press between the scorer and the last play that really happened.
  test('pressing Rnrs with the bases empty does not burn an undo press', () => {
    sel('visiting', 0, 0);
    play('K');
    sel('visiting', 0, 0);
    const undos = playHistory.length;
    editRunners();
    eq('nothing pushed to undo', playHistory.length, undos);
    ok('the press is answered', visible('play-reject'));
    ok('and it says what is missing',
       document.getElementById('play-reject').textContent.indexOf('no runner to move') >= 0);
  });

  // The app's own policy, from NOTHING_TO_MOVE and removePitch: a press that
  // changes nothing says why. `moveRunner` returned bare.
  test('pressing Move with the bases empty says why', () => {
    sel('visiting', 0, 0);
    play('K');
    sel('visiting', 0, 0);
    moveRunner();
    ok('no popup', !visible('move-runner-popup'));
    ok('the press is answered', visible('play-reject'));
    ok('and it says what is missing',
       document.getElementById('play-reject').textContent.indexOf('no runner to move') >= 0);
  });

  /* ---- L3: the summary reads the card, not the last save ------------- */

  // `collectState` scrapes the lineup inputs on the 400ms debounce, so a name
  // typed just before the summary opened was not in the state yet and the box
  // score printed "Pos 1". `livePlayerField` exists for this and every popup
  // already uses it.
  test('the summary prints a name typed a moment before it opened', () => {
    setPlayer('visiting', 0, '7', 'Molina');         // typed, not yet scraped
    sel('visiting', 0, 0);
    play('1B');
    eq('the debounce has not scraped it yet', gameState.teams.visiting.players[0].name, '');
    showGameSummary();
    const names = Array.from(document.querySelectorAll('#gs-inner tr'))
      .map(tr => (tr.children[0] && tr.children[0].textContent) || '');
    ok('the box score names him', names.some(n => n.indexOf('Molina') >= 0));
    const hl = document.querySelector('#gs-inner .gs-hl-value');
    ok('and so does the player of the game', !!hl && hl.textContent.indexOf('Molina') >= 0);
    document.getElementById('game-summary-modal').classList.remove('active');
  });

  /* ---- L4: one answer to "was that an at-bat" ----------------------- */

  // Rule 9.02(a)(1): a sacrifice costs no at-bat only if it did its job, which is
  // what `tallyAtBats` / `sacrificeExemptsAB` say (#17). `findPlayerOfGame` kept
  // its own list with SAC/SF/SH in it, so the POG's "h-for-ab" line could
  // contradict the box score printed above it.
  test('the player of the game line agrees with the box score on a sacrifice', () => {
    setPlayer('visiting', 0, '7', 'Nunez');
    sel('visiting', 0, 0);
    play('SF');                                      // nobody on: it drove nobody in
    collectState();
    showGameSummary();
    const row = Array.from(document.querySelectorAll('#gs-inner tr'))
      .map(tr => Array.from(tr.children).map(td => td.textContent.trim()))
      .find(c => c[0] && c[0].indexOf('Nunez') >= 0);
    ok('he is on the box score', !!row);
    eq('charged the at-bat', row[1], '1');
    const hl = document.querySelector('#gs-inner .gs-highlight-card .gs-hl-detail');
    ok('and the player-of-the-game line says the same', !!hl && hl.textContent.indexOf('0-1') >= 0);
    document.getElementById('game-summary-modal').classList.remove('active');
  });

  /* ---- L5 / L6: the two latent ones --------------------------------- */

  // The same shape m6 guarded in `setPitcher`: the popup is the only caller today,
  // so the dereference is latent — but it is one line from a crash, and every other
  // popup in the file is dismissed through a null check or hidePopupById.
  test('a position change does not need its popup in the DOM', () => {
    lineupDirty = true;
    const popup = document.getElementById('pos-change-popup');
    if (popup) popup.remove();
    applyFieldPos('visiting', 0, '6', null);
    eq('the position is on the card', gameState.teams.visiting.players[0].pos, '6');
  });

  // Superseded by `columnForInning` and left behind. Nothing calls it, and the
  // comment above `columnForInning` explains why nothing should.
  test('the column scan columnForInning replaced is gone', () => {
    eq('getNextFreeColumn is no longer defined', typeof getNextFreeColumn, 'undefined');
  });

  /* =====================================================================
     2026-08-01 — the fourth audit's findings, as known failures

     One marker per finding (H1 gets one per confirmed shape, since the three
     go through two different functions). Each asserts the CORRECT behaviour,
     so the fix promotes its own case to `test`.
     ===================================================================== */

  /* ---- H1: rule 5.08(a), the batter retired before first ------------- */

  /* No run scores on a play whose third out is the batter-runner put out before
     he reaches first. `applyPlayEffects` walks the runners home (app.js:1721)
     and only then records his out (app.js:1735), so audit 3's guard at the top
     of `applyChosenAdvancements` sees two outs and lets the run through.

     The refusal belongs in the popups, the way the occupancy check refuses a
     base somebody is standing on: with the batter's own out the half-inning is
     over, so Home is not a place the scorer can send anybody. */

  function homeBtn(base) {
    const popup = document.getElementById('runner-popup');
    if (!visible('runner-popup')) fail('runner popup is not open');
    return popup.querySelector(`.rp-btn[data-base="${base}"][data-dest="3"]`);
  }

  function twoOutOnThird() {
    sel('visiting', 0, 0); play('K');                // out 1
    sel('visiting', 3, 0); play('K');                // out 2
    sel('visiting', 6, 0); play('3B');               // and a man on 3rd
  }

  test('a sacrifice fly with two out cannot send the runner home', () => {
    twoOutOnThird();
    sel('visiting', 9, 0); play('SF');
    const home = homeBtn(2);
    ok('the popup will not send him home', !!home && isOptionBlocked(home));
    runnerPopup({ 2: 2 });
    eq('no run', rTotal('visiting'), '');
    eq('no RBI', ab('visiting', 9, 0).rbi, 0);
    // #17's other side: a sacrifice that achieved nothing is an ordinary out.
    eq('the sacrifice is charged as an at-bat', bStat('visiting', 9, 'ab'), '1');
    eq('he is left on base', lobTotal('visiting'), '1');
  });

  test('a groundout at first with two out cannot send the runner home', () => {
    twoOutOnThird();
    sel('visiting', 9, 0);
    promptPositionPlay('GO ');
    positionPopup('3');
    const home = homeBtn(2);
    ok('the popup will not send him home', !!home && isOptionBlocked(home));
    runnerPopup({ 2: 2 });
    eq('no run', rTotal('visiting'), '');
    eq('no RBI', ab('visiting', 9, 0).rbi, 0);
  });

  // The second site: `applyRunnerOutcomes` (app.js:2205). Here the batter's out
  // is a choice, so the bar has to follow it — one out already, the runner on
  // 1st forced at 2nd, and the batter at first is the third.
  test('a double play ending on the batter at first cannot send the runner home', () => {
    sel('visiting', 0, 0); play('K');                // out 1
    sel('visiting', 3, 0); play('3B');               // man on 3rd
    sel('visiting', 6, 0); play('1B'); runnerPopup({ 2: 2 });
    sel('visiting', 9, 0);
    promptPositionPlay('DP ');
    positionPopup('4-6-3');
    const home = document.getElementById('outcome-popup')
      .querySelector('.oc-btn[data-base="2"][data-action="safe"][data-dest="3"]');
    ok('the popup will not send him home', !!home && isOptionBlocked(home));
    outcomePopup({ 0: ['out', 1], batter: ['out'] });
    eq('no run', rTotal('visiting'), '');
    eq('three outs', inn('visiting', 0).outs, 3);
  });

  // The controls. These pass today and have to keep passing: the rule is about
  // the batter's own out, not about two being out.
  test('a sacrifice fly with one out still scores the runner', () => {
    sel('visiting', 0, 0); play('K');
    sel('visiting', 3, 0); play('3B');
    sel('visiting', 6, 0); play('SF');
    const home = homeBtn(2);
    ok('Home is offered', !!home && !isOptionBlocked(home));
    runnerPopup({ 2: 3 });
    eq('the run counts', rTotal('visiting'), '1');
    eq('and the RBI', ab('visiting', 6, 0).rbi, 1);
    eq('no at-bat charged', bStat('visiting', 6, 'ab'), '');
  });

  test('a third out tagged on the bases still lets the run count', () => {
    sel('visiting', 0, 0); play('K');
    sel('visiting', 3, 0); play('K');
    sel('visiting', 6, 0); play('1B');
    sel('visiting', 9, 0); play('2B'); runnerPopup({ 0: 2 });   // 2nd and 3rd, two out
    sel('visiting', 12, 0); play('1B');
    ok('Home is offered — the batter reaches, so his out is not the third',
      !isOptionBlocked(homeBtn(2)));
    runnerPopup({ 2: 3, 1: -2 });                    // lead scores, trailer out at 3rd
    eq('the run counts', rTotal('visiting'), '1');
    eq('and the RBI', ab('visiting', 12, 0).rbi, 1);
    eq('three outs', inn('visiting', 0).outs, 3);
  });

  // A fielder's choice opens with the batter safe, so the plate starts open and
  // the bar arrives with the click that marks him out. The runner already sent
  // there is set back to his base and told about it, the way the out cap does.
  test('marking the batter out sends a runner already headed home back', () => {
    twoOutOnThird();
    sel('visiting', 9, 0);
    promptPositionPlay('FC ');
    positionPopup('5');
    outcomePopup({ 2: ['safe', 3], batter: ['out'] });
    ok('it says why', visible('play-reject'));
    eq('no run', rTotal('visiting'), '');
    eq('he is still on 3rd, and left there', lobTotal('visiting'), '1');
    eq('three outs', inn('visiting', 0).outs, 3);
  });

  // The state-level backstops. The popups no longer offer the run, so these are
  // for a set of choices that arrives from an import, a hand edit or a headless
  // caller — the only paths that can still ask for one.
  test('a set of advancements that scores after the batter is out is refused', () => {
    twoOutOnThird();
    const choices = { 2: 3 };
    barRunsAfterBatterOut('visiting', 0, choices);
    eq('the run is taken out of the set', choices[2], undefined);
    ok('and it says why', visible('play-reject'));
  });

  test('runner outcomes that score after the batter is out are refused', () => {
    twoOutOnThird();
    sel('visiting', 9, 0);
    const a = ab('visiting', 9, 0);
    a.play = 'DP';
    applyRunnerOutcomes('visiting', 9, 0, a, inn('visiting', 0), 'DP',
      { 2: { action: 'safe', dest: 3 }, batter: { action: 'out' } });
    eq('no run', rTotal('visiting'), '');
    eq('he keeps the base he was on', onB('visiting', 0, 2), 6);
  });

  /* ---- H2: the card with no library entry --------------------------- */

  // `currentGameHasUnsavedChanges` answers "no" when there is nothing to compare
  // against (app.js:6020) — which is the card most at risk, because a game that
  // was never "Save as New Game"d has `currentGameId: null`. So no confirm, and
  // the `flushSave()` after the swap writes the incoming game over the outgoing
  // one's only copy.
  test('a card that was never saved still counts as unsaved changes', () => {
    clearStorage();
    const realConfirm = window.confirm;
    let asked = 0;
    window.confirm = function () { asked++; return false; };
    try {
      const other = JSON.parse(JSON.stringify(createEmptyState()));
      other.info.visitingTeam = 'Jays';
      safeStorage.setItem(LIBRARY_KEY, JSON.stringify(
        [{ id: 'x', date: '', teams: 'a vs b', score: '0 - 0', state: other }]));
      sel('visiting', 0, 0); play('1B');
      eq('the card has no library entry', gameState.currentGameId, null);
      ok('and it counts as unsaved', currentGameHasUnsavedChanges());
      loadGameFromLibrary(0);
      eq('the scorer was asked before it was thrown away', asked, 1);
      // The swap replaces `gameState` wholesale, so his single still being here is
      // the proof the load was refused.
      eq('and answering no left his game alone', ab('visiting', 0, 0).play, '1B');
    } finally { window.confirm = realConfirm; clearStorage(); }
  });

  // The same hole after the current game's own entry is deleted: `currentGameId`
  // is left dangling and the comparison finds nothing again.
  test('a card whose library entry was deleted still counts as unsaved', () => {
    clearStorage();
    const realConfirm = window.confirm;
    window.confirm = function () { return true; };
    try {
      sel('visiting', 0, 0); play('1B');
      saveAsNewGame();
      ok('saved, so nothing is outstanding', !currentGameHasUnsavedChanges());
      deleteGameFromLibrary(0);
      ok('its only copy is gone, so everything is outstanding', currentGameHasUnsavedChanges());
    } finally { window.confirm = realConfirm; clearStorage(); }
  });

  /* F5 — Load and Import both weigh what is about to be lost before they ask.
     New Game put the same mild question to an empty card and to one with an
     inning of unsaved work on it, which is the question you stop reading. */
  test('New Game names the unsaved work it is about to throw away', () => {
    clearStorage();
    const realConfirm = window.confirm;
    let asked = '';
    window.confirm = function (msg) { asked = msg; return false; };
    try {
      sel('visiting', 0, 0); play('1B');
      newGame();
      ok('the warning names the loss', asked.indexOf('unsaved changes') >= 0);
      eq('and answering no left the card alone', ab('visiting', 0, 0).play, '1B');
    } finally { window.confirm = realConfirm; clearStorage(); }
  });

  test('New Game asks the plain question of a card with nothing on it', () => {
    clearStorage();
    const realConfirm = window.confirm;
    let asked = '';
    window.confirm = function (msg) { asked = msg; return false; };
    try {
      ok('nothing is outstanding', !currentGameHasUnsavedChanges());
      newGame();
      ok('so the warning stays plain', asked.indexOf('unsaved changes') < 0);
      ok('and it still asks', asked.indexOf('new scorecard') >= 0);
    } finally { window.confirm = realConfirm; clearStorage(); }
  });

  /* ---- M1: a cleared pitching change ---------------------------------- */

  // `clearSelectedCell` blanks `ab.pitcherChangeNum` (app.js:4180) and leaves
  // `inn.currentPitcher` on the reliever, so the card no longer records when he
  // came in while the state still says he is out there.
  test('clearing a play takes its pitching change off the mound with it', () => {
    sel('visiting', 0, 0); play('K');
    sel('visiting', 3, 0); usePitcher(1); play('K');   // the reliever comes in here
    sel('visiting', 6, 0); play('K');                  // and this is the latest play
    sel('visiting', 3, 0); clearSelectedCell();
    eq('the marker is gone', ab('visiting', 3, 0).pitcherChangeNum, '');
    eq('and so is the change', getEffectivePitcher('visiting', 0), 0);
    eq('the inning no longer claims a pitcher of its own', inn('visiting', 0).pitcherSet, false);
    sel('visiting', 9, 0); play('1B');
    eq('the next hit is charged to the man the card has on the mound', pStat('visiting', 0, 'h'), '1');
    eq('and not to the reliever', pStat('visiting', 1, 'h'), '');
  });

  // The markers are the record, so the last one left in the column is the one the
  // mound goes back to — a column can hand the ball over twice.
  test('clearing the second change in a column leaves the first standing', () => {
    sel('visiting', 0, 0); usePitcher(1); play('K');
    sel('visiting', 3, 0); usePitcher(2); play('K');
    sel('visiting', 6, 0); play('1B');                 // the latest play, so p3 is not
    sel('visiting', 3, 0); clearSelectedCell();
    eq('the first change still stands', getEffectivePitcher('visiting', 0), 1);
    ok('and the column still claims a pitcher', inn('visiting', 0).pitcherSet);
  });

  /* ---- M2: redo skips the tail --------------------------------------- */

  // `restoreSnapshot` puts the data back and stops there, so a redone third out
  // leaves the half-inning open — no side change, no leadoff, and every further
  // entry refused as "3 outs". Audit 3's Family A fixed this same hole for
  // `editRunners` and `moveRunner`.
  test('a redone third out ends the half-inning', () => {
    sel('visiting', 0, 0);
    play('K'); play('K'); play('K');
    eq('three outs', inn('visiting', 0).outs, 3);
    undoLastPlay();
    eq('two outs after the undo', inn('visiting', 0).outs, 2);
    redoLastPlay();
    eq('three outs again', inn('visiting', 0).outs, 3);
    ok('and the side is changing', pendingTransitionTimer !== null);
    flushTimers();
    eq('leadoff for the next inning', gameState.nextLeadoff.visiting[1], 9);
    eq('the home half is up', selectedCell.dataset.team, 'home');
  });

  test('a redone walk-off ends the game', () => {
    sel('home', 0, 8);
    play('HR');
    ok('the game is over', gameOverShown);
    undoLastPlay();
    ok('and not over after the undo', !gameOverShown);
    redoLastPlay();
    eq('the run is back on the line', lsInput('home', 8).value, '1');
    ok('and so is the result', gameOverShown);
  });

  // The tail's `advanceBatter` is the caller's to decide, and a runner event is not
  // a plate appearance: the same man is still at bat, before and after a redo.
  test('a redone stolen base leaves the same batter at the plate', () => {
    sel('visiting', 0, 0);
    play('1B');                                      // p0 on 1st, p3 up
    promptSBBase(); basePicker(0);
    eq('he is on 2nd', onB('visiting', 0, 1), 0);
    undoLastPlay();
    redoLastPlay();
    eq('he is on 2nd again', onB('visiting', 0, 1), 0);
    eq('and the same batter is up', curP(), 3);
  });

  /* ---- M3: the defensive-change log ----------------------------------- */

  // `applyFieldPos` builds the label from state (app.js:5588) and *stores* it, so
  // a change recorded within the 400ms debounce is logged permanently as "Pos 1".
  // Audit 3's L3 was the display version of this one.
  test('a defensive change logs the name the scorer has typed', () => {
    lineupDirty = true;
    setPos('visiting', 0, 'CF');
    setPlayer('visiting', 0, '9', 'Ortiz');          // typed, not yet collected
    applyFieldPos('visiting', 0, 'LF', 'T3');
    const entry = gameState.defChanges[0].changes[0];
    eq('the log names him', entry.name, '#9 Ortiz');
  });

  /* ---- L1: the earned-run review popup -------------------------------- */

  // The fallback is the row index + 1, and rows are `spot * ROWS_PER_POS`, so the
  // 4th spot's starter reads "Batter 10".
  test('the earned-run review names the batting spot, not the row', () => {
    sel('visiting', 9, 0); play('HR');
    sel('visiting', 9, 0);
    reviewEarnedRuns();
    const t = document.getElementById('er-review-popup').textContent;
    ok('the run belongs to the 4th spot', t.indexOf('Batter 4') >= 0);
    ok('and not to row 10', t.indexOf('Batter 10') < 0);
  });

  // And it reads names from state rather than the inputs, and labels a run with
  // the man who BATTED — so a pinch runner's run goes to the man he ran for,
  // which is the distinction `runRowOf` exists for.
  test('the earned-run review reads the card and credits the man who ran', () => {
    lineupDirty = true;
    setPlayer('visiting', 0, '7', 'Nunez');
    setPlayer('visiting', 1, '21', 'Ruiz');
    setPlayer('visiting', 3, '5', 'Molina');
    sel('visiting', 0, 0); play('1B');
    sel('visiting', 0, 0); markPinchRunner();        // Ruiz runs for Nunez
    sel('visiting', 3, 0); play('HR');               // both score
    sel('visiting', 0, 0);
    reviewEarnedRuns();
    const t = document.getElementById('er-review-popup').textContent;
    ok('the pinch runner is credited with his run', t.indexOf('Ruiz') >= 0);
    ok('not the man he ran for', t.indexOf('Nunez') < 0);
    ok('and the names come off the card', t.indexOf('Molina') >= 0);
  });

  /* ---- L2: a pitch removed from a cell that has a play ---------------- */

  // `removePitch` refreshes the pitcher line only when it took back an auto-play
  // (app.js:2979), so PC stays one too high on screen and in the state until the
  // next play or a reload — and the wrong number is what gets saved in between.
  test('removing a pitch takes it off the pitcher line as well', () => {
    sel('visiting', 0, 0);
    pitch('B'); pitch('F');
    play('1B');                                      // the play adds its result pitch
    const before = Number(pStat('visiting', 0, 'pc'));
    eq('three pitches so far', before, 3);
    sel('visiting', 0, 0);
    removePitch();
    eq('the pitcher line drops one', pStat('visiting', 0, 'pc'), String(before - 1));
    collectState();
    eq('and so does what gets saved', gameState.teams.home.pitchers[0].pc, String(before - 1));
  });

  /* ---- L3: the last two silent dead presses --------------------------- */

  test('redo with nothing to redo says so', () => {
    redoLastPlay();
    ok('it says why', visible('play-reject'));
  });

  test('the spray chart says why it will not open on a cell with no hit', () => {
    sel('visiting', 0, 0); play('K');
    sel('visiting', 0, 0);
    editSprayChart();
    ok('it says why', visible('play-reject'));
  });

  /* ---- L4: SUB on a pinch runner's line -------------------------------- */

  // `promptSubRemoval`'s "he never batted, so this is an undo" path does not know
  // the line came from PR, so it reverts the whole thing with no popup and no
  // re-entry — while `prRow` on his own column survives, leaving the run with a
  // man the card no longer has in the game.
  test('SUB does not quietly undo a pinch runner\'s line', () => {
    lineupDirty = true;
    setPlayer('visiting', 0, '7', 'Nunez');
    setPlayer('visiting', 1, '21', 'Ruiz');
    sel('visiting', 0, 0); play('1B');
    sel('visiting', 0, 0); markPinchRunner();
    eq('the line forward is his', ab('visiting', 0, 1).subChange, 1);
    sel('visiting', 0, 1); markSub();
    ok('it says why', visible('play-reject'));
    eq('the line is still the pinch runner\'s', ab('visiting', 0, 1).subChange, 1);
    eq('and he is still running in the 1st', ab('visiting', 0, 0).prRow, 1);
  });

  // The refusal is the mis-press path's alone. Once the pinch runner has batted,
  // taking him out is an ordinary substitution and gets the ordinary question.
  test('SUB on a pinch runner who has since batted still asks', () => {
    lineupDirty = true;
    setPlayer('visiting', 0, '7', 'Nunez');
    setPlayer('visiting', 1, '21', 'Ruiz');
    sel('visiting', 0, 0); play('1B');
    sel('visiting', 0, 0); markPinchRunner();
    sel('visiting', 0, 1); play('K');                // Ruiz bats in the 2nd
    sel('visiting', 0, 1); markSub();
    ok('the question is put', visible('sub-popup'));
  });

  /* ---- the re-stamped sequence number ---------------------------------- */

  // `ab.seq` orders the plays of a game for the pitcher decisions. `finishPlay`
  // only stamps it once — but clearing a play resets it to 0, so re-entering the
  // cell stamps it again and the play sorts after everything recorded since,
  // which can move the go-ahead run behind the wrong pitcher.
  test('a play cleared and re-entered keeps its place in the game', () => {
    sel('visiting', 0, 0); play('1B');
    const first = ab('visiting', 0, 0).seq;
    sel('visiting', 3, 0); play('K');
    const second = ab('visiting', 3, 0).seq;
    ok('they are stamped in order', first > 0 && first < second);
    sel('visiting', 0, 0); clearSelectedCell();
    sel('visiting', 0, 0); play('2B');               // nobody on: no popup to answer
    ok('the re-entered play still sorts first', ab('visiting', 0, 0).seq < second);
  });

  // The other two places a play comes off a cell keep the stamp for the same
  // reason: "Clear Play (Keep Pitches)", and `removePitch` taking back an
  // auto-play — a strikeout undone one pitch at a time and struck out again is
  // the same time at bat, in the same place in the game.
  test('clearing a play but keeping its pitches keeps its place too', () => {
    sel('visiting', 0, 0); play('1B');
    const first = ab('visiting', 0, 0).seq;
    sel('visiting', 3, 0); play('K');
    const second = ab('visiting', 3, 0).seq;
    sel('visiting', 0, 0); clearPlayKeepPitches();
    play('K');
    ok('it still sorts first', ab('visiting', 0, 0).seq < second);
  });

  test('a strikeout taken back one pitch at a time keeps its place', () => {
    sel('visiting', 0, 0);
    pitch('S'); pitch('S'); pitch('S');               // the third opens the K popup
    clickId('k-swinging');
    eq('the strikeout is on the card', ab('visiting', 0, 0).play, 'K');
    const first = ab('visiting', 0, 0).seq;
    sel('visiting', 3, 0); play('1B');
    const second = ab('visiting', 3, 0).seq;
    sel('visiting', 0, 0); removePitch();
    eq('the strikeout came off', ab('visiting', 0, 0).play, '');
    pitch('S');
    clickId('k-swinging');
    eq('and back on', ab('visiting', 0, 0).play, 'K');
    ok('in the place it always had', ab('visiting', 0, 0).seq < second);
  });

  /* ---- The live panel's AT BAT / PITCHER readout ----------------------- */

  const lsText = id => document.getElementById(id).textContent;

  // The count is the one a manager takes a starter out on, so it has to move on
  // the pitch. The pitching line can't be the source: `updatePitcherStats` skips
  // an at-bat with no play on it yet, so PC stands still through a nine-pitch
  // at-bat and then jumps.
  test('the panel counts pitches as they are thrown, not at the end of the at-bat', () => {
    sel('visiting', 0, 0);
    pitch('S');
    eq('one pitch reads singular', lsText('ls-pitches'), '1 pitch');
    pitch('B');
    eq('and the second lands before any play does', lsText('ls-pitches'), '2 pitches');
    eq('while the pitching line has yet to move', pStat('visiting', 0, 'pc'), '');
    play('1B');                                       // the play adds its result pitch
    sel('visiting', 3, 0);
    eq('the next batter carries the total forward', lsText('ls-pitches'), '3 pitches');
    pitch('B');
    eq('and adds to it', lsText('ls-pitches'), '4 pitches');
  });

  test('the panel names the man on the mound and counts only his pitches', () => {
    lineupDirty = true;
    eq('the starter, before anyone is written in', lsText('ls-pitcher'), 'Pitcher 1');
    sel('visiting', 0, 0); play('K');                 // three pitches, all his
    sel('visiting', 3, 0);
    eq('his three', lsText('ls-pitches'), '3 pitches');
    document.querySelector('input[data-team="home"][data-pitcher="1"][data-field="num"]').value = '31';
    document.querySelector('input[data-team="home"][data-pitcher="1"][data-field="name"]').value = 'Ramos';
    usePitcher(1);
    eq('the reliever is named as he comes in', lsText('ls-pitcher'), '#31 Ramos');
    eq('and comes in on none of his own', lsText('ls-pitches'), '0 pitches');
    pitch('S');
    eq('the first is his', lsText('ls-pitches'), '1 pitch');
    eq('and the starter keeps his three', pStat('visiting', 0, 'pc'), '3');
  });

  /* F4 — the panel names the batter and the pitcher off the inputs, not off the
     state, but nothing repainted it as they were typed. A substitute written in
     under the scorer's fingers left the panel naming the man he replaced until
     the next play — after the moment it was needed. */
  function typeInto(el, value) {
    el.value = value;
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  }

  test('the readout follows a substitute as his name is typed', () => {
    lineupDirty = true;
    const starter = document.querySelector('input[data-field="name"][data-team="visiting"][data-p="0"]');
    typeInto(starter, 'Jung');
    sel('visiting', 0, 0);
    eq('the starter is at the plate', lsText('ls-batter'), 'Jung');
    markSub();                                        // row 1 of the spot is the sub
    const sub = document.querySelector('input[data-field="name"][data-team="visiting"][data-p="1"]');
    typeInto(sub, 'Carter');
    eq('and the panel has the substitute', lsText('ls-batter'), 'Carter');
    const num = document.querySelector('input[data-field="num"][data-team="visiting"][data-p="1"]');
    typeInto(num, '25');
    eq('with his number as it lands', lsText('ls-batter'), '#25 Carter');
  });

  test('the readout follows a reliever as his name is typed', () => {
    lineupDirty = true;
    sel('visiting', 0, 0);
    const num = document.querySelector('input[data-team="home"][data-pitcher="1"][data-field="num"]');
    const name = document.querySelector('input[data-team="home"][data-pitcher="1"][data-field="name"]');
    typeInto(name, 'Ramos');
    typeInto(num, '31');
    usePitcher(1);
    eq('the reliever is on the mound', lsText('ls-pitcher'), '#31 Ramos');
    typeInto(name, 'Ramirez');                        // a correction to the spelling
    eq('and the panel follows the correction', lsText('ls-pitcher'), '#31 Ramirez');
  });

  test('a final card empties the matchup readout', () => {
    sel('home', 0, 8); play('HR');                    // walk-off in the 9th
    eq('the game is final', lsText('ls-inning'), 'FINAL');
    eq('nobody is at the plate', lsText('ls-batter'), '');
    eq('nobody is on the mound', lsText('ls-pitcher'), '');
    eq('and no count is showing', lsText('ls-pitches'), '');
  });

  /* F14 — the win-probability chart kept the old dark skin's colours. The axis
     labels were white at 0.35–0.45 alpha, and the curve was stroked
     `var(--gold)`, which this theme defines as #ffffff — so over the plot's own
     black wash the line itself was invisible, not only its captions. The
     viewBox was a fixed 560 as well, leaving ~270px of the summary panel dead. */
  const WP_DATA = [
    { homeTeamWinProbability: 50 },
    { homeTeamWinProbability: 71 },
    { homeTeamWinProbability: 38 },
    { homeTeamWinProbability: 86 }
  ];
  function chartIn(width) {
    const box = document.createElement('div');
    document.body.appendChild(box);
    if (width !== undefined) Object.defineProperty(box, 'clientWidth', { value: width, configurable: true });
    return box;
  }

  test('the win-probability chart is drawn in the card palette, not the dark skin', () => {
    const box = chartIn();
    renderWinProbSVG(box, WP_DATA, 'Astros', 'Rangers', 9, true);
    const svg = box.innerHTML;
    ok('nothing is drawn in white-on-dark', svg.indexOf('rgba(255,255,255') < 0);
    ok('and the plot ground is not a black wash', svg.indexOf('rgba(0,0,0,0.2)') < 0);
    ok('no --gold ink, which this theme makes white', svg.indexOf('var(--gold)') < 0);
    ok('the curve is navy', /<polyline[^>]*stroke="var\(--navy\)"/.test(svg));
    const labels = Array.from(box.querySelectorAll('text'));
    ok('there are labels to read', labels.length >= 12);
    ok('and every one takes its colour from the palette',
      labels.every(t => (t.getAttribute('fill') || '').indexOf('var(--') === 0));
    box.remove();
  });

  test('the chart names both sides of the 50% line', () => {
    const box = chartIn();
    renderWinProbSVG(box, WP_DATA, 'Astros', 'Rangers', 9, true);
    const text = box.textContent;
    ok('the home team owns the upper band', text.indexOf('Rangers win% (est.)') >= 0);
    ok('and the visiting team the lower', text.indexOf('Astros ahead') >= 0);
    box.remove();
  });

  test('the chart takes its width from the panel it is drawn in', () => {
    const wide = chartIn(836);
    renderWinProbSVG(wide, WP_DATA, 'Astros', 'Rangers', 9, true);
    eq('a wide panel is filled', wide.querySelector('svg').getAttribute('viewBox'), '0 0 836 160');
    wide.remove();

    const unmeasured = chartIn(0);
    renderWinProbSVG(unmeasured, WP_DATA, 'Astros', 'Rangers', 9, true);
    eq('an unmeasurable one falls back to the old width', unmeasured.querySelector('svg').getAttribute('viewBox'), '0 0 560 160');
    unmeasured.remove();

    const phone = chartIn(240);
    renderWinProbSVG(phone, WP_DATA, 'Astros', 'Rangers', 9, true);
    eq('and a phone column stops at the floor', phone.querySelector('svg').getAttribute('viewBox'), '0 0 320 160');
    phone.remove();
  });

  test('a narrow panel drops the tick that would sit under the innings caption', () => {
    const ticks = box => Array.from(box.querySelectorAll('text'))
      .filter(t => /^\d+$/.test(t.textContent) && t.getAttribute('text-anchor') === 'middle')
      .map(t => t.textContent);

    const wide = chartIn(834);
    renderWinProbSVG(wide, WP_DATA, 'Astros', 'Rangers', 10, true);
    eq('an iPad panel numbers every inning', ticks(wide).join(','), '1,2,3,4,5,6,7,8,9');
    ok('and still says how long the game was', wide.textContent.indexOf('10 inn.') >= 0);
    wide.remove();

    const phone = chartIn(336);
    renderWinProbSVG(phone, WP_DATA, 'Astros', 'Rangers', 10, true);
    eq('a phone column gives the last one up', ticks(phone).join(','), '1,2,3,4,5,6,7,8');
    eq('but keeps its gridline', phone.querySelectorAll('line').length, wide.querySelectorAll('line').length);
    ok('and the caption it made room for', phone.textContent.indexOf('10 inn.') >= 0);
    phone.remove();
  });

  // The team names went into the SVG unescaped, and they are typed by hand.
  test('a team name cannot write markup into the chart', () => {
    const box = chartIn();
    renderWinProbSVG(box, WP_DATA, '<script>x</script>', 'Ran<b>gers', 9, false);
    eq('the name made no elements', box.querySelectorAll('script,b').length, 0);
    ok('and it is still printed as typed', box.textContent.indexOf('Ran<b>gers win%') >= 0);
    box.remove();
  });

  test('the game summary draws the chart it wires up', () => {
    gameState.info.visitingTeam = 'Astros';
    gameState.info.homeTeam = 'Rangers';
    sel('visiting', 0, 0); play('HR');
    showGameSummary();
    const svg = document.querySelector('#gs-winprob-chart svg');
    ok('the summary has a chart in it', !!svg);
    ok('drawn with the navy curve', /var\(--navy\)/.test(svg.innerHTML));
    ok('and both teams named on it', svg.textContent.indexOf('Rangers') >= 0 && svg.textContent.indexOf('Astros') >= 0);
    document.getElementById('game-summary-modal').classList.remove('active');
  });
})();
