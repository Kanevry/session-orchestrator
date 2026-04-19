import { describe, it, expect } from 'vitest';
import { validateSessionConfig, formatErrors } from '../../scripts/lib/config-schema.mjs';

function baseConfig(overrides = {}) {
  return {
    'test-command': 'npm test',
    'typecheck-command': 'npm run typecheck',
    'lint-command': 'npm run lint',
    'agents-per-wave': 6,
    waves: 5,
    persistence: true,
    enforcement: 'warn',
    ...overrides,
  };
}

describe('validateSessionConfig', () => {
  it('accepts the canonical 7-field config', () => {
    const result = validateSessionConfig(baseConfig());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config).toBeTypeOf('object');
  });

  it('rejects non-object input', () => {
    expect(validateSessionConfig(null).ok).toBe(false);
    expect(validateSessionConfig('string').ok).toBe(false);
    expect(validateSessionConfig(42).ok).toBe(false);
    expect(validateSessionConfig([]).ok).toBe(false);
  });

  it.each([
    ['test-command', ''],
    ['typecheck-command', ''],
    ['lint-command', ''],
    ['test-command', null],
    ['typecheck-command', 42],
  ])('rejects empty or non-string %s=%s', (field, value) => {
    const result = validateSessionConfig(baseConfig({ [field]: value }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path === field)).toBe(true);
    }
  });

  it('rejects waves < 3', () => {
    const result = validateSessionConfig(baseConfig({ waves: 2 }));
    expect(result.ok).toBe(false);
  });

  it('rejects non-integer waves', () => {
    const result = validateSessionConfig(baseConfig({ waves: 5.5 }));
    expect(result.ok).toBe(false);
  });

  it('accepts agents-per-wave as integer', () => {
    expect(validateSessionConfig(baseConfig({ 'agents-per-wave': 2 })).ok).toBe(true);
    expect(validateSessionConfig(baseConfig({ 'agents-per-wave': 18 })).ok).toBe(true);
  });

  it('rejects agents-per-wave < 2', () => {
    const result = validateSessionConfig(baseConfig({ 'agents-per-wave': 1 }));
    expect(result.ok).toBe(false);
  });

  it('accepts agents-per-wave as object with default', () => {
    const result = validateSessionConfig(
      baseConfig({ 'agents-per-wave': { default: 6, deep: 18, housekeeping: 2 } })
    );
    expect(result.ok).toBe(true);
  });

  it('rejects agents-per-wave object with missing default', () => {
    const result = validateSessionConfig(baseConfig({ 'agents-per-wave': { deep: 18 } }));
    expect(result.ok).toBe(false);
  });

  it('rejects agents-per-wave object with override < 2', () => {
    const result = validateSessionConfig(
      baseConfig({ 'agents-per-wave': { default: 6, deep: 1 } })
    );
    expect(result.ok).toBe(false);
  });

  it('rejects non-boolean persistence', () => {
    expect(validateSessionConfig(baseConfig({ persistence: 'true' })).ok).toBe(false);
    expect(validateSessionConfig(baseConfig({ persistence: 1 })).ok).toBe(false);
  });

  it.each(['strict', 'warn', 'off'])('accepts enforcement=%s', (value) => {
    expect(validateSessionConfig(baseConfig({ enforcement: value })).ok).toBe(true);
  });

  it('rejects unknown enforcement value', () => {
    const result = validateSessionConfig(baseConfig({ enforcement: 'loose' }));
    expect(result.ok).toBe(false);
  });

  it('accumulates multiple errors', () => {
    const result = validateSessionConfig({ 'test-command': '', waves: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThanOrEqual(5);
    }
  });

  it('does not mutate input', () => {
    const input = baseConfig();
    const snapshot = JSON.stringify(input);
    validateSessionConfig(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('does not throw on weird input shapes', () => {
    expect(() => validateSessionConfig(undefined)).not.toThrow();
    expect(() => validateSessionConfig({ 'agents-per-wave': [] })).not.toThrow();
  });
});

describe('formatErrors', () => {
  it('formats errors as human-readable lines', () => {
    const result = validateSessionConfig({ waves: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const formatted = formatErrors(result.errors);
      expect(formatted).toContain('waves');
      expect(formatted).toContain('-');
    }
  });
});
