/* /commands filter. Progressive enhancement: without JS the field stays
   hidden and all 30 cards are visible. Every search term must appear
   somewhere in a card's text for the card to stay visible. */
(function () {
  'use strict';
  const box = document.getElementById('cmd-filter-box');
  const input = document.getElementById('cmd-filter');
  const count = document.getElementById('cmd-count');
  const empty = document.getElementById('cmd-empty');
  if (!box || !input || !count) return;

  const cards = Array.prototype.slice.call(document.querySelectorAll('[data-command]'));
  const groups = Array.prototype.slice
    .call(document.querySelectorAll('.cmd-group'))
    .filter(function (g) {
      return g.querySelector('[data-command]');
    });
  const texts = cards.map(function (c) {
    return c.textContent.toLowerCase().replace(/\s+/g, ' ');
  });
  const total = cards.length;

  function apply() {
    const terms = input.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
    let shown = 0;
    cards.forEach(function (card, i) {
      const hit = terms.every(function (t) {
        return texts[i].indexOf(t) !== -1;
      });
      card.hidden = !hit;
      if (hit) shown += 1;
    });
    groups.forEach(function (g) {
      g.hidden = !g.querySelector('[data-command]:not([hidden])');
    });
    count.textContent = shown + ' of ' + total + ' commands';
    if (empty) empty.hidden = shown !== 0;
  }

  input.addEventListener('input', apply);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && input.value) {
      input.value = '';
      apply();
    }
  });
  box.hidden = false;
  apply();
})();
