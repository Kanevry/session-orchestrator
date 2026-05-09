/**
 * tests/lib/harness-audit/categories/category4.test.mjs
 *
 * Vitest suite for scripts/lib/harness-audit/categories/category4.mjs
 *
 * Category 4: Persistence Health — checks state-md-schema,
 * sessions-jsonl-recent (30-day boundary), learnings-prunable, vault-sync-validator.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runCategory4 } from '../../../../scripts/lib/harness-audit/categories/category4.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'cat4-'));
}

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

function validStateMd() {
  return [
    '---',
    'schema-version: 1',
    'session-type: deep',
    'branch: main',
    'status: active',
    'current-wave: 1',
    'total-waves: 5',
    '---',
    '# Session State',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('runCategory4', () => {
  let root;

  beforeEach(() => {
    root = makeRoot();
    vi.useFakeTimers();
    // Pin "now" to 2026-05-09T08:00:00Z — the project's known current date.
    vi.setSystemTime(new Date('2026-05-09T08:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // -------------------------------------------------------------------------
  // Happy path — all 4 checks pass
  // -------------------------------------------------------------------------
  it('returns 4 passing checks when all persistence files are valid and recent', () => {
    // STATE.md with all required frontmatter keys
    ensureDir(join(root, '.claude'));
    writeFileSync(join(root, '.claude/STATE.md'), validStateMd());

    // sessions.jsonl — completed 1 day ago (well within 30-day threshold)
    ensureDir(join(root, '.orchestrator/metrics'));
    const recentDate = new Date('2026-05-08T10:00:00Z').toISOString();
    writeFileSync(
      join(root, '.orchestrator/metrics/sessions.jsonl'),
      JSON.stringify({ completed_at: recentDate, session_type: 'deep' }) + '\n',
    );

    // learnings.jsonl — valid entries with expires_at and confidence
    writeFileSync(
      join(root, '.orchestrator/metrics/learnings.jsonl'),
      JSON.stringify({ expires_at: '2026-06-01', confidence: 0.8, text: 'x' }) + '\n',
    );

    // No vault-integration enabled — vault-sync-validator auto-passes
    writeFileSync(join(root, 'CLAUDE.md'), '## Session Config\nsome: value\n');

    const checks = runCategory4(root);

    expect(checks).toHaveLength(4);
    expect(checks.every((c) => c.status === 'pass')).toBe(true);
    expect(checks[0].check_id).toBe('state-md-schema');
    expect(checks[1].check_id).toBe('sessions-jsonl-recent');
    expect(checks[2].check_id).toBe('learnings-prunable');
    expect(checks[3].check_id).toBe('vault-sync-validator');
  });

  // -------------------------------------------------------------------------
  // Failure case — STATE.md missing required keys
  // -------------------------------------------------------------------------
  it('fails state-md-schema when STATE.md is missing required frontmatter keys', () => {
    ensureDir(join(root, '.claude'));
    // Only has schema-version; missing all others
    writeFileSync(
      join(root, '.claude/STATE.md'),
      '---\nschema-version: 1\n---\n# Session State\n',
    );

    const checks = runCategory4(root);
    const stateMdCheck = checks.find((c) => c.check_id === 'state-md-schema');

    expect(stateMdCheck).toBeDefined();
    expect(stateMdCheck.status).toBe('fail');
    expect(stateMdCheck.points).toBe(0);
    // All 5 missing keys should be reported
    expect(stateMdCheck.evidence.missingKeys).toContain('session-type');
    expect(stateMdCheck.evidence.missingKeys).toContain('branch');
    expect(stateMdCheck.evidence.missingKeys).toContain('total-waves');
  });

  // -------------------------------------------------------------------------
  // Edge case — 30-day boundary: exactly 29 days ago passes, 31 days fails
  // -------------------------------------------------------------------------
  it('passes sessions-jsonl-recent for 29-day-old entry but fails for 31-day-old entry', () => {
    ensureDir(join(root, '.orchestrator/metrics'));

    // 29 days ago relative to pinned now (2026-05-09T08:00:00Z)
    const twentyNineDaysAgo = new Date('2026-04-10T08:00:00Z').toISOString();
    const thirtyOneDaysAgo = new Date('2026-04-08T08:00:00Z').toISOString();

    // --- Test 29 days ---
    writeFileSync(
      join(root, '.orchestrator/metrics/sessions.jsonl'),
      JSON.stringify({ completed_at: twentyNineDaysAgo }) + '\n',
    );
    const checks29 = runCategory4(root);
    const recent29 = checks29.find((c) => c.check_id === 'sessions-jsonl-recent');
    expect(recent29.status).toBe('pass');
    expect(recent29.evidence.ageInDays).toBe(29);

    // --- Test 31 days ---
    writeFileSync(
      join(root, '.orchestrator/metrics/sessions.jsonl'),
      JSON.stringify({ completed_at: thirtyOneDaysAgo }) + '\n',
    );
    const checks31 = runCategory4(root);
    const recent31 = checks31.find((c) => c.check_id === 'sessions-jsonl-recent');
    expect(recent31.status).toBe('fail');
    expect(recent31.evidence.ageInDays).toBe(31);
    expect(recent31.message).toContain('> 30 day threshold');
  });

  // -------------------------------------------------------------------------
  // Edge case — sessions.jsonl file missing
  // -------------------------------------------------------------------------
  it('fails sessions-jsonl-recent when sessions.jsonl does not exist', () => {
    // Do not create the sessions.jsonl file
    const checks = runCategory4(root);
    const recentCheck = checks.find((c) => c.check_id === 'sessions-jsonl-recent');

    expect(recentCheck.status).toBe('fail');
    expect(recentCheck.evidence.latestCompletedAt).toBeNull();
    expect(recentCheck.message).toContain('missing');
  });

  // -------------------------------------------------------------------------
  // Edge case — learnings.jsonl has entries without expires_at
  // -------------------------------------------------------------------------
  it('fails learnings-prunable when entries lack expires_at', () => {
    ensureDir(join(root, '.orchestrator/metrics'));
    // Entry without expires_at
    writeFileSync(
      join(root, '.orchestrator/metrics/learnings.jsonl'),
      JSON.stringify({ confidence: 0.7, text: 'no expiry here' }) + '\n',
    );

    const checks = runCategory4(root);
    const prunable = checks.find((c) => c.check_id === 'learnings-prunable');

    expect(prunable.status).toBe('fail');
    expect(prunable.evidence.allHaveExpires).toBe(false);
  });
});
