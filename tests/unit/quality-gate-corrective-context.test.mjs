/**
 * tests/unit/quality-gate-corrective-context.test.mjs
 *
 * Regression coverage for GitLab #1205: `scripts/lib/quality-gate.mjs`'s
 * private `readOwnSessionIds()` used to fall back to
 * `.orchestrator/session.lock` when `CLAUDE_CODE_SESSION_ID` was unset.
 * `session.lock` is a repo-GLOBAL artefact — any session sharing the working
 * copy may hold it — so it is not a process-local identity witness (the
 * #1194 hazard class; see `.claude/rules/host-resources.md` § HR-102, "a
 * better signal REPLACES a worse one, it does not merely suppress it"). The
 * fix folds `readOwnSessionIds()` onto the shared, already-hardened
 * `readProcessLocalSessionIds()` (`scripts/lib/session-identity/own-session.mjs`)
 * and deletes the lock fallback outright.
 *
 * Scope note (RCR-009 / PSA-006 — measured, not assumed): the Discovery brief
 * for this task (D6) claimed "Tests: NONE cover
 * readCorrectiveContext/classifyCurrentSessionOwnership". That claim is
 * refuted by measurement: `tests/unit/quality-gate-autofix.test.mjs` lines
 * 464-576 ("correctiveContext session binding (#1058)") already pin the
 * env-var-only own/foreign/unknown paths with 5 tests — own-via-env,
 * foreign-via-env, kept-with-no-id, matched-via-semantic-id, and the WARN
 * side effect. Duplicating those cases here (env=OWN/file=PEER → foreign;
 * env=PEER/file=PEER → own) would violate `.claude/rules/test-value.md`
 * TV-004 for zero new bug-catching power — same code path, same assertions.
 *
 * `grep -n "session.lock\|readLock" tests/unit/quality-gate*.test.mjs` (run
 * 2026-09-03 against HEAD 2cb8708b, before this fix) returns exactly one hit,
 * a doc comment — zero prior coverage of the LOCK FALLBACK path itself. That
 * is the genuine, previously-untested gap, and the only one this file closes.
 *
 * Case discrimination note: a fixture where `current-session.json`'s
 * `session_id` EQUALS the lock's `session_id` (the literal shape D6
 * proposed) does NOT discriminate old vs. fixed code — `classifyCurrentSessionOwnership`
 * only DISCARDS on verdict `'foreign'`; both `'own'` (old code, matched via
 * the lock fallback) and `'unknown'` (fixed code, empty own-id set) KEEP the
 * data, so `readCorrectiveContext`'s return value is byte-identical either
 * way and no assertion on it can fail differently pre/post fix. The
 * discriminating fixture — proven by tracing `readOwnSessionIds()` /
 * `classifyCurrentSessionOwnership()` in both the pre-fix (`git show
 * HEAD:scripts/lib/quality-gate.mjs`) and fixed source — is a lock that names
 * a DIFFERENT session than the one that wrote `current-session.json`: the old
 * fallback then reads the LOCK holder's id as this process's own, mismatches
 * against the file's (different) id, and DISCARDS a hint that has nothing to
 * do with whether the discarding process actually IS that file's session.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

import { runQualityGateWithRetry } from '@lib/quality-gate.mjs';

const ENV_KEY = 'CLAUDE_CODE_SESSION_ID';

// Cross-platform shell stand-ins — see quality-gate-autofix.test.mjs header.
const FAIL_LINT_COMMANDS = {
  lint: 'node -e "process.exit(1)"',
  typecheck: 'node -e "process.exit(0)"',
  test: 'node -e "process.exit(0)"',
};

let repoRoot;
let savedEnv;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'qg-corrective-ctx-'));
  mkdirSync(join(repoRoot, '.orchestrator', 'metrics', 'verification-failures'), {
    recursive: true,
  });
  execSync('git init -q', { cwd: repoRoot });
  execSync('git config user.email "test@test.local"', { cwd: repoRoot });
  execSync('git config user.name "Test"', { cwd: repoRoot });
  writeFileSync(join(repoRoot, 'A.txt'), 'a', 'utf8');
  execSync('git add .', { cwd: repoRoot });
  execSync('git commit -m init -q', { cwd: repoRoot });
  savedEnv = process.env[ENV_KEY];
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  rmSync(repoRoot, { recursive: true, force: true });
});

/**
 * Write `.orchestrator/session.lock` — the exact shape `parseLock()` in
 * `scripts/lib/session-lock.mjs` requires (session_id/started_at/mode/pid/
 * host/ttl_hours all present) so the OLD code's `readLock()` fallback parses
 * it successfully rather than silently treating it as absent/corrupt.
 */
