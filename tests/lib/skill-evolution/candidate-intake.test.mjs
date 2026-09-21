/**
 * candidate-intake.test.mjs — Unit tests for the #647 C2 candidate-intake
 * transform (`extractCandidates`).
 *
 * Covers:
 *   - Actionable learning → exactly 1 candidate with the full RepairCandidate shape.
 *   - Descriptive learnings (no verb / no path) → dropped.
 *   - Confidence-floor gate, non-finite confidence, expiry filter.
 *   - Determinism: identical input → identical id.
 *   - Target resolution against the tracked files of `repoRoot` (bare basename
 *     → its one tracked path; zero / several matches or an untracked path → dropped;
 *     no git → the path must exist).
 *   - Realpath containment in both modes (symlinked dir, `../`, tracked symlink
 *     escaping the root → dropped) and `..` normalisation of `target_path`.
 *   - Drift-check error mapping (filesystem-fact, evidence 1.0).
 *   - Inert drift results (null / skipped / warnings-only) → 0 drift candidates.
 *   - Defensive handling of malformed learnings.
 */

import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { extractCandidates } from '@lib/skill-evolution/candidate-intake.mjs';
import { fixtureGit, makeTmpDir, removeTree } from '../../_helpers/tmp-fixture.mjs';

const NOW = '2026-06-14T12:00:00.000Z';

/** Files the fixture repo tracks: `engine.mjs` twice (ambiguous), the rest unique. */
const TRACKED = [
  'scripts/lib/foo.mjs',
  'scripts/lib/skill-evolution/engine.mjs',
  'tests/lib/skill-evolution/engine.mjs',
  'hooks/_lib/hook-import-set.json',
];

let repoRoot;
let plainDir;

beforeAll(() => {
  repoRoot = makeTmpDir('so-candidate-intake-');
  for (const rel of TRACKED) {
    mkdirSync(join(repoRoot, rel, '..'), { recursive: true });
    writeFileSync(join(repoRoot, rel), '// fixture\n');
  }
  fixtureGit(['init', '-q'], repoRoot);
  fixtureGit(['add', '--', ...TRACKED], repoRoot);

  // No `.git`: exercises the "git unavailable" degradation.
  plainDir = makeTmpDir('so-candidate-intake-nogit-');
  writeFileSync(join(plainDir, 'present.mjs'), '// fixture\n');
});

afterAll(() => {
  removeTree(repoRoot);
  removeTree(plainDir);
});

/** `extractCandidates` anchored on the fixture repo unless a test overrides it. */
function extract(params) {
  return extractCandidates({ repoRoot, now: NOW, ...params });
}

