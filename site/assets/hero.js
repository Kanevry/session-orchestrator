// Hero: five blocks, four gates, one token that walks the row and is checked at
// every gate. Contract: docs/plans/2026-09-07-site-redesign-contract.md s.5.
// Q3 MED-3: three.js is imported lazily inside init() — a reduced-motion visit
// must never download the renderer.

const BLOCK_X = [-4, -2, 0, 2, 4];  // the five passes, spacing 2.0
const BLOCK_W = 1.2;  // Design M3: narrower than the spacing, so a 0.8 gap shows
const GATE_X = [-3, -1, 1, 3];  // midpoints of that gap
const TOKEN_Y = 0.75;  // the token rides above the row
const ROW_W = 9.6, FILL = 0.82;  // the row spans 82% of the container width
const SCENE_H = 1.0, VFILL = 0.55;  // ...and the scene fills 55% of its height
const GATE_Y = -0.05, GATE_DROP = 0.15;  // open panels drop, not tuck in
const GATE_SHUT = 0.10, GATE_OPEN = 0.30;  // centred in the 0.8 gap
const TOKENS = [['bg', '#F5F1EA'], ['fg', '#171412'], ['accent', '#1E3A5F'],
  ['run', '#8a5a00'], ['hold', '#a3301c'], ['pass', '#1d6b39'],
  ['code-bg', '#E8E0D2'], ['surface', '#241F1B']];

let THREE = null;

// Tokens are oklch(); setStyle cannot parse it, so let the browser resolve the
// colour on a 1x1 2D canvas and read the painted pixel back.
const pctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });

function cssColor(name, fb) {
  const c = new THREE.Color();
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name);
    pctx.fillStyle = fb;
    pctx.fillStyle = raw.trim() || fb;  // bad syntax keeps fb
    pctx.fillRect(0, 0, 1, 1);
    const d = pctx.getImageData(0, 0, 1, 1).data;
    return c.setRGB(d[0] / 255, d[1] / 255, d[2] / 255, THREE.SRGBColorSpace);
  } catch { return c.setStyle(fb); }
}

// One pass over the row, then a settle, then loop: about 11 s.
const SEG = [{ k: 'appear', d: 0.8 }];
for (let i = 0; i < 4; i++) {
  SEG.push({ k: 'travel', i, d: 1.1 }, { k: 'check', i, d: 0.5 },
    { k: 'open', i, d: 0.3 }, { k: 'exit', i, d: 0.4 });
}
SEG.push({ k: 'settle', d: 1.7 });  // 1.2 s at rest, then 0.5 s fade

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const lerp = (a, b, t) => a + (b - a) * t;
const tint = (m, c) => { m.color.copy(c); m.emissive.copy(c); };
const mesh = (g, m, x, y) => { const o = new THREE.Mesh(g, m); o.position.set(x, y || 0, 0); return o; };
const announce = (el, s) => {
  el.dataset.heroState = s;
  el.dispatchEvent(new CustomEvent('hero:ready', { detail: s }));
};

// Static SVG instead of the canvas: reduced motion, no WebGL, or a thrown error.
function still(el, state) {
  if (el.dataset.heroState === state) return;
  const c = el.querySelector('canvas');
  if (c) c.style.display = 'none';
  if (!el.querySelector('img.hero-fallback')) {
    el.insertAdjacentHTML('beforeend',
      '<img class="hero-fallback" src="/assets/hero-fallback.svg" alt="" width="960" height="400">');
  }
  announce(el, state);
}
const fallback = (el) => still(el, 'fallback');

