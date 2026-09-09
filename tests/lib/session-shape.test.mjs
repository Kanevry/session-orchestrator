/**
 * session-shape.test.mjs — scripts/lib/session-shape.mjs
 *
 * Every test below names the bug it catches (TV-001). The short version of all
 * of them: on 2026-09-09 the wave shape of a session lived in PROSE at 27 sites
 * that contradicted each other in 8 answers, so "how many waves does a
 * housekeeping session run" had no falsifiable answer and consumer repos ran
 * 5-wave housekeeping sessions (6 measured) with nothing anywhere recording it.
 * These tests pin the shape AND the fact that it records itself.
 *
 * LEDGER SAFETY. No test here may append to the operator's real telemetry.
 * Two independent guards, the same shape `tests/lib/express-path.test.mjs` uses:
 *   1. every emitting test passes an explicit `repoRoot` under `mkdtemp`;
 *   2. `CLAUDE_PROJECT_DIR` is pinned to a throwaway SENTINEL tree before the
 *      first `import('./events.mjs')` can happen, so if the repoRoot guard ever
 *      regresses the stray write lands in the sentinel — where a test asserts on
 *      it — instead of in the real repo. `SO_PROJECT_DIR` is a module-level const
 *      computed at `platform.mjs` load, which is why this is set at file scope
 *      rather than inside a `beforeEach`.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// --- must run before any lazy import of events.mjs → platform.mjs ------------
const SENTINEL = mkdtempSync(join(tmpdir(), 'session-shape-sentinel-'));
process.env.CLAUDE_PROJECT_DIR = SENTINEL;

const {
  resolveSessionShape,
  resolveAndRecordSessionShape,
  resolveAgentCap,
  SESSION_SHAPE_EVENT,
  SESSION_SHAPE_VERSION,
} = await import('@lib/session-shape.mjs');

const SENTINEL_LEDGER = join(SENTINEL, '.orchestrator', 'metrics', 'events.jsonl');

/** @type {string[]} */
const tmpRoots = [];

