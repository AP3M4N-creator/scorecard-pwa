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

/* ------------------------------------------------------ delivery checks ---
   The two suites above run the app. These run the repo, because the two ways
   this project has actually broken in the field are not things a DOM can see:
   a file that stops being delivered, and a hook that stops running.

   Both of F37 and F38 were *regressions* of state that had been correct — the
   `.nojekyll` marker deleted, the hook's exec bit dropped — and nothing noticed
   either. Neither would have failed a test, because there was no test. */
function deliveryChecks() {
  const results = [];
  const check = (name, fn) => {
    try {
      const why = fn();
      results.push(why ? { name, pass: false, error: why } : { name, pass: true });
    } catch (e) {
      results.push({ name, pass: false, error: (e && e.message) || String(e) });
    }
  };
  const exists = f => fs.existsSync(path.join(ROOT, f));

  // F37. Without it GitHub Pages runs Jekyll over the site, which can drop a
  // file the service worker precaches — and `addAll` is all-or-nothing, so one
  // missing URL fails the install, leaves the old worker in place, and the app
  // silently stops updating and stops working offline.
  check('.nojekyll is present, so Pages serves the site as static files', () =>
    exists('.nojekyll') ? null : '.nojekyll is missing — Pages will run Jekyll over the site');

  /* The other half of the same hazard, and the one a person cannot eyeball: every
     URL the install precaches has to resolve. The list is deliberately exact
     (sw.js:14-15) and it is edited by hand whenever the fonts or icons change. */
  check('every asset the service worker precaches exists', () => {
    const sw = read('sw.js');
    const arrayOf = name => {
      const m = sw.match(new RegExp('const ' + name + '\\s*=\\s*\\[([\\s\\S]*?)\\]'));
      if (!m) return null;
      return (m[1].match(/'[^']+'/g) || []).map(s => s.slice(1, -1));
    };
    const fonts = arrayOf('FONTS');
    const shell = arrayOf('SHELL');
    // A parse that quietly matched nothing would make this check pass forever.
    if (!fonts || !fonts.length) return 'could not read FONTS out of sw.js';
    if (!shell || !shell.length) return 'could not read SHELL out of sw.js';
    const direct = (sw.match(/base \+ '([^']+)'/g) || []).map(s => s.slice(8, -1));
    if (!direct.length) return "could not read the base + '...' entries out of sw.js";
    const missing = [...fonts, ...shell, ...direct].filter(f => !exists(f));
    return missing.length ? 'precached but not in the repo: ' + missing.join(', ') : null;
  });

  // F38, first half. The mode in the *index* is what a fresh clone checks out,
  // so that is what is asked — a local chmod would hide the regression.
  check('the pre-commit hook is executable in the index', () => {
    let out;
    try {
      out = require('child_process')
        .execFileSync('git', ['ls-files', '-s', '.githooks/pre-commit'], { cwd: ROOT })
        .toString();
    } catch (e) {
      return null;   // no git, or not a checkout: nothing to assert against
    }
    if (!out.trim()) return '.githooks/pre-commit is not tracked';
    return out.startsWith('100755')
      ? null
      : 'mode is ' + out.slice(0, 6) + ', not 100755 — the hook will not run on macOS or Linux';
  });

  /* F38, second half. The bump used BSD `sed -i ''`, which GNU sed reads as an
     empty script plus a filename, so it never ran here — and nothing checked,
     so the hook still added sw.js and announced a version it had not written. */
  check('the cache-version bump is portable and checks that it landed', () => {
    const hook = read('.githooks/pre-commit');
    if (/sed\s+-i\s+''/.test(hook)) return "the BSD `sed -i ''` form is back — it is a no-op under GNU sed";
    // Matched on the `grep` specifically, not on the version string: that string
    // is also the sed replacement, so a looser pattern goes on passing after the
    // verification is deleted. Which is what it did on the first draft of this.
    if (!/grep -q "SHELL_VERSION = 'v\$next'"/.test(hook)) {
      return 'the bump no longer checks that the substitution actually applied';
    }
    return null;
  });

  return results;
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

console.log('▸ Delivery  (the repo, not the app)');
for (const r of deliveryChecks()) {
  if (r.pass) {
    passed++;
    if (!QUIET) console.log(`  ✓ ${r.name}`);
  } else {
    failed++;
    console.log(`  ✗ ${r.name}`);
    console.log(`      ${r.error}`);
  }
}
console.log('');

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(`${passed} passed · ${failed} failed  (${secs}s)\n`);

process.exit(failed ? 1 : 0);
