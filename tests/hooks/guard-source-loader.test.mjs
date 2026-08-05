/**
 * tests/hooks/guard-source-loader.test.mjs
 *
 * Unit tests for the generalised loader `hooks/_lib/guard-source-loader.mjs`
 * (#993): `armGuard(specMap, opts)` + `emitGuardInactiveBanner(opts)`.
 *
 * These pin the CONTRACT A2/A3 build on — the loader must NEVER hard-wire
 * `pre-bash-destructive-guard` into a banner, must reject an unsound
 * `headFallback`, and must honour the per-module `requires` shape check. The
 * spawn-level behaviour (the banner reaching a real hook's stderr) is covered by
 * tests/hooks/pre-bash-destructive-guard.test.mjs; here we exercise the exported
 * functions directly.
 *
 * Issue: #993.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { armGuard, emitGuardInactiveBanner } from '../../hooks/_lib/guard-source-loader.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

let GIT_AVAILABLE = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  GIT_AVAILABLE = false;
}

const tmpDirs = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of tmpDirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

/**
 * Build a tmp git repo whose committed module is `committed`. When `working` is
 * given the working-tree copy is overwritten with it afterwards (the shape that
 * forces the HEAD fallback); omit it for a repo used purely as a `git show`
 * source, e.g. the FOREIGN repo of the #998.1 env-scrub tests.
 */
async function makeGitRepoWithBrokenWorkingCopy({ rel, committed, working }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'armguard-'));
  tmpDirs.push(dir);
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, committed);
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@test.com');
  git('config', 'user.name', 'Test');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  if (working !== undefined) await fs.writeFile(abs, working); // break the working-tree copy
  return { dir, abs };
}

/** Capture everything written to process.stderr during `fn()`. */
function captureStderr(fn) {
  const chunks = [];
  const spy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((s) => (chunks.push(String(s)), true));
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return chunks.join('');
}

// ---------------------------------------------------------------------------
// hookName is MANDATORY on both exports — a default would re-freeze the #993 drift
// ---------------------------------------------------------------------------

describe('hookName is required (no default — #993)', () => {
  it('armGuard rejects when hookName is missing', async () => {
    await expect(
      armGuard({}, { repoRoot: REPO_ROOT, projectDir: os.tmpdir() })
    ).rejects.toThrow(/hookName/);
  });

  it('emitGuardInactiveBanner throws when hookName is missing', () => {
    expect(() => emitGuardInactiveBanner({ error: new Error('boom') })).toThrow(/hookName/);
  });

  it('emitGuardInactiveBanner names the CALLER hookName, never a hard-wired literal', () => {
    const out = captureStderr(() =>
      emitGuardInactiveBanner({
        hookName: 'some-other-guard',
        error: new Error('boom'),
        consequence: { inactive: ['    Consequence: X are NOT being blocked.'] },
      })
    );
    expect(out).toContain('some-other-guard: GUARD INACTIVE');
    // The whole point of #993: no hook name other than the caller's leaks in.
    expect(out).not.toContain('pre-bash-destructive-guard');
    // consequence.inactive is spliced verbatim.
    expect(out).toContain('are NOT being blocked');
  });
});

// ---------------------------------------------------------------------------
// headFallback:true is legal ONLY for a dependency-free module
// ---------------------------------------------------------------------------

