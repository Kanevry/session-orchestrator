// "How it works": one task walks through the five steps of a session.
// The ordered list in the markup carries every word; this file only adds
// motion. Wide screens with WebGL get a small three.js model, everything
// else keeps the inline SVG, where a CSS transition moves the token.
// three.js is imported lazily and only when the model is allowed to run, so
// a reduced-motion or narrow visit never downloads the renderer.

const STEPS = 5;
const WIDE = '(min-width: 760px)';
const STILL = '(prefers-reduced-motion: reduce)';

// Station x positions along the row; Go has three lanes at z -1 / 0 / 1.
const SX = [-6, -3, 0, 3, 6];
const LANES = [-1.1, 0, 1.1];
const COL = {
  base: 0x1c1e21, top: 0x454a51, line: 0x5a6068, fg: 0xd6d9dc,
  lime: 0xd5f478, fail: 0xff7a59, done: 0xf5f3ee,
};

// Timeline in seconds. `step` is the list item it belongs to.
function timeline(withFailure) {
  const t = [
    { k: 'read', step: 0, d: 1.8 },
    { k: 'toPlan', step: 1, d: 0.9 },
    { k: 'yes', step: 1, d: 1.3 },
    { k: 'split', step: 2, d: 1.0 },
    { k: 'work', step: 2, d: 1.6 },
    { k: 'toCheck', step: 3, d: 0.9 },
    { k: 'check', step: 3, d: 0.9 },
  ];
  if (withFailure) t.push({ k: 'back', step: 3, d: 1.1 }, { k: 'fix', step: 3, d: 1.1 }, { k: 'check', step: 3, d: 0.8 });
  t.push({ k: 'merge', step: 4, d: 0.8 }, { k: 'close', step: 4, d: 1.4 }, { k: 'next', step: 4, d: 1.6 });
  return t;
}

const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
const lerp = (a, b, u) => a + (b - a) * u;

function setup(root) {
  const fig = root.querySelector('.how-model');
  const items = [...root.querySelectorAll('.how-step')];
  const buttons = [...root.querySelectorAll('.how-step-btn')];
  const playBtn = root.querySelector('[data-action="play"]');
  const failBtn = root.querySelector('[data-action="fail"]');
  const status = root.querySelector('.how-status');
  const de = document.documentElement.lang === 'de';
  const label = {
    play: de ? 'Abspielen' : 'Play', pause: de ? 'Pause' : 'Pause',
  };
  const still = window.matchMedia(STILL).matches;

  let active = -1;
  let engine = null;  // { jump(step), setFailure(bool), play(), pause() }
  let playing = !still;
  let failure = false;

  function show(step, fromEngine) {
    if (step === active) return;
    active = step;
    items.forEach((li, i) => {
      if (i === step) li.setAttribute('aria-current', 'step');
      else li.removeAttribute('aria-current');
    });
    fig.dataset.step = String(step);
    if (!fromEngine && engine) engine.jump(step);
  }
  function setPlaying(p) {
    playing = p;
    if (playBtn) {
      // The label says what a press does next; no aria-pressed on top of it.
      playBtn.textContent = p ? label.pause : label.play;
    }
    if (engine) (p ? engine.play() : engine.pause());
  }

  buttons.forEach((b, i) => b.addEventListener('click', () => {
    show(i);
    if (status) status.textContent = items[i].querySelector('h3').textContent.trim();
  }));
  if (playBtn) playBtn.addEventListener('click', () => setPlaying(!playing));
  if (failBtn) failBtn.addEventListener('click', () => {
    failure = !failure;
    failBtn.setAttribute('aria-pressed', String(failure));
    fig.classList.toggle('is-failing', failure);
    if (engine) engine.setFailure(failure);
    show(3);
  });
  root.querySelectorAll('.how-controls').forEach((c) => { c.hidden = false; });
  show(0);

  const onStep = (s) => show(s, true);
  const wide = window.matchMedia(WIDE).matches;
  const canvas = fig.querySelector('canvas');
  if (!still && wide && canvas && hasWebGL()) {
    import('/vendor/three.module.min.js')
      .then((THREE) => {
        engine = model(THREE, fig, canvas, onStep);
        engine.setFailure(failure);
        if (active > 0) engine.jump(active);
        fig.dataset.mode = '3d';
        if (playing) engine.play(); else engine.pause();
      })
      .catch(() => { engine = ticker(fig, onStep); fig.dataset.mode = 'svg'; setPlaying(playing); });
  } else {
    engine = ticker(fig, onStep);
    fig.dataset.mode = 'svg';
  }
  setPlaying(playing);
}

function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    return Boolean(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { return false; }
}