function build(el, canvas) {
  // Probe on a scratch canvas so a failure never touches the real one.
  const s = document.createElement('canvas');
  if (!(s.getContext('webgl2') || s.getContext('webgl'))) return fallback(el);
  const gl = new THREE.WebGLRenderer({
    canvas, antialias: true, alpha: true, powerPreference: 'high-performance',
  });
  gl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  gl.outputColorSpace = THREE.SRGBColorSpace;
  gl.toneMapping = THREE.NeutralToneMapping;
  gl.setClearAlpha(0);  // the CSS background shows through
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-5, 5, 3, -3, 0.1, 100);
  camera.position.set(0, 1.6, 8);
  camera.lookAt(0, 0.15, 0);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.1);
  const dir = new THREE.DirectionalLight(0xffffff, 1.2);
  dir.position.set(2, 3, 4);
  scene.add(hemi, dir);

  // Shared geometry, one material per role.
  const geos = {
    block: new THREE.BoxGeometry(BLOCK_W, 1, 0.5),
    panel: new THREE.BoxGeometry(0.18, 0.9, 0.5),
    token: new THREE.IcosahedronGeometry(0.3, 0),
    shadow: new THREE.PlaneGeometry(BLOCK_W * 1.25, 0.35),
  };
  const std = (o) => new THREE.MeshStandardMaterial(o);
  const blockMat = std({ roughness: 0.85, metalness: 0 });
  const topMat = std({ roughness: 0.85, metalness: 0 });
  const shadowMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.12 });
  const tokenMat = std({ roughness: 0.35, emissiveIntensity: 0.9 });
  const gateMats = GATE_X.map(() => std({ roughness: 0.5, emissiveIntensity: 0.6 }));
  const white = new THREE.Color(1, 1, 1);
  const darkQ = window.matchMedia('(prefers-color-scheme: dark)');

  // Palette, re-read when the colour scheme flips.
  const pal = {};
  const readPalette = () => TOKENS.forEach(([n, f]) => { pal[n] = cssColor('--' + n, f); });
  const applyPalette = () => {
    hemi.color.copy(pal.bg); hemi.groundColor.copy(pal.fg);
    // Design M3: warm sand, not taupe — the code surface pulled 30% towards ink,
    // so the blocks read as objects on the page rather than as a wall.
    const base = darkQ.matches ? pal.surface : pal['code-bg'];
    blockMat.color.copy(base).lerp(pal.fg, 0.30);
    topMat.color.copy(blockMat.color).lerp(white, 0.08);  // top face 8% lighter
    shadowMat.color.copy(pal.fg);
    tint(tokenMat, pal.run);
    gateMats.forEach((m) => tint(m, pal.accent));
  };
  readPalette();
  applyPalette();
  // BoxGeometry face order +X -X +Y -Y +Z -Z: index 2 is the top.
  const faces = [blockMat, blockMat, topMat, blockMat, blockMat, blockMat];
  BLOCK_X.forEach((x) => {
    scene.add(mesh(geos.block, faces, x));
    const sh = mesh(geos.shadow, shadowMat, x, -0.51);  // contact shadow
    sh.rotation.x = -Math.PI / 2;
    scene.add(sh);
  });

  // Each gate is two panels, centred in the gap between two blocks.
  const gates = GATE_X.map((x, i) => {
    const g = { x, mat: gateMats[i], left: mesh(geos.panel, gateMats[i], x - GATE_SHUT, GATE_Y),
      right: mesh(geos.panel, gateMats[i], x + GATE_SHUT, GATE_Y) };
    scene.add(g.left, g.right);
    return g;
  });
  // e = 0 shut, e = 1 open: panels part a little and slide down.
  const poseGate = (g, e) => {
    const gap = lerp(GATE_SHUT, GATE_OPEN, e), y = GATE_Y - GATE_DROP * e;
    g.left.position.set(g.x - gap, y, 0);
    g.right.position.set(g.x + gap, y, 0);
  };
  const setGate = (g, open, colour) => { poseGate(g, open ? 1 : 0); tint(g.mat, colour); };
  const token = mesh(geos.token, tokenMat, BLOCK_X[0], TOKEN_Y);
  scene.add(token);

  // Q3 LOW-1: frame on the tighter of the two fits, so the scene fills the box
  // vertically as well as horizontally instead of floating in a wide letterbox.
  const resize = () => {
    const w = Math.max(1, el.clientWidth), h = Math.max(1, el.clientHeight);
    const viewW = ROW_W / FILL, viewH = Math.max(viewW * h / w, SCENE_H / VFILL);
    const halfW = Math.max(viewW, viewH * w / h) / 2;
    camera.left = -halfW; camera.right = halfW;
    camera.top = viewH / 2; camera.bottom = -viewH / 2;
    camera.updateProjectionMatrix();
    gl.setSize(w, h, false);
  };
  resize();
  let seg = 0, acc = 0, raf = 0, last = 0, visible = true, onScreen = true;

  function tick(dt) {
    acc += dt;
    let s2 = SEG[seg];
    while (acc >= s2.d) {  // advance the state machine
      acc -= s2.d;
      seg = (seg + 1) % SEG.length;
      if (seg === 0) gates.forEach((g) => setGate(g, false, pal.accent));  // new loop
      s2 = SEG[seg];
    }
    const u = acc / s2.d;  // 0..1 inside this segment
    const i = s2.i || 0;
    token.position.y = TOKEN_Y;

    switch (s2.k) {
    case 'appear': {
      token.position.x = BLOCK_X[0];
      token.scale.setScalar(ease(u));
      tint(tokenMat, pal.run);
      break; }
    case 'travel':
      token.scale.setScalar(1);
      token.position.x = lerp(BLOCK_X[i], GATE_X[i], ease(u));
      break;
    case 'check': {
      token.position.x = GATE_X[i];
      const p = 0.5 - 0.5 * Math.cos(4 * Math.PI * acc);  // 2 Hz, never faster
      tint(gates[i].mat, pal.accent.clone().lerp(pal.hold, p));
      break; }
    case 'open': {
      const e = ease(u);
      poseGate(gates[i], e);
      tint(gates[i].mat, pal.accent.clone().lerp(pal.pass, e));
      tint(tokenMat, pal.run.clone().lerp(pal.pass, e));
      break; }
    case 'exit':
      setGate(gates[i], true, pal.pass);
      token.position.x = lerp(GATE_X[i], BLOCK_X[i + 1], ease(u));
      tint(tokenMat, pal.pass.clone().lerp(pal.run, ease(u)));
      break;
    default: {  // settle: land, rest, fade
      token.position.x = BLOCK_X[4];
      const t = acc;  // seconds into the segment
      token.position.y = TOKEN_Y + Math.sin(Math.min(1, t / 0.6) * Math.PI) * 0.14;
      token.scale.setScalar(Math.max(0, 1 - Math.max(0, t - 1.2) / 0.5));
    }
    }
    token.rotation.y += dt * 1.2;
    gl.render(scene, camera);
  }
  const frame = (now) => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;
    tick(dt);
  };
  const play = () => {
    if (raf || !visible || !onScreen) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  };
  const pause = () => { if (raf) { cancelAnimationFrame(raf); raf = 0; } };
  darkQ.addEventListener('change', () => {
    readPalette();
    applyPalette();
    if (!raf) gl.render(scene, camera);
  });
  new ResizeObserver(() => { resize(); if (!raf) gl.render(scene, camera); }).observe(el);
  window.addEventListener('pagehide', () => {
    pause();
    Object.values(geos).forEach((g) => g.dispose());
    [blockMat, topMat, shadowMat, tokenMat, ...gateMats].forEach((m) => m.dispose());
    gl.dispose();
  }, { once: true });
  new IntersectionObserver((es) => {
    onScreen = es.some((e) => e.isIntersecting);
    if (onScreen) play(); else pause();
  }, { threshold: 0.01 }).observe(el);
  document.addEventListener('visibilitychange', () => {
    visible = !document.hidden;
    if (visible) play(); else pause();
  });
  play();
  announce(el, 'running');
}

async function init() {
  const el = document.getElementById('hero');
  if (!el) return;
  // Q3 MED-3: decide BEFORE the import, so reduced motion costs zero bytes.
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    still(el, 'static');
    return;
  }
  const canvas = el.querySelector('canvas');
  if (!canvas) { fallback(el); return; }
  try {
    THREE = await import('/vendor/three.module.min.js');
  } catch { fallback(el); return; }
  try { build(el, canvas); } catch { fallback(el); }
}

init();
