/**
 * engine.test.mjs — Unit tests for the #695 FA2 Reconciliation Engine
 * ORCHESTRATOR (`runReconcile`).
 *
 * DI seams (`opts.learnings`, `opts.merge`, `opts.loadLearnings`, `opts.dryRun`)
 * keep every test off the real corpus AND off the real sidecar. The
 * regression-lock test injects a committed fixture via `opts.learnings` so it is
 * deterministic and CI-portable (no read of the gitignored `learnings.jsonl`).
 *
 * The engine's load-bearing scope constraint is asserted: it COMPUTES proposals
 * (content lives inside each proposal object) and RECORDS them via the merge
 * seam, but NEVER writes `.claude/rules/`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, vi } from 'vitest';

import { runReconcile } from '../../../scripts/lib/reconcile/engine.mjs';
import { parseGlobsFrontmatter } from '../../../scripts/lib/rule-loader.mjs';
import { normalizeDialects } from '../../../scripts/lib/learnings/schema.mjs';
import { RECONCILE_FIXTURE } from './_fixtures.mjs';

/** An eligible fragile-pattern learning (real type + non-empty file_paths). */
function eligibleLearning(overrides = {}) {
  return {
    type: 'fragile-pattern',
    subject: 'zx-imports',
    insight: 'Top-level zx imports cause fork-pool fragility',
    confidence: 0.9,
    file_paths: ['scripts/lib/autopilot/worktree-pipeline.mjs'],
    created_at: '2026-06-21T00:00:00Z',
    ...overrides,
  };
}

/** An ineligible learning (type not in the convert allow-list → rejected). */
function rejectLearning(overrides = {}) {
  return {
    type: 'effective-sizing',
    subject: 'deep-session-5w6a',
    confidence: 0.7,
    ...overrides,
  };
}

describe('runReconcile — committed-fixture regression lock (DI-injected dryRun)', () => {
  it('produces the fixture verdict: 6 total / 2 eligible / 2 proposed / 4 rejected / not written', async () => {
    // Pinned `now` (issue #741.1c wiring — engine.mjs now threads nowMs into
    // the eligibility expiry gate). The fixture's two eligible records expire
    // 2026-08-05 (created_at 2026-06-21 + 45d fragile-pattern/recurring-issue
    // TTL) — without this pin, `Date.now()` would flip this fixture-lock to
    // "already-expired-at-proposal" after that date. Pinned well before expiry
    // keeps the assertion deterministic forever.
    const result = await runReconcile(
      { dryRun: true, now: new Date('2026-06-25T00:00:00Z') },
      { learnings: RECONCILE_FIXTURE },
    );

    expect(result.summary).toEqual({
      totalLearnings: 6,
      eligible: 2,
      proposed: 2,
      rejected: 4,
      capped: 0,
      alreadyMaterialized: 0,
      written: false,
    });
    expect(result.proposals).toHaveLength(2);
    expect(result.rejected).toHaveLength(4);
  });
});

describe('runReconcile — DI injection', () => {
  it('partitions injected learnings into 1 proposal + 1 rejection and passes candidates to the merge seam', async () => {
    const merge = vi.fn(() => ({ merged: [], written: true }));

    // Pin `now` before the fixture's 2026-08-05 natural expiry (created_at
    // 2026-06-21 + 45d fragile-pattern TTL) — engine.mjs threads nowMs into the
    // eligibility expiry gate (#741.1c), so an unpinned Date.now() would flip
    // eligibleLearning() to already-expired-at-proposal after that date.
    const result = await runReconcile(
      { now: new Date('2026-06-25T00:00:00Z') },
      { learnings: [eligibleLearning(), rejectLearning()], merge },
    );

    expect(result.summary.proposed).toBe(1);
    expect(result.summary.rejected).toBe(1);
    expect(result.summary.written).toBe(true);

    // The merge seam received the minted candidates (proposal + rejection).
    expect(merge).toHaveBeenCalledTimes(1);
    expect(merge.mock.calls[0][0].candidates).toHaveLength(2);
  });
});

