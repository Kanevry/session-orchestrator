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

import { expectDeny, expectAllow, expectWarn, expectGuardInactive } from '../_helpers/hook-decision.mjs';
import { brokenModuleBoot } from '../_helpers/broken-module-boot.mjs';

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
async function runHook({ projectDir, stdin, execArgv = [], env = {} }) {
  return new Promise((resolve) => {
    // `env` overlays the inherited environment; a value of `null` DELETES the
    // variable — the only way to reproduce a harness that exports no session id
    // (#1153 P1), since the live operator environment exports
    // `CLAUDE_CODE_SESSION_ID` and `spawn` inherits it by default.
    const childEnv = { ...process.env, CLAUDE_PROJECT_DIR: projectDir, ...env };
    for (const [key, value] of Object.entries(env)) {
      if (value === null) delete childEnv[key];
    }
    const child = spawn(process.execPath, [...execArgv, HOOK], {
      env: childEnv,
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
// Decision assertions (post-#906 PreToolUse contract)
//
// emitDeny() now emits ONE stdout JSON line and exits **0** — the mixed
// stdout-JSON + `exit 2` form is what the docs forbid ("Exit 2 … Claude Code
// ignores stdout and any JSON in it"; "choose one approach per hook, not both").
//
// Two consequences these helpers exist to handle:
//   1. The exit code no longer discriminates allow from deny — BOTH are 0. An
//      allow test that asserts only `code === 0` would stay green if the hook
//      started denying, so `expectAllow` also asserts stdout is silent.
//   2. A malformed envelope is read by the harness as "nothing to say" ⇒ the
//      tool call is ALLOWED. The envelope SHAPE is the block, so it is asserted
//      on the PARSED object, never as a raw-stdout substring: a substring like
//      '"permissionDecision":"deny"' survives any re-nesting verbatim and is
//      therefore blind to exactly the protocol change it looks like it covers.
// ---------------------------------------------------------------------------

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
    expectAllow(result);
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
    expectAllow(result);
  });

  // Merged from two former tests (one asserting `exit 2`, one asserting the raw
  // substring '"permissionDecision":"deny"') — same fixture, same payload. Both
  // assertions are now subsumed by expectDeny's parsed-envelope contract, which
  // is strictly stronger than either half was (TV-004 duplication removal).
  it('denies (exit 0 + deny envelope) when command matches a blocked pattern', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: ['rm -rf'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('rm -rf /'),
    });
    expectDeny(result, "Blocked command: 'rm -rf' found in command");
  });

  it('allows "rm-rf /home" — word boundary prevents false positive match', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: ['rm -rf'],
    });
    // "rm-rf" is a different token from "rm -rf", should NOT match
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('rm-rf /home'),
    });
    expectAllow(result);
  });
});

// ---------------------------------------------------------------------------
// Warn mode
// ---------------------------------------------------------------------------

describe('warn mode', { timeout: 15000 }, () => {
  // REPLACES `expectAllow(result)` here.
  //
  // What it pinned: warn ≠ deny — via expectAllow's empty-stdout half.
  // Why the new state is right: emitWarn was stderr-only, and stderr is not
  // surfaced under exit 0, so an `enforcement: warn` block notice reached nobody
  // (#916). The notice now rides the visible top-level `systemMessage`, so this
  // path is no longer a SILENT allow and expectAllow (correctly) no longer fits.
  // What is pinned instead: an allow-WITH-NOTICE envelope — one line, only
  // `systemMessage`, no permissionDecision. The warn/strict discriminator the
  // old comment protected survives intact, asserted on the parsed object.
  it('allows (no deny envelope) when enforcement is warn even if command matches', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'warn',
      blockedCommands: ['rm -rf'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('rm -rf /'),
    });
    // Allow-with-notice envelope: exit 0, one stdout line, ONLY `systemMessage`.
    // The warn/strict discriminator (absent permissionDecision) is asserted
    // inside expectWarn — the single home for the warn contract.
    expectWarn(result, "Blocked command: 'rm -rf' found in command");
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
  it('allows regardless of blocked command when enforcement is off', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'off',
      blockedCommands: ['rm -rf'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('rm -rf /'),
    });
    expectAllow(result);
  });
});

// ---------------------------------------------------------------------------
// Gate disabled — command-guard=false
// ---------------------------------------------------------------------------

describe('gate disabled — command-guard=false', { timeout: 15000 }, () => {
  it('allows even a blocked command when gates.command-guard is false', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: ['rm -rf'],
      gates: { 'command-guard': false },
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('rm -rf /'),
    });
    expectAllow(result);
  });
});

