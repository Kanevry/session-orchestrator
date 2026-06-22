/**
 * tests/lib/named-vault-resolver.test.mjs
 *
 * Unit tests for scripts/lib/named-vault-resolver.mjs (Issue #700 Part 2).
 *
 * IO is fully injected (existsSync, realpathSync, gitRemote) so every branch
 * is exercised without touching disk or git. Tests verify:
 *  - Backward-compat: absent vaults → single '/agents/vault' suffix.
 *  - parseNamedVaults: malformed entries are dropped; valid entries preserved.
 *  - canonicalSuffixesFromVaults: env override, named-vault list, fallback.
 *  - matchVaultForRepo: org-prefix matching; no match → null.
 *  - resolveCanonicalSuffixes: thin wrapper defers correctly.
 *  - findRepoRoot: walk-up with injected IO; symlink canonicalisation.
 *  - resolveNamedVault: explicit vault-name short-circuits git entirely;
 *    walkup path; fallback.
 */

import { describe, it, expect } from 'vitest';

import {
  parseNamedVaults,
  canonicalSuffixesFromVaults,
  matchVaultForRepo,
  resolveCanonicalSuffixes,
  findRepoRoot,
  resolveNamedVault,
} from '../../scripts/lib/named-vault-resolver.mjs';

// ---------------------------------------------------------------------------
// Stderr capture helper — wraps process.stderr.write to collect WARN lines
// ---------------------------------------------------------------------------

function captureStderr(fn) {
  const lines = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return lines;
}

// ---------------------------------------------------------------------------
// parseNamedVaults
// ---------------------------------------------------------------------------

describe('parseNamedVaults — absent vaults section', () => {
  it('returns [] when ownerConfig is undefined', () => {
    expect(parseNamedVaults(undefined)).toEqual([]);
  });

  it('returns [] when ownerConfig has no vaults key', () => {
    expect(parseNamedVaults({ owner: { name: 'Test' } })).toEqual([]);
  });

  it('returns [] when vaults is null', () => {
    expect(parseNamedVaults({ vaults: null })).toEqual([]);
  });

  it('returns [] when vaults is an empty array', () => {
    expect(parseNamedVaults({ vaults: [] })).toEqual([]);
  });
});

describe('parseNamedVaults — valid entries', () => {
  it('parses a single well-formed entry', () => {
    const config = {
      vaults: [{ name: 'bernhard', suffix: '/agents/vault', root: '~/v' }],
    };
    const result = parseNamedVaults(config);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('bernhard');
    expect(result[0].suffix).toBe('/agents/vault');
    expect(result[0].root).toBe('~/v');
  });

  it('preserves match.org-prefix on a valid entry', () => {
    const config = {
      vaults: [
        {
          name: 'bernhard',
          suffix: '/agents/vault',
          root: '~/v',
          match: { 'org-prefix': 'bernhard-group' },
        },
      ],
    };
    const result = parseNamedVaults(config);
    expect(result[0].match['org-prefix']).toBe('bernhard-group');
  });

  it('parses multiple valid entries and preserves order', () => {
    const config = {
      vaults: [
        { name: 'vault-a', suffix: '/agents/vault', root: '~/a' },
        { name: 'vault-b', suffix: '/agents/vault-b', root: '~/b' },
      ],
    };
    const result = parseNamedVaults(config);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('vault-a');
    expect(result[1].name).toBe('vault-b');
  });
});