describe('runReconcile — default loader uses the learnings schema SSOT', () => {
  it('converts a legacy dialect record read from disk without requiring a prior backfill', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'reconcile-engine-loader-'));
    try {
      const metricsDir = join(repoRoot, '.orchestrator', 'metrics');
      mkdirSync(metricsDir, { recursive: true });
      writeFileSync(
        join(metricsDir, 'learnings.jsonl'),
        JSON.stringify({
          type: 'anti-pattern',
          name: 'legacy files carrier',
          description: 'Legacy records with files[] must still reconcile through the default loader.',
          evidence: 'Fleet corpus used files[] before file_paths[] became canonical.',
          confidence: 0.9,
          sessions: ['main-2026-07-04-deep-1'],
          created_at: '2026-07-04T00:00:00Z',
          files: ['scripts/lib/reconcile/engine.mjs'],
        }) + '\n',
        'utf8',
      );

      const result = await runReconcile({
        repoRoot,
        dryRun: true,
        now: new Date('2026-07-04T00:00:00Z'),
      });

      expect(result.error).toBeUndefined();
      expect(result.summary).toMatchObject({
        totalLearnings: 1,
        eligible: 1,
        proposed: 1,
        rejected: 0,
        written: false,
      });
      expect(result.proposals).toHaveLength(1);
      expect(result.proposals[0].path).toMatch(
        /^\.claude\/rules\/anti-pattern-legacy-files-carrier-[a-f0-9]{7}\.md$/,
      );
      expect(result.proposals[0].content).toContain(
        'Legacy records with files[] must still reconcile through the default loader.',
      );
      expect(result.proposals[0].content).toContain(
        '- source-session: `main-2026-07-04-deep-1`',
      );
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('runReconcile — empty short-circuit', () => {
  it('returns an all-zero summary, no proposals/rejections, and never writes on an empty corpus', async () => {
    const merge = vi.fn(() => ({ merged: [], written: true }));

    const result = await runReconcile({}, { learnings: [], merge });

    expect(result.proposals).toEqual([]);
    expect(result.rejected).toEqual([]);
    expect(result.summary).toEqual({
      totalLearnings: 0,
      eligible: 0,
      proposed: 0,
      rejected: 0,
      capped: 0,
      alreadyMaterialized: 0,
      written: false,
    });
    // Empty short-circuit touches no disk — merge seam is never invoked.
    expect(merge).not.toHaveBeenCalled();
  });
});

describe('runReconcile — never-throws boundary', () => {
  it('returns a zeroed result with an error field instead of throwing when the loader throws', async () => {
    const result = await runReconcile(
      {},
      {
        loadLearnings: () => {
          throw new Error('boom');
        },
      },
    );

    expect(result.error).toBe('boom');
    expect(result.summary).toEqual({
      totalLearnings: 0,
      eligible: 0,
      proposed: 0,
      rejected: 0,
      capped: 0,
      alreadyMaterialized: 0,
      written: false,
    });
    expect(result.proposals).toEqual([]);
  });
});

describe('runReconcile — minRuleDays / minInsightChars param forwarding (#741.1/#741.2 config plumbing)', () => {
  it('minInsightChars, when forwarded, rejects a non-empty-but-short insight that is eligible by default', async () => {
    const pinnedNow = new Date('2026-06-25T00:00:00Z');
    const shortInsightLearning = eligibleLearning({
      subject: 'short-insight-case',
      insight: 'too short', // 9 chars — non-empty, non-placeholder, but < 24
    });

    // Baseline: minInsightChars omitted (undefined) — the placeholder-insight
    // gate stays inert for a non-empty, non-placeholder insight, so the
    // learning is still proposed.
    const baseline = await runReconcile(
      { dryRun: true, now: pinnedNow },
      { learnings: [shortInsightLearning] },
    );
    expect(baseline.summary.proposed).toBe(1);
    expect(baseline.summary.rejected).toBe(0);

    // Fake-regression note: before this wave wired `minInsightChars` through
    // to `filterEligible` (engine.mjs previously hardcoded the literal
    // `undefined`), this call would have produced the SAME result as the
    // baseline above — the gate below is the fix under test.
    const gated = await runReconcile(
      { dryRun: true, now: pinnedNow, minInsightChars: 24 },
      { learnings: [shortInsightLearning] },
    );
    expect(gated.summary.proposed).toBe(0);
    expect(gated.summary.rejected).toBe(1);
    expect(gated.rejected[0].reason).toContain('min-insight-chars 24');
  });

  it('minRuleDays, when forwarded, floors a near-dead learning\'s expires-at to now + minRuleDays days', async () => {
    // fragile-pattern TTL = 45d (learnings/schema.mjs LEARNING_TYPE_REGISTRY).
    // created_at 2026-05-13 + 45d -> natural expiry 2026-06-27 (2 days after
    // the pinned `now` below — eligible, not already-expired-at-proposal, but
    // near-dead relative to a 15-day floor).
    const nearDeadLearning = eligibleLearning({
      subject: 'near-dead-case',
      created_at: '2026-05-13T00:00:00Z',
    });

    const result = await runReconcile(
      { dryRun: true, now: new Date('2026-06-25T00:00:00Z'), minRuleDays: 15 },
      { learnings: [nearDeadLearning] },
    );

    expect(result.summary.proposed).toBe(1);
    // Fake-regression note: before this wave forwarded `minRuleDays` to
    // `toActivationMetadata`, the emitter's internal MIN_RULE_DAYS_DEFAULT
    // (7d) would have floored this to 2026-07-02 (now+7d) instead of the
    // requested 2026-07-10 (now+15d) — the assertion below is the fix under test.
    expect(result.proposals[0].content).toContain('expires-at: 2026-07-10');
  });
});

describe('runReconcile — max-proposals-per-run volume brake (#900 D, default cap 10)', () => {
  it('caps 15 eligible learnings to the 10 highest-confidence proposals; summary.capped reflects the cut', async () => {
    const learnings = Array.from({ length: 15 }, (_, i) =>
      eligibleLearning({
        subject: `vol-brake-${i}`,
        confidence: 0.5 + i * 0.03, // strictly increasing: 0.50 .. 0.92
        file_paths: [`scripts/lib/vol-brake/${i}.mjs`],
      }),
    );

    const result = await runReconcile(
      { dryRun: true, now: new Date('2026-06-25T00:00:00Z') },
      { learnings },
    );

    expect(result.summary.totalLearnings).toBe(15);
    expect(result.summary.eligible).toBe(15);
    expect(result.summary.proposed).toBe(10);
    expect(result.summary.rejected).toBe(5);
    expect(result.summary.capped).toBe(5);
    expect(result.proposals).toHaveLength(10);

    // Highest-confidence-first: the 5 LOWEST-confidence subjects (indices
    // 0..4, confidence 0.50..0.62) must be the ones cut — never proposed.
    const proposedKeys = result.proposals.map((p) => p.learningKey);
    expect(proposedKeys).not.toContain('fragile-pattern/vol-brake-0');
    expect(proposedKeys).not.toContain('fragile-pattern/vol-brake-4');
    expect(proposedKeys).toContain('fragile-pattern/vol-brake-14');
    expect(proposedKeys).toContain('fragile-pattern/vol-brake-5');

    // Cut entries are recorded as `capped` rejections, not silently dropped.
    const cappedRejections = result.rejected.filter((r) => r.reason.startsWith('capped —'));
    expect(cappedRejections).toHaveLength(5);
  });

  // Cap-RESOLUTION boundary table (issue #950). Consolidates the two former
  // single-value cap tests (`maxProposalsPerRun: 20` above the eligible count,
  // and `maxProposalsPerRun: 0` falling back to the default) into one table and
  // adds the two rows neither of them reached: an explicit cap of exactly 1 and
  // its neighbour 2.
  //
  // TV-001 — the bug this catches that the suite let through: mutating the
  // guard at engine.mjs:294 from `maxProposalsPerRunParam >= 1` to `> 1`
  // (mutation survivor `re1`, docs/mutation-testing/2026-07-31-report.md) makes
  // an explicit cap of exactly 1 — the TIGHTEST brake an operator can set —
  // silently resolve to the default of 10 instead. Both former rows survive
  // that mutation unchanged (20 > 1 and 0 fails either comparison), so no test
  // pinned the lower boundary. Same defect class as the panel-found
  // "never-passed-through max-proposals" HIGH bug: a config value that looks
  // forwarded but is replaced by a default at the point of use.
  //
  // The `cap: 2` row is the counter-probe: it makes the table unsatisfiable by
  // an "always propose exactly 1" implementation. Expected values are hardcoded
  // literals per row, never derived from the production cap formula.
  it.each([
    { cap: 1, eligibleCount: 3, proposed: 1, capped: 2 },
    { cap: 2, eligibleCount: 3, proposed: 2, capped: 1 },
    { cap: 20, eligibleCount: 3, proposed: 3, capped: 0 },
    { cap: 0, eligibleCount: 12, proposed: 10, capped: 2 },
  ])(
    'maxProposalsPerRun=$cap over $eligibleCount eligible learnings proposes exactly $proposed and caps $capped',
    async ({ cap, eligibleCount, proposed, capped }) => {
      const learnings = Array.from({ length: eligibleCount }, (_, i) =>
        eligibleLearning({
          subject: `vol-brake-cap-${cap}-${i}`,
          confidence: 0.5 + i * 0.01,
          file_paths: [`scripts/lib/vol-brake-cap-${cap}/${i}.mjs`],
        }),
      );

      const result = await runReconcile(
        { dryRun: true, now: new Date('2026-06-25T00:00:00Z'), maxProposalsPerRun: cap },
        { learnings },
      );

      expect(result.summary.proposed).toBe(proposed);
      expect(result.summary.capped).toBe(capped);
      expect(result.summary.rejected).toBe(capped);
      expect(result.proposals).toHaveLength(proposed);
    },
  );
});

describe('runReconcile — #900 brandmauer guard: an aliased type without scope never reaches the emitter', () => {
  it('rejects a gotcha (aliased -> anti-pattern) learning with no file_paths and no host_class: 0 proposals, 1 rejection, no rule content minted', async () => {
    // gotcha aliases to anti-pattern (already ruleConvertible:true) via
    // normalizeDialects — exactly what the engine's default loader applies
    // before eligibility runs. This record deliberately carries NEITHER
    // file_paths NOR host_class, so it must be rejected on the FILE gate
    // inside classifyLearning() — never reach toActivationMetadata(), which
    // would otherwise throw (no activation axis) on a bare `anti-pattern`
    // record. A rejection reason of "empty file_paths[]" proves the
    // eligibility gate caught it; a reason of "emit/render error: ..." would
    // mean the eligibility gate was bypassed and only the emitter's own
    // throw-based brandmauer caught it — a strictly weaker second line of
    // defense this test also distinguishes against.
    const rawLearning = {
      type: 'gotcha',
      subject: 'no-scope-gotcha',
      insight: 'A real insight describing a pattern with no scoping information at all.',
      confidence: 0.8,
      created_at: '2026-06-21T00:00:00Z',
    };
    const learning = normalizeDialects(rawLearning);
    expect(learning.type).toBe('anti-pattern'); // sanity: alias resolved

    const result = await runReconcile(
      { dryRun: true, now: new Date('2026-06-25T00:00:00Z') },
      { learnings: [learning] },
    );

    expect(result.summary.proposed).toBe(0);
    expect(result.summary.rejected).toBe(1);
    expect(result.proposals).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toMatch(/empty file_paths/);
    expect(result.rejected[0].reason).not.toMatch(/emit\/render error/);

    // No rule object was ever minted — there is nothing with empty globs or
    // alwaysApply !== false anywhere in the result, because nothing reached
    // the emitter at all.
    expect(result.proposals.every((p) => typeof p.content === 'string' && p.content.length > 0)).toBe(true);
  });

  // Q3-MED fix pass: a record whose ONLY file_paths entry is a glob
  // metacharacter (e.g. '**', from an old learning predating the #900 C /
  // schema.mjs argv-boundary guards) has a non-empty file_paths[] — so it
  // DOES pass the eligibility FILE gate above and DOES reach the emitter.
  // The emitter's globsFromFilePaths now skips the metacharacter entry,
  // producing empty globs; with no host_class, toActivationMetadata throws
  // the never-always-on invariant, and the engine's per-item try/catch
  // degrades this to a rejection — never a minted always-on rule.
  it('a learning whose only file_paths entry is "**" reaches the emitter and is rejected there (never an always-on rule)', async () => {
    const learning = eligibleLearning({
      subject: 'stale-glob-only-learning',
      file_paths: ['**'],
    });

    const result = await runReconcile(
      { dryRun: true, now: new Date('2026-06-25T00:00:00Z') },
      { learnings: [learning] },
    );

    expect(result.summary.proposed).toBe(0);
    expect(result.summary.rejected).toBe(1);
    expect(result.proposals).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    // This time the eligibility gate did NOT catch it (file_paths was
    // non-empty) — the emitter's own throw-based brandmauer is what fired.
    expect(result.rejected[0].reason).toMatch(/emit\/render error/);
    expect(result.rejected[0].reason).toMatch(/never-always-on|activation axis/);
  });
});

describe('runReconcile — sidecar shape-guard drops reach the caller', () => {
  // TV-001 — the bug this catches that the suite let through: `mergeCandidates`
  // rewrites the candidate store in FULL, so a record its read-side shape guard
  // rejects is DELETED from disk by the merge, not merely ignored on read. The
  // guard counts the drop (`mergeCandidates(...).skipped`), but before this
  // change engine.mjs consumed only `mergeResult.written` — the count died at
  // the call site and the data loss was unattributable in practice.
  //
  // The second half is the distinction that makes the field honest: under
  // `dryRun` the merge never runs, so the store is never inspected. Reporting
  // `skipped: 0` there would be a FALSE ALL-CLEAR ("checked, nothing dropped")
  // for a run that checked nothing — absence is the only correct answer.
  //
  // Deliberately uses the REAL `mergeCandidates` against a tmp repoRoot (no
  // merge seam stub): a stubbed seam would only prove the engine forwards a
  // number a test invented, never that the store's own guard is wired through.
  it('reports summary.skipped=1 (plus a stderr WARN) for a record the store guard drops, and OMITS the key entirely under dryRun', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'reconcile-engine-skipped-'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const runtimeDir = join(repoRoot, '.orchestrator', 'runtime');
      mkdirSync(runtimeDir, { recursive: true });
      // The exact form of the 2026-07-31 incident: a hand-written report
      // artefact using candidate_id / generated_at / status:"candidate". No
      // writer in this repo produces this shape, so readStore rejects it.
      writeFileSync(
        join(runtimeDir, 'reconcile-candidates.jsonl'),
        JSON.stringify({
          candidate_id: 'rc-deadbeef',
          generated_at: '2026-07-31T00:00:00Z',
          status: 'candidate',
          slug: 'hand-written-report-artefact',
        }) + '\n',
        'utf8',
      );

      const args = { repoRoot, now: new Date('2026-06-25T00:00:00Z') };
      const learnings = [eligibleLearning()];

      // dryRun: merge skipped entirely ⇒ the store was never inspected.
      const dry = await runReconcile({ ...args, dryRun: true }, { learnings });
      expect(dry.summary.written).toBe(false);
      expect('skipped' in dry.summary).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();

      // Real merge over the real store ⇒ the guard drops the foreign record and
      // the count reaches the caller instead of dying at the call site.
      const wet = await runReconcile(args, { learnings });
      expect(wet.summary.written).toBe(true);
      expect(wet.summary.skipped).toBe(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toContain('reconcile-candidates.jsonl');

      // A clean store on the next run reports 0 — "inspected, nothing dropped"
      // — which is what makes the absent case above distinguishable at all.
      const clean = await runReconcile(args, { learnings });
      expect(clean.summary.skipped).toBe(0);
      expect(warnSpy).toHaveBeenCalledTimes(1); // no second WARN
    } finally {
      warnSpy.mockRestore();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('runReconcile — never writes .claude/rules/', () => {
  it('returns rule content inside the proposal object without persisting any rule file', async () => {
    // A merge stub keeps the real sidecar untouched; the engine NEVER writes
    // .claude/rules/, so the rendered rule is only ever carried in the proposal.
    const merge = vi.fn(() => ({ merged: [], written: true }));

    // Pin `now` before the fixture's 2026-08-05 natural expiry (see #741.1c note above).
    const result = await runReconcile(
      { now: new Date('2026-06-25T00:00:00Z') },
      { learnings: [eligibleLearning()], merge },
    );

    expect(result.proposals).toHaveLength(1);
    expect(typeof result.proposals[0].content).toBe('string');
    expect(result.proposals[0].path).toBe(
      '.claude/rules/fragile-pattern-zx-imports-660952b.md',
    );
    // The ONLY disk write the engine performs is via the merge seam (the
    // sidecar) — and here that seam is a stub, so no real file is written.
    expect(merge).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// #1015 — the production call into toActivationMetadata → renderRule
// (engine.mjs step 4) is reachable with a learning that no upstream validator
// screened for frontmatter safety:
//
//   - `validateLearning` (learnings/schema.mjs) checks only required-field
//     presence, the confidence range, the scope enum, and that `host_class` is
//     "a string or null" — ANY string, newlines included. No newline guard, no
//     length cap, no type enum.
//   - `validateProposalRecord` performs no unknown-key rejection, and
//     memory-proposals/sink.mjs spreads `{...base}`, so any key on a proposal
//     record flows into the learning verbatim. That is what makes `host_class`
//     reachable at all.
//   - `opts.learnings` bypasses `normalizeLearning` entirely, so a caller can
//     inject a raw record with no screening whatsoever.
//
// The engine needs no guard of its own — the emitter's shape gate is the single
// enforcement point, and the engine's existing per-item try/catch turns the
// throw into ONE auditable rejection. These tests pin that composition, which
// is the property a future refactor could silently break.
//
// PAYLOAD NOTE — `tier: always`, deliberately NOT `expires-at:`/`globs:`: the
// renderer emits those LATER in the same frontmatter block, so an injected copy
// is overwritten and the fixture would go green with no guard at all. `tier` is
// never emitted, so it SURVIVES and is the payload that discriminates.
// ---------------------------------------------------------------------------

describe('runReconcile — a frontmatter-injecting learning is rejected, never proposed (#1015)', () => {
  it('records a rejection (not a proposal) for a newline-poisoned host_class and does not throw', async () => {
    const merge = vi.fn(() => ({ merged: [], written: true }));
    const poisoned = eligibleLearning({
      subject: 'poisoned-host',
      host_class: 'macos-arm64-m4pro\ntier: always',
    });

    const result = await runReconcile(
      { now: new Date('2026-06-25T00:00:00Z') },
      { learnings: [poisoned], merge },
    );

    // FALSIFICATION: without the emitter's host_class shape gate this yields
    // proposals:1 whose rendered content carries the injected `tier: always`.
    expect(result.proposals).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].learningKey).toBe('fragile-pattern/poisoned-host');
    expect(result.rejected[0].reason).toMatch(/host_class/);
    expect(result.error).toBeUndefined();
  });

  it('isolates the bad record — a clean sibling in the same run is still proposed', async () => {
    const merge = vi.fn(() => ({ merged: [], written: true }));
    const result = await runReconcile(
      { now: new Date('2026-06-25T00:00:00Z') },
      {
        learnings: [
          eligibleLearning({ subject: 'poisoned-host', host_class: 'x\ntier: always' }),
          eligibleLearning({ subject: 'clean-host', host_class: 'macos-arm64-m4pro' }),
        ],
        merge,
      },
    );

    expect(result.proposals.map((p) => p.learningKey)).toEqual([
      'fragile-pattern/clean-host',
    ]);
    expect(result.rejected.map((r) => r.learningKey)).toEqual([
      'fragile-pattern/poisoned-host',
    ]);
    expect(result.summary.proposed).toBe(1);
    expect(result.summary.rejected).toBe(1);
  });

  it('drops a newline-poisoned file_paths entry from the proposed globs', async () => {
    const merge = vi.fn(() => ({ merged: [], written: true }));
    const result = await runReconcile(
      { now: new Date('2026-06-25T00:00:00Z') },
      {
        learnings: [
          eligibleLearning({
            file_paths: [
              'scripts/evil.mjs\ntier: always',
              'scripts/lib/autopilot/worktree-pipeline.mjs',
            ],
          }),
        ],
        merge,
      },
    );

    expect(result.proposals).toHaveLength(1);
    // Assert on the PARSED frontmatter of the rendered proposal, never a
    // file-wide substring search — a file-wide toContain matches text anywhere
    // in the document (body, provenance block, comment) and so passes for
    // states the frontmatter block never reaches.
    const { globs, meta } = parseGlobsFrontmatter(result.proposals[0].content);
    expect(globs).toEqual(['scripts/lib/autopilot/**']);
    expect(meta.tier).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Issue #484 — idempotency + on-disk dedupe. Before this fix, engine.mjs
// computed `isProcessed`/`isTerminal` in idempotency.mjs but NEVER called
// them, and never looked at `.claude/rules/` at all — a run reproposed every
// eligible learning every time, even the ones a `.claude/rules/*.md` file
// already covered (9 of 10 proposals in one real run were exactly this).
// ---------------------------------------------------------------------------

/** Minimal well-formed rule document carrying a `learning-key:` frontmatter
 * line — mirrors renderer.mjs's real output shape closely enough for the
 * regex-based provenance scan in engine.mjs to find it. */
function materializedRuleDoc(learningKey) {
  return [
    '---',
    'auto-generated: true',
    'alwaysApply: false',
    `learning-key: ${learningKey}`,
    'confidence: 0.8',
    'expires-at: 2099-09-30',
    '---',
    '',
    `# Auto-generated rule: ${learningKey}`,
    '',
  ].join('\n');
}

describe('runReconcile — on-disk dedupe against .claude/rules/ provenance (issue #484)', () => {
  it('does not re-propose a learning whose learning-key already has a materialized rule file, but still proposes a sibling', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'reconcile-engine-dedupe-disk-'));
    try {
      const rulesDir = join(repoRoot, '.claude', 'rules');
      mkdirSync(rulesDir, { recursive: true });
      writeFileSync(
        join(rulesDir, 'fragile-pattern-eligible-frag-existing.md'),
        materializedRuleDoc('fragile-pattern/eligible-frag'),
        'utf8',
      );

      const merge = vi.fn(() => ({ merged: [], written: true }));
      const result = await runReconcile(
        { repoRoot, now: new Date('2026-06-25T00:00:00Z') },
        {
          learnings: [
            // learningKey resolves to fragile-pattern/eligible-frag — matches
            // the on-disk file above.
            eligibleLearning({ subject: 'eligible-frag' }),
            // A genuinely new sibling — must NOT be crowded out by the dedupe.
            eligibleLearning({ subject: 'brand-new', file_paths: ['scripts/lib/new/z.mjs'] }),
          ],
          merge,
        },
      );

      expect(result.summary.eligible).toBe(2);
      expect(result.summary.alreadyMaterialized).toBe(1);
      expect(result.summary.proposed).toBe(1);
      expect(result.summary.rejected).toBe(1);
      expect(result.proposals.map((p) => p.learningKey)).toEqual(['fragile-pattern/brand-new']);

      const dedupeRejection = result.rejected.find(
        (r) => r.learningKey === 'fragile-pattern/eligible-frag',
      );
      expect(dedupeRejection).toBeDefined();
      expect(dedupeRejection.reason).toContain('already materialized');

      // The freshly discovered on-disk match is stamped into the candidates
      // handed to merge() — the SAME write path as every other record this
      // run produces (never a second one) — so a future run can dedupe via
      // the sidecar alone, without rescanning .claude/rules/.
      expect(merge).toHaveBeenCalledTimes(1);
      const mergedCandidates = merge.mock.calls[0][0].candidates;
      const stampedRecord = mergedCandidates.find(
        (c) => c.learning_key === 'fragile-pattern/eligible-frag',
      );
      expect(stampedRecord).toBeDefined();
      expect(stampedRecord.outcome).toBe('already-on-disk');
      expect(typeof stampedRecord.processed_at).toBe('string');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('a learning stamped terminal via an on-disk match in run 1 is still skipped in run 2 even after the rule file is removed (sidecar isProcessed() carries the verdict, not a re-scan)', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'reconcile-engine-dedupe-persist-'));
    try {
      const rulesDir = join(repoRoot, '.claude', 'rules');
      mkdirSync(rulesDir, { recursive: true });
      const ruleFilePath = join(rulesDir, 'fragile-pattern-persist-case.md');
      writeFileSync(ruleFilePath, materializedRuleDoc('fragile-pattern/persist-case'), 'utf8');

      const learnings = [eligibleLearning({ subject: 'persist-case' })];
      const args = { repoRoot, now: new Date('2026-06-25T00:00:00Z') };

      // Run 1 — REAL merge (no stub, no dryRun): discovers the on-disk match
      // and stamps it terminal into the real sidecar under repoRoot.
      const run1 = await runReconcile(args, { learnings });
      expect(run1.summary.alreadyMaterialized).toBe(1);
      expect(run1.summary.proposed).toBe(0);
      expect(run1.summary.written).toBe(true);

      // Remove the rule file. If run 2 skipped this learning ONLY because of
      // the disk scan, it would propose it again now — it must not: the
      // sidecar stamp from run 1 has to carry the terminal verdict forward.
      rmSync(ruleFilePath);

      const run2 = await runReconcile(args, { learnings });
      // Still counted as materialized — but now via the SIDECAR verdict
      // (isProcessed()), not a fresh disk match (the file is gone).
      expect(run2.summary.alreadyMaterialized).toBe(1);
      expect(run2.summary.proposed).toBe(0); // still not proposed — isProcessed() caught it
      const rej = run2.rejected.find((r) => r.learningKey === 'fragile-pattern/persist-case');
      expect(rej).toBeDefined();
      expect(rej.reason).toContain('already processed');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
