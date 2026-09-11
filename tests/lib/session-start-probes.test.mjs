/**
 * tests/lib/session-start-probes.test.mjs
 *
 * Tests for scripts/lib/session-start-probes.mjs — the mechanical caller for
 * the `skills/session-start/SKILL.md` § Phase 4 probe family.
 *
 * Every test below names the concrete bug it catches (TV-001). The runner sits
 * on a SessionStart hook that runs under a 5s `hooks.json` timeout and an
 * exit-0 fail-open protocol, so its failure modes are all of the shape "the
 * session start is degraded and nothing says so" — which is exactly the class
 * the runner exists to remove.
 *
 * SAFETY: every test pins `repoRoot` to a tmp directory and either injects an
 * `emit` capture or lets the real emitter write into that same tmp tree. No
 * test may append to the real repo's `.orchestrator/metrics/events.jsonl` or
 * touch the operator's vault — hence the `SO_VAULT_DIR` / `CLAUDE_PROJECT_DIR`
 * pins in `beforeEach`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

import {
  runSessionStartProbes,
  PROBES,
  PROBE_BUDGET_MS,
} from '../../scripts/lib/session-start-probes.mjs';

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

const tmpDirs = [];
let savedEnv;

beforeEach(async () => {
  savedEnv = {
    SO_VAULT_DIR: process.env.SO_VAULT_DIR,
    CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
    SO_PROBES_INCLUDE_NETWORK: process.env.SO_PROBES_INCLUDE_NETWORK,
  };
  // A vault writer reached by any probe must land in a throwaway tree, never in
  // the operator's real vault (CLAUDE.md § vault-dir resolves HOST-LOCALLY).
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'probes-vault-'));
  tmpDirs.push(vault);
  process.env.SO_VAULT_DIR = vault;
  process.env.CLAUDE_PROJECT_DIR = vault;
  delete process.env.SO_PROBES_INCLUDE_NETWORK;
});

afterEach(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const d of tmpDirs.splice(0)) {
    await fs.rm(d, { recursive: true, force: true });
  }
});

async function mkTmp(prefix = 'probes-repo-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/**
 * Write a fixture probe module and return a registry entry pointing at it.
 *
 * Deliberately a real module loaded through the real dynamic `import` the
 * runner uses in production, rather than an injected callback: the import step
 * is part of the contract under test (an absent module must degrade to a
 * recorded skip, not to a throw).
 */
async function fakeProbe(dir, id, body, extra = {}) {
  const file = path.join(dir, `${id}.mjs`);
  await fs.writeFile(file, body, 'utf8');
  return {
    id,
    spec: pathToFileURL(file).href,
    fn: 'probe',
    network: false,
    args: () => ({}),
    ...extra,
  };
}

const CLEAN = 'export function probe() { return null; }';
const THROWS = 'export function probe() { throw new Error("probe exploded"); }';
const HANGS = 'export function probe() { return new Promise(() => {}); }';
const warns = (msg) =>
  `export function probe() { return { severity: 'warn', message: ${JSON.stringify(msg)} }; }`;

/** Collects emitted events instead of writing them anywhere. */
function captureEmit() {
  const calls = [];
  return {
    calls,
    emit: async (type, payload, opts) => { calls.push({ type, payload, opts }); },
  };
}

// ---------------------------------------------------------------------------

