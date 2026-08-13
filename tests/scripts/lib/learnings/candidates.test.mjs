/**
 * tests/scripts/lib/learnings/candidates.test.mjs
 *
 * Unit tests for scripts/lib/learnings/candidates.mjs — the per-seed candidate
 * pool for learning→learning duplicate/contradiction judgment (#1016).
 *
 * Fixtures are GOLDEN-RECORD derived: the field set, ordering and optional-field
 * presence are copied from live records in .orchestrator/metrics/learnings.jsonl
 * (2026-08-13 harvest), then re-subjected. The live file itself is deliberately
 * NOT read — records expire, so any assertion against it would drift with the
 * wall clock. The clock is frozen instead.
 *
 * Corpus-derived counts (89/94/152/172 …) are NOT pinned anywhere here; they
 * drift with every append. Only FIXED invariants are asserted exactly: the
 * boost-vs-floor inequality, the top-K cap, and the tie-break order.
 *
 * Every test names the concrete bug it catches. No test recomputes the module's
 * own formula.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CANDIDATE_FLOOR,
  CANDIDATE_TOP_K,
  MAX_POOL_HOPS,
  PATH_BOOST_DIR,
  PATH_BOOST_EXACT,
  STOPWORDS,
  buildCandidatePools,
  buildCandidatePoolsFromFile,
  candidateTokens,
  emptyPools,
  learningKey,
  pathBoost,
} from '@lib/learnings/candidates.mjs';

// ---------------------------------------------------------------------------
// Frozen clock + golden-record fixture factory
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-08-01T00:00:00.000Z');
const OPTS = { now: NOW };

/** Golden-record shape: exact field set of a live learnings.jsonl entry. */
function record(overrides = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000000',
    type: 'recurring-issue',
    subject: 'placeholder-subject',
    insight: 'Placeholder insight text.',
    evidence: 'Placeholder evidence text.',
    confidence: 0.7499999999999999,
    source_session: 'main-2026-07-03-session-1',
    created_at: '2026-07-01T06:38:13.040Z',
    expires_at: '2026-12-01T06:38:13.040Z',
    schema_version: 1,
    scope: 'local',
    host_class: null,
    anonymized: false,
    ...overrides,
  };
}

/** Subjects in a seed's pool, in emitted order. */
function poolOf(result, seedSubject) {
  const pool = result.pools.find((p) => p.seed.subject === seedSubject);
  return pool ? pool.candidates.map((c) => c.record.subject) : null;
}

// ---------------------------------------------------------------------------
// Fixtures — English content pair (cross-type on purpose)
// ---------------------------------------------------------------------------

const P_STDOUT = record({
  id: '6cf829ba-49c4-4a2c-9942-5eaa5a4ba6b0',
  type: 'anti-pattern',
  subject: 'stdout-truncation-drops-the-decision-envelope',
  insight:
    'Node stdout is asynchronous on a pipe; process exit discards the envelope past the kernel buffer.',
});

