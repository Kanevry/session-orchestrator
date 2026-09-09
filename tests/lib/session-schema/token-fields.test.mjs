/**
 * tests/lib/session-schema/token-fields.test.mjs
 *
 * Validation tests for the 3 Epic #644 token rollup fields added to the
 * session schema (OPTIONAL_FIELDS): total_token_input, total_token_output,
 * subagents_with_tokens.
 *
 * Validates via validateSession (the same path used for production writes),
 * which internally calls _validateOptionalFields.
 *
 * Testing-rule compliance (testing.md):
 *   - Hardcoded expected values (no tautological computation).
 *   - Error paths cover all three new field constraints.
 *   - Null acceptance tested (additive-optional contract).
 *   - Falsification-check: removing any field-validation branch in
 *     validator.mjs would cause specific tests below to pass when they
 *     should throw — each assertion is tied to a distinct code path.
 */

import { describe, it, expect } from 'vitest';
import { validateSession, ValidationError } from '@lib/session-schema/validator.mjs';

// ---------------------------------------------------------------------------
// Minimal valid base session — satisfies all REQUIRED_FIELDS.
// Reused across tests; spread it to add/override fields per test.
// ---------------------------------------------------------------------------

const BASE = () => ({
  session_id: 'test-session-id-001',
  session_type: 'housekeeping',
  started_at: '2026-01-01T10:00:00.000Z',
  completed_at: '2026-01-01T11:00:00.000Z',
  total_waves: 1,
  waves: [{ wave: 1, role: 'coordinator' }],
  agent_summary: { complete: 2, partial: 0, failed: 0, spiral: 0 },
  total_agents: 2,
  total_files_changed: 3,
});

// ---------------------------------------------------------------------------
// Happy path — all three new optional fields present with valid values
// ---------------------------------------------------------------------------

describe('validateSession — token fields (Epic #644) — valid values', () => {
  it('validates cleanly when all three token fields carry valid non-null values', () => {
    const entry = {
      ...BASE(),
      total_token_input: 12345,
      total_token_output: 6789,
      subagents_with_tokens: 4,
    };

    expect(() => validateSession(entry)).not.toThrow();
  });

  it('accepts total_token_input: null (absent data — additive optional)', () => {
    const entry = { ...BASE(), total_token_input: null };

    expect(() => validateSession(entry)).not.toThrow();
  });

  it('accepts total_token_output: null', () => {
    const entry = { ...BASE(), total_token_output: null };

    expect(() => validateSession(entry)).not.toThrow();
  });

  it('accepts subagents_with_tokens: null (treated as not-provided)', () => {
    const entry = { ...BASE(), subagents_with_tokens: null };

    expect(() => validateSession(entry)).not.toThrow();
  });

  it('validates cleanly when none of the three token fields are present (older record)', () => {
    // Token fields are optional — pre-#644 records must still validate clean.
    const entry = BASE();

    expect(() => validateSession(entry)).not.toThrow();
  });

  it('accepts total_token_input: 0 (zero-cost edge case)', () => {
    const entry = { ...BASE(), total_token_input: 0 };

    expect(() => validateSession(entry)).not.toThrow();
  });

  it('accepts subagents_with_tokens: 0 (no agents with token data)', () => {
    const entry = { ...BASE(), subagents_with_tokens: 0 };

    expect(() => validateSession(entry)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Error paths — one case per (field, rejected value). Each asserts BOTH the
// error CLASS and that the message names the offending field: a validator that
// threw the right class while naming the wrong field would leave the operator
// hunting the wrong key, and the previous split pairs only checked one of the
// two per case.
// ---------------------------------------------------------------------------

describe('validateSession — token-field constraint violations', () => {
  it.each([
    // NaN/Infinity: typeof 'number' and `NaN < 0` is false, so a typeof-only
    // guard let both through — Number.isFinite is what rejects them (#644 W4).
    ['total_token_input', -5, 'negative'],
    ['total_token_input', '1000', 'a numeric string'],
    ['total_token_input', NaN, 'NaN'],
    ['total_token_input', Infinity, 'Infinity'],
    ['total_token_output', -1, 'negative'],
    ['total_token_output', true, 'a boolean'],
    ['subagents_with_tokens', 2.5, 'a non-integer float'],
    ['subagents_with_tokens', -1, 'negative'],
    ['subagents_with_tokens', '3', 'a numeric string'],
  ])('rejects %s when it is %s, naming the field in the message', (field, value) => {
    const entry = { ...BASE(), [field]: value };

    expect(() => validateSession(entry)).toThrow(ValidationError);
    expect(() => validateSession(entry)).toThrow(new RegExp(field));
  });

  it('accepts subagents_with_tokens: 1 (valid integer)', () => {
    const entry = { ...BASE(), subagents_with_tokens: 1 };

    expect(() => validateSession(entry)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Return-value contract — validateSession stamps schema_version
// ---------------------------------------------------------------------------

describe('validateSession — return value with token fields', () => {
  it('returns a new object with the token fields preserved', () => {
    const entry = {
      ...BASE(),
      total_token_input: 500,
      total_token_output: 250,
      subagents_with_tokens: 3,
    };

    const result = validateSession(entry);

    expect(result.total_token_input).toBe(500);
    expect(result.total_token_output).toBe(250);
    expect(result.subagents_with_tokens).toBe(3);
  });

  it('does not mutate the input object', () => {
    const entry = { ...BASE(), total_token_input: 100 };
    const original = { ...entry };

    validateSession(entry);

    expect(entry).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// #1244 — cache buckets, the cost estimate and the token-contract marker.
// ---------------------------------------------------------------------------

describe('#1244 session token fields', () => {
  it('accepts a v2 rollup record carrying all five new fields', () => {
    const entry = {
      ...BASE(),
      total_token_input: 1100,
      total_token_output: 10,
      total_token_input_uncached: 100,
      total_token_cache_read: 1000,
      total_token_cache_creation: 0,
      total_cost_usd: 0.0026,
      _token_schema: 2,
    };
    expect(() => validateSession(entry)).not.toThrow();
  });

  it('accepts null for each of them (unknown is not zero)', () => {
    for (const field of [
      'total_token_input_uncached',
      'total_token_cache_read',
      'total_token_cache_creation',
      'total_cost_usd',
    ]) {
      expect(() => validateSession({ ...BASE(), [field]: null })).not.toThrow();
    }
  });

  it('rejects a negative or non-finite value on each new numeric field', () => {
    expect(() => validateSession({ ...BASE(), total_token_cache_read: -1 })).toThrow(ValidationError);
    expect(() => validateSession({ ...BASE(), total_cost_usd: Number.NaN })).toThrow(ValidationError);
    expect(() => validateSession({ ...BASE(), total_token_cache_creation: Infinity })).toThrow(
      ValidationError,
    );
  });
});
