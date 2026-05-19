/**
 * tests/lib/wave-executor/persona-gate-hook.test.mjs
 *
 * Vitest suite for the wave-executor Persona-Gate Hook (issue #481 / #458 follow-on).
 *
 * The hook lives in skills/wave-executor/wave-loop.md § "3b. Persona-Gate Hook"
 * as procedural Markdown. This suite inlines a pure-function simulation of the
 * hook contract — the same pattern used by wave-loop-schema-validation.test.mjs.
 * Do NOT try to execute Markdown; test the LOGIC that the Markdown describes.
 *
 * Contract under test (from wave-loop.md § 3b):
 *   - Gate conditions: enabled=true, wave matches cfg.after, mode !== 'off'
 *   - mode=off → silent no-op, no dispatch
 *   - mode=warn → log dissent, continue regardless of final_verdict
 *   - mode=strict + PROCEED → continue, no AUQ
 *   - mode=strict + non-PROCEED → AUQ with 3 options: proceed-as-is, revise-remaining-waves, abort-session
 *   - AUQ answer proceed-as-is → PROCEED_WITH_FOLLOWUPS + Deviation written
 *   - AUQ answer revise-remaining-waves → FIX_REQUIRED + revision_context
 *   - AUQ answer abort-session → BLOCKED
 *   - catalog empty + require-personas:true → throw
 *   - catalog empty + require-personas:false → silent skip
 *   - dispatch-error on 1-of-6 → conservative-error rule fires; consolidator gets FAIL vote
 *   - 6 personas dispatched → sidecar written via writeJsonAtomic, validated against schema
 *   + 4 boundary tests
 */

import { describe, it, expect, vi } from 'vitest';
import { consolidate } from '../../../scripts/lib/persona-panel/consolidator.mjs';
import { parseThreshold } from '../../../scripts/lib/persona-panel/threshold.mjs';

// ---------------------------------------------------------------------------
// Inline simulation of the Persona-Gate Hook contract
//
// The hook is described in wave-loop.md § 3b. This pure-function simulation
// captures:
//   - gate conditions (enabled, after-wave match, mode ≠ off)
//   - dispatch sequence (loadCatalog, buildPersonaPrompt, validatePersonaOutput,
//     consolidate, writeJsonAtomic, appendDeviation)
//   - behaviour table (off / warn / strict × final_verdict)
//   - AUQ paths (proceed-as-is / revise-remaining-waves / abort-session)
//   - sidecar write contract
//
// All external I/O is injected as function parameters so the hook logic can
// be tested without hitting the filesystem, Agent tool, or AUQ tool.
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} PersonaGateCfg
 * @property {boolean} enabled
 * @property {string}  after         - 'quality' | 'impl-polish'
 * @property {string}  threshold     - spec string, e.g. 'all', '5-of-6'
 * @property {string[]} personas     - empty = all catalog
 * @property {string}  mode          - 'off' | 'warn' | 'strict'
 * @property {boolean} [require-personas] - when true throw on empty catalog
 */

/**
 * Simulate the Persona-Gate Hook execution for one wave completion.
 *
 * @param {object} opts
 * @param {PersonaGateCfg}   opts.cfg             - normalised session config block
 * @param {string}           opts.completedWave   - wave name that just finished
 * @param {Map<string, object>} opts.catalog       - persona name → spec
 * @param {Function}         opts.dispatchPersona  - (personaSpec, waveContext) → Promise<string>; injected mock
 * @param {Function}         opts.validateOutput   - (persona, text) → Promise<{ok, mode, ...}>; injected mock
 * @param {Function}         opts.askUser          - (options) → Promise<string>; injected mock for AUQ
 * @param {Function}         opts.writeAtomic      - (path, value) → Promise<{path, bytes}>; injected mock
 * @param {Function}         opts.appendDev        - (stateContents, iso, msg) → string; injected mock
 * @param {string}           [opts.waveContext]    - scope summary passed to prompt builder
 * @param {string}           [opts.stateContents]  - current STATE.md contents
 * @param {string}           [opts.runId]          - run identifier for sidecar
 *
 * @returns {Promise<{
 *   skipped: boolean,
 *   verdict?: string,
 *   sidecarPath?: string,
 *   revision_context?: object,
 *   deviationWritten: boolean,
 *   dissenters: string[],
 *   auqInvoked: boolean,
 * }>}
 */