const P_PROTOCOL = record({
  id: 'ed5ad563-dc22-4759-83c3-308afe5e37c8',
  type: 'proven-pattern',
  subject: 'exit-protocol-migration-inverts-failure-direction',
  insight:
    'Under the stdout envelope protocol a truncated envelope reads as no decision and the process proceeds.',
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pathBoost — the boost can never create a link (hard invariant)', () => {
  // BUG CAUGHT: a path boost tuned above the floor. Then two records that share
  // a file path but nothing else would enter each other's pools on paths alone,
  // and since 80.9% of records carry no file_paths at all, the pool would become
  // "whoever touched the same file" instead of "whoever says the same thing".
  // This inequality is the mechanical form of accepted failure mode 1's ceiling.
  it('keeps the maximum boost strictly below the pool floor', () => {
    expect(PATH_BOOST_EXACT).toBe(0.05);
    expect(CANDIDATE_FLOOR).toBe(0.085);
    expect(PATH_BOOST_EXACT).toBeLessThan(CANDIDATE_FLOOR);
    expect(PATH_BOOST_DIR).toBeLessThan(PATH_BOOST_EXACT);
  });

  // BUG CAUGHT: the inequality above holding in the constants but not in the
  // behaviour — e.g. a boost applied multiplicatively, or applied twice (once
  // per direction). Two records with an IDENTICAL file path and zero shared
  // content tokens must produce no pool at all.
  it('pools nothing for a path-identical pair with no shared vocabulary', () => {
    const alpha = record({
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      subject: 'zebra-quilt-orbit',
      insight: 'Vanish trumpet meadow.',
      file_paths: ['scripts/lib/learnings/candidates.mjs'],
    });
    const beta = record({
      id: 'aaaaaaaa-0000-4000-8000-000000000002',
      subject: 'cactus-lantern-harbour',
      insight: 'Puzzle mandolin fjord.',
      file_paths: ['scripts/lib/learnings/candidates.mjs'],
    });

    const res = buildCandidatePools([alpha, beta], OPTS);

    expect(pathBoost(alpha.file_paths, beta.file_paths)).toBe(PATH_BOOST_EXACT);
    expect(res.pools).toEqual([]);
    expect(res.stats.retained).toBe(0);
  });

  // BUG CAUGHT: a string-prefix directory comparison ("scripts/lib" matching
  // "scripts/library/…"), or crediting two unrelated top-level files with a
  // shared "" directory key — which would hand the dir boost to every pair of
  // repo-root files.
  it('grades exact overlap above a shared 2-level dir prefix, and gives root files nothing', () => {
    expect(pathBoost(['scripts/lib/a.mjs'], ['scripts/lib/a.mjs'])).toBe(PATH_BOOST_EXACT);
    expect(pathBoost(['scripts/lib/learnings/a.mjs'], ['scripts/lib/gates/b.mjs'])).toBe(
      PATH_BOOST_DIR
    );
    expect(pathBoost(['scripts/lib/a.mjs'], ['scripts/library/b.mjs'])).toBe(0);
    expect(pathBoost(['hooks/a.mjs'], ['scripts/lib/b.mjs'])).toBe(0);
    expect(pathBoost(['README.md'], ['CHANGELOG.md'])).toBe(0);
    expect(pathBoost(['scripts/lib/a.mjs'], [])).toBe(0);
    expect(pathBoost('nope', undefined)).toBe(0);
  });
});

describe('expiry gate', () => {
  // BUG CAUGHT: pooling expired guidance. An expired record is exactly the kind
  // that looks like a strong duplicate of its live successor, so a selector that
  // ranks before it filters would surface the dead half of every rotated pair
  // and invite a judge to "reconcile" a learning that is already gone.
  // The second half proves the test is not vacuous: the SAME record pools fine
  // before its expiry date.
  it('never pools an expired record, and does pool it before expiry', () => {
    const expired = record({
      ...P_PROTOCOL,
      id: 'a22ce14f-4666-4b91-99be-c680e9903907',
      expires_at: '2026-07-15T00:00:00.000Z',
    });

    const after = buildCandidatePools([P_STDOUT, expired], OPTS);
    expect(after.pools).toEqual([]);
    expect(after.stats.expired).toBe(1);
    expect(after.stats.scored).toBe(1);

    const before = buildCandidatePools([P_STDOUT, expired], {
      now: Date.parse('2026-07-10T00:00:00.000Z'),
    });
    expect(poolOf(before, P_STDOUT.subject)).toEqual([
      'exit-protocol-migration-inverts-failure-direction',
    ]);
    expect(before.stats.expired).toBe(0);
  });
});

describe('type is metadata, never a gate', () => {
  // BUG CAUGHT: a same-type filter or same-type boost. Measured: both strongest
  // ground-truth links are CROSS-type, and a type-equality gate drops
  // ground-truth connectivity from 6/6 to 4/6 while still retaining 26% of all
  // pairs — it costs the answer and buys almost no reduction. The fixture pair
  // here is deliberately anti-pattern↔proven-pattern.
  it('pools a strong cross-type pair', () => {
    const res = buildCandidatePools([P_STDOUT, P_PROTOCOL], OPTS);

    expect(P_STDOUT.type).not.toBe(P_PROTOCOL.type);
    expect(poolOf(res, P_STDOUT.subject)).toEqual([
      'exit-protocol-migration-inverts-failure-direction',
    ]);
    expect(res.pools[0].candidates[0].type).toBe('proven-pattern');
    expect(res.pools[0].candidates[0].boost).toBe(0);
  });
});

