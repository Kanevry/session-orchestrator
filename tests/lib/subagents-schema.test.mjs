/**
 * tests/lib/subagents-schema.test.mjs
 *
 * Unit tests for scripts/lib/subagents-schema.mjs (#342).
 *
 * Covered:
 *   CURRENT_SCHEMA_VERSION, VALID_EVENTS — constant values
 *   ValidationError — is an Error subclass with a field property
 *   validateSubagent — accepts valid start/stop records; throws on missing
 *                      timestamp, bad event, missing agent_id, missing
 *                      duration_ms on stop
 *   normalizeSubagent — fills schema_version and optional null defaults
 *   migrateLegacySubagent — stamps schema_version when absent
 *   appendSubagent — writes a valid JSONL line + creates parent dir
 *   readSubagents — returns [] on missing file; skips invalid lines
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CURRENT_SCHEMA_VERSION,
  VALID_EVENTS,
  ValidationError,
  validateSubagent,
  normalizeSubagent,
  migrateLegacySubagent,
  appendSubagent,
  readSubagents,
} from '../../scripts/lib/subagents-schema.mjs';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const validStart = () => ({
  timestamp: '2026-05-08T10:00:00.000Z',
  event: 'start',
  agent_id: 'explore-agent-1',
  schema_version: 1,
});

const validStop = () => ({
  timestamp: '2026-05-08T10:05:00.000Z',
  event: 'stop',
  agent_id: 'explore-agent-1',
  schema_version: 1,
  duration_ms: 300000,
});

// ---------------------------------------------------------------------------
// Temp dir management
// ---------------------------------------------------------------------------

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'subagents-schema-'));
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

  it('VALID_EVENTS contains start and stop', () => {
    expect(VALID_EVENTS).toContain('start');
    expect(VALID_EVENTS).toContain('stop');
  });
});

// ---------------------------------------------------------------------------
// ValidationError
// ---------------------------------------------------------------------------

describe('ValidationError', () => {
  it('is an instance of Error', () => {
    const err = new ValidationError('bad input', 'timestamp');
    expect(err).toBeInstanceOf(Error);
  });

  it('has name ValidationError', () => {
    const err = new ValidationError('bad input');
    expect(err.name).toBe('ValidationError');
  });

  it('exposes the field property when provided', () => {
    const err = new ValidationError('missing timestamp', 'timestamp');
    expect(err.field).toBe('timestamp');
  });
});

// ---------------------------------------------------------------------------
// validateSubagent
// ---------------------------------------------------------------------------

describe('validateSubagent', () => {
  it('accepts a valid event=start record', () => {
    const entry = validStart();
    expect(() => validateSubagent(entry)).not.toThrow();
    const result = validateSubagent(entry);
    expect(result).toBe(entry); // returns the same object reference
  });

  it('accepts a valid event=stop record with duration_ms', () => {
    const entry = validStop();
    expect(() => validateSubagent(entry)).not.toThrow();
  });

  it('throws ValidationError when timestamp is missing', () => {
    const entry = validStart();
    delete entry.timestamp;
    expect(() => validateSubagent(entry)).toThrow(ValidationError);
    expect(() => validateSubagent(entry)).toThrow(/timestamp/);
  });

  it('throws ValidationError when event is not in VALID_EVENTS', () => {
    const entry = { ...validStart(), event: 'pause' };
    expect(() => validateSubagent(entry)).toThrow(ValidationError);
    expect(() => validateSubagent(entry)).toThrow(/event/);
  });

  it('throws ValidationError when agent_id is missing', () => {
    const entry = validStart();
    delete entry.agent_id;
    expect(() => validateSubagent(entry)).toThrow(ValidationError);
    expect(() => validateSubagent(entry)).toThrow(/agent_id/);
  });

  it('throws ValidationError when event=stop and duration_ms is missing', () => {
    const entry = validStop();
    delete entry.duration_ms;
    expect(() => validateSubagent(entry)).toThrow(ValidationError);
    expect(() => validateSubagent(entry)).toThrow(/duration_ms/);
  });

  it('throws ValidationError when event=stop and duration_ms is negative', () => {
    const entry = { ...validStop(), duration_ms: -1 };
    expect(() => validateSubagent(entry)).toThrow(ValidationError);
  });

  it('throws ValidationError when entry is null', () => {
    expect(() => validateSubagent(null)).toThrow(ValidationError);
  });

  it('throws ValidationError when schema_version is wrong', () => {
    const entry = { ...validStart(), schema_version: 99 };
    expect(() => validateSubagent(entry)).toThrow(ValidationError);
    expect(() => validateSubagent(entry)).toThrow(/schema_version/);
  });

  it('throws ValidationError when timestamp is not a valid ISO string', () => {
    const entry = { ...validStart(), timestamp: 'not-a-date' };
    expect(() => validateSubagent(entry)).toThrow(ValidationError);
  });

  it('event=start does not require duration_ms', () => {
    const entry = validStart();
    // No duration_ms — must not throw
    expect(() => validateSubagent(entry)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// normalizeSubagent
// ---------------------------------------------------------------------------

describe('normalizeSubagent', () => {
  it('fills schema_version with CURRENT_SCHEMA_VERSION when missing', () => {
    const entry = { timestamp: '2026-05-08T10:00:00Z', event: 'start', agent_id: 'a1' };
    const result = normalizeSubagent(entry);
    expect(result.schema_version).toBe(1);
  });

  it('fills optional fields with null when absent', () => {
    const entry = validStart();
    const result = normalizeSubagent(entry);
    expect(result.agent_type).toBeNull();
    expect(result.parent_session_id).toBeNull();
    expect(result.token_input).toBeNull();
    expect(result.token_output).toBeNull();
  });

  it('preserves existing schema_version when present', () => {
    const entry = { ...validStart(), schema_version: 1 };
    const result = normalizeSubagent(entry);
    expect(result.schema_version).toBe(1);
  });

  it('returns the input unchanged when not an object', () => {
    expect(normalizeSubagent(null)).toBeNull();
    expect(normalizeSubagent(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// migrateLegacySubagent
// ---------------------------------------------------------------------------

describe('migrateLegacySubagent', () => {
  it('stamps schema_version when absent', () => {
    const entry = { timestamp: '2026-05-08T10:00:00Z', event: 'start', agent_id: 'a1' };
    const result = migrateLegacySubagent(entry);
    expect(result.schema_version).toBe(1);
  });

  it('is idempotent — does not change an already-canonical record', () => {
    const entry = validStart();
    const first = migrateLegacySubagent(entry);
    const second = migrateLegacySubagent(first);
    expect(second.schema_version).toBe(1);
    expect(second.agent_id).toBe('explore-agent-1');
  });
});

// ---------------------------------------------------------------------------
// appendSubagent
// ---------------------------------------------------------------------------

describe('appendSubagent', () => {
  it('writes a valid JSONL line and creates parent directories', async () => {
    const filePath = join(tmp, 'subdir', 'subagents.jsonl');
    const entry = validStart();
    await appendSubagent(filePath, entry);

    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, 'utf8').trim();
    const parsed = JSON.parse(content);
    expect(parsed.event).toBe('start');
    expect(parsed.agent_id).toBe('explore-agent-1');
    expect(parsed.schema_version).toBe(1);
  });

  it('appends multiple records as separate JSONL lines', async () => {
    const filePath = join(tmp, 'subagents.jsonl');
    await appendSubagent(filePath, validStart());
    await appendSubagent(filePath, validStop());

    const lines = readFileSync(filePath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    expect(first.event).toBe('start');
    expect(second.event).toBe('stop');
  });

  it('throws ValidationError when the record is invalid', async () => {
    const filePath = join(tmp, 'subagents.jsonl');
    const bad = { ...validStart(), event: 'invalid' };
    await expect(appendSubagent(filePath, bad)).rejects.toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// readSubagents
// ---------------------------------------------------------------------------

describe('readSubagents', () => {
  it('returns empty array when file does not exist — no throw', async () => {
    const result = await readSubagents(join(tmp, 'nonexistent.jsonl'));
    expect(result).toEqual([]);
  });

  it('returns parsed records from a valid JSONL file', async () => {
    const filePath = join(tmp, 'subagents.jsonl');
    await appendSubagent(filePath, validStart());
    await appendSubagent(filePath, validStop());

    const records = await readSubagents(filePath);
    expect(records).toHaveLength(2);
    expect(records[0].event).toBe('start');
    expect(records[1].event).toBe('stop');
  });

  it('skips malformed (non-JSON) lines and returns valid ones', async () => {
    const filePath = join(tmp, 'subagents.jsonl');
    // Write one valid line followed by a malformed line
    const { appendFileSync } = await import('node:fs');
    appendFileSync(filePath, JSON.stringify(validStart()) + '\n');
    appendFileSync(filePath, 'this is not json\n');
    appendFileSync(filePath, JSON.stringify(validStop()) + '\n');

    const records = await readSubagents(filePath);
    expect(records).toHaveLength(2);
    expect(records[0].event).toBe('start');
    expect(records[1].event).toBe('stop');
  });

  it('normalizes records on read (fills optional null fields)', async () => {
    const filePath = join(tmp, 'subagents.jsonl');
    await appendSubagent(filePath, validStart());

    const records = await readSubagents(filePath);
    expect(records[0].agent_type).toBeNull();
    expect(records[0].parent_session_id).toBeNull();
  });
});
