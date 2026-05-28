/**
 * vault-migration-rules.test.mjs — unit tests for the config loader
 * exported by scripts/lib/vault-migration-rules.mjs.
 *
 * Covers: loadVaultMigrationRules happy path, file-absent, malformed YAML,
 * missing/wrong-type sections, and getDefaults shape. Uses tmp YAML files
 * written via node:fs so the tests never depend on the operator's real
 * ~/.config/session-orchestrator/vault-migration-rules.yaml.
 *
 * Issue #604 — closing the zero-coverage gap on the loader and normalize().
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  loadVaultMigrationRules,
  getDefaults,
  VAULT_MIGRATION_RULES_PATH,
} from '../../scripts/lib/vault-migration-rules.mjs';

// ---------------------------------------------------------------------------
// Helpers — create/destroy a per-test temp directory
// ---------------------------------------------------------------------------

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'vmr-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function tmpFile(name, content) {
  const p = join(tmpDir, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

// ---------------------------------------------------------------------------
// VAULT_MIGRATION_RULES_PATH — module-level constant
// ---------------------------------------------------------------------------

describe('VAULT_MIGRATION_RULES_PATH', () => {
  it('is an absolute path ending with the expected filename', () => {
    expect(VAULT_MIGRATION_RULES_PATH).toMatch(
      /vault-migration-rules\.yaml$/,
    );
    expect(VAULT_MIGRATION_RULES_PATH.startsWith('/')).toBe(true);
  });

  it('sits under the .config/session-orchestrator directory', () => {
    expect(VAULT_MIGRATION_RULES_PATH).toContain(
      '.config/session-orchestrator/vault-migration-rules.yaml',
    );
  });
});

// ---------------------------------------------------------------------------
// getDefaults — shape and independence
// ---------------------------------------------------------------------------

describe('getDefaults', () => {
  it('returns an object with usernameRewrites, auditedRepos, dormantRepos', () => {
    const d = getDefaults();
    expect(d).toEqual({ usernameRewrites: [], auditedRepos: [], dormantRepos: [] });
  });

  it('returns empty arrays for all three fields', () => {
    const d = getDefaults();
    expect(d.usernameRewrites).toEqual([]);
    expect(d.auditedRepos).toEqual([]);
    expect(d.dormantRepos).toEqual([]);
  });

  it('returns a fresh object on every call — mutations do not leak', () => {
    const a = getDefaults();
    const b = getDefaults();
    a.auditedRepos.push('mutation');
    expect(b.auditedRepos).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// loadVaultMigrationRules — file-absent
// ---------------------------------------------------------------------------

describe('loadVaultMigrationRules — file absent', () => {
  it('returns defaults and source:defaults when the file does not exist', () => {
    const nonExistent = join(tmpDir, 'does-not-exist.yaml');
    const result = loadVaultMigrationRules(nonExistent);
    expect(result.source).toBe('defaults');
    expect(result.errors).toEqual([]);
    expect(result.config).toEqual({ usernameRewrites: [], auditedRepos: [], dormantRepos: [] });
  });

  it('does NOT throw when the file is absent', () => {
    const nonExistent = join(tmpDir, 'does-not-exist.yaml');
    expect(() => loadVaultMigrationRules(nonExistent)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// loadVaultMigrationRules — happy path (valid YAML, all sections present)
// ---------------------------------------------------------------------------

describe('loadVaultMigrationRules — valid YAML, all sections', () => {
  it('returns source:file and errors:[] for a well-formed config', () => {
    const p = tmpFile(
      'rules.yaml',
      [
        'schema-version: 1',
        'username-rewrites:',
        '  - from: /Users/oldname/',
        '    to: /Users/newname/',
        'audited-repos:',
        '  - my-repo',
        '  - /abs/path/repo',
        'dormant-repos:',
        '  - ~/Projects/dormant/one',
      ].join('\n'),
    );

    const result = loadVaultMigrationRules(p);
    expect(result.source).toBe('file');
    expect(result.errors).toEqual([]);
  });

  it('parses username-rewrites with concrete from/to values', () => {
    const p = tmpFile(
      'rules.yaml',
      [
        'username-rewrites:',
        '  - from: /Users/oldname/',
        '    to: /Users/newname/',
      ].join('\n'),
    );
    const { config } = loadVaultMigrationRules(p);
    expect(config.usernameRewrites).toEqual([
      { from: '/Users/oldname/', to: '/Users/newname/' },
    ]);
  });

  it('parses audited-repos as a string array', () => {
    const p = tmpFile(
      'rules.yaml',
      ['audited-repos:', '  - repo-alpha', '  - repo-beta'].join('\n'),
    );
    const { config } = loadVaultMigrationRules(p);
    expect(config.auditedRepos).toEqual(['repo-alpha', 'repo-beta']);
  });

  it('parses dormant-repos as a string array', () => {
    const p = tmpFile(
      'rules.yaml',
      ['dormant-repos:', '  - ~/Projects/dormant/x', '  - ~/Projects/dormant/y'].join('\n'),
    );
    const { config } = loadVaultMigrationRules(p);
    expect(config.dormantRepos).toEqual([
      '~/Projects/dormant/x',
      '~/Projects/dormant/y',
    ]);
  });

  it('handles multiple username-rewrites entries', () => {
    const p = tmpFile(
      'rules.yaml',
      [
        'username-rewrites:',
        '  - from: /Users/alice/',
        '    to: /Users/alice-new/',
        '  - from: /Users/bob/',
        '    to: /Users/bob-new/',
      ].join('\n'),
    );
    const { config } = loadVaultMigrationRules(p);
    expect(config.usernameRewrites).toEqual([
      { from: '/Users/alice/', to: '/Users/alice-new/' },
      { from: '/Users/bob/', to: '/Users/bob-new/' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// loadVaultMigrationRules — missing optional sections (defaults applied)
// ---------------------------------------------------------------------------

describe('loadVaultMigrationRules — missing optional sections', () => {
  it('returns empty usernameRewrites when username-rewrites is absent', () => {
    const p = tmpFile('rules.yaml', 'schema-version: 1\n');
    const { config, source, errors } = loadVaultMigrationRules(p);
    expect(source).toBe('file');
    expect(errors).toEqual([]);
    expect(config.usernameRewrites).toEqual([]);
  });

  it('returns empty auditedRepos when audited-repos is absent', () => {
    const p = tmpFile('rules.yaml', 'schema-version: 1\n');
    const { config } = loadVaultMigrationRules(p);
    expect(config.auditedRepos).toEqual([]);
  });

  it('returns empty dormantRepos when dormant-repos is absent', () => {
    const p = tmpFile('rules.yaml', 'schema-version: 1\n');
    const { config } = loadVaultMigrationRules(p);
    expect(config.dormantRepos).toEqual([]);
  });

  it('returns source:file when all sections are absent but the YAML is valid', () => {
    // A top-level mapping with only unknown keys — forward-compatible (ignored).
    const p = tmpFile('rules.yaml', 'schema-version: 1\nfuture-field: ignored\n');
    const { source, errors } = loadVaultMigrationRules(p);
    expect(source).toBe('file');
    expect(errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// loadVaultMigrationRules — malformed YAML (NEVER throws)
// ---------------------------------------------------------------------------

describe('loadVaultMigrationRules — malformed YAML', () => {
  it('does NOT throw on malformed YAML', () => {
    const p = tmpFile('rules.yaml', ':\n  - bad: yaml: here:\n  : : :\n');
    expect(() => loadVaultMigrationRules(p)).not.toThrow();
  });

  it('returns source:defaults on malformed YAML', () => {
    // Indentation error that js-yaml rejects
    const p = tmpFile(
      'rules.yaml',
      'audited-repos:\n  - ok\n   - bad-indent-error:\nfoo: [unclosed bracket\n',
    );
    const result = loadVaultMigrationRules(p);
    expect(result.source).toBe('defaults');
  });

  it('returns a non-empty errors array on malformed YAML', () => {
    const p = tmpFile('rules.yaml', 'foo: [unclosed bracket\n');
    const { errors } = loadVaultMigrationRules(p);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('failed to parse vault-migration-rules.yaml');
  });

  it('returns defaults config on malformed YAML', () => {
    const p = tmpFile('rules.yaml', 'foo: [unclosed bracket\n');
    const { config } = loadVaultMigrationRules(p);
    expect(config).toEqual({ usernameRewrites: [], auditedRepos: [], dormantRepos: [] });
  });
});

// ---------------------------------------------------------------------------
// loadVaultMigrationRules — YAML parses to a non-mapping (scalar / array)
// ---------------------------------------------------------------------------

describe('loadVaultMigrationRules — YAML is valid but not a mapping', () => {
  it('returns source:defaults when the YAML root is a bare string', () => {
    const p = tmpFile('rules.yaml', '"just a string"\n');
    const { source } = loadVaultMigrationRules(p);
    expect(source).toBe('defaults');
  });

  it('returns an error mentioning the mapping requirement for a bare string', () => {
    const p = tmpFile('rules.yaml', '"just a string"\n');
    const { errors } = loadVaultMigrationRules(p);
    expect(errors).toEqual(['config must be a YAML mapping']);
  });

  it('returns source:defaults when the YAML root is an array', () => {
    const p = tmpFile('rules.yaml', '- item-one\n- item-two\n');
    const { source, errors } = loadVaultMigrationRules(p);
    expect(source).toBe('defaults');
    expect(errors).toEqual(['config must be a YAML mapping']);
  });

  it('returns source:defaults when the YAML file is entirely empty (null parse)', () => {
    // js-yaml.load('') returns null — not a plain object
    const p = tmpFile('rules.yaml', '');
    const { source, errors } = loadVaultMigrationRules(p);
    expect(source).toBe('defaults');
    expect(errors).toEqual(['config must be a YAML mapping']);
  });

  it('returns default config values for a non-mapping root', () => {
    const p = tmpFile('rules.yaml', '42\n');
    const { config } = loadVaultMigrationRules(p);
    expect(config).toEqual({ usernameRewrites: [], auditedRepos: [], dormantRepos: [] });
  });
});

// ---------------------------------------------------------------------------
// loadVaultMigrationRules — wrong type for audited-repos
// ---------------------------------------------------------------------------

describe('loadVaultMigrationRules — wrong type: audited-repos', () => {
  it('returns source:defaults when audited-repos is a string, not an array', () => {
    const p = tmpFile('rules.yaml', 'audited-repos: "should-be-array"\n');
    const { source } = loadVaultMigrationRules(p);
    expect(source).toBe('defaults');
  });

  it('includes an error mentioning audited-repos for a scalar value', () => {
    const p = tmpFile('rules.yaml', 'audited-repos: "should-be-array"\n');
    const { errors } = loadVaultMigrationRules(p);
    expect(errors).toEqual(['audited-repos must be an array of strings']);
  });

  it('returns source:defaults when audited-repos is an array containing a non-string', () => {
    // Mixed array: .every(s => typeof s === 'string') fails → whole array rejected
    const p = tmpFile('rules.yaml', 'audited-repos:\n  - valid-repo\n  - 42\n');
    const { source, errors } = loadVaultMigrationRules(p);
    expect(source).toBe('defaults');
    expect(errors).toEqual(['audited-repos must be an array of strings']);
  });

  it('returns empty auditedRepos when audited-repos type is wrong', () => {
    const p = tmpFile('rules.yaml', 'audited-repos: 123\n');
    const { config } = loadVaultMigrationRules(p);
    expect(config.auditedRepos).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// loadVaultMigrationRules — wrong type for dormant-repos
// ---------------------------------------------------------------------------

describe('loadVaultMigrationRules — wrong type: dormant-repos', () => {
  it('returns source:defaults when dormant-repos is a string, not an array', () => {
    const p = tmpFile('rules.yaml', 'dormant-repos: "should-be-array"\n');
    const { source } = loadVaultMigrationRules(p);
    expect(source).toBe('defaults');
  });

  it('includes an error mentioning dormant-repos for a scalar value', () => {
    const p = tmpFile('rules.yaml', 'dormant-repos: "should-be-array"\n');
    const { errors } = loadVaultMigrationRules(p);
    expect(errors).toEqual(['dormant-repos must be an array of strings']);
  });

  it('returns source:defaults when dormant-repos contains a non-string element', () => {
    const p = tmpFile('rules.yaml', 'dormant-repos:\n  - ~/Projects/ok\n  - 99\n');
    const { source, errors } = loadVaultMigrationRules(p);
    expect(source).toBe('defaults');
    expect(errors).toEqual(['dormant-repos must be an array of strings']);
  });

  it('returns empty dormantRepos when dormant-repos type is wrong', () => {
    const p = tmpFile('rules.yaml', 'dormant-repos: true\n');
    const { config } = loadVaultMigrationRules(p);
    expect(config.dormantRepos).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// loadVaultMigrationRules — wrong type for username-rewrites
// ---------------------------------------------------------------------------

describe('loadVaultMigrationRules — wrong type: username-rewrites', () => {
  it('returns source:defaults when username-rewrites is a string, not an array', () => {
    const p = tmpFile('rules.yaml', 'username-rewrites: "should-be-array"\n');
    const { source, errors } = loadVaultMigrationRules(p);
    expect(source).toBe('defaults');
    expect(errors).toEqual(['username-rewrites must be an array']);
  });

  it('skips an individual rewrite entry missing the from field and records an error', () => {
    // The entry is skipped; the error is recorded; other valid entries are still applied.
    const p = tmpFile(
      'rules.yaml',
      [
        'username-rewrites:',
        '  - to: /Users/newname/',
        // NOTE: 'from' is missing — should cause an error for index 0
        '  - from: /Users/alice/',
        '    to: /Users/alice-new/',
      ].join('\n'),
    );
    const { config, errors, source } = loadVaultMigrationRules(p);
    // The bad entry at index 0 is rejected; the good one at index 1 is kept.
    // BUT: because errors.length > 0, source becomes 'defaults'.
    expect(source).toBe('defaults');
    expect(errors).toEqual([
      "username-rewrites[0]: must have string 'from' and 'to' fields",
    ]);
    // The valid entry at index 1 IS pushed into config (partial data on error — pin behavior).
    expect(config.usernameRewrites).toEqual([
      { from: '/Users/alice/', to: '/Users/alice-new/' },
    ]);
  });

  it('records an error for a rewrite entry where from is not a string', () => {
    const p = tmpFile(
      'rules.yaml',
      ['username-rewrites:', '  - from: 42', '    to: /Users/newname/'].join('\n'),
    );
    const { errors } = loadVaultMigrationRules(p);
    expect(errors).toEqual([
      "username-rewrites[0]: must have string 'from' and 'to' fields",
    ]);
  });
});

// ---------------------------------------------------------------------------
// loadVaultMigrationRules — multiple errors accumulate
// ---------------------------------------------------------------------------

describe('loadVaultMigrationRules — multiple validation errors', () => {
  it('accumulates errors from multiple invalid sections in one pass', () => {
    const p = tmpFile(
      'rules.yaml',
      ['audited-repos: 999', 'dormant-repos: false'].join('\n'),
    );
    const { errors, source } = loadVaultMigrationRules(p);
    expect(source).toBe('defaults');
    expect(errors).toContain('audited-repos must be an array of strings');
    expect(errors).toContain('dormant-repos must be an array of strings');
    expect(errors.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// loadVaultMigrationRules — source field semantics
// ---------------------------------------------------------------------------

describe('loadVaultMigrationRules — source field semantics', () => {
  it('source is "file" only when there are zero errors and the file exists', () => {
    const p = tmpFile('rules.yaml', 'schema-version: 1\n');
    expect(loadVaultMigrationRules(p).source).toBe('file');
  });

  it('source is "defaults" when there is at least one validation error', () => {
    const p = tmpFile('rules.yaml', 'audited-repos: not-an-array\n');
    expect(loadVaultMigrationRules(p).source).toBe('defaults');
  });

  it('source is "defaults" when the file is absent', () => {
    expect(loadVaultMigrationRules(join(tmpDir, 'missing.yaml')).source).toBe('defaults');
  });
});

// ---------------------------------------------------------------------------
// loadVaultMigrationRules — unknown/extra top-level keys are silently ignored
// ---------------------------------------------------------------------------

describe('loadVaultMigrationRules — forward-compatibility (unknown keys ignored)', () => {
  it('ignores unknown top-level keys without error', () => {
    const p = tmpFile(
      'rules.yaml',
      ['schema-version: 1', 'future-feature: some-value', 'audited-repos:', '  - repo-x'].join(
        '\n',
      ),
    );
    const { errors, source, config } = loadVaultMigrationRules(p);
    expect(errors).toEqual([]);
    expect(source).toBe('file');
    expect(config.auditedRepos).toEqual(['repo-x']);
  });
});
