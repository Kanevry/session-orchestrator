/**
 * tests/lib/skill-judgments-schema.test.mjs
 *
 * Unit tests for scripts/lib/skill-judgments-schema.mjs (epic #645, L3).
 *
 * Behavioral coverage of the L3 judgment-record schema:
 *   - validateSkillJudgment: accepts a valid record; rejects every constraint
 *     violation, with explicit emphasis on the LOAD-BEARING firewall constant
 *     advisory:true (a judgment must NEVER be persisted with advisory:false).
 *   - appendSkillJudgment: a written record round-trips via readSkillJudgments.
 *   - readSkillJudgments: missing path → []; malformed lines silently skipped.
 *
 * Falsification: every assertion fails if the validation/IO body is removed.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  validateSkillJudgment,
  appendSkillJudgment,
  readSkillJudgments,
  ValidationError,
  CURRENT_SCHEMA_VERSION,
  VALID_EVENTS,
} from '@lib/skill-judgments-schema.mjs';

/** A complete, valid skill-judgment record. */
function validRecord(overrides = {}) {
  return {
    timestamp: '2026-06-14T10:00:00.000Z',
    event: 'judged',
    skill: 'discovery',
    session_id: 'deep-1647',
    applied: 'yes',
    completed: 'no',
    confidence: 0.8,
    advisory: true,
    model: 'haiku',
    schema_version: 1,
    ...overrides,
  };
}

describe('validateSkillJudgment', () => {
  it('returns the entry unchanged for a fully valid record', () => {
    const rec = validRecord();
    expect(validateSkillJudgment(rec)).toBe(rec);
  });

  it('REJECTS advisory:false — the load-bearing advisory-only firewall', () => {
    expect(() => validateSkillJudgment(validRecord({ advisory: false }))).toThrow(
      ValidationError,
    );
  });

  it('rejects an applied value outside yes|no|unknown', () => {
    expect(() => validateSkillJudgment(validRecord({ applied: 'maybe' }))).toThrow(
      ValidationError,
    );
  });

  it('rejects a completed value outside yes|no|unknown', () => {
    expect(() => validateSkillJudgment(validRecord({ completed: 'partial' }))).toThrow(
      ValidationError,
    );
  });

  it('rejects confidence above 1', () => {
    expect(() => validateSkillJudgment(validRecord({ confidence: 1.5 }))).toThrow(
      ValidationError,
    );
  });

  it('rejects confidence below 0', () => {
    expect(() => validateSkillJudgment(validRecord({ confidence: -0.1 }))).toThrow(
      ValidationError,
    );
  });

  it("rejects an event other than 'judged' (e.g. 'selected' from the L1 schema)", () => {
    expect(() => validateSkillJudgment(validRecord({ event: 'selected' }))).toThrow(
      ValidationError,
    );
  });

  it('rejects an empty skill string', () => {
    expect(() => validateSkillJudgment(validRecord({ skill: '' }))).toThrow(
      ValidationError,
    );
  });

  it('rejects a schema_version other than 1', () => {
    expect(() => validateSkillJudgment(validRecord({ schema_version: 2 }))).toThrow(
      ValidationError,
    );
  });
});

describe('appendSkillJudgment + readSkillJudgments round-trip', () => {
  let dir;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('writes exactly one JSONL line that round-trips back via readSkillJudgments', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'skill-judgments-rt-'));
    const filePath = path.join(dir, 'nested', 'skill-judgments.jsonl');
    const rec = validRecord();

    await appendSkillJudgment(rec, { path: filePath });
    const readBack = await readSkillJudgments(filePath);

    expect(readBack).toHaveLength(1);
    expect(readBack[0]).toEqual({
      timestamp: '2026-06-14T10:00:00.000Z',
      event: 'judged',
      skill: 'discovery',
      session_id: 'deep-1647',
      applied: 'yes',
      completed: 'no',
      confidence: 0.8,
      advisory: true,
      model: 'haiku',
      schema_version: 1,
    });
  });
});

describe('readSkillJudgments', () => {
  let dir;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('returns [] without throwing for a missing file', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'skill-judgments-missing-'));
    const result = await readSkillJudgments(path.join(dir, 'does-not-exist.jsonl'));
    expect(result).toEqual([]);
  });

  it('returns only the valid record when a file mixes valid and malformed lines', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'skill-judgments-mixed-'));
    const filePath = path.join(dir, 'skill-judgments.jsonl');
    const valid = JSON.stringify(validRecord({ skill: 'plan' }));
    const lines = [valid, '{ not valid json at all', ''].join('\n');
    writeFileSync(filePath, lines + '\n', 'utf8');

    const result = await readSkillJudgments(filePath);

    expect(result).toHaveLength(1);
    expect(result[0].skill).toBe('plan');
  });
});

describe('module constants', () => {
  it('freezes VALID_EVENTS to exactly the judged event', () => {
    expect(VALID_EVENTS).toEqual(['judged']);
  });

  it('pins CURRENT_SCHEMA_VERSION to 1', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(1);
  });
});
