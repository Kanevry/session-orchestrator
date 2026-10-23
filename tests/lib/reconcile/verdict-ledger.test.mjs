/**
 * verdict-ledger.test.mjs — #1710 append-only reconcile verdict ledger.
 *
 * TV-001 — the bug this catches: a JSONL reader that silently skips a garbled
 * line reports a partial read as a clean ledger (measurement-discipline.md
 * § Unlesbare JSONL-Zeilen zaehlen). The ledger is appended without a lock by
 * concurrent worktree sessions, so a garbled line is its named revisit trigger
 * and must be COUNTED — and the count must reach the operator as a stderr WARN,
 * because no production caller reads `skipped`. Also pins F6: a verdict's
 * `processed_at` is not a run, so `lastRunAt` comes from run records only.
 * All disk access is under a mkdtemp dir.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { VERDICT_LEDGER_PATH, loadVerdictLedger } from '../../../scripts/lib/reconcile/verdict-ledger.mjs';

let root;
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('loadVerdictLedger', () => {
  it('counts and WARNs a garbled line, reads the valid records around it, and dates the last run from run records only', () => {
    root = mkdtempSync(join(tmpdir(), 'reconcile-verdict-ledger-'));
    mkdirSync(join(root, '.orchestrator', 'metrics'), { recursive: true });
    writeFileSync(
      join(root, VERDICT_LEDGER_PATH),
      [
        '{"kind":"verdict","learning_key":"anti-pattern/a","outcome":"rejected","processed_at":"2026-10-09T00:00:00.000Z","recorded_at":"2026-10-09T00:00:01.000Z"}',
        '{"kind":"verdict","learning_key":"anti-pat',
        '{"kind":"run","at":"2026-10-05T00:00:00.000Z"}',
        '',
      ].join('\n'),
      'utf8',
    );

    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let ledger;
    try {
      ledger = loadVerdictLedger(root);
      const warns = stderr.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('loadVerdictLedger'));
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain(join(root, VERDICT_LEDGER_PATH));
      expect(warns[0]).toContain('1 ');
    } finally {
      stderr.mockRestore();
    }
    expect(ledger.skipped).toBe(1);
    expect(ledger.present).toBe(true);
    expect([...ledger.terminalKeys]).toEqual([['anti-pattern/a', 'rejected']]);
    // The verdict (2026-10-09) is later than the run (2026-10-05) and must not date it.
    expect(ledger.lastRunAt).toBe('2026-10-05T00:00:00.000Z');
  });
});
