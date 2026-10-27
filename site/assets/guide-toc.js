// Marks the guide section in view in the on-this-page list (#1767).
// Without JS the links still work; this only sets aria-current.
(function () {
  const nav = document.querySelector('.guide-toc');
  if (!nav || !('IntersectionObserver' in window)) return;
  const links = Array.prototype.slice.call(nav.querySelectorAll('a[href^="#"]'));
  const byId = {};
  const sections = [];
  links.forEach(function (a) {
    const el = document.getElementById(a.getAttribute('href').slice(1));
    if (el) { byId[el.id] = a; sections.push(el); }
  });
  // The observer only says "something crossed the line"; the current
  // section is the last one whose top has passed the sticky header (96px).
  function mark() {
    let current = sections[0];
    for (let i = 0; i < sections.length; i++) {
      if (sections[i].getBoundingClientRect().top <= 120) current = sections[i];
    }
    links.forEach(function (a) { a.removeAttribute('aria-current'); });
    byId[current.id].setAttribute('aria-current', 'true');
  }
  const io = new IntersectionObserver(mark, { rootMargin: '-96px 0px -55% 0px' });
  sections.forEach(function (s) { io.observe(s); });
})();
