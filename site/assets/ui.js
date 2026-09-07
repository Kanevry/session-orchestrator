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
    const status = document.createElement('span');
    status.className = 'sr';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    document.body.appendChild(status);

    document.querySelectorAll('button.copy[data-copy]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const label = btn.dataset.label || btn.textContent;
        btn.dataset.label = label;
        copyText(btn.getAttribute('data-copy'))
          .then(() => ['Copied', 'Copied'], () => ['Failed', 'Copy failed'])
          // Design H1: the button is absolutely positioned in a 76px gutter, so
          // the visible label stays short; the live region carries the sentence.
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

    document.querySelectorAll('details.nav-menu').forEach((menu) => {
      menu.addEventListener('click', (ev) => {
        if (ev.target.closest('a')) menu.open = false;
      });
      document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape' && menu.open) menu.open = false;
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else init();
}());
