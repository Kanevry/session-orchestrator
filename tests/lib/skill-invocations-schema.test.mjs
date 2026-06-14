/**
 * tests/lib/skill-invocations-schema.test.mjs
 *
 * Unit tests for scripts/lib/skill-invocations-schema.mjs (epic #645, issue #644).
 *
 * Covered:
 *   CURRENT_SCHEMA_VERSION, VALID_EVENTS — constant values
 *   ValidationError — is an Error subclass with a field property
 *   validateSkillInvocation — accepts well-formed record; throws on bad schema_version,
 *                             bad event, empty/missing skill; session_id is OPTIONAL
 *                             (not required by the schema — confirmed by reading source)
 *   normalizeSkillInvocation — fills phase and session_id defaults to null
 *   appendSkillInvocation — writes valid JSONL + creates parent dir; throws on invalid
 *   readSkillInvocations — returns [] on absent file; skips malformed lines; round-trips
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CURRENT_SCHEMA_VERSION,
  VALID_EVENTS,
  DEFAULT_SKILL_INVOCATIONS_PATH,
  ValidationError,
  validateSkillInvocation,
  normalizeSkillInvocation,
  appendSkillInvocation,
  readSkillInvocations,
} from '@lib/skill-invocations-schema.mjs';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const validEntry = () => ({
  timestamp: '2026-06-14T10:00:00.000Z',
  event: 'selected',
  skill: 'session-orchestrator:discovery',
  session_id: 'sess-abc-123',
  schema_version: 1,
});

// ---------------------------------------------------------------------------
// Temp dir management
// ---------------------------------------------------------------------------

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'skill-invocations-schema-'));
});

afterEach(() => {
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('constants', () => {
  it('CURRENT_SCHEMA_VERSION is 1', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(1);
  });

  it('VALID_EVENTS contains "selected"', () => {
    expect(VALID_EVENTS).toContain('selected');
  });

  it('VALID_EVENTS does not contain "start" or "stop"', () => {
    expect(VALID_EVENTS).not.toContain('start');
    expect(VALID_EVENTS).not.toContain('stop');
  });

  it('DEFAULT_SKILL_INVOCATIONS_PATH ends with skill-invocations.jsonl', () => {
    expect(DEFAULT_SKILL_INVOCATIONS_PATH).toMatch(/skill-invocations\.jsonl$/);
  });
});

// ---------------------------------------------------------------------------
// ValidationError
// ---------------------------------------------------------------------------

describe('ValidationError', () => {
  it('is an instance of Error', () => {
    const err = new ValidationError('bad input', 'skill');
    expect(err).toBeInstanceOf(Error);
  });

  it('has name ValidationError', () => {
    const err = new ValidationError('bad input');
    expect(err.name).toBe('ValidationError');
  });

  it('exposes the field property when provided', () => {
    const err = new ValidationError('missing skill', 'skill');
    expect(err.field).toBe('skill');
  });

  it('field is undefined when not provided', () => {
    const err = new ValidationError('generic error');
    expect(err.field).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// validateSkillInvocation
// ---------------------------------------------------------------------------

describe('validateSkillInvocation', () => {
  it('accepts a well-formed record and returns the same object reference', () => {
    const entry = validEntry();
    const result = validateSkillInvocation(entry);
    expect(result).toBe(entry);
  });

  it('accepts a record without session_id (session_id is optional)', () => {
    const entry = validEntry();
    delete entry.session_id;
    expect(() => validateSkillInvocation(entry)).not.toThrow();
  });

  it('accepts a record with session_id: null', () => {
    const entry = { ...validEntry(), session_id: null };
    expect(() => validateSkillInvocation(entry)).not.toThrow();
  });

  it('accepts a record with phase: null', () => {
    const entry = { ...validEntry(), phase: null };
    expect(() => validateSkillInvocation(entry)).not.toThrow();
  });

  it('accepts a record with a non-null phase string', () => {
    const entry = { ...validEntry(), phase: 'W1-impl' };
    expect(() => validateSkillInvocation(entry)).not.toThrow();
  });

  it('throws ValidationError when entry is null', () => {
    expect(() => validateSkillInvocation(null)).toThrow(ValidationError);
  });

  it('throws ValidationError when entry is a string', () => {
    expect(() => validateSkillInvocation('not-an-object')).toThrow(ValidationError);
  });

  it('throws ValidationError when schema_version is wrong', () => {
    const entry = { ...validEntry(), schema_version: 99 };
    expect(() => validateSkillInvocation(entry)).toThrow(ValidationError);
    expect(() => validateSkillInvocation(entry)).toThrow(/schema_version/);
  });

  it('throws ValidationError with field="schema_version" when schema_version is wrong', () => {
    const entry = { ...validEntry(), schema_version: 99 };
    try {
      validateSkillInvocation(entry);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.field).toBe('schema_version');
    }
  });

  it('throws ValidationError when timestamp is missing', () => {
    const entry = validEntry();
    delete entry.timestamp;
    expect(() => validateSkillInvocation(entry)).toThrow(ValidationError);
    expect(() => validateSkillInvocation(entry)).toThrow(/timestamp/);
  });

  it('throws ValidationError when timestamp is empty string', () => {
    const entry = { ...validEntry(), timestamp: '' };
    expect(() => validateSkillInvocation(entry)).toThrow(ValidationError);
  });

  it('throws ValidationError when timestamp is not a valid ISO date', () => {
    const entry = { ...validEntry(), timestamp: 'not-a-date' };
    expect(() => validateSkillInvocation(entry)).toThrow(ValidationError);
    expect(() => validateSkillInvocation(entry)).toThrow(/timestamp/);
  });

  it('throws ValidationError when event is not "selected"', () => {
    const entry = { ...validEntry(), event: 'stop' };
    expect(() => validateSkillInvocation(entry)).toThrow(ValidationError);
    expect(() => validateSkillInvocation(entry)).toThrow(/event/);
  });

  it('throws ValidationError with field="event" on bad event', () => {
    const entry = { ...validEntry(), event: 'unknown' };
    try {
      validateSkillInvocation(entry);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.field).toBe('event');
    }
  });

  it('throws ValidationError when skill is missing', () => {
    const entry = validEntry();
    delete entry.skill;
    expect(() => validateSkillInvocation(entry)).toThrow(ValidationError);
    expect(() => validateSkillInvocation(entry)).toThrow(/skill/);
  });

  it('throws ValidationError when skill is an empty string', () => {
    const entry = { ...validEntry(), skill: '' };
    expect(() => validateSkillInvocation(entry)).toThrow(ValidationError);
    expect(() => validateSkillInvocation(entry)).toThrow(/skill/);
  });

  it('throws ValidationError when skill is whitespace-only', () => {
    const entry = { ...validEntry(), skill: '   ' };
    expect(() => validateSkillInvocation(entry)).toThrow(ValidationError);
  });

  it('throws ValidationError with field="skill" when skill is empty', () => {
    const entry = { ...validEntry(), skill: '' };
    try {
      validateSkillInvocation(entry);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.field).toBe('skill');
    }
  });

  it('throws ValidationError when session_id is a number (not string or null)', () => {
    const entry = { ...validEntry(), session_id: 42 };
    expect(() => validateSkillInvocation(entry)).toThrow(ValidationError);
    expect(() => validateSkillInvocation(entry)).toThrow(/session_id/);
  });

  it('throws ValidationError when phase is a number (not string or null)', () => {
    const entry = { ...validEntry(), phase: 99 };
    expect(() => validateSkillInvocation(entry)).toThrow(ValidationError);
    expect(() => validateSkillInvocation(entry)).toThrow(/phase/);
  });
});

// ---------------------------------------------------------------------------
// normalizeSkillInvocation
// ---------------------------------------------------------------------------

describe('normalizeSkillInvocation', () => {
  it('fills phase with null when absent', () => {
    const entry = validEntry();
    delete entry.phase;
    const result = normalizeSkillInvocation(entry);
    expect(result.phase).toBeNull();
  });

  it('fills session_id with null when absent', () => {
    const entry = validEntry();
    delete entry.session_id;
    const result = normalizeSkillInvocation(entry);
    expect(result.session_id).toBeNull();
  });

  it('fills schema_version with CURRENT_SCHEMA_VERSION when absent', () => {
    const entry = { timestamp: '2026-06-14T10:00:00Z', event: 'selected', skill: 'x' };
    const result = normalizeSkillInvocation(entry);
    expect(result.schema_version).toBe(1);
  });

  it('preserves existing schema_version when present', () => {
    const entry = { ...validEntry(), schema_version: 1 };
    const result = normalizeSkillInvocation(entry);
    expect(result.schema_version).toBe(1);
  });

  it('preserves existing phase when present', () => {
    const entry = { ...validEntry(), phase: 'W2-polish' };
    const result = normalizeSkillInvocation(entry);
    expect(result.phase).toBe('W2-polish');
  });

  it('does not mutate the input object', () => {
    const entry = validEntry();
    delete entry.phase;
    const before = { ...entry };
    normalizeSkillInvocation(entry);
    expect(entry).toEqual(before);
  });

  it('returns input unchanged when not an object', () => {
    expect(normalizeSkillInvocation(null)).toBeNull();
    expect(normalizeSkillInvocation(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// appendSkillInvocation
// ---------------------------------------------------------------------------

describe('appendSkillInvocation', () => {
  it('writes a valid JSONL line and creates parent directories', async () => {
    const filePath = join(tmp, 'subdir', 'nested', 'skill-invocations.jsonl');
    await appendSkillInvocation(filePath, validEntry());

    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, 'utf8').trim();
    const parsed = JSON.parse(content);
    expect(parsed.event).toBe('selected');
    expect(parsed.skill).toBe('session-orchestrator:discovery');
    expect(parsed.schema_version).toBe(1);
  });

  it('returns the validated and normalized entry that was written', async () => {
    const filePath = join(tmp, 'skill-invocations.jsonl');
    const entry = validEntry();
    const result = await appendSkillInvocation(filePath, entry);
    expect(result.event).toBe('selected');
    expect(result.skill).toBe('session-orchestrator:discovery');
    expect(result.session_id).toBe('sess-abc-123');
    expect(result.schema_version).toBe(1);
  });

  it('appends 2 records as separate JSONL lines, both parseable', async () => {
    const filePath = join(tmp, 'skill-invocations.jsonl');
    await appendSkillInvocation(filePath, validEntry());
    await appendSkillInvocation(filePath, { ...validEntry(), skill: 'session-orchestrator:test' });

    const lines = readFileSync(filePath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    expect(first.skill).toBe('session-orchestrator:discovery');
    expect(second.skill).toBe('session-orchestrator:test');
  });

  it('stamps schema_version automatically when missing from input', async () => {
    const filePath = join(tmp, 'skill-invocations.jsonl');
    const entry = validEntry();
    delete entry.schema_version;
    await appendSkillInvocation(filePath, entry);

    const content = readFileSync(filePath, 'utf8').trim();
    const parsed = JSON.parse(content);
    expect(parsed.schema_version).toBe(1);
  });

  it('throws ValidationError when skill is empty — file is not written', async () => {
    const filePath = join(tmp, 'skill-invocations.jsonl');
    const bad = { ...validEntry(), skill: '' };
    await expect(appendSkillInvocation(filePath, bad)).rejects.toThrow(ValidationError);
    expect(existsSync(filePath)).toBe(false);
  });

  it('throws ValidationError when event is not "selected"', async () => {
    const filePath = join(tmp, 'skill-invocations.jsonl');
    const bad = { ...validEntry(), event: 'start' };
    await expect(appendSkillInvocation(filePath, bad)).rejects.toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// readSkillInvocations
// ---------------------------------------------------------------------------

describe('readSkillInvocations', () => {
  it('returns empty array when file does not exist — never throws', async () => {
    const result = await readSkillInvocations(join(tmp, 'nonexistent.jsonl'));
    expect(result).toEqual([]);
  });

  it('returns parsed and normalized records from a valid JSONL file', async () => {
    const filePath = join(tmp, 'skill-invocations.jsonl');
    await appendSkillInvocation(filePath, validEntry());
    await appendSkillInvocation(filePath, { ...validEntry(), skill: 'session-orchestrator:test' });

    const records = await readSkillInvocations(filePath);
    expect(records).toHaveLength(2);
    expect(records[0].skill).toBe('session-orchestrator:discovery');
    expect(records[1].skill).toBe('session-orchestrator:test');
  });

  it('normalizes records on read — phase and session_id default to null when absent', async () => {
    const filePath = join(tmp, 'skill-invocations.jsonl');
    // Write a raw line without phase
    const raw = { timestamp: '2026-06-14T10:00:00Z', event: 'selected', skill: 'x', schema_version: 1 };
    appendFileSync(filePath, JSON.stringify(raw) + '\n');

    const records = await readSkillInvocations(filePath);
    expect(records[0].phase).toBeNull();
    expect(records[0].session_id).toBeNull();
  });

  it('skips malformed (non-JSON) lines and returns only valid ones', async () => {
    const filePath = join(tmp, 'skill-invocations.jsonl');
    appendFileSync(filePath, JSON.stringify(validEntry()) + '\n');
    appendFileSync(filePath, 'this is not json at all\n');
    appendFileSync(filePath, JSON.stringify({ ...validEntry(), skill: 'session-orchestrator:test' }) + '\n');

    const records = await readSkillInvocations(filePath);
    expect(records).toHaveLength(2);
    expect(records[0].skill).toBe('session-orchestrator:discovery');
    expect(records[1].skill).toBe('session-orchestrator:test');
  });

  it('returns empty array for a file containing only blank lines', async () => {
    const filePath = join(tmp, 'skill-invocations.jsonl');
    appendFileSync(filePath, '\n\n\n');

    const records = await readSkillInvocations(filePath);
    expect(records).toEqual([]);
  });

  it('round-trips 2 appended records back to original field values', async () => {
    const filePath = join(tmp, 'skill-invocations.jsonl');
    const e1 = { ...validEntry(), skill: 'skill-a', session_id: 'sess-1' };
    const e2 = { ...validEntry(), skill: 'skill-b', session_id: 'sess-2', phase: 'W1' };
    await appendSkillInvocation(filePath, e1);
    await appendSkillInvocation(filePath, e2);

    const records = await readSkillInvocations(filePath);
    expect(records).toHaveLength(2);
    expect(records[0].skill).toBe('skill-a');
    expect(records[0].session_id).toBe('sess-1');
    expect(records[0].event).toBe('selected');
    expect(records[1].skill).toBe('skill-b');
    expect(records[1].session_id).toBe('sess-2');
    expect(records[1].phase).toBe('W1');
  });
});
