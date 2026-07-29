
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
const ROWS_PER_POS = 2;
const INNINGS = 15;
const PITCHER_ROWS = 8;

let selectedCell = null;
let gameState = createEmptyState();

// Identity column->inning map sized to INNINGS ([0,1,2,...,INNINGS-1]).
function defaultColumnMap() { return Array.from({ length: INNINGS }, (_, i) => i); }

// Every at-bat cell on the card carries the *starter's* row index — a sub bats
// on the starter's line — so `players[1].atBats` and every other odd row is 15
// untouched objects. They stay allocated in memory, because a dozen loops walk
// every player and index by column, but `stateForStorage` drops them on the way
// out and `refillAtBats` puts them back on the way in (#33).
function makeEmptyAtBat() {
  return { bases:[false,false,false,false], advReason:['','','',''], outOnBase:null, play:'', out:0, outsRecorded:0, pitches:[], hitLoc:null, rbi:0, pitcher:0, reachedOnError:false, pitcherChangeNum:'', subChange:false, seq:0 };
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
    timerStart: null,
    timerElapsed: 0,
    timerRunning: false,
    linescore: {
      visiting: { innings: Array(INNINGS).fill(''), r:'', h:'', e:'' },
      home: { innings: Array(INNINGS).fill(''), r:'', h:'', e:'' }
    },
    visibleInnings: 9,
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

  const posSelect = '<select data-field="pos"><option value=""></option><option>P</option><option>C</option><option>1B</option><option>2B</option><option>3B</option><option>SS</option><option>LF</option><option>CF</option><option>RF</option><option>DH</option></select>';

  for (let pos = 0; pos < POSITIONS; pos++) {
    const sp = pos * ROWS_PER_POS;     // starter player index
    const subp = sp + 1;               // sub player index

    // Starter row — includes at-bat cells with rowspan=2
    html += `<tr class="pos-starter" data-team="${team}" data-player="${sp}">`;
    html += `<td class="order-cell" rowspan="2">${pos + 1}</td>`;
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
      html += `<td class="at-bat-cell" rowspan="2" data-team="${team}" data-p="${sp}" data-inn="${inn}">`;
      html += `<div class="pitcher-change-mark" id="pcm-${team}-${sp}-${inn}"></div>`;
      html += `<div class="sub-change-mark" id="scm-${team}-${sp}-${inn}"></div>`;
      html += `<div class="pitch-track" id="pt-${team}-${sp}-${inn}"></div>`;
      html += `<div class="pitch-count" id="pc-${team}-${sp}-${inn}"></div>`;
      html += `<div class="diamond-wrap">${diamondSVG(team, sp, inn)}</div>`;
      html += `<div class="play-text" id="txt-${team}-${sp}-${inn}"></div>`;
      html += `<div class="out-num" data-team="${team}" data-p="${sp}" data-inn="${inn}"></div>`;
      html += `<div class="rbi-badge" id="rbi-${team}-${sp}-${inn}"></div>`;
      html += `</td>`;
    }
    html += '</tr>';

    // Sub row — player info only, no at-bat cells (spanned from above)
    html += `<tr class="pos-sub" data-team="${team}" data-player="${subp}">`;
    html += `<td class="num-cell"><input type="text" data-field="num" data-team="${team}" data-p="${subp}" maxlength="3"></td>`;
    html += `<td class="player-cell"><input type="text" data-field="name" data-team="${team}" data-p="${subp}" placeholder="PH / Sub"></td>`;
    html += `<td class="pos-cell">${posSelect.replace('data-field="pos"', `data-field="pos" data-team="${team}" data-p="${subp}"`)}</td>`;
    html += `<td class="avg-cell"><input type="text" data-field="avg" data-team="${team}" data-p="${subp}" maxlength="5"></td>`;
    html += `<td class="stat-cell" id="st-ab-${team}-${subp}"></td>`;
    html += `<td class="stat-cell" id="st-h-${team}-${subp}"></td>`;
    html += `<td class="stat-cell" id="st-r-${team}-${subp}"></td>`;
    html += `<td class="stat-cell" id="st-rbi-${team}-${subp}"></td>`;
    html += `<td class="stat-cell" id="st-bb-${team}-${subp}"></td>`;
    html += '</tr>';
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
  html += '<button type="button" onclick="recomputePitcherAssignments()" title="Re-attribute recorded at-bats to the correct pitcher based on pitching changes" style="font-size:10px;font-weight:700;padding:2px 7px;border:1px solid var(--navy,#1a2744);border-radius:3px;background:#fff;color:var(--navy,#1a2744);cursor:pointer;font-family:var(--heading,inherit);letter-spacing:0.3px">↻ Fix Stats</button>';
  html += '</div>';
  html += '<table class="pitcher-grid"><thead><tr>';
  html += '<th class="pitcher-num-col">#</th>';
  html += '<th class="pitcher-name-col">Pitcher / ERA</th>';
  labels.forEach(l => html += `<th>${l}</th>`);
  html += '</tr></thead><tbody>';

  for (let i = 0; i < PITCHER_ROWS; i++) {
    html += '<tr>';
    html += `<td><input type="text" data-team="${team}" data-pitcher="${i}" data-field="num" maxlength="3" style="text-align:center"></td>`;
    html += `<td class="p-name"><input type="text" data-team="${team}" data-pitcher="${i}" data-field="name"></td>`;
    stats.forEach(s => {
      html += `<td class="p-stat"><input type="text" data-team="${team}" data-pitcher="${i}" data-field="${s}" maxlength="5"></td>`;
    });
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
      html += `<td data-inn-col="${i}"><input type="text" data-ls="${t}" data-inn="${i}" maxlength="3" oninput="updateLinescoreTotals('${t}')"></td>`;
    }
    html += `<td class="total"><input type="text" data-ls="${t}" data-stat="r" readonly tabindex="-1"></td>`;
    html += `<td class="total"><input type="text" data-ls="${t}" data-stat="h" readonly tabindex="-1"></td>`;
    html += `<td class="total"><input type="text" data-ls="${t}" data-stat="e" maxlength="2" oninput="autoSave()"></td>`;
    html += `<td class="total ls-lob"><input type="text" data-ls="${t}" data-stat="lob" readonly tabindex="-1"></td>`;
    row.innerHTML = `<td class="team-col">${t === 'visiting' ? '<span id="ls-v-label">Visiting</span>' : '<span id="ls-h-label">Home</span>'}</td>` + html;
  });
}

/* Standings and field diagram removed - replaced by situation panel */

/* Interaction */
function selectCell(td) {
  if (selectedCell) selectedCell.classList.remove('selected');
  selectedCell = td;
  td.classList.add('selected');
  updateSituation();
}

