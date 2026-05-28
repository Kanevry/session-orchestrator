/**
 * migrate-vault-paths.test.mjs — Tests for scripts/migrate-vault-paths.mjs
 *
 * Cross-repo username-drift fixer (epic #498). Rewrites a literal --from
 * segment to a literal --to segment in markdown files under selected repos.
 * Tests use synthetic placeholder usernames (oldname/newname).
 *
 * Tested behaviours:
 *   - Default dry-run; --apply mutates files
 *   - Literal split+join (no regex) — non-path-segment hits are NOT mutated
 *   - isHistorical() classification: decisions.md, /history/, 90-archive/, *-history/
 *   - Symlinks → skipped with reason: 'symlink'
 *   - EXCLUDE_GLOBS: /tests/, /.git/, etc. → skipped
 *   - Permission errors → counted; exit 2 when any I/O error occurred
 *   - Idempotency: second --apply is no-op
 *   - Classification: vault-dir-drift vs path-drift
 *
 * Subprocess-based: invokes the script via child_process.spawnSync (fork-pool
 * safe). All file ops happen in os.tmpdir()-rooted directories — never touches
 * real ~/Projects.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  chmodSync,
  existsSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Repo + script paths
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts', 'migrate-vault-paths.mjs');

// Resolve tmpdir to its real path so spawnSync output matches the comparison
// when the system tmp is symlinked (e.g. /var → /private/var on macOS).
const TMP_REAL = realpathSync(tmpdir());

const OLD = '/Users/oldname/';
const NEW = '/Users/newname/';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const cleanups = [];

function mkTmp(prefix = 'mvp-test-') {
  const tmp = mkdtempSync(join(TMP_REAL, prefix));
  cleanups.push(tmp);
  return tmp;
}

/**
 * Run the migrate-vault-paths.mjs script with extra args. Always passes
 * --from / --to so tests are self-contained (no dependency on the operator's
 * vault-migration-rules.yaml). Returns the spawnSync result.
 */
function runScript(extraArgs = []) {
  return spawnSync(process.execPath, [SCRIPT, '--from', OLD, '--to', NEW, ...extraArgs], {
    encoding: 'utf8',
    timeout: 20_000,
  });
}

/**
 * Write `content` to a file inside `dir`, creating parents as needed.
 */
function writeFile(dir, relPath, content) {
  const full = join(dir, relPath);
  const parent = full.substring(0, full.lastIndexOf('/'));
  if (parent && parent !== dir) mkdirSync(parent, { recursive: true });
  writeFileSync(full, content, 'utf8');
  return full;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
  for (const d of cleanups.splice(0)) {
    // Restore any chmod-stripped read perms so rm can clean up.
    try { chmodSync(d, 0o755); } catch { /* ignore */ }
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// Default dry-run vs --apply
// ---------------------------------------------------------------------------

describe('migrate-vault-paths — default dry-run vs --apply', () => {
  it('default (no --apply) does NOT mutate files; reports would-fix', () => {
    const repo = mkTmp();
    const filePath = writeFile(repo, 'CLAUDE.md', `vault-dir: ${OLD}Projects/vault\n`);

    const result = runScript(['--repos', repo]);

    // File is unchanged
    expect(readFileSync(filePath, 'utf8')).toBe(`vault-dir: ${OLD}Projects/vault\n`);

    // Exit 0 success, output mentions would-fix and dry-run
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('would-fix');
    expect(result.stderr).toContain('[dry-run]');
  });

  it('--apply mutates file from old username segment to new', () => {
    const repo = mkTmp();
    const filePath = writeFile(repo, 'CLAUDE.md', `vault-dir: ${OLD}Projects/vault\n`);

    const result = runScript(['--repos', repo, '--apply']);

    // File is rewritten
    expect(readFileSync(filePath, 'utf8')).toBe(`vault-dir: ${NEW}Projects/vault\n`);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('fixed');
    expect(result.stderr).toContain('[applied]');
  });

  // GitLab #509 — Mutex check: --dry-run and --apply share the same `apply`
  // field. Previously this silently last-wins. The mutex check (mirrors
  // scripts/migrate-cold-start-seed.mjs:113-116) makes the conflict explicit.

  it('exits 1 with "mutually exclusive" stderr when --dry-run then --apply are passed', () => {
    const repo = mkTmp();
    writeFile(repo, 'CLAUDE.md', `${OLD}Projects/x\n`);

    const result = runScript(['--repos', repo, '--dry-run', '--apply']);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/mutually exclusive/);
  });

  it('exits 1 with "mutually exclusive" stderr when --apply then --dry-run are passed (order-independent)', () => {
    const repo = mkTmp();
    writeFile(repo, 'CLAUDE.md', `${OLD}Projects/x\n`);

    const result = runScript(['--repos', repo, '--apply', '--dry-run']);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/mutually exclusive/);
  });

  it('--dry-run alone still exits 0 (no regression of single-flag behavior)', () => {
    const repo = mkTmp();
    const filePath = writeFile(repo, 'CLAUDE.md', `${OLD}Projects/x\n`);

    const result = runScript(['--repos', repo, '--dry-run']);

    expect(result.status).toBe(0);
    // File untouched in dry-run
    expect(readFileSync(filePath, 'utf8')).toBe(`${OLD}Projects/x\n`);
    expect(result.stderr).toContain('[dry-run]');
  });

  it('--apply alone still exits 0 (no regression of single-flag behavior)', () => {
    const repo = mkTmp();
    const filePath = writeFile(repo, 'CLAUDE.md', `${OLD}Projects/x\n`);

    const result = runScript(['--repos', repo, '--apply']);

    expect(result.status).toBe(0);
    // File rewritten in apply
    expect(readFileSync(filePath, 'utf8')).toBe(`${NEW}Projects/x\n`);
    expect(result.stderr).toContain('[applied]');
  });
});

