/**
 * tests/lib/maintenance-due-banner.test.mjs
 *
 * The probe replaces three separate nudges with ONE session-start reading, so
 * its failure modes are all "the maintenance loop runs empty and nothing says
 * so" — or the inverse, HR-101: a banner that fires on every start and teaches
 * the operator to ignore banners. Each case below names the concrete bug it
 * catches (TV-001).
 *
 * SAFETY: every case pins `repoRoot` to a throwaway tmpdir and `SO_VAULT_DIR` /
 * `CLAUDE_PROJECT_DIR` to another, so nothing reaches the real repo ledgers or
 * the operator's vault (CLAUDE.md § `vault-dir` resolves HOST-LOCALLY).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  checkMaintenanceDue,
  computeMaintenanceDue,
  MAINTENANCE_TOTAL_SIGNALS,
  MAINTENANCE_MIN_LEARNINGS,
  HOUSEKEEPING_COOLDOWN_DAYS,
} from '@lib/maintenance-due-banner.mjs';

let tmpRepo;
let savedEnv;

beforeEach(() => {
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'maintenance-due-repo-'));
  savedEnv = {
    SO_VAULT_DIR: process.env.SO_VAULT_DIR,
    CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
  };
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'maintenance-due-vault-'));
  process.env.SO_VAULT_DIR = vault;
  process.env.CLAUDE_PROJECT_DIR = vault;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const metricsDir = () => path.join(tmpRepo, '.orchestrator', 'metrics');

function writeMetrics(name, lines) {
  fs.mkdirSync(metricsDir(), { recursive: true });
  fs.writeFileSync(path.join(metricsDir(), name), lines.join('\n') + '\n', 'utf8');
}

/** One learning line. `expiresAt` set ⇒ sweep-eligible once past the 14d grace. */
function learning(i, { expiresAt } = {}) {
  const obj = {
    id: `learn-${i}`,
    type: 'convention',
    subject: `subject-${i}`,
    insight: 'test insight',
    evidence: 'test evidence',
    confidence: 0.9,
    source_session: 'main-2026-01-01-1',
    created_at: '2026-01-01T00:00:00.000Z',
    schema_version: 1,
  };
  if (expiresAt) obj.expires_at = expiresAt;
  return JSON.stringify(obj);
}

/** N active learnings + optional M long-expired ones. */
function writeLearnings(active, expired = 0) {
  const longAgo = new Date(Date.now() - 400 * 86_400_000).toISOString();
  const lines = [
    ...Array.from({ length: active }, (_, i) => learning(i)),
    ...Array.from({ length: expired }, (_, i) => learning(1000 + i, { expiresAt: longAgo })),
  ];
  writeMetrics('learnings.jsonl', lines);
}

// ---------------------------------------------------------------------------