describe('headFallback allowlist', () => {
  it('rejects headFallback:true on a module that is NOT dependency-free', async () => {
    // hardening.mjs carries relative imports — a data: URL cannot resolve them,
    // so the fallback would be silently unloadable. Must be a HARD error.
    await expect(
      armGuard(
        {
          hardening: {
            specifier: pathToFileURL(
              path.join(REPO_ROOT, 'scripts', 'lib', 'hardening.mjs')
            ).href,
            headFallback: true,
          },
        },
        { hookName: 'x', repoRoot: REPO_ROOT, projectDir: os.tmpdir() }
      )
    ).rejects.toThrow(/dependency-free|allowlist/i);
  });

  it('accepts a dependency-free basename (command-blocker.mjs loads cleanly)', async () => {
    const { modules, degraded } = await armGuard(
      {
        blocker: {
          specifier: pathToFileURL(
            path.join(REPO_ROOT, 'scripts', 'lib', 'command-blocker.mjs')
          ).href,
          headFallback: true,
          requires: ['tokenizeCommand', 'splitChainSegments'],
        },
      },
      { hookName: 'x', repoRoot: REPO_ROOT, projectDir: os.tmpdir() }
    );
    expect(typeof modules.blocker.tokenizeCommand).toBe('function');
    expect(degraded).toEqual([]); // working-tree copy is fine → no fallback
  });
});

// ---------------------------------------------------------------------------
// per-module `requires` shape check
// ---------------------------------------------------------------------------