async function runPersonaGateHook({
  cfg,
  completedWave,
  catalog,
  dispatchPersona,
  validateOutput,
  askUser,
  writeAtomic,
  appendDev,
  waveContext = 'Wave 3 quality results',
  stateContents = '',
  runId = 'test-run-0001',
}) {
  // ── Gate conditions ──────────────────────────────────────────────────────
  // Condition 1: enabled
  if (!cfg.enabled) return { skipped: true, deviationWritten: false, dissenters: [], auqInvoked: false };
  // Condition 2: mode !== 'off'
  if (cfg.mode === 'off') return { skipped: true, deviationWritten: false, dissenters: [], auqInvoked: false };
  // Condition 3: wave matches cfg.after
  if (completedWave !== cfg.after) return { skipped: true, deviationWritten: false, dissenters: [], auqInvoked: false };

  // ── Catalog resolution ───────────────────────────────────────────────────
  const requirePersonas = cfg['require-personas'] ?? false;
  if (catalog.size === 0) {
    if (requirePersonas) {
      throw new Error('persona-gate-wave: catalog is empty and require-personas:true — aborting hook');
    }
    // Silent skip when require-personas is false
    return { skipped: true, deviationWritten: false, dissenters: [], auqInvoked: false };
  }

  const rosterNames =
    cfg.personas && cfg.personas.length > 0 ? cfg.personas : [...catalog.keys()];
  const personas = rosterNames.map((n) => catalog.get(n)).filter(Boolean);

  // ── Dispatch personas in parallel ────────────────────────────────────────
  const rawOutputs = await Promise.allSettled(
    personas.map((persona) => dispatchPersona(persona, waveContext)),
  );

  // ── Validate each output (conservative-error: rejected dispatch = FAIL) ──
  const validatedOutputs = [];
  for (let i = 0; i < personas.length; i++) {
    const persona = personas[i];
    const settled = rawOutputs[i];
    if (settled.status === 'rejected') {
      // dispatch-error → conservative-error rule (W1-D3 H4): counts as FAIL
      validatedOutputs.push({
        persona_name: persona.name,
        mode: 'dispatch-error',
        ok: false,
        verdict: undefined,
      });
    } else {
      const validated = await validateOutput(persona, settled.value);
      validatedOutputs.push({ persona_name: persona.name, ...validated });
    }
  }

  // ── Consolidate ──────────────────────────────────────────────────────────
  const threshold = parseThreshold(cfg.threshold ?? 'all');
  const consolidation = consolidate(validatedOutputs, 'hard-gate-threshold', { threshold });

  const { final_verdict: finalVerdict, dissenting_personas: dissenters } = consolidation;

  // ── Sidecar write ────────────────────────────────────────────────────────
  const iso = new Date().toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
  const sidecarPath = `.orchestrator/persona-panel/${iso}-${runId}.json`;
  const sidecar = {
    schema_version: 1,
    run_id: runId,
    iso_timestamp: iso,
    target: waveContext,
    personas_invoked: personas.map((p) => ({
      name: p.name,
      version: p.version ?? 1,
      model: cfg['dispatch-model'] ?? 'claude-opus-4-7',
      prompt_hash: 'a'.repeat(16),
      timestamp_start: iso,
      timestamp_end: iso,
    })),
    outputs: validatedOutputs,
    consolidation: {
      mode_used: consolidation.mode_used,
      final_verdict: finalVerdict,
      votes: consolidation.votes,
      threshold: cfg.threshold ?? 'all',
      threshold_met: consolidation.threshold_met,
      dissenting_personas: dissenters,
      tie_break_applied: consolidation.tie_break_applied,
      notes: consolidation.notes,
    },
  };
  await writeAtomic(sidecarPath, sidecar);

  // ── Behaviour by mode ────────────────────────────────────────────────────
  let result;
  let deviationWritten = false;

  if (cfg.mode === 'warn') {
    // Always continue regardless of verdict. Write deviation when there are dissenters.
    if (dissenters.length > 0) {
      appendDev(stateContents, iso, `Wave N persona-gate warn: dissenting=[${dissenters.join(', ')}], mode=warn`);
      deviationWritten = true;
    }
    result = { skipped: false, verdict: 'WAVE_CONTINUE', sidecarPath, deviationWritten, dissenters, auqInvoked: false };
  } else {
    // mode === 'strict'
    if (finalVerdict === 'PROCEED') {
      // Clean pass — continue, no AUQ, no deviation
      result = { skipped: false, verdict: 'PROCEED', sidecarPath, deviationWritten: false, dissenters, auqInvoked: false };
    } else {
      // Non-PROCEED under strict → AUQ
      const auqAnswer = await askUser({
        question: `Persona-gate: ${dissenters.length} persona(s) dissenting. Choose action:`,
        options: ['proceed-as-is', 'revise-remaining-waves', 'abort-session'],
      });

      if (auqAnswer === 'proceed-as-is') {
        appendDev(stateContents, iso, `Wave N persona-gate strict-proceed: dissenting=[${dissenters.join(', ')}], mode=strict`);
        deviationWritten = true;
        result = {
          skipped: false,
          verdict: 'PROCEED_WITH_FOLLOWUPS',
          sidecarPath,
          deviationWritten,
          dissenters,
          auqInvoked: true,
        };
      } else if (auqAnswer === 'revise-remaining-waves') {
        appendDev(stateContents, iso, `Wave N persona-gate strict-revise: dissenting=[${dissenters.join(', ')}], mode=strict`);
        deviationWritten = true;
        result = {
          skipped: false,
          verdict: 'FIX_REQUIRED',
          revision_context: {
            dissenting_personas: dissenters,
            recommendations: validatedOutputs
              .filter((o) => o.recommendations && o.recommendations.length > 0)
              .flatMap((o) => o.recommendations),
          },
          sidecarPath,
          deviationWritten,
          dissenters,
          auqInvoked: true,
        };
      } else if (auqAnswer === 'abort-session') {
        appendDev(stateContents, iso, `Wave N persona-gate strict-abort: dissenting=[${dissenters.join(', ')}], mode=strict`);
        deviationWritten = true;
        result = {
          skipped: false,
          verdict: 'BLOCKED',
          sidecarPath,
          deviationWritten,
          dissenters,
          auqInvoked: true,
        };
      } else {
        // Unknown AUQ answer → safe default: treat as proceed-as-is (conservative)
        appendDev(stateContents, iso, `Wave N persona-gate strict-unknown-auq: dissenting=[${dissenters.join(', ')}], mode=strict, answer=${auqAnswer}`);
        deviationWritten = true;
        result = {
          skipped: false,
          verdict: 'PROCEED_WITH_FOLLOWUPS',
          sidecarPath,
          deviationWritten,
          dissenters,
          auqInvoked: true,
        };
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

/** Minimal catalog with one passing persona. */
function makePassingCatalog(count = 1) {
  const catalog = new Map();
  for (let i = 0; i < count; i++) {
    const name = `persona-${String.fromCharCode(97 + i)}`;
    catalog.set(name, {
      name,
      version: 1,
      role: 'domain-expert',
      tier: 'primary',
      evaluation_criteria: ['criterion 1'],
    });
  }
  return catalog;
}

/** Config block with sensible defaults. */
function makeCfg(overrides = {}) {
  return {
    enabled: true,
    after: 'quality',
    threshold: 'all',
    personas: [],
    'dispatch-model': 'claude-opus-4-7',
    mode: 'warn',
    ...overrides,
  };
}

/** validateOutput mock that returns 'pass' for all personas. */
function makePassingValidator() {
  return vi.fn().mockResolvedValue({
    ok: true,
    mode: 'validated',
    verdict: 'pass',
    rationale: 'looks good',
    recommendations: [],
  });
}

/** writeAtomic mock that always succeeds. */
function makeWriteAtomicMock() {
  return vi.fn().mockResolvedValue({ path: 'mock-path', bytes: 100 });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('persona-gate-hook — mode=off silent no-op', () => {
  it('skips dispatch entirely when mode is off, even when enabled=true and wave matches', async () => {
    const dispatchPersona = vi.fn();
    const validateOutput = makePassingValidator();
    const writeAtomic = makeWriteAtomicMock();
    const askUser = vi.fn();
    const appendDev = vi.fn();

    const result = await runPersonaGateHook({
      cfg: makeCfg({ mode: 'off', enabled: true }),
      completedWave: 'quality',
      catalog: makePassingCatalog(2),
      dispatchPersona,
      validateOutput,
      askUser,
      writeAtomic,
      appendDev,
    });

    expect(result.skipped).toBe(true);
    expect(dispatchPersona).not.toHaveBeenCalled();
    expect(writeAtomic).not.toHaveBeenCalled();
    expect(askUser).not.toHaveBeenCalled();
  });
});

describe('persona-gate-hook — mode=warn + non-PROCEED verdict', () => {
  it('continues wave without AUQ when warn mode and final_verdict is BLOCKED, writes deviation', async () => {
    // One persona votes fail → BLOCKED under hard-gate
    const dispatchPersona = vi.fn().mockResolvedValue('```json\n{"verdict":"fail","rationale":"too slow"}\n```');
    const validateOutput = vi.fn().mockResolvedValue({
      ok: true,
      mode: 'validated',
      verdict: 'fail',
      rationale: 'too slow',
      recommendations: ['Speed up rendering'],
    });
    const writeAtomic = makeWriteAtomicMock();
    const askUser = vi.fn();
    const appendDev = vi.fn().mockReturnValue('updated-state');

    const result = await runPersonaGateHook({
      cfg: makeCfg({ mode: 'warn' }),
      completedWave: 'quality',
      catalog: makePassingCatalog(1),
      dispatchPersona,
      validateOutput,
      askUser,
      writeAtomic,
      appendDev,
    });

    expect(result.skipped).toBe(false);
    expect(result.verdict).toBe('WAVE_CONTINUE');
    expect(result.auqInvoked).toBe(false);
    expect(askUser).not.toHaveBeenCalled();
    // Deviation must be written because there are dissenters
    expect(result.deviationWritten).toBe(true);
    expect(appendDev).toHaveBeenCalledOnce();
    // Sidecar must still be written
    expect(writeAtomic).toHaveBeenCalledOnce();
  });
});

describe('persona-gate-hook — mode=strict + final_verdict=PROCEED', () => {
  it('continues without AUQ when strict mode and all personas pass', async () => {
    const dispatchPersona = vi.fn().mockResolvedValue('```json\n{"verdict":"pass","rationale":"good"}\n```');
    const validateOutput = makePassingValidator();
    const writeAtomic = makeWriteAtomicMock();
    const askUser = vi.fn();
    const appendDev = vi.fn();

    const result = await runPersonaGateHook({
      cfg: makeCfg({ mode: 'strict' }),
      completedWave: 'quality',
      catalog: makePassingCatalog(3),
      dispatchPersona,
      validateOutput,
      askUser,
      writeAtomic,
      appendDev,
    });

    expect(result.skipped).toBe(false);
    expect(result.verdict).toBe('PROCEED');
    expect(result.auqInvoked).toBe(false);
    expect(askUser).not.toHaveBeenCalled();
    expect(result.deviationWritten).toBe(false);
    expect(result.sidecarPath).toBeDefined();
    expect(writeAtomic).toHaveBeenCalledOnce();
  });
});

describe('persona-gate-hook — mode=strict + non-PROCEED + AUQ=proceed-as-is', () => {
  it('returns PROCEED_WITH_FOLLOWUPS and writes Deviation when operator selects proceed-as-is', async () => {
    const dispatchPersona = vi.fn().mockResolvedValue('raw-output');
    const validateOutput = vi.fn().mockResolvedValue({
      ok: true,
      mode: 'validated',
      verdict: 'fail',
      rationale: 'UX fails audit',
      recommendations: ['Fix contrast'],
    });
    const writeAtomic = makeWriteAtomicMock();
    const askUser = vi.fn().mockResolvedValue('proceed-as-is');
    const appendDev = vi.fn().mockReturnValue('updated-state');

    const result = await runPersonaGateHook({
      cfg: makeCfg({ mode: 'strict' }),
      completedWave: 'quality',
      catalog: makePassingCatalog(1),
      dispatchPersona,
      validateOutput,
      askUser,
      writeAtomic,
      appendDev,
    });

    expect(result.verdict).toBe('PROCEED_WITH_FOLLOWUPS');
    expect(result.auqInvoked).toBe(true);
    expect(result.deviationWritten).toBe(true);
    expect(askUser).toHaveBeenCalledOnce();
    // AUQ must have been called with 3 options
    const callArgs = askUser.mock.calls[0][0];
    expect(callArgs.options).toEqual(['proceed-as-is', 'revise-remaining-waves', 'abort-session']);
    expect(appendDev).toHaveBeenCalledOnce();
    expect(result.sidecarPath).toBeDefined();
  });
});

describe('persona-gate-hook — mode=strict + non-PROCEED + AUQ=revise-remaining-waves', () => {
  it('returns FIX_REQUIRED with revision_context populated from dissenting persona recommendations', async () => {
    const dispatchPersona = vi.fn().mockResolvedValue('raw-output');
    const validateOutput = vi.fn().mockResolvedValue({
      ok: true,
      mode: 'validated',
      verdict: 'fail',
      rationale: 'critical accessibility gap',
      recommendations: ['Add ARIA labels', 'Increase contrast ratio'],
    });
    const writeAtomic = makeWriteAtomicMock();
    const askUser = vi.fn().mockResolvedValue('revise-remaining-waves');
    const appendDev = vi.fn().mockReturnValue('updated-state');

    const result = await runPersonaGateHook({
      cfg: makeCfg({ mode: 'strict' }),
      completedWave: 'quality',
      catalog: makePassingCatalog(1),
      dispatchPersona,
      validateOutput,
      askUser,
      writeAtomic,
      appendDev,
    });

    expect(result.verdict).toBe('FIX_REQUIRED');
    expect(result.auqInvoked).toBe(true);
    expect(result.deviationWritten).toBe(true);
    expect(result.revision_context).toBeDefined();
    expect(result.revision_context.dissenting_personas).toHaveLength(1);
    expect(result.revision_context.recommendations).toEqual(['Add ARIA labels', 'Increase contrast ratio']);
  });
});

describe('persona-gate-hook — mode=strict + non-PROCEED + AUQ=abort-session', () => {
  it('returns BLOCKED when operator selects abort-session', async () => {
    const dispatchPersona = vi.fn().mockResolvedValue('raw-output');
    const validateOutput = vi.fn().mockResolvedValue({
      ok: true,
      mode: 'validated',
      verdict: 'fail',
      rationale: 'critical bug found',
      recommendations: [],
    });
    const writeAtomic = makeWriteAtomicMock();
    const askUser = vi.fn().mockResolvedValue('abort-session');
    const appendDev = vi.fn().mockReturnValue('updated-state');

    const result = await runPersonaGateHook({
      cfg: makeCfg({ mode: 'strict' }),
      completedWave: 'quality',
      catalog: makePassingCatalog(1),
      dispatchPersona,
      validateOutput,
      askUser,
      writeAtomic,
      appendDev,
    });

    expect(result.verdict).toBe('BLOCKED');
    expect(result.auqInvoked).toBe(true);
    expect(result.deviationWritten).toBe(true);
    expect(askUser).toHaveBeenCalledOnce();
  });
});

describe('persona-gate-hook — catalog empty + require-personas:true', () => {
  it('throws when catalog is empty and require-personas is true', async () => {
    const dispatchPersona = vi.fn();
    const validateOutput = makePassingValidator();
    const writeAtomic = makeWriteAtomicMock();
    const askUser = vi.fn();
    const appendDev = vi.fn();

    await expect(
      runPersonaGateHook({
        cfg: makeCfg({ 'require-personas': true }),
        completedWave: 'quality',
        catalog: new Map(),
        dispatchPersona,
        validateOutput,
        askUser,
        writeAtomic,
        appendDev,
      }),
    ).rejects.toThrow(/require-personas/);

    expect(dispatchPersona).not.toHaveBeenCalled();
    expect(writeAtomic).not.toHaveBeenCalled();
  });
});

describe('persona-gate-hook — catalog empty + require-personas:false', () => {
  it('silently skips without throwing when catalog is empty and require-personas is false', async () => {
    const dispatchPersona = vi.fn();
    const validateOutput = makePassingValidator();
    const writeAtomic = makeWriteAtomicMock();
    const askUser = vi.fn();
    const appendDev = vi.fn();

    const result = await runPersonaGateHook({
      cfg: makeCfg({ 'require-personas': false }),
      completedWave: 'quality',
      catalog: new Map(),
      dispatchPersona,
      validateOutput,
      askUser,
      writeAtomic,
      appendDev,
    });

    expect(result.skipped).toBe(true);
    expect(dispatchPersona).not.toHaveBeenCalled();
    expect(writeAtomic).not.toHaveBeenCalled();
  });
});

describe('persona-gate-hook — dispatch-error on 1-of-6 personas', () => {
  it('conservative-error rule fires: dispatch failure counted as FAIL, consolidator still produces verdict', async () => {
    // 5 succeed with pass, 1 rejects → overall BLOCKED under hard-gate (not unanimous)
    const catalog = makePassingCatalog(6);

    let callCount = 0;
    const dispatchPersona = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 3) {
        return Promise.reject(new Error('Agent dispatch timed out'));
      }
      return Promise.resolve('```json\n{"verdict":"pass","rationale":"ok"}\n```');
    });

    const validateOutput = vi.fn().mockResolvedValue({
      ok: true,
      mode: 'validated',
      verdict: 'pass',
      rationale: 'ok',
      recommendations: [],
    });
    const writeAtomic = makeWriteAtomicMock();
    const askUser = vi.fn().mockResolvedValue('proceed-as-is');
    const appendDev = vi.fn().mockReturnValue('');

    const result = await runPersonaGateHook({
      cfg: makeCfg({ mode: 'strict' }),
      completedWave: 'quality',
      catalog,
      dispatchPersona,
      validateOutput,
      askUser,
      writeAtomic,
      appendDev,
    });

    // All 6 dispatched (5 succeed, 1 fails)
    expect(dispatchPersona).toHaveBeenCalledTimes(6);
    // validateOutput called only for the 5 that succeeded (dispatch-error skips validation)
    expect(validateOutput).toHaveBeenCalledTimes(5);
    // Conservative-error: one dispatch error → not unanimous pass → BLOCKED under hard-gate
    // AUQ was invoked under strict mode
    expect(result.auqInvoked).toBe(true);
    // result.dissenters must include the persona whose dispatch failed
    expect(result.dissenters.length).toBeGreaterThanOrEqual(1);
    // sidecar written before AUQ decision
    expect(writeAtomic).toHaveBeenCalledOnce();
  });
});

describe('persona-gate-hook — 6 personas dispatched + sidecar schema validation', () => {
  it('sidecar written via writeAtomic carries correct shape validated against sidecar schema required fields', async () => {
    const catalog = makePassingCatalog(6);
    const dispatchPersona = vi.fn().mockResolvedValue('raw-output');
    const validateOutput = makePassingValidator();

    let capturedSidecarPath = null;
    let capturedSidecarValue = null;
    const writeAtomic = vi.fn().mockImplementation(async (path, value) => {
      capturedSidecarPath = path;
      capturedSidecarValue = value;
      return { path, bytes: JSON.stringify(value).length };
    });
    const askUser = vi.fn();
    const appendDev = vi.fn();

    await runPersonaGateHook({
      cfg: makeCfg({ mode: 'warn' }),
      completedWave: 'quality',
      catalog,
      dispatchPersona,
      validateOutput,
      askUser,
      writeAtomic,
      appendDev,
      runId: 'sidecar-test-run',
    });

    // Sidecar must have been written
    expect(writeAtomic).toHaveBeenCalledOnce();
    expect(capturedSidecarPath).toMatch(/\.orchestrator\/persona-panel\/.+\.json$/);

    // Validate captured sidecar value against schema required fields
    expect(capturedSidecarValue).not.toBeNull();
    expect(capturedSidecarValue.schema_version).toBe(1);
    expect(capturedSidecarValue.run_id).toBe('sidecar-test-run');
    expect(typeof capturedSidecarValue.iso_timestamp).toBe('string');
    expect(typeof capturedSidecarValue.target).toBe('string');
    expect(Array.isArray(capturedSidecarValue.personas_invoked)).toBe(true);
    expect(capturedSidecarValue.personas_invoked).toHaveLength(6);
    expect(Array.isArray(capturedSidecarValue.outputs)).toBe(true);
    expect(capturedSidecarValue.outputs).toHaveLength(6);
    expect(typeof capturedSidecarValue.consolidation).toBe('object');
    expect(typeof capturedSidecarValue.consolidation.final_verdict).toBe('string');
    expect(typeof capturedSidecarValue.consolidation.mode_used).toBe('string');

    // Each persona_invoked entry must have required schema fields
    for (const pi of capturedSidecarValue.personas_invoked) {
      expect(typeof pi.name).toBe('string');
      expect(typeof pi.version).toBe('number');
      expect(typeof pi.model).toBe('string');
      expect(typeof pi.prompt_hash).toBe('string');
      expect(typeof pi.timestamp_start).toBe('string');
      expect(typeof pi.timestamp_end).toBe('string');
    }
  });
});

describe('persona-gate-hook — boundary: mode=strict + PROCEED → no AUQ (invariant)', () => {
  it('does not invoke AUQ when strict mode produces a clean PROCEED verdict', async () => {
    const catalog = makePassingCatalog(2);
    const dispatchPersona = vi.fn().mockResolvedValue('raw-output');
    const validateOutput = makePassingValidator();
    const writeAtomic = makeWriteAtomicMock();
    const askUser = vi.fn();
    const appendDev = vi.fn();

    const result = await runPersonaGateHook({
      cfg: makeCfg({ mode: 'strict', threshold: 'all' }),
      completedWave: 'quality',
      catalog,
      dispatchPersona,
      validateOutput,
      askUser,
      writeAtomic,
      appendDev,
    });

    expect(result.verdict).toBe('PROCEED');
    expect(askUser).not.toHaveBeenCalled();
    expect(result.auqInvoked).toBe(false);
    expect(result.deviationWritten).toBe(false);
  });
});

describe('persona-gate-hook — boundary: unknown AUQ answer → safe default PROCEED_WITH_FOLLOWUPS', () => {
  it('falls back to PROCEED_WITH_FOLLOWUPS when AUQ returns an unrecognised option string', async () => {
    const dispatchPersona = vi.fn().mockResolvedValue('raw-output');
    const validateOutput = vi.fn().mockResolvedValue({
      ok: true,
      mode: 'validated',
      verdict: 'fail',
      rationale: 'rejected',
      recommendations: [],
    });
    const writeAtomic = makeWriteAtomicMock();
    const askUser = vi.fn().mockResolvedValue('this-option-does-not-exist');
    const appendDev = vi.fn().mockReturnValue('');

    const result = await runPersonaGateHook({
      cfg: makeCfg({ mode: 'strict' }),
      completedWave: 'quality',
      catalog: makePassingCatalog(1),
      dispatchPersona,
      validateOutput,
      askUser,
      writeAtomic,
      appendDev,
    });

    expect(result.verdict).toBe('PROCEED_WITH_FOLLOWUPS');
    expect(result.auqInvoked).toBe(true);
    expect(result.deviationWritten).toBe(true);
  });
});

describe('persona-gate-hook — boundary: N=1 persona passes under consolidator', () => {
  it('produces PROCEED when exactly one persona votes pass under hard-gate-threshold', () => {
    // Uses the real consolidator (pure function) directly — no hook needed
    const outputs = [
      { persona_name: 'solo-persona', mode: 'validated', verdict: 'pass', ok: true },
    ];
    const threshold = parseThreshold('all');
    const result = consolidate(outputs, 'hard-gate-threshold', { threshold });

    expect(result.final_verdict).toBe('PROCEED');
    expect(result.votes.pass).toBe(1);
    expect(result.votes.total).toBe(1);
    expect(result.dissenting_personas).toHaveLength(0);
  });
});

describe('persona-gate-hook — boundary: sidecar iso_timestamp uses filename-safe format', () => {
  it('sidecar path timestamp uses hyphens in place of colons so filename is filesystem-safe', async () => {
    const catalog = makePassingCatalog(1);
    const dispatchPersona = vi.fn().mockResolvedValue('raw-output');
    const validateOutput = makePassingValidator();

    let capturedPath = null;
    const writeAtomic = vi.fn().mockImplementation(async (path) => {
      capturedPath = path;
      return { path, bytes: 1 };
    });
    const askUser = vi.fn();
    const appendDev = vi.fn();

    await runPersonaGateHook({
      cfg: makeCfg({ mode: 'warn' }),
      completedWave: 'quality',
      catalog,
      dispatchPersona,
      validateOutput,
      askUser,
      writeAtomic,
      appendDev,
      runId: 'ts-format-test',
    });

    expect(capturedPath).not.toBeNull();
    // Extract filename from path
    const filename = capturedPath.split('/').pop();
    // Filename must not contain raw colons (which are illegal on some filesystems)
    expect(filename).not.toMatch(/:/);
    // Timestamp portion should match filename-safe ISO 8601 pattern (hyphens replace colons)
    // e.g. 2026-05-19T12-34-56Z-ts-format-test.json
    expect(filename).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z?-ts-format-test\.json$/);
  });
});

describe('persona-gate-hook — gate condition: wrong completedWave skips hook', () => {
  it('skips hook when completedWave does not match cfg.after', async () => {
    const dispatchPersona = vi.fn();
    const validateOutput = makePassingValidator();
    const writeAtomic = makeWriteAtomicMock();
    const askUser = vi.fn();
    const appendDev = vi.fn();

    const result = await runPersonaGateHook({
      cfg: makeCfg({ after: 'impl-polish', mode: 'strict', enabled: true }),
      completedWave: 'quality',   // mismatch: cfg.after='impl-polish', wave='quality'
      catalog: makePassingCatalog(2),
      dispatchPersona,
      validateOutput,
      askUser,
      writeAtomic,
      appendDev,
    });

    expect(result.skipped).toBe(true);
    expect(dispatchPersona).not.toHaveBeenCalled();
    expect(writeAtomic).not.toHaveBeenCalled();
  });
});

describe('persona-gate-hook — gate condition: enabled=false skips hook', () => {
  it('skips hook silently when enabled is false, even with mode=strict and matching wave', async () => {
    const dispatchPersona = vi.fn();
    const writeAtomic = makeWriteAtomicMock();
    const askUser = vi.fn();
    const appendDev = vi.fn();

    const result = await runPersonaGateHook({
      cfg: makeCfg({ enabled: false, mode: 'strict' }),
      completedWave: 'quality',
      catalog: makePassingCatalog(3),
      dispatchPersona,
      validateOutput: makePassingValidator(),
      askUser,
      writeAtomic,
      appendDev,
    });

    expect(result.skipped).toBe(true);
    expect(dispatchPersona).not.toHaveBeenCalled();
    expect(writeAtomic).not.toHaveBeenCalled();
  });
});

describe('persona-gate-hook — warn mode with unanimous pass does not write deviation', () => {
  it('no deviation written in warn mode when all personas pass (no dissenters)', async () => {
    const catalog = makePassingCatalog(2);
    const dispatchPersona = vi.fn().mockResolvedValue('raw-output');
    const validateOutput = makePassingValidator();
    const writeAtomic = makeWriteAtomicMock();
    const askUser = vi.fn();
    const appendDev = vi.fn();

    const result = await runPersonaGateHook({
      cfg: makeCfg({ mode: 'warn' }),
      completedWave: 'quality',
      catalog,
      dispatchPersona,
      validateOutput,
      askUser,
      writeAtomic,
      appendDev,
    });

    expect(result.deviationWritten).toBe(false);
    expect(appendDev).not.toHaveBeenCalled();
    // Sidecar is still written even on a clean pass
    expect(writeAtomic).toHaveBeenCalledOnce();
  });
});