/** A learning that passes every actionable filter (verb + repo path + live + confident). */
function actionableLearning(overrides = {}) {
  return {
    id: 'learn-1',
    subject: 'scripts/lib/foo.mjs',
    insight: 'Fix the stale default in scripts/lib/foo.mjs',
    confidence: 0.8,
    created_at: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('extractCandidates — /evolve learnings', () => {
  it('maps an actionable learning to exactly one candidate', () => {
    const result = extract({ learnings: [actionableLearning()] });
    expect(result).toHaveLength(1);
  });

  it('emits a candidate with source evolve-learning and confidence evidence', () => {
    const [candidate] = extract({ learnings: [actionableLearning()] });
    expect(candidate).toEqual(
      expect.objectContaining({
        schema_version: 1,
        source: 'evolve-learning',
        target_path: 'scripts/lib/foo.mjs',
        evidence: 0.8,
        evidence_kind: 'confidence',
        processed_at: null,
        superseded_by: null,
        created_at: NOW,
      }),
    );
  });

  it('drops a descriptive learning with no prescriptive verb', () => {
    const learning = actionableLearning({
      insight: 'The behaviour in scripts/lib/foo.mjs is stale and surprising',
    });
    expect(extract({ learnings: [learning] })).toEqual([]);
  });

  it('drops a learning with a verb but no resolvable repo path', () => {
    const learning = actionableLearning({
      subject: 'general guidance',
      insight: 'Always remove the surprising behaviour from the system',
    });
    expect(extract({ learnings: [learning] })).toEqual([]);
  });

  it('drops a learning below the evidence floor', () => {
    const learning = actionableLearning({ confidence: 0.4 });
    expect(extract({ learnings: [learning], evidenceFloor: 0.5 })).toEqual([]);
  });

  it('drops a learning with non-finite confidence', () => {
    const learning = actionableLearning({ confidence: Number.NaN });
    expect(extract({ learnings: [learning] })).toEqual([]);
  });

  it('drops a learning that has expired', () => {
    const learning = actionableLearning({ expires_at: '2026-06-13T00:00:00.000Z' });
    expect(extract({ learnings: [learning] })).toEqual([]);
  });

  it('keeps a learning whose expiry is after now', () => {
    const learning = actionableLearning({ expires_at: '2026-06-15T00:00:00.000Z' });
    expect(extract({ learnings: [learning] })).toHaveLength(1);
  });

  it('produces an identical id for identical input across two calls', () => {
    const [first] = extract({ learnings: [actionableLearning()] });
    const [second] = extract({ learnings: [actionableLearning()] });
    expect(first.id).toBe(second.id);
  });

  it('handles a learning missing id/subject/insight without throwing', () => {
    const malformed = { confidence: 0.9, created_at: NOW };
    expect(() => extract({ learnings: [malformed] })).not.toThrow();
    expect(extract({ learnings: [malformed] })).toEqual([]);
  });

  it('returns an empty array when learnings is absent', () => {
    expect(extract({})).toEqual([]);
  });
});

describe('extractCandidates — target resolution against repoRoot', () => {
  it('rewrites a bare basename with exactly one tracked match to that full path', () => {
    const learning = actionableLearning({
      subject: 'drift',
      insight: 'Regenerate and update hook-import-set.json after every hook import change',
    });
    const result = extract({ learnings: [learning] });
    expect(result.map((c) => c.target_path)).toEqual(['hooks/_lib/hook-import-set.json']);
  });

  it.each([
    ['a bare basename with zero tracked matches', 'Add the server entry to mcp.json'],
    ['a bare basename with two tracked matches', 'Fix the default in engine.mjs'],
    ['a slash path that is not tracked', 'Fix the default in scripts/lib/missing.mjs'],
  ])('drops %s', (_label, insight) => {
    const learning = actionableLearning({ subject: 'x', insight });
    expect(extract({ learnings: [learning] })).toEqual([]);
  });

  it.each([
    ['keeps', 'Fix the default in present.mjs', ['present.mjs']],
    ['drops', 'Fix the default in absent.mjs', []],
  ])('without git, %s a path by whether it exists (%s)', (_verb, insight, expected) => {
    const learning = actionableLearning({ subject: 'x', insight });
    const result = extract({ learnings: [learning], repoRoot: plainDir });
    expect(result.map((c) => c.target_path)).toEqual(expected);
  });

  // A `..` segment must not survive into target_path: the same file under two
  // spellings would be two targets with two idempotency keys.
  it.each([
    ['with git', 'scripts/lib/skill-evolution/../foo.mjs', 'scripts/lib/foo.mjs', () => repoRoot],
    ['without git', 'scripts/../present.mjs', 'present.mjs', () => plainDir],
  ])('%s, normalises %s to %s and mints the same id as the plain spelling', (_mode, spelled, plain, root) => {
    const insight = 'Fix the stale default here';
    const result = extract({
      learnings: [
        actionableLearning({ subject: spelled, insight }),
        actionableLearning({ subject: plain, insight }),
      ],
      repoRoot: root(),
    });
    expect(result.map((c) => c.target_path)).toEqual([plain, plain]);
    expect(result[0].id).toBe(result[1].id);
  });
});

describe('extractCandidates — realpath containment', () => {
  /** outer/{outside.md, victim/victim.md, nogit/, git/} — both roots sit beside the escape targets. */
  let outer;
  let noGitRoot;
  let gitRoot;

  beforeAll(() => {
    outer = makeTmpDir('so-candidate-intake-escape-');
    writeFileSync(join(outer, 'outside.md'), '# outside the repo\n');
    mkdirSync(join(outer, 'victim'));
    writeFileSync(join(outer, 'victim', 'victim.md'), '# outside the repo\n');

    noGitRoot = join(outer, 'nogit');
    mkdirSync(join(noGitRoot, 'docs'), { recursive: true });
    symlinkSync(join(outer, 'victim'), join(noGitRoot, 'docs', 'ext'));

    gitRoot = join(outer, 'git');
    mkdirSync(join(gitRoot, 'docs'), { recursive: true });
    symlinkSync(join(outer, 'outside.md'), join(gitRoot, 'docs', 'link.md'));
    fixtureGit(['init', '-q'], gitRoot);
    fixtureGit(['add', '--', 'docs/link.md'], gitRoot);
  });

  afterAll(() => {
    removeTree(outer);
  });

  it.each([
    ['without git, a symlinked directory pointing outside', () => noGitRoot, 'docs/ext/victim.md'],
    ['without git, a ../ escape to an existing outside file', () => noGitRoot, 'scripts/../../outside.md'],
    ['with git, a TRACKED symlink to an outside file', () => gitRoot, 'docs/link.md'],
  ])('drops %s', (_label, root, target) => {
    const learning = actionableLearning({ subject: 'x', insight: `Fix the default in ${target}` });
    expect(extract({ learnings: [learning], repoRoot: root() })).toEqual([]);
  });
});

describe('extractCandidates — drift-check errors', () => {
  const driftResult = {
    status: 'fail',
    errors: [
      {
        check: 'command-count',
        file: 'CLAUDE.md',
        line: 142,
        message: 'narrative says 13 commands but actual is 11',
        command_count: { actual: 11 },
      },
    ],
    warnings: [{ check: 'something', file: 'README.md', message: 'a warning' }],
  };

  it('maps a single drift error to exactly one candidate', () => {
    expect(extractCandidates({ driftResult, now: NOW })).toHaveLength(1);
  });

  it('emits a drift candidate as a filesystem-fact with evidence 1.0', () => {
    const [candidate] = extractCandidates({ driftResult, now: NOW });
    expect(candidate).toEqual(
      expect.objectContaining({
        source: 'drift-check',
        evidence: 1.0,
        evidence_kind: 'filesystem-fact',
        target_path: 'CLAUDE.md',
        processed_at: null,
        superseded_by: null,
      }),
    );
  });

  it('ignores drift warnings (only errors become candidates)', () => {
    const result = extractCandidates({ driftResult, now: NOW });
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('drift-check');
  });

  it('returns no drift candidates when driftResult is null', () => {
    expect(extractCandidates({ driftResult: null, now: NOW })).toEqual([]);
  });

  it('returns no drift candidates when status is skipped', () => {
    const skipped = { status: 'skipped', errors: [{ check: 'command-count', file: 'CLAUDE.md', line: 1, message: 'm' }] };
    expect(extractCandidates({ driftResult: skipped, now: NOW })).toEqual([]);
  });

  it('returns no drift candidates when status is skipped-mode-off', () => {
    const off = { status: 'skipped-mode-off', errors: [{ check: 'command-count', file: 'CLAUDE.md', line: 1, message: 'm' }] };
    expect(extractCandidates({ driftResult: off, now: NOW })).toEqual([]);
  });

  it('drops a drift error with no file', () => {
    const noFile = { status: 'fail', errors: [{ check: 'command-count', line: 1, message: 'm' }] };
    expect(extractCandidates({ driftResult: noFile, now: NOW })).toEqual([]);
  });
});
