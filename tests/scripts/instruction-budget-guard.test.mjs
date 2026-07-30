/**
 * tests/scripts/instruction-budget-guard.test.mjs
 *
 * Unit tests for scripts/lib/instruction-budget-guard.mjs — #687.
 *
 * Behaviour under test (NOT implementation):
 *   - computeInstructionBudget sums always-on directives across rule files,
 *     excluding glob-scoped rules (membership via rule-loader) and fenced code.
 *   - perFile is sorted DESC by count; totalDirectives is the sum.
 *   - overBudget / severity flip at the ceiling boundary.
 *   - checkInstructionBudget returns null under ceiling, a banner over it.
 *   - Never throws: missing dir → safe empty shape / null.
 *
 * Fixtures use mkdtempSync under os.tmpdir() (portable; owner-leakage gate
 * blocks hardcoded home paths). Expected directive counts are HAND-COUNTED
 * literals — never computed from the production heuristic.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  computeInstructionBudget,
  checkInstructionBudget,
  loadInstructionBudgetConfig,
  _parseInstructionBudget,
  countDirectives,
  DEFAULT_CEILING,
  DEFAULT_BYTE_CEILING,
} from '@lib/instruction-budget-guard.mjs';

// ---------------------------------------------------------------------------
// Fixture management
// ---------------------------------------------------------------------------

const tmpDirs = [];

function makeTmpRulesDir() {
  const dir = mkdtempSync(join(tmpdir(), 'instr-budget-test-'));
  tmpDirs.push(dir);
  return dir;
}

function writeRule(dir, name, content) {
  writeFileSync(join(dir, name), content, 'utf8');
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Fixtures — directive counts hand-derived below each constant.
// ---------------------------------------------------------------------------

// alpha: always-on (no frontmatter).
//   ## Section A      -> heading depth 2   (1)
//   - bullet one      -> bullet            (2)
//   - bullet two      -> bullet            (3)
//   ### Subsection    -> heading depth 3   (4)
//   1. ordered one    -> ordered           (5)
//   2. ordered two    -> ordered           (6)
//   (# Alpha Rule is depth-1 → NOT counted; plain text → NOT counted)
// => 6 directives
const ALPHA = `# Alpha Rule

## Section A

Some intro prose that is not a directive.

- bullet one
- bullet two

### Subsection

1. ordered one
2. ordered two

Closing paragraph.
`;
const ALPHA_COUNT = 6;
// ALPHA has no frontmatter, so its byte total is the full raw content —
// hand-verified via `Buffer.byteLength(ALPHA, 'utf8')` run standalone
// (NOT via the production countContentBytes heuristic under test; #877).
const ALPHA_BYTES = 164;

// beta: always-on, contains a fenced code block whose bullets/headings must be ignored.
//   ## Heading B      -> heading depth 2   (1)
//   - real bullet     -> bullet            (2)
//   [fence opens]
//     - fake bullet in fence       -> IGNORED
//     ## fake heading in fence     -> IGNORED
//   [fence closes]
//   * bullet after fence -> bullet         (3)
// => 3 directives
const BETA = `## Heading B

- real bullet

\`\`\`bash
- fake bullet in fence
## fake heading in fence
+ another fake
\`\`\`

* bullet after fence
`;
const BETA_COUNT = 3;
// BETA also has no frontmatter, so its byte total is the full raw content
// INCLUDING the fenced block's 3 fake lines — the byte dimension does NOT
// exclude fenced content the way countDirectives does (#877: that
// divergence is intentional, see instruction-budget-guard.mjs doc).
const BETA_BYTES = 126;

// delta: always-on, has YAML frontmatter WITHOUT globs (still always-on).
//   frontmatter title:/description: lines must NOT be counted.
//   ## Delta Heading  -> heading depth 2   (1)
//   - d bullet        -> bullet            (2)
// => 2 directives
const DELTA = `---
title: Delta
description: has frontmatter but no globs key
---

## Delta Heading

- d bullet
`;
const DELTA_COUNT = 2;
// DELTA's byte total excludes the frontmatter block (same skip logic
// countDirectives uses) — only the body "\n## Delta Heading\n\n- d bullet\n"
// counts, hand-verified via `Buffer.byteLength` on that body string alone.
const DELTA_BYTES = 30;

// gamma: glob-scoped → EXCLUDED from the always-on count entirely.
// Its bullets would count as 3 if (wrongly) included.
const GAMMA = `---
globs:
  - "**/*.ts"
---

## Gamma Heading

