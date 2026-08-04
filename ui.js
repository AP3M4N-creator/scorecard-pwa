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
  } else if (act === 'deck') {
    /* The deck handle — phone only.

       The docked entry deck rests at 174px on a 440px-wide phone, which is
       three of the nine batting slots, and there is no arrangement of the
       chrome that gives back enough to show the whole card with it open. So it
       folds: 174px down to a 32px handle, and the batting rows grow into the
       space (fit() measures the deck rather than assuming it, so nothing here
       has to know the number).

       On the body rather than the deck, because there are two decks — one per
       team tab — and folding is a preference about the screen, not about the
       team. The drawer's own open/shut state is deliberately left alone, so
       unfolding gives back exactly what was folded away.

       The label is not written here. fit() derives it from the class, for the
       same reason it derives the More-plays button's: it has to be right at
       rest — on load, and after an orientation change that takes the handle
       out of the layout entirely — and not only after a press. */
    document.body.classList.toggle('deck-folded');
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

/* The drawer button's words used to be put back here, on its own click listener,
   after app.js's toggleQBDrawer() rewrote it to '···' / '∧'. It lives in `fit()` now
   — see the note there — because the label has to be right at rest, not just after a
   press, and `fit()` is the thing that already runs on load and on every resize. */

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

   Below FIT_BREAK — iPad portrait — the stylesheet's own breakpoint
   ladder is left alone: the card cannot fit there anyway, and
   shrinking the cells would only make the scroll harder to read.
   Extra innings and shown sub rows overflow past the floor by design
   — they scroll.

   The phone is neither of those and takes its own path, below. ------ */
(function () {
  /* PAD covers what sits below the grid but outside this measurement:
     .app's 14px gutter under the deck, plus a pixel or two of rounding
     in the row heights. Short-changing it leaves the page 2-3px
     scrollable, which on a touch screen is as annoying as 300px. */
  var FIT_MIN = 44, FIT_MAX = 62, FIT_BREAK = 835, STARTERS = 9, PAD = 18;
  /* A phone gets a higher floor than the iPad's 44px, because there is nothing
     to be won by going below it: the grid scrolls inside its own box either
     way (see the phone note below), so a shorter row buys no extra slot — it
     only shrinks the pitch marks, which size off --cell-h and are already down
     to 6-7px on the iPad. (44px would put a seven-mark column at 5.6px.) */
  var PHONE_MIN = 48;
  /* Kept verbatim in step with the two phone blocks at the end of styles.css.
     Asking matchMedia rather than comparing innerWidth/innerHeight here is the
     whole point: if the CSS and this file disagree about what a phone is, the
     layout reserves space for one deck and paints another. */
  var PHONE_PORTRAIT = '(max-width: 560px)';
  var PHONE_LANDSCAPE = '(orientation: landscape) and (max-height: 500px) and (min-width: 561px)';
  function phoneMode() {
    if (window.matchMedia(PHONE_PORTRAIT).matches) return 'portrait';
    if (window.matchMedia(PHONE_LANDSCAPE).matches) return 'landscape';
    return null;
  }
  /* At and above this the stylesheet lays the drawer flat and it stops being a
     drawer — every play button is on the deck all the time. Kept in step with the
     `min-width: 1100px` block in styles.css. */
  var FLAT_DRAWER = 1100;
  var root = document.documentElement, queued = false;

  function boxH(sel) {
    var e = document.querySelector('.tab-content.active ' + sel);
    return e ? e.getBoundingClientRect().height : 0;
  }

  function fit() {
    queued = false;
    /* Reserve the deck's resting height only. The More-plays drawer
       expands over the card; it must not push 400px of padding in.

       Except where it does not expand: laid flat there is nothing to open and no
       resting height to distinguish, so what has to be reserved is the whole deck.
       Reserving only `.qb-core` there would leave 98px of buttons sitting over the
       bottom of the order permanently, which is F9 made worse rather than fixed. */
    var flat = window.innerWidth >= FLAT_DRAWER;

    /* The button's words, derived from the drawer rather than flipped on the press.
       app.js writes '···' / '∧' synchronously; this puts the words back, and does it
       on load and on every resize as well — which matters because laid flat the deck
       starts *showing*, so a button that only ever changed on a press sat there
       reading "More plays" over two rows of plays already on screen. That is the F15
       mislabel over again. `refit()` runs on every `[data-act]` click, so the press is
       covered by the same call. (F21) */
    var d = document.querySelector('.tab-content.active .qb-drawer');
    var showing = !!d && (flat ? !d.classList.contains('collapsed') : d.classList.contains('open'));
    document.querySelectorAll('.qb-more-btn').forEach(function (btn) {
      btn.classList.toggle('open', showing);
      btn.textContent = showing ? 'Fewer plays' : 'More plays';
    });

    var phone = phoneMode();

    /* The handle's words, on the same terms as the More-plays button above and
       for the same reason — they have to be right at rest. An orientation change
       is the case that makes it necessary here rather than on the press: the
       handle is `display: none` outside the phone blocks, so turning the phone
       to landscape and back re-lays it out from the stylesheet, and a label that
       only ever moved on a click would come back saying the wrong thing. */
    var folded = document.body.classList.contains('deck-folded');
    document.querySelectorAll('.deck-handle').forEach(function (btn) {
      btn.textContent = folded ? 'Show entry' : 'Hide entry';
      btn.setAttribute('aria-expanded', folded ? 'false' : 'true');
    });

    /* What the deck occupies at rest. On a phone that is the whole docked bar
       *less* the drawer: the bar's own 3px rule and its safe-area bottom padding
       are on screen and have to be reserved, and the drawer must not be — it
       expands over the card, same as everywhere else. Subtracting the drawer
       rather than adding up the handle and the core keeps that arithmetic in the
       stylesheet, where the padding is declared. */
    var deck = Math.ceil(
      flat ? boxH('.quick-bar')
           : phone ? boxH('.quick-bar') - boxH('.qb-drawer')
                   : boxH('.qb-core'));
    root.style.setProperty('--deck-h', deck + 'px');

    var wrap = document.querySelector('.tab-content.active .grid-wrap');
    if (!wrap) { root.style.removeProperty('--cell-h'); return; }

    var head = wrap.querySelector('thead');
    var headH = head ? head.getBoundingClientRect().height : 40;

    /* The nine starters are not the only rows in the box. A sub row shows itself
       the moment a name is typed into it — no toggle involved — and it is
       content-height, not --cell-h, so the starters have to give up the space or
       the bottom of the order goes off the end. Measure what is actually on
       screen: a collapsed row reports no height. Both paths below want this. */
    var subs = 0;
    wrap.querySelectorAll('tr.pos-sub').forEach(function (r) {
      subs += r.getBoundingClientRect().height;
    });

    /* ---- Phone ----
       The page does not scroll here; the grid does. Every other block on the
       screen is chrome the scorer needs to keep still — the scoreboard above,
       the inning numbers in the head row, the deck below — and page-scrolling a
       card that is 250px short takes all three away at once. So the grid gets a
       measured box and its own scroll, and what does not fit scrolls inside it
       under a head row that is already sticky.

       The ceiling is the deck's top edge in every state: the handle is the
       docked deck's last child and the deck is laid out `column-reverse`, so the
       handle sits above both the core and the drawer whatever either is doing.
       That makes one measurement right for folded, unfolded, and drawer-open,
       and it is a fixed-position rect, so the safe-area insets are already in
       it. No page scroll to correct for either — there isn't any. */
    if (phone) {
      var handle = document.querySelector('.tab-content.active .deck-handle');
      var ceiling = handle ? handle.getBoundingClientRect().top
                           : window.innerHeight - deck;
      var room = Math.floor(ceiling - wrap.getBoundingClientRect().top - PAD);
      root.style.setProperty('--grid-max-h', Math.max(120, room) + 'px');
      /* Grow the rows into whatever the box turns out to be, up to the same
         62px ceiling the iPad uses, but never below PHONE_MIN — past that a
         shorter row buys no extra slot, because the box scrolls either way.
         Folding the deck in portrait is what this is for: the box goes from
         ~250px to ~570px and all nine slots land on screen at full height.

         Sub rows come out of the starters' share first, then stop mattering:
         same trade the iPad makes below, and for the same reason. A phone with
         the Show-sub-rows toggle on has eighteen rows and no arrangement fits
         them, so let the box scroll rather than shrink the card to 48px for a
         scroll it does not prevent. */
      var ph = Math.floor((room - headH - subs) / STARTERS);
      if (ph < PHONE_MIN) ph = Math.floor((room - headH) / STARTERS);
      root.style.setProperty('--cell-h', Math.max(PHONE_MIN, Math.min(FIT_MAX, ph)) + 'px');
      return;
    }

    root.style.removeProperty('--grid-max-h');
    if (window.innerWidth < FIT_BREAK) { root.style.removeProperty('--cell-h'); return; }

    /* Narrower than FLAT_DRAWER the drawer still opens over the card and is
       still not reserved — so give the grid its own scroll while it is open, or
       the rows behind the deck cannot be reached at all (F9-A). Only `fit()`
       knows where the open drawer's top edge actually lands. */
    var openDrawer = flat ? null : document.querySelector('.tab-content.active .qb-drawer.open');
    if (openDrawer) {
      var gridTop = wrap.getBoundingClientRect().top;
      var avail = Math.floor(openDrawer.getBoundingClientRect().top - gridTop - PAD);
      root.style.setProperty('--grid-max-h', Math.max(160, avail) + 'px');
    }

    /* Document-space top, so a scrolled page still measures the same box. */
    var top = wrap.getBoundingClientRect().top + window.scrollY;
    var body = window.innerHeight - top - deck - PAD - headH;

    /* If even the floor cannot swallow the sub rows measured above — the
       Show-sub-rows toggle, all eighteen at once — stop shrinking and let it
       scroll. A 44px row is a bad trade for a scroll it does not prevent. */
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
  /* Laid flat the deck's height is reserved, so folding it away hands ~114px back to
     the batting rows — but the click above measures on the next frame, 200ms before
     the padding has finished animating, and would bake in a stale height. Measure
     again when it settles. Fires once per property; refit coalesces them. (F21)

     `.qb-core` is here for the phone's deck handle, which folds the core the same
     way — 174px back to the batting rows, and the same stale-height trap. It was
     landing on the right numbers by accident: folding also zeroes the drawer's
     padding, so the drawer fired a transitionend of its own. Naming the element
     that is actually animating rather than relying on that. */
  document.addEventListener('transitionend', function (e) {
    var c = e.target.classList;
    if (c && (c.contains('qb-drawer') || c.contains('qb-core'))) refit();
  });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(refit);
  window.addEventListener('load', refit);
  refit();
})();
