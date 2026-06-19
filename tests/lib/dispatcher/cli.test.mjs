/**
 * cli.test.mjs — coverage for scripts/lib/dispatcher/cli.mjs
 * (Epic #673 Phase 3, issue #678). Front-door that wires
 * enumerate → freeCandidates → rank into one read path (runDispatch), exposes
 * an atomic claim pass-through (claimRepo), and a flag-parsing CLI (main).
 *
 * Two test surfaces:
 *  - UNIT (runDispatch / claimRepo): SUT imported by relative path; every I/O
 *    seam is dependency-injected (fs / lock / glab / resource probe), so a
 *    single test fully determines inputs. Deterministic FIXED_NOW. No hardcoded
 *    home paths (the CI owner-leakage scanner blocks those).
 *  - SUBPROCESS (main): spawnSync(process.execPath, [CLI_PATH, ...]) against an
 *    EMPTY tmpdir scan root so the real ~/Projects is never scanned. Asserts the
 *    stdout/stderr SEPARATION contract (data → stdout, warnings → stderr) and
 *    precise exit codes.
 *
 * Imported by relative path (tests/lib/dispatcher → repo root is 3 levels up).
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runDispatch, claimRepo } from '../../../scripts/lib/dispatcher/cli.mjs';

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

// Deterministic clock seam shared by every unit test.
const FIXED_NOW = new Date('2026-06-18T20:00:00Z').getTime();

// POSIX-absolute scan root for the DI-stub path. Never resolves against the
// real fs because readdirSync/existsSync are stubbed.
const ROOT = '/sandbox/projects';

// Absolute path to the CLI under test (resolved relative to this test file).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(
  __dirname,
  '../../../scripts/lib/dispatcher/cli.mjs',
);

/** A fake Dirent for the withFileTypes:true readdir stub. */
function dirent(name) {
  return { name, isDirectory: () => true };
}

/**
 * Build a combined deps bundle for runDispatch. The same `deps` object is
 * forwarded by runDispatch to BOTH enumerateCandidates (fs/lock seams) and
 * rankCandidates (signal seams), so we stub both layers here.
 *
 * @param {object} opts
 * @param {string[]} opts.repoNames   — child dir names that are git repos.
 * @param {Set<string>} [opts.busy]   — abs repoRoots whose lease is live (busy).
 * @param {Map<string,number>} [opts.staleDaysByName] — repoName → staleDays.
 */
function makeDispatchDeps({ repoNames, busy = new Set(), staleDaysByName = new Map() }) {
  const repoRoots = repoNames.map((n) => path.join(ROOT, n));
  const gitRepos = new Set(repoRoots.map((r) => path.join(r, '.git')));
  return {
    // --- enumerate seams ---
    readdirSync() {
      return repoNames.map((n) => dirent(n));
    },
    existsSync(p) {
      return gitRepos.has(p);
    },
    readLock({ repoRoot }) {
      // A live lock body for busy repos, null otherwise.
      return busy.has(repoRoot)
        ? { session_id: 'sess-busy', last_heartbeat: new Date(FIXED_NOW).toISOString() }
        : null;
    },
    isLockLive(lock) {
      return !!lock; // any present lock is treated as live here
    },
    async getCrossRepoProjects() {
      return [];
    },
    validatePathInsideProject() {
      return { ok: true };
    },
    // --- rank seams ---
    async fetchPriority() {
      return { criticalCount: 0, highCount: 0 };
    },
    async staleDaysFor(repoRoot) {
      const name = path.basename(repoRoot);
      return staleDaysByName.has(name) ? staleDaysByName.get(name) : 0;
    },
    async checkCiStatus() {
      return 'green';
    },
    async resourceVerdict() {
      return 'green';
    },
  };
}

