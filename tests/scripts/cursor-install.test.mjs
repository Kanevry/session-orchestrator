/**
 * tests/scripts/cursor-install.test.mjs
 *
 * Integration smoke-tests for scripts/cursor-install.mjs (issue #218).
 *
 * Strategy: spawn `node scripts/cursor-install.mjs [TARGET]` with controlled
 * environment. Never import the script as a module — always use spawnSync so
 * the process boundary is identical to real-world usage.
 *
 * Exit codes expected by the script:
 *   0 — success
 *   1 — source rules not found
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  lstatSync,
  existsSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Repo paths
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts', 'cursor-install.mjs');
const SOURCE_RULES_DIR = join(REPO_ROOT, '.cursor', 'rules');
const HOOKS_DIR = join(REPO_ROOT, 'hooks');
const ENFORCE_HOOK_FILES = readdirSync(HOOKS_DIR).filter((f) => f.startsWith('enforce-'));

// Count .mdc files in the source repo once — used for floor/ceiling assertions.
const MDC_COUNT = readdirSync(SOURCE_RULES_DIR).filter((f) => f.endsWith('.mdc')).length;

// ---------------------------------------------------------------------------
// Helper: spawn cursor-install.mjs
// ---------------------------------------------------------------------------

function runCursorInstall(args = [], { cwd } = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: cwd ?? REPO_ROOT,
    env: { ...process.env },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Helper: count symlinks in a directory
// ---------------------------------------------------------------------------

function countSymlinks(dir) {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => {
    try { return lstatSync(join(dir, f)).isSymbolicLink(); } catch { return false; }
  }).length;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('scripts/cursor-install.mjs integration', () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cursor-install-test-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Test 1 — argless invocation: uses cwd as target, creates .cursor/rules/
  // -------------------------------------------------------------------------

  it('argless invocation: creates .cursor/rules/ in cwd and symlinks all .mdc files', () => {
    // Spawn from tmp — no .cursor/rules there yet
    const result = runCursorInstall([], { cwd: tmp });

    expect(result.status).toBe(0);

    const targetRulesDir = join(tmp, '.cursor', 'rules');
    expect(existsSync(targetRulesDir)).toBe(true);

    const symlinkCount = countSymlinks(targetRulesDir);
    // Floor/ceiling: must link all .mdc files from source (exact count known at test time)
    expect(symlinkCount).toBeGreaterThanOrEqual(MDC_COUNT);
    expect(symlinkCount).toBeLessThanOrEqual(MDC_COUNT);
  });

  // -------------------------------------------------------------------------
  // Test 2 — explicit TARGET arg: symlinks land at the given path
  // -------------------------------------------------------------------------

  it('explicit TARGET arg: symlinks land inside the specified target directory', () => {
    const explicitTarget = join(tmp, 'my-project');
    mkdirSync(explicitTarget, { recursive: true });

    const result = runCursorInstall([explicitTarget]);

    expect(result.status).toBe(0);

    const targetRulesDir = join(explicitTarget, '.cursor', 'rules');
    expect(existsSync(targetRulesDir)).toBe(true);

    const symlinkCount = countSymlinks(targetRulesDir);
    expect(symlinkCount).toBeGreaterThanOrEqual(MDC_COUNT);
    expect(symlinkCount).toBeLessThanOrEqual(MDC_COUNT);
  });

  // -------------------------------------------------------------------------
  // Test 3 — idempotent re-run: no new symlinks; second run prints only SKIP
  // -------------------------------------------------------------------------

  it('idempotent re-run: second invocation SKIPs all files and emits no new LINK lines', () => {
    const target = join(tmp, 'idempotent-project');
    mkdirSync(target, { recursive: true });

    // First run — installs symlinks
    const first = runCursorInstall([target]);
    expect(first.status).toBe(0);

    const afterFirst = countSymlinks(join(target, '.cursor', 'rules'));
    expect(afterFirst).toBe(MDC_COUNT);

    // Second run — all files already linked; no new LINKs expected
    const second = runCursorInstall([target]);
    expect(second.status).toBe(0);

    const afterSecond = countSymlinks(join(target, '.cursor', 'rules'));
    // Symlink count must not have changed
    expect(afterSecond).toBe(MDC_COUNT);

    // stdout should contain SKIP lines and zero new LINK lines for .mdc files
    const skipCount = (second.stdout.match(/SKIP:/g) ?? []).length;
    const linkCount = (second.stdout.match(/LINK:/g) ?? []).length;
    expect(skipCount).toBe(MDC_COUNT);
    expect(linkCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Test 4 — banner is printed on stdout with correct paths
  // -------------------------------------------------------------------------

  it('prints banner with source and target paths on stdout', () => {
    const target = join(tmp, 'banner-check');
    mkdirSync(target, { recursive: true });

    const result = runCursorInstall([target]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Session Orchestrator — Cursor IDE Setup');
    expect(result.stdout).toContain('.cursor/rules/');
  });

  // -------------------------------------------------------------------------
  // Test 5 — exit code 0 on success; stdout contains "Done!"
  // -------------------------------------------------------------------------

  it('exits 0 and prints "Done!" summary line on success', () => {
    const target = join(tmp, 'done-check');
    mkdirSync(target, { recursive: true });

    const result = runCursorInstall([target]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Done!');
  });

  // -------------------------------------------------------------------------
  // Test 6 — non-existent TARGET: exit 1 with clear stderr message
  // -------------------------------------------------------------------------

  it('non-existent TARGET: exits 1 and prints a clear stderr message', () => {
    const missingTarget = join(tmp, 'does-not-exist');

    const result = runCursorInstall([missingTarget]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ERROR: Target directory does not exist:');
    expect(result.stderr).toContain(missingTarget);
  });

  // -------------------------------------------------------------------------
  // Test 6b — TARGET exists but is a FILE, not a directory: the `||` in
  // `!existsSync(TARGET) || !statSync(TARGET).isDirectory()` was only ever
  // exercised via its LEFT operand (a path that doesn't exist at all). A
  // regular file satisfies `existsSync` but fails `.isDirectory()`, so the
  // guard must still short-circuit to the same clean exit-1 path rather than
  // falling through to `mkdirSync(path.join(TARGET, '.cursor', 'rules'), ...)`
  // — which would throw ENOTDIR with a raw stack trace on a file target,
  // never reaching this script's own error message at all.
  // -------------------------------------------------------------------------

  it('TARGET that exists but is a FILE (not a directory): exits 1 with the same clean stderr message as a missing target', () => {
    const fileTarget = join(tmp, 'not-a-directory.txt');
    writeFileSync(fileTarget, 'not a directory');

    const result = runCursorInstall([fileTarget]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ERROR: Target directory does not exist:');
    expect(result.stderr).toContain(fileTarget);
  });

  // -------------------------------------------------------------------------
  // Test 7 — next-steps banner names enforce-* hook files that exist in hooks/
  // -------------------------------------------------------------------------

  it('next-steps banner names enforce-* hook files that exist in hooks/', () => {
    const target = join(tmp, 'hooks-banner-check');
    mkdirSync(target, { recursive: true });

    const result = runCursorInstall([target]);

    expect(result.status).toBe(0);
    expect(ENFORCE_HOOK_FILES.length).toBeGreaterThan(0);
    for (const hookFile of ENFORCE_HOOK_FILES) {
      expect(result.stdout).toContain(hookFile);
    }
  });
});