describe('checkMaintenanceDue', () => {
  // BUG (HR-101): an instrument that warns on a repo with nothing to maintain
  // fires on essentially every session start and is worthless within a week.
  it('is silent when nothing is due', async () => {
    const result = await checkMaintenanceDue({ repoRoot: tmpRepo, config: {} });
    expect(result).toBeNull();

    const computed = await computeMaintenanceDue({ repoRoot: tmpRepo, config: {} });
    expect(computed.due).toEqual([]);
    expect(computed.undeterminable).toEqual([]);
    expect(computed.total).toBe(MAINTENANCE_TOTAL_SIGNALS);
    expect(computed.lastHousekeeping).toBeNull();
  });

  // BUG (HR-106): a bare "4 of 6" tells the operator nothing about WHICH signal
  // fired or what number drove it — the banner must carry the numbers the
  // verdict was computed from, and must list only signals that are actually due.
  it('lists exactly the due signals with their driving numbers', async () => {
    writeLearnings(MAINTENANCE_MIN_LEARNINGS + 5, 3);

    const computed = await computeMaintenanceDue({ repoRoot: tmpRepo, config: {} });
    expect(computed.due.map((d) => d.id)).toEqual(['evolve', 'reconcile', 'sweep']);
    expect(computed.undeterminable).toEqual([]);

    const result = await checkMaintenanceDue({ repoRoot: tmpRepo, config: {} });
    expect(result?.severity).toBe('warn');
    expect(result.message).toContain('⚠ maintenance due: 3 of 6');
    expect(result.message).toContain(`evolve: never, ${MAINTENANCE_MIN_LEARNINGS + 5} active learnings`);
    expect(result.message).toContain('reconcile: never');
    expect(result.message).toContain('sweep: 3 expired');
    expect(result.message).toContain('run /session housekeeping.');
    // Signals that are NOT due must not appear at all.
    expect(result.message).not.toContain('dialectic:');
    expect(result.message).not.toContain('memory-cleanup:');
    expect(result.message).not.toContain('undeterminable');
  });

  // BUG: without a cooldown the banner keeps demanding /session housekeeping
  // right after one ran — the signals need a whole session to clear, so the
  // instrument would nag through every start of the following week.
  it('suppresses the banner after a recent housekeeping session, without suppressing the computation', async () => {
    writeLearnings(MAINTENANCE_MIN_LEARNINGS + 5, 3);
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
    writeMetrics('sessions.jsonl', [
      JSON.stringify({
        session_id: 'aaaaaaaa-0000-4000-8000-000000000001',
        session_type: 'housekeeping',
        started_at: twoDaysAgo,
        completed_at: twoDaysAgo,
        status: 'completed',
      }),
    ]);

    expect(await checkMaintenanceDue({ repoRoot: tmpRepo, config: {} })).toBeNull();

    const computed = await computeMaintenanceDue({ repoRoot: tmpRepo, config: {} });
    expect(computed.lastHousekeeping).toBe(twoDaysAgo);
    expect(computed.due.map((d) => d.id)).toContain('reconcile');

    // …and the suppression expires: the same fixture read from a clock past the
    // cooldown must warn again, or the cooldown would be a permanent mute.
    const later = Date.now() + (HOUSEKEEPING_COOLDOWN_DAYS + 1) * 86_400_000;
    const afterCooldown = await checkMaintenanceDue({
      repoRoot: tmpRepo,
      config: {},
      now: later,
    });
    expect(afterCooldown?.severity).toBe('warn');
  });

  // BUG (three-state): an unreadable ledger read as "no evolve run on record"
  // would report a DUE signal it never measured — and read as clean it would
  // hide one. Neither: it goes to `undeterminable`, and the banner says so.
  it('records an unreadable events.jsonl as undeterminable, never as clean', async () => {
    writeLearnings(MAINTENANCE_MIN_LEARNINGS + 5);
    // A directory where a file is expected: readFileSync throws EISDIR.
    fs.mkdirSync(path.join(metricsDir(), 'events.jsonl'), { recursive: true });

    const computed = await computeMaintenanceDue({ repoRoot: tmpRepo, config: {} });
    expect(computed.undeterminable).toContain('evolve');
    expect(computed.due.map((d) => d.id)).not.toContain('evolve');

    const result = await checkMaintenanceDue({ repoRoot: tmpRepo, config: {} });
    expect(result.message).toContain('undeterminable: evolve');
  });

  // BUG: a probe that reads a RECORDED evolve run as "never" would nag a repo
  // that is already running the loop — the absence claim must be falsifiable.
  it('clears the evolve signal when the ledger carries a completed run', async () => {
    writeLearnings(MAINTENANCE_MIN_LEARNINGS + 5);
    writeMetrics('events.jsonl', [
      JSON.stringify({ event: 'subagent_stop', timestamp: '2026-01-01T00:00:00Z' }),
      JSON.stringify({
        event: 'orchestrator.evolve.completed',
        timestamp: '2026-09-01T10:00:00.000Z',
      }),
    ]);

    const computed = await computeMaintenanceDue({ repoRoot: tmpRepo, config: {} });
    expect(computed.due.map((d) => d.id)).not.toContain('evolve');
    expect(computed.undeterminable).toEqual([]);
  });

  // BUG: a stale pending proposal is archaeology, not a nudge — re-raising a
  // months-old sidecar every start is the HR-101 failure mode again.
  it('counts a fresh pending sidecar and ignores an aged one', async () => {
    fs.mkdirSync(path.join(tmpRepo, '.orchestrator'), { recursive: true });
    const sidecar = path.join(tmpRepo, '.orchestrator', 'pending-dream.md');
    fs.writeFileSync(sidecar, '# pending\n', 'utf8');

    const fresh = await computeMaintenanceDue({ repoRoot: tmpRepo, config: {} });
    expect(fresh.due.map((d) => d.id)).toContain('pending-sidecar');

    const old = new Date(Date.now() - 40 * 86_400_000);
    fs.utimesSync(sidecar, old, old);
    const aged = await computeMaintenanceDue({ repoRoot: tmpRepo, config: {} });
    expect(aged.due.map((d) => d.id)).not.toContain('pending-sidecar');
  });

  // BUG (HR-106): a constant `total: 6` reports a denominator the rule never
  // judged — with `dialectic.cadence: 0` the dialectic signal is never
  // evaluated, so "3 of 6" on such a host quotes a number nothing measured.
  it('the denominator counts the signals actually evaluated, not the constant 6', async () => {
    writeLearnings(MAINTENANCE_MIN_LEARNINGS + 5, 3);
    const config = { dialectic: { cadence: 0 } };

    const computed = await computeMaintenanceDue({ repoRoot: tmpRepo, config });
    expect(computed.skipped).toEqual(['dialectic']);
    expect(computed.total).toBe(5);
    // A skipped signal is neither due nor undeterminable — it was not judged.
    expect(computed.undeterminable).toEqual([]);
    expect(computed.due.map((d) => d.id)).toEqual(['evolve', 'reconcile', 'sweep']);

    const result = await checkMaintenanceDue({ repoRoot: tmpRepo, config });
    expect(result.message).toContain('⚠ maintenance due: 3 of 5');
  });

  // BUG (HR-106, second kill-switch): the memory-cleanup signal is skipped on a
  // non-Claude harness. Counting it would report a denominator that includes a
  // signal this platform structurally cannot evaluate.
  it('drops the memory-cleanup signal from the denominator on a non-Claude platform', async () => {
    writeLearnings(MAINTENANCE_MIN_LEARNINGS + 5, 3);

    const computed = await computeMaintenanceDue({
      repoRoot: tmpRepo,
      config: {},
      platform: 'codex',
    });
    expect(computed.skipped).toEqual(['memory-cleanup']);
    expect(computed.total).toBe(5);
  });

  // BUG: `decideAndRecordAutoDialectic` advances `.orchestrator/dialectic-last-run`.
  // A probe calling it would consume the signal it reports — every session start
  // would silently reset the cadence the session-end phase depends on.
  it('writes nothing to the repo it measures', async () => {
    writeLearnings(MAINTENANCE_MIN_LEARNINGS + 5, 3);
    const before = fs.readdirSync(path.join(tmpRepo, '.orchestrator'), { recursive: true }).sort();
    await checkMaintenanceDue({ repoRoot: tmpRepo, config: {} });
    const after = fs.readdirSync(path.join(tmpRepo, '.orchestrator'), { recursive: true }).sort();
    expect(after).toEqual(before);
  });
});
