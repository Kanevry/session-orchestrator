/* /commands: tool switcher and filter. Progressive enhancement: without JS
   both controls stay hidden, every card shows the forms for all four tools
   and all 31 cards are visible.

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
    },
    de: {
      showing: function (tool) {
        return 'Befehle für ' + tool + '.';
      },
      count: function (shown, total) {
        return shown + ' von ' + total + ' Befehlen';
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

    // textContent includes hidden forms, so every tool's form stays findable.
    reindex = function () {
      texts = cards.map(function (c) {
        return c.textContent.toLowerCase().replace(/\s+/g, ' ');
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
})();