/** Make a throwaway repoRoot the emitting tests can safely write into. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'session-shape-repo-'));
  tmpRoots.push(dir);
  return dir;
}

/** Read every event record a tmp repoRoot received. */
function readLedger(repoRoot) {
  const file = join(repoRoot, '.orchestrator', 'metrics', 'events.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
  rmSync(SENTINEL, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// resolveAgentCap
// ---------------------------------------------------------------------------

describe('resolveAgentCap', () => {
  it('resolves the per-type override, not cap.default, for the overridden type', () => {
    // Bug: the two PRIVATE copies of this resolver
    // (wave-resource-gate.mjs:235-242, resource-probe/evaluate.mjs:269-277)
    // both return cap.default unconditionally. That is the safe direction for a
    // RESOURCE ceiling but the wrong answer for wave shaping: this repo's own
    // Session Config says `agents-per-wave: 6 (deep: 18)`, so a deep wave capped
    // at 6 silently runs at a third of the configured width.
    const cap = { default: 6, deep: 18 };
    expect(resolveAgentCap(cap, 'deep')).toBe(18);
    expect(resolveAgentCap(cap, 'feature')).toBe(6);
  });

  it('passes a plain number through and returns null for an unusable value', () => {
    // Bug: `agents-per-wave` has TWO shapes (`_coerceInteger` returns a number
    // OR a record). A resolver that assumes one shape returns `undefined` for
    // the other, and `Math.min(raw, undefined)` is NaN — a cap of NaN compares
    // false against every guard and silently uncaps the wave.
    expect(resolveAgentCap(6, 'deep')).toBe(6);
    expect(resolveAgentCap(null, 'deep')).toBeNull();
    expect(resolveAgentCap('6', 'deep')).toBeNull();
    expect(resolveAgentCap({ feature: 4 }, 'deep')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveSessionShape — the four forms
// ---------------------------------------------------------------------------

describe('resolveSessionShape — the four forms', () => {
  const cases = [
    {
      name: 'housekeeping',
      input: { sessionType: 'housekeeping' },
      totalWaves: 1,
      roles: ['Housekeeping'],
      discovery: false,
      maxTurnsDefault: 8,
    },
    {
      name: 'feature',
      input: { sessionType: 'feature' },
      totalWaves: 3,
      roles: ['Impl-Core', 'Impl-Polish+Quality', 'Finalization'],
      discovery: false,
      maxTurnsDefault: 15,
    },
    {
      name: 'deep (no profile)',
      input: { sessionType: 'deep' },
      totalWaves: 5,
      roles: ['Discovery', 'Impl-Core', 'Impl-Polish', 'Quality', 'Finalization'],
      discovery: true,
      maxTurnsDefault: 25,
    },
    {
      name: 'deep + ultradeep',
      input: { sessionType: 'deep', profile: 'ultradeep' },
      totalWaves: 7,
      roles: [
        'Research+Code-Discovery',
        'Synthesis-Gate',
        'Impl-Core',
        'Impl-Polish',
        'Review-Panel',
        'Quality',
        'Release/Finalization',
      ],
      discovery: true,
      maxTurnsDefault: 25,
    },
  ];

  for (const c of cases) {
    it(`${c.name} resolves to exactly ${c.totalWaves} wave(s) with the documented roles`, () => {
      // Bug: 27 prose sites, 8 contradictions (measured 2026-09-09). Without a
      // table test, "how many waves does X run" stays answerable four different
      // ways depending on which file the coordinator happened to read.
      const shape = resolveSessionShape(c.input);
      expect(shape.totalWaves).toBe(c.totalWaves);
      expect(shape.waves.map((w) => w.role)).toEqual(c.roles);
      expect(shape.waves.map((w) => w.n)).toEqual(c.roles.map((_, i) => i + 1));
      expect(shape.discovery).toBe(c.discovery);
      expect(shape.maxTurnsDefault).toBe(c.maxTurnsDefault);
      expect(shape.version).toBe(SESSION_SHAPE_VERSION);
    });
  }
});

describe('resolveSessionShape — per-form rules', () => {
  it('housekeeping is exactly ONE coordinator-direct wave with no agents', () => {
    // Bug (measured): 6 housekeeping sessions in consumer repos ran the full
    // 5-wave deep shape. Housekeeping is a maintenance LOOP the coordinator runs
    // itself; a wave-decomposed housekeeping session spends six agent dispatches
    // on work that is six sequential CLI calls.
    const shape = resolveSessionShape({ sessionType: 'housekeeping' });
    expect(shape.totalWaves).toBe(1);
    expect(shape.coordinatorDirect).toBe(true);
    expect(shape.waves.filter((w) => w.coordinatorDirect)).toHaveLength(1);
    expect(shape.waves[0]).toMatchObject({ agentCap: 0, agentCapRaw: 0, maxTurns: null });
    expect(shape.waves[0].isolation).toBe('none');
    expect(shape.notes.join(' ')).toContain('memory-cleanup');
  });

  it('feature runs NO Discovery wave and earns Quality inside wave 2', () => {
    // Bug: the retired `waves: 3` role-mapping row said W1 = "Discovery +
    // Impl-Core", which put a discovery budget into a session whose scope is
    // already agreed — and left Quality without a named owner.
    const shape = resolveSessionShape({ sessionType: 'feature' });
    expect(shape.discovery).toBe(false);
    expect(shape.waves.some((w) => w.role.includes('Discovery'))).toBe(false);
    expect(shape.waves[1]).toMatchObject({ qualityEarned: true, verification: 'full' });
    expect(shape.waves.map((w) => w.agentCapRaw)).toEqual([4, 4, 2]);
  });

  it('deep with knownScope drops Discovery and renumbers the remaining waves', () => {
    // Bug: dropping a wave without renumbering leaves waves numbered 2..5 with
    // `totalWaves: 4`, so every consumer that indexes by `n` (the scope
    // manifest directory `filescopes/wave-<N>/` above all) writes into a wave
    // directory that the checkpoint loop never reads.
    const shape = resolveSessionShape({ sessionType: 'deep', knownScope: true });
    expect(shape.totalWaves).toBe(4);
    expect(shape.discovery).toBe(false);
    expect(shape.waves.map((w) => w.n)).toEqual([1, 2, 3, 4]);
    expect(shape.waves[0].role).toBe('Impl-Core');
    expect(shape.notes.join(' ')).toContain('knownScope');
  });

  it('deep Discovery is read-only with an EMPTY allowedPaths, Quality is earned', () => {
    // Bug: a Discovery wave whose allowedPaths is merely absent inherits the
    // coordinator's paths and becomes writable — the read-only guarantee the
    // whole wave exists for evaporates with no error anywhere.
    const shape = resolveSessionShape({ sessionType: 'deep' });
    expect(shape.waves[0]).toMatchObject({
      writes: false,
      verification: 'none',
      allowedPaths: [],
    });
    expect(shape.waves[3]).toMatchObject({ qualityEarned: true, verification: 'full' });
    expect(shape.waves[4].verification).toBe('git-status');
    expect(shape.waves.map((w) => w.agentCapRaw)).toEqual([8, 10, 8, 6, 4]);
  });

  it('ultradeep IGNORES waves: 5 — 7 waves, wavesConfigHonored false, no error', () => {
    // Bug, in both directions: PRD AC-9 REJECTED `waves < 7` under the profile,
    // which turned this repo's own committed `waves: 5` into a hard start
    // failure; and the prose fallback silently produced a 5-wave plan for a
    // session the operator asked to run as ultradeep. Neither the rejection nor
    // the silence is acceptable — the value is ignored AND the ignoring is
    // recorded.
    const shape = resolveSessionShape({ sessionType: 'deep', profile: 'ultradeep', waves: 5 });
    expect(shape.totalWaves).toBe(7);
    expect(shape.wavesConfigHonored).toBe(false);
    expect(shape.wavesConfigIgnoredValue).toBe(5);
  });

  it('ultradeep wave 2 is the blocking coordinator-direct Synthesis-Gate', () => {
    // Bug: the Synthesis-Gate reduced to "a wave with 0 agents" loses the two
    // things that make it a gate — the ONE blocking AskUserQuestion before
    // wave 3, and the audit artifact wave 1 is consolidated into.
    const gate = resolveSessionShape({ sessionType: 'deep', profile: 'ultradeep' }).waves[1];
    expect(gate).toMatchObject({
      n: 2,
      role: 'Synthesis-Gate',
      coordinatorDirect: true,
      agentCap: 0,
      maxTurns: null,
      blockingAsk: true,
    });
    expect(gate.artifact).toContain('docs/audits/');
  });

  it('records a note when the configured waves value differs from the natural count', () => {
    // Bug: silently ignoring `waves: 7` for a plain deep session reproduces the
    // contradiction this module exists to end — the operator configured one
    // number, got another, and nothing said so.
    expect(resolveSessionShape({ sessionType: 'deep', waves: 5 }).notes).toEqual([]);
    expect(resolveSessionShape({ sessionType: 'deep', waves: 7 }).notes.join(' ')).toContain(
      'waves: 7 configured',
    );
  });
});

// ---------------------------------------------------------------------------
// Caps and turn budgets
// ---------------------------------------------------------------------------

describe('resolveSessionShape — caps and turns', () => {
  it('caps every wave at the per-type agents-per-wave value: {default:6, deep:18}', () => {
    // Bug: this repo's committed `agents-per-wave: 6 (deep: 18)` was read as a
    // flat 6 by both existing private resolvers. A deep Impl-Core wave then runs
    // 6 agents where 10 were budgeted and 18 allowed.
    const cap = { default: 6, deep: 18 };
    const deep = resolveSessionShape({ sessionType: 'deep', agentsPerWave: cap });
    expect(deep.waves.map((w) => w.agentCap)).toEqual([8, 10, 8, 6, 4]);

    const feature = resolveSessionShape({ sessionType: 'feature', agentsPerWave: cap });
    expect(feature.waves.map((w) => w.agentCap)).toEqual([4, 4, 2]);

    const tight = resolveSessionShape({ sessionType: 'deep', agentsPerWave: 3 });
    expect(tight.waves.map((w) => w.agentCap)).toEqual([3, 3, 3, 3, 3]);
    // The RAW tier number survives the clamp — otherwise "the cap bit" is
    // indistinguishable from "the tier is small".
    expect(tight.waves.map((w) => w.agentCapRaw)).toEqual([8, 10, 8, 6, 4]);
  });

  it('ultradeep reads the deep cap when no ultradeep key exists, and prefers one when it does', () => {
    // Bug: an ultradeep session is `session_type: deep` PLUS a profile. A cap
    // lookup keyed on the literal profile name finds nothing in the repos that
    // wrote `6 (deep: 18)` and falls back to 6, which caps the 18-agent Research
    // wave at 6 — the exact wave whose width is the point of the profile.
    const viaDeep = resolveSessionShape({
      sessionType: 'deep',
      profile: 'ultradeep',
      agentsPerWave: { default: 6, deep: 18 },
    });
    expect(viaDeep.waves[0].agentCap).toBe(18);

    const explicit = resolveSessionShape({
      sessionType: 'deep',
      profile: 'ultradeep',
      agentsPerWave: { default: 6, deep: 18, ultradeep: 12 },
    });
    expect(explicit.waves[0].agentCap).toBe(12);
  });

  it("expands maxTurns 'auto' per type, lets a number win, but never over an ultradeep per-role value", () => {
    // Bug: a numeric `max-turns: 10` applied blindly would cut the ultradeep
    // Research wave from 40 to 10 turns and, worse, fill the Synthesis-Gate's
    // deliberate `null` (no agent runs there) with a number — making a
    // coordinator-direct wave look dispatchable.
    expect(resolveSessionShape({ sessionType: 'feature' }).waves[0].maxTurns).toBe(15);
    expect(resolveSessionShape({ sessionType: 'deep', maxTurns: 12 }).waves[1].maxTurns).toBe(12);

    const ultra = resolveSessionShape({
      sessionType: 'deep',
      profile: 'ultradeep',
      maxTurns: 12,
    });
    expect(ultra.waves.map((w) => w.maxTurns)).toEqual([40, null, 12, 12, 12, 12, 15]);
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('resolveSessionShape — validation', () => {
  it('throws TypeError on an unknown session type', () => {
    // Bug: `session_type: 'ultradeep'` is the documented mistake
    // (session-schema/constants.mjs: a profile is NEVER a type). Degrading it to
    // a default shape would hand the operator a 5-wave plan for a 7-wave ask.
    expect(() => resolveSessionShape({ sessionType: 'ultradeep' })).toThrow(TypeError);
    expect(() => resolveSessionShape({ sessionType: '' })).toThrow(TypeError);
    expect(() => resolveSessionShape({})).toThrow(TypeError);
  });

  it('throws TypeError on an unknown profile instead of silently shaping as plain deep', () => {
    // Bug: this module is the FIRST consumer that branches on a profile value —
    // the revisit trigger named at scripts/lib/state-md.mjs:80-89. An
    // unrecognised profile degrading to the 5-wave shape is exactly the silent
    // mislabel that docstring warns the open vocabulary would eventually cause.
    expect(() => resolveSessionShape({ sessionType: 'deep', profile: 'turbo' })).toThrow(TypeError);
  });

  it("shapes session_type 'unknown' as deep rather than throwing", () => {
    // Bug: `unknown` is a VALID_SESSION_TYPES member (the ABSENCE of a
    // measurement, written only by the close-backfill). Throwing on it would
    // make a reconstructed record unshapeable; defaulting it to the narrowest
    // shape would under-plan a session nobody measured.
    const shape = resolveSessionShape({ sessionType: 'unknown' });
    expect(shape.totalWaves).toBe(5);
    expect(shape.sessionType).toBe('unknown');
    expect(shape.maxTurnsDefault).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// resolveAndRecordSessionShape — the record
// ---------------------------------------------------------------------------

describe('resolveAndRecordSessionShape', () => {
  it('emits one record whose payload matches the returned shape', () => {
    // Bug: the shape being resolvable is only half the fix. Until this event
    // existed, nothing in `.orchestrator/metrics/events.jsonl` said what shape a
    // session actually ran — which is why the 5-wave housekeeping sessions were
    // only ever found by hand.
    const repoRoot = makeRepo();
    return resolveAndRecordSessionShape({
      repoRoot,
      config: { waves: 5, 'agents-per-wave': { default: 6, deep: 18 }, 'max-turns': 'auto' },
      sessionType: 'deep',
      profile: 'ultradeep',
      taskCount: 4,
    }).then((shape) => {
      const records = readLedger(repoRoot).filter((r) => r.event === SESSION_SHAPE_EVENT);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        session_type: 'deep',
        session_profile: 'ultradeep',
        total_waves: 7,
        waves_config_honored: false,
        discovery: true,
        agent_caps: [18, 0, 8, 8, 3, 6, 4],
        coordinator_direct_waves: [2],
        shape_version: SESSION_SHAPE_VERSION,
        task_count: 4,
      });
      expect(records[0].agent_caps).toEqual(shape.waves.map((w) => w.agentCap));
    });
  });

  it('OMITS session_profile for a plain deep session — never null, never an empty string', () => {
    // Bug: a `session_profile: null` in the ledger reads as "measured, no
    // profile" where the honest encoding is an absent key; and a `''` would
    // pass any downstream truthiness check as a profile that does not exist.
    // Same absent-is-not-zero contract every sibling event follows.
    const repoRoot = makeRepo();
    return resolveAndRecordSessionShape({ repoRoot, sessionType: 'deep' }).then(() => {
      const record = readLedger(repoRoot).find((r) => r.event === SESSION_SHAPE_EVENT);
      expect(record).toBeDefined();
      expect(Object.hasOwn(record, 'session_profile')).toBe(false);
      expect(record.coordinator_direct_waves).toEqual([]);
    });
  });

  it('emits nothing at all when emit is false (the --no-event planning dry-run)', () => {
    // Bug: a planning dry-run that records itself puts a shape into the ledger
    // for a session that never ran, which corrupts exactly the count the event
    // exists to make honest.
    const repoRoot = makeRepo();
    return resolveAndRecordSessionShape({ repoRoot, sessionType: 'feature', emit: false }).then(
      (shape) => {
        expect(shape.totalWaves).toBe(3);
        expect(readLedger(repoRoot)).toEqual([]);
      },
    );
  });

  it('returns the shape unchanged when the emitter cannot write, and skips the ambient ledger', () => {
    // Bug, two halves. (a) Telemetry that can throw into the caller makes the
    // shape hostage to the ledger; the shape is authoritative whether or not the
    // record landed. (b) Without a repoRoot, `emitEvent` falls back to
    // SO_PROJECT_DIR — the #941 incident that put a synthetic record into the
    // operator's REAL fleet ledger. The SENTINEL assertion is what proves the
    // refusal rather than merely asserting the return value.
    return resolveAndRecordSessionShape({ sessionType: 'housekeeping' }).then((shape) => {
      expect(shape.totalWaves).toBe(1);
      expect(existsSync(SENTINEL_LEDGER)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Isolation + enforcement (per wave)
// ---------------------------------------------------------------------------

describe('resolveSessionShape — per-wave isolation and enforcement', () => {
  it('a 10-agent deep Impl-Core wave resolves isolation worktree, not none', () => {
    // Bug: the shape carried ONE session-level `isolationDefault: 'none'`, so a
    // plan header read `Isolation: none` for a wave dispatching ten WRITING
    // agents into a single working copy — while `resolveIsolation` (#194, the
    // real resolver) says `worktree` for every wave of >= 5 agents.
    const shape = resolveSessionShape({ sessionType: 'deep', agentsPerWave: 18 });
    const implCore = shape.waves.find((w) => w.role === 'Impl-Core');
    expect(implCore.agentCap).toBe(10);
    expect(implCore.isolation).toBe('worktree');
    // No session-level field survives: one number cannot answer a per-wave
    // question, and a stale one is worse than none.
    expect(Object.hasOwn(shape, 'isolationDefault')).toBe(false);
  });

  it('housekeeping and Discovery waves resolve isolation none', () => {
    // Bug: a worktree for a wave that dispatches nobody (coordinator-direct) or
    // writes nothing (read-only Discovery) costs a clone and isolates nothing —
    // and `resolveIsolation` throws outright on an agentCount below 1.
    const housekeeping = resolveSessionShape({ sessionType: 'housekeeping' });
    expect(housekeeping.waves.map((w) => w.isolation)).toEqual(['none']);

    const deep = resolveSessionShape({ sessionType: 'deep', agentsPerWave: 18 });
    const discovery = deep.waves.find((w) => w.role === 'Discovery');
    expect(discovery.writes).toBe(false);
    expect(discovery.isolation).toBe('none');
  });

  it("configIsolation: 'none' is honoured on every wave", () => {
    // Bug: an operator opt-out that the shape ignores makes the Session Config
    // key decorative — the whole `isolation:` surface stops meaning anything.
    const shape = resolveSessionShape({
      sessionType: 'deep',
      agentsPerWave: 18,
      configIsolation: 'none',
    });
    expect(shape.waves.map((w) => w.isolation)).toEqual(shape.waves.map(() => 'none'));
  });

  it('enforcement auto-promotes to strict when isolation is none, unless config says off', () => {
    // Bug: with isolation `none` the scope-enforcement hook is the ONLY barrier
    // between parallel agents and each other's files; leaving it at `warn` there
    // means every collision is logged and none is prevented.
    const promoted = resolveSessionShape({
      sessionType: 'deep',
      agentsPerWave: 18,
      configIsolation: 'none',
      configEnforcement: 'warn',
    });
    expect(promoted.waves.map((w) => w.enforcement)).toEqual(promoted.waves.map(() => 'strict'));

    const optedOut = resolveSessionShape({
      sessionType: 'deep',
      agentsPerWave: 18,
      configIsolation: 'none',
      configEnforcement: 'off',
    });
    expect(optedOut.waves.every((w) => w.enforcement === 'off')).toBe(true);

    // Under a worktree the config value passes through untouched.
    const isolated = resolveSessionShape({
      sessionType: 'deep',
      agentsPerWave: 18,
      configEnforcement: 'warn',
    });
    expect(isolated.waves.find((w) => w.role === 'Impl-Core')).toMatchObject({
      isolation: 'worktree',
      enforcement: 'warn',
    });
  });
});

// ---------------------------------------------------------------------------
// Degenerate caps and note ordering
// ---------------------------------------------------------------------------

describe('resolveSessionShape — degenerate agent caps', () => {
  it('notes a cap that resolves to 0 instead of returning a silent no-agent plan', () => {
    // Bug: `agents-per-wave: 0` produced every wave at `agentCap: 0` with NO
    // note — textually indistinguishable from a normal plan, so the coordinator
    // approves a session that would dispatch nobody.
    const flat = resolveSessionShape({ sessionType: 'deep', agentsPerWave: 0 });
    expect(flat.waves.every((w) => w.agentCap === 0)).toBe(true);
    expect(flat.notes.join(' ')).toContain('dispatch nobody');

    const viaObject = resolveSessionShape({
      sessionType: 'deep',
      agentsPerWave: { default: 6, deep: 0 },
    });
    expect(viaObject.notes.join(' ')).toContain('agents-per-wave resolves to 0');

    // A healthy cap must NOT carry the note — otherwise it is noise, not a signal.
    const healthy = resolveSessionShape({ sessionType: 'deep', agentsPerWave: 6 });
    expect(healthy.notes.join(' ')).not.toContain('dispatch nobody');
  });

  it('lists the housekeeping maintenance loop in EXECUTION order, drift-check first', () => {
    // Bug: the note listed the loop in signal order (evolve, sweep, reconcile,
    // dialectic, memory-cleanup, drift-check). A coordinator following that runs
    // the drift check LAST — against a learnings store that evolve, reconcile and
    // memory-cleanup have just rewritten, so it measures its own session's edits.
    // Execution order is the numbered table in skills/wave-executor/SKILL.md
    // § "Housekeeping Sessions — the Maintenance Loop".
    const shape = resolveSessionShape({ sessionType: 'housekeeping' });
    const note = shape.notes.find((n) => n.includes('maintenance loop'));
    expect(note).toBe(
      'housekeeping is the maintenance loop, in execution order: ' +
        'drift-check, sweep, evolve, reconcile, dialectic, memory-cleanup',
    );
  });
});