- g one
- g two
`;

function makeFullFixture() {
  const dir = makeTmpRulesDir();
  writeRule(dir, 'alpha.md', ALPHA);
  writeRule(dir, 'beta.md', BETA);
  writeRule(dir, 'delta.md', DELTA);
  writeRule(dir, 'gamma.md', GAMMA);
  return dir;
}

// ---------------------------------------------------------------------------
// computeInstructionBudget — core counting + membership
// ---------------------------------------------------------------------------

describe('computeInstructionBudget — directive counting', () => {
  it('sums always-on directives and excludes glob-scoped rules', () => {
    const dir = makeFullFixture();

    const result = computeInstructionBudget({ rulesDir: dir, ceiling: 1000 });

    // 11 hand-counted directives across the 3 always-on files; gamma excluded.
    expect(result.totalDirectives).toBe(11);
    expect(result.ceiling).toBe(1000);
    expect(result.overBudget).toBe(false);
    expect(result.severity).toBe('ok');
  });

  it('reports exact per-file counts sorted DESC by count', () => {
    const dir = makeFullFixture();

    const result = computeInstructionBudget({ rulesDir: dir, ceiling: 1000 });

    // gamma.md (glob-scoped) is absent; alpha(6) > beta(3) > delta(2).
    // Expected counts are the hand-derived per-fixture literals (see fixture
    // comments above), pinned here to catch a DESC-sort or membership regression.
    expect(result.perFile).toEqual([
      { file: 'alpha.md', count: ALPHA_COUNT, bytes: ALPHA_BYTES },
      { file: 'beta.md', count: BETA_COUNT, bytes: BETA_BYTES },
      { file: 'delta.md', count: DELTA_COUNT, bytes: DELTA_BYTES },
    ]);
  });

  it('does not count bullets or headings inside a fenced code block', () => {
    const dir = makeTmpRulesDir();
    writeRule(dir, 'beta.md', BETA);

    const result = computeInstructionBudget({ rulesDir: dir, ceiling: 1000 });

    // 3 real directives; the 3 fenced lines are ignored.
    expect(result.totalDirectives).toBe(3);
    expect(result.perFile).toEqual([{ file: 'beta.md', count: 3, bytes: BETA_BYTES }]);
  });

  it('does not count YAML frontmatter lines as directives', () => {
    const dir = makeTmpRulesDir();
    writeRule(dir, 'delta.md', DELTA);

    const result = computeInstructionBudget({ rulesDir: dir, ceiling: 1000 });

    // title:/description: frontmatter lines excluded → only 2 body directives.
    expect(result.totalDirectives).toBe(2);
  });

  it('excludes a glob-scoped rule from the count entirely', () => {
    const dir = makeTmpRulesDir();
    writeRule(dir, 'gamma.md', GAMMA);

    const result = computeInstructionBudget({ rulesDir: dir, ceiling: 1000 });

    // gamma is glob-scoped: zero always-on directives despite its 2 bullets.
    expect(result.totalDirectives).toBe(0);
    expect(result.perFile).toEqual([]);
    expect(result.overBudget).toBe(false);
    expect(result.severity).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// #795 — `paths:` alias membership (regression at the budget layer).
//
// scripts/lib/rule-loader.mjs now recognises `paths:` frontmatter as an
// alias for `globs:` (globs: wins when both are present). computeInstructionBudget
// delegates always-on membership to loadApplicableRules with scopePaths: [],
// so a `paths:`-scoped rule must be excluded from the always-on total exactly
// like a `globs:`-scoped rule already is (see GAMMA above).
// ---------------------------------------------------------------------------

// scoped: `paths:`-scoped body (no `globs:` key at all).
//   ## Scoped Heading  -> heading depth 2   (1)
//   - scoped bullet one -> bullet          (2)
//   - scoped bullet two -> bullet          (3)
//   - scoped bullet three -> bullet        (4)
// => 4 directives IF (wrongly) counted as always-on; 0 when properly excluded.
const PATHS_SCOPED_BODY = `## Scoped Heading

- scoped bullet one
- scoped bullet two
- scoped bullet three
`;
const PATHS_SCOPED_BODY_COUNT = 4;
// No frontmatter in PATHS_SCOPED_BODY itself (only PATHS_SCOPED wraps it in
// one) — hand-verified via `Buffer.byteLength` standalone (#877).
const PATHS_SCOPED_BODY_BYTES = 81;

const PATHS_SCOPED = `---
paths:
  - "**/*.ts"
---

${PATHS_SCOPED_BODY}`;

// unscoped: no frontmatter at all — always-on regardless of the #795 fix.
//   ## Unscoped Heading -> heading depth 2  (1)
//   - unscoped bullet   -> bullet           (2)
// => 2 directives
const UNSCOPED_ALWAYS_ON = `## Unscoped Heading