function renderDiamond(team, pIdx, innIdx) {
  const ab = gameState.teams[team].players[pIdx].atBats[innIdx];
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

function renderPlayText(team, pIdx, innIdx) {
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

  // One definition of LOB (#16): the runners left standing when the half-inning
  // ends. Nothing is left on base until it does, so an inning in progress is 0.
  const lob = outs >= 3 ? bases.filter(r => r !== null).length : 0;

  for (const col of cols) {
    const inn = getInnState(team, col);
    inn.outs = outs;
    // In place — callers hold `inn.bases` across a recompute.
    for (let b = 0; b < 3; b++) inn.bases[b] = bases[b];
    inn.lob = lob;
  }

  // Runs on the line, by real inning, then the R/H/LOB totals.
  updateInningRuns(team, cols[cols.length - 1]);
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

function getActivePlayer(team, pIdx, innIdx) {
  const sp = Math.floor(pIdx / ROWS_PER_POS) * ROWS_PER_POS;
  const subp = sp + 1;
  const ab = gameState.teams[team].players[sp].atBats[innIdx];
  if (ab && ab.subChange) return gameState.teams[team].players[subp];
  return gameState.teams[team].players[sp];
}

function getActivePlayerName(team, pIdx, innIdx) {
  const pl = getActivePlayer(team, pIdx, innIdx);
  const pos = Math.floor(pIdx / ROWS_PER_POS) + 1;
  return (pl.num ? '#' + pl.num + ' ' : '') + (pl.name || 'Batter ' + pos);
}

function getBatterLabel(team, pIdx, innIdx) {
  const pl = innIdx !== undefined ? getActivePlayer(team, pIdx, innIdx) : gameState.teams[team].players[pIdx];
  return pl.num || String(Math.floor(pIdx / ROWS_PER_POS) + 1);
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
  revertAdvancesFrom(team, getRealInning(team, col), pIdx, col);
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

// Brief, non-blocking notice for a refused entry. A rejected play has to say so:
// silently dropping it is how a scorer ends up trusting a wrong card.
function showPlayReject(msg) {
  if (typeof document === 'undefined') return;
  let el = document.getElementById('play-reject');
  if (!el) {
    el = document.createElement('div');
    el.id = 'play-reject';
    el.style.cssText = 'position:fixed;left:50%;bottom:80px;transform:translateX(-50%);background:var(--accent,#c62828);color:#fff;padding:10px 18px;border-radius:6px;z-index:400;font-family:var(--heading);font-size:13px;font-weight:700;letter-spacing:0.5px;text-align:center;max-width:80vw;box-shadow:0 4px 20px rgba(0,0,0,0.35);';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.display = 'block';
  if (playRejectTimer) clearTimeout(playRejectTimer);
  playRejectTimer = setTimeout(() => { playRejectTimer = null; el.style.display = 'none'; }, 2200);
}

// Popups that own the current entry get a backdrop, so a tap meant for the popup
// can't land on the grid and move the selection underneath it (#1, #29).
const BACKDROP_GUARDED = ['k-popup', 'pos-popup'];

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
  'edit-play-popup', 'move-runner-popup', 'er-review-popup', 'recompute-popup'
];

function pendingEntryPopupOpen() {
  if (typeof document === 'undefined') return false;
  return PENDING_ENTRY_POPUPS.some(id => {
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
      renderPitchCount(team, p, col);
      renderPitcherChange(team, p, col);
    }
  }
}

// How many runners this play drove in: who is credited with a run now who wasn't
// before it. Counted across every column of the inning, so a runner who reached
// on an earlier trip through the order still earns the RBI.
function countRunnersScored(team, prev) {
  const players = gameState.teams[team].players;
  const didScore = ab => !!(ab && ab.bases[0] && ab.bases[1] && ab.bases[2] && ab.bases[3] && ab.outOnBase == null);
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
  const t = target || currentTarget();
  if (!t) return;
  const team = t.team;
  const pIdx = t.pIdx;
  const innIdx = t.innIdx;
  const ab = gameState.teams[team].players[pIdx].atBats[innIdx];
  const inn = getInnState(team, innIdx);
  if (inn.outs >= 3 || ab.play) return;

  // Reject before the at-bat is touched — no play, no result pitch.
  const reject = playEntryReject(team, innIdx, play);
  if (reject) { showPlayReject(reject); return; }

  // Save undo snapshot
  const prevTab = document.querySelector('.tab-btn.active')?.dataset.tab;
  const prev = captureInning(team, innIdx);
  const snapshot = { team, pIdx, innIdx, prev, prevTab };

  ab.play = play;
  // Every at-bat ends on a pitch — add the final pitch that produced the result
  if (!ab.pitches) ab.pitches = [];
  if (play !== 'BB' && play !== 'IBB' && play !== 'HBP') {
    // The result pitch: ball was put in play (hit/out) or swung through (K already tracked by auto-trigger)
    // Only add if this wasn't an auto-triggered K (which already has 3 strikes)
    const count = getPitchCount(ab.pitches);
    if (count.strikes < 3 && count.balls < 4) {
      if (isHitPlay(play) || isErrorPlay(play) || play === 'HR') ab.pitches.push('H');
      else ab.pitches.push('X');
    }
  } else if (ab.pitches.length === 0) {
    ab.pitches.push('B'); // HBP/walks always involve at least 1 pitch
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
    showRunnerPopup(team, innIdx, defaultAdv, function(choices) {
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
      } else if (isSac || play === 'IF' || isOutPlay(play)) {
        recordBatterOut(team, innIdx, pIdx, ab);
      }
      // RBI
      if (!isErrorPlay(play)) {
        ab.rbi = countRunnersScored(team, prev);
      }
      done();
    }, { batterTakesBase: isHitOrError, batterPIdx: pIdx });
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
      for (let step = fromBase + 1; step < outAt; step++) markAdvance(rab, step, rsn, src);
      setAdvReason(rab, outAt, rsn);
      const n = recordOut(team, innIdx, {
        kind: 'runner', pIdx: rn.p, col: rn.col,
        srcP: src ? src.pIdx : rn.p, srcCol: src ? src.col : rn.col
      });
      if (n) {
        rab.out = n;
        rab.outOnBase = outAt;
      }
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

  const outcomes = {};
  runners.forEach(r => { outcomes[r.base] = { action: 'safe', dest: Math.min(r.base + 1, 3) }; });
  outcomes.batter = { action: isDP ? 'out' : 'safe', dest: 0 };

  let html = '<div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--navy);margin-bottom:12px;font-family:var(--heading)">' + play + ' — Runner Outcomes</div>';

  runners.forEach(r => {
    html += `<div class="oc-row" data-base="${r.base}" style="margin-bottom:8px;padding:6px;background:var(--cream);border-radius:4px">`;
    html += `<div style="font-size:11px;font-weight:600;margin-bottom:4px">${escapeHtml(r.name)} <span style="color:var(--text-light)">(on ${r.fromLabel})</span></div>`;
    html += `<div style="display:flex;gap:4px;flex-wrap:wrap">`;
    // Hold option — keep the runner on their current base (e.g. runner on 3rd during a DP)
    html += `<button class="oc-btn" data-base="${r.base}" data-action="safe" data-dest="${r.base}" style="padding:3px 8px;font-size:10px;font-weight:600;border:1.5px solid #ccc;border-radius:3px;background:#fff;color:#555;cursor:pointer;font-family:var(--mono)">Hold ${r.fromLabel}</button>`;
    // Safe options
    for (let d = r.base + 1; d <= 3; d++) {
      const isDefault = d === r.base + 1 && outcomes[r.base].action === 'safe';
      html += `<button class="oc-btn" data-base="${r.base}" data-action="safe" data-dest="${d}" style="padding:3px 8px;font-size:10px;font-weight:600;border:1.5px solid ${isDefault ? '#2e7d32' : '#ccc'};border-radius:3px;background:${isDefault ? '#e8f5e9' : '#fff'};color:${isDefault ? '#2e7d32' : '#555'};cursor:pointer;font-family:var(--mono)">Safe ${baseNames[d]}</button>`;
    }
    // Out options
    for (let d = r.base + 1; d <= 3; d++) {
      html += `<button class="oc-btn" data-base="${r.base}" data-action="out" data-dest="${d}" style="padding:3px 8px;font-size:10px;font-weight:600;border:1.5px solid #ccc;border-radius:3px;background:#fff;color:#555;cursor:pointer;font-family:var(--mono)">Out at ${baseNames[d]}</button>`;
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

  html += `<button id="oc-confirm" style="margin-top:6px;width:100%;padding:7px;font-size:12px;font-weight:700;background:var(--navy);color:var(--gold);border:none;border-radius:4px;cursor:pointer;font-family:var(--heading);letter-spacing:0.5px;text-transform:uppercase">Confirm</button>`;
  popup.innerHTML = html;
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

  function refreshOutcomeAvailability() {
    popup.querySelectorAll('.oc-btn').forEach(btn => {
      if (btn.dataset.action !== 'safe') return;   // an out never collides
      const key = btn.dataset.base === 'batter' ? 'batter' : parseInt(btn.dataset.base);
      const dest = btn.dataset.dest ? parseInt(btn.dataset.dest) : 0;
      const hypothetical = ocParties().map(p => (p.key === key ? { key: p.key, from: p.from, dest } : p));
      setOptionBlocked(btn, runnerOrderConflicts(hypothetical).has(key));
    });
  }

  function flashOcRow(key) {
    const row = popup.querySelector('.oc-row[data-base="' + key + '"]');
    if (row) { row.style.outline = '2px solid var(--accent)'; setTimeout(() => row.style.outline = '', 800); }
  }

  // Button handlers
  const maxOuts = /^TP/.test(play) ? 3 : /^DP/.test(play) ? 2 : 3;
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
        while (outCount > maxOuts) {
          const revertKey = outKeys.find(k => String(k) !== base);
          if (revertKey === undefined) break;
          if (revertKey === 'batter') {
            outcomes.batter = { action: 'safe', dest: 0 };
          } else {
            outcomes[revertKey] = { action: 'safe', dest: Math.min(revertKey + 1, 3) };
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
    popup.style.display = 'none';
    callback(outcomes);
  };
}

function applyRunnerOutcomes(team, pIdx, innIdx, ab, inn, play, outcomes) {
  const playLabel = play.replace(/^(DP|FC|TP)\s*/, '') || play;

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
  const realInn = getRealInning(team, innIdx);
  const vR = parseInt(document.querySelector('input[data-ls="visiting"][data-stat="r"]')?.value) || 0;
  const hR = parseInt(document.querySelector('input[data-ls="home"][data-stat="r"]')?.value) || 0;
  // The bottom half ends the instant the home team goes ahead — a walk-off doesn't
  // wait for a 3rd out, and it doesn't care whether the run came in on a hit or on
  // a wild pitch. Otherwise the half has to be complete and the game not tied.
  const isGameOver = realInn >= 8 && (team === 'home'
    ? (hR > vR || (inn.outs >= 3 && vR !== hR))
    : (inn.outs >= 3 && hR > vR));
  if (!isGameOver || gameOverShown) return false;
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
  // Chronological order of plays, for pitcher decisions (Phase 8b). Only stamped
  // once, so re-editing a play doesn't move it later in the game.
  if (!ab.seq) {
    gameState.playSeq = (gameState.playSeq || 0) + 1;
    ab.seq = gameState.playSeq;
  }
  renderDiamond(team, pIdx, innIdx);
  renderOut(team, pIdx, innIdx);
  renderPlayText(team, pIdx, innIdx);
  renderRBI(team, pIdx, innIdx);
  renderPitchCount(team, pIdx, innIdx);
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

  let html = '<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px;color:#333">Advance Runners</div>';
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
  const batterDefaultBase = defaultAdv > 0 && defaultAdv <= 3 ? defaultAdv - 1 : -1;
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
    if (opts && opts.batterTakesBase) {
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

function overflowToNextColumn(team, innIdx) {
  const nextCol = innIdx + 1;
  if (nextCol >= INNINGS) return;

  // Mark the next column as a continuation of the same real inning
  if (!gameState.columnMap) gameState.columnMap = { visiting:defaultColumnMap(), home:defaultColumnMap() };
  const realInning = getRealInning(team, innIdx);
  // Shift all subsequent column mappings right by 1 (insert overflow)
  for (let c = INNINGS - 1; c > nextCol; c--) {
    gameState.columnMap[team][c] = gameState.columnMap[team][c - 1];
  }
  gameState.columnMap[team][nextCol] = realInning; // same inning continues

  // Copy inning state (outs, bases) to the new column
  const srcInn = getInnState(team, innIdx);
  const dstInn = getInnState(team, nextCol);
  dstInn.outs = srcInn.outs;
  dstInn.bases = [...srcInn.bases];
  dstInn.currentPitcher = srcInn.currentPitcher;
  dstInn.pitcherSet = srcInn.pitcherSet;

  // Update column headers
  updateColumnHeaders(team);

  // Select the next batter in the new column (wrap around from where we left off)
  const sameTeam = selectedCell && selectedCell.dataset.team === team;
  const curP = sameTeam ? parseInt(selectedCell.dataset.p) : -2;
  const curPos = Math.floor(curP / ROWS_PER_POS);
  const nextPos = (curPos + 1) % POSITIONS;
  const nextP = nextPos * ROWS_PER_POS;
  const cell = document.querySelector(`.at-bat-cell[data-team="${team}"][data-p="${nextP}"][data-inn="${nextCol}"]`);
  if (cell) selectCell(cell);
}

function getNextFreeColumn(team) {
  // Find the next column that has no plays yet for this team
  const players = gameState.teams[team].players;
  for (let col = 0; col < INNINGS; col++) {
    let hasPlay = false;
    for (let pos = 0; pos < POSITIONS; pos++) {
      if (players[pos * ROWS_PER_POS].atBats[col].play) { hasPlay = true; break; }
    }
    if (!hasPlay) return col;
  }
  return INNINGS - 1;
}

function switchToNextHalf(team, innIdx) {
  markNextInningLeadoff(team, innIdx);

  if (team === 'visiting') {
    // Find the correct column for the home team in this real inning
    switchTab('home');
    const homeCol = getNextFreeColumn('home');
    selectNextBatterForInning('home', homeCol);
  } else {
    // Find the correct next column for the visiting team
    switchTab('visiting');
    const visCol = getNextFreeColumn('visiting');
    selectNextBatterForInning('visiting', visCol);
  }
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
  const nextCol = getNextFreeColumn(team);

  if (!gameState.nextLeadoff) gameState.nextLeadoff = {};
  if (!gameState.nextLeadoff[team]) gameState.nextLeadoff[team] = {};
  gameState.nextLeadoff[team][nextCol] = nextP;
}

function selectNextBatterForInning(team, colIdx) {
  // #6: extra-inning columns are display:none until +EI is pressed. After a tied
  // 9th the app selected a cell nobody could see, so reveal the column first.
  if (colIdx >= (gameState.visibleInnings || 9)) {
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
  if (getInnState(team, innIdx).outs >= 3) return;
  if (!ab.pitches) ab.pitches = [];
  const before = getPitchCount(ab.pitches);
  if (before.balls >= 4 || before.strikes >= 3) return;
  pushUndo(team, pIdx, innIdx);
  ab.pitches.push(type);
  renderPitches(team, pIdx, innIdx);
  renderPitchCount(team, pIdx, innIdx);
  updateSituation();
  checkAutoTrigger(team, pIdx, innIdx);
  autoSave();
}

function removePitch() {
  if (!selectedCell) return;
  const team = selectedCell.dataset.team;
  const pIdx = parseInt(selectedCell.dataset.p);
  const innIdx = parseInt(selectedCell.dataset.inn);
  const ab = gameState.teams[team].players[pIdx].atBats[innIdx];
  if (!ab.pitches || !ab.pitches.length) return;
  pushUndo(team, pIdx, innIdx);
  const wasAutoPlay = ab.play === 'BB' || ab.play === 'K' || ab.play === 'ꓘ';
  ab.pitches.pop();
  if (wasAutoPlay) {
    // Find the snapshot from when the auto-play was applied (entry before this removePitch's pushUndo)
    const autoSnapIdx = playHistory.length - 2;
    if (autoSnapIdx >= 0 && playHistory[autoSnapIdx].prev) {
      const snap = playHistory[autoSnapIdx];
      restoreInning(team, snap.prev);
      renderInning(team, snap.prev);
      playHistory.splice(autoSnapIdx, 1);
    } else {
      removeOutsFromPlay(team, innIdx, pIdx, innIdx, ab.out > 0 ? 1 : 0);
      const inn = getInnState(team, innIdx);
      removeRunnerFromBases(inn, pIdx);
      ab.play = '';
      ab.bases = [false, false, false, false];
      ab.out = 0; ab.outsRecorded = 0; ab.seq = 0;
      renumberOuts(team, innIdx);
      renderDiamond(team, pIdx, innIdx);
      renderOut(team, pIdx, innIdx);
      renderPlayText(team, pIdx, innIdx);
    }
    updateInningRuns(team, innIdx);
    updatePlayerStats(team);
    updatePitcherStats(team);
  }
  renderPitches(team, pIdx, innIdx);
  renderPitchCount(team, pIdx, innIdx);
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
  if (lsBatter) lsBatter.textContent = getActivePlayerName(team, pIdx, innIdx);

  // Pitch sequence
  const lsPitches = document.getElementById('ls-pitches');
  if (lsPitches) {
    const pitches = ab.pitches || [];
    lsPitches.textContent = pitches.length > 0 ? pitches.length + ' pitches' : '';
  }

  // Linescore highlight + auto-zeros for completed innings
  highlightLinescore(team, innIdx);
  fillLinescoreZeros();

  // (count, batter, LOB now handled in the panel loop above)
}

function updateLiveStatsFromState() {
  const vR = parseInt(document.querySelector('input[data-ls="visiting"][data-stat="r"]')?.value) || 0;
  const hR = parseInt(document.querySelector('input[data-ls="home"][data-stat="r"]')?.value) || 0;
  // Find the last inning with plays
  let lastTeam = 'visiting', lastInn = 0, hasPlays = false;
  ['visiting','home'].forEach(team => {
    const players = gameState.teams[team].players;
    for (let col = INNINGS - 1; col >= 0; col--) {
      for (let p = 0; p < players.length; p++) {
        if (players[p].atBats[col].play) {
          if (col > lastInn || (col === lastInn && team === 'home')) {
            lastInn = col; lastTeam = team; hasPlays = true;
          }
          break;
        }
      }
      if (hasPlays && col < lastInn) break;
    }
  });
  if (!hasPlays) return;
  const inn = getInnState(lastTeam, lastInn);
  const realInn = getRealInning(lastTeam, lastInn);
  const isComplete = (lastTeam === 'home' && realInn >= 8 && inn.outs >= 3) ||
                     (lastTeam === 'visiting' && realInn >= 8 && inn.outs >= 3 && hR > vR);
  const lsInn = document.getElementById('ls-inning');
  const lsCount = document.getElementById('ls-count');
  const lsBatter = document.getElementById('ls-batter');
  if (isComplete) {
    if (lsInn) lsInn.textContent = 'FINAL';
    if (lsCount) lsCount.textContent = vR + '-' + hR;
    if (lsBatter) lsBatter.textContent = '';
    for (let i = 1; i <= 3; i++) {
      const od = document.getElementById('ls-out-' + i);
      if (od) od.classList.remove('active');
    }
    ['ls-b1','ls-b2','ls-b3'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.setAttribute('fill', 'rgba(255,255,255,0.2)');
    });
    const lsPitches = document.getElementById('ls-pitches');
    if (lsPitches) lsPitches.textContent = '';
  } else {
    const half = lastTeam === 'visiting' ? '▲' : '▼';
    if (lsInn) lsInn.textContent = half + ' ' + (realInn + 1);
  }
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
  if (options.length === 0) return;
  if (options.length === 1) { applySBAtBase(team, innIdx, options[0].from, false); return; }
  showBasePickerPopup('Stolen Base', options, function(from, extra) { applySBAtBase(team, innIdx, from, extra === 'error'); });
}

function applySBAtBase(team, innIdx, fromBase, withError) {
  const inn = getInnState(team, innIdx);
  // #3: the half-inning is over — a stranded runner can't steal, least of all
  // steal home and put a run on the board.
  if (inn.outs >= 3) return;
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
  if (options.length === 0) return;
  if (options.length === 1) { applyCSAtBase(team, innIdx, options[0].from); return; }
  showBasePickerPopup('Caught Stealing', options, function(from) { applyCSAtBase(team, innIdx, from); });
}

function applyCSAtBase(team, innIdx, fromBase) {
  const inn = getInnState(team, innIdx);
  // #2: no 4th out — the guard applyRunnerEvent has always had.
  if (inn.outs >= 3) return;
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
  if (options.length === 0) return;
  showBasePickerPopup('Pickoff', options, function(from, extra) { applyPickoff(team, innIdx, from, extra === 'error'); });
}

function applyPickoff(team, innIdx, atBase, withError) {
  const inn = getInnState(team, innIdx);
  // #2: no 4th out, and no advancing a stranded runner on the error variant.
  if (inn.outs >= 3) return;
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

function applyRunnerEvent(type) {
  if (!selectedCell) return;
  const team = selectedCell.dataset.team;
  const pIdx = parseInt(selectedCell.dataset.p);
  const innIdx = parseInt(selectedCell.dataset.inn);
  const inn = getInnState(team, innIdx);
  if (inn.outs >= 3) return;
  pushUndo(team, pIdx, innIdx);

  if (type === 'WP' || type === 'PB') {
    // Rule 9.16: a run that scores as a result of a passed ball is unearned (a wild
    // pitch is the pitcher's own doing, so the WP side is right to do nothing).
    // This used to flag only the runner on 3rd, so a man moved up from 1st or 2nd
    // by the same passed ball scored as an earned run later (#14). Flag whoever the
    // ball actually moved — a runner it couldn't advance keeps his own reckoning.
    const before = type === 'PB' ? inn.bases.slice() : null;
    advanceRunners(team, innIdx, 1, type);
    if (before) {
      for (let b = 0; b < 3; b++) {
        const rn = before[b];
        if (!rn || sameRunner(inn.bases[b], rn)) continue;
        const rab = runnerAtBat(team, rn);
        if (rab) rab.reachedOnError = true;
      }
    }
  } else if (type === 'SB') {
    // Lead runner first, so 2nd is free for the man behind him. A blocked steal is
    // refused, not converted into an extra base: this used to send the runner from
    // 2nd all the way home when 3rd was occupied, inventing a run (#4).
    if (inn.bases[1] !== null) {
      const rn = inn.bases[1]; const rab = runnerAtBat(team, rn);
      if (rab && moveRunnerTo(inn, 1, 2, rn)) {
        rab.bases[2] = true; setAdvReason(rab, 2, 'SB');
        renderDiamond(team, rn.p, rn.col);
      }
    }
    if (inn.bases[0] !== null && inn.bases[1] === null) {
      const rn = inn.bases[0]; const rab = runnerAtBat(team, rn);
      if (rab && moveRunnerTo(inn, 0, 1, rn)) {
        rab.bases[1] = true; setAdvReason(rab, 1, 'SB');
        renderDiamond(team, rn.p, rn.col);
      }
    }
  } else if (type === 'CS') {
    let removed = false;
    for (let b = 2; b >= 0; b--) {
      if (inn.bases[b] !== null && !removed) {
        const rn = inn.bases[b];
        const rab = runnerAtBat(team, rn);
        if (!rab) continue;
        const n = recordOut(team, innIdx, { kind: 'runner', pIdx: rn.p, col: rn.col });
        if (!n) break;
        rab.out = n;
        rab.outOnBase = b + 1;
        setAdvReason(rab, b + 1, 'CS');
        renderDiamond(team, rn.p, rn.col);
        renderOut(team, rn.p, rn.col);
        clearRunner(inn, b);
        removed = true;
      }
    }
  } else if (type === 'BK') {
    // Balk: all runners advance 1 base, like WP
    advanceRunners(team, innIdx, 1, 'BK');
  }
  afterStateChange(team, innIdx);
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
    renderPitchCount(team, pIdx, c);
    renderPitcherChange(team, pIdx, c);
  }
}

function restoreSnapshot(snap) {
  const { team, pIdx, innIdx } = snap;
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
  if (!playHistory.length) return;
  const last = playHistory[playHistory.length - 1];
  const redo = snapshotForRedo(last.team, last.pIdx, last.innIdx);
  redoHistory.push(redo);
  playHistory.pop();
  restoreSnapshot(last);
}

function redoLastPlay() {
  if (pendingEntryPopupOpen()) { showPlayReject('Finish or close the open entry first.'); return; }
  dismissSprayPopup();
  if (!redoHistory.length) return;
  const next = redoHistory[redoHistory.length - 1];
  const undo = snapshotForRedo(next.team, next.pIdx, next.innIdx);
  playHistory.push(undo);
  redoHistory.pop();
  restoreSnapshot(next);
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
      showPlayReject('The inning already has 3 outs — clear a play first.');
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
      recomputeInning(team, realInn);
      updatePlayerStats(team);
      updatePitcherStats(team);
      updateSituation();
      autoSave();
    });
  };
}

/* Feature 3: Re-open runner popup to fix advancements */
function editRunners() {
  if (!selectedCell) return;
  const team = selectedCell.dataset.team;
  const pIdx = parseInt(selectedCell.dataset.p);
  const innIdx = parseInt(selectedCell.dataset.inn);
  const ab = gameState.teams[team].players[pIdx].atBats[innIdx];
  if (!ab.play) return;
  const batterLbl = getBatterLabel(team, pIdx, innIdx);
  pushUndo(team, pIdx, innIdx);
  showRunnerPopup(team, innIdx, 0, function(choices) {
    applyChosenAdvancements(team, innIdx, choices, batterLbl);
    updateInningRuns(team, innIdx);
    updatePlayerStats(team);
    updatePitcherStats(team);
    updateSituation();
    autoSave();
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
  if (runners.length === 0) return;
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
    html += '<button class="mr-btn mr-remove" data-from="' + r.base + '" data-to="off" style="padding:3px 8px;font-size:10px;font-weight:600;border:1.5px solid var(--accent);border-radius:3px;background:#fff;color:var(--accent);cursor:pointer;font-family:var(--mono)">Remove</button>';
    html += '</div></div>';
  });
  html += '<button onclick="document.getElementById(\'move-runner-popup\').style.display=\'none\'" style="margin-top:4px;width:100%;padding:5px;font-size:11px;border:1px solid #ccc;border-radius:4px;background:#f5f5f5;cursor:pointer">Close</button>';
  popup.innerHTML = html;
  popup.style.display = 'block';
  popup.querySelectorAll('.mr-btn').forEach(btn => {
    btn.onclick = function() {
      const from = parseInt(this.dataset.from);
      const to = this.dataset.to;
      const rn = inn.bases[from];
      if (rn === null) return;
      const toBase = to === 'off' ? null : parseInt(to);
      if (toBase !== null && !baseFreeFor(inn, toBase, rn)) {
        reportRunnerCollision(toBase, inn.bases[toBase], rn);
        return;
      }
      pushUndo(team, pIdx, innIdx);
      const rab = runnerAtBat(team, rn);
      if (!rab) return;
      if (to === 'off') {
        clearRunner(inn, from);
        for (let b = 0; b < 4; b++) { rab.bases[b] = false; }
        rab.advReason = ['','','',''];
        rab.out = 0; rab.outsRecorded = 0; rab.outOnBase = null;
      } else {
        if (!moveRunnerTo(inn, from, toBase, rn)) return;
        for (let step = from + 1; step <= toBase; step++) {
          rab.bases[step] = true;
          setAdvReason(rab, step, 'MV');
        }
      }
      renderDiamond(team, rn.p, rn.col);
      renderOut(team, rn.p, rn.col);
      updateInningRuns(team, innIdx);
      updatePlayerStats(team);
      updateSituation();
      autoSave();
      popup.style.display = 'none';
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
  ab.advReason = ['','','','']; ab.reachedOnError = false; ab.seq = 0;
  ab.advSrc = null;
  // Re-apply saved pitches on the batter's at-bat
  ab.pitches = savedPitches;
  renderDiamond(team, pIdx, innIdx);
  renderOut(team, pIdx, innIdx);
  renderPlayText(team, pIdx, innIdx);
  renderPitches(team, pIdx, innIdx);
  renderPitchCount(team, pIdx, innIdx);
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
  if (!ab.play || (!isHitPlay(ab.play) && !isErrorPlay(ab.play) && ab.play !== 'HR')) return;
  showSprayChart(team, pIdx, innIdx);
}

/* Feature 7: Manual RBI adjustment */
function adjustRBI(delta) {
  if (!selectedCell) return;
  const team = selectedCell.dataset.team;
  const pIdx = parseInt(selectedCell.dataset.p);
  const innIdx = parseInt(selectedCell.dataset.inn);
  const ab = gameState.teams[team].players[pIdx].atBats[innIdx];
  if (!ab.play) return;
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
      const pl = gameState.teams[team].players[r.pIdx];
      const label = (pl.num ? '#' + pl.num + ' ' : '') + (pl.name || `Batter ${r.pIdx + 1}`);
      const unearned = !!r.ab.reachedOnError;
      html += '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 0;border-top:1px solid var(--border-light,#ddd)">';
      html += `<div style="font-size:12px;line-height:1.3"><div style="font-weight:600">${escapeHtml(label)}</div><div style="font-size:10px;color:var(--text-light,#666)">${escapeHtml(describeReach(r.ab))}</div></div>`;
      html += '<div style="display:flex;gap:4px;flex:0 0 auto">';
      html += `<button onclick="setRunEarnedByIndex(${i}, false)" style="padding:5px 9px;font-size:11px;font-weight:700;border:1.5px solid ${!unearned ? '#1565c0' : '#ccc'};border-radius:4px;background:${!unearned ? '#e3f2fd' : '#fff'};color:${!unearned ? '#1565c0' : '#666'};cursor:pointer">Earned</button>`;
      html += `<button onclick="setRunEarnedByIndex(${i}, true)" style="padding:5px 9px;font-size:11px;font-weight:700;border:1.5px solid ${unearned ? 'var(--accent,#c41e3a)' : '#ccc'};border-radius:4px;background:${unearned ? '#fdecef' : '#fff'};color:${unearned ? 'var(--accent,#c41e3a)' : '#666'};cursor:pointer">Unearned</button>`;
      html += '</div></div>';
    });
  }
  html += '<button onclick="document.getElementById(\'er-review-popup\').style.display=\'none\'" style="margin-top:10px;width:100%;padding:6px;font-size:12px;border:1px solid #ccc;border-radius:4px;background:#f5f5f5;cursor:pointer">Done</button>';

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
    ab.pitcherChangeNum = '';
    // A sub line spans from here to the end of the game; clear the whole contiguous run.
    if (ab.subChange) {
      for (let c = innIdx; c < players[pIdx].atBats.length && players[pIdx].atBats[c].subChange; c++) {
        players[pIdx].atBats[c].subChange = false;
        renderPitcherChange(team, pIdx, c);
      }
    }
    ab.subChange = false;
    ab.seq = 0;
    renderDiamond(team, pIdx, innIdx);
    renderOut(team, pIdx, innIdx);
    renderPitches(team, pIdx, innIdx);
    renderPlayText(team, pIdx, innIdx);
    renderRBI(team, pIdx, innIdx);
    renderPitchCount(team, pIdx, innIdx);
  }

  renderPitcherChange(team, pIdx, innIdx);
  // Both branches above touch only the at-bat records (and the out log); the
  // inning's outs, bases, runs and LOB come back out of them here. The restore
  // branch reinstates the snapshot's inning records wholesale, so a recompute over
  // it is a no-op unless the snapshot and the at-bats disagree — records win.
  recomputeInning(team, getRealInning(team, innIdx));
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
  // #16: this used to be the *second* writer of `inn.lob`, and the two disagreed.
  // Its own scan counted every at-bat that reached and hadn't scored, in every
  // column including innings still in progress — so LOB climbed as runners reached
  // and fell as they scored, and it counted a runner two plays before anyone was
  // left on anything. `recomputeInning` settles the figure when the half-inning
  // ends; this only adds them up.
  const totalLob = teamLOB(team);
  gameState.linescore[team].lob = totalLob;
  const lobInp = document.querySelector(`input[data-ls="${team}"][data-stat="lob"]`);
  if (lobInp) lobInp.value = totalLob || '';
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
    const pitcherStats = ['era','ip','pc','h','r','er','k','bb'];
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
  // Dropped in Phase 9: an older save still carries an unbounded play log (#31)
  // and an unused standings table (#33). Shed them rather than writing them back
  // out on every autoSave.
  delete parsed.log;
  delete parsed.standings;
  refillAtBats(parsed);
  backfillOutsLog(parsed);
  migrateBaseRunners(parsed);
  return parsed;
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
  if (!gameState.visibleInnings) gameState.visibleInnings = 9;
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
        renderPitchCount(team, p, inn);
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
  applyState();
}

function printScorecard() { window.print(); }

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

/* Render pitch count in at-bat cell (Feature 12) */
function renderPitchCount(team, pIdx, innIdx) {
  const ab = gameState.teams[team].players[pIdx].atBats[innIdx];
  const el = document.getElementById(`pc-${team}-${pIdx}-${innIdx}`);
  if (!el) return;
  const count = (ab.pitches || []).length;
  el.textContent = count > 0 ? count : '';
  el.classList.toggle('active', count > 0);
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

function tallyAtBats(team, pIdx, atBats, filterFn) {
  let ab = 0, h = 0, r = 0, rbi = 0, bb = 0, k = 0, hbp = 0;
  for (let col = 0; col < atBats.length; col++) {
    const atBat = atBats[col];
    if (!atBat.play || !filterFn(atBat)) continue;
    const isSac = ['SAC','SF','SH'].includes(atBat.play);
    const noAB = isSac
      ? sacrificeExemptsAB(team, pIdx, col, atBat)
      : ['BB','HBP','IBB','CI'].includes(atBat.play);
    if (!noAB) ab++;
    if (isHitPlay(atBat.play)) h++;
    if (atBat.bases[0] && atBat.bases[1] && atBat.bases[2] && atBat.bases[3] && atBat.outOnBase == null) r++;
    rbi += (atBat.rbi || 0);
    if (atBat.play === 'BB' || atBat.play === 'IBB') bb++;
    if (atBat.play === 'K' || atBat.play === 'ꓘ' || atBat.play === 'K+WP') k++;
    if (atBat.play === 'HBP') hbp++;
  }
  return { ab, h, r, rbi, bb, k, hbp };
}

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
    const subp = sp + 1;
    const player = players[sp];
    const allABs = player.atBats;
    const hasSub = player.atBats.some(a => a.subChange);
    if (hasSub) {
      writeStats(team, sp, tallyAtBats(team, sp, allABs, a => !a.subChange));
      writeStats(team, subp, tallyAtBats(team, sp, allABs, a => a.subChange));
    } else {
      writeStats(team, sp, tallyAtBats(team, sp, allABs, () => true));
      writeStats(team, subp, { ab:0, h:0, r:0, rbi:0, bb:0 });
    }
  }
}

/* Pitcher Stats Auto-Calculation (Feature 5) */
function updatePitcherStats(battingTeam) {
  // When visiting is batting, HOME pitchers face them. So update HOME pitcher stats.
  const pitchingTeam = battingTeam === 'visiting' ? 'home' : 'visiting';
  const pitchers = gameState.teams[pitchingTeam].pitchers;
  const stats = {};
  for (let i = 0; i < PITCHER_ROWS; i++) {
    stats[i] = { ip: 0, outs: 0, k: 0, bb: 0, h: 0, r: 0, er: 0, pc: 0, prov: false };
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
      if (!stats[pi]) stats[pi] = { ip: 0, outs: 0, k: 0, bb: 0, h: 0, r: 0, er: 0, pc: 0, prov: false };
      const s = stats[pi];
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
      if (!stats[pi]) stats[pi] = { ip: 0, outs: 0, k: 0, bb: 0, h: 0, r: 0, er: 0, pc: 0, prov: false };
      stats[pi].outs++;
    }
  }

  // Update pitcher table cells for the pitching team
  for (let i = 0; i < PITCHER_ROWS; i++) {
    const s = stats[i];
    const fullInnings = Math.floor(s.outs / 3);
    const partialOuts = s.outs % 3;
    const ipStr = partialOuts > 0 ? `${fullInnings}.${partialOuts}` : (s.outs > 0 ? `${fullInnings}` : '');

    const fields = { ip: ipStr, pc: s.pc || '', h: s.h || '', r: s.r || '', er: s.er || '', k: s.k || '', bb: s.bb || '' };
    Object.keys(fields).forEach(field => {
      const inp = document.querySelector(`input[data-team="${pitchingTeam}"][data-pitcher="${i}"][data-field="${field}"]`);
      if (inp) {
        inp.value = fields[field];
        pitchers[i][field] = String(fields[field]);
      }
    });

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
    html += `<button onclick="setPitcher(${i})" style="display:block;width:100%;text-align:left;padding:6px 10px;margin-bottom:4px;border:1.5px solid ${isActive ? '#1565c0' : '#ccc'};border-radius:4px;background:${isActive ? '#e3f2fd' : '#fff'};cursor:pointer;font-size:12px;font-weight:${isActive ? '700' : '500'};font-family:var(--font)">${escapeHtml(num)}${escapeHtml(name)}</button>`;
  });
  html += '<button onclick="document.getElementById(\'pitcher-popup\').style.display=\'none\'" style="margin-top:6px;width:100%;padding:5px;font-size:11px;border:1px solid #ccc;border-radius:4px;background:#f5f5f5;cursor:pointer">Cancel</button>';
  popup.innerHTML = html;
  popup.style.display = 'block';
}

function markSub() {
  if (!selectedCell) return;
  const team = selectedCell.dataset.team;
  const pIdx = parseInt(selectedCell.dataset.p);
  const innIdx = parseInt(selectedCell.dataset.inn);
  pushUndo(team, pIdx, innIdx);
  const player = gameState.teams[team].players[pIdx];
  const turning = !player.atBats[innIdx].subChange;
  const startCol = (turning && player.atBats[innIdx].play) ? innIdx + 1 : innIdx;
  for (let c = startCol; c < INNINGS; c++) {
    player.atBats[c].subChange = turning;
    renderPitcherChange(team, pIdx, c);
  }
  updatePlayerStats(team);
  autoSave();
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
  let html = '<div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--navy);margin-bottom:10px;font-family:var(--heading)">Position Change <span style="font-size:11px;color:var(--red);font-weight:600;margin-left:6px">' + innLabel + '</span></div>';
  html += '<div style="font-size:11px;margin-bottom:8px;color:var(--text-light)">' + escapeHtml(name) + ' — current: <b>' + escapeHtml(current || 'none') + '</b></div>';
  html += '<div style="display:flex;gap:4px;flex-wrap:wrap">';
  positions.forEach(pos => {
    const isCurrent = pos === current;
    html += `<button onclick="applyFieldPos('${team}',${starterP},'${pos}','${innLabel}')" style="padding:5px 10px;font-size:11px;font-weight:${isCurrent?'700':'600'};border:1.5px solid ${isCurrent?'var(--navy)':'#ccc'};border-radius:4px;background:${isCurrent?'var(--cream)':'#fff'};color:${isCurrent?'var(--navy)':'#555'};cursor:pointer;font-family:var(--mono)">${pos}</button>`;
  });
  html += '</div>';
  html += '<button onclick="document.getElementById(\'pos-change-popup\').style.display=\'none\'" style="margin-top:10px;width:100%;padding:5px;font-size:11px;border:1px solid #ccc;border-radius:4px;background:#f5f5f5;cursor:pointer">Cancel</button>';
  popup.innerHTML = html;
  popup.style.display = 'block';
}

function applyFieldPos(team, starterP, pos, innLabel) {
  const posSelect = document.querySelector(`select[data-field="pos"][data-team="${team}"][data-p="${starterP}"]`);
  const oldPos = posSelect ? posSelect.value : '';
  if (posSelect) { posSelect.value = pos; }
  if (oldPos && oldPos !== pos && innLabel) {
    if (!gameState.defChanges) gameState.defChanges = [];
    const player = gameState.teams[team].players[starterP];
    const sub = gameState.teams[team].players[starterP + 1];
    const hasSub = player.atBats.some(ab => ab.subChange);
    const activeName = hasSub && sub.name ? sub.name : player.name;
    const activeNum = hasSub && sub.num ? sub.num : player.num;
    const displayName = (activeNum ? '#' + activeNum + ' ' : '') + (activeName || 'Pos ' + (Math.floor(starterP / ROWS_PER_POS) + 1));
    let existing = gameState.defChanges.find(d => d.inning === innLabel && d.team === team);
    if (!existing) {
      existing = { inning: innLabel, team, changes: [] };
      gameState.defChanges.push(existing);
    }
    const prevEntry = existing.changes.findIndex(c => c.pIdx === starterP);
    if (prevEntry >= 0) existing.changes.splice(prevEntry, 1);
    existing.changes.push({ pIdx: starterP, fromPos: oldPos, toPos: pos, name: displayName });
  }
  document.getElementById('pos-change-popup').style.display = 'none';
  autoSave();
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
  document.getElementById('pitcher-popup').style.display = 'none';
  autoSave();
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
    const isSubStart = !!ab.subChange && !(prev && prev.subChange);
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
    html += '<button onclick="document.getElementById(\'recompute-popup\').style.display=\'none\'" style="width:100%;padding:6px;font-size:12px;border:1px solid #ccc;border-radius:4px;background:#f5f5f5;cursor:pointer">Close</button>';
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
    plan.forEach(p => { p.ab.pitcher = p.to; });
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
  const vis = gameState.visibleInnings || 9;
  for (let i = 0; i < INNINGS; i++) {
    const show = i < vis;
    document.querySelectorAll(`.inn-col[data-inn="${i}"], .at-bat-cell[data-inn="${i}"], [data-inn-col="${i}"]`)
      .forEach(el => el.classList.toggle('hidden-inning', !show));
  }
  const btn = document.getElementById('add-extra-inn-btn');
  if (btn) btn.style.display = vis < INNINGS ? '' : 'none';
}

function addExtraInning() {
  if (!gameState.visibleInnings) gameState.visibleInnings = 9;
  if (gameState.visibleInnings < INNINGS) {
    gameState.visibleInnings++;
    updateInningVisibility();
    autoSave();
  }
}

function updateExtraInnings() { updateInningVisibility(); }

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
        <button class="load-btn" onclick="loadGameFromLibrary(${idx})">Load</button>
        <button class="del-btn" onclick="deleteGameFromLibrary(${idx})">Delete</button>
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

// True if the in-progress game differs from its saved library snapshot.
function currentGameHasUnsavedChanges() {
  if (!gameState.currentGameId) return false;
  const entry = getGameLibrary().find(g => g.id === gameState.currentGameId);
  if (!entry || !entry.state) return false;
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
  const slug = s => (s || '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
  const vis = slug(gameState.info.visitingTeam) || 'visiting';
  const hom = slug(gameState.info.homeTeam) || 'home';
  downloadTextFile(`scorecard-${vis}-vs-${hom}.json`, JSON.stringify(stateForStorage(gameState), null, 2));
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

  const gsVis = gameState.visibleInnings || 9;

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
    for (let pos = 0; pos < POSITIONS; pos++) {
      const sp = pos * ROWS_PER_POS;
      const subp = sp + 1;
      const starter = players[sp];
      const sub = players[subp];
      const allABs = starter.atBats;
      const hasSub = starter.atBats.some(ab => ab.subChange);
      if (hasSub) {
        const ss = tallyAtBats(team, sp, allABs, ab => !ab.subChange);
        const us = tallyAtBats(team, sp, allABs, ab => ab.subChange);
        if (ss.ab > 0 || ss.bb > 0 || ss.hbp > 0) {
          const name = (starter.num ? '#' + starter.num + ' ' : '') + (starter.name || 'Pos ' + (pos + 1));
          addRow(name, getPosTrail(team, sp), ss, false);
        }
        if (us.ab > 0 || us.bb > 0 || us.hbp > 0) {
          const name = (sub.num ? '#' + sub.num + ' ' : '') + (sub.name || 'Sub ' + (pos + 1));
          addRow(name, sub.pos || '', us, true);
        }
      } else {
        if (!starter.name && !starter.num) continue;
        const s = tallyAtBats(team, sp, allABs, () => true);
        if (s.ab === 0 && s.bb === 0 && s.hbp === 0) continue;
        const name = (starter.num ? '#' + starter.num + ' ' : '') + (starter.name || 'Pos ' + (pos + 1));
        addRow(name, getPosTrail(team, sp), s, false);
      }
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
      if (!p.name && !p.num) continue;
      const ip = p.ip || '0';
      if (ip === '0' && !p.h && !p.k) continue;
      const name = (p.num ? '#' + p.num + ' ' : '') + (p.name || 'Pitcher ' + (i + 1));
      rows += '<tr><td>' + escapeHtml(name) + '</td><td>' + (p.ip || '0') + '</td><td>' + (p.pc || '0') + '</td><td>' + (p.h || '0') + '</td><td>' + (p.r || '0') + '</td><td>' + (p.er || '0') + '</td><td>' + (p.k || '0') + '</td><td>' + (p.bb || '0') + '</td></tr>';
    }
    return rows;
  }

  // Player of the game: highest combined (H + RBI + R) weighted
  function findPlayerOfGame() {
    let best = null, bestScore = -1;
    function consider(pl, tName, atBats, filterFn) {
      if (!pl.name) return;
      let h = 0, rbi = 0, r = 0, hr = 0, ab = 0, k = 0;
      for (const atBat of atBats) {
        if (!atBat.play || !filterFn(atBat)) continue;
        if (isHitPlay(atBat.play)) h++;
        if (atBat.play === 'HR') hr++;
        rbi += (atBat.rbi || 0);
        if (atBat.bases[0] && atBat.bases[1] && atBat.bases[2] && atBat.bases[3] && atBat.outOnBase == null) r++;
        const noAB = ['BB','HBP','IBB','SAC','SF','SH','CI'].includes(atBat.play);
        if (!noAB) ab++;
        if (atBat.play === 'K' || atBat.play === 'ꓘ' || atBat.play === 'K+WP') k++;
      }
      const score = h * 3 + rbi * 2 + r * 2 + hr * 3 - k;
      if (score > bestScore) {
        bestScore = score;
        best = { name: (pl.num ? '#' + pl.num + ' ' : '') + pl.name, team: tName, h, ab, rbi, r, hr, pos: pl.pos || '' };
      }
    }
    ['visiting', 'home'].forEach(team => {
      const players = gameState.teams[team].players;
      const tName = team === 'visiting' ? vTeam : hTeam;
      for (let pos = 0; pos < POSITIONS; pos++) {
        const sp = pos * ROWS_PER_POS;
        const starter = players[sp];
        const sub = players[sp + 1];
        const hasSub = starter.atBats.some(ab => ab.subChange);
        if (hasSub) {
          consider(starter, tName, starter.atBats, ab => !ab.subChange);
          consider(sub, tName, starter.atBats, ab => ab.subChange);
        } else {
          consider(starter, tName, starter.atBats, () => true);
        }
      }
    });
    // Also check pitchers — dominant pitching performance
    ['visiting', 'home'].forEach(team => {
      const pitchers = gameState.teams[team].pitchers;
      const tName = team === 'visiting' ? vTeam : hTeam;
      for (let i = 0; i < PITCHER_ROWS; i++) {
        const p = pitchers[i];
        if (!p.name) continue;
        const ip = parseFloat(p.ip) || 0;
        const k = parseInt(p.k) || 0;
        const er = parseInt(p.er) || 0;
        const score = ip * 2 + k * 2 - er * 4;
        if (score > bestScore && ip >= 5) {
          bestScore = score;
          best = { name: (p.num ? '#' + p.num + ' ' : '') + p.name, team: tName, isPitcher: true, ip: p.ip, k, er, h: parseInt(p.h) || 0 };
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
        const sub = players[sp + 1];
        const hasSub = starter.atBats.some(ab => ab.subChange);
        if (hasSub) {
          if (starter.name) scanNotable((starter.num ? '#' + starter.num + ' ' : '') + starter.name, tName, starter.atBats, ab => !ab.subChange);
          if (sub.name) scanNotable((sub.num ? '#' + sub.num + ' ' : '') + sub.name, tName, starter.atBats, ab => ab.subChange);
        } else {
          if (!starter.name) continue;
          scanNotable((starter.num ? '#' + starter.num + ' ' : '') + starter.name, tName, starter.atBats, () => true);
        }
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

  let html = '<div style="position:relative"><button onclick="document.getElementById(\'game-summary-modal\').classList.remove(\'active\')" style="position:absolute;top:-8px;right:-12px;font-size:24px;cursor:pointer;color:var(--text-light);background:none;border:none;font-weight:700">&times;</button>';

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
    const change = w => '<button onclick="promptPitcherDecision(\'' + w + '\')" style="margin-left:6px;font-size:9px;padding:1px 5px;border:1px solid var(--border);border-radius:3px;background:transparent;color:var(--text-light);cursor:pointer;font-family:var(--font)">change</button>';
    const nameOf = (team, idx) => (idx === null || idx === undefined || idx < 0) ? '—' : escapeHtml(pitcherLabel(team, idx));
    html += '<div class="gs-highlight-card"><div class="gs-hl-label">Pitching Decision</div>';
    html += '<div class="gs-pitching-line"><b>W:</b> ' + nameOf(decisions.winTeam, decisions.wp) + change('wp') + '</div>';
    html += '<div class="gs-pitching-line"><b>L:</b> ' + nameOf(decisions.loseTeam, decisions.lp) + change('lp') + '</div>';
    html += '<div class="gs-pitching-line"><b>SV:</b> ' + nameOf(decisions.winTeam, decisions.sv) + change('sv') + '</div>';
    if (decisions.judgment) {
      html += '<div class="gs-hl-detail" style="color:var(--red);margin-top:4px">' + escapeHtml(decisions.judgment) + '</div>';
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
  html += '<table class="gs-table"><thead><tr><th>Pitcher</th><th>IP</th><th>PC</th><th>H</th><th>R</th><th>ER</th><th>K</th><th>BB</th></tr></thead><tbody>';
  html += pitcherBox('visiting');
  html += '</tbody></table></div>';

  // Pitching — Home pitchers
  html += '<div class="gs-section"><h3>' + escapeHtml(hTeam) + ' — Pitching</h3>';
  html += '<table class="gs-table"><thead><tr><th>Pitcher</th><th>IP</th><th>PC</th><th>H</th><th>R</th><th>ER</th><th>K</th><th>BB</th></tr></thead><tbody>';
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
  const vis = gameState.visibleInnings || 9;
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
    if (hv !== '') {
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

/* Auto-save on any input/select change (autoSave is itself debounced) */
document.addEventListener('input', function(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') autoSave();
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