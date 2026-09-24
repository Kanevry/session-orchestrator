/**
 * Tests for scripts/lib/validate/check-learnings-shell-writes.mjs (GitHub #69 /
 * GitLab #1446) — the blocking gate against instruction prose that tells an
 * agent to write learnings.jsonl with a shell `>` / `>>`.
 *
 * Fixture trees are throwaway (non-git) dirs; the live repo is used only for
 * the CLI contract, pinning that the rewritten session-end/retro prose stays
 * clean.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { scanLearningsShellWrites } from '../../../scripts/lib/validate/check-learnings-shell-writes.mjs';
import { makeTmpDir, removeTree } from '../../_helpers/tmp-fixture.mjs';

const repoRoot = process.cwd();
const checkScript = path.join(repoRoot, 'scripts/lib/validate/check-learnings-shell-writes.mjs');

const roots = [];
afterEach(() => {
  for (const r of roots.splice(0)) removeTree(r);
});

/** Scan a one-file plugin root whose skill doc is `body`. */
function scanDoc(body) {
  const root = makeTmpDir('learnings-shell-writes-');
  roots.push(root);
  mkdirSync(path.join(root, 'skills', 'demo'), { recursive: true });
  writeFileSync(path.join(root, 'skills', 'demo', 'SKILL.md'), body);
  return scanLearningsShellWrites({ pluginRoot: root });
}

describe('scanLearningsShellWrites', () => {
  it.each([
    ['R2', 'Then write the result back with `>` to `.orchestrator/metrics/learnings.jsonl`.'],
    ['R1', 'cat x > "$ROOT/.orchestrator/metrics/learnings.jsonl"'],
    ['R1', 'echo "$LINE" >> learnings.jsonl'],
  ])('flags %s: %s', (rule, line) => {
    const res = scanDoc(`# Demo\n\n${line}\n`);
    expect(res.ok).toBe(false);
    expect(res.findings).toEqual([{ file: 'skills/demo/SKILL.md', line: 3, rule, text: line }]);
  });

  it.each([
    ['a prohibition on the line', 'NEVER write learnings.jsonl with `>` — use the CLI.'],
    ['a prohibition on the line above', 'Do not do this:\ncat x > learnings.jsonl'],
    ['an empty-file create', ': > "$F/learnings.jsonl"'],
    ['the marker on the line', 'cat x > learnings.jsonl <!-- learnings-write-check: prohibition -->'],
  ])('exempts %s', (_label, body) => {
    const res = scanDoc(`${body}\n`);
    expect(res.findings).toEqual([]);
    expect(res.summary.exempt).toBe(1);
  });

  it('passes a plain `<state-dir>/metrics/learnings.jsonl` mention (the boundary-regex false-positive class)', () => {
    const res = scanDoc('Read <state-dir>/metrics/learnings.jsonl before planning.\n');
    expect(res).toMatchObject({ ok: true, findings: [], summary: { mentions: 1, exempt: 0 } });
  });
});

describe('check-learnings-shell-writes CLI', () => {
  it('reports 0 failed on the live repo (the rewritten session-end/retro prose stays clean)', () => {
    const result = spawnSync(process.execPath, [checkScript, repoRoot], { encoding: 'utf8', timeout: 60_000 });
    expect(result.stdout).toContain('Results: 1 passed, 0 failed');
    expect(result.status).toBe(0);
  });
});