// SVG mode: step forward while playing, on screen and in a visible tab. The
// check step lingers longer when the failing-test toggle is on.
function ticker(fig, onStep) {
  let step = 0, timer = 0, failure = false, wanted = false, onScreen = true, visible = !document.hidden;
  const stop = () => { if (timer) { window.clearTimeout(timer); timer = 0; } };
  const schedule = () => {
    stop();
    if (!wanted || !onScreen || !visible) return;
    timer = window.setTimeout(() => {
      timer = 0;
      step = (step + 1) % STEPS;
      onStep(step);
      schedule();
    }, failure && step === 3 ? 4200 : 2800);
  };
  new IntersectionObserver((es) => {
    onScreen = es.some((e) => e.isIntersecting);
    schedule();
  }, { threshold: 0.05 }).observe(fig);
  document.addEventListener('visibilitychange', () => { visible = !document.hidden; schedule(); });
  return {
    jump(s) { step = s; schedule(); },
    setFailure(f) { failure = f; schedule(); },
    play() { wanted = true; schedule(); },
    pause() { wanted = false; stop(); },
  };
}

// three.js mode.
function model(THREE, fig, canvas, onStep) {
  const gl = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  gl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  gl.outputColorSpace = THREE.SRGBColorSpace;
  gl.setClearAlpha(0);
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-8, 8, 4.5, -4.5, 0.1, 100);
  camera.position.set(3.5, 7, 11);
  camera.lookAt(0, -0.2, 0);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x2a2d31, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(4, 8, 6);
  scene.add(sun);

  const disposables = [];
  const std = (color, extra = {}) => {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.05, ...extra });
    disposables.push(m);
    return m;
  };
  const box = (w, h, d, mat, x, y, z) => {
    const g = new THREE.BoxGeometry(w, h, d);
    disposables.push(g);
    const o = new THREE.Mesh(g, mat);
    o.position.set(x, y, z);
    scene.add(o);
    return o;
  };

  // Platform and the five stations.
  box(16, 0.3, 5.6, std(COL.base), 0, -0.65, 0);
  const stationMat = std(COL.top);
  SX.forEach((x, i) => {
    if (i === 2) LANES.forEach((z) => box(1.0, 0.5, 0.7, stationMat, x, -0.25, z));
    else box(1.6, 0.5, 1.6, stationMat, x, -0.25, 0);
  });
  // Read: a small stack of files. Close: a tray for done work, one for issues.
  const fileMat = std(COL.fg);
  [0, 1, 2].forEach((k) => box(0.9, 0.06, 1.1, fileMat, SX[0] - 0.1 + k * 0.08, 0.05 + k * 0.09, 0));
  const doneTray = box(1.2, 0.18, 1.2, std(COL.line), SX[4], 0.09, -0.25);
  const issueTray = box(0.6, 0.12, 0.6, std(COL.line), SX[4] + 0.55, 0.06, 0.95);

  // Gates: "your yes" after Plan, "tests" before Check.
  const yesMat = std(COL.fg, { emissive: COL.fg, emissiveIntensity: 0.15 });
  const testMat = std(COL.fg, { emissive: COL.fg, emissiveIntensity: 0.15 });
  const yesGate = [box(0.14, 0.9, 0.6, yesMat, -1.5, 0.2, -0.45), box(0.14, 0.9, 0.6, yesMat, -1.5, 0.2, 0.45)];
  const testGate = [box(0.14, 0.9, 0.6, testMat, 1.5, 0.2, -0.45), box(0.14, 0.9, 0.6, testMat, 1.5, 0.2, 0.45)];

  // Paths: the row, three lanes, and the return path to the next session.
  const lineMat = new THREE.LineBasicMaterial({ color: COL.line });
  disposables.push(lineMat);
  const addLine = (pts) => {
    const g = new THREE.BufferGeometry().setFromPoints(pts.map((p) => new THREE.Vector3(...p)));
    disposables.push(g);
    scene.add(new THREE.Line(g, lineMat));
  };
  addLine([[SX[0], 0.02, 0], [SX[1], 0.02, 0]]);
  LANES.forEach((z) => addLine([[SX[1], 0.02, 0], [SX[2], 0.02, z], [SX[3], 0.02, 0]]));
  addLine([[SX[3], 0.02, 0], [SX[4], 0.02, 0]]);
  const back = new THREE.CatmullRomCurve3([
    new THREE.Vector3(SX[4], 0.02, -1.2), new THREE.Vector3(3, 0.02, -2.4),
    new THREE.Vector3(-3, 0.02, -2.4), new THREE.Vector3(SX[0], 0.02, -1.2),
  ]);
  addLine(back.getPoints(40).map((v) => [v.x, v.y, v.z]));

  // The task: one lime cube that splits into three for the parallel round.
  const tokenGeo = new THREE.BoxGeometry(0.42, 0.42, 0.42);
  const miniGeo = new THREE.BoxGeometry(0.26, 0.26, 0.26);
  disposables.push(tokenGeo, miniGeo);
  const tokenMat = std(COL.lime, { emissive: COL.lime, emissiveIntensity: 0.35, roughness: 0.4 });
  const minis = LANES.map(() => std(COL.lime, { emissive: COL.lime, emissiveIntensity: 0.35, roughness: 0.4 }));
  const token = new THREE.Mesh(tokenGeo, tokenMat);
  scene.add(token);
  const mini = minis.map((m) => { const o = new THREE.Mesh(miniGeo, m); scene.add(o); return o; });
  const chipGeo = new THREE.BoxGeometry(0.22, 0.08, 0.22);
  disposables.push(chipGeo);
  const chip = new THREE.Mesh(chipGeo, std(COL.fail, { emissive: COL.fail, emissiveIntensity: 0.25 }));
  scene.add(chip);

  const lime = new THREE.Color(COL.lime), fail = new THREE.Color(COL.fail), grey = new THREE.Color(COL.fg);
  const tint = (m, c, glow = 0.35) => { m.color.copy(c); m.emissive.copy(c); m.emissiveIntensity = glow; };
  const gate = (pair, mat, open, color) => {
    pair[0].position.z = -0.45 - 0.35 * open;
    pair[1].position.z = 0.45 + 0.35 * open;
    tint(mat, color, open > 0 ? 0.55 : 0.15);
  };
  const Y = 0.32;

  let tl = timeline(false);
  let seg = 0, acc = 0, raf = 0, last = 0, wanted = false, onScreen = true, visible = true;
  const startOf = (step) => Math.max(0, tl.findIndex((s) => s.step === step));

  function pose() {
    const s = tl[seg];
    const u = Math.min(1, acc / s.d), e = ease(u);
    const failRun = tl.some((x) => x.k === 'back');
    token.visible = true; mini.forEach((m) => { m.visible = false; });
    chip.visible = false;
    token.scale.setScalar(1);
    gate(yesGate, yesMat, 0, grey);
    gate(testGate, testMat, 0, grey);
    tint(tokenMat, lime);
    minis.forEach((m) => tint(m, lime));
    const lanePos = (p, z) => [lerp(SX[1], SX[2], p), Y - 0.08, lerp(0, z, p)];
    const placeMinis = (fn) => mini.forEach((m, i) => {
      m.visible = true; token.visible = false;
      const [x, y, z] = fn(i);
      m.position.set(x, y, z);
    });
    switch (s.k) {
    case 'read':
      token.position.set(SX[0], Y + 0.25 + 0.08 * Math.sin(acc * 4), 0);
      token.scale.setScalar(Math.min(1, acc / 0.4));
      break;
    case 'toPlan':
      token.position.set(lerp(SX[0], SX[1], e), Y + Math.sin(u * Math.PI) * 0.4, 0);
      break;
    case 'yes': {
      token.position.set(SX[1], Y, 0);
      const open = u < 0.45 ? 0 : ease((u - 0.45) / 0.55);
      gate(yesGate, yesMat, open, open > 0 ? lime : grey);
      break; }
    case 'split':
      gate(yesGate, yesMat, 1, lime);
      placeMinis((i) => lanePos(e, LANES[i]));
      break;
    case 'work':
      gate(yesGate, yesMat, 1, lime);
      placeMinis((i) => [SX[2], Y - 0.08 + Math.abs(Math.sin(acc * 5 + i)) * 0.18, LANES[i]]);
      break;
    case 'toCheck':
      placeMinis((i) => [lerp(SX[2], 1.5 - 0.3, e), Y - 0.08, lerp(LANES[i], LANES[i] * 0.35, e)]);
      break;
    case 'check': {
      const passed = !failRun || tl.indexOf(s) !== tl.findIndex((x) => x.k === 'check');
      placeMinis((i) => [1.2, Y - 0.08, LANES[i] * 0.35]);
      const pulse = 0.5 - 0.5 * Math.cos(acc * 7);
      if (passed) gate(testGate, testMat, ease(u), lime);
      else {
        tint(testMat, grey.clone().lerp(fail, pulse), 0.5);
        tint(minis[2], lime.clone().lerp(fail, Math.min(1, u * 1.6)));
      }
      break; }
    case 'back':
      tint(testMat, fail, 0.5);
      placeMinis((i) => (i === 2
        ? [lerp(1.2, SX[2], e), Y - 0.08 + Math.sin(u * Math.PI) * 0.5, lerp(LANES[2] * 0.35, LANES[2], e)]
        : [1.2, Y - 0.08, LANES[i] * 0.35]));
      tint(minis[2], fail);
      break;
    case 'fix':
      placeMinis((i) => (i === 2
        ? [lerp(SX[2], 1.2, e), Y - 0.08 + Math.abs(Math.sin(acc * 6)) * 0.12, lerp(LANES[2], LANES[2] * 0.35, e)]
        : [1.2, Y - 0.08, LANES[i] * 0.35]));
      tint(minis[2], fail.clone().lerp(lime, e));
      break;
    case 'merge':
      gate(testGate, testMat, 1, lime);
      token.position.set(lerp(1.5, SX[3], e), Y, 0);
      token.scale.setScalar(lerp(0.6, 1, e));
      break;
    case 'close':
      gate(testGate, testMat, 1, lime);
      token.position.set(lerp(SX[3], SX[4], ease(Math.min(1, u * 1.6))), Y + Math.sin(Math.min(1, u * 1.6) * Math.PI) * 0.5, lerp(0, -0.25, e));
      tint(tokenMat, lime.clone().lerp(new THREE.Color(COL.done), e), 0.25);
      chip.visible = u > 0.45;
      chip.position.set(SX[4] + 0.55, 0.16 + (1 - ease(Math.min(1, (u - 0.45) / 0.55))) * 0.6, 0.95);
      break;
    default: {  // next: the record travels back to Read for the next session
      chip.visible = true;
      chip.position.set(SX[4] + 0.55, 0.16, 0.95);
      const p = back.getPoint(e);
      token.position.set(p.x, Y - 0.05, p.z);
      token.scale.setScalar(0.7);
      tint(tokenMat, lime, 0.2);
    }
    }
    token.rotation.y += 0.01;
    doneTray.scale.y = 1; issueTray.scale.y = 1;
    gl.render(scene, camera);
  }

  function tick(dt) {
    acc += dt;
    while (acc >= tl[seg].d) {
      acc -= tl[seg].d;
      seg = (seg + 1) % tl.length;
    }
    onStep(tl[seg].step);
    pose();
  }
  const frame = (now) => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;
    tick(dt);
  };
  const run = () => {
    if (raf || !wanted || !onScreen || !visible) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  };
  const halt = () => { if (raf) { cancelAnimationFrame(raf); raf = 0; } };

  // HTML labels over the canvas, placed by projecting each station once per resize.
  const stage = canvas.parentElement;
  const labels = [...stage.querySelectorAll('.how-label')];
  const anchors = [[SX[0], 0.9, 1.3], [SX[1], 0.9, 1.3], [SX[2], 0.9, 1.9], [SX[3], 0.9, 1.3], [SX[4], 0.9, 1.5], [0, 0.1, -2.9], [-1.5, 1.25, 0], [1.5, 1.25, 0]];
  const resize = () => {
    const w = Math.max(1, stage.clientWidth), h = Math.max(1, stage.clientHeight);
    const halfW = 7.6, halfH = Math.max(halfW * h / w, 3.0);
    const fitW = Math.max(halfW, halfH * w / h);
    camera.left = -fitW; camera.right = fitW; camera.top = halfH; camera.bottom = -halfH;
    camera.updateProjectionMatrix();
    gl.setSize(w, h, false);
    labels.forEach((el, i) => {
      const a = anchors[i];
      if (!a) return;
      const v = new THREE.Vector3(...a).project(camera);
      el.style.left = `${((v.x + 1) / 2) * 100}%`;
      el.style.top = `${((1 - v.y) / 2) * 100}%`;
    });
    pose();
  };
  resize();
  new ResizeObserver(resize).observe(stage);
  new IntersectionObserver((es) => {
    onScreen = es.some((e) => e.isIntersecting);
    if (onScreen) run(); else halt();
  }, { threshold: 0.05 }).observe(fig);
  document.addEventListener('visibilitychange', () => {
    visible = !document.hidden;
    if (visible) run(); else halt();
  });
  // Dispose only when the page is really unloaded; a page kept in the
  // back/forward cache comes back with the same renderer.
  window.addEventListener('pagehide', (e) => {
    halt();
    if (e.persisted) return;
    disposables.forEach((d) => d.dispose());
    gl.dispose();
  });

  return {
    jump(step) { seg = startOf(step); acc = 0; pose(); },
    setFailure(f) {
      const step = tl[seg].step;
      tl = timeline(f);
      seg = startOf(step); acc = 0; pose();
    },
    play() { wanted = true; run(); },
    pause() { wanted = false; halt(); pose(); },
  };
}

document.querySelectorAll('[data-how]').forEach(setup);

// "How it fits together": the arrows flow only while the diagram is on screen.
document.querySelectorAll('.connect-sec').forEach((sec) => {
  new IntersectionObserver((es) => {
    sec.classList.toggle('is-visible', es.some((e) => e.isIntersecting));
  }, { threshold: 0.2 }).observe(sec);
});