function writeLock(sessionId) {
  writeFileSync(
    join(repoRoot, '.orchestrator', 'session.lock'),
    JSON.stringify({
      session_id: sessionId,
      started_at: new Date().toISOString(),
      mode: 'session',
      pid: process.pid,
      host: 'test-host',
      ttl_hours: 4,
    }),
    'utf8',
  );
}

/** Write `.orchestrator/current-session.json` with a session id + one hint. */
function writeCurrentSession(sessionId, hint) {
  writeFileSync(
    join(repoRoot, '.orchestrator', 'current-session.json'),
    JSON.stringify({ session_id: sessionId, corrective_context: [hint] }),
    'utf8',
  );
}

describe('readCorrectiveContext — session.lock fallback removal (#1205)', () => {
  it('no longer treats the session.lock holder\'s id as our own when CLAUDE_CODE_SESSION_ID is unset', async () => {
    delete process.env[ENV_KEY];
    // The lock names one session; current-session.json was written by a
    // DIFFERENT one. Under the pre-#1205 code this makes readOwnSessionIds()
    // adopt the lock holder's id (LOCK-HOLDER-SESSION) as "our own" purely
    // because the env var is absent — an identity that has nothing to do with
    // which process is actually running this test.
    writeLock('LOCK-HOLDER-SESSION');
    writeCurrentSession('OTHER-SESSION-ID', 'hint-from-other-session');

    const dispatchFixer = vi.fn().mockResolvedValue(undefined);
    await runQualityGateWithRetry({
      maxRetries: 1,
      dispatchFixer,
      repoRoot,
      commands: FAIL_LINT_COMMANDS,
    });

    const callArg = dispatchFixer.mock.calls[0][0];
    // Fixed behaviour: with no process-local witness, ownership is 'unknown'
    // (unprovable in both directions), so the hint is KEPT per the existing
    // #1058 fail-open contract — never discarded on the strength of a
    // repo-global lock file that could name any peer in the working copy.
    expect(callArg.correctiveContext).toEqual(['hint-from-other-session']);
  });
});

describe('readCorrectiveContext — visible fail-open on unverifiable ownership', () => {
  // vi.spyOn on an already-spied `process.stderr.write` returns the SAME spy
  // instance rather than a fresh one, so an un-restored spy's `.mock.calls`
  // from a PRIOR test in this describe block leaks into the next test's
  // "fresh" `stderrSpy` variable. Restore after every test so each spy's call
  // list reflects only its own test.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // maxRetries: 0 -> totalAttempts is 1, so readCorrectiveContext runs exactly
  // ONCE (the abort path only — no fixer dispatch). That is what makes "exactly
  // one WARN" a meaningful assertion rather than an artefact of the retry count
  // (see the module doc: "runs at most once per fixer dispatch plus once at
  // abort, and each line marks a distinct decision point").
  it('keeps corrective_context AND emits exactly one UNVERIFIED WARN when CLAUDE_CODE_SESSION_ID is unset and the file names a peer', async () => {
    delete process.env[ENV_KEY];
    writeCurrentSession('PEER-SESSION-ID', 'hint-from-peer');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const result = await runQualityGateWithRetry({
      maxRetries: 0,
      dispatchFixer: vi.fn().mockResolvedValue(undefined),
      repoRoot,
      commands: FAIL_LINT_COMMANDS,
    });

    const bundle = JSON.parse(readFileSync(result.diagnosticsBundlePath, 'utf8'));
    expect(bundle.correctiveContext).toEqual(['hint-from-peer']);

    const unverifiedWarnings = stderrSpy.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes('UNVERIFIED'));
    expect(unverifiedWarnings).toHaveLength(1);
  });

  it('emits NO UNVERIFIED warn when CLAUDE_CODE_SESSION_ID matches the file\'s own session id', async () => {
    process.env[ENV_KEY] = 'PEER-SESSION-ID';
    writeCurrentSession('PEER-SESSION-ID', 'hint-from-peer');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const result = await runQualityGateWithRetry({
      maxRetries: 0,
      dispatchFixer: vi.fn().mockResolvedValue(undefined),
      repoRoot,
      commands: FAIL_LINT_COMMANDS,
    });

    const bundle = JSON.parse(readFileSync(result.diagnosticsBundlePath, 'utf8'));
    expect(bundle.correctiveContext).toEqual(['hint-from-peer']);

    const unverifiedWarnings = stderrSpy.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes('UNVERIFIED'));
    expect(unverifiedWarnings).toHaveLength(0);
  });
});