describe('runSessionStartProbes — fail-open', () => {
  // BUG: a probe that throws propagates out of the runner and aborts the
  // SessionStart hook mid-flight. Everything downstream of the probe call in
  // hooks/on-session-start.mjs is lost — the `orchestrator.session.started`
  // event, the peer banners, the events-rotation. Before this file the suite
  // exercised the runner not at all, so nothing pinned "one broken probe must
  // not cost the operator the other seventeen".
  it('records a throwing probe as an error and still runs its siblings', async () => {
    const dir = await mkTmp();
    const { calls, emit } = captureEmit();
    const probes = [
      await fakeProbe(dir, 'boom', THROWS),
      await fakeProbe(dir, 'fine', CLEAN),
    ];

    const out = await runSessionStartProbes({ repoRoot: dir }, { probes, emit, timeoutMs: 30_000 });

    expect(out.results).toEqual([
      expect.objectContaining({ id: 'boom', outcome: 'error' }),
      expect.objectContaining({ id: 'fine', outcome: 'ran-clean' }),
    ]);
    expect(out.results[0].reason).toContain('probe exploded');
    expect(calls[0].payload).toMatchObject({ total: 2, ran: 1, errored: 0 + 1 });
  });

  // BUG: an absent probe module (the documented "pre-#N plugin install" case
  // SKILL.md tells the coordinator to skip silently) becomes an unhandled
  // ERR_MODULE_NOT_FOUND rejection. On an exit-0 fail-open hook an unhandled
  // rejection is the worst outcome available: it kills the process before the
  // single stdout envelope is flushed.
  it('records an absent probe module as a skip, never as a throw', async () => {
    const dir = await mkTmp();
    const { emit } = captureEmit();
    const probes = [{
      id: 'ghost',
      spec: pathToFileURL(path.join(dir, 'does-not-exist.mjs')).href,
      fn: 'probe',
      network: false,
      args: () => ({}),
    }];

    const out = await runSessionStartProbes({ repoRoot: dir }, { probes, emit, timeoutMs: 30_000 });

    expect(out.results).toEqual([
      expect.objectContaining({ id: 'ghost', outcome: 'skipped', reason: 'module-absent' }),
    ]);
  });

  // BUG: a probe that never resolves hangs the whole hook until Claude Code's
  // 5s hooks.json timeout kills it — losing the started-event AND the banner,
  // with no record that a probe was responsible. Worse, if the runner recorded
  // the unfinished probe as clean, the telemetry would assert a measurement
  // that never completed.
  it('cuts a hanging probe off at the budget and reports it as timeout', async () => {
    const dir = await mkTmp();
    const { calls, emit } = captureEmit();
    const probes = [
      await fakeProbe(dir, 'hang', HANGS),
      await fakeProbe(dir, 'fine', CLEAN),
    ];

    // Measure the hanging invocation's deadline after loading these fixtures.
    // A cold module import can exceed 150ms under full-suite CPU contention;
    // The cold-import timeout has its own coverage below.
    await Promise.all(probes.map((probe) => import(probe.spec)));

    const t0 = Date.now();
    const out = await runSessionStartProbes(
      { repoRoot: dir, timeoutMs: 150 },
      { probes, emit },
    );
    const elapsed = Date.now() - t0;

    expect(out.results).toEqual([
      expect.objectContaining({ id: 'hang', outcome: 'timeout', reason: 'budget-exceeded' }),
      expect.objectContaining({ id: 'fine', outcome: 'ran-clean' }),
    ]);
    // The run must actually RETURN at the budget, not merely label the probe.
    // Ceiling raised 3000 → 5000 (BV-004): the assertion's INTENT is "returns
    // at the 150ms budget instead of waiting out the hung probe" — the HANGS
    // fixture returns a promise that NEVER resolves, so without the budget
    // this run does not return at all and any finite bound falsifies it.
    // 3000 was additionally measuring node startup under contention and
    // tripped at CPU 100% while passing in isolation.
    expect(elapsed).toBeLessThan(5000);
    expect(calls[0].payload.timed_out).toBe(1);
    // A timeout is never folded into the clean count.
    expect(calls[0].payload.ran).toBe(1);
    // ...and the operator is told, because a silent timeout is a silent probe.
    expect(out.bannerLines.join('\n')).toContain('1 timed out');
  });

  // The deadline must cover module evaluation too: a top-level await that
  // never resolves must not prevent the runner from reporting a timeout.
  it('reports timeout when a cold probe import never finishes', async () => {
    const dir = await mkTmp();
    const { calls, emit } = captureEmit();
    const probes = [await fakeProbe(
      dir,
      'cold-hang',
      'await new Promise(() => {}); export function probe() { return null; }',
    )];

    const t0 = Date.now();
    const out = await runSessionStartProbes(
      { repoRoot: dir, timeoutMs: 150 },
      { probes, emit },
    );

    expect(out.results).toEqual([
      expect.objectContaining({ id: 'cold-hang', outcome: 'timeout', reason: 'budget-exceeded' }),
    ]);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(calls[0].payload).toMatchObject({ timed_out: 1, ran: 0 });
    expect(out.bannerLines.join('\n')).toContain('1 timed out');
  });

  // BUG (measured 2026-09-11 in this repo's own ledger, 7 of 39 recorded
  // `orchestrator.probes.completed` runs): probes share the process, and the
  // two that shell out with `execFileSync` monopolise the event loop for
  // seconds. Under one shared WALL-CLOCK deadline, every probe that yields
  // mid-work then loses its race to a long-expired timer and is recorded
  // `timeout` / `budget-exceeded` with its result DISCARDED — while the
  // synchronous blocker that caused the overrun settles in a microtask and is
  // recorded `ran-clean`. The verdict graded asynchrony, not cost: the two
  // probes blamed (`peer-cards-staleness` 7 ms, `maintenance-due` 40 ms in
  // isolation) were among the cheapest in the registry. No existing test in
  // this suite fails on that, because every fake probe here is either instant
  // or hangs forever — none is cheap-but-preemptible next to a blocker.
  it('does not charge a cheap async probe for a synchronous sibling that blocks the loop', async () => {
    const dir = await mkTmp();
    const { calls, emit } = captureEmit();
    const probes = [
      // Non-preemptible: burns wall-clock far past the budget without ever
      // yielding — the `execFileSync` shape, without spawning anything.
      await fakeProbe(
        dir,
        'blocker',
        'export function probe() { const end = Date.now() + 400; while (Date.now() < end) {} return null; }',
      ),
      // Preemptible and cheap: one tick of real async work, then a real result.
      await fakeProbe(
        dir,
        'cheap-async',
        "export async function probe() { await new Promise((r) => setTimeout(r, 1));" +
          " return { severity: 'warn', message: 'cheap-async measured something' }; }",
      ),
    ];

    const out = await runSessionStartProbes({ repoRoot: dir, timeoutMs: 50 }, { probes, emit });

    const cheap = out.results.find((r) => r.id === 'cheap-async');
    // Assert on the OUTPUT, not on a duration: a probe that returns instantly
    // because it silently did nothing is indistinguishable from a fast one.
    expect(cheap).toMatchObject({ outcome: 'ran-warn', severity: 'warn' });
    expect(out.bannerLines.join('\n')).toContain('cheap-async measured something');
    expect(calls[0].payload.timed_out).toBe(0);
    // The verdict's input reaches the ledger, and the cheap probe's own work is
    // charged well under the budget even though wall-clock elapsed exceeds it.
    const payload = calls[0].payload.probes.find((p) => p.id === 'cheap-async');
    expect(payload.work_ms).toBeLessThan(50);
    expect(cheap.durationMs).toBeGreaterThan(cheap.workMs);
  });
});

