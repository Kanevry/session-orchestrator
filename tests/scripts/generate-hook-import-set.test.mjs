/**
 * tests/scripts/generate-hook-import-set.test.mjs
 *
 * scripts/generate-hook-import-set.mjs — the committed hook-reachable module
 * allowlist consumed by hooks/post-edit-import-probe.mjs (GitLab #1224).
 *
 * Bugs these cases catch:
 *   - a crawl that stops at depth 1, so a module imported by a hook's HELPER
 *     (the 2026-09-04 incident shape) never lands in the set and the probe
 *     silently ignores exactly the file class it exists for
 *   - reachable_from losing the hook attribution, which is the blast-radius
 *     line in the operator warning
 *   - a committed set drifting away from the manifests with nothing failing
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

import { buildImportSet, main } from '../../scripts/generate-hook-import-set.mjs';

let root;

/** Build a tmp plugin root with a 2-level import chain behind one hook entry. */
function scaffold() {
  mkdirSync(path.join(root, 'hooks', '_lib'), { recursive: true });
  mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });

  writeFileSync(path.join(root, 'hooks', 'hooks.json'), JSON.stringify({
    hooks: {
      PreToolUse: [{
        matcher: 'Bash',
        hooks: [{
          type: 'command',
          command: 'sh "$CLAUDE_PLUGIN_ROOT/hooks/run-node.sh" "$CLAUDE_PLUGIN_ROOT/hooks/entry.mjs"',
          timeout: 5,
        }],
      }],
    },
  }, null, 2), 'utf8');

  writeFileSync(path.join(root, 'hooks', 'entry.mjs'),
    "import { helper } from './_lib/helper.mjs';\nexport const x = helper;\n", 'utf8');
  writeFileSync(path.join(root, 'hooks', '_lib', 'helper.mjs'),
    "import { deep } from '../../scripts/lib/deep.mjs';\nexport const helper = deep;\n", 'utf8');
  writeFileSync(path.join(root, 'scripts', 'lib', 'deep.mjs'),
    'export const deep = 1;\n', 'utf8');
  // Not imported by anything — must NOT appear in the set.
  writeFileSync(path.join(root, 'scripts', 'lib', 'unreached.mjs'),
    'export const nope = 1;\n', 'utf8');
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'hook-import-set-'));
  scaffold();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('generate-hook-import-set', () => {
  it('follows the import chain two levels deep and attributes every module to its hook', () => {
    const entries = buildImportSet(root);
    const files = entries.map((e) => e.file);

    expect(files).toContain('hooks/entry.mjs');
    expect(files).toContain('hooks/_lib/helper.mjs');
    // The load-bearing case: reached only THROUGH the helper.
    expect(files).toContain('scripts/lib/deep.mjs');
    expect(files).not.toContain('scripts/lib/unreached.mjs');

    const deep = entries.find((e) => e.file === 'scripts/lib/deep.mjs');
    expect(deep.reachable_from).toEqual(['entry.mjs']);
  });

  it('--check exits 1 when the committed set drifts from the manifests', () => {
    const out = path.join(root, 'hooks', '_lib', 'hook-import-set.json');

    expect(main(['node', 'gen', '--plugin-root', root, '--out', out])).toBe(0);
    expect(main(['node', 'gen', '--plugin-root', root, '--out', out, '--check'])).toBe(0);

    // Drift: a new module joins the chain but nobody regenerates.
    writeFileSync(path.join(root, 'scripts', 'lib', 'added.mjs'), 'export const y = 2;\n', 'utf8');
    writeFileSync(path.join(root, 'scripts', 'lib', 'deep.mjs'),
      "import { y } from './added.mjs';\nexport const deep = y;\n", 'utf8');

    expect(main(['node', 'gen', '--plugin-root', root, '--out', out, '--check'])).toBe(1);

    // …and 0 again once regenerated.
    expect(main(['node', 'gen', '--plugin-root', root, '--out', out])).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8')).entries.map((e) => e.file))
      .toContain('scripts/lib/added.mjs');
    expect(main(['node', 'gen', '--plugin-root', root, '--out', out, '--check'])).toBe(0);
  });

  it('--check exits 1 when the committed file is missing', () => {
    const out = path.join(root, 'hooks', '_lib', 'does-not-exist.json');
    expect(main(['node', 'gen', '--plugin-root', root, '--out', out, '--check'])).toBe(1);
  });

  it('runs the CLI body when invoked through a SYMLINKED absolute path', () => {
    // The bug: the entry guard compared `import.meta.url` against a hand-built
    // `file://${process.argv[1]}`. Any path that differs from its realpath —
    // a symlink, and `/tmp` → `/private/tmp` on macOS — made the compare false,
    // so the CLI printed nothing and exited 0. Every caller that judged the
    // gate by exit code alone (husky, CI) was therefore fail-OPEN.
    const link = path.join(root, 'gen-link.mjs');
    symlinkSync(path.resolve(import.meta.dirname, '../../scripts/generate-hook-import-set.mjs'), link);

    const out = path.join(root, 'hooks', '_lib', 'hook-import-set.json');
    const write = spawnSync(process.execPath, [link, '--plugin-root', root, '--out', out], { encoding: 'utf8' });
    expect(write.status).toBe(0);
    expect(write.stdout).toMatch(/wrote \d+ modules/);

    const check = spawnSync(process.execPath, [link, '--plugin-root', root, '--out', out, '--check'], { encoding: 'utf8' });
    expect(check.status).toBe(0);
    expect(check.stdout).toMatch(/\d+ modules, in sync/);
  });

  it('the committed set covers the module of the 2026-09-04 incident', () => {
    // The probe is a no-op for anything outside the committed set, so the one
    // repo-level invariant worth pinning is that the incident's own module is
    // IN it and carries its hook attribution. (Full set-vs-manifest equality is
    // the `--check` CLI's job, not a suite assertion: it would go red for every
    // unrelated import added anywhere in the graph until someone regenerates.)
    const repoRoot = path.resolve(import.meta.dirname, '../..');
    const committed = JSON.parse(
      readFileSync(path.join(repoRoot, 'hooks', '_lib', 'hook-import-set.json'), 'utf8'),
    );
    const incident = committed.entries.find(
      (e) => e.file === 'scripts/lib/session-identity/own-session.mjs',
    );
    expect(incident, 'own-session.mjs must be in the hook-reachable set').toBeDefined();
    expect(incident.reachable_from).toContain('enforce-scope.mjs');
    expect(incident.reachable_from).toContain('enforce-commands.mjs');
  });
});