/**
 * Spawn the CLI as a child process. `--start-dir` is forced to an empty tmpdir
 * so the scan is deterministic (zero candidates) and never touches ~/Projects.
 *
 * @param {string[]} args — extra CLI args (beyond start-dir, when applicable).
 * @param {{ withStartDir?: boolean }} [opts]
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function runCli(args, { withStartDir = true } = {}) {
  let tmp;
  const full = [CLI_PATH, ...args];
  if (withStartDir) {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'dispatcher-cli-'));
    full.push('--start-dir', tmp);
  }
  try {
    const res = spawnSync(process.execPath, full, { encoding: 'utf8' });
    return { status: res.status, stdout: res.stdout, stderr: res.stderr };
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// runDispatch — read-path orchestration shape
// ---------------------------------------------------------------------------

describe('runDispatch', () => {
  it('returns the five-key result shape with recommended === ranked[0]', async () => {
    const deps = makeDispatchDeps({
      repoNames: ['alpha', 'beta'],
      staleDaysByName: new Map([['alpha', 10], ['beta', 60]]),
    });

    const result = await runDispatch({ startDir: ROOT, now: FIXED_NOW, deps });

    expect(Object.keys(result).sort()).toEqual(
      ['candidates', 'free', 'ranked', 'recommended', 'warnings'],
    );
    // beta is staler (60 > 10) → higher staleness score → ranked first.
    expect(result.recommended).toBe(result.ranked[0]);
    expect(result.recommended.candidate.repoName).toBe('beta');
  });

  it('counts both free and busy candidates but ranks only the free ones', async () => {
    const deps = makeDispatchDeps({
      repoNames: ['free-one', 'busy-one'],
      busy: new Set([path.join(ROOT, 'busy-one')]),
    });

    const result = await runDispatch({ startDir: ROOT, now: FIXED_NOW, deps });

    expect(result.candidates).toHaveLength(2);
    expect(result.free).toHaveLength(1);
    expect(result.free[0].repoName).toBe('free-one');
    expect(result.ranked).toHaveLength(1);
    expect(result.recommended.candidate.repoName).toBe('free-one');
  });

  it('returns recommended === null when there are no free candidates', async () => {
    const deps = makeDispatchDeps({
      repoNames: ['busy-a', 'busy-b'],
      busy: new Set([path.join(ROOT, 'busy-a'), path.join(ROOT, 'busy-b')]),
    });

    const result = await runDispatch({ startDir: ROOT, now: FIXED_NOW, deps });

    expect(result.candidates).toHaveLength(2);
    expect(result.free).toEqual([]);
    expect(result.ranked).toEqual([]);
    expect(result.recommended).toBeNull();
  });

  it('propagates rank warnings when a priority signal is unavailable', async () => {
    const deps = makeDispatchDeps({ repoNames: ['gamma'] });
    deps.fetchPriority = async () => null; // glab/gh missing → fallback + warning

    const result = await runDispatch({ startDir: ROOT, now: FIXED_NOW, deps });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('priority unavailable for gamma');
    // Fallback still ranks the candidate (null priority ⇒ neutral score, not dropped).
    expect(result.recommended.candidate.repoName).toBe('gamma');
  });
});

// ---------------------------------------------------------------------------
// claimRepo — verbatim acquire pass-through
// ---------------------------------------------------------------------------

describe('claimRepo', () => {
  it('returns the acquire ok:true result verbatim', () => {
    const lock = { session_id: 'sess-1', acquired_at: '2026-06-18T20:00:00Z' };
    const acquire = () => ({ ok: true, lock });

    const result = claimRepo({
      repoRoot: '/sandbox/projects/alpha',
      sessionId: 'sess-1',
      mode: 'feature',
      deps: { acquire },
    });

    expect(result).toEqual({ ok: true, lock });
  });

  it('returns the acquire ok:false result verbatim (no rewriting of the reason)', () => {
    const acquire = () => ({ ok: false, reason: 'active' });

    const result = claimRepo({
      repoRoot: '/sandbox/projects/beta',
      sessionId: 'sess-2',
      mode: 'feature',
      deps: { acquire },
    });

    expect(result).toEqual({ ok: false, reason: 'active' });
  });

  it('forwards every claim field to the injected acquire unchanged', () => {
    let seen = null;
    const acquire = (args) => {
      seen = args;
      return { ok: true, lock: {} };
    };

    claimRepo({
      repoRoot: '/sandbox/projects/delta',
      sessionId: 'sess-3',
      mode: 'deep',
      ttlHours: 4,
      semanticSessionId: 'deep-42',
      deps: { acquire },
    });

    expect(seen).toEqual({
      repoRoot: '/sandbox/projects/delta',
      sessionId: 'sess-3',
      mode: 'deep',
      ttlHours: 4,
      semanticSessionId: 'deep-42',
    });
  });
});

// ---------------------------------------------------------------------------
// import.meta guard — importing the module must not run main
// ---------------------------------------------------------------------------

describe('module import', () => {
  it('exposes runDispatch and claimRepo as functions without running main', () => {
    // If `import` had executed main(), this test file would have already exited
    // (main calls process.exit under the guard). Reaching here with both exports
    // callable proves the import.meta guard suppressed main on import.
    expect(typeof runDispatch).toBe('function');
    expect(typeof claimRepo).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// main — subprocess CLI contract (flags, exit codes, stdout/stderr separation)
// ---------------------------------------------------------------------------

describe('main (subprocess)', () => {
  it('--json emits a single JSON object with the five top-level keys on stdout', () => {
    const { status, stdout } = runCli(['--json']);

    expect(status).toBe(0);
    const parsed = JSON.parse(stdout); // throws if stdout is not pure JSON
    expect(Object.keys(parsed).sort()).toEqual(
      ['candidates', 'free', 'ranked', 'recommended', 'warnings'],
    );
    // Empty tmpdir → no candidates discovered.
    expect(parsed.candidates).toEqual([]);
    expect(parsed.recommended).toBeNull();
  });

  it('--json keeps diagnostic prose out of stdout (data → stdout, diagnostics → stderr)', () => {
    const { status, stdout } = runCli(['--json']);

    expect(status).toBe(0);
    // The `warn()` diagnostic prefix must never appear on stdout — warnings are
    // routed to stderr, stdout carries data only.
    expect(stdout).not.toContain('WARNING:');
    // stdout is EXACTLY one JSON line and nothing else: parsing the whole of
    // stdout then re-serialising must round-trip to the same trimmed string.
    // This fails if any human prose were appended alongside the JSON payload.
    const parsed = JSON.parse(stdout);
    expect(`${JSON.stringify(parsed)}`).toBe(stdout.trim());
  });

  it('--help prints usage to stdout and exits 0', () => {
    const { status, stdout } = runCli(['--help']);

    expect(status).toBe(0);
    expect(stdout).toContain('USAGE');
    expect(stdout).toContain('--json');
  });

  it('--version prints a semver line to stdout and exits 0', () => {
    const { status, stdout } = runCli(['--version']);

    expect(status).toBe(0);
    expect(stdout.trim()).toBe('1.0.0');
  });

  it('exits 1 on an unknown flag (user/input error) with the error on stderr', () => {
    const { status, stdout, stderr } = runCli(['--bogus']);

    expect(status).toBe(1);
    expect(stderr).toContain('ERROR');
    expect(stdout).toBe('');
  });

  it('exits 1 when --start-dir is given without a value', () => {
    // parseArgs treats a trailing string flag with no value as an error.
    const { status, stderr } = runCli(['--start-dir'], { withStartDir: false });

    expect(status).toBe(1);
    expect(stderr).toContain('ERROR');
  });

  it('--repo filters the human-readable output to the named repo (no match → notice)', () => {
    // Empty scan root → no candidate matches the filter → explicit no-match line.
    const { status, stdout } = runCli(['--repo', 'nonexistent']);

    expect(status).toBe(0);
    expect(stdout).toContain('no free candidate named "nonexistent"');
  });
});
