/**
 * tests/hooks/enforce-scope.test.mjs
 *
 * Regression tests for hooks/enforce-scope.mjs — PreToolUse Edit/Write/MultiEdit scope gate.
 *
 * Strategy: spawn the hook as a subprocess, pipe JSON on stdin, assert exit code
 * and stdout/stderr for each behavioural case derived from the baseline spec
 * (v3-wave-hooks-baseline.md Part 4) plus security regressions.
 *
 * Issues: #137 (hook implementation), #143–#145 (test migration wave)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOOK = path.resolve(import.meta.dirname, '../../hooks/enforce-scope.mjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spawn the hook, pipe stdin JSON, collect stdout/stderr, resolve with exit code.
 */
async function runHook({ projectDir, stdin }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

/**
 * Create a temporary project directory with a .claude/wave-scope.json and a git repo.
 * Optionally creates a src/ subdirectory.
 */
async function mkProject(scope) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-scope-test-'));
  await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(path.join(dir, '.claude/wave-scope.json'), JSON.stringify(scope));
  // init git so project-root detection works the same as production
  const { $ } = await import('zx');
  $.verbose = false;
  $.quiet = true;
  await $`git -C ${dir} init -q`;
  return dir;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

const tmpDirs = [];

afterEach(async () => {
  for (const d of tmpDirs.splice(0)) {
    await fs.rm(d, { recursive: true, force: true });
  }
});

async function mkProjectTracked(scope) {
  const dir = await mkProject(scope);
  tmpDirs.push(dir);
  return dir;
}

/**
 * Create a temporary project directory whose .claude/wave-scope.json holds
 * RAW (non-JSON-parseable) content, rather than a serialized scope object.
 * Used to exercise the readJson() catch path (#794 GAP-5) — a corrupt scope
 * file must fail closed, not crash or silently allow.
 */
async function mkProjectRawScope(rawContent) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-scope-test-'));
  await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(path.join(dir, '.claude/wave-scope.json'), rawContent);
  // init git so project-root detection works the same as production
  const { $ } = await import('zx');
  $.verbose = false;
  $.quiet = true;
  await $`git -C ${dir} init -q`;
  return dir;
}

async function mkProjectRawScopeTracked(rawContent) {
  const dir = await mkProjectRawScope(rawContent);
  tmpDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Helper: build a preToolUse JSON payload for Edit/Write/MultiEdit
// ---------------------------------------------------------------------------

function editPayload(filePath, tool = 'Edit') {
  return JSON.stringify({
    tool_name: tool,
    tool_input: { file_path: filePath },
  });
}

// ---------------------------------------------------------------------------
// Tool filter — non-Edit/Write/MultiEdit tools are always allowed
// ---------------------------------------------------------------------------

describe('tool filter', { timeout: 15000 }, () => {
  it('exits 0 when tool_name is Bash (not Edit, Write, or MultiEdit)', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: ['src/'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'echo hi' },
      }),
    });
    expect(result.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Allow path — strict mode
// ---------------------------------------------------------------------------

describe('allow path — strict mode', { timeout: 15000 }, () => {
  it('exits 0 when file is inside an allowedPaths directory prefix', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: ['src/', 'lib/'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'src', 'app.ts')),
    });
    expect(result.code).toBe(0);
  });

  it('exits 0 when file matches a recursive glob pattern in a nested subdirectory', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: ['src/**/*.tsx'],
    });
    // The directory does NOT need to exist on disk — hook resolves parent dirs
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'src', 'components', 'Button.tsx')),
    });
    expect(result.code).toBe(0);
  });

  it('exits 0 when MultiEdit targets an allowed path', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: ['src/'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'src', 'app.ts'), 'MultiEdit'),
    });
    expect(result.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Deny path — strict mode
// ---------------------------------------------------------------------------

describe('deny path — strict mode', { timeout: 15000 }, () => {
  it('exits 2 when file is outside allowedPaths in strict mode', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: ['src/', 'lib/'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'tests', 'unit.test.ts')),
    });
    expect(result.code).toBe(2);
  });

  it('stdout JSON contains permissionDecision deny when path is blocked', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: ['src/', 'lib/'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'tests', 'unit.test.ts')),
    });
    expect(result.stdout).toContain('"permissionDecision":"deny"');
  });

  it('exits 2 when allowedPaths is empty and any file is edited', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: [],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'README.md')),
    });
    expect(result.code).toBe(2);
  });

  it('exits 2 when MultiEdit targets an out-of-scope path', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: ['src/'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'tests', 'unit.test.ts'), 'MultiEdit'),
    });
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('"permissionDecision":"deny"');
  });

  it('stdout JSON contains permissionDecision deny for empty allowedPaths', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: [],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'README.md')),
    });
    expect(result.stdout).toContain('"permissionDecision":"deny"');
  });
});

