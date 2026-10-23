/**
 * tests/lib/ledger-path.test.mjs
 *
 * The decision table of `resolveLedgerPath` (#1722). Each row is a bug the
 * suite would otherwise miss:
 *   - ignored ledger in a linked worktree → main checkout (else: lost with the
 *     worktree, the #1722 leak);
 *   - tracked ledger in a linked worktree → the worktree's own copy (else: a
 *     write into another session's working tree in the 27 fleet repos that
 *     version their ledgers, and a branch without the record);
 *   - main checkout → its own path, no mapping;
 *   - absolute path → unchanged (explicit overrides stay explicit);
 *   - a root BELOW the worktree top level → local (else an ignored subdir such
 *     as node_modules/ answered "ignored" and the ledger landed inside the main
 *     checkout's copy of that subdir — review finding 2026-10-22);
 *   - git cannot answer → local (never a write into a foreign tree on an
 *     unmeasured answer).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { resolveLedgerPath, _resetLedgerPathMemo } from '../../scripts/lib/ledger-path.mjs';
import { makeLinkedWorktree } from '../_helpers/linked-worktree.mjs';

const REL = '.orchestrator/metrics/learnings.jsonl';
const cleanups = [];

afterEach(() => {
  _resetLedgerPathMemo();
  while (cleanups.length) cleanups.pop()();
});

describe('resolveLedgerPath (#1722)', () => {
  it('maps an ignored ledger from a linked worktree to the main checkout', () => {
    const fx = makeLinkedWorktree('ledger-ignored-', { files: { '.gitignore': '.orchestrator/metrics/*.jsonl\n' } });
    cleanups.push(fx.cleanup);
    expect(resolveLedgerPath(REL, fx.wt)).toBe(path.join(fx.main, REL));
  });

  it('keeps a tracked ledger in the linked worktree', () => {
    const fx = makeLinkedWorktree('ledger-tracked-', {
      files: { '.gitignore': '.orchestrator/metrics/*.jsonl\n', [REL]: '' },
    });
    cleanups.push(fx.cleanup);
    expect(resolveLedgerPath(REL, fx.wt)).toBe(path.join(fx.wt, REL));
  });

  it('leaves the main checkout and absolute paths alone', () => {
    const fx = makeLinkedWorktree('ledger-main-', { files: { '.gitignore': '.orchestrator/metrics/*.jsonl\n' } });
    cleanups.push(fx.cleanup);
    expect(resolveLedgerPath(REL, fx.main)).toBe(path.join(fx.main, REL));
    const abs = path.join(fx.wt, REL);
    expect(resolveLedgerPath(abs, fx.main)).toBe(abs);
  });

  it('keeps the local path below the top level and when git cannot answer', () => {
    const fx = makeLinkedWorktree('ledger-local-', { files: { '.gitignore': 'node_modules/\n.orchestrator/metrics/*.jsonl\n' } });
    cleanups.push(fx.cleanup);
    const sub = path.join(fx.wt, 'node_modules');
    mkdirSync(sub, { recursive: true });
    expect(resolveLedgerPath(REL, sub)).toBe(path.join(sub, REL));

    const savedPath = process.env.PATH;
    process.env.PATH = '';
    try {
      expect(resolveLedgerPath(REL, fx.wt)).toBe(path.join(fx.wt, REL));
    } finally {
      process.env.PATH = savedPath;
    }
  });
});