- unscoped bullet
`;
const UNSCOPED_ALWAYS_ON_COUNT = 2;
// No frontmatter — hand-verified via `Buffer.byteLength` standalone (#877).
const UNSCOPED_ALWAYS_ON_BYTES = 39;

describe('#795 paths:-scoped rules excluded from always-on budget', () => {
  it('excludes a paths:-scoped rule from the always-on total, counting only the unscoped rule', () => {
    const dir = makeTmpRulesDir();
    writeRule(dir, 'scoped.md', PATHS_SCOPED);
    writeRule(dir, 'unscoped.md', UNSCOPED_ALWAYS_ON);

    const result = computeInstructionBudget({ rulesDir: dir, ceiling: 1000 });

    // scoped.md's 4 directives must NOT be counted — only unscoped.md's 2.
    expect(result.totalDirectives).toBe(2);
    expect(result.perFile).toEqual([{ file: 'unscoped.md', count: 2, bytes: UNSCOPED_ALWAYS_ON_BYTES }]);
  });

  it('fake-regression control: the SAME rule body WITHOUT the paths: key counts as always-on (proves the exclusion above is real, not a naming fluke)', () => {
    const dir = makeTmpRulesDir();
    // Same body as PATHS_SCOPED, but with the paths: frontmatter stripped —
    // this file is now always-on and MUST count. If the paths: alias were
    // broken (e.g. reverted to pre-#795 behaviour), the PRIOR test would
    // ALSO count scoped.md's 4 directives, making totalDirectives 6 there
    // instead of 2 — that is exactly the regression this pair of tests catches.
    writeRule(dir, 'scoped.md', PATHS_SCOPED_BODY);
    writeRule(dir, 'unscoped.md', UNSCOPED_ALWAYS_ON);

    const result = computeInstructionBudget({ rulesDir: dir, ceiling: 1000 });

    expect(result.totalDirectives).toBe(6);
    expect(result.perFile).toEqual([
      { file: 'scoped.md', count: PATHS_SCOPED_BODY_COUNT, bytes: PATHS_SCOPED_BODY_BYTES },
      { file: 'unscoped.md', count: UNSCOPED_ALWAYS_ON_COUNT, bytes: UNSCOPED_ALWAYS_ON_BYTES },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Ceiling boundary
// ---------------------------------------------------------------------------

describe('computeInstructionBudget — ceiling boundary', () => {
  it('flags overBudget when total strictly exceeds the ceiling', () => {
    const dir = makeFullFixture(); // total = 11

    const result = computeInstructionBudget({ rulesDir: dir, ceiling: 10 });

    expect(result.totalDirectives).toBe(11);
    expect(result.overBudget).toBe(true);
    expect(result.severity).toBe('warn');
  });

  it('does not flag overBudget when total equals the ceiling', () => {
    const dir = makeFullFixture(); // total = 11

    const result = computeInstructionBudget({ rulesDir: dir, ceiling: 11 });

    expect(result.overBudget).toBe(false);
    expect(result.severity).toBe('ok');
  });

  it('does not flag overBudget when total is just under the ceiling', () => {
    const dir = makeFullFixture(); // total = 11

    const result = computeInstructionBudget({ rulesDir: dir, ceiling: 12 });

    expect(result.overBudget).toBe(false);
    expect(result.severity).toBe('ok');
  });

  it('defaults ceiling to 480 when not supplied', () => {
    const dir = makeFullFixture(); // total = 11

    const result = computeInstructionBudget({ rulesDir: dir });

    expect(result.ceiling).toBe(480);
    expect(DEFAULT_CEILING).toBe(480);
    expect(result.overBudget).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #877 FA2 — byte dimension (totalBytes / perFile[].bytes)
// ---------------------------------------------------------------------------

describe('computeInstructionBudget — byte dimension (#877)', () => {
  it('sums totalBytes across always-on files, excluding the glob-scoped gamma.md', () => {
    const dir = makeFullFixture();

    const result = computeInstructionBudget({ rulesDir: dir, ceiling: 1000 });

    // ALPHA_BYTES + BETA_BYTES + DELTA_BYTES — gamma.md contributes 0 (it is
    // glob-scoped, excluded from the always-on set entirely, same membership
    // rule as totalDirectives above).
    expect(result.totalBytes).toBe(ALPHA_BYTES + BETA_BYTES + DELTA_BYTES);
  });

  it('excludes YAML frontmatter bytes from the byte total, mirroring countDirectives', () => {
    const dir = makeTmpRulesDir();
    writeRule(dir, 'delta.md', DELTA);

    const result = computeInstructionBudget({ rulesDir: dir, ceiling: 1000 });

    // DELTA_BYTES is hand-derived from the BODY only (frontmatter stripped);
    // if frontmatter bytes leaked into the count, this would be larger.
    expect(result.totalBytes).toBe(DELTA_BYTES);
  });

  it('includes fenced-code bytes in totalBytes even though countDirectives excludes them from totalDirectives', () => {
    const dir = makeTmpRulesDir();
    writeRule(dir, 'beta.md', BETA);

    const result = computeInstructionBudget({ rulesDir: dir, ceiling: 1000 });

    // BETA has no frontmatter, so BETA_BYTES is its FULL raw byte length —
    // including the 3 fenced fake-directive lines. Contrast with
    // totalDirectives, which excludes those same lines (3, not 6).
    expect(result.totalBytes).toBe(BETA_BYTES);
    expect(result.totalDirectives).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// #877 FA2 — countDirectives export (reused by the byte walk, not duplicated)
// ---------------------------------------------------------------------------

describe('countDirectives — exported for reuse (#877)', () => {
  it('is exported and matches the hand-counted literals used elsewhere in this file', () => {
    expect(countDirectives(ALPHA)).toBe(ALPHA_COUNT);
    expect(countDirectives(BETA)).toBe(BETA_COUNT);
    expect(countDirectives(DELTA)).toBe(DELTA_COUNT);
  });

  it('perFile.count from computeInstructionBudget is identical to a direct countDirectives call (no second classifier)', () => {
    const dir = makeFullFixture();

    const result = computeInstructionBudget({ rulesDir: dir, ceiling: 1000 });
    const alphaEntry = result.perFile.find((f) => f.file === 'alpha.md');

    expect(alphaEntry.count).toBe(countDirectives(ALPHA));
  });
});

// ---------------------------------------------------------------------------
// #877 FA2 — bySurface tier split.
//
// Fixtures below carry explicit `tier:` frontmatter (issue #692) with NO
// `globs:`/`paths:` key, so all four stay in the always-on set. Byte counts
// are hand-derived the same way as the fixtures above (Buffer.byteLength on
// the post-frontmatter body, verified standalone — never via the SUT).
// ---------------------------------------------------------------------------

// tierAlways: `tier: always`, body = "\n- a\n" after frontmatter strip.
//   1 directive (the bullet); byte body is 5 bytes: \n, -, space, a, \n.
const TIER_ALWAYS = `---
tier: always
---

- a
`;
const TIER_ALWAYS_COUNT = 1;
const TIER_ALWAYS_BYTES = 5;

// tierCoord: `tier: coordinator-only`, same body shape as TIER_ALWAYS (- c).
const TIER_COORD = `---
tier: coordinator-only
---

- c
`;
const TIER_COORD_COUNT = 1;
const TIER_COORD_BYTES = 5;

// tierWave: `tier: wave-only`, same body shape (- w). Structurally unusual
// (no repo file currently combines always-on + wave-only) but valid per
// rule-loader's tier contract — needed to exercise the nesting invariant.
const TIER_WAVE = `---
tier: wave-only
---

