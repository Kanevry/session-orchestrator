import { describe, it, expect } from 'vitest';
import {
  validateSessionConfig,
  formatErrors,
  validateDocsOrchestrator,
  validateVaultStaleness,
} from '../../scripts/lib/config-schema.mjs';

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

describe('vault-integration validator', () => {
  it('accepts valid vault-integration block', () => {
    const result = validateSessionConfig(
      baseConfig({ 'vault-integration': { enabled: true, mode: 'warn', 'vault-dir': '~/Projects/vault' } })
    );
    expect(result.ok).toBe(true);
  });

  it('accepts absent vault-integration (fully optional)', () => {
    const result = validateSessionConfig(baseConfig());
    expect(result.ok).toBe(true);
  });

  it('rejects invalid vault-integration.mode enum', () => {
    const result = validateSessionConfig(
      baseConfig({ 'vault-integration': { enabled: true, mode: 'hard' } })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path === 'vault-integration.mode')).toBe(true);
    }
  });

  it('rejects non-boolean vault-integration.enabled', () => {
    const result = validateSessionConfig(
      baseConfig({ 'vault-integration': { enabled: 'yes' } })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path === 'vault-integration.enabled')).toBe(true);
    }
  });
});

describe('validateDocsOrchestrator', () => {
  it('returns empty array for empty object (all defaults valid)', () => {
    expect(validateDocsOrchestrator({})).toEqual([]);
  });

  it('returns error when enabled is not boolean', () => {
    const errs = validateDocsOrchestrator({ enabled: 'yes' });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => e.includes('boolean'))).toBe(true);
  });

  it('returns error when audiences is a string rather than array', () => {
    const errs = validateDocsOrchestrator({ audiences: 'user' });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => e.includes('array'))).toBe(true);
  });

  it('returns error when audiences contains an invalid entry', () => {
    const errs = validateDocsOrchestrator({ audiences: ['user', 'bogus'] });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => e.toLowerCase().includes('bogus') || e.includes('invalid'))).toBe(true);
  });

  it('returns error when mode is "hard" (not in strict|warn|off)', () => {
    const errs = validateDocsOrchestrator({ mode: 'hard' });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => e.includes('strict') || e.includes('warn') || e.includes('off'))).toBe(true);
  });

  it('returns empty array for valid full object', () => {
    expect(validateDocsOrchestrator({ enabled: true, audiences: ['user', 'dev'], mode: 'strict' })).toEqual([]);
  });

  it('returns error for non-object input (null)', () => {
    const errs = validateDocsOrchestrator(null);
    expect(errs.length).toBeGreaterThan(0);
  });

  it('returns error for non-object input (string)', () => {
    const errs = validateDocsOrchestrator('user');
    expect(errs.length).toBeGreaterThan(0);
  });
});

describe('validateVaultStaleness', () => {
  it('returns empty array for empty object (all defaults valid)', () => {
    expect(validateVaultStaleness({})).toEqual([]);
  });

  it('returns error when enabled is not boolean (number 1)', () => {
    const errs = validateVaultStaleness({ enabled: 1 });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => e.includes('boolean'))).toBe(true);
  });

  it('returns error when thresholds is a string rather than object', () => {
    const errs = validateVaultStaleness({ thresholds: 'bad' });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => e.includes('object'))).toBe(true);
  });

  it('returns error when thresholds.top is negative', () => {
    const errs = validateVaultStaleness({ thresholds: { top: -5 } });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => e.includes('top') && e.includes('positive'))).toBe(true);
  });

  it('returns error when thresholds.active is zero', () => {
    const errs = validateVaultStaleness({ thresholds: { active: 0 } });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => e.includes('active'))).toBe(true);
  });

  it('returns error when mode is "hard"', () => {
    const errs = validateVaultStaleness({ mode: 'hard' });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.some((e) => e.includes('strict') || e.includes('warn') || e.includes('off'))).toBe(true);
  });

  it('returns empty array for valid full object', () => {
    expect(
      validateVaultStaleness({ enabled: true, thresholds: { top: 7, active: 14, archived: 60 }, mode: 'off' })
    ).toEqual([]);
  });

  it('returns error for non-object input (null)', () => {
    const errs = validateVaultStaleness(null);
    expect(errs.length).toBeGreaterThan(0);
  });
});

describe('validateSessionConfig — aggregates docs-orchestrator and vault-staleness errors', () => {
  it('collects errors from both new validators when both blocks are invalid', () => {
    const result = validateSessionConfig(
      baseConfig({
        'docs-orchestrator': { enabled: 'yes', mode: 'hard' },
        'vault-staleness': { enabled: 1, thresholds: 'bad' },
      })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.errors.map((e) => e.path);
      expect(paths).toContain('docs-orchestrator');
      expect(paths).toContain('vault-staleness');
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('accepts valid docs-orchestrator and vault-staleness together', () => {
    const result = validateSessionConfig(
      baseConfig({
        'docs-orchestrator': { enabled: true, audiences: ['user', 'dev'], mode: 'warn' },
        'vault-staleness': { enabled: false, thresholds: { top: 30, active: 60, archived: 180 }, mode: 'off' },
      })
    );
    expect(result.ok).toBe(true);
  });
});

describe('vault-sync validator', () => {
  it('accepts valid vault-sync block', () => {
    const result = validateSessionConfig(
      baseConfig({ 'vault-sync': { enabled: false, mode: 'off', exclude: ['**/_MOC.md'] } })
    );
    expect(result.ok).toBe(true);
  });

  it('accepts absent vault-sync (fully optional)', () => {
    const result = validateSessionConfig(baseConfig());
    expect(result.ok).toBe(true);
  });

  it('rejects invalid vault-sync.mode enum', () => {
    const result = validateSessionConfig(
      baseConfig({ 'vault-sync': { enabled: true, mode: 'hard' } })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path === 'vault-sync.mode')).toBe(true);
    }
  });

  it('rejects non-array vault-sync.exclude', () => {
    const result = validateSessionConfig(
      baseConfig({ 'vault-sync': { exclude: '**/_MOC.md' } })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path === 'vault-sync.exclude')).toBe(true);
    }
  });
});