describe('tokenisation', () => {
  // BUG CAUGHT: tokenising `evidence` along with subject/insight. Evidence is
  // dense with dates, ids, pipeline numbers and file names, so two unrelated
  // learnings that both quote a "2026-07-30 pipeline" transcript would pair up
  // on provenance boilerplate rather than on content.
  it('ignores evidence, so an evidence-only overlap pools nothing', () => {
    const shared =
      'Wave 4 reproduced a full-suite race on pipeline 6819 at commit 3a27817 on 2026-07-30.';
    const one = record({
      id: 'bbbbbbbb-0000-4000-8000-000000000001',
      subject: 'lantern-drift',
      insight: 'Mandolin fjord meadow.',
      evidence: shared,
    });
    const two = record({
      id: 'bbbbbbbb-0000-4000-8000-000000000002',
      subject: 'quilt-orbit',
      insight: 'Trumpet cactus harbour.',
      evidence: shared,
    });

    expect(candidateTokens(one)).toEqual(['lantern', 'drift', 'mandolin', 'fjord', 'meadow']);
    expect(buildCandidatePools([one, two], OPTS).pools).toEqual([]);
  });

  // BUG CAUGHT: an English-only stoplist. 7 of the measured 89 records are
  // German, and the highest-scoring pair in the whole corpus was a German↔German
  // pair driven purely by shared function words — the score was measuring
  // LANGUAGE, not content. The control pair below proves the stoplist does not
  // simply exclude German records: a German pair with shared CONTENT still pools.
  it('drops German function words, so a function-word-only German pair never pools', () => {
    const funcA = record({
      id: 'cccccccc-0000-4000-8000-000000000001',
      subject: 'kompass-notiz',
      insight: 'Der Ablauf ist ein Beispiel und wird nicht mit dem Kompass verwechselt.',
    });
    const funcB = record({
      id: 'cccccccc-0000-4000-8000-000000000002',
      subject: 'ballon-mitteilung',
      insight: 'Das Verfahren ist ein Ergebnis und wird nicht mit dem Ballon vertauscht.',
    });
    const contentA = record({
      id: 'cccccccc-0000-4000-8000-000000000003',
      subject: 'sicherheitsfix-ohne-pruefung',
      insight:
        'Ein Sicherheitsfix der ungeprueft folgt oeffnet ein Loch derselben Klasse im Guard.',
    });
    const contentB = record({
      id: 'cccccccc-0000-4000-8000-000000000004',
      subject: 'adversariales-panel-findet-guard-loecher',
      insight:
        'Das adversariale Panel findet selbstverursachte Loecher derselben Klasse wie ein Sicherheitsfix im Guard.',
    });

    const res = buildCandidatePools([funcA, funcB, contentA, contentB], OPTS);

    expect(candidateTokens(funcA)).toEqual([
      'kompass',
      'notiz',
      'ablauf',
      'beispiel',
      'verwechselt',
    ]);
    expect(poolOf(res, 'kompass-notiz')).toBe(null);
    expect(poolOf(res, 'ballon-mitteilung')).toBe(null);
    expect(poolOf(res, 'sicherheitsfix-ohne-pruefung')).toEqual([
      'adversariales-panel-findet-guard-loecher',
    ]);
  });

  // BUG CAUGHT: a stoplist that lost its German half in a merge. The set is the
  // only place the two languages are declared; a silent truncation there would
  // show up as "slightly noisier pools", which nobody notices.
  it('carries both language halves in STOPWORDS', () => {
    for (const w of ['the', 'with', 'which', 'because']) expect(STOPWORDS.has(w)).toBe(true);
    for (const w of ['der', 'die', 'das', 'und', 'nicht', 'werden', 'durch']) {
      expect(STOPWORDS.has(w)).toBe(true);
    }
    expect(STOPWORDS.has('envelope')).toBe(false);
    expect(STOPWORDS.has('guard')).toBe(false);
  });
});