// ---------------------------------------------------------------------------
// Warn mode
// ---------------------------------------------------------------------------

describe('warn mode', { timeout: 15000 }, () => {
  it('exits 0 when enforcement is warn and file is out-of-scope', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'warn',
      allowedPaths: ['src/'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'tests', 'x.ts')),
    });
    expect(result.code).toBe(0);
  });

  it('writes a warning containing ⚠ to stderr in warn mode', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'warn',
      allowedPaths: ['src/'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'tests', 'x.ts')),
    });
    expect(result.stderr).toContain('⚠');
  });
});

// ---------------------------------------------------------------------------
// Enforcement off
// ---------------------------------------------------------------------------

describe('enforcement off', { timeout: 15000 }, () => {
  it('exits 0 regardless of file path when enforcement is off', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'off',
      allowedPaths: ['src/'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'etc', 'something.ts')),
    });
    expect(result.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Gate disabled — path-guard=false
// ---------------------------------------------------------------------------

describe('gate disabled — path-guard=false', { timeout: 15000 }, () => {
  it('exits 0 even for out-of-scope files when gates.path-guard is false', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: ['src/'],
      gates: { 'path-guard': false },
    });
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'forbidden', 'file.ts')),
    });
    expect(result.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// No scope file
// ---------------------------------------------------------------------------

describe('no scope file', { timeout: 15000 }, () => {
  it('exits 0 when .claude/wave-scope.json does not exist', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-scope-noscope-'));
    tmpDirs.push(dir);
    const { $ } = await import('zx');
    $.verbose = false;
    $.quiet = true;
    await $`git -C ${dir} init -q`;
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'src', 'app.ts')),
    });
    expect(result.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Path outside project root
// ---------------------------------------------------------------------------

describe('path outside project root', { timeout: 15000 }, () => {
  it('exits 2 in strict mode when file_path is outside the project root', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: ['src/'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload('/etc/passwd'),
    });
    expect(result.code).toBe(2);
  });

  it('stdout JSON contains permissionDecision deny for path outside project root', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: ['src/'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload('/etc/passwd'),
    });
    expect(result.stdout).toContain('"permissionDecision":"deny"');
  });
});

// ---------------------------------------------------------------------------
// Relative file_path resolved against projectRoot (SECURITY-REQ-06)
// ---------------------------------------------------------------------------

describe('relative file_path resolution — SECURITY-REQ-06', { timeout: 15000 }, () => {
  it('exits 0 for relative path "src/app.ts" resolved against CLAUDE_PROJECT_DIR when in-scope', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: ['src/'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload('src/app.ts'),
    });
    expect(result.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Symlink-escape regression (SECURITY-REQ-03 / F-02)
// ---------------------------------------------------------------------------

describe('symlink-escape regression — SECURITY-REQ-03 / F-02', { timeout: 15000 }, () => {
  it.skipIf(process.platform === 'win32')(
    'exits 2 in strict mode when file_path resolves via symlink to a path outside project root',
    async () => {
      const dir = await mkProjectTracked({
        enforcement: 'strict',
        allowedPaths: ['src/'],
      });
      // Create a symlink inside src/ that points to /etc/passwd
      const symlinkPath = path.join(dir, 'src', 'evil');
      try {
        await fs.symlink('/etc/passwd', symlinkPath);
      } catch {
        // If symlink creation fails (permissions/platform), skip gracefully
        return;
      }
      const result = await runHook({
        projectDir: dir,
        stdin: editPayload(symlinkPath),
      });
      // After realpath resolution /etc/passwd is outside project root → deny
      expect(result.code).toBe(2);
      expect(result.stdout).toContain('"permissionDecision":"deny"');
    },
  );
});

describe('coordinator carveout — #245', { timeout: 15000 }, () => {
  it('allows STATE.md write even when allowedPaths is empty', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: [],
    });
    const statePath = path.join(dir, '.claude', 'STATE.md');
    await fs.writeFile(statePath, '---\nstatus: active\n---\n');
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(statePath),
    });
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain('"permissionDecision":"deny"');
  });

  it('allows STATE.md write when allowedPaths does not include it (strict)', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: ['src/'],
    });
    const statePath = path.join(dir, '.claude', 'STATE.md');
    await fs.writeFile(statePath, '---\nstatus: active\n---\n');
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(statePath),
    });
    expect(result.code).toBe(0);
  });

  it('allows .pi/STATE.md write when allowedPaths does not include it (strict)', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: ['src/'],
    });
    const piDir = path.join(dir, '.pi');
    await fs.mkdir(piDir, { recursive: true });
    const statePath = path.join(piDir, 'STATE.md');
    await fs.writeFile(statePath, '---\nstatus: active\n---\n');
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(statePath),
    });
    expect(result.code).toBe(0);
  });

  it('allows wave-scope.json write (the manifest the hook itself reads)', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: ['src/'],
    });
    const scopePath = path.join(dir, '.claude', 'wave-scope.json');
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(scopePath, 'Write'),
    });
    expect(result.code).toBe(0);
  });

  it('does NOT carve out sibling files in .claude/ (narrow allowlist)', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: ['src/'],
    });
    const sibling = path.join(dir, '.claude', 'notes.md');
    await fs.writeFile(sibling, '# notes');
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(sibling),
    });
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('"permissionDecision":"deny"');
  });

  it('does NOT carve out a file that merely contains STATE.md in its name', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: ['src/'],
    });
    const fake = path.join(dir, '.claude', 'STATE.md.bak');
    await fs.writeFile(fake, 'backup');
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(fake),
    });
    expect(result.code).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Discovery-wave semantics regression lock — #256 NO-OP contract
