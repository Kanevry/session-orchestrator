/**
 * tests/lib/scope-gate-collisions.test.mjs
 *
 * Pre-dispatch scope-collision detection (#1020) — `unionFileScopes` and
 * `findScopeCollisions` from scripts/lib/scope-gate.mjs.
 *
 * Every `it` below names the concrete bug it catches that the existing suite
 * does NOT (`.claude/rules/test-value.md` TV-001). The pre-existing coverage in
 * tests/lib/scope-gate.test.mjs exercises `assertFileScopeSubset`, which checks
 * fileScope ⊆ allowedPaths — a SUBSET relation that two colliding agents both
 * satisfy, so it is structurally incapable of catching any case below.
 */

import { describe, it, expect } from 'vitest';
import {
  findScopeCollisions,
  unionFileScopes,
  pathMatchesPattern,
  assertFileScopeSubset,
} from '@lib/scope-gate.mjs';

describe('unionFileScopes (#1020)', () => {
  // BUG: the coordinator keeps the manifest union and the agent briefs as two
  // hand-written lists; they diverged 5× in one session (#1020). A union
  // derived from the per-agent declarations must accept the record shape the
  // plan actually carries — a helper that only took bare arrays would leave the
  // record-shaped call site hand-rolling its own flatten, i.e. the second list
  // again.
  it('accepts both input shapes and deduplicates order-stably', () => {
    expect(unionFileScopes([['b.mjs', 'a.mjs'], ['a.mjs', 'c.mjs']])).toEqual([
      'b.mjs',
      'a.mjs',
      'c.mjs',
    ]);
    expect(
      unionFileScopes([
        { id: 'W1-A', files: ['b.mjs', 'a.mjs'] },
        { id: 'W1-B', files: ['a.mjs', 'c.mjs'] },
      ]),
    ).toEqual(['b.mjs', 'a.mjs', 'c.mjs']);
  });

  // BUG: sorting the union would make every re-union (#796 rewrites the
  // manifest mid-wave) produce a diff unrelated to what changed, and would
  // silently reorder the scope paragraph the brief is generated from.
  it('preserves first-seen order rather than sorting', () => {
    expect(unionFileScopes([['z.mjs', 'a.mjs', 'm.mjs']])).toEqual(['z.mjs', 'a.mjs', 'm.mjs']);
  });

  // BUG: a throw here runs inside hooks/enforce-scope.mjs' hot path, where the
  // exit-0/stdout-JSON protocol reads "no decision" as ALLOW — a crash would
  // silently disable scope enforcement instead of failing loudly.
  it('never throws on malformed input', () => {
    expect(unionFileScopes(null)).toEqual([]);
    expect(unionFileScopes('nope')).toEqual([]);
    expect(unionFileScopes([null, 42, { id: 'x' }, { id: 'y', files: 'no' }])).toEqual([]);
    expect(unionFileScopes([{ id: 'y', files: ['ok.mjs', '', 7, null] }])).toEqual(['ok.mjs']);
  });
});