// ---------------------------------------------------------------------------
// Fallback blocklist (empty blockedCommands)
// ---------------------------------------------------------------------------

describe('fallback blocklist — empty blockedCommands', { timeout: 15000 }, () => {
  it('denies "git push --force" via fallback blocklist', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: [],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git push --force origin main'),
    });
    expectDeny(result, "Blocked by fallback safety list: 'git push --force'");
  });

  it('denies "git push -f" short form via fallback blocklist (#138)', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: [],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git push -f origin main'),
    });
    expectDeny(result, "Blocked by fallback safety list: 'git push -f'");
  });

  it('denies "git reset --hard" via fallback blocklist', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: [],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git reset --hard HEAD~1'),
    });
    expectDeny(result, "Blocked by fallback safety list: 'git reset --hard'");
  });

  it('denies "DROP TABLE" (uppercase) via fallback blocklist', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: [],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('psql -c "DROP TABLE users"'),
    });
    expectDeny(result, 'Blocked by fallback safety list:');
  });

  it('denies "drop table" (lowercase) via fallback blocklist (#138)', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: [],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('psql -c "drop table users"'),
    });
    expectDeny(result, 'Blocked by fallback safety list:');
  });

  it('denies "git checkout -- ." via fallback blocklist', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: [],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git checkout -- .'),
    });
    expectDeny(result, "Blocked by fallback safety list: 'git checkout -- .'");
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
  it('denies semicolon-chained command: "ls;rm -rf /"', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: ['rm -rf'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('ls;rm -rf /'),
    });
    expectDeny(result, "Blocked command: 'rm -rf' found in command");
  });

  it('denies && chained command: "ls&&rm -rf /"', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: ['rm -rf'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('ls&&rm -rf /'),
    });
    expectDeny(result, "Blocked command: 'rm -rf' found in command");
  });

  it('denies || chained command: "ls||rm -rf /"', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: ['rm -rf'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('ls||rm -rf /'),
    });
    expectDeny(result, "Blocked command: 'rm -rf' found in command");
  });

  it('denies subshell: "(rm -rf /)"', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: ['rm -rf'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('(rm -rf /)'),
    });
    expectDeny(result, "Blocked command: 'rm -rf' found in command");
  });

  it('denies backtick substitution: "`rm -rf /`"', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: ['rm -rf'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('`rm -rf /`'),
    });
    expectDeny(result, "Blocked command: 'rm -rf' found in command");
  });

  it('denies dollar-paren substitution: "$(rm -rf /)"', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: ['rm -rf'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('$(rm -rf /)'),
    });
    expectDeny(result, "Blocked command: 'rm -rf' found in command");
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
    expectAllow(result);
    expect(result.stderr).not.toContain(BWG_MARKER);
  });

  it('ON + out-of-scope target → WARN on stderr, still allows (never denies)', async () => {
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
    // "never denies" is now carried by expectAllow's silent-stdout half — the
    // exit code alone cannot express it once deny also exits 0.
    expectAllow(result);
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
    expectAllow(result);
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
    expectAllow(result);
    expect(result.stderr).not.toContain(BWG_MARKER);
  });
});

// ---------------------------------------------------------------------------
// #993 — module-load failure must be VISIBLE, not a silent fail-open
//
// Baseline defect (measured before the late-binding fix): a SyntaxError in a
// scripts/lib module this hook STATICALLY imported failed at ESM LINK time,
// before main() ran. The main().catch() handler was structurally unreachable —
// node exited 1 with 0 bytes on stdout. Under the exit-0 PreToolUse protocol
// (#906) that is INDISTINGUISHABLE from an allow on the only decision-bearing
// channel: the command guard was silently disarmed.
//
// This hook late-binds `command-blocker.mjs` (and `hardening.mjs`, which
// transitively imports command-blocker via scope-gate.mjs). Breaking command-blocker's working-tree copy
// therefore fails `hardening` FIRST — it is armed before the headFallback
// `blocker` entry and has no fallback of its own — so the failure degrades
// straight to GUARD INACTIVE, git-independently. The banner rides stderr; the
// decision channel stays empty (fail-open, so a broken module cannot brick the
// session).
//
// NOT expectAllow: that would go green after the fix even if the guard were OFF,
// because an allow is ALSO exit 0 + empty stdout. Only the stderr GUARD INACTIVE
// banner distinguishes a VISIBLE fail-open from the silent one this fixes.
// ---------------------------------------------------------------------------