describe('runSessionStartProbes — what did not run is recorded', () => {
  // BUG: the two network probes are dropped silently to protect the hook's
  // latency budget. `total` then reads 16, every outcome is clean, and nothing
  // distinguishes "excluded by policy" from "never existed" — which is the
  // built-but-not-wired defect this module was written to repair, rebuilt one
  // layer down. "Absent is not zero."
  it('keeps an excluded network probe in the event as skipped', async () => {
    const dir = await mkTmp();
    const { calls, emit } = captureEmit();
    const probes = [
      await fakeProbe(dir, 'net', warns('should not be seen'), { network: true }),
      await fakeProbe(dir, 'local', CLEAN),
    ];

    const out = await runSessionStartProbes({ repoRoot: dir }, { probes, emit, timeoutMs: 30_000 });

    expect(out.results).toContainEqual(
      expect.objectContaining({
        id: 'net',
        outcome: 'skipped',
        reason: 'network-probe-opt-in',
      }),
    );
    expect(calls[0].payload.total).toBe(2);
    expect(calls[0].payload.skipped).toBe(1);
    // `reason` travels into the payload, not just the in-memory result. Without it
    // the ledger cannot tell `network-probe-opt-in` (the intended default) from
    // `module-absent` (a permanently dead registry entry) — and the module's own
    // header calls dropping it "the exact defect this module repairs".
    expect(calls[0].payload.probes).toEqual([
      { id: 'net', outcome: 'skipped', reason: 'network-probe-opt-in' },
      // `work_ms` — the quantity the `timeout` verdict is computed from — must
      // reach the ledger too (HR-105), but its VALUE is wall-clock and must
      // never be pinned (`0becdd9a` decoupled this suite from a wall budget for
      // exactly that reason). A skipped probe never ran, so it carries none.
      { id: 'local', outcome: 'ran-clean', work_ms: expect.any(Number) },
    ]);
    expect(calls[0].payload.probes[0]).not.toHaveProperty('work_ms');
    // Excluded means not invoked — its banner must not appear.
    expect(out.bannerLines.join('\n')).not.toContain('should not be seen');
  });

  // BUG: the opt-in escape hatch is documented but dead, so an operator who
  // sets it gets the same silent exclusion and no way to find out.
  it('runs network probes when SO_PROBES_INCLUDE_NETWORK=1', async () => {
    const dir = await mkTmp();
    const { emit } = captureEmit();
    const probes = [await fakeProbe(dir, 'net', warns('CI is red'), { network: true })];

    const out = await runSessionStartProbes(
      { repoRoot: dir, env: { SO_PROBES_INCLUDE_NETWORK: '1' } },
      { probes, emit },
    );

    expect(out.results[0]).toMatchObject({ id: 'net', outcome: 'ran-warn' });
    expect(out.bannerLines).toContain('CI is red');
  });

  // BUG: a `degraded` result from one of the three-state probes
  // (`mirror-issues`, `git-config-drift`, `ci-status`) is mapped to clean.
  // SKILL.md § Phase 4 is explicit that `degraded` means "the state is UNKNOWN
  // — never read that as clean", and names the sibling collapse that hid the
  // gap for a release ("Do not reproduce it").
  it('treats a degraded result as a finding, never as clean', async () => {
    const dir = await mkTmp();
    const { emit } = captureEmit();
    const probes = [await fakeProbe(
      dir,
      'degraded',
      `export function probe() { return { severity: 'warn', message: 'mirror state unknown', degraded: 'cli-missing' }; }`,
    )];

    const out = await runSessionStartProbes({ repoRoot: dir }, { probes, emit, timeoutMs: 30_000 });

    expect(out.results[0]).toMatchObject({ id: 'degraded', outcome: 'ran-warn' });
    expect(out.bannerLines).toContain('mirror state unknown');
  });
});

