// Copy buttons and the mobile nav menu. Plain script, defer-loaded.
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
            () => isGerman ? ['Kopiert', 'Befehl kopiert'] : ['Copied', 'Command copied'],
            () => isGerman ? ['Fehler', 'Kopieren fehlgeschlagen'] : ['Failed', 'Copy failed'],
          )
          // The button label stays short; the live region carries the full status.
          .then(([short, msg]) => {
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
      if (!video || !button) return;
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
            source.src = `/video/agent-production-loop.${format}`;
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