// ---------------------------------------------------------------------------
//
// Issue #256 proposed a "lazy-skip" optimization: if allowedPaths is empty,
// skip the scope check entirely. This was REJECTED because `allowedPaths: []`
// is the intentional Discovery-wave "deny all writes" semantics. This test
// locks in the contract: any future PR that implements the skip MUST fail
// this test. Do not remove without reading the #256 decision.
// ---------------------------------------------------------------------------

describe('Discovery-wave deny-all semantics — #256 NO-OP regression lock', { timeout: 15000 }, () => {
  it('enforces Discovery-wave deny-all semantics when allowedPaths is empty (issue #256 NO-OP contract)', async () => {
    const dir = await mkProjectTracked({
      wave: 1,
      role: 'Discovery',
      enforcement: 'strict',
      allowedPaths: [],
      blockedCommands: [],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'README.md')),
    });
    // Deny semantics MUST be preserved: empty allowedPaths in strict mode
    // means "Discovery wave — read-only". Exit code non-zero + deny decision.
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('"permissionDecision":"deny"');
  });
});

// ---------------------------------------------------------------------------
// pathRegex edge cases — #558 Q2-L5
// ---------------------------------------------------------------------------
//
// Covers three under-tested behaviours of pathMatchesPattern via the hook's
// public surface (PreToolUse Edit gate):
//   1. Paths containing spaces — spaces are literal and not regex-special.
//   2. Substring-prefix guard — `src/` must NOT match `scripts/src_backup/foo.ts`.
//      The trailing slash is load-bearing; pathMatchesPattern uses
//      `relPath.startsWith(pattern)` for the directory-prefix shortcut, so
//      `scripts/src_backup/...` correctly fails the prefix check.
//   3. Multi-path coexistence — when allowedPaths mixes a prefix (`src/`) with
//      a glob (`src/**/*.tsx`), both must remain matchable; the hook iterates
//      via `Array.some()` so a later pattern does not shadow an earlier one.
// ---------------------------------------------------------------------------