describe('runSessionStartProbes — telemetry destination', () => {
  // BUG: the event's destination stops being pinned to the caller's repoRoot
  // and falls back to whatever SO_PROJECT_DIR resolves to. This is not
  // hypothetical: a Wave-1 agent in this very session lost exactly this pin (a
  // shell variable set but never exported), and its synthetic records landed in
  // THIS repo's real `.orchestrator/metrics/events.jsonl`.
  it('writes the event under the caller-supplied repoRoot', async () => {
    const dir = await mkTmp();
    const probes = [await fakeProbe(dir, 'fine', CLEAN)];

    // The REAL emitter, on purpose — the pin is what is under test.
    await runSessionStartProbes({ repoRoot: dir }, { probes, timeoutMs: 30_000 });

    const ledger = path.join(dir, '.orchestrator', 'metrics', 'events.jsonl');
    const lines = (await fs.readFile(ledger, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]);
    expect(rec.event).toBe('orchestrator.probes.completed');
    expect(rec).toMatchObject({ total: 1, ran: 1, skipped: 0, errored: 0, timed_out: 0 });
    expect(Number.isFinite(rec.duration_ms)).toBe(true);
  });

  // BUG: called without a repoRoot the runner measures whatever tree the
  // ambient env points at and writes its record there. Refusing is the only
  // fail-open answer — the same reason every probe in the family returns `null`
  // on a missing repoRoot.
  it('does nothing at all when repoRoot is missing', async () => {
    const { calls, emit } = captureEmit();
    const out = await runSessionStartProbes({}, { emit });

    expect(out).toEqual({ bannerLines: [], results: [], event: null });
    expect(calls).toHaveLength(0);
  });

  // BUG: an unwritable ledger turns into a rejection and costs the operator the
  // banners the run had already produced. Telemetry is the least important
  // thing in the function and must fail last.
  it('still returns banners when the emitter throws', async () => {
    const dir = await mkTmp();
    const probes = [await fakeProbe(dir, 'w', warns('a real finding'))];

    const out = await runSessionStartProbes(
      { repoRoot: dir },
      { probes, emit: async () => { throw new Error('ledger is read-only'); } },
    );

    expect(out.bannerLines).toContain('a real finding');
    expect(out.results[0]).toMatchObject({ outcome: 'ran-warn' });
  });
});

