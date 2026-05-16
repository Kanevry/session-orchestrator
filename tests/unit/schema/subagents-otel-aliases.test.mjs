/**
 * tests/unit/schema/subagents-otel-aliases.test.mjs
 *
 * Verifies that the #411 OTel alias additions to subagents-schema.mjs coexist
 * with existing fields and introduce no regression against the pre-#411 schema.
 *
 * New optional fields (Stop-record only, all nullable):
 *   gen_ai.usage.input_tokens  — alias of token_input
 *   gen_ai.usage.output_tokens — alias of token_output
 *   gen_ai.system              — AI provider identifier (e.g. 'anthropic')
 */

import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  validateSubagent,
  normalizeSubagent,
} from '@lib/subagents-schema.mjs';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/**
 * Minimal valid Stop record WITHOUT any OTel fields (pre-#411 shape).
 */
const legacyStop = () => ({
  timestamp: '2026-05-16T10:25:05.000Z',
  event: 'stop',
  agent_id: 'test-agent-1',
  schema_version: 1,
  duration_ms: 5000,
  token_input: 1500,
  token_output: 800,
});

/**
 * Stop record WITH all three OTel alias fields present (post-#411 shape).
 * Values match the legacy token fields to express the alias parity invariant.
 */
const otelStop = () => ({
  timestamp: '2026-05-16T10:25:05.000Z',
  event: 'stop',
  agent_id: 'test-agent-1',
  schema_version: 1,
  duration_ms: 5000,
  token_input: 1500,
  token_output: 800,
  'gen_ai.usage.input_tokens': 1500,
  'gen_ai.usage.output_tokens': 800,
  'gen_ai.system': 'anthropic',
});

// Absolute path to the P3-created fixture file.
const FIXTURE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/metrics/subagents-otel-alias.jsonl',
);

// ---------------------------------------------------------------------------
// Test 1 — Validator accepts OTel-augmented Stop record
// ---------------------------------------------------------------------------

