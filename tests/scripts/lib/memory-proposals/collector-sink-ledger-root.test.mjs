/**
 * #1722 — the memory-proposal store, collector and sink must agree on ONE
 * ledger root when they run in a linked worktree of a repo that ignores
 * `.orchestrator/metrics/*.jsonl`. Bug class: the queue is written in one
 * checkout and read (or promoted) from another, so approved proposals vanish
 * with the worktree — or a path guard still validating against the worktree
 * root rejects the mapped main-checkout target.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { makeLinkedWorktree } from '../../../_helpers/linked-worktree.mjs';
import { _resetLedgerPathMemo } from '@lib/ledger-path.mjs';
import { createProposalRecord } from '@lib/memory-proposals/schema.mjs';
import { appendProposal } from '@lib/memory-proposals/store.mjs';
import { readProposalsJsonl } from '@lib/memory-proposals/collector.mjs';
import { writeApproved } from '@lib/memory-proposals/sink.mjs';

const lines = (file) =>
  existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0) : [];

describe('memory proposals in a linked worktree (#1722)', () => {
  let fx;
  afterEach(() => {
    fx?.cleanup();
    _resetLedgerPathMemo();
  });

  it('store, collector and sink all use the main checkout when the ledgers are ignored', async () => {
    fx = makeLinkedWorktree('mp-ledger-root-', { files: { '.gitignore': '.orchestrator/metrics/*.jsonl\n' } });
    const record = createProposalRecord({
      type: 'workflow-pattern',
      subject: 'ledger root agreement',
      insight: 'Queue and promotion must land in the same checkout.',
      evidence: 'Synthetic fixture for #1722.',
      confidence: 0.9,
      waveId: 'W1',
    });

    const appended = await appendProposal({ record, repoRoot: fx.wt, waveId: 'W1' });
    expect(appended.status).toBe('queued');
    expect(lines(path.join(fx.mainMetrics, 'proposals.jsonl'))).toHaveLength(1);
    expect(existsSync(path.join(fx.wtMetrics, 'proposals.jsonl'))).toBe(false);

    const queue = await readProposalsJsonl({ repoRoot: fx.wt });
    expect(queue).toHaveLength(1);

    const res = await writeApproved({ approved: queue, repoRoot: fx.wt, sessionId: 'sess-1722' });
    expect(res.errors).toEqual([]);
    expect(res.written).toBe(1);
    expect(lines(path.join(fx.mainMetrics, 'learnings.jsonl'))).toHaveLength(1);
    expect(existsSync(path.join(fx.wtMetrics, 'learnings.jsonl'))).toBe(false);
  });
});
