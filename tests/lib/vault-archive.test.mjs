/**
 * vault-archive.test.mjs — unit + integration tests for scripts/lib/vault-archive.mjs
 *
 * Covers:
 *   slugFromFilename        — slugging + collision-safety via takenIds
 *   buildArchiveFields      — mandatory fields, injected clock, existing-fm merge,
 *                             invalid input → throw
 *   generateArchiveFrontmatter — single `---` block; parses back to schema-valid YAML
 *   archiveFileToVault      — dry-run writes nothing; --apply writes; existing
 *                             frontmatter merged (not doubled); manifest shape
 *   REAL validator          — generated output passes the ACTUAL vault-sync
 *                             validator.mjs Zod schema (subprocess)
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'js-yaml';

// Mocked os.homedir() — lets the tilde-expansion test prove `expandTilde()`
// (consumed via vault-archive.mjs's `./common.mjs` import) resolves through
// a REAL homedir()-anchored path without ever writing into the operator's
// actual $HOME. scripts/lib/common.mjs does `import os from 'node:os'` — a
// default import — so both the named `homedir` export AND `default.homedir`
// must be patched (mirrors tests/lib/memory-paths.test.mjs). vi.hoisted is
// required because a vi.mock factory cannot close over a plain top-level
// const (testing.md § Vitest Mocking Gotchas).
const { mockedHomedir } = vi.hoisted(() => ({ mockedHomedir: vi.fn(() => '/unset-fake-home') }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    homedir: mockedHomedir,
    default: { ...actual.default, homedir: mockedHomedir },
  };
});

import {
  slugFromFilename,
  todayIso,
  validateFrontmatterFields,
  splitFrontmatter,
  buildArchiveFields,
  generateArchiveFrontmatter,
  archiveFileToVault,
  titleFromMarkdown,
} from '@lib/vault-archive.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const VALIDATOR = join(REPO_ROOT, 'skills', 'vault-sync', 'validator.mjs');
const TMP_REAL = realpathSync(tmpdir());

const cleanups = [];
function mkTmp(prefix = 'va-') {
  const d = mkdtempSync(join(TMP_REAL, prefix));
  cleanups.push(d);
  return d;
}
function writeFile(base, rel, content) {
  const full = join(base, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
  return full;
}
afterEach(() => {
  while (cleanups.length) {
    try {
      rmSync(cleanups.pop(), { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

// A fixed, injected clock — assertions derive their expected value from it, so
// nothing drifts with wall-clock time.
const FIXED_NOW = new Date('2026-03-04T09:00:00Z');
const FIXED_DAY = '2026-03-04';

describe('todayIso', () => {
  it('formats an injected Date as YYYY-MM-DD', () => {
    expect(todayIso(FIXED_NOW)).toBe(FIXED_DAY);
  });
});

describe('slugFromFilename', () => {
  it('slugs a dated PRD filename into a valid kebab id', () => {
    expect(slugFromFilename('2026-04-25-autopilot-loop.md')).toBe('2026-04-25-autopilot-loop');
  });

  it('collapses non-alphanumeric runs and trims hyphens', () => {
    expect(slugFromFilename('Foo__Bar!!.md')).toBe('foo-bar');
  });

  it('is collision-safe against a takenIds set', () => {
    const taken = new Set();
    const a = slugFromFilename('dup.md', taken);
    const b = slugFromFilename('dup.md', taken);
    expect(a).toBe('dup');
    expect(b).toBe('dup-2');
    expect(taken.has('dup')).toBe(true);
    expect(taken.has('dup-2')).toBe(true);
  });
});

describe('validateFrontmatterFields', () => {
  it('accepts a fully-valid field object', () => {
    const { ok, errors } = validateFrontmatterFields({
      id: 'my-note',
      type: 'reference',
      created: FIXED_DAY,
      updated: FIXED_DAY,
    });
    expect(ok).toBe(true);
    expect(errors).toEqual([]);
  });

  it('rejects a bad id, bad type, and bad date', () => {
    const { ok, errors } = validateFrontmatterFields({
      id: 'Not A Slug',
      type: 'bogus',
      created: '04/03/2026',
      updated: FIXED_DAY,
    });
    expect(ok).toBe(false);
    expect(errors.length).toBe(3);
  });
});

describe('splitFrontmatter', () => {
  it('returns null frontmatter for a plain markdown file', () => {
    const r = splitFrontmatter('# Title\n\nbody\n');
    expect(r.hadFrontmatter).toBe(false);
    expect(r.frontmatter).toBeNull();
    expect(r.body).toBe('# Title\n\nbody\n');
  });

  it('parses an existing YAML frontmatter block and body', () => {
    const r = splitFrontmatter('---\nid: keep-me\ntype: note\n---\n# Body\n');
    expect(r.hadFrontmatter).toBe(true);
    expect(r.frontmatter).toMatchObject({ id: 'keep-me', type: 'note' });
    expect(r.body).toBe('# Body\n');
  });
});

describe('titleFromMarkdown', () => {
  it('extracts the first H1', () => {
    expect(titleFromMarkdown('# PRD — Foo\n\n## Problem\n')).toBe('PRD — Foo');
  });
});

describe('buildArchiveFields', () => {
  it('emits all mandatory fields with the injected clock and archival defaults', () => {
    const f = buildArchiveFields({
      sourcePath: '/repo/docs/prd/2026-01-02-thing.md',
      repoRoot: '/repo',
      now: FIXED_NOW,
      issueRef: '123',
    });
    expect(f.id).toBe('2026-01-02-thing');
    expect(f.type).toBe('reference');
    expect(f.status).toBe('archived');
    expect(f.created).toBe(FIXED_DAY);
    expect(f.updated).toBe(FIXED_DAY);
    expect(f.source).toBe('docs/prd/2026-01-02-thing.md');
    expect(f['source-repo']).toBe('session-orchestrator');
    expect(f['epic-ref']).toBe('123');
  });

  it('merges existing frontmatter: keeps valid id/type/created, preserves passthrough keys', () => {
    const f = buildArchiveFields({
      sourcePath: '/repo/x/note.md',
      repoRoot: '/repo',
      now: FIXED_NOW,
      existing: { id: 'original-id', type: 'note', created: '2025-12-01', customKey: 'kept' },
    });
    expect(f.id).toBe('original-id');
    expect(f.type).toBe('note'); // valid existing enum preserved
    expect(f.created).toBe('2025-12-01'); // original creation preserved
    expect(f.updated).toBe(FIXED_DAY); // updated always bumped to now
    expect(f.status).toBe('archived');
    expect(f.customKey).toBe('kept'); // passthrough survives
  });

  it('applies overrides last (wins over archival defaults)', () => {
    const f = buildArchiveFields({
      sourcePath: '/repo/x/note.md',
      repoRoot: '/repo',
      now: FIXED_NOW,
      overrides: { status: 'verified' },
    });
    expect(f.status).toBe('verified');
  });

  it('throws when the resulting frontmatter would be invalid', () => {
    expect(() =>
      buildArchiveFields({
        sourcePath: '/repo/x/note.md',
        now: FIXED_NOW,
        overrides: { type: 'not-a-real-type' },
      }),
    ).toThrow(/invalid/);
  });
});

describe('generateArchiveFrontmatter', () => {
  it('produces exactly one --- fenced block that round-trips to valid YAML', () => {
    const fm = generateArchiveFrontmatter({
      sourcePath: '/repo/docs/prd/foo.md',
      repoRoot: '/repo',
      now: FIXED_NOW,
    });
    const fences = fm.match(/^---$/gm);
    expect(fences).toHaveLength(2);

    const inner = fm.replace(/^---\n/, '').replace(/\n---\n$/, '');
    const parsed = YAML.load(inner);
    const { ok } = validateFrontmatterFields(parsed);
    expect(ok).toBe(true);
  });
});

describe('archiveFileToVault', () => {
  it('dry-run returns a would-archive manifest entry and writes NOTHING', () => {
    const vault = mkTmp('va-vault-');
    const src = writeFile(vault, 'src/prd/2026-01-02-foo.md', '# Foo PRD\n\nbody\n');

    const entry = archiveFileToVault({
      repoRoot: vault,
      vaultDir: vault,
      sourcePath: src,
      targetSubdir: '01-projects/x/prd',
      dryRun: true,
      now: FIXED_NOW,
    });

    expect(entry.action).toBe('would-archive');
    expect(entry.target).toBe('01-projects/x/prd/2026-01-02-foo.md');
    expect(entry.id).toBe('2026-01-02-foo');
    expect(existsSync(join(vault, '01-projects/x/prd/2026-01-02-foo.md'))).toBe(false);
  });

  it('--apply writes the archived file with frontmatter + original body', () => {
    const vault = mkTmp('va-vault-');
    const src = writeFile(vault, 'src/prd/bar.md', '# Bar PRD\n\nreal body\n');

    const entry = archiveFileToVault({
      repoRoot: vault,
      vaultDir: vault,
      sourcePath: src,
      targetSubdir: 'archive',
      dryRun: false,
      now: FIXED_NOW,
      issueRef: '77',
    });

    expect(entry.action).toBe('archived');
    const out = readFileSync(join(vault, 'archive/bar.md'), 'utf8');
    expect(out).toMatch(/^---\n/);
    expect(out).toContain('id: bar');
    expect(out).toContain('status: archived');
    expect(out).toContain('real body');
  });

  it('merges pre-existing frontmatter without producing a second --- block', () => {
    const vault = mkTmp('va-vault-');
    const src = writeFile(
      vault,
      'src/note.md',
      '---\nid: pre-existing\ntype: note\ncustom: kept-value\n---\n# Heading\n\nbody\n',
    );

    archiveFileToVault({
      repoRoot: vault,
      vaultDir: vault,
      sourcePath: src,
      targetSubdir: 'archive',
      dryRun: false,
      now: FIXED_NOW,
    });

    const out = readFileSync(join(vault, 'archive/note.md'), 'utf8');
    const fences = out.match(/^---$/gm);
    expect(fences).toHaveLength(2); // exactly one frontmatter block, not doubled
    expect(out).toContain('id: pre-existing'); // existing id preserved
    expect(out).toContain('custom: kept-value'); // passthrough survives
    expect(out).toContain('status: archived'); // archival field injected
    expect(out).toContain('# Heading'); // body preserved once
  });
});

describe('archiveFileToVault — tilde-expansion (architect finding, #774 follow-up)', () => {
  afterEach(() => {
    mockedHomedir.mockReset();
    mockedHomedir.mockImplementation(() => '/unset-fake-home');
  });

  it('a "~/"-prefixed vaultDir writes UNDER the (mocked) real home directory, never a literal "./~"', () => {
    // A REAL tmp dir stands in for "$HOME" here — os.homedir() is mocked to
    // return it, so the write is real (proves the fix end-to-end) but never
    // touches the operator's actual home directory.
    const fakeHome = mkTmp('va-fakehome-');
    mockedHomedir.mockReturnValue(fakeHome);

    const vault = mkTmp('va-vault-');
    const src = writeFile(vault, 'src/note.md', '# Tilde Note\n\nbody\n');

    const entry = archiveFileToVault({
      repoRoot: vault,
      vaultDir: '~/so-test-vault-tilde',
      sourcePath: src,
      targetSubdir: 'archive',
      dryRun: false,
      now: FIXED_NOW,
    });

    expect(entry.action).toBe('archived');
    // Written under the expanded (mocked) home dir, not a literal "~" segment.
    const expectedTarget = join(fakeHome, 'so-test-vault-tilde', 'archive', 'note.md');
    expect(existsSync(expectedTarget)).toBe(true);
    expect(readFileSync(expectedTarget, 'utf8')).toContain('Tilde Note');

    // Regression guard: this test's write never leaked into a literal "./~"
    // directory (the bug this fix closes — join(vaultDir, ...) with an
    // un-expanded "~/..." is a RELATIVE path, landing under
    // process.cwd()/~/...). Scoped to this test's OWN subdir name rather than
    // asserting bare "./~" is absent — an unrelated, pre-existing, gitignored
    // "~" directory (matches the "*~" .gitignore rule) can legitimately sit
    // at the repo root already, independent of this test.
    expect(existsSync(join(process.cwd(), '~', 'so-test-vault-tilde'))).toBe(false);
  });
});

describe('REAL validator (schema-conformance integration)', () => {
  it('generated archive output passes the actual vault-sync validator Zod schema', () => {
    const vault = mkTmp('va-realvault-');
    // Vault marker so validator.mjs recognises the dir (_meta/).
    mkdirSync(join(vault, '_meta'), { recursive: true });

    const src = writeFile(vault, 'src/2026-01-02-some-prd.md', '# Some PRD\n\nbody\n');
    const entry = archiveFileToVault({
      repoRoot: vault,
      vaultDir: vault,
      sourcePath: src,
      targetSubdir: '01-projects/session-orchestrator/prd',
      dryRun: false,
      now: FIXED_NOW,
      issueRef: '42',
    });

    const r = spawnSync('node', [VALIDATOR, '--mode', 'warn'], {
      env: { ...process.env, VAULT_DIR: vault },
      encoding: 'utf8',
    });
    const report = JSON.parse(r.stdout.trim().split('\n').pop());
    const ourErrors = (report.errors || []).filter((e) => e.file && e.file.includes(entry.id));
    expect(ourErrors).toEqual([]);
    // Sanity: the archived note WAS seen + validated (not silently skipped).
    expect(report.files_checked).toBeGreaterThanOrEqual(1);
  });
});
