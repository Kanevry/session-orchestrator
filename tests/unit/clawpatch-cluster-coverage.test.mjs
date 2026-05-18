/**
 * tests/unit/clawpatch-cluster-coverage.test.mjs
 *
 * Closes the W4-Q3 qa-strategist deferred LOW-14..LOW-19 gaps and the two
 * integration scenarios identified in the "Integration Gaps" section of
 * .orchestrator/audits/wave-reviewer-4-qa-strategist.md.
 *
 * Issue: #455 (W3-P1)
 *
 * Each `it(...)` cites its audit reference in the form:
 *   // Audit: LOW-NN — <one-line description>
 *
 * LOW gap inventory:
 *   LOW-14 — loadAgentSchema: extended-schema agents (reviewer class) validate correctly
 *   LOW-15 — validateTierConsistency: all 4 tiers including network-allowed + dangerous
 *   LOW-16 — loadTriageState: handles a very large number of entries without crashing
 *   LOW-17 — runWavePool: AbortController worker signal is actually passed to dispatch
 *   LOW-18 — changedFilesSince: ref with leading/trailing whitespace is trimmed correctly
 *   LOW-19 — languageFromPath: uppercase extension is normalised to lowercase
 *
 * Integration scenarios:
 *   INT-1 — "slice → triage" pipeline: extractSemanticSlices feeds computeFingerprint
 *   INT-2 — agent-output-schema: all 11 declared schemas load and validate correctly
 *
 * Import notes:
 *   - discovery/helpers.mjs lives at scripts/lib/discovery/helpers.mjs → @lib/discovery/helpers.mjs
 *   - language-mappers live at scripts/lib/language-mappers/*.mjs → @lib/language-mappers/*.mjs
 *   - These are static imports here; dynamic-import cache-busting is only needed
 *     when tests share a process and need module isolation (not the case here).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Module imports — all via @lib alias (maps to scripts/lib/)
// ---------------------------------------------------------------------------

import {
  loadAgentSchema,
  validateAgentOutput,
  _clearCompileCache,
} from '@lib/agent-output-schema.mjs';

import { TIER_ENUM, validateTierConsistency } from '@lib/validate/tier-inference.mjs';

import {
  computeFingerprint,
  loadTriageState,
  appendTriageEntry,
} from '@lib/discovery/triage-state.mjs';

import { runWavePool } from '@lib/wave-executor/pool.mjs';

import { changedFilesSince } from '@lib/discovery/helpers.mjs';

import {
  languageFromPath,
  extractSemanticSlices,
} from '@lib/language-mappers/index.mjs';

// ---------------------------------------------------------------------------
// LOW-14 — loadAgentSchema: reviewer-class agents now have schemas; verify
//           that all 11 declared agents load successfully with a proper $schema
//           field, and that 'unvalidated' mode no longer fires for them.
// ---------------------------------------------------------------------------

describe('LOW-14 — loadAgentSchema: all 11 declared agent schemas are loadable', () => {
  // Audit: LOW-14 — 7 reviewer/specialist agents (session-reviewer, security-reviewer,
  // qa-strategist, architect-reviewer, analyst, ux-evaluator, docs-writer) had no schema
  // at review time. Verify they now load correctly.

  const ALL_SCHEMA_AGENTS = [
    // Original 4 implementer agents (already partially covered)
    'code-implementer',
    'db-specialist',
    'test-writer',
    'ui-developer',
    // The 7 reviewer/specialist agents added in the extended schema cluster
    'session-reviewer',
    'security-reviewer',
    'qa-strategist',
    'architect-reviewer',
    'analyst',
    'ux-evaluator',
    'docs-writer',
  ];

  it.each(ALL_SCHEMA_AGENTS)(
    'loads a valid schema for %s — returns non-null object with $schema field',
    async (agentName) => {
      // Audit: LOW-14 — each declared agent must have a readable, parseable schema
      const schema = await loadAgentSchema(agentName);
      expect(schema, `schema for ${agentName} should not be null`).not.toBeNull();
      expect(schema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
    },
  );

  it('loads at least 11 distinct schemas (floor: 11, ceiling: 30)', async () => {
    // Audit: LOW-14 — count guard against accidental deletion or uncontrolled growth
    const schemas = await Promise.all(ALL_SCHEMA_AGENTS.map((a) => loadAgentSchema(a)));
    const loaded = schemas.filter((s) => s !== null).length;
    expect(loaded).toBeGreaterThanOrEqual(11);
    expect(loaded).toBeLessThanOrEqual(30);
  });

  it('session-reviewer schema: validateAgentOutput returns mode=validated on a compliant output', async () => {
    // Audit: LOW-14 — schema is wired end-to-end: extraction + validation should work
    _clearCompileCache();
    const raw =
      '```json\n' +
      JSON.stringify({
        verdict: 'PROCEED',
        total_findings: 0,
        high_confidence: 0,
        categories: {
          implementation: 'PASS',
          tests: 'PASS',
          typescript: 'PASS',
          security: 'PASS',
        },
        fix_required: [],
      }) +
      '\n```';
    const result = await validateAgentOutput({ agentName: 'session-reviewer', raw });
    expect(result.mode).toBe('validated');
    expect(result.ok).toBe(true);
  });

  it('security-reviewer schema: validateAgentOutput returns mode=validated on a compliant output', async () => {
    // Audit: LOW-14 — security-reviewer schema validates its own output format correctly
    _clearCompileCache();
    const raw =
      '```json\n' +
      JSON.stringify({
        verdict: 'PROCEED',
        finding_counts: { high: 0, med: 0, low: 0 },
        files_reviewed: 5,
        phases: { context: true, comparative: true, assessment: true },
      }) +
      '\n```';
    const result = await validateAgentOutput({ agentName: 'security-reviewer', raw });
    expect(result.mode).toBe('validated');
    expect(result.ok).toBe(true);
  });

  it('session-reviewer schema: rejects output with invalid verdict enum', async () => {
    // Audit: LOW-14 — schema constraint on enum values is enforced for reviewer agents
    _clearCompileCache();
    const raw =
      '```json\n' +
      JSON.stringify({
        verdict: 'UNKNOWN_VERDICT', // not in enum
        total_findings: 0,
        high_confidence: 0,
        categories: {
          implementation: 'PASS',
          tests: 'PASS',
          typescript: 'PASS',
          security: 'PASS',
        },
        fix_required: [],
      }) +
      '\n```';
    const result = await validateAgentOutput({ agentName: 'session-reviewer', raw });
    expect(result.mode).toBe('validated');
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LOW-15 — tier-inference: all 16 tier-consistency combinations
//          (4 declared × 4 inferred tiers) are table-driven
// ---------------------------------------------------------------------------

describe('LOW-15 — validateTierConsistency: all declared × inferred tier combinations', () => {
  // Audit: LOW-15 — TIER_ENUM has 4 values; only 2 (read-only, repo-write) were
  // exercised. Table-driven test covers all 16 combinations with expected outcomes.

  // The only constraint: declared='read-only' + inferred != 'read-only' → FAIL.
  // All other combinations with a valid declared tier → ok:true.
  const COMBINATIONS = [
    // declared='read-only' rows
    { declared: 'read-only',       inferred: 'read-only',       tools: ['Read'],  expectOk: true },
    { declared: 'read-only',       inferred: 'repo-write',      tools: ['Edit'],  expectOk: false },
    { declared: 'read-only',       inferred: 'network-allowed', tools: ['Edit'],  expectOk: false },
    { declared: 'read-only',       inferred: 'dangerous',       tools: ['Edit'],  expectOk: false },
    // declared='repo-write' rows
    { declared: 'repo-write',      inferred: 'read-only',       tools: ['Read'],  expectOk: true },
    { declared: 'repo-write',      inferred: 'repo-write',      tools: ['Edit'],  expectOk: true },
    { declared: 'repo-write',      inferred: 'network-allowed', tools: ['Edit'],  expectOk: true },
    { declared: 'repo-write',      inferred: 'dangerous',       tools: ['Edit'],  expectOk: true },
    // declared='network-allowed' rows (valid enum, no constraint violation)
    { declared: 'network-allowed', inferred: 'read-only',       tools: ['Read'],  expectOk: true },
    { declared: 'network-allowed', inferred: 'repo-write',      tools: ['Edit'],  expectOk: true },
    { declared: 'network-allowed', inferred: 'network-allowed', tools: ['Edit'],  expectOk: true },
    { declared: 'network-allowed', inferred: 'dangerous',       tools: ['Edit'],  expectOk: true },
    // declared='dangerous' rows (valid enum, no constraint)
    { declared: 'dangerous',       inferred: 'read-only',       tools: ['Read'],  expectOk: true },
    { declared: 'dangerous',       inferred: 'repo-write',      tools: ['Edit'],  expectOk: true },
    { declared: 'dangerous',       inferred: 'network-allowed', tools: ['Edit'],  expectOk: true },
    { declared: 'dangerous',       inferred: 'dangerous',       tools: ['Edit'],  expectOk: true },
  ];

  it.each(COMBINATIONS)(
    'declared=$declared inferred=$inferred → ok=$expectOk',
    ({ declared, inferred, tools, expectOk }) => {
      // Audit: LOW-15 — parametrised coverage of all 16 declared × inferred combinations
      const result = validateTierConsistency({ declared, inferred, tools });
      expect(result.ok).toBe(expectOk);
      if (!expectOk) {
        // When not ok, an error string must be present
        expect(typeof result.error).toBe('string');
        expect(result.error.length).toBeGreaterThan(0);
      }
    },
  );

  it('all 4 TIER_ENUM values are valid declared tiers — no unexpected invalid-tier errors', () => {
    // Audit: LOW-15 — every enum value accepted by the validator when used with read-only tools
    for (const tier of TIER_ENUM) {
      const result = validateTierConsistency({
        declared: tier,
        inferred: 'read-only',
        tools: ['Read'],
      });
      expect(result.ok).toBe(true);
    }
  });

  it('network-allowed declared with repo-write inferred returns ok:true — "declared higher than inferred" branch', () => {
    // Audit: LOW-15 — documents the "declared higher than inferred is OK" branch
    const result = validateTierConsistency({
      declared: 'network-allowed',
      inferred: 'repo-write',
      tools: ['Edit'],
    });
    expect(result.ok).toBe(true);
  });

  it('dangerous declared with repo-write inferred returns ok:true', () => {
    // Audit: LOW-15 — dangerous tier accepts any tool combination
    const result = validateTierConsistency({
      declared: 'dangerous',
      inferred: 'repo-write',
      tools: ['Read', 'Edit', 'Write', 'Bash'],
    });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// LOW-16 — loadTriageState: handles very large entry counts without crashing
// ---------------------------------------------------------------------------

describe('LOW-16 — loadTriageState: large entry count does not crash', () => {
  // Audit: LOW-16 — a discovery session over months could accumulate 10K+ entries.
  // loadTriageState uses readFile + split('\n') — verify it handles 500 entries
  // (pragmatic bound; full 10MB deferred to a dedicated perf test in W5).

  let tmp;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'triage-large-'));
  });
  afterEach(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('loads 500 distinct entries without throwing', async () => {
    // Audit: LOW-16 — baseline stress test confirming no synchronous buffer overflow
    const file = join(tmp, 'large.jsonl');
    const fps = [];
    for (let i = 0; i < 500; i++) {
      const fp = computeFingerprint({
        probe: `probe-${i}`,
        file: `src/file-${i}.ts`,
        severity: 'high',
        ruleId: `rule-${i}`,
      });
      fps.push(fp);
      await appendTriageEntry(file, {
        fingerprint: fp,
        state: 'open',
        timestamp: '2026-01-01T00:00:00.000Z',
        session_id: `session-${i}`,
      });
    }

    const map = await loadTriageState(file);
    expect(map).toBeInstanceOf(Map);
    expect(map.size).toBe(500);
    // Spot-check first and last fingerprints
    expect(map.has(fps[0])).toBe(true);
    expect(map.has(fps[499])).toBe(true);
  }, 30000); // allow up to 30s for 500 sequential writes

  it('last-writer-wins still applies across 200 sequential updates of the same fingerprint', async () => {
    // Audit: LOW-16 — LWW semantic must hold regardless of entry count
    const file = join(tmp, 'lww.jsonl');
    const fp = computeFingerprint({ probe: 'lp', file: 'lp.ts', severity: 'med', ruleId: 'lrule' });
    const STATES = ['open', 'dismissed', 'reopened', 'accepted-as-known'];

    for (let i = 0; i < 200; i++) {
      const state = STATES[i % STATES.length];
      await appendTriageEntry(file, {
        fingerprint: fp,
        state,
        timestamp: `2026-01-01T00:00:00.000Z`,
        session_id: `sess-${i}`,
      });
    }

    const map = await loadTriageState(file);
    expect(map.size).toBe(1);
    // Last state is entry at index 199: 199 % 4 = 3 → 'accepted-as-known'
    expect(map.get(fp).state).toBe('accepted-as-known');
  }, 30000);
});

// ---------------------------------------------------------------------------
// LOW-17 — runWavePool: AbortController worker signal is actually passed to dispatch
// ---------------------------------------------------------------------------

describe('LOW-17 — runWavePool: per-worker AbortController signal is passed to dispatch', () => {
  // Audit: LOW-17 — pool.mjs:167 passes workerController.signal to task.dispatch(signal).
  // A regression where pool.mjs accidentally passes undefined instead would not be
  // caught by the abort test alone (it tests abort timing, not signal identity).
  // This test verifies the signal IS a real AbortSignal received by dispatch.

  it('dispatch receives an AbortSignal (not undefined) when no external abort', async () => {
    // Audit: LOW-17 — worker signal must be a real AbortSignal object
    let receivedSignal;
    const tasks = [
      {
        taskId: 'sig-test',
        dispatch: async (signal) => {
          receivedSignal = signal;
          return 'done';
        },
      },
    ];
    await runWavePool({ tasks, maxParallel: 1 });
    // Must be a real AbortSignal (has .aborted property)
    expect(receivedSignal).toBeDefined();
    expect(typeof receivedSignal.aborted).toBe('boolean');
    // Before pool abort, signal must not be in aborted state
    expect(receivedSignal.aborted).toBe(false);
  });

  it('each task receives an INDEPENDENT AbortSignal — distinct object per task', async () => {
    // Audit: LOW-17 — each task gets its own per-worker controller; signals are distinct
    const signals = [];
    const tasks = [0, 1, 2].map((i) => ({
      taskId: String(i),
      dispatch: async (signal) => {
        signals.push(signal);
        return i;
      },
    }));
    await runWavePool({ tasks, maxParallel: 3 });
    expect(signals).toHaveLength(3);
    // All must be AbortSignal instances (have .aborted boolean property)
    for (const s of signals) {
      expect(typeof s.aborted).toBe('boolean');
    }
    // Each must be a distinct object (independent per-worker controllers)
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals[1]).not.toBe(signals[2]);
    expect(signals[0]).not.toBe(signals[2]);
  });

  it('worker signal transitions to aborted:true after pool abort fires', async () => {
    // Audit: LOW-17 — when pool aborts, the per-worker signal transitions to aborted:true
    const controller = new AbortController();
    const abortedSignals = [];

    const tasks = Array.from({ length: 3 }, (_, i) => ({
      taskId: String(i),
      dispatch: async (signal) => {
        if (i === 0) {
          // Trigger abort after first task starts
          setTimeout(() => controller.abort(), 5);
        }
        return new Promise((res, rej) => {
          const t = setTimeout(() => {
            res(i);
          }, 80);
          signal.addEventListener('abort', () => {
            clearTimeout(t);
            abortedSignals.push(signal);
            rej(new Error('aborted'));
          }, { once: true });
        });
      },
    }));

    await runWavePool({
      tasks,
      maxParallel: 2,
      abortSignal: controller.signal,
      drainTimeoutMs: 200,
    });

    // At least one task must have seen its signal fire (aborted)
    expect(abortedSignals.length).toBeGreaterThanOrEqual(1);
    // Each fired signal must be in aborted state
    for (const s of abortedSignals) {
      expect(s.aborted).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// LOW-18 — changedFilesSince: ref with leading/trailing whitespace is trimmed
// ---------------------------------------------------------------------------

describe('LOW-18 — changedFilesSince: whitespace-padded ref is trimmed to valid ref', () => {
  // Audit: LOW-18 — the function calls ref.trim() at the top; '  HEAD  ' should
  // behave identically to 'HEAD'. This was noted as trivial but untested.

  it('"  HEAD  " (whitespace-padded HEAD) resolves to the same result as "HEAD"', async () => {
    // Audit: LOW-18 — leading/trailing whitespace stripped before git rev-parse
    const resultStripped = await changedFilesSince('HEAD');
    const resultPadded = await changedFilesSince('  HEAD  ');
    // Both must return the same empty array (HEAD..HEAD diff is always empty)
    expect(resultPadded).toEqual(resultStripped);
    expect(resultPadded).toEqual([]);
  });

  it('"\\tHEAD\\t" (tab-padded HEAD) resolves without throwing', async () => {
    // Audit: LOW-18 — trim() strips tabs as well as spaces
    const result = await changedFilesSince('\tHEAD\t');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([]);
  });

  it('"HEAD  " (trailing-only whitespace) resolves to the same result as "HEAD"', async () => {
    // Audit: LOW-18 — trailing-only whitespace is also stripped
    const result = await changedFilesSince('HEAD  ');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// LOW-19 — languageFromPath: uppercase extension normalised to lowercase
// ---------------------------------------------------------------------------

describe('LOW-19 — languageFromPath: uppercase + mixed-case extensions are normalised', () => {
  // Audit: LOW-19 — EXT_TO_LANG keys are lowercase; languageFromPath calls .toLowerCase()
  // at line 60. A test with 'foo.TS' documents this contract.

  it('returns "ts" for .TS (uppercase extension)', () => {
    // Audit: LOW-19 — uppercased extension is normalised via .toLowerCase()
    expect(languageFromPath('foo.TS')).toBe('ts');
  });

  it('returns "ts" for .Tsx (mixed-case extension)', () => {
    // Audit: LOW-19 — mixed-case TSX extension also normalised
    expect(languageFromPath('Component.Tsx')).toBe('ts');
  });

  it('returns "md" for .MD (uppercase)', () => {
    // Audit: LOW-19 — markdown extension uppercased
    expect(languageFromPath('README.MD')).toBe('md');
  });

  it('returns "js" for .MJS (uppercase)', () => {
    // Audit: LOW-19 — mjs uppercase → js language key
    expect(languageFromPath('scripts/lib/common.MJS')).toBe('js');
  });

  it('returns null for .UNKNOWN (no match after lowercasing)', () => {
    // Audit: LOW-19 — unknown extension returns null regardless of case
    expect(languageFromPath('file.UNKNOWN')).toBeNull();
  });

  it('extractSemanticSlices dispatches correctly for "foo.TS" (uppercase extension)', async () => {
    // Audit: LOW-19 — languageFromPath feeds extractSemanticSlices; uppercase ext must dispatch
    const slices = await extractSemanticSlices('foo.TS', 'export function hello() {}');
    expect(Array.isArray(slices)).toBe(true);
    expect(slices.length).toBe(1);
    expect(slices[0].kind).toBe('function');
    expect(slices[0].name).toBe('hello');
  });
});

// ---------------------------------------------------------------------------
// Integration Gap 1 (INT-1) — "slice → triage" pipeline:
//   extractSemanticSlices produces slices whose fields feed into
//   computeFingerprint correctly.
//
//   The Clawpatch modules form a pipeline:
//     changed-files → language-mappers → triage-state
//   No test exercises 2+ modules together; this closes that gap.
// ---------------------------------------------------------------------------

describe('INT-1 — slice → triage pipeline: extractSemanticSlices output feeds computeFingerprint', () => {
  // Audit: Integration Gaps — "No end-to-end test: extract slices from a real
  // session-orchestrator source file, then schema-validate"

  let tmp;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'int1-'));
  });
  afterEach(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('slice kind+name fields produce a stable fingerprint when used as triage keys', async () => {
    // Audit: INT-1 — verify the pipeline contract: slices from the mapper can
    // be turned into fingerprints that are deterministic across calls.
    const content = [
      'export function computeStuff(x) {',
      '  return x * 2;',
      '}',
      '',
      'export class Processor {',
      '  run() { return 42; }',
      '}',
    ].join('\n');

    const slices = await extractSemanticSlices('src/compute.ts', content);
    expect(slices.length).toBeGreaterThanOrEqual(2);

    // Map each slice to a triage finding-like object and fingerprint it
    const fingerprints = slices.map((slice) =>
      computeFingerprint({
        probe: 'language-mapper',
        file: 'src/compute.ts',
        severity: 'low',
        ruleId: `${slice.kind}:${slice.name}`,
      }),
    );

    // All fingerprints must be 16-char hex
    for (const fp of fingerprints) {
      expect(fp).toMatch(/^[0-9a-f]{16}$/);
    }

    // All fingerprints must be distinct (different ruleId → different fingerprint)
    const unique = new Set(fingerprints);
    expect(unique.size).toBe(fingerprints.length);
  });

  it('round-trip: markdown slices → fingerprints → appendTriageEntry → loadTriageState → all entries readable', async () => {
    // Audit: INT-1 — full end-to-end: slice extraction, triage persistence, reload
    const content = [
      '## Installation',
      '',
      'Run npm install.',
      '',
      '## Configuration',
      '',
      'Set your env vars.',
    ].join('\n');

    const slices = await extractSemanticSlices('SETUP.md', content);
    expect(slices.length).toBe(2); // Installation + Configuration

    const file = join(tmp, 'slice-triage.jsonl');

    // Persist each slice as a triage entry using its kind+name as ruleId
    const fps = [];
    const names = [];
    for (const slice of slices) {
      const fp = computeFingerprint({
        probe: 'md-section-check',
        file: 'SETUP.md',
        severity: 'low',
        ruleId: `section:${slice.name}`,
      });
      fps.push(fp);
      names.push(slice.name);
      await appendTriageEntry(file, {
        fingerprint: fp,
        state: 'open',
        timestamp: '2026-01-01T00:00:00.000Z',
        session_id: 'int-test',
      });
    }

    // Reload and verify all entries are present
    const map = await loadTriageState(file);
    expect(map.size).toBe(2);
    for (const fp of fps) {
      expect(map.has(fp)).toBe(true);
      expect(map.get(fp).state).toBe('open');
    }

    // Slice names must be the headings from the markdown
    const sortedNames = [...names].sort();
    expect(sortedNames).toEqual(['Configuration', 'Installation']);
  });

  it('TypeScript slice round-trip: function slices produce fingerprints loadable from triage', async () => {
    // Audit: INT-1 — TypeScript source path through the pipeline
    const content = [
      'export function alpha() { return 1; }',
      'export function beta() { return 2; }',
      'export function gamma() { return 3; }',
    ].join('\n');

    const slices = await extractSemanticSlices('lib/funcs.ts', content);
    const fnSlices = slices.filter((s) => s.kind === 'function');
    expect(fnSlices.length).toBe(3);

    const file = join(tmp, 'fn-triage.jsonl');
    const fps = [];
    for (const slice of fnSlices) {
      const fp = computeFingerprint({
        probe: 'fn-check',
        file: 'lib/funcs.ts',
        severity: 'low',
        ruleId: `fn:${slice.name}`,
      });
      fps.push(fp);
      await appendTriageEntry(file, {
        fingerprint: fp,
        state: 'open',
        timestamp: '2026-01-01T00:00:00.000Z',
        session_id: 'ts-int-test',
      });
    }

    const map = await loadTriageState(file);
    expect(map.size).toBe(3);
    for (const fp of fps) {
      expect(map.has(fp)).toBe(true);
    }
  });

  it('fingerprint is stable across two independent extractions of identical content', async () => {
    // Audit: INT-1 — the pipeline must be deterministic: same source → same fingerprint
    const content = '## Stable Section\n\nContent.';
    const slices1 = await extractSemanticSlices('doc.md', content);
    const slices2 = await extractSemanticSlices('doc.md', content);

    expect(slices1.length).toBe(1);
    expect(slices2.length).toBe(1);

    const fp1 = computeFingerprint({
      probe: 'stability-check',
      file: 'doc.md',
      severity: 'low',
      ruleId: `section:${slices1[0].name}`,
    });
    const fp2 = computeFingerprint({
      probe: 'stability-check',
      file: 'doc.md',
      severity: 'low',
      ruleId: `section:${slices2[0].name}`,
    });
    // Same input → same fingerprint (determinism guarantee)
    expect(fp1).toBe(fp2);
    expect(fp1).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ---------------------------------------------------------------------------
// Integration Gap 2 (INT-2) — agent-output-schema: all 11 declared schemas
//   load and validate compliant outputs correctly.
//   "No round-trip test: agent-output-schema against the actual agent output format"
// ---------------------------------------------------------------------------

describe('INT-2 — agent-output-schema: all 11 declared schemas validate representative outputs', () => {
  // Audit: Integration Gaps — "No round-trip test: agent-output-schema against
  // the actual code-implementer.md agent output format"

  beforeEach(() => {
    _clearCompileCache();
  });

  // Representative compliant output fixtures per agent, based on each schema's required fields.
  const AGENT_FIXTURES = {
    'code-implementer': {
      status: 'done',
      task_id: 'CI-INT-1',
      files_changed: [{ path: 'src/foo.ts', description: 'added' }],
      blockers: [],
    },
    'db-specialist': {
      status: 'done',
      task_id: 'DB-INT-1',
      files_changed: ['migrations/001_add_users.sql'],
      blockers: [],
    },
    'test-writer': {
      status: 'done',
      task_id: 'TW-INT-1',
      files_changed: [{ path: 'tests/foo.test.ts', tests_added: 4 }],
      blockers: [],
    },
    'ui-developer': {
      status: 'done',
      task_id: 'UI-INT-1',
      files_changed: [{ path: 'src/components/Foo.tsx' }],
      blockers: [],
    },
    'session-reviewer': {
      verdict: 'PROCEED',
      total_findings: 0,
      high_confidence: 0,
      categories: {
        implementation: 'PASS',
        tests: 'PASS',
        typescript: 'PASS',
        security: 'PASS',
      },
      fix_required: [],
    },
    'security-reviewer': {
      verdict: 'PROCEED',
      finding_counts: { high: 0, med: 0, low: 0 },
      files_reviewed: 5,
      phases: { context: true, comparative: true, assessment: true },
    },
    'qa-strategist': {
      verdict: 'PROCEED',
      report_path: '.orchestrator/audits/wave-reviewer-qa.md',
      gap_counts: { high: 0, med: 0, low: 0 },
      source_files_reviewed: 3,
      test_files_reviewed: 3,
    },
    'architect-reviewer': {
      verdict: 'PROCEED',
      report_path: '.orchestrator/audits/wave-reviewer-architect.md',
      finding_counts: { high: 0, med: 0, low: 0 },
      files_reviewed: 5,
    },
    'analyst': {
      verdict: 'PROCEED',
      report_path: '.orchestrator/audits/wave-reviewer-analyst.md',
      finding_counts: { high: 0, med: 0, low: 0 },
      scope_drift_count: 0,
      criteria_reviewed: 4,
    },
    'ux-evaluator': {
      verdict: 'PROCEED',
      run_id: 'ux-run-001',
      rubric_version: '1.0',
      checks_applied: 5,
      findings_count: 0,
      findings_path: '.orchestrator/audits/ux-findings.md',
    },
    'docs-writer': {
      verdict: 'PROCEED',
      status: 'done',
      files_updated: [{ path: 'docs/api.md', audience: 'dev', sections: ['Overview'] }],
    },
  };

  it.each(Object.keys(AGENT_FIXTURES))(
    '%s: validateAgentOutput returns mode=validated AND ok=true (schema-compliant fixture)',
    async (agentName) => {
      // Audit: INT-2 — each declared agent's schema must be end-to-end reachable via
      // validateAgentOutput AND the fixture must satisfy the schema (HIGH-001 fold-in:
      // tightened from mode-only check to full schema-compliance check, exposing
      // silent-pass risk where invalid fixtures previously passed green)
      const raw = '```json\n' + JSON.stringify(AGENT_FIXTURES[agentName]) + '\n```';
      const result = await validateAgentOutput({ agentName, raw });
      expect(result.mode).not.toBe('unvalidated');
      expect(result.mode).toBe('validated');
      expect(result.ok).toBe(true);
    },
  );

  it('code-implementer round-trip: fixture passes schema validation (ok=true)', async () => {
    // Audit: INT-2 — the canonical implementer agent fixture fully satisfies its schema
    const raw = '```json\n' + JSON.stringify(AGENT_FIXTURES['code-implementer']) + '\n```';
    const result = await validateAgentOutput({ agentName: 'code-implementer', raw });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('validated');
    expect(result.parsed.status).toBe('done');
  });

  it('session-reviewer round-trip: fixture passes schema validation (ok=true)', async () => {
    // Audit: INT-2 — session-reviewer fixture satisfies its schema
    const raw = '```json\n' + JSON.stringify(AGENT_FIXTURES['session-reviewer']) + '\n```';
    const result = await validateAgentOutput({ agentName: 'session-reviewer', raw });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('validated');
  });

  it('security-reviewer round-trip: fixture passes schema validation (ok=true)', async () => {
    // Audit: INT-2 — security-reviewer fixture satisfies its schema
    const raw = '```json\n' + JSON.stringify(AGENT_FIXTURES['security-reviewer']) + '\n```';
    const result = await validateAgentOutput({ agentName: 'security-reviewer', raw });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('validated');
  });

  it('qa-strategist round-trip: fixture passes schema validation (ok=true)', async () => {
    // Audit: INT-2 — qa-strategist fixture satisfies its schema
    const raw = '```json\n' + JSON.stringify(AGENT_FIXTURES['qa-strategist']) + '\n```';
    const result = await validateAgentOutput({ agentName: 'qa-strategist', raw });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('validated');
  });

  it('all 11 schema agents return mode=validated — zero unvalidated (floor check)', async () => {
    // Audit: INT-2 — none of the 11 declared agents should fall into unvalidated mode
    const agents = Object.keys(AGENT_FIXTURES);
    expect(agents.length).toBe(11);

    const results = await Promise.all(
      agents.map((agentName) => {
        const raw = '```json\n' + JSON.stringify(AGENT_FIXTURES[agentName]) + '\n```';
        return validateAgentOutput({ agentName, raw });
      }),
    );

    const unvalidatedCount = results.filter((r) => r.mode === 'unvalidated').length;
    expect(unvalidatedCount).toBe(0);

    const validatedCount = results.filter((r) => r.mode === 'validated').length;
    expect(validatedCount).toBe(11);
  });
});
