/**
 * tests/hooks/enforce-commands.test.mjs
 *
 * Regression tests for hooks/enforce-commands.mjs — PreToolUse Bash command gate.
 *
 * Strategy: spawn the hook as a subprocess, pipe JSON on stdin, assert exit code
 * and stdout/stderr for each behavioural case derived from the baseline spec
 * (v3-wave-hooks-baseline.md Part 2) plus F-01 shell-operator bypass regressions.
 *
 * Issues: #138 (hook implementation), #143–#145 (test migration wave)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { extractBashWriteTargets } from '../../scripts/lib/scope-gate.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOOK = path.resolve(import.meta.dirname, '../../hooks/enforce-commands.mjs');

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
 * Spawn the hook with an ISOLATED child env (learning 0.85 — clear inherited
 * gate/profile env vars so an outer gate run cannot suppress the hook or leak
 * config into it). Forces SO_HOOK_PROFILE=full and strips SO_DISABLED_HOOKS +
 * the quality-gate wrapper vars. Used by the bash-write-guard (#800) tests whose
 * assertions hinge on the hook actually running.
 */
async function runHookIsolated({ projectDir, stdin }) {
  const env = { ...process.env };
  for (const k of [
    'SO_DISABLED_HOOKS',
    'TYPECHECK_CMD', 'TEST_CMD', 'LINT_CMD', 'FILES', 'SESSION_START_REF',
  ]) {
    delete env[k];
  }
  env.SO_HOOK_PROFILE = 'full';
  env.CLAUDE_PROJECT_DIR = projectDir;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      env,
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
 */
async function mkProject(scope) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-cmd-test-'));
  await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
  await fs.writeFile(path.join(dir, '.claude/wave-scope.json'), JSON.stringify(scope));
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

// ---------------------------------------------------------------------------
// Helper: build a preToolUse JSON payload for Bash
// ---------------------------------------------------------------------------

function bashPayload(command) {
  return JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command },
  });
}

// ---------------------------------------------------------------------------
// Tool filter — non-Bash tools are always allowed
// ---------------------------------------------------------------------------

describe('tool filter', { timeout: 15000 }, () => {
  it('exits 0 when tool_name is Edit (not Bash)', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: ['rm -rf'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: JSON.stringify({
        tool_name: 'Edit',
        tool_input: { file_path: 'src/app.ts' },
      }),
    });
    expect(result.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Explicit blockedCommands — strict mode
// ---------------------------------------------------------------------------

describe('explicit blockedCommands — strict mode', { timeout: 15000 }, () => {
  it('exits 0 when command does not match any blocked pattern', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: ['rm -rf'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('ls -la'),
    });
    expect(result.code).toBe(0);
  });

  it('exits 2 when command matches a blocked pattern', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: ['rm -rf'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('rm -rf /'),
    });
    expect(result.code).toBe(2);
  });

  it('stdout JSON contains permissionDecision deny when command is blocked', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: ['rm -rf'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('rm -rf /'),
    });
    expect(result.stdout).toContain('"permissionDecision":"deny"');
  });

  it('exits 0 for "rm-rf /home" — word boundary prevents false positive match', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: ['rm -rf'],
    });
    // "rm-rf" is a different token from "rm -rf", should NOT match
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('rm-rf /home'),
    });
    expect(result.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Warn mode
// ---------------------------------------------------------------------------

describe('warn mode', { timeout: 15000 }, () => {
  it('exits 0 when enforcement is warn even if command matches a blocked pattern', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'warn',
      blockedCommands: ['rm -rf'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('rm -rf /'),
    });
    expect(result.code).toBe(0);
  });

  it('writes a warning containing ⚠ to stderr in warn mode', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'warn',
      blockedCommands: ['rm -rf'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('rm -rf /'),
    });
    expect(result.stderr).toContain('⚠');
  });
});

// ---------------------------------------------------------------------------
// Enforcement off
// ---------------------------------------------------------------------------

