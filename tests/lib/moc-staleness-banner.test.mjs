/**
 * tests/lib/moc-staleness-banner.test.mjs
 *
 * Behavioral tests for scripts/lib/moc-staleness-banner.mjs (issue #831).
 *
 * Isolation: every case passes BOTH `repoRoot` AND `vaultDir` pointing into a
 * `mkdtempSync` tmpdir — never reads the real repo or the real Meta-Vault.
 * `now` is always injected so day-math stays deterministic (no un-injectable
 * `Date.now()`). Relative-offset dates (`now - N * 86_400_000`) are the
 * established repo convention (see tests/probes/docs-staleness.test.mjs's
 * "no hardcoded absolute-date fixtures" learning, conf 0.85) — the hardcoded
 * literal under test is the day-count `N` itself, asserted back out of the
 * result, never a re-derivation of the SUT's own formula.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
// Namespace import (not default) so vi.spyOn(fs, 'existsSync') etc. below can
// override the SUT's named `node:fs` imports via the shared ES-module
// namespace object (mirrors tests/lib/path-utils.test.mjs's
// vi.spyOn(fs, 'realpathSync') pattern; testing.md's "vi.spyOn on ESM named
// exports fails" gotcha is why spying on the REAL synthetic node:fs
// namespace does not work without this passthrough mock first).
import * as fs from 'node:fs';

// vi.mock('node:fs', ...) is hoisted by vitest BEFORE the SUT import below.
// Returning { ...actual } is a passthrough (no behaviour change for the
// tests that don't spy) but makes every property on the `fs` namespace
// configurable, so vi.spyOn(fs, 'existsSync') can intercept the SUT's calls.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return { ...actual };
});

import { checkMocStaleness } from '@lib/moc-staleness-banner.mjs';

// ---------------------------------------------------------------------------
// Fixed clock + helpers
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date('2026-07-20T00:00:00Z');

/** ISO string for `days` whole days before FIXED_NOW. */
function daysAgoIso(days) {
  return new Date(FIXED_NOW.getTime() - days * 86_400_000).toISOString();
}

/** Write `<dir>/<filename>` with a minimal MOC-shaped frontmatter body. */
function writeMoc(dir, filename, frontmatterBody) {
  fs.writeFileSync(
    path.join(dir, filename),
    `---\n${frontmatterBody}\n---\n\n# ${filename}\n`,
    'utf8'
  );
}

let tmpDirs = [];

function makeTmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

beforeEach(() => {
  tmpDirs = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
  tmpDirs = [];
});

// ---------------------------------------------------------------------------
// Bad input
// ---------------------------------------------------------------------------

