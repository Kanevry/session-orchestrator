/**
 * tests/husky/pre-commit-nul-byte-guard.test.mjs
 *
 * Tests for the .husky/pre-commit nul-byte-guard stage (K7).
 *
 * Bug class this locks in (TV-001): a NUL byte written into a source file by a
 * bad tool/write silently corrupts it — vitest and eslint BOTH pass on the
 * corrupted file, so the corruption lands in a commit and only shows up later
 * as a "Bin" marker in a git diff. The hook stage is the only mechanical
 * catch, so these tests execute the REAL shell block extracted from the hook
 * (between the `nul-byte-guard:begin/end` markers) against tmp git repos —
 * no copy of the command lives here that could drift from the hook.
 *
 * Named bugs covered:
 *   1. corrupted staged .mjs is NOT detected  → the gate is a no-op (K7 recurs)
 *   2. clean staged files are rejected        → gate gets disabled as noise
 *   3. a real binary (.png with NUL) blocks   → legitimate binaries unusable
 *   4. block rewritten with GNU-only syntax   → silent no-op on macOS (bug 1
 *      would stay green on a Linux CI runner, so it needs its own assertion)
 *   5. gate reads the WORKTREE instead of the staged blob → `git add <corrupt>`
 *      + worktree repair smuggles corruption into the commit the gate exists
 *      to stop (and, symmetrically, an unrelated dirty worktree false-blocks)
 *   6. allowlisted deliberate-NUL file gets blocked → the three intentional
 *      carriers become uncommittable on their next edit
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const HOOK_PATH = join(REPO_ROOT, '.husky', 'pre-commit');

const BEGIN = '# --- nul-byte-guard:begin';
const END = '# --- nul-byte-guard:end ---';

/** Extract the real guard block from the hook (no duplicated command here). */
function extractGuardBlock() {
  const hook = readFileSync(HOOK_PATH, 'utf8');
  const start = hook.indexOf(BEGIN);
  const end = hook.indexOf(END);
  if (start === -1 || end === -1) {
    throw new Error('nul-byte-guard markers missing from .husky/pre-commit');
  }
  return hook.slice(start, end + END.length);
}

const tmpDirs = [];
afterEach(() => {
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop(), { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

/**
 * Create a tmp git repo, stage the given files, run the extracted guard block.
 * @param {Record<string, Buffer|string>} files relative path → STAGED content
 * @param {Record<string, Buffer|string>} [worktreeAfter] relative path → content
 *   written over the worktree copy AFTER staging (index keeps the original).
 *   Used to prove the gate reads the index, not the working copy.
 */
function runGuardWithStaged(files, worktreeAfter = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'so-nul-guard-'));
  tmpDirs.push(dir);
  execFileSync('git', ['init', '-q', dir]);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
    execFileSync('git', ['-C', dir, 'add', rel]);
  }
  for (const [rel, content] of Object.entries(worktreeAfter)) {
    writeFileSync(join(dir, rel), content);
  }
  writeFileSync(join(dir, 'guard.sh'), extractGuardBlock());
  return spawnSync('sh', ['guard.sh'], { cwd: dir, encoding: 'utf8', timeout: 20_000 });
}

const NUL = String.fromCharCode(0);

/** A .mjs buffer with one NUL byte embedded mid-line. */
function corruptMjs() {
  return Buffer.concat([
    Buffer.from('export const answer = '),
    Buffer.from([0x00]),
    Buffer.from('42;\n'),
  ]);
}

describe('.husky/pre-commit — nul-byte-guard (K7)', () => {
  it('blocks a staged .mjs containing a NUL byte', () => {
    const res = runGuardWithStaged({ 'corrupt.mjs': corruptMjs() });

    expect(res.status).toBe(1);
    expect(res.stderr).toContain('nul-byte-guard');
    expect(res.stderr).toContain('corrupt.mjs');
  });

  it('blocks when the STAGED blob is corrupt but the worktree copy is clean', () => {
    // bug_caught: the gate reads the worktree instead of the index. Staging the
    // corruption and then repairing the working copy (a plausible "I fixed it"
    // sequence, and exactly what an editor auto-format can do) would let the
    // corrupt blob land in the commit with the gate reporting green.
    const res = runGuardWithStaged(
      { 'corrupt.mjs': corruptMjs() },
      { 'corrupt.mjs': 'export const answer = 42;\n' },
    );

    expect(res.status).toBe(1);
    expect(res.stderr).toContain('corrupt.mjs');
  });

  it('passes when the STAGED blob is clean but the worktree copy is corrupt', () => {
    // The reverse half of the same bug: reading the worktree makes unrelated
    // in-progress corruption block a commit that stages nothing corrupt at all.
    const res = runGuardWithStaged(
      { 'clean.mjs': 'export const answer = 42;\n' },
      { 'clean.mjs': corruptMjs() },
    );

    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
  });

  it('does not block an allowlisted file whose NUL bytes are deliberate', () => {
    // bug_caught: the three tracked files that carry INTENTIONAL NUL bytes
    // (masking sentinel + two adversarial fixtures) become uncommittable on
    // their next edit, so the gate gets bypassed with --no-verify or deleted.
    const sentinel = `      working = working.split(token).join('${NUL}'.repeat(token.length));\n`;
    const res = runGuardWithStaged({ 'hooks/config-protection.mjs': sentinel });

    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
  });

  it('passes clean staged text files', () => {
    const res = runGuardWithStaged({
      'clean.mjs': 'export const answer = 42;\n',
      'notes.md': '# Heading\n\nprose\n',
      'data.json': '{"a":1}\n',
    });

    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
  });

  it('ignores NUL bytes in real binary files (.png is not a text extension)', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    const res = runGuardWithStaged({ 'logo.png': png });

    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
  });

  it('uses POSIX NUL detection, not GNU-only syntax', () => {
    // The behavioural tests above run on the developer's macOS box where
    // `grep -P` / `$'\x00'` degrade to a silent no-op — but they would stay
    // GREEN on the Linux CI runner, where GNU grep accepts -P. This assertion
    // is what makes the portability regression visible on BOTH platforms.
    // Comment lines are stripped first: the block's own comments NAME the
    // forbidden GNU-only forms as a warning, so asserting over raw text would
    // fail on the documentation rather than on the executed command.
    const code = extractGuardBlock()
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n');

    expect(code).toContain("tr -d '\\000'");
    expect(code).not.toMatch(/grep\s+-\w*P/);
    expect(code).not.toContain("$'\\x00'");
  });
});