describe('#993 — load-failure visibility (GUARD INACTIVE)', { timeout: 30000 }, () => {
  it('banners "enforce-commands: GUARD INACTIVE" on a broken command-blocker import — never a silent exit 1 / 0-byte disarm', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: ['rm -rf'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('rm -rf /'),
      execArgv: brokenModuleBoot({ moduleBasename: 'command-blocker.mjs' }),
    });
    // Fail-open + GUARD INACTIVE marker (hook-agnostic half) AND the hook-specific
    // prefix (#993 non-hard-wiring proof — a mis-wired hookName would banner the
    // wrong hook's name here and this assertion would catch it).
    expectGuardInactive(result, { hookName: 'enforce-commands' });
  });
});

// ---------------------------------------------------------------------------
// #1001 — DEGRADED visibility on the DECISION channel
//
// `armGuard` returns `{ modules, degraded }`; `degraded` names every module it
// had to recover from HEAD because the working-tree copy failed. This hook
// discarded that value: it destructured `{ modules }` only. The DEGRADED banner
// therefore reached stderr alone — and under the exit-0 PreToolUse protocol
// (#906) stderr is not surfaced, so a session running against COMMITTED source
// looked byte-identical to a healthy one on the only channel the operator sees.
//
// Reaching DEGRADED here needs the SHAPE-CHECK door, not the parse-error door:
// this hook's `hardening` spec has no fallback and imports command-blocker
// transitively (via scope-gate.mjs), so a SyntaxError kills bootstrap FIRST and
// yields GUARD INACTIVE (the suite above), never DEGRADED. A working copy that
// PARSES but omits one `requires` export fails only `assertShape` — the HEAD
// fallback then runs and the guard arms, degraded.
// ---------------------------------------------------------------------------

/**
 * Working-tree command-blocker that PARSES but omits `suggestForCommandBlock` —
 * one of the two names on the `blocker` spec's `requires` array, so it fails
 * `assertShape` and nothing else.
 *
 * The other three exports are not decoration: `scope-gate.mjs` statically imports
 * `tokenizeCommand` / `splitChainSegments` / `resolveSegmentVerb` from this
 * module, and `hardening.mjs` pulls scope-gate in. Omitting them makes the LINK
 * of `hardening` fail — which has no fallback and arms first — so the run lands
 * on GUARD INACTIVE and never reaches the degraded path under test.
 */
const EXPORT_SHY_WORKING = [
  'export function commandMatchesBlocked() { return false; }',
  'export function tokenizeCommand() { return []; }',
  'export function splitChainSegments() { return []; }',
  'export function resolveSegmentVerb() { return { verb: null, index: -1, payloads: [], wrapperArgs: [] }; }',
].join('\n');

/** Valid HEAD replacement carrying the COMPLETE `requires` set. */
const VALID_HEAD = [
  'export function commandMatchesBlocked(command, pattern) { return command.includes(pattern); }',
  'export function suggestForCommandBlock() { return "use the sanctioned path"; }',
].join('\n');

const DEGRADED_BOOT = {
  moduleBasename: 'command-blocker.mjs',
  workingSource: EXPORT_SHY_WORKING,
  headSource: VALID_HEAD,
};