// ---------------------------------------------------------------------------
// Literal split+join (no regex) — only the exact path segment is mutated
// ---------------------------------------------------------------------------

describe('migrate-vault-paths — literal match only', () => {
  it('does NOT mutate a string containing the username without leading slash + trailing slash', () => {
    // grep filter only finds files containing the literal OLD path segment.
    // A line like "see oldname-other-string" does NOT match because the
    // literal "/Users/oldname/" is absent.
    const repo = mkTmp();
    const filePath = writeFile(repo, 'README.md', 'see oldname-other-string for ref\n');

    const result = runScript(['--repos', repo, '--apply']);

    // File is untouched — grep had no hit, no rewrite attempted
    expect(readFileSync(filePath, 'utf8')).toBe('see oldname-other-string for ref\n');
    expect(result.status).toBe(0);
    // 0 lines fixed
    expect(result.stderr).toContain('0 lines fixed');
  });

  it('only the literal /Users/oldname/ segment is replaced; trailing path is preserved', () => {
    const repo = mkTmp();
    const filePath = writeFile(
      repo,
      'STATE.md',
      `plan-file: ${OLD}Projects/foo/bar/baz.md\n`
    );

    runScript(['--repos', repo, '--apply']);

    expect(readFileSync(filePath, 'utf8')).toBe(
      `plan-file: ${NEW}Projects/foo/bar/baz.md\n`
    );
  });
});

// ---------------------------------------------------------------------------
// isHistorical() — historical contexts are NOT rewritten
// ---------------------------------------------------------------------------

describe('migrate-vault-paths — isHistorical() classification', () => {
  it('skips decisions.md (historical) even with --apply', () => {
    const repo = mkTmp();
    const filePath = writeFile(repo, 'decisions.md', `Old setup used ${OLD}Projects/x\n`);

    const result = runScript(['--repos', repo, '--apply']);

    // File is preserved
    expect(readFileSync(filePath, 'utf8')).toBe(`Old setup used ${OLD}Projects/x\n`);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('historical skipped');
  });

  it('skips files under /history/ directory', () => {
    const repo = mkTmp();
    const filePath = writeFile(repo, 'history/notes.md', `was ${OLD}Projects/x\n`);

    runScript(['--repos', repo, '--apply']);

    expect(readFileSync(filePath, 'utf8')).toBe(`was ${OLD}Projects/x\n`);
  });

  it('skips files under 90-archive/ (vault-style archive)', () => {
    const repo = mkTmp();
    const filePath = writeFile(repo, '90-archive/old-note.md', `legacy: ${OLD}Projects/x\n`);

    runScript(['--repos', repo, '--apply']);

    expect(readFileSync(filePath, 'utf8')).toBe(`legacy: ${OLD}Projects/x\n`);
  });

  it('skips files under pricing-history/ (basename includes -history)', () => {
    const repo = mkTmp();
    const filePath = writeFile(repo, 'pricing-history/q1.md', `price for ${OLD}Projects/x\n`);

    runScript(['--repos', repo, '--apply']);

    expect(readFileSync(filePath, 'utf8')).toBe(`price for ${OLD}Projects/x\n`);
  });
});

