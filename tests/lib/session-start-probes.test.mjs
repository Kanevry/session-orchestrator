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

    const out = await runSessionStartProbes({ repoRoot: dir }, { probes, emit });

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

    const out = await runSessionStartProbes({ repoRoot: dir }, { probes, emit });

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

    const out = await runSessionStartProbes({ repoRoot: dir }, { probes, emit });

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
      { id: 'local', outcome: 'ran-clean' },
    ]);
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

    const out = await runSessionStartProbes({ repoRoot: dir }, { probes, emit });

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
    await runSessionStartProbes({ repoRoot: dir }, { probes });

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
