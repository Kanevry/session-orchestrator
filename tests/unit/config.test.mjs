/**
 * config.test.mjs (tests/unit) — targeted tests for Meta-Audit issues #255 + #259.
 *
 * Covers:
 *   - agent-mapping role-key validation (#255)
 *   - discovery-parallelism bounded-integer parsing (#259)
 *
 * Broader config parser coverage lives in tests/lib/config.test.mjs.
 */

import { describe, it, expect } from 'vitest';
import { parseSessionConfig } from '../../scripts/lib/config.mjs';

const CONFIG_HEADER = '## Session Config\n\n';

// ---------------------------------------------------------------------------
// agent-mapping role-key validation (issue #255)
// ---------------------------------------------------------------------------

describe('agent-mapping validation (#255)', () => {
  it('accepts all 8 canonical role keys without throwing', () => {
    const content =
      CONFIG_HEADER +
      '- **agent-mapping:** { impl: code-impl, test: test-writer, db: db-spec, ui: ui-dev, security: sec-rev, compliance: comp-rev, docs: docs-wr, perf: perf-eng }\n';
    const config = parseSessionConfig(content);
    expect(config['agent-mapping']).toEqual({
      impl: 'code-impl',
      test: 'test-writer',
      db: 'db-spec',
      ui: 'ui-dev',
      security: 'sec-rev',
      compliance: 'comp-rev',
      docs: 'docs-wr',
      perf: 'perf-eng',
    });
  });

  it('accepts a single valid role', () => {
    const content = CONFIG_HEADER + '- **agent-mapping:** { impl: code-implementer }\n';
    const config = parseSessionConfig(content);
    expect(config['agent-mapping']).toEqual({ impl: 'code-implementer' });
  });

  it('throws on invalid role key listing the offending key and allowed set', () => {
    const content = CONFIG_HEADER + '- **agent-mapping:** { foo: agent-x }\n';
    expect(() => parseSessionConfig(content)).toThrow(/agent-mapping/);
    expect(() => parseSessionConfig(content)).toThrow(/foo/);
    expect(() => parseSessionConfig(content)).toThrow(/impl/);
  });

  it('throws on multiple invalid role keys listing all of them', () => {
    const content =
      CONFIG_HEADER + '- **agent-mapping:** { impl: code-impl, foo: agent-x, bar: agent-y }\n';
    expect(() => parseSessionConfig(content)).toThrow(/foo/);
    expect(() => parseSessionConfig(content)).toThrow(/bar/);
  });

  it('leaves agent-mapping null when field is absent', () => {
    const content = CONFIG_HEADER + '- **persistence:** true\n';
    const config = parseSessionConfig(content);
    expect(config['agent-mapping']).toBeNull();
  });

  it('throws on empty value for a valid role (no silent drop)', () => {
    // Regression: previously _coerceObject filtered `if (k && v)` which silently
    // dropped empty-value pairs BEFORE the validator could fire. Fixed to
    // preserve the pair so the validator throws as contracted.
    const content = CONFIG_HEADER + '- **agent-mapping:** { impl: code-impl, test: }\n';
    expect(() => parseSessionConfig(content)).toThrow(/agent-mapping/);
    expect(() => parseSessionConfig(content)).toThrow(/test/);
  });
});

// ---------------------------------------------------------------------------
// discovery-parallelism (issue #259)
// ---------------------------------------------------------------------------

describe('discovery-parallelism (#259)', () => {
  it('defaults to 5 when absent', () => {
    const content = CONFIG_HEADER + '- **persistence:** true\n';
    const config = parseSessionConfig(content);
    expect(config['discovery-parallelism']).toBe(5);
  });

  it('parses an explicit in-bounds value of 10', () => {
    const content = CONFIG_HEADER + '- **discovery-parallelism:** 10\n';
    const config = parseSessionConfig(content);
    expect(config['discovery-parallelism']).toBe(10);
  });

  it('parses lower bound 1', () => {
    const content = CONFIG_HEADER + '- **discovery-parallelism:** 1\n';
    const config = parseSessionConfig(content);
    expect(config['discovery-parallelism']).toBe(1);
  });

  it('parses upper bound 16', () => {
    const content = CONFIG_HEADER + '- **discovery-parallelism:** 16\n';
    const config = parseSessionConfig(content);
    expect(config['discovery-parallelism']).toBe(16);
  });

  it('silently falls back to default 5 for out-of-bounds value 100', () => {
    const content = CONFIG_HEADER + '- **discovery-parallelism:** 100\n';
    const config = parseSessionConfig(content);
    expect(config['discovery-parallelism']).toBe(5);
  });

  it('silently falls back to default 5 for out-of-bounds value 0', () => {
    const content = CONFIG_HEADER + '- **discovery-parallelism:** 0\n';
    const config = parseSessionConfig(content);
    expect(config['discovery-parallelism']).toBe(5);
  });

  it('silently falls back to default 5 for non-numeric value', () => {
    const content = CONFIG_HEADER + '- **discovery-parallelism:** abc\n';
    const config = parseSessionConfig(content);
    expect(config['discovery-parallelism']).toBe(5);
  });
});