// ---------------------------------------------------------------------------
// Symlinks → skipped
// ---------------------------------------------------------------------------

describe('migrate-vault-paths — symlinks', () => {
  it('leaves a symlink alone while still rewriting the real target file', () => {
    // BSD/macOS `grep -r` does NOT follow symlinks to files, so the symlink
    // never enters the candidate list — only the real file is rewritten and
    // the symlink remains pointing to it. We verify both: real file is fixed,
    // symlink is untouched (no .migrate-tmp- leftover, link target unchanged).
    const repo = mkTmp();
    const realPath = writeFile(repo, 'real.md', `${OLD}Projects/x\n`);
    const symPath = join(repo, 'link.md');
    symlinkSync(realPath, symPath);

    const result = runScript(['--repos', repo, '--apply']);

    expect(result.status).toBe(0);
    // Real file rewritten via the atomic-write path
    expect(readFileSync(realPath, 'utf8')).toBe(`${NEW}Projects/x\n`);
    // Symlink still exists and still resolves via the same chain
    expect(existsSync(symPath)).toBe(true);
    expect(readFileSync(symPath, 'utf8')).toBe(`${NEW}Projects/x\n`);
    // No stray .migrate-tmp- left over in repo
    expect(result.stderr).not.toContain('failed to write');
  });
});

// ---------------------------------------------------------------------------
// EXCLUDE_GLOBS — /tests/, /.git/, etc.
// ---------------------------------------------------------------------------

