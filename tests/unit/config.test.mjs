/**
 * config.test.mjs (tests/unit) — targeted tests for Meta-Audit issues #255 + #259.
 *
 * Covers:
 *   - agent-mapping role-key validation (#255)
 *   - discovery-parallelism bounded-integer parsing (#259)
 *
 * Broader config parser coverage lives in tests/lib/config.test.mjs; neither
 * surface below is exercised there, so this file is not a duplicate of it.
 *
 * Shape: it.each {content, expected} / {content, matcher} tables.
 */

import { describe, it, expect } from 'vitest';
import { parseSessionConfig } from '@lib/config.mjs';

const CONFIG_HEADER = '## Session Config\n\n';
const cfg = (line) => parseSessionConfig(CONFIG_HEADER + line + '\n');

// ---------------------------------------------------------------------------
// agent-mapping role-key validation (issue #255)
// ---------------------------------------------------------------------------

describe('agent-mapping validation (#255)', () => {
  it.each([
    {
      why: 'accepts all 8 canonical role keys',
      line: '- **agent-mapping:** { impl: code-impl, test: test-writer, db: db-spec, ui: ui-dev, security: sec-rev, compliance: comp-rev, docs: docs-wr, perf: perf-eng }',
      expected: {
        impl: 'code-impl',
        test: 'test-writer',
        db: 'db-spec',
        ui: 'ui-dev',
        security: 'sec-rev',
        compliance: 'comp-rev',
        docs: 'docs-wr',
        perf: 'perf-eng',
      },
    },
    {
      why: 'accepts a single valid role',
      line: '- **agent-mapping:** { impl: code-implementer }',
      expected: { impl: 'code-implementer' },
    },
    {
      why: 'leaves agent-mapping null when the field is absent',
      line: '- **persistence:** true',
      expected: null,
    },
  ])('$why', ({ line, expected }) => {
    expect(cfg(line)['agent-mapping']).toEqual(expected);
  });

  it.each([
    // The error must name the field, the offending key, AND the allowed set.
    { why: 'invalid role key: names the field', line: '- **agent-mapping:** { foo: agent-x }', matcher: /agent-mapping/ },
    { why: 'invalid role key: names the offending key', line: '- **agent-mapping:** { foo: agent-x }', matcher: /foo/ },
    { why: 'invalid role key: lists an allowed key', line: '- **agent-mapping:** { foo: agent-x }', matcher: /impl/ },
    { why: 'multiple invalid keys: names the first', line: '- **agent-mapping:** { impl: code-impl, foo: agent-x, bar: agent-y }', matcher: /foo/ },
    { why: 'multiple invalid keys: names the second', line: '- **agent-mapping:** { impl: code-impl, foo: agent-x, bar: agent-y }', matcher: /bar/ },
    // Regression: _coerceObject used to filter `if (k && v)`, silently dropping
    // empty-value pairs BEFORE the validator could fire. The pair is now kept so
    // the validator throws as contracted.
    { why: 'empty value for a valid role: names the field (no silent drop)', line: '- **agent-mapping:** { impl: code-impl, test: }', matcher: /agent-mapping/ },
    { why: 'empty value for a valid role: names the key', line: '- **agent-mapping:** { impl: code-impl, test: }', matcher: /test/ },
  ])('throws — $why', ({ line, matcher }) => {
    expect(() => cfg(line)).toThrow(matcher);
  });
});

// ---------------------------------------------------------------------------
// discovery-parallelism (issue #259)
// ---------------------------------------------------------------------------

describe('discovery-parallelism (#259)', () => {
  it.each([
    { why: 'defaults to 5 when absent', line: '- **persistence:** true', expected: 5 },
    { why: 'parses an explicit in-bounds value of 10', line: '- **discovery-parallelism:** 10', expected: 10 },
    { why: 'parses lower bound 1', line: '- **discovery-parallelism:** 1', expected: 1 },
    { why: 'parses upper bound 16', line: '- **discovery-parallelism:** 16', expected: 16 },
    { why: 'silently falls back to 5 for out-of-bounds 100', line: '- **discovery-parallelism:** 100', expected: 5 },
    { why: 'silently falls back to 5 for out-of-bounds 0', line: '- **discovery-parallelism:** 0', expected: 5 },
    { why: 'silently falls back to 5 for a non-numeric value', line: '- **discovery-parallelism:** abc', expected: 5 },
  ])('$why', ({ line, expected }) => {
    expect(cfg(line)['discovery-parallelism']).toBe(expected);
  });
});
