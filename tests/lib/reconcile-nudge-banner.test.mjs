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

/**
 * Default fixture insight — 41 chars, i.e. ABOVE the `reconcile.min-insight-chars`
 * default (24) the nudge now shares with `/reconcile`. A short placeholder here
 * would make every eligibility case in this file measure the placeholder gate
 * instead of the behaviour under test; the short-insight case has its own test.
 */
const DEFAULT_INSIGHT = 'a sufficiently long insight for eligibility';

/**
 * Build one JSONL learning line. No `expires_at`, and `created_at` is the real
 * clock — so the natural-TTL gate the nudge now shares with the engine (#1380,
 * `filterEligible({ now })`) never rejects it. A fixed past date here would be a
 * time bomb once its TTL elapsed.
 */
function learningLine(
  { type = 'convention', confidence = 0.8, file_paths, id, insight = DEFAULT_INSIGHT } = {},
  i = 0,
) {
  const obj = {
    id: id ?? `id-${i}`,
    type,
    subject: `subject-${i}`,
    insight,
    evidence: 'test evidence',
    confidence,
    source_session: 'main-2026-01-01-1',
    created_at: new Date().toISOString(),
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

/**
 * Write N SHAPE-FOREIGN records into the candidate store — the real 2026-07-31
 * contamination shape (`candidate_id`/`generated_at`, no `created_at`), which the
 * store's read-side guard quarantines. Field set copied from a live line of that
 * store (testing.md § Fixtures Mirror Production Data).
 */
function writeForeignCandidates(repo, count) {
  const dir = path.join(repo, '.orchestrator', 'runtime');
  fs.mkdirSync(dir, { recursive: true });
  const lines = Array.from({ length: count }, (_, i) => JSON.stringify({
    learning_key: `anti-pattern/foreign-${i}`,
    slug: `anti-pattern-foreign-${i}-91c32e4`,
    confidence: 0.95,
    candidate_id: `rc-f587113${i}`,
    rule_path: `.claude/rules/anti-pattern-foreign-${i}-91c32e4.md`,
    status: 'candidate',
    generated_at: '2026-07-31T07:09:33.905Z',
    generated_by: 'W3-reconcile-candidate-dry-run',
  }));
  fs.appendFileSync(path.join(dir, 'reconcile-candidates.jsonl'), lines.join('\n') + '\n', 'utf8');
}

describe('checkReconcileNudge — bad input', () => {
  // TV-003 consolidation: three cases with an identical body differing only in
  // the argument value → one table. No assertion lost.
  it.each([
    ['no arguments', undefined],
    ['repoRoot missing', {}],
    ['repoRoot a non-string', { repoRoot: 42 }],
  ])('returns null when called with %s', async (_label, args) => {
    expect(await checkReconcileNudge(args)).toBe(null);
  });
});

describe('checkReconcileNudge — silent no-op (empty corpus)', () => {
  // TV-003 consolidation: three cases with an identical body differing only in
  // the corpus file's content → one table (`null` = "write no file at all").
  it.each([
    ['does not exist', null],
    ['exists but is empty', ''],
    ['contains only malformed lines', 'not valid json at all\n{broken\n'],
  ])('returns null when learnings.jsonl %s', async (_label, content) => {
    if (content !== null) writeRawLearnings(tmpRepo, content);
    expect(await checkReconcileNudge({ repoRoot: tmpRepo })).toBe(null);
  });
});
// TV-003: the former "under threshold" case (5 convention learnings, no
// file_paths, no store → null) was strictly weaker than the
// NUDGE_MIN_LEARNINGS-1 boundary case below, which asserts the same null on the
// same corpus shape one learning closer to the threshold. Removed, not merged.

describe('checkReconcileNudge — nudge (a): active learnings, no run on record', () => {
  it('returns a warn banner with correct counts when >= NUDGE_MIN_LEARNINGS active learnings and no reconcile run', async () => {
    writeLearnings(tmpRepo, 25, { type: 'convention', confidence: 0.8 });
    const result = await checkReconcileNudge({ repoRoot: tmpRepo });
    expect(result).not.toBe(null);
    expect(result.severity).toBe('warn');
    expect(result.message).toContain('25 active learnings');
    expect(result.message).toContain('0 rule-eligible');
    expect(result.message).toContain('last reconcile run: never');
    // TV-003: folded in from the former standalone "message contains /reconcile"
    // case, whose setup and subject were identical to this one.
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

  it('a learning whose insight is shorter than reconcile.min-insight-chars does not count — the nudge applies the same gate /reconcile does', async () => {
    // Same corpus as the passing case above, one field changed: an insight below
    // the Session Config gate. /reconcile rejects these as `placeholder-insight`,
    // so a banner counting them would nudge for work /reconcile cannot clear.
    writeLearnings(tmpRepo, NUDGE_MIN_ELIGIBLE, {
      type: 'anti-pattern',
      confidence: 0.5,
      file_paths: ['scripts/lib/example.mjs'],
      insight: 'too short',
    });
    fs.writeFileSync(
      path.join(tmpRepo, 'CLAUDE.md'),
      '## Session Config\n\nreconcile:\n  enabled: true\n  min-insight-chars: 24\n',
      'utf8',
    );

    const computed = await computeReconcileNudge({ repoRoot: tmpRepo });
    expect(computed.eligibleCount).toBe(0);
    expect(computed.backlogCount).toBe(0);
    expect(computed.nudge).toBe(false);
    expect(await checkReconcileNudge({ repoRoot: tmpRepo })).toBe(null);
  });

  it('an injected reconcile.min-insight-chars wins over the CLAUDE.md value — per-KEY precedence, not per-block', async () => {
    // The docblock on `_resolveReconcileSettings` promises precedence PER KEY, and
    // `enabled` has a test for it — `min-insight-chars` had none, so dropping the
    // key from the injected-config branch (`minInsightChars: hasChars` → `false`)
    // left every test green while the banner silently judged on CLAUDE.md's value.
    // DEFAULT_INSIGHT is 41 chars: above CLAUDE.md's 24, below the injected 200.
    // Only if the INJECTED value reaches `filterEligible` does the backlog go to 0.
    writeLearnings(tmpRepo, NUDGE_MIN_ELIGIBLE, {
      type: 'anti-pattern',
      confidence: 0.5,
      file_paths: ['scripts/lib/example.mjs'],
    });
    fs.writeFileSync(
      path.join(tmpRepo, 'CLAUDE.md'),
      '## Session Config\n\nreconcile:\n  enabled: true\n  min-insight-chars: 24\n',
      'utf8',
    );

    // Control: with no injection the CLAUDE.md value (24) applies and all three count.
    const onClaudeMd = await computeReconcileNudge({ repoRoot: tmpRepo });
    expect(onClaudeMd.eligibleCount).toBe(NUDGE_MIN_ELIGIBLE);
    expect(onClaudeMd.backlogCount).toBe(NUDGE_MIN_ELIGIBLE);

    const injected = await computeReconcileNudge({
      repoRoot: tmpRepo,
      config: { reconcile: { 'min-insight-chars': 200 } },
    });
    expect(injected.eligibleCount).toBe(0);
    expect(injected.backlogCount).toBe(0);
    expect(injected.nudge).toBe(false);
  });

  it('#1380: eligible learnings already materialized under .claude/rules/ do not count — /reconcile could not clear them', async () => {
    writeLearnings(tmpRepo, NUDGE_MIN_ELIGIBLE, {
      type: 'anti-pattern',
      confidence: 0.5,
      file_paths: ['scripts/lib/example.mjs'],
    });
    const rulesDir = path.join(tmpRepo, '.claude', 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    const provenance = Array.from({ length: NUDGE_MIN_ELIGIBLE }, (_, i) => `- learning-id: \`id-${i}\``);
    fs.writeFileSync(path.join(rulesDir, 'x.md'), `# X\n\n## Provenance\n${provenance.join('\n')}\n`, 'utf8');

    const computed = await computeReconcileNudge({ repoRoot: tmpRepo });
    expect(computed.eligibleCount).toBe(NUDGE_MIN_ELIGIBLE);
    expect(computed.alreadyMaterialized).toBe(NUDGE_MIN_ELIGIBLE);
    expect(computed.backlogCount).toBe(0);
    expect(computed.nudge).toBe(false);
  });
});

describe('checkReconcileNudge — type-alias read-path (issue #900): raw dialect type normalizes before eligibility', () => {
  it('a raw "gotcha" learning with non-empty file_paths counts as rule-eligible after alias normalization', async () => {
    // 'gotcha' is a raw producer dialect, never itself in CONVERT_TYPES —
    // LEARNING_TYPE_ALIASES maps it to 'anti-pattern' (ruleConvertible: true)
    // via normalizeDialects() on the readLearnings() funnel. This proves that
    // normalization actually reaches filterEligible() through this consumer,
    // not just in an isolated schema.mjs unit test.
    writeLearnings(tmpRepo, NUDGE_MIN_ELIGIBLE, {
      type: 'gotcha',
      confidence: 0.8,
      file_paths: ['scripts/lib/example.mjs'],
    });
    const computed = await computeReconcileNudge({ repoRoot: tmpRepo });
    expect(computed.eligibleCount).toBe(NUDGE_MIN_ELIGIBLE);
    const result = await checkReconcileNudge({ repoRoot: tmpRepo });
    expect(result).not.toBe(null);
    expect(result.message).toContain(`${NUDGE_MIN_ELIGIBLE} rule-eligible`);
  });

  it('a raw "gotcha" learning WITHOUT file_paths does not count as rule-eligible (negative control)', async () => {
    // Same alias resolution ('gotcha' -> 'anti-pattern') but no file_paths —
    // classifyLearning's file-gate still rejects it. Confirms the eligibility
    // gain above comes from the file_paths presence, not merely from the
    // type-alias resolution alone.
    writeLearnings(tmpRepo, NUDGE_MIN_ELIGIBLE, {
      type: 'gotcha',
      confidence: 0.8,
    });
    const computed = await computeReconcileNudge({ repoRoot: tmpRepo });
    expect(computed.eligibleCount).toBe(0);
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

describe('checkReconcileNudge — contaminated candidate store (GitLab #955 finding 2)', () => {
  // TV-001 — the bug: the store reader used to discard its skip count, so a
  // store whose every line fails the shape guard was indistinguishable from a
  // MISSING one — both yield `[]` → `lastRunAt === null` → "last reconcile run:
  // never". The banner then reports that no run ever happened when one did and
  // its record was quarantined. No existing case here ever wrote a shape-foreign
  // line: `writeCandidates` only produces writer-faithful records, so every
  // "never" assertion in this file stays green with the guard's count thrown
  // away. This case pins the DISCRIMINATION — contaminated and empty must not
  // read the same — which is what makes it falsifiable.
  it('says "undeterminable" for a contaminated store and "never" for an empty one', async () => {
    writeLearnings(tmpRepo, 25, { type: 'convention', confidence: 0.8 });
    writeForeignCandidates(tmpRepo, 40);

    const contaminated = await checkReconcileNudge({ repoRoot: tmpRepo });
    expect(contaminated.message).toContain(
      'last reconcile run: undeterminable (40 unreadable record(s) in the candidate store)',
    );
    expect(contaminated.message).not.toContain('last reconcile run: never');
    const contaminatedComputed = await computeReconcileNudge({ repoRoot: tmpRepo });
    expect(contaminatedComputed.skippedCandidates).toBe(40);
    expect(contaminatedComputed.reasons).toEqual([
      '25 active learnings; last reconcile run undeterminable — 40 unreadable record(s) in the candidate store',
    ]);

    // Same corpus, NO candidate store at all → the honest label is "never".
    fs.rmSync(path.join(tmpRepo, '.orchestrator', 'runtime'), { recursive: true, force: true });
    const empty = await checkReconcileNudge({ repoRoot: tmpRepo });
    expect(empty.message).toContain('last reconcile run: never');
    expect(empty.message).not.toContain('unreadable record');
    expect((await computeReconcileNudge({ repoRoot: tmpRepo })).skippedCandidates).toBe(0);

    // The two must differ — a matching pair would mean the fix is not wired.
    expect(contaminated.message).not.toBe(empty.message);
  });

  it('flags a PARTIALLY contaminated store — dates the run from survivors, but marks it possibly stale', async () => {
    writeLearnings(tmpRepo, 25, { type: 'convention', confidence: 0.8 });
    writeCandidates(tmpRepo, 2, '2025-06-01T00:00:00.000Z'); // survivors carry the date
    writeForeignCandidates(tmpRepo, 3);

    const result = await checkReconcileNudge({ repoRoot: tmpRepo });
    expect(result.message).toContain(
      'last reconcile run: 2025-06-01 (+3 unreadable record(s) — date may be stale)',
    );
    expect((await computeReconcileNudge({ repoRoot: tmpRepo })).skippedCandidates).toBe(3);
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
      alreadyMaterialized: 0,
      backlogCount: 0,
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