describe('non-transitivity (accepted failure mode 2)', () => {
  // BUG CAUGHT: a transitive-closure / union-find / clustering pass bolted onto
  // the pool. Measured: even at K=3 the directed pool graph collapses into a
  // 99-of-100 giant component, so a closure returns "the corpus" and the judge
  // is handed everything. A pool must stay a per-seed shortlist; chaining is the
  // CONSUMER's decision, bounded at MAX_POOL_HOPS.
  it('does not merge A~B and B~C into A~C', () => {
    const a = record({
      id: 'dddddddd-0000-4000-8000-000000000001',
      subject: 'lockfile-rotation-keeps-backups',
      insight: 'Lockfile rotation keeps three timestamped backups on disk.',
    });
    const b = record({
      id: 'dddddddd-0000-4000-8000-000000000002',
      subject: 'lockfile-rotation-meets-worktree-pruning',
      insight: 'Lockfile rotation interacts with the worktree pruning sweep.',
    });
    const c = record({
      id: 'dddddddd-0000-4000-8000-000000000003',
      subject: 'worktree-pruning-sweep-removes-orphans',
      insight: 'Worktree pruning sweep removes orphaned checkouts.',
    });

    const res = buildCandidatePools([a, b, c], OPTS);

    expect(poolOf(res, 'lockfile-rotation-keeps-backups')).toEqual([
      'lockfile-rotation-meets-worktree-pruning',
    ]);
    expect(poolOf(res, 'worktree-pruning-sweep-removes-orphans')).toEqual([
      'lockfile-rotation-meets-worktree-pruning',
    ]);
    // Membership, not order: which of B's two neighbours scores higher is a
    // property of the fixture wording, and pinning it would make this test fail
    // on a fixture edit that has nothing to do with transitivity.
    expect(poolOf(res, 'lockfile-rotation-meets-worktree-pruning').sort()).toEqual([
      'lockfile-rotation-keeps-backups',
      'worktree-pruning-sweep-removes-orphans',
    ]);
    expect(MAX_POOL_HOPS).toBe(2);
  });
});

describe('exact-key pass runs before any scoring', () => {
  // BUG CAUGHT: scoring first and deduping later. Two records that share a
  // learning_key are duplicates under the EXISTING contract (reconcile keys its
  // whole idempotency layer on it) — if they reach the scorer they become each
  // other's top candidate and burn a pool slot each on a question already
  // answered, while the dropped twin keeps seeding pools of its own.
  it('collapses identical learning_keys and keeps the dropped twin out of every pool', () => {
    const older = record({
      id: 'eeeeeeee-0000-4000-8000-000000000001',
      type: 'anti-pattern',
      subject: 'stdout-truncation-drops-the-decision-envelope',
      insight: 'Node stdout is asynchronous on a pipe; the envelope is discarded.',
      created_at: '2026-06-01T00:00:00.000Z',
    });
    const newer = record({
      ...older,
      id: 'eeeeeeee-0000-4000-8000-000000000002',
      created_at: '2026-07-01T00:00:00.000Z',
    });

    const res = buildCandidatePools([older, newer, P_PROTOCOL], OPTS);

    expect(res.duplicates).toHaveLength(1);
    expect(res.duplicates[0].key).toBe(
      'anti-pattern/stdout-truncation-drops-the-decision-envelope'
    );
    expect(res.duplicates[0].kept.id).toBe('eeeeeeee-0000-4000-8000-000000000002');
    expect(res.duplicates[0].dropped.map((d) => d.id)).toEqual([
      'eeeeeeee-0000-4000-8000-000000000001',
    ]);
    expect(res.stats.duplicatesDropped).toBe(1);

    const pooledIds = res.pools.flatMap((p) => [
      p.seed.id,
      ...p.candidates.map((c) => c.record.id),
    ]);
    expect(pooledIds).not.toContain('eeeeeeee-0000-4000-8000-000000000001');
  });

  // BUG CAUGHT: a locally re-implemented kebab. `learning_key` is the logical
  // dedupe identity of the whole reconcile layer; a divergent slugifier does not
  // produce an ugly key, it FORKS the key space — the same learning renders
  // under two identities and dedupe silently stops firing. Includes the
  // documented unkeyable cases, which must not collapse into one shared key.
  it('derives the key through the shared kebab and returns null when unkeyable', () => {
    expect(learningKey(record({ type: 'anti-pattern', subject: 'Größe der Datei!' }))).toBe(
      'anti-pattern/gr-e-der-datei'
    );
    expect(
      learningKey(record({ type: 'convention', title: 'Title Wins', subject: 'subject-loses' }))
    ).toBe('convention/title-wins');
    expect(learningKey(record({ type: '', subject: 'no-type' }))).toBe(null);
    expect(learningKey(record({ type: 'convention', subject: '', title: '' }))).toBe(null);
    expect(learningKey(record({ type: 'convention', subject: '!!!' }))).toBe(null);
    expect(learningKey(null)).toBe(null);
  });
});

