
// Storage shim: use memory storage if localStorage is blocked (file:// URLs)
// or the quota is exceeded. setItem returns true on a durable write, false when
// it fell back to in-memory (data will be lost when the page closes) so callers
// can warn the user instead of silently losing a game.
const _storage = {};
const safeStorage = {
  getItem: function(k) { try { return localStorage.getItem(k); } catch(e) { return _storage[k] || null; } },
  setItem: function(k,v) {
    try { localStorage.setItem(k,v); return true; }
    catch(e) { _storage[k] = v; reportStorageFailure(); return false; }
  },
  removeItem: function(k) { try { localStorage.removeItem(k); } catch(e) { delete _storage[k]; } }
};

// Shown once when a write falls back to memory. Reveals the persistent banner
// that warns the user their changes are not being saved on this device and
// offers a JSON backup they can download to recover the game elsewhere.
let _storageWarned = false;
function reportStorageFailure() {
  if (_storageWarned) return;
  _storageWarned = true;
  const banner = (typeof document !== 'undefined') && document.getElementById('storage-warning');
  if (banner) banner.style.display = 'flex';
}

/* ------------------------------------------------ unreadable saves (#25) ---
   A stored game that won't parse used to be discarded with a console line, and
   the next autoSave — 400ms later — wrote over it. A corrupt library key read
   as "no saved games yet", and saving one game then replaced however many were
   in there. Either way the only copy of the data was gone before anybody knew
   there was a problem.

   So: keep the raw string, both in memory (for the download button, which has
   to work even when storage is full) and under a `-unreadable` key. A write to
   the original key is refused only if that copy could not be made — otherwise
   the quarantined copy is the backup and the app stays usable. */
const UNREADABLE_SUFFIX = '-unreadable';
const _unreadable = {};   // storage key -> { raw, stashed }

function quarantineUnreadable(key, raw) {
  if (!_unreadable[key]) {
    _unreadable[key] = { raw, stashed: safeStorage.setItem(key + UNREADABLE_SUFFIX, raw) };
  }
  showUnreadableBanner();
  return _unreadable[key].stashed;
}

// True only when we could not put the unreadable text anywhere safe, which is
// the one case where overwriting the key would actually lose it.
function saveBlockedFor(key) {
  return !!_unreadable[key] && !_unreadable[key].stashed;
}

// A quarantine from an earlier session is still the user's data — pick it back
// up on load so the banner and its download button reappear.
function adoptExistingQuarantine(key) {
  if (_unreadable[key]) return;
  const raw = safeStorage.getItem(key + UNREADABLE_SUFFIX);
  if (raw === null) return;
  _unreadable[key] = { raw, stashed: true };
  showUnreadableBanner();
}

function showUnreadableBanner() {
  const banner = (typeof document !== 'undefined') && document.getElementById('unreadable-warning');
  if (banner) banner.style.display = 'flex';
}

function downloadUnreadableSaves() {
  Object.keys(_unreadable).forEach(key => {
    downloadTextFile(key + UNREADABLE_SUFFIX + '.txt', _unreadable[key].raw);
  });
}

function discardUnreadableSaves() {
  if (!confirm('Delete the unreadable saved data? Download it first if you might want to recover the game by hand.')) return;
  Object.keys(_unreadable).forEach(key => {
    safeStorage.removeItem(key + UNREADABLE_SUFFIX);
    delete _unreadable[key];
  });
  const banner = document.getElementById('unreadable-warning');
  if (banner) banner.style.display = 'none';
}
// Escapes user free-text (team/player names, notes, linescore cells) before it
// is interpolated into an innerHTML sink — the popups, saved-game library, and
// game summary. Without this a stray '<' breaks rendering and a crafted name
// persists as injected markup in the saved library. `'` is escaped too because
// several sinks build single-quoted attributes.
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Field image embedded directly in SVG
const POSITIONS = 9;
/* Rows in one lineup slot: the starter plus ROWS_PER_POS - 1 substitutes. Two was
   one short of routine — a pinch hitter followed by a defensive replacement in the
   same spot had nowhere to go, and the second SUB press could only offer to undo
   the first (H3). Raising it also made `subChange` a row *number* rather than a
   boolean; see `subRowOf`. Saves written with two rows are re-laid-out by
   `migrateLineupRows`. */
const ROWS_PER_POS = 3;
const INNINGS = 15;
const PITCHER_ROWS = 8;
const DEFAULT_REGULATION = 9;

let selectedCell = null;
let gameState = createEmptyState();

/* How long a regulation game is for THIS card. Nine unless the scorer says
   otherwise — a doubleheader, a youth game or softball is often six or seven,
   and the game-over checks used to compare against a literal 8 ("the 9th real
   inning, zero-based"), so a 7-inning game rolled straight on into an 8th. */
function regulationInnings() {
  const n = parseInt(gameState && gameState.rules && gameState.rules.regulationInnings);
  return (n >= 1 && n <= INNINGS) ? n : DEFAULT_REGULATION;
}

/* Zero-based index of the last regulation inning — what the game-over
   comparisons actually want. */
function lastRegulationIdx() { return regulationInnings() - 1; }

/* How many inning columns the card is showing. Falls back to regulation rather
   than to a literal 9, so a 7-inning game with no stored value doesn't briefly
   claim nine columns. */
function visibleInningCount() {
  return gameState.visibleInnings || regulationInnings();
}

// Identity column->inning map sized to INNINGS ([0,1,2,...,INNINGS-1]).
function defaultColumnMap() { return Array.from({ length: INNINGS }, (_, i) => i); }

// Every at-bat cell on the card carries the *starter's* row index — a sub bats
// on the starter's line — so every row that isn't a multiple of ROWS_PER_POS holds
// 15 untouched objects. They stay allocated in memory, because a dozen loops walk
// every player and index by column, but `stateForStorage` drops them on the way
// out and `refillAtBats` puts them back on the way in (#33).
function makeEmptyAtBat() {
  return { bases:[false,false,false,false], advReason:['','','',''], outOnBase:null, play:'', out:0, outsRecorded:0, pitches:[], hitLoc:null, rbi:0, pitcher:0, reachedOnError:false, pitcherChangeNum:'', subChange:0, prRow:0, seq:0 };
}

/* Which row of the slot owns this at-bat: 0 for the starter, 1..ROWS_PER_POS-1 for
   a substitute. `subChange` was a boolean while a slot had exactly one sub row, and
   a boolean cannot say *which* sub once there are two (H3) — so it is now the row
   number, and this is the one reader of it.

   `true` is still accepted and means row 1. Saves are re-laid-out on load by
   `migrateLineupRows`, but a boolean also reaches here from a library entry or an
   imported file that skipped a migration, and resolving it to the first sub is
   both what the old build meant and what the scorer sees on the card. Anything out
   of range is clamped rather than trusted: an index past the last row would read
   a player who doesn't exist. */
function subRowOf(ab) {
  if (!ab || !ab.subChange) return 0;
  const r = ab.subChange === true ? 1 : Math.floor(ab.subChange);
  return r >= 1 && r < ROWS_PER_POS ? r : (r >= ROWS_PER_POS ? ROWS_PER_POS - 1 : 0);
}

// The sub rows of a slot, in order — `[1, 2]` as it stands. Several callers split
// a slot's figures per row and would otherwise each write the same loop bounds.
function subRowOffsets() {
  return Array.from({ length: ROWS_PER_POS - 1 }, (_, i) => i + 1);
}

/* Which row is credited with the *running* in this at-bat, as against the batting.
   They are the same man unless a pinch runner came on: then the plate appearance —
   the AB, the hit, the RBI it drove in — stays with the batter who earned it, and
   only what happens on the bases from that point, the run above all, belongs to the
   man who did the running (H2, D4).

   `prRow` is that runner's row. Everything else about the column, including which
   row *batted* it, still comes from `subRowOf`. */
function runRowOf(ab) {
  if (!ab || !ab.prRow) return subRowOf(ab);
  const r = Math.floor(ab.prRow);
  return r >= 1 && r < ROWS_PER_POS ? r : subRowOf(ab);
}

// Which row is in the slot *now* — the one owning the last column of the game,
// since every sub line runs to the end of it and a re-entry hands the tail back.
// Callers that name "the man at this position" want this rather than "has a sub
// been used at all", which stopped being the same question at two sub rows.
function currentSlotRow(team, sp) {
  const abs = gameState.teams[team] && gameState.teams[team].players[sp] &&
    gameState.teams[team].players[sp].atBats;
  if (!abs || !abs.length) return 0;
  return subRowOf(abs[Math.min(INNINGS, abs.length) - 1]);
}

// A player row's at-bats, padded to INNINGS — for a save from a build with fewer
// innings, and for the sub rows `stateForStorage` empties.
function refillAtBats(state) {
  ['visiting','home'].forEach(t => {
    const team = state.teams && state.teams[t];
    if (!team || !Array.isArray(team.players)) return;
    team.players.forEach(player => {
      if (!Array.isArray(player.atBats)) player.atBats = [];
      while (player.atBats.length < INNINGS) player.atBats.push(makeEmptyAtBat());
    });
  });
}

// A shallow copy of `state` with the sub rows' at-bats emptied. Used for every
// write and for change detection, so both sides of a comparison are the same
// shape. The live `gameState` is never mutated.
function stateForStorage(state) {
  if (!state || !state.teams) return state;
  const out = Object.assign({}, state, { teams: Object.assign({}, state.teams) });
  ['visiting','home'].forEach(t => {
    const team = state.teams[t];
    if (!team || !Array.isArray(team.players)) return;
    out.teams[t] = Object.assign({}, team, {
      players: team.players.map((pl, i) => i % ROWS_PER_POS === 0 ? pl : Object.assign({}, pl, { atBats: [] }))
    });
  });
  return out;
}

function createEmptyState() {
  const makeAtBat = makeEmptyAtBat;
  const makeInning = () => ({ outs:0, bases:[null,null,null], currentPitcher:0, lob:0, outsLog:[], lastPA:null });
  return {
    info: { date:'', startTime:'', timeOfGame:'', visitingTeam:'', homeTeam:'', weather:'', attendance:'' },
    umpires: { hp:'', '1b':'', '2b':'', '3b':'' },
    notes: '',
    currentGameId: null,
    lastSaved: null,
    // Has a backup file been taken of the card as it now stands? Persisted, so the
    // prompt doesn't reappear on a card that has already been exported; absent in an
    // older save, which reads as false and asks — the honest answer for a card
    // nobody knows the history of.
    backedUp: false,
    timerStart: null,
    timerElapsed: 0,
    timerRunning: false,
    linescore: {
      visiting: { innings: Array(INNINGS).fill(''), r:'', h:'', e:'' },
      home: { innings: Array(INNINGS).fill(''), r:'', h:'', e:'' }
    },
    visibleInnings: DEFAULT_REGULATION,
    innings: {
      visiting: Array(INNINGS).fill(null).map(() => makeInning()),
      home: Array(INNINGS).fill(null).map(() => makeInning())
    },
    teams: {
      visiting: {
        players: Array(POSITIONS * ROWS_PER_POS).fill(null).map(() => ({
          num:'', name:'', pos:'', avg:'',
          atBats: Array(INNINGS).fill(null).map(() => makeAtBat())
        })),
        pitchers: Array(PITCHER_ROWS).fill(null).map(() => ({
          num:'', name:'', era:'', ip:'', pc:'', h:'', r:'', er:'', k:'', bb:''
        }))
      },
      home: {
        players: Array(POSITIONS * ROWS_PER_POS).fill(null).map(() => ({
          num:'', name:'', pos:'', avg:'',
          atBats: Array(INNINGS).fill(null).map(() => makeAtBat())
        })),
        pitchers: Array(PITCHER_ROWS).fill(null).map(() => ({
          num:'', name:'', era:'', ip:'', pc:'', h:'', r:'', er:'', k:'', bb:''
        }))
      }
    },
    columnMap: {
      visiting: defaultColumnMap(),
      home: defaultColumnMap()
    },
    nextLeadoff: {},
    defChanges: [],
    // Rule choices that differ by league and can't be derived from the card.
    // `allowReentry`: OBR 5.10(d) says a replaced player is out of the game;
    // youth and some rec leagues let a starter back in. Off by default, and the
    // re-entry prompt is where a scorer turns it on for the game in hand.
    rules: { allowReentry: false, regulationInnings: DEFAULT_REGULATION },
    // Scorer decisions the card can't re-derive: a starter coming back in, and
    // the inning a side lost its DH. Logs, like `defChanges` — recorded when the
    // decision is made and not pruned when a cell is later cleared.
    reentries: [],
    dhTerminated: { visiting: null, home: null },
    playSeq: 0
  };
}

/* ------------------------------------------- who is standing on the base ---
   `inn.bases[b]` holds `{ p, col }`: the runner and the *plate appearance he is
   running from*. It used to hold a bare player index, which is ambiguous the
   moment a batter comes up twice in one inning — both trips are the same player,
   but only one of them is on base, and only that one's cell may be marked up.
   The old code recovered the column by searching for it (`getRunnerCol`), got the
   wrong trip, and wrote a run onto a cell that had already scored (#9, #19, #30).
   The base entry carries the answer, so nothing searches. */
function runnerRef(pIdx, col) { return { p: pIdx, col }; }

// Same runner? Identity is the player: he can only be running from one plate
// appearance at a time, so a caller holding a stale column still means this man.
function sameRunner(a, b) { return !!a && !!b && a.p === b.p; }

/* Column-to-inning mapping helpers */
function getRealInning(team, colIdx) {
  if (!gameState.columnMap) gameState.columnMap = { visiting:defaultColumnMap(), home:defaultColumnMap() };
  return gameState.columnMap[team][colIdx] ?? colIdx;
}

function getColumnsForInning(team, realInning) {
  if (!gameState.columnMap) return [realInning];
  return gameState.columnMap[team].reduce((cols, ri, ci) => { if (ri === realInning) cols.push(ci); return cols; }, []);
}

// Every at-bat label on one side, re-derived. Batting around renumbers the
// columns, so a label built at grid time now names the wrong inning — the same
// staleness `updateColumnHeaders` fixes for the headers a sighted scorer reads.
function refreshCellAria(team) {
  const players = gameState.teams[team].players;
  for (let p = 0; p < players.length; p += ROWS_PER_POS) {
    for (let c = 0; c < INNINGS; c++) updateCellAria(team, p, c);
  }
}

function updateColumnHeaders(team) {
  if (!gameState.columnMap) return;
  const gridId = team === 'visiting' ? 'grid-visiting' : 'grid-home';
  const ths = document.querySelectorAll(`#${gridId} .scoring-grid thead th.inn-col`);
  ths.forEach((th, i) => {
    const realInn = getRealInning(team, i) + 1;
    th.textContent = String(realInn);
  });
}

function diamondSVG(team, playerIdx, innIdx) {
  const id = `d-${team}-${playerIdx}-${innIdx}`;
  return `<svg viewBox="0 0 60 60" class="diamond-svg" id="${id}">
    <g class="seg" data-seg="0"><line class="base-line" x1="30" y1="52" x2="52" y2="30"/></g>
    <g class="seg" data-seg="1"><line class="base-line" x1="52" y1="30" x2="30" y2="8"/></g>
    <g class="seg" data-seg="2"><line class="base-line" x1="30" y1="8" x2="8" y2="30"/></g>
    <g class="seg" data-seg="3"><line class="base-line" x1="8" y1="30" x2="30" y2="52"/></g>
    <circle class="base-dot" cx="52" cy="30" r="2.5"/>
    <circle class="base-dot" cx="30" cy="8" r="2.5"/>
    <circle class="base-dot" cx="8" cy="30" r="2.5"/>
    <polygon class="diamond-fill" points="30,52 52,30 30,8 8,30"/>
    <polygon class="home-dot" points="30,56 27,52 30,49 33,52" fill="#999" stroke="none"/>
    <text class="adv-label" id="adv-${id}-0" x="45" y="45" text-anchor="middle" dominant-baseline="middle"></text>
    <text class="adv-label" id="adv-${id}-1" x="45" y="15" text-anchor="middle" dominant-baseline="middle"></text>
    <text class="adv-label" id="adv-${id}-2" x="15" y="15" text-anchor="middle" dominant-baseline="middle"></text>
    <text class="adv-label" id="adv-${id}-3" x="15" y="45" text-anchor="middle" dominant-baseline="middle"></text>
    <g id="oob-${id}-0" display="none"><line class="out-on-path" x1="30" y1="52" x2="44" y2="38"/><line class="out-on-cross" x1="48" y1="42" x2="40" y2="34"/></g>
    <g id="oob-${id}-1" display="none"><line class="out-on-path" x1="52" y1="30" x2="38" y2="16"/><line class="out-on-cross" x1="42" y1="12" x2="34" y2="20"/></g>
    <g id="oob-${id}-2" display="none"><line class="out-on-path" x1="30" y1="8" x2="16" y2="22"/><line class="out-on-cross" x1="12" y1="18" x2="20" y2="26"/></g>
    <g id="oob-${id}-3" display="none"><line class="out-on-path" x1="8" y1="30" x2="22" y2="44"/><line class="out-on-cross" x1="18" y1="48" x2="26" y2="40"/></g>
    <text id="ue-${id}" display="none" x="30" y="31" text-anchor="middle" dominant-baseline="middle" font-size="9" font-weight="800" font-family="var(--mono)" fill="var(--accent)">UE</text>
  </svg>`;
}

/* ------------------------------------------------------ names that fit ----
   A name wider than the Player column used to run off the end of it. An
   <input> has no ellipsis to give, so it cut mid-letter, and a card that reads
   "Encarnacio" tells the scorer nothing about which Encarnacion batted.

   Wrapping to a second line is not on offer: the at-bat cells are rowspanned
   over the whole slot, so a taller name row is a taller card, and the one-page
   fit in ui.js is measuring exactly that. So the text is shrunk to the column
   instead — what a scorer does with a pen when the name is longer than the box.

   The size is computed rather than stepped down: measure the name once on a
   canvas at whatever size the stylesheet is asking for, then scale by the
   ratio. One reflow per name, not five. Anything without a measurable box — a
   collapsed sub row, or jsdom under the test runner, where nothing has a width
   — is left at its CSS size and never reaches the canvas. */
const NAME_FIT_MIN = 6;      // px floor — a name this small is at the edge of legible.
const NAME_FIT_SQUEEZE = -0.04;  // em. How far the letters may be pulled together at the floor.
const NAME_FIT_SELECTOR = '.scoring-grid td.player-cell input, .live-matchup .ls-name';

function nameFitContext() {
  if (nameFitContext._ctx === undefined) {
    try { nameFitContext._ctx = document.createElement('canvas').getContext('2d'); }
    catch (e) { nameFitContext._ctx = null; }
  }
  return nameFitContext._ctx;
}

function measureNameWidth(text, cs, fontSize) {
  const ctx = nameFitContext();
  if (!ctx) return 0;
  ctx.font = `${cs.fontStyle || 'normal'} ${cs.fontWeight || 400} ${fontSize}px ${cs.fontFamily}`;
  // The skin tracks the grid names out by .02em, which is part of the width they
  // need. Canvas letterSpacing is missing on Safari before 17.4 — add it by hand
  // there, one gap per character, which is what the layout engine does anyway.
  const track = cs.letterSpacing === 'normal' ? 0 : (parseFloat(cs.letterSpacing) || 0);
  if ('letterSpacing' in ctx) {
    ctx.letterSpacing = track + 'px';
    return ctx.measureText(text).width;
  }
  return ctx.measureText(text).width + track * text.length;
}

/* What each name was last measured, and measured against. Re-fitting is a write
   to the element followed by a read of the layout, so doing it to all 54 names
   on a card costs 54 relayouts — and a re-fit is asked for on every click, most
   of which are pitches that change no name and no column. Skip the ones that
   have not moved: a pure read, no write, no relayout. */
const _nameFitSeen = new WeakMap();

/* Shrink one name until the whole of it is inside its own box. `force` measures
   again even if nothing looks changed — for when the metrics themselves moved
   under us, which is what a webfont finishing loading does. */
function fitName(el, force) {
  if (!el) return;
  const text = (el.tagName === 'INPUT' ? el.value : el.textContent) || '';
  const seen = _nameFitSeen.get(el);
  if (!force && seen && seen.text === text && seen.box === nameBoxWidth(el)) return;
  shrinkName(el, text);
  // Recorded *after* the fit: that is the number the next call will read.
  _nameFitSeen.set(el, { text, box: nameBoxWidth(el) });
}

function nameBoxWidth(el) {
  return el.getBoundingClientRect().width || el.clientWidth;
}

function shrinkName(el, text) {
  // Measure against the stylesheet, not against the last fit.
  el.style.fontSize = '';
  el.style.letterSpacing = '';
  if (!text.trim()) return;
  const cs = window.getComputedStyle(el);
  const base = parseFloat(cs.fontSize);
  const inset = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)
              + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0);
  // Less a hair: the columns land on fractional widths, and a name measured to
  // exactly the width of one can still round its way back over the edge.
  const avail = nameBoxWidth(el) - inset - 0.5;
  if (!base || !(avail > 0)) return;
  const w = measureNameWidth(text, cs, base);
  if (!w || w <= avail) return;
  // Rounded down to a tenth: rounding up puts the last glyph back over the edge.
  const fs = Math.max(NAME_FIT_MIN, Math.floor(base * (avail / w) * 10) / 10);
  el.style.fontSize = fs + 'px';
  if (fs > NAME_FIT_MIN) return;

  // The floor bound before the name did — the Player column is set in Graduate,
  // which is a wide face, and a hyphenated double name on a phone runs past even
  // 6px. Close what is left by pulling the letters together, as far as they can
  // go before they touch. A name still too long after that is past helping.
  const over = measureNameWidth(text, cs, fs) - avail;
  if (over <= 0) return;
  const track = cs.letterSpacing === 'normal' ? 0 : (parseFloat(cs.letterSpacing) || 0);
  el.style.letterSpacing = Math.max(track - over / text.length, NAME_FIT_SQUEEZE * fs) + 'px';
}

function fitAllNames(force) {
  document.querySelectorAll(NAME_FIT_SELECTOR).forEach(el => fitName(el, force));
}

/* Coalesced, because the things that invalidate every name at once — a resize
   across a column-width breakpoint, the webfont arriving, a game loading — tend
   to arrive together. A timer rather than an animation frame: a card that loads
   while its tab is in the background (an iOS PWA coming out of the app switcher)
   is given no frames, and the names would sit unfitted until something else
   happened to touch them. */
let _nameFitQueued = 0, _nameFitForce = false;
function refitNames(force) {
  _nameFitForce = _nameFitForce || force === true;
  if (_nameFitQueued) return;
  _nameFitQueued = setTimeout(() => {
    _nameFitQueued = 0;
    const f = _nameFitForce;
    _nameFitForce = false;
    fitAllNames(f);
  }, 0);
}

function buildScoringGrid(team, containerId) {
  const wrap = document.getElementById(containerId);
  let html = '<table class="scoring-grid"><thead><tr>';
  html += '<th style="width:20px"></th>'; // batting order
  html += '<th class="player-col" style="width:30px">#</th>';
  html += '<th class="player-col" style="width:170px">Player</th>';
  html += '<th style="width:34px">POS</th>';
  html += '<th style="width:40px">AVG</th>';
  html += '<th class="stat-col">AB</th><th class="stat-col">H</th><th class="stat-col">R</th><th class="stat-col">RBI</th><th class="stat-col">BB</th>';
  for (let i = 1; i <= INNINGS; i++) html += `<th class="inn-col" data-inn="${i-1}" style="width:var(--cell-w)">${i}</th>`;
  html += '</tr></thead><tbody>';

  // `data-act` dispatch, not an inline handler: the CSP forbids inline script.
  // The change hook keeps `players[p].pos` in step with the select (the generic
  // autoSave path only reads them at save time) and puts the DH rules to it.
  const posSelect = '<select data-field="pos" data-act="posSelectChanged" data-arg="this" data-act-on="change"><option value=""></option><option>P</option><option>C</option><option>1B</option><option>2B</option><option>3B</option><option>SS</option><option>LF</option><option>CF</option><option>RF</option><option>DH</option></select>';

  for (let pos = 0; pos < POSITIONS; pos++) {
    const sp = pos * ROWS_PER_POS;     // starter player index

    // Starter row — carries the at-bat cells, spanned down over every sub row of
    // the slot, because a sub bats on the starter's line.
    html += `<tr class="pos-starter" data-team="${team}" data-player="${sp}">`;
    html += `<td class="order-cell" rowspan="${ROWS_PER_POS}">${pos + 1}</td>`;
    html += `<td class="num-cell"><input type="text" data-field="num" data-team="${team}" data-p="${sp}" maxlength="3"></td>`;
    html += `<td class="player-cell"><input type="text" data-field="name" data-team="${team}" data-p="${sp}"></td>`;
    html += `<td class="pos-cell">${posSelect.replace('data-field="pos"', `data-field="pos" data-team="${team}" data-p="${sp}"`)}</td>`;
    html += `<td class="avg-cell"><input type="text" data-field="avg" data-team="${team}" data-p="${sp}" maxlength="5"></td>`;
    html += `<td class="stat-cell" id="st-ab-${team}-${sp}"></td>`;
    html += `<td class="stat-cell" id="st-h-${team}-${sp}"></td>`;
    html += `<td class="stat-cell" id="st-r-${team}-${sp}"></td>`;
    html += `<td class="stat-cell" id="st-rbi-${team}-${sp}"></td>`;
    html += `<td class="stat-cell" id="st-bb-${team}-${sp}"></td>`;
    for (let inn = 0; inn < INNINGS; inn++) {
      html += `<td class="at-bat-cell" id="cell-${team}-${sp}-${inn}" rowspan="${ROWS_PER_POS}" aria-label="${describeCellForScreenReader(team, sp, inn)}" data-team="${team}" data-p="${sp}" data-inn="${inn}">`;
      html += `<div class="pitcher-change-mark" id="pcm-${team}-${sp}-${inn}"></div>`;
      html += `<div class="sub-change-mark" id="scm-${team}-${sp}-${inn}"></div>`;
      html += `<div class="pitch-track" id="pt-${team}-${sp}-${inn}"></div>`;
      html += `<div class="diamond-wrap">${diamondSVG(team, sp, inn)}</div>`;
      html += `<div class="play-text" id="txt-${team}-${sp}-${inn}"></div>`;
      html += `<div class="out-num" data-team="${team}" data-p="${sp}" data-inn="${inn}"></div>`;
      html += `<div class="rbi-badge" id="rbi-${team}-${sp}-${inn}"></div>`;
      html += `</td>`;
    }
    html += '</tr>';

    // Sub rows — player info only, no at-bat cells (spanned from above). The
    // placeholder numbers them once there is more than one, so the scorer can tell
    // which row a prompt is talking about.
    subRowOffsets().forEach(r => {
      const subp = sp + r;
      const ph = ROWS_PER_POS > 2 ? `PH / Sub ${r}` : 'PH / Sub';
      html += `<tr class="pos-sub" data-team="${team}" data-player="${subp}">`;
      html += `<td class="num-cell"><input type="text" data-field="num" data-team="${team}" data-p="${subp}" maxlength="3"></td>`;
      html += `<td class="player-cell"><input type="text" data-field="name" data-team="${team}" data-p="${subp}" placeholder="${ph}"></td>`;
      html += `<td class="pos-cell">${posSelect.replace('data-field="pos"', `data-field="pos" data-team="${team}" data-p="${subp}"`)}</td>`;
      html += `<td class="avg-cell"><input type="text" data-field="avg" data-team="${team}" data-p="${subp}" maxlength="5"></td>`;
      html += `<td class="stat-cell" id="st-ab-${team}-${subp}"></td>`;
      html += `<td class="stat-cell" id="st-h-${team}-${subp}"></td>`;
      html += `<td class="stat-cell" id="st-r-${team}-${subp}"></td>`;
      html += `<td class="stat-cell" id="st-rbi-${team}-${subp}"></td>`;
      html += `<td class="stat-cell" id="st-bb-${team}-${subp}"></td>`;
      html += '</tr>';
    });
  }
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

function buildPitcherTable(team, containerId) {
  const wrap = document.getElementById(containerId);
  const stats = ['ip','pc','h','r','er','k','bb'];
  const labels = ['IP','PC','H','R','ER','K','BB'];
  let html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px">';
  html += '<h3 style="margin:0">Pitchers</h3>';
  html += '<button type="button" data-act="recomputePitcherAssignments" title="Re-attribute recorded at-bats to the correct pitcher based on pitching changes" style="font-size:10px;font-weight:700;padding:2px 7px;border:1px solid var(--navy,#1a2744);border-radius:3px;background:#fff;color:var(--navy,#1a2744);cursor:pointer;font-family:var(--heading,inherit);letter-spacing:0.3px">↻ Fix Stats</button>';
  html += '</div>';
  html += '<table class="pitcher-grid"><thead><tr>';
  html += '<th class="pitcher-num-col">#</th>';
  html += '<th class="pitcher-name-col">Pitcher</th>';
  labels.forEach(l => html += `<th>${l}</th>`);
  html += '<th class="pitcher-era-col">ERA</th>';
  html += '</tr></thead><tbody>';

  for (let i = 0; i < PITCHER_ROWS; i++) {
    html += '<tr>';
    html += `<td><input type="text" data-team="${team}" data-pitcher="${i}" data-field="num" maxlength="3" style="text-align:center"></td>`;
    html += `<td class="p-name"><input type="text" data-team="${team}" data-pitcher="${i}" data-field="name"></td>`;
    stats.forEach(s => {
      html += `<td class="p-stat"><input type="text" data-team="${team}" data-pitcher="${i}" data-field="${s}" maxlength="5"></td>`;
    });
    // ERA is derived from this game's ER and IP, so it is a cell, not an input —
    // the header used to promise an ERA in the name column and no field ever
    // existed for it. `updatePitcherStats` fills it.
    html += `<td class="p-era" data-team="${team}" data-pitcher="${i}" data-field="era"></td>`;
    html += '</tr>';
  }
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

function buildLinescore() {
  // Header: one inning column per INNINGS, then R/H/E/LOB.
  const headerRow = document.getElementById('ls-header-row');
  if (headerRow) {
    let ths = '<th class="team-col"></th>';
    for (let i = 0; i < INNINGS; i++) ths += `<th data-inn-col="${i}">${i + 1}</th>`;
    ths += '<th>R</th><th>H</th><th>E</th><th>LOB</th>';
    headerRow.innerHTML = ths;
  }
  const teams = ['visiting','home'];
  teams.forEach(t => {
    const row = document.getElementById(`ls-${t}`);
    const existing = row.querySelector('.team-col');
    let html = '';
    for (let i = 0; i < INNINGS; i++) {
      html += `<td data-inn-col="${i}"><input type="text" data-ls="${t}" data-inn="${i}" maxlength="3" data-act="updateLinescoreTotals" data-arg="${t}" data-act-on="input"></td>`;
    }
    html += `<td class="total"><input type="text" data-ls="${t}" data-stat="r" readonly tabindex="-1"></td>`;
    html += `<td class="total"><input type="text" data-ls="${t}" data-stat="h" readonly tabindex="-1"></td>`;
    html += `<td class="total"><input type="text" data-ls="${t}" data-stat="e" readonly tabindex="-1"></td>`;
    html += `<td class="total ls-lob"><input type="text" data-ls="${t}" data-stat="lob" readonly tabindex="-1"></td>`;
    row.innerHTML = `<td class="team-col">${t === 'visiting' ? '<span id="ls-v-label">Visiting</span>' : '<span id="ls-h-label">Home</span>'}</td>` + html;
  });
}

/* Standings and field diagram removed - replaced by situation panel */

/* Interaction */
function selectCell(td) {
  // Moving the selection out from under a pending entry popup is what orphans the
  // play the popup is still deciding (C1). Every programmatic caller runs after
  // the popup has closed, so this only ever refuses a real tap or hotkey.
  if (td !== selectedCell && entryInProgress()) {
    showPlayReject('Finish the open entry first.');
    return;
  }
  if (selectedCell) {
    selectedCell.classList.remove('selected');
    selectedCell.removeAttribute('aria-current');
  }
  selectedCell = td;
  td.classList.add('selected');
  // `aria-current`, not `aria-selected`: these are ordinary table cells, and
  // promoting the card to role="grid" to make aria-selected legal would cost a
  // screen reader the table navigation it already has.
  td.setAttribute('aria-current', 'true');
  announce('Selected ' + describeCellForScreenReader(td.dataset.team, parseInt(td.dataset.p), parseInt(td.dataset.inn)));
  updateSituation();
}

function renderDiamond(team, pIdx, innIdx) {
  const ab = gameState.teams[team].players[pIdx].atBats[innIdx];
  updateCellAria(team, pIdx, innIdx);
  const id = `d-${team}-${pIdx}-${innIdx}`;
  const svg = document.getElementById(id);
  if (!svg) return;
  svg.querySelectorAll('.seg').forEach((seg, i) => seg.classList.toggle('reached', ab.bases[i]));
  svg.classList.toggle('scored', ab.bases[0] && ab.bases[1] && ab.bases[2] && ab.bases[3] && ab.outOnBase == null);
  // Advancement reason labels
  const reasons = ab.advReason || ['','','',''];
  for (let i = 0; i < 4; i++) {
    const el = document.getElementById(`adv-${id}-${i}`);
    if (el) el.textContent = reasons[i] || '';
  }
  // Out-on-base indicator
  for (let i = 0; i < 4; i++) {
    const oob = document.getElementById(`oob-${id}-${i}`);
    if (oob) oob.setAttribute('display', ab.outOnBase === i ? 'block' : 'none');
  }
  // Unearned run indicator
  const ueEl = document.getElementById(`ue-${id}`);
  if (ueEl) {
    const scored = ab.bases[0] && ab.bases[1] && ab.bases[2] && ab.bases[3] && ab.outOnBase == null;
    ueEl.setAttribute('display', scored && ab.reachedOnError ? 'block' : 'none');
  }
}

function renderOut(team, pIdx, innIdx) {
  const ab = gameState.teams[team].players[pIdx].atBats[innIdx];
  updateCellAria(team, pIdx, innIdx);
  const el = document.querySelector(`.out-num[data-team="${team}"][data-p="${pIdx}"][data-inn="${innIdx}"]`);
  if (!el) return;
  const p = ab.play || '';
  const isOutType = isOutPlay(p) || p === 'K' || p === 'ꓘ';
  // Only show out number on out plays — on-base plays show the out via the diamond indicator
  if (!isOutType) {
    el.textContent = '';
    el.classList.remove('active');
    return;
  }
  if (ab.dpOuts && ab.dpOuts.length >= 2) {
    el.textContent = ab.dpOuts.join('/');
    el.style.fontSize = '10px';
  } else {
    el.textContent = ab.out || '';
    el.style.fontSize = '';
  }
  el.classList.toggle('active', ab.out > 0 || (ab.dpOuts && ab.dpOuts.length >= 2));
}

/* ------------------------------------------------------------ a11y ---
   An at-bat cell is a diamond, a play code and an out number — all of it
   graphical. These give a screen reader the same thing in words, and keep it in
   step: `renderPlayText` runs on every change to a cell, so the label is
   rewritten with the play. The selected cell is also announced through a live
   region, since moving the selection changes nothing a reader would otherwise
   notice. */
const A11Y_BASES = ['1st', '2nd', '3rd'];

function describeCellForScreenReader(team, pIdx, col) {
  const side = team === 'visiting' ? 'Visiting' : 'Home';
  const spot = Math.floor(pIdx / ROWS_PER_POS) + 1;
  const innNum = getRealInning(team, col) + 1;
  const where = `${side}, batting order ${spot}, inning ${innNum}`;
  const ab = gameState.teams[team] && gameState.teams[team].players[pIdx] &&
    gameState.teams[team].players[pIdx].atBats[col];
  if (!ab || !ab.play) return where + ', empty';
  const bits = [ab.play];
  if (ab.rbi) bits.push(ab.rbi + ' RBI');
  if (ab.bases[0] && ab.bases[1] && ab.bases[2] && ab.bases[3] && ab.outOnBase == null) {
    bits.push(ab.reachedOnError ? 'scored, unearned' : 'scored');
  } else if (ab.outOnBase != null) {
    bits.push('out at ' + (ab.outOnBase === 3 ? 'home' : A11Y_BASES[ab.outOnBase]));
  } else if (ab.out) {
    bits.push('out ' + ab.out);
  } else {
    let last = -1;
    for (let i = 0; i < 3; i++) if (ab.bases[i]) last = i;
    if (last >= 0) bits.push('on ' + A11Y_BASES[last]);
  }
  return where + ': ' + bits.join(', ');
}

function updateCellAria(team, pIdx, col) {
  const cell = document.getElementById(`cell-${team}-${pIdx}-${col}`);
  if (cell) cell.setAttribute('aria-label', describeCellForScreenReader(team, pIdx, col));
}

// Say out loud whatever just changed, for a reader that has no other way to
// notice it. Anything else on the page is unaffected: the region is off-screen.
function announce(message) {
  const el = document.getElementById('a11y-live');
  if (el) el.textContent = message;
}

function renderPlayText(team, pIdx, innIdx) {
  updateCellAria(team, pIdx, innIdx);
  const ab = gameState.teams[team].players[pIdx].atBats[innIdx];
  const el = document.getElementById(`txt-${team}-${pIdx}-${innIdx}`);
  if (!el) return;
  const p = ab.play || '';
  const isFCsafe = (p === 'FC' || /^FC /.test(p)) && ab.bases[0] && !ab.out;
  const isOut = !isFCsafe && (isOutPlay(p) || p === 'K' || p === 'ꓘ');
  // Build content: RBI dots + play text for on-base, just text for outs
  const rbi = ab.rbi || 0;
  if (rbi > 0) {
    let dots = '';
    for (let i = 0; i < rbi; i++) dots += '<span class="rbi-dot-mark"></span>';
    el.innerHTML = dots + p;
  } else {
    el.textContent = p;
  }
  el.classList.remove('play-out', 'play-on');
  el.style.fontSize = '';
  if (p) {
    if (isOut) {
      el.classList.add('play-out');
      const len = p.length;
      el.style.fontSize = len > 6 ? '8px' : len > 4 ? '10px' : '14px';
    } else {
      el.classList.add('play-on');
      const len = p.length;
      el.style.fontSize = len > 4 ? '10px' : '14px';
    }
  }

  // Highlight cell by play type
  const cell = el.closest('.at-bat-cell');
  if (!cell) return;
  cell.classList.remove('play-k','play-hit','play-bb','play-dp','play-hr','play-go');
  if (!p) return;
  if (p === 'K' || p === 'ꓘ' || p === 'K+WP') cell.classList.add('play-k');
  else if (p === 'HR') cell.classList.add('play-hr');
  else if (p === 'DP' || /^DP /.test(p)) cell.classList.add('play-dp');
  else if (p === 'BB' || p === 'IBB' || p === 'HBP') cell.classList.add('play-bb');
  else if (isHitPlay(p)) cell.classList.add('play-hit');
  else if (/^(GO|FO|LO|PO|IF|FC|SF|SH|TP)/.test(p)) cell.classList.add('play-go');
}

function getInnState(team, innIdx) {
  if (!gameState.innings) gameState.innings = { visiting: Array(INNINGS).fill(null).map(() => ({outs:0,bases:[null,null,null]})), home: Array(INNINGS).fill(null).map(() => ({outs:0,bases:[null,null,null]})) };
  if (!gameState.innings[team][innIdx]) gameState.innings[team][innIdx] = { outs:0, bases:[null,null,null] };
  return gameState.innings[team][innIdx];
}

// Resolve which pitcher is on the mound for a given inning column.
// A pitching change (setPitcher) stamps that column with pitcherSet=true.
// Later innings with no change of their own inherit the most recent one by
// walking backward through columns (which are in chronological order, since
// batting-around overflow inserts columns to the right). Defaults to the
// starter (index 0) when no change has been made yet.
function getEffectivePitcher(team, innIdx) {
  for (let c = innIdx; c >= 0; c--) {
    const inn = gameState.innings && gameState.innings[team] && gameState.innings[team][c];
    if (inn && inn.pitcherSet) return inn.currentPitcher || 0;
  }
  return 0;
}

/* ------------------------------------------------------- recording outs ---
   One chokepoint for every out in the game. Before this there were fifteen
   `inn.outs++` sites with inconsistent 3-out guards, and pitcher IP had to be
   re-inferred afterwards from `outsRecorded`/`outOnBase` on the batter's at-bat
   — which missed every out that wasn't the batter's own (#10).

   `inn.outsLog` is now the record: one entry per out, in order, carrying the
   pitcher who was on the mound. IP counts entries; nothing infers.

   `pIdx`/`col` are the at-bat cell the out is *shown* on — the runner's own cell
   for a base out. `srcP`/`srcCol` are the cell whose play *caused* it, so
   clearing a double play takes both of its outs with it (#21).

   Returns the out number (1-3), or 0 when refused because the inning is over. */
function recordOut(team, innIdx, opts) {
  const inn = getInnState(team, innIdx);
  if (inn.outs >= 3) return 0;
  if (!Array.isArray(inn.outsLog)) inn.outsLog = [];
  inn.outs++;
  const pIdx = opts.pIdx === undefined ? null : opts.pIdx;
  const col = opts.col === undefined ? innIdx : opts.col;
  inn.outsLog.push({
    n: inn.outs,
    kind: opts.kind || 'batter',
    pIdx, col,
    srcP: opts.srcP === undefined ? pIdx : opts.srcP,
    srcCol: opts.srcCol === undefined ? col : opts.srcCol,
    pitcher: getEffectivePitcher(team, innIdx)
  });
  return inn.outs;
}

// The batter's own out, stamped on his at-bat the way the old inline
// `inn.outs++; ab.out = inn.outs; ab.outsRecorded = 1` did.
function recordBatterOut(team, innIdx, pIdx, ab) {
  const n = recordOut(team, innIdx, { kind: 'batter', pIdx, col: innIdx });
  if (!n) return 0;
  ab.out = n;
  ab.outsRecorded = 1;
  return n;
}

// Every out of a real inning, in order. Batting around splits one inning across
// several columns; each column logs the outs made while it was the active one,
// so the inning's log is those columns' logs concatenated (column order is
// chronological).
function inningOutsLog(team, realInn) {
  const all = [];
  for (const col of getColumnsForInning(team, realInn)) {
    const inn = gameState.innings && gameState.innings[team] && gameState.innings[team][col];
    if (inn && Array.isArray(inn.outsLog)) all.push(...inn.outsLog);
  }
  return all;
}

// Every out one plate appearance produced — the batter's and any runner it
// doubled off.
function outsFromPlay(inn, pIdx, col) {
  if (!Array.isArray(inn.outsLog)) return [];
  return inn.outsLog.filter(o => o.srcP === pIdx && o.srcCol === col);
}

// Undo the outs a play produced. `fallback` is how many to subtract when the log
// is missing (a game saved before Phase 3 that mergeStateDefaults couldn't
// backfill). Returns how many were removed.
function removeOutsFromPlay(team, innIdx, pIdx, col, fallback) {
  const inn = getInnState(team, innIdx);
  if (!Array.isArray(inn.outsLog) || !inn.outsLog.length) {
    const n = fallback || 0;
    inn.outs = Math.max(0, inn.outs - n);
    return n;
  }
  const keep = inn.outsLog.filter(o => !(o.srcP === pIdx && o.srcCol === col));
  const removed = inn.outsLog.length - keep.length;
  inn.outsLog = keep;
  inn.outs = Math.max(0, inn.outs - removed);
  return removed;
}

// After an out is removed the survivors' numbers have a gap in them, so the card
// showed "1" and "3" for a two-out inning. Renumber the log and the out badges
// it points at, across every column of the real inning.
function renumberOuts(team, innIdx) {
  const players = gameState.teams[team].players;
  let n = 0;
  for (const col of getColumnsForInning(team, getRealInning(team, innIdx))) {
    const inn = gameState.innings[team][col];
    if (!inn || !Array.isArray(inn.outsLog)) continue;
    for (const o of inn.outsLog) {
      o.n = ++n;
      if (o.pIdx == null) continue;
      const rab = players[o.pIdx] && players[o.pIdx].atBats[o.col];
      if (rab && rab.out > 0 && rab.out !== o.n && !(rab.dpOuts && rab.dpOuts.length >= 2)) {
        rab.out = o.n;
        renderOut(team, o.pIdx, o.col);
      }
    }
  }
}

// The R totals as the line shows them. `checkGameOver` and the walk-off clause of
// `halfInningIsOver` have to read the same two numbers, and the line is where they
// live: an inning nobody has records for may have been typed in by hand — a scorer
// picking a game up in the 4th — and those runs still count towards who is ahead.
function runsOnLine(team) {
  return parseInt(document.querySelector(`input[data-ls="${team}"][data-stat="r"]`)?.value) || 0;
}

/* Is this half-inning over? Three outs, normally — but the home half of the last
   inning also ends on the run that puts the home team ahead, with nobody out and
   runners still standing. Those runners were left on base, and LOB read 0 for
   every walk-off because the only test was `outs >= 3` (M2).

   Deliberately the same condition `checkGameOver` ends the game on, through the
   same `halfEndsGame`, so the card can't call a game final and its LOB column
   still say the inning is being played. */
function halfInningIsOver(team, realInn, outs) {
  if (outs >= 3) return true;
  // With fewer than 3 outs the only thing that ends a half is a walk-off, which
  // is the home clause of `halfEndsGame` — asked there rather than restated here.
  return team === 'home' && halfEndsGame('home', realInn, outs);
}

/* Does this half-inning end the *game*? The one copy of that condition.
   There were three: `checkGameOver`, the walk-off clause above, and
   `updateLiveStatsFromState`'s `isComplete`, which had drifted — it missed the
   walk-off entirely (so the card that ends on the winning run never read FINAL)
   and forgot `vR !== hR` (so a tied bottom of the 9th read FINAL when the game
   was headed for extras). M1.

   The home half ends the instant the home team goes ahead: a walk-off doesn't wait
   for a 3rd out, and it doesn't care whether the run came in on a hit or a wild
   pitch. Otherwise the half has to be complete and the game not tied. */
function halfEndsGame(team, realInn, outs) {
  if (realInn < lastRegulationIdx()) return false;
  const vR = runsOnLine('visiting');
  const hR = runsOnLine('home');
  return team === 'home'
    ? (hR > vR || (outs >= 3 && vR !== hR))
    : (outs >= 3 && hR > vR);
}

/* ------------------------------------------------- recomputing an inning ---
   An inning's derived state — the out count, who is standing on which base, the
   runs on the linescore, LOB — is a function of the at-bat records and the out
   log. It used to be *patched*: every mutator adjusted the parts it believed it
   had changed, and each one forgot something different. Clearing an older play
   left its runner outs standing (#21). Changing a play type adjusted the batter's
   own bases and nothing else (#22). LOB had two writers that disagreed (#16).
   `fillLinescoreZeros` wrote the right zero into the wrong inning (#23).

   So mutators now fix the at-bat records they own and call this. Nothing else
   writes `inn.outs`, `inn.bases` or `inn.lob` for a finished edit — grep
   `inn.outs =` / `inn.bases\[` / `.lob =` and the hits are here, plus the three
   runner helpers and `removeOutsFromPlay`, which this reads back.

   Batting around spreads one real inning across several columns. They all describe
   the same inning, so they all get the same outs and bases: `overflowToNextColumn`
   has always copied them forward at the moment it inserts a column, and this keeps
   the copies in step however the edit arrived — the divergence Phase 3 left open. */
function recomputeInning(team, realInn) {
  if (realInn == null || realInn < 0 || realInn >= INNINGS) return;
  const cols = getColumnsForInning(team, realInn);
  if (!cols.length) return;
  const players = gameState.teams[team].players;

  // Outs: the log is the record. Renumber first — an out removed from the middle
  // leaves a gap, and the card read "1" and "3" for a two-out inning.
  renumberOuts(team, cols[0]);
  const outs = Math.min(3, inningOutsLog(team, realInn).length);

  // Bases: a runner is on base when his cell says he reached, hasn't scored and
  // wasn't put out on the bases. The base he's on is the last one marked, and the
  // cell it came off is the plate appearance he's running from — which is exactly
  // what the base entry records, so this is also where those entries are minted.
  const bases = [null, null, null];
  for (const col of cols) {
    for (let p = 0; p < players.length; p++) {
      const ab = players[p].atBats[col];
      if (!ab || !ab.play || !ab.bases[0] || ab.bases[3] || ab.outOnBase != null) continue;
      let b = 0;
      for (let i = 2; i >= 0; i--) if (ab.bases[i]) { b = i; break; }
      if (bases[b] !== null && bases[b].p !== p) {
        // Two live plate appearances claiming one base. Recomputing can't make
        // that true, so keep the first and say so loudly — the policy
        // `setRunnerOn` uses for a colliding placement. Reachable from an
        // imported or hand-edited game, not from playing one.
        console.warn(`recomputeInning: ${team} inning ${realInn + 1} — runner ${bases[b].p} and runner ${p} both on ${BASE_NAMES[b]}`);
        continue;
      }
      bases[b] = runnerRef(p, col);
    }
  }

  for (const col of cols) {
    const inn = getInnState(team, col);
    inn.outs = outs;
    // In place — callers hold `inn.bases` across a recompute.
    for (let b = 0; b < 3; b++) inn.bases[b] = bases[b];
  }

  // Runs on the line, by real inning, then the R/H/E/LOB totals. Ahead of LOB
  // rather than after it now: `halfInningIsOver` asks whether the home team is
  // ahead, and on a walk-off the run that puts them there is the one this
  // recompute has just derived.
  updateInningRuns(team, cols[cols.length - 1]);

  // One definition of LOB (#16): the runners left standing when the half-inning
  // ends. Nothing is left on base until it does, so an inning in progress is 0.
  const lob = halfInningIsOver(team, realInn, outs) ? bases.filter(r => r !== null).length : 0;
  for (const col of cols) getInnState(team, col).lob = lob;
  // The figure this inning contributes has just moved, and the total on the line
  // was added up from the old one a few lines above. Re-add it.
  writeTeamLOB(team);
}

// Has anybody batted in this inning? Distinguishes "0 runs" from "not played" —
// an inning with no records has nothing to derive, and its linescore cell may have
// been filled in by hand.
function inningHasRecords(team, realInn) {
  const players = gameState.teams[team].players;
  for (const col of getColumnsForInning(team, realInn)) {
    for (const player of players) {
      const ab = player.atBats[col];
      if (ab && (ab.play || (ab.pitches && ab.pitches.length))) return true;
    }
  }
  return false;
}

// A team's LOB is the per-inning figures summed. Once per *real* inning: a
// batted-around inning has the same LOB on each of its columns.
function teamLOB(team) {
  let total = 0;
  for (let ri = 0; ri < INNINGS; ri++) {
    const cols = getColumnsForInning(team, ri);
    if (!cols.length) continue;
    const inn = gameState.innings && gameState.innings[team] && gameState.innings[team][cols[0]];
    if (inn && inn.lob) total += inn.lob;
  }
  return total;
}

// LOB on the line. Split out of `updateLinescoreTotals` because `recomputeInning`
// settles a half-inning's figure *after* the runs are on the line — the walk-off
// test needs them — so the total has to be re-added once it does.
function writeTeamLOB(team) {
  const total = teamLOB(team);
  gameState.linescore[team].lob = total;
  const inp = document.querySelector(`input[data-ls="${team}"][data-stat="lob"]`);
  if (inp) inp.value = total || '';
}

// Which row is occupying the slot in this column — the starter's, or the sub's
// once a sub line covers it.
function getActivePlayerIndex(team, pIdx, innIdx) {
  const sp = Math.floor(pIdx / ROWS_PER_POS) * ROWS_PER_POS;
  const ab = gameState.teams[team].players[sp].atBats[innIdx];
  return sp + subRowOf(ab);
}

// A row's `num`/`name` as they stand on the card. `collectState` only scrapes the
// lineup inputs on the debounced save (~400ms after the last keystroke), so
// anything that puts a player's name in front of the scorer has to read the
// input: a name typed a moment ago is not in the state yet, and every popup that
// asked about "Batter 3" was asking about a man whose name was on screen.
function livePlayerField(team, pIdx, field) {
  const inp = document.querySelector(`input[data-field="${field}"][data-team="${team}"][data-p="${pIdx}"]`);
  if (inp) return inp.value;
  const pl = gameState.teams[team] && gameState.teams[team].players[pIdx];
  return (pl && pl[field]) || '';
}

// The same for a pitcher's row, which the table keys by `data-pitcher` rather than
// `data-p`. The game summary needs it for the reason above (L3): a reliever written
// in as he came out of the bullpen is on screen a good while before the debounce.
function livePitcherField(team, idx, field) {
  const inp = document.querySelector(`input[data-team="${team}"][data-pitcher="${idx}"][data-field="${field}"]`);
  if (inp) return inp.value;
  const p = gameState.teams[team] && gameState.teams[team].pitchers[idx];
  return (p && p[field]) || '';
}

function getActivePlayerName(team, pIdx, innIdx) {
  const ap = getActivePlayerIndex(team, pIdx, innIdx);
  const pos = Math.floor(pIdx / ROWS_PER_POS) + 1;
  const num = livePlayerField(team, ap, 'num');
  return (num ? '#' + num + ' ' : '') + (livePlayerField(team, ap, 'name') || 'Batter ' + pos);
}

function getBatterLabel(team, pIdx, innIdx) {
  const ap = innIdx !== undefined ? getActivePlayerIndex(team, pIdx, innIdx) : pIdx;
  return livePlayerField(team, ap, 'num') || String(Math.floor(pIdx / ROWS_PER_POS) + 1);
}

function setAdvReason(ab, segIdx, reason) {
  if (!ab.advReason) ab.advReason = ['','','',''];
  if (!ab.advReason[segIdx]) ab.advReason[segIdx] = reason;
}

// Mark a base a runner reached on his own cell: the segment, why, and — when a
// plate appearance sent him there — which one. `src` is that batter's cell, the
// same {pIdx, col} pair `recordOut` carries as srcP/srcCol, and it's what lets
// clearing a play take back exactly the advancement it caused (#21). A base taken
// on a steal, a wild pitch or a manual move has no src: it isn't any play's to
// give back. `advSrc` is created only when something stamps it, so an at-bat that
// never advanced anybody costs nothing to store.
function markAdvance(ab, segIdx, reason, src) {
  ab.bases[segIdx] = true;
  setAdvReason(ab, segIdx, reason);
  if (!src) return;
  if (!Array.isArray(ab.advSrc)) ab.advSrc = [null, null, null, null];
  if (!ab.advSrc[segIdx]) ab.advSrc[segIdx] = { p: src.pIdx, col: src.col };
}

// Take back the advancement one plate appearance caused, across every column of
// its inning. The runner's own cell still carries the bases he had reached before
// it, so unmarking this play's segments drops him back to the last base still
// marked — which is where he was standing when it happened, and where
// `recomputeInning` will then find him.
//
// Only segments stamped with this play come off; a base he stole is his to keep.
// A game saved before the stamp existed has none, so it keeps the old behaviour
// rather than guessing which play moved whom.
//
// A later play may have put somebody on the base a runner would go back to — clear
// the single that drove a man in and the batter who followed him is standing on
// 1st. There is no honest answer to that: the later play only happened because
// this one did. So the runner keeps what he was given, loudly, rather than making
// two men share a base — the same policy `setRunnerOn` uses for a collision.
function revertAdvancesFrom(team, realInn, srcP, srcCol) {
  const players = gameState.teams[team].players;
  const cols = getColumnsForInning(team, realInn);

  // Everyone holding a base stamped to this play, with the marks the revert would
  // leave him and the base that would put him back on.
  const candidates = [];
  for (const col of cols) {
    for (let p = 0; p < players.length; p++) {
      if (p === srcP && col === srcCol) continue;   // the batter's own cell
      const ab = players[p].atBats[col];
      if (!ab || !Array.isArray(ab.advSrc)) continue;
      const segs = [];
      for (let seg = 0; seg < 4; seg++) {
        const s = ab.advSrc[seg];
        if (s && s.p === srcP && s.col === srcCol) segs.push(seg);
      }
      if (!segs.length) continue;
      const after = ab.bases.slice();
      segs.forEach(seg => { after[seg] = false; });
      candidates.push({ p, col, ab, segs, after });
    }
  }
  if (!candidates.length) return;

  // The bases held by runners this revert doesn't touch. The cleared cell isn't one
  // of them — its batter is coming off the card with his play.
  const untouched = new Set(candidates.map(c => c.p + ':' + c.col));
  untouched.add(srcP + ':' + srcCol);
  const occupied = [null, null, null];
  for (const col of cols) {
    for (let p = 0; p < players.length; p++) {
      if (untouched.has(p + ':' + col)) continue;
      const ab = players[p].atBats[col];
      if (!ab || !ab.play || !ab.bases[0] || ab.bases[3] || ab.outOnBase != null) continue;
      for (let i = 2; i >= 0; i--) if (ab.bases[i]) { occupied[i] = p; break; }
    }
  }

  for (const c of candidates) {
    // A runner still credited with a run after the revert isn't coming back to a
    // base at all, so nothing can be in his way.
    if (!c.after[3] && c.after[0]) {
      let dest = 0;
      for (let i = 2; i >= 0; i--) if (c.after[i]) { dest = i; break; }
      if (occupied[dest] !== null) {
        console.warn(`revertAdvancesFrom: ${team} inning ${realInn + 1} — runner ${c.p} keeps the base runner ${srcP}'s play gave him; runner ${occupied[dest]} is on ${BASE_NAMES[dest]}`);
        continue;
      }
      occupied[dest] = c.p;
    }
    for (const seg of c.segs) {
      c.ab.bases[seg] = false;
      if (c.ab.advReason) c.ab.advReason[seg] = '';
      c.ab.advSrc[seg] = null;
    }
    renderDiamond(team, c.p, c.col);
    renderPlayText(team, c.p, c.col);
  }
}

// Is this at-bat credited with a run right now? Every base marked, home included,
// and not thrown out along the way.
function runScored(ab) {
  return !!(ab && ab.bases[0] && ab.bases[1] && ab.bases[2] && ab.bases[3] && ab.outOnBase == null);
}

// Every run credited in this at-bat's inning right now, each with the plate
// appearance that drove it in — `advSrc[3]`, the stamp `markAdvance` puts on the
// segment that brought him home. A run nobody stamped (a steal of home, a wild
// pitch) has no source, and no RBI was credited for it either.
function scoredRunsWithSource(team, cols) {
  const players = gameState.teams[team].players;
  const runs = [];
  for (const col of cols) {
    for (let p = 0; p < players.length; p++) {
      const ab = players[p].atBats[col];
      if (!runScored(ab)) continue;
      runs.push({ p, col, src: Array.isArray(ab.advSrc) ? ab.advSrc[3] : null });
    }
  }
  return runs;
}

// A run that comes off the board takes its RBI with it (#C3). `recomputeInning`
// re-derives outs, bases, runs and LOB but not `ab.rbi`, which `countRunnersScored`
// freezes at entry — so clearing or rewriting the man who scored used to leave the
// batter credited with driving in a run that no longer exists, and team RBI could
// exceed team runs.
//
// RBI can't simply be re-derived: it is a scorer judgement (9.04(b) suppresses it
// on a double play and on a K+WP, and `adjustRBI` exists so a human can override).
// So only the credit for runs that actually disappeared is dropped, and only from
// the play each run was stamped to — an override survives anything it doesn't
// contradict. The taken-back cell is skipped: the caller wipes its whole at-bat.
function dropRbiForLostRuns(team, col, pIdx, runsBefore) {
  const players = gameState.teams[team].players;
  for (const run of runsBefore) {
    if (!run.src) continue;
    if (run.src.p === pIdx && run.src.col === col) continue;
    // The taken-back cell's own runner is coming off the card with his play, so his
    // run is gone whatever his bases still read at this point.
    const gone = (run.p === pIdx && run.col === col) || !runScored(players[run.p].atBats[run.col]);
    if (!gone) continue;
    const sab = players[run.src.p].atBats[run.src.col];
    if (!sab || !sab.rbi) continue;
    sab.rbi = Math.max(0, sab.rbi - 1);
    renderRBI(team, run.src.p, run.src.col);
    renderPlayText(team, run.src.p, run.src.col);
  }
  updatePlayerStats(team);
}

// Take a plate appearance's effects back off the inning: the outs it made (its
// batter's own and any runner it doubled off) and the bases it handed out. Both
// halves of #21. `fallbackOuts` is how many outs to subtract when there is no log
// to consult (a game saved before Phase 3 that couldn't be backfilled).
//
// The batter's own at-bat record is the caller's to clear — clearing a cell,
// keeping its pitches and changing its play type each keep a different amount of
// it — but the effects on everybody *else* are identical, and used to be
// reimplemented (or forgotten) separately in each.
function takeBackPlay(team, col, pIdx, fallbackOuts) {
  const inn = getInnState(team, col);
  const players = gameState.teams[team].players;
  const realInn = getRealInning(team, col);
  // Who is credited with a run, and off whose play, before any of this comes off —
  // compared again once it has, to take the RBI down with the run (#C3).
  const runsBefore = scoredRunsWithSource(team, getColumnsForInning(team, realInn));
  // Read the runner outs before the log entries go: after this the only record
  // that they happened is the `out` / `outOnBase` marks on the runners' own cells.
  const runnerOuts = outsFromPlay(inn, pIdx, col).filter(o => o.pIdx !== pIdx || o.col !== col);
  removeOutsFromPlay(team, col, pIdx, col, fallbackOuts);
  for (const o of runnerOuts) {
    if (o.pIdx == null) continue;
    const rab = players[o.pIdx].atBats[o.col];
    rab.out = 0; rab.outOnBase = null;
    renderDiamond(team, o.pIdx, o.col);
    renderOut(team, o.pIdx, o.col);
  }
  // The bases it handed out go back too. A base a runner stole, or took on a wild
  // pitch, isn't this play's to take away.
  revertAdvancesFrom(team, realInn, pIdx, col);
  dropRbiForLostRuns(team, col, pIdx, runsBefore);
}

// The at-bat cell a runner on base is running from — his own record, where his
// advancement is written. Reads the base entry; nothing searches for it.
function runnerAtBat(team, runner) {
  const player = runner && gameState.teams[team].players[runner.p];
  return player ? player.atBats[runner.col] : null;
}

// Everyone on base moves up `advanceBy` (1 for a wild pitch, balk or passed
// ball; 4 for a home run). Lead runner first, so the base he vacates is already
// free for the man behind him. `src` is the plate appearance responsible, when
// there is one — a home run has one, a wild pitch doesn't.
function advanceRunners(team, innIdx, advanceBy, reason, src) {
  const inn = getInnState(team, innIdx);
  const rsn = reason || '';
  const by = Math.max(1, advanceBy || 1);
  for (let from = 2; from >= 0; from--) {
    const rn = inn.bases[from];
    if (rn === null) continue;
    const dest = Math.min(from + by, 3);
    const rab = runnerAtBat(team, rn);
    if (!rab) continue;
    if (!moveRunnerTo(inn, from, dest, rn)) continue;
    for (let step = from + 1; step <= dest; step++) markAdvance(rab, step, rsn, src);
    renderDiamond(team, rn.p, rn.col);
  }
}

function advanceForcedRunners(team, innIdx, reason, src) {
  const inn = getInnState(team, innIdx);
  const rsn = reason || 'BB';
  // A runner is only forced while every base behind him is occupied, so count out
  // from 1st and stop at the first empty base.
  let forcedThrough = -1;
  for (let b = 0; b < 3; b++) {
    if (inn.bases[b] === null) break;
    forcedThrough = b;
  }
  for (let from = forcedThrough; from >= 0; from--) {
    const rn = inn.bases[from];
    if (rn === null) continue;
    const rab = runnerAtBat(team, rn);
    if (!rab) continue;
    if (!moveRunnerTo(inn, from, from + 1, rn)) continue;
    markAdvance(rab, from + 1, rsn, src);
    renderDiamond(team, rn.p, rn.col);
  }
}

// Scorers type "GO 6-3" / "FO 8"; everything downstream matches canonical codes
// ("6-3", "F8"). New entries are normalized at the input boundary by
// normalizePlayCode, so a prefixed code only reaches state from a game saved
// before that existed — isOutPlay still has to recognise those.
const PREFIXED_OUT_RE = /^(GO|FO|LO|PO)\s+\S/i;
const OUT_PREFIX_CANON = { GO: '', FO: 'F', LO: 'L', PO: 'P' };

function isOutPlay(play) {
  return ['K','ꓘ','GO','SAC','DP','FC','SF','SH','IF','TP'].includes(play) ||
    /^F\d/.test(play) || /^P\d/.test(play) || /^\d+-\d/.test(play) || /^L\d/.test(play) ||
    /^\d+U?$/i.test(play) || /^U\d+$/i.test(play) ||
    /^DP /.test(play) || /^FC /.test(play) || /^TP /.test(play) ||
    PREFIXED_OUT_RE.test(play);
}

// "GO 6-3" → "6-3", "FO 8" → "F8", "LO 7" → "L7", "PO 3" → "P3". Anything else
// (including "DP 6-4-3" and the quick-button codes) passes through untouched.
function normalizePlayCode(code) {
  const raw = String(code == null ? '' : code).trim();
  const m = /^(GO|FO|LO|PO)\s+(.+)$/i.exec(raw);
  if (!m) return raw;
  return OUT_PREFIX_CANON[m[1].toUpperCase()] + m[2].trim();
}

function isHitPlay(play) {
  return ['1B','2B','3B','HR'].includes(play);
}

function isErrorPlay(play) {
  return play === 'E' || /^E\d/.test(play);
}

function hasRunnersOnBase(team, innIdx) {
  const inn = getInnState(team, innIdx);
  return inn.bases[0] !== null || inn.bases[1] !== null || inn.bases[2] !== null;
}

/* ------------------------------------------------------------------------
   Entry guards (audit findings #1, #4, #7, #27)
   ------------------------------------------------------------------------ */

// The cell a popup is deciding for. Popups resolve their target when they OPEN,
// not when the scorer presses a button — tapping another cell in between used to
// apply the play to the wrong batter (#1).
function currentTarget() {
  if (!selectedCell) return null;
  return {
    team: selectedCell.dataset.team,
    pIdx: parseInt(selectedCell.dataset.p),
    innIdx: parseInt(selectedCell.dataset.inn)
  };
}

// #4: two runners can't share a base. True when `runner` (a `{p, col}` ref) may
// occupy `base` — either it's empty or he's already standing on it. Base 3 is
// home; any number score.
function baseFreeFor(inn, base, runner) {
  return base > 2 || inn.bases[base] === null || sameRunner(inn.bases[base], runner);
}

/* ------------------------------------------------------------------------
   Runner placement chokepoint (audit finding #4, Phase 4)

   Every write to `inn.bases` goes through these three functions. The slot used
   to be assigned directly at fifteen sites, each with its own idea of whether
   to check the base first, so the last writer won and the runner who was
   standing there vanished off the bases — still marked up on his at-bat, but
   unable to ever score.

   They all take and store a `{p, col}` runner ref, never a bare player index.
   ------------------------------------------------------------------------ */

const BASE_NAMES = ['1st', '2nd', '3rd', 'Home'];

function reportRunnerCollision(base, held, runner) {
  if (typeof console !== 'undefined' && console.warn) {
    console.warn('runner placement refused: ' + (runner && runner.p) + ' → ' + BASE_NAMES[base] +
                 ', runner ' + (held && held.p) + ' is already there');
  }
  showPlayReject('Two runners can\'t share ' + BASE_NAMES[base] + '.');
}

function clearRunner(inn, base) {
  if (base < 0 || base > 2) return;
  inn.bases[base] = null;
}

// Takes a player off every base he is listed on, whichever plate appearance he
// got there from. The five places that cleared a play used to inline this loop.
function removeRunnerFromBases(inn, pIdx) {
  for (let b = 0; b < 3; b++) if (inn.bases[b] && inn.bases[b].p === pIdx) clearRunner(inn, b);
}

// Puts `runner` on `base`. Base 3 is home — nothing to store, and any number of
// runners can cross the plate, so that's a no-op success. Refuses to evict a
// different runner, and says so: a silent refusal is how a scorecard ends up
// quietly disagreeing with the game.
function setRunnerOn(inn, base, runner) {
  if (base > 2) return true;
  if (base < 0 || runner == null) return false;
  const held = inn.bases[base];
  if (held !== null && !sameRunner(held, runner)) {
    reportRunnerCollision(base, held, runner);
    return false;
  }
  inn.bases[base] = runner;
  return true;
}

// Atomic move: the runner keeps the base he is on unless the destination is
// really available. Callers mark up the at-bat only when this returns true, so a
// refused move leaves no half-written advancement behind.
function moveRunnerTo(inn, fromBase, dest, runner) {
  if (dest > 2) { clearRunner(inn, fromBase); return true; }
  if (!baseFreeFor(inn, dest, runner)) {
    reportRunnerCollision(dest, inn.bases[dest], runner);
    return false;
  }
  clearRunner(inn, fromBase);
  inn.bases[dest] = runner;
  return true;
}

// A runner can't run through the man in front of him. True when every base between
// `fromBase` and `dest` (and `dest` itself, when it isn't home) is clear for him.
// Used by the steal and pickoff-error paths, where one runner moves on his own and
// there is no popup to validate the set as a whole.
function runnerPathClear(inn, fromBase, dest, runner) {
  for (let b = fromBase + 1; b <= Math.min(dest, 2); b++) {
    if (!baseFreeFor(inn, b, runner)) return false;
  }
  return true;
}

// The runners' order has to survive the play: two men can't finish on one base,
// and a trailing runner can't finish ahead of a lead runner who is still on one —
// he would have to pass him. `parties` is [{ key, from, dest }]; `from` is the
// base each started on (-1 for the batter) and `dest` is 0-3, or undefined for
// anyone thrown out or not yet decided. Returns the set of keys in conflict.
function runnerOrderConflicts(parties) {
  const on = parties.filter(p => p.dest !== undefined && p.dest !== null && p.dest >= 0 && p.dest <= 3);
  const bad = new Set();
  for (let i = 0; i < on.length; i++) {
    for (let j = i + 1; j < on.length; j++) {
      const a = on[i], b = on[j];
      if (a.from === b.from) continue;
      // Both scoring is fine — home isn't a base anyone has to stand on.
      if (a.dest === 3 && b.dest === 3) continue;
      const keepsOrder = a.from < b.from ? a.dest < b.dest : a.dest > b.dest;
      if (!keepsOrder) { bad.add(a.key); bad.add(b.key); }
    }
  }
  return bad;
}

// Grey out an offered destination the current set of choices has made illegal, so
// the scorer sees the constraint instead of running into a refusal on Confirm.
// Reversible: the option comes back as soon as the conflicting choice changes.
function setOptionBlocked(btn, blocked) {
  btn.dataset.blocked = blocked ? '1' : '';
  btn.disabled = !!blocked;
  btn.style.opacity = blocked ? '0.35' : '1';
  btn.style.cursor = blocked ? 'not-allowed' : 'pointer';
  if (blocked) {
    btn.style.borderColor = '#ccc';
    btn.style.background = '#f0f0f0';
    btn.style.color = '#999';
  }
}

function isOptionBlocked(btn) {
  return btn.dataset.blocked === '1';
}

// Message for a refused set of destinations — sharing a base and passing a
// runner are different mistakes and the scorer fixes them differently.
function runnerOrderMessage(parties) {
  const on = parties.filter(p => p.dest !== undefined && p.dest !== null && p.dest >= 0 && p.dest <= 2);
  const dests = on.map(p => p.dest);
  const shared = dests.some((d, i) => dests.indexOf(d) !== i);
  return shared
    ? 'Two runners can\'t share a base — pick another destination.'
    : 'A runner can\'t pass the runner ahead of him.';
}

let playRejectTimer = null;

// Brief, non-blocking notice about an entry. `tone` is 'reject' for an entry that
// was refused — a rejected play has to say so, since silently dropping it is how a
// scorer ends up trusting a wrong card — or 'notice' for one that was *accepted*
// with a caveat, which must not be dressed in the refusal's red (M1).
function showPlayToast(msg, tone) {
  if (typeof document === 'undefined') return;
  let el = document.getElementById('play-reject');
  if (!el) {
    el = document.createElement('div');
    el.id = 'play-reject';
    el.style.cssText = 'position:fixed;left:50%;bottom:80px;transform:translateX(-50%);color:#fff;padding:10px 18px;border-radius:6px;z-index:400;font-family:var(--heading);font-size:13px;font-weight:700;letter-spacing:0.5px;text-align:center;max-width:80vw;box-shadow:0 4px 20px rgba(0,0,0,0.35);';
    document.body.appendChild(el);
  }
  el.dataset.tone = tone === 'notice' ? 'notice' : 'reject';
  el.style.background = tone === 'notice' ? 'var(--navy,#1a2744)' : 'var(--accent,#c62828)';
  el.textContent = msg;
  el.style.display = 'block';
  if (playRejectTimer) clearTimeout(playRejectTimer);
  playRejectTimer = setTimeout(() => { playRejectTimer = null; el.style.display = 'none'; }, 2200);
}

function showPlayReject(msg) { showPlayToast(msg, 'reject'); }
function showPlayNotice(msg) { showPlayToast(msg, 'notice'); }

// Every entry path ends at the same wall once the half-inning is over, so they say
// the same thing about it (L2). One constant, because six copies of a sentence drift.
const INNING_OVER = 'The inning already has 3 outs — clear a play first.';

/* Rule 5.08(a): no run scores on a play whose third out is made by the
   batter-runner before he reaches first. The fly caught, the groundout at
   first, the batter doubled off at the front end of a double play — his out
   ends the half-inning, and it ends it before any runner can be credited with
   crossing the plate.

   The card applies a play's advancements before it records the batter's out
   (`applyPlayEffects`), so audit 3's `inn.outs >= 3` guard sees two outs and
   waves the run through: a sacrifice fly with two out scored a run, an RBI,
   and — because `sacrificeExemptsAB` read the run as a successful sacrifice —
   took the at-bat off as well. Three wrong figures from one tap.

   So the plate is closed up front, in the two popups that offer it, the way the
   occupancy check refuses a base somebody is standing on. The state-level
   backstops below it are for choices that did not come through a popup.

   Only the batter-runner half of the rule. The force-out half needs to know
   whether an out on the bases was a force, which the card has never recorded
   (the standing force-vs-tag gap) — which is also why a run scored while a
   trailing runner is tagged out still counts, as it should. */
const NO_RUN_508A = 'Two out — the batter is retired before first, so his out ends the inning before the run (5.08(a)).';

// The state-level half of that refusal, for the `showRunnerPopup` path. A set of
// choices still carrying a run when the batter's own out will end the inning came
// from an import, a hand edit or a headless caller; the runner keeps his base,
// the way the #4 occupancy backstop leaves a colliding runner where he is.
function barRunsAfterBatterOut(team, innIdx, choices) {
  if (getInnState(team, innIdx).outs < 2) return;
  let barred = 0;
  [2, 1, 0].forEach(b => { if (choices[b] === 3) { delete choices[b]; barred++; } });
  if (barred) showPlayReject(NO_RUN_508A);
}

// The other wall, and a different answer: this one cannot be cleared by hand. The
// card is fifteen columns wide and an inning that bats around takes more than one
// of them, so a side can run out of card — at the end of the 15th, or earlier if
// enough innings batted around. `overflowToNextColumn` has said this since L4; the
// half-inning transition used to meet the same wall and blame the 3 outs (M1).
const CARD_FULL = 'The card is full — no column left for this inning.';

// Popups that own the current entry get a backdrop, so a tap meant for the popup
// can't land on the grid and move the selection underneath it (#1, #29).
const BACKDROP_GUARDED = ['k-popup', 'pos-popup', 'runner-popup', 'outcome-popup'];

function showPopupBackdrop() {
  if (typeof document === 'undefined') return;
  let bd = document.getElementById('popup-backdrop');
  if (!bd) {
    bd = document.createElement('div');
    bd.id = 'popup-backdrop';
    bd.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:180;background:rgba(26,39,68,0.15);';
    bd.onclick = function(e) {
      if (e && e.stopPropagation) e.stopPropagation();
      // Swallow the tap. If whatever it was guarding is already gone, get out of
      // the way rather than leaving the app unclickable.
      const stillOpen = BACKDROP_GUARDED.some(id => {
        const p = document.getElementById(id);
        return p && p.style.display && p.style.display !== 'none';
      });
      if (!stillOpen) hidePopupBackdrop();
      // A swallowed tap with no explanation reads as a dead app. The two entry
      // popups can only be answered, not dismissed, so say so (C1).
      else if (entryInProgress()) showPlayReject('Finish the open entry first.');
    };
    document.body.appendChild(bd);
  }
  bd.style.display = 'block';
}

function hidePopupBackdrop() {
  if (typeof document === 'undefined') return;
  const bd = document.getElementById('popup-backdrop');
  if (bd) bd.style.display = 'none';
}

// Popups whose Confirm writes to an at-bat and an inning captured when they
// opened. Undo restores an older snapshot, and the confirm then applies its
// advancements on top of that — the runners land in a state that never
// happened (#29). So undo and redo refuse to run until the entry is resolved:
// answer the popup, or close it, first.
//
// `spray-popup` is deliberately not on the list. It opens by itself after every
// hit, so blocking undo behind it would block undo on the commonest path there
// is — and all it writes is `hitLoc`. Undo dismisses it instead: the play it was
// asking about is the one being taken back.
const PENDING_ENTRY_POPUPS = [
  'runner-popup', 'outcome-popup', 'base-picker', 'pos-popup', 'k-popup',
  'edit-play-popup', 'move-runner-popup', 'er-review-popup', 'recompute-popup',
  // Both defer their write until a choice is made, and both write a whole
  // player row — so an undo taken in the meantime would be applied on top of.
  'sub-popup', 'dh-popup'
];

function pendingEntryPopupOpen() {
  if (typeof document === 'undefined') return false;
  return PENDING_ENTRY_POPUPS.some(id => {
    const p = document.getElementById(id);
    return p && p.style.display && p.style.display !== 'none';
  });
}

// The two popups that open from *inside* `applyPlay`, after `ab.play` and the
// result pitch are already committed but before the play's effects are known.
// A tap that lands while one is pending does two kinds of damage (C1):
// the play underneath is orphaned — on the card, counted in H, but nobody on
// base and no out — and the popup's Confirm still closes over the inning as it
// was when it opened, so answering it later writes runners into a state that
// never happened. The backdrop stops the tap; this guard stops anything that
// reaches the entry path some other way (a play button, a hotkey).
const ENTRY_IN_PROGRESS_POPUPS = ['runner-popup', 'outcome-popup'];

function entryInProgress() {
  if (typeof document === 'undefined') return false;
  return ENTRY_IN_PROGRESS_POPUPS.some(id => {
    const p = document.getElementById(id);
    return p && p.style.display && p.style.display !== 'none';
  });
}

function dismissSprayPopup() {
  if (typeof document === 'undefined') return;
  const p = document.getElementById('spray-popup');
  if (p) p.style.display = 'none';
}

/* ------------------------------------------------ undo: the whole inning ---
   A snapshot used to hold one column: `atBats[innIdx]` for every player, plus
   that column's inning record. A batted-around inning lives in two or more
   columns and a play in the later one moves runners standing on bases they
   reached in the earlier one, so undo restored half of what the play had changed
   (#19). These capture and restore every column of the play's *real* inning.

   Snapshots are memory-only (they are never persisted), so the shape is free to
   change. What they still can't undo is the column insertion itself: a play that
   bats the order around adds a column and shifts `columnMap`, and that happens
   after the snapshot was taken. `cols` is therefore the inning as it stood when
   the play was entered. */
function captureInning(team, innIdx) {
  const players = gameState.teams[team].players;
  const cols = getColumnsForInning(team, getRealInning(team, innIdx));
  const abs = {};
  const inns = {};
  for (const col of cols) {
    for (let p = 0; p < players.length; p++) {
      abs[p + ':' + col] = JSON.parse(JSON.stringify(players[p].atBats[col]));
    }
    inns[col] = JSON.parse(JSON.stringify(getInnState(team, col)));
  }
  return { cols, abs, inns };
}

// Overwrite `target` with a snapshot copy: fields the snapshot doesn't have are
// dropped, not left over from the newer state.
function assignOver(target, src) {
  const copy = JSON.parse(JSON.stringify(src));
  Object.keys(target).forEach(k => { if (!(k in copy)) delete target[k]; });
  Object.assign(target, copy);
}

function restoreInning(team, prev) {
  if (!prev || !prev.cols) return;
  const players = gameState.teams[team].players;
  for (const col of prev.cols) {
    for (let p = 0; p < players.length; p++) {
      const src = prev.abs[p + ':' + col];
      if (src) assignOver(players[p].atBats[col], src);
    }
    if (prev.inns[col]) assignOver(getInnState(team, col), prev.inns[col]);
  }
}

function renderInning(team, prev) {
  if (!prev || !prev.cols) return;
  const players = gameState.teams[team].players;
  for (const col of prev.cols) {
    for (let p = 0; p < players.length; p++) {
      renderDiamond(team, p, col);
      renderOut(team, p, col);
      renderPlayText(team, p, col);
      renderPitches(team, p, col);
      renderPitcherChange(team, p, col);
    }
  }
}

// How many runners this play drove in: who is credited with a run now who wasn't
// before it. Counted across every column of the inning, so a runner who reached
// on an earlier trip through the order still earns the RBI.
function countRunnersScored(team, prev) {
  const players = gameState.teams[team].players;
  const didScore = runScored;
  let scored = 0;
  for (const col of prev.cols) {
    for (let p = 0; p < players.length; p++) {
      if (didScore(players[p].atBats[col]) && !didScore(prev.abs[p + ':' + col])) scored++;
    }
  }
  return scored;
}

// Can `play` legally be entered into this half-inning as it stands? Returns the
// reason it can't, or null. Both cases would otherwise be recorded short: the
// outs that run past three are refused by `recordOut`, so the inning ends up
// under-reported rather than wrong-in-an-obvious-way (#7, #27).
//
// Called before the at-bat is touched on a new entry, and after the old play has
// been taken back on an edit — an edited cell's own outs are not in its way.
function playEntryReject(team, innIdx, play) {
  const inn = getInnState(team, innIdx);
  if (play === 'DP' || /^DP /.test(play)) {
    // With 2 outs the inning ends on the first out, so a double play isn't legal.
    if (inn.outs >= 2) return 'Only one out left — record the single out, not a DP.';
  }
  if (play === 'TP' || /^TP /.test(play)) {
    const onBase = inn.bases.filter(b => b !== null).length;
    if (onBase < 2) return 'A triple play needs two runners on base.';
    if (inn.outs >= 1) return 'Not enough outs left for a triple play.';
  }
  return null;
}

// `target` is the cell this play belongs to. Popups pass the cell they captured
// when they opened; everything else falls back to the current selection (#1).
function applyPlay(play, target) {
  if (entryInProgress()) { showPlayReject('Finish the open entry first.'); return; }
  const t = target || currentTarget();
  if (!t) return;
  const team = t.team;
  const pIdx = t.pIdx;
  const innIdx = t.innIdx;
  const ab = gameState.teams[team].players[pIdx].atBats[innIdx];
  const inn = getInnState(team, innIdx);
  // L2: both of these used to return bare. A refused play that says nothing is how a
  // scorer ends up believing a card that doesn't hold what they entered — the reason
  // every *other* refusal in this function speaks.
  if (inn.outs >= 3) { showPlayReject(INNING_OVER); return; }
  // Not an entry point: this cell is filled, and what the scorer wants is Change Play
  // Type. It is also the dead end a full card leaves the selection on (L4).
  if (ab.play) { showPlayReject('That cell already has a play — change or clear it first.'); return; }

  // Reject before the at-bat is touched — no play, no result pitch.
  const reject = playEntryReject(team, innIdx, play);
  if (reject) { showPlayReject(reject); return; }

  noteEntryAfterFinal();

  // Save undo snapshot
  const prevTab = document.querySelector('.tab-btn.active')?.dataset.tab;
  const prev = captureInning(team, innIdx);
  const snapshot = { team, pIdx, innIdx, prev, prevTab };

  ab.play = play;
  // Every at-bat ends on a pitch — add the final pitch that produced the result
  if (!ab.pitches) ab.pitches = [];
  // A play the scorer taps rather than pitches into has to leave a count the play
  // could actually have happened on (M7). A strikeout is three strikes and a walk is
  // four balls, so pad to them; an auto-triggered K or auto-walk is already there, so
  // this only ever fires for a button press.
  if (play === 'K' || play === 'ꓘ' || play === 'K+WP') {
    // The old code pushed a single 'X' here, which `getPitchCount` reads as neither a
    // ball nor a strike and `renderPitches` draws as nothing: the cell claimed one
    // pitch over an empty pitch track and a 0-0 count on a strikeout.
    while (getPitchCount(ab.pitches).strikes < 3) ab.pitches.push('S');
  } else if (play === 'BB') {
    // A walk tapped on a 3-ball count stayed at three pitches. Not IBB: since 2017 an
    // intentional walk is awarded without a pitch thrown, so padding it to four balls
    // would invent them.
    while (getPitchCount(ab.pitches).balls < 4) ab.pitches.push('B');
  } else if (play !== 'IBB' && play !== 'HBP') {
    // The result pitch: ball was put in play (hit/out).
    const count = getPitchCount(ab.pitches);
    if (count.strikes < 3 && count.balls < 4) {
      if (isHitPlay(play) || isErrorPlay(play) || play === 'HR') ab.pitches.push('H');
      else ab.pitches.push('X');
    }
  } else if (ab.pitches.length === 0) {
    ab.pitches.push('B'); // an IBB/HBP always involves at least 1 pitch
  }
  // Track which pitcher the batter faced
  ab.pitcher = getEffectivePitcher(team, innIdx);
  if (ab.rbi === undefined) ab.rbi = 0;

  applyPlayEffects(team, pIdx, innIdx, play, prev, function() {
    finishPlay(team, pIdx, innIdx, snapshot);
  });
}

/* -------------------------------------------- what a play does to the card ---
   Where the batter ends up, which outs it makes, where it sends the runners —
   for a play whose code is already written on the cell. `prev` is the inning as
   it stood before the play, for the RBI count; `done` runs once everything has
   resolved, including any popup, so the caller decides what "finished" means.

   Split out of `applyPlay` because `editPlayType` has to do exactly this and used
   to do a fraction of it: it adjusted the batter's own bases and outs and never
   asked where the runners went (#22). Rewriting a single as a double left them
   standing where the single had put them. */
function applyPlayEffects(team, pIdx, innIdx, play, prev, done) {
  const ab = gameState.teams[team].players[pIdx].atBats[innIdx];
  const inn = getInnState(team, innIdx);
  const src = { pIdx, col: innIdx };

  // Plays that have their own outcome popup (DP/FC/TP) — handled below
  const hasOwnPopup = play === 'DP' || /^DP /.test(play) || play === 'FC' || /^FC /.test(play) || play === 'TP' || /^TP /.test(play);
  // HR always scores everyone automatically — no popup needed
  const isHR = play === 'HR';
  // Plain K/ꓘ are strikeouts — ball not in play, no runner advancement
  const isPlainK = play === 'K' || play === 'ꓘ';
  // Show runner advancement popup for ALL plays when runners are on base
  if (!hasOwnPopup && !isHR && !isPlainK && hasRunnersOnBase(team, innIdx)) {
    const isHitOrError = ['1B','2B','3B'].includes(play) || isErrorPlay(play);
    const isWalk = play === 'BB' || play === 'HBP' || play === 'IBB' || play === 'CI';
    const isKWP = play === 'K+WP';
    const isSac = play === 'SF' || play === 'SH' || play === 'SAC';

    // Walks: auto-advance forced runners, no popup
    if (isWalk) {
      advanceForcedRunners(team, innIdx, play, src);
      ab.bases[0] = true; setRunnerOn(inn, 0, runnerRef(pIdx, innIdx));
      ab.rbi = countRunnersScored(team, prev);
      done();
      return;
    }

    // K+WP: batter reaches 1st, show runner popup for wild pitch advancement.
    // He is placed after the popup resolves, like every other batter who reaches:
    // placing him first overwrote a runner standing on 1st, and that runner was
    // then gone from the popup's own list of runners to advance (#4).
    if (isKWP) {
      const batterLbl = getBatterLabel(team, pIdx, innIdx);
      showRunnerPopup(team, innIdx, 1, function(choices) {
        applyChosenAdvancements(team, innIdx, choices, batterLbl, src);
        const bDest = choices.batterDest !== undefined ? choices.batterDest : 0;
        for (let s = 0; s <= bDest; s++) ab.bases[s] = true;
        setRunnerOn(inn, bDest, runnerRef(pIdx, innIdx));
        // Rule 9.04(b): a run that scores on a wild pitch is nobody's RBI — and on
        // a K+WP the batter struck out, so every run on the play came in on the
        // pitch, not off the bat (#12).
        ab.rbi = 0;
        done();
      }, { batterTakesBase: true, batterPIdx: pIdx });
      return;
    }

    // Default advancement: hits advance by hit type, sac advance 1, outs = 0 (hold)
    const defaultAdv = play === '3B' ? 3 : play === '2B' ? 2 : (isHitOrError || isSac) ? 1 : 0;
    const batterLbl = getBatterLabel(team, pIdx, innIdx);
    // Does this play put the batter out? The popup needs it for the 5.08(a) bar,
    // and the callback below has always needed it to know who to record.
    const batterRetired = isSac || play === 'IF' || isOutPlay(play);
    showRunnerPopup(team, innIdx, defaultAdv, function(choices) {
      if (batterRetired) barRunsAfterBatterOut(team, innIdx, choices);
      applyChosenAdvancements(team, innIdx, choices, batterLbl, src);
      // Place batter based on play type
      if (isHitOrError) {
        if (choices.batterDest !== undefined && choices.batterDest > 0) {
          for (let s = 0; s <= choices.batterDest; s++) ab.bases[s] = true;
          setRunnerOn(inn, choices.batterDest, runnerRef(pIdx, innIdx));
          // `placeBatter` is the only other setter, and this branch skips it — so a
          // batter who took an extra base on the error used to count as having
          // reached cleanly, and his run as earned (#11).
          if (isErrorPlay(play)) ab.reachedOnError = true;
        } else {
          placeBatter(ab, inn, play, pIdx, innIdx);
        }
      } else if (batterRetired) {
        recordBatterOut(team, innIdx, pIdx, ab);
      }
      // RBI
      if (!isErrorPlay(play)) {
        ab.rbi = countRunnersScored(team, prev);
      }
      done();
    }, { batterTakesBase: isHitOrError, batterPIdx: pIdx, batterRetired });
    return;
  }

  // No runners or plays with own popup — handle directly
  const isHitOrError = ['1B','2B','3B'].includes(play) || isErrorPlay(play);
  if (isHitOrError) {
    placeBatter(ab, inn, play, pIdx, innIdx);
  } else if (isHR) {
    const runnersOn = inn.bases.filter(b => b !== null).length;
    const lbl = getBatterLabel(team, pIdx, innIdx);
    advanceRunners(team, innIdx, 4, lbl, src);
    ab.bases = [true, true, true, true];
    ab.rbi = runnersOn + 1;
  } else if (play === 'BB' || play === 'HBP' || play === 'IBB' || play === 'CI') {
    ab.bases[0] = true; setRunnerOn(inn, 0, runnerRef(pIdx, innIdx));
  } else if (play === 'SF' || play === 'SH' || play === 'SAC') {
    recordBatterOut(team, innIdx, pIdx, ab);
  } else if (play === 'TP' || /^TP /.test(play)) {
    // Runner count already checked by playEntryReject, before any pitch was
    // pushed (#27).
    showRunnerOutcomePopup(team, innIdx, play, true, function(outcomes) {
      applyRunnerOutcomes(team, pIdx, innIdx, ab, inn, play, outcomes);
      ab.rbi = countRunnersScored(team, prev);
      done();
    });
    return;
  } else if (play === 'DP' || /^DP /.test(play) || play === 'FC' || /^FC /.test(play)) {
    const isDP = play === 'DP' || /^DP /.test(play);
    if (hasRunnersOnBase(team, innIdx)) {
      showRunnerOutcomePopup(team, innIdx, play, isDP, function(outcomes) {
        applyRunnerOutcomes(team, pIdx, innIdx, ab, inn, play, outcomes);
        // Rule 9.04(b)(1): no RBI when the batter grounds into a double play, even
        // if a run crosses the plate. A fielder's choice is not covered by the rule
        // — the run there is his (#12).
        ab.rbi = isDP ? 0 : countRunnersScored(team, prev);
        done();
      });
      return;
    }
    if (isDP) {
      // A double play with nobody on base is not a real play, but the entry is
      // reachable, so record it honestly: the batter plus one out that has no
      // runner to hang it on.
      const n1 = recordBatterOut(team, innIdx, pIdx, ab);
      const n2 = recordOut(team, innIdx, { kind: 'runner', pIdx: null, col: innIdx, srcP: pIdx, srcCol: innIdx });
      ab.outsRecorded = (n1 ? 1 : 0) + (n2 ? 1 : 0);
      if (n1 && n2) ab.dpOuts = [n1, n2];
    } else {
      recordBatterOut(team, innIdx, pIdx, ab);
    }
  } else if (play === 'K+WP') {
    ab.bases[0] = true; setRunnerOn(inn, 0, runnerRef(pIdx, innIdx)); ab.outsRecorded = 0;
  } else if (play === 'IF' || isOutPlay(play)) {
    // Infield fly is an automatic out
    recordBatterOut(team, innIdx, pIdx, ab);
  }
  done();
}

function placeBatter(ab, inn, play, pIdx, col) {
  // `setRunnerOn` is the #4 backstop: the runner popup refuses a colliding
  // destination up front, so a refusal here means the state came from an import or
  // a hand edit. Mark the batter's at-bat either way, but don't erase the runner
  // already standing on that base.
  const runner = runnerRef(pIdx, col);
  if (play === '1B' || play === 'E' || isErrorPlay(play)) { ab.bases[0] = true; setRunnerOn(inn, 0, runner); if (isErrorPlay(play)) ab.reachedOnError = true; }
  else if (play === '2B') { ab.bases[0] = true; ab.bases[1] = true; setRunnerOn(inn, 1, runner); }
  else if (play === '3B') { ab.bases[0] = true; ab.bases[1] = true; ab.bases[2] = true; setRunnerOn(inn, 2, runner); }
}

// `src` is the plate appearance these advancements came out of, so a runner
// thrown out on the play is logged against it and comes off again with it.
function applyChosenAdvancements(team, innIdx, choices, reason, src) {
  const inn = getInnState(team, innIdx);
  // H1: nothing moves once the half-inning is over. The stranded runners are still
  // standing in `inn.bases` — that is where LOB comes from — so the advance branch
  // below would walk one of them home onto the linescore, the batter's R and the
  // pitcher's R and ER, and drop him out of LOB. Every sibling refuses the same way
  // (`applySBAtBase`, `applyCSAtBase`, `applyPickoff`, `applyRunnerEvent`).
  //
  // Here rather than inside the branch, because a set of choices *made* while the
  // inning was live can legitimately record the third out on a lead runner and still
  // have a trailing runner's advance to write after it. The bases are walked
  // lead-runner-first (2, 1, 0) precisely so that order holds, and this way that
  // play still enters exactly as it did.
  if (inn.outs >= 3) { showPlayReject(INNING_OVER); return; }
  const rsn = reason || '';
  [2, 1, 0].forEach(fromBase => {
    if (inn.bases[fromBase] === null) return;
    const dest = choices[fromBase];
    if (dest === undefined) return;
    if (dest === fromBase) return;
    const rn = inn.bases[fromBase];
    const rab = runnerAtBat(team, rn);
    if (!rab) return;
    if (dest < 0) {
      const outAt = Math.abs(dest);
      // The out first: with the inning already at three there is none to be had,
      // and a runner taken off the bases with nothing recorded against him is
      // simply gone — no out, not left on base, unaccounted for anywhere (M5).
      // `applyRunnerOutcomes` has always bailed here; this cleared him regardless,
      // which the applyPlay path then papered over with a recompute and
      // `editRunners`, having no recompute of its own, did not.
      const n = recordOut(team, innIdx, {
        kind: 'runner', pIdx: rn.p, col: rn.col,
        srcP: src ? src.pIdx : rn.p, srcCol: src ? src.col : rn.col
      });
      if (!n) { showPlayReject(INNING_OVER); return; }
      for (let step = fromBase + 1; step < outAt; step++) markAdvance(rab, step, rsn, src);
      setAdvReason(rab, outAt, rsn);
      rab.out = n;
      rab.outOnBase = outAt;
      clearRunner(inn, fromBase);
      renderDiamond(team, rn.p, rn.col);
      renderOut(team, rn.p, rn.col);
    } else {
      // #4 backstop: the popup validates the whole set of destinations before we
      // get here, so a refusal means imported or hand-edited state. The runner
      // keeps the base he is on rather than erasing whoever is on `dest`.
      if (!moveRunnerTo(inn, fromBase, dest, rn)) return;
      for (let step = fromBase + 1; step <= dest; step++) markAdvance(rab, step, rsn, src);
      renderDiamond(team, rn.p, rn.col);
    }
  });
}

/* Spray Chart */
const HIT_COLORS = { '1B':'#1565c0', '2B':'#2e7d32', '3B':'#e65100', 'HR':'#c62828', 'E':'#777' };

function showSprayChart(team, pIdx, innIdx) {
  const ab = gameState.teams[team].players[pIdx].atBats[innIdx];
  const play = ab.play;
  if (!isHitPlay(play) && !isErrorPlay(play)) return;

  const popup = document.getElementById('spray-popup');
  const svg = document.getElementById('spray-field');
  const marker = document.getElementById('spray-marker');
  marker.setAttribute('display', 'none');
  const colorKey = isErrorPlay(play) ? 'E' : play;
  marker.setAttribute('fill', HIT_COLORS[colorKey] || 'red');
  popup.style.display = 'block';

  function handleClick(e) {
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const svgPt = pt.matrixTransform(svg.getScreenCTM().inverse());
    marker.setAttribute('cx', svgPt.x);
    marker.setAttribute('cy', svgPt.y);
    marker.setAttribute('display', 'block');
    ab.hitLoc = { x: Math.round(svgPt.x * 10) / 10, y: Math.round(svgPt.y * 10) / 10 };
    svg.removeEventListener('click', handleClick);
    setTimeout(() => { popup.style.display = 'none'; updateSprayMini(); autoSave(); }, 400);
  }
  svg.addEventListener('click', handleClick);

  document.getElementById('spray-skip').onclick = function() {
    svg.removeEventListener('click', handleClick);
    popup.style.display = 'none';
  };
}

function updateSprayMini() {
  document.querySelectorAll('.spray-mini-svg').forEach(svg => {
    svg.querySelectorAll('.spray-dot,.spray-label').forEach(d => d.remove());
    const team = svg.dataset.team;
    if (!team) return;
    const players = gameState.teams[team].players;
    let hitNum = 0;
    players.forEach((player, pIdx) => {
      player.atBats.forEach(ab => {
        if (ab.hitLoc && ab.play && (isHitPlay(ab.play) || ab.play === 'HR' || isErrorPlay(ab.play))) {
          hitNum++;
          const x = ab.hitLoc.x, y = ab.hitLoc.y;
          const colorKey = isErrorPlay(ab.play) ? 'E' : ab.play;
          const color = HIT_COLORS[colorKey] || '#999';
          // Dot
          const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.setAttribute('r', '8');
          dot.setAttribute('fill', color); dot.setAttribute('stroke', '#fff'); dot.setAttribute('stroke-width', '1.5');
          dot.setAttribute('opacity', '0.9');
          dot.classList.add('spray-dot');
          svg.appendChild(dot);
          // Label: batter number
          const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          label.setAttribute('x', x); label.setAttribute('y', y + 3);
          label.setAttribute('text-anchor', 'middle');
          label.setAttribute('fill', '#fff'); label.setAttribute('font-size', '7');
          label.setAttribute('font-weight', '700'); label.setAttribute('font-family', 'var(--mono)');
          label.classList.add('spray-label');
          label.textContent = player.num || hitNum;
          svg.appendChild(label);
        }
      });
    });
  });
}

/* Runner outcome popup for DP/FC */
function showRunnerOutcomePopup(team, innIdx, play, isDP, callback) {
  const inn = getInnState(team, innIdx);
  const baseNames = ['1st','2nd','3rd','Home'];
  const runners = [];
  for (let b = 2; b >= 0; b--) {
    if (inn.bases[b] === null) continue;
    const rn = inn.bases[b];
    const name = getActivePlayerName(team, rn.p, rn.col);
    runners.push({ base: b, pIdx: rn.p, name, fromLabel: baseNames[b] });
  }

  let popup = document.getElementById('outcome-popup');
  if (!popup) {
    popup = document.createElement('div');
    popup.id = 'outcome-popup';
    popup.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:var(--card);border:3px solid var(--navy);border-radius:10px;padding:16px 20px;z-index:300;box-shadow:0 8px 40px rgba(26,39,68,0.4);min-width:300px;font-family:var(--font);';
    document.body.appendChild(popup);
  }

  // A play labelled DP has to record 2 outs and a TP 3 — refused on Confirm below.
  // Open on the forced runners nearest the batter already marked out, so the popup
  // starts on what the label asserts instead of on a green "Safe" that contradicts
  // it (#C2). A runner is forced only while every base behind him is occupied.
  const requiredOuts = /^TP/.test(play) ? 3 : /^DP/.test(play) ? 2 : 0;
  // And the out count the label *allows*. A fielder's choice retires one man — that
  // the fielder chose which one is the whole play — so two outs on it is a double
  // play wearing an FC's label, and the popup used to accept three (M4). Capping FC
  // at 1 puts all three plays under one rule: FC 1, DP 2, TP 3.
  //
  // The cap bounds FC without requiring it, and that asymmetry is deliberate (m7):
  // a fielder's choice that retires nobody is a real play and a real entry. The
  // fielder elects to throw somewhere other than first, the runner beats it, and the
  // batter is on with a time at bat and no hit. Requiring an out here would make
  // that unenterable, so `requiredOuts` stays 0 for FC and only DP and TP are held
  // to their labels on Confirm below.
  const maxOuts = /^TP/.test(play) ? 3 : /^DP/.test(play) ? 2 : /^FC/.test(play) ? 1 : 3;
  const playLabel = /^TP/.test(play) ? 'triple play'
    : /^DP/.test(play) ? 'double play'
    : /^FC/.test(play) ? "fielder's choice" : play;
  const forcedBases = [];
  for (let b = 0; b < 3; b++) {
    if (inn.bases[b] === null) break;
    forcedBases.push(b);
  }
  // How many outs the label leads with. DP and TP require theirs; a fielder's
  // choice requires nothing but does retire one man — that is the play — so it
  // opens on one as well rather than on a set of choices recording none.
  const openingOuts = requiredOuts || (/^FC/.test(play) ? 1 : 0);
  // On a DP or a TP the batter is one of them, so the rest come off the force
  // chain; on a fielder's choice he is safe by default and the whole out does.
  // If the chain is short (nobody on 1st) no runner gets a default out and the
  // scorer has to name the tag out himself — Confirm won't take a DP or a TP
  // otherwise.
  const defaultOutBases = forcedBases.slice(0, Math.max(0, openingOuts - (isDP ? 1 : 0)));

  const outcomes = {};
  runners.forEach(r => {
    const isOut = defaultOutBases.includes(r.base);
    outcomes[r.base] = {
      action: isOut ? 'out' : 'safe',
      // A runner nobody has spoken for holds his base. This used to open on the
      // base in front of him, so accepting the defaults on a ground-ball double
      // play scored the man on 3rd — a run the play never produced, in the one
      // popup that doesn't make you answer for every runner (C2).
      // `showRunnerPopup` refuses to confirm until each one is chosen; this one
      // keeps the out defaults its label asserts and stands still on the rest.
      dest: isOut ? Math.min(r.base + 1, 3) : r.base
    };
  });
  outcomes.batter = { action: isDP ? 'out' : 'safe', dest: 0 };

  // Which button a row opens on — asked of `outcomes` rather than re-derived per
  // row, so the highlight can't drift from the choice Confirm will actually use.
  // It did: the Hold button was never painted as the default even when holding
  // was what the row meant, and the cap's auto-revert below painted Hold while
  // storing an advance.
  const opensOn = (base, action, dest) => {
    const oc = outcomes[base];
    return !!oc && oc.action === action && oc.dest === dest;
  };

  let html = '<div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--navy);margin-bottom:12px;font-family:var(--heading)">' + play + ' — Runner Outcomes</div>';

  runners.forEach(r => {
    html += `<div class="oc-row" data-base="${r.base}" style="margin-bottom:8px;padding:6px;background:var(--cream);border-radius:4px">`;
    html += `<div style="font-size:11px;font-weight:600;margin-bottom:4px">${escapeHtml(r.name)} <span style="color:var(--text-light)">(on ${r.fromLabel})</span></div>`;
    html += `<div style="display:flex;gap:4px;flex-wrap:wrap">`;
    // Hold option — keep the runner on their current base (e.g. runner on 3rd during a DP)
    {
      const isDefault = opensOn(r.base, 'safe', r.base);
      html += `<button class="oc-btn" data-base="${r.base}" data-action="safe" data-dest="${r.base}" style="padding:3px 8px;font-size:10px;font-weight:600;border:1.5px solid ${isDefault ? '#2e7d32' : '#ccc'};border-radius:3px;background:${isDefault ? '#e8f5e9' : '#fff'};color:${isDefault ? '#2e7d32' : '#555'};cursor:pointer;font-family:var(--mono)">Hold ${r.fromLabel}</button>`;
    }
    // Safe options
    for (let d = r.base + 1; d <= 3; d++) {
      const isDefault = opensOn(r.base, 'safe', d);
      html += `<button class="oc-btn" data-base="${r.base}" data-action="safe" data-dest="${d}" style="padding:3px 8px;font-size:10px;font-weight:600;border:1.5px solid ${isDefault ? '#2e7d32' : '#ccc'};border-radius:3px;background:${isDefault ? '#e8f5e9' : '#fff'};color:${isDefault ? '#2e7d32' : '#555'};cursor:pointer;font-family:var(--mono)">Safe ${baseNames[d]}</button>`;
    }
    // Out options
    for (let d = r.base + 1; d <= 3; d++) {
      const isDefault = opensOn(r.base, 'out', d);
      html += `<button class="oc-btn" data-base="${r.base}" data-action="out" data-dest="${d}" style="padding:3px 8px;font-size:10px;font-weight:600;border:1.5px solid ${isDefault ? 'var(--accent)' : '#ccc'};border-radius:3px;background:${isDefault ? '#fce4ec' : '#fff'};color:${isDefault ? 'var(--accent)' : '#555'};cursor:pointer;font-family:var(--mono)">Out at ${baseNames[d]}</button>`;
    }
    html += `</div></div>`;
  });

  // Batter outcome
  html += `<div class="oc-row" data-base="batter" style="margin-bottom:8px;padding:6px;background:var(--cream);border-radius:4px">`;
  html += `<div style="font-size:11px;font-weight:600;margin-bottom:4px">Batter</div>`;
  html += `<div style="display:flex;gap:4px;flex-wrap:wrap">`;
  const batterSafe = !isDP;
  const baseLabels = ['1st','2nd','3rd'];
  for (let d = 0; d < 3; d++) {
    const isDefault = d === 0 && batterSafe;
    html += `<button class="oc-btn" data-base="batter" data-action="safe" data-dest="${d}" style="padding:3px 8px;font-size:10px;font-weight:600;border:1.5px solid ${isDefault ? '#2e7d32' : '#ccc'};border-radius:3px;background:${isDefault ? '#e8f5e9' : '#fff'};color:${isDefault ? '#2e7d32' : '#555'};cursor:pointer;font-family:var(--mono)">Safe ${baseLabels[d]}</button>`;
  }
  html += `<button class="oc-btn" data-base="batter" data-action="out" style="padding:3px 8px;font-size:10px;font-weight:600;border:1.5px solid ${!batterSafe ? 'var(--accent)' : '#ccc'};border-radius:3px;background:${!batterSafe ? '#fce4ec' : '#fff'};color:${!batterSafe ? 'var(--accent)' : '#555'};cursor:pointer;font-family:var(--mono)">Out</button>`;
  html += `</div></div>`;

  // Rule 5.08(a) — see NO_RUN_508A. Hidden until the chosen outcomes make the
  // batter's out the third one, which they can stop doing again on the next click.
  html += `<div id="oc-508a" style="display:none;font-size:10px;color:var(--accent);margin:2px 0 6px;line-height:1.4">${escapeHtml(NO_RUN_508A)}</div>`;
  html += `<button id="oc-confirm" style="margin-top:6px;width:100%;padding:7px;font-size:12px;font-weight:700;background:var(--navy);color:var(--gold);border:none;border-radius:4px;cursor:pointer;font-family:var(--heading);letter-spacing:0.5px;text-transform:uppercase">Confirm</button>`;
  popup.innerHTML = html;
  showPopupBackdrop();
  popup.style.display = 'block';

  // Every runner still on a base after the play, plus the batter if he ends up on
  // one, as `runnerOrderConflicts` wants them. A runner who is out drops out of the
  // ordering entirely — the base he was heading for is free for the man behind him.
  function ocParties() {
    const list = runners.map(r => ({
      key: r.base,
      from: r.base,
      dest: outcomes[r.base] && outcomes[r.base].action === 'safe' ? outcomes[r.base].dest : undefined
    }));
    list.push({
      key: 'batter',
      from: -1,
      dest: outcomes.batter && outcomes.batter.action === 'safe'
        ? (outcomes.batter.dest !== undefined ? outcomes.batter.dest : 0)
        : undefined
    });
    return list;
  }

  /* Rule 5.08(a) — see NO_RUN_508A. Here the batter's out is one of the choices,
     so the bar has to be re-derived on every click the way the collision check is:
     his out is the third when the outs already made plus the ones this play marks
     on the runners come to two. On a ground-ball double play that is the ordinary
     case — one out, the man on 1st forced at 2nd, the batter at first — and the
     man on 3rd may not be sent home on it. */
  function runsBarred() {
    if (!outcomes.batter || outcomes.batter.action !== 'out') return false;
    let n = getInnState(team, innIdx).outs;
    for (let b = 0; b < 3; b++) if (outcomes[b] && outcomes[b].action === 'out') n++;
    return n >= 2;
  }

  // Repaint one row's buttons against what `outcomes` now says. The click handler
  // has always done this inline for the row it was in and for a row the out cap
  // set back; the 5.08(a) revert below needs the same thing.
  function repaintOcRow(key) {
    const row = popup.querySelector('.oc-row[data-base="' + key + '"]');
    if (!row) return;
    const oc = key === 'batter' ? outcomes.batter : outcomes[key];
    row.querySelectorAll('.oc-btn').forEach(b => {
      const isOut = b.dataset.action === 'out';
      const dest = b.dataset.dest ? parseInt(b.dataset.dest) : (isOut ? undefined : 0);
      const isActive = !!oc && oc.action === b.dataset.action && (isOut ? true : oc.dest === dest);
      b.style.borderColor = isActive ? (isOut ? 'var(--accent)' : '#2e7d32') : '#ccc';
      b.style.background = isActive ? (isOut ? '#fce4ec' : '#e8f5e9') : '#fff';
      b.style.color = isActive ? (isOut ? 'var(--accent)' : '#2e7d32') : '#555';
    });
  }

  function refreshOutcomeAvailability() {
    const barred = runsBarred();
    // A runner already sent home when the bar comes on is set back to his base and
    // told about it — the courtesy the out cap does for an out it takes off (M4).
    if (barred) {
      let sentBack = false;
      for (let b = 0; b < 3; b++) {
        if (outcomes[b] && outcomes[b].action === 'safe' && outcomes[b].dest === 3) {
          outcomes[b] = { action: 'safe', dest: b };
          repaintOcRow(b);
          sentBack = true;
        }
      }
      if (sentBack) showPlayReject(NO_RUN_508A);
    }
    const note = document.getElementById('oc-508a');
    if (note) note.style.display = barred ? 'block' : 'none';
    popup.querySelectorAll('.oc-btn').forEach(btn => {
      if (btn.dataset.action !== 'safe') return;   // an out never collides
      const key = btn.dataset.base === 'batter' ? 'batter' : parseInt(btn.dataset.base);
      const dest = btn.dataset.dest ? parseInt(btn.dataset.dest) : 0;
      if (barred && dest === 3) { setOptionBlocked(btn, true); return; }
      const hypothetical = ocParties().map(p => (p.key === key ? { key: p.key, from: p.from, dest } : p));
      setOptionBlocked(btn, runnerOrderConflicts(hypothetical).has(key));
    });
  }

  function flashOcRow(key) {
    const row = popup.querySelector('.oc-row[data-base="' + key + '"]');
    if (row) { row.style.outline = '2px solid var(--accent)'; setTimeout(() => row.style.outline = '', 800); }
  }

  // Who a reverted row is, for the toast below. The runners are named by the base
  // they started on, which is how their own row is labelled.
  function ocWho(key) {
    return key === 'batter' ? 'batter' : `runner on ${baseNames[key]}`;
  }

  // Button handlers
  popup.querySelectorAll('.oc-btn').forEach(btn => {
    btn.onclick = function() {
      if (isOptionBlocked(this)) return;
      const base = this.dataset.base;
      const action = this.dataset.action;
      const dest = this.dataset.dest ? parseInt(this.dataset.dest) : null;
      if (base === 'batter') {
        outcomes.batter = { action, dest: dest !== null ? dest : 0 };
      } else {
        outcomes[parseInt(base)] = { action, dest };
      }
      if (action === 'out') {
        let outCount = 0;
        const outKeys = [];
        if (outcomes.batter && outcomes.batter.action === 'out') { outCount++; outKeys.push('batter'); }
        for (let b = 0; b < 3; b++) {
          if (outcomes[b] && outcomes[b].action === 'out') { outCount++; outKeys.push(b); }
        }
        const reverted = [];
        while (outCount > maxOuts) {
          const revertKey = outKeys.find(k => String(k) !== base);
          if (revertKey === undefined) break;
          reverted.push(ocWho(revertKey));
          if (revertKey === 'batter') {
            outcomes.batter = { action: 'safe', dest: 0 };
          } else {
            // Hold, which is what the repaint below highlights — this used to
            // store an advance and paint the Hold button (C2).
            outcomes[revertKey] = { action: 'safe', dest: revertKey };
          }
          const row = popup.querySelector('.oc-row[data-base="' + revertKey + '"]');
          if (row) {
            const firstSafe = row.querySelector('.oc-btn[data-action="safe"]');
            row.querySelectorAll('.oc-btn').forEach(b => {
              const act = b === firstSafe;
              b.style.borderColor = act ? '#2e7d32' : '#ccc';
              b.style.background = act ? '#e8f5e9' : '#fff';
              b.style.color = act ? '#2e7d32' : '#555';
            });
          }
          outKeys.splice(outKeys.indexOf(revertKey), 1);
          outCount--;
        }
        // An out taken off the board without a word reads as a dead button — the
        // scorer marked it and the row went green on its own. Say what the cap did
        // (M4); it applies to the DP and TP flips as well, which were just as silent.
        if (reverted.length) {
          const n = maxOuts === 1 ? 'one' : maxOuts === 2 ? 'two' : String(maxOuts);
          showPlayReject(`A ${playLabel} records ${n} out${maxOuts === 1 ? '' : 's'} — ${reverted.join(' and ')} set back to safe.`);
        }
      }
      // Update button styles in this row
      this.closest('.oc-row').querySelectorAll('.oc-btn').forEach(b => {
        const isActive = b === this;
        const isOut = b.dataset.action === 'out';
        b.style.borderColor = isActive ? (isOut ? 'var(--accent)' : '#2e7d32') : '#ccc';
        b.style.background = isActive ? (isOut ? '#fce4ec' : '#e8f5e9') : '#fff';
        b.style.color = isActive ? (isOut ? 'var(--accent)' : '#2e7d32') : '#555';
      });
      refreshOutcomeAvailability();   // last: it repaints whatever it blocks
    };
  });

  refreshOutcomeAvailability();

  document.getElementById('oc-confirm').onclick = function() {
    // The offered options are already constrained, but the defaults were never
    // clicked and the out-count auto-revert above can change a row on its own, so
    // check the whole set before it reaches state (#4).
    const parties = ocParties();
    const bad = runnerOrderConflicts(parties);
    if (bad.size) {
      bad.forEach(flashOcRow);
      showPlayReject(runnerOrderMessage(parties));
      return;
    }
    // A DP that records one out is not a DP. The card would assert a double play
    // while the state recorded the opposite of its second out, leaving the inning
    // an out short (#C2). Refuse rather than silently disagree with the label.
    if (requiredOuts) {
      let outCount = outcomes.batter && outcomes.batter.action === 'out' ? 1 : 0;
      for (let b = 0; b < 3; b++) {
        if (outcomes[b] && outcomes[b].action === 'out') outCount++;
      }
      if (outCount < requiredOuts) {
        popup.querySelectorAll('.oc-row').forEach(row => {
          const key = row.dataset.base;
          const oc = key === 'batter' ? outcomes.batter : outcomes[parseInt(key)];
          if (!oc || oc.action !== 'out') flashOcRow(key);
        });
        showPlayReject(`A ${playLabel} needs ${requiredOuts} outs — ${outCount} marked.`);
        return;
      }
    }
    popup.style.display = 'none';
    hidePopupBackdrop();
    callback(outcomes);
  };
}

function applyRunnerOutcomes(team, pIdx, innIdx, ab, inn, play, outcomes) {
  const playLabel = play.replace(/^(DP|FC|TP)\s*/, '') || play;

  // The 5.08(a) backstop for this path — see NO_RUN_508A. The popup blocks Home
  // once the batter's out is the third of the half, so a set of outcomes that
  // still sends somebody there did not come from it.
  let outsThisPlay = 0;
  for (let b = 0; b < 3; b++) if (outcomes[b] && outcomes[b].action === 'out') outsThisPlay++;
  const runsBarred = !!(outcomes.batter && outcomes.batter.action === 'out') &&
    inn.outs + outsThisPlay >= 2;

  // Process runners from 3rd → 1st, tracking which were thrown out on THIS play
  const runnersOutThisPlay = [];
  [2, 1, 0].forEach(fromBase => {
    if (!outcomes[fromBase]) return;
    const oc = outcomes[fromBase];
    const rn = inn.bases[fromBase];
    if (rn === null) return;
    const rab = runnerAtBat(team, rn);
    if (!rab) return;

    if (oc.action === 'out') {
      const n = recordOut(team, innIdx, { kind: 'runner', pIdx: rn.p, col: rn.col, srcP: pIdx, srcCol: innIdx });
      if (!n) return;
      rab.out = n;
      rab.outOnBase = oc.dest;
      setAdvReason(rab, oc.dest, play.substring(0, 2).trim());
      renderDiamond(team, rn.p, rn.col);
      renderOut(team, rn.p, rn.col);
      clearRunner(inn, fromBase);
      runnersOutThisPlay.push(rn);
    } else if (oc.action === 'safe') {
      // He keeps the base he is on, as under the #4 backstop below.
      if (runsBarred && oc.dest === 3) { showPlayReject(NO_RUN_508A); return; }
      // #4 backstop — see applyChosenAdvancements.
      if (!moveRunnerTo(inn, fromBase, oc.dest, rn)) return;
      for (let step = fromBase + 1; step <= oc.dest; step++) {
        markAdvance(rab, step, playLabel, { pIdx, col: innIdx });
      }
      renderDiamond(team, rn.p, rn.col);
    }
  });

  // Collect out numbers only from runners thrown out on THIS play
  let totalOuts = 0;
  const dpOutNums = [];
  for (const rn of runnersOutThisPlay) {
    const rab = runnerAtBat(team, rn);
    if (rab && rab.out > 0) {
      dpOutNums.push(rab.out);
      totalOuts++;
    }
  }

  // Batter outcome
  if (outcomes.batter.action === 'out') {
    const n = recordOut(team, innIdx, { kind: 'batter', pIdx, col: innIdx });
    if (n) {
      ab.out = n;
      dpOutNums.push(n);
      totalOuts++;
    }
  } else {
    const batterDest = outcomes.batter.dest !== undefined ? outcomes.batter.dest : 0;
    for (let s = 0; s <= batterDest; s++) ab.bases[s] = true;
    setRunnerOn(inn, batterDest, runnerRef(pIdx, innIdx));
  }
  ab.outsRecorded = totalOuts;
  if (dpOutNums.length >= 2) {
    dpOutNums.sort((a, b) => a - b);
    ab.dpOuts = dpOutNums;
  }

  renderDiamond(team, pIdx, innIdx);
  renderOut(team, pIdx, innIdx);
  renderPlayText(team, pIdx, innIdx);
}

// The one place a delayed transition is scheduled. Every scheduler used to write
// `pendingTransitionTimer` itself — and the bulk caught-stealing path didn't write
// it at all — so undo's clearTimeout had nothing to cancel, and a second timer
// could be armed on top of a live one (#20). Cancel-before-set, one handle.
function scheduleTransition(fn, delay) {
  if (pendingTransitionTimer) clearTimeout(pendingTransitionTimer);
  pendingTransitionTimer = setTimeout(() => { pendingTransitionTimer = null; fn(); }, delay);
}

// Does the half-inning that just ended (or the run that just scored) end the
// game? Returns true when the summary has been scheduled, so the caller knows not
// to also schedule the next half-inning.
//
// Lives out here because the 3rd out isn't always a batter: a caught stealing or
// a pickoff ends the inning too, and those paths never reached finishPlay, so a
// game ending on one just rolled on into the bottom of the 9th (#5).
function checkGameOver(team, innIdx) {
  const inn = getInnState(team, innIdx);
  if (!halfEndsGame(team, getRealInning(team, innIdx), inn.outs) || gameOverShown) return false;
  gameOverShown = true;
  scheduleTransition(showGameSummary, 1000);
  return true;
}

// Everything that has to happen once the inning state changes, whatever changed
// it. `finishPlay` did all of this inline and the four runner-event paths (SB, CS,
// pickoff, and the bulk WP/PB/BK/SB/CS handler) each re-implemented a different
// subset — which is how a caught stealing could end the game with no summary (#5),
// how a stolen base could put a run on a finished inning's line (#3), how the 3rd
// out made on the bases got a transition timer undo couldn't reach (#20), and why
// an error on a steal never refreshed the pitcher's ER-review badge (#13).
//
// opts.advanceBatter — only a completed plate appearance moves the selection on.
// A steal or a wild pitch leaves the same batter standing at the plate.
function afterStateChange(team, innIdx, opts) {
  // Outs, bases, runs and LOB all come back out of the records here, so a play
  // that patched them inconsistently is corrected before anything reads them.
  recomputeInning(team, getRealInning(team, innIdx));
  const inn = getInnState(team, innIdx);
  const endsHalfInning = inn.outs >= 3;
  updatePlayerStats(team);
  updatePitcherStats(team);   // also recomputes the provisional-ER badges
  if (endsHalfInning) {
    if (!checkGameOver(team, innIdx)) {
      scheduleTransition(() => switchToNextHalf(team, innIdx), 600);
    }
  } else {
    if (opts && opts.advanceBatter) selectNextBatter(team, innIdx);
    checkGameOver(team, innIdx);   // walk-off: the run ends it, not the out
  }
  noteCardChanged();
  updateSituation();
  autoSave();
}

function finishPlay(team, pIdx, innIdx, snapshot) {
  const ab = gameState.teams[team].players[pIdx].atBats[innIdx];
  const inn = getInnState(team, innIdx);
  // The last completed plate appearance of this half-inning: markNextInningLeadoff
  // works off this instead of hunting for an at-bat stamped `out === 3`, which
  // isn't there when the inning ends on a double play, a caught stealing or a
  // pickoff.
  inn.lastPA = { pIdx, col: innIdx };
  /* Chronological order of plays, for pitcher decisions (Phase 8b). Only stamped
     once, so re-editing a play doesn't move it later in the game.

     Which is why the three places that take a play off a cell — `clearSelectedCell`,
     `clearPlayKeepPitches` and `removePitch`'s auto-play recovery — leave `seq`
     alone rather than resetting it. They used to clear it, so a play cleared and
     re-entered was stamped again and sorted after everything recorded in between:
     within its own inning the go-ahead run could end up behind a later one, and the
     win and the loss followed it to the wrong pitcher.

     A stale stamp on an empty cell costs nothing — `runTimeline` and
     `pitcherEntryState`, the only readers, both skip a cell with no play — and the
     cell keeping its place is right: clearing and re-entering is how a scorer
     corrects the plate appearance that already happened there. */
  if (!ab.seq) {
    gameState.playSeq = (gameState.playSeq || 0) + 1;
    ab.seq = gameState.playSeq;
  }
  renderDiamond(team, pIdx, innIdx);
  renderOut(team, pIdx, innIdx);
  renderPlayText(team, pIdx, innIdx);
  renderRBI(team, pIdx, innIdx);
  // Entering a play changes the pitch list — the result pitch, and since M7 the
  // strikes or balls the play implies — so the track has to be repainted here or a
  // button-entered K leaves an empty pitch track until something else redraws the cell.
  renderPitches(team, pIdx, innIdx);
  redoHistory.length = 0;
  playHistory.push(snapshot);

  // Show spray chart for hits
  if (isHitPlay(ab.play) || isErrorPlay(ab.play)) {
    showSprayChart(team, pIdx, innIdx);
  }

  afterStateChange(team, innIdx, { advanceBatter: true });
}

/* Runner advancement popup */
// opts.batterTakesBase — whether the batter ends this play standing on a base
// (a hit or error, not a sacrifice or an out). Needed to catch the batter landing
// on a base a runner is holding (#4).
// opts.batterPIdx — the batter this popup belongs to, so the row is labelled from
// the captured target rather than whatever cell happens to be selected (#1).
function showRunnerPopup(team, innIdx, defaultAdv, callback, opts) {
  const inn = getInnState(team, innIdx);
  const baseNames = ['1st','2nd','3rd','Home'];
  const runners = [];

  for (let b = 2; b >= 0; b--) {
    if (inn.bases[b] === null) continue;
    const rn = inn.bases[b];
    const name = getActivePlayerName(team, rn.p, rn.col);
    const minDest = b; // always allow hold
    runners.push({ base: b, pIdx: rn.p, name, fromLabel: baseNames[b], minDest, defaultDest: undefined });
  }

  // Never skip — always ask
  if (runners.length === 0) {
    callback({});
    return;
  }

  let popup = document.getElementById('runner-popup');
  if (!popup) {
    popup = document.createElement('div');
    popup.id = 'runner-popup';
    popup.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#fff;border:2px solid #333;border-radius:8px;padding:14px 18px;z-index:300;box-shadow:0 6px 30px rgba(0,0,0,0.35);min-width:260px;font-family:var(--font);';
    document.body.appendChild(popup);
  }

  // The play's own name when the caller has one to give: a popup opened by a wild
  // pitch or a passed ball is asking a narrower question than "advance runners", and
  // a scorer answering it should be able to see which event he is answering for (m1).
  const title = (opts && opts.title) || 'Advance Runners';
  let html = '<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px;color:#333">' + escapeHtml(title) + '</div>';
  // Rule 5.08(a) — see NO_RUN_508A. `opts.batterRetired` is the caller saying this
  // play puts the batter out; with two already gone that out is the third, so Home
  // comes off the board for everybody. Said in words as well as greyed out, because
  // an option that is simply missing reads as the app losing track.
  const runBarred = !!(opts && opts.batterRetired) && inn.outs >= 2;
  if (runBarred) {
    html += '<div style="font-size:10px;color:var(--accent,#c41e3a);margin:-4px 0 10px;line-height:1.4">' + escapeHtml(NO_RUN_508A) + '</div>';
  }
  const choices = {};

  runners.forEach(r => {
    choices[r.base] = undefined;
    html += `<div style="margin-bottom:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">`;
    html += `<span style="font-size:11px;font-weight:600;min-width:100px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(r.name)}</span>`;
    html += `<span style="font-size:10px;color:#999;min-width:24px">${r.fromLabel}→</span>`;
    html += `<div style="display:flex;gap:3px;flex-wrap:wrap">`;
    for (let d = r.minDest; d <= 3; d++) {
      const label = d === r.base ? 'Hold' : baseNames[d];
      html += `<button class="rp-btn" data-base="${r.base}" data-dest="${d}" style="padding:3px 8px;font-size:11px;font-weight:600;border:1.5px solid #ccc;border-radius:4px;background:#fff;cursor:pointer;color:#555;font-family:var(--mono)">${label}</button>`;
    }
    for (let d = r.base + 1; d <= 3; d++) {
      html += `<button class="rp-btn rp-out" data-base="${r.base}" data-dest="-${d}" style="padding:3px 8px;font-size:11px;font-weight:600;border:1.5px solid #ccc;border-radius:4px;background:#fff;cursor:pointer;color:var(--accent);font-family:var(--mono)">Out ${baseNames[d]}</button>`;
    }
    html += `</div></div>`;
  });

  // Batter advancement row for hits/errors — allows advancing past default base (e.g. 1B→2B on error)
  // Only for a batter who ends the play on a base. A sacrifice advances its runners
  // by 1 like a single does, and the row used to render off that alone — three
  // destinations for a man the callback then handed straight to `recordBatterOut`,
  // and which `rpParties` never validated because he was never going to be on a base
  // (M3). An option that cannot change the card is worse than no option.
  const batterTakesBase = !!(opts && opts.batterTakesBase);
  const batterDefaultBase = batterTakesBase && defaultAdv > 0 && defaultAdv <= 3 ? defaultAdv - 1 : -1;
  if (batterDefaultBase >= 0 && batterDefaultBase < 3) {
    choices.batterDest = undefined;
    const batterName = (opts && opts.batterPIdx !== undefined)
      ? getActivePlayerName(team, opts.batterPIdx, innIdx)
      : (selectedCell ? getActivePlayerName(selectedCell.dataset.team, parseInt(selectedCell.dataset.p), parseInt(selectedCell.dataset.inn)) : 'Batter');
    html += `<div style="margin-bottom:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;border-top:1px solid #ddd;padding-top:8px">`;
    html += `<span style="font-size:11px;font-weight:600;min-width:100px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(batterName)}</span>`;
    html += `<span style="font-size:10px;color:#999;min-width:24px">Batter→</span>`;
    html += `<div style="display:flex;gap:3px;flex-wrap:wrap">`;
    for (let d = batterDefaultBase; d <= 2; d++) {
      html += `<button class="rp-btn" data-base="batter" data-dest="${d}" style="padding:3px 8px;font-size:11px;font-weight:600;border:1.5px solid #ccc;border-radius:4px;background:#fff;cursor:pointer;color:#555;font-family:var(--mono)">${baseNames[d]}</button>`;
    }
    html += `</div></div>`;
  }

  html += `<button id="rp-confirm" style="margin-top:6px;width:100%;padding:6px;font-size:12px;font-weight:700;background:#333;color:#fff;border:none;border-radius:4px;cursor:pointer">Confirm</button>`;
  popup.innerHTML = html;
  showPopupBackdrop();
  popup.style.display = 'block';

  // Where everyone ends up, as `runnerOrderConflicts` wants it. A runner thrown out
  // (negative dest) leaves the ordering: the base he was heading for is free for the
  // man behind him. The batter counts as starting from behind 1st.
  const inPopup = new Set(runners.map(r => r.pIdx));
  function rpParties(assume) {
    const list = runners.map(r => ({
      key: r.base,
      from: r.base,
      dest: choices[r.base] !== undefined && choices[r.base] >= 0 ? choices[r.base] : undefined
    }));
    // A runner this play already placed and who isn't up for a decision here holds
    // his base — nobody in the popup may be sent to it.
    for (let b = 0; b < 3; b++) {
      if (inn.bases[b] !== null && !inPopup.has(inn.bases[b].p)) list.push({ key: 'held' + b, from: b, dest: b });
    }
    if (batterTakesBase) {
      const bDest = choices.batterDest !== undefined ? choices.batterDest : batterDefaultBase;
      list.push({ key: 'batter', from: -1, dest: bDest >= 0 ? bDest : undefined });
    }
    if (!assume) return list;
    return list.map(p => (p.key === assume.key ? { key: p.key, from: p.from, dest: assume.dest } : p));
  }

  function refreshRunnerAvailability() {
    popup.querySelectorAll('.rp-btn').forEach(btn => {
      const dest = parseInt(btn.dataset.dest);
      if (dest < 0) return;   // "Out at" never collides with anyone
      const key = btn.dataset.base === 'batter' ? 'batter' : parseInt(btn.dataset.base);
      // The 5.08(a) bar goes through here rather than being painted once at render
      // time, or the collision refresh below would open the plate back up on the
      // next click. The batter's own row tops out at 3rd, so this is the runners.
      if (runBarred && dest === 3) { setOptionBlocked(btn, true); return; }
      setOptionBlocked(btn, runnerOrderConflicts(rpParties({ key, dest })).has(key));
    });
  }

  // Button click handlers
  popup.querySelectorAll('.rp-btn').forEach(btn => {
    btn.onclick = function() {
      if (isOptionBlocked(this)) return;
      const baseKey = this.dataset.base;
      const dest = parseInt(this.dataset.dest);
      if (baseKey === 'batter') {
        choices.batterDest = dest;
      } else {
        choices[parseInt(baseKey)] = dest;
      }
      this.parentElement.querySelectorAll('.rp-btn').forEach(b => {
        const bDest = parseInt(b.dataset.dest);
        const isActive = bDest === dest;
        const isOut = bDest < 0;
        b.style.borderColor = isActive ? (isOut ? 'var(--accent)' : '#1565c0') : '#ccc';
        b.style.background = isActive ? (isOut ? '#fce4ec' : '#e3f2fd') : '#fff';
        b.style.color = isActive ? (isOut ? 'var(--accent)' : '#1565c0') : (isOut ? 'var(--accent)' : '#555');
      });
      refreshRunnerAvailability();   // last: it repaints whatever it blocks
    };
  });

  refreshRunnerAvailability();

  function flashRow(baseKey) {
    const row = popup.querySelector(`.rp-btn[data-base="${baseKey}"]`)?.closest('div')?.parentElement;
    if (row) { row.style.outline = '2px solid var(--accent)'; setTimeout(() => row.style.outline = '', 800); }
  }

  document.getElementById('rp-confirm').onclick = function() {
    // Check all runners have a selection
    const allSelected = runners.every(r => choices[r.base] !== undefined);
    if (!allSelected) {
      // Flash unselected rows
      runners.forEach(r => {
        if (choices[r.base] === undefined) flashRow(r.base);
      });
      return;
    }

    // #4: refuse a set of destinations that would put two men on one base, or send
    // a trailing runner past a lead runner still standing on one. The old code took
    // the last write and the overwritten runner vanished off the bases — still
    // marked up on his at-bat, but unable to score. The colliding options are
    // greyed out as choices are made; this catches the rest, including the batter
    // row left on its default.
    const parties = rpParties();
    const bad = runnerOrderConflicts(parties);
    if (bad.size) {
      bad.forEach(k => flashRow(k));
      showPlayReject(runnerOrderMessage(parties));
      return;
    }

    popup.style.display = 'none';
    hidePopupBackdrop();
    callback(choices);
  };
}

function updateInningRuns(team, innIdx) {
  const realInning = getRealInning(team, innIdx);
  if (realInning >= INNINGS) return;
  const players = gameState.teams[team].players;
  // Count runs across ALL columns that belong to this real inning
  const cols = getColumnsForInning(team, realInning);
  let runs = 0;
  for (const col of cols) {
    for (const player of players) {
      const ab = player.atBats[col];
      if (ab.bases[0] && ab.bases[1] && ab.bases[2] && ab.bases[3] && ab.outOnBase == null) runs++;
    }
  }
  const inp = document.querySelector(`input[data-ls="${team}"][data-inn="${realInning}"]`);
  if (inp) { inp.value = runs || ''; gameState.linescore[team].innings[realInning] = runs ? String(runs) : ''; }
  updateLinescoreTotals(team);
}

function updateLinescoreHits(team) {
  const players = gameState.teams[team].players;
  let totalHits = 0;
  for (const player of players) {
    for (const ab of player.atBats) {
      if (isHitPlay(ab.play)) totalHits++;
    }
  }
  const hInp = document.querySelector(`input[data-ls="${team}"][data-stat="h"]`);
  if (hInp) hInp.value = totalHits || '';
  if (gameState.linescore[team]) gameState.linescore[team].h = totalHits;
}

// H1: errors are recorded on the card of the team that was *batting*, so the count
// they produce belongs in the other team's E box. Two distinct signals, and a cell
// can legitimately carry both: an error play (`E`, `E5`, …) is a fielding error on
// the batter, and an exact `'E'` advancement reason is a throwing error on a steal
// or a pickoff (the only two writers — applySBWithError and the pickoff path), which
// leaves no error play on any cell. A player who reaches on E5 and later steals on a
// bad throw made two errors happen, and this counts two.
//
// Only the exact string counts. `showRunnerPopup`'s out path stamps the *batter's*
// play as the reason ('E5' on a runner thrown out during the error play), which is a
// label for an error already counted, not a second one.
function countErrorSignals(battingTeam) {
  let n = 0;
  for (const player of gameState.teams[battingTeam].players) {
    for (const ab of player.atBats) {
      if (isErrorPlay(ab.play)) n++;
      if (Array.isArray(ab.advReason)) {
        for (const r of ab.advReason) if (r === 'E') n++;
      }
    }
  }
  return n;
}

// Recomputes both boxes: the figure for either team is read off the opposing card,
// so there is no per-team call that wouldn't have to reach across anyway.
function updateLinescoreErrors() {
  const other = { visiting: 'home', home: 'visiting' };
  ['visiting', 'home'].forEach(team => {
    const e = countErrorSignals(other[team]);
    const inp = document.querySelector(`input[data-ls="${team}"][data-stat="e"]`);
    if (inp) inp.value = e || '';
    if (gameState.linescore[team]) gameState.linescore[team].e = e ? String(e) : '';
  });
}

function selectNextBatter(team, innIdx) {
  const players = gameState.teams[team].players;
  const sameTeam = selectedCell && selectedCell.dataset.team === team;
  const curP = sameTeam ? parseInt(selectedCell.dataset.p) : -2;
  const curPos = Math.floor(curP / ROWS_PER_POS);
  for (let i = 1; i <= POSITIONS; i++) {
    const pos = (curPos + i) % POSITIONS;
    const p = pos * ROWS_PER_POS;
    if (!players[p].atBats[innIdx].play) {
      const cell = document.querySelector(`.at-bat-cell[data-team="${team}"][data-p="${p}"][data-inn="${innIdx}"]`);
      if (cell) { selectCell(cell); return; }
    }
  }
  // All 9 positions filled — check if inning still active (outs < 3)
  const inn = getInnState(team, innIdx);
  if (inn.outs < 3) {
    overflowToNextColumn(team, innIdx);
  }
}

/* ------------------------------------------ moving a side's columns over ---
   Batting around needs a column to spill into, and it has to sit immediately
   right of the one that filled up or the card stops reading left to right. So
   everything from there rightwards moves over one.

   `columnMap` was the only thing that moved (C1). The at-bats stayed where they
   were, so an inning already recorded in the next column was silently relabelled
   as this one: three strikeouts entered as the top of the 2nd became the top of
   the 1st, out log and all. That is reachable from an ordinary correction — go
   back to an earlier inning, add the batter you missed, and the inning you have
   already scored slides under it.

   Everything column-indexed moves together now, and every pointer that names a
   column moves with it. Those pointers are the reason this can't be done in
   pieces: `bases[].col`, the out log's `col`/`srcCol`, `lastPA.col`, the
   advancement stamps' `advSrc[].col`, the stored leadoff (keyed by column) and
   any recorded re-entry all name columns, and a card whose base entries point at
   the wrong plate appearance is worse than one that refused the insertion. */
function remapColumnRefs(team, remap) {
  const players = gameState.teams[team].players;
  for (const inn of gameState.innings[team]) {
    if (!inn) continue;
    if (Array.isArray(inn.bases)) inn.bases.forEach(r => { if (r) r.col = remap(r.col); });
    if (Array.isArray(inn.outsLog)) inn.outsLog.forEach(o => {
      if (!o) return;
      o.col = remap(o.col);
      o.srcCol = remap(o.srcCol);
    });
    if (inn.lastPA) inn.lastPA.col = remap(inn.lastPA.col);
  }
  for (const player of players) {
    for (const ab of player.atBats) {
      if (ab && Array.isArray(ab.advSrc)) ab.advSrc.forEach(s => { if (s) s.col = remap(s.col); });
    }
  }
  const leadoff = gameState.nextLeadoff && gameState.nextLeadoff[team];
  if (leadoff) {
    const moved = {};
    Object.keys(leadoff).forEach(k => { moved[remap(parseInt(k))] = leadoff[k]; });
    gameState.nextLeadoff[team] = moved;
  }
  if (Array.isArray(gameState.reentries)) {
    gameState.reentries.forEach(r => { if (r && r.team === team) r.col = remap(r.col); });
  }
}

function emptyInningRecord() {
  return { outs:0, bases:[null,null,null], currentPitcher:0, lob:0, outsLog:[], lastPA:null };
}

// Open a fresh column at `at`, mapped to `realInning`. Returns false when the
// last column holds a play and there is therefore nothing to move into.
function shiftColumnsRight(team, at, realInning) {
  const players = gameState.teams[team].players;
  const innings = gameState.innings[team];
  for (let pos = 0; pos < POSITIONS; pos++) {
    if (players[pos * ROWS_PER_POS].atBats[INNINGS - 1].play) return false;
  }
  for (let c = INNINGS - 1; c > at; c--) {
    gameState.columnMap[team][c] = gameState.columnMap[team][c - 1];
    innings[c] = innings[c - 1];
    for (const player of players) player.atBats[c] = player.atBats[c - 1];
  }
  gameState.columnMap[team][at] = realInning;
  innings[at] = emptyInningRecord();
  for (const player of players) {
    const fresh = makeEmptyAtBat();
    // The overflow continues the same half-inning, so the same man is in the
    // slot: carry the sub line across or a substitution's run of columns is split
    // in two by a blank one, and the column reads as the starter's.
    //
    // `runRowOf`, not `subRowOf` (M2): who is in the slot going forward is who was
    // *running* the column before, and a pinch runner lives in `prRow` — his own
    // column still reports the row that batted it, which is the man he came in for.
    // Seeded from `subChange` alone, the inserted column was handed back to that
    // man, the runner's own sub line resumed one column late, and the rows down the
    // slot read 0, 0, 1, 1. A pinch hitter has no `prRow`, so his columns are
    // unaffected — `runRowOf` falls through to `subRowOf` for him.
    if (at > 0) fresh.subChange = runRowOf(player.atBats[at - 1]);
    player.atBats[at] = fresh;
  }
  remapColumnRefs(team, c => (typeof c === 'number' && c >= at ? c + 1 : c));
  return true;
}

// The exact inverse, for undo (M4). The column is empty again by the time this
// runs: history is a stack, so anything entered into it has been taken back
// first.
function shiftColumnsLeft(team, at) {
  const players = gameState.teams[team].players;
  const innings = gameState.innings[team];
  for (let c = at; c < INNINGS - 1; c++) {
    gameState.columnMap[team][c] = gameState.columnMap[team][c + 1];
    innings[c] = innings[c + 1];
    for (const player of players) player.atBats[c] = player.atBats[c + 1];
  }
  const prevMapped = gameState.columnMap[team][INNINGS - 2];
  gameState.columnMap[team][INNINGS - 1] =
    Math.min(INNINGS - 1, (typeof prevMapped === 'number' ? prevMapped : INNINGS - 2) + 1);
  innings[INNINGS - 1] = emptyInningRecord();
  for (const player of players) player.atBats[INNINGS - 1] = makeEmptyAtBat();
  remapColumnRefs(team, c => (typeof c === 'number' && c > at ? c - 1 : c));
}

/* Stamp the insertion onto the undo entry for the play that caused it (M4).

   The column is inserted from inside `selectNextBatter`, by which time
   `finishPlay` has already pushed the snapshot — and that snapshot was taken
   before the play, so it knows nothing about a column that did not exist yet.
   Undo gave the runs and the bases back and left the column standing, and the
   phantom continuation then made every later half-inning transition pick it. */
function noteInsertedColumn(team, col) {
  const top = playHistory[playHistory.length - 1];
  if (top && top.team === team && top.insertedCol === undefined) top.insertedCol = col;
}

function overflowToNextColumn(team, innIdx) {
  const nextCol = innIdx + 1;
  // L4: an inning that bats around needs a column to spill into, and the card has
  // fifteen. Reaching the last one used to return bare, leaving the selection on the
  // filled cell it came from — where every further batter was refused, silently until
  // L2 gave that cell a voice. Say which wall was hit, since the two refusals a scorer
  // then meets ("this cell is full", "no column left") have different answers.
  if (!gameState.columnMap) gameState.columnMap = { visiting:defaultColumnMap(), home:defaultColumnMap() };
  const realInning = getRealInning(team, innIdx);
  if (nextCol >= INNINGS || !shiftColumnsRight(team, nextCol, realInning)) {
    showPlayReject(CARD_FULL);
    return;
  }

  // Copy inning state (outs, bases) to the new column
  const srcInn = getInnState(team, innIdx);
  const dstInn = getInnState(team, nextCol);
  dstInn.outs = srcInn.outs;
  dstInn.bases = [...srcInn.bases];
  dstInn.currentPitcher = srcInn.currentPitcher;
  dstInn.pitcherSet = srcInn.pitcherSet;

  noteInsertedColumn(team, nextCol);

  // Update column headers
  updateColumnHeaders(team);
  refreshCellAria(team);

  // Select the next batter in the new column (wrap around from where we left off)
  const sameTeam = selectedCell && selectedCell.dataset.team === team;
  const curP = sameTeam ? parseInt(selectedCell.dataset.p) : -2;
  const curPos = Math.floor(curP / ROWS_PER_POS);
  const nextPos = (curPos + 1) % POSITIONS;
  const nextP = nextPos * ROWS_PER_POS;
  const cell = document.querySelector(`.at-bat-cell[data-team="${team}"][data-p="${nextP}"][data-inn="${nextCol}"]`);
  if (cell) selectCell(cell);
}

// Are all nine spots in this column taken?
function columnIsFull(team, col) {
  const players = gameState.teams[team].players;
  for (let pos = 0; pos < POSITIONS; pos++) {
    if (!players[pos * ROWS_PER_POS].atBats[col].play) return false;
  }
  return true;
}

/* The column a side bats its `realInn`th inning in (M3).

   This used to be `getNextFreeColumn` — "the first column with no plays in it" —
   which is only the same question while every half-inning before this one has been
   recorded. One that nobody recorded (a half missed at a live game, or the phantom
   column M4 used to leave behind) and every later transition landed back in the
   hole: the bottom of the 3rd was selected in the column labelled the 2nd, and its
   runs went onto the line against the wrong inning.

   The column map is the record, so ask it. A batted-around inning has more than one
   column; the one to bat in is the first with a spot still open.

   Returns -1 when the card has no column for this inning at all (M1) — past the
   fifteenth, or an inning whose column an earlier bat-around has since consumed.
   It used to answer `INNINGS - 1` for the first of those and `realInn` for the
   second, both of which name a column belonging to some *other* inning: the
   selection was parked on a half-inning already spent, and every entry there was
   refused as "the inning already has 3 outs" — a wall the scorer can clear by hand,
   which is not the one he had hit. Callers say CARD_FULL instead. */
function columnForInning(team, realInn) {
  if (realInn >= INNINGS) return -1;
  const cols = getColumnsForInning(team, realInn);
  // Every column is mapped to some inning, so an inning with none of them has been
  // squeezed off the end of the card by a bat-around — there is no free one to fall
  // back to.
  if (!cols.length) return -1;
  for (const col of cols) if (!columnIsFull(team, col)) return col;
  return cols[cols.length - 1];
}

function switchToNextHalf(team, innIdx) {
  markNextInningLeadoff(team, innIdx);

  // The visitor's half of an inning is followed by the home team's half of the
  // same one; the home team's by the visitor's half of the next.
  const realInn = getRealInning(team, innIdx);
  const nextTeam = team === 'visiting' ? 'home' : 'visiting';
  const nextInn = team === 'visiting' ? realInn : realInn + 1;
  const nextCol = columnForInning(nextTeam, nextInn);
  // M1: the card has run out. Say which wall this is and leave the selection on the
  // half-inning that just ended — there is no cell that stands for the inning being
  // asked for, so any cell this moved to would be some other inning's, and the one
  // it used to move to was a half-inning with three outs already on it.
  if (nextCol < 0) { showPlayReject(CARD_FULL); return; }
  switchTab(nextTeam);
  selectNextBatterForInning(nextTeam, nextCol);
}

// The next inning leads off with the batter after the last completed plate
// appearance. That rule is right however the half-inning ended — on a strikeout,
// on the back end of a double play, on a caught stealing or on a pickoff. The old
// version searched for an at-bat stamped `out === 3` and found nothing in the
// last three of those, so the order silently restarted at the top (#7).
function markNextInningLeadoff(team, innIdx) {
  const players = gameState.teams[team].players;
  const realInning = getRealInning(team, innIdx);
  const cols = getColumnsForInning(team, realInning);

  let lastPos = -1;
  for (const col of cols) {
    const pa = getInnState(team, col).lastPA;
    if (pa) lastPos = Math.floor(pa.pIdx / ROWS_PER_POS);
  }
  // Games saved before `lastPA` existed can't have it backfilled reliably, so
  // fall back to the old 3rd-out search for them rather than losing the order.
  if (lastPos === -1) {
    for (const col of cols) {
      for (let pos = 0; pos < POSITIONS; pos++) {
        if (players[pos * ROWS_PER_POS].atBats[col].out === 3) { lastPos = pos; break; }
      }
      if (lastPos !== -1) break;
    }
  }
  if (lastPos === -1) return;

  const nextPos = (lastPos + 1) % POSITIONS;
  const nextP = nextPos * ROWS_PER_POS;
  // This side's *next* inning, by the map — not the column scan this used to use,
  // which parked the order against whichever column happened to be blank and so
  // filed the leadoff under an inning nobody had reached yet (M3). There may be no
  // column for it at all, in which case there is nothing to file (M1).
  const nextCol = columnForInning(team, realInning + 1);
  if (nextCol < 0) return;

  if (!gameState.nextLeadoff) gameState.nextLeadoff = {};
  if (!gameState.nextLeadoff[team]) gameState.nextLeadoff[team] = {};
  gameState.nextLeadoff[team][nextCol] = nextP;
}

function selectNextBatterForInning(team, colIdx) {
  // #6: extra-inning columns are display:none until +EI is pressed. After a tied
  // 9th the app selected a cell nobody could see, so reveal the column first.
  if (colIdx >= visibleInningCount()) {
    gameState.visibleInnings = Math.min(colIdx + 1, INNINGS);
    updateInningVisibility();
  }
  const leadoffP = gameState.nextLeadoff?.[team]?.[colIdx];
  if (leadoffP !== undefined) {
    const cell = document.querySelector(`.at-bat-cell[data-team="${team}"][data-p="${leadoffP}"][data-inn="${colIdx}"]`);
    if (cell) { selectCell(cell); return; }
  }
  // No stored leadoff — start from position 1
  const cell = document.querySelector(`.at-bat-cell[data-team="${team}"][data-p="0"][data-inn="${colIdx}"]`);
  if (cell) { selectCell(cell); return; }
}

/* Pitch tracking */
function getPitchCount(pitches) {
  let balls = 0, strikes = 0;
  for (const p of pitches) {
    if (p === 'B') balls++;
    else if (p === 'S') strikes++;
    else if (p === 'F' && strikes < 2) strikes++;
  }
  return { balls, strikes };
}

function addPitch(type) {
  if (!selectedCell) return;
  const team = selectedCell.dataset.team;
  const pIdx = parseInt(selectedCell.dataset.p);
  const innIdx = parseInt(selectedCell.dataset.inn);
  const ab = gameState.teams[team].players[pIdx].atBats[innIdx];
  if (ab.play) return;
  // #26: the half-inning is over — there is nobody at the plate to charge a pitch
  // to. Without this, 4 balls here counted toward the pitch count and then
  // applyPlay silently dropped the walk on its own outs guard.
  if (getInnState(team, innIdx).outs >= 3) { showPlayReject(INNING_OVER); return; }
  if (!ab.pitches) ab.pitches = [];
  const before = getPitchCount(ab.pitches);
  if (before.balls >= 4 || before.strikes >= 3) return;
  pushUndo(team, pIdx, innIdx);
  ab.pitches.push(type);
  renderPitches(team, pIdx, innIdx);
  updateSituation();
  checkAutoTrigger(team, pIdx, innIdx);
  autoSave();
}

/* Take the last pitch back off the at-bat under the cursor.

   A pitch that produced a play takes the play with it: four balls is a walk and
   three strikes a strikeout, so removing the pitch that got there has to remove
   what it triggered, or the cell keeps a walk on a 3-ball count.

   That recovery used to hunt for "the snapshot the auto-play was applied over" at
   `playHistory[length - 2]`, and it was wrong three ways (M2). That entry is only
   the right one when removePitch is the very next action after the play — which
   it never is, because entering the play moves the selection to the next batter,
   so the first press landed on an empty cell and did nothing at all, silently.
   Pressed on the right cell it restored the snapshot *over the pitch it had just
   popped*, so the ball never came off. And with anything in between it restored
   whatever happened to be two from the top, putting the walk back.

   So nothing is restored. The play comes off the way every other mutator takes
   one off — `takeBackPlay` for its effects on everybody else, the batter's own
   record cleared here — and `recomputeInning` derives the rest. */
function removePitch() {
  if (!selectedCell) return;
  const team = selectedCell.dataset.team;
  const pIdx = parseInt(selectedCell.dataset.p);
  const innIdx = parseInt(selectedCell.dataset.inn);
  const ab = gameState.teams[team].players[pIdx].atBats[innIdx];
  // L2's rule: a press that changes nothing has to say why. This is the commonest
  // press there is — the selection has already moved on to the next batter by the
  // time a scorer reaches for it — and it used to return bare.
  if (!ab.pitches || !ab.pitches.length) {
    showPlayReject('No pitches on this cell — select the at-bat you meant first.');
    return;
  }
  pushUndo(team, pIdx, innIdx);
  const wasAutoPlay = ab.play === 'BB' || ab.play === 'K' || ab.play === 'ꓘ';
  ab.pitches.pop();
  if (wasAutoPlay) {
    takeBackPlay(team, innIdx, pIdx, ab.outsRecorded || (ab.out ? 1 : 0));
    removeRunnerFromBases(getInnState(team, innIdx), pIdx);
    ab.play = '';
    ab.bases = [false, false, false, false];
    ab.advReason = ['','','','']; ab.advSrc = null;
    ab.out = 0; ab.outsRecorded = 0; ab.dpOuts = null; ab.outOnBase = null;
    ab.rbi = 0; ab.reachedOnError = false;   // `seq` stays — see `finishPlay`
    renderDiamond(team, pIdx, innIdx);
    renderOut(team, pIdx, innIdx);
    renderPlayText(team, pIdx, innIdx);
    renderRBI(team, pIdx, innIdx);
  }
  renderPitches(team, pIdx, innIdx);
  if (wasAutoPlay) {
    // A removal can't end a half-inning, so this is `clearPlayKeepPitches`'s tail
    // rather than the full `afterStateChange` — no transition to schedule, and the
    // same batter is still at the plate.
    recomputeInning(team, getRealInning(team, innIdx));
    updatePlayerStats(team);
  }
  // Outside that branch, because a pitch always belongs to a pitcher (L2). The
  // pitcher line was refreshed only when the removal took a play back with it, so
  // removing a pitch from a cell that already had a play left PC one too high on
  // screen and — `collectState` scrapes the input — one too high in what got
  // saved, until the next play or a reload put it right.
  updatePitcherStats(team);
  noteCardChanged();
  updateSituation();
  autoSave();
}

function renderPitches(team, pIdx, innIdx) {
  const ab = gameState.teams[team].players[pIdx].atBats[innIdx];
  const el = document.getElementById(`pt-${team}-${pIdx}-${innIdx}`);
  if (!el) return;
  const pitches = ab.pitches || [];
  const balls = pitches.filter(p => p === 'B');
  const strikes = pitches.filter(p => p === 'S' || p === 'F');
  if (!balls.length && !strikes.length) { el.innerHTML = ''; return; }
  const MAX = 7;
  const groups = Math.max(Math.ceil(balls.length / MAX), Math.ceil(strikes.length / MAX), 1);
  let html = '';
  for (let g = 0; g < groups; g++) {
    const gb = balls.slice(g * MAX, (g + 1) * MAX);
    const gs = strikes.slice(g * MAX, (g + 1) * MAX);
    html += '<div class="pitch-col">';
    gb.forEach(() => { html += '<span class="pitch-mark ball">●</span>'; });
    html += '</div><div class="pitch-col">';
    gs.forEach(p => { html += p === 'F' ? '<span class="pitch-mark foul">✕</span>' : '<span class="pitch-mark strike">✕</span>'; });
    html += '</div>';
  }
  el.innerHTML = html;
}

function checkAutoTrigger(team, pIdx, innIdx) {
  const ab = gameState.teams[team].players[pIdx].atBats[innIdx];
  if (ab.play) return;
  const count = getPitchCount(ab.pitches || []);
  // Pass the batter explicitly: this is the man who just reached 4 balls / 3
  // strikes, whatever the scorer taps next (#1).
  const target = { team, pIdx, innIdx };
  if (count.balls >= 4) applyPlay('BB', target);
  else if (count.strikes >= 3) showStrikeoutPopup(target);
}

function showStrikeoutPopup(target) {
  const t = target || currentTarget();
  if (!t) return;
  let popup = document.getElementById('k-popup');
  if (!popup) {
    popup = document.createElement('div');
    popup.id = 'k-popup';
    popup.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:var(--card);border:3px solid var(--navy);border-radius:10px;padding:20px 24px;z-index:300;box-shadow:0 8px 40px rgba(26,39,68,0.4);text-align:center;font-family:var(--heading);';
    popup.innerHTML = '<div style="font-size:14px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--navy);margin-bottom:14px">Strikeout</div>'
      + '<div style="display:flex;gap:12px;justify-content:center">'
      + '<button id="k-swinging" style="padding:10px 24px;font-size:16px;font-weight:700;font-family:var(--heading);background:var(--navy);color:var(--gold);border:none;border-radius:6px;cursor:pointer;letter-spacing:1px">K<br><span style=font-size:10px>SWINGING</span></button>'
      + '<button id="k-looking" style="padding:10px 24px;font-size:16px;font-weight:700;font-family:var(--heading);background:var(--navy);color:var(--gold);border:none;border-radius:6px;cursor:pointer;letter-spacing:1px">ꓘ<br><span style=font-size:10px>LOOKING</span></button>'
      + '</div>';
    document.body.appendChild(popup);
  }
  // Rebound on every open so the handlers apply to the batter captured above,
  // not to whatever cell is selected when the button is finally pressed (#1).
  document.getElementById('k-swinging').onclick = function() {
    popup.style.display = 'none'; hidePopupBackdrop(); applyPlay('K', t);
  };
  document.getElementById('k-looking').onclick = function() {
    popup.style.display = 'none'; hidePopupBackdrop(); applyPlay('ꓘ', t);
  };
  showPopupBackdrop();
  popup.style.display = 'block';
}

/* The pitcher's name as the card has him right now, the way `getActivePlayerName`
   reads a batter: off the input rather than the state, so a reliever written in as
   he comes out of the bullpen is named in the panel before the debounce (L3). */
function livePitcherLabel(team, idx) {
  const num = livePitcherField(team, idx, 'num');
  const name = livePitcherField(team, idx, 'name');
  if (!num && !name) return 'Pitcher ' + (idx + 1);
  return (num ? '#' + num + ' ' : '') + (name || 'Pitcher ' + (idx + 1));
}

/* Every pitch one pitcher has thrown in the game so far, counted live.

   The PC on the pitching line can't answer this: `updatePitcherStats` skips at-bats
   with no play yet, so it stands still through a nine-pitch at-bat and jumps when
   the play lands. The panel is what a manager watches a starter's count on, so the
   at-bat in progress is counted here too.

   `ab.pitcher` is only stamped when the play is entered, so an unfinished at-bat is
   attributed the way `applyPlay` is about to attribute it — whoever the column says
   is on the mound. `battingTeam` picks the side whose at-bats hold the pitches;
   these are the pitches thrown *at* them, by `battingTeam`'s opponent. */
function livePitchCount(battingTeam, pitcherIdx) {
  let n = 0;
  for (const player of gameState.teams[battingTeam].players) {
    for (let col = 0; col < player.atBats.length; col++) {
      const ab = player.atBats[col];
      const pitches = ab && ab.pitches;
      if (!pitches || !pitches.length) continue;
      const owner = ab.play ? (ab.pitcher || 0) : getEffectivePitcher(battingTeam, col);
      if (owner === pitcherIdx) n += pitches.length;
    }
  }
  return n;
}

/* Game Situation Panel */
function updateSituation() {
  if (!selectedCell) return;
  const team = selectedCell.dataset.team;
  const pIdx = parseInt(selectedCell.dataset.p);
  const innIdx = parseInt(selectedCell.dataset.inn);
  const ab = gameState.teams[team].players[pIdx].atBats[innIdx];
  const inn = getInnState(team, innIdx);
  const realInn = getRealInning(team, innIdx);

  // Situation panel removed — just update linescore tracking

  // Update live stat box
  const innNum = realInn + 1;
  const half = team === 'visiting' ? '▲' : '▼';
  const lsInn = document.getElementById('ls-inning');
  if (lsInn) lsInn.textContent = half + ' ' + innNum;

  const count = getPitchCount(ab.pitches || []);
  const lsCount = document.getElementById('ls-count');
  if (lsCount) lsCount.textContent = count.balls + '-' + count.strikes;

  // Outs
  for (let i = 1; i <= 3; i++) {
    const od = document.getElementById('ls-out-' + i);
    if (od) od.classList.toggle('active', i <= inn.outs);
  }

  // Bases
  ['ls-b1','ls-b2','ls-b3'].forEach((id, i) => {
    const el = document.getElementById(id);
    if (el) el.setAttribute('fill', inn.bases[i] !== null ? 'var(--gold)' : 'rgba(255,255,255,0.2)');
  });

  // Batter
  const lsBatter = document.getElementById('ls-batter');
  if (lsBatter) {
    lsBatter.textContent = getActivePlayerName(team, pIdx, innIdx);
    fitName(lsBatter);
  }

  // The man on the mound, and his running pitch count. Both repaint from here,
  // which every pitch goes through — a count that only moved when the plate
  // appearance finished would be a pitch count you can't take a pitcher out on.
  const pitchingTeam = team === 'visiting' ? 'home' : 'visiting';
  const pIdxOnMound = getEffectivePitcher(team, innIdx);
  const lsPitcher = document.getElementById('ls-pitcher');
  if (lsPitcher) {
    lsPitcher.textContent = livePitcherLabel(pitchingTeam, pIdxOnMound);
    fitName(lsPitcher);
  }
  const lsPitches = document.getElementById('ls-pitches');
  if (lsPitches) {
    const n = livePitchCount(team, pIdxOnMound);
    lsPitches.textContent = n + (n === 1 ? ' pitch' : ' pitches');
  }

  // Linescore highlight + auto-zeros for completed innings
  highlightLinescore(team, innIdx);
  fillLinescoreZeros();

  // Last, over the top of everything above: a finished game reads FINAL. The panel
  // is the only standing sign that the card is closed once the summary modal has
  // been dismissed, and this is the one writer that repaints on every selection —
  // so without this, a reloaded final card showed FINAL until the first tap and
  // then went back to reading "▼ 9 · 0-0 · nobody out" for a game that was over
  // (M1). Derived, so correcting the score back to a tie restores the live panel.
  if (gameIsFinal()) renderFinalReadout();
  updateBackupReminder();

  // (count, batter, LOB now handled in the panel loop above)
}

function updateLiveStatsFromState() {
  const half = lastHalfWithPlays();
  if (!half) return;
  // The reload path: `updateSituation` bails with no cell selected, so a card that
  // comes back final and unbacked-up gets its ask from here (M1's reasoning, applied
  // to the banner).
  updateBackupReminder();
  if (gameIsFinal()) { renderFinalReadout(); return; }
  const lsInn = document.getElementById('ls-inning');
  const arrow = half.team === 'visiting' ? '▲' : '▼';
  if (lsInn) lsInn.textContent = arrow + ' ' + (getRealInning(half.team, half.innIdx) + 1);
}

/* The half-inning the card is furthest into: the highest column either side has a
   recorded play in, the home half winning a tie because it is played second.
   Returns null for an empty card.

   This is what "has the game reached its end" has to be asked about — the
   condition can't be applied to a half nobody has batted in, or a home team
   leading in the 5th would satisfy `halfEndsGame`'s home clause and the card would
   read FINAL in the middle of the game. */
function lastHalfWithPlays() {
  let lastTeam = null, lastInn = -1;
  ['visiting','home'].forEach(team => {
    const players = gameState.teams[team].players;
    for (let col = INNINGS - 1; col >= 0; col--) {
      if (col < lastInn) break;
      const played = players.some(pl => pl.atBats[col] && pl.atBats[col].play);
      if (played && (col > lastInn || team === 'home')) { lastInn = col; lastTeam = team; }
    }
  });
  return lastTeam === null ? null : { team: lastTeam, innIdx: lastInn };
}

/* Is this card a finished game? Derived from the records and the line every time
   it is asked, not from the memory-only `gameOverShown` flag — so it survives a
   reload, and an edit that puts the score back to a tie takes FINAL away again
   without anything having to remember to clear it (M1). */
function gameIsFinal() {
  const half = lastHalfWithPlays();
  if (!half) return false;
  return halfEndsGame(half.team, getRealInning(half.team, half.innIdx), getInnState(half.team, half.innIdx).outs);
}

/* Say once that the card being written to is a finished game. Nothing locked the
   card after a walk-off, so another home run was accepted and quietly moved R from
   1 to 2 with no sign anything unusual had happened (M1).

   Warn, don't refuse (D6): a scorer does sometimes have to correct a final card,
   and this app's standing policy is to record what happened rather than argue. The
   caveat is the whole point, so it goes on the *accepted* path, before the play
   lands — `gameIsFinal()` is about to be true either way, and what the scorer needs
   told is that it was already true before they typed.

   One notice per final game, and it re-arms itself: an entry made while the game is
   not final clears the flag here, so a card corrected back to a live game and then
   finished again gets a fresh warning. That is why there is nothing to reset
   alongside `gameOverShown`. */
let finalNoticeShown = false;

function noteEntryAfterFinal() {
  if (!gameIsFinal()) { finalNoticeShown = false; return; }
  if (finalNoticeShown) return;
  finalNoticeShown = true;
  showPlayNotice('Game is final — recording anyway.');
}

/* The last step of scoring a game: get it off this device.

   A finished card lives in one browser's `localStorage` and nowhere else until it is
   exported, and nothing ever said so — the scorer with the best possible reason to
   care (the game is over, the record is complete) was the one least likely to think
   of it. So the banner asks, once the game is final, and stops asking as soon as a
   file exists.

   Derived like FINAL and the linescore's X, from the records rather than a flag: a
   score corrected back to a tie takes the banner away, and any later change to the
   card brings it back, because the file no longer matches what is on the screen.
   `backedUp` is persisted; the dismissal is not — "Not now" holds for this session,
   and a reload of a card that still has no backup asks again. That is the point of
   it. */
let backupPromptDismissed = false;

function updateBackupReminder() {
  const el = document.getElementById('backup-reminder');
  if (!el) return;
  const ask = gameIsFinal() && !gameState.backedUp && !backupPromptDismissed;
  el.style.display = ask ? 'flex' : 'none';
}

function dismissBackupReminder() {
  backupPromptDismissed = true;
  updateBackupReminder();
}

/* The exported file no longer matches the card. Called from the two tails every
   scoring change ends in, so the prompt re-arms on a correction — but not on typing
   the attendance or a player's name, which don't change what was scored. */
function noteCardChanged() {
  if (gameState.backedUp) gameState.backedUp = false;
}

/* The live panel, for a game that is over. Nothing is at bat, nobody is on, and
   the count slot shows the final score instead. */
function renderFinalReadout() {
  const lsInn = document.getElementById('ls-inning');
  const lsCount = document.getElementById('ls-count');
  const lsBatter = document.getElementById('ls-batter');
  const lsPitcher = document.getElementById('ls-pitcher');
  const lsPitches = document.getElementById('ls-pitches');
  if (lsInn) lsInn.textContent = 'FINAL';
  if (lsCount) lsCount.textContent = runsOnLine('visiting') + '-' + runsOnLine('home');
  if (lsBatter) { lsBatter.textContent = ''; fitName(lsBatter); }
  if (lsPitcher) { lsPitcher.textContent = ''; fitName(lsPitcher); }
  if (lsPitches) lsPitches.textContent = '';
  for (let i = 1; i <= 3; i++) {
    const od = document.getElementById('ls-out-' + i);
    if (od) od.classList.remove('active');
  }
  ['ls-b1','ls-b2','ls-b3'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.setAttribute('fill', 'rgba(255,255,255,0.2)');
  });
}

/* Runner events (mid-at-bat, don't end the at-bat) */
/* Specific SB/CS base prompts */
function promptSBBase() {
  if (!selectedCell) return;
  const team = selectedCell.dataset.team;
  const innIdx = parseInt(selectedCell.dataset.inn);
  const inn = getInnState(team, innIdx);
  const options = [];
  // Only offer a steal the runner can actually complete (#4): nobody may be standing
  // on the base he's taking or on one he'd have to run through. With runners on 1st
  // and 2nd the lead runner steals 3rd first — the trailing man has nowhere to go
  // until he does, so a double steal is entered as two events.
  const canGo = (from, dest) => runnerPathClear(inn, from, dest, inn.bases[from]);
  if (inn.bases[1] !== null) {
    if (canGo(1, 2)) options.push({from: 1, label: 'SB3 (2nd→3rd)'});
    if (canGo(1, 3)) options.push({from: 1, label: 'SB3+E (2nd→Home)', extra: 'error'});
  }
  if (inn.bases[0] !== null) {
    if (canGo(0, 1)) options.push({from: 0, label: 'SB2 (1st→2nd)'});
    if (canGo(0, 2)) options.push({from: 0, label: 'SB2+E (1st→3rd)', extra: 'error'});
  }
  if (inn.bases[2] !== null) {
    options.push({from: 2, label: 'SBH (3rd→Home)'});
  }
  // Nobody on is a different thing from nobody who can go, and only the first has a
  // sentence written for it (m2). A blocked steal already explains itself through
  // applySBAtBase; a press with the bases empty used to do nothing and say nothing.
  if (options.length === 0) { showPlayReject(NOTHING_TO_MOVE.SB); return; }
  if (options.length === 1) { applySBAtBase(team, innIdx, options[0].from, false); return; }
  showBasePickerPopup('Stolen Base', options, function(from, extra) { applySBAtBase(team, innIdx, from, extra === 'error'); });
}

function applySBAtBase(team, innIdx, fromBase, withError) {
  const inn = getInnState(team, innIdx);
  // #3: the half-inning is over — a stranded runner can't steal, least of all
  // steal home and put a run on the board. The picker still offers him, because he
  // is still standing there, so the refusal has to explain itself (L2).
  if (inn.outs >= 3) { showPlayReject(INNING_OVER); return; }
  if (inn.bases[fromBase] === null) return;
  const rn = inn.bases[fromBase];
  const dest = withError ? Math.min(fromBase + 2, 3) : fromBase + 1;
  // The picker doesn't offer a blocked steal, so this is the guard for a hotkey
  // firing on state the picker never saw. Refuse before the undo snapshot.
  if (!runnerPathClear(inn, fromBase, dest, rn)) {
    const blocked = fromBase + 1 <= 2 && !baseFreeFor(inn, fromBase + 1, rn) ? fromBase + 1 : Math.min(dest, 2);
    reportRunnerCollision(blocked, inn.bases[blocked], rn);
    return;
  }
  const pIdx = selectedCell ? parseInt(selectedCell.dataset.p) : 0;
  pushUndo(team, pIdx, innIdx);
  const rab = runnerAtBat(team, rn);
  if (!rab) return;
  if (!moveRunnerTo(inn, fromBase, dest, rn)) return;
  for (let step = fromBase + 1; step <= dest; step++) {
    rab.bases[step] = true;
    setAdvReason(rab, step, step === fromBase + 1 ? 'SB' : 'E');
  }
  // Rule 9.16: the extra base came on a throwing error, so a run this runner goes
  // on to score is unearned — and the inning is one a human should review (#13).
  if (withError && dest > fromBase + 1) rab.reachedOnError = true;
  renderDiamond(team, rn.p, rn.col);
  afterStateChange(team, innIdx);
}

function promptCSBase() {
  if (!selectedCell) return;
  const team = selectedCell.dataset.team;
  const innIdx = parseInt(selectedCell.dataset.inn);
  const inn = getInnState(team, innIdx);
  const options = [];
  if (inn.bases[2] !== null) options.push({from: 2, label: 'CS Home'});
  if (inn.bases[1] !== null) options.push({from: 1, label: 'CS 3rd'});
  if (inn.bases[0] !== null) options.push({from: 0, label: 'CS 2nd'});
  // Empty only when the bases are — every runner is somebody to catch stealing (m2).
  if (options.length === 0) { showPlayReject(NOTHING_TO_MOVE.CS); return; }
  if (options.length === 1) { applyCSAtBase(team, innIdx, options[0].from); return; }
  showBasePickerPopup('Caught Stealing', options, function(from) { applyCSAtBase(team, innIdx, from); });
}

function applyCSAtBase(team, innIdx, fromBase) {
  const inn = getInnState(team, innIdx);
  // #2: no 4th out — the guard applyRunnerEvent has always had.
  if (inn.outs >= 3) { showPlayReject(INNING_OVER); return; }
  if (inn.bases[fromBase] === null) return;
  const pIdx = selectedCell ? parseInt(selectedCell.dataset.p) : 0;
  pushUndo(team, pIdx, innIdx);
  const rn = inn.bases[fromBase];
  const rab = runnerAtBat(team, rn);
  if (!rab) return;
  // The out is logged against the runner's own cell, with the pitcher who threw
  // it. `rab.pitcher` is left alone on purpose: it records the pitcher the runner
  // *batted* against, which is who owes the hit and the run — overwriting it here
  // moved both to whoever happened to be on the mound for the steal attempt.
  const n = recordOut(team, innIdx, { kind: 'runner', pIdx: rn.p, col: rn.col });
  if (!n) return;
  rab.out = n;
  rab.outOnBase = fromBase + 1;
  setAdvReason(rab, fromBase + 1, 'CS');
  renderDiamond(team, rn.p, rn.col);
  renderOut(team, rn.p, rn.col);
  clearRunner(inn, fromBase);
  // A CS can make the 3rd out; afterStateChange ends the half-inning (or the
  // game) from there, and markNextInningLeadoff works the order out from lastPA.
  afterStateChange(team, innIdx);
}

function promptPickoff() {
  if (!selectedCell) return;
  const team = selectedCell.dataset.team;
  const innIdx = parseInt(selectedCell.dataset.inn);
  const inn = getInnState(team, innIdx);
  const destNames = ['2nd', '3rd', 'Home'];
  const baseNames = ['1st', '2nd', '3rd'];
  const options = [];
  for (let b = 0; b < 3; b++) {
    if (inn.bases[b] !== null) {
      options.push({from: b, label: 'PO ' + baseNames[b] + ' — Out'});
      // The error variant moves him up a base; don't offer it into an occupied one (#4).
      if (b + 1 > 2 || inn.bases[b + 1] === null) {
        options.push({from: b, label: 'PO ' + baseNames[b] + ' — Error (→' + destNames[b] + ')', extra: 'error'});
      }
    }
  }
  // Likewise: every runner can be picked off, so an empty list means an empty diamond.
  if (options.length === 0) { showPlayReject(NOTHING_TO_MOVE.PO); return; }
  showBasePickerPopup('Pickoff', options, function(from, extra) { applyPickoff(team, innIdx, from, extra === 'error'); });
}

function applyPickoff(team, innIdx, atBase, withError) {
  const inn = getInnState(team, innIdx);
  // #2: no 4th out, and no advancing a stranded runner on the error variant.
  if (inn.outs >= 3) { showPlayReject(INNING_OVER); return; }
  if (inn.bases[atBase] === null) return;
  const rn = inn.bases[atBase];
  // Same as applySBAtBase: the picker won't offer a blocked advance, so this catches
  // the paths that bypass it. Refuse before the undo snapshot.
  if (withError && !baseFreeFor(inn, atBase + 1, rn)) {
    reportRunnerCollision(atBase + 1, inn.bases[atBase + 1], rn);
    return;
  }
  const pIdx = selectedCell ? parseInt(selectedCell.dataset.p) : 0;
  pushUndo(team, pIdx, innIdx);
  const rab = runnerAtBat(team, rn);
  if (!rab) return;
  if (withError) {
    const dest = atBase + 1;
    if (!moveRunnerTo(inn, atBase, dest, rn)) return;
    rab.bases[dest] = true;
    setAdvReason(rab, dest, 'E');
    // Same as the SB+E path: he advanced on the error, so the run is unearned (#13).
    rab.reachedOnError = true;
    renderDiamond(team, rn.p, rn.col);
  } else {
    // See applyCSAtBase: the out's pitcher lives in the log, `rab.pitcher` keeps
    // pointing at the pitcher the runner reached base against.
    const n = recordOut(team, innIdx, { kind: 'runner', pIdx: rn.p, col: rn.col });
    if (!n) return;
    rab.out = n;
    rab.outOnBase = atBase;
    setAdvReason(rab, atBase, 'PO');
    renderDiamond(team, rn.p, rn.col);
    renderOut(team, rn.p, rn.col);
    clearRunner(inn, atBase);
  }
  afterStateChange(team, innIdx);
}

function showBasePickerPopup(title, options, callback) {
  let popup = document.getElementById('base-picker');
  if (!popup) {
    popup = document.createElement('div');
    popup.id = 'base-picker';
    popup.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:var(--card);border:3px solid var(--navy);border-radius:10px;padding:16px 20px;z-index:300;box-shadow:0 8px 40px rgba(26,39,68,0.4);text-align:center;font-family:var(--heading);';
    document.body.appendChild(popup);
  }
  let html = '<div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--navy);margin-bottom:12px">' + title + '</div>';
  html += '<div style="display:flex;flex-direction:column;gap:6px">';
  options.forEach(o => {
    const isError = o.extra === 'error';
    const bg = isError ? 'var(--accent)' : 'var(--navy)';
    const fg = isError ? '#fff' : 'var(--gold)';
    html += '<button class="bp-opt" data-from="' + o.from + '" data-extra="' + (o.extra || '') + '" style="padding:8px 20px;font-size:13px;font-weight:600;font-family:var(--heading);background:' + bg + ';color:' + fg + ';border:none;border-radius:5px;cursor:pointer;letter-spacing:0.5px">' + o.label + '</button>';
  });
  html += '</div>';
  popup.innerHTML = html;
  popup.style.display = 'block';
  popup.querySelectorAll('.bp-opt').forEach(btn => {
    btn.onclick = function() {
      popup.style.display = 'none';
      callback(parseInt(this.dataset.from), this.dataset.extra || '');
    };
  });
}

/* Why each of these needs somebody on base, in the words a scorer would use. Rule
   9.13 charges a wild pitch or a passed ball only when a runner advances on it, and
   6.02(a) makes a balk with the bases empty a ball to the batter — so with nobody on
   there is no runner event to write, and the card has nowhere to write one. The
   steal and pickoff entries belong to promptSBBase / promptCSBase / promptPickoff,
   which own those paths (m2) and used to answer an empty set of bases with silence. */
const NOTHING_TO_MOVE = {
  WP: 'Nobody on — a wild pitch is only charged when a runner advances.',
  PB: 'Nobody on — a passed ball is only charged when a runner advances.',
  BK: 'Nobody on — a balk with the bases empty is a ball to the batter.',
  SB: 'Nobody on — no runner to steal a base.',
  CS: 'Nobody on — no runner to catch stealing.',
  PO: 'Nobody on — no runner to pick off.',
  // Move and Rnrs, the two manual paths. Both used to answer an empty diamond with
  // silence: Move returned bare (L2) and Rnrs opened a popup that called straight
  // back with nothing, having already pushed an undo snapshot (L1).
  MV: 'Nobody on — no runner to move.'
};

// Rule 9.13 from the other side: the event is charged *for* the advance, so a set
// of choices in which every runner held his base is not a wild pitch or a passed
// ball at all.
const NOTHING_MOVED = {
  WP: 'Nobody moved — a wild pitch is only charged when a runner advances.',
  PB: 'Nobody moved — a passed ball is only charged when a runner advances.'
};

const RUNNER_EVENT_TITLE = {
  WP: 'Wild Pitch — Who Moved',
  PB: 'Passed Ball — Who Moved'
};

/* A wild pitch, a passed ball or a balk, and who it moved.

   m1: with more than one man on, this decided that for the scorer — everybody up
   exactly one base, no choice offered. A ball to the backstop that only the runner
   on 3rd could score on was enterable one way, and it was the wrong one. A wild
   pitch or a passed ball now asks, through the same advancement popup every other
   multi-runner play uses; its "Out at" options also cover the man thrown out trying
   for the extra base, which the bulk advance had no way to write.

   A balk is not a judgement call — rule 6.02(a) awards every runner one base — so BK
   keeps the forced advance and asks nothing. One runner on is likewise applied
   straight, the way promptSBBase applies its single option: he is the runner the
   event is charged for, and one base is where he goes. */
function applyRunnerEvent(type) {
  if (!selectedCell) return;
  const team = selectedCell.dataset.team;
  const pIdx = parseInt(selectedCell.dataset.p);
  const innIdx = parseInt(selectedCell.dataset.inn);
  const inn = getInnState(team, innIdx);
  if (inn.outs >= 3) { showPlayReject(INNING_OVER); return; }
  // L1: with the bases empty every branch below is a no-op, and the old code ran
  // them all anyway — after pushing an undo snapshot. Two presses of BK left two
  // dead presses of Undo between the scorer and the last play that really happened.
  // Refused, and named, rather than silently recorded as nothing (D11).
  if (inn.bases.every(b => b === null)) {
    showPlayReject(NOTHING_TO_MOVE[type] || 'Nobody is on base.');
    return;
  }
  // One man on, or a balk: nothing to ask, so nothing is asked.
  const onBase = inn.bases.filter(b => b !== null).length;
  if (onBase === 1 || type === 'BK') {
    pushUndo(team, pIdx, innIdx);
    const before = inn.bases.slice();
    advanceRunners(team, innIdx, 1, type);
    flagRunnersMovedByPassedBall(team, innIdx, type, before);
    afterStateChange(team, innIdx);
    return;
  }
  showRunnerPopup(team, innIdx, 0, function (choices) {
    // Nothing is written until the choices are in, so both the refusal below and a
    // popup the scorer walks away from leave the card and the undo stack alone.
    const moved = [0, 1, 2].some(b => inn.bases[b] !== null &&
      choices[b] !== undefined && choices[b] !== b);
    if (!moved) { showPlayReject(NOTHING_MOVED[type] || 'Nobody was moved.'); return; }
    pushUndo(team, pIdx, innIdx);
    const before = inn.bases.slice();
    applyChosenAdvancements(team, innIdx, choices, type);
    flagRunnersMovedByPassedBall(team, innIdx, type, before);
    afterStateChange(team, innIdx);
  }, { title: RUNNER_EVENT_TITLE[type] });
}

// Rule 9.16: a run that scores as a result of a passed ball is unearned (a wild
// pitch is the pitcher's own doing, and so is a balk, so both are right to do
// nothing here). This used to flag only the runner on 3rd, so a man moved up from
// 1st or 2nd by the same passed ball scored as an earned run later (#14). Flag
// whoever the ball actually moved, `before` against the bases now — a runner it
// couldn't advance keeps his own reckoning, and one thrown out on it has no run to
// reckon with.
function flagRunnersMovedByPassedBall(team, innIdx, type, before) {
  if (type !== 'PB') return;
  const inn = getInnState(team, innIdx);
  for (let b = 0; b < 3; b++) {
    const rn = before[b];
    if (!rn || sameRunner(inn.bases[b], rn)) continue;
    const rab = runnerAtBat(team, rn);
    if (rab && rab.outOnBase == null) rab.reachedOnError = true;
  }
}

/* Undo / Redo */
let playHistory = [];
let redoHistory = [];
let gameOverShown = false;
let pendingTransitionTimer = null;

function pushUndo(team, pIdx, innIdx) {
  redoHistory.length = 0;
  playHistory.push(snapshotForRedo(team, pIdx, innIdx));
}

function snapshotForRedo(team, pIdx, innIdx) {
  const prevTab = document.querySelector('.tab-btn.active')?.dataset.tab;
  // Full batter row across all innings — captures multi-column mutations (e.g. sub
  // lines) that span past the inning captureInning covers.
  const prevPlayerAbs = JSON.parse(JSON.stringify(gameState.teams[team].players[pIdx].atBats));
  return { team, pIdx, innIdx, prev: captureInning(team, innIdx), prevPlayerAbs, prevTab };
}

// Restore a player's entire at-bat row (all innings) and re-render every cell.
// Needed for mutations that span multiple inning columns (e.g. substitution lines).
function restorePlayerRow(team, pIdx, prevAbs) {
  const abs = gameState.teams[team].players[pIdx].atBats;
  const n = Math.min(abs.length, prevAbs.length);
  for (let c = 0; c < n; c++) {
    assignOver(abs[c], prevAbs[c]);
    renderDiamond(team, pIdx, c);
    renderOut(team, pIdx, c);
    renderPlayText(team, pIdx, c);
    renderPitches(team, pIdx, c);
    renderPitcherChange(team, pIdx, c);
  }
}

function restoreSnapshot(snap) {
  const { team, pIdx, innIdx } = snap;
  // First, before anything reads a column: take back the column the play
  // inserted. The snapshot's own `cols` were worked out before it existed (M4).
  if (snap.insertedCol !== undefined) {
    shiftColumnsLeft(team, snap.insertedCol);
    updateColumnHeaders(team);
    refreshCellAria(team);
  }
  restoreInning(team, snap.prev);
  // Restore the batter's full row so multi-column mutations (sub lines) revert.
  if (snap.prevPlayerAbs) restorePlayerRow(team, pIdx, snap.prevPlayerAbs);
  renderInning(team, snap.prev);
  // The snapshot has already reinstated the outs and bases, so this mostly
  // confirms them — and puts right anything the play changed in a column the
  // snapshot didn't cover (one the batting order wrapped into after it was taken).
  recomputeInning(team, getRealInning(team, innIdx));
  updateSprayMini();
  const cell = document.querySelector(`.at-bat-cell[data-team="${team}"][data-p="${pIdx}"][data-inn="${innIdx}"]`);
  if (cell) selectCell(cell);
  if (snap.prevTab) switchTab(snap.prevTab);
  updatePlayerStats(team);
  updatePitcherStats(team);
  updateSituation();
  autoSave();
}

function undoLastPlay() {
  if (pendingEntryPopupOpen()) { showPlayReject('Finish or close the open entry first.'); return; }
  dismissSprayPopup();
  if (pendingTransitionTimer) { clearTimeout(pendingTransitionTimer); pendingTransitionTimer = null; }
  gameOverShown = false;
  // The history lives in memory only (D9), so a reload empties it. Say so rather
  // than reading as a dead button, and point at the tool that does still work.
  if (!playHistory.length) {
    showPlayReject('Nothing to undo — undo covers this session only. Clear the cell instead.');
    return;
  }
  const last = playHistory[playHistory.length - 1];
  // A play that inserted a column can't be redone. The redo snapshot is taken with
  // the column still in place, so putting those at-bats back after the undo has
  // removed it would write them into whatever now occupies that column — which,
  // when a later inning had been recorded there, is that inning. Undo is the
  // direction that has to be right; redo gives up rather than guess (M4).
  if (last.insertedCol === undefined) {
    redoHistory.push(snapshotForRedo(last.team, last.pIdx, last.innIdx));
  } else {
    redoHistory.length = 0;
  }
  playHistory.pop();
  restoreSnapshot(last);
}

function redoLastPlay() {
  if (pendingEntryPopupOpen()) { showPlayReject('Finish or close the open entry first.'); return; }
  dismissSprayPopup();
  // The app's own policy: a press that changes nothing says why (L3). Undo has had
  // a sentence for exactly this case since audit 3; this one returned bare.
  if (!redoHistory.length) {
    showPlayReject('Nothing to redo — redo only follows an undo, and both cover this session only.');
    return;
  }
  const next = redoHistory[redoHistory.length - 1];
  const undo = snapshotForRedo(next.team, next.pIdx, next.innIdx);
  playHistory.push(undo);
  redoHistory.pop();
  restoreSnapshot(next);
  /* The tail every other mutator ends in (M2). `restoreSnapshot` puts the data
     back correctly — outs, bases, runs, LOB and both stat tables — and stops
     there, so a redone third out left the half-inning open: no side change, no
     leadoff, and every further entry refused as "3 outs". A redone walk-off left
     `gameOverShown` false while the card read FINAL. Audit 3's Family A closed
     this same hole for `editRunners` and `moveRunner`.

     The selection moves on only if what was redone was a completed plate
     appearance, which is exactly what `inn.lastPA` records. A redone steal or
     runner edit leaves the same batter standing at the plate, as it does the
     first time round. */
  const inn = getInnState(next.team, next.innIdx);
  const wasPA = !!(inn.lastPA && inn.lastPA.pIdx === next.pIdx && inn.lastPA.col === next.innIdx);
  afterStateChange(next.team, next.innIdx, { advanceBatter: wasPA });
}

/* Feature 2: Edit play type — swap play on completed cell, re-prompt runners */
function editPlayType() {
  if (!selectedCell) return;
  const team = selectedCell.dataset.team;
  const pIdx = parseInt(selectedCell.dataset.p);
  const innIdx = parseInt(selectedCell.dataset.inn);
  const ab = gameState.teams[team].players[pIdx].atBats[innIdx];
  if (!ab.play) return;
  let popup = document.getElementById('edit-play-popup');
  if (!popup) {
    popup = document.createElement('div');
    popup.id = 'edit-play-popup';
    popup.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:var(--card);border:3px solid var(--navy);border-radius:10px;padding:16px 20px;z-index:300;box-shadow:0 8px 40px rgba(26,39,68,0.4);min-width:280px;font-family:var(--font);';
    document.body.appendChild(popup);
  }
  const plays = ['1B','2B','3B','HR','K','ꓘ','BB','IBB','HBP','SF','SH','CI','IF','K+WP','E'];
  let html = '<div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--navy);margin-bottom:10px;font-family:var(--heading)">Change Play Type</div>';
  html += '<div style="font-size:11px;color:var(--text-light);margin-bottom:8px">Current: <b>' + ab.play + '</b> — pitches kept</div>';
  html += '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px">';
  plays.forEach(p => {
    const isCur = p === ab.play;
    html += '<button class="ep-btn" data-play="' + p + '" style="padding:4px 10px;font-size:11px;font-weight:600;border:1.5px solid ' + (isCur ? 'var(--navy)' : '#ccc') + ';border-radius:4px;background:' + (isCur ? 'var(--navy)' : '#fff') + ';color:' + (isCur ? 'var(--gold)' : '#555') + ';cursor:pointer;font-family:var(--mono)">' + p + '</button>';
  });
  html += '</div>';
  html += '<div style="display:flex;gap:4px;margin-bottom:6px"><span style="font-size:10px;color:var(--text-light)">Or position play:</span>';
  html += '<input id="ep-custom" type="text" maxlength="10" placeholder="GO 6-3, DP 6-4-3, FC 6..." style="flex:1;font-size:11px;font-family:var(--mono);padding:3px 6px;border:1.5px solid #ccc;border-radius:4px">';
  html += '</div>';
  html += '<div style="display:flex;gap:6px"><button id="ep-confirm" style="flex:1;padding:6px;font-size:12px;font-weight:700;background:var(--navy);color:var(--gold);border:none;border-radius:4px;cursor:pointer;font-family:var(--heading);text-transform:uppercase">Apply</button>';
  html += '<button id="ep-cancel" style="padding:6px 12px;font-size:12px;border:1px solid #ccc;border-radius:4px;background:#f5f5f5;cursor:pointer">Cancel</button></div>';
  popup.innerHTML = html;
  popup.style.display = 'block';
  let chosen = ab.play;
  popup.querySelectorAll('.ep-btn').forEach(btn => {
    btn.onclick = function() {
      chosen = this.dataset.play;
      document.getElementById('ep-custom').value = '';
      popup.querySelectorAll('.ep-btn').forEach(b => { b.style.borderColor = '#ccc'; b.style.background = '#fff'; b.style.color = '#555'; });
      this.style.borderColor = 'var(--navy)'; this.style.background = 'var(--navy)'; this.style.color = 'var(--gold)';
    };
  });
  document.getElementById('ep-cancel').onclick = function() { popup.style.display = 'none'; };
  document.getElementById('ep-confirm').onclick = function() {
    // Normalize a typed "GO 6-3" the same way the position popup does (#15).
    const custom = normalizePlayCode(document.getElementById('ep-custom').value.trim());
    const newPlay = custom || chosen;
    if (!newPlay || newPlay === ab.play) { popup.style.display = 'none'; return; }
    const realInn = getRealInning(team, innIdx);
    const inn = getInnState(team, innIdx);
    const nowOut = isOutPlay(newPlay) || newPlay === 'K' || newPlay === 'ꓘ';
    // #8: turning an on-base play into an out used to push the inning to 4 outs.
    // Checked here rather than after the take-back below because it costs nothing
    // to work out in advance, and the popup stays open on a refusal: the outs this
    // cell's own play made are about to come off, so they aren't in its way.
    const myOuts = outsFromPlay(inn, pIdx, innIdx).length || (ab.out ? (ab.outsRecorded || 1) : 0);
    if (nowOut && Math.max(0, inn.outs - myOuts) >= 3) {
      showPlayReject(INNING_OVER);
      return;
    }
    popup.style.display = 'none';
    pushUndo(team, pIdx, innIdx);
    const prev = captureInning(team, innIdx);

    /* Take the old play off the card, all of it. This used to adjust the batter's
       own bases and out and stop, so the runners it had moved stayed where it put
       them and the runners it doubled off stayed out (#22). Everything the play
       caused comes off, and then the new play is entered into the state that
       leaves — the same state a scorer would have been looking at. */
    takeBackPlay(team, innIdx, pIdx, myOuts);
    removeRunnerFromBases(inn, pIdx);
    ab.play = '';
    ab.bases = [false, false, false, false];
    ab.advReason = ['','','','']; ab.advSrc = null;
    ab.out = 0; ab.outsRecorded = 0; ab.dpOuts = null; ab.outOnBase = null;
    ab.rbi = 0; ab.reachedOnError = false;
    recomputeInning(team, realInn);

    // Now that the cell is empty, is the new play a legal entry here? These need
    // the taken-back state to judge (a DP is legal with 2 outs if one of them was
    // this cell's), so a refusal has to put back what the take-back removed —
    // which is what the snapshot pushed above is for.
    const rollback = function(msg) {
      restoreSnapshot(playHistory.pop());
      showPlayReject(msg);
    };
    const reject = playEntryReject(team, innIdx, newPlay);
    if (reject) { rollback(reject); return; }
    // #4: the new play has to have a base to put the batter on. Refuse the change
    // rather than evicting the runner standing there.
    if (!nowOut && (isHitPlay(newPlay) || ['BB','IBB','HBP','CI'].includes(newPlay)) && newPlay !== 'HR') {
      const HIT_DEST = { '1B': 0, 'E': 0, '2B': 1, '3B': 2 };
      const bDest = HIT_DEST[newPlay] !== undefined ? HIT_DEST[newPlay] : 0;
      if (!baseFreeFor(inn, bDest, runnerRef(pIdx, innIdx))) {
        rollback('Another runner is on ' + BASE_NAMES[bDest] + ' — move him first.');
        return;
      }
    }

    ab.play = newPlay;
    // The same dispatch a fresh entry runs, so the runners get re-asked (a single
    // rewritten as a double sends them further) and a home run brings them round.
    // The pitches and the pitcher faced are left as they were: this is a change of
    // what the play was, not a re-pitching of the at-bat.
    applyPlayEffects(team, pIdx, innIdx, newPlay, prev, function() {
      renderPlayText(team, pIdx, innIdx);
      renderOut(team, pIdx, innIdx);
      renderDiamond(team, pIdx, innIdx);
      renderRBI(team, pIdx, innIdx);
      // The same tail every other mutator runs (#RC-D). This used to recompute
      // and re-render on its own, so an edit that made the 3rd out left the half
      // -inning open and an edit that scored the winning run never ended the
      // game. No `advanceBatter`: changing what a play was is not a new plate
      // appearance, so the selection stays on the cell being edited.
      afterStateChange(team, innIdx);
    });
  };
}

/* Feature 3: Re-open runner popup to fix advancements.

   This is a correction to a plate appearance already on the card, so it is the
   same act `applyPlayEffects` performs on entry and it ends the same way (C3).
   It used to end at `updateInningRuns` and its own three updates, which left
   three holes:

   - `afterStateChange` never ran, so an out recorded here didn't end the
     half-inning. The card sat on a dead inning with three outs on it, refusing
     every further entry, and a run that put the home team ahead in the bottom of
     the last inning never ended the game.
   - no `src` was passed, so the advancement was stamped to no play. Nothing
     credited the RBI for a run the correction drove in, and — worse —
     `revertAdvancesFrom` had nothing to take back, so clearing the play the run
     was scored on left the run standing on the linescore.
   - `countRunnersScored` was never consulted, which is what the RBI comes from.

   `prev` is captured before the popup opens, the way `applyPlay` does it, so the
   RBI counts the runs this correction added rather than every run in the inning.
   An RBI the scorer has overridden with `adjustRBI` is left alone: the count only
   replaces it when the correction actually moved somebody home. */
function editRunners() {
  if (!selectedCell) return;
  const team = selectedCell.dataset.team;
  const pIdx = parseInt(selectedCell.dataset.p);
  const innIdx = parseInt(selectedCell.dataset.inn);
  const ab = gameState.teams[team].players[pIdx].atBats[innIdx];
  if (!ab.play) return;
  // H1: a correction to a half-inning that is already over can only do one of two
  // illegal things — score a stranded runner or record a 4th out — so it is refused
  // before the popup opens, the way `applyRunnerEvent` refuses. Asking the scorer
  // where three runners went and only then turning the whole answer down is a worse
  // way to say the same no. `applyChosenAdvancements` still holds the line for
  // whoever calls it next.
  const inn = getInnState(team, innIdx);
  if (inn.outs >= 3) { showPlayReject(INNING_OVER); return; }
  // L1: with nobody on, `showRunnerPopup` has nothing to ask and calls straight back
  // with `{}` — so this changed nothing, said nothing, and left an undo snapshot and
  // a cleared redo stack behind it: a dead Undo press between the scorer and the last
  // play that really happened. m1 fixed the same thing for `applyRunnerEvent`.
  if (inn.bases.every(b => b === null)) { showPlayReject(NOTHING_TO_MOVE.MV); return; }
  const batterLbl = getBatterLabel(team, pIdx, innIdx);
  const src = { pIdx, col: innIdx };
  const prev = captureInning(team, innIdx);
  showRunnerPopup(team, innIdx, 0, function(choices) {
    // The snapshot goes in here, once the choices are in, so a popup the scorer walks
    // away from leaves the undo stack alone (m1). Nothing can change the card while
    // it is open, so it is the same snapshot it always was.
    pushUndo(team, pIdx, innIdx);
    applyChosenAdvancements(team, innIdx, choices, batterLbl, src);
    // Rule 9.04(b) still applies to what the play was: a double play and a
    // K+WP drive in nobody however the runners moved.
    const scored = countRunnersScored(team, prev);
    const suppressed = ab.play === 'DP' || /^DP /.test(ab.play) || ab.play === 'K+WP' ||
      isErrorPlay(ab.play);
    if (scored && !suppressed) ab.rbi = (ab.rbi || 0) + scored;
    renderRBI(team, pIdx, innIdx);
    afterStateChange(team, innIdx);
  });
}

/* Feature 4: Manual runner move — pick a runner, move to any base */
function moveRunner() {
  if (!selectedCell) return;
  const team = selectedCell.dataset.team;
  const pIdx = parseInt(selectedCell.dataset.p);
  const innIdx = parseInt(selectedCell.dataset.inn);
  const inn = getInnState(team, innIdx);
  const baseNames = ['1st','2nd','3rd','Home'];
  const runners = [];
  for (let b = 0; b < 3; b++) {
    if (inn.bases[b] !== null) {
      const rn = inn.bases[b];
      const name = getActivePlayerName(team, rn.p, rn.col);
      runners.push({ base: b, pIdx: rn.p, name });
    }
  }
  // L2: the app's own policy — a press that changes nothing says why (NOTHING_TO_MOVE,
  // removePitch). This returned bare, so Move on an empty diamond was a dead press.
  if (runners.length === 0) { showPlayReject(NOTHING_TO_MOVE.MV); return; }
  let popup = document.getElementById('move-runner-popup');
  if (!popup) {
    popup = document.createElement('div');
    popup.id = 'move-runner-popup';
    popup.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:var(--card);border:3px solid var(--navy);border-radius:10px;padding:16px 20px;z-index:300;box-shadow:0 8px 40px rgba(26,39,68,0.4);min-width:260px;font-family:var(--font);';
    document.body.appendChild(popup);
  }
  let html = '<div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--navy);margin-bottom:10px;font-family:var(--heading)">Move Runner</div>';
  runners.forEach(r => {
    html += '<div style="margin-bottom:8px;padding:6px;background:var(--cream);border-radius:4px">';
    html += '<div style="font-size:11px;font-weight:600;margin-bottom:4px">' + escapeHtml(r.name) + ' <span style="color:var(--text-light)">(on ' + baseNames[r.base] + ')</span></div>';
    html += '<div style="display:flex;gap:4px">';
    for (let d = 0; d <= 3; d++) {
      if (d === r.base) continue;
      // This is the manual override, but it still can't put two men on one base (#4):
      // an occupied destination isn't offered. Move the other runner first.
      if (d < 3 && inn.bases[d] !== null) continue;
      html += '<button class="mr-btn" data-from="' + r.base + '" data-to="' + d + '" style="padding:3px 8px;font-size:10px;font-weight:600;border:1.5px solid #ccc;border-radius:3px;background:#fff;color:#555;cursor:pointer;font-family:var(--mono)">→ ' + baseNames[d] + '</button>';
    }
    // Was "Remove" — see the handler below (m3). It records the out it always was.
    html += '<button class="mr-btn mr-out" data-from="' + r.base + '" data-to="out" style="padding:3px 8px;font-size:10px;font-weight:600;border:1.5px solid var(--accent);border-radius:3px;background:#fff;color:var(--accent);cursor:pointer;font-family:var(--mono)">Out ' + baseNames[r.base] + '</button>';
    html += '</div></div>';
  });
  html += '<button data-act="hidePopupById" data-arg="move-runner-popup" style="margin-top:4px;width:100%;padding:5px;font-size:11px;border:1px solid #ccc;border-radius:4px;background:#f5f5f5;cursor:pointer">Close</button>';
  popup.innerHTML = html;
  popup.style.display = 'block';
  popup.querySelectorAll('.mr-btn').forEach(btn => {
    btn.onclick = function() {
      const from = parseInt(this.dataset.from);
      const to = this.dataset.to;
      const rn = inn.bases[from];
      if (rn === null) return;
      const isOut = to === 'out';
      const toBase = isOut ? null : parseInt(to);
      if (toBase !== null && !baseFreeFor(inn, toBase, rn)) {
        reportRunnerCollision(toBase, inn.bases[toBase], rn);
        return;
      }
      // H1: neither half of this popup works on a finished half-inning. The out
      // branch has always said so; the move branch walked a stranded runner home —
      // a run on the linescore, on the batter's R and on the pitcher's R and ER,
      // and a man dropped out of LOB, all after the third out. The runners are
      // still offered because they are still standing there, which is exactly why
      // the refusal has to explain itself (the base picker does the same).
      if (inn.outs >= 3) { showPlayReject(INNING_OVER); return; }
      // A man off the bases with no out to his name is the one thing this popup
      // could produce that the rest of the app cannot (m3): "Remove" wiped his
      // advancement, his out and his out-on-base and left the play, the hit and the
      // at-bat on the card with the runner accounted for nowhere — no out, not in
      // LOB, invisible to the linescore. The three ways off a base are to score, to
      // be put out, or to be left there when the half ends, and this is the second:
      // the out is recorded against his own cell, standing on the base he was on,
      // the way a pickoff records one. What the out *was* goes in the play text; an
      // entry made in error is undo's to take back, not this button's.
      pushUndo(team, pIdx, innIdx);
      const rab = runnerAtBat(team, rn);
      if (!rab) return;
      if (isOut) {
        const n = recordOut(team, innIdx, { kind: 'runner', pIdx: rn.p, col: rn.col });
        if (!n) return;
        rab.out = n;
        rab.outOnBase = from;
        setAdvReason(rab, from, 'OUT');
        clearRunner(inn, from);
      } else {
        if (!moveRunnerTo(inn, from, toBase, rn)) return;
        for (let step = from + 1; step <= toBase; step++) {
          rab.bases[step] = true;
          setAdvReason(rab, step, 'MV');
        }
      }
      renderDiamond(team, rn.p, rn.col);
      renderOut(team, rn.p, rn.col);
      popup.style.display = 'none';
      // The same tail every other mutator ends in (M1). This used to run
      // `updateInningRuns` and two of the updates by hand, and so a runner moved
      // home reached the linescore and the batter's own R without ever reaching
      // the pitcher who is charged with him; `inn.lob`, settled when the half
      // ended, went on counting a man who had scored; a move that put the home
      // team ahead in the bottom of the last inning didn't end the game; and the
      // backup prompt never re-armed. No `advanceBatter` — moving a runner is not
      // a plate appearance.
      afterStateChange(team, innIdx);
    };
  });
}

/* Feature 5: Clear play only, keep pitches */
function clearPlayKeepPitches() {
  if (!selectedCell) return;
  const team = selectedCell.dataset.team;
  const pIdx = parseInt(selectedCell.dataset.p);
  const innIdx = parseInt(selectedCell.dataset.inn);
  const ab = gameState.teams[team].players[pIdx].atBats[innIdx];
  if (!ab.play) return;
  pushUndo(team, pIdx, innIdx);
  const savedPitches = ab.pitches ? ab.pitches.slice() : [];
  if (savedPitches.length > 0) {
    const last = savedPitches[savedPitches.length - 1];
    if (last === 'H' || last === 'X') savedPitches.pop();
  }
  // This used to try to rebuild the inning from "the last undo snapshot" — which,
  // three lines after its own `pushUndo`, was the snapshot it had just taken. It
  // restored the state onto itself and the branch below, the one that does the
  // clearing, was unreachable: "Clear Play (Keep Pitches)" dropped the result pitch
  // and left the play, the runner and the out exactly where they were.
  //
  // No snapshot is needed. Clear the batter's own record, take back the outs and
  // the advancement the play produced, and let `recomputeInning` derive the rest.
  takeBackPlay(team, innIdx, pIdx, ab.outsRecorded || (ab.out ? 1 : 0));
  ab.play = '';
  ab.bases = [false, false, false, false];
  ab.out = 0; ab.outsRecorded = 0; ab.rbi = 0; ab.hitLoc = null;
  ab.dpOuts = null; ab.outOnBase = null;
  ab.advReason = ['','','','']; ab.reachedOnError = false;   // `seq` stays — see `finishPlay`
  ab.advSrc = null;
  // Re-apply saved pitches on the batter's at-bat
  ab.pitches = savedPitches;
  renderDiamond(team, pIdx, innIdx);
  renderOut(team, pIdx, innIdx);
  renderPlayText(team, pIdx, innIdx);
  renderPitches(team, pIdx, innIdx);
  renderPitcherChange(team, pIdx, innIdx);
  recomputeInning(team, getRealInning(team, innIdx));
  updateSprayMini();
  updatePlayerStats(team);
  updatePitcherStats(team);
  updateSituation();
  autoSave();
}

/* Feature 6: Re-open spray chart to reposition hit */
function editSprayChart() {
  if (!selectedCell) return;
  const team = selectedCell.dataset.team;
  const pIdx = parseInt(selectedCell.dataset.p);
  const innIdx = parseInt(selectedCell.dataset.inn);
  const ab = gameState.teams[team].players[pIdx].atBats[innIdx];
  // The other silent dead press (L3). The chart plots where the ball was hit, so
  // there has to be one on the cell — say that rather than ignoring the button.
  if (!ab.play || (!isHitPlay(ab.play) && !isErrorPlay(ab.play) && ab.play !== 'HR')) {
    showPlayReject('No hit on this cell — the spray chart plots hits and errors.');
    return;
  }
  showSprayChart(team, pIdx, innIdx);
}

/* Feature 7: Manual RBI adjustment */

// Every RBI charged to a team in one inning, across every column the inning spans.
function rbiInInning(team, realInn) {
  const players = gameState.teams[team].players;
  let total = 0;
  for (const col of getColumnsForInning(team, realInn)) {
    for (const player of players) total += (player.atBats[col].rbi || 0);
  }
  return total;
}

function adjustRBI(delta) {
  if (!selectedCell) return;
  const team = selectedCell.dataset.team;
  const pIdx = parseInt(selectedCell.dataset.p);
  const innIdx = parseInt(selectedCell.dataset.inn);
  const ab = gameState.teams[team].players[pIdx].atBats[innIdx];
  if (!ab.play) return;
  // An RBI is credited for a run, so a side can never be charged more of them than
  // it scored — and every run the inning produced is already on the card, which is
  // where the count comes from. The override used to take any number of presses (m4)
  // and the box score then read more RBI than R with nothing to say which was wrong.
  // Only the increment is checked: taking one off can't invent anything.
  if (delta > 0) {
    const realInn = getRealInning(team, innIdx);
    const runs = collectScoredRuns(team, realInn).length;
    const rbi = rbiInInning(team, realInn);
    if (rbi + delta > runs) {
      showPlayReject(runs === 0
        ? 'No runs scored this inning — an RBI needs a run to drive in.'
        : `This inning scored ${runs} run${runs === 1 ? '' : 's'} and ${rbi} of them are already driven in.`);
      return;
    }
  }
  pushUndo(team, pIdx, innIdx);
  ab.rbi = Math.max(0, (ab.rbi || 0) + delta);
  renderPlayText(team, pIdx, innIdx);
  updatePlayerStats(team);
  autoSave();
}

/* Feature 8: Earned/unearned run review (per-run, per-inning) */

// Collect every scored run for a batting team in a given real inning.
// Returns entries [{ team, pIdx, colIdx, ab }] in batting-order-ish column order.
// A batted-around inning spans several columns and they are all covered.
function collectScoredRuns(battingTeam, realInn) {
  const players = gameState.teams[battingTeam].players;
  const cols = getColumnsForInning(battingTeam, realInn);
  const runs = [];
  const scored = ab => ab.bases[0] && ab.bases[1] && ab.bases[2] && ab.bases[3] && ab.outOnBase == null;
  for (const col of cols) {
    for (let pIdx = 0; pIdx < players.length; pIdx++) {
      const ab = players[pIdx].atBats[col];
      if (scored(ab)) runs.push({ team: battingTeam, pIdx, colIdx: col, ab });
    }
  }
  return runs;
}

// An inning's earned-run count is "provisional" when it scored runs AND contains
// an error signal (error play, a run flagged reached-on-error via error/PB, or
// catcher's interference). The auto ER count can't apply the "inning would have
// ended but for the error" rule, so a human should confirm which runs are earned.
function inningErProvisional(battingTeam, realInn) {
  if (!collectScoredRuns(battingTeam, realInn).length) return false;
  const players = gameState.teams[battingTeam].players;
  const cols = getColumnsForInning(battingTeam, realInn);
  // An 'E' advancement reason is the third signal: a runner moved up by a throwing
  // error on a steal or a pickoff leaves no error play on any cell, so without this
  // the inning read as clean and never asked for review (#13).
  const hasSignal = ab => ab.reachedOnError || isErrorPlay(ab.play) || ab.play === 'CI' ||
    (Array.isArray(ab.advReason) && ab.advReason.includes('E'));
  for (const col of cols) {
    for (const player of players) {
      if (hasSignal(player.atBats[col])) return true;
    }
  }
  return false;
}

function describeReach(ab) {
  const p = ab.play || '';
  if (isErrorPlay(p)) return 'reached on error';
  if (p === '1B') return 'single';
  if (p === '2B') return 'double';
  if (p === '3B') return 'triple';
  if (p === 'HR') return 'home run';
  if (p === 'BB') return 'walk';
  if (p === 'IBB') return 'intentional walk';
  if (p === 'HBP') return 'hit by pitch';
  if (p === 'FC') return "fielder's choice";
  if (p === 'CI') return "catcher's interference";
  if (ab.reachedOnError) return 'reached (unearned)';
  if (p) return p;
  return 'reached base';
}

// Backing list for the review popup so onclick can address the exact at-bat.
let erReviewList = [];

function reviewEarnedRuns() {
  if (!selectedCell) return;
  const team = selectedCell.dataset.team;
  const innIdx = parseInt(selectedCell.dataset.inn);
  const realInn = getRealInning(team, innIdx);
  erReviewList = collectScoredRuns(team, realInn);

  let popup = document.getElementById('er-review-popup');
  if (!popup) {
    popup = document.createElement('div');
    popup.id = 'er-review-popup';
    popup.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:var(--card,#fff);border:2px solid var(--navy,#1a2744);border-radius:8px;padding:14px 16px;z-index:400;box-shadow:0 8px 40px rgba(0,0,0,0.35);min-width:280px;max-width:360px;font-family:var(--font)';
    document.body.appendChild(popup);
  }

  const teamName = (team === 'visiting' ? gameState.info.visitingTeam : gameState.info.homeTeam) || (team === 'visiting' ? 'Visiting' : 'Home');
  let html = `<div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--navy,#1a2744);margin-bottom:8px">Earned Run Review — ${escapeHtml(teamName)}, Inn ${realInn + 1}</div>`;

  if (!erReviewList.length) {
    html += '<div style="font-size:12px;color:var(--text-light,#666);margin-bottom:10px">No runs scored in this inning.</div>';
  } else {
    if (inningErProvisional(team, realInn)) {
      html += '<div style="font-size:11px;color:var(--accent,#c41e3a);margin-bottom:10px;line-height:1.4">This inning had an error, passed ball, or interference. Mark any run that would <b>not</b> have scored without it as <b>unearned</b>.</div>';
    }
    erReviewList.forEach((r, i) => {
      // Three things this got wrong (L1). The man is the one who *ran*, not the one
      // who batted, which is the distinction `runRowOf` exists for — a pinch
      // runner's run was credited to the man he came in for. The name comes off the
      // inputs, so one typed inside the 400ms save debounce is not "Pos 1". And an
      // unnamed row is numbered by batting spot: rows are `spot * ROWS_PER_POS`, so
      // the old row-index fallback called the 4th spot's starter "Batter 10".
      // `rowLabel` does all three.
      const label = rowLabel(team, r.pIdx + runRowOf(r.ab));
      const unearned = !!r.ab.reachedOnError;
      html += '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 0;border-top:1px solid var(--border-light,#ddd)">';
      html += `<div style="font-size:12px;line-height:1.3"><div style="font-weight:600">${escapeHtml(label)}</div><div style="font-size:10px;color:var(--text-light,#666)">${escapeHtml(describeReach(r.ab))}</div></div>`;
      html += '<div style="display:flex;gap:4px;flex:0 0 auto">';
      html += `<button data-act="markRunEarned" data-argnum="${i}" style="padding:5px 9px;font-size:11px;font-weight:700;border:1.5px solid ${!unearned ? '#1565c0' : '#ccc'};border-radius:4px;background:${!unearned ? '#e3f2fd' : '#fff'};color:${!unearned ? '#1565c0' : '#666'};cursor:pointer">Earned</button>`;
      html += `<button data-act="markRunUnearned" data-argnum="${i}" style="padding:5px 9px;font-size:11px;font-weight:700;border:1.5px solid ${unearned ? 'var(--accent,#c41e3a)' : '#ccc'};border-radius:4px;background:${unearned ? '#fdecef' : '#fff'};color:${unearned ? 'var(--accent,#c41e3a)' : '#666'};cursor:pointer">Unearned</button>`;
      html += '</div></div>';
    });
  }
  html += '<button data-act="hidePopupById" data-arg="er-review-popup" style="margin-top:10px;width:100%;padding:6px;font-size:12px;border:1px solid #ccc;border-radius:4px;background:#f5f5f5;cursor:pointer">Done</button>';

  popup.innerHTML = html;
  popup.style.display = 'block';
}

function setRunEarnedByIndex(idx, unearned) {
  const entry = erReviewList[idx];
  if (!entry) return;
  const ab = entry.ab;
  if (!!ab.reachedOnError === !!unearned) return; // no change
  pushUndo(entry.team, entry.pIdx, entry.colIdx);
  ab.reachedOnError = !!unearned;
  renderDiamond(entry.team, entry.pIdx, entry.colIdx);
  updatePitcherStats(entry.team);
  autoSave();
  reviewEarnedRuns(); // rebuild popup to reflect the new state
}

function clearSelectedCell() {
  if (!selectedCell) return;
  // The last hole in the C1 guard family. Clear is reachable past the backdrop
  // through the `c` hotkey, and it deleted the play a pending runner/outcome popup
  // was still deciding — leaving the popup up over a cell with nothing in it. Its
  // Confirm would then write advancements for a play that no longer exists, and
  // until it was answered `entryInProgress()` refused *every* other entry: a
  // lockup worse than the bug it came from. Refuse, the way `applyPlay` and
  // `selectCell` do, with the same message.
  if (entryInProgress()) { showPlayReject('Finish the open entry first.'); return; }
  const team = selectedCell.dataset.team;
  const pIdx = parseInt(selectedCell.dataset.p);
  const innIdx = parseInt(selectedCell.dataset.inn);
  const ab = gameState.teams[team].players[pIdx].atBats[innIdx];
  if (!ab.play && (!ab.pitches || !ab.pitches.length) && !ab.subChange && !ab.pitcherChangeNum) return;

  const histIdx = playHistory.findIndex(h => h.team === team && h.pIdx === pIdx && h.innIdx === innIdx);
  const isLatest = histIdx !== -1 && histIdx === playHistory.length - 1;

  if (isLatest) {
    const snapshot = playHistory[histIdx];
    restoreInning(team, snapshot.prev);
    if (snapshot.prevPlayerAbs) restorePlayerRow(team, pIdx, snapshot.prevPlayerAbs);
    renderInning(team, snapshot.prev);
    if (snapshot.prev) {
      for (const col of snapshot.prev.cols) {
        for (let p = 0; p < gameState.teams[team].players.length; p++) renderRBI(team, p, col);
      }
    }
    playHistory.splice(histIdx, 1);
  } else {
    if (histIdx !== -1) playHistory.splice(histIdx, 1);
    const players = gameState.teams[team].players;
    // #21: the outs this play produced and the bases it handed out both come off.
    // The old code subtracted `ab.outsRecorded`, left the runner it doubled off
    // recorded as out (the loop meant to revert those subtracted nothing —
    // `inn.outs = Math.max(0, inn.outs)`), and left the runners it moved where
    // the play had put them.
    takeBackPlay(team, innIdx, pIdx, ab.outsRecorded || (ab.out ? 1 : 0));
    ab.bases = [false, false, false, false];
    ab.play = '';
    ab.out = 0;
    ab.outsRecorded = 0;
    ab.pitches = [];
    ab.rbi = 0;
    ab.hitLoc = null;
    ab.dpOuts = null;
    ab.outOnBase = null;
    ab.advReason = ['','','',''];
    ab.advSrc = null;
    ab.reachedOnError = false;
    // The marker and the mound go together (M1) — see `resyncInningPitcher`. The
    // `isLatest` branch above needs none of this: it puts the inning records back
    // wholesale, `currentPitcher` and `pitcherSet` with them.
    const hadPitcherChange = !!ab.pitcherChangeNum;
    ab.pitcherChangeNum = '';
    if (hadPitcherChange) resyncInningPitcher(team, innIdx);
    // The pinch runner went with the plate appearance he was running in (H2).
    ab.prRow = 0;
    // A sub line spans from here to the end of the game; clear the whole contiguous
    // run, and hand those columns back to the row above rather than all the way to
    // the starter — with two sub rows the man before this one may be another sub.
    // The run is bounded by row number, so clearing the first sub doesn't also wipe
    // a second substitution made later in the game (H3).
    const clearedRow = subRowOf(ab);
    if (clearedRow) {
      const back = clearedRow - 1;
      for (let c = innIdx; c < players[pIdx].atBats.length && subRowOf(players[pIdx].atBats[c]) === clearedRow; c++) {
        players[pIdx].atBats[c].subChange = back;
        renderPitcherChange(team, pIdx, c);
      }
    } else {
      ab.subChange = 0;
    }
    // `seq` stays — see `finishPlay`: the cell keeps its place in the game so a
    // re-entered play does not sort after everything recorded since.
    renderDiamond(team, pIdx, innIdx);
    renderOut(team, pIdx, innIdx);
    renderPitches(team, pIdx, innIdx);
    renderPlayText(team, pIdx, innIdx);
    renderRBI(team, pIdx, innIdx);
  }

  renderPitcherChange(team, pIdx, innIdx);
  // Both branches above touch only the at-bat records (and the out log); the
  // inning's outs, bases, runs and LOB come back out of them here. The restore
  // branch reinstates the snapshot's inning records wholesale, so a recompute over
  // it is a no-op unless the snapshot and the at-bats disagree — records win.
  recomputeInning(team, getRealInning(team, innIdx));
  noteCardChanged();
  updateSprayMini();
  updateSituation();
  updatePlayerStats(team);
  updatePitcherStats(team);
  autoSave();
}

function highlightLinescore(team, innIdx) {
  const realInn = getRealInning(team, innIdx);
  // Remove all highlights
  document.querySelectorAll('.linescore td.ls-active').forEach(el => el.classList.remove('ls-active'));
  // Highlight the current inning cell for the active team
  const row = team === 'visiting' ? 0 : 1;
  const rows = document.querySelectorAll('.linescore tbody tr');
  if (rows[row]) {
    const cells = rows[row].querySelectorAll('td');
    // cells[0] is team name, cells[1..INNINGS] are innings, then R/H/E/LOB
    if (realInn < INNINGS && cells[realInn + 1]) {
      cells[realInn + 1].classList.add('ls-active');
    }
  }
}

// A completed half-inning that scored nothing shows a 0, not a blank.
//
// #23: this looked the input up by real inning and then wrote state by *column*
// index, so after batting around the DOM read ["0","",…] and the state
// ["","0",…]. Usually the next updateLinescoreTotals put it right; a save landing
// in between persisted a zero against the wrong inning. Walk real innings, so
// there is one index in play. (The old `realInn >= INNINGS` check ran after the
// lookup it was meant to guard, and columnMap never holds a value that large.)
function fillLinescoreZeros() {
  ['visiting', 'home'].forEach(team => {
    for (let realInn = 0; realInn < INNINGS; realInn++) {
      const cols = getColumnsForInning(team, realInn);
      if (!cols.length) continue;
      const inp = document.querySelector(`input[data-ls="${team}"][data-inn="${realInn}"]`);
      if (!inp) continue;
      const inn = getInnState(team, cols[cols.length - 1]);
      if (inn.outs >= 3 && inp.value === '') {
        inp.value = '0';
        gameState.linescore[team].innings[realInn] = '0';
      }
    }
  });
  markUnplayedHomeHalf();
}

/* The other blank the line has to account for (L5): the home team doesn't bat in the
   bottom of the last inning when it is already ahead, and a blank there reads as
   "nobody scored" — the 0 of a team that lost, on the row of the team that won. That
   half is an X.

   Only ever the home team, and only ever one cell. The visitor bats first, so every
   half the game got *past* was played whether or not anyone recorded its at-bats, and
   every inning after the last one with plays was never reached. The single half in
   between — the bottom of the inning the game ended in the top of — is the X. Asking
   it that way also keeps the X off the card of a scorer who tracks the other side on
   the line only, with no at-bats to find.

   Derived on every pass, like FINAL: a score corrected back to a tie takes the X away
   again, and so does scoring the half after all. */
function markUnplayedHomeHalf() {
  const half = gameIsFinal() ? lastHalfWithPlays() : null;
  const skipped = half && half.team === 'visiting' ? getRealInning('visiting', half.innIdx) : -1;
  for (let realInn = 0; realInn < INNINGS; realInn++) {
    const inp = document.querySelector(`input[data-ls="home"][data-inn="${realInn}"]`);
    if (!inp) continue;
    // Never over the top of a figure already on the line: a run recorded there is a
    // scorer saying the half *was* played, and they outrank this derivation.
    if (realInn === skipped && inp.value === '') {
      inp.value = 'X';
      if (gameState.linescore.home) gameState.linescore.home.innings[realInn] = 'X';
    } else if (realInn !== skipped && inp.value === 'X') {
      inp.value = '';
      if (gameState.linescore.home) gameState.linescore.home.innings[realInn] = '';
    }
  }
}

function updateLinescoreTotals(team) {
  let r = 0;
  for (let i = 0; i < INNINGS; i++) {
    const inp = document.querySelector(`input[data-ls="${team}"][data-inn="${i}"]`);
    if (!inp) continue;
    const val = parseInt(inp.value) || 0;
    gameState.linescore[team].innings[i] = inp.value;
    r += val;
  }
  const rInp = document.querySelector(`input[data-ls="${team}"][data-stat="r"]`);
  if (rInp) rInp.value = r || '';
  gameState.linescore[team].r = r;
  updateLinescoreHits(team);
  updateLinescoreErrors();
  // #16: this used to be the *second* writer of `inn.lob`, and the two disagreed.
  // Its own scan counted every at-bat that reached and hadn't scored, in every
  // column including innings still in progress — so LOB climbed as runners reached
  // and fell as they scored, and it counted a runner two plays before anyone was
  // left on anything. `recomputeInning` settles the figure when the half-inning
  // ends; this only adds them up.
  writeTeamLOB(team);
}

/* Tabs */
function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById(`tab-${tab}`).classList.add('active');
}

/* Save / Load */
// Debounced persistence. Play/pitch actions and typing all call autoSave(),
// which coalesces rapid changes into a single collect + serialize + write
// (~400ms after the last change) instead of scraping the DOM and rewriting
// localStorage on every pitch. Call flushSave() when an immediate,
// authoritative write is required (explicit Save, switching games, page hide).
let _saveTimer = null;
function autoSave() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(flushSave, 400);
}
function flushSave() {
  clearTimeout(_saveTimer);
  _saveTimer = null;
  collectState();
  // The stored game wouldn't parse and we couldn't stash a copy of it anywhere,
  // so this write would be the thing that actually loses it (#25).
  if (saveBlockedFor(CURRENT_GAME_KEY)) return;
  safeStorage.setItem(CURRENT_GAME_KEY, JSON.stringify(stateForStorage(gameState)));
}

function collectState() {
  gameState.info.date = document.getElementById('info-date').value;
  gameState.info.startTime = document.getElementById('info-start-time').value;
  gameState.info.timeOfGame = document.getElementById('info-time-of-game').value;
  gameState.info.visitingTeam = document.getElementById('info-visiting-team').value;
  gameState.info.homeTeam = document.getElementById('info-home-team').value;
  gameState.info.weather = document.getElementById('info-weather').value;
  gameState.info.attendance = document.getElementById('info-attendance').value;
  // Regulation length lives in `rules`, not `info`, but it is scraped here with the
  // rest of the header so the select can't drift from state if it is ever set
  // without firing a change event.
  const innSel = document.getElementById('info-innings');
  if (innSel) {
    const n = parseInt(innSel.value);
    if (n >= 1 && n <= INNINGS) {
      if (!gameState.rules) gameState.rules = { allowReentry: false, regulationInnings: DEFAULT_REGULATION };
      gameState.rules.regulationInnings = n;
    }
  }
  gameState.umpires.hp = document.getElementById('ump-hp').value;
  gameState.umpires['1b'] = document.getElementById('ump-1b').value;
  gameState.umpires['2b'] = document.getElementById('ump-2b').value;
  gameState.umpires['3b'] = document.getElementById('ump-3b').value;
  gameState.notes = document.getElementById('game-notes').value;

  ['visiting','home'].forEach(team => {
    document.querySelectorAll(`input[data-field="num"][data-team="${team}"]`).forEach(inp => {
      const p = parseInt(inp.dataset.p);
      if (inp.dataset.pitcher !== undefined) {
        gameState.teams[team].pitchers[parseInt(inp.dataset.pitcher)].num = inp.value;
      } else {
        gameState.teams[team].players[p].num = inp.value;
      }
    });
    document.querySelectorAll(`input[data-field="name"][data-team="${team}"]`).forEach(inp => {
      if (inp.dataset.pitcher !== undefined) {
        gameState.teams[team].pitchers[parseInt(inp.dataset.pitcher)].name = inp.value;
      } else {
        const p = parseInt(inp.dataset.p);
        gameState.teams[team].players[p].name = inp.value;
      }
    });
    document.querySelectorAll(`select[data-field="pos"][data-team="${team}"]`).forEach(sel => {
      const p = parseInt(sel.dataset.p);
      gameState.teams[team].players[p].pos = sel.value;
    });
    document.querySelectorAll(`input[data-field="avg"][data-team="${team}"]`).forEach(inp => {
      const p = parseInt(inp.dataset.p);
      gameState.teams[team].players[p].avg = inp.value;
    });
    // `era` is deliberately absent: it is derived in `updatePitcherStats` and
    // rendered into a cell, so there is no input here to scrape.
    const pitcherStats = ['ip','pc','h','r','er','k','bb'];
    pitcherStats.forEach(stat => {
      document.querySelectorAll(`input[data-team="${team}"][data-field="${stat}"]`).forEach(inp => {
        if (inp.dataset.pitcher !== undefined) {
          gameState.teams[team].pitchers[parseInt(inp.dataset.pitcher)][stat] = inp.value;
        }
      });
    });
    const eInp = document.querySelector(`input[data-ls="${team}"][data-stat="e"]`);
    if (eInp) gameState.linescore[team].e = eInp.value;
  });

  /* standings removed */
}

function saveGame() {
  flushSave();
  const btn = document.getElementById('save-btn');
  const orig = btn.textContent;
  btn.textContent = 'Saved!';
  setTimeout(() => btn.textContent = orig, 1200);
}

// Backfill any fields a persisted/imported state is missing so no downstream
// code hits an undefined object. Mutates and returns `parsed`.
function mergeStateDefaults(parsed) {
  const defaults = createEmptyState();
  if (!parsed.innings) parsed.innings = defaults.innings;
  if (parsed.timerElapsed === undefined) parsed.timerElapsed = 0;
  if (parsed.timerRunning === undefined) parsed.timerRunning = false;
  // Deep merge with defaults so no fields are undefined
  Object.keys(defaults).forEach(k => {
    if (parsed[k] === undefined) parsed[k] = defaults[k];
  });
  if (!parsed.info) parsed.info = defaults.info;
  if (!parsed.umpires) parsed.umpires = defaults.umpires;
  if (!parsed.linescore) parsed.linescore = defaults.linescore;
  if (!parsed.teams) parsed.teams = defaults.teams;
  if (!parsed.innings) parsed.innings = defaults.innings;
  if (!parsed.columnMap) parsed.columnMap = defaults.columnMap;
  // The key-by-key merge above only fills whole top-level keys, so a save from
  // before regulation length was settable — `rules` present, the key inside it
  // missing — needs the nested backfill by hand.
  if (!parsed.rules) parsed.rules = defaults.rules;
  const parsedReg = parseInt(parsed.rules.regulationInnings);
  parsed.rules.regulationInnings = (parsedReg >= 1 && parsedReg <= INNINGS) ? parsedReg : DEFAULT_REGULATION;
  // Dropped in Phase 9: an older save still carries an unbounded play log (#31)
  // and an unused standings table (#33). Shed them rather than writing them back
  // out on every autoSave.
  delete parsed.log;
  delete parsed.standings;
  // Before refillAtBats: the re-lay-out moves whole player rows, and there is no
  // point padding rows that are about to be inserted.
  migrateLineupRows(parsed);
  refillAtBats(parsed);
  backfillOutsLog(parsed);
  migrateBaseRunners(parsed);
  return parsed;
}

/* Re-lay-out a save written when a lineup slot had fewer rows than it has now
   (H3: ROWS_PER_POS went 2 → 3).

   A player's row index *is* his position in the slot — `slot * ROWS_PER_POS + row`
   — so widening a slot is not an append, it is a remap. Row 2 of a 2-row save is
   slot 1's starter; in a 3-row card that index belongs to slot 0's second sub. Left
   alone, every lineup below the first would shift up a spot and the at-bats would
   go with them.

   So each old row moves to `slot * ROWS_PER_POS + row`, the new rows in between are
   fresh, and every stored player index is put through the same map. Those indices
   are the reason this can't be done anywhere but here: `bases[].p`, `lastPA.pIdx`,
   the out log's `pIdx`/`srcP`, `nextLeadoff`, `reentries` and `defChanges` all name
   rows, and a card whose runners point at the wrong men is worse than one that
   failed to load.

   Idempotent — a save already at the current width is left alone, which is what
   makes it safe to call from more than one load path. */
function migrateLineupRows(state) {
  if (!state || !state.teams) return;
  const want = POSITIONS * ROWS_PER_POS;
  // Infer the old width from the row count. Anything that isn't a whole number of
  // rows per slot is not a shape this knows how to move, so leave it to
  // `refillAtBats` and the per-row defaults rather than guess.
  const widths = ['visiting', 'home'].map(t => {
    const pl = state.teams[t] && state.teams[t].players;
    return Array.isArray(pl) ? pl.length : 0;
  });
  if (widths.some(n => n === want) || widths.some(n => n === 0)) return;
  if (widths[0] !== widths[1]) return;
  const oldRows = widths[0] / POSITIONS;
  if (!Number.isInteger(oldRows) || oldRows < 1 || oldRows >= ROWS_PER_POS) return;

  const remap = p => {
    if (typeof p !== 'number' || p < 0) return p;
    return Math.floor(p / oldRows) * ROWS_PER_POS + (p % oldRows);
  };

  ['visiting', 'home'].forEach(t => {
    const team = state.teams[t];
    const old = team.players;
    const next = Array(want).fill(null).map(() => ({
      num: '', name: '', pos: '', avg: '', atBats: []
    }));
    old.forEach((pl, i) => { next[remap(i)] = pl; });
    team.players = next;

    const innings = state.innings && state.innings[t];
    if (Array.isArray(innings)) {
      innings.forEach(inn => {
        if (!inn) return;
        if (Array.isArray(inn.bases)) {
          inn.bases.forEach((held, b) => {
            if (held && typeof held === 'object' && typeof held.p === 'number') held.p = remap(held.p);
            else if (typeof held === 'number') inn.bases[b] = remap(held);   // pre-Phase-7 bare index
          });
        }
        if (inn.lastPA && typeof inn.lastPA.pIdx === 'number') inn.lastPA.pIdx = remap(inn.lastPA.pIdx);
        if (Array.isArray(inn.outsLog)) {
          inn.outsLog.forEach(e => {
            if (!e) return;
            if (typeof e.pIdx === 'number') e.pIdx = remap(e.pIdx);
            if (typeof e.srcP === 'number') e.srcP = remap(e.srcP);
          });
        }
      });
    }

    const leadoff = state.nextLeadoff && state.nextLeadoff[t];
    if (leadoff) Object.keys(leadoff).forEach(col => { leadoff[col] = remap(leadoff[col]); });
  });

  if (Array.isArray(state.reentries)) {
    state.reentries.forEach(r => { if (r && typeof r.pIdx === 'number') r.pIdx = remap(r.pIdx); });
  }
  if (Array.isArray(state.defChanges)) {
    state.defChanges.forEach(d => {
      if (!d || !Array.isArray(d.changes)) return;
      d.changes.forEach(c => { if (c && typeof c.pIdx === 'number') c.pIdx = remap(c.pIdx); });
    });
  }

  // `subChange` was a boolean when a slot had one sub row. True means the first
  // sub, which is the row the old build drew and the scorer saw.
  ['visiting', 'home'].forEach(t => {
    (state.teams[t].players || []).forEach(pl => {
      (pl.atBats || []).forEach(ab => {
        if (ab && typeof ab.subChange !== 'number') ab.subChange = ab.subChange ? 1 : 0;
      });
    });
  });
}

// Games saved before Phase 7 hold a bare player index in `inn.bases`, not the
// `{ p, col }` ref every reader now expects. Upgrade in place: the column is the
// player's first plate appearance in that inning, which is what the old
// `getRunnerCol` resolved to and is correct for every save that didn't bat around.
// (`applyState` re-derives the bases of every inning with records anyway, so this
// is the belt to that braces — it also covers `loadGameFromLibrary`, which skips
// the merge entirely (#28).)
function migrateBaseRunners(state) {
  if (!state.innings || !state.teams) return;
  for (const team of ['visiting', 'home']) {
    const innings = state.innings[team];
    const players = state.teams[team] && state.teams[team].players;
    if (!innings || !players) continue;
    const cmap = (state.columnMap && state.columnMap[team]) || null;
    for (let col = 0; col < innings.length; col++) {
      const inn = innings[col];
      if (!inn || !Array.isArray(inn.bases)) continue;
      const realInn = cmap && cmap[col] !== undefined ? cmap[col] : col;
      for (let b = 0; b < 3; b++) {
        const held = inn.bases[b];
        if (typeof held !== 'number') continue;
        const pl = players[held];
        let src = col;
        if (pl && pl.atBats) {
          for (let c = 0; c < pl.atBats.length; c++) {
            const ri = cmap && cmap[c] !== undefined ? cmap[c] : c;
            if (ri === realInn && pl.atBats[c] && pl.atBats[c].play) { src = c; break; }
          }
        }
        inn.bases[b] = { p: held, col: src };
      }
    }
  }
}

// Games saved before `outsLog` existed carry only per-at-bat `out` / `outsRecorded`,
// so rebuild the log from those — otherwise an in-progress game reloaded after
// this change would show blank IP for every inning already played.
//
// Two things can't be recovered: which play a runner out belonged to (so `srcP`
// points at the runner's own cell, meaning clearing an old double play won't take
// its runner out with it — which is what the old code did anyway), and `lastPA`
// (markNextInningLeadoff falls back to its old 3rd-out search when it's missing).
function backfillOutsLog(state) {
  if (!state.innings || !state.teams) return;
  for (const team of ['visiting', 'home']) {
    const innings = state.innings[team];
    const players = state.teams[team] && state.teams[team].players;
    if (!innings || !players) continue;
    const cmap = state.columnMap && state.columnMap[team];
    for (let col = 0; col < innings.length; col++) {
      const inn = innings[col];
      if (!inn || Array.isArray(inn.outsLog)) continue;
      if (inn.lastPA === undefined) inn.lastPA = null;
      const entries = [];
      players.forEach((pl, pIdx) => {
        const ab = pl.atBats && pl.atBats[col];
        if (!ab || !(ab.out > 0)) return;
        entries.push({
          n: ab.out,
          kind: ab.outOnBase != null ? 'runner' : 'batter',
          pIdx, col, srcP: pIdx, srcCol: col,
          pitcher: ab.pitcher || 0
        });
      });
      entries.sort((a, b) => a.n - b.n);
      // An old double play with nobody on base stamped two outs onto one at-bat,
      // so the entries can come up short. Only pad when this column is the whole
      // inning — after batting around, `inn.outs` is the running total for the
      // inning and the earlier columns already logged their share.
      const realInn = cmap ? (cmap[col] === undefined ? col : cmap[col]) : col;
      const soleColumn = !cmap || cmap.filter(ri => ri === realInn).length <= 1;
      if (soleColumn) {
        while (entries.length < (inn.outs || 0)) {
          entries.push({ n: 0, kind: 'runner', pIdx: null, col, srcP: null, srcCol: col, pitcher: inn.currentPitcher || 0 });
        }
      }
      entries.forEach((e, i) => { e.n = i + 1; });
      inn.outsLog = entries;
    }
  }
}

function loadState() {
  adoptExistingQuarantine(CURRENT_GAME_KEY);
  adoptExistingQuarantine(LIBRARY_KEY);
  const saved = safeStorage.getItem(CURRENT_GAME_KEY);
  if (saved) {
    try {
      gameState = mergeStateDefaults(JSON.parse(saved));
    } catch(e) {
      // #25: keep the text before starting a fresh game on top of it.
      console.error('Failed to load state', e);
      quarantineUnreadable(CURRENT_GAME_KEY, saved);
      gameState = createEmptyState();
    }
  }
  applyState();
}

function applyState() {
  // Ensure gameState has all required top-level objects
  const d = createEmptyState();
  if (!gameState.info) gameState.info = d.info;
  if (!gameState.umpires) gameState.umpires = d.umpires;
  if (!gameState.linescore) gameState.linescore = d.linescore;
  if (!gameState.teams) gameState.teams = d.teams;
  if (!gameState.innings) gameState.innings = d.innings;
  if (!gameState.columnMap) gameState.columnMap = d.columnMap;
  if (gameState.timerElapsed === undefined) gameState.timerElapsed = 0;
  if (gameState.timerRunning === undefined) gameState.timerRunning = false;
  if (gameState.notes === undefined) gameState.notes = '';
  if (!gameState.defChanges) gameState.defChanges = [];
  if (!gameState.rules) gameState.rules = { allowReentry: false, regulationInnings: DEFAULT_REGULATION };
  // A save from before regulation length was settable carries `rules` without the
  // key, so this has to backfill inside the object, not just create it.
  const savedReg = parseInt(gameState.rules.regulationInnings);
  gameState.rules.regulationInnings = (savedReg >= 1 && savedReg <= INNINGS) ? savedReg : DEFAULT_REGULATION;
  if (!Array.isArray(gameState.reentries)) gameState.reentries = [];
  if (!gameState.dhTerminated) gameState.dhTerminated = { visiting: null, home: null };
  if (!gameState.visibleInnings) gameState.visibleInnings = regulationInnings();
  if (gameState.playSeq === undefined) gameState.playSeq = 0;
  migrateBaseRunners(gameState);   // bare-index base entries from a pre-Phase-7 save
  ['visiting','home'].forEach(t => {
    if (gameState.linescore[t] && gameState.linescore[t].innings.length < INNINGS) {
      const ext = Array(INNINGS - gameState.linescore[t].innings.length).fill('');
      gameState.linescore[t].innings = gameState.linescore[t].innings.concat(ext);
    }
    // Extend an older/shorter column map so extra-inning columns map to themselves
    if (gameState.columnMap && gameState.columnMap[t]) {
      for (let c = gameState.columnMap[t].length; c < INNINGS; c++) gameState.columnMap[t][c] = c;
    }
    // Extend player atBat arrays if loaded from older save with fewer innings
    if (gameState.teams && gameState.teams[t]) {
      gameState.teams[t].players.forEach(player => {
        while (player.atBats.length < INNINGS) player.atBats.push(makeEmptyAtBat());
      });
    }
    // Extend innings array
    if (gameState.innings && gameState.innings[t]) {
      const makeInning = () => ({ outs:0, bases:[null,null,null], currentPitcher:0, lob:0, outsLog:[], lastPA:null });
      while (gameState.innings[t].length < INNINGS) gameState.innings[t].push(makeInning());
    }
  });

  document.getElementById('info-date').value = gameState.info.date || '';
  document.getElementById('info-start-time').value = gameState.info.startTime || '';
  document.getElementById('info-time-of-game').value = gameState.info.timeOfGame || '';
  document.getElementById('info-visiting-team').value = gameState.info.visitingTeam || '';
  document.getElementById('info-home-team').value = gameState.info.homeTeam || '';
  document.getElementById('info-weather').value = gameState.info.weather || '';
  document.getElementById('info-attendance').value = gameState.info.attendance || '';
  const innSelEl = document.getElementById('info-innings');
  if (innSelEl) innSelEl.value = String(regulationInnings());
  document.getElementById('ump-hp').value = gameState.umpires.hp || '';
  document.getElementById('ump-1b').value = gameState.umpires['1b'] || '';
  document.getElementById('ump-2b').value = gameState.umpires['2b'] || '';
  document.getElementById('ump-3b').value = gameState.umpires['3b'] || '';
  document.getElementById('game-notes').value = gameState.notes || '';

  const vLabel = document.getElementById('ls-v-label');
  if (vLabel && gameState.info.visitingTeam) vLabel.textContent = gameState.info.visitingTeam;
  const hLabel = document.getElementById('ls-h-label');
  if (hLabel && gameState.info.homeTeam) hLabel.textContent = gameState.info.homeTeam;

  ['visiting','home'].forEach(team => {
    // Ensure innings have new fields
    if (gameState.innings && gameState.innings[team]) {
      gameState.innings[team].forEach(inn => {
        if (inn && inn.currentPitcher === undefined) inn.currentPitcher = 0;
        if (inn && inn.lob === undefined) inn.lob = 0;
        if (inn && !Array.isArray(inn.outsLog)) inn.outsLog = [];
        if (inn && inn.lastPA === undefined) inn.lastPA = null;
      });
    }

    gameState.teams[team].players.forEach((player, p) => {
      const numInp = document.querySelector(`input[data-field="num"][data-team="${team}"][data-p="${p}"]`);
      const nameInp = document.querySelector(`input[data-field="name"][data-team="${team}"][data-p="${p}"]`);
      const posSel = document.querySelector(`select[data-field="pos"][data-team="${team}"][data-p="${p}"]`);
      const avgInp = document.querySelector(`input[data-field="avg"][data-team="${team}"][data-p="${p}"]`);
      if (numInp) numInp.value = player.num || '';
      if (nameInp) nameInp.value = player.name || '';
      if (posSel) posSel.value = player.pos || '';
      if (avgInp) avgInp.value = player.avg || '';

      player.atBats.forEach((ab, inn) => {
        if (!ab.pitches) ab.pitches = [];
        if (ab.rbi === undefined) ab.rbi = 0;
        if (ab.pitcher === undefined) ab.pitcher = 0;
        renderDiamond(team, p, inn);
        renderOut(team, p, inn);
        renderPitches(team, p, inn);
        renderPlayText(team, p, inn);
        renderPitcherChange(team, p, inn);
        renderRBI(team, p, inn);
      });
    });

    gameState.teams[team].pitchers.forEach((pitcher, i) => {
      Object.keys(pitcher).forEach(field => {
        const inp = document.querySelector(`input[data-team="${team}"][data-pitcher="${i}"][data-field="${field}"]`);
        if (inp) inp.value = pitcher[field] || '';
      });
    });

    gameState.linescore[team].innings.forEach((val, i) => {
      const inp = document.querySelector(`input[data-ls="${team}"][data-inn="${i}"]`);
      if (inp) inp.value = val || '';
    });
    const eInp = document.querySelector(`input[data-ls="${team}"][data-stat="e"]`);
    if (eInp) eInp.value = gameState.linescore[team].e || '';
    // #24: the grid header is built 1…15 and only `overflowToNextColumn` ever
    // re-derived it, so a game reloaded after batting around showed the columns
    // renumbered past their real innings — column 2 read "3" when it was still
    // the 1st. The map is the record; re-derive from it on every load.
    updateColumnHeaders(team);
    refreshCellAria(team);
    // Re-derive every inning somebody batted in, so a game saved by an older build
    // — or hand-edited, or imported — comes back consistent with its own records.
    // A save from before LOB had one definition carries the old inflating scan's
    // figures, and this is what corrects them. Innings nobody batted in are left
    // exactly as saved: there is nothing to derive, and the cell may be hand-typed.
    for (let ri = 0; ri < INNINGS; ri++) {
      if (inningHasRecords(team, ri)) recomputeInning(team, ri);
    }
    updateLinescoreTotals(team);
    updatePlayerStats(team);
    updatePitcherStats(team);
  });

  updateSprayMini();
  updateExtraInnings();
  updateLiveStatsFromState();
  // Every name in the lineup arrived at once and none of them fired an input
  // event, so none of them has been measured against its column yet.
  refitNames();

  // Restore timer state
  if (gameState.timerRunning && gameState.timerStart) {
    document.getElementById('timer-btn').textContent = 'Stop';
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(updateTimerDisplay, 1000);
    updateTimerDisplay();
  } else {
    if (gameState.timerElapsed > 0) updateTimerDisplay();
  }
}

function newGame() {
  if (!confirm('Clear all data and start a new scorecard?')) return;
  clearTimeout(_saveTimer); _saveTimer = null;  // drop any pending save of the outgoing game
  // Stop timer if running
  if (timerInterval) clearInterval(timerInterval);
  gameState = createEmptyState();
  safeStorage.removeItem(CURRENT_GAME_KEY);
  document.getElementById('timer-btn').textContent = 'Start';
  document.getElementById('timer-display').textContent = '0:00';
  playHistory = [];
  redoHistory = [];
  gameOverShown = false;
  backupPromptDismissed = false;
  applyState();
}

/* Position play popup input */
function showPositionPopup(prefix, placeholder, target) {
  // Capture the cell now — typing the fielders takes long enough for the scorer
  // to tap somewhere else first (#1).
  const t = target || currentTarget();
  if (!t) return;
  let popup = document.getElementById('pos-popup');
  if (!popup) {
    popup = document.createElement('div');
    popup.id = 'pos-popup';
    popup.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#333;color:#fff;padding:12px 16px;border-radius:8px;z-index:200;display:flex;align-items:center;gap:8px;box-shadow:0 4px 20px rgba(0,0,0,0.3);';
    popup.innerHTML = '<span id="pos-label" style="font-size:14px;font-weight:700;font-family:var(--mono)"></span>'
      + '<input id="pos-input" type="text" maxlength="7" style="width:70px;font-size:16px;font-family:var(--mono);font-weight:700;padding:4px 8px;border:2px solid #888;border-radius:4px;text-align:center;text-transform:uppercase;" autocomplete="off">'
      + '<span style="font-size:11px;opacity:0.6">Enter to confirm</span>';
    document.body.appendChild(popup);
  }
  const label = prefix === 'F' ? 'Fly:' : prefix === 'P' ? 'Pop:' : prefix === 'L' ? 'Line:' : prefix === 'E' ? 'Error:' : prefix === 'DP ' ? 'DP:' : prefix === 'FC ' ? 'FC:' : prefix === 'TP ' ? 'TP:' : 'Ground:';
  document.getElementById('pos-label').textContent = label;
  const input = document.getElementById('pos-input');
  input.value = '';
  input.placeholder = placeholder || '7';
  showPopupBackdrop();
  popup.style.display = 'flex';
  popup.dataset.prefix = prefix;
  setTimeout(() => input.focus(), 10);

  input.onkeydown = function(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      const val = input.value.trim();
      popup.style.display = 'none';
      hidePopupBackdrop();
      input.blur();
      // Normalize here so only canonical codes reach state — a scorer typing
      // "GO 6-3" gets "6-3", which the rest of the app recognises as an out (#15).
      if (val) applyPlay(normalizePlayCode(prefix + val), t);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      popup.style.display = 'none';
      hidePopupBackdrop();
      input.blur();
    }
  };
}

function promptPositionPlay(prefix) {
  showPositionPopup(prefix, '7');
}

function promptGroundout() {
  showPositionPopup('', '6-3');
}

/* Error detail popup (Feature 14) */
function promptErrorPlay() {
  showPositionPopup('E', '6');
}

/* Render RBI badge in at-bat cell (Feature 2) */
function renderRBI(team, pIdx, innIdx) {
  // RBI dots are now rendered inline by renderPlayText
  renderPlayText(team, pIdx, innIdx);
}

/* Auto Player Stats (Feature 1) */

// Did this plate appearance move anybody? `markAdvance` stamps every base a play
// gives a runner with the batter's own cell, so the answer is written on the
// runners' rows, not his.
function advancedARunner(team, srcP, srcCol) {
  const players = gameState.teams[team].players;
  const cols = getColumnsForInning(team, getRealInning(team, srcCol));
  for (const col of cols) {
    for (let p = 0; p < players.length; p++) {
      if (p === srcP && col === srcCol) continue;   // the batter's own cell
      const ab = players[p].atBats[col];
      if (!ab || !Array.isArray(ab.advSrc)) continue;
      for (let seg = 0; seg < 4; seg++) {
        const s = ab.advSrc[seg];
        if (s && s.p === srcP && s.col === srcCol) return true;
      }
    }
  }
  return false;
}

// Rule 9.02(a)(1): a sacrifice costs no at-bat only if it did its job. A sac fly
// needs a run to score; a sac bunt needs a runner to advance. A fly ball or a bunt
// that achieved neither is an ordinary out and the batter is charged for it — the
// reachable case being an `SF` entered with the bases empty (#17).
function sacrificeExemptsAB(team, pIdx, col, ab) {
  if (ab.play === 'SF') return (ab.rbi || 0) > 0;
  return advancedARunner(team, pIdx, col);
}

/* One row of a slot's figures, from the slot's at-bats. `row` is which row —
   0 for the starter — and a column counts towards it in two independent ways:
   the plate appearance goes to the row that *batted* it (`subRowOf`), the run goes
   to the row that *ran* it (`runRowOf`), and a pinch runner is exactly the case
   where those differ (H2). Before that they were one test, so a run scored by a
   pinch runner landed on the starter's line and the sub's read blank. */
function tallyAtBats(team, pIdx, atBats, row) {
  let ab = 0, h = 0, r = 0, rbi = 0, bb = 0, k = 0, hbp = 0;
  for (let col = 0; col < atBats.length; col++) {
    const atBat = atBats[col];
    if (!atBat.play) continue;
    const scored = atBat.bases[0] && atBat.bases[1] && atBat.bases[2] && atBat.bases[3] && atBat.outOnBase == null;
    if (scored && runRowOf(atBat) === row) r++;
    if (subRowOf(atBat) !== row) continue;
    const isSac = ['SAC','SF','SH'].includes(atBat.play);
    const noAB = isSac
      ? sacrificeExemptsAB(team, pIdx, col, atBat)
      : ['BB','HBP','IBB','CI'].includes(atBat.play);
    if (!noAB) ab++;
    if (isHitPlay(atBat.play)) h++;
    rbi += (atBat.rbi || 0);
    if (atBat.play === 'BB' || atBat.play === 'IBB') bb++;
    if (atBat.play === 'K' || atBat.play === 'ꓘ' || atBat.play === 'K+WP') k++;
    if (atBat.play === 'HBP') hbp++;
  }
  return { ab, h, r, rbi, bb, k, hbp };
}

// `k` and `hbp` are not for the card: the stat block beside the lineup has five
// columns (AB H R RBI BB) and writeStats fills those. The game summary's box score
// is the consumer — `k` is its K column, and `hbp` is part of deciding whether a row
// appeared in the game at all, which is how a pinch runner who never batted still
// gets a line (m5). Both live; neither is dead.
function writeStats(team, pIdx, s) {
  const fields = ['ab','h','r','rbi','bb'];
  fields.forEach(f => {
    const el = document.getElementById(`st-${f}-${team}-${pIdx}`);
    if (el) el.textContent = s[f] || '';
  });
}

function updatePlayerStats(team) {
  const players = gameState.teams[team].players;
  for (let pos = 0; pos < POSITIONS; pos++) {
    const sp = pos * ROWS_PER_POS;
    const player = players[sp];
    const allABs = player.atBats;
    // Every row of the slot is tallied from the starter's at-bats, split by which
    // row owns each column. A row nobody has batted in tallies to zeros and shows
    // blank, so an untouched sub row reads empty rather than "0".
    writeStats(team, sp, tallyAtBats(team, sp, allABs, 0));
    subRowOffsets().forEach(r => {
      writeStats(team, sp + r, tallyAtBats(team, sp, allABs, r));
    });
  }
}

/* Pitcher Stats Auto-Calculation (Feature 5) */
// One shape for a pitcher's line, since three places build it and a field added to
// only some of them (`faced`, M6) reads as NaN in the others.
function emptyPitcherLine() {
  return { ip: 0, outs: 0, k: 0, bb: 0, h: 0, r: 0, er: 0, pc: 0, faced: 0, prov: false };
}

function updatePitcherStats(battingTeam) {
  // When visiting is batting, HOME pitchers face them. So update HOME pitcher stats.
  const pitchingTeam = battingTeam === 'visiting' ? 'home' : 'visiting';
  const pitchers = gameState.teams[pitchingTeam].pitchers;
  const stats = {};
  for (let i = 0; i < PITCHER_ROWS; i++) {
    stats[i] = emptyPitcherLine();
  }

  // Innings whose ER total is provisional (contained an error/PB/CI) — a run
  // scored in one of these flags its pitcher for manual ER review.
  const provInnings = new Set();
  for (let ri = 0; ri < INNINGS; ri++) {
    if (inningErProvisional(battingTeam, ri)) provInnings.add(ri);
  }

  // Go through the batting team's players to compute stats for the pitching team's pitchers
  const batters = gameState.teams[battingTeam].players;
  for (const player of batters) {
    for (let col = 0; col < player.atBats.length; col++) {
      const ab = player.atBats[col];
      if (!ab.play) continue;
      const pi = ab.pitcher || 0;
      if (!stats[pi]) stats[pi] = emptyPitcherLine();
      const s = stats[pi];
      // Batters faced — the record that he pitched at all, which IP alone cannot
      // carry: a reliever who retires nobody has 0 outs and so did read as an empty
      // row (M6).
      s.faced++;
      // Pitch count
      s.pc += (ab.pitches || []).length;
      // Outs are not counted here — see the outsLog pass below.
      // Strikeouts
      if (ab.play === 'K' || ab.play === 'ꓘ' || ab.play === 'K+WP') s.k++;
      // Walks
      if (ab.play === 'BB' || ab.play === 'IBB') s.bb++;
      // Hits
      if (isHitPlay(ab.play)) s.h++;
      // Runs (if batter scored)
      if (ab.bases[0] && ab.bases[1] && ab.bases[2] && ab.bases[3] && ab.outOnBase == null) {
        s.r++;
        if (!ab.reachedOnError) s.er++;
        if (provInnings.has(getRealInning(battingTeam, col))) s.prov = true;
      }
    }
  }

  // Outs come straight from each inning's out log, so every out counts once and
  // against the pitcher who was on the mound when it happened. The old version
  // re-derived them from `outsRecorded` / `outOnBase` on the batter's at-bat and
  // missed every out that wasn't the batter's own — a caught stealing, a pickoff
  // and a runner thrown out advancing on a single all left IP blank (#10).
  for (let ri = 0; ri < INNINGS; ri++) {
    for (const o of inningOutsLog(battingTeam, ri)) {
      const pi = o.pitcher || 0;
      if (!stats[pi]) stats[pi] = emptyPitcherLine();
      stats[pi].outs++;
    }
  }

  // Update pitcher table cells for the pitching team
  for (let i = 0; i < PITCHER_ROWS; i++) {
    const s = stats[i];
    // IP in the box-score form: full innings, then the outs left over. A pitcher who
    // appeared and retired nobody is `0.0`, not a blank — he pitched, and a blank says
    // he didn't (M6). "Appeared" is a batter faced or an out recorded, so a row for a
    // pitcher who never came in stays empty. A whole inning now reads `1.0` rather
    // than `1`, which is the same convention `0.1` and `0.2` were already using.
    const appeared = s.faced > 0 || s.outs > 0;
    const ipStr = appeared ? `${Math.floor(s.outs / 3)}.${s.outs % 3}` : '';

    const fields = { ip: ipStr, pc: s.pc || '', h: s.h || '', r: s.r || '', er: s.er || '', k: s.k || '', bb: s.bb || '' };
    Object.keys(fields).forEach(field => {
      const inp = document.querySelector(`input[data-team="${pitchingTeam}"][data-pitcher="${i}"][data-field="${field}"]`);
      if (inp) {
        inp.value = fields[field];
        pitchers[i][field] = String(fields[field]);
      }
    });

    // ERA for this game's line: ER × 9 ÷ IP, which in outs is ER × 27 ÷ outs.
    // A pitcher charged an earned run without retiring anybody has an infinite
    // ERA — the convention on a box score is INF, not a division by zero.
    const eraStr = s.outs > 0 ? (s.er * 27 / s.outs).toFixed(2)
                              : (s.er > 0 ? 'INF' : '');
    pitchers[i].era = eraStr;
    const eraCell = document.querySelector(`td[data-field="era"][data-team="${pitchingTeam}"][data-pitcher="${i}"]`);
    if (eraCell) eraCell.textContent = eraStr;

    // ER-review badge: flag the ER cell when this pitcher allowed a run in an
    // inning that had an error/PB/CI, so the scorer knows to verify it.
    const erInp = document.querySelector(`input[data-team="${pitchingTeam}"][data-pitcher="${i}"][data-field="er"]`);
    if (erInp) {
      const td = erInp.closest('td');
      if (td) td.classList.toggle('er-review', !!s.prov);
      erInp.title = s.prov ? 'ER review needed — a run scored in an inning with an error, passed ball, or interference. Select a scored cell in that inning and tap “E/UE” to review.' : '';
    }
  }
}

/* Change Pitcher (Feature 5) */
function changePitcher() {
  if (!selectedCell) return;
  const battingTeam = selectedCell.dataset.team;
  const innIdx = parseInt(selectedCell.dataset.inn);
  // Visiting batters face home pitchers, home batters face visiting pitchers
  const pitchingTeam = battingTeam === 'visiting' ? 'home' : 'visiting';
  // currentPitcher is stored on the batting team's inning state
  const battingInn = getInnState(battingTeam, innIdx);

  let popup = document.getElementById('pitcher-popup');
  if (!popup) {
    popup = document.createElement('div');
    popup.id = 'pitcher-popup';
    popup.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#fff;border:2px solid #333;border-radius:8px;padding:14px 18px;z-index:300;box-shadow:0 6px 30px rgba(0,0,0,0.35);min-width:220px;font-family:var(--font);';
    document.body.appendChild(popup);
  }

  const pitchers = gameState.teams[pitchingTeam].pitchers;
  let html = '<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px;color:#333">Select Pitcher</div>';
  pitchers.forEach((p, i) => {
    const name = p.name || `Pitcher ${i + 1}`;
    const num = p.num ? '#' + p.num + ' ' : '';
    const isActive = getEffectivePitcher(battingTeam, innIdx) === i;
    html += `<button data-act="setPitcher" data-argnum="${i}" style="display:block;width:100%;text-align:left;padding:6px 10px;margin-bottom:4px;border:1.5px solid ${isActive ? '#1565c0' : '#ccc'};border-radius:4px;background:${isActive ? '#e3f2fd' : '#fff'};cursor:pointer;font-size:12px;font-weight:${isActive ? '700' : '500'};font-family:var(--font)">${escapeHtml(num)}${escapeHtml(name)}</button>`;
  });
  html += '<button data-act="hidePopupById" data-arg="pitcher-popup" style="margin-top:6px;width:100%;padding:5px;font-size:11px;border:1px solid #ccc;border-radius:4px;background:#f5f5f5;cursor:pointer">Cancel</button>';
  popup.innerHTML = html;
  popup.style.display = 'block';
}

/* ------------------------------------------------------- substitutions ---
   SUB is the one control over who occupies a lineup slot, and it used to be a
   plain toggle: press it once and the sub bats from here on, press it again and
   the starter is back. That second press is a re-entry, which OBR 5.10(d)
   forbids — a replaced player is out of the game — and the app was granting it
   silently, indistinguishable from taking back a press that shouldn't have
   happened.

   Those are two different acts and the card should say which one it recorded, so
   the second press now asks. It still never refuses: leagues that allow re-entry
   exist, and a scorer's job is to record what happened, legal or not. What it
   won't do any more is decide on its own. */

function markSub() {
  if (!selectedCell) return;
  const team = selectedCell.dataset.team;
  const pIdx = parseInt(selectedCell.dataset.p);
  const innIdx = parseInt(selectedCell.dataset.inn);
  if (gameState.teams[team].players[pIdx].atBats[innIdx].subChange) {
    promptSubRemoval(team, pIdx, innIdx);
    return;
  }
  pushUndo(team, pIdx, innIdx);
  setSubLine(team, pIdx, innIdx, INNINGS - 1, 1);
}

/* PR — a pinch runner, which SUB cannot express (H2, D4).

   SUB deliberately skips a column that already has a play in it: that plate
   appearance belongs to the man who made it, and a pinch *hitter* arrives before
   one, not after. A pinch runner arrives in the middle of exactly such a column —
   somebody reached, and somebody else does the running — so under SUB he could
   never own the at-bat he was running in, and the run he scored went onto the
   starter's line while his own read blank.

   So this marks the column instead of taking it over: `prRow` says who ran, the
   plate appearance stays where it is, and only the run follows the runner. The
   line forward *is* handed over, because a pinch runner stays in the game and
   bats in that spot next time up — one press for the whole act.

   Refused when the column has no play (nobody is on base to run for) or when the
   slot has no row left to put him in. */
function markPinchRunner() {
  if (!selectedCell) return;
  const team = selectedCell.dataset.team;
  const pIdx = parseInt(selectedCell.dataset.p);
  const innIdx = parseInt(selectedCell.dataset.inn);
  const player = gameState.teams[team].players[pIdx];
  const ab = player.atBats[innIdx];

  if (!ab.play) { showPlayReject('Record how he reached first, then run for him.'); return; }
  if (ab.prRow) { showPlayReject(rowLabel(team, pIdx + ab.prRow) + ' is already running here.'); return; }
  const runner = subRowOf(ab) + 1;
  if (runner >= ROWS_PER_POS) { showPlayReject('No row left in this spot for a pinch runner.'); return; }
  // Nobody to run for: he is already off the bases, out or scored.
  const inn = getInnState(team, innIdx);
  const onBase = inn.bases.some(b => b && b.p === pIdx && b.col === innIdx);
  if (!onBase && !(ab.bases[0] && ab.outOnBase == null)) {
    showPlayReject('He is not on base — nothing to pinch-run.');
    return;
  }

  pushUndo(team, pIdx, innIdx);
  ab.prRow = runner;
  // From the next column on he is simply the man in the slot.
  setSubLine(team, pIdx, innIdx + 1, INNINGS - 1, runner);
  renderPitcherChange(team, pIdx, innIdx);
  updatePlayerStats(team);
  announce(rowLabel(team, pIdx + runner) + ' pinch-runs for ' + rowLabel(team, pIdx + subRowOf(ab)));
  autoSave();
}

// Write a slot's sub line across `[from, to]` and bring the stats and the change
// marks with it. `row` is which row of the slot takes over — 0 hands the columns
// back to the starter, 1..ROWS_PER_POS-1 gives them to that substitute. Turning a
// sub on skips the first column when a play is already recorded there: that at-bat
// belongs to whoever was batting, and the new man takes over from the next one.
//
// `row` used to be a boolean, because a slot had one sub row and "on" could only
// mean that row (H3).
function setSubLine(team, pIdx, from, to, row) {
  const player = gameState.teams[team].players[pIdx];
  const r = row === true ? 1 : (row ? Math.floor(row) : 0);
  const start = (r && player.atBats[from].play) ? from + 1 : from;
  for (let c = start; c <= to && c < INNINGS; c++) {
    player.atBats[c].subChange = r;
    renderPitcherChange(team, pIdx, c);
  }
  updatePlayerStats(team);
  autoSave();
}

// The contiguous run of columns *one* substitute's line covers around `col`, plus
// what he has recorded inside it. `before` and `after` are the plate appearances
// either side of `col`, and they are what decide whether taking him out here is a
// re-entry (he batted, so someone is coming back) or simply an undo (he never came
// up, so nothing happened to record).
//
// The run is bounded by the row number, not by "any sub": with two sub rows,
// walking on truthiness alone would swallow the *next* substitute's columns into
// this one's run and offer to clear them both (H3). `row` is the run's owner.
function subLineRun(team, pIdx, col) {
  const abs = gameState.teams[team].players[pIdx].atBats;
  const row = subRowOf(abs[col]);
  if (!abs[col] || !row) return null;
  let start = col, end = col;
  while (start > 0 && subRowOf(abs[start - 1]) === row) start--;
  while (end < abs.length - 1 && subRowOf(abs[end + 1]) === row) end++;
  const plays = (a, b) => {
    let n = 0;
    for (let c = a; c <= b; c++) if (abs[c] && abs[c].play) n++;
    return n;
  };
  return { row, start, end, before: col > start ? plays(start, col - 1) : 0, after: plays(col, end) };
}

// A one-line description of a lineup row, for a prompt or a log entry. Unlike
// `getActivePlayerName` this names a specific row rather than whoever is
// occupying the slot, and it says which row when the name is blank.
function rowLabel(team, pIdx) {
  if (!(gameState.teams[team] && gameState.teams[team].players[pIdx])) return 'row ' + pIdx;
  const spot = Math.floor(pIdx / ROWS_PER_POS) + 1;
  const row = pIdx % ROWS_PER_POS;
  // "Sub 3" meant the sub in spot 3 while a slot had one of them. With two it named
  // both rows identically, and the takeover prompt read "Sub 1 takes over" about a
  // spot whose current occupant was also "Sub 1" — so an unnamed sub row now says
  // which one it is as well as where. Numbered the same way the row's own
  // placeholder is, so the prompt and the card agree.
  const fallback = row === 0 ? 'Batter ' + spot
    : (ROWS_PER_POS > 2 ? 'Sub ' + row + ' in spot ' + spot : 'Sub ' + spot);
  const num = livePlayerField(team, pIdx, 'num');
  return (num ? '#' + num + ' ' : '') + (livePlayerField(team, pIdx, 'name') || fallback);
}

// The half-inning label a decision is being recorded in — the selected cell's,
// falling back to the card's first inning when nothing is selected (a lineup
// edit made before anybody has batted).
function currentInningLabel(team, innIdx) {
  const col = innIdx !== undefined && innIdx !== null ? innIdx : 0;
  return (team === 'visiting' ? 'T' : 'B') + (getRealInning(team, col) + 1);
}

/* The second press of SUB. Several different acts land on the same button, so this
   asks which — and spells out what each does to the card, because the choice
   changes who the recorded at-bats belong to. */
function promptSubRemoval(team, pIdx, innIdx) {
  const run = subLineRun(team, pIdx, innIdx);
  if (!run) return;

  // Nothing recorded under the sub anywhere in the run: this is a mis-press,
  // not a re-entry. Take the whole line back without ceremony.
  if (!run.before && !run.after) {
    /* Unless the line came from PR (L4). A pinch runner's line starts at the column
       *after* the one he came into, and the plate appearance he ran in — with the
       run he scored on it — stays on that column under `prRow`. So the run reads as
       "he never batted", and taking it back handed the whole line to the man he
       replaced while `prRow` kept the run for the man now off the card: the starter
       shown still in the game, and a run scored by somebody who is not.

       Refused rather than unwound, because unwinding means moving a run that has
       already been credited. Clearing his column is the act that takes a pinch
       runner back, and it already does the whole job. Once he has batted this is a
       real substitution and the prompt below handles it as one. */
    const prevAb = run.start > 0 ? gameState.teams[team].players[pIdx].atBats[run.start - 1] : null;
    if (prevAb && prevAb.prRow === run.row) {
      showPlayReject(rowLabel(team, pIdx + run.row) + ' came in as a pinch runner at ' +
        currentInningLabel(team, run.start - 1) + ' — clear that column instead.');
      return;
    }
    pushUndo(team, pIdx, innIdx);
    setSubLine(team, pIdx, run.start, run.end, run.row - 1);
    return;
  }

  // Clearing a sub line hands its columns back to whoever held them before, which
  // is the row above — the starter for the first sub, the first sub for the second.
  // It was always "the starter" while a slot had one sub row (H3).
  const prevRow = run.row - 1;
  const prev = rowLabel(team, pIdx + prevRow);
  const sub = rowLabel(team, pIdx + run.row);
  const nextRow = run.row + 1 < ROWS_PER_POS ? run.row + 1 : null;
  const innLabel = currentInningLabel(team, innIdx);
  const allowed = !!(gameState.rules && gameState.rules.allowReentry);
  const recorded = run.before + run.after;

  const opts = [];
  if (nextRow !== null) {
    // The whole point of a third row: a pinch hitter who has batted, now being
    // replaced in the field. Nothing comes off the card — the man already in the
    // slot keeps what he did, and the next row takes the columns from here on.
    opts.push({
      key: 'next',
      label: rowLabel(team, pIdx + nextRow) + ' takes over at ' + innLabel,
      note: 'A second substitution in this spot. ' + sub + ' keeps what he has recorded.'
    });
  }
  if (run.before) {
    // The sub has batted, so clearing from here forward puts the man above back in
    // the game. That is the re-entry, and it is what gets recorded.
    opts.push({
      key: 'reentry',
      label: prev + ' re-enters at ' + innLabel,
      note: allowed
        ? 'Recorded as a re-entry. This league allows it.'
        : 'Illegal under OBR 5.10(d) — a replaced player may not return. Recorded as entered.',
      warn: !allowed
    });
  }
  opts.push({
    key: 'undo',
    label: 'Undo the substitution',
    note: 'Clears the whole sub line. The ' + (recorded === 1 ? '1 at-bat' : recorded + ' at-bats') +
      ' recorded on it go' + (recorded === 1 ? 'es' : '') + ' back to ' + prev + '.'
  });

  let popup = document.getElementById('sub-popup');
  if (!popup) {
    popup = document.createElement('div');
    popup.id = 'sub-popup';
    popup.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:var(--card);border:3px solid var(--navy);border-radius:10px;padding:16px 20px;z-index:400;box-shadow:0 8px 40px rgba(26,39,68,0.4);min-width:280px;max-width:min(92vw,380px);font-family:var(--font);';
    document.body.appendChild(popup);
  }

  const heading = nextRow !== null ? 'Change this spot?' : 'Take the sub out?';
  let html = '<div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--navy);margin-bottom:8px;font-family:var(--heading)">' + heading + ' <span style="font-size:11px;color:var(--accent);font-weight:600;margin-left:6px">' + escapeHtml(innLabel) + '</span></div>';
  html += '<div style="font-size:11px;color:var(--text-light);margin-bottom:10px">' + escapeHtml(sub) +
    ' is batting in spot ' + (Math.floor(pIdx / ROWS_PER_POS) + 1) + ' for ' + escapeHtml(prev) + '.</div>';
  opts.forEach(o => {
    html += '<button class="sub-opt" data-key="' + o.key + '" style="display:block;width:100%;text-align:left;padding:7px 10px;margin-bottom:6px;border:1.5px solid ' +
      (o.warn ? 'var(--accent)' : '#ccc') + ';border-radius:4px;background:#fff;cursor:pointer;font-size:12px;font-weight:600;font-family:var(--font)">' +
      escapeHtml(o.label) +
      '<div style="font-size:10px;font-weight:400;margin-top:2px;color:' + (o.warn ? 'var(--accent)' : 'var(--text-light)') + '">' + escapeHtml(o.note) + '</div></button>';
  });
  if (run.before && !allowed) {
    html += '<label style="display:flex;align-items:center;gap:6px;font-size:10px;color:var(--text-light);margin:2px 0 8px">' +
      '<input type="checkbox" id="sub-allow-reentry"> This league allows re-entry — stop warning</label>';
  }
  html += '<button class="sub-opt" data-key="cancel" style="display:block;width:100%;padding:5px;font-size:11px;border:1px solid #ccc;border-radius:4px;background:#f5f5f5;cursor:pointer;font-family:var(--font)">Cancel</button>';
  popup.innerHTML = html;
  popup.style.display = 'block';

  popup.querySelectorAll('.sub-opt').forEach(btn => {
    btn.onclick = function () {
      const key = this.dataset.key;
      const box = document.getElementById('sub-allow-reentry');
      const nowAllowed = !!(box && box.checked);
      popup.style.display = 'none';
      if (key === 'cancel') return;
      if (nowAllowed) {
        if (!gameState.rules) gameState.rules = { allowReentry: false };
        gameState.rules.allowReentry = true;
      }
      pushUndo(team, pIdx, innIdx);
      if (key === 'next') {
        // From this column forward only: the columns behind stay with the man who
        // batted in them.
        setSubLine(team, pIdx, innIdx, run.end, nextRow);
        announce(rowLabel(team, pIdx + nextRow) + ' takes over at ' + innLabel);
      } else if (key === 'reentry') {
        recordReentry(team, pIdx, innIdx, innLabel, prev, sub);
        setSubLine(team, pIdx, innIdx, run.end, prevRow);
        announce(prev + ' re-enters at ' + innLabel);
      } else {
        setSubLine(team, pIdx, run.start, run.end, prevRow);
        announce('Substitution cleared in spot ' + (Math.floor(pIdx / ROWS_PER_POS) + 1));
      }
    };
  });
}

// Log a starter coming back in. One entry per slot per column — a scorer who
// answers the prompt twice at the same cell replaces the record rather than
// stacking a second one, the same way `applyFieldPos` handles a repeat.
function recordReentry(team, pIdx, col, innLabel, starterName, subName) {
  if (!Array.isArray(gameState.reentries)) gameState.reentries = [];
  const legal = !!(gameState.rules && gameState.rules.allowReentry);
  const prev = gameState.reentries.findIndex(r => r.team === team && r.pIdx === pIdx && r.col === col);
  if (prev >= 0) gameState.reentries.splice(prev, 1);
  gameState.reentries.push({
    team, pIdx, col, inning: innLabel,
    spot: Math.floor(pIdx / ROWS_PER_POS) + 1,
    starter: starterName, sub: subName, legal
  });
}

/* ------------------------------------------------------------- the DH ---
   `DH` was one more option in the position select with nothing behind it. OBR
   5.11 makes it a role with rules: one to a side, a batter only, and the pitcher
   is not in the batting order for as long as it lasts. The role can also be
   lost, and losing it is a legal event to record rather than an error to block —
   so nothing here refuses an entry either. Where the card cannot tell a lineup
   slip from a lost DH, it asks (the Rule 9.17(b) pattern), and while the lineup
   is still being typed it says so without a modal in the way. */

const FIELDING_POS = ['P', 'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF'];

// The DH picture for one side. Read off the live selects, which are the truth
// until `collectState` runs, with the state as the fallback for a headless
// caller. Sub rows count: a pinch-hitter who takes the DH's spot is the DH.
function dhState(team) {
  const players = (gameState.teams[team] && gameState.teams[team].players) || [];
  const dh = [], pitchers = [];
  for (let p = 0; p < players.length; p++) {
    const sel = document.querySelector(`select[data-field="pos"][data-team="${team}"][data-p="${p}"]`);
    const pos = sel ? sel.value : (players[p].pos || '');
    if (pos === 'DH') dh.push(p);
    else if (pos === 'P') pitchers.push(p);
  }
  const t = gameState.dhTerminated && gameState.dhTerminated[team];
  return { dh, pitchers, hasDH: dh.length > 0, terminated: t || null };
}

// Has this side batted yet? Before the first record the lineup is being entered
// and a half-typed card is normal; after it, a lineup that breaks a rule is an
// in-game event worth stopping for.
function teamHasRecords(team) {
  for (let ri = 0; ri < INNINGS; ri++) if (inningHasRecords(team, ri)) return true;
  return false;
}

// Set a row's position in the state and in the select together. Used by the DH
// prompts to put a card right; it deliberately does not re-run the rule check,
// so answering a prompt can't set off another one.
function setRowPos(team, pIdx, pos) {
  const players = gameState.teams[team] && gameState.teams[team].players;
  if (players && players[pIdx]) players[pIdx].pos = pos;
  const sel = document.querySelector(`select[data-field="pos"][data-team="${team}"][data-p="${pIdx}"]`);
  if (sel) sel.value = pos;
  autoSave();
}

// A position select changed by hand.
function posSelectChanged(sel) {
  const team = sel.dataset.team;
  const p = parseInt(sel.dataset.p);
  if (!team || Number.isNaN(p)) return;
  const players = gameState.teams[team] && gameState.teams[team].players;
  if (!players || !players[p]) return;
  const from = players[p].pos || '';
  players[p].pos = sel.value;
  checkDHRules(team, p, from, sel.value, null);
}

/* Put the DH rules to a lineup after row `p` moved from `fromPos` to `toPos`.
   `innLabel` is the half-inning to record against, or null to take it from the
   selected cell. Returns the name of the rule that fired, for the tests. */
function checkDHRules(team, p, fromPos, toPos, innLabel) {
  const label = innLabel || currentInningLabel(team, selectedCell && selectedCell.dataset.team === team
    ? parseInt(selectedCell.dataset.inn) : 0);
  const st = dhState(team);

  // 5.11(a)(3): the designated hitter taking a fielding position ends the role.
  // A legal and common move, so it is recorded and said out loud, not queried.
  if (fromPos === 'DH' && FIELDING_POS.includes(toPos)) {
    terminateDH(team, label, rowLabel(team, p) + ' took the field at ' + toPos);
    return 'dh-took-field';
  }

  // One DH to a side. Never legal either way round, and the scorer has just
  // typed one of the two, so ask which to keep instead of picking.
  if (toPos === 'DH' && st.dh.length > 1) {
    const other = st.dh.find(i => i !== p);
    promptDHChoice(team, {
      title: 'Two designated hitters',
      body: rowLabel(team, other) + ' is already the DH. A side may use only one (OBR 5.11(a)).',
      options: [
        { label: 'Keep this one — clear ' + rowLabel(team, other), run: () => setRowPos(team, other, '') },
        { label: 'Undo — leave the DH with ' + rowLabel(team, other), run: () => setRowPos(team, p, fromPos) }
      ]
    });
    return 'two-dh';
  }

  // 5.11(a): with a DH in the order the pitcher is not one of the nine batters.
  // Both on the card is either a lineup slip or the moment the DH was lost, and
  // the card can't tell which — so it asks once the game is under way, and
  // before then just says so and gets out of the way.
  if (st.hasDH && st.pitchers.length && !st.terminated) {
    const pitcherRow = st.pitchers[0], dhRow = st.dh[0];
    if (!teamHasRecords(team)) {
      showPlayReject('DH lineup: the pitcher does not bat. ' + rowLabel(team, pitcherRow) +
        ' is listed at P alongside DH ' + rowLabel(team, dhRow) + '.');
      return 'dh-and-pitcher-pregame';
    }
    promptDHChoice(team, {
      title: 'Pitcher in the batting order',
      body: rowLabel(team, pitcherRow) + ' is at P while ' + rowLabel(team, dhRow) +
        ' is the DH. Under OBR 5.11(a) the pitcher does not bat while a DH is in use.',
      options: [
        {
          label: 'The DH was lost at ' + label,
          note: 'The pitcher bats from here on. The DH cannot be restored (5.11(b)).',
          run: () => terminateDH(team, label, 'the pitcher entered the batting order')
        },
        {
          label: 'A mistake — undo this change',
          run: () => setRowPos(team, p, fromPos)
        }
      ]
    });
    return 'dh-and-pitcher';
  }
  return null;
}

// Record a side losing its DH. Once lost the role can't be restored (5.11(b)),
// so one slot per side is the whole record; a later termination overwrites it.
function terminateDH(team, innLabel, reason) {
  if (!gameState.dhTerminated) gameState.dhTerminated = { visiting: null, home: null };
  gameState.dhTerminated[team] = { inning: innLabel, reason };
  announce('DH terminated at ' + innLabel + ': ' + reason);
  showPlayReject('DH terminated at ' + innLabel + ' — ' + reason);
  autoSave();
}

/* A two-or-three-way DH question. Each option carries the work it does, so the
   rule logic above reads as rules and this only draws them. */
function promptDHChoice(team, spec) {
  let popup = document.getElementById('dh-popup');
  if (!popup) {
    popup = document.createElement('div');
    popup.id = 'dh-popup';
    popup.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:var(--card);border:3px solid var(--navy);border-radius:10px;padding:16px 20px;z-index:400;box-shadow:0 8px 40px rgba(26,39,68,0.4);min-width:280px;max-width:min(92vw,380px);font-family:var(--font);';
    document.body.appendChild(popup);
  }
  let html = '<div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--navy);margin-bottom:8px;font-family:var(--heading)">' + escapeHtml(spec.title) + '</div>';
  html += '<div style="font-size:11px;color:var(--text-light);margin-bottom:10px">' + escapeHtml(spec.body) + '</div>';
  spec.options.forEach((o, i) => {
    html += '<button class="dh-opt" data-idx="' + i + '" style="display:block;width:100%;text-align:left;padding:7px 10px;margin-bottom:6px;border:1.5px solid #ccc;border-radius:4px;background:#fff;cursor:pointer;font-size:12px;font-weight:600;font-family:var(--font)">' +
      escapeHtml(o.label) +
      (o.note ? '<div style="font-size:10px;font-weight:400;margin-top:2px;color:var(--text-light)">' + escapeHtml(o.note) + '</div>' : '') +
      '</button>';
  });
  popup.innerHTML = html;
  popup.style.display = 'block';
  popup.querySelectorAll('.dh-opt').forEach(btn => {
    btn.onclick = function () {
      const opt = spec.options[parseInt(this.dataset.idx)];
      popup.style.display = 'none';
      if (opt && opt.run) opt.run();
    };
  });
}

function changeFieldPos() {
  if (!selectedCell) return;
  const team = selectedCell.dataset.team;
  const pIdx = parseInt(selectedCell.dataset.p);
  const innIdx = parseInt(selectedCell.dataset.inn);
  const posIdx = Math.floor(pIdx / ROWS_PER_POS);
  const starterP = posIdx * ROWS_PER_POS;
  const posSelect = document.querySelector(`select[data-field="pos"][data-team="${team}"][data-p="${starterP}"]`);
  if (!posSelect) return;
  let popup = document.getElementById('pos-change-popup');
  if (!popup) {
    popup = document.createElement('div');
    popup.id = 'pos-change-popup';
    popup.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:var(--card);border:3px solid var(--navy);border-radius:10px;padding:16px 20px;z-index:300;box-shadow:0 8px 40px rgba(26,39,68,0.4);min-width:220px;font-family:var(--font);';
    document.body.appendChild(popup);
  }
  const positions = ['P','C','1B','2B','3B','SS','LF','CF','RF','DH'];
  const current = posSelect.value;
  const name = getActivePlayerName(team, starterP, innIdx);
  const halfLabel = team === 'visiting' ? 'T' : 'B';
  const realInn = getRealInning(team, innIdx) + 1;
  const innLabel = halfLabel + realInn;
  let html = '<div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--navy);margin-bottom:10px;font-family:var(--heading)">Position Change <span style="font-size:11px;color:var(--accent);font-weight:600;margin-left:6px">' + innLabel + '</span></div>';
  html += '<div style="font-size:11px;margin-bottom:8px;color:var(--text-light)">' + escapeHtml(name) + ' — current: <b>' + escapeHtml(current || 'none') + '</b></div>';
  html += '<div style="display:flex;gap:4px;flex-wrap:wrap">';
  positions.forEach(pos => {
    const isCurrent = pos === current;
    html += `<button data-act="applyFieldPosFromEl" data-arg="this" data-team="${team}" data-p="${starterP}" data-pos="${pos}" data-inn="${escapeHtml(innLabel)}" style="padding:5px 10px;font-size:11px;font-weight:${isCurrent?'700':'600'};border:1.5px solid ${isCurrent?'var(--navy)':'#ccc'};border-radius:4px;background:${isCurrent?'var(--cream)':'#fff'};color:${isCurrent?'var(--navy)':'#555'};cursor:pointer;font-family:var(--mono)">${pos}</button>`;
  });
  html += '</div>';
  html += '<button data-act="hidePopupById" data-arg="pos-change-popup" style="margin-top:10px;width:100%;padding:5px;font-size:11px;border:1px solid #ccc;border-radius:4px;background:#f5f5f5;cursor:pointer">Cancel</button>';
  popup.innerHTML = html;
  popup.style.display = 'block';
}

function applyFieldPos(team, starterP, pos, innLabel) {
  const posSelect = document.querySelector(`select[data-field="pos"][data-team="${team}"][data-p="${starterP}"]`);
  const oldPos = posSelect ? posSelect.value : '';
  if (posSelect) { posSelect.value = pos; }
  // Setting the select by hand fires no change event, so the state and the DH
  // check both have to be driven from here.
  const posPlayer = gameState.teams[team] && gameState.teams[team].players[starterP];
  if (posPlayer) posPlayer.pos = pos;
  if (oldPos && oldPos !== pos && innLabel) {
    if (!gameState.defChanges) gameState.defChanges = [];
    // Whoever is in the slot now, which may be the second sub (H3) — named through
    // `rowLabel`, which reads the inputs (M3). This built the name out of state and
    // then *stored* it, so a change recorded inside the 400ms save debounce was
    // logged permanently as "Pos 1". Audit 3's L3 was the same bug in a place that
    // only displayed it; here it goes onto the card. `rowLabel` also numbers an
    // unnamed row the way the row's own placeholder does.
    const displayName = rowLabel(team, starterP + currentSlotRow(team, starterP));
    let existing = gameState.defChanges.find(d => d.inning === innLabel && d.team === team);
    if (!existing) {
      existing = { inning: innLabel, team, changes: [] };
      gameState.defChanges.push(existing);
    }
    const prevEntry = existing.changes.findIndex(c => c.pIdx === starterP);
    if (prevEntry >= 0) existing.changes.splice(prevEntry, 1);
    existing.changes.push({ pIdx: starterP, fromPos: oldPos, toPos: pos, name: displayName });
  }
  // L5: the popup that builds it lazily is this function's only caller, so the
  // dereference is latent — but it is one line from a crash that would take the
  // position change with it, and m6 guarded the identical shape in `setPitcher`.
  const popup = document.getElementById('pos-change-popup');
  if (popup) popup.style.display = 'none';
  autoSave();
  // After the popup is down, so a DH question doesn't open behind it.
  if (oldPos !== pos) checkDHRules(team, starterP, oldPos, pos, innLabel);
}

function setPitcher(idx) {
  if (!selectedCell) return;
  const team = selectedCell.dataset.team;
  const pIdx = parseInt(selectedCell.dataset.p);
  const innIdx = parseInt(selectedCell.dataset.inn);
  pushUndo(team, pIdx, innIdx);
  const inn = getInnState(team, innIdx);
  inn.currentPitcher = idx;
  inn.pitcherSet = true; // explicit change here — later innings inherit via getEffectivePitcher
  // Mark this cell with the new pitcher's number
  const pitchingTeam = team === 'visiting' ? 'home' : 'visiting';
  const pitcherNum = gameState.teams[pitchingTeam].pitchers[idx]?.num || String(idx + 1);
  const ab = gameState.teams[team].players[pIdx].atBats[innIdx];
  ab.pitcherChangeNum = pitcherNum;
  renderPitcherChange(team, pIdx, innIdx);
  // changePitcher builds #pitcher-popup lazily, so it exists only because the popup
  // is this function's only caller. Guarded rather than relying on that (m6) — every
  // other popup in the file is dismissed through a null check or hidePopupById.
  const popup = document.getElementById('pitcher-popup');
  if (popup) popup.style.display = 'none';
  // The panel names the man on the mound now, so the handover has to reach it here
  // — otherwise it keeps naming the pitcher who just left until the next pitch.
  updateSituation();
  autoSave();
}

/* Put a column's mound state back to what its change markers say (M1).

   `setPitcher` writes two things: the marker on the cell, and `currentPitcher` /
   `pitcherSet` on the inning. Clearing the cell took back the marker and left the
   inning pointing at the reliever, so the card no longer recorded when he came in
   while the state still had him out there — `getEffectivePitcher` said reliever,
   `computePitcherPlan`, which walks the markers, said starter, and "Fix Stats"
   offered to move at-bats to a man it disagreed with itself about.

   The markers are the record, so they are what this reads. The last one in the
   column wins — a column can hand the ball over twice — and with none left the
   column stops claiming a pitcher of its own and inherits again, which is what
   `getEffectivePitcher` does with `pitcherSet` false. Every row is walked, not
   just the starters: a change can be marked on a substitute's cell. */
function resyncInningPitcher(team, innIdx) {
  const inn = getInnState(team, innIdx);
  const pitchers = gameState.teams[team === 'visiting' ? 'home' : 'visiting'].pitchers;
  const players = gameState.teams[team].players;
  let found = null;
  for (let p = 0; p < players.length; p++) {
    const ab = players[p].atBats[innIdx];
    if (!ab || !ab.pitcherChangeNum) continue;
    const idx = resolvePitcherIndex(pitchers, ab.pitcherChangeNum);
    if (idx != null) found = idx;
  }
  if (found != null) {
    inn.currentPitcher = found;
    inn.pitcherSet = true;
  } else {
    inn.pitcherSet = false;
    // Left agreeing with what the column now inherits: the outs-log backfill
    // (app.js:4752) reads `currentPitcher` directly rather than asking, and a
    // column that says one thing and inherits another is the bug over again.
    inn.currentPitcher = innIdx > 0 ? getEffectivePitcher(team, innIdx - 1) : 0;
  }
}

function renderPitcherChange(team, pIdx, innIdx) {
  const ab = gameState.teams[team].players[pIdx].atBats[innIdx];
  const el = document.getElementById('pcm-' + team + '-' + pIdx + '-' + innIdx);
  if (el) {
    el.classList.toggle('active', !!ab.pitcherChangeNum);
    el.setAttribute('data-pnum', ab.pitcherChangeNum ? '#' + ab.pitcherChangeNum : '');
  }
  const sel = document.getElementById('scm-' + team + '-' + pIdx + '-' + innIdx);
  if (sel) {
    const prev = innIdx > 0 ? gameState.teams[team].players[pIdx].atBats[innIdx - 1] : null;
    // The mark goes on the column where the slot changes hands, so a *second*
    // substitution is marked too — not just the first one off the starter (H3).
    // A pinch runner changes hands *inside* his column rather than at its edge, so
    // he is marked on the column he came into (H2).
    const isSubStart = !!ab.prRow || (subRowOf(ab) > 0 && subRowOf(ab) !== subRowOf(prev));
    sel.classList.toggle('active', isSubStart);
  }
}

// Map a jersey number stored on a change marker back to a pitcher row index.
// setPitcher stores pitchers[idx].num, or String(idx+1) when the pitcher has
// no number — so we reverse both forms.
function resolvePitcherIndex(pitchers, num) {
  const s = String(num);
  for (let i = 0; i < pitchers.length; i++) {
    if ((pitchers[i].num || String(i + 1)) === s) return i;
  }
  return null;
}

// One-time repair: re-derive ab.pitcher for every recorded at-bat from the
// pitching-change markers already on the card. Columns are in chronological
// order, so a single left-to-right / top-to-bottom pass with a running pitcher
// reconstructs cross-inning carry-forward, mid-inning changes, and multi-relief
// correctly. Nothing but ab.pitcher is touched; the markers are the source of
// truth and are left as-is.
function computePitcherPlan() {
  const plan = [];
  ['visiting','home'].forEach(battingTeam => {
    const pitchingTeam = battingTeam === 'visiting' ? 'home' : 'visiting';
    const pitchers = gameState.teams[pitchingTeam].pitchers;
    const players = gameState.teams[battingTeam].players;
    let running = 0; // starter, carried across inning columns
    for (let col = 0; col < INNINGS; col++) {
      for (let pos = 0; pos < POSITIONS; pos++) {
        const row = pos * ROWS_PER_POS;
        const ab = players[row] && players[row].atBats[col];
        if (!ab) continue;
        if (ab.pitcherChangeNum) {
          const idx = resolvePitcherIndex(pitchers, ab.pitcherChangeNum);
          if (idx != null) running = idx;
        }
        if (ab.play && (ab.pitcher || 0) !== running) {
          plan.push({ ab, from: ab.pitcher || 0, to: running });
        }
      }
    }
  });
  return plan;
}

/* The outs that go with the at-bats a repair moves (M3).

   IP is not derived from `ab.pitcher`: it counts `inn.outsLog[]` entries, each
   stamped with the pitcher who was on the mound when that out was made. So moving
   the at-bats alone moved a strikeout and left the out that made it behind — starter
   0.2 IP with 1 K, reliever 0.0 IP with 1 K — while the popup promised it updates
   IP.

   An out belongs to the play that caused it, and `srcP`/`srcCol` point at that plate
   appearance, so the outs to move are the ones whose source at-bat the plan moves.
   Only those still stamped with that at-bat's *old* pitcher, though: a caught
   stealing or a pickoff is logged against the runner's own batting cell on purpose
   (see `applyCSAtBase`), carrying the pitcher who threw it rather than the one the
   runner batted against, and the log has never recorded which plate appearance it
   happened during. So one already attributed away from its cell is left where it is
   — there is nothing here that could work out where it belongs. */
function outLogPlanFor(plan) {
  const moves = [];
  if (!plan.length) return moves;
  const planned = new Map(plan.map(p => [p.ab, p]));
  ['visiting', 'home'].forEach(battingTeam => {
    const players = gameState.teams[battingTeam].players;
    const innings = (gameState.innings && gameState.innings[battingTeam]) || [];
    for (let col = 0; col < INNINGS; col++) {
      const inn = innings[col];
      if (!inn || !Array.isArray(inn.outsLog)) continue;
      for (const o of inn.outsLog) {
        if (o.srcP == null) continue;
        const srcAb = players[o.srcP] && players[o.srcP].atBats[o.srcCol];
        const p = srcAb && planned.get(srcAb);
        if (!p || (o.pitcher || 0) !== p.from) continue;
        moves.push({ out: o, to: p.to });
      }
    }
  });
  return moves;
}

function recomputePitcherAssignments() {
  const plan = computePitcherPlan();
  let popup = document.getElementById('recompute-popup');
  if (!popup) {
    popup = document.createElement('div');
    popup.id = 'recompute-popup';
    popup.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:var(--card,#fff);border:2px solid var(--navy,#1a2744);border-radius:8px;padding:16px 18px;z-index:400;box-shadow:0 8px 40px rgba(0,0,0,0.35);min-width:260px;max-width:340px;font-family:var(--font);';
    document.body.appendChild(popup);
  }
  let html = '<div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--navy,#1a2744);margin-bottom:8px">Recompute Pitcher Stats</div>';
  if (!plan.length) {
    html += '<div style="font-size:12px;color:var(--text-light,#666);margin-bottom:10px">All at-bats are already attributed to the correct pitcher. Nothing to change.</div>';
    html += '<button data-act="hidePopupById" data-arg="recompute-popup" style="width:100%;padding:6px;font-size:12px;border:1px solid #ccc;border-radius:4px;background:#f5f5f5;cursor:pointer">Close</button>';
  } else {
    html += '<div style="font-size:12px;color:var(--text-light,#666);margin-bottom:10px">Re-attributes <b>' + plan.length + '</b> at-bat' + (plan.length === 1 ? '' : 's') + ' to the correct pitcher based on the pitching changes recorded on the card. This updates IP, PC, H, R, ER, K and BB. It cannot be auto-undone.</div>';
    html += '<div style="display:flex;gap:6px"><button id="rc-apply" style="flex:1;padding:7px;font-size:12px;font-weight:700;background:var(--navy,#1a2744);color:var(--gold,#c8a44b);border:none;border-radius:4px;cursor:pointer;text-transform:uppercase">Apply</button>';
    html += '<button id="rc-cancel" style="padding:7px 12px;font-size:12px;border:1px solid #ccc;border-radius:4px;background:#f5f5f5;cursor:pointer">Cancel</button></div>';
  }
  popup.innerHTML = html;
  popup.style.display = 'block';
  const cancel = document.getElementById('rc-cancel');
  if (cancel) cancel.onclick = () => { popup.style.display = 'none'; };
  const apply = document.getElementById('rc-apply');
  if (apply) apply.onclick = () => {
    // The outs are worked out against the attribution the plan is replacing, so
    // they are collected before the at-bats move (M3).
    const outMoves = outLogPlanFor(plan);
    plan.forEach(p => { p.ab.pitcher = p.to; });
    outMoves.forEach(m => { m.out.pitcher = m.to; });
    updatePitcherStats('visiting');
    updatePitcherStats('home');
    autoSave();
    popup.style.display = 'none';
  };
}

/* Play-by-Play Log (Feature 7) */
function toggleQBDrawer() {
  const drawers = document.querySelectorAll('.qb-drawer');
  const btns = document.querySelectorAll('.qb-more-btn');
  const isOpen = drawers[0] && drawers[0].classList.contains('open');
  drawers.forEach(d => d.classList.toggle('open', !isOpen));
  btns.forEach(b => { b.classList.toggle('open', !isOpen); b.textContent = isOpen ? '···' : '∧'; });
}

function updateInningVisibility() {
  const vis = visibleInningCount();
  for (let i = 0; i < INNINGS; i++) {
    const show = i < vis;
    document.querySelectorAll(`.inn-col[data-inn="${i}"], .at-bat-cell[data-inn="${i}"], [data-inn-col="${i}"]`)
      .forEach(el => el.classList.toggle('hidden-inning', !show));
  }
  const btn = document.getElementById('add-extra-inn-btn');
  if (btn) btn.style.display = vis < INNINGS ? '' : 'none';
}

function addExtraInning() {
  if (!gameState.visibleInnings) gameState.visibleInnings = regulationInnings();
  if (gameState.visibleInnings < INNINGS) {
    gameState.visibleInnings++;
    updateInningVisibility();
    autoSave();
  }
}

function updateExtraInnings() { updateInningVisibility(); }

/* The scorer sets regulation length; the card follows it. Columns are never taken
   away from a half-inning that already has plays — dropping to 7 after nine have
   been scored would hide real at-bats behind `hidden-inning` — so the floor is the
   last column in use. `gameOverShown` is reset because the answer to "is this game
   over" has just changed: shortening the game can make a finished card final, and
   lengthening it un-finals one. */
function setRegulationInnings(value) {
  const n = parseInt(value);
  if (!(n >= 1 && n <= INNINGS)) return;
  if (!gameState.rules) gameState.rules = { allowReentry: false, regulationInnings: DEFAULT_REGULATION };
  gameState.rules.regulationInnings = n;
  gameState.visibleInnings = Math.max(n, lastColumnWithPlays() + 1);
  gameOverShown = false;
  updateInningVisibility();
  updateLiveStatsFromState();
  autoSave();
}

/* Highest column index either side has a recorded play in, or -1 for an empty
   card. Used as the floor on how far the inning columns can be pulled back. */
function lastColumnWithPlays() {
  let last = -1;
  ['visiting', 'home'].forEach(team => {
    for (const player of gameState.teams[team].players) {
      for (let col = 0; col < player.atBats.length; col++) {
        if (player.atBats[col].play && col > last) last = col;
      }
    }
  });
  return last;
}

/* Game Timer (Feature 13) */
let timerInterval = null;

function toggleGameTimer() {
  const btn = document.getElementById('timer-btn');
  if (gameState.timerRunning) {
    // Stop
    clearInterval(timerInterval);
    gameState.timerRunning = false;
    gameState.timerElapsed = getElapsedSeconds();
    gameState.timerStart = null;
    btn.textContent = 'Start';
    // Auto-fill time of game
    const elapsed = gameState.timerElapsed;
    const hrs = Math.floor(elapsed / 3600);
    const mins = Math.floor((elapsed % 3600) / 60);
    const timeStr = hrs > 0 ? `${hrs}:${String(mins).padStart(2, '0')}` : `${mins}m`;
    document.getElementById('info-time-of-game').value = timeStr;
    gameState.info.timeOfGame = timeStr;
  } else {
    // Start
    gameState.timerRunning = true;
    gameState.timerStart = Date.now();
    btn.textContent = 'Stop';
    timerInterval = setInterval(updateTimerDisplay, 1000);
    updateTimerDisplay();
  }
  autoSave();
}

function getElapsedSeconds() {
  let elapsed = gameState.timerElapsed || 0;
  if (gameState.timerRunning && gameState.timerStart) {
    elapsed += Math.floor((Date.now() - gameState.timerStart) / 1000);
  }
  return elapsed;
}

function updateTimerDisplay() {
  const elapsed = getElapsedSeconds();
  const hrs = Math.floor(elapsed / 3600);
  const mins = Math.floor((elapsed % 3600) / 60);
  const secs = elapsed % 60;
  const display = document.getElementById('timer-display');
  if (display) {
    display.textContent = hrs > 0
      ? `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
      : `${mins}:${String(secs).padStart(2, '0')}`;
  }
}

/* Game Library (Feature 8) */
const LIBRARY_KEY = 'baseball-scorecard-library';
const CURRENT_GAME_KEY = 'baseball-scorecard';

function getGameLibrary() {
  const raw = safeStorage.getItem(LIBRARY_KEY);
  if (raw === null || raw === '') return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch(e) { parsed = undefined; }
  // A library that won't parse used to read as "no saved games yet", and the
  // next save wrote one entry over however many were in there (#25).
  if (!Array.isArray(parsed)) {
    quarantineUnreadable(LIBRARY_KEY, raw);
    return [];
  }
  return parsed;
}

function saveGameLibrary(library) {
  if (saveBlockedFor(LIBRARY_KEY)) {
    alert('The saved-game library on this device is unreadable and could not be backed up. Download it from the banner at the top of the page, then discard it, before saving another game.');
    return false;
  }
  safeStorage.setItem(LIBRARY_KEY, JSON.stringify(library));
  return true;
}

function openGameLibrary() {
  const modal = document.getElementById('game-library-modal');
  modal.classList.add('active');
  renderGameLibrary();
  updateLibraryButtons();
}

// Show the "Update Saved Game" button only when the game in progress
// corresponds to an existing library entry.
function updateLibraryButtons() {
  const btn = document.getElementById('lib-update-btn');
  if (!btn) return;
  const inLibrary = gameState.currentGameId &&
    getGameLibrary().some(g => g.id === gameState.currentGameId);
  btn.style.display = inLibrary ? '' : 'none';
}

function closeGameLibrary() {
  document.getElementById('game-library-modal').classList.remove('active');
}

function renderGameLibrary() {
  const library = getGameLibrary();
  const listEl = document.getElementById('game-library-list');
  if (library.length === 0) {
    listEl.innerHTML = '<p style="font-size:12px;color:var(--text-light);padding:10px">No saved games yet. Click "Save as New Game" to save this game.</p>';
    return;
  }
  let html = '<ul class="game-list">';
  library.forEach((game, idx) => {
    const date = escapeHtml(game.date || 'No date');
    const teams = escapeHtml(game.teams || 'Unknown teams');
    const score = escapeHtml(game.score || '');
    const saved = game.lastSaved ? 'Saved ' + escapeHtml(game.lastSaved) : '';
    const isCurrent = game.id && game.id === gameState.currentGameId;
    html += `<li>
      <div>
        <div class="game-info-text">${teams}${isCurrent ? ' <span style="color:var(--navy);font-weight:600">● current</span>' : ''}</div>
        <div class="game-date">${date} ${score ? '| ' + score : ''}</div>
        ${saved ? `<div class="game-date">${saved}</div>` : ''}
      </div>
      <div>
        <button class="load-btn" data-act="loadGameFromLibrary" data-argnum="${idx}">Load</button>
        <button class="del-btn" data-act="deleteGameFromLibrary" data-argnum="${idx}">Delete</button>
      </div>
    </li>`;
  });
  html += '</ul>';
  listEl.innerHTML = html;
}

// Build a library entry (metadata + deep-copied state) from the current game.
// Stamps `lastSaved` onto the live state first so it travels into the snapshot.
function buildLibraryEntry(id) {
  const vis = gameState.info.visitingTeam || 'Visiting';
  const hom = gameState.info.homeTeam || 'Home';
  const vR = document.querySelector('input[data-ls="visiting"][data-stat="r"]');
  const hR = document.querySelector('input[data-ls="home"][data-stat="r"]');
  const score = `${vR ? vR.value || 0 : 0} - ${hR ? hR.value || 0 : 0}`;
  gameState.lastSaved = new Date().toLocaleString();
  return {
    id: id,
    date: gameState.info.date || new Date().toLocaleDateString(),
    teams: `${vis} vs ${hom}`,
    score: score,
    lastSaved: gameState.lastSaved,
    state: JSON.parse(JSON.stringify(stateForStorage(gameState)))
  };
}

function saveAsNewGame() {
  collectState();
  const library = getGameLibrary();
  const id = Date.now().toString(36);
  gameState.currentGameId = id;   // set before snapshot so it's captured
  library.push(buildLibraryEntry(id));
  saveGameLibrary(library);
  flushSave();
  renderGameLibrary();
  updateLibraryButtons();
}

// Replace the existing library entry for the current game in place. Falls back
// to saving a new game if the current id no longer matches any entry.
function updateSavedGame() {
  collectState();
  const library = getGameLibrary();
  const idx = library.findIndex(g => g.id === gameState.currentGameId);
  if (idx === -1) { saveAsNewGame(); return; }
  library[idx] = buildLibraryEntry(gameState.currentGameId);
  saveGameLibrary(library);
  flushSave();
  renderGameLibrary();
  updateLibraryButtons();
}

// Serialize state for change-detection, ignoring the save timestamp.
function stateSignature(state) {
  // Through stateForStorage so a live state and a stored one — which has its sub
  // rows emptied — compare as the same game rather than always differing.
  const clone = JSON.parse(JSON.stringify(stateForStorage(state)));
  delete clone.lastSaved;
  return JSON.stringify(clone);
}

// Is there anything on this card worth stopping for? Records first — but a lineup
// typed in before the first pitch is somebody's work too, and it is read off the
// inputs because that is where it still is inside the 400ms debounce.
function cardHasContent() {
  if (teamHasRecords('visiting') || teamHasRecords('home')) return true;
  for (const team of ['visiting', 'home']) {
    const players = gameState.teams[team].players;
    for (let p = 0; p < players.length; p++) {
      if (livePlayerField(team, p, 'name') || livePlayerField(team, p, 'num')) return true;
    }
  }
  return false;
}

// True if the in-progress game differs from its saved library snapshot.
function currentGameHasUnsavedChanges() {
  const entry = gameState.currentGameId
    ? getGameLibrary().find(g => g.id === gameState.currentGameId)
    : null;
  // H2: no entry to compare against is not "nothing to lose" — it is the card most
  // at risk. A game that was never "Save as New Game"d has `currentGameId: null`,
  // and one whose library entry has been deleted has an id matching nothing; in
  // both cases its only copy is the `baseball-scorecard` slot that the caller is
  // about to write the incoming game over, after which it is gone for good. So
  // anything recorded on it counts as unsaved, and the scorer gets his confirm.
  if (!entry || !entry.state) return cardHasContent();
  return stateSignature(gameState) !== stateSignature(entry.state);
}

function loadGameFromLibrary(idx) {
  const library = getGameLibrary();
  if (!library[idx] || !library[idx].state || !library[idx].state.teams) return;
  collectState();  // capture live DOM edits before comparing
  if (currentGameHasUnsavedChanges() &&
      !confirm('The current game has unsaved changes that will be lost. Load the selected game anyway?')) {
    return;
  }
  flushSave();  // persist the outgoing game before switching
  // #28: run the same backfill `importGameJSON` does. A library entry saved by
  // an older build is missing whatever has been added to the state since, and
  // assigning it raw left those fields undefined downstream.
  gameState = mergeStateDefaults(library[idx].state);
  playHistory = [];
  redoHistory = [];
  gameOverShown = false;
  backupPromptDismissed = false;   // a different card gets its own ask
  applyState();
  closeGameLibrary();
  flushSave();
  updateLibraryButtons();
}

function deleteGameFromLibrary(idx) {
  const library = getGameLibrary();
  if (!confirm('Delete this saved game?')) return;
  library.splice(idx, 1);
  saveGameLibrary(library);
  renderGameLibrary();
}

/* Export / Import — offline JSON backup of the in-progress game. No
   dependencies: a Blob download out, a file input in. Doubles as the recovery
   path when localStorage can't persist (see reportStorageFailure). */
function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Delay revoke so the download has time to start (Safari/iOS).
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function exportGameJSON() {
  collectState();
  // Stamped before serialising, so the file records that it *is* the backup — import
  // it later and the card doesn't immediately ask to be backed up again. `flushSave`
  // rather than `autoSave` because the stamp is the point: a debounced save that the
  // scorer closes the tab ahead of would lose it.
  gameState.backedUp = true;
  const slug = s => (s || '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
  const vis = slug(gameState.info.visitingTeam) || 'visiting';
  const hom = slug(gameState.info.homeTeam) || 'home';
  downloadTextFile(`scorecard-${vis}-vs-${hom}.json`, JSON.stringify(stateForStorage(gameState), null, 2));
  flushSave();
  updateBackupReminder();
}

function importGameJSON(input) {
  const file = input.files && input.files[0];
  input.value = '';  // allow re-importing the same file later
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function() {
    let parsed;
    try {
      parsed = JSON.parse(reader.result);
    } catch(e) {
      alert('That file is not valid JSON and could not be imported.');
      return;
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.teams || !parsed.info) {
      alert('That file does not look like a saved scorecard game.');
      return;
    }
    collectState();  // capture live DOM edits before comparing
    if (currentGameHasUnsavedChanges() &&
        !confirm('The current game has unsaved changes that will be lost. Import the selected file anyway?')) {
      return;
    }
    flushSave();  // persist the outgoing game before switching
    gameState = mergeStateDefaults(parsed);
    playHistory = [];
    redoHistory = [];
    gameOverShown = false;
    backupPromptDismissed = false;
    applyState();
    flushSave();
    updateLibraryButtons();
    closeGameLibrary();
  };
  reader.onerror = function() { alert('Could not read that file.'); };
  reader.readAsText(file);
}

/* ------------------------------------------- pitcher decisions (Phase 8b) ---
   Replaces a heuristic that guessed: most IP on the winning side took the win,
   most ER on the losing side took the loss (and with no ER recorded that was
   always the losing team's first row), and the save test was
   `margin <= 3 || IP >= 3`, which is not the save rule. All three were printed
   in the summary as fact (#18).

   The rules need three things the card now records: when each run scored
   (`ab.seq`), who put that runner on (`ab.pitcher` — which is exactly the
   pitcher Rule 9.16 charges with the run), and which pitcher was on the mound
   for each out (`inn.outsLog`). Nothing here re-infers any of that.

   Where a rule is explicitly the scorer's judgment — 9.17(b)'s starter who did
   not go five — this offers the candidates rather than picking one. Every
   decision can also be overridden by hand; overrides persist in
   `gameState.decisions`. */

function pitcherLabel(team, idx) {
  const p = gameState.teams[team].pitchers[idx];
  if (!p) return '';
  if (!p.name && !p.num) return 'Pitcher ' + (idx + 1);
  return (p.num ? '#' + p.num + ' ' : '') + (p.name || 'Pitcher ' + (idx + 1));
}

function cmpPlayOrder(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

// Every run in the game, in the order it was scored, with the running score
// after each. A runner's own plate appearance is the ordering key inside a
// half-inning: runners can't pass each other, so they cross the plate in the
// order they reached. A game saved before `ab.seq` existed has none, and falls
// back to column-then-batting-order — flagged as approximate rather than
// presented as exact.
function runTimeline() {
  const runs = [];
  ['visiting','home'].forEach(battingTeam => {
    const players = gameState.teams[battingTeam].players;
    const half = battingTeam === 'visiting' ? 0 : 1;
    for (let ri = 0; ri < INNINGS; ri++) {
      for (const col of getColumnsForInning(battingTeam, ri)) {
        for (let p = 0; p < players.length; p++) {
          const ab = players[p].atBats[col];
          if (!ab || !ab.play) continue;
          if (!(ab.bases[0] && ab.bases[1] && ab.bases[2] && ab.bases[3])) continue;
          if (ab.outOnBase != null) continue;
          runs.push({
            battingTeam, realInn: ri, col,
            order: [ri, half, ab.seq || 0, col, p],
            hasSeq: !!ab.seq,
            chargedPitcher: ab.pitcher || 0
          });
        }
      }
    }
  });
  runs.sort((a, b) => cmpPlayOrder(a.order, b.order));
  let v = 0, h = 0;
  runs.forEach(r => {
    if (r.battingTeam === 'visiting') v++; else h++;
    r.scoreAfter = { visiting: v, home: h };
  });
  return runs;
}

// Outs charged to each pitcher of `pitchingTeam`, straight off the out log.
function pitcherOutCounts(pitchingTeam) {
  const battingTeam = pitchingTeam === 'visiting' ? 'home' : 'visiting';
  const counts = {};
  for (let ri = 0; ri < INNINGS; ri++) {
    for (const o of inningOutsLog(battingTeam, ri)) {
      const i = o.pitcher || 0;
      counts[i] = (counts[i] || 0) + 1;
    }
  }
  return counts;
}

// The winning team's pitcher of record when their go-ahead run scored: the last
// man to have pitched for them, which is whoever was on the mound the last time
// the losing team batted before that run.
function pitcherOfRecordAt(winTeam, loseTeam, ri) {
  const lastRi = winTeam === 'visiting' ? ri - 1 : ri;
  if (lastRi < 0) return 0;   // nobody has pitched yet — the starter
  const cols = getColumnsForInning(loseTeam, lastRi);
  return getEffectivePitcher(loseTeam, cols.length ? cols[cols.length - 1] : lastRi);
}

// Who finished the game for `pitchingTeam` — the man on the mound for the last
// out the other side made. -1 if they never retired anybody.
function finishingPitcher(pitchingTeam) {
  const battingTeam = pitchingTeam === 'visiting' ? 'home' : 'visiting';
  for (let ri = INNINGS - 1; ri >= 0; ri--) {
    const log = inningOutsLog(battingTeam, ri);
    if (log.length) return log[log.length - 1].pitcher || 0;
  }
  return -1;
}

// How the game stood when a reliever came in: the score before his first batter
// and how many runners he inherited. The runner count is read off the records of
// the half-inning he walked into — men who reached earlier in it and neither
// scored nor were put out — so it is exactly as good as the card is.
function pitcherEntryState(pitchingTeam, pIdx, timeline) {
  const battingTeam = pitchingTeam === 'visiting' ? 'home' : 'visiting';
  const players = gameState.teams[battingTeam].players;
  const half = battingTeam === 'visiting' ? 0 : 1;
  let first = null;
  for (let ri = 0; ri < INNINGS; ri++) {
    for (const col of getColumnsForInning(battingTeam, ri)) {
      for (let p = 0; p < players.length; p++) {
        const ab = players[p].atBats[col];
        if (!ab || !ab.play || (ab.pitcher || 0) !== pIdx) continue;
        const key = [ri, half, ab.seq || 0, col, p];
        if (!first || cmpPlayOrder(key, first.key) < 0) first = { key, ri };
      }
    }
  }
  if (!first) return null;
  const before = timeline.filter(r => cmpPlayOrder(r.order, first.key) < 0);
  const scoreAt = before.length ? before[before.length - 1].scoreAfter : { visiting: 0, home: 0 };
  let onBase = 0;
  for (const col of getColumnsForInning(battingTeam, first.ri)) {
    for (let p = 0; p < players.length; p++) {
      const ab = players[p].atBats[col];
      if (!ab || !ab.play) continue;
      if (cmpPlayOrder([first.ri, half, ab.seq || 0, col, p], first.key) >= 0) continue;
      if (ab.bases[0] && !ab.bases[3] && ab.outOnBase == null) onBase++;
    }
  }
  return { ri: first.ri, scoreAt, onBase };
}

// How many innings the game actually went, for 9.17(b)'s "game of 6 or more".
function inningsPlayed() {
  let last = -1;
  for (let ri = 0; ri < INNINGS; ri++) {
    if (inningHasRecords('visiting', ri) || inningHasRecords('home', ri)) last = ri;
  }
  return last + 1;
}

function teamRunTotal(team) {
  const el = document.querySelector(`input[data-ls="${team}"][data-stat="r"]`);
  return parseInt(el && el.value) || 0;
}

function computePitcherDecisions() {
  const res = {
    winTeam: null, loseTeam: null, wp: null, lp: null, sv: null,
    judgment: null, winCandidates: [], approximate: false
  };
  const vR = teamRunTotal('visiting'), hR = teamRunTotal('home');
  if (vR === hR) return res;                       // a tie yields no decisions

  const winTeam = res.winTeam = vR > hR ? 'visiting' : 'home';
  const loseTeam = res.loseTeam = vR > hR ? 'home' : 'visiting';
  const timeline = runTimeline();
  if (!timeline.length) return res;
  res.approximate = timeline.some(r => !r.hasSeq);

  // The go-ahead run: the earliest run from which the winner led without ever
  // giving it back. Scanning from the end, it is the first run at which the
  // winner's lead becomes unbroken.
  let idx = timeline.length;
  for (let i = timeline.length - 1; i >= 0; i--) {
    if (timeline[i].scoreAfter[winTeam] > timeline[i].scoreAfter[loseTeam]) idx = i;
    else break;
  }
  if (idx === timeline.length) return res;         // shouldn't happen with a winner
  const goAhead = timeline[idx];

  // Rule 9.17(d): the loss goes to the pitcher charged with the go-ahead run —
  // which `ab.pitcher` already records, since it is the man who put that runner
  // on base.
  res.lp = goAhead.chargedPitcher;

  // Rule 9.17: the win goes to the winning team's pitcher of record at that run.
  const ofRecord = pitcherOfRecordAt(winTeam, loseTeam, goAhead.realInn);
  res.wp = ofRecord;

  const winOuts = pitcherOutCounts(winTeam);
  // Rule 9.17(b): a starter who did not complete 5 innings in a game of 6 or
  // more cannot be credited with the win — it goes to the most effective
  // reliever, and the rule says that is the scorer's call. Offer the relievers
  // who appeared; don't pick one.
  if (ofRecord === 0 && (winOuts[0] || 0) < 15 && inningsPlayed() >= 6) {
    res.winCandidates = Object.keys(winOuts).map(Number).filter(i => i !== 0 && winOuts[i] > 0);
    if (res.winCandidates.length) {
      res.judgment = 'The starter did not go 5 innings (Rule 9.17(b)) — the win is the scorer\'s call.';
      res.wp = null;
    }
  }

  // A hand override wins over what the rules worked out — and it has to land
  // before the save is computed, or a scorer who hands the win to the man who
  // finished the game leaves him holding both the W and the save.
  const ov = gameState.decisions || {};
  if (ov.lp !== undefined && ov.lp !== null) res.lp = ov.lp;
  if (ov.wp !== undefined && ov.wp !== null) { res.wp = ov.wp; res.judgment = null; }

  // Rule 9.19: the save goes to the pitcher who finished the game, is not the
  // winner, and is charged with at least a third of an inning, provided he also
  // met one of the three qualifying conditions.
  const finisher = finishingPitcher(winTeam);
  if (finisher >= 0 && finisher !== res.wp && (winOuts[finisher] || 0) >= 1) {
    const entry = pitcherEntryState(winTeam, finisher, timeline);
    const outs = winOuts[finisher] || 0;
    const leadAtEntry = entry ? entry.scoreAt[winTeam] - entry.scoreAt[loseTeam] : null;
    const qualifies =
      (leadAtEntry !== null && leadAtEntry > 0 && leadAtEntry <= 3 && outs >= 3) ||
      // The tying run on base, at bat, or on deck: runners inherited, plus the
      // batter and the man behind him.
      (leadAtEntry !== null && leadAtEntry > 0 && leadAtEntry <= entry.onBase + 2) ||
      outs >= 9;
    if (qualifies) res.sv = finisher;
  }
  if (ov.sv !== undefined && ov.sv !== null) res.sv = ov.sv;

  res.overridden = ['wp','lp','sv'].filter(k => ov[k] !== undefined && ov[k] !== null);
  return res;
}

/* The decision override picker. Lists the pitchers on the relevant side who
   actually appeared, plus "Auto" to hand the choice back to the rules. */
function promptPitcherDecision(which) {
  const d = computePitcherDecisions();
  if (!d.winTeam) return;
  const team = which === 'lp' ? d.loseTeam : d.winTeam;
  const outs = pitcherOutCounts(team);
  const appeared = Object.keys(outs).map(Number).filter(i => outs[i] > 0).sort((a, b) => a - b);
  const title = which === 'wp' ? 'Winning Pitcher' : which === 'lp' ? 'Losing Pitcher' : 'Save';

  let popup = document.getElementById('decision-popup');
  if (!popup) {
    popup = document.createElement('div');
    popup.id = 'decision-popup';
    popup.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:var(--card);border:3px solid var(--navy);border-radius:10px;padding:16px 20px;z-index:400;box-shadow:0 8px 40px rgba(26,39,68,0.4);min-width:240px;font-family:var(--font);';
    document.body.appendChild(popup);
  }
  let html = '<div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--navy);margin-bottom:10px;font-family:var(--heading)">' + title + '</div>';
  if (!appeared.length) {
    html += '<div style="font-size:11px;color:var(--text-light);margin-bottom:10px">No pitcher on that side has recorded an out.</div>';
  }
  appeared.forEach(i => {
    html += '<button class="dp-opt" data-idx="' + i + '" style="display:block;width:100%;text-align:left;padding:6px 10px;margin-bottom:4px;border:1.5px solid #ccc;border-radius:4px;background:#fff;cursor:pointer;font-size:12px;font-family:var(--font)">' +
      escapeHtml(pitcherLabel(team, i)) + ' <span style="color:var(--text-light);font-size:10px">' + outsToIP(outs[i]) + ' IP</span></button>';
  });
  if (which === 'sv') {
    html += '<button class="dp-opt" data-idx="none" style="display:block;width:100%;text-align:left;padding:6px 10px;margin-bottom:4px;border:1.5px solid #ccc;border-radius:4px;background:#fff;cursor:pointer;font-size:12px;font-family:var(--font)">No save</button>';
  }
  html += '<button class="dp-opt" data-idx="auto" style="display:block;width:100%;text-align:left;padding:6px 10px;margin-top:6px;border:1.5px solid var(--navy);border-radius:4px;background:var(--cream);cursor:pointer;font-size:12px;font-weight:700;font-family:var(--font)">Auto (apply the rules)</button>';
  popup.innerHTML = html;
  popup.style.display = 'block';
  popup.querySelectorAll('.dp-opt').forEach(btn => {
    btn.onclick = function() {
      popup.style.display = 'none';
      setPitcherDecision(which, this.dataset.idx);
    };
  });
}

function setPitcherDecision(which, raw) {
  if (!gameState.decisions) gameState.decisions = {};
  if (raw === 'auto') delete gameState.decisions[which];
  else if (raw === 'none') gameState.decisions[which] = -1;
  else gameState.decisions[which] = parseInt(raw);
  autoSave();
  showGameSummary();   // rebuild the card with the new decision
}

function outsToIP(outs) {
  const n = outs || 0;
  return Math.floor(n / 3) + '.' + (n % 3);
}

/* Game Summary */
function showGameSummary() {
  let modal = document.getElementById('game-summary-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'game-summary-modal';
    modal.className = 'game-summary-modal';
    modal.onclick = function(e) { if (e.target === this) this.classList.remove('active'); };
    modal.innerHTML = '<div class="game-summary-inner" id="gs-inner"></div>';
    document.body.appendChild(modal);
  }

  const vTeam = document.getElementById('info-visiting-team')?.value || 'Visiting';
  const hTeam = document.getElementById('info-home-team')?.value || 'Home';
  const date = document.getElementById('info-date')?.value || '';
  const vR = parseInt(document.querySelector('input[data-ls="visiting"][data-stat="r"]')?.value) || 0;
  const hR = parseInt(document.querySelector('input[data-ls="home"][data-stat="r"]')?.value) || 0;
  const vH = parseInt(document.querySelector('input[data-ls="visiting"][data-stat="h"]')?.value) || 0;
  const hH = parseInt(document.querySelector('input[data-ls="home"][data-stat="h"]')?.value) || 0;
  const vE = parseInt(document.querySelector('input[data-ls="visiting"][data-stat="e"]')?.value) || 0;
  const hE = parseInt(document.querySelector('input[data-ls="home"][data-stat="e"]')?.value) || 0;
  const winner = vR > hR ? vTeam : (hR > vR ? hTeam : 'Tied');
  const loser = vR > hR ? hTeam : (hR > vR ? vTeam : '');

  const gsVis = visibleInningCount();

  // Linescore row
  function lsRow(team) {
    let cells = '';
    for (let i = 0; i < gsVis; i++) {
      const v = document.querySelector('input[data-ls="' + team + '"][data-inn="' + i + '"]')?.value || '';
      cells += '<td>' + escapeHtml(v || '-') + '</td>';
    }
    return cells;
  }

  function getPosTrail(team, pIdx) {
    const storedPos = gameState.teams[team].players[pIdx].pos || '';
    if (!gameState.defChanges || !gameState.defChanges.length) return storedPos;
    const moves = [];
    for (const dc of gameState.defChanges) {
      if (dc.team !== team) continue;
      for (const c of dc.changes) {
        if (c.pIdx === pIdx) moves.push(c);
      }
    }
    if (!moves.length) return storedPos;
    const trail = [moves[0].fromPos];
    for (const m of moves) {
      if (trail[trail.length - 1] !== m.toPos) trail.push(m.toPos);
    }
    return trail.join('-');
  }

  /* L3: every name in the summary comes off the card, not out of the state.
     `collectState` scrapes the lineup inputs on the 400ms debounce, so a name typed
     just before the summary opened was not in the state yet and the box score printed
     "Pos 1" for a man whose name was on screen. `livePlayerField` /
     `livePitcherField` read the input and fall back to the state, so a loaded game
     with no inputs on screen reads the same as it always did. */
  const liveName = (team, pIdx) => livePlayerField(team, pIdx, 'name');
  const liveNum = (team, pIdx) => livePlayerField(team, pIdx, 'num');
  const labelled = (num, name, fallback) => (num ? '#' + num + ' ' : '') + (name || fallback);

  // Player stats for box score
  function playerBox(team, label) {
    const players = gameState.teams[team].players;
    let rows = '', totAB = 0, totH = 0, totR = 0, totRBI = 0, totBB = 0;
    function addRow(name, posLabel, s, indent) {
      const avg = s.ab > 0 ? (s.h / s.ab).toFixed(3).replace(/^0/, '') : '-';
      const pre = indent ? '&nbsp;&nbsp;↳ ' : '';
      rows += '<tr><td>' + pre + escapeHtml(name) + ' <span style="color:var(--text-light);font-size:10px">' + escapeHtml(posLabel) + '</span></td><td>' + s.ab + '</td><td>' + s.r + '</td><td>' + s.h + '</td><td>' + s.rbi + '</td><td>' + s.bb + '</td><td>' + s.k + '</td><td>' + avg + '</td></tr>';
      totAB += s.ab; totH += s.h; totR += s.r; totRBI += s.rbi; totBB += s.bb;
    }
    // One line per row of the slot that actually came to the plate, in row order —
    // so a spot with two substitutions prints all three men (H3). A slot with no
    // sub prints the starter's whole line, which is the `subRowOf === 0` tally.
    // Did this row appear in the game at all? A run counts on its own: a pinch
    // runner who scored and never came to the plate has no AB, no walk and no HBP,
    // and without him the box score's R column doesn't add up to the team's runs
    // (H2).
    const came = s => s.ab > 0 || s.bb > 0 || s.hbp > 0 || s.r > 0;
    for (let pos = 0; pos < POSITIONS; pos++) {
      const sp = pos * ROWS_PER_POS;
      const starter = players[sp];
      const allABs = starter.atBats;
      const ss = tallyAtBats(team, sp, allABs, 0);
      if (came(ss)) {
        addRow(labelled(liveNum(team, sp), liveName(team, sp), 'Pos ' + (pos + 1)),
               getPosTrail(team, sp), ss, false);
      }
      subRowOffsets().forEach(r => {
        const sub = players[sp + r];
        const us = tallyAtBats(team, sp, allABs, r);
        if (!came(us)) return;
        addRow(labelled(liveNum(team, sp + r), liveName(team, sp + r), 'Sub ' + (pos + 1)),
               sub.pos || '', us, true);
      });
    }
    rows += '<tr class="gs-totals"><td>Totals</td><td>' + totAB + '</td><td>' + totR + '</td><td>' + totH + '</td><td>' + totRBI + '</td><td>' + totBB + '</td><td></td><td></td></tr>';
    return rows;
  }

  // Pitcher stats
  function pitcherBox(team) {
    const pitchers = gameState.teams[team].pitchers;
    let rows = '';
    for (let i = 0; i < PITCHER_ROWS; i++) {
      const p = pitchers[i];
      const pName = livePitcherField(team, i, 'name');
      const pNum = livePitcherField(team, i, 'num');
      if (!pName && !pNum) continue;
      const ip = p.ip || '0';
      if (ip === '0' && !p.h && !p.k) continue;
      const name = labelled(pNum, pName, 'Pitcher ' + (i + 1));
      rows += '<tr><td>' + escapeHtml(name) + '</td><td>' + (p.ip || '0') + '</td><td>' + (p.pc || '0') + '</td><td>' + (p.h || '0') + '</td><td>' + (p.r || '0') + '</td><td>' + (p.er || '0') + '</td><td>' + (p.k || '0') + '</td><td>' + (p.bb || '0') + '</td><td>' + escapeHtml(p.era || '—') + '</td></tr>';
    }
    return rows;
  }

  // Player of the game: highest combined (H + RBI + R) weighted
  function findPlayerOfGame() {
    let best = null, bestScore = -1;
    // `row` is which row of the slot, split batting from running the same way
    // `tallyAtBats` does — a pinch runner's run is his, not the batter's (H2).
    // `pIdx` is the row being considered and `sp` its slot's first row, which is
    // whose at-bats these are.
    function consider(team, sp, pIdx, tName, atBats, row) {
      const name = liveName(team, pIdx);
      if (!name) return;
      const pl = gameState.teams[team].players[pIdx];
      let h = 0, rbi = 0, r = 0, hr = 0, ab = 0, k = 0;
      atBats.forEach((atBat, col) => {
        if (!atBat.play) return;
        const scored = atBat.bases[0] && atBat.bases[1] && atBat.bases[2] && atBat.bases[3] && atBat.outOnBase == null;
        if (scored && runRowOf(atBat) === row) r++;
        if (subRowOf(atBat) !== row) return;
        if (isHitPlay(atBat.play)) h++;
        if (atBat.play === 'HR') hr++;
        rbi += (atBat.rbi || 0);
        // L4: rule 9.02(a)(1) again — a sacrifice costs no at-bat only if it did its
        // job, which is what `tallyAtBats` prints in the box score two panels up.
        // This kept its own list with SAC/SF/SH flatly in it, so the "h-for-ab" line
        // under the player's name could contradict the box score above it (#17).
        const isSac = ['SAC','SF','SH'].includes(atBat.play);
        const noAB = isSac
          ? sacrificeExemptsAB(team, sp, col, atBat)
          : ['BB','HBP','IBB','CI'].includes(atBat.play);
        if (!noAB) ab++;
        if (atBat.play === 'K' || atBat.play === 'ꓘ' || atBat.play === 'K+WP') k++;
      });
      const score = h * 3 + rbi * 2 + r * 2 + hr * 3 - k;
      if (score > bestScore) {
        bestScore = score;
        best = { name: labelled(liveNum(team, pIdx), name, ''), team: tName, h, ab, rbi, r, hr, pos: pl.pos || '' };
      }
    }
    ['visiting', 'home'].forEach(team => {
      const players = gameState.teams[team].players;
      const tName = team === 'visiting' ? vTeam : hTeam;
      for (let pos = 0; pos < POSITIONS; pos++) {
        const sp = pos * ROWS_PER_POS;
        const starter = players[sp];
        // Every row of the slot is a candidate on its own at-bats, so a second
        // substitute can win it too (H3). `consider` skips unnamed rows itself.
        consider(team, sp, sp, tName, starter.atBats, 0);
        subRowOffsets().forEach(r => {
          consider(team, sp, sp + r, tName, starter.atBats, r);
        });
      }
    });
    // Also check pitchers — dominant pitching performance
    ['visiting', 'home'].forEach(team => {
      const pitchers = gameState.teams[team].pitchers;
      const tName = team === 'visiting' ? vTeam : hTeam;
      for (let i = 0; i < PITCHER_ROWS; i++) {
        const p = pitchers[i];
        const pName = livePitcherField(team, i, 'name');
        if (!pName) continue;
        const ip = parseFloat(p.ip) || 0;
        const k = parseInt(p.k) || 0;
        const er = parseInt(p.er) || 0;
        const score = ip * 2 + k * 2 - er * 4;
        if (score > bestScore && ip >= 5) {
          bestScore = score;
          best = { name: labelled(livePitcherField(team, i, 'num'), pName, ''), team: tName, isPitcher: true, ip: p.ip, k, er, h: parseInt(p.h) || 0 };
        }
      }
    });
    return best;
  }

  // Notable plays
  function findNotablePlays() {
    const plays = [];
    function scanNotable(name, tName, atBats, filterFn) {
      let hrs = 0, triples = 0, doubles = 0, sbs = 0, rbiTotal = 0, hits = 0;
      for (const atBat of atBats) {
        if (!atBat.play || !filterFn(atBat)) continue;
        if (atBat.play === 'HR') hrs++;
        if (atBat.play === '3B') triples++;
        if (atBat.play === '2B') doubles++;
        if (isHitPlay(atBat.play)) hits++;
        rbiTotal += (atBat.rbi || 0);
        for (let seg = 1; seg <= 3; seg++) {
          if (atBat.advReason && atBat.advReason[seg] === 'SB') sbs++;
        }
      }
      if (hrs >= 2) plays.push(name + ' (' + tName + '): ' + hrs + ' HR');
      else if (hrs === 1 && rbiTotal >= 3) plays.push(name + ' (' + tName + '): HR, ' + rbiTotal + ' RBI');
      else if (hrs === 1) plays.push(name + ' (' + tName + '): HR');
      if (triples > 0) plays.push(name + ' (' + tName + '): ' + triples + ' triple' + (triples > 1 ? 's' : ''));
      if (doubles >= 2) plays.push(name + ' (' + tName + '): ' + doubles + ' doubles');
      if (sbs >= 2) plays.push(name + ' (' + tName + '): ' + sbs + ' SB');
      if (rbiTotal >= 4) plays.push(name + ' (' + tName + '): ' + rbiTotal + ' RBI game');
      if (hits >= 3) plays.push(name + ' (' + tName + '): ' + hits + '-hit game');
    }
    ['visiting', 'home'].forEach(team => {
      const players = gameState.teams[team].players;
      const tName = team === 'visiting' ? vTeam : hTeam;
      for (let pos = 0; pos < POSITIONS; pos++) {
        const sp = pos * ROWS_PER_POS;
        const starter = players[sp];
        // Per row, so a multi-hit game by the second substitute is still notable.
        // Named off the card like everything else here (L3).
        const notableRow = (row) => {
          const name = liveName(team, sp + row);
          if (!name) return;
          scanNotable(labelled(liveNum(team, sp + row), name, ''), tName, starter.atBats,
                      ab => subRowOf(ab) === row);
        };
        notableRow(0);
        subRowOffsets().forEach(notableRow);
      }
    });
    // DP plays
    ['visiting', 'home'].forEach(team => {
      const players = gameState.teams[team].players;
      for (const pl of players) {
        for (const atBat of pl.atBats) {
          if (/^DP/.test(atBat.play)) plays.push('Double play: ' + atBat.play);
          if (/^TP/.test(atBat.play)) plays.push('Triple play: ' + atBat.play);
        }
      }
    });
    // Dedupe
    return [...new Set(plays)];
  }

  const decisions = computePitcherDecisions();
  const potg = findPlayerOfGame();
  const notable = findNotablePlays();

  let html = '<div style="position:relative"><button data-act="closeGameSummary" style="position:absolute;top:-8px;right:-12px;font-size:24px;cursor:pointer;color:var(--text-light);background:none;border:none;font-weight:700">&times;</button>';

  // Header
  html += '<div class="gs-header"><h2>Game Summary</h2>';
  html += '<div class="gs-subtitle">' + escapeHtml(date || 'Date TBD') + '</div></div>';

  // Score banner
  html += '<div class="gs-score-banner">';
  html += '<div class="gs-team-score"><div class="gs-team-name">' + escapeHtml(vTeam) + '</div><div class="gs-score-num">' + vR + '</div></div>';
  html += '<div style="text-align:center"><div class="gs-vs">vs</div><div class="gs-final-tag">Final</div></div>';
  html += '<div class="gs-team-score"><div class="gs-team-name">' + escapeHtml(hTeam) + '</div><div class="gs-score-num">' + hR + '</div></div>';
  html += '</div>';

  // Highlights row
  html += '<div class="gs-highlight">';
  if (potg) {
    html += '<div class="gs-highlight-card"><div class="gs-hl-label">Player of the Game</div>';
    html += '<div class="gs-hl-value">' + escapeHtml(potg.name) + '</div>';
    if (potg.isPitcher) {
      html += '<div class="gs-hl-detail">' + potg.ip + ' IP, ' + potg.k + ' K, ' + potg.er + ' ER</div>';
    } else {
      html += '<div class="gs-hl-detail">' + potg.h + '-' + potg.ab + ', ' + potg.rbi + ' RBI, ' + potg.r + ' R' + (potg.hr ? ', ' + potg.hr + ' HR' : '') + '</div>';
    }
    html += '<div class="gs-hl-detail" style="color:var(--text-light)">' + escapeHtml(potg.team) + '</div></div>';
  }
  if (decisions.winTeam) {
    const change = w => '<button data-act="promptPitcherDecision" data-arg="' + w + '" style="margin-left:6px;font-size:9px;padding:1px 5px;border:1px solid var(--border);border-radius:3px;background:transparent;color:var(--text-light);cursor:pointer;font-family:var(--font)">change</button>';
    const nameOf = (team, idx) => (idx === null || idx === undefined || idx < 0) ? '—' : escapeHtml(pitcherLabel(team, idx));
    html += '<div class="gs-highlight-card"><div class="gs-hl-label">Pitching Decision</div>';
    html += '<div class="gs-pitching-line"><b>W:</b> ' + nameOf(decisions.winTeam, decisions.wp) + change('wp') + '</div>';
    html += '<div class="gs-pitching-line"><b>L:</b> ' + nameOf(decisions.loseTeam, decisions.lp) + change('lp') + '</div>';
    html += '<div class="gs-pitching-line"><b>SV:</b> ' + nameOf(decisions.winTeam, decisions.sv) + change('sv') + '</div>';
    if (decisions.judgment) {
      html += '<div class="gs-hl-detail" style="color:var(--accent);margin-top:4px">' + escapeHtml(decisions.judgment) + '</div>';
      html += '<div class="gs-hl-detail" style="color:var(--text-light)">Candidates: ' +
        decisions.winCandidates.map(i => escapeHtml(pitcherLabel(decisions.winTeam, i))).join(', ') + '</div>';
    }
    if (decisions.approximate) {
      html += '<div class="gs-hl-detail" style="color:var(--text-light);margin-top:4px">Approximate: this game was saved before play order was recorded.</div>';
    }
    html += '</div>';
  }
  html += '</div>';

  // Linescore
  html += '<div class="gs-section"><h3>Linescore</h3>';
  html += '<table class="gs-table"><thead><tr><th></th>';
  for (let i = 1; i <= gsVis; i++) html += '<th>' + i + '</th>';
  html += '<th>R</th><th>H</th><th>E</th></tr></thead><tbody>';
  html += '<tr><td>' + escapeHtml(vTeam) + '</td>' + lsRow('visiting') + '<td><b>' + vR + '</b></td><td>' + vH + '</td><td>' + vE + '</td></tr>';
  html += '<tr><td>' + escapeHtml(hTeam) + '</td>' + lsRow('home') + '<td><b>' + hR + '</b></td><td>' + hH + '</td><td>' + hE + '</td></tr>';
  html += '</tbody></table></div>';

  // Box score — Visiting
  html += '<div class="gs-section"><h3>' + escapeHtml(vTeam) + ' — Batting</h3>';
  html += '<table class="gs-table"><thead><tr><th>Player</th><th>AB</th><th>R</th><th>H</th><th>RBI</th><th>BB</th><th>K</th><th>AVG</th></tr></thead><tbody>';
  html += playerBox('visiting', vTeam);
  html += '</tbody></table></div>';

  // Box score — Home
  html += '<div class="gs-section"><h3>' + escapeHtml(hTeam) + ' — Batting</h3>';
  html += '<table class="gs-table"><thead><tr><th>Player</th><th>AB</th><th>R</th><th>H</th><th>RBI</th><th>BB</th><th>K</th><th>AVG</th></tr></thead><tbody>';
  html += playerBox('home', hTeam);
  html += '</tbody></table></div>';

  // Pitching — Visiting pitchers
  html += '<div class="gs-section"><h3>' + escapeHtml(vTeam) + ' — Pitching</h3>';
  html += '<table class="gs-table"><thead><tr><th>Pitcher</th><th>IP</th><th>PC</th><th>H</th><th>R</th><th>ER</th><th>K</th><th>BB</th><th>ERA</th></tr></thead><tbody>';
  html += pitcherBox('visiting');
  html += '</tbody></table></div>';

  // Pitching — Home pitchers
  html += '<div class="gs-section"><h3>' + escapeHtml(hTeam) + ' — Pitching</h3>';
  html += '<table class="gs-table"><thead><tr><th>Pitcher</th><th>IP</th><th>PC</th><th>H</th><th>R</th><th>ER</th><th>K</th><th>BB</th><th>ERA</th></tr></thead><tbody>';
  html += pitcherBox('home');
  html += '</tbody></table></div>';

  // Defensive changes
  if (gameState.defChanges && gameState.defChanges.length > 0) {
    html += '<div class="gs-section"><h3>Defensive Changes</h3>';
    html += '<table class="gs-table"><thead><tr><th>Inning</th><th>Team</th><th>Player</th><th>From</th><th>To</th></tr></thead><tbody>';
    const sorted = [...gameState.defChanges].sort((a, b) => {
      const innA = parseInt(a.inning.slice(1)), innB = parseInt(b.inning.slice(1));
      if (innA !== innB) return innA - innB;
      return a.inning[0] === 'T' ? -1 : 1;
    });
    for (const dc of sorted) {
      const teamName = dc.team === 'visiting' ? vTeam : hTeam;
      for (const c of dc.changes) {
        html += '<tr><td>' + escapeHtml(dc.inning) + '</td><td>' + escapeHtml(teamName) + '</td><td>' + escapeHtml(c.name) + '</td><td>' + escapeHtml(c.fromPos) + '</td><td>' + escapeHtml(c.toPos) + '</td></tr>';
      }
    }
    html += '</tbody></table></div>';
  }

  // Lineup rules — the DH and any re-entry. Both are scorer decisions the card
  // can't re-derive, so the summary is where they get read back.
  const dhLines = ['visiting', 'home'].map(t => {
    const st = dhState(t);
    if (!st.hasDH && !st.terminated) return null;
    const name = st.hasDH ? rowLabel(t, st.dh[0]) : null;
    const who = t === 'visiting' ? vTeam : hTeam;
    let s = escapeHtml(who) + ' — DH: ' + escapeHtml(name || '—');
    if (st.terminated) {
      s += ' <span style="color:var(--accent)">terminated ' + escapeHtml(st.terminated.inning) +
        ' (' + escapeHtml(st.terminated.reason) + ')</span>';
    }
    return s;
  }).filter(Boolean);
  const reentries = Array.isArray(gameState.reentries) ? gameState.reentries : [];
  // A game that wasn't nine innings is a scorer decision too, and the linescore
  // alone doesn't say whether a 7-inning card was shortened or just unfinished.
  const regLine = regulationInnings() !== DEFAULT_REGULATION
    ? 'Regulation: ' + regulationInnings() + ' innings'
    : null;
  if (dhLines.length || reentries.length || regLine) {
    html += '<div class="gs-section"><h3>Lineup Rules</h3>';
    if (regLine) html += '<div class="gs-pitching-line">' + escapeHtml(regLine) + '</div>';
    dhLines.forEach(l => { html += '<div class="gs-pitching-line">' + l + '</div>'; });
    if (reentries.length) {
      html += '<table class="gs-table"><thead><tr><th>Inning</th><th>Team</th><th>Spot</th><th>Re-entered</th><th>For</th></tr></thead><tbody>';
      for (const r of reentries) {
        const teamName = r.team === 'visiting' ? vTeam : hTeam;
        html += '<tr><td>' + escapeHtml(r.inning) + '</td><td>' + escapeHtml(teamName) + '</td><td>' + r.spot +
          '</td><td>' + escapeHtml(r.starter) +
          (r.legal ? '' : ' <span style="color:var(--accent);font-size:10px">illegal (5.10(d))</span>') +
          '</td><td>' + escapeHtml(r.sub) + '</td></tr>';
      }
      html += '</tbody></table>';
    }
    html += '</div>';
  }

  // Notable plays
  if (notable.length > 0) {
    html += '<div class="gs-section"><h3>Notable Plays</h3>';
    html += '<div class="gs-plays">';
    notable.forEach(p => { html += '<span>' + escapeHtml(p) + '</span> '; });
    html += '</div></div>';
  }

  // Win probability chart
  const hasScoreData = gameState.linescore.visiting.innings.some(v => v !== '') || gameState.linescore.home.innings.some(v => v !== '');
  if (hasScoreData) {
    html += '<div class="gs-section" id="gs-winprob-section"><h3>Win Probability</h3><div id="gs-winprob-chart" style="min-height:40px"></div></div>';
  }

  html += '</div>';
  document.getElementById('gs-inner').innerHTML = html;
  modal.classList.add('active');

  if (hasScoreData) {
    renderManualWinProbChart('gs-winprob-chart');
  }
}

function normalCDF(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))));
  return z >= 0 ? 1 - p : p;
}

function winProbFromDiff(runDiff, halfInnsRemaining) {
  if (halfInnsRemaining <= 0) return runDiff > 0 ? 1.0 : runDiff < 0 ? 0.0 : 0.5;
  const sigma = Math.sqrt(halfInnsRemaining) * 0.92;
  const hfa = 0.18; // ~54% home win rate at start
  return normalCDF((runDiff + hfa) / sigma);
}

function renderWinProbSVG(container, data, vTeam, hTeam, numInns, isEstimate) {
  const W = 560, H = 160;
  const PAD = { top: 14, right: 16, bottom: 26, left: 34 };
  const iW = W - PAD.left - PAD.right;
  const iH = H - PAD.top - PAD.bottom;
  const n = data.length;
  const clipId = 'wpc-clip-' + Math.random().toString(36).slice(2,6);

  function px(i) { return PAD.left + (i / Math.max(n - 1, 1)) * iW; }
  function py(prob) { return PAD.top + (1 - prob / 100) * iH; }

  const pts = data.map((d, i) => `${px(i).toFixed(1)},${py(d.homeTeamWinProbability).toFixed(1)}`).join(' ');

  let above = `M${px(0).toFixed(1)},${py(50).toFixed(1)}`;
  data.forEach((d, i) => { above += ` L${px(i).toFixed(1)},${Math.min(py(d.homeTeamWinProbability), py(50)).toFixed(1)}`; });
  above += ` L${px(n-1).toFixed(1)},${py(50).toFixed(1)} Z`;

  let below = `M${px(0).toFixed(1)},${py(50).toFixed(1)}`;
  data.forEach((d, i) => { below += ` L${px(i).toFixed(1)},${Math.max(py(d.homeTeamWinProbability), py(50)).toFixed(1)}`; });
  below += ` L${px(n-1).toFixed(1)},${py(50).toFixed(1)} Z`;

  let marks = '';
  for (let inn = 1; inn < numInns; inn++) {
    const x = (PAD.left + (inn / numInns) * iW).toFixed(1);
    marks += `<line x1="${x}" y1="${PAD.top}" x2="${x}" y2="${PAD.top + iH}" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>`;
    marks += `<text x="${x}" y="${H - 4}" text-anchor="middle" font-size="9" fill="rgba(255,255,255,0.35)" font-family="monospace">${inn}</text>`;
  }

  let yMarks = '';
  for (const pct of [25, 50, 75, 100]) {
    const y = py(pct).toFixed(1);
    yMarks += `<text x="${PAD.left - 4}" y="${(parseFloat(y) + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="rgba(255,255,255,0.45)" font-family="monospace">${pct}</text>`;
    if (pct === 50) yMarks += `<line x1="${PAD.left}" y1="${y}" x2="${PAD.left + iW}" y2="${y}" stroke="rgba(255,255,255,0.25)" stroke-width="1" stroke-dasharray="3,3"/>`;
  }

  const lastProb = data[n-1].homeTeamWinProbability;
  const dotColor = lastProb >= 50 ? 'var(--gold)' : '#7b9fd4';
  const dot = `<circle cx="${px(n-1).toFixed(1)}" cy="${py(lastProb).toFixed(1)}" r="3.5" fill="${dotColor}" stroke="var(--navy)" stroke-width="1.5"/>`;
  const label = `${hTeam} win%${isEstimate ? ' (est.)' : ''}`;

  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:${W}px;display:block;overflow:visible" xmlns="http://www.w3.org/2000/svg">
    <defs><clipPath id="${clipId}"><rect x="${PAD.left}" y="${PAD.top}" width="${iW}" height="${iH}"/></clipPath></defs>
    <rect x="${PAD.left}" y="${PAD.top}" width="${iW}" height="${iH}" fill="rgba(0,0,0,0.2)" rx="2"/>
    ${yMarks}${marks}
    <path d="${above}" fill="rgba(212,168,83,0.22)" clip-path="url(#${clipId})"/>
    <path d="${below}" fill="rgba(90,130,200,0.22)" clip-path="url(#${clipId})"/>
    <polyline points="${pts}" fill="none" stroke="var(--gold)" stroke-width="1.5" stroke-linejoin="round" clip-path="url(#${clipId})"/>
    ${dot}
    <text x="${PAD.left + 4}" y="${PAD.top + 12}" font-size="9" fill="rgba(212,168,83,0.8)" font-family="var(--heading)">${label}</text>
    <text x="${PAD.left + iW - 2}" y="${H - 4}" text-anchor="end" font-size="9" fill="rgba(255,255,255,0.35)" font-family="monospace">${numInns} inn.</text>
  </svg>`;
}

function renderManualWinProbChart(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const vis = visibleInningCount();
  const vTeam = gameState.info.visitingTeam || 'VIS';
  const hTeam = gameState.info.homeTeam || 'HOM';
  const awayInns = gameState.linescore.visiting.innings;
  const homeInns = gameState.linescore.home.innings;

  const data = [{ homeTeamWinProbability: winProbFromDiff(0, vis * 2) * 100 }];
  let awayTotal = 0, homeTotal = 0;
  for (let i = 0; i < vis; i++) {
    const av = awayInns[i], hv = homeInns[i];
    if (av === '' && hv === '') break;
    if (av !== '') {
      awayTotal += parseInt(av) || 0;
      data.push({ homeTeamWinProbability: winProbFromDiff(homeTotal - awayTotal, (vis * 2) - (i * 2 + 1)) * 100 });
    }
    // An `X` is a half nobody batted in (L5), not a scoreless one — it gets no point
    // on the curve, or the chart grows a step for an inning that was never played.
    if (hv !== '' && hv !== 'X') {
      homeTotal += parseInt(hv) || 0;
      data.push({ homeTeamWinProbability: winProbFromDiff(homeTotal - awayTotal, (vis * 2) - (i * 2 + 2)) * 100 });
    }
  }
  if (data.length < 2) {
    container.innerHTML = '<div style="color:var(--text-light);font-size:12px;padding:8px 0">Score innings to see win probability.</div>';
    return;
  }
  renderWinProbSVG(container, data, vTeam, hTeam, vis, true);
}

/* Keyboard handler */
document.addEventListener('keydown', function(e) {
  const inInput = document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA' || document.activeElement.tagName === 'SELECT');
  if (inInput) return;
  if (e.key === '?' || (e.key === '/' && !e.shiftKey)) { e.preventDefault(); document.getElementById('hotkey-modal').classList.toggle('active'); return; }
  if (e.key === 'Escape') { document.getElementById('hotkey-modal')?.classList.remove('active'); document.getElementById('game-summary-modal')?.classList.remove('active'); return; }
  if (!selectedCell) return;

  const team = selectedCell.dataset.team;
  const p = parseInt(selectedCell.dataset.p);
  const inn = parseInt(selectedCell.dataset.inn);

  let np = p, ni = inn;
  if (e.key === 'ArrowRight') { ni = Math.min(inn + 1, INNINGS - 1); }
  else if (e.key === 'ArrowLeft') { ni = Math.max(inn - 1, 0); }
  else if (e.key === 'ArrowDown') { np = Math.min(p + ROWS_PER_POS, (POSITIONS - 1) * ROWS_PER_POS); }
  else if (e.key === 'ArrowUp') { np = Math.max(p - ROWS_PER_POS, 0); }
  else {
    const key = e.key.toLowerCase();
    e.preventDefault();
    if (key === 's') addPitch('S');
    else if (key === 'f') addPitch('F');
    else if (key === 'b') addPitch('B');
    else if (key === 'z' || key === 'backspace') removePitch();
    else if (key === '1') applyPlay('1B');
    else if (key === '2') applyPlay('2B');
    else if (key === '3') applyPlay('3B');
    else if (key === '4') applyPlay('HR');
    else if (key === 'w') applyPlay('BB');
    else if (key === 'k') showStrikeoutPopup();
    else if (key === 'h') applyPlay('HBP');
    else if (key === 'i') applyPlay('IBB');
    else if (key === 'e') { promptErrorPlay(); return; }
    else if (key === 'q') applyPlay('SF');
    else if (key === 'g') { promptGroundout(); return; }
    else if (key === 'p') { promptPositionPlay('P'); return; }
    else if (key === 'l') { promptPositionPlay('L'); return; }
    else if (key === 'x') { promptPositionPlay('F'); return; }
    else if (key === 'd') { promptPositionPlay('DP '); return; }
    else if (key === 'r') { promptSBBase(); return; }
    else if (key === 'j') { promptCSBase(); return; }
    else if (key === 'n') applyRunnerEvent('WP');
    else if (key === 'o') { promptPickoff(); return; }
    else if (key === 'u') undoLastPlay();
    else if (key === 'y') redoLastPlay();
    else if (key === 't') { editPlayType(); return; }
    else if (key === 'm') { editRunners(); return; }
    else if (key === 'c') clearSelectedCell();
    else if (key === '?' || key === '/') { document.getElementById('hotkey-modal').classList.toggle('active'); return; }
    return;
  }

  if (np !== p || ni !== inn) {
    e.preventDefault();
    const next = document.querySelector(`.at-bat-cell[data-team="${team}"][data-p="${np}"][data-inn="${ni}"]`);
    if (next) selectCell(next);
  }
});

/* -------------------------------------------------- event wiring (CSP) ---
   index.html used to carry ~110 inline `on*` handlers, and that is what kept a
   strict Content-Security-Policy out of reach: permitting them means permitting
   every inline script on the page, which is the one thing the policy is for.

   Each is now `data-act`, the name of a global function, with at most one
   argument — `data-arg` for a string, `data-argnum` for a number, and
   `data-arg="this"` for the element itself. Two listeners here do the
   dispatching. The popups app.js builds attach their handlers in JS after
   setting innerHTML, which is how most of them already worked. */

// The generated popups dispatch through the same listener, so their buttons
// need named actions too rather than expressions in an attribute.
function hidePopupById(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}
function closeGameSummary() {
  const el = document.getElementById('game-summary-modal');
  if (el) el.classList.remove('active');
}
function markRunEarned(i) { setRunEarnedByIndex(i, false); }
function markRunUnearned(i) { setRunEarnedByIndex(i, true); }
// The position-change buttons carry four values, more than `data-arg` holds, so
// they hand over the element and this reads them off it.
function applyFieldPosFromEl(el) {
  applyFieldPos(el.dataset.team, Number(el.dataset.p), el.dataset.pos, el.dataset.inn);
}

function closeHotkeyModal() {
  document.getElementById('hotkey-modal').classList.remove('active');
}
function openImportPicker() {
  document.getElementById('import-game-file').click();
}
// On a modal's own backdrop: close only when the click landed on the backdrop
// itself, not on anything inside it.
function closeModalOnBackdrop(el, e) {
  if (e && e.target === el) el.classList.remove('active');
}

function runAction(el, e) {
  const name = el.dataset.act;
  const fn = window[name];
  if (typeof fn !== 'function') { console.warn('no action named ' + name); return; }
  if (name === 'closeModalOnBackdrop') return fn(el, e);
  if (el.dataset.argnum !== undefined) return fn(Number(el.dataset.argnum));
  if (el.dataset.arg === 'this') return fn(el);
  if (el.dataset.arg !== undefined) return fn(el.dataset.arg);
  return fn();
}

document.addEventListener('click', function(e) {
  const el = e.target.closest && e.target.closest('[data-act]');
  if (!el) return;
  if ((el.dataset.actOn || 'click') !== 'click') return;
  runAction(el, e);
});
document.addEventListener('change', function(e) {
  const el = e.target.closest && e.target.closest('[data-act][data-act-on="change"]');
  if (el) runAction(el, e);
});
document.addEventListener('input', function(e) {
  const el = e.target.closest && e.target.closest('[data-act][data-act-on="input"]');
  if (el) runAction(el, e);
});

/* Auto-save on any input/select change (autoSave is itself debounced) */
document.addEventListener('input', function(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') autoSave();
});

/* Keep a name inside its column as it is typed, letter by letter, rather than
   letting it disappear off the right-hand edge and reappear on blur. */
document.addEventListener('input', function(e) {
  const t = e.target;
  if (t && t.matches && t.matches(NAME_FIT_SELECTOR)) fitName(t);
});
/* Breakpoints move the Player column, the webfont changes what a name measures,
   and clicks load games, reveal sub rows and switch teams — all of which put
   names in front of the scorer that have not been measured at their real size. */
// These four measure again from scratch: the column may be the same width as it
// was and the name the same name, and the answer still different.
window.addEventListener('resize', function() { refitNames(true); });
window.addEventListener('orientationchange', function() { refitNames(true); });
if (document.fonts && document.fonts.ready) document.fonts.ready.then(function() { refitNames(true); });
// A grid inside a hidden tab has no width to measure against, so a card that
// loaded out of sight is measured when it comes back into it.
document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'visible') refitNames(true);
});
document.addEventListener('click', function(e) {
  if (e.target.closest && e.target.closest('[data-act], [data-ui-act]')) refitNames();
});
document.addEventListener('change', function(e) {
  if (e.target.tagName === 'SELECT') autoSave();
});

/* Flush any pending save when the page is hidden or closed so nothing is
   lost when backgrounding/closing the app (iOS Safari fires these reliably). */
document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'hidden') flushSave();
});
window.addEventListener('pagehide', flushSave);

/* Update team labels in linescore */
document.getElementById('info-visiting-team')?.addEventListener('input', function() {
  gameState.info.visitingTeam = this.value;
  const label = document.getElementById('ls-v-label');
  if (label) label.textContent = this.value || 'Visiting';
  autoSave();
});
document.getElementById('info-home-team')?.addEventListener('input', function() {
  gameState.info.homeTeam = this.value;
  const label = document.getElementById('ls-h-label');
  if (label) label.textContent = this.value || 'Home';
  autoSave();
});
document.getElementById('info-innings')?.addEventListener('change', function() {
  setRegulationInnings(this.value);
  // Snap the select back if the change was refused or clamped, so what it reads is
  // always what the card is actually using.
  this.value = String(regulationInnings());
});

/* Event delegation for cell selection */
document.addEventListener('click', function(e) {
  const cell = e.target.closest('.at-bat-cell');
  if (cell) selectCell(cell);
});

/* Init */
function init() {
  // Field images set directly in HTML
  buildScoringGrid('visiting', 'grid-visiting');
  buildScoringGrid('home', 'grid-home');
  buildPitcherTable('visiting', 'pitchers-visiting');
  buildPitcherTable('home', 'pitchers-home');
  buildLinescore();
  // Sidebar removed
  loadState();
}

// tests.html sets window.__NO_AUTO_INIT__ so it can load app.js and exercise
// the scoring functions against a minimal DOM without booting the whole app.
if (!(typeof window !== 'undefined' && window.__NO_AUTO_INIT__)) {
init();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(reg => {
    // Check for a new worker on load and whenever the app regains focus.
    reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  }).catch(() => {});

  // When a new worker takes control, reload once so fresh assets apply.
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
}
}