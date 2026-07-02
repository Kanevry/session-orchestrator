/**
 * tests/lib/reconcile-nudge-banner.test.mjs — #723 Epic B1
 *
 * Every case writes into an isolated tmpdir repo — never touches the real
 * `.orchestrator/metrics/learnings.jsonl` or `.orchestrator/runtime/
 * reconcile-candidates.jsonl` in this repo, so results stay deterministic
 * regardless of the host repo's live corpus.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  checkReconcileNudge,
  computeReconcileNudge,
  NUDGE_MIN_LEARNINGS,
  NUDGE_MIN_DELTA,
  NUDGE_MIN_ELIGIBLE,
} from '@lib/reconcile-nudge-banner.mjs';

let tmpRepo;

beforeEach(() => {
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-nudge-repo-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

/** Build one JSONL learning line. No `expires_at` → never treated as expired. */
function learningLine({ type = 'convention', confidence = 0.8, file_paths, id } = {}, i = 0) {
  const obj = {
    id: id ?? `id-${i}`,
    type,
    subject: `subject-${i}`,
    insight: 'test insight',
    evidence: 'test evidence',
    confidence,
    source_session: 'main-2026-01-01-1',
    created_at: '2026-01-01T00:00:00.000Z',
    schema_version: 1,
  };
  if (file_paths) obj.file_paths = file_paths;
  return JSON.stringify(obj);
}

/** Write N learning lines (all same shape, unique id/subject) to <repo>/.orchestrator/metrics/learnings.jsonl. */
function writeLearnings(repo, count, opts = {}) {
  const dir = path.join(repo, '.orchestrator', 'metrics');
  fs.mkdirSync(dir, { recursive: true });
  const lines = Array.from({ length: count }, (_, i) => learningLine(opts, i));
  fs.writeFileSync(path.join(dir, 'learnings.jsonl'), lines.join('\n') + '\n', 'utf8');
}

/** Write raw (possibly malformed) content to learnings.jsonl. */
function writeRawLearnings(repo, content) {
  const dir = path.join(repo, '.orchestrator', 'metrics');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'learnings.jsonl'), content, 'utf8');
}

/** Write N reconcile-candidate sidecar records to <repo>/.orchestrator/runtime/reconcile-candidates.jsonl. */
function writeCandidates(repo, count, createdAt = '2025-06-01T00:00:00.000Z') {
  const dir = path.join(repo, '.orchestrator', 'runtime');
  fs.mkdirSync(dir, { recursive: true });
  const lines = Array.from({ length: count }, (_, i) => JSON.stringify({
    id: `rc-${i}`,
    schema_version: 1,
    learning_key: `convention/subject-${i}`,
    slug: `test-slug-${i}`,
    status: 'proposed',
    reason: 'reconciliation engine proposed a conditional rule',
    confidence: 0.8,
    created_at: createdAt,
    processed_at: null,
    superseded_by: null,
  }));
  fs.writeFileSync(path.join(dir, 'reconcile-candidates.jsonl'), lines.join('\n') + '\n', 'utf8');
}

describe('checkReconcileNudge — bad input', () => {
  it('returns null when called with no arguments', async () => {
    expect(await checkReconcileNudge()).toBe(null);
  });

  it('returns null when repoRoot is missing', async () => {
    expect(await checkReconcileNudge({})).toBe(null);
  });

  it('returns null when repoRoot is a non-string', async () => {
    expect(await checkReconcileNudge({ repoRoot: 42 })).toBe(null);
  });
});

describe('checkReconcileNudge — silent no-op (empty corpus)', () => {
  it('returns null when learnings.jsonl does not exist', async () => {
    expect(await checkReconcileNudge({ repoRoot: tmpRepo })).toBe(null);
  });

  it('returns null when learnings.jsonl exists but is empty', async () => {
    writeRawLearnings(tmpRepo, '');
    expect(await checkReconcileNudge({ repoRoot: tmpRepo })).toBe(null);
  });

  it('returns null when learnings.jsonl contains only malformed lines', async () => {
    writeRawLearnings(tmpRepo, 'not valid json at all\n{broken\n');
    expect(await checkReconcileNudge({ repoRoot: tmpRepo })).toBe(null);
  });
});

describe('checkReconcileNudge — under threshold', () => {
  it('returns null when active learnings, delta, and eligible count are all below threshold', async () => {
    // 5 active learnings, no candidates store (delta condition inert without a
    // determinable prior run), 0 eligible (no file_paths).
    writeLearnings(tmpRepo, 5, { type: 'convention', confidence: 0.8 });
    expect(await checkReconcileNudge({ repoRoot: tmpRepo })).toBe(null);
  });
});

describe('checkReconcileNudge — nudge (a): active learnings, no run on record', () => {
  it('returns a warn banner with correct counts when >= NUDGE_MIN_LEARNINGS active learnings and no reconcile run', async () => {
    writeLearnings(tmpRepo, 25, { type: 'convention', confidence: 0.8 });
    const result = await checkReconcileNudge({ repoRoot: tmpRepo });
    expect(result).not.toBe(null);
    expect(result.severity).toBe('warn');
    expect(result.message).toContain('25 active learnings');
    expect(result.message).toContain('0 rule-eligible');
    expect(result.message).toContain('last reconcile run: never');
  });

  it('message contains /reconcile', async () => {
    writeLearnings(tmpRepo, 25, { type: 'convention', confidence: 0.8 });
    const result = await checkReconcileNudge({ repoRoot: tmpRepo });
    expect(result.message).toContain('/reconcile');
  });

  it('threshold constant NUDGE_MIN_LEARNINGS gates the (a) condition', async () => {
    writeLearnings(tmpRepo, NUDGE_MIN_LEARNINGS - 1, { type: 'convention', confidence: 0.8 });
    expect(await checkReconcileNudge({ repoRoot: tmpRepo })).toBe(null);
  });
});

describe('checkReconcileNudge — nudge (c): rule-eligible learnings', () => {
  it('returns a warn banner when eligible count >= NUDGE_MIN_ELIGIBLE, even with few active learnings', async () => {
    writeLearnings(tmpRepo, NUDGE_MIN_ELIGIBLE, {
      type: 'anti-pattern',
      confidence: 0.5,
      file_paths: ['scripts/lib/example.mjs'],
    });
    const result = await checkReconcileNudge({ repoRoot: tmpRepo });
    expect(result).not.toBe(null);
    expect(result.severity).toBe('warn');
    expect(result.message).toContain(`${NUDGE_MIN_ELIGIBLE} rule-eligible`);
  });

  it('does not nudge on eligible count just below NUDGE_MIN_ELIGIBLE (and below other thresholds)', async () => {
    writeLearnings(tmpRepo, NUDGE_MIN_ELIGIBLE - 1, {
      type: 'anti-pattern',
      confidence: 0.5,
      file_paths: ['scripts/lib/example.mjs'],
    });
    expect(await checkReconcileNudge({ repoRoot: tmpRepo })).toBe(null);
  });
});

describe('checkReconcileNudge — nudge (b): delta since last determinable run', () => {
  const PRIOR_RUN_CANDIDATES = 10;

  it('returns a warn banner with the last-run date when the corpus grew by more than NUDGE_MIN_DELTA since the last run', async () => {
    // Prior run recorded 10 candidates; corpus has since grown so that
    // delta = (learnings - 10) is one MORE than NUDGE_MIN_DELTA(15).
    writeCandidates(tmpRepo, PRIOR_RUN_CANDIDATES, '2025-06-01T00:00:00.000Z');
    writeLearnings(tmpRepo, PRIOR_RUN_CANDIDATES + NUDGE_MIN_DELTA + 1, {
      type: 'convention',
      confidence: 0.8,
    });
    const result = await checkReconcileNudge({ repoRoot: tmpRepo });
    expect(result).not.toBe(null);
    expect(result.message).toContain('last reconcile run: 2025-06-01');
  });

  it('does not nudge on delta alone when delta <= NUDGE_MIN_DELTA and other thresholds are unmet', async () => {
    // Prior run recorded 10 candidates; corpus grew so delta sits AT the
    // threshold (not over it, since the (b) check is strictly-greater-than).
    // Condition (a) stays inert too — lastRunAt is non-null here (a run IS on
    // record), so the active-learnings count alone cannot trigger it.
    // eligibleCount also stays 0 (no file_paths).
    writeCandidates(tmpRepo, PRIOR_RUN_CANDIDATES, '2025-06-01T00:00:00.000Z');
    writeLearnings(tmpRepo, PRIOR_RUN_CANDIDATES + NUDGE_MIN_DELTA, {
      type: 'convention',
      confidence: 0.8,
    });
    expect(await checkReconcileNudge({ repoRoot: tmpRepo })).toBe(null);
  });
});

describe('checkReconcileNudge — reconcile.enabled parenthetical', () => {
  it('appends the advisory parenthetical when reconcile.enabled is false (via injected config)', async () => {
    writeLearnings(tmpRepo, 25, { type: 'convention', confidence: 0.8 });
    const result = await checkReconcileNudge({ repoRoot: tmpRepo, config: { reconcile: { enabled: false } } });
    expect(result.message).toContain('reconcile.enabled: false');
    expect(result.message).toContain('/reconcile still runs on-demand');
  });

  it('omits the advisory parenthetical when reconcile.enabled is true (via injected config)', async () => {
    writeLearnings(tmpRepo, 25, { type: 'convention', confidence: 0.8 });
    const result = await checkReconcileNudge({ repoRoot: tmpRepo, config: { reconcile: { enabled: true } } });
    expect(result.message).not.toContain('reconcile.enabled: false');
  });

  it('falls back to reading CLAUDE.md when no config is injected and no CLAUDE.md/AGENTS.md exists (defaults to false)', async () => {
    writeLearnings(tmpRepo, 25, { type: 'convention', confidence: 0.8 });
    const result = await checkReconcileNudge({ repoRoot: tmpRepo });
    expect(result.message).toContain('reconcile.enabled: false');
  });
});

describe('computeReconcileNudge — pure shape', () => {
  it('returns the zeroed shape for an empty corpus', async () => {
    const result = await computeReconcileNudge({ repoRoot: tmpRepo });
    expect(result).toEqual({
      totalLearnings: 0,
      activeLearnings: 0,
      eligibleCount: 0,
      lastRunAt: null,
      lastRunCandidateCount: 0,
      delta: 0,
      nudge: false,
      reasons: [],
    });
  });

  it('reports activeLearnings, eligibleCount, and nudge=true for a corpus over threshold', async () => {
    writeLearnings(tmpRepo, 25, { type: 'convention', confidence: 0.8 });
    const result = await computeReconcileNudge({ repoRoot: tmpRepo });
    expect(result.totalLearnings).toBe(25);
    expect(result.activeLearnings).toBe(25);
    expect(result.eligibleCount).toBe(0);
    expect(result.lastRunAt).toBe(null);
    expect(result.nudge).toBe(true);
  });

  it('excludes low-confidence learnings from activeLearnings', async () => {
    writeLearnings(tmpRepo, 25, { type: 'convention', confidence: 0.2 });
    const result = await computeReconcileNudge({ repoRoot: tmpRepo });
    // confidence 0.2 <= default floor 0.3 → filtered out of the active set.
    expect(result.activeLearnings).toBe(0);
    expect(result.nudge).toBe(false);
  });
});

describe('checkReconcileNudge — fail-silent', () => {
  it('does not throw when learnings.jsonl path is unreadable (a directory, not a file)', async () => {
    // learnings.jsonl is itself a directory → readFile throws EISDIR internally;
    // the probe must swallow it and resolve to null, not reject.
    const dir = path.join(tmpRepo, '.orchestrator', 'metrics', 'learnings.jsonl');
    fs.mkdirSync(dir, { recursive: true });
    const result = await checkReconcileNudge({ repoRoot: tmpRepo });
    expect(result).toBe(null);
  });
});