describe('pathRegex edge cases — #558 Q2-L5', { timeout: 15000 }, () => {
  it('handles a path with spaces — allows the exact match, denies neighbouring filenames', async () => {
    // The space in `src/my file.ts` is literal (not regex-special, not a glob char).
    // Verify both directions: the spaced filename allowed; the unspaced sibling denied.
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: ['src/my file.ts'],
    });
    const allowed = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'src', 'my file.ts')),
    });
    expect(allowed.code).toBe(0);

    const denied = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'src', 'myfile.ts')),
    });
    expect(denied.code).toBe(2);
    expect(denied.stdout).toContain('"permissionDecision":"deny"');
  });

  it('does NOT match a sibling directory whose name shares the allowed prefix without a slash boundary', async () => {
    // `src/` (with trailing slash) is the directory-prefix shortcut. A path like
    // `scripts/src_backup/foo.ts` shares the substring `src` but is under a
    // different top-level directory — must be denied. Defends against accidental
    // prefix-match without `/` boundary check (PSA-006 — verified via
    // pathMatchesPattern's `relPath.startsWith(pattern)` rule in hardening.mjs).
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: ['src/'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'scripts', 'src_backup', 'foo.ts')),
    });
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('"permissionDecision":"deny"');
  });

  it('allows files matching either pattern when allowedPaths mixes a directory prefix and a recursive glob', async () => {
    // Overlap test: `src/foo.ts` matches `src/` (prefix shortcut),
    // `src/components/Button.tsx` matches BOTH `src/` AND `src/**/*.tsx`.
    // The hook iterates with Array.some() — verify the matcher does not
    // regress to AND-semantics or short-circuit on the first pattern.
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: ['src/', 'src/**/*.tsx'],
    });
    const prefixHit = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'src', 'foo.ts')),
    });
    expect(prefixHit.code).toBe(0);

    const globHit = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'src', 'components', 'Button.tsx')),
    });
    expect(globHit.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Malformed allowedPaths shape — fail-closed coercion — #558 Unnumbered 1
// ---------------------------------------------------------------------------
//
// Defends the line-92 guard in hooks/enforce-scope.mjs:
//   const allowedPaths = Array.isArray(scope.allowedPaths) ? scope.allowedPaths : [];
//
// Any non-array allowedPaths shape MUST be coerced to [] (fail-closed deny-all
// in strict mode). The hook MUST NOT crash on malformed input — it MUST exit
// with a structured deny decision (exit 2 + JSON `permissionDecision: deny`).
// The structured-deny contract is more important than the exact exit code
// because a crash would be exit 1 (unhandled rejection → SECURITY-REQ-01 catch),
// not exit 2 — distinguishing "fail-closed via Gate 7" from "blew up".
// ---------------------------------------------------------------------------

describe('malformed allowedPaths shape — fail-closed coercion (#558)', { timeout: 15000 }, () => {
  it('coerces allowedPaths: null to [] (deny all writes in strict mode)', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: null,
    });
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'src', 'app.ts')),
    });
    // Fail-closed: Array.isArray(null) === false → allowedPaths = []
    // → no pattern matches → strict mode → deny.
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('"permissionDecision":"deny"');
  });

  it('coerces allowedPaths: "src/" (string) to [] (deny all writes in strict mode)', async () => {
    // A string is iterable, but Array.isArray("src/") === false — guard catches it.
    // Without the guard, .some() on a string would error. With the guard, fail-closed.
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: 'src/',
    });
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'src', 'app.ts')),
    });
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('"permissionDecision":"deny"');
  });

  it('coerces allowedPaths: { "src/": true } (object) to [] (deny all writes in strict mode)', async () => {
    // Object literal — Array.isArray({...}) === false → fail-closed empty array.
    // Tests for the "user copy-pasted a keyed shape" failure mode.
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: { 'src/': true },
    });
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'src', 'app.ts')),
    });
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('"permissionDecision":"deny"');
  });
});

// ---------------------------------------------------------------------------
// Corrupt wave-scope.json — fail-closed on JSON.parse failure — #794 GAP-5
// ---------------------------------------------------------------------------
//
// Defends the readJson() catch path in hooks/enforce-scope.mjs (~L96-101):
//   try { scope = await readJson(scopePath); } catch { scope = {}; }
//
// A wave-scope.json that exists but fails to JSON.parse (truncated write,
// concurrent-writer race, disk corruption) MUST fail closed, exactly like the
// malformed-shape block above: scope = {} → enforcement defaults to 'strict'
// (scope.enforcement ?? 'strict'), allowedPaths defaults to [] (Array.isArray
// guard) → deny-all under strict enforcement, never a crash and never a
// silent allow. Same structured-deny contract as #558: exit 2 + JSON
// `permissionDecision: deny`, not an unhandled-rejection exit 1.
// ---------------------------------------------------------------------------

describe('corrupt wave-scope.json — fail-closed on JSON.parse failure (#794 GAP-5)', { timeout: 15000 }, () => {
  it('denies an in-repo Edit when wave-scope.json is invalid (truncated) JSON', async () => {
    const dir = await mkProjectRawScopeTracked('{ not valid');
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'src', 'app.ts')),
    });
    // readJson() throws SyntaxError → catch → scope = {} → enforcement
    // defaults 'strict', allowedPaths defaults [] → Gate 7 denies (deny-all).
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('"permissionDecision":"deny"');
  });
});