- w
`;
const TIER_WAVE_COUNT = 1;
const TIER_WAVE_BYTES = 5;

// tierUntagged: no `tier:` key at all, no frontmatter — always-on and
// tier-unrestricted (passes every context gate; NOT part of bySurface.always,
// which is scoped strictly to `tier === 'always'`).
const TIER_UNTAGGED = `- u
`;
const TIER_UNTAGGED_COUNT = 1;
const TIER_UNTAGGED_BYTES = 4;

function makeTierFixture() {
  const dir = makeTmpRulesDir();
  writeRule(dir, 'tier-always.md', TIER_ALWAYS);
  writeRule(dir, 'tier-coord.md', TIER_COORD);
  writeRule(dir, 'tier-wave.md', TIER_WAVE);
  writeRule(dir, 'tier-untagged.md', TIER_UNTAGGED);
  return dir;
}

describe('computeInstructionBudget — bySurface tier split (#877; corrected #893)', () => {
  it('bySurface.coordinator excludes tier:wave-only bytes (#893 — mirrors loadApplicableRules({context:"coordinator"}), NOT the full untiered corpus)', () => {
    const dir = makeTierFixture();

    const result = computeInstructionBudget({ rulesDir: dir, ceiling: 1000 });

    // always + coordinator-only + untagged — wave-only (tier-wave.md) is excluded.
    expect(result.bySurface.coordinator).toBe(
      TIER_ALWAYS_BYTES + TIER_COORD_BYTES + TIER_UNTAGGED_BYTES,
    );
    // Pre-#893 this equaled totalBytes (the full untiered corpus); it no
    // longer does, because totalBytes (no context requested) still includes
    // the wave-only file that bySurface.coordinator now correctly excludes.
    expect(result.bySurface.coordinator).not.toBe(result.totalBytes);
  });

  it('bySurface.wave excludes tier:coordinator-only bytes (what a wave agent actually receives)', () => {
    const dir = makeTierFixture();

    const result = computeInstructionBudget({ rulesDir: dir, ceiling: 1000 });

    // always + wave-only + untagged — coordinator-only (tier-coord.md) is excluded.
    expect(result.bySurface.wave).toBe(TIER_ALWAYS_BYTES + TIER_WAVE_BYTES + TIER_UNTAGGED_BYTES);
  });

  it('bySurface.always is scoped strictly to tier:always (excludes untagged, coordinator-only, wave-only)', () => {
    const dir = makeTierFixture();

    const result = computeInstructionBudget({ rulesDir: dir, ceiling: 1000 });

    expect(result.bySurface.always).toBe(TIER_ALWAYS_BYTES);
  });

  it('always is a subset of BOTH wave and coordinator (each surface individually), but wave and coordinator are NOT nested in each other (#893)', () => {
    const dir = makeTierFixture();

    const result = computeInstructionBudget({ rulesDir: dir, ceiling: 1000 });

    // `always` never exceeds either sibling surface — neither tier gate
    // excludes `tier: always` content.
    expect(result.bySurface.always).toBeLessThanOrEqual(result.bySurface.wave);
    expect(result.bySurface.always).toBeLessThanOrEqual(result.bySurface.coordinator);
    // In THIS fixture wave and coordinator happen to be equal (symmetric
    // 5-byte coordinator-only/wave-only bodies) — that is fixture
    // coincidence, not a general `wave ⊆ coordinator` invariant. See the
    // asymmetric-fixture test below for the case where they diverge.
    expect(result.bySurface.wave).toBe(result.bySurface.coordinator);
  });

  it('does NOT implement the additive coordinator + wave === totalBytes identity (would double-count the always tier)', () => {
    const dir = makeTierFixture();

    const result = computeInstructionBudget({ rulesDir: dir, ceiling: 1000 });

    // coordinator(14) + wave(14) = 28 ≠ totalBytes(19, untiered — no context
    // requested) — the additive PRD identity is mathematically impossible
    // here and must NOT hold.
    expect(result.bySurface.coordinator + result.bySurface.wave).not.toBe(result.totalBytes);
    expect(result.bySurface.coordinator).toBe(14);
    expect(result.bySurface.wave).toBe(14);
    expect(result.totalBytes).toBe(19);
  });
});

// ---------------------------------------------------------------------------
// #893 — asymmetric tier fixture: a BIGGER coordinator-only body than the
// wave-only body, so `bySurface.wave` and `bySurface.coordinator` can never
// coincidentally match the way they do in the symmetric makeTierFixture()
// above. Proves (a) wave/coordinator are genuinely sibling projections, not
// nested, and (b) bySurface stays computed identically regardless of which
// `context` was requested for the PRIMARY totals (M1).
// ---------------------------------------------------------------------------

// coordBig: `tier: coordinator-only`, 2-bullet body (bigger than tier-wave's
// 1-bullet body). Byte/count hand-verified standalone via Buffer.byteLength
// on the post-frontmatter body — never via the SUT.
const TIER_COORD_BIG = `---
tier: coordinator-only
---

