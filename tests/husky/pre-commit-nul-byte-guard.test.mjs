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
 *   6. allowlisted deliberate-NUL fixture gets blocked → the two intentional
 *      carriers become uncommittable on their next edit
 *   7. production code gets (re-)allowlisted → hooks/config-protection.mjs goes
 *      binary again and drops out of every grep-based audit
 *   8. the guard is narrowed back to NUL-only → a literal ESC (0x1b) commits
 *      again; and symmetrically, widened to ALL C0 → every tab-indented or
 *      CRLF file becomes uncommittable and the gate is bypassed as noise
 *      (widened 2026-09-18 to all C0 except TAB/LF/CR)
 *   9. the staged-path list is read through git's default `core.quotePath=true`
 *      → any path with a byte >= 0x80 is printed C-QUOTED (`"f\303\274nf.mjs"`),
 *      the extension filter drops it and the blob is never read: a corrupt file
 *      with a non-ASCII NAME commits clean (full bypass, reproduced 2026-09-18)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import { dirname, join, resolve } from 'node:path';
import { fixtureGit, makeTmpDir, removeTree } from '../_helpers/tmp-fixture.mjs';

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
      removeTree(tmpDirs.pop());
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
  const dir = makeTmpDir('so-nul-guard-');
  tmpDirs.push(dir);
  fixtureGit(['init', '-q', dir]);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
    fixtureGit(['-C', dir, 'add', rel]);
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

  it('does not block an allowlisted fixture whose NUL bytes are deliberate', () => {
    // bug_caught: the two tracked adversarial FIXTURES that carry INTENTIONAL
    // NUL bytes become uncommittable on their next edit, so the gate gets
    // bypassed with --no-verify or deleted outright.
    const fixture = `const garbage = '${NUL}${NUL}${NUL}payload';\n`;
    const res = runGuardWithStaged({
      'tests/lib/config/dispatcher-autonomy.test.mjs': fixture,
    });

    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
  });

  it('BLOCKS a raw NUL in hooks/config-protection.mjs (production is not allowlisted)', () => {
    // bug_caught: the allowlist entry for the config-protection security hook is
    // restored (or a raw NUL is pasted back into its masking sentinel), silently
    // re-making that file BINARY to ugrep / `grep -I` — which then skips it with
    // exit 1 and NO output, so the hook goes invisible to every grep-based audit.
    // That is not hypothetical: a live deny-path census missed its emitDeny call
    // exactly that way, which is why the entry was removed on 2026-07-29.
    // The escaped form (' '.repeat(...)) is byte-identical at runtime, so
    // there is no legitimate reason for this file to carry a raw NUL again.
    const sentinel = `      working = working.split(token).join('${NUL}'.repeat(token.length));\n`;
    const res = runGuardWithStaged({ 'hooks/config-protection.mjs': sentinel });

    expect(res.status).toBe(1);
    expect(res.stderr).toContain('hooks/config-protection.mjs');
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

  it('blocks a staged .mjs containing a literal ESC byte', () => {
    // bug_caught: the widened C0 range is reverted to NUL-only (or narrowed by
    // a "simplification"), so a literal 0x1b pasted into an ANSI-stripping code
    // path lands in a commit again. That is not hypothetical — it is exactly
    // what hooks/post-tool-failure-corrective-context.mjs carried until
    // 2026-09-18, where the escaped `\x1b` is byte-identical at runtime.
    // The byte is BUILT here, never written as a literal in this source file.
    const esc = Buffer.concat([
      Buffer.from("const strip = (s) => s.split('"),
      Buffer.from([0x1b]),
      Buffer.from("').join(' ');\n"),
    ]);
    const res = runGuardWithStaged({ 'ansi.mjs': esc });

    expect(res.status).toBe(1);
    expect(res.stderr).toContain('ansi.mjs');
  });

  it('passes a staged .mjs containing TAB, LF and CR', () => {
    // bug_caught: the range is written too wide (e.g. `\000-\037`), so every
    // tab-indented file and every CRLF file becomes uncommittable — the gate
    // turns into noise and gets bypassed with --no-verify or deleted. TAB/LF/CR
    // are the three C0 bytes that legitimately occur in text.
    const whitespace = Buffer.concat([
      Buffer.from('export const x = {'),
      Buffer.from([0x0d, 0x0a, 0x09]),
      Buffer.from('a: 1,'),
      Buffer.from([0x0d, 0x0a]),
      Buffer.from('};'),
      Buffer.from([0x0a]),
    ]);
    const res = runGuardWithStaged({ 'crlf.mjs': whitespace });

    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
  });

  it('blocks a corrupt staged file whose NAME contains a non-ASCII character', () => {
    // bug_caught: the staged-path list is enumerated under git's default
    // `core.quotePath=true`, which C-QUOTES every path carrying a byte >= 0x80
    // — `"f\303\274nf.mjs"`. An extension filter then sees a name ending in `"`,
    // drops the path, and the staged blob is never read: a FULL bypass of this
    // gate by renaming the file. Reproduced 2026-09-18 against the pre-fix
    // block: identical ESC-carrying bytes gave exit 0 under the non-ASCII name
    // and exit 1 under `plain.mjs`. Name and byte are both BUILT here, never
    // written as literals in this source file.
    const esc = Buffer.concat([
      Buffer.from("const s = '"),
      Buffer.from([0x1b]),
      Buffer.from("';\n"),
    ]);
    const res = runGuardWithStaged({ ['fünf.mjs']: esc });

    expect(res.status).toBe(1);
    expect(res.stderr).toContain('nul-byte-guard');
    expect(res.stderr).toContain('fünf.mjs');
  });
});
