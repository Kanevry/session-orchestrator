/**
 * tests/lib/context-coverage-banner.test.mjs — #831 building block B4.
 *
 * Every case builds an isolated tmpdir "repo" and "vault" via `mkdtempSync` —
 * never reads the real vault or the real home directory, so results stay
 * deterministic regardless of the host machine's live state. Both `repoRoot`
 * and `vaultDir` are passed explicitly through the `vaultDir` test seam.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
// Namespace import + vi.mock passthrough so vi.spyOn(fs, 'readdirSync') below
// can observe the SUT's own `readdirSync` calls via the shared ES module
// live binding (same pattern as tests/lib/path-utils.test.mjs).
import * as fs from 'node:fs';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return { ...actual };
});

import { checkContextCoverage } from '@lib/context-coverage-banner.mjs';

let tmpRepo;
let tmpVault;

beforeEach(() => {
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'context-coverage-repo-'));
  tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'context-coverage-vault-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of [tmpRepo, tmpVault]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

/** Create `<vaultDir>/01-projects/` (empty) and return its path. */
function makeProjectsDir(vaultDir) {
  const dir = path.join(vaultDir, '01-projects');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Create `<vaultDir>/01-projects/<slug>/` with the requested marker files.
 * `overview: false` deliberately omits `_overview.md` (the "not registered"
 * fixture shape).
 */
function makeProject(vaultDir, slug, { overview = true, contextMd = false, passiveMd = false } = {}) {
  const dir = path.join(vaultDir, '01-projects', slug);
  fs.mkdirSync(dir, { recursive: true });
  if (overview) fs.writeFileSync(path.join(dir, '_overview.md'), '# overview\n', 'utf8');
  if (contextMd) fs.writeFileSync(path.join(dir, 'context.md'), '# context\n', 'utf8');
  if (passiveMd) fs.writeFileSync(path.join(dir, '_passive.md'), '# passive\n', 'utf8');
  return dir;
}

describe('checkContextCoverage — bad input', () => {
  it('returns null when called with no arguments', () => {
    expect(checkContextCoverage()).toBe(null);
  });

  it('returns null when repoRoot is null', () => {
    expect(checkContextCoverage({ repoRoot: null, vaultDir: tmpVault })).toBe(null);
  });

  it('returns null when repoRoot is a non-string (number)', () => {
    expect(checkContextCoverage({ repoRoot: 42, vaultDir: tmpVault })).toBe(null);
  });
});

describe('checkContextCoverage — config gate (disabled, no I/O)', () => {
  it('returns null and never calls readdirSync when context-coverage.enabled is false', () => {
    makeProjectsDir(tmpVault);
    makeProject(tmpVault, 'alpha'); // would be a gap if the probe ran
    const readdirSpy = vi.spyOn(fs, 'readdirSync');

    const result = checkContextCoverage({
      repoRoot: tmpRepo,
      vaultDir: tmpVault,
      config: { 'context-coverage': { enabled: false } },
    });

    expect(result).toBe(null);
    expect(readdirSpy).not.toHaveBeenCalled();
  });

  it('returns null and never calls readdirSync when context-coverage.mode is "off"', () => {
    makeProjectsDir(tmpVault);
    makeProject(tmpVault, 'alpha');
    const readdirSpy = vi.spyOn(fs, 'readdirSync');

    const result = checkContextCoverage({
      repoRoot: tmpRepo,
      vaultDir: tmpVault,
      config: { 'context-coverage': { mode: 'off' } },
    });

    expect(result).toBe(null);
    expect(readdirSpy).not.toHaveBeenCalled();
  });
});

describe('checkContextCoverage — vault-dir resolution', () => {
  it('returns null when neither opts.vaultDir nor config vault-integration.vault-dir resolves', () => {
    expect(checkContextCoverage({ repoRoot: tmpRepo, config: {} })).toBe(null);
  });

  it('resolves the vault dir from config["vault-integration"]["vault-dir"] when opts.vaultDir is absent', () => {
    makeProjectsDir(tmpVault);
    makeProject(tmpVault, 'alpha'); // no context.md/_passive.md — a gap
    const result = checkContextCoverage({
      repoRoot: tmpRepo,
      config: { 'vault-integration': { 'vault-dir': tmpVault } },
    });
    expect(result).not.toBe(null);
    expect(result.gaps).toEqual([{ slug: 'alpha' }]);
  });

  it('opts.vaultDir (test seam) wins over config["vault-integration"]["vault-dir"]', () => {
    // Config points at a vault with a gap; the explicit vaultDir points at a
    // fully-covered vault. If the seam did not win, the result would be non-null.
    const configVault = fs.mkdtempSync(path.join(os.tmpdir(), 'context-coverage-configvault-'));
    makeProjectsDir(configVault);
    makeProject(configVault, 'alpha'); // gap, in the vault we must NOT scan
    makeProjectsDir(tmpVault);
    makeProject(tmpVault, 'beta', { contextMd: true }); // covered, in the vault we MUST scan

    try {
      const result = checkContextCoverage({
        repoRoot: tmpRepo,
        vaultDir: tmpVault,
        config: { 'vault-integration': { 'vault-dir': configVault } },
      });
      expect(result).toBe(null);
    } finally {
      try {
        fs.rmSync(configVault, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  });

  it('expands a tilde-prefixed config vault-dir (the committed repo default shape) before scanning', () => {
    // The committed default `vault-integration.vault-dir` is literally
    // `~/Projects/vault` and is NOT pre-expanded anywhere upstream — this
    // pins that checkContextCoverage applies expandTilde() itself.
    vi.stubEnv('HOME', tmpVault);
    const projectsDir = path.join(tmpVault, 'nested-vault', '01-projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    makeProject(path.join(tmpVault, 'nested-vault'), 'alpha'); // gap

    const result = checkContextCoverage({
      repoRoot: tmpRepo,
      config: { 'vault-integration': { 'vault-dir': '~/nested-vault' } },
    });

    expect(result).not.toBe(null);
    expect(result.gaps).toEqual([{ slug: 'alpha' }]);
  });
});

describe('checkContextCoverage — absent 01-projects/', () => {
  it('returns null when <vaultDir>/01-projects/ does not exist', () => {
    // tmpVault exists but has no 01-projects subdirectory at all.
    expect(checkContextCoverage({ repoRoot: tmpRepo, vaultDir: tmpVault })).toBe(null);
  });
});

describe('checkContextCoverage — healthy (every registered project covered)', () => {
  it('returns null when every registered project has context.md or _passive.md', () => {
    makeProjectsDir(tmpVault);
    makeProject(tmpVault, 'alpha', { contextMd: true });
    makeProject(tmpVault, 'beta', { passiveMd: true });
    expect(checkContextCoverage({ repoRoot: tmpRepo, vaultDir: tmpVault })).toBe(null);
  });
});

describe('checkContextCoverage — coverage-file variants', () => {
  it('context.md alone satisfies coverage', () => {
    makeProjectsDir(tmpVault);
    makeProject(tmpVault, 'alpha', { contextMd: true });
    expect(checkContextCoverage({ repoRoot: tmpRepo, vaultDir: tmpVault })).toBe(null);
  });

  it('_passive.md alone satisfies coverage', () => {
    makeProjectsDir(tmpVault);
    makeProject(tmpVault, 'alpha', { passiveMd: true });
    expect(checkContextCoverage({ repoRoot: tmpRepo, vaultDir: tmpVault })).toBe(null);
  });
});

describe('checkContextCoverage — some gaps (exact result shape)', () => {
  it('returns the exact {severity, message, gaps, registered, covered} shape with correct counts', () => {
    makeProjectsDir(tmpVault);
    makeProject(tmpVault, 'alpha', { contextMd: true }); // covered
    makeProject(tmpVault, 'beta', { passiveMd: true }); // covered
    makeProject(tmpVault, 'gamma'); // gap
    makeProject(tmpVault, 'delta'); // gap

    const result = checkContextCoverage({ repoRoot: tmpRepo, vaultDir: tmpVault });

    expect(result).toEqual({
      severity: 'warn',
      message:
        '⚠ context-coverage: 2 of 4 registered projects lack context.md and _passive.md — ' +
        'delta, gamma — add a context.md or mark the project passive with _passive.md.',
      gaps: [{ slug: 'delta' }, { slug: 'gamma' }],
      registered: 4,
      covered: 2,
    });
  });
});

describe('checkContextCoverage — _overview.md registration definition', () => {
  it('a folder WITHOUT _overview.md is neither counted as registered nor reported as a gap', () => {
    makeProjectsDir(tmpVault);
    makeProject(tmpVault, 'alpha', { contextMd: true }); // registered + covered
    makeProject(tmpVault, 'unregistered', { overview: false }); // NOT registered — no _overview.md

    const result = checkContextCoverage({ repoRoot: tmpRepo, vaultDir: tmpVault });

    // Only 'alpha' is registered (and covered) — the unregistered folder must
    // not inflate `registered` and must never appear in `gaps`.
    expect(result).toBe(null);
  });

  it('an unregistered folder without ANY coverage file is still excluded from gaps', () => {
    makeProjectsDir(tmpVault);
    makeProject(tmpVault, 'alpha'); // registered, no coverage file — a real gap
    makeProject(tmpVault, 'unregistered', { overview: false }); // no _overview.md, no coverage file either

    const result = checkContextCoverage({ repoRoot: tmpRepo, vaultDir: tmpVault });

    expect(result.registered).toBe(1);
    expect(result.gaps).toEqual([{ slug: 'alpha' }]);
  });
});

describe('checkContextCoverage — stray file inside 01-projects/', () => {
  it('a stray FILE (not a directory) inside 01-projects/ is ignored', () => {
    const projectsDir = makeProjectsDir(tmpVault);
    fs.writeFileSync(path.join(projectsDir, 'README.md'), '# not a project\n', 'utf8');
    makeProject(tmpVault, 'alpha'); // gap

    const result = checkContextCoverage({ repoRoot: tmpRepo, vaultDir: tmpVault });

    expect(result.registered).toBe(1);
    expect(result.gaps).toEqual([{ slug: 'alpha' }]);
  });
});

describe('checkContextCoverage — message prefix', () => {
  it('pins the literal "⚠ context-coverage: " prefix', () => {
    makeProjectsDir(tmpVault);
    makeProject(tmpVault, 'alpha'); // gap
    const result = checkContextCoverage({ repoRoot: tmpRepo, vaultDir: tmpVault });
    expect(result.message.startsWith('⚠ context-coverage: ')).toBe(true);
  });
});

describe('checkContextCoverage — large gap count truncation', () => {
  it('truncates the gap-name list past 20 entries and says so in the message', () => {
    makeProjectsDir(tmpVault);
    for (let i = 0; i < 25; i += 1) {
      makeProject(tmpVault, `proj-${String(i).padStart(2, '0')}`); // all gaps
    }

    const result = checkContextCoverage({ repoRoot: tmpRepo, vaultDir: tmpVault });

    expect(result.registered).toBe(25);
    expect(result.gaps).toHaveLength(25);
    expect(result.message).toContain('more (name list truncated)');
  });
});

describe('checkContextCoverage — fail-silent', () => {
  it('does not throw when repoRoot is a weird value', () => {
    let result;
    expect(() => {
      result = checkContextCoverage({ repoRoot: '/tmp/\0bad', vaultDir: tmpVault });
    }).not.toThrow();
    expect(result).toBe(null);
  });
});