describe('bounds and ordering', () => {
  // BUG CAUGHT: an unbounded pool. Without the per-seed cap a well-connected
  // seed hands its consumer dozens of candidates — and the consumer here is an
  // LLM judgment pass, so an unbounded pool is an unbounded bill. K is a code
  // constant, not a config knob with a `0 = unlimited` sentinel.
  it('caps each pool at K even when far more candidates clear the floor', () => {
    const seed = record({
      id: 'ffffffff-0000-4000-8000-000000000000',
      subject: 'envelope-truncation-seed',
      insight: 'The stdout envelope is truncated past the kernel pipe buffer.',
    });
    const crowd = Array.from({ length: 14 }, (_, i) =>
      record({
        id: `ffffffff-0000-4000-8000-${String(i).padStart(12, '0')}`,
        subject: `envelope-truncation-echo-${i}`,
        insight: 'The stdout envelope is truncated past the kernel pipe buffer.',
      })
    );

    const res = buildCandidatePools([seed, ...crowd], OPTS);
    const pool = res.pools.find((p) => p.seed.subject === 'envelope-truncation-seed');

    expect(CANDIDATE_TOP_K).toBe(8);
    expect(pool.candidates).toHaveLength(CANDIDATE_TOP_K);
    for (const c of pool.candidates) expect(c.score).toBeGreaterThanOrEqual(CANDIDATE_FLOOR);
  });

  // BUG CAUGHT: ordering that falls through to the corpus's on-disk line order
  // when scores tie. All three candidates below are equidistant from the seed by
  // construction, so only the documented created_at DESC → id ASC tiebreak can
  // decide — without it, appending one line to learnings.jsonl silently
  // reshuffles which candidates survive the top-K cut.
  it('breaks score ties by created_at DESC then id ASC', () => {
    const seed = record({
      id: '11111111-0000-4000-8000-000000000000',
      subject: 'retention-window-probe',
      insight: 'Retention window governs the archived snapshot ledger.',
    });
    const tie = (idLetter, token) =>
      record({
        id: `${idLetter.repeat(8)}-0000-4000-8000-000000000000`,
        subject: `${token}-tiebreak`,
        insight: 'Retention window governs the archived snapshot ledger.',
      });
    const newest = { ...tie('z', 'xray'), created_at: '2026-07-02T00:00:00.000Z' };
    const olderA = { ...tie('a', 'yankee'), created_at: '2026-07-01T00:00:00.000Z' };
    const olderB = { ...tie('b', 'zulu'), created_at: '2026-07-01T00:00:00.000Z' };

    const forward = buildCandidatePools([seed, olderB, olderA, newest], OPTS);
    const reversed = buildCandidatePools([newest, olderA, olderB, seed], OPTS);

    expect(poolOf(forward, 'retention-window-probe')).toEqual([
      'xray-tiebreak',
      'yankee-tiebreak',
      'zulu-tiebreak',
    ]);
    expect(poolOf(reversed, 'retention-window-probe')).toEqual(
      poolOf(forward, 'retention-window-probe')
    );
  });

  // BUG CAUGHT: any hidden dependence on input order — a Map iteration, an
  // in-place sort of the caller's array, or df counted over a mutated corpus.
  // `/evolve` reads the file in whatever order it was appended; the pools must
  // not change shape because a line moved.
  it('produces identical pools for a reversed corpus', () => {
    const corpus = [
      P_STDOUT,
      P_PROTOCOL,
      record({
        id: '22222222-0000-4000-8000-000000000001',
        subject: 'worktree-pruning-sweep-removes-orphans',
        insight: 'Worktree pruning sweep removes orphaned checkouts from disk.',
      }),
      record({
        id: '22222222-0000-4000-8000-000000000002',
        subject: 'worktree-pruning-keeps-dirty-checkouts',
        insight: 'Worktree pruning keeps dirty orphaned checkouts on disk.',
      }),
    ];

    const shape = (res) =>
      res.pools.map((p) => [p.seed.subject, p.candidates.map((c) => c.record.subject)]);

    const forward = buildCandidatePools(corpus, OPTS);
    const reversed = buildCandidatePools([...corpus].reverse(), OPTS);

    expect(shape(forward).sort()).toEqual(shape(reversed).sort());
    expect(forward.stats.retained).toBe(reversed.stats.retained);
  });
});