describe('#1001 — DEGRADED surfaces on stdout, not stderr alone', { timeout: 30000 }, () => {
  it('warns "DEGRADED" on the visible channel when the guard armed from HEAD (non-matching command)', async () => {
    // Bug this catches: `const { modules } = await armGuard(...)` dropped
    // `degraded` on the floor, so this exact spawn produced an EMPTY stdout —
    // an ordinary silent allow, indistinguishable from a healthy guard, while
    // the hook was in fact evaluating COMMITTED source.
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: ['rm -rf'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('ls -la'),
      execArgv: brokenModuleBoot(DEGRADED_BOOT),
    });
    const warn = expectWarn(result, 'DEGRADED');
    // The notice must NAME the recovered module and the hook, else the operator
    // cannot tell which uncommitted edit is not in effect.
    expect(warn.systemMessage).toContain('enforce-commands');
    expect(warn.systemMessage).toContain('blocker');
  });

  it('still DENIES a blocked command while degraded — the notice never preempts the deny', async () => {
    // Bug this catches (the emitWarn trap, repo learning conf 0.8): emitWarn is
    // `@returns never`. An inline warn at the degraded site — before the G6
    // blocked-pattern loop — exits 0 with an allow-with-notice envelope, so every
    // deny in a degraded session silently becomes an ALLOW. Aggregating and
    // flushing only on the allow path is what keeps this a deny.
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: ['rm -rf'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('rm -rf /'),
      execArgv: brokenModuleBoot(DEGRADED_BOOT),
    });
    expectDeny(result, 'rm -rf');
    // expectDeny already pins "exactly one non-blank stdout line", which is the
    // load-bearing half here: a second envelope (notice + deny) would leave the
    // harness parsing the FIRST line only, and a leading systemMessage line reads
    // as no-decision, i.e. fail-OPEN. Asserted explicitly so the intent survives
    // any future loosening of the shared helper.
    expect(result.stdout.split('\n').filter((l) => l.trim().length > 0)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Foreign-session manifest (#1153 P1, sibling of enforce-scope's #1123 Gate 3b)
// ---------------------------------------------------------------------------
//
// `wave-scope.json` lives in the WORKING COPY, not in the session, so two live
// sessions in one checkout read the SAME `blockedCommands` list. Before Gate 3b
// this hook denied a peer session's Bash calls with a reason naming a wave plan
// that session does not own — the #1082 lockout, on the command axis.
//
// The bug each test below catches, named per TV-001:
//   1. a peer's manifest still blocking THIS session's command (the lockout)
//   2. a stand-down that leaves no trace (the #1020 signal-free-ALLOW class:
//      "guard correctly stood down" is indistinguishable from "guard broken")
//   3. over-reach — a manifest naming US no longer being enforced

/** A manifest that blocks everything interesting, bound to a PEER session. */
const FOREIGN_CMD_SCOPE = {
  wave: 4,
  role: 'Discovery',
  enforcement: 'strict',
  session_id: 'PEER-UUID-1111',
  semantic_session_id: 'main-2026-01-01-session-9',
  blockedCommands: ['npm test'],
};

/** Parse every JSONL record the hook emitted into the project's events log. */
async function readCmdEvents(dir) {
  try {
    const raw = await fs.readFile(
      path.join(dir, '.orchestrator', 'metrics', 'events.jsonl'),
      'utf8',
    );
    return raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

describe('foreign-session manifest (#1153 P1)', { timeout: 15000 }, () => {
  it('allows a blocked command when the manifest names ANOTHER session', async () => {
    const dir = await mkProjectTracked(FOREIGN_CMD_SCOPE);
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('npm test'),
      env: { CLAUDE_CODE_SESSION_ID: 'OWN-UUID-2222' },
    });
    expectAllow(result);
  });

  it('emits exactly one orchestrator.scope.foreign_session_ignored event', async () => {
    const dir = await mkProjectTracked(FOREIGN_CMD_SCOPE);
    await runHook({
      projectDir: dir,
      stdin: bashPayload('npm test'),
      env: { CLAUDE_CODE_SESSION_ID: 'OWN-UUID-2222' },
    });

    const events = (await readCmdEvents(dir))
      .filter((e) => e.event === 'orchestrator.scope.foreign_session_ignored');
    expect(events).toHaveLength(1);
    expect(events[0].hook).toBe('enforce-commands');
    expect(events[0].manifest_session).toEqual(['PEER-UUID-1111', 'main-2026-01-01-session-9']);
    expect(events[0].own_session).toEqual(['OWN-UUID-2222']);
    expect(events[0].wave).toBe(4);
    expect(events[0].command).toBe('npm test');
  });

  it('still denies when the manifest names THIS session — enforcement unchanged', async () => {
    // The over-reach guard: the gate must key on a PROVABLY foreign id, never on
    // the mere presence of a `session` field.
    const dir = await mkProjectTracked({ ...FOREIGN_CMD_SCOPE, session_id: 'OWN-UUID-2222' });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('npm test'),
      env: { CLAUDE_CODE_SESSION_ID: 'OWN-UUID-2222' },
    });
    expectDeny(result, 'npm test');
    expect(await readCmdEvents(dir)).toHaveLength(0);
  });

  it('still denies a LEGACY manifest with no session field (unknown = enforce)', async () => {
    // The fail-closed half: a manifest written before #1153 binds nobody and
    // must keep constraining everyone exactly as it did before.
    const dir = await mkProjectTracked({
      wave: 4,
      enforcement: 'strict',
      blockedCommands: ['npm test'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('npm test'),
      env: { CLAUDE_CODE_SESSION_ID: 'OWN-UUID-2222' },
    });
    expectDeny(result, 'npm test');
  });
});
