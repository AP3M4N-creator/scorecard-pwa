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
 *
 * ui.js is inlined the same way, and was not until F39. jsdom's resource loader
 * is off, so its <script src> never executed and the shell's whole chrome layer
 * — the drawer, the section tabs, the sub-row toggle, the masthead menu, the
 * deck handle and the one-page fit engine — ran under no test at all. Some of
 * that is a hard ceiling (jsdom has no layout, so `fit()`'s arithmetic measures
 * zeroes), but the parts that are pure state are not, and those are covered now.
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
  { title: 'Scoring flows', page: 'index.html', suite: 'tests-scoring.js', scripts: ['ui.js', 'app.js'] }
];

/* Replace <script src="…"></script> with the file's contents inline, in place,
   so parse order is exactly the browser's — ui.js before app.js, as index.html
   has them. Throws rather than warns when a tag is missing: a rename that
   silently stopped inlining a file would take its whole suite with it and still
   report green. */
function inlineScripts(html, files) {
  return files.reduce((out, f) => {
    const src = read(f);
    const tag = new RegExp('<script\\s+src=(["\'])' + f.replace('.', '\\.') + '\\1\\s*></script>', 'gi');
    let replaced = 0;
    const next = out.replace(tag, () => { replaced++; return '<script>\n' + src + '\n</script>'; });
    if (!replaced) throw new Error(`no <script src="${f}"> tag found to inline`);
    return next;
  }, html);
}

/* jsdom implements no viewport, so it ships no `matchMedia` — and `fit()` asks
   it three questions (F39). Without this the whole fit engine throws on every
   frame, which is silent, because a throw inside a requestAnimationFrame
   callback does not fail a case.

   Every query answers false, which is the honest answer: there is no viewport
   to match against, so `phoneMode()` returns null and fit() takes the iPad
   path. That is the branch the suite wants anyway — the phone path measures
   boxes, and every box here is zero. A case that needs a different answer can
   replace this; none does yet. */
function stubMatchMedia(window) {
  window.matchMedia = query => ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; }
  });
}

/* Wait for the page to finish loading before running a suite against it.

   The JSDOM constructor returns with the document still parsing: the inlined
   scripts have executed by then, but `readyState` is 'loading' and neither
   DOMContentLoaded nor load has fired. run-tests.js used to append the suite
   right there, so under `npm test` every deferred boot step in the app was dead
   — including ui.js's `switchTab` wrapper, which is what moves the one Notes
   box between the two team cards and which therefore could not be tested at
   all. It works in a browser and did not here, which is the worst shape a test
   environment can have. */
function whenLoaded(dom) {
  const { document, window } = { document: dom.window.document, window: dom.window };
  if (document.readyState === 'complete') return Promise.resolve();
  return new Promise(resolve => window.addEventListener('load', () => resolve(), { once: true }));
}