- coordinator only bullet one
- coordinator only bullet two
`;
const TIER_COORD_BIG_BYTES = 61;

function makeAsymmetricTierFixture() {
  const dir = makeTmpRulesDir();
  writeRule(dir, 'tier-always.md', TIER_ALWAYS);
  writeRule(dir, 'tier-coord-big.md', TIER_COORD_BIG);
  writeRule(dir, 'tier-wave.md', TIER_WAVE);
  writeRule(dir, 'tier-untagged.md', TIER_UNTAGGED);
  return dir;
}

describe('computeInstructionBudget — bySurface context-independence, asymmetric fixture (#893 M1)', () => {
  it('bySurface is identical across context:"wave", context:"coordinator", and no context at all', () => {
    const dir = makeAsymmetricTierFixture();

    const withWave = computeInstructionBudget({ rulesDir: dir, ceiling: 1000, context: 'wave' });
    const withCoordinator = computeInstructionBudget({
      rulesDir: dir,
      ceiling: 1000,
      context: 'coordinator',
    });
    const withNoContext = computeInstructionBudget({ rulesDir: dir, ceiling: 1000 });

    const expectedBySurface = {
      coordinator: TIER_ALWAYS_BYTES + TIER_COORD_BIG_BYTES + TIER_UNTAGGED_BYTES, // 70
      wave: TIER_ALWAYS_BYTES + TIER_WAVE_BYTES + TIER_UNTAGGED_BYTES, // 14
      always: TIER_ALWAYS_BYTES, // 5
    };

    expect(withWave.bySurface).toEqual(expectedBySurface);
    expect(withCoordinator.bySurface).toEqual(expectedBySurface);
    expect(withNoContext.bySurface).toEqual(expectedBySurface);
  });

  it('a context:"wave" call narrows totalBytes below bySurface.coordinator, proving bySurface.coordinator is NOT re-derived from the narrowed selection', () => {
    const dir = makeAsymmetricTierFixture();

    const result = computeInstructionBudget({ rulesDir: dir, ceiling: 1000, context: 'wave' });

    // totalBytes (wave-narrowed) excludes the big coordinator-only file.
    expect(result.totalBytes).toBe(TIER_ALWAYS_BYTES + TIER_WAVE_BYTES + TIER_UNTAGGED_BYTES); // 14
    // bySurface.coordinator still reports the FULL coordinator-surface sum,
    // unaffected by the 'wave' context requested for the primary totals.
    expect(result.bySurface.coordinator).toBe(
      TIER_ALWAYS_BYTES + TIER_COORD_BIG_BYTES + TIER_UNTAGGED_BYTES,
    ); // 70
    expect(result.bySurface.coordinator).not.toBe(result.totalBytes);
  });

  it('wave and coordinator are genuinely sibling projections here — coordinator is bigger than wave (no nesting invariant)', () => {
    const dir = makeAsymmetricTierFixture();

    const result = computeInstructionBudget({ rulesDir: dir, ceiling: 1000 });

    expect(result.bySurface.wave).toBe(14);
    expect(result.bySurface.coordinator).toBe(70);
    expect(result.bySurface.wave).toBeLessThan(result.bySurface.coordinator);
  });
});

// ---------------------------------------------------------------------------
// #893 M2 — context: 'coordinator' PRIMARY totals (totalDirectives/totalBytes/
// perFile). Before the fix, 'coordinator' silently coerced to the untiered
// `null` shape (same bug class as bySurface.coordinator above, but for the
// PRIMARY totals instead of the surface split).
// ---------------------------------------------------------------------------

describe('computeInstructionBudget — context: "coordinator" narrows PRIMARY totals (#893 M2)', () => {
  it('excludes tier:wave-only from totalDirectives/totalBytes/perFile, mirroring loadApplicableRules({context:"coordinator"})', () => {
    const dir = makeTierFixture();

    const result = computeInstructionBudget({ rulesDir: dir, ceiling: 1000, context: 'coordinator' });

    expect(result.totalDirectives).toBe(
      TIER_ALWAYS_COUNT + TIER_COORD_COUNT + TIER_UNTAGGED_COUNT,
    );
    expect(result.totalBytes).toBe(TIER_ALWAYS_BYTES + TIER_COORD_BYTES + TIER_UNTAGGED_BYTES);
    expect(result.perFile.map((f) => f.file).sort()).toEqual([
      'tier-always.md',
      'tier-coord.md',
      'tier-untagged.md',
    ]);
  });

  it('fake-regression control: context:"wave" on the SAME fixture includes the wave-only file instead (proves the two contexts genuinely select different sets, not a naming fluke)', () => {
    const dir = makeTierFixture();

    const coordinatorResult = computeInstructionBudget({
      rulesDir: dir,
      ceiling: 1000,
      context: 'coordinator',
    });
    const waveResult = computeInstructionBudget({ rulesDir: dir, ceiling: 1000, context: 'wave' });

    expect(coordinatorResult.perFile.map((f) => f.file).sort()).not.toContain('tier-wave.md');
    expect(waveResult.perFile.map((f) => f.file).sort()).toContain('tier-wave.md');
    expect(waveResult.perFile.map((f) => f.file).sort()).not.toContain('tier-coord.md');
  });
});

// ---------------------------------------------------------------------------
// #877 FA2 — context param
// ---------------------------------------------------------------------------

describe('computeInstructionBudget — context param (#877)', () => {
  it('context: "wave" narrows totalDirectives/totalBytes/perFile to exclude tier:coordinator-only files', () => {
    const dir = makeTierFixture();

    const result = computeInstructionBudget({ rulesDir: dir, ceiling: 1000, context: 'wave' });

    expect(result.totalDirectives).toBe(TIER_ALWAYS_COUNT + TIER_WAVE_COUNT + TIER_UNTAGGED_COUNT);
    expect(result.totalBytes).toBe(TIER_ALWAYS_BYTES + TIER_WAVE_BYTES + TIER_UNTAGGED_BYTES);
    expect(result.perFile.map((f) => f.file).sort()).toEqual([
      'tier-always.md',
      'tier-untagged.md',
      'tier-wave.md',
    ]);
  });

  it('omitting context preserves the pre-#877 tier-agnostic total (every always-on file counted)', () => {
    const dir = makeTierFixture();

    const result = computeInstructionBudget({ rulesDir: dir, ceiling: 1000 });

    expect(result.totalDirectives).toBe(
      TIER_ALWAYS_COUNT + TIER_COORD_COUNT + TIER_WAVE_COUNT + TIER_UNTAGGED_COUNT,
    );
    expect(result.perFile).toHaveLength(4);
  });

  it('an unrecognised context value falls back to the tier-agnostic default (fail-open, never throws)', () => {
    const dir = makeTierFixture();

    const result = computeInstructionBudget({ rulesDir: dir, ceiling: 1000, context: 'bogus' });

    expect(result.perFile).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// checkInstructionBudget — banner wrapper
// ---------------------------------------------------------------------------

describe('checkInstructionBudget — banner wrapper', () => {
  it('returns null when under the ceiling', () => {
    const dir = makeFullFixture(); // total = 11

    const banner = checkInstructionBudget({ rulesDir: dir, ceiling: 480 });

    expect(banner).toBeNull();
  });

  it('returns a warn banner naming the count and ceiling when over', () => {
    const dir = makeFullFixture(); // total = 11

    const banner = checkInstructionBudget({ rulesDir: dir, ceiling: 5 });

    expect(banner).not.toBeNull();
    expect(banner.severity).toBe('warn');
    expect(banner.message).toContain('directives 11 > 5');
    expect(banner.message).toContain('across 3 always-on rules');
    // Top file (alpha.md, 6 directives / 164 B) appears in the Top-files line.
    expect(banner.message).toContain(`alpha.md (6 dir, ${ALPHA_BYTES} B)`);
    expect(banner.message).toContain('instruction-budget audit (#687; archived in the private Meta-Vault)');
  });

  // #931a — the banner must say WHICH axis broke, not just "over budget".
  it('names ONLY the byte axis when the directive axis is healthy', () => {
    const dir = makeFullFixture(); // 11 directives, 320 bytes

    const banner = checkInstructionBudget({ rulesDir: dir, ceiling: 1000, byteCeiling: 100 });

    expect(banner).not.toBeNull();
    expect(banner.message).toContain(
      `bytes ${ALPHA_BYTES + BETA_BYTES + DELTA_BYTES} > 100`,
    );
    // The healthy directive axis is NOT mentioned — a banner that lists a
    // passing axis pads the line without giving the operator an action.
    expect(banner.message).not.toContain('directives');
  });

  it('names BOTH axes when both are breached', () => {
    const dir = makeFullFixture();

    const banner = checkInstructionBudget({ rulesDir: dir, ceiling: 5, byteCeiling: 100 });

    expect(banner).not.toBeNull();
    expect(banner.message).toContain('directives 11 > 5');
    expect(banner.message).toContain(`bytes ${ALPHA_BYTES + BETA_BYTES + DELTA_BYTES} > 100`);
  });

  it('ranks Top files by BYTES when only the byte axis broke, not by directive count', () => {
    // heavy.md: ONE directive but a large body; alpha.md: 6 directives, 164 B.
    // A directive-count ranking would put alpha.md first and point the operator
    // at the wrong file for a byte-axis breach.
    const dir = makeTmpRulesDir();
    writeRule(dir, 'alpha.md', ALPHA);
    writeRule(dir, 'heavy.md', `- one bullet\n${'x'.repeat(5000)}\n`);

    const byteBanner = checkInstructionBudget({ rulesDir: dir, ceiling: 1000, byteCeiling: 100 });
    const directiveBanner = checkInstructionBudget({ rulesDir: dir, ceiling: 3, byteCeiling: 100000 });

    // Byte breach → heavy.md leads.
    expect(byteBanner.message).toMatch(/Top files: heavy\.md \(1 dir, \d+ B\), alpha\.md /);
    // Directive breach → the pre-existing DESC-by-count ordering is preserved.
    expect(directiveBanner.message).toMatch(/Top files: alpha\.md \(6 dir, \d+ B\), heavy\.md /);
  });
});

// ---------------------------------------------------------------------------
// #931a — byte-ceiling as a VERDICT axis (was data-only since #877).
//
// The verdict rule under test: overBudget === overDirectiveBudget ||
// overByteBudget. Each test below pins one quadrant of that truth table, so a
// regression to either single-axis form (directive-only = the pre-#931a bug,
// or byte-only) goes red.
// ---------------------------------------------------------------------------

const FULL_FIXTURE_BYTES = ALPHA_BYTES + BETA_BYTES + DELTA_BYTES; // 320
const FULL_FIXTURE_DIRECTIVES = 11;

describe('computeInstructionBudget — byte ceiling as a verdict axis (#931a)', () => {
  it('flags overBudget from the BYTE axis alone while the directive axis is healthy', () => {
    const dir = makeFullFixture();

    const result = computeInstructionBudget({
      rulesDir: dir,
      ceiling: 1000, // 11 directives — far under
      byteCeiling: 100, // 320 bytes — over
    });

    expect(result.totalBytes).toBe(FULL_FIXTURE_BYTES);
    expect(result.overDirectiveBudget).toBe(false);
    expect(result.overByteBudget).toBe(true);
    expect(result.overBudget).toBe(true);
    expect(result.severity).toBe('warn');
  });

  it('fake-regression control: the SAME fixture with a byte ceiling ABOVE the total is ok (proves the flag above tracks the ceiling, not the fixture)', () => {
    const dir = makeFullFixture();

    const result = computeInstructionBudget({
      rulesDir: dir,
      ceiling: 1000,
      byteCeiling: 100000,
    });

    expect(result.totalBytes).toBe(FULL_FIXTURE_BYTES);
    expect(result.overByteBudget).toBe(false);
    expect(result.overBudget).toBe(false);
    expect(result.severity).toBe('ok');
  });

  it('still flags overBudget from the DIRECTIVE axis alone (pre-#931a behaviour preserved)', () => {
    const dir = makeFullFixture();

    const result = computeInstructionBudget({
      rulesDir: dir,
      ceiling: 5, // 11 directives — over
      byteCeiling: 100000, // 320 bytes — under
    });

    expect(result.totalDirectives).toBe(FULL_FIXTURE_DIRECTIVES);
    expect(result.overDirectiveBudget).toBe(true);
    expect(result.overByteBudget).toBe(false);
    expect(result.overBudget).toBe(true);
  });

  it('is ok only when BOTH axes are within their ceilings', () => {
    const dir = makeFullFixture();

    const result = computeInstructionBudget({ rulesDir: dir, ceiling: 1000, byteCeiling: 100000 });

    expect(result.overDirectiveBudget).toBe(false);
    expect(result.overByteBudget).toBe(false);
    expect(result.overBudget).toBe(false);
  });

  it('does not flag the byte axis when totalBytes exactly equals byteCeiling (strict >, mirroring the directive boundary)', () => {
    const dir = makeFullFixture();

    const atBoundary = computeInstructionBudget({
      rulesDir: dir,
      ceiling: 1000,
      byteCeiling: FULL_FIXTURE_BYTES,
    });
    const oneUnder = computeInstructionBudget({
      rulesDir: dir,
      ceiling: 1000,
      byteCeiling: FULL_FIXTURE_BYTES - 1,
    });

    expect(atBoundary.overByteBudget).toBe(false);
    expect(oneUnder.overByteBudget).toBe(true);
  });

  it('defaults byteCeiling to DEFAULT_BYTE_CEILING (114000) when not supplied', () => {
    const dir = makeFullFixture();

    const result = computeInstructionBudget({ rulesDir: dir });

    expect(result.byteCeiling).toBe(114000);
    expect(DEFAULT_BYTE_CEILING).toBe(114000);
    expect(result.overByteBudget).toBe(false);
  });

  it('narrows totalBytes by context, so the byte verdict follows the SURFACE being measured', () => {
    // A coordinator-only file inflates the coordinator surface but never
    // reaches a wave agent — a byte verdict must not charge the wave surface
    // for bytes it never receives.
    const dir = makeAsymmetricTierFixture(); // coordinator 70 B, wave 14 B

    const waveResult = computeInstructionBudget({
      rulesDir: dir,
      ceiling: 1000,
      byteCeiling: 20,
      context: 'wave',
    });
    const coordinatorResult = computeInstructionBudget({
      rulesDir: dir,
      ceiling: 1000,
      byteCeiling: 20,
      context: 'coordinator',
    });

    expect(waveResult.totalBytes).toBe(14);
    expect(waveResult.overByteBudget).toBe(false);
    expect(coordinatorResult.totalBytes).toBe(70);
    expect(coordinatorResult.overByteBudget).toBe(true);
  });
});

describe('checkInstructionBudget — byte-ceiling config wiring (#931a)', () => {
  it('honors instruction-budget.byte-ceiling from Session Config with no explicit opt', () => {
    // Config byte-ceiling 100 < fixture total 320 → banner fires on the byte
    // axis even though the directive ceiling (999) is comfortably clear.
    const { repoRoot, rulesDir } = makeConfigFixture(
      [
        'instruction-budget:',
        '  enabled: true',
        '  ceiling: 999',
        '  byte-ceiling: 100',
        '  mode: warn',
      ].join('\n'),
    );

    const banner = checkInstructionBudget({ repoRoot, rulesDir });

    expect(banner).not.toBeNull();
    expect(banner.severity).toBe('warn');
    expect(banner.message).toContain(`bytes ${FULL_FIXTURE_BYTES} > 100`);
  });

  it('fake-regression control: the SAME config with a high byte-ceiling stays silent', () => {
    const { repoRoot, rulesDir } = makeConfigFixture(
      [
        'instruction-budget:',
        '  enabled: true',
        '  ceiling: 999',
        '  byte-ceiling: 100000',
        '  mode: warn',
      ].join('\n'),
    );

    expect(checkInstructionBudget({ repoRoot, rulesDir })).toBeNull();
  });

  it('mode: off silences a byte-axis breach too', () => {
    const { repoRoot, rulesDir } = makeConfigFixture(
      [
        'instruction-budget:',
        '  enabled: true',
        '  ceiling: 999',
        '  byte-ceiling: 100',
        '  mode: off',
      ].join('\n'),
    );

    expect(checkInstructionBudget({ repoRoot, rulesDir })).toBeNull();
  });

  it('an explicit opts.byteCeiling wins over the config byte-ceiling', () => {
    // Config would fire (100 < 320); the explicit opt (100000) must silence it.
    const { repoRoot, rulesDir } = makeConfigFixture(
      [
        'instruction-budget:',
        '  enabled: true',
        '  ceiling: 999',
        '  byte-ceiling: 100',
        '  mode: warn',
      ].join('\n'),
    );

    expect(checkInstructionBudget({ repoRoot, rulesDir, byteCeiling: 100000 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Never-throws: missing / unreadable rulesDir
// ---------------------------------------------------------------------------

describe('never throws on a missing rulesDir', () => {
  const missingDir = join(tmpdir(), 'instr-budget-does-not-exist-xyz-987');

  it('computeInstructionBudget returns the safe empty shape', () => {
    const result = computeInstructionBudget({ rulesDir: missingDir, ceiling: 480, byteCeiling: 114000 });

    expect(result).toEqual({
      totalDirectives: 0,
      totalBytes: 0,
      perFile: [],
      ceiling: 480,
      byteCeiling: 114000,
      overDirectiveBudget: false,
      overByteBudget: false,
      overBudget: false,
      severity: 'ok',
      bySurface: { coordinator: 0, wave: 0, always: 0 },
    });
  });

  it('checkInstructionBudget returns null', () => {
    const banner = checkInstructionBudget({ rulesDir: missingDir, ceiling: 480 });

    expect(banner).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Session Config integration — instruction-budget.{enabled,ceiling,mode}
// ---------------------------------------------------------------------------

import { mkdirSync } from 'node:fs';

/**
 * Build a tmp repo root containing a CLAUDE.md with the given Session Config
 * `instruction-budget` block plus a `.claude/rules/` dir seeded with the full
 * fixture (always-on total = 11). Returns { repoRoot, rulesDir }.
 */
function makeConfigFixture(configBlock) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'instr-budget-cfg-'));
  tmpDirs.push(repoRoot);
  const rulesDir = join(repoRoot, '.claude', 'rules');
  mkdirSync(rulesDir, { recursive: true });
  writeRule(rulesDir, 'alpha.md', ALPHA);
  writeRule(rulesDir, 'beta.md', BETA);
  writeRule(rulesDir, 'delta.md', DELTA);
  writeRule(rulesDir, 'gamma.md', GAMMA);

  const claudeMd = `# Repo\n\n## Session Config\n\n${configBlock}\n`;
  writeFileSync(join(repoRoot, 'CLAUDE.md'), claudeMd, 'utf8');
  return { repoRoot, rulesDir };
}