describe('per-module requires', () => {
  it('rejects and NAMES the missing export when requires is unmet', async () => {
    await expect(
      armGuard(
        {
          io: {
            specifier: pathToFileURL(path.join(REPO_ROOT, 'scripts', 'lib', 'io.mjs')).href,
            requires: ['emitAllow', 'thisExportDoesNotExist'],
          },
        },
        { hookName: 'x', repoRoot: REPO_ROOT, projectDir: os.tmpdir() }
      )
    ).rejects.toThrow(/thisExportDoesNotExist/);
  });

  it('passes when every required export is present (no requires → no check)', async () => {
    const { modules } = await armGuard(
      {
        io: {
          specifier: pathToFileURL(path.join(REPO_ROOT, 'scripts', 'lib', 'io.mjs')).href,
          requires: ['emitAllow', 'emitDeny', 'emitWarn'],
        },
      },
      { hookName: 'x', repoRoot: REPO_ROOT, projectDir: os.tmpdir() }
    );
    expect(typeof modules.io.emitWarn).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// The DEGRADED banner also names the CALLER hookName (#993) — git-backed HEAD
// fallback: committed copy valid, working-tree copy broken.
// ---------------------------------------------------------------------------

describe('DEGRADED banner (git HEAD fallback)', () => {
  it.skipIf(!GIT_AVAILABLE)(
    'falls back to HEAD and banners with the CALLER hookName, not a literal',
    async () => {
      const rel = 'scripts/lib/io.mjs'; // a dependency-free ALLOWLIST basename
      const { dir } = await makeGitRepoWithBrokenWorkingCopy({
        rel,
        committed: 'export function foo() { return 1; }\n',
        working: 'export const broken = ;', // unparseable
      });

      // captureStderr wraps a sync fn; the banner write is synchronous inside the
      // awaited armGuard, so spy directly around the await here.
      const chunks = [];
      const spy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation((s) => (chunks.push(String(s)), true));
      let result;
      try {
        result = await armGuard(
          {
            m: {
              specifier: pathToFileURL(path.join(dir, rel)).href,
              headFallback: true,
              requires: ['foo'],
            },
          },
          {
            hookName: 'custom-degraded-guard',
            repoRoot: dir,
            projectDir: dir,
            consequence: { degraded: ['    Consequence: evaluating HEAD copy.'] },
          }
        );
      } finally {
        spy.mockRestore();
      }
      const out = chunks.join('');

      expect(result.degraded).toEqual(['m']);
      expect(typeof result.modules.m.foo).toBe('function'); // loaded from HEAD
      expect(out).toContain('custom-degraded-guard: DEGRADED');
      expect(out).toContain('running against HEAD, not your working tree');
      expect(out).not.toContain('pre-bash-destructive-guard');
    }
  );
});

// ---------------------------------------------------------------------------
// #998.1 — the HEAD fallback must not read a FOREIGN repository
//
// `git -C <repoRoot> show HEAD:<rel>` sets only the child's CWD; GIT_DIR (and
// GIT_OBJECT_DIRECTORY) override repository/object discovery outright, so an
// inherited value makes the loader import a foreign blob AS CODE inside a
// deny-capable hook. Defense in depth — no vector is known that sets a later
// hook process's env — but the blast radius if one appears is code execution.
// ---------------------------------------------------------------------------

/** The loader's own per-project marker-scope derivation (module-private there). */
function markerScopeOf(projectDir) {
  return crypto.createHash('sha256').update(projectDir).digest('hex').slice(0, 12);
}

/** Every banner marker this file's tmp projects may have written. */
const markerScopes = [];
afterEach(async () => {
  const scopes = markerScopes.splice(0);
  if (scopes.length === 0) return;
  for (const name of await fs.readdir(os.tmpdir())) {
    if (!name.startsWith('session-orchestrator-guard-')) continue;
    if (scopes.some((s) => name.includes(`-${s}-`))) {
      await fs.rm(path.join(os.tmpdir(), name), { force: true });
    }
  }
});

/** Run armGuard with stderr silenced, returning `{ result, stderr }`. */
async function armGuardQuietly(specMap, opts) {
  const chunks = [];
  const spy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((s) => (chunks.push(String(s)), true));
  try {
    const result = await armGuard(specMap, opts);
    return { result, stderr: chunks.join('') };
  } finally {
    spy.mockRestore();
  }
}

/** A real repo (broken working copy) + a foreign repo with the SAME rel path. */
async function makeRealAndForeignRepos(rel) {
  const { dir: realDir } = await makeGitRepoWithBrokenWorkingCopy({
    rel,
    committed: "export function origin() { return 'REAL'; }\n",
    working: 'export const broken = ;', // unparseable → forces the HEAD fallback
  });
  const { dir: foreignDir } = await makeGitRepoWithBrokenWorkingCopy({
    rel,
    committed: "export function origin() { return 'FOREIGN'; }\n",
  });
  markerScopes.push(markerScopeOf(realDir));
  return { realDir, foreignDir };
}

describe('#998.1 — git env scrub in readFromHead', () => {
  const REL = 'scripts/lib/io.mjs'; // a dependency-free ALLOWLIST basename

  /** Set env vars for one call, restoring the previous values unconditionally. */
  async function withEnv(vars, fn) {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    Object.assign(process.env, vars);
    try {
      return await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it.skipIf(!GIT_AVAILABLE)('an inherited GIT_DIR does not swap in a FOREIGN repo’s blob', async () => {
    // Bug this catches: dropping the env option from readFromHead re-opens the
    // foreign-blob door — `git -C real show HEAD:<rel>` then returns the repo
    // GIT_DIR names, and importFromSource EXECUTES it inside the guard.
    const { realDir, foreignDir } = await makeRealAndForeignRepos(REL);

    const { result } = await withEnv({ GIT_DIR: path.join(foreignDir, '.git') }, () =>
      armGuardQuietly(
        {
          m: {
            specifier: pathToFileURL(path.join(realDir, REL)).href,
            headFallback: true,
            requires: ['origin'],
          },
        },
        { hookName: 'x', repoRoot: realDir, projectDir: realDir }
      )
    );

    expect(result.degraded).toEqual(['m']);
    expect(result.modules.m.origin()).toBe('REAL');
  });

  it.skipIf(!GIT_AVAILABLE)('an inherited GIT_OBJECT_DIRECTORY does not swap in a FOREIGN repo’s objects', async () => {
    // Same class, second discovery override: pointing the object store at a
    // foreign repo either yields foreign content or breaks the fallback outright
    // — both fail this assertion, only the scrub keeps it REAL.
    const { realDir, foreignDir } = await makeRealAndForeignRepos(REL);

    const { result } = await withEnv(
      { GIT_OBJECT_DIRECTORY: path.join(foreignDir, '.git', 'objects') },
      () =>
        armGuardQuietly(
          {
            m: {
              specifier: pathToFileURL(path.join(realDir, REL)).href,
              headFallback: true,
              requires: ['origin'],
            },
          },
          { hookName: 'x', repoRoot: realDir, projectDir: realDir }
        )
    );

    expect(result.degraded).toEqual(['m']);
    expect(result.modules.m.origin()).toBe('REAL');
  });
});

// ---------------------------------------------------------------------------
// #998.3 — the once-per-session banner key is per SESSION, not per working copy
//
// There is one `.orchestrator/session.lock` per working copy, so keying on
// `session_id` alone means two parallel sessions in the same working copy share
// a marker and the second never sees its degradation banner. The key composes
// the id with the PARENT pid (the harness process — `run-node.sh` uses `exec
// node` on every branch, so no shell survives to become the parent).
// ---------------------------------------------------------------------------

describe('#998.3 — banner key composes session id with the parent pid', () => {
  const REL = 'scripts/lib/io.mjs';
  const MARKER = (scope, key) =>
    path.join(os.tmpdir(), `session-orchestrator-guard-head-fallback-${scope}-${key}`);

  async function degradeOnce(dir) {
    return armGuardQuietly(
      {
        m: {
          specifier: pathToFileURL(path.join(dir, REL)).href,
          headFallback: true,
          requires: ['origin'],
        },
      },
      { hookName: 'x', repoRoot: dir, projectDir: dir }
    );
  }

  async function makeBrokenRepo() {
    const { dir } = await makeGitRepoWithBrokenWorkingCopy({
      rel: REL,
      committed: "export function origin() { return 'REAL'; }\n",
      working: 'export const broken = ;',
    });
    markerScopes.push(markerScopeOf(dir));
    return dir;
  }

  it.skipIf(!GIT_AVAILABLE)('the ttl branch (no session.lock) keys on the PARENT pid and stays stable across calls', async () => {
    // Bug this catches: keying on process.pid instead of process.ppid. Every hook
    // invocation is its own node process, so a pid-keyed marker is unique per
    // tool call — the banner would fire on every single call, which is the noise
    // class the throttle exists to prevent.
    const dir = await makeBrokenRepo();
    const scope = markerScopeOf(dir);

    const first = await degradeOnce(dir);
    expect(first.result.degraded).toEqual(['m']);
    expect(first.stderr).toContain('DEGRADED');

    await expect(fs.access(MARKER(scope, `ttl-p${process.ppid}`))).resolves.toBeUndefined();
    await expect(fs.access(MARKER(scope, `ttl-p${process.pid}`))).rejects.toThrow();
    await expect(fs.access(MARKER(scope, 'ttl'))).rejects.toThrow(); // pre-#998.3 format

    // Same process → same key → the throttle bites on the second call.
    const second = await degradeOnce(dir);
    expect(second.stderr).not.toContain('DEGRADED');
  });

  it.skipIf(!GIT_AVAILABLE)('a session.lock keys on <sanitised-id>-p<ppid>, never on the id alone', async () => {
    // Bug this catches: dropping the composition (back to the bare session id)
    // re-shares one marker between two parallel sessions in the SAME working
    // copy — the second session's degradation banner is swallowed.
    const dir = await makeBrokenRepo();
    const scope = markerScopeOf(dir);
    await fs.mkdir(path.join(dir, '.orchestrator'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.orchestrator', 'session.lock'),
      JSON.stringify({ session_id: 'main/2026-08-05:session-1' })
    );

    const { result, stderr } = await degradeOnce(dir);
    expect(result.degraded).toEqual(['m']);
    expect(stderr).toContain('DEGRADED');

    const sanitised = 'main_2026-08-05_session-1'; // `/` and `:` are not [A-Za-z0-9._-]
    await expect(
      fs.access(MARKER(scope, `${sanitised}-p${process.ppid}`))
    ).resolves.toBeUndefined();
    await expect(fs.access(MARKER(scope, sanitised))).rejects.toThrow(); // pre-#998.3 format
  });
});
