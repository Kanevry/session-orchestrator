/* /commands: tool switcher and filter. Progressive enhancement: without JS
   both controls stay hidden, every card shows the forms for all four tools,
   all 31 cards are visible and every card is fully open.

   Tool switcher: the buttons pick Claude Code, Codex, Cursor or Pi. Each
   card's "Type it" list then shows only that tool's form. Command mentions
   such as "/session feature" in the first screen, the tile hints and the
   cards are rewritten to the chosen tool's form. The form comes from the
   target command's own card (its "Codex" etc. entry), never from a list in
   this file; a command without a card or without such a form is left as it
   is. The original text is kept in data-orig-text, so switching back
   restores it exactly. The choice is stored in localStorage ("so-tool") and
   can be preset with ?tool=codex.

   Filter: every search term must appear somewhere in a card's text for the
   card to stay visible. The index is rebuilt after each tool switch.

   Collapsed cards: cards outside "Start here" shrink to their title and
   first fact (.is-collapsed, set only here; the hiding lives in
   commands.css). Each gets a real button. A link or hash to a card opens it,
   an active search opens the matches, and clearing the search restores what
   the reader had open. The form rows keep their own hidden attribute.

   Language: every string this script writes comes from UI below, German
   when <html lang> starts with "de" (/de/commands), English otherwise. The
   Codex rewrite needs none: it reads the forms and tool labels from the
   cards, and both pages label them with the same tool names. */
