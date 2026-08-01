#!/usr/bin/env node
'use strict';

/*
 * CLI test runner — `npm test`.
 *
 * The app has no build step, so the suites run the *real* app.js against a real
 * DOM in jsdom. Two suites:
 *
 *   tests.html        linescore / extra-inning column + total maths. Also opens
 *                     directly in a browser (it carries its own results UI).
 *   tests-scoring.js  scoring flows driven through the full index.html DOM:
 *                     selectCell + applyPlay + popup confirms, the same entry
 *                     points the UI uses. CLI only.
 *
 * app.js is inlined in place of its <script src> tag rather than fetched. That
 * keeps parse order identical to the browser and — the part that matters — runs
 * app.js and the suite as classic scripts in one realm, which is the only way a
 * suite can reach app.js's top-level `let gameState` / `let selectedCell`
 * bindings (they are global lexical bindings, not properties of window).
 */

const fs = require('fs');
const path = require('path');

let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require('jsdom'));
} catch (e) {
  console.error('jsdom is not installed. Run:\n\n  npm install\n');
  process.exit(2);
}

const ROOT = __dirname;
const QUIET = process.argv.includes('-q') || process.argv.includes('--quiet');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

const SUITES = [
  { title: 'Linescore & extra innings', page: 'tests.html' },
  { title: 'Scoring flows', page: 'index.html', suite: 'tests-scoring.js' }
];

// Replace <script src="app.js"></script> with the file's contents inline.
function inlineAppJs(html) {
  const appJs = read('app.js');
  let replaced = 0;
  const out = html.replace(/<script\s+src=(["'])app\.js\1\s*><\/script>/gi, () => {
    replaced++;
    return '<script>\n' + appJs + '\n</script>';
  });
  if (!replaced) throw new Error('no <script src="app.js"> tag found to inline');
  return out;
}

function runSuite(suite) {
  const fatal = [];
  const warnings = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', e => fatal.push(e && (e.stack || e.message) || String(e)));
  virtualConsole.on('error', (...args) => warnings.push(args.map(String).join(' ')));
  virtualConsole.on('warn', (...args) => warnings.push(args.map(String).join(' ')));
  if (!QUIET) virtualConsole.on('log', (...args) => console.log('    [page]', ...args.map(String)));

  let dom;
  try {
    dom = new JSDOM(inlineAppJs(read(suite.page)), {
      url: 'http://localhost/',
      runScripts: 'dangerously',
      virtualConsole,
      // Suppress the app's own boot (init -> loadState -> applyState). Suites
      // build only the DOM they need and reset state per case; a full
      // applyState() per case is what made the audit harness take ~10 minutes.
      beforeParse(window) { window.__NO_AUTO_INIT__ = true; }
    });
    if (suite.suite) {
      const el = dom.window.document.createElement('script');
      el.textContent = read(suite.suite);
      dom.window.document.body.appendChild(el);
    }
  } catch (e) {
    fatal.push(e && (e.stack || e.message) || String(e));
  }

  const results = (dom && dom.window.__TEST_RESULTS__) || [];
  if (dom) dom.window.close();
  if (!fatal.length && !results.length) fatal.push('suite produced no results (did it throw before reporting?)');
  return { results, fatal, warnings };
}

function label(suite) {
  return suite.suite ? `${suite.page} + ${suite.suite}` : suite.page;
}

const started = Date.now();
let passed = 0, failed = 0;

console.log('\nScorecard test suite\n');

for (const suite of SUITES) {
  console.log(`▸ ${suite.title}  (${label(suite)})`);
  const { results, fatal, warnings } = runSuite(suite);

  for (const r of results) {
    if (r.pass) {
      passed++;
      if (!QUIET) console.log(`  ✓ ${r.name}`);
    } else {
      failed++;
      console.log(`  ✗ ${r.name}`);
      console.log(`      ${r.error}`);
    }
  }

  for (const w of warnings) console.log(`  ! page console: ${w.split('\n')[0]}`);
  for (const f of fatal) {
    failed++;
    console.log('  ✗ SUITE ERROR');
    console.log('      ' + String(f).split('\n').slice(0, 6).join('\n      '));
  }
  console.log('');
}

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(`${passed} passed · ${failed} failed  (${secs}s)\n`);

process.exit(failed ? 1 : 0);
