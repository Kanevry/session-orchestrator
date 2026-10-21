/**
 * migrate-ids.mjs (#1601/#1602, release-review on MR !148): the guards around
 * the one-line id rewrite. The end-to-end shapes (long id, all-digit id, flat
 * notes, sessions, `[REDACTED]` with the secret missing from env) are pinned in
 * tests/unit/vault-mirror.test.mjs and tests/lib/vault-mirror/process.test.mjs.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { makeTmpDir, removeTree } from '../../_helpers/tmp-fixture.mjs';
import { planIdMigration, applyIdMigration } from '../../../scripts/lib/vault-mirror/migrate-ids.mjs';

const MARKER = '_generator: session-orchestrator-vault-mirror@1';
const CLI = resolve(process.cwd(), 'scripts/lib/vault-mirror/migrate-ids.mjs');

const note = (id, { marker = true, repo } = {}) =>
  ['---', `id: ${id}`, 'type: learning', ...(repo ? [`source-repo: ${repo}`] : []), ...(marker ? [MARKER] : []), '---', '', 'Body [REDACTED] stays.', ''].join('\n');

describe('migrate-ids', () => {
  let dirs = [];
  afterEach(() => {
    for (const d of dirs) removeTree(d);
    dirs = [];
  });
  function vault(files) {
    const v = makeTmpDir('vm-migrate-ids-');
    dirs.push(v);
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(v, rel, '..'), { recursive: true });
      writeFileSync(join(v, rel), content);
    }
    return v;
  }

  // Bugs caught: a rewrite of a hand-written note (no generator marker), and a
  // vault-wide rewrite of every valid bare id when the operator only asked for
  // the schema repair.
  it('plans schema repairs only; bare ids need --include-bare; hand-written notes are never planned', () => {
    const v = vault({
      '40-learnings/repo-a/433.md': note('433'),
      '40-learnings/repo-a/fine.md': note('fine'),
      '40-learnings/repo-a/mine.md': note('433', { marker: false }),
    });
    expect(planIdMigration({ vaultDir: v }).changes).toEqual([
      { path: '40-learnings/repo-a/433.md', from: '433', to: 'repo-a-433', reason: 'schema' },
    ]);
    expect(planIdMigration({ vaultDir: v, includeBare: true }).changes.map((c) => [c.path, c.reason])).toEqual([
      ['40-learnings/repo-a/433.md', 'schema'],
      ['40-learnings/repo-a/fine.md', 'namespace'],
    ]);
  });

  // Bugs caught: two live notes migrated onto the same id (a flat legacy note
  // with `source-repo: repo-a` and its folder twin), trading one schema error
  // for a duplicate-id error; and the reverse — a live note left broken
  // because its `90-archive/` copy (which vault-sync never checks) shares the
  // target id.
  it('leaves two live notes with one target alone, but repairs a live note despite its archive copy', () => {
    const live = vault({
      '40-learnings/repo-a/433.md': note('433'),
      '40-learnings/433.md': note('433', { repo: 'repo-a' }),
    });
    const plan = planIdMigration({ vaultDir: live });
    expect(plan.changes).toEqual([]);
    expect(plan.conflicts.map((c) => c.path).sort()).toEqual(['40-learnings/433.md', '40-learnings/repo-a/433.md']);
    const r = spawnSync(process.execPath, [CLI, '--vault-dir', live, '--apply', '--max-changes', '0'], { encoding: 'utf8', env: { ...process.env, SO_VAULT_DIR: live } });
    expect(r.status).toBe(2); // the schema error stays, so --apply must not report success

    const archived = vault({
      '40-learnings/repo-a/433.md': note('433'),
      '90-archive/mirror/40-learnings/repo-a/433.md': note('433'),
    });
    const plan2 = planIdMigration({ vaultDir: archived });
    expect(plan2.conflicts).toEqual([]);
    expect(plan2.changes.map((c) => c.path)).toContain('40-learnings/repo-a/433.md');
  });

  // Bug caught: a note without an `id:` line planned as a repair that apply
  // can only skip, while the run still reported success (exit 0).
  it('reports a note without an id line as unrepairable, and --apply exits 2', () => {
    const noId = note('433').replace('id: 433\n', '');
    const v = vault({ '40-learnings/repo-a/433.md': noId });
    const plan = planIdMigration({ vaultDir: v });
    expect(plan.changes).toEqual([]);
    expect(plan.unrepairable).toEqual([{ path: '40-learnings/repo-a/433.md', reason: 'no-id-line' }]);
    const r = spawnSync(process.execPath, [CLI, '--vault-dir', v, '--apply', '--max-changes', '0'], { encoding: 'utf8', env: { ...process.env, SO_VAULT_DIR: v } });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('no id line');
    expect(readFileSync(join(v, '40-learnings/repo-a/433.md'), 'utf8')).toBe(noId);
  });

  // Bug caught: apply overwriting an edit made between the dry run and the
  // real run (the plan's bytes are stale).
  it('skips a note that changed after the plan', () => {
    const v = vault({ '40-learnings/repo-a/433.md': note('433') });
    const plan = planIdMigration({ vaultDir: v });
    const edited = note('433').replace('Body', 'Edited body');
    writeFileSync(join(v, '40-learnings/repo-a/433.md'), edited);
    const res = applyIdMigration(plan, { vaultDir: v, maxChanges: 1 });
    expect(res.skipped).toEqual([{ path: '40-learnings/repo-a/433.md', reason: 'changed-since-plan' }]);
    expect(readFileSync(join(v, '40-learnings/repo-a/433.md'), 'utf8')).toBe(edited);
  });

  // Bug caught: a real run started without a dry run first (no cap given).
  it('CLI: --apply without --max-changes writes nothing and exits 1', () => {
    const v = vault({ '40-learnings/repo-a/433.md': note('433') });
    const r = spawnSync(process.execPath, [CLI, '--vault-dir', v, '--apply'], { encoding: 'utf8', env: { ...process.env, SO_VAULT_DIR: v } });
    expect(r.status).toBe(1);
    expect(readFileSync(join(v, '40-learnings/repo-a/433.md'), 'utf8')).toBe(note('433'));
    const dry = spawnSync(process.execPath, [CLI, '--vault-dir', v], { encoding: 'utf8', env: { ...process.env, SO_VAULT_DIR: v } });
    expect(dry.status).toBe(0);
    expect(JSON.parse(dry.stdout.trim().split('\n').at(-1))).toMatchObject({ mode: 'dry-run', planned: 1 });
  });
});