describe('_parseInstructionBudget — block parser', () => {
  const FALLBACK = { enabled: true, ceiling: 480, 'byte-ceiling': 114000, mode: 'warn' };

  it('returns fallback for empty / absent block', () => {
    expect(_parseInstructionBudget('', FALLBACK)).toEqual(FALLBACK);
    expect(_parseInstructionBudget('# Repo\n\n## Session Config\n\nwaves: 5\n', FALLBACK)).toEqual(
      FALLBACK,
    );
  });

  it('parses enabled:false, ceiling override, and mode:off', () => {
    const block = [
      'instruction-budget:',
      '  enabled: false',
      '  ceiling: 300',
      '  mode: off',
    ].join('\n');

    expect(_parseInstructionBudget(block, FALLBACK)).toEqual({
      enabled: false,
      ceiling: 300,
      'byte-ceiling': 114000,
      mode: 'off',
    });
  });

  it('ignores inline comments and a non-positive ceiling', () => {
    const block = [
      'instruction-budget:',
      '  enabled: true            # comment',
      '  ceiling: 0               # invalid → fallback ceiling kept',
      '  mode: warn',
    ].join('\n');

    expect(_parseInstructionBudget(block, FALLBACK)).toEqual({
      enabled: true,
      ceiling: 480,
      'byte-ceiling': 114000,
      mode: 'warn',
    });
  });

  // #931a — byte-ceiling parsing, mirroring the `ceiling` cases above.
  it('parses a byte-ceiling override independently of the directive ceiling', () => {
    const block = [
      'instruction-budget:',
      '  enabled: true',
      '  ceiling: 300',
      '  byte-ceiling: 90000',
      '  mode: warn',
    ].join('\n');

    expect(_parseInstructionBudget(block, FALLBACK)).toEqual({
      enabled: true,
      ceiling: 300,
      'byte-ceiling': 90000,
      mode: 'warn',
    });
  });

  it('keeps the default byte-ceiling for a malformed or non-positive value', () => {
    const nonPositive = [
      'instruction-budget:',
      '  byte-ceiling: 0          # invalid → default kept',
    ].join('\n');
    const malformed = ['instruction-budget:', '  byte-ceiling: not-a-number'].join('\n');

    expect(_parseInstructionBudget(nonPositive, FALLBACK)['byte-ceiling']).toBe(114000);
    expect(_parseInstructionBudget(malformed, FALLBACK)['byte-ceiling']).toBe(114000);
  });

  it('supplies DEFAULT_BYTE_CEILING when the caller passes a pre-#931a defaults object without the key', () => {
    // A stale caller must never disable the byte axis by omission — the missing
    // key falls back to the module default, not to undefined (which would make
    // `totalBytes > undefined` false forever, i.e. a silent fail-open).
    const legacyDefaults = { enabled: true, ceiling: 480, mode: 'warn' };

    expect(_parseInstructionBudget('', legacyDefaults)['byte-ceiling']).toBe(DEFAULT_BYTE_CEILING);
    expect(
      _parseInstructionBudget('instruction-budget:\n  ceiling: 300\n', legacyDefaults),
    ).toEqual({
      enabled: true,
      ceiling: 300,
      'byte-ceiling': DEFAULT_BYTE_CEILING,
      mode: 'warn',
    });
  });
});

