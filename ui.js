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
  } else if (act === 'menu') {
    var menu = el.closest('.hdr-menu');
    if (!menu) return;
    var open = menu.classList.toggle('open');
    el.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
});

/* Close the masthead menu and the details panel on any click outside them —
   including a click on one of the menu's own buttons, which fires its
   data-act on app.js and then wants the menu out of the way. */
document.addEventListener('click', function (e) {
  var inMenu = e.target.closest && e.target.closest('.hdr-menu');
  var onTrigger = inMenu && e.target.closest('[data-ui-act="menu"]');
  if (!onTrigger) {
    document.querySelectorAll('.hdr-menu.open').forEach(function (m) {
      m.classList.remove('open');
      var b = m.querySelector('[data-ui-act="menu"]');
      if (b) b.setAttribute('aria-expanded', 'false');
    });
  }
  if (!(e.target.closest && e.target.closest('.game-info-card'))) {
    document.querySelectorAll('details.info-details[open]').forEach(function (d) { d.open = false; });
  }
});
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape') return;
  document.querySelectorAll('.hdr-menu.open').forEach(function (m) { m.classList.remove('open'); });
  document.querySelectorAll('details.info-details[open]').forEach(function (d) { d.open = false; });
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

/* ---------------------------------------------------------------
   One Notes box, both team tabs.

   The team card is duplicated per tab, and the Notes field was inside
   the Home copy — so a note about the game could only be written by
   first switching teams. Two textareas would mean two values to keep
   in sync and app.js reads exactly one #game-notes, so instead the one
   box is moved into whichever tab's Spray panel is on screen. Moving a
   node keeps its value, its listeners and its undo history; only focus
   is lost, and that only happens on a tab switch, which was taking the
   box off screen anyway.

   Hung off switchTab() rather than the tab button's click, because
   app.js switches teams on its own too — the half-inning ending, an
   undo restoring the other side. Reassigning the global rebinds the
   name for app.js's internal calls as well as for the data-act
   dispatch, both of which resolve `switchTab` through window.
   --------------------------------------------------------------- */
(function () {
  function placeNotes() {
    var box = document.getElementById('notes-box');
    var row = document.querySelector('.tab-content.active .sec-panel[data-panel="spray"] .spray-row');
    if (box && row && box.parentElement !== row) row.appendChild(box);
  }
  function hook() {
    var orig = window.switchTab;
    if (typeof orig === 'function' && !orig._notesHooked) {
      var wrapped = function () { var r = orig.apply(this, arguments); placeNotes(); return r; };
      wrapped._notesHooked = true;
      window.switchTab = wrapped;
    }
    placeNotes();   // in case a tab was switched before the hook was in place
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hook);
  else hook();
})();

/* ---------------------------------------------------------------
   One-page fit.

   The batting grid gets whatever vertical space is left between the
   scoreboard strip and the docked entry deck, so a nine-inning card
   sits on an iPad screen with nothing to scroll. Measuring beats the
   old --cell-h width breakpoints, which were guessing at height from
   width and could not tell Safari-with-chrome from the home-screen
   PWA.

   Two variables come out of here:
     --cell-h   batting row height, clamped to stay legible
     --deck-h   what the docked deck actually occupies, so .app
                reserves that and not a flat 140px

   Below FIT_BREAK (phone, and iPad portrait) the stylesheet's own
   breakpoint ladder is left alone: the card cannot fit there anyway,
   and shrinking the cells would only make the scroll harder to read.
   Extra innings and shown sub rows overflow past the floor by design
   — they scroll. --------------------------------------------------- */
(function () {
  /* PAD covers what sits below the grid but outside this measurement:
     .app's 14px gutter under the deck, plus a pixel or two of rounding
     in the row heights. Short-changing it leaves the page 2-3px
     scrollable, which on a touch screen is as annoying as 300px. */
  var FIT_MIN = 44, FIT_MAX = 62, FIT_BREAK = 835, STARTERS = 9, PAD = 18;
  var root = document.documentElement, queued = false;

  function fit() {
    queued = false;
    /* Reserve the deck's resting height only. The More-plays drawer
       expands over the card; it must not push 400px of padding in. */
    var core = document.querySelector('.tab-content.active .qb-core');
    var deck = core ? Math.ceil(core.getBoundingClientRect().height) : 0;
    root.style.setProperty('--deck-h', deck + 'px');

    var wrap = document.querySelector('.tab-content.active .grid-wrap');
    if (window.innerWidth < FIT_BREAK || !wrap) { root.style.removeProperty('--cell-h'); return; }

    var head = wrap.querySelector('thead');
    /* Document-space top, so a scrolled page still measures the same box. */
    var top = wrap.getBoundingClientRect().top + window.scrollY;
    var body = window.innerHeight - top - deck - PAD - (head ? head.getBoundingClientRect().height : 40);

    /* The nine starters are not the only rows in the box. A sub row shows
       itself the moment a name is typed into it — no toggle involved — and
       it is content-height, not --cell-h, so the starters have to give up
       the space or the bottom of the order slides under the deck. Measure
       what is actually on screen: a collapsed row reports no height.

       If even the floor cannot swallow them — the Show-sub-rows toggle, all
       eighteen at once — stop shrinking and let it scroll. A 44px row is a
       bad trade for a scroll it does not prevent. */
    var subs = 0;
    wrap.querySelectorAll('tr.pos-sub').forEach(function (r) {
      subs += r.getBoundingClientRect().height;
    });
    var h = Math.floor((body - subs) / STARTERS);
    if (h < FIT_MIN) h = Math.floor(body / STARTERS);
    root.style.setProperty('--cell-h', Math.max(FIT_MIN, Math.min(FIT_MAX, h)) + 'px');
  }

  function refit() { if (!queued) { queued = true; requestAnimationFrame(fit); } }

  window.addEventListener('resize', refit);
  window.addEventListener('orientationchange', refit);
  /* A tab switch, the drawer, the sub-row toggle and +EI all change the
     boxes being measured; re-measure after whichever handler ran. */
  document.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('[data-act], [data-ui-act]')) refit();
  });
  /* Naming a substitute is what reveals his row, and it happens under the
     scorer's fingers rather than on a press. Coalesced to one measurement
     per frame, so a whole name costs one. */
  document.addEventListener('input', refit);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(refit);
  window.addEventListener('load', refit);
  refit();
})();