describe('enforcement off', { timeout: 15000 }, () => {
  it('exits 0 regardless of blocked command when enforcement is off', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'off',
      blockedCommands: ['rm -rf'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('rm -rf /'),
    });
    expect(result.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Gate disabled — command-guard=false
// ---------------------------------------------------------------------------

describe('gate disabled — command-guard=false', { timeout: 15000 }, () => {
  it('exits 0 even for blocked command when gates.command-guard is false', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: ['rm -rf'],
      gates: { 'command-guard': false },
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('rm -rf /'),
    });
    expect(result.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Fallback blocklist (empty blockedCommands)
// ---------------------------------------------------------------------------

describe('fallback blocklist — empty blockedCommands', { timeout: 15000 }, () => {
  it('exits 2 for "git push --force" via fallback blocklist', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: [],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git push --force origin main'),
    });
    expect(result.code).toBe(2);
  });

  it('exits 2 for "git push -f" short form via fallback blocklist (#138)', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: [],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git push -f origin main'),
    });
    expect(result.code).toBe(2);
  });

  it('exits 2 for "git reset --hard" via fallback blocklist', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: [],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git reset --hard HEAD~1'),
    });
    expect(result.code).toBe(2);
  });

  it('exits 2 for "DROP TABLE" (uppercase) via fallback blocklist', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: [],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('psql -c "DROP TABLE users"'),
    });
    expect(result.code).toBe(2);
  });

  it('exits 2 for "drop table" (lowercase) via fallback blocklist (#138)', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: [],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('psql -c "drop table users"'),
    });
    expect(result.code).toBe(2);
  });

  it('exits 2 for "git checkout -- ." via fallback blocklist', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: [],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git checkout -- .'),
    });
    expect(result.code).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// F-01 regression — shell-operator bypass attempts
//
// Attackers may try to hide a blocked command inside a shell operator sequence.
// The hook must detect the blocked pattern anywhere in the full command string,
// not only at the top level.
// ---------------------------------------------------------------------------

describe('F-01 regression — shell-operator bypass', { timeout: 15000 }, () => {
  it('exits 2 for semicolon-chained command: "ls;rm -rf /"', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: ['rm -rf'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('ls;rm -rf /'),
    });
    expect(result.code).toBe(2);
  });

  it('exits 2 for && chained command: "ls&&rm -rf /"', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: ['rm -rf'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('ls&&rm -rf /'),
    });
    expect(result.code).toBe(2);
  });

  it('exits 2 for || chained command: "ls||rm -rf /"', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: ['rm -rf'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('ls||rm -rf /'),
    });
    expect(result.code).toBe(2);
  });

  it('exits 2 for subshell: "(rm -rf /)"', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: ['rm -rf'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('(rm -rf /)'),
    });
    expect(result.code).toBe(2);
  });

  it('exits 2 for backtick substitution: "`rm -rf /`"', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: ['rm -rf'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('`rm -rf /`'),
    });
    expect(result.code).toBe(2);
  });

  it('exits 2 for dollar-paren substitution: "$(rm -rf /)"', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: ['rm -rf'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('$(rm -rf /)'),
    });
    expect(result.code).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// bash-write-guard (#800) — extractBashWriteTargets unit contract
//
// Pure-function tests for the shell write-target extractor. Conservative,
// under-match posture: positives cover the 5 write channels; negatives cover
// the documented skip traps (quoted operators, variables, temp sinks, procsub).
// ---------------------------------------------------------------------------

describe('extractBashWriteTargets — positive channels', () => {
  it('extracts a plain `>` redirect target', () => {
    expect(extractBashWriteTargets('echo x > foo.txt')).toEqual(['foo.txt']);
  });

  it('extracts a heredoc redirect target (`cat > p <<EOF`)', () => {
    expect(extractBashWriteTargets('cat > a/b.mjs <<EOF')).toEqual(['a/b.mjs']);
  });

  it('extracts a `tee -a` file argument', () => {
    expect(extractBashWriteTargets('tee -a log.txt')).toEqual(['log.txt']);
  });

  it('extracts every non-flag file arg of a piped `tee` command-head', () => {
    expect(extractBashWriteTargets('build | tee a.txt b.txt')).toEqual(['a.txt', 'b.txt']);
  });

  it('extracts the last non-flag arg of a BSD `sed -i \'\'` command', () => {
    expect(extractBashWriteTargets("sed -i '' file.mjs")).toEqual(['file.mjs']);
  });

  it('extracts the file (not the script) from a GNU `sed -i` command', () => {
    expect(extractBashWriteTargets("sed -i 's/a/b/' target.mjs")).toEqual(['target.mjs']);
  });

  it('extracts a `dd of=` target', () => {
    expect(extractBashWriteTargets('dd if=/dev/zero of=out.bin')).toEqual(['out.bin']);
  });

  it('de-duplicates a target written twice (`>` then `>>`)', () => {
    expect(extractBashWriteTargets('echo a > x.txt; echo b >> x.txt')).toEqual(['x.txt']);
  });

  it('extracts an fd-prefixed redirect (`2> err.log`)', () => {
    expect(extractBashWriteTargets('run 2> err.log')).toEqual(['err.log']);
  });
});

