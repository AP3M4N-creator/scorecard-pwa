/* ---------------------------------------------------------------
   Boot watchdog.

   A home-screen launch that fails has no console to read. The scorer
   gets a white screen, and every diagnosis after that is guesswork —
   which is exactly how the standalone launch bug got two rounds of
   wrong answers before anyone knew what it said.

   So the app reports on itself. Two things are caught here:

     - any uncaught error or rejected promise, including a stylesheet
       or script that failed to load at all (the capture-phase listener
       sees resource errors, which do not bubble)
     - a boot that finishes without drawing a card, on a timer

   Either paints a readable panel over the page with what went wrong
   and the handful of facts that distinguish a home-screen launch from
   a browser tab. Screenshot it and there is nothing left to guess at.

   Loaded first, from <head>, and before the stylesheet: a listener
   registered here catches failures in everything that loads after it.
   Its own markup carries inline style attributes rather than classes,
   because the case it exists for is the one where styles.css is the
   thing that did not arrive. The page's CSP allows style attributes
   ('unsafe-inline' on style-src) but not inline script, which is why
   this is a file and not a <script> block.
   --------------------------------------------------------------- */
(function () {
  var shown = false;

  function esc(s) {
    return String(s).replace(/[&<>]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
    });
  }

  /* The facts that actually separate a working launch from a white one.
     Every lookup is guarded: this runs when things are already broken,
     and a diagnostic that throws tells nobody anything. */
  function env() {
    var rows = [];
    function add(k, v) { rows.push(k + ': ' + v); }
    try {
      add('url', location.href);
    } catch (e) { add('url', '?'); }
    try {
      var mm = window.matchMedia;
      add('display-mode', mm && mm('(display-mode: standalone)').matches ? 'standalone'
        : mm && mm('(display-mode: fullscreen)').matches ? 'fullscreen'
        : 'browser');
    } catch (e) { add('display-mode', '?'); }
    /* iOS sets this on a home-screen web app and nowhere else, so it is the
       one flag that says which of the two contexts this is on an iPad. */
    try { add('navigator.standalone', String(navigator.standalone)); } catch (e) {}
    try { add('viewport', window.innerWidth + 'x' + window.innerHeight); } catch (e) {}
    try {
      add('service worker', !('serviceWorker' in navigator) ? 'unsupported'
        : navigator.serviceWorker.controller ? 'controlling' : 'none');
    } catch (e) { add('service worker', '?'); }
    try { add('stylesheets', String(document.styleSheets.length)); } catch (e) {}
    try { add('localStorage', (function () { try { localStorage.setItem('__t', '1'); localStorage.removeItem('__t'); return 'ok'; } catch (e) { return 'blocked (' + e.name + ')'; } })()); } catch (e) {}
    try { add('ua', navigator.userAgent); } catch (e) {}
    return rows.join('\n');
  }

  function show(title, detail) {
    if (shown) return;
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', function () { shown = false; show(title, detail); });
      return;
    }
    shown = true;
    var d = document.createElement('div');
    d.setAttribute('role', 'alert');
    d.setAttribute('style', 'position:fixed;inset:0;z-index:2147483647;overflow:auto;' +
      'background:#f7f3e8;color:#003278;font:14px/1.45 Georgia,serif;padding:24px;-webkit-text-size-adjust:100%');
    d.innerHTML =
      '<h1 style="font:700 19px/1.3 Georgia,serif;margin:0 0 10px">' + esc(title) + '</h1>' +
      '<p style="margin:0 0 14px">The scorecard did not finish starting. Screenshot this and send it on.</p>' +
      '<pre style="white-space:pre-wrap;word-break:break-word;margin:0 0 16px;padding:12px;' +
      'background:#fff;border:1px solid #d8cfba;border-radius:6px;font:12px/1.5 ui-monospace,Menlo,monospace">' +
      esc(detail) + '\n\n' + esc(env()) + '</pre>' +
      '<p style="margin:0"><a href="./" style="display:inline-block;padding:11px 20px;background:#003278;' +
      'color:#fff;text-decoration:none;border-radius:6px">Reload</a></p>';
    document.body.appendChild(d);
  }

  /* Capture phase, so this also sees resource errors — a <link> or <script>
     that 404'd fires an error event that does not bubble to window. Those
     arrive with no message and a target instead, which is the shape that
     tells us the stylesheet or a script never arrived. */
  window.addEventListener('error', function (e) {
    if (e && e.target && e.target !== window && e.target.tagName) {
      show('A file failed to load',
        e.target.tagName.toLowerCase() + ' — ' + (e.target.src || e.target.href || '(no url)'));
      return;
    }
    show('Script error', (e && e.message ? e.message : 'unknown') +
      '\n' + ((e && e.filename) || '') + (e && e.lineno ? ':' + e.lineno : ''));
  }, true);

  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    show('Unhandled rejection', (r && (r.stack || r.message)) || String(r));
  });

  /* The silent case: nothing threw, and there is still no card. Checked
     against a cell rather than a container, because the containers are in
     index.html and would be there even if app.js never ran a line.

     Three seconds after load, not after DOMContentLoaded — the grid is built
     from script and an iPad is not always quick about it. A launch that is
     merely slow must not accuse itself. */
  function watchdog() {
    setTimeout(function () {
      if (shown) return;
      var cells = 0;
      try { cells = document.querySelectorAll('#grid-visiting .at-bat-cell').length; } catch (e) {}
      if (cells > 0) return;                     // drew a card: nothing to report
      show('Scorecard did not start',
        'The page loaded but no batting grid was built.\n' +
        'No error was thrown, so app.js either did not run or stopped early.');
    }, 3000);
  }
  if (document.readyState === 'complete') watchdog();
  else window.addEventListener('load', watchdog);
})();
