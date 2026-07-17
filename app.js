
// Storage shim: use memory storage if localStorage is blocked (file:// URLs)
const _storage = {};
const safeStorage = {
  getItem: function(k) { try { return localStorage.getItem(k); } catch(e) { return _storage[k] || null; } },
  setItem: function(k,v) { try { localStorage.setItem(k,v); } catch(e) { _storage[k] = v; } },
  removeItem: function(k) { try { localStorage.removeItem(k); } catch(e) { delete _storage[k]; } }
};
// Field image embedded directly in SVG
const POSITIONS = 9;
const ROWS_PER_POS = 2;
const INNINGS = 15;
const PITCHER_ROWS = 8;
const STANDINGS_ROWS = 5;

let selectedCell = null;
let gameState = createEmptyState();

function createEmptyState() {
  const makeAtBat = () => ({ bases:[false,false,false,false], advReason:['','','',''], outOnBase:null, play:'', out:0, outsRecorded:0, pitches:[], hitLoc:null, rbi:0, pitcher:0, reachedOnError:false, pitcherChangeNum:'', subChange:false });
  const makeInning = () => ({ outs:0, bases:[null,null,null], currentPitcher:0, lob:0 });
  return {
    info: { date:'', startTime:'', timeOfGame:'', visitingTeam:'', homeTeam:'', weather:'', attendance:'' },
    umpires: { hp:'', '1b':'', '2b':'', '3b':'' },
    notes: '',
    currentGameId: null,
    timerStart: null,
    timerElapsed: 0,
    timerRunning: false,
    log: [],
    linescore: {
      visiting: { innings: Array(14).fill(''), r:'', h:'', e:'' },
      home: { innings: Array(14).fill(''), r:'', h:'', e:'' }
    },
    visibleInnings: 9,
    standings: Array(STANDINGS_ROWS).fill(null).map(() => ({ team:'', rec:'', gb:'' })),
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
      visiting: [0,1,2,3,4,5,6,7,8,9,10,11,12,13],
      home: [0,1,2,3,4,5,6,7,8,9,10,11,12,13]
    },
    nextLeadoff: {},
    overflowAtBats: [],
    defChanges: []
  };
}

function getOverflowForPlayer(team, pIdx) {
  if (!gameState.overflowAtBats) return [];
  return gameState.overflowAtBats.filter(o => o.team === team && o.pIdx === pIdx).map(o => o.atBat);
}

function getOverflowForInning(team, colIdx) {
  if (!gameState.overflowAtBats) return [];
  return gameState.overflowAtBats.filter(o => o.team === team && o.colIdx === colIdx);
}

