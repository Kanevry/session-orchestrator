/**
 * sweep-expired-rules.test.mjs — the CLI's roll-up (#1388 P7).
 *
 * TV-001 — the bug this catches: a HEADER-RAISE is an `action: 'rewrite'` plan
 * carrying `reason: 'header-raise'`, so it was folded into `rewrites` and
 * invisible on the human stdout line. Nothing else in the suite exercises
 * `summarize()` (census 2026-09-18: `grep -rn "summarize" tests/ docs/ skills/`
 * → no hit for this CLI), so dropping the counter again would be silent.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { summarize } from '../../scripts/sweep-expired-rules.mjs';

const cli = fileURLToPath(new URL('../../scripts/sweep-expired-rules.mjs', import.meta.url));

describe('CLI input errors before Apply (#1579)', () => {
  let root;
  let repoRoot;
  let protectedPaths;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sweep-input-'));
    repoRoot = join(root, 'repo');
    protectedPaths = [
      join(repoRoot, '.claude/rules/fixture.md'),
      join(repoRoot, '.orchestrator/runtime/reconcile-candidates.jsonl'),
      join(repoRoot, '.orchestrator/metrics/events.jsonl'),
    ];
    for (const file of protectedPaths) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, '');
    }
    // An expired single-entry rule makes the old empty-index fallback plan a
    // delete. The error must stop Apply before deletion, stamping, or events.
    writeFileSync(protectedPaths[0], `---
auto-generated: true
learning-key: anti-pattern/fixture
expires-at: 2020-01-01
---
# Fixture

Body prose.

## Provenance
- learning-key: \`anti-pattern/fixture\`
- learning-id: \`id-fixture\`
`);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function run(args, preload = null) {
    const home = mkdtempSync(join(root, 'home-'));
    const navigator = mkdtempSync(join(root, 'navigator-'));
    const vault = mkdtempSync(join(root, 'vault-'));
    const result = spawnSync(process.execPath, [
      ...(preload ? ['--import', preload] : []),
      cli, '--repo-root', repoRoot, '--now', '2026-06-01T00:00:00.000Z', '--json', ...args,
    ], {
      cwd: repoRoot,
      env: { ...process.env, HOME: home, NAVIGATOR_CONFIG_DIR: navigator, SO_VAULT_DIR: vault },
      encoding: 'utf8',
      timeout: 10000,
    });
    expect(result.error).toBeUndefined();
    return result;
  }

  it.each(['--dry-run', '--apply'])('rejects absolute --learnings before %s', (mode) => {
    const store = join(repoRoot, '.orchestrator/metrics/learnings.jsonl');
    writeFileSync(store, '');
    const before = protectedPaths.map((file) => readFileSync(file));
    const result = run([mode, '--learnings', store]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--learnings requires a repo-relative path');
    expect(result.stdout).toBe('');
    expect(protectedPaths.map((file) => readFileSync(file))).toEqual(before);
  });

  it.each([
    ['--dry-run', []], ['--apply', []],
    ['--dry-run', ['--learnings', 'missing.jsonl']],
    ['--apply', ['--learnings', 'missing.jsonl']],
  ])('fails on a missing store before %s (%j)', (mode, args) => {
    const before = protectedPaths.map((file) => readFileSync(file));
    const result = run([mode, ...args]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('planning failed:');
    expect(result.stderr).toContain('ENOENT');
    expect(result.stdout).toBe('');
    expect(protectedPaths.map((file) => readFileSync(file))).toEqual(before);
  });

  it('propagates an injected EACCES to Exit 2 without Apply side effects', () => {
    writeFileSync(join(repoRoot, '.orchestrator/metrics/learnings.jsonl'), '');
    const before = protectedPaths.map((file) => readFileSync(file));
    // Inject only the real FS-read failure in the CLI child, not the planner
    // or its error handler. No chmod/root-dependent permission assumptions.
    // The path is native (backslash on Windows); backslashes are doubled because
    // this source lives in a template literal.
    const preload = 'data:text/javascript,' + encodeURIComponent(`
      import fs from 'node:fs/promises';
      import { syncBuiltinESMExports } from 'node:module';
      const readFile = fs.readFile;
      fs.readFile = (file, ...args) => /[\\\\/]learnings\\.jsonl$/.test(String(file))
        ? Promise.reject(Object.assign(new Error('read denied'), { code: 'EACCES' }))
        : readFile(file, ...args);
      syncBuiltinESMExports();
    `);
    const result = run(['--apply'], preload);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('planning failed: read denied');
    expect(result.stdout).toBe('');
    expect(protectedPaths.map((file) => readFileSync(file))).toEqual(before);
  });

  it.each([
    { args: [], store: '.orchestrator/metrics/learnings.jsonl' },
    { args: ['--learnings', 'empty.jsonl'], store: 'empty.jsonl' },
  ])('accepts a readable empty store ($store)', ({ args, store }) => {
    writeFileSync(join(repoRoot, store), '');
    const result = run(['--dry-run', ...args]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ dry_run: true, files_scanned: 1, malformed_lines: 0 });
  });
});

describe('--horizon-days (#1779)', () => {
  // Bug: Claude Code ignores `expires-at`, so an entry that expires between two
  // housekeeping sweeps keeps loading natively until the NEXT sweep. The
  // horizon sweeps what would expire before then; the clock is injected.
  let root;
  const rulesDir = () => join(root, '.claude/rules');

  function writeSingleEntryRule(name, id, expiresAt) {
    writeFileSync(join(rulesDir(), name), `---
auto-generated: true
learning-key: anti-pattern/${id}
expires-at: ${expiresAt}
---
# Fixture ${id}

Body prose.

## Provenance
- learning-key: \`anti-pattern/${id}\`
- learning-id: \`${id}\`
`);
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sweep-horizon-'));
    mkdirSync(rulesDir(), { recursive: true });
    mkdirSync(join(root, '.orchestrator/metrics'), { recursive: true });
    writeSingleEntryRule('soon.md', 'id-soon', '2026-06-04');
    writeSingleEntryRule('later.md', 'id-later', '2026-06-11');
    const record = (id, expiresAt) => JSON.stringify({
      id, type: 'anti-pattern', subject: id, insight: `insight for ${id}`, confidence: 0.8,
      file_paths: ['scripts/lib/x.mjs'], created_at: '2026-01-01T00:00:00.000Z', expires_at: expiresAt,
    });
    writeFileSync(join(root, '.orchestrator/metrics/learnings.jsonl'),
      `${record('id-soon', '2026-06-04T00:00:00.000Z')}\n${record('id-later', '2026-06-11T00:00:00.000Z')}\n`);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function run(args) {
    return spawnSync(process.execPath, [
      cli, '--repo-root', root, '--now', '2026-06-01T00:00:00.000Z', '--json', ...args,
    ], { cwd: root, env: { ...process.env, HOME: root, SO_VAULT_DIR: root }, encoding: 'utf8', timeout: 10000 });
  }

  const actions = (stdout) =>
    Object.fromEntries(JSON.parse(stdout).plans.map((p) => [p.file, p.action]));

  it('without a horizon both entries are still live', () => {
    const result = run(['--dry-run']);
    expect(result.status).toBe(0);
    expect(actions(result.stdout)).toEqual({ 'later.md': 'keep', 'soon.md': 'keep' });
  });

  it('--horizon-days 7 sweeps the entry expiring in 3 days and keeps the one in 10', () => {
    const result = run(['--dry-run', '--horizon-days', '7']);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).horizon_days).toBe(7);
    expect(actions(result.stdout)).toEqual({ 'later.md': 'keep', 'soon.md': 'delete' });
  });

  it.each(['-1', '1.5', 'abc', ''])('rejects --horizon-days %j with exit 1', (value) => {
    const result = run(['--dry-run', '--horizon-days', value]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--horizon-days requires a non-negative integer');
    expect(result.stdout).toBe('');
  });
});

/** Minimal plan shape — only the fields `summarize()` reads. */
function planStub(plans) {
  return {
    plans: plans.map((p) => ({
      expiredPairIds: [],
      unresolvedPairIds: [],
      ...p,
    })),
    malformedLines: 0,
    ok: true,
    skipped: [],
  };
}

