// Copy buttons, tool tabs and the mobile nav menu. Plain script, defer-loaded.
(function () {
  'use strict';

  // Fallback where the async clipboard is missing or denied.
  const legacyCopy = (text) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px';
    document.body.appendChild(ta);
    ta.select();
    let ok;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok ? Promise.resolve() : Promise.reject(new Error('copy'));
  };

  const copyText = (text) => (navigator.clipboard && navigator.clipboard.writeText
    ? navigator.clipboard.writeText(text).catch(() => legacyCopy(text))
    : legacyCopy(text));

  function init() {
    const isGerman = document.documentElement.lang === 'de';

    // Where the clipboard refuses (insecure context, permission denied), a
    // short "Failed" on the button is easy to miss: select the command and say
    // visibly, next to it, how to copy it by hand.
    function showCopyHint(btn, failed) {
      const row = btn.parentElement;
      const next = row.nextElementSibling;
      let hint = next && next.classList.contains('copy-err') ? next : null;
      if (!failed) {
        if (hint) hint.hidden = true;
        return;
      }
      const code = row.querySelector('code, pre');
      if (code) {
        try {
          const range = document.createRange();
          range.selectNodeContents(code);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        } catch { /* selection is a convenience; the hint below still shows */ }
      }
      if (!hint) {
        hint = document.createElement('p');
        hint.className = 'copy-err';
        row.after(hint);
      }
      hint.hidden = false;
      hint.textContent = isGerman
        ? 'Kopieren ging hier nicht. Die Zeile ist markiert: Strg+C oder \u2318C drücken.'
        : 'Could not copy here. The line is selected: press Ctrl+C or \u2318C.';
    }

    // Tool tabs ([data-tabs]): the panels are plain sections in the markup, so
    // without JavaScript all of them stay readable. Roles are set here, with the
    // behaviour that makes them true.
    document.querySelectorAll('[data-tabs]').forEach((list) => {
      const tabs = [...list.querySelectorAll('button[aria-controls]')];
      const panes = tabs.map((t) => document.getElementById(t.getAttribute('aria-controls')));
      if (!tabs.length || panes.some((p) => !p)) return;
      list.setAttribute('role', 'tablist');
      list.setAttribute('aria-orientation', 'vertical');
      const select = (i, focus) => {
        tabs.forEach((t, j) => {
          t.setAttribute('aria-selected', String(i === j));
          t.tabIndex = i === j ? 0 : -1;
          panes[j].hidden = i !== j;
        });
        if (focus) tabs[i].focus();
      };
      tabs.forEach((t, i) => {
        t.setAttribute('role', 'tab');
        panes[i].setAttribute('role', 'tabpanel');
        panes[i].setAttribute('aria-labelledby', t.id);
        t.addEventListener('click', () => select(i, false));
        t.addEventListener('keydown', (ev) => {
          const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[ev.key];
          let j = step === undefined ? null : (i + step + tabs.length) % tabs.length;
          if (ev.key === 'Home') j = 0;
          if (ev.key === 'End') j = tabs.length - 1;
          if (j === null) return;
          ev.preventDefault();
          select(j, true);
        });
      });
      select(0, false);
    });

    const status = document.getElementById('copy-live') || document.createElement('span');
    status.className = 'sr';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    document.body.appendChild(status);

    document.querySelectorAll('button.copy[data-copy]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const label = btn.dataset.label || btn.textContent;
        btn.dataset.label = label;
        copyText(btn.getAttribute('data-copy'))
          .then(
            () => isGerman ? ['Kopiert', 'Befehl kopiert', false] : ['Copied', 'Command copied', false],
            () => isGerman ? ['Fehler', 'Kopieren fehlgeschlagen', true] : ['Failed', 'Copy failed', true],
          )
          // The button label stays short; the live region carries the full status.
          .then(([short, msg, failed]) => {
            showCopyHint(btn, failed);
            btn.textContent = short;
            status.textContent = msg;
            window.setTimeout(() => {
              btn.textContent = label;
              status.textContent = '';
            }, 1500);
          });
      });
    });

    function revealTarget(hash = window.location.hash) {
      const id = hash.slice(1);
      const target = document.getElementById(id);
      if (target && target.matches('details.technical-detail')) target.open = true;
    }
    window.addEventListener('hashchange', () => revealTarget());
    document.addEventListener('click', (ev) => {
      const link = ev.target.closest('a[href^="#"]');
      if (link) revealTarget(link.hash);
    });
    revealTarget();

    document.querySelectorAll('.hero-art').forEach((art) => {
      const video = art.querySelector('video');
      const button = art.querySelector('.motion-toggle');
      // Filename lives in the markup (data-video-base), not here: one video element,
      // one place its asset is named. Missing attribute -> no toggle, no guessing.
      const base = video && video.dataset.videoBase;
      if (!video || !button || !base) return;
      const playLabel = isGerman ? 'Werkstatt bewegen' : 'Animate workshop';
      const pauseLabel = isGerman ? 'Animation pausieren' : 'Pause animation';
      let attempt = 0;
      function setPlaying(playing) {
        button.textContent = playing ? pauseLabel : playLabel;
        button.setAttribute('aria-pressed', String(playing));
      }
      function showFailure() {
        const wasRequested = !video.paused;
        attempt += 1;
        video.pause();
        video.hidden = true;
        video.replaceChildren();
        video.load();
        setPlaying(false);
        status.textContent = wasRequested
          ? (isGerman ? 'Animation konnte nicht geladen werden.' : 'Animation could not be loaded.')
          : '';
      }
      button.hidden = false;
      button.addEventListener('click', async () => {
        if (!video.paused) {
          attempt += 1;
          video.pause();
          status.textContent = '';
          return;
        }
        const currentAttempt = ++attempt;
        status.textContent = '';
        if (!video.querySelector('source')) {
          let failedSources = 0;
          for (const [format, type] of [['webm', 'video/webm'], ['mp4', 'video/mp4']]) {
            const source = document.createElement('source');
            source.src = `/video/${base}.${format}`;
            source.type = type;
            source.addEventListener('error', () => {
              if (!video.contains(source)) return;
              failedSources += 1;
              if (failedSources === 2) showFailure();
            });
            video.appendChild(source);
          }
          video.load();
        }
        try {
          await video.play();
          if (currentAttempt !== attempt) return;
          video.hidden = false;
          status.textContent = '';
        } catch (error) {
          if (currentAttempt === attempt && error.name !== 'AbortError') showFailure();
        }
      });
      video.addEventListener('play', () => setPlaying(true));
      video.addEventListener('pause', () => setPlaying(false));
      video.addEventListener('error', showFailure);
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) { attempt += 1; video.pause(); }
      });
      window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (event) => {
        if (event.matches) { attempt += 1; video.pause(); }
      });
    });

    document.querySelectorAll('details.nav-menu').forEach((menu) => {
      menu.addEventListener('click', (ev) => {
        if (ev.target.closest('a')) menu.open = false;
      });
      document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape' && menu.open) {
          menu.open = false;
          menu.querySelector('summary').focus();
        }
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else init();
}());