(function () {
  'use strict';

  const UI = {
    en: {
      showing: function (tool) {
        return 'Showing commands for ' + tool + '.';
      },
      count: function (shown, total) {
        return shown + ' of ' + total + ' commands';
      },
      toggle: 'Details',
      toggleName: function (name) {
        return 'Details for /' + name;
      },
    },
    de: {
      showing: function (tool) {
        return 'Befehle für ' + tool + '.';
      },
      count: function (shown, total) {
        return shown + ' von ' + total + ' Befehlen';
      },
      toggle: 'Details',
      toggleName: function (name) {
        return 'Details zu /' + name;
      },
    },
  };
  const ui = /^de\b/i.test(document.documentElement.lang || '') ? UI.de : UI.en;

  const cards = Array.prototype.slice.call(document.querySelectorAll('[data-command]'));

  /* ---------- Tool switcher ---------- */
  const TOOLS = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor', pi: 'Pi' };
  const DEFAULT_TOOL = 'claude';
  const STORE_KEY = 'so-tool';
  const switcher = document.getElementById('tool-switch');
  const status = document.getElementById('tool-status');
  let reindex = function () {};

  function toolOfLabel(text) {
    const t = text.trim();
    for (const key in TOOLS) {
      if (TOOLS[key] === t) return key;
    }
    return null;
  }

  // name -> { codex: '$session-orchestrator:plan', cursor: '/plan', ... }
  // Each prefix is the first word of the first <code> in that tool's form.
  const prefixes = {};
  cards.forEach(function (card) {
    const name = card.getAttribute('data-command');
    const forms = card.querySelector('dl.forms');
    if (!name || !forms) return;
    prefixes[name] = {};
    forms.querySelectorAll('dt').forEach(function (dt) {
      const tool = toolOfLabel(dt.textContent);
      const dd = dt.nextElementSibling;
      const code = dd && dd.tagName === 'DD' ? dd.querySelector('code') : null;
      if (!tool || !code) return;
      const first = code.textContent.trim().split(/\s+/)[0];
      if (first) prefixes[name][tool] = first;
    });
  });

  // Elements whose "/name" mentions follow the tool. Card titles, the
  // "Type it" lists and the per-tool explanation table stay as written.
  const targets = Array.prototype.slice
    .call(document.querySelectorAll('#top code, #top .tile-hint, [data-command] .cmd-facts > dd code'))
    .filter(function (el) {
      return (
        !el.closest('dl.forms') &&
        !el.closest('.typing') &&
        !el.closest('.cmd-name') &&
        !el.querySelector('*') &&
        /(^|[\s(,])\/[a-z]/.test(el.textContent)
      );
    });
  targets.forEach(function (el) {
    el.setAttribute('data-orig-text', el.textContent);
  });

  const MENTION = /(^|[\s(,])\/([a-z][a-z0-9-]*)(?=$|[\s),.])/g;

  function rewrite(text, tool) {
    return text.replace(MENTION, function (whole, lead, name) {
      const form = prefixes[name] && prefixes[name][tool];
      return form ? lead + form : whole;
    });
  }

  function applyTool(tool, announce) {
    document.querySelectorAll('dl.forms').forEach(function (forms) {
      forms.querySelectorAll('dt').forEach(function (dt) {
        const show = toolOfLabel(dt.textContent) === tool;
        dt.hidden = !show;
        const dd = dt.nextElementSibling;
        if (dd && dd.tagName === 'DD') dd.hidden = !show;
      });
    });
    targets.forEach(function (el) {
      const orig = el.getAttribute('data-orig-text');
      el.textContent = tool === DEFAULT_TOOL ? orig : rewrite(orig, tool);
    });
    switcher.querySelectorAll('button[data-tool]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-tool') === tool));
    });
    if (status && announce) status.textContent = ui.showing(TOOLS[tool]);
    reindex();
  }

  function readStored() {
    try {
      return window.localStorage.getItem(STORE_KEY);
    } catch {
      return null;
    }
  }

  function store(tool) {
    try {
      window.localStorage.setItem(STORE_KEY, tool);
    } catch {
      /* storage blocked: the choice lasts for this page view only */
    }
  }

  let initialTool = DEFAULT_TOOL;
  if (switcher) {
    let fromUrl = null;
    try {
      fromUrl = new URLSearchParams(window.location.search).get('tool');
    } catch {
      /* no usable query string: fall back to the stored choice */
    }
    const known = function (t) {
      return !!t && Object.prototype.hasOwnProperty.call(TOOLS, t);
    };
    // An unknown ?tool= value falls through to the stored choice instead of discarding it.
    const wanted = known(fromUrl) ? fromUrl : readStored();
    if (known(wanted)) initialTool = wanted;

    switcher.addEventListener('click', function (e) {
      const btn = e.target.closest('button[data-tool]');
      if (!btn) return;
      const tool = btn.getAttribute('data-tool');
      if (!Object.prototype.hasOwnProperty.call(TOOLS, tool)) return;
      store(tool);
      applyTool(tool, true);
    });
  }

  /* ---------- Collapsed cards ---------- */
  // open: the reader's own state. searchClosed: closed by hand during the
  // current search only, so a search never changes what open remembers.
  const collapsible = [];
  const collapsibleById = {};
  let searching = false;

  function renderCollapse() {
    collapsible.forEach(function (item) {
      const expanded = searching ? !item.searchClosed : item.open;
      item.card.classList.toggle('is-collapsed', !expanded);
      item.button.setAttribute('aria-expanded', String(expanded));
    });
  }

  function setSearching(on) {
    if (on === searching) return;
    searching = on;
    if (!on) {
      collapsible.forEach(function (item) {
        item.searchClosed = false;
      });
    }
    renderCollapse();
  }

  function revealCard(id) {
    const item = Object.prototype.hasOwnProperty.call(collapsibleById, id) ? collapsibleById[id] : null;
    if (!item) return;
    item.open = true;
    item.searchClosed = false;
    renderCollapse();
  }

  cards.forEach(function (card) {
    if (card.closest('#start-here')) return;
    const title = card.querySelector('h3');
    const facts = card.querySelector('dl.cmd-facts');
    if (!title || !facts) return;
    const name = card.getAttribute('data-command');
    facts.id = card.id + '-facts';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cmd-toggle';
    button.textContent = ui.toggle;
    button.setAttribute('aria-label', ui.toggleName(name));
    button.setAttribute('aria-controls', facts.id);
    const item = { card: card, button: button, open: false, searchClosed: false };
    button.addEventListener('click', function () {
      if (searching) item.searchClosed = !item.searchClosed;
      else item.open = !item.open;
      renderCollapse();
    });
    title.insertAdjacentElement('afterend', button);
    card.classList.add('has-toggle');
    collapsible.push(item);
    collapsibleById[card.id] = item;
  });
  renderCollapse();

  /* ---------- Filter ---------- */
  const box = document.getElementById('cmd-filter-box');
  const input = document.getElementById('cmd-filter');
  const count = document.getElementById('cmd-count');
  const empty = document.getElementById('cmd-empty');

  if (box && input && count) {
    const groups = Array.prototype.slice
      .call(document.querySelectorAll('.cmd-group'))
      .filter(function (g) {
        return g.querySelector('[data-command]');
      });
    let texts = [];
    const total = cards.length;

    const apply = function () {
      const terms = input.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
      setSearching(terms.length > 0);
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
      count.textContent = ui.count(shown, total);
      if (empty) empty.hidden = shown !== 0;
    };

    // textContent includes hidden forms and collapsed facts, so all of it stays
    // findable. The toggle is left out: its label would match every card.
    const searchText = function (card) {
      const copy = card.cloneNode(true);
      const toggle = copy.querySelector('.cmd-toggle');
      if (toggle) toggle.remove();
      return copy.textContent;
    };

    reindex = function () {
      texts = cards.map(function (c) {
        return searchText(c).toLowerCase().replace(/\s+/g, ' ');
      });
      apply();
    };

    input.addEventListener('input', apply);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && input.value) {
        input.value = '';
        apply();
      }
    });
    box.hidden = false;
    reindex();
  }

  if (switcher) {
    applyTool(initialTool, false);
    if (status) status.textContent = ui.showing(TOOLS[initialTool]);
    switcher.hidden = false;
  }

  /* ---------- Links to collapsed cards ---------- */
  if (collapsible.length) {
    const hashId = function () {
      return window.location.hash.slice(1);
    };

    // Runs before the browser follows the link, so the card is open when it
    // scrolls; also covers a link to the hash that is already current.
    document.addEventListener('click', function (e) {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = e.target.closest('a[href^="#"]');
      if (link) revealCard(link.getAttribute('href').slice(1));
    });

    window.addEventListener('hashchange', function () {
      const id = hashId();
      revealCard(id);
      const el = document.getElementById(id);
      if (el) el.scrollIntoView();
    });

    // Collapsing moved everything below the fold, so the position the browser
    // computed for the fragment on load is stale whatever the target is.
    const initial = hashId();
    if (initial) {
      revealCard(initial);
      const el = document.getElementById(initial);
      if (el) el.scrollIntoView({ behavior: 'instant' });
    }
  }

  // Test seam (tests/site/commands-rewrite.test.mjs, #1879): inert in the browser.
  if (typeof window.__soTest === 'function') window.__soTest({ MENTION, rewrite, prefixes });
})();