describe('totality', () => {
  // BUG CAUGHT: a throw on a malformed corpus line. This module runs inside
  // /evolve housekeeping over a store that has held malformed lines before
  // (readLearnings has a `malformed` bucket for exactly that reason). A
  // TypeError here would abort the run instead of degrading to "no pools".
  it('returns empty pools instead of throwing on hostile input', () => {
    const hostile = {
      get insight() {
        throw new Error('boom');
      },
      type: 'anti-pattern',
      subject: 'hostile',
    };

    expect(buildCandidatePools(null)).toEqual(emptyPools());
    expect(buildCandidatePools(undefined)).toEqual(emptyPools());
    expect(buildCandidatePools('not-an-array')).toEqual(emptyPools());
    expect(() => buildCandidatePools([hostile, null, 42, 'x', {}, []], OPTS)).not.toThrow();
    expect(buildCandidatePools([hostile, null, 42, 'x', {}, []], OPTS).pools).toEqual([]);
    expect(candidateTokens(42)).toEqual([]);
    expect(candidateTokens(hostile)).toEqual([]);
  });

  // BUG CAUGHT: the same object reference appearing twice in the corpus becoming
  // a pair with ITSELF — a perfect 1.0 self-match that outranks every real
  // candidate and burns the top slot of its own pool.
  it('ignores a duplicated object reference rather than pairing it with itself', () => {
    const res = buildCandidatePools([P_STDOUT, P_STDOUT, P_PROTOCOL], OPTS);

    expect(res.stats.scored).toBe(2);
    expect(poolOf(res, P_STDOUT.subject)).toEqual([
      'exit-protocol-migration-inverts-failure-direction',
    ]);
  });
});

describe('buildCandidatePoolsFromFile', () => {
  let tmpDir;
  let filePath;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'candidates-test-'));
    filePath = join(tmpDir, 'learnings.jsonl');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // BUG CAUGHT: a private second reader that skips the dialect funnel. The
  // corpus carries producer dialects — legacy `files` instead of `file_paths`,
  // aliased types like `gotcha` — and a reader that misses them would compute a
  // zero path boost for records that DO declare paths, and split one type space
  // into two. The malformed line proves a corrupt store degrades rather than
  // throws.
  it('reads through the funnel so legacy dialects are canonical', async () => {
    const legacyA = record({
      id: '33333333-0000-4000-8000-000000000001',
      type: 'gotcha',
      subject: 'stdout-truncation-drops-the-decision-envelope',
      insight: 'Node stdout is asynchronous on a pipe; the envelope is discarded past the buffer.',
      files: ['hooks/_lib/emit.mjs'],
    });
    const legacyB = record({
      id: '33333333-0000-4000-8000-000000000002',
      type: 'proven-pattern',
      subject: 'envelope-protocol-inverts-failure-direction',
      insight: 'Under the stdout envelope protocol a truncated envelope discards the decision.',
      files: ['hooks/_lib/emit.mjs'],
    });
    writeFileSync(
      filePath,
      `${JSON.stringify(legacyA)}\n{ this is not json\n${JSON.stringify(legacyB)}\n`,
      'utf8'
    );

    const res = await buildCandidatePoolsFromFile(filePath, OPTS);
    const pool = res.pools.find(
      (p) => p.seed.subject === 'stdout-truncation-drops-the-decision-envelope'
    );

    expect(res.stats.scored).toBe(2);
    expect(pool.seed.type).toBe('anti-pattern'); // `gotcha` alias resolved
    expect(pool.seed.file_paths).toEqual(['hooks/_lib/emit.mjs']); // `files` dialect resolved
    expect(pool.candidates).toHaveLength(1);
    expect(pool.candidates[0].boost).toBe(PATH_BOOST_EXACT);
  });

  // BUG CAUGHT: an unhandled rejection on a missing store. /evolve may run in a
  // repo that has never written a learning; a throw there would abort the phase
  // rather than report "nothing to reconcile".
  it('returns empty pools for a missing file', async () => {
    const res = await buildCandidatePoolsFromFile(join(tmpDir, 'absent.jsonl'), OPTS);
    expect(res).toEqual(emptyPools());
  });
});