// ---------------------------------------------------------------------------
// Absolute out-of-repo allowlist — #792
// ---------------------------------------------------------------------------
//
// Root cause (W1-D6): Gate 6 (`isPathInside(resolvedPath, projectRoot)`) denied
// every out-of-repo path BEFORE Gate 7 ever consulted allowedPaths, and Gate 7
// only matches the ROOT-RELATIVE candidate — so an absolute entry could never
// match. A deliberate coordinator grant like "/Users/x/Projects/vault/**" was
// therefore structurally unreachable.
//
// Fix: a pre-Gate-6 `matchesAbsoluteAllowlist` step honours EXPLICIT absolute
// allowedPaths entries against the fully realpath-resolved candidate. The four
// security invariants below MUST all hold:
//   (a) RELATIVE entries (`**`, `../**`) can NEVER match an out-of-repo path.
//   (b) With no absolute entry the pre-gate is inert (byte-identical to before).
//   (c) ../.. traversal stays blocked (realpath + Gate 6).
//   (d) A symlink cannot smuggle out-of-repo writes — realpath makes the
//       canonical target authoritative.
//
// GOTCHA: on macOS /tmp (and /var) is a symlink to /private/... — every tmpdir
// path used here is passed through fs.realpath so the absolute allowedPaths
// pattern matches the realpath-resolved candidate the hook actually computes.
// ---------------------------------------------------------------------------

describe('absolute out-of-repo allowlist — #792', { timeout: 15000 }, () => {
  /**
   * Create a realpath-resolved tmpdir that stands in for an out-of-repo "vault".
   * Realpath is load-bearing (macOS /tmp → /private/tmp): the hook realpath-
   * resolves the candidate, so the absolute allowedPaths pattern must be built
   * from the canonical path or it can never match.
   */
  async function mkVault() {
    const v = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hook-scope-vault-')));
    tmpDirs.push(v);
    return v;
  }

  it('(i) allows an Edit to an EXPLICIT absolute out-of-repo allowedPaths entry', async () => {
    const vault = await mkVault();
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: ['src/', `${vault}/**`],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(vault, 'note.md')),
    });
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain('"permissionDecision":"deny"');
  });

  it('(ii) denies the SAME out-of-repo path when no absolute grant is present', async () => {
    const vault = await mkVault();
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: ['src/'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(vault, 'note.md')),
    });
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('"permissionDecision":"deny"');
    expect(result.stdout).toContain('path outside project root');
  });

  it('(iii) invariant (a): relative `**` and `../**` entries can NOT match out-of-repo', async () => {
    const vault = await mkVault();
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: ['**', '../**'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(vault, 'note.md')),
    });
    // Both entries are RELATIVE → filtered out by path.isAbsolute → helper false
    // → Gate 6 denies. A relative glob must never become a repo-escape hatch.
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('"permissionDecision":"deny"');
  });

  it('(iv) invariant (c): ../../etc/passwd traversal stays denied under allowedPaths [src/]', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: ['src/'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, '..', '..', 'etc', 'passwd')),
    });
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('"permissionDecision":"deny"');
  });

  it('scopes the grant to its OWN subtree — a sibling ungranted vault is still denied', async () => {
    // An absolute entry matches ONLY its literal subtree, never "any out-of-repo".
    const grantedVault = await mkVault();
    const otherVault = await mkVault();
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: ['src/', `${grantedVault}/**`],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(otherVault, 'note.md')),
    });
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('"permissionDecision":"deny"');
  });

  it('invariant (b): with NO absolute entry an in-repo out-of-scope path denies exactly as before', async () => {
    // Regression lock: the pre-gate must be inert when abs=[] — an in-repo path
    // outside allowedPaths still fails Gate 7, unchanged from pre-#792 behaviour.
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: ['src/'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'tests', 'unit.test.ts')),
    });
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('"permissionDecision":"deny"');
    expect(result.stdout).toContain('not in allowed paths');
  });

  it.skipIf(process.platform === 'win32')(
    '(d) a symlink to an UNGRANTED out-of-repo target is denied (realpath is authoritative)',
    async () => {
      // src/ is allowed, but a symlink under src/ points at an out-of-repo vault
      // that is NOT granted. realpath resolves the canonical target → out-of-repo
      // → deny. Proves an in-repo allowed prefix cannot be used to smuggle writes
      // to an out-of-repo location through a symlink.
      const vault = await mkVault();
      const dir = await mkProjectTracked({
        enforcement: 'strict',
        allowedPaths: ['src/'],
      });
      const linkPath = path.join(dir, 'src', 'vlink');
      try {
        await fs.symlink(vault, linkPath);
      } catch {
        // Symlink creation not permitted on this runner — skip gracefully.
        return;
      }
      const result = await runHook({
        projectDir: dir,
        stdin: editPayload(path.join(linkPath, 'note.md')),
      });
      expect(result.code).toBe(2);
      expect(result.stdout).toContain('"permissionDecision":"deny"');
    },
  );
});