describe('loadInstructionBudgetConfig — disk read', () => {
  it('reads the block from a repo CLAUDE.md', () => {
    const { repoRoot } = makeConfigFixture(
      ['instruction-budget:', '  enabled: true', '  ceiling: 5', '  mode: warn'].join('\n'),
    );

    expect(loadInstructionBudgetConfig(repoRoot)).toEqual({
      enabled: true,
      ceiling: 5,
      'byte-ceiling': DEFAULT_BYTE_CEILING,
      mode: 'warn',
    });
  });

  it('reads a byte-ceiling from a repo CLAUDE.md (#931a)', () => {
    const { repoRoot } = makeConfigFixture(
      ['instruction-budget:', '  enabled: true', '  byte-ceiling: 200', '  mode: warn'].join('\n'),
    );

    expect(loadInstructionBudgetConfig(repoRoot)).toEqual({
      enabled: true,
      ceiling: 480,
      'byte-ceiling': 200,
      mode: 'warn',
    });
  });

  it('falls back to defaults when no instruction file exists', () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), 'instr-budget-noconfig-'));
    tmpDirs.push(emptyRoot);

    expect(loadInstructionBudgetConfig(emptyRoot)).toEqual({
      enabled: true,
      ceiling: 480,
      'byte-ceiling': DEFAULT_BYTE_CEILING,
      mode: 'warn',
    });
  });
});

