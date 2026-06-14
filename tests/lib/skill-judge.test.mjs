/**
 * tests/lib/skill-judge.test.mjs
 *
 * Unit tests for scripts/lib/skill-judge.mjs (epic #645, L3 — opt-in
 * session-end skill-applied LLM-judge).
 *
 * Pure gates:
 *   - estimateInputTokens: chars/4 heuristic (hardcoded expected).
 *   - checkBudget: ok under, exceeded over (hardcoded).
 *   - buildJudgePrompt: untrusted transcript fenced; skills present; JSON output
 *     instruction present.
 *   - parseJudgeResponse: one ```json block extracted + validated; malformed
 *     entry dropped silently; no block → [].
 *
 * Main entry runSkillJudge (the injected dispatchAgent is a legitimate DI seam —
 * assertions verify runSkillJudge's OWN gating/dispatch behavior, not the mock):
 *   - empty selectedSkills → status:'empty-input', dispatch NOT called.
 *   - budget exceeded      → status:'budget-exceeded', dispatch NOT called.
 *   - happy path           → status:'ok' with parsed judgments, dispatch called
 *                            once with the built prompt.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  estimateInputTokens,
  checkBudget,
  buildJudgePrompt,
  parseJudgeResponse,
  runSkillJudge,
} from '@lib/skill-judge.mjs';

describe('estimateInputTokens', () => {
  it('returns floor(length/4) for a known 12-char string', () => {
    // 'abcdefghijkl' is 12 chars → 12/4 = 3.
    expect(estimateInputTokens('abcdefghijkl')).toBe(3);
  });

  it('rounds down a non-multiple-of-4 length', () => {
    // 'hello' is 5 chars → floor(5/4) = 1.
    expect(estimateInputTokens('hello')).toBe(1);
  });

  it('returns 0 for null/undefined payloads', () => {
    expect(estimateInputTokens(null)).toBe(0);
    expect(estimateInputTokens(undefined)).toBe(0);
  });
});

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

describe('buildJudgePrompt', () => {
  const skills = ['discovery', 'plan'];
  const tail = 'transcript line one\ntranscript line two';
  const nonce = 'deadbeef';
  const prompt = buildJudgePrompt(skills, tail, nonce);

  it('wraps the untrusted transcript tail in a nonce-tagged fence', () => {
    expect(prompt).toContain(`<untrusted-data-${nonce}>\n${tail}\n</untrusted-data-${nonce}>`);
  });

  it('includes each selected skill name', () => {
    expect(prompt).toContain('discovery');
    expect(prompt).toContain('plan');
  });

  it('instructs the judge to emit a fenced json block', () => {
    expect(prompt).toContain('```json');
    expect(prompt).toContain('EXACTLY ONE fenced code block tagged `json`');
  });
});

describe('parseJudgeResponse', () => {
  it('extracts judgments from a single fenced json block', () => {
    const text = [
      'Here is my judgment:',
      '```json',
      JSON.stringify([
        { skill: 'discovery', applied: 'yes', completed: 'no', confidence: 0.9 },
      ]),
      '```',
    ].join('\n');

    expect(parseJudgeResponse(text)).toEqual([
      { skill: 'discovery', applied: 'yes', completed: 'no', confidence: 0.9 },
    ]);
  });

  it('drops a malformed entry (applied=maybe) while keeping the valid one', () => {
    const text = [
      '```json',
      JSON.stringify([
        { skill: 'discovery', applied: 'maybe', completed: 'no', confidence: 0.5 },
        { skill: 'plan', applied: 'yes', completed: 'yes', confidence: 0.7 },
      ]),
      '```',
    ].join('\n');

    expect(parseJudgeResponse(text)).toEqual([
      { skill: 'plan', applied: 'yes', completed: 'yes', confidence: 0.7 },
    ]);
  });

  it('returns [] when the response has no fenced json block', () => {
    expect(parseJudgeResponse('No JSON here, just prose about the session.')).toEqual([]);
  });
});

describe('runSkillJudge', () => {
  let dispatchAgent;

  beforeEach(() => {
    dispatchAgent = vi.fn();
  });

  it('returns empty-input and does NOT dispatch when selectedSkills is empty', async () => {
    const result = await runSkillJudge({
      dispatchAgent,
      selectedSkills: [],
      transcriptTail: 'some transcript',
    });

    expect(result.status).toBe('empty-input');
    expect(result.judgments).toEqual([]);
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('returns budget-exceeded and does NOT dispatch when the prompt blows the budget', async () => {
    const hugeTail = 'x'.repeat(50_000);

    const result = await runSkillJudge({
      dispatchAgent,
      selectedSkills: ['discovery'],
      transcriptTail: hugeTail,
      budget: { input: 100, output: 4000 },
    });

    expect(result.status).toBe('budget-exceeded');
    expect(result.judgments).toEqual([]);
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('dispatches once with the built prompt and returns parsed judgments on the happy path', async () => {
    dispatchAgent.mockResolvedValue({
      text: [
        '```json',
        JSON.stringify([
          { skill: 'discovery', applied: 'yes', completed: 'yes', confidence: 0.95 },
        ]),
        '```',
      ].join('\n'),
      usage: { input_tokens: 120, output_tokens: 30 },
    });

    const result = await runSkillJudge({
      dispatchAgent,
      selectedSkills: ['discovery'],
      transcriptTail: 'discovery skill was invoked and finished cleanly',
      model: 'haiku',
    });

    expect(result.status).toBe('ok');
    expect(result.judgments).toEqual([
      { skill: 'discovery', applied: 'yes', completed: 'yes', confidence: 0.95 },
    ]);

    // DI-seam assertion: runSkillJudge calls dispatchAgent exactly once, and the
    // prompt it passes is the buildJudgePrompt output (contains the skill + the
    // untrusted-data fence + the json-output instruction).
    expect(dispatchAgent).toHaveBeenCalledTimes(1);
    const callArg = dispatchAgent.mock.calls[0][0];
    expect(callArg.model).toBe('haiku');
    expect(callArg.prompt).toContain('discovery');
    expect(callArg.prompt).toContain('<untrusted-data-');
    expect(callArg.prompt).toContain('EXACTLY ONE fenced code block tagged `json`');
  });
});