describe('parseNamedVaults — malformed entries dropped with WARN', () => {
  it('drops an entry missing name and emits WARN', () => {
    const config = {
      vaults: [{ suffix: '/agents/vault', root: '~/v' }],
    };
    const lines = captureStderr(() => {
      const result = parseNamedVaults(config);
      expect(result).toHaveLength(0);
    });
    expect(lines.some((l) => l.includes('WARN'))).toBe(true);
  });

  it('drops an entry missing suffix and emits WARN', () => {
    const config = {
      vaults: [{ name: 'my-vault', root: '~/v' }],
    };
    const lines = captureStderr(() => {
      const result = parseNamedVaults(config);
      expect(result).toHaveLength(0);
    });
    expect(lines.some((l) => l.includes('WARN'))).toBe(true);
  });

  it('drops an entry missing root and emits WARN', () => {
    const config = {
      vaults: [{ name: 'my-vault', suffix: '/agents/vault' }],
    };
    const lines = captureStderr(() => {
      const result = parseNamedVaults(config);
      expect(result).toHaveLength(0);
    });
    expect(lines.some((l) => l.includes('WARN'))).toBe(true);
  });

  it('drops only the malformed entry; valid entries survive', () => {
    const config = {
      vaults: [
        { name: 'good', suffix: '/agents/vault', root: '~/v' },
        { suffix: '/agents/vault', root: '~/v' }, // missing name
      ],
    };
    const lines = captureStderr(() => {
      const result = parseNamedVaults(config);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('good');
    });
    expect(lines.some((l) => l.includes('WARN'))).toBe(true);
  });

  it('drops a non-object entry and emits WARN', () => {
    const config = {
      vaults: ['not-an-object'],
    };
    const lines = captureStderr(() => {
      const result = parseNamedVaults(config);
      expect(result).toHaveLength(0);
    });
    expect(lines.some((l) => l.includes('WARN'))).toBe(true);
  });

  it('WARNs and returns [] when vaults: is not an array (e.g. an object)', () => {
    const config = { vaults: { name: 'oops' } };
    const lines = captureStderr(() => {
      const result = parseNamedVaults(config);
      expect(result).toHaveLength(0);
    });
    expect(lines.some((l) => l.includes('WARN'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// canonicalSuffixesFromVaults
// ---------------------------------------------------------------------------

describe('canonicalSuffixesFromVaults — backward-compat', () => {
  it('returns ["/agents/vault"] when vaults is empty and no env override', () => {
    expect(canonicalSuffixesFromVaults([], undefined)).toEqual(['/agents/vault']);
  });

  it('returns ["/agents/vault"] when vaults is empty and env override is blank string', () => {
    expect(canonicalSuffixesFromVaults([], '')).toEqual(['/agents/vault']);
  });
});

describe('canonicalSuffixesFromVaults — env override wins', () => {
  it('returns [envOverride] when override is non-blank, even if vaults are present', () => {
    const vaults = [{ name: 'v', suffix: '/other/path', root: '~/v', match: {} }];
    expect(canonicalSuffixesFromVaults(vaults, '/custom/suffix')).toEqual(['/custom/suffix']);
  });

  it('trims whitespace from the env override value', () => {
    expect(canonicalSuffixesFromVaults([], '  /trimmed/suffix  ')).toEqual(['/trimmed/suffix']);
  });
});

describe('canonicalSuffixesFromVaults — named vaults list', () => {
  it('returns suffixes from each named vault entry', () => {
    const vaults = [
      { name: 'a', suffix: '/agents/vault-a', root: '~/a', match: {} },
      { name: 'b', suffix: '/agents/vault-b', root: '~/b', match: {} },
    ];
    expect(canonicalSuffixesFromVaults(vaults, undefined)).toEqual([
      '/agents/vault-a',
      '/agents/vault-b',
    ]);
  });
});

// ---------------------------------------------------------------------------
// matchVaultForRepo
// ---------------------------------------------------------------------------

describe('matchVaultForRepo', () => {
  const vaults = [
    {
      name: 'bernhard',
      suffix: '/agents/vault',
      root: '~/v',
      match: { 'org-prefix': 'bernhard-group' },
    },
  ];

  it('matches when repoSlug starts with org-prefix followed by "/"', () => {
    const result = matchVaultForRepo('bernhard-group/foo', vaults);
    expect(result).not.toBeNull();
    expect(result.name).toBe('bernhard');
    expect(result.suffix).toBe('/agents/vault');
    expect(result.root).toBe('~/v');
  });

  it('matches when repoSlug equals org-prefix exactly', () => {
    const result = matchVaultForRepo('bernhard-group', vaults);
    expect(result).not.toBeNull();
    expect(result.name).toBe('bernhard');
  });

  it('returns null when no vault matches the repoSlug', () => {
    const result = matchVaultForRepo('other-org/repo', vaults);
    expect(result).toBeNull();
  });

  it('returns null for empty repoSlug', () => {
    expect(matchVaultForRepo('', vaults)).toBeNull();
  });

  it('returns null when vaults array is empty', () => {
    expect(matchVaultForRepo('bernhard-group/foo', [])).toBeNull();
  });

  it('returns null when vault entries have no match.org-prefix', () => {
    const noMatchVaults = [{ name: 'v', suffix: '/agents/vault', root: '~/v', match: {} }];
    expect(matchVaultForRepo('any-org/foo', noMatchVaults)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveCanonicalSuffixes
// ---------------------------------------------------------------------------

describe('resolveCanonicalSuffixes', () => {
  it('returns ["/agents/vault"] when ownerConfig is undefined (backward-compat)', () => {
    expect(resolveCanonicalSuffixes({ ownerConfig: undefined })).toEqual(['/agents/vault']);
  });

  it('returns ["/agents/vault"] when ownerConfig has no vaults section', () => {
    expect(resolveCanonicalSuffixes({ ownerConfig: { owner: { name: 'Test' } } })).toEqual([
      '/agents/vault',
    ]);
  });

  it('returns env override from injected env object', () => {
    const result = resolveCanonicalSuffixes({
      ownerConfig: undefined,
      env: { VAULT_MIRROR_CANONICAL_SUFFIX: '/my/custom/vault' },
    });
    expect(result).toEqual(['/my/custom/vault']);
  });

  it('returns named vault suffixes when ownerConfig has valid vaults list', () => {
    const ownerConfig = {
      vaults: [{ name: 'v', suffix: '/agents/my-vault', root: '~/v' }],
    };
    const result = resolveCanonicalSuffixes({ ownerConfig, env: {} });
    expect(result).toEqual(['/agents/my-vault']);
  });
});

// ---------------------------------------------------------------------------
// findRepoRoot — injectable IO
// ---------------------------------------------------------------------------

describe('findRepoRoot', () => {
  it('returns the directory containing .git when found at the given cwd', () => {
    const existsSync = (p) => p === '/repo/.git';
    const realpathSync = (p) => p;
    expect(findRepoRoot('/repo', { existsSync, realpathSync })).toBe('/repo');
  });

  it('walks up to find .git in a parent directory', () => {
    const existsSync = (p) => p === '/repo/.git';
    const realpathSync = (p) => p;
    expect(findRepoRoot('/repo/src/lib', { existsSync, realpathSync })).toBe('/repo');
  });

  it('returns null when no .git is found before filesystem root', () => {
    const existsSync = () => false;
    const realpathSync = (p) => p;
    expect(findRepoRoot('/repo/src', { existsSync, realpathSync })).toBeNull();
  });

  it('calls realpathSync to canonicalise symlinks before walking', () => {
    let realpathCalled = false;
    const realpathSync = (p) => {
      realpathCalled = true;
      return '/real' + p; // maps /sym → /real/sym
    };
    // existsSync must match the REALPATH form
    const existsSync = (p) => p === '/real/sym/.git';
    findRepoRoot('/sym', { existsSync, realpathSync });
    expect(realpathCalled).toBe(true);
  });

  it('falls back to original cwd when realpathSync throws', () => {
    const realpathSync = () => { throw new Error('ENOENT'); };
    const existsSync = (p) => p === '/repo/.git';
    expect(findRepoRoot('/repo', { existsSync, realpathSync })).toBe('/repo');
  });
});

// ---------------------------------------------------------------------------
// resolveNamedVault
// ---------------------------------------------------------------------------

describe('resolveNamedVault — explicit vault-name short-circuits git', () => {
  it('returns source "explicit" and does NOT call gitRemote when vaultName is set', () => {
    const throwingGitRemote = () => { throw new Error('gitRemote must not be called for explicit path'); };
    const ownerConfig = {
      vaults: [{ name: 'bernhard', suffix: '/agents/vault', root: '~/v' }],
    };
    const result = resolveNamedVault({
      vaultName: 'bernhard',
      ownerConfig,
      gitRemote: throwingGitRemote,
    });
    expect(result.source).toBe('explicit');
    expect(result.name).toBe('bernhard');
    expect(result.root).toBe('~/v');
    expect(result.suffix).toBe('/agents/vault');
  });

  it('explicit vault-name resolves root and suffix from matching vault entry', () => {
    const ownerConfig = {
      vaults: [{ name: 'bernhard', suffix: '/agents/vault', root: '~/vault-dir' }],
    };
    const result = resolveNamedVault({
      vaultName: 'bernhard',
      ownerConfig,
      gitRemote: () => { throw new Error('should not call'); },
    });
    expect(result.root).toBe('~/vault-dir');
    expect(result.suffix).toBe('/agents/vault');
  });

  it('explicit vault-name not in list still returns source "explicit" with null root', () => {
    const ownerConfig = { vaults: [] };
    const result = resolveNamedVault({
      vaultName: 'unknown-vault',
      ownerConfig,
      gitRemote: () => { throw new Error('should not call'); },
    });
    expect(result.source).toBe('explicit');
    expect(result.name).toBe('unknown-vault');
    expect(result.root).toBeNull();
  });
});

describe('resolveNamedVault — walkup path', () => {
  it('returns source "walkup" when org-prefix matches the git remote', () => {
    const ownerConfig = {
      vaults: [
        {
          name: 'bernhard',
          suffix: '/agents/vault',
          root: '~/v',
          match: { 'org-prefix': 'bernhard-group' },
        },
      ],
    };
    const result = resolveNamedVault({
      vaultName: null,
      ownerConfig,
      cwd: '/repo',
      existsSync: (p) => p === '/repo/.git',
      realpathSync: (p) => p,
      gitRemote: () => 'git@github.com:bernhard-group/my-repo.git',
      env: {},
    });
    expect(result.source).toBe('walkup');
    expect(result.name).toBe('bernhard');
    expect(result.root).toBe('~/v');
  });
});

describe('resolveNamedVault — fallback', () => {
  it('returns source "fallback" with null root when no vaults configured', () => {
    const result = resolveNamedVault({
      vaultName: null,
      ownerConfig: undefined,
      env: {},
    });
    expect(result.source).toBe('fallback');
    expect(result.root).toBeNull();
    expect(result.name).toBeNull();
    expect(result.suffix).toBe('/agents/vault');
  });

  it('returns source "fallback" when vaults are configured but no repo root found', () => {
    const ownerConfig = {
      vaults: [
        {
          name: 'bernhard',
          suffix: '/agents/vault',
          root: '~/v',
          match: { 'org-prefix': 'bernhard-group' },
        },
      ],
    };
    const result = resolveNamedVault({
      vaultName: null,
      ownerConfig,
      cwd: '/no-git-here',
      existsSync: () => false,
      realpathSync: (p) => p,
      gitRemote: () => { throw new Error('should not reach git if no root found'); },
      env: {},
    });
    expect(result.source).toBe('fallback');
  });

  it('uses env suffix override in fallback result', () => {
    const result = resolveNamedVault({
      vaultName: null,
      ownerConfig: undefined,
      env: { VAULT_MIRROR_CANONICAL_SUFFIX: '/custom/vault' },
    });
    expect(result.source).toBe('fallback');
    expect(result.suffix).toBe('/custom/vault');
  });
});