async function runSuite(suite) {
  const fatal = [];
  const warnings = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', e => fatal.push(e && (e.stack || e.message) || String(e)));
  virtualConsole.on('error', (...args) => warnings.push(args.map(String).join(' ')));
  virtualConsole.on('warn', (...args) => warnings.push(args.map(String).join(' ')));
  if (!QUIET) virtualConsole.on('log', (...args) => console.log('    [page]', ...args.map(String)));

  let dom;
  try {
    dom = new JSDOM(inlineScripts(read(suite.page), suite.scripts || ['app.js']), {
      url: 'http://localhost/',
      runScripts: 'dangerously',
      virtualConsole,
      /* ui.js ends on `refit()`, which is `requestAnimationFrame` — undefined in
         jsdom unless it is pretending to be visual, and an inlined ui.js would
         throw on load without this. It also means `fit()` runs on its own during
         the suite, on zero-sized boxes; harmless (it writes --cell-h to its
         floor and no layout reads it), and cases that want fit() call it
         synchronously through `window.__ui` rather than waiting for a frame. */
      pretendToBeVisual: true,
      // Suppress the app's own boot (init -> loadState -> applyState). Suites
      // build only the DOM they need and reset state per case; a full
      // applyState() per case is what made the audit harness take ~10 minutes.
      beforeParse(window) { window.__NO_AUTO_INIT__ = true; stubMatchMedia(window); }
    });
    await whenLoaded(dom);
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

/* A section of checks that read files rather than drive a DOM. */
function section(title, body) {
  const results = [];
  const check = (name, fn) => {
    try {
      const why = fn();
      results.push(why ? { name, pass: false, error: why } : { name, pass: true });
    } catch (e) {
      results.push({ name, pass: false, error: (e && e.message) || String(e) });
    }
  };
  body(check);
  return { title, results };
}

/* ---------------------------------------------------- stylesheet checks ---
   styles.css is 2100 lines that no suite can see. jsdom is built without
   `resources: 'usable'`, so the stylesheet never loads and nothing in it is
   ever exercised — which is why F30 could carry two whole palettes, one
   shadowing the other, without a single test noticing.

   These read it as text. That will not catch a colour that looks wrong, and it
   is not trying to; it catches the four things that went wrong in this file and
   would go wrong again the same way — a token declared twice, a token nothing
   reads, a breakpoint that means two different things in two places, and a
   `var()` pointing at nothing. */
function stylesheetChecks() {
  return section('Stylesheet  (styles.css, which no DOM here loads)', check => {
    /* Blank out comments before matching, but keep every newline and every byte
       position, so a reported line number still points at the real line. These
       files are heavily commented and the comments quote the very patterns
       being looked for — the F28 note quotes `(min-width: 835px)` while
       explaining why there are none left — so a check reading the raw text
       finds its own documentation and calls it a defect. It did, on the first
       run of this. */
    const blank = s => s.replace(/[^\n]/g, ' ');
    const code = f => {
      const s = read(f);
      if (f.endsWith('.html')) return s.replace(/<!--[\s\S]*?-->/g, blank);
      return s
        .replace(/\/\*[\s\S]*?\*\//g, blank)
        .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + blank(m.slice(p.length)));
    };
    const css = code('styles.css');
    const sources = ['styles.css', 'app.js', 'ui.js', 'index.html'];

    /* F30. Three `:root` blocks, the second unconditionally redeclaring most of
       the first by source order. Media-query copies are fine and expected —
       that is how --cell-w steps down — so this counts only the ones that stand
       on their own at the top level. */
    check('there is exactly one unconditional :root block', () => {
      const n = (css.match(/^:root\s*\{/gm) || []).length;
      return n === 1 ? null : `found ${n} top-level :root blocks — a second one shadows the first by source order, which is how F30 happened`;
    });

    /* Both halves of "every var() resolves". A name may be declared in the
       stylesheet, or written at runtime by ui.js (--cell-h, --deck-h,
       --grid-max-h are measured, not declared), or used with a fallback. Any
       other var() paints nothing at all and does it silently. */
    check('every var(--x) resolves to something', () => {
      const declared = new Set((css.match(/--[A-Za-z0-9-]+\s*:/g) || []).map(m => m.replace(/\s*:$/, '')));
      const runtime = new Set((code('ui.js').match(/setProperty\(\s*'(--[A-Za-z0-9-]+)'/g) || [])
        .map(m => m.slice(m.indexOf("'") + 1, -1)));
      const bad = [];
      sources.forEach(f => {
        const s = code(f);
        const re = /var\(\s*(--[A-Za-z0-9-]+)\s*(,)?/g;
        let m;
        while ((m = re.exec(s))) {
          if (declared.has(m[1]) || runtime.has(m[1]) || m[2]) continue;
          bad.push(`${f}: var(${m[1]})`);
        }
      });
      return bad.length ? 'points at a name nothing declares — ' + [...new Set(bad)].join(', ') : null;
    });

    check('no token is declared that nothing reads', () => {
      const declared = new Set((css.match(/--[A-Za-z0-9-]+\s*:/g) || []).map(m => m.replace(/\s*:$/, '')));
      const used = new Set();
      sources.forEach(f => {
        const s = code(f);
        const re = /var\(\s*(--[A-Za-z0-9-]+)/g;
        let m;
        while ((m = re.exec(s))) used.add(m[1]);
      });
      const dead = [...declared].filter(d => !used.has(d));
      return dead.length ? 'declared and never read: ' + dead.join(', ') : null;
    });

    /* F28. At 844x390 both the iPad block and the phone-landscape block matched,
       so every iPad rule the phone block did not restate was in force on a
       390px-tall window. The height floor is what keeps them disjoint, and a
       bare 835 anywhere means the breakpoint says "iPad" in one place and "iPad
       or a phone on its side" in another. */
    check('no 835px breakpoint is left without its height floor', () => {
      const bare = [];
      const re = /\(min-width:\s*835px\)(\s*and\s*\(min-height:\s*501px\))?/g;
      let m;
      while ((m = re.exec(css))) {
        if (!m[1]) bare.push('line ' + (css.slice(0, m.index).split('\n').length));
      }
      return bare.length
        ? `a bare (min-width: 835px) at ${bare.join(', ')} — it matches a phone in landscape too (F28)`
        : null;
    });

    // F33.
    check('reduced motion is honoured, by duration rather than by removal', () => {
      if (!/@media\s*\(prefers-reduced-motion:\s*reduce\)/.test(css)) {
        return 'no prefers-reduced-motion block — seven transitions run whatever the OS was told';
      }
      const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
      if (/transition:\s*none/.test(block)) {
        return '`transition: none` fires no transitionend, and fit() re-measures the deck on one (F33)';
      }
      return /transition-duration:\s*0\.01ms/.test(block) ? null
        : 'the block no longer sets a near-zero transition-duration';
    });

    /* F31. Graduate is a single-weight display face with no tabular figures.
       While it led this stack the 31KB JetBrains Mono was fetched, precached and
       never rendered once, and the pitch marks and the count — the two places
       figures have to line up — were set in the display face. */
    check('the mono stack does not start with the display face', () => {
      const m = css.match(/--mono:\s*([^;]+);/);
      if (!m) return 'no --mono declaration found at all';
      const first = m[1].split(',')[0].replace(/['"]/g, '').trim();
      return /graduate/i.test(first)
        ? `--mono starts with ${first}, so JetBrains Mono is precached and never renders (F31)`
        : null;
    });
  });
}

/* ------------------------------------------------------ delivery checks ---
   The two suites above run the app. These run the repo, because the two ways
   this project has actually broken in the field are not things a DOM can see:
   a file that stops being delivered, and a hook that stops running.

   Both of F37 and F38 were *regressions* of state that had been correct — the
   `.nojekyll` marker deleted, the hook's exec bit dropped — and nothing noticed
   either. Neither would have failed a test, because there was no test. */
function deliveryChecks() {
  return section('Delivery  (the repo, not the app)', check => {
  const exists = f => fs.existsSync(path.join(ROOT, f));

  // F37. Without it GitHub Pages runs Jekyll over the site, which can drop a
  // file the service worker precaches. A dropped CRITICAL file still fails the
  // install outright — deliberately, so the old worker stays in charge rather
  // than a new one taking over with a half-filled cache — and a dropped
  // OPTIONAL one is swallowed, which is quieter and worse: the app updates,
  // works online, and has lost a font or an icon offline with nothing said.
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
    // CRITICAL and OPTIONAL are the lists the install handler actually walks;
    // FONTS and SHELL only feed them. Read all four, because a file that goes
    // missing from OPTIONAL now fails silently by design — c.add() swallows it
    // so one 404 can't leave the cache empty — and this is the only thing left
    // that would notice.
    const critical = arrayOf('CRITICAL');
    const optional = arrayOf('OPTIONAL');
    // A parse that quietly matched nothing would make this check pass forever.
    if (!fonts || !fonts.length) return 'could not read FONTS out of sw.js';
    if (!shell || !shell.length) return 'could not read SHELL out of sw.js';
    if (!critical || !critical.length) return 'could not read CRITICAL out of sw.js';
    if (!optional || !optional.length) return 'could not read OPTIONAL out of sw.js';
    const direct = (sw.match(/base \+ '([^']+)'/g) || []).map(s => s.slice(8, -1));
    if (!direct.length) return "could not read the base + '...' entries out of sw.js";
    const missing = [...fonts, ...shell, ...critical, ...optional, ...direct].filter(f => !exists(f));
    return missing.length ? 'precached but not in the repo: ' + missing.join(', ') : null;
  });

  /* boot.js only reports the failures that happen after it runs. Loaded late it
     would miss the stylesheet, miss ui.js and app.js, and go on saying nothing
     about the exact white screen it was written for — a watchdog that is quiet
     for the wrong reason is worse than none, because it reads as all clear.
     So the order is asserted rather than trusted to survive the next edit. */
  check('boot.js runs before anything it is meant to watch', () => {
    const html = read('index.html');
    const at = s => html.indexOf(s);
    const boot = at('src="boot.js"');
    if (boot < 0) return 'index.html does not load boot.js';
    const after = [['styles.css', at('href="styles.css"')],
                   ['ui.js', at('src="ui.js"')],
                   ['app.js', at('src="app.js"')]];
    const early = after.filter(([, i]) => i >= 0 && i < boot).map(([n]) => n);
    return early.length ? 'loaded before boot.js, so a failure in it goes unreported: ' + early.join(', ') : null;
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

  /* F39. The hook runs this suite over the *working tree*, not over what is
     actually being committed — so a fix staged alongside an unstaged breakage
     is gated on the breakage, and a broken file left unstaged is gated on
     nothing. `git stash -k` puts the working tree at the staged snapshot for
     the length of the run and restores it after. */
  check('the hook tests what is being committed, not what is lying about', () => {
    const hook = read('.githooks/pre-commit');
    if (!/git stash (push )?-k|--keep-index/.test(hook)) {
      return 'the hook still runs the suite over the working tree — a staged fix can pass on an unstaged file, and an unstaged breakage is not gated at all';
    }
    if (!/trap\s+'restore_tree'/.test(hook)) {
      return 'the hook stashes but does not trap — a failed or interrupted run would leave the working tree stashed';
    }
    /* The bare `git stash pop` after a --keep-index push conflicts wherever the
       staged and unstaged halves touch the same file, and leaves conflict
       markers in it. The reset-to-HEAD is what makes the pop a fast-forward and
       `--index` is what puts the staged/unstaged split back. Both are easy to
       "tidy away" by someone who has not watched it fail. */
    if (!/git reset --hard/.test(hook) || !/git stash pop --index/.test(hook)) {
      return 'the restore is back to a bare `git stash pop` — that conflicts with the staged half and writes conflict markers into the working copy';
    }
    return null;
  });
  });
}


/* The two DOM suites, then the sections that read files instead. Async only
   because a suite now waits for its page to finish loading first — see
   whenLoaded(): the app has boot steps that run on DOMContentLoaded, and until
   F39 none of them ran here. */
async function main() {
  const started = Date.now();
  let passed = 0, failed = 0;
  const tally = r => {
    if (r.pass) {
      passed++;
      if (!QUIET) console.log(`  ✓ ${r.name}`);
    } else {
      failed++;
      console.log(`  ✗ ${r.name}`);
      console.log(`      ${r.error}`);
    }
  };

  console.log('\nScorecard test suite\n');

  for (const suite of SUITES) {
    console.log(`▸ ${suite.title}  (${label(suite)})`);
    const { results, fatal, warnings } = await runSuite(suite);
    results.forEach(tally);
    for (const w of warnings) console.log(`  ! page console: ${w.split('\n')[0]}`);
    for (const f of fatal) {
      failed++;
      console.log('  ✗ SUITE ERROR');
      console.log('      ' + String(f).split('\n').slice(0, 6).join('\n      '));
    }
    console.log('');
  }

  for (const s of [stylesheetChecks(), deliveryChecks()]) {
    console.log(`▸ ${s.title}`);
    s.results.forEach(tally);
    console.log('');
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`${passed} passed · ${failed} failed  (${secs}s)\n`);
  process.exit(failed ? 1 : 0);
}

/* A throw out here is the runner breaking, not a case failing, and it must not
   be reported as either a pass or a quiet exit 0. */
main().catch(e => {
  console.log('\n✗ RUNNER ERROR');
  console.log('    ' + String((e && e.stack) || e).split('\n').slice(0, 8).join('\n    ') + '\n');
  process.exit(2);
});