describe('runSessionStartProbes — banner ordering', () => {
  // BUG: banners are pushed in COMPLETION order, so the operator's screen is
  // reordered by whichever probe happened to win the race. Two starts of the
  // same repo then produce two different banners with identical findings, and
  // neither is diffable against the other.
  it('emits banner lines in registry order, not completion order', async () => {
    const dir = await mkTmp();
    const { emit } = captureEmit();
    const slow = await fakeProbe(
      dir,
      'slow-first',
      `export async function probe() { await new Promise(r => setTimeout(r, 60)); return { severity: 'warn', message: 'FIRST' }; }`,
    );
    const fast = await fakeProbe(dir, 'fast-second', warns('SECOND'));

    const out = await runSessionStartProbes({ repoRoot: dir }, { probes: [slow, fast], emit });

    expect(out.bannerLines).toEqual(['FIRST', 'SECOND']);
    expect(out.results.map((r) => r.id)).toEqual(['slow-first', 'fast-second']);
  });
});

describe('the built-in registry', () => {
  // BUG: a probe module is renamed or its entry function changes signature, and
  // the registry entry degrades to a permanent `skipped: module-absent`. The
  // run stays green, the telemetry stays plausible, and the probe is silently
  // dead again — the same failure this module exists to end, restored by a
  // rename. Only a live resolution of every entry catches it.
  it('resolves every registered probe module and entry function', async () => {
    const missing = [];
    for (const probe of PROBES) {
      try {
        const mod = await import(probe.spec);
        if (typeof mod[probe.fn] !== 'function') missing.push(`${probe.id}: no export ${probe.fn}`);
      } catch (err) {
        missing.push(`${probe.id}: ${err.message}`);
      }
    }
    expect(missing).toEqual([]);
  });

  // BUG (#1159 wiring; contract changed by the #1158/#1159 review's N3
  // single-vocabulary fix): vault-staleness-banner USED TO return a third
  // shape, `{severity:'info', kind:'probe-stale'}`, that the registry had to
  // remap to `'warn'` by hand — the default severityOf() maps everything but
  // warn/alert to 'ok', so without the remap the "probe has not run for N
  // days" banner would build and never render. The banner module now returns
  // `severity: 'warn'` directly for that shape (kind still carries the
  // demotion meaning), so the registry entry carries NO custom severityOf —
  // this test asserts that AND exercises the real runner against the exact
  // shape checkVaultStaleness now produces, so a regression back to a
  // distinct 'info' value (which the default WOULD remap to 'ok', silent) is
  // caught here rather than only inside the banner module's own tests, which
  // cannot see the consumer.
  it('has no custom severityOf for vault-staleness, and the default renders its probe-stale shape', async () => {
    const registryProbe = PROBES.find((p) => p.id === 'vault-staleness');
    expect(registryProbe.severityOf).toBeUndefined();

    const dir = await mkTmp();
    const { emit } = captureEmit();
    const fake = await fakeProbe(
      dir,
      'vault-staleness',
      `export function probe() { return { severity: 'warn', kind: 'probe-stale', message: 'probe has not run for 47 days' }; }`,
    );

    const out = await runSessionStartProbes({ repoRoot: dir }, { probes: [fake], emit });

    expect(out.results[0]).toMatchObject({ id: 'vault-staleness', outcome: 'ran-warn' });
    expect(out.bannerLines).toContain('probe has not run for 47 days');
  });

  // BUG this catches (TV-001): the `ci-status` entry overrides BOTH `render`
  // and `severityOf`, so the module-level defaults that already handle a
  // three-state `degraded` result never run for it. Before #1031 wired the
  // degraded branch into those two overrides, a degraded ci-status result
  // scored 'ok' and rendered nothing — "could not read" displayed exactly like
  // "green", the collapse SKILL.md § Phase 4 names and forbids.
  //
  // The generic-path test above ("treats a degraded result as a finding") uses
  // a bare fake probe with NO overrides, so it cannot see this hole. This one
  // runs the REAL registry entry's `render`/`severityOf` against the exact
  // object `checkCiStatus` now returns.
  it('renders a degraded ci-status result through the REAL registry entry', async () => {
    const registryProbe = PROBES.find((p) => p.id === 'ci-status');
    const dir = await mkTmp();
    const { emit } = captureEmit();
    const degraded = {
      severity: 'warn',
      ok: false,
      message: '⚠ ci-status: CI status for HEAD could not be determined (query-failed) — state UNKNOWN, not "green".',
      degraded: 'query-failed',
    };
    const fake = await fakeProbe(
      dir,
      'ci-status',
      `export function probe() { return ${JSON.stringify(degraded)}; }`,
      { render: registryProbe.render, severityOf: registryProbe.severityOf },
    );

    const out = await runSessionStartProbes({ repoRoot: dir }, { probes: [fake], emit });

    expect(out.results[0]).toMatchObject({ id: 'ci-status', outcome: 'ran-warn' });
    expect(out.bannerLines).toContain(degraded.message);
  });

  // The other half of the same override: a real reading must be unaffected.
  // Without this, "render everything" would satisfy the test above.
  it('keeps the real registry entry silent on a plain green ci-status reading', async () => {
    const registryProbe = PROBES.find((p) => p.id === 'ci-status');
    const dir = await mkTmp();
    const { emit } = captureEmit();
    const fake = await fakeProbe(
      dir,
      'ci-status',
      `export function probe() { return { status: 'green', ok: true, details: { cliUsed: 'glab' } }; }`,
      { render: registryProbe.render, severityOf: registryProbe.severityOf },
    );

    const out = await runSessionStartProbes({ repoRoot: dir }, { probes: [fake], emit });

    expect(out.results[0]).toMatchObject({ id: 'ci-status', outcome: 'ran-clean' });
    expect(out.bannerLines).toEqual([]);
  });

  // BUG this catches (TV-001, #1255): the `telemetry-flush-health` entry was
  // only ever exercised as "the module and the named export resolve" — nothing
  // ran the REAL registry entry end-to-end. It carries NO custom
  // render/severityOf, so it depends entirely on the module-level defaults
  // reading `{severity:'warn', message}`; if that shape or the entry's `args`
  // (which must pass `repoRoot` through, or the probe reads the WRONG repo's
  // ledger and silently finds nothing) ever drift apart, the sandbox refusal
  // this probe exists to surface goes back to being invisible — the exact
  // pre-#1255 state, and indistinguishable from a healthy channel.
  it('surfaces a sandbox refusal through the REAL telemetry-flush-health registry entry', async () => {
    const registryProbe = PROBES.find((p) => p.id === 'telemetry-flush-health');
    expect(registryProbe).toBeDefined();
    expect(registryProbe.render).toBeUndefined();
    expect(registryProbe.severityOf).toBeUndefined();

    const dir = await mkTmp();
    await fs.mkdir(path.join(dir, '.orchestrator', 'metrics'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.orchestrator', 'metrics', 'events.jsonl'),
      [
        JSON.stringify({ event: 'orchestrator.session.started' }),
        JSON.stringify({
          timestamp: '2026-09-07T05:04:55.138Z',
          event: 'orchestrator.telemetry.flush',
          outcome: 'skipped',
          reason: 'sandbox:probe-failed',
          schema_version: 1,
        }),
      ].join('\n') + '\n',
      'utf8',
    );
    const { emit } = captureEmit();

    const out = await runSessionStartProbes({ repoRoot: dir }, { probes: [registryProbe], emit });

    expect(out.results[0]).toMatchObject({
      id: 'telemetry-flush-health',
      outcome: 'ran-warn',
    });
    const matching = out.bannerLines.filter((l) => l.includes('sandbox:probe-failed'));
    expect(matching).toHaveLength(1);
  });

  // BUG: `maintenance-due` SUBSUMES `reconcile-nudge` — it calls
  // `computeReconcileNudge` wholesale as its S3. Leaving both entries in the
  // registry double-reports the same finding on every session start, which is
  // exactly the banner-noise failure (`.claude/rules/host-resources.md` §
  // HR-101) the consolidation was built to remove. Dropping `maintenance-due`
  // instead loses five other signals with no trace.
  it('registers maintenance-due in place of reconcile-nudge', () => {
    const ids = PROBES.map((p) => p.id);
    expect(ids).toContain('maintenance-due');
    expect(ids).not.toContain('reconcile-nudge');

    const entry = PROBES.find((p) => p.id === 'maintenance-due');
    expect(entry.fn).toBe('checkMaintenanceDue');
    expect(entry.network).toBe(false);
    expect(entry.args({ repoRoot: '/tmp/x', config: { a: 1 } })).toEqual({
      repoRoot: '/tmp/x',
      config: { a: 1 },
    });
  });

  it('has a unique id per entry and a sane default budget', () => {
    const ids = PROBES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(PROBE_BUDGET_MS).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// #1132 — the instruction-budget probe on a repo without `.claude/rules/`
// ---------------------------------------------------------------------------

describe('the instruction-budget probe on a repo with no .claude/rules (#1132)', () => {
  // BUG: this entry carried a `no-rules-dir` precondition, so on the NORMAL
  // state of every repo that has not adopted the rules layer the telemetry
  // recorded `skipped: 'no-rules-dir'` — a measurement claimed as DECLINED
  // that would in fact have run and returned a legitimate empty corpus. The
  // precondition existed only to dodge a stderr side-effect in rule-loader,
  // which is now category-gated at its source. Re-adding it (or any other
  // precondition here) turns `ran-*` back into `skipped` and the outcome
  // column lies about what was measured.
  //
  // The stderr assertion below is the other half: it pins the side-effect
  // through the REAL caller chain (runner → checkInstructionBudget →
  // loadApplicableRules ×3), which is where the three duplicate lines per
  // probe run actually came from.
  it('runs the probe, records no skip, and writes nothing to stderr', async () => {
    const dir = await mkTmp();
    const entry = PROBES.find((p) => p.id === 'instruction-budget');
    expect(entry).toBeDefined();

    const { calls, emit } = captureEmit();

    const captured = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = (chunk) => {
      captured.push(String(chunk));
      return true;
    };
    let out;
    try {
      out = await runSessionStartProbes({ repoRoot: dir }, { probes: [entry], emit });
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(captured.join('')).toBe('');
    expect(out.results).toHaveLength(1);
    expect(out.results[0].id).toBe('instruction-budget');
    expect(out.results[0].outcome).toMatch(/^ran-/);
    expect(out.results[0].reason).toBeUndefined();
    expect(calls[0].payload.skipped).toBe(0);
  });
});