describe('checkInstructionBudget — Session Config gates', () => {
  it('returns null when instruction-budget.enabled is false (even when over a low ceiling)', () => {
    const { repoRoot, rulesDir } = makeConfigFixture(
      // ceiling 5 would otherwise fire (total = 11), but enabled:false silences it.
      ['instruction-budget:', '  enabled: false', '  ceiling: 5', '  mode: warn'].join('\n'),
    );

    const banner = checkInstructionBudget({ repoRoot, rulesDir });

    expect(banner).toBeNull();
  });

  it('returns null when instruction-budget.mode is off', () => {
    const { repoRoot, rulesDir } = makeConfigFixture(
      ['instruction-budget:', '  enabled: true', '  ceiling: 5', '  mode: off'].join('\n'),
    );

    const banner = checkInstructionBudget({ repoRoot, rulesDir });

    expect(banner).toBeNull();
  });

  it('honors the config ceiling when no explicit opt ceiling is supplied', () => {
    // Config ceiling 5 < total 11 → banner fires; no opts.ceiling override.
    const { repoRoot, rulesDir } = makeConfigFixture(
      ['instruction-budget:', '  enabled: true', '  ceiling: 5', '  mode: warn'].join('\n'),
    );

    const banner = checkInstructionBudget({ repoRoot, rulesDir });

    expect(banner).not.toBeNull();
    expect(banner.severity).toBe('warn');
    expect(banner.message).toContain('directives 11 > 5');
    expect(banner.message).toContain('across 3 always-on rules');
  });

  it('a high config ceiling keeps the banner silent', () => {
    // Config ceiling 999 > total 11 → no banner.
    const { repoRoot, rulesDir } = makeConfigFixture(
      ['instruction-budget:', '  enabled: true', '  ceiling: 999', '  mode: warn'].join('\n'),
    );

    const banner = checkInstructionBudget({ repoRoot, rulesDir });

    expect(banner).toBeNull();
  });

  it('falls back to the default ceiling and still computes when config load fails', () => {
    // No CLAUDE.md → fallback {enabled:true, ceiling:480, mode:warn}. With an
    // explicit opts.ceiling override of 5, the banner still fires (total = 11).
    const emptyRoot = mkdtempSync(join(tmpdir(), 'instr-budget-fallback-'));
    tmpDirs.push(emptyRoot);
    const rulesDir = makeFullFixture(); // total = 11

    const banner = checkInstructionBudget({ repoRoot: emptyRoot, rulesDir, ceiling: 5 });

    expect(banner).not.toBeNull();
    expect(banner.message).toContain('directives 11 > 5');
  });
});