describe('validateSubagent — OTel aliases coexist with legacy fields', () => {
  it('accepts a Stop record with both legacy token fields and all three OTel alias fields', () => {
    const record = otelStop();
    // validateSubagent returns the entry unchanged on success; throws ValidationError on failure
    const result = validateSubagent(record);
    expect(result).toBe(record); // same object reference — no mutation, no copy
  });

  it('returns the exact input object reference on success (not a copy)', () => {
    const record = otelStop();
    expect(validateSubagent(record)).toBe(record);
  });

  // ---------------------------------------------------------------------------
  // Test 2 — Backwards-compat: legacy Stop record without OTel fields still validates
  // ---------------------------------------------------------------------------

  it('accepts a legacy Stop record that has NO OTel alias fields (backwards-compat)', () => {
    const record = legacyStop();
    // None of the three OTel fields must be present for the validator to pass
    expect('gen_ai.usage.input_tokens' in record).toBe(false);
    expect('gen_ai.usage.output_tokens' in record).toBe(false);
    expect('gen_ai.system' in record).toBe(false);
    // Must not throw
    const result = validateSubagent(record);
    expect(result).toBe(record);
  });

  // ---------------------------------------------------------------------------
  // Test 3 — Null token values with gen_ai.system marker are accepted
  // ---------------------------------------------------------------------------

  it('accepts a Stop record where both token fields and their OTel aliases are null but gen_ai.system is present', () => {
    const record = {
      timestamp: '2026-05-16T10:25:05.000Z',
      event: 'stop',
      agent_id: 'test-agent-null-tokens',
      schema_version: 1,
      duration_ms: 0,
      token_input: null,
      token_output: null,
      'gen_ai.usage.input_tokens': null,
      'gen_ai.usage.output_tokens': null,
      'gen_ai.system': 'anthropic',
    };
    const result = validateSubagent(record);
    expect(result).toBe(record);
  });

  // ---------------------------------------------------------------------------
  // Test 6 — Field parity: schema does NOT enforce alias == legacy (writer's responsibility)
  // ---------------------------------------------------------------------------

  it('accepts a Stop record where token_input and gen_ai.usage.input_tokens are mismatched — schema does not enforce parity (the writer is responsible for emitting matched values)', () => {
    // NOTE: This test documents expected schema behavior. The validator intentionally
    // does NOT enforce that gen_ai.usage.input_tokens === token_input because the
    // schema rule is: both fields are nullable integers, independently validated.
    // Parity is an invariant owned by the emitter (subagent-telemetry.mjs), not
    // the schema module. If we ever add parity enforcement, this test must be updated.
    const mismatchedRecord = {
      timestamp: '2026-05-16T10:25:05.000Z',
      event: 'stop',
      agent_id: 'test-agent-mismatch',
      schema_version: 1,
      duration_ms: 1000,
      token_input: 100,
      token_output: 50,
      'gen_ai.usage.input_tokens': 999, // intentionally different from token_input
      'gen_ai.usage.output_tokens': 50,
      'gen_ai.system': 'anthropic',
    };
    // The schema accepts mismatched values; the writer is responsible for
    // emitting matched values (see hooks/subagent-telemetry.mjs, lines 119-121).
    expect(() => validateSubagent(mismatchedRecord)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Test 4 — Fixture roundtrip: both records validate and Stop has alias parity
// ---------------------------------------------------------------------------

describe('fixture roundtrip — subagents-otel-alias.jsonl', () => {
  it('parses both fixture records and both pass validation', async () => {
    const raw = await readFile(FIXTURE_PATH, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);

    expect(lines).toHaveLength(2);

    const start = JSON.parse(lines[0]);
    const stop = JSON.parse(lines[1]);

    // Both records must pass the validator without throwing
    expect(() => validateSubagent(start)).not.toThrow();
    expect(() => validateSubagent(stop)).not.toThrow();
  });

  it('fixture Start record has correct event and agent_id', async () => {
    const raw = await readFile(FIXTURE_PATH, 'utf8');
    const start = JSON.parse(raw.split('\n').filter(Boolean)[0]);

    expect(start.event).toBe('start');
    expect(start.agent_id).toBe('fixture-agent-1');
    expect(start.schema_version).toBe(1);
  });

  it('fixture Stop record carries OTel alias fields with values matching the legacy token fields', async () => {
    const raw = await readFile(FIXTURE_PATH, 'utf8');
    const stop = JSON.parse(raw.split('\n').filter(Boolean)[1]);

    // Alias parity: the fixture writer must emit identical values for both
    expect(stop['gen_ai.usage.input_tokens']).toBe(1500);
    expect(stop['gen_ai.usage.output_tokens']).toBe(800);
    expect(stop['gen_ai.usage.input_tokens']).toBe(stop.token_input);
    expect(stop['gen_ai.usage.output_tokens']).toBe(stop.token_output);
    expect(stop['gen_ai.system']).toBe('anthropic');
  });
});

// ---------------------------------------------------------------------------
// Test 5 — normalizeSubagent preserves OTel fields on read
// ---------------------------------------------------------------------------

describe('normalizeSubagent — OTel alias fields survive normalization', () => {
  it('preserves all three OTel fields with their original values when already present', () => {
    const record = otelStop();
    const normalized = normalizeSubagent(record);

    expect(normalized['gen_ai.usage.input_tokens']).toBe(1500);
    expect(normalized['gen_ai.usage.output_tokens']).toBe(800);
    expect(normalized['gen_ai.system']).toBe('anthropic');
  });

  it('defaults absent OTel fields to null when missing from a legacy record', () => {
    const record = legacyStop();
    const normalized = normalizeSubagent(record);

    expect(normalized['gen_ai.usage.input_tokens']).toBeNull();
    expect(normalized['gen_ai.usage.output_tokens']).toBeNull();
    expect(normalized['gen_ai.system']).toBeNull();
  });

  it('does not alter the legacy token fields when OTel fields are also present', () => {
    const record = otelStop();
    const normalized = normalizeSubagent(record);

    // Normalization must not overwrite or clear the original legacy fields
    expect(normalized.token_input).toBe(1500);
    expect(normalized.token_output).toBe(800);
  });
});