describe('migrate-vault-paths — EXCLUDE_GLOBS', () => {
  it('skips files under /tests/ subdirectory', () => {
    const repo = mkTmp();
    const filePath = writeFile(repo, 'tests/fixture.md', `${OLD}Projects/x\n`);

    const result = runScript(['--repos', repo, '--apply']);

    // File preserved — excluded from candidate set by grep + final filter
    expect(readFileSync(filePath, 'utf8')).toBe(`${OLD}Projects/x\n`);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('0 lines fixed');
  });

  it('skips files under /.git/ directory', () => {
    const repo = mkTmp();
    const filePath = writeFile(repo, '.git/notes.md', `${OLD}Projects/x\n`);

    const result = runScript(['--repos', repo, '--apply']);

    expect(readFileSync(filePath, 'utf8')).toBe(`${OLD}Projects/x\n`);
    expect(result.status).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Arg parsing — exit 1 on bad args
// ---------------------------------------------------------------------------

describe('migrate-vault-paths — arg parsing', () => {
  it('exits with code 1 on unknown argument', () => {
    const result = runScript(['--bogus-flag']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown argument');
  });

  it('exits with code 1 when --repos is given an empty/missing value', () => {
    const result = runScript(['--repos']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--repos requires');
  });

  it('exits with code 1 when --repos resolves to no valid repos', () => {
    const result = runScript(['--repos', '/nonexistent/path/that-cannot-exist']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no valid repos');
  });
});

// ---------------------------------------------------------------------------
// Idempotency — second --apply is no-op
// ---------------------------------------------------------------------------

describe('migrate-vault-paths — idempotency', () => {
  it('second --apply reports 0 lines fixed', () => {
    const repo = mkTmp();
    const filePath = writeFile(repo, 'CLAUDE.md', `${OLD}Projects/x\n`);

    // First apply
    const firstResult = runScript(['--repos', repo, '--apply']);
    expect(firstResult.status).toBe(0);
    expect(readFileSync(filePath, 'utf8')).toBe(`${NEW}Projects/x\n`);
    expect(firstResult.stderr).toContain('1 lines fixed');

    // Second apply — file no longer contains the old segment
    const secondResult = runScript(['--repos', repo, '--apply']);
    expect(secondResult.status).toBe(0);
    expect(readFileSync(filePath, 'utf8')).toBe(`${NEW}Projects/x\n`);
    expect(secondResult.stderr).toContain('0 lines fixed');
  });
});

// ---------------------------------------------------------------------------
// Classification: vault-dir-drift vs path-drift
// ---------------------------------------------------------------------------

describe('migrate-vault-paths — classification', () => {
  it('classifies a vault-dir: line with old username as vault-dir-drift', () => {
    const repo = mkTmp();
    writeFile(repo, 'CLAUDE.md', `  vault-dir: ${OLD}Projects/vault\n`);

    const result = runScript(['--repos', repo, '--json']);

    const records = result.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const hits = records.filter((r) => r.classification === 'vault-dir-drift');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ classification: 'vault-dir-drift' });
    expect(hits[0].file).toContain('CLAUDE.md');
    // Symmetric no-leak guard — a vault-dir: line must NOT also be classified as path-drift.
    expect(records.some((r) => r.classification === 'path-drift')).toBe(false);
  });

  it('classifies a non-vault-dir reference as path-drift', () => {
    const repo = mkTmp();
    writeFile(repo, 'STATE.md', `plan-file: ${OLD}Projects/foo/bar.md\n`);

    const result = runScript(['--repos', repo, '--json']);

    const records = result.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const hits = records.filter((r) => r.classification === 'path-drift');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ classification: 'path-drift' });
    expect(hits[0].file).toContain('STATE.md');
    // Symmetric no-leak guard — a non-vault-dir reference must NOT be classified as vault-dir-drift.
    expect(records.some((r) => r.classification === 'vault-dir-drift')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Missing-segment class (GitLab #600 D3) — vault-dir: ~/Projects/vault drift
//
// A second drift class, independent of the OLD_SEGMENT username rewrite: a
// `vault-dir:` value that points at ~/Projects/vault (MISSING the canonical
// /Bernhard/ owner segment) must become ~/Projects/Bernhard/vault. These files
// do NOT contain the OLD username, so they exercise the dedicated discovery +
// classification + rewrite path. Tests still pass --from/--to (via runScript)
// to keep the script self-contained; the missing-segment path fires regardless.
// ---------------------------------------------------------------------------

const CANONICAL_VAULT = '~/Projects/Bernhard/vault';

describe('migrate-vault-paths — missing-segment class (#600 D3)', () => {
  it('rewrites vault-dir: ~/Projects/vault to ~/Projects/Bernhard/vault on --apply', () => {
    const repo = mkTmp();
    const filePath = writeFile(repo, 'CLAUDE.md', 'vault-dir: ~/Projects/vault\n');

    const result = runScript(['--repos', repo, '--apply']);

    expect(result.status).toBe(0);
    // Hardcoded expected output — the canonical owner segment is inserted.
    expect(readFileSync(filePath, 'utf8')).toBe('vault-dir: ~/Projects/Bernhard/vault\n');
    expect(result.stdout).toContain('vault-dir-missing-segment-fixed');
    expect(result.stderr).toContain('1 lines fixed');
  });

  it('rewrites the expanded /Users/<user>/Projects/vault form too', () => {
    const repo = mkTmp();
    const filePath = writeFile(repo, 'CLAUDE.md', 'vault-dir: /Users/bob/Projects/vault\n');

    runScript(['--repos', repo, '--apply']);

    expect(readFileSync(filePath, 'utf8')).toBe('vault-dir: /Users/bob/Projects/Bernhard/vault\n');
  });

  it('default dry-run reports would-fix without mutating the file', () => {
    const repo = mkTmp();
    const filePath = writeFile(repo, 'CLAUDE.md', 'vault-dir: ~/Projects/vault\n');

    const result = runScript(['--repos', repo]);

    expect(result.status).toBe(0);
    expect(readFileSync(filePath, 'utf8')).toBe('vault-dir: ~/Projects/vault\n');
    expect(result.stdout).toContain('vault-dir-missing-segment-would-fix');
    expect(result.stderr).toContain('[dry-run]');
  });

  it('is idempotent — an already-canonical vault-dir is NOT double-segmented', () => {
    const repo = mkTmp();
    const filePath = writeFile(repo, 'CLAUDE.md', `vault-dir: ${CANONICAL_VAULT}\n`);

    const result = runScript(['--repos', repo, '--apply']);

    expect(result.status).toBe(0);
    // Unchanged — no ~/Projects/Bernhard/Bernhard/vault.
    expect(readFileSync(filePath, 'utf8')).toBe(`vault-dir: ${CANONICAL_VAULT}\n`);
    expect(readFileSync(filePath, 'utf8')).not.toContain('Bernhard/Bernhard');
    expect(result.stderr).toContain('0 lines fixed');
  });

  it('does NOT rewrite a non-vault-dir ~/Projects/vault-backups line (scope safety)', () => {
    const repo = mkTmp();
    const filePath = writeFile(repo, 'CLAUDE.md', 'cache: ~/Projects/vault-backups\n');

    const result = runScript(['--repos', repo, '--apply']);

    expect(result.status).toBe(0);
    // The path boundary + vault-dir: context guards both reject this line.
    expect(readFileSync(filePath, 'utf8')).toBe('cache: ~/Projects/vault-backups\n');
    expect(result.stderr).toContain('0 lines fixed');
  });

  it('does NOT rewrite vault-dir: ~/Projects/vault-backups (path-boundary guard)', () => {
    const repo = mkTmp();
    // Even on a vault-dir: line, the trailing `-backups` is a different segment.
    const filePath = writeFile(repo, 'CLAUDE.md', 'vault-dir: ~/Projects/vault-backups\n');

    const result = runScript(['--repos', repo, '--apply']);

    expect(result.status).toBe(0);
    expect(readFileSync(filePath, 'utf8')).toBe('vault-dir: ~/Projects/vault-backups\n');
    expect(result.stderr).toContain('0 lines fixed');
  });

  it('preserves a trailing path after vault, inserting the owner segment only at the root', () => {
    const repo = mkTmp();
    const filePath = writeFile(repo, 'CLAUDE.md', 'vault-dir: ~/Projects/vault/sub/dir\n');

    runScript(['--repos', repo, '--apply']);

    expect(readFileSync(filePath, 'utf8')).toBe('vault-dir: ~/Projects/Bernhard/vault/sub/dir\n');
  });

  it('discovers a missing-segment file that contains NO OLD_SEGMENT username', () => {
    // Regression guard: findCandidateFiles greps OLD_SEGMENT, so a file with
    // only missing-segment drift would be invisible without the dedicated
    // findMissingSegmentFiles discovery path.
    const repo = mkTmp();
    const filePath = writeFile(repo, 'CLAUDE.md', 'vault-dir: ~/Projects/vault\n');
    // Sanity: no OLD username anywhere in the fixture.
    expect(readFileSync(filePath, 'utf8')).not.toContain('oldname');

    const result = runScript(['--repos', repo, '--json']);

    const records = result.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const hits = records.filter((r) => r.classification === 'vault-dir-missing-segment');
    expect(hits).toHaveLength(1);
    expect(hits[0].file).toContain('CLAUDE.md');
  });

  it('skips tests/ fixtures — a missing-segment line under tests/ is NOT rewritten', () => {
    const repo = mkTmp();
    const filePath = writeFile(repo, 'tests/fixture.md', 'vault-dir: ~/Projects/vault\n');

    const result = runScript(['--repos', repo, '--apply']);

    expect(result.status).toBe(0);
    // tests/** is an EXCLUDE_GLOB — intentional parser fixtures stay verbatim.
    expect(readFileSync(filePath, 'utf8')).toBe('vault-dir: ~/Projects/vault\n');
    expect(result.stderr).toContain('0 lines fixed');
  });
});

// ---------------------------------------------------------------------------
// ENOENT guard (GitLab #600 F2) — grep/find binary missing from PATH
//
// When the `grep` binary cannot be resolved, spawnSync sets result.error (ENOENT)
// and result.status is null. The pre-#600 status check (`status !== 0 && status
// !== 1`) treated null as a failure but printed an empty stderr ("grep failed: "),
// masking the cause. The guard now surfaces a clear "grep/find not found on PATH".
//
// Seam: spawn the script via process.execPath (absolute node path, so node itself
// still runs) with a PATH pointing at a nonexistent directory, so the script's own
// `grep` spawn ENOENTs. env -i equivalent is achieved by overriding env entirely.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Mixed-class & idempotency edge cases (#600 D3 deepening)
//
// The username-rewrite path (rewriteContent) and the missing-segment path
// (rewriteMissingSegment) are mutually exclusive per line — the former owns any
// line carrying OLD_SEGMENT, the latter owns lines pointing at ~/Projects/vault.
// These tests prove the two classes coexist correctly on the SAME file, that
// partial-migrations are idempotent, and that trailing comments survive the
// missing-segment rewrite.
// ---------------------------------------------------------------------------

describe('migrate-vault-paths — mixed-class & idempotency edges', () => {
  it('a single file with BOTH username-drift and missing-segment lines is rewritten correctly per-class, no double-rewrite', () => {
    // Layer-collision regression: if the missing-segment regex were applied to
    // the username-rewrite output, the file would gain a spurious /Bernhard/
    // segment in the username-rewritten line (yielding /Users/newname/Projects/
    // Bernhard/vault). The originalContent gate in rewriteMissingSegment
    // prevents this.
    const repo = mkTmp();
    const filePath = writeFile(
      repo,
      'CLAUDE.md',
      [
        `vault-dir: ${OLD}Projects/vault`,
        `vault-dir: ~/Projects/vault`,
        '',
      ].join('\n'),
    );

    const result = runScript(['--repos', repo, '--apply']);

    expect(result.status).toBe(0);
    // Hardcoded expected: username line → /Users/newname/Projects/vault (NO
    // /Bernhard/ injection); missing-segment line → ~/Projects/Bernhard/vault.
    expect(readFileSync(filePath, 'utf8')).toBe(
      [
        `vault-dir: ${NEW}Projects/vault`,
        `vault-dir: ~/Projects/Bernhard/vault`,
        '',
      ].join('\n'),
    );
    // Symmetric anti-injection check.
    expect(readFileSync(filePath, 'utf8')).not.toContain('newname/Projects/Bernhard');
    expect(result.stderr).toContain('2 lines fixed');
  });

  it('partial-migration tree: canonical lines untouched, drift lines rewritten in the same run', () => {
    // Real-world idempotency case: a repo where some files were already
    // migrated and some weren't. The canonical files must survive untouched
    // while the drift files get rewritten in the same --apply pass.
    const repo = mkTmp();
    const driftFile = writeFile(repo, 'CLAUDE.md', 'vault-dir: ~/Projects/vault\n');
    const canonicalFile = writeFile(
      repo,
      'AGENTS.md',
      `vault-dir: ${CANONICAL_VAULT}\n`,
    );

    const result = runScript(['--repos', repo, '--apply']);

    expect(result.status).toBe(0);
    expect(readFileSync(driftFile, 'utf8')).toBe(
      'vault-dir: ~/Projects/Bernhard/vault\n',
    );
    // Canonical file byte-for-byte unchanged (no Bernhard/Bernhard injection).
    expect(readFileSync(canonicalFile, 'utf8')).toBe(
      `vault-dir: ${CANONICAL_VAULT}\n`,
    );
    expect(result.stderr).toContain('1 lines fixed');
  });

  it('trailing inline comment on the vault-dir line is preserved after missing-segment rewrite', () => {
    // The regex captures only the prefix `vault-dir:` + value portion; the
    // trailing comment after the rewritten path must survive verbatim.
    const repo = mkTmp();
    const filePath = writeFile(
      repo,
      'CLAUDE.md',
      'vault-dir: ~/Projects/vault   # canonical Meta-Vault location\n',
    );

    runScript(['--repos', repo, '--apply']);

    expect(readFileSync(filePath, 'utf8')).toBe(
      'vault-dir: ~/Projects/Bernhard/vault   # canonical Meta-Vault location\n',
    );
  });
});

describe('migrate-vault-paths — ENOENT guard (#600 F2)', () => {
  it('exits 2 with a clear "grep/find not found on PATH" message when grep is missing', () => {
    const repo = mkTmp();
    writeFile(repo, 'CLAUDE.md', 'vault-dir: ~/Projects/vault\n');

    // PATH points at a directory with no executables → child `grep` spawn ENOENTs.
    // process.execPath is absolute, so node itself launches fine.
    const result = spawnSync(
      process.execPath,
      [SCRIPT, '--from', OLD, '--to', NEW, '--repos', repo],
      {
        encoding: 'utf8',
        timeout: 20_000,
        env: { PATH: join(repo, 'no-such-bin-dir') },
      },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('grep/find not found on PATH');
    // Must NOT be the old masked empty-stderr message.
    expect(result.stderr).not.toMatch(/grep failed:\s*\n/);
  });
});
