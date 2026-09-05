/**
 * tests/husky/pre-commit-hook-import-set.test.mjs
 *
 * Tests for the .husky/pre-commit hook-import-set drift stage (#1224).
 *
 * The stage it guards: `hooks/_lib/hook-import-set.json` is the committed
 * allowlist that gates `hooks/post-edit-import-probe.mjs`. A stale allowlist
 * does not make the probe noisy — it makes it SILENT for exactly the modules
 * that just became hook-reachable, which is the 2026-09-04 host-wide-block
 * incident class.
 *
 * Three guarantees:
 *   1. The hook text contains the invocation + the one-line remedy (regression
 *      guard against accidental removal during pre-commit edits).
 *   2. E2E in a tmp git repo: the EXTRACTED stage block blocks a commit that
 *      touches `scripts/lib/` while the allowlist is stale, and passes when the
 *      allowlist matches.
 *   3. The staged-set filter is honoured: a commit touching neither `hooks/`
 *      nor `scripts/lib/` never runs the crawl, even with a stale allowlist.
 *
 * The E2E deliberately builds its own tiny plugin root rather than measuring
 * THIS repository — a gate test whose fixture is the live repo pins the repo's
 * current state and goes red when a sibling wave legitimately changes imports.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, chmodSync, cpSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const HOOK_PATH = join(REPO_ROOT, '.husky', 'pre-commit');
const GENERATOR_PATH = join(REPO_ROOT, 'scripts', 'generate-hook-import-set.mjs');

/**
 * Extract the marker-delimited stage from the real hook so the E2E executes the
 * SAME shell text that ships, not a paraphrase of it.
 *
 * @returns {string}
 */
function extractStage() {
  const src = readFileSync(HOOK_PATH, 'utf8');
  const m = src.match(
    /# --- hook-import-set-drift:begin[\s\S]*?# --- hook-import-set-drift:end ---/,
  );
  if (!m) throw new Error('hook-import-set-drift stage markers not found in .husky/pre-commit');
  return `#!/usr/bin/env sh\n${m[0]}\n`;
}

