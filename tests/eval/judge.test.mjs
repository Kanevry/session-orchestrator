/**
 * tests/eval/judge.test.mjs
 *
 * Unit tests for scripts/lib/eval/judge.mjs (Epic #803, S7 — issue #810, the
 * opt-in advisory LLM-judge overlay for the aiat-llm-eval standard).
 *
 * Pure gates:
 *   - validateModel: passthrough for allowed models, throws for unknown ones.
 *   - estimateInputTokens: chars/4 heuristic (hardcoded expected).
 *   - checkBudget: ok under/at boundary, exceeded over (hardcoded).
 *   - buildJudgePrompt: record slice fenced with a nonce; both judge-question
 *     ids present; JSON output instruction present.
 *   - parseJudgeResponse: exactly one ```json block extracted + validated;
 *     malformed/unknown-id entries dropped silently; advisory/calibration_status
 *     ALWAYS hard-overridden regardless of what the raw entry carries; no block → [].
 *
 * Main entry runEvalJudge (the injected dispatchAgent is a legitimate DI seam —
 * assertions verify runEvalJudge's OWN gating/dispatch behavior, not the mock):
 *   - empty-input (no record / no dimensions / no session_id) → dispatch NOT called.
 *   - unknown model → throws before dispatch, dispatch NOT called.
 *   - budget exceeded → status:'budget-exceeded', dispatch NOT called.
 *   - no parseable json in the response → status:'parse-error', dispatch called once.
 *   - happy path → status:'ok' with 2 hard-overridden dimensions, dispatch called
 *     once with the built prompt (nonce fence + record data).
 *
 * mergeJudgeDimensions:
 *   - happy merge → validateEvalRecord green on the returned record.
 *   - hard-overrides advisory/calibration_status even when supplied dimensions differ.
 *   - a malformed dimension → returns the ORIGINAL record unchanged, never throws.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ALLOWED_MODELS,
  JUDGE_DIMENSION_IDS,
  validateModel,
  estimateInputTokens,
  checkBudget,
  buildJudgePrompt,
  parseJudgeResponse,
  runEvalJudge,
  mergeJudgeDimensions,
} from '@lib/eval/judge.mjs';
import { validateEvalRecord } from '@lib/eval/schema.mjs';

// ---------------------------------------------------------------------------
// Fixture — a valid session-eval record (schema.mjs shape)
// ---------------------------------------------------------------------------

const BASE_RECORD = Object.freeze({
  schema_version: 1,
  record_kind: 'session-eval',
  run_id: 'main-2026-07-16-test-1-eval-20260716T100000000Z',
  session_id: 'main-2026-07-16-test-1',
  standard_version: 'aiat-llm-eval/1.0',
  rubric_version: 'rubric-v1',
  provenance: { rubric_sha256: 'a'.repeat(64), engine_commit: 'deadbeef' },
  model: { id: 'claude-sonnet-5', source: 'self-report' },
  harness: { plugin_version: '3.14.0', platform: 'claude-code', host_class: null, hostname_hash: null },
  kpis: {
    duration_seconds: 1200,
    total_waves: 3,
    total_agents: 12,
    token_input: 50000,
    token_output: 20000,
    carryover: 0,
  },
  dimensions: [
    { id: 'verification-evidence', method: 'deterministic', status: 'pass', evidence: 'quality_gate exit_code=0 in window' },
    { id: 'plan-fidelity', method: 'deterministic', status: 'pass', evidence: 'completion_rate=1.0', score: 1.0 },
    { id: 'gate-health', method: 'deterministic', status: 'pass', evidence: 'last full-gate exit_code=0' },
    { id: 'process-safety', method: 'deterministic', status: 'pass', evidence: 'no destructive_guard.blocked events' },
    { id: 'efficiency-kpis', method: 'deterministic', status: 'not-applicable', evidence: 'reported only' },
  ],
  handle: null,
  anonymized: true,
  timestamp: '2026-07-16T10:00:00.000Z',
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('ALLOWED_MODELS / JUDGE_DIMENSION_IDS', () => {
  it('pins the three allowed model tiers', () => {
    expect(ALLOWED_MODELS).toEqual(['haiku', 'sonnet', 'opus']);
  });

  it('pins the two pre-registered judge dimension ids', () => {
    expect(JUDGE_DIMENSION_IDS).toEqual(['instruction-adherence', 'report-quality']);
  });
});

// ---------------------------------------------------------------------------
// validateModel
// ---------------------------------------------------------------------------

describe('validateModel', () => {
  it('returns the model unchanged when allowed', () => {
    expect(validateModel('haiku')).toBe('haiku');
  });

  it('throws for an unknown model', () => {
    expect(() => validateModel('gpt-4')).toThrow(
      "eval-judge.model must be one of [\"haiku\",\"sonnet\",\"opus\"], got 'gpt-4'",
    );
  });
});

// ---------------------------------------------------------------------------
// estimateInputTokens
// ---------------------------------------------------------------------------

describe('estimateInputTokens', () => {
  it('returns floor(length/4) for a known 12-char string', () => {
    expect(estimateInputTokens('abcdefghijkl')).toBe(3);
  });

  it('rounds down a non-multiple-of-4 length', () => {
    expect(estimateInputTokens('hello')).toBe(1);
  });

  it('returns 0 for null/undefined payloads', () => {
    expect(estimateInputTokens(null)).toBe(0);
    expect(estimateInputTokens(undefined)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// checkBudget
// ---------------------------------------------------------------------------

describe('checkBudget', () => {
  it('returns ok when estimated input is under the budget', () => {
    expect(checkBudget(100, { input: 8000 })).toEqual({ ok: true });
  });

  it('returns ok at the exact budget boundary (not strictly exceeded)', () => {
    expect(checkBudget(8000, { input: 8000 })).toEqual({ ok: true });
  });

  it('returns a budget-exceeded verdict when over the budget', () => {
    expect(checkBudget(9000, { input: 8000 })).toEqual({
      ok: false,
      status: 'budget-exceeded',
      used: 9000,
      budget: 8000,
    });
  });
});

// ---------------------------------------------------------------------------
// buildJudgePrompt
// ---------------------------------------------------------------------------

describe('buildJudgePrompt', () => {
  const nonce = 'deadbeef';
  const prompt = buildJudgePrompt(BASE_RECORD, nonce);

  it('wraps the record slice in a nonce-tagged untrusted-data fence', () => {
    expect(prompt).toContain(`<untrusted-data-${nonce}>`);
    expect(prompt).toContain(`</untrusted-data-${nonce}>`);
  });

  it('includes the session_id and dimension evidence inside the fenced slice', () => {
    expect(prompt).toContain('main-2026-07-16-test-1');
    expect(prompt).toContain('quality_gate exit_code=0 in window');
  });

  it('instructs the judge to emit a fenced json block for both fixed dimension ids', () => {
    expect(prompt).toContain('```json');
    expect(prompt).toContain('EXACTLY ONE fenced code block tagged `json`');
    expect(prompt).toContain('instruction-adherence');
    expect(prompt).toContain('report-quality');
  });
});

// ---------------------------------------------------------------------------
// parseJudgeResponse
// ---------------------------------------------------------------------------

describe('parseJudgeResponse', () => {
  it('extracts + hard-overrides advisory/calibration_status for both dimensions', () => {
    const text = [
      'Here is my judgment:',
      '```json',
      JSON.stringify([
        { id: 'instruction-adherence', status: 'pass', evidence: 'no deviation found', score: null, advisory: false, calibration_status: 'calibrated' },
        { id: 'report-quality', status: 'fail', evidence: 'vague and self-congratulatory' },
      ]),
      '```',
    ].join('\n');

    expect(parseJudgeResponse(text)).toEqual([
      {
        id: 'instruction-adherence',
        method: 'judge',
        status: 'pass',
        evidence: 'no deviation found',
        score: null,
        advisory: true,
        calibration_status: 'uncalibrated',
      },
      {
        id: 'report-quality',
        method: 'judge',
        status: 'fail',
        evidence: 'vague and self-congratulatory',
        score: null,
        advisory: true,
        calibration_status: 'uncalibrated',
      },
    ]);
  });

  it('drops a malformed entry (unknown status) while keeping the valid one', () => {
    const text = [
      '```json',
      JSON.stringify([
        { id: 'instruction-adherence', status: 'maybe', evidence: 'bad status value' },
        { id: 'report-quality', status: 'pass', evidence: 'evidence looks solid' },
      ]),
      '```',
    ].join('\n');

    expect(parseJudgeResponse(text)).toEqual([
      {
        id: 'report-quality',
        method: 'judge',
        status: 'pass',
        evidence: 'evidence looks solid',
        score: null,
        advisory: true,
        calibration_status: 'uncalibrated',
      },
    ]);
  });

  it('drops an entry whose id is outside the fixed dimension set', () => {
    const text = [
      '```json',
      JSON.stringify([
        { id: 'made-up-dimension', status: 'pass', evidence: 'not a real dimension' },
      ]),
      '```',
    ].join('\n');

    expect(parseJudgeResponse(text)).toEqual([]);
  });

  it('returns [] when the response has no fenced json block', () => {
    expect(parseJudgeResponse('No JSON here, just prose about the session.')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// runEvalJudge
// ---------------------------------------------------------------------------

describe('runEvalJudge', () => {
  let dispatchAgent;

  beforeEach(() => {
    dispatchAgent = vi.fn();
  });

  it('returns empty-input and does NOT dispatch when record is undefined', async () => {
    const result = await runEvalJudge({ dispatchAgent, record: undefined });

    expect(result.status).toBe('empty-input');
    expect(result.dimensions).toEqual([]);
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('returns empty-input and does NOT dispatch when dimensions is empty', async () => {
    const record = { ...BASE_RECORD, dimensions: [] };

    const result = await runEvalJudge({ dispatchAgent, record });

    expect(result.status).toBe('empty-input');
    expect(result.dimensions).toEqual([]);
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('returns empty-input and does NOT dispatch when session_id is missing', async () => {
    const record = { ...BASE_RECORD, session_id: '' };

    const result = await runEvalJudge({ dispatchAgent, record });

    expect(result.status).toBe('empty-input');
    expect(result.dimensions).toEqual([]);
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('rejects on an unknown model before any dispatch', async () => {
    await expect(
      runEvalJudge({ dispatchAgent, record: BASE_RECORD, model: 'gpt-4' }),
    ).rejects.toThrow("eval-judge.model must be one of [\"haiku\",\"sonnet\",\"opus\"], got 'gpt-4'");

    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('returns budget-exceeded and does NOT dispatch when the prompt blows the budget', async () => {
    const result = await runEvalJudge({
      dispatchAgent,
      record: BASE_RECORD,
      budget: { input: 1, output: 4000 },
    });

    expect(result.status).toBe('budget-exceeded');
    expect(result.dimensions).toEqual([]);
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('returns parse-error when the dispatched response has no fenced json block', async () => {
    dispatchAgent.mockResolvedValue({ text: 'No JSON here, just prose.' });

    const result = await runEvalJudge({ dispatchAgent, record: BASE_RECORD });

    expect(result.status).toBe('parse-error');
    expect(result.dimensions).toEqual([]);
    expect(dispatchAgent).toHaveBeenCalledTimes(1);
  });

  it('dispatches once with the built prompt and returns 2 hard-overridden dimensions on the happy path', async () => {
    dispatchAgent.mockResolvedValue({
      text: [
        '```json',
        JSON.stringify([
          { id: 'instruction-adherence', status: 'pass', evidence: 'followed the plan', advisory: false, calibration_status: 'calibrated' },
          { id: 'report-quality', status: 'pass', evidence: 'evidence-anchored, no superlatives' },
        ]),
        '```',
      ].join('\n'),
      usage: { input_tokens: 300, output_tokens: 80 },
    });

    const result = await runEvalJudge({
      dispatchAgent,
      record: BASE_RECORD,
      model: 'haiku',
      randomNonce: () => 'deadbeef',
    });

    expect(result.status).toBe('ok');
    expect(result.dimensions).toEqual([
      {
        id: 'instruction-adherence',
        method: 'judge',
        status: 'pass',
        evidence: 'followed the plan',
        score: null,
        advisory: true,
        calibration_status: 'uncalibrated',
      },
      {
        id: 'report-quality',
        method: 'judge',
        status: 'pass',
        evidence: 'evidence-anchored, no superlatives',
        score: null,
        advisory: true,
        calibration_status: 'uncalibrated',
      },
    ]);

    // DI-seam assertion: runEvalJudge calls dispatchAgent exactly once, and the
    // prompt it passes is the buildJudgePrompt output (nonce fence + record data
    // + the json-output instruction).
    expect(dispatchAgent).toHaveBeenCalledTimes(1);
    const callArg = dispatchAgent.mock.calls[0][0];
    expect(callArg.model).toBe('haiku');
    expect(callArg.prompt).toContain('<untrusted-data-deadbeef>');
    expect(callArg.prompt).toContain('main-2026-07-16-test-1');
    expect(callArg.prompt).toContain('EXACTLY ONE fenced code block tagged `json`');
  });

  // Finding 2 (qa-HIGH advisory contract). RED-FIRST (executed 2026-07-17 against
  // the pre-fix judge): the un-try/catch'd `await dispatchAgent(...)` propagated a
  // dispatch rejection, so runEvalJudge REJECTED with "agent timeout" instead of
  // resolving — breaking the advisory contract that the judge must NEVER break
  // /close. The fix wraps the dispatch in try/catch → returns
  // {status:'dispatch-error', dimensions:[]} + a stderr WARN.
  it('returns dispatch-error and never rejects when the dispatch throws', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    dispatchAgent.mockRejectedValue(new Error('agent timeout'));

    // never-throw: the promise RESOLVES rather than rejecting.
    await expect(runEvalJudge({ dispatchAgent, record: BASE_RECORD })).resolves.toEqual(
      expect.objectContaining({ status: 'dispatch-error', dimensions: [] }),
    );
    expect(dispatchAgent).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('agent timeout'));

    stderrSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// mergeJudgeDimensions
// ---------------------------------------------------------------------------

describe('mergeJudgeDimensions', () => {
  const judgeDimensions = [
    {
      id: 'instruction-adherence',
      method: 'judge',
      status: 'pass',
      evidence: 'no deviation found',
      score: null,
      advisory: true,
      calibration_status: 'uncalibrated',
    },
    {
      id: 'report-quality',
      method: 'judge',
      status: 'pass',
      evidence: 'evidence-anchored, no superlatives',
      score: null,
      advisory: true,
      calibration_status: 'uncalibrated',
    },
  ];

  it('appends both judge dimensions and returns a record that validates green', () => {
    const merged = mergeJudgeDimensions(BASE_RECORD, judgeDimensions);

    expect(merged.dimensions).toHaveLength(BASE_RECORD.dimensions.length + 2);
    expect(() => validateEvalRecord(merged)).not.toThrow();
  });

  it('hard-overrides advisory/calibration_status even when the input dimensions carry different values', () => {
    const suppliedDimensions = [
      { id: 'instruction-adherence', status: 'pass', evidence: 'looks fine', advisory: false, calibration_status: 'calibrated' },
      { id: 'report-quality', status: 'fail', evidence: 'padded narrative', advisory: false, calibration_status: 'calibrated' },
    ];

    const merged = mergeJudgeDimensions(BASE_RECORD, suppliedDimensions);
    const appended = merged.dimensions.slice(BASE_RECORD.dimensions.length);

    expect(appended).toEqual([
      { id: 'instruction-adherence', status: 'pass', evidence: 'looks fine', method: 'judge', advisory: true, calibration_status: 'uncalibrated' },
      { id: 'report-quality', status: 'fail', evidence: 'padded narrative', method: 'judge', advisory: true, calibration_status: 'uncalibrated' },
    ]);
  });

  it('returns the ORIGINAL record unchanged (and never throws) when a dimension is malformed', () => {
    const brokenDimensions = [
      { id: 'instruction-adherence', status: 'pass' }, // missing required `evidence` string
    ];

    expect(() => mergeJudgeDimensions(BASE_RECORD, brokenDimensions)).not.toThrow();
    const result = mergeJudgeDimensions(BASE_RECORD, brokenDimensions);
    expect(result).toEqual(BASE_RECORD);
  });
});
