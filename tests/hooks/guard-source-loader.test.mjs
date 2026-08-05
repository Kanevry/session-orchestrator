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
  /** Build a tmp git repo whose committed module is valid but working copy broken. */
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
    await fs.writeFile(abs, working); // now break the working-tree copy
    return { dir, abs };
  }

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