describe('.husky/pre-commit — hook-import-set drift stage (#1224)', () => {
  describe('regression guard — hook content', () => {
    it('contains the generator --check invocation', () => {
      const hook = readFileSync(HOOK_PATH, 'utf8');
      expect(hook).toContain('node scripts/generate-hook-import-set.mjs --check');
    });

    it('scopes the stage to staged hooks/ or scripts/lib/ paths', () => {
      const hook = readFileSync(HOOK_PATH, 'utf8');
      expect(hook).toMatch(/git diff --cached --name-only[^|]*\| grep -qE '\^\(hooks\|scripts\/lib\)\/'/);
    });

    it('prints the one-line remedy and the --no-verify escape', () => {
      const hook = readFileSync(HOOK_PATH, 'utf8');
      expect(hook).toContain(
        'run node scripts/generate-hook-import-set.mjs and stage hooks/_lib/hook-import-set.json',
      );
      expect(hook).toContain('Commit blocked');
      expect(hook).toMatch(/--no-verify/);
    });

    it('judges the stage by the success MARKER, not by the exit code alone', () => {
      // A generator whose CLI entry guard does not fire prints nothing and
      // exits 0 — an exit-code-only stage reads that as a pass (fail-open).
      const hook = readFileSync(HOOK_PATH, 'utf8');
      expect(hook).toContain('modules, in sync');
    });

    it('is valid under POSIX sh, not only bash (bash-harness-pitfalls §5)', () => {
      const r = spawnSync('sh', ['-n', HOOK_PATH], { encoding: 'utf8' });
      expect(r.status).toBe(0);
    });
  });

  describe('E2E — extracted stage against a tmp plugin root', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'so-husky-import-set-'));
      execFileSync('git', ['init', '-q', tmpDir]);
      execFileSync('git', ['-C', tmpDir, 'config', 'user.email', 'test@example.com']);
      execFileSync('git', ['-C', tmpDir, 'config', 'user.name', 'Test']);
      execFileSync('git', ['-C', tmpDir, 'config', 'commit.gpgsign', 'false']);

      // Minimal plugin root the generator can crawl: one manifest naming one
      // entry file, which imports one helper under scripts/lib/.
      mkdirSync(join(tmpDir, 'scripts', 'lib'), { recursive: true });
      mkdirSync(join(tmpDir, 'hooks', '_lib'), { recursive: true });
      cpSync(GENERATOR_PATH, join(tmpDir, 'scripts', 'generate-hook-import-set.mjs'));
      writeFileSync(
        join(tmpDir, 'hooks', 'hooks.json'),
        JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'node "$CLAUDE_PLUGIN_ROOT/hooks/on-stop.mjs"' }] }] } }),
      );
      writeFileSync(join(tmpDir, 'hooks', 'on-stop.mjs'), "import '../scripts/lib/helper.mjs';\n");
      writeFileSync(join(tmpDir, 'scripts', 'lib', 'helper.mjs'), 'export const x = 1;\n');

      const hookDst = join(tmpDir, '.git', 'hooks', 'pre-commit');
      writeFileSync(hookDst, extractStage());
      chmodSync(hookDst, 0o755);
    });

    afterEach(() => {
      if (tmpDir) execFileSync('find', [tmpDir, '-delete']);
    });

    /** Regenerate the allowlist inside the fixture so it is in sync. */
    function sync() {
      execFileSync(process.execPath, ['scripts/generate-hook-import-set.mjs'], { cwd: tmpDir });
    }

    /** Stage everything and attempt a commit. */
    function commit(msg) {
      execFileSync('git', ['-C', tmpDir, 'add', '-A']);
      return spawnSync('git', ['-C', tmpDir, 'commit', '-m', msg], { encoding: 'utf8' });
    }

    it('blocks a commit touching scripts/lib/ while the allowlist is stale', () => {
      writeFileSync(
        join(tmpDir, 'hooks', '_lib', 'hook-import-set.json'),
        JSON.stringify({ generated_at: 'stale', head: 'stale', entries: [] }) + '\n',
      );
      const r = commit('stale allowlist');
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/hook-import-set: committed allowlist is stale/);
      expect(r.stderr).toMatch(/stage hooks\/_lib\/hook-import-set\.json/);
    });

    it('blocks when the generator exits 0 without reporting a comparison', () => {
      // The fail-open shape this stage was hardened against: a silent exit 0
      // (measured on the real generator when invoked through a symlinked path
      // before #1224's entry-guard fix). Exit code alone would say "pass".
      sync();
      writeFileSync(
        join(tmpDir, 'scripts', 'generate-hook-import-set.mjs'),
        '#!/usr/bin/env node\nprocess.exit(0);\n',
      );
      const r = commit('silently no-op generator');
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/hook-import-set: committed allowlist is stale/);
    });

    it('allows the same commit once the allowlist is regenerated', () => {
      sync();
      const r = commit('synced allowlist');
      expect(r.status).toBe(0);
    });

    it('does not run the crawl when no staged path touches hooks/ or scripts/lib/', () => {
      // Land the fixture first with a synced allowlist…
      sync();
      expect(commit('baseline').status).toBe(0);
      // …then corrupt the allowlist WITHOUT staging it, and commit an unrelated
      // file. The filter must short-circuit before the generator ever runs.
      writeFileSync(
        join(tmpDir, 'hooks', '_lib', 'hook-import-set.json'),
        JSON.stringify({ generated_at: 'stale', head: 'stale', entries: [] }) + '\n',
      );
      writeFileSync(join(tmpDir, 'NOTES.md'), 'unrelated docs change\n');
      execFileSync('git', ['-C', tmpDir, 'add', 'NOTES.md']);
      const r = spawnSync('git', ['-C', tmpDir, 'commit', '-m', 'docs only'], { encoding: 'utf8' });
      expect(r.status).toBe(0);
    });
  });
});