describe('extractBashWriteTargets — documented skips (negatives)', () => {
  it('does NOT treat a quoted `>` as a redirect operator', () => {
    expect(extractBashWriteTargets("echo '>' quoted")).toEqual([]);
  });

  it('skips a variable/expansion target (`> $VAR`)', () => {
    expect(extractBashWriteTargets('echo x > $VAR')).toEqual([]);
  });

  it('skips a `${TMPDIR}` expansion target', () => {
    expect(extractBashWriteTargets('echo x > ${TMPDIR}/scratch')).toEqual([]);
  });

  it('skips a /tmp/ temp-sink target', () => {
    expect(extractBashWriteTargets('echo x > /tmp/x')).toEqual([]);
  });

  it('skips a /dev/ device target', () => {
    expect(extractBashWriteTargets('echo x > /dev/null')).toEqual([]);
  });

  it('skips process substitution `>(proc)`', () => {
    expect(extractBashWriteTargets('diff a b > >(cat)')).toEqual([]);
  });

  it('does NOT treat fd duplication `2>&1` as a file target', () => {
    expect(extractBashWriteTargets('run 2>&1')).toEqual([]);
  });

  it('returns [] for a non-string / empty command', () => {
    expect(extractBashWriteTargets('')).toEqual([]);
    expect(extractBashWriteTargets(null)).toEqual([]);
    expect(extractBashWriteTargets(undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// bash-write-guard (#800) — gate wiring in enforce-commands.mjs
//
// The gate INVERTS the default-enabled convention: it runs ONLY when
// gates['bash-write-guard'] === true. It is warn-only (stderr line, exit 0);
// it never denies. allowedPaths coverage decides whether a target warns.
// ---------------------------------------------------------------------------

const BWG_MARKER = 'bash-write-guard:';

describe('bash-write-guard — gate wiring', { timeout: 15000 }, () => {
  it('default OFF: no gates entry → no WARN even for an out-of-scope redirect', async () => {
    // FAKE-REGRESSION (testing.md): this fixture with `gates:{'bash-write-guard':true}`
    // added — and the SAME out-of-scope command — DOES emit the WARN; that ON case is
    // the immediately-following test. Verified live once during authoring:
    //   printf '{"tool_name":"Bash","tool_input":{"command":"echo x > secrets.txt"}}' \
    //     | (gates:{'bash-write-guard':true}) → stderr:
    //       "bash-write-guard: secrets.txt outside wave scope (warn-only, #800)", exit 0.
    // Flipping the gate back to absent (this test) turns the WARN off → proves the
    // guard bites only on explicit opt-in, not by accident.
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: [],
      allowedPaths: ['hooks/**'],
    });
    const result = await runHookIsolated({
      projectDir: dir,
      stdin: bashPayload('echo x > secrets.txt'),
    });
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain(BWG_MARKER);
  });

  it('ON + out-of-scope target → WARN on stderr, still exit 0 (never denies)', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: [],
      allowedPaths: ['hooks/**'],
      gates: { 'bash-write-guard': true },
    });
    const result = await runHookIsolated({
      projectDir: dir,
      stdin: bashPayload('echo x > secrets.txt'),
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain(
      'bash-write-guard: secrets.txt outside wave scope (warn-only, #800)',
    );
  });

  it('ON + in-scope target → no WARN', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: [],
      allowedPaths: ['hooks/**'],
      gates: { 'bash-write-guard': true },
    });
    const result = await runHookIsolated({
      projectDir: dir,
      stdin: bashPayload('echo x > hooks/foo.mjs'),
    });
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain(BWG_MARKER);
  });

  it('ON but enforcement:off → guard is inert (no WARN)', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'off',
      blockedCommands: [],
      allowedPaths: ['hooks/**'],
      gates: { 'bash-write-guard': true },
    });
    const result = await runHookIsolated({
      projectDir: dir,
      stdin: bashPayload('echo x > secrets.txt'),
    });
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain(BWG_MARKER);
  });
});