describe('checkMocStaleness — bad input', () => {
  it('returns null when called with no arguments', () => {
    expect(checkMocStaleness()).toBe(null);
  });

  it('returns null when repoRoot is null', () => {
    const vaultDir = makeTmpDir('moc-staleness-vault-');
    expect(checkMocStaleness({ repoRoot: null, vaultDir, now: FIXED_NOW })).toBe(null);
  });

  it('returns null when repoRoot is a non-string (number)', () => {
    const vaultDir = makeTmpDir('moc-staleness-vault-');
    expect(checkMocStaleness({ repoRoot: 42, vaultDir, now: FIXED_NOW })).toBe(null);
  });

  it('returns null for empty-string repoRoot (falsy bad input)', () => {
    const vaultDir = makeTmpDir('moc-staleness-vault-');
    expect(checkMocStaleness({ repoRoot: '', vaultDir, now: FIXED_NOW })).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// Config gate — disabled config short-circuits BEFORE any filesystem I/O
// ---------------------------------------------------------------------------

describe('checkMocStaleness — config gate', () => {
  it('returns null AND performs no filesystem I/O when moc-staleness.enabled is false', () => {
    const tmpRepo = makeTmpDir('moc-staleness-repo-');
    const vaultDir = makeTmpDir('moc-staleness-vault-');
    const topicsDir = path.join(vaultDir, '08-topics');
    fs.mkdirSync(topicsDir, { recursive: true });
    // A genuinely stale MOC — if the gate did NOT short-circuit before I/O,
    // this file would produce a non-null banner (proven by the sibling
    // "reports one stale MOC" test below using the identical fixture shape).
    writeMoc(topicsDir, 'alpha-moc.md', `id: alpha-moc\nupdated: ${daysAgoIso(200)}`);

    const existsSpy = vi.spyOn(fs, 'existsSync');
    const readdirSpy = vi.spyOn(fs, 'readdirSync');
    const readFileSpy = vi.spyOn(fs, 'readFileSync');

    const result = checkMocStaleness({
      repoRoot: tmpRepo,
      vaultDir,
      now: FIXED_NOW,
      config: { 'moc-staleness': { enabled: false } },
    });

    expect(result).toBe(null);
    expect(existsSpy).not.toHaveBeenCalled();
    expect(readdirSpy).not.toHaveBeenCalled();
    expect(readFileSpy).not.toHaveBeenCalled();
  });

  it('returns null when moc-staleness.mode is "off" (enabled true but mode off)', () => {
    const tmpRepo = makeTmpDir('moc-staleness-repo-');
    const vaultDir = makeTmpDir('moc-staleness-vault-');
    const topicsDir = path.join(vaultDir, '08-topics');
    fs.mkdirSync(topicsDir, { recursive: true });
    writeMoc(topicsDir, 'alpha-moc.md', `id: alpha-moc\nupdated: ${daysAgoIso(200)}`);

    const result = checkMocStaleness({
      repoRoot: tmpRepo,
      vaultDir,
      now: FIXED_NOW,
      config: { 'moc-staleness': { enabled: true, mode: 'off' } },
    });

    expect(result).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// Vault-dir resolution
// ---------------------------------------------------------------------------

describe('checkMocStaleness — vault-dir resolution', () => {
  it('returns null when neither opts.vaultDir nor config vault-integration provide a path', () => {
    const tmpRepo = makeTmpDir('moc-staleness-repo-');
    expect(checkMocStaleness({ repoRoot: tmpRepo, now: FIXED_NOW })).toBe(null);
  });

  it('returns null when 08-topics/ is absent under the resolved vault dir', () => {
    const tmpRepo = makeTmpDir('moc-staleness-repo-');
    const vaultDir = makeTmpDir('moc-staleness-vault-'); // no 08-topics/ subdir created
    expect(checkMocStaleness({ repoRoot: tmpRepo, vaultDir, now: FIXED_NOW })).toBe(null);
  });

  it('opts.vaultDir (test seam) takes precedence over config vault-integration.vault-dir', () => {
    const tmpRepo = makeTmpDir('moc-staleness-repo-');
    const seamVaultDir = makeTmpDir('moc-staleness-seam-vault-');
    const configVaultDir = makeTmpDir('moc-staleness-config-vault-');
    // Stale MOC lives ONLY under the config vault-dir — if the seam did not
    // win, this would produce a warn banner instead of null.
    const configTopicsDir = path.join(configVaultDir, '08-topics');
    fs.mkdirSync(configTopicsDir, { recursive: true });
    writeMoc(configTopicsDir, 'alpha-moc.md', `id: alpha-moc\nupdated: ${daysAgoIso(200)}`);
    // The seam vault dir exists but has no 08-topics/ at all.

    const result = checkMocStaleness({
      repoRoot: tmpRepo,
      vaultDir: seamVaultDir,
      now: FIXED_NOW,
      config: {
        'moc-staleness': { enabled: true, thresholds: { moc: 90 }, mode: 'warn' },
        'vault-integration': { 'vault-dir': configVaultDir },
      },
    });

    expect(result).toBe(null);
  });

  it('expands a tilde-prefixed config vault-integration.vault-dir before joining 08-topics/', () => {
    // Regression guard for the resolveHostPath-does-not-expand-tilde trap:
    // the committed Session Config default (`~/Projects/vault`) is literal.
    const tmpRepo = makeTmpDir('moc-staleness-repo-');
    const tmpHome = makeTmpDir('moc-staleness-home-');
    vi.stubEnv('HOME', tmpHome);

    const topicsDir = path.join(tmpHome, '08-topics');
    fs.mkdirSync(topicsDir, { recursive: true });
    writeMoc(topicsDir, 'alpha-moc.md', `id: alpha-moc\nupdated: ${daysAgoIso(200)}`);

    const result = checkMocStaleness({
      repoRoot: tmpRepo,
      now: FIXED_NOW,
      config: {
        'moc-staleness': { enabled: true, thresholds: { moc: 90 }, mode: 'warn' },
        'vault-integration': { 'vault-dir': '~' },
      },
    });

    expect(result).not.toBe(null);
    expect(result.stale).toEqual([{ file: 'alpha-moc.md', days: 200 }]);
  });
});

// ---------------------------------------------------------------------------
// Healthy (no banner)
// ---------------------------------------------------------------------------

describe('checkMocStaleness — healthy (no banner)', () => {
  it('returns null when no MOC is stale', () => {
    const tmpRepo = makeTmpDir('moc-staleness-repo-');
    const vaultDir = makeTmpDir('moc-staleness-vault-');
    const topicsDir = path.join(vaultDir, '08-topics');
    fs.mkdirSync(topicsDir, { recursive: true });
    writeMoc(topicsDir, 'alpha-moc.md', `id: alpha-moc\nupdated: ${daysAgoIso(5)}`);

    expect(checkMocStaleness({ repoRoot: tmpRepo, vaultDir, now: FIXED_NOW })).toBe(null);
  });

  it('ignores a non "-moc.md" file in 08-topics/ regardless of its staleness', () => {
    const tmpRepo = makeTmpDir('moc-staleness-repo-');
    const vaultDir = makeTmpDir('moc-staleness-vault-');
    const topicsDir = path.join(vaultDir, '08-topics');
    fs.mkdirSync(topicsDir, { recursive: true });
    // Very old `updated:`, but the filename does not end in "-moc.md".
    writeMoc(topicsDir, 'example-topic-note.md', `id: example-topic-note\nupdated: ${daysAgoIso(999)}`);

    expect(checkMocStaleness({ repoRoot: tmpRepo, vaultDir, now: FIXED_NOW })).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// Warn — a stale MOC
// ---------------------------------------------------------------------------

describe('checkMocStaleness — warn (a stale MOC)', () => {
  it('returns the exact {severity, message, stale} shape for one stale MOC', () => {
    const tmpRepo = makeTmpDir('moc-staleness-repo-');
    const vaultDir = makeTmpDir('moc-staleness-vault-');
    const topicsDir = path.join(vaultDir, '08-topics');
    fs.mkdirSync(topicsDir, { recursive: true });
    writeMoc(topicsDir, 'example-topic-moc.md', `id: example-topic-moc\nupdated: ${daysAgoIso(142)}`);

    const result = checkMocStaleness({ repoRoot: tmpRepo, vaultDir, now: FIXED_NOW });

    expect(result).toEqual({
      severity: 'warn',
      message:
        '⚠ moc-staleness: 1 MOCs stale (>90 days) — example-topic-moc.md (142d) — ' +
        'review and refresh the `updated:` frontmatter.',
      stale: [{ file: 'example-topic-moc.md', days: 142 }],
    });
  });

  it('pins the literal "⚠ moc-staleness: " message prefix', () => {
    const tmpRepo = makeTmpDir('moc-staleness-repo-');
    const vaultDir = makeTmpDir('moc-staleness-vault-');
    const topicsDir = path.join(vaultDir, '08-topics');
    fs.mkdirSync(topicsDir, { recursive: true });
    writeMoc(topicsDir, 'alpha-moc.md', `id: alpha-moc\nupdated: ${daysAgoIso(120)}`);

    const result = checkMocStaleness({ repoRoot: tmpRepo, vaultDir, now: FIXED_NOW });

    expect(result.message.startsWith('⚠ moc-staleness: ')).toBe(true);
  });

  it('respects a custom moc-staleness.thresholds.moc value', () => {
    const tmpRepo = makeTmpDir('moc-staleness-repo-');
    const vaultDir = makeTmpDir('moc-staleness-vault-');
    const topicsDir = path.join(vaultDir, '08-topics');
    fs.mkdirSync(topicsDir, { recursive: true });
    writeMoc(topicsDir, 'alpha-moc.md', `id: alpha-moc\nupdated: ${daysAgoIso(45)}`);

    // Below the default 90d threshold — silent under defaults.
    expect(checkMocStaleness({ repoRoot: tmpRepo, vaultDir, now: FIXED_NOW })).toBe(null);

    // Above a tightened 30d threshold — warns.
    const result = checkMocStaleness({
      repoRoot: tmpRepo,
      vaultDir,
      now: FIXED_NOW,
      config: { 'moc-staleness': { enabled: true, thresholds: { moc: 30 }, mode: 'warn' } },
    });
    expect(result.stale).toEqual([{ file: 'alpha-moc.md', days: 45 }]);
    expect(result.message).toContain('>30 days');
  });

  it('lists multiple stale MOCs in a single combined result, never an array of banners', () => {
    const tmpRepo = makeTmpDir('moc-staleness-repo-');
    const vaultDir = makeTmpDir('moc-staleness-vault-');
    const topicsDir = path.join(vaultDir, '08-topics');
    fs.mkdirSync(topicsDir, { recursive: true });
    writeMoc(topicsDir, 'example-topic-moc.md', `id: example-topic-moc\nupdated: ${daysAgoIso(142)}`);
    writeMoc(topicsDir, 'other-moc.md', `id: other-moc\nupdated: ${daysAgoIso(98)}`);

    const result = checkMocStaleness({ repoRoot: tmpRepo, vaultDir, now: FIXED_NOW });

    expect(Array.isArray(result)).toBe(false);
    expect(result.severity).toBe('warn');
    expect(result.stale).toEqual([
      { file: 'example-topic-moc.md', days: 142 },
      { file: 'other-moc.md', days: 98 },
    ]);
  });

  it('truncates the stale-name list past 20 entries and says so in the message', () => {
    const tmpRepo = makeTmpDir('moc-staleness-repo-');
    const vaultDir = makeTmpDir('moc-staleness-vault-');
    const topicsDir = path.join(vaultDir, '08-topics');
    fs.mkdirSync(topicsDir, { recursive: true });
    for (let i = 0; i < 25; i += 1) {
      const name = `alpha-${String(i).padStart(2, '0')}-moc.md`;
      writeMoc(topicsDir, name, `id: ${name}\nupdated: ${daysAgoIso(200)}`);
    }

    const result = checkMocStaleness({ repoRoot: tmpRepo, vaultDir, now: FIXED_NOW });

    expect(result.stale).toHaveLength(25);
    expect(result.message).toContain('more (name list truncated)');
  });
});

// ---------------------------------------------------------------------------
// Exclusion — missing / unparseable `updated:` is EXCLUDED, not reported
// ---------------------------------------------------------------------------

describe('checkMocStaleness — missing/unparseable updated: is excluded', () => {
  it('returns null when the only MOC has no frontmatter fence at all', () => {
    const tmpRepo = makeTmpDir('moc-staleness-repo-');
    const vaultDir = makeTmpDir('moc-staleness-vault-');
    const topicsDir = path.join(vaultDir, '08-topics');
    fs.mkdirSync(topicsDir, { recursive: true });
    fs.writeFileSync(path.join(topicsDir, 'alpha-moc.md'), '# alpha\n\nno frontmatter here.\n', 'utf8');

    expect(checkMocStaleness({ repoRoot: tmpRepo, vaultDir, now: FIXED_NOW })).toBe(null);
  });

  it('returns null when the only MOC has frontmatter but no updated: key', () => {
    const tmpRepo = makeTmpDir('moc-staleness-repo-');
    const vaultDir = makeTmpDir('moc-staleness-vault-');
    const topicsDir = path.join(vaultDir, '08-topics');
    fs.mkdirSync(topicsDir, { recursive: true });
    writeMoc(topicsDir, 'alpha-moc.md', 'id: alpha-moc\ntype: reference');

    expect(checkMocStaleness({ repoRoot: tmpRepo, vaultDir, now: FIXED_NOW })).toBe(null);
  });

  it('returns null when the only MOC has an unparseable updated: value', () => {
    const tmpRepo = makeTmpDir('moc-staleness-repo-');
    const vaultDir = makeTmpDir('moc-staleness-vault-');
    const topicsDir = path.join(vaultDir, '08-topics');
    fs.mkdirSync(topicsDir, { recursive: true });
    writeMoc(topicsDir, 'alpha-moc.md', 'id: alpha-moc\nupdated: not-a-real-date');

    expect(checkMocStaleness({ repoRoot: tmpRepo, vaultDir, now: FIXED_NOW })).toBe(null);
  });

  it('excludes a broken-frontmatter MOC while still reporting a genuinely stale sibling', () => {
    const tmpRepo = makeTmpDir('moc-staleness-repo-');
    const vaultDir = makeTmpDir('moc-staleness-vault-');
    const topicsDir = path.join(vaultDir, '08-topics');
    fs.mkdirSync(topicsDir, { recursive: true });
    // Excluded: unparseable updated:
    writeMoc(topicsDir, 'broken-moc.md', 'id: broken-moc\nupdated: not-a-real-date');
    // Reported: genuinely stale
    writeMoc(topicsDir, 'example-topic-moc.md', `id: example-topic-moc\nupdated: ${daysAgoIso(142)}`);

    const result = checkMocStaleness({ repoRoot: tmpRepo, vaultDir, now: FIXED_NOW });

    expect(result.stale).toEqual([{ file: 'example-topic-moc.md', days: 142 }]);
    expect(result.message).not.toContain('broken-moc.md');
  });
});

// ---------------------------------------------------------------------------
// Fail-silent — never throws
// ---------------------------------------------------------------------------

describe('checkMocStaleness — fail-silent', () => {
  it('does not throw when 08-topics/ path component is a file, not a directory', () => {
    const tmpRepo = makeTmpDir('moc-staleness-repo-');
    const vaultDir = makeTmpDir('moc-staleness-vault-');
    // `<vaultDir>/08-topics` is a regular FILE, not a directory.
    fs.writeFileSync(path.join(vaultDir, '08-topics'), 'i am a file, not a dir\n', 'utf8');

    let result;
    expect(() => {
      result = checkMocStaleness({ repoRoot: tmpRepo, vaultDir, now: FIXED_NOW });
    }).not.toThrow();
    expect(result).toBe(null);
  });
});
