/* Chrome-only behaviour for the redesigned shell: the grouped "More plays"
   drawer, the Batting / Pitching / Spray section tabs, and the sub-row toggle.
   Nothing here touches scoring state — app.js still owns all of that.
   Kept in its own file because the page's CSP forbids inline script. */
document.addEventListener('click', function (e) {
  var el = e.target.closest && e.target.closest('[data-ui-act]');
  if (!el) return;
  var act = el.dataset.uiAct;
  if (act === 'qbg') {
    var drawer = el.closest('.qb-drawer');
    if (!drawer) return;
    drawer.querySelectorAll('.qbg-tab').forEach(function (b) { b.classList.toggle('active', b === el); });
    drawer.querySelectorAll('.qbg-panel').forEach(function (p) { p.classList.toggle('active', p.dataset.group === el.dataset.group); });
  } else if (act === 'sec') {
    var area = el.closest('.main-area');
    if (!area) return;
    area.querySelectorAll('.sec-btn').forEach(function (b) { b.classList.toggle('active', b === el); });
    area.querySelectorAll('.sec-panel').forEach(function (p) { p.classList.toggle('active', p.dataset.panel === el.dataset.panel); });
  } else if (act === 'subs') {
    var wrap = el.closest('.main-area') && el.closest('.main-area').querySelector('.grid-wrap');
    if (!wrap) return;
    el.textContent = wrap.classList.toggle('show-subs') ? 'Hide sub rows' : 'Show sub rows';
  }
});

/* app.js's toggleQBDrawer() rewrites the drawer button to '···' / '∧'.
   Put the words back after it runs. */
document.addEventListener('click', function (e) {
  if (!(e.target.closest && e.target.closest('.qb-more-btn'))) return;
  setTimeout(function () {
    document.querySelectorAll('.qb-more-btn').forEach(function (btn) {
      btn.textContent = btn.classList.contains('open') ? 'Fewer plays' : 'More plays';
    });
  }, 0);
});