describe('summarize() — header-raise roll-up (#1388 P7)', () => {
  it('counts header-raises separately while keeping them inside rewrites', () => {
    const summary = summarize(
      planStub([
        { file: 'a.md', action: 'rewrite', reason: 'header-raise' },
        { file: 'b.md', action: 'rewrite', reason: 'expired-entries', expiredPairIds: ['x'] },
        { file: 'c.md', action: 'delete', reason: 'expired-entries' },
        { file: 'd.md', action: 'keep', reason: null },
      ]),
      { dryRun: true, graceDays: 0 },
      null,
    );

    expect(summary.rewrites).toBe(2); // header-raise is a SUBSET, not a sibling
    expect(summary.header_raises).toBe(1);
    expect(summary.deletes).toBe(1);
    expect(summary.keeps).toBe(1);
    expect(summary.files_scanned).toBe(4);
    expect(summary.expired_entries).toBe(1);
  });

  it('reports 0 header-raises when every rewrite has another reason', () => {
    const summary = summarize(
      planStub([{ file: 'a.md', action: 'rewrite', reason: 'expired-entries' }]),
      { dryRun: false, graceDays: 2 },
      null,
    );
    expect(summary.rewrites).toBe(1);
    expect(summary.header_raises).toBe(0);
  });
});
