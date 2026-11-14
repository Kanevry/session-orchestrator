// The thread on the home page: one line from /session through the rounds to
// /close, drawn into one SVG behind <main>. Loaded synchronously in <head>, so
// the `js` class and the old-anchor forwarding happen before the first paint.
// Without JavaScript the page stays complete: every label and the real-run note
// are plain HTML, only the line is missing. No device storage of any kind.
(function () {
  'use strict';

  // Old anchors of the previous home page whose content moved to /guide and
  // /commands. External links still point at them; forward instead of landing
  // on the top of a page that no longer has the section.
  // The guide is English only; /commands has a German twin under /de.
  const commands = document.documentElement.lang === 'de' ? '/de/commands' : '/commands';
  const MOVED = {
    '#faq': '/guide#faq',
    '#tools': '/guide#tools',
    '#who': '/guide#story',
    '#connect': '/guide#fits-together',
    '#learn': commands + '#evolve',
    '#choose': commands + '#top',
  };
  const hash = window.location.hash;
  if (Object.prototype.hasOwnProperty.call(MOVED, hash)) {
    window.location.replace(MOVED[hash]);
    return;
  }

  // Set before the first paint so the labels do not flash; start() reveals them
  // in a finally and init() in a catch, so an exception cannot leave them hidden.
  document.documentElement.classList.add('js');

  const NS = 'http://www.w3.org/2000/svg';
  const LEAN = 0.32;
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reduce = motion.matches;

  function init() {
    const main = document.getElementById('main');
    const svg = document.getElementById('thread');
    const zone = document.getElementById('zone');
    const stYes = document.getElementById('st-yes');
    const yesDot = document.getElementById('yes');
    if (!main || !svg || !zone || !stYes || !yesDot) {
      // Not the home page markup: never leave labels hidden behind the js class.
      document.documentElement.classList.remove('js');
      return;
    }

    let built = false;
    let rt = 0;
    let lastH = 0;
    let lastW = 0;
    let pieces = [];
    const drawn = { hero: false };
    const timers = [];
    const later = (fn, sec) => timers.push(window.setTimeout(fn, sec * 1000));

    function rel(el) {
      const m = main.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return {
        l: r.left - m.left, r: r.right - m.left, t: r.top - m.top, b: r.bottom - m.top,
        cx: (r.left + r.right) / 2 - m.left, cy: (r.top + r.bottom) / 2 - m.top, w: r.width, h: r.height,
      };
    }
    const vertical = () => window.matchMedia('(max-width: 720px)').matches;
    const poly = (pts) => 'M' + pts.map((p) => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' L');

    function corner(pts, rad) {
      let d = 'M' + pts[0][0] + ' ' + pts[0][1];
      for (let i = 1; i < pts.length - 1; i++) {
        const a = pts[i - 1], b = pts[i], c = pts[i + 1];
        const r1 = Math.min(rad, Math.hypot(b[0] - a[0], b[1] - a[1]) / 2, Math.hypot(c[0] - b[0], c[1] - b[1]) / 2);
        const ux = Math.sign(b[0] - a[0]), uy = Math.sign(b[1] - a[1]);
        const vx = Math.sign(c[0] - b[0]), vy = Math.sign(c[1] - b[1]);
        d += ' L' + (b[0] - ux * r1) + ' ' + (b[1] - uy * r1) + ' Q' + b[0] + ' ' + b[1] + ' ' + (b[0] + vx * r1) + ' ' + (b[1] + vy * r1);
      }
      const z = pts[pts.length - 1];
      return d + ' L' + z[0] + ' ' + z[1];
    }

    // One loop: a trochoid (a point on a rolling wheel), leaning forward.
    function loopPts(P, H) {
      const r = P / (2 * Math.PI), d = r / 0.3, k = H / (2 * d), out = [];
      for (let i = 0; i <= 96; i++) {
        const t = (i / 96) * 2 * Math.PI, u = k * d * (1 - Math.cos(t));
        out.push([r * t + d * Math.sin(t) + u * LEAN, u]);
      }
      return out;
    }

    function add(d, cls, start, dur, group) {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      p.setAttribute('class', cls);
      svg.appendChild(p);
      pieces.push({ el: p, start, dur, group, cls });
    }
    function dot(x, y, r, full, group, start) {
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', x);
      c.setAttribute('cy', y);
      c.setAttribute('r', r);
      c.setAttribute('class', 'late' + (full ? ' full' : ''));
      svg.appendChild(c);
      pieces.push({ el: c, start, group, circle: true });
    }
    function label(x, y, text, group, start) {
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('x', x);
      t.setAttribute('y', y);
      t.setAttribute('class', 'late');
      t.textContent = text;
      svg.appendChild(t);
      pieces.push({ el: t, start, group, circle: true });
    }
    function tick(x, y, group, start) {
      add('M' + (x - 6) + ' ' + (y + 0.5) + ' l4.3 4.3 l8 -8.8', 'tick', start, 0.18, group);
    }

    // A small row: plan dashed, the yes, n loops, a knot.
    function rowThread(el, group, V) {
      const r = rel(el), n = parseInt(el.getAttribute('data-n'), 10), ghost = el.hasAttribute('data-ghost');
      const B = r.t + (V ? 40 : 58), x = r.l;
      const P = V ? 40 : 70, H = V ? 36 : 54, gap = V ? 6 : 12;
      const yesX = x + (V ? 34 : 64), s0 = yesX + (V ? 16 : 34);
      const endX = V ? r.r - 10 : Math.min(r.r - 20, s0 + 5 * (P + gap) + 120);
      add(poly([[x, B], [yesX - 8, B]]), 'dash', 0.05, 0.3, group);
      dot(yesX, B, 6, true, group, 0.35);
      add(poly([[yesX, B], [s0, B]]), 'solid', 0.38, 0.1, group);
      let t = 0.48, real2 = null, cur = s0, low = B;
      const fix = el.hasAttribute('data-fix');
      for (let k = 0; k < n; k++) {
        const base = cur, gh = ghost && k === 0, back = fix && k === 1;
        const pts = loopPts(P, H).map((q) => [base + q[0], B - q[1]]);
        add(poly(pts), gh ? 'ghost' : 'solid', t, 0.22, group);
        cur = base + P;
        const tx = base + P / 2 + H * 0.6 * LEAN, ty = B - H * 0.6;
        if (back) {
          // Round 2 found weak tests: an open circle instead of a tick, then a
          // smaller, thinner bow back under the line (the fix pass, not a fourth round).
          dot(tx, ty, 5, false, group, t + 0.24);
        } else if (!gh) {
          tick(tx, ty, group, t + 0.24);
        }
        if (k === 1) real2 = tx;
        if (back) {
          const P2 = P * 0.8, H2 = H * 0.72, x0 = cur;
          const rb = P2 / (2 * Math.PI), db = rb / 0.17, kb = H2 / (2 * db), bp = [];
          for (let j = 0; j <= 120; j++) {
            const tb = (j / 120) * 2 * Math.PI, ub = kb * db * (1 - Math.cos(tb));
            bp.push([x0 + rb * tb + db * Math.sin(tb) - ub * 0.55, B + ub]);
          }
          add(poly(bp), 'thin fixloop', t + 0.24, 0.5, group);
          const bx = x0 + P2 / 2 - H2 * 0.55, by = B + H2;
          tick(x0 + P2 / 2 - H2 * 0.3 - 3, B + H2 * 0.5, group, t + 0.74);
          label(x0 + P2 + 8, B + H2 * 0.62, document.documentElement.lang === 'de' ? 'Korrektur' : 'Fix pass', group, t + 0.74);
          real2 = bx;
          low = by;
          cur = x0 + P2;
          t += 0.56;
        }
        add(poly([[cur, B], [cur + gap, B]]), gh ? 'ghost' : 'solid', t + 0.22, 0.04, group);
        cur += gap;
        t += 0.27;
      }
      const sEnd = cur - gap;
      add(poly([[sEnd, B], [endX, B]]), 'solid', t, 0.18, group);
      dot(endX, B, 6, true, group, t + 0.18);
      if (el.hasAttribute('data-real') && real2 !== null) {
        const co = document.getElementById('callout');
        co.style.marginLeft = V ? '0px' : Math.max(0, real2 - r.l - 2) + 'px';
        co.style.marginTop = (low - r.t + (V ? 30 : 34)) + 'px';
        const cr = rel(co), y0 = low + 8, yk = low + (V ? 18 : 20);
        const cx = V ? r.l + 2 : real2;
        const path = [[real2, y0], [real2, yk], [cx, yk], [cx, cr.t + 6]]
          .filter((p, i, a) => i === 0 || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]);
        add(poly(path), 'thin', t + 0.1, 0.3, group);
      }
    }

    // Lead band: three sessions, each in rounds, run into one knot, the Inbox.
    function leadFig(V) {
      const f = rel(document.getElementById('lead-fig'));
      const kx = f.r, ky = f.t + f.h / 2, D = V ? 30 : 40, P = V ? 30 : 44, H = V ? 27 : 38;
      const xm = kx - (V ? 92 : 170);
      [[-1, 0.1], [0, 0.42], [1, 0.24]].forEach((row, i) => {
        const y = ky + row[0] * D, x0 = f.l, lx = x0 + (xm - x0 - P) * row[1] + (V ? 6 : 20);
        const pts = [[x0, y]].concat(loopPts(P, H).map((q) => [lx + q[0], y - q[1]]), [[xm, y]]);
        const c = (kx - xm) * 0.55;
        const d = poly(pts) + ' C' + (xm + c).toFixed(1) + ' ' + y.toFixed(1) + ' ' + (kx - c).toFixed(1) + ' ' + ky.toFixed(1) + ' ' + (kx - 9).toFixed(1) + ' ' + ky.toFixed(1);
        add(d, i === 1 ? 'solid' : 'thin', 0.1 + i * 0.08, 0.9, 'lead');
      });
      dot(kx, ky, 8, true, 'lead', 1.05);
    }

    // Section 2: a stitch from the /close line to the backlog line it names.
    function stitch(V) {
      const from = document.getElementById('from'), to = document.getElementById('to');
      const file = document.getElementById('file'), said = document.querySelector('.said');
      const mm = main.getBoundingClientRect();
      const lastRect = (el) => { const rs = el.getClientRects(); return rs[rs.length - 1]; };
      if (!V) {
        const comma = document.getElementById('comma');
        let fy = (lastRect(from).top + lastRect(from).bottom) / 2 - mm.top;
        const ty = rel(to).cy;
        const fm = parseFloat(file.style.marginTop || 0), sm = parseFloat(said.style.marginTop || 0);
        let d = fy - ty;
        if (d > 0.5) {
          if (sm >= d) said.style.marginTop = (sm - d) + 'px';
          else { said.style.marginTop = ''; file.style.marginTop = (fm + d - sm) + 'px'; }
        } else if (d < -0.5) {
          d = -d;
          if (fm >= d) file.style.marginTop = (fm - d) + 'px';
          else { file.style.marginTop = ''; said.style.marginTop = (sm + d - fm) + 'px'; }
        }
        fy = (lastRect(from).top + lastRect(from).bottom) / 2 - mm.top;
        const fx = comma.getBoundingClientRect().right - mm.left;
        const tr = rel(to), pr = rel(document.getElementById('proof'));
        const midX = pr.l + (pr.w - 120) / 2 + 60;
        add(poly([[fx + 10, fy], [tr.l - 34, fy]]), 'solid', 0.9, 0.45, 's2');
        dot(midX, fy, 6, true, 's2', 1.2);
        return { midX, fy };
      }
      file.style.marginTop = '';
      said.style.marginTop = '';
      const X = rel(zone.querySelector('.dot')).cx;
      const fR = from.getClientRects(), tR = to.getClientRects();
      const fy2 = (fR[fR.length - 1].top + fR[fR.length - 1].bottom) / 2 - mm.top;
      const ty2 = (tR[0].top + tR[0].bottom) / 2 - mm.top;
      add(poly([[X, fy2], [rel(said).l - 8, fy2]]), 'solid', 0.5, 0.25, 's2');
      add(poly([[X, ty2], [rel(file).l - 8, ty2]]), 'solid', 0.7, 0.25, 's2');
      return { midX: X, fy: fy2 };
    }

    // A lesson: dashed up to your yes, solid after it.
    function lessonLine() {
      const ds = document.querySelectorAll('#stops .sdot');
      const a = rel(ds[0]), b = rel(ds[1]), c = rel(ds[2]);
      add(poly([[a.cx, a.cy], [b.cx, b.cy]]), 'dash', 1.2, 0.4, 's2');
      dot(a.cx, a.cy, 5, false, 's2', 1.15);
      dot(b.cx, b.cy, 7, true, 's2', 1.6);
      add(poly([[b.cx, b.cy], [c.cx, c.cy]]), 'solid', 1.65, 0.35, 's2');
      dot(c.cx, c.cy, 5, true, 's2', 2.0);
    }

    function layout() {
      const m = main.getBoundingClientRect();
      svg.setAttribute('viewBox', '0 0 ' + m.width + ' ' + m.height);
      svg.setAttribute('width', m.width);
      svg.setAttribute('height', m.height);
      const V = vertical();
      const dots = zone.querySelectorAll('.dot');
      const ask = rel(dots[0]), yes = rel(dots[1]), done = rel(dots[2]);
      const rr = rel(document.getElementById('rounds-st'));
      const gap = V ? 10 : 14, n = 3;
      let P, H, map, s0, s1;
      if (!V) {
        const B = ask.cy;
        P = Math.min(104, (rr.w - 4 * gap) / 5);
        H = Math.min(104, P);
        map = (s, u) => [s, B - u];
        const groupW = n * P + (n - 1) * gap;
        s0 = rr.l + (rr.w - groupW) / 2;
        s1 = s0 + groupW;
        add(poly([[0, B], [ask.cx, B]]), 'solid', 0, 0.16, 'hero');
        add(poly([[ask.cx + 9, B], [yes.cx - 13, B]]), 'dash', 0.22, 0.46, 'hero');
        add(poly([[yes.cx, B], [s0, B]]), 'solid', 0.78, 0.14, 'hero');
      } else {
        const X = ask.cx;
        P = 62;
        H = 62;
        map = (s, u) => [X + u, s];
        s0 = rr.t + 18;
        s1 = s0 + n * P + (n - 1) * gap;
        add(poly([[X, ask.cy - 40], [X, ask.cy]]), 'solid', 0, 0.16, 'hero');
        add(poly([[X, ask.cy + 9], [X, yes.cy - 13]]), 'dash', 0.22, 0.46, 'hero');
        add(poly([[X, yes.cy], [X, s0]]), 'solid', 0.78, 0.14, 'hero');
      }
      const t0 = 0.9, per = 0.85 / n;
      for (let k = 0; k < n; k++) {
        const base = s0 + k * (P + gap);
        add(poly(loopPts(P, H).map((q) => map(base + q[0], q[1]))), 'solid', t0 + k * per, per * 0.86, 'hero');
        if (k < n - 1) add(poly([map(base + P, 0), map(base + P + gap, 0)]), 'solid', t0 + k * per + per * 0.86, per * 0.14, 'hero');
        const c = map(base + P / 2 + H * 0.6 * LEAN, H * 0.6);
        tick(c[0], c[1], 'hero', t0 + (k + 1) * per - 0.05);
      }

      // The thread through the page: a crossing at each section start, vertical at the edge in between.
      const secs = ['how', 'next', 'install', 'made'].map((id) => rel(document.getElementById(id)));
      const xL = 18, xR = m.width - 18;
      const g2 = stitch(V);
      if (!V) {
        const Bh = ask.cy, run = (i) => secs[i].t + 56;
        add(poly([[s1, Bh], [done.cx, Bh]]), 'solid', t0 + 0.85, 0.14, 'hero');
        add(corner([[done.cx, Bh], [xR, Bh], [xR, secs[0].t]], 46), 'solid', t0 + 0.99, 0.4, 'hero');
        add(corner([[xR, secs[0].t], [xR, run(0)], [xL, run(0)], [xL, secs[1].t]], 46), 'solid', 0, 1.1, 's1');
        add(corner([[xL, secs[1].t], [xL, run(1)], [g2.midX, run(1)], [g2.midX, secs[2].t]], 46), 'solid', 0, 1.2, 's2');
        add(corner([[g2.midX, secs[2].t], [g2.midX, run(2)], [xR, run(2)], [xR, secs[3].t]], 46), 'solid', 0, 1.0, 's3');
        const endX = rel(document.getElementById('made-h')).l + 6;
        add(corner([[xR, secs[3].t], [xR, run(3)], [endX, run(3)]], 46), 'solid', 0, 0.9, 's4');
        dot(endX, run(3), 7, true, 's4', 0.9);
      } else {
        const Xv = ask.cx;
        add(poly([[Xv, s1], [Xv, done.cy]]), 'solid', t0 + 0.85, 0.14, 'hero');
        add(poly([[Xv, done.cy], [Xv, secs[0].t]]), 'solid', t0 + 0.99, 0.4, 'hero');
        add(poly([[Xv, secs[0].t], [Xv, secs[1].t]]), 'solid', 0, 1.2, 's1');
        add(poly([[Xv, secs[1].t], [Xv, secs[2].t]]), 'solid', 0, 1.2, 's2');
        add(poly([[Xv, secs[2].t], [Xv, secs[3].t]]), 'solid', 0, 1, 's3');
        const endY = rel(document.getElementById('limits')).b;
        add(poly([[Xv, secs[3].t], [Xv, endY]]), 'solid', 0, 0.9, 's4');
        dot(Xv, endY, 7, true, 's4', 0.9);
      }
      document.querySelectorAll('.job-line').forEach((el) => rowThread(el, 's1', V));
      lessonLine();
      leadFig(V);
    }

    function prepare(pc) {
      if (pc.circle) return;
      const p = pc.el, L = p.getTotalLength();
      if (pc.cls.indexOf('dash') > -1) {
        const arr = [];
        let acc = 0;
        while (acc < L) { arr.push(7, 8); acc += 15; }
        arr.push(0, L + 20);
        p.style.strokeDasharray = arr.join(' ');
        pc.off = acc;
      } else {
        p.style.strokeDasharray = L + ' ' + (L + 20);
        pc.off = L;
      }
      p.style.strokeDashoffset = pc.off;
    }
    function show(pc, anim, delay) {
      if (pc.circle) {
        if (anim) later(() => pc.el.classList.add('on'), delay);
        else { pc.el.style.transition = 'none'; pc.el.classList.add('on'); }
        return;
      }
      const p = pc.el;
      if (!anim) { p.style.transition = 'none'; p.style.strokeDashoffset = 0; return; }
      p.getBoundingClientRect();
      p.style.transition = 'stroke-dashoffset ' + pc.dur + 's cubic-bezier(.45,0,.35,1) ' + delay + 's';
      p.style.strokeDashoffset = 0;
    }
    function play(group) {
      drawn[group] = true;
      pieces.forEach((pc) => { if (pc.group === group) show(pc, !reduce, pc.start); });
    }

    function build(animate) {
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      pieces = [];
      document.documentElement.classList.add('measuring');
      // Two passes: the first sets spacing (stitch, callout), the second measures the settled page.
      try {
        layout();
        while (svg.firstChild) svg.removeChild(svg.firstChild);
        pieces = [];
        layout();
      } finally {
        document.documentElement.classList.remove('measuring');
      }
      const mEnd = main.getBoundingClientRect();
      svg.setAttribute('viewBox', '0 0 ' + mEnd.width + ' ' + mEnd.height);
      svg.setAttribute('width', mEnd.width);
      svg.setAttribute('height', mEnd.height);
      pieces.forEach(prepare);
      pieces.forEach((pc) => { if (reduce || !animate || drawn[pc.group]) show(pc, false); });
      if (animate && !reduce) play('hero');
    }

    function setCard(open) {
      stYes.classList.toggle('open', open);
      yesDot.setAttribute('aria-expanded', String(open));
    }

    // Labels appear along the line; the real-run note opens once the line is drawn.
    function showLabels() {
      document.querySelectorAll('.run').forEach((el) => {
        if (reduce) { el.classList.add('on'); return; }
        later(() => el.classList.add('on'), parseFloat(el.getAttribute('data-t') || 0));
      });
      if (reduce) { yesDot.classList.add('said-yes'); setCard(true); return; }
      setCard(false);
      later(() => yesDot.classList.add('said-yes'), 0.76);
      later(() => setCard(true), 2.4);
    }

    // Reduced motion turned on with the page open: finish everything at once.
    function settle() {
      timers.forEach((id) => window.clearTimeout(id));
      timers.length = 0;
      ['hero', 's1', 's2', 's3', 'lead', 's4'].forEach((g) => { drawn[g] = true; });
      pieces.forEach((pc) => show(pc, false));
      document.querySelectorAll('.run').forEach((el) => el.classList.add('on'));
      yesDot.classList.add('said-yes');
      setCard(true);
    }

    let labelsShown = false;
    function revealLabels() {
      if (labelsShown) return;
      labelsShown = true;
      showLabels();
    }

    function start() {
      try {
        build(true);
        built = true;
      } finally {
        // Labels start with the line; if build throws they still appear.
        revealLabels();
      }
      const r0 = main.getBoundingClientRect();
      lastH = r0.height;
      lastW = r0.width;
      const groups = ['s1', 's2', 's3', 'lead', 's4'];
      if ('IntersectionObserver' in window && !reduce) {
        const io = new IntersectionObserver((entries) => {
          entries.forEach((e) => {
            if (!e.isIntersecting) return;
            const g = e.target.getAttribute('data-group');
            if (!drawn[g]) play(g);
            io.unobserve(e.target);
          });
        }, { rootMargin: '0px 0px -20% 0px' });
        later(() => groups.forEach((g) => io.observe(document.querySelector('[data-group="' + g + '"]'))), 1.5);
      } else {
        groups.forEach((g) => { drawn[g] = true; });
      }
    }

    try {
      yesDot.addEventListener('click', () => setCard(!stYes.classList.contains('open')));
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && stYes.classList.contains('open') && stYes.contains(document.activeElement)) setCard(false);
      });
      const motionChange = (e) => {
        reduce = e.matches;
        if (reduce && built) settle();
      };
      if (typeof motion.addEventListener === 'function') motion.addEventListener('change', motionChange);
      else if (typeof motion.addListener === 'function') motion.addListener(motionChange);

      // Redraw on every size change (window, tab switch, font), without motion.
      function relayout() {
        window.clearTimeout(rt);
        rt = window.setTimeout(() => { if (built) build(false); }, 60);
      }
      window.addEventListener('resize', relayout);
      if ('ResizeObserver' in window) {
        new ResizeObserver(() => {
          const r = main.getBoundingClientRect();
          if (Math.abs(r.height - lastH) > 2 || Math.abs(r.width - lastW) > 2) {
            lastH = r.height;
            lastW = r.width;
            if (built) relayout();
          }
        }).observe(main);
      }
      (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve())
        .then(() => window.requestAnimationFrame(start))
        .catch(revealLabels);
    } catch (err) {
      // Wiring failed before the line could start: show the text, keep no line.
      revealLabels();
      throw err;
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
}());