describe('findScopeCollisions — stage 1: exact equality (#1020)', () => {
  // BUG: #1020 Vorfall 3 verbatim — tests/scripts/sweep-expired-learnings-cli.test.mjs
  // was handed to TWO agents of the same wave. Nothing caught it before
  // dispatch; it surfaced afterwards from an agent's own PSA-002 report.
  it('reports the exact agent pair that claims the same concrete file', () => {
    const result = findScopeCollisions(
      [
        { id: 'W3-A', files: ['scripts/lib/sweep-expired-learnings.mjs', 'tests/scripts/sweep-expired-learnings-cli.test.mjs'] },
        { id: 'W3-B', files: ['scripts/evolve.mjs', 'tests/scripts/sweep-expired-learnings-cli.test.mjs'] },
      ],
      { knownFiles: [] },
    );
    expect(result).toEqual({
      ok: false,
      duplicateIds: [],
      collisions: [
        {
          a: 'W3-A',
          b: 'W3-B',
          kind: 'concrete',
          evidence: ['tests/scripts/sweep-expired-learnings-cli.test.mjs'],
        },
      ],
    });
  });

  // BUG: a naive implementation that counts duplicates across the flattened
  // UNION would flag an agent that lists the same path twice in its own scope
  // as a collision — blocking a legitimate plan on a cosmetic defect.
  it('does not flag an agent overlapping with ITSELF', () => {
    const result = findScopeCollisions(
      [
        { id: 'W3-A', files: ['a.mjs', 'a.mjs'] },
        { id: 'W3-B', files: ['b.mjs'] },
      ],
      { knownFiles: [] },
    );
    expect(result.collisions).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe('findScopeCollisions — stage 2: concrete vs glob (#1020)', () => {
  // BUG: agent A owns scripts/lib/scope-gate.mjs, agent B owns scripts/lib/*.mjs.
  // Both pass assertFileScopeSubset against the union (asserted below), so the
  // one pre-dispatch check that exists today is blind to this overlap — yet B's
  // glob grants exactly A's file.
  it('catches an overlap that assertFileScopeSubset passes', () => {
    const a = ['scripts/lib/scope-gate.mjs'];
    const b = ['scripts/lib/*.mjs'];
    const union = unionFileScopes([a, b]);
    // The existing pre-dispatch assertion is happy with BOTH agents …
    expect(assertFileScopeSubset(a, union).ok).toBe(true);
    expect(assertFileScopeSubset(b, union).ok).toBe(true);
    // … while they in fact claim the same file.
    const result = findScopeCollisions(
      [
        { id: 'W2-L1', files: a },
        { id: 'W2-C1', files: b },
      ],
      { knownFiles: [] },
    );
    expect(result.collisions).toEqual([
      {
        a: 'W2-L1',
        b: 'W2-C1',
        kind: 'concrete',
        evidence: ['scripts/lib/scope-gate.mjs', 'scripts/lib/*.mjs'],
      },
    ]);
  });

  // BUG: `pathMatchesPattern` is DIRECTED. Calling it with the glob as argument
  // 1 always returns false, so a concrete-vs-glob check written in the wrong
  // argument order would silently miss every collision of this class.
  it('detects the overlap in BOTH agent orders', () => {
    const forward = findScopeCollisions([
      { id: 'A', files: ['scripts/lib/x.mjs'] },
      { id: 'B', files: ['scripts/lib/*.mjs'] },
    ]);
    const reversed = findScopeCollisions([
      { id: 'B', files: ['scripts/lib/*.mjs'] },
      { id: 'A', files: ['scripts/lib/x.mjs'] },
    ]);
    expect(forward.collisions.map((c) => c.kind)).toEqual(['concrete']);
    expect(reversed.collisions.map((c) => c.kind)).toEqual(['concrete']);
  });
});

describe('findScopeCollisions — stage 3: glob vs glob (#1020)', () => {
  // BUG (the load-bearing one): `pathMatchesPattern` is exact only for
  // path-vs-glob. For glob∩glob it is neither correct nor symmetric — measured
  // here in both directions — so an implementation that reused
  // assertFileScopeSubset's glob branch would report NO collision for two
  // scopes that both grant scripts/lib/scope-gate.mjs. For a subset check that
  // over-approximation is safe; for a collision check it is a false NEGATIVE,
  // i.e. the incident.
  it('finds a witnessed intersection the directed matcher cannot see', () => {
    const aGlob = 'scripts/lib/*.mjs';
    const bGlob = 'scripts/**/*.test.mjs';
    // The directed matcher settles nothing here: false in BOTH directions for
    // this pair …
    expect(pathMatchesPattern(aGlob, bGlob)).toBe(false);
    expect(pathMatchesPattern(bGlob, aGlob)).toBe(false);
    // … and for a second pair it is asymmetric — false forward, true backward.
    // The `true` is an artefact, not a set relation: the glob passed as
    // argument 1 is treated as a literal path, so its `*` matched as an
    // ordinary character. Neither reading can decide a glob∩glob overlap.
    expect([
      pathMatchesPattern('scripts/**/*.mjs', 'scripts/lib/*.mjs'),
      pathMatchesPattern('scripts/lib/*.mjs', 'scripts/**/*.mjs'),
    ]).toEqual([false, true]);
    // A real file nevertheless witnesses the intersection of aGlob and bGlob.
    expect(pathMatchesPattern('scripts/lib/x.test.mjs', aGlob)).toBe(true);
    expect(pathMatchesPattern('scripts/lib/x.test.mjs', bGlob)).toBe(true);
    const result = findScopeCollisions(
      [
        { id: 'W2-C1', files: [aGlob] },
        { id: 'W2-C4', files: [bGlob] },
      ],
      { knownFiles: ['scripts/lib/x.test.mjs', 'hooks/enforce-scope.mjs'] },
    );
    expect(result.collisions).toEqual([
      { a: 'W2-C1', b: 'W2-C4', kind: 'glob-expanded', evidence: [aGlob, bGlob] },
    ]);
  });

  // BUG: the witness set is drawn from files that EXIST. A wave whose two
  // agents both create new files under an overlapping glob has no witness, so a
  // witness-only stage 3 would pass the plan through — and the collision only
  // materialises once the files are written.
  it('falls back to literal-prefix containment when no witness exists', () => {
    const result = findScopeCollisions(
      [
        { id: 'W2-C1', files: ['scripts/lib/**/*.mjs'] },
        { id: 'W2-C4', files: ['scripts/**/*.mjs'] },
      ],
      { knownFiles: [] },
    );
    expect(result.collisions).toEqual([
      {
        a: 'W2-C1',
        b: 'W2-C4',
        kind: 'glob-prefix',
        evidence: ['scripts/lib/**/*.mjs', 'scripts/**/*.mjs'],
      },
    ]);
  });

  // BUG: `pathMatchesPattern` matches a trailing-slash entry with startsWith,
  // i.e. at ANY depth — so `tests/` is recursive in effect even though it
  // carries no `**`. A recursion test keyed only on the literal `**` would read
  // `tests/` vs `tests/lib/*.mjs` as disjoint and miss the collision.
  it('treats a trailing-slash directory prefix as recursive', () => {
    const result = findScopeCollisions(
      [
        { id: 'A', files: ['tests/'] },
        { id: 'B', files: ['tests/lib/*.mjs'] },
      ],
      { knownFiles: [] },
    );
    expect(result.collisions).toEqual([
      { a: 'A', b: 'B', kind: 'glob-prefix', evidence: ['tests/', 'tests/lib/*.mjs'] },
    ]);
  });
});

describe('findScopeCollisions — negative cases (#1020)', () => {
  // BUG: a collision check that always reports is worthless — it would block
  // every wave plan and be switched off within a session. This is the single
  // most important assertion in the file.
  it('reports ok for a genuinely disjoint wave plan', () => {
    const result = findScopeCollisions(
      [
        { id: 'W2-L1', files: ['scripts/lib/scope-gate.mjs', 'tests/lib/scope-gate-collisions.test.mjs'] },
        { id: 'W2-C1', files: ['scripts/validate-wave-scope.mjs'] },
        { id: 'W2-C4', files: ['hooks/pre-task-scope-disjoint.mjs'] },
      ],
      { knownFiles: ['scripts/lib/scope-gate.mjs', 'scripts/validate-wave-scope.mjs'] },
    );
    expect(result).toEqual({ ok: true, collisions: [], duplicateIds: [] });
  });

  // BUG: the prefix fallback keys on literal PREFIX containment plus recursion.
  // Without a suffix-compatibility filter it would flag `scripts/**\/*.ts`
  // against `scripts/**\/*.mjs` — same prefix, both recursive, yet no path can
  // ever match both. That false positive blocks a legitimate two-language plan.
  it('does not flag two recursive globs with incompatible extensions', () => {
    const result = findScopeCollisions(
      [
        { id: 'A', files: ['scripts/**/*.ts'] },
        { id: 'B', files: ['scripts/**/*.mjs'] },
      ],
      { knownFiles: [] },
    );
    expect(result).toEqual({ ok: true, collisions: [], duplicateIds: [] });
  });

  // BUG: two distinct concrete paths must never collide, whatever their shared
  // directory. A directory-level comparison would flag every pair of siblings
  // in scripts/lib/ — the commonest shape of a well-deconflicted wave.
  it('does not flag two distinct files in the same directory', () => {
    const result = findScopeCollisions([
      { id: 'A', files: ['scripts/lib/a.mjs'] },
      { id: 'B', files: ['scripts/lib/b.mjs'] },
    ]);
    expect(result.collisions).toEqual([]);
  });
});

describe('findScopeCollisions — duplicate ids and fail-closed input (#1020)', () => {
  // BUG: two plan records sharing an id are a malformed plan, not two agents
  // fighting over a file. Folding them into `collisions` would emit a
  // self-referential record (a === b) that names no real conflict, and the
  // operator would chase a phantom deconfliction problem.
  it('reports a duplicate id as its own finding, not as a collision', () => {
    const result = findScopeCollisions([
      { id: 'W2-C1', files: ['a.mjs'] },
      { id: 'W2-C1', files: ['a.mjs'] },
      { id: 'W2-C2', files: ['b.mjs'] },
    ]);
    expect(result.duplicateIds).toEqual(['W2-C1']);
    expect(result.collisions).toEqual([]);
    expect(result.ok).toBe(false);
  });

  // BUG: dropping a record with no usable id would remove its files from the
  // check entirely — a false negative on exactly the sloppily-written record
  // most likely to collide.
  it('keeps an id-less record in the check under a synthetic id', () => {
    const result = findScopeCollisions([
      { files: ['shared.mjs'] },
      { id: 'W2-C1', files: ['shared.mjs'] },
    ]);
    expect(result.collisions).toEqual([
      { a: '<unnamed#0>', b: 'W2-C1', kind: 'concrete', evidence: ['shared.mjs'] },
    ]);
  });

  // BUG: this module is reached from hooks/enforce-scope.mjs on a hot path.
  // Under the exit-0/stdout-JSON protocol a throw produces no decision, which
  // reads as ALLOW — a crash on a malformed plan would silently switch scope
  // enforcement off instead of blocking.
  it('never throws on malformed input and fails closed on a non-array', () => {
    expect(findScopeCollisions(null)).toEqual({ ok: false, collisions: [], duplicateIds: [] });
    expect(findScopeCollisions('nope')).toEqual({ ok: false, collisions: [], duplicateIds: [] });
    expect(findScopeCollisions([null, 7, 'x'])).toEqual({
      ok: true,
      collisions: [],
      duplicateIds: [],
    });
    expect(
      findScopeCollisions(
        [
          { id: 'A', files: ['ok.mjs', null, '', 42] },
          { id: 'B', files: null },
        ],
        null,
      ),
    ).toEqual({ ok: true, collisions: [], duplicateIds: [] });
    expect(
      findScopeCollisions([{ id: 'A', files: ['ok.mjs'] }], { knownFiles: 'not-an-array' }),
    ).toEqual({ ok: true, collisions: [], duplicateIds: [] });
  });
});

describe('findScopeCollisions — fake regression on #1020 Vorfall 3', () => {
  // The acceptance criterion from the issue: an artificially diverging
  // declaration must turn the detection RED, and the corrected one GREEN. The
  // fixture is the real wave-plan assignment from the incident.
  const collidingPlan = [
    {
      id: 'W3-A',
      files: [
        'scripts/lib/sweep-expired-learnings.mjs',
        'tests/scripts/sweep-expired-learnings-cli.test.mjs',
      ],
    },
    {
      id: 'W3-B',
      files: ['scripts/evolve.mjs', 'tests/scripts/sweep-expired-learnings-cli.test.mjs'],
    },
  ];
  const correctedPlan = [
    {
      id: 'W3-A',
      files: [
        'scripts/lib/sweep-expired-learnings.mjs',
        'tests/scripts/sweep-expired-learnings-cli.test.mjs',
      ],
    },
    { id: 'W3-B', files: ['scripts/evolve.mjs', 'tests/scripts/evolve-cli.test.mjs'] },
  ];
  const knownFiles = [
    'scripts/lib/sweep-expired-learnings.mjs',
    'scripts/evolve.mjs',
    'tests/scripts/sweep-expired-learnings-cli.test.mjs',
    'tests/scripts/evolve-cli.test.mjs',
  ];

  it('goes RED on the incident assignment', () => {
    expect(findScopeCollisions(collidingPlan, { knownFiles })).toEqual({
      ok: false,
      duplicateIds: [],
      collisions: [
        {
          a: 'W3-A',
          b: 'W3-B',
          kind: 'concrete',
          evidence: ['tests/scripts/sweep-expired-learnings-cli.test.mjs'],
        },
      ],
    });
  });

  it('goes GREEN once the assignment is disjoint', () => {
    expect(findScopeCollisions(correctedPlan, { knownFiles })).toEqual({
      ok: true,
      collisions: [],
      duplicateIds: [],
    });
  });
});