/* Column-to-inning mapping helpers */
function getRealInning(team, colIdx) {
  if (!gameState.columnMap) gameState.columnMap = { visiting:[0,1,2,3,4,5,6,7,8,9,10,11,12,13], home:[0,1,2,3,4,5,6,7,8,9,10,11,12,13] };
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
  const teams = ['visiting','home'];
  teams.forEach(t => {
    const row = document.getElementById(`ls-${t}`);
    const existing = row.querySelector('.team-col');
    let html = '';
    for (let i = 0; i < 14; i++) {
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

// When the batting order wraps (overflow column), a runner may have batted in
// an earlier visual column for the same real inning. Return that original column
// so advancement renders on the correct cell.
function getRunnerCol(team, pIdx, innIdx) {
  const realInn = getRealInning(team, innIdx);
  const colMap = gameState.columnMap[team];
  const player = gameState.teams[team].players[pIdx];
  if (!player) return innIdx;
  for (let c = 0; c < INNINGS; c++) {
    if (colMap[c] === realInn && player.atBats[c] && player.atBats[c].play) return c;
  }
  return innIdx;
}

function advanceRunners(team, innIdx, advanceBy, reason) {
  const inn = getInnState(team, innIdx);
  const players = gameState.teams[team].players;
  const rsn = reason || '';
  if (inn.bases[2] !== null) {
    const r = inn.bases[2];
    const rc = getRunnerCol(team, r, innIdx);
    const rab = players[r].atBats[rc];
    rab.bases[3] = true;
    setAdvReason(rab, 3, rsn);
    renderDiamond(team, r, rc);
    inn.bases[2] = null;
  }
  if (inn.bases[1] !== null) {
    const r = inn.bases[1];
    const rc = getRunnerCol(team, r, innIdx);
    const rab = players[r].atBats[rc];
    if (advanceBy >= 2) {
      rab.bases[2] = true; rab.bases[3] = true;
      setAdvReason(rab, 2, rsn); setAdvReason(rab, 3, rsn);
      inn.bases[1] = null;
    } else {
      rab.bases[2] = true;
      setAdvReason(rab, 2, rsn);
      inn.bases[2] = r; inn.bases[1] = null;
    }
    renderDiamond(team, r, rc);
  }
  if (inn.bases[0] !== null) {
    const r = inn.bases[0];
    const rc = getRunnerCol(team, r, innIdx);
    const rab = players[r].atBats[rc];
    if (advanceBy >= 2) {
      rab.bases[1] = true; rab.bases[2] = true; rab.bases[3] = true;
      setAdvReason(rab, 1, rsn); setAdvReason(rab, 2, rsn); setAdvReason(rab, 3, rsn);
      inn.bases[0] = null;
    } else {
      rab.bases[1] = true;
      setAdvReason(rab, 1, rsn);
      inn.bases[1] = r; inn.bases[0] = null;
    }
    renderDiamond(team, r, rc);
  }
}

function advanceForcedRunners(team, innIdx, reason) {
  const inn = getInnState(team, innIdx);
  const players = gameState.teams[team].players;
  const rsn = reason || 'BB';
  const on1 = inn.bases[0] !== null, on2 = inn.bases[1] !== null, on3 = inn.bases[2] !== null;
  if (on1 && on2 && on3) {
    const r3 = inn.bases[2]; const rc3 = getRunnerCol(team, r3, innIdx); const ab3 = players[r3].atBats[rc3]; ab3.bases[3] = true; setAdvReason(ab3, 3, rsn); renderDiamond(team, r3, rc3);
    const r2 = inn.bases[1]; inn.bases[2] = r2; const rc2 = getRunnerCol(team, r2, innIdx); const ab2 = players[r2].atBats[rc2]; ab2.bases[2] = true; setAdvReason(ab2, 2, rsn); renderDiamond(team, r2, rc2);
    const r1 = inn.bases[0]; inn.bases[1] = r1; const rc1 = getRunnerCol(team, r1, innIdx); const ab1 = players[r1].atBats[rc1]; ab1.bases[1] = true; setAdvReason(ab1, 1, rsn); renderDiamond(team, r1, rc1);
    inn.bases[0] = null;
  } else if (on1 && on2) {
    const r2 = inn.bases[1]; inn.bases[2] = r2; const rc2 = getRunnerCol(team, r2, innIdx); const ab2 = players[r2].atBats[rc2]; ab2.bases[2] = true; setAdvReason(ab2, 2, rsn); renderDiamond(team, r2, rc2);
    const r1 = inn.bases[0]; inn.bases[1] = r1; const rc1 = getRunnerCol(team, r1, innIdx); const ab1 = players[r1].atBats[rc1]; ab1.bases[1] = true; setAdvReason(ab1, 1, rsn); renderDiamond(team, r1, rc1);
    inn.bases[0] = null;
  } else if (on1) {
    const r1 = inn.bases[0]; inn.bases[1] = r1; const rc1 = getRunnerCol(team, r1, innIdx); const ab1 = players[r1].atBats[rc1]; ab1.bases[1] = true; setAdvReason(ab1, 1, rsn); renderDiamond(team, r1, rc1);
    inn.bases[0] = null;
  }
}

function isOutPlay(play) {
  return ['K','ꓘ','GO','SAC','DP','FC','SF','SH','IF','TP'].includes(play) ||
    /^F\d/.test(play) || /^P\d/.test(play) || /^\d+-\d/.test(play) || /^L\d/.test(play) ||
    /^\d+$/.test(play) ||
    /^DP /.test(play) || /^FC /.test(play) || /^TP /.test(play);
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

function countRunnersScored(team, innIdx, prevRunners) {
  const players = gameState.teams[team].players;
  let scored = 0;
  for (let i = 0; i < players.length; i++) {
    const ab = players[i].atBats[innIdx];
    const curScored = ab.bases[0] && ab.bases[1] && ab.bases[2] && ab.bases[3] && ab.outOnBase == null;
    const prevScored = prevRunners[i] && prevRunners[i].bases[0] && prevRunners[i].bases[1] && prevRunners[i].bases[2] && prevRunners[i].bases[3] && prevRunners[i].outOnBase == null;
    if (curScored && !prevScored) scored++;
  }
  return scored;
}

function applyPlay(play) {
  if (!selectedCell) return;
  const team = selectedCell.dataset.team;
  const pIdx = parseInt(selectedCell.dataset.p);
  const innIdx = parseInt(selectedCell.dataset.inn);
  const ab = gameState.teams[team].players[pIdx].atBats[innIdx];
  const inn = getInnState(team, innIdx);
  if (inn.outs >= 3 || ab.play) return;

  // Save undo snapshot
  const prevTab = document.querySelector('.tab-btn.active')?.dataset.tab;
  const prevAb = JSON.parse(JSON.stringify(ab));
  const prevInn = JSON.parse(JSON.stringify(inn));
  const prevRunners = {};
  gameState.teams[team].players.forEach((pl, i) => { prevRunners[i] = JSON.parse(JSON.stringify(pl.atBats[innIdx])); });
  const snapshot = { team, pIdx, innIdx, prevAb, prevInn, prevRunners, prevTab };

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
      advanceForcedRunners(team, innIdx, play);
      ab.bases[0] = true; inn.bases[0] = pIdx;
      ab.rbi = countRunnersScored(team, innIdx, prevRunners);
      finishPlay(team, pIdx, innIdx, snapshot);
      return;
    }

    // K+WP: batter reaches 1st, show runner popup for wild pitch advancement
    if (isKWP) {
      ab.bases[0] = true; inn.bases[0] = pIdx;
      const batterLbl = getBatterLabel(team, pIdx, innIdx);
      showRunnerPopup(team, innIdx, 1, function(choices) {
        applyChosenAdvancements(team, innIdx, choices, batterLbl);
        ab.rbi = countRunnersScored(team, innIdx, prevRunners);
        finishPlay(team, pIdx, innIdx, snapshot);
      });
      return;
    }

    // Default advancement: hits advance by hit type, sac advance 1, outs = 0 (hold)
    const defaultAdv = play === '3B' ? 3 : play === '2B' ? 2 : (isHitOrError || isSac) ? 1 : 0;
    const batterLbl = getBatterLabel(team, pIdx, innIdx);
    showRunnerPopup(team, innIdx, defaultAdv, function(choices) {
      applyChosenAdvancements(team, innIdx, choices, batterLbl);
      // Place batter based on play type
      if (isHitOrError) {
        if (choices.batterDest !== undefined && choices.batterDest > 0) {
          for (let s = 0; s <= choices.batterDest; s++) ab.bases[s] = true;
          if (choices.batterDest < 3) inn.bases[choices.batterDest] = pIdx;
        } else {
          placeBatter(ab, inn, play, pIdx);
        }
      } else if (isSac) {
        inn.outs++; ab.out = inn.outs; ab.outsRecorded = 1;
      } else if (play === 'IF') {
        inn.outs++; ab.out = inn.outs; ab.outsRecorded = 1;
      } else if (isOutPlay(play)) {
        inn.outs++; ab.out = inn.outs; ab.outsRecorded = 1;
      }
      // RBI
      if (!isErrorPlay(play)) {
        ab.rbi = countRunnersScored(team, innIdx, prevRunners);
      }
      finishPlay(team, pIdx, innIdx, snapshot);
    });
    return;
  }

  // No runners or plays with own popup — handle directly
  const isHitOrError = ['1B','2B','3B'].includes(play) || isErrorPlay(play);
  if (isHitOrError) {
    placeBatter(ab, inn, play, pIdx);
  } else if (isHR) {
    const runnersOn = [inn.bases[0], inn.bases[1], inn.bases[2]].filter(b => b !== null).length;
    const lbl = getBatterLabel(team, pIdx, innIdx);
    advanceRunners(team, innIdx, 4, lbl);
    ab.bases = [true, true, true, true];
    ab.rbi = runnersOn + 1;
  } else if (play === 'BB' || play === 'HBP' || play === 'IBB' || play === 'CI') {
    ab.bases[0] = true; inn.bases[0] = pIdx;
  } else if (play === 'SF') {
    inn.outs++; ab.out = inn.outs; ab.outsRecorded = 1;
  } else if (play === 'SH' || play === 'SAC') {
    inn.outs++; ab.out = inn.outs; ab.outsRecorded = 1;
  } else if (play === 'TP' || /^TP /.test(play)) {
    // Triple play requires at least 2 runners on base
    const rCount = [inn.bases[0], inn.bases[1], inn.bases[2]].filter(b => b !== null).length;
    if (rCount < 2) { ab.play = ''; return; }
    showRunnerOutcomePopup(team, innIdx, play, true, function(outcomes) {
      applyRunnerOutcomes(team, pIdx, innIdx, ab, inn, play, outcomes);
      ab.rbi = countRunnersScored(team, innIdx, prevRunners);
      finishPlay(team, pIdx, innIdx, snapshot);
    });
    return;
  } else if (play === 'DP' || /^DP /.test(play) || play === 'FC' || /^FC /.test(play)) {
    const isDP = play === 'DP' || /^DP /.test(play);
    if (hasRunnersOnBase(team, innIdx)) {
      showRunnerOutcomePopup(team, innIdx, play, isDP, function(outcomes) {
        applyRunnerOutcomes(team, pIdx, innIdx, ab, inn, play, outcomes);
        ab.rbi = countRunnersScored(team, innIdx, prevRunners);
        finishPlay(team, pIdx, innIdx, snapshot);
      });
      return;
    }
    if (isDP) { inn.outs = Math.min(inn.outs + 2, 3); ab.out = inn.outs - 1 || 1; ab.outsRecorded = 2; }
    else { inn.outs++; ab.out = inn.outs; ab.outsRecorded = 1; }
  } else if (play === 'K+WP') {
    ab.bases[0] = true; inn.bases[0] = pIdx; ab.outsRecorded = 0;
  } else if (play === 'IF') {
    // Infield fly: automatic out
    inn.outs++; ab.out = inn.outs; ab.outsRecorded = 1;
  } else if (isOutPlay(play)) {
    inn.outs++; ab.out = inn.outs; ab.outsRecorded = 1;
  }
  finishPlay(team, pIdx, innIdx, snapshot);
}

function placeBatter(ab, inn, play, pIdx) {
  if (play === '1B' || play === 'E' || isErrorPlay(play)) { ab.bases[0] = true; inn.bases[0] = pIdx; if (isErrorPlay(play)) ab.reachedOnError = true; }
  else if (play === '2B') { ab.bases[0] = true; ab.bases[1] = true; inn.bases[1] = pIdx; }
  else if (play === '3B') { ab.bases[0] = true; ab.bases[1] = true; ab.bases[2] = true; inn.bases[2] = pIdx; }
}

function applyChosenAdvancements(team, innIdx, choices, reason) {
  const inn = getInnState(team, innIdx);
  const players = gameState.teams[team].players;
  const rsn = reason || '';
  [2, 1, 0].forEach(fromBase => {
    if (inn.bases[fromBase] === null) return;
    const dest = choices[fromBase];
    if (dest === undefined) return;
    if (dest === fromBase) return;
    const r = inn.bases[fromBase];
    const rc = getRunnerCol(team, r, innIdx);
    const rab = players[r].atBats[rc];
    if (dest < 0) {
      const outAt = Math.abs(dest);
      for (let step = fromBase + 1; step < outAt; step++) {
        rab.bases[step] = true;
        setAdvReason(rab, step, rsn);
      }
      setAdvReason(rab, outAt, rsn);
      if (inn.outs < 3) {
        inn.outs++;
        rab.out = inn.outs;
        rab.outOnBase = outAt;
      }
      inn.bases[fromBase] = null;
      renderDiamond(team, r, rc);
      renderOut(team, r, rc);
    } else {
      for (let step = fromBase + 1; step <= dest; step++) {
        rab.bases[step] = true;
        setAdvReason(rab, step, rsn);
      }
      inn.bases[fromBase] = null;
      if (dest < 3) inn.bases[dest] = r;
      renderDiamond(team, r, rc);
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
    const r = inn.bases[b];
    const name = getActivePlayerName(team, r, innIdx);
    runners.push({ base: b, pIdx: r, name, fromLabel: baseNames[b] });
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
    html += `<div style="font-size:11px;font-weight:600;margin-bottom:4px">${r.name} <span style="color:var(--text-light)">(on ${r.fromLabel})</span></div>`;
    html += `<div style="display:flex;gap:4px;flex-wrap:wrap">`;
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

  // Button handlers
  const maxOuts = /^TP/.test(play) ? 3 : /^DP/.test(play) ? 2 : 3;
  popup.querySelectorAll('.oc-btn').forEach(btn => {
    btn.onclick = function() {
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
    };
  });

  document.getElementById('oc-confirm').onclick = function() {
    popup.style.display = 'none';
    callback(outcomes);
  };
}

function applyRunnerOutcomes(team, pIdx, innIdx, ab, inn, play, outcomes) {
  const players = gameState.teams[team].players;
  const playLabel = play.replace(/^(DP|FC|TP)\s*/, '') || play;

  // Process runners from 3rd → 1st, tracking which were thrown out on THIS play
  const runnersOutThisPlay = [];
  [2, 1, 0].forEach(fromBase => {
    if (!outcomes[fromBase]) return;
    const oc = outcomes[fromBase];
    const r = inn.bases[fromBase];
    if (r === null) return;
    const rc = getRunnerCol(team, r, innIdx);
    const rab = players[r].atBats[rc];

    if (oc.action === 'out' && inn.outs < 3) {
      inn.outs++;
      rab.out = inn.outs;
      rab.outOnBase = oc.dest;
      setAdvReason(rab, oc.dest, play.substring(0, 2).trim());
      renderDiamond(team, r, rc);
      renderOut(team, r, rc);
      inn.bases[fromBase] = null;
      runnersOutThisPlay.push(r);
    } else if (oc.action === 'safe') {
      for (let step = fromBase + 1; step <= oc.dest; step++) {
        rab.bases[step] = true;
        setAdvReason(rab, step, playLabel);
      }
      inn.bases[fromBase] = null;
      if (oc.dest < 3) inn.bases[oc.dest] = r;
      renderDiamond(team, r, rc);
    }
  });

  // Collect out numbers only from runners thrown out on THIS play
  let totalOuts = 0;
  const dpOutNums = [];
  for (const r of runnersOutThisPlay) {
    const rab = players[r].atBats[getRunnerCol(team, r, innIdx)];
    if (rab.out > 0) {
      dpOutNums.push(rab.out);
      totalOuts++;
    }
  }

  // Batter outcome
  if (outcomes.batter.action === 'out' && inn.outs < 3) {
    inn.outs++;
    ab.out = inn.outs;
    dpOutNums.push(ab.out);
    totalOuts++;
  } else if (outcomes.batter.action === 'out') {
    // Already at 3 outs
  } else {
    const batterDest = outcomes.batter.dest !== undefined ? outcomes.batter.dest : 0;
    for (let s = 0; s <= batterDest; s++) ab.bases[s] = true;
    if (batterDest < 3) inn.bases[batterDest] = pIdx;
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

function finishPlay(team, pIdx, innIdx, snapshot) {
  const ab = gameState.teams[team].players[pIdx].atBats[innIdx];
  const inn = getInnState(team, innIdx);
  renderDiamond(team, pIdx, innIdx);
  renderOut(team, pIdx, innIdx);
  renderPlayText(team, pIdx, innIdx);
  renderRBI(team, pIdx, innIdx);
  renderPitchCount(team, pIdx, innIdx);
  updateInningRuns(team, innIdx);
  updatePlayerStats(team);
  updatePitcherStats(team);
  redoHistory.length = 0;
  playHistory.push(snapshot);

  // Play-by-play log
  addPlayLogEntry(team, pIdx, innIdx);

  // Show spray chart for hits
  if (isHitPlay(ab.play) || isErrorPlay(ab.play)) {
    showSprayChart(team, pIdx, innIdx);
  }

  // LOB tracking at end of half-inning
  if (inn.outs >= 3) {
    let lob = 0;
    if (inn.bases[0] !== null) lob++;
    if (inn.bases[1] !== null) lob++;
    if (inn.bases[2] !== null) lob++;
    inn.lob = lob;
    updateLinescoreTotals(team);
    // Check for game over
    const realInn = getRealInning(team, innIdx);
    const vR = parseInt(document.querySelector('input[data-ls="visiting"][data-stat="r"]')?.value) || 0;
    const hR = parseInt(document.querySelector('input[data-ls="home"][data-stat="r"]')?.value) || 0;
    const isGameOver = (team === 'home' && realInn >= 8 && inn.outs >= 3 && vR !== hR) ||
                       (team === 'visiting' && realInn >= 8 && inn.outs >= 3 && hR > vR);
    if (isGameOver && !gameOverShown) {
      gameOverShown = true;
      pendingTransitionTimer = setTimeout(() => { pendingTransitionTimer = null; showGameSummary(); }, 1000);
    } else {
      pendingTransitionTimer = setTimeout(() => { pendingTransitionTimer = null; switchToNextHalf(team, innIdx); }, 600);
    }
  } else {
    selectNextBatter(team, innIdx);
    // Walk-off check: home team takes lead mid-inning in bottom 9+
    if (team === 'home') {
      const realInn = getRealInning(team, innIdx);
      const vR = parseInt(document.querySelector('input[data-ls="visiting"][data-stat="r"]')?.value) || 0;
      const hR = parseInt(document.querySelector('input[data-ls="home"][data-stat="r"]')?.value) || 0;
      if (realInn >= 8 && hR > vR && !gameOverShown) {
        gameOverShown = true;
        pendingTransitionTimer = setTimeout(() => { pendingTransitionTimer = null; showGameSummary(); }, 1000);
      }
    }
  }
  updateSituation();
  autoSave();
}

/* Runner advancement popup */
function showRunnerPopup(team, innIdx, defaultAdv, callback) {
  const inn = getInnState(team, innIdx);
  const baseNames = ['1st','2nd','3rd','Home'];
  const runners = [];

  for (let b = 2; b >= 0; b--) {
    if (inn.bases[b] === null) continue;
    const r = inn.bases[b];
    const name = getActivePlayerName(team, r, innIdx);
    const minDest = b; // always allow hold
    runners.push({ base: b, pIdx: r, name, fromLabel: baseNames[b], minDest, defaultDest: undefined });
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
    html += `<span style="font-size:11px;font-weight:600;min-width:100px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${r.name}</span>`;
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
    const batterName = selectedCell ? getActivePlayerName(selectedCell.dataset.team, parseInt(selectedCell.dataset.p), parseInt(selectedCell.dataset.inn)) : 'Batter';
    html += `<div style="margin-bottom:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;border-top:1px solid #ddd;padding-top:8px">`;
    html += `<span style="font-size:11px;font-weight:600;min-width:100px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${batterName}</span>`;
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

  // Button click handlers
  popup.querySelectorAll('.rp-btn').forEach(btn => {
    btn.onclick = function() {
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
    };
  });

  document.getElementById('rp-confirm').onclick = function() {
    // Check all runners have a selection
    const allSelected = runners.every(r => choices[r.base] !== undefined);
    if (!allSelected) {
      // Flash unselected rows
      runners.forEach(r => {
        if (choices[r.base] === undefined) {
          const row = popup.querySelector(`.rp-btn[data-base="${r.base}"]`)?.closest('div')?.parentElement;
          if (row) { row.style.outline = '2px solid var(--accent)'; setTimeout(() => row.style.outline = '', 800); }
        }
      });
      return;
    }
    popup.style.display = 'none';
    callback(choices);
  };
}

function updateInningRuns(team, innIdx) {
  const realInning = getRealInning(team, innIdx);
  if (realInning >= 14) return;
  const players = gameState.teams[team].players;
  // Count runs across ALL columns that belong to this real inning
  const cols = getColumnsForInning(team, realInning);
  let runs = 0;
  for (const col of cols) {
    for (const player of players) {
      const ab = player.atBats[col];
      if (ab.bases[0] && ab.bases[1] && ab.bases[2] && ab.bases[3] && ab.outOnBase == null) runs++;
    }
    for (const oa of getOverflowForInning(team, col)) {
      const ab = oa.atBat;
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
  for (const oa of (gameState.overflowAtBats || []).filter(o => o.team === team)) {
    if (isHitPlay(oa.atBat.play)) totalHits++;
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
  if (!gameState.columnMap) gameState.columnMap = { visiting:[0,1,2,3,4,5,6,7,8,9,10,11,12,13], home:[0,1,2,3,4,5,6,7,8,9,10,11,12,13] };
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

function markNextInningLeadoff(team, innIdx) {
  const players = gameState.teams[team].players;

  // Find the batter who made the 3rd out — search current column AND overflow columns
  const realInning = getRealInning(team, innIdx);
  const cols = getColumnsForInning(team, realInning);
  let thirdOutPos = -1;
  let thirdOutCol = innIdx;
  for (const col of cols) {
    for (let pos = 0; pos < POSITIONS; pos++) {
      const p = pos * ROWS_PER_POS;
      if (players[p].atBats[col].out === 3) { thirdOutPos = pos; thirdOutCol = col; break; }
    }
    if (thirdOutPos !== -1) break;
  }
  if (thirdOutPos === -1) return;

  const nextPos = (thirdOutPos + 1) % POSITIONS;
  const nextP = nextPos * ROWS_PER_POS;
  const nextCol = getNextFreeColumn(team);

  if (!gameState.nextLeadoff) gameState.nextLeadoff = {};
  if (!gameState.nextLeadoff[team]) gameState.nextLeadoff[team] = {};
  // Don't overwrite if already set (e.g. by CS/PO ending the inning)
  if (gameState.nextLeadoff[team][nextCol] !== undefined) return;
  gameState.nextLeadoff[team][nextCol] = nextP;
}

function selectNextBatterForInning(team, colIdx) {
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
    if (autoSnapIdx >= 0 && playHistory[autoSnapIdx].prevRunners && playHistory[autoSnapIdx].prevInn) {
      const snap = playHistory[autoSnapIdx];
      const players = gameState.teams[team].players;
      Object.keys(snap.prevRunners).forEach(p => {
        const pi = parseInt(p);
        const restored = JSON.parse(JSON.stringify(snap.prevRunners[pi]));
        const target = players[pi].atBats[innIdx];
        Object.keys(target).forEach(k => { if (!(k in restored)) delete target[k]; });
        Object.assign(target, restored);
        renderDiamond(team, pi, innIdx);
        renderOut(team, pi, innIdx);
        renderPlayText(team, pi, innIdx);
      });
      const inn = getInnState(team, innIdx);
      Object.assign(inn, JSON.parse(JSON.stringify(snap.prevInn)));
      playHistory.splice(autoSnapIdx, 1);
    } else {
      const inn = getInnState(team, innIdx);
      if (ab.out > 0) inn.outs = Math.max(0, inn.outs - 1);
      for (let b = 0; b < 3; b++) { if (inn.bases[b] === pIdx) inn.bases[b] = null; }
      ab.play = '';
      ab.bases = [false, false, false, false];
      ab.out = 0; ab.outsRecorded = 0;
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
  if (count.balls >= 4) applyPlay('BB');
  else if (count.strikes >= 3) showStrikeoutPopup();
}

function showStrikeoutPopup() {
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
    document.getElementById('k-swinging').onclick = function() { popup.style.display = 'none'; applyPlay('K'); };
    document.getElementById('k-looking').onclick = function() { popup.style.display = 'none'; applyPlay('ꓘ'); };
  }
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

  // LOB
  const lobEl = document.getElementById('sit-lob');
  if (lobEl) {
    let totalLOB = 0;
    ['visiting', 'home'].forEach(t => {
      for (let i = 0; i < INNINGS; i++) {
        const innState = gameState.innings[t] && gameState.innings[t][i];
        if (innState && innState.lob) totalLOB += innState.lob;
      }
    });
    lobEl.textContent = totalLOB > 0 ? `LOB: ${totalLOB}` : '';
  }
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
  if (inn.bases[1] !== null) {
    options.push({from: 1, label: 'SB3 (2nd→3rd)'});
    options.push({from: 1, label: 'SB3+E (2nd→Home)', extra: 'error'});
  }
  if (inn.bases[0] !== null) {
    options.push({from: 0, label: 'SB2 (1st→2nd)'});
    options.push({from: 0, label: 'SB2+E (1st→3rd)', extra: 'error'});
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
  const players = gameState.teams[team].players;
  if (inn.bases[fromBase] === null) return;
  const pIdx = selectedCell ? parseInt(selectedCell.dataset.p) : 0;
  pushUndo(team, pIdx, innIdx);
  const r = inn.bases[fromBase];
  const rc = getRunnerCol(team, r, innIdx);
  const rab = players[r].atBats[rc];
  const dest = withError ? Math.min(fromBase + 2, 3) : fromBase + 1;
  for (let step = fromBase + 1; step <= dest; step++) {
    rab.bases[step] = true;
    setAdvReason(rab, step, step === fromBase + 1 ? 'SB' : 'E');
  }
  inn.bases[fromBase] = null;
  if (dest < 3) inn.bases[dest] = r;
  renderDiamond(team, r, rc);
  updateInningRuns(team, innIdx);
  updatePlayerStats(team);
  updateSituation();
  autoSave();
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
  const players = gameState.teams[team].players;
  if (inn.bases[fromBase] === null) return;
  const pIdx = selectedCell ? parseInt(selectedCell.dataset.p) : 0;
  pushUndo(team, pIdx, innIdx);
  const r = inn.bases[fromBase];
  const rc = getRunnerCol(team, r, innIdx);
  const rab = players[r].atBats[rc];
  inn.outs++;
  rab.out = inn.outs;
  rab.outOnBase = fromBase + 1;
  rab.pitcher = getEffectivePitcher(team, innIdx);
  setAdvReason(rab, fromBase + 1, 'CS');
  renderDiamond(team, r, rc);
  renderOut(team, r, rc);
  inn.bases[fromBase] = null;
  if (inn.outs >= 3) {
    // CS made 3rd out — current batter leads off next inning
    const nextCol = getNextFreeColumn(team);
    if (!gameState.nextLeadoff) gameState.nextLeadoff = {};
    if (!gameState.nextLeadoff[team]) gameState.nextLeadoff[team] = {};
    gameState.nextLeadoff[team][nextCol] = pIdx;
    pendingTransitionTimer = setTimeout(() => { pendingTransitionTimer = null; switchToNextHalf(team, innIdx); }, 600);
  }
  updatePlayerStats(team);
  updateSituation();
  autoSave();
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
      options.push({from: b, label: 'PO ' + baseNames[b] + ' — Error (→' + destNames[b] + ')', extra: 'error'});
    }
  }
  if (options.length === 0) return;
  showBasePickerPopup('Pickoff', options, function(from, extra) { applyPickoff(team, innIdx, from, extra === 'error'); });
}

function applyPickoff(team, innIdx, atBase, withError) {
  const inn = getInnState(team, innIdx);
  const players = gameState.teams[team].players;
  if (inn.bases[atBase] === null) return;
  const pIdx = selectedCell ? parseInt(selectedCell.dataset.p) : 0;
  pushUndo(team, pIdx, innIdx);
  const r = inn.bases[atBase];
  const rc = getRunnerCol(team, r, innIdx);
  const rab = players[r].atBats[rc];
  if (withError) {
    const dest = atBase + 1;
    rab.bases[dest] = true;
    setAdvReason(rab, dest, 'E');
    inn.bases[atBase] = null;
    if (dest < 3) inn.bases[dest] = r;
    renderDiamond(team, r, rc);
    updateInningRuns(team, innIdx);
  } else {
    inn.outs++;
    rab.out = inn.outs;
    rab.outOnBase = atBase;
    rab.pitcher = getEffectivePitcher(team, innIdx);
    setAdvReason(rab, atBase, 'PO');
    renderDiamond(team, r, rc);
    renderOut(team, r, rc);
    inn.bases[atBase] = null;
    if (inn.outs >= 3) {
      const nextCol = getNextFreeColumn(team);
      if (!gameState.nextLeadoff) gameState.nextLeadoff = {};
      if (!gameState.nextLeadoff[team]) gameState.nextLeadoff[team] = {};
      gameState.nextLeadoff[team][nextCol] = pIdx;
      pendingTransitionTimer = setTimeout(() => { pendingTransitionTimer = null; switchToNextHalf(team, innIdx); }, 600);
    }
  }
  updatePlayerStats(team);
  updateSituation();
  autoSave();
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
    // PB: runs scored are unearned. Mark runners on 3rd before advancing.
    if (type === 'PB' && inn.bases[2] !== null) {
      const r = inn.bases[2];
      const rc = getRunnerCol(team, r, innIdx);
      gameState.teams[team].players[r].atBats[rc].reachedOnError = true;
    }
    advanceRunners(team, innIdx, 1, type);
    updateInningRuns(team, innIdx);
  } else if (type === 'SB') {
    const players = gameState.teams[team].players;
    if (inn.bases[1] !== null) {
      const r = inn.bases[1]; const rc = getRunnerCol(team, r, innIdx); const rab = players[r].atBats[rc];
      rab.bases[2] = true; setAdvReason(rab, 2, 'SB');
      if (inn.bases[2] === null) { inn.bases[2] = r; inn.bases[1] = null; }
      else { rab.bases[3] = true; setAdvReason(rab, 3, 'SB'); inn.bases[1] = null; }
      renderDiamond(team, r, rc);
    }
    if (inn.bases[0] !== null && inn.bases[1] === null) {
      const r = inn.bases[0]; const rc = getRunnerCol(team, r, innIdx); const rab = players[r].atBats[rc];
      rab.bases[1] = true; setAdvReason(rab, 1, 'SB');
      inn.bases[1] = r; inn.bases[0] = null;
      renderDiamond(team, r, rc);
    }
    updateInningRuns(team, innIdx);
  } else if (type === 'CS') {
    const players = gameState.teams[team].players;
    let removed = false;
    for (let b = 2; b >= 0; b--) {
      if (inn.bases[b] !== null && !removed) {
        const r = inn.bases[b];
        const rc = getRunnerCol(team, r, innIdx);
        const rab = players[r].atBats[rc];
        inn.outs++;
        rab.out = inn.outs;
        rab.outOnBase = b + 1;
        setAdvReason(rab, b + 1, 'CS');
        renderDiamond(team, r, rc);
        renderOut(team, r, rc);
        inn.bases[b] = null;
        removed = true;
      }
    }
    if (inn.outs >= 3) { setTimeout(() => switchToNextHalf(team, innIdx), 600); }
  } else if (type === 'BK') {
    // Balk: all runners advance 1 base, like WP
    advanceRunners(team, innIdx, 1, 'BK');
    updateInningRuns(team, innIdx);
  }
  updatePlayerStats(team);
  updateSituation();
  autoSave();
}

/* Undo / Redo */
let playHistory = [];
let redoHistory = [];
let gameOverShown = false;
let pendingTransitionTimer = null;

function pushUndo(team, pIdx, innIdx) {
  redoHistory.length = 0;
  const ab = gameState.teams[team].players[pIdx].atBats[innIdx];
  const inn = getInnState(team, innIdx);
  const prevTab = document.querySelector('.tab-btn.active')?.dataset.tab;
  const prevRunners = {};
  gameState.teams[team].players.forEach((pl, i) => { prevRunners[i] = JSON.parse(JSON.stringify(pl.atBats[innIdx])); });
  // Full batter row across all innings — captures multi-column mutations (e.g. sub lines) that span past innIdx.
  const prevPlayerAbs = JSON.parse(JSON.stringify(gameState.teams[team].players[pIdx].atBats));
  playHistory.push({ team, pIdx, innIdx, prevAb: JSON.parse(JSON.stringify(ab)), prevInn: JSON.parse(JSON.stringify(inn)), prevRunners, prevPlayerAbs, prevTab });
}

function snapshotForRedo(team, pIdx, innIdx) {
  const ab = gameState.teams[team].players[pIdx].atBats[innIdx];
  const inn = getInnState(team, innIdx);
  const prevTab = document.querySelector('.tab-btn.active')?.dataset.tab;
  const prevRunners = {};
  gameState.teams[team].players.forEach((pl, i) => { prevRunners[i] = JSON.parse(JSON.stringify(pl.atBats[innIdx])); });
  const prevPlayerAbs = JSON.parse(JSON.stringify(gameState.teams[team].players[pIdx].atBats));
  return { team, pIdx, innIdx, prevAb: JSON.parse(JSON.stringify(ab)), prevInn: JSON.parse(JSON.stringify(inn)), prevRunners, prevPlayerAbs, prevTab };
}

// Restore a player's entire at-bat row (all innings) and re-render every cell.
// Needed for mutations that span multiple inning columns (e.g. substitution lines).
function restorePlayerRow(team, pIdx, prevAbs) {
  const abs = gameState.teams[team].players[pIdx].atBats;
  const n = Math.min(abs.length, prevAbs.length);
  for (let c = 0; c < n; c++) {
    const target = abs[c];
    const src = JSON.parse(JSON.stringify(prevAbs[c]));
    Object.keys(target).forEach(k => { if (!(k in src)) delete target[k]; });
    Object.assign(target, src);
    renderDiamond(team, pIdx, c);
    renderOut(team, pIdx, c);
    renderPlayText(team, pIdx, c);
    renderPitches(team, pIdx, c);
    renderPitchCount(team, pIdx, c);
    renderPitcherChange(team, pIdx, c);
  }
}

function restoreSnapshot(snap) {
  const { team, pIdx, innIdx, prevAb, prevInn, prevRunners } = snap;
  if (prevRunners) {
    Object.keys(prevRunners).forEach(p => {
      const pi = parseInt(p);
      const target = gameState.teams[team].players[pi].atBats[innIdx];
      const src = JSON.parse(JSON.stringify(prevRunners[pi]));
      Object.keys(target).forEach(k => { if (!(k in src)) delete target[k]; });
      Object.assign(target, src);
    });
  }
  // Restore the batter's full row so multi-column mutations (sub lines) revert.
  if (snap.prevPlayerAbs) restorePlayerRow(team, pIdx, snap.prevPlayerAbs);
  const inn = getInnState(team, innIdx);
  const prevInnCopy = JSON.parse(JSON.stringify(prevInn));
  Object.keys(inn).forEach(k => { if (!(k in prevInnCopy)) delete inn[k]; });
  Object.assign(inn, prevInnCopy);
  for (let p = 0; p < gameState.teams[team].players.length; p++) {
    renderDiamond(team, p, innIdx);
    renderOut(team, p, innIdx);
    renderPlayText(team, p, innIdx);
    renderPitches(team, p, innIdx);
    renderPitchCount(team, p, innIdx);
    renderPitcherChange(team, p, innIdx);
  }
  updateInningRuns(team, innIdx);
  updateSprayMini();
  const cell = document.querySelector(`.at-bat-cell[data-team="${team}"][data-p="${pIdx}"][data-inn="${innIdx}"]`);
  if (cell) selectCell(cell);
  if (snap.prevTab) switchTab(snap.prevTab);
  updatePlayerStats(team);
  updatePitcherStats(team);
  updateSituation();
  rebuildPlayLog();
  autoSave();
}

function undoLastPlay() {
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
    const custom = document.getElementById('ep-custom').value.trim();
    const newPlay = custom || chosen;
    if (!newPlay || newPlay === ab.play) { popup.style.display = 'none'; return; }
    popup.style.display = 'none';
    pushUndo(team, pIdx, innIdx);
    const oldPlay = ab.play;
    const wasOut = isOutPlay(oldPlay) || oldPlay === 'K' || oldPlay === 'ꓘ';
    const nowOut = isOutPlay(newPlay) || newPlay === 'K' || newPlay === 'ꓘ';
    const wasHit = isHitPlay(oldPlay);
    const nowHit = isHitPlay(newPlay);
    const wasWalk = ['BB','IBB','HBP','CI'].includes(oldPlay);
    const nowWalk = ['BB','IBB','HBP','CI'].includes(newPlay);
    const inn = getInnState(team, innIdx);
    // Adjust outs when changing between out and non-out
    if (wasOut && !nowOut) {
      const outsToRemove = ab.outsRecorded || 1;
      inn.outs = Math.max(0, inn.outs - outsToRemove);
      ab.out = 0; ab.outsRecorded = 0; ab.dpOuts = null;
    } else if (!wasOut && nowOut) {
      inn.outs++; ab.out = inn.outs; ab.outsRecorded = 1;
      // Remove batter from bases
      for (let b = 0; b < 3; b++) { if (inn.bases[b] === pIdx) inn.bases[b] = null; }
      ab.bases = [false, false, false, false];
    }
    // Adjust bases when changing between hit types
    if (nowOut) {
      for (let b = 0; b < 3; b++) { if (inn.bases[b] === pIdx) inn.bases[b] = null; }
      ab.bases = [false, false, false, false]; ab.outOnBase = null;
    } else if (nowHit || nowWalk) {
      // Clear old base position
      for (let b = 0; b < 3; b++) { if (inn.bases[b] === pIdx) inn.bases[b] = null; }
      ab.bases = [false, false, false, false];
      if (newPlay === '1B' || newPlay === 'E' || nowWalk) { ab.bases[0] = true; inn.bases[0] = pIdx; }
      else if (newPlay === '2B') { ab.bases[0] = true; ab.bases[1] = true; inn.bases[1] = pIdx; }
      else if (newPlay === '3B') { ab.bases[0] = true; ab.bases[1] = true; ab.bases[2] = true; inn.bases[2] = pIdx; }
      else if (newPlay === 'HR') { ab.bases = [true, true, true, true]; }
    }
    ab.play = newPlay;
    renderPlayText(team, pIdx, innIdx);
    renderOut(team, pIdx, innIdx);
    renderDiamond(team, pIdx, innIdx);
    updatePlayerStats(team);
    updatePitcherStats(team);
    updateInningRuns(team, innIdx);
    updateSituation();
    autoSave();
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
  const players = gameState.teams[team].players;
  const baseNames = ['1st','2nd','3rd','Home'];
  const runners = [];
  for (let b = 0; b < 3; b++) {
    if (inn.bases[b] !== null) {
      const r = inn.bases[b];
      const name = getActivePlayerName(team, r, innIdx);
      runners.push({ base: b, pIdx: r, name });
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
    html += '<div style="font-size:11px;font-weight:600;margin-bottom:4px">' + r.name + ' <span style="color:var(--text-light)">(on ' + baseNames[r.base] + ')</span></div>';
    html += '<div style="display:flex;gap:4px">';
    for (let d = 0; d <= 3; d++) {
      if (d === r.base) continue;
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
      pushUndo(team, pIdx, innIdx);
      const r = inn.bases[from];
      if (r === null) return;
      const rc = getRunnerCol(team, r, innIdx);
      const rab = players[r].atBats[rc];
      inn.bases[from] = null;
      if (to === 'off') {
        for (let b = 0; b < 4; b++) { rab.bases[b] = false; }
        rab.advReason = ['','','',''];
        rab.out = 0; rab.outsRecorded = 0; rab.outOnBase = null;
      } else {
        const toBase = parseInt(to);
        for (let step = from + 1; step <= toBase; step++) {
          rab.bases[step] = true;
          setAdvReason(rab, step, 'MV');
        }
        if (toBase < 3) inn.bases[toBase] = r;
      }
      renderDiamond(team, r, rc);
      renderOut(team, r, rc);
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
  // Use the undo snapshot to fully restore runners and inning state
  const lastUndo = playHistory[playHistory.length - 1];
  if (lastUndo && lastUndo.prevRunners && lastUndo.prevInn) {
    const players = gameState.teams[team].players;
    Object.keys(lastUndo.prevRunners).forEach(p => {
      const pi = parseInt(p);
      const restored = JSON.parse(JSON.stringify(lastUndo.prevRunners[pi]));
      const target = players[pi].atBats[innIdx];
      Object.keys(target).forEach(k => { if (!(k in restored)) delete target[k]; });
      Object.assign(target, restored);
      renderDiamond(team, pi, innIdx);
      renderOut(team, pi, innIdx);
      renderPlayText(team, pi, innIdx);
      renderRBI(team, pi, innIdx);
      renderPitchCount(team, pi, innIdx);
    });
    const inn = getInnState(team, innIdx);
    Object.assign(inn, JSON.parse(JSON.stringify(lastUndo.prevInn)));
  } else {
    const inn = getInnState(team, innIdx);
    const outsToRemove = ab.outsRecorded || (ab.out ? 1 : 0);
    inn.outs = Math.max(0, inn.outs - outsToRemove);
    for (let b = 0; b < 3; b++) { if (inn.bases[b] === pIdx) inn.bases[b] = null; }
    ab.play = '';
    ab.bases = [false, false, false, false];
    ab.out = 0; ab.outsRecorded = 0; ab.rbi = 0; ab.hitLoc = null;
    ab.dpOuts = null; ab.outOnBase = null;
    ab.advReason = ['','','','']; ab.reachedOnError = false;
  }
  // Re-apply saved pitches on the batter's at-bat
  ab.pitches = savedPitches;
  renderDiamond(team, pIdx, innIdx);
  renderOut(team, pIdx, innIdx);
  renderPlayText(team, pIdx, innIdx);
  renderPitches(team, pIdx, innIdx);
  renderPitchCount(team, pIdx, innIdx);
  renderPitcherChange(team, pIdx, innIdx);
  updateInningRuns(team, innIdx);
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

/* Feature 8: Toggle earned/unearned run */
function toggleEarnedRun() {
  if (!selectedCell) return;
  const team = selectedCell.dataset.team;
  const pIdx = parseInt(selectedCell.dataset.p);
  const innIdx = parseInt(selectedCell.dataset.inn);
  const ab = gameState.teams[team].players[pIdx].atBats[innIdx];
  if (!ab.bases || !ab.bases[3]) return;
  pushUndo(team, pIdx, innIdx);
  ab.reachedOnError = !ab.reachedOnError;
  renderDiamond(team, pIdx, innIdx);
  updatePitcherStats(team);
  autoSave();
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
    if (snapshot.prevRunners) {
      Object.keys(snapshot.prevRunners).forEach(p => {
        const pi = parseInt(p);
        const restored = JSON.parse(JSON.stringify(snapshot.prevRunners[pi]));
        const target = gameState.teams[team].players[pi].atBats[innIdx];
        Object.keys(target).forEach(k => { if (!(k in restored)) delete target[k]; });
        Object.assign(target, restored);
        renderDiamond(team, pi, innIdx);
        renderOut(team, pi, innIdx);
        renderPlayText(team, pi, innIdx);
        renderPitches(team, pi, innIdx);
        renderRBI(team, pi, innIdx);
        renderPitchCount(team, pi, innIdx);
      });
    }
    if (snapshot.prevPlayerAbs) restorePlayerRow(team, pIdx, snapshot.prevPlayerAbs);
    if (snapshot.prevInn) {
      const inn = getInnState(team, innIdx);
      Object.assign(inn, JSON.parse(JSON.stringify(snapshot.prevInn)));
    }
    playHistory.splice(histIdx, 1);
  } else {
    if (histIdx !== -1) playHistory.splice(histIdx, 1);
    const inn = getInnState(team, innIdx);
    const outsToRemove = ab.outsRecorded || (ab.out ? 1 : 0);
    inn.outs = Math.max(0, inn.outs - outsToRemove);
    for (let b = 0; b < 3; b++) { if (inn.bases[b] === pIdx) inn.bases[b] = null; }
    // Also revert runners who were thrown out as part of this play (DP/FC runner outs)
    const players = gameState.teams[team].players;
    for (let pi = 0; pi < players.length; pi++) {
      if (pi === pIdx) continue;
      const rab = players[pi].atBats[innIdx];
      if (rab.outOnBase && rab.out > 0 && rab.out > inn.outs) {
        inn.outs = Math.max(0, inn.outs);
        rab.out = 0; rab.outOnBase = null;
        renderDiamond(team, pi, innIdx);
        renderOut(team, pi, innIdx);
      }
    }
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
    ab.reachedOnError = false;
    ab.extraOuts = 0;
    ab.pitcherChangeNum = '';
    // A sub line spans from here to the end of the game; clear the whole contiguous run.
    if (ab.subChange) {
      for (let c = innIdx; c < players[pIdx].atBats.length && players[pIdx].atBats[c].subChange; c++) {
        players[pIdx].atBats[c].subChange = false;
        renderPitcherChange(team, pIdx, c);
      }
    }
    ab.subChange = false;
    renderDiamond(team, pIdx, innIdx);
    renderOut(team, pIdx, innIdx);
    renderPitches(team, pIdx, innIdx);
    renderPlayText(team, pIdx, innIdx);
    renderRBI(team, pIdx, innIdx);
    renderPitchCount(team, pIdx, innIdx);
  }

  renderPitcherChange(team, pIdx, innIdx);
  updateInningRuns(team, innIdx);
  updateSprayMini();
  updateSituation();
  updatePlayerStats(team);
  updatePitcherStats(team);
  rebuildPlayLog();
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
    // cells[0] is team name, cells[1-10] are innings, cells[11-13] are R/H/E
    if (realInn < 10 && cells[realInn + 1]) {
      cells[realInn + 1].classList.add('ls-active');
    }
  }
}

function fillLinescoreZeros() {
  ['visiting', 'home'].forEach(team => {
    for (let i = 0; i < 10; i++) {
      const realInn = getRealInning(team, i);
      const inp = document.querySelector(`input[data-ls="${team}"][data-inn="${realInn}"]`);
      if (!inp || realInn >= 10) continue;
      const inn = getInnState(team, i);
      if (inn.outs >= 3 && inp.value === '') {
        inp.value = '0';
        gameState.linescore[team].innings[i] = '0';
      }
    }
  });
}

function updateLinescoreTotals(team) {
  let r = 0;
  for (let i = 0; i < 10; i++) {
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
  // Total LOB
  let totalLob = 0;
  const players = gameState.teams[team].players;
  for (let col = 0; col < INNINGS; col++) {
    let innLob = 0;
    for (const player of players) {
      const ab = player.atBats[col];
      if (!ab || !ab.play) continue;
      if (ab.bases[0] && !ab.bases[3] && ab.outOnBase == null) innLob++;
    }
    for (const oa of getOverflowForInning(team, col)) {
      if (!oa.atBat.play) continue;
      if (oa.atBat.bases[0] && !oa.atBat.bases[3] && oa.atBat.outOnBase == null) innLob++;
    }
    if (gameState.innings && gameState.innings[team] && gameState.innings[team][col]) {
      gameState.innings[team][col].lob = innLob;
    }
    totalLob += innLob;
  }
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
  safeStorage.setItem(CURRENT_GAME_KEY, JSON.stringify(gameState));
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

function loadState() {
  const saved = safeStorage.getItem(CURRENT_GAME_KEY);
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      // Merge with defaults to handle missing new fields
      const defaults = createEmptyState();
      if (!parsed.log) parsed.log = [];
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
      gameState = parsed;
    } catch(e) { 
      console.error('Failed to load state', e);
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
  if (!gameState.log) gameState.log = [];
  if (gameState.timerElapsed === undefined) gameState.timerElapsed = 0;
  if (gameState.timerRunning === undefined) gameState.timerRunning = false;
  if (gameState.notes === undefined) gameState.notes = '';
  if (!gameState.defChanges) gameState.defChanges = [];
  if (!gameState.visibleInnings) gameState.visibleInnings = 9;
  const makeAtBat = () => ({ bases:[false,false,false,false], advReason:['','','',''], outOnBase:null, play:'', out:0, outsRecorded:0, pitches:[], hitLoc:null, rbi:0, pitcher:0, reachedOnError:false, pitcherChangeNum:'', subChange:false });
  ['visiting','home'].forEach(t => {
    if (gameState.linescore[t] && gameState.linescore[t].innings.length < 14) {
      const ext = Array(14 - gameState.linescore[t].innings.length).fill('');
      gameState.linescore[t].innings = gameState.linescore[t].innings.concat(ext);
    }
    // Extend player atBat arrays if loaded from older save with fewer innings
    if (gameState.teams && gameState.teams[t]) {
      gameState.teams[t].players.forEach(player => {
        while (player.atBats.length < INNINGS) player.atBats.push(makeAtBat());
      });
    }
    // Extend innings array
    if (gameState.innings && gameState.innings[t]) {
      const makeInning = () => ({ outs:0, bases:[null,null,null], currentPitcher:0, lob:0 });
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
    updateLinescoreTotals(team);
    updatePlayerStats(team);
    updatePitcherStats(team);
  });

  updateSprayMini();
  refreshPlayLogDisplay();
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
function showPositionPopup(prefix, placeholder) {
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
  popup.style.display = 'flex';
  popup.dataset.prefix = prefix;
  setTimeout(() => input.focus(), 10);

  input.onkeydown = function(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      const val = input.value.trim();
      popup.style.display = 'none';
      input.blur();
      if (val) applyPlay(prefix + val);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      popup.style.display = 'none';
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
function tallyAtBats(atBats, filterFn) {
  let ab = 0, h = 0, r = 0, rbi = 0, bb = 0, k = 0, hbp = 0;
  for (const atBat of atBats) {
    if (!atBat.play || !filterFn(atBat)) continue;
    const noAB = ['BB','HBP','IBB','SAC','SF','SH','CI'].includes(atBat.play);
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
    const overflow = getOverflowForPlayer(team, sp);
    const allABs = player.atBats.concat(overflow);
    const hasSub = player.atBats.some(a => a.subChange);
    if (hasSub) {
      writeStats(team, sp, tallyAtBats(allABs, a => !a.subChange));
      writeStats(team, subp, tallyAtBats(allABs, a => a.subChange));
    } else {
      writeStats(team, sp, tallyAtBats(allABs, () => true));
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
    stats[i] = { ip: 0, outs: 0, k: 0, bb: 0, h: 0, r: 0, er: 0, pc: 0 };
  }

  // Go through the batting team's players to compute stats for the pitching team's pitchers
  const batters = gameState.teams[battingTeam].players;
  for (const player of batters) {
    for (const ab of player.atBats) {
      if (!ab.play) continue;
      const pi = ab.pitcher || 0;
      if (!stats[pi]) stats[pi] = { ip: 0, outs: 0, k: 0, bb: 0, h: 0, r: 0, er: 0, pc: 0 };
      const s = stats[pi];
      // Pitch count
      s.pc += (ab.pitches || []).length;
      // Count outs via outsRecorded (credits outs to the current pitcher).
      // Skip pure runner base-outs (outOnBase set, no outsRecorded) to avoid
      // double-counting — those outs are captured by the batter's outsRecorded.
      if (ab.outOnBase != null && !ab.outsRecorded) {
        // pure runner out — skip
      } else if (ab.outsRecorded > 0) {
        s.outs += ab.outsRecorded;
      } else if (ab.out > 0) {
        s.outs++;
      }
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
      }
    }
  }

  // Include overflow at-bats (batting-around)
  if (gameState.overflowAtBats) {
    for (const oa of gameState.overflowAtBats) {
      if (oa.team !== battingTeam) continue;
      const ab = oa.atBat;
      if (!ab.play) continue;
      const pi = ab.pitcher || 0;
      if (!stats[pi]) stats[pi] = { ip: 0, outs: 0, k: 0, bb: 0, h: 0, r: 0, er: 0, pc: 0 };
      const s = stats[pi];
      s.pc += (ab.pitches || []).length;
      if (ab.outOnBase != null && !ab.outsRecorded) {
      } else if (ab.outsRecorded > 0) {
        s.outs += ab.outsRecorded;
      } else if (ab.out > 0) {
        s.outs++;
      }
      if (ab.play === 'K' || ab.play === 'ꓘ' || ab.play === 'K+WP') s.k++;
      if (ab.play === 'BB' || ab.play === 'IBB') s.bb++;
      if (isHitPlay(ab.play)) s.h++;
      if (ab.bases[0] && ab.bases[1] && ab.bases[2] && ab.bases[3] && ab.outOnBase == null) {
        s.r++;
        if (!ab.reachedOnError) s.er++;
      }
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
    html += `<button onclick="setPitcher(${i})" style="display:block;width:100%;text-align:left;padding:6px 10px;margin-bottom:4px;border:1.5px solid ${isActive ? '#1565c0' : '#ccc'};border-radius:4px;background:${isActive ? '#e3f2fd' : '#fff'};cursor:pointer;font-size:12px;font-weight:${isActive ? '700' : '500'};font-family:var(--font)">${num}${name}</button>`;
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
  html += '<div style="font-size:11px;margin-bottom:8px;color:var(--text-light)">' + name + ' — current: <b>' + (current || 'none') + '</b></div>';
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
      // Batting-around overflow at-bats occur after the regular pass in this
      // column, so they take the pitcher in effect at the end of the column.
      if (gameState.overflowAtBats) {
        for (const oa of gameState.overflowAtBats) {
          if (oa.team !== battingTeam || oa.colIdx !== col) continue;
          const ab = oa.atBat;
          if (ab.pitcherChangeNum) {
            const idx = resolvePitcherIndex(pitchers, ab.pitcherChangeNum);
            if (idx != null) running = idx;
          }
          if (ab.play && (ab.pitcher || 0) !== running) {
            plan.push({ ab, from: ab.pitcher || 0, to: running });
          }
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
    rebuildPlayLog();
    autoSave();
    popup.style.display = 'none';
  };
}

/* Play-by-Play Log (Feature 7) */
function generatePlayDescription(team, pIdx, innIdx) {
  const ab = gameState.teams[team].players[pIdx].atBats[innIdx];
  const name = getActivePlayerName(team, pIdx, innIdx).replace(/^#\d+\s*/, '');
  const half = team === 'visiting' ? 'T' : 'B';
  const innNum = getRealInning(team, innIdx) + 1;
  const prefix = `${half}${innNum}`;
  const play = ab.play;

  let desc = '';
  if (play === '1B') desc = `${name} singled`;
  else if (play === '2B') desc = `${name} doubled`;
  else if (play === '3B') desc = `${name} tripled`;
  else if (play === 'HR') desc = `${name} homered`;
  else if (play === 'BB') desc = `${name} walked`;
  else if (play === 'IBB') desc = `${name} was intentionally walked`;
  else if (play === 'HBP') desc = `${name} was hit by pitch`;
  else if (play === 'K') desc = `${name} struck out swinging`;
  else if (play === 'ꓘ') desc = `${name} struck out looking`;
  else if (play === 'K+WP') desc = `${name} struck out but reached on wild pitch`;
  else if (play === 'SF') desc = `${name} hit a sacrifice fly`;
  else if (play === 'SH') desc = `${name} laid down a sacrifice bunt`;
  else if (play === 'SAC') desc = `${name} sacrificed`;
  else if (play === 'DP' || /^DP /.test(play)) desc = `${name} hit into a double play (${play})`;
  else if (play === 'FC') desc = `${name} reached on fielder's choice`;
  else if (isErrorPlay(play)) desc = `${name} reached on an error (${play})`;
  else if (/^F\d/.test(play)) desc = `${name} flied out to ${play.substring(1)}`;
  else if (/^P\d/.test(play)) desc = `${name} popped out to ${play.substring(1)}`;
  else if (/^L\d/.test(play)) desc = `${name} lined out to ${play.substring(1)}`;
  else if (/^\d+-\d/.test(play)) desc = `${name} grounded out ${play}`;
  else desc = `${name}: ${play}`;

  // RBI info
  if (ab.rbi > 0) desc += ` (${ab.rbi} RBI)`;

  return `${prefix}: ${desc}`;
}

function addPlayLogEntry(team, pIdx, innIdx) {
  const desc = generatePlayDescription(team, pIdx, innIdx);
  if (!gameState.log) gameState.log = [];
  gameState.log.push(desc);
  refreshPlayLogDisplay();
}

function refreshPlayLogDisplay() {
  const el = document.getElementById('play-log');
  if (!el || !gameState.log) return;
  el.innerHTML = (gameState.log || []).map(entry => `<div>${entry}</div>`).join('');
  el.scrollTop = el.scrollHeight;
  const section = el.closest('.play-log-section');
  if (section) section.classList.toggle('empty', !gameState.log.length);
}

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

function rebuildPlayLog() {
  if (!gameState.log) gameState.log = [];
  gameState.log = [];
  for (let innIdx = 0; innIdx < INNINGS; innIdx++) {
    for (const team of ['visiting', 'home']) {
      const players = gameState.teams[team].players;
      const plays = [];
      for (let p = 0; p < players.length; p += 2) {
        const ab = players[p].atBats[innIdx];
        if (ab.play) {
          plays.push({ p, out: ab.out || 999 });
        }
      }
      plays.sort((a, b) => a.out - b.out);
      for (const pl of plays) {
        gameState.log.push(generatePlayDescription(team, pl.p, innIdx));
      }
    }
  }
  refreshPlayLogDisplay();
}

/* LOB Calculation (Feature 6) */
function calculateLOB(team, innIdx) {
  const inn = getInnState(team, innIdx);
  if (inn.outs < 3) return 0;
  let lob = 0;
  if (inn.bases[0] !== null) lob++;
  if (inn.bases[1] !== null) lob++;
  if (inn.bases[2] !== null) lob++;
  return lob;
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
  try {
    return JSON.parse(safeStorage.getItem(LIBRARY_KEY) || '[]');
  } catch(e) { return []; }
}

function saveGameLibrary(library) {
  safeStorage.setItem(LIBRARY_KEY, JSON.stringify(library));
}

function openGameLibrary() {
  const modal = document.getElementById('game-library-modal');
  modal.classList.add('active');
  renderGameLibrary();
}

function closeGameLibrary() {
  document.getElementById('game-library-modal').classList.remove('active');
}

function renderGameLibrary() {
  const library = getGameLibrary();
  const listEl = document.getElementById('game-library-list');
  if (library.length === 0) {
    listEl.innerHTML = '<p style="font-size:12px;color:var(--text-light);padding:10px">No saved games yet. Click "Save Current as New" to save this game.</p>';
    return;
  }
  let html = '<ul class="game-list">';
  library.forEach((game, idx) => {
    const date = game.date || 'No date';
    const teams = game.teams || 'Unknown teams';
    const score = game.score || '';
    html += `<li>
      <div>
        <div class="game-info-text">${teams}</div>
        <div class="game-date">${date} ${score ? '| ' + score : ''}</div>
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

function saveAsNewGame() {
  collectState();
  const library = getGameLibrary();
  const vis = gameState.info.visitingTeam || 'Visiting';
  const hom = gameState.info.homeTeam || 'Home';
  const vR = document.querySelector('input[data-ls="visiting"][data-stat="r"]');
  const hR = document.querySelector('input[data-ls="home"][data-stat="r"]');
  const score = `${vR ? vR.value || 0 : 0} - ${hR ? hR.value || 0 : 0}`;
  const id = Date.now().toString(36);

  library.push({
    id: id,
    date: gameState.info.date || new Date().toLocaleDateString(),
    teams: `${vis} vs ${hom}`,
    score: score,
    state: JSON.parse(JSON.stringify(gameState))
  });

  saveGameLibrary(library);
  gameState.currentGameId = id;
  flushSave();
  renderGameLibrary();
}

function loadGameFromLibrary(idx) {
  const library = getGameLibrary();
  if (!library[idx] || !library[idx].state || !library[idx].state.teams) return;
  flushSave();  // persist the outgoing game before switching
  gameState = library[idx].state;
  playHistory = [];
  redoHistory = [];
  gameOverShown = false;
  applyState();
  closeGameLibrary();
  flushSave();
}

function deleteGameFromLibrary(idx) {
  const library = getGameLibrary();
  if (!confirm('Delete this saved game?')) return;
  library.splice(idx, 1);
  saveGameLibrary(library);
  renderGameLibrary();
}

/* Export PDF (Feature 15) */
function exportPDF() {
  window.print();
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
  const hTeam = 'Home';
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
      cells += '<td>' + (v || '-') + '</td>';
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
      rows += '<tr><td>' + pre + name + ' <span style="color:var(--text-light);font-size:10px">' + posLabel + '</span></td><td>' + s.ab + '</td><td>' + s.r + '</td><td>' + s.h + '</td><td>' + s.rbi + '</td><td>' + s.bb + '</td><td>' + s.k + '</td><td>' + avg + '</td></tr>';
      totAB += s.ab; totH += s.h; totR += s.r; totRBI += s.rbi; totBB += s.bb;
    }
    for (let pos = 0; pos < POSITIONS; pos++) {
      const sp = pos * ROWS_PER_POS;
      const subp = sp + 1;
      const starter = players[sp];
      const sub = players[subp];
      const overflow = getOverflowForPlayer(team, sp);
      const allABs = starter.atBats.concat(overflow);
      const hasSub = starter.atBats.some(ab => ab.subChange);
      if (hasSub) {
        const ss = tallyAtBats(allABs, ab => !ab.subChange);
        const us = tallyAtBats(allABs, ab => ab.subChange);
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
        const s = tallyAtBats(allABs, () => true);
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
      rows += '<tr><td>' + name + '</td><td>' + (p.ip || '0') + '</td><td>' + (p.pc || '0') + '</td><td>' + (p.h || '0') + '</td><td>' + (p.r || '0') + '</td><td>' + (p.er || '0') + '</td><td>' + (p.k || '0') + '</td><td>' + (p.bb || '0') + '</td></tr>';
    }
    return rows;
  }

  // Determine W/L/S pitchers
  function findPitcherDecisions() {
    const result = { wp: '', lp: '', sv: '' };
    // Winning pitcher: last pitcher for winning team when they took the lead for good
    // Simplified: winning team's pitcher with most IP, losing team's pitcher who allowed the go-ahead run
    const wTeam = vR > hR ? 'visiting' : 'home';
    const lTeam = vR > hR ? 'home' : 'visiting';
    const wPitchers = gameState.teams[wTeam].pitchers;
    const lPitchers = gameState.teams[lTeam].pitchers;
    // Find pitcher with most outs on winning side
    let bestIP = -1, bestIdx = 0;
    for (let i = 0; i < PITCHER_ROWS; i++) {
      const ip = parseFloat(wPitchers[i].ip) || 0;
      if (ip > bestIP) { bestIP = ip; bestIdx = i; }
    }
    if (wPitchers[bestIdx]?.name || wPitchers[bestIdx]?.num) {
      result.wp = (wPitchers[bestIdx].num ? '#' + wPitchers[bestIdx].num + ' ' : '') + (wPitchers[bestIdx].name || 'Pitcher ' + (bestIdx + 1));
    }
    // Losing pitcher: pitcher with most ER on losing side
    let worstER = -1, worstIdx = 0;
    for (let i = 0; i < PITCHER_ROWS; i++) {
      const er = parseInt(lPitchers[i].er) || 0;
      if (er > worstER) { worstER = er; worstIdx = i; }
    }
    if (lPitchers[worstIdx]?.name || lPitchers[worstIdx]?.num) {
      result.lp = (lPitchers[worstIdx].num ? '#' + lPitchers[worstIdx].num + ' ' : '') + (lPitchers[worstIdx].name || 'Pitcher ' + (worstIdx + 1));
    }
    // Save: last pitcher for winning team if they pitched the final inning and lead was ≤3
    const lastPitcherIdx = (() => {
      for (let i = PITCHER_ROWS - 1; i >= 0; i--) {
        if (wPitchers[i].ip && parseFloat(wPitchers[i].ip) > 0) return i;
      }
      return -1;
    })();
    if (lastPitcherIdx > 0 && lastPitcherIdx !== bestIdx) {
      const lastP = wPitchers[lastPitcherIdx];
      const margin = Math.abs(vR - hR);
      if (margin <= 3 || parseFloat(lastP.ip) >= 3) {
        result.sv = (lastP.num ? '#' + lastP.num + ' ' : '') + (lastP.name || 'Pitcher ' + (lastPitcherIdx + 1));
      }
    }
    return result;
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

  const decisions = vR !== hR ? findPitcherDecisions() : { wp: '', lp: '', sv: '' };
  const potg = findPlayerOfGame();
  const notable = findNotablePlays();

  let html = '<div style="position:relative"><button onclick="document.getElementById(\'game-summary-modal\').classList.remove(\'active\')" style="position:absolute;top:-8px;right:-12px;font-size:24px;cursor:pointer;color:var(--text-light);background:none;border:none;font-weight:700">&times;</button>';

  // Header
  html += '<div class="gs-header"><h2>Game Summary</h2>';
  html += '<div class="gs-subtitle">' + (date || 'Date TBD') + '</div></div>';

  // Score banner
  html += '<div class="gs-score-banner">';
  html += '<div class="gs-team-score"><div class="gs-team-name">' + vTeam + '</div><div class="gs-score-num">' + vR + '</div></div>';
  html += '<div style="text-align:center"><div class="gs-vs">vs</div><div class="gs-final-tag">Final</div></div>';
  html += '<div class="gs-team-score"><div class="gs-team-name">' + hTeam + '</div><div class="gs-score-num">' + hR + '</div></div>';
  html += '</div>';

  // Highlights row
  html += '<div class="gs-highlight">';
  if (potg) {
    html += '<div class="gs-highlight-card"><div class="gs-hl-label">Player of the Game</div>';
    html += '<div class="gs-hl-value">' + potg.name + '</div>';
    if (potg.isPitcher) {
      html += '<div class="gs-hl-detail">' + potg.ip + ' IP, ' + potg.k + ' K, ' + potg.er + ' ER</div>';
    } else {
      html += '<div class="gs-hl-detail">' + potg.h + '-' + potg.ab + ', ' + potg.rbi + ' RBI, ' + potg.r + ' R' + (potg.hr ? ', ' + potg.hr + ' HR' : '') + '</div>';
    }
    html += '<div class="gs-hl-detail" style="color:var(--text-light)">' + potg.team + '</div></div>';
  }
  if (decisions.wp) {
    html += '<div class="gs-highlight-card"><div class="gs-hl-label">Pitching Decision</div>';
    html += '<div class="gs-pitching-line"><b>W:</b> ' + decisions.wp + '</div>';
    html += '<div class="gs-pitching-line"><b>L:</b> ' + decisions.lp + '</div>';
    if (decisions.sv) html += '<div class="gs-pitching-line"><b>SV:</b> ' + decisions.sv + '</div>';
    html += '</div>';
  }
  html += '</div>';

  // Linescore
  html += '<div class="gs-section"><h3>Linescore</h3>';
  html += '<table class="gs-table"><thead><tr><th></th>';
  for (let i = 1; i <= gsVis; i++) html += '<th>' + i + '</th>';
  html += '<th>R</th><th>H</th><th>E</th></tr></thead><tbody>';
  html += '<tr><td>' + vTeam + '</td>' + lsRow('visiting') + '<td><b>' + vR + '</b></td><td>' + vH + '</td><td>' + vE + '</td></tr>';
  html += '<tr><td>' + hTeam + '</td>' + lsRow('home') + '<td><b>' + hR + '</b></td><td>' + hH + '</td><td>' + hE + '</td></tr>';
  html += '</tbody></table></div>';

  // Box score — Visiting
  html += '<div class="gs-section"><h3>' + vTeam + ' — Batting</h3>';
  html += '<table class="gs-table"><thead><tr><th>Player</th><th>AB</th><th>R</th><th>H</th><th>RBI</th><th>BB</th><th>K</th><th>AVG</th></tr></thead><tbody>';
  html += playerBox('visiting', vTeam);
  html += '</tbody></table></div>';

  // Box score — Home
  html += '<div class="gs-section"><h3>' + hTeam + ' — Batting</h3>';
  html += '<table class="gs-table"><thead><tr><th>Player</th><th>AB</th><th>R</th><th>H</th><th>RBI</th><th>BB</th><th>K</th><th>AVG</th></tr></thead><tbody>';
  html += playerBox('home', hTeam);
  html += '</tbody></table></div>';

  // Pitching — Visiting pitchers
  html += '<div class="gs-section"><h3>' + vTeam + ' — Pitching</h3>';
  html += '<table class="gs-table"><thead><tr><th>Pitcher</th><th>IP</th><th>PC</th><th>H</th><th>R</th><th>ER</th><th>K</th><th>BB</th></tr></thead><tbody>';
  html += pitcherBox('visiting');
  html += '</tbody></table></div>';

  // Pitching — Home pitchers
  html += '<div class="gs-section"><h3>' + hTeam + ' — Pitching</h3>';
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
        html += '<tr><td>' + dc.inning + '</td><td>' + teamName + '</td><td>' + c.name + '</td><td>' + c.fromPos + '</td><td>' + c.toPos + '</td></tr>';
      }
    }
    html += '</tbody></table></div>';
  }

  // Notable plays
  if (notable.length > 0) {
    html += '<div class="gs-section"><h3>Notable Plays</h3>';
    html += '<div class="gs-plays">';
    notable.forEach(p => { html += '<span>' + p + '</span> '; });
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