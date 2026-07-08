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
  DEFAULT_CEILING,
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
      { file: 'alpha.md', count: ALPHA_COUNT },
      { file: 'beta.md', count: BETA_COUNT },
      { file: 'delta.md', count: DELTA_COUNT },
    ]);
  });

  it('does not count bullets or headings inside a fenced code block', () => {
    const dir = makeTmpRulesDir();
    writeRule(dir, 'beta.md', BETA);

    const result = computeInstructionBudget({ rulesDir: dir, ceiling: 1000 });

    // 3 real directives; the 3 fenced lines are ignored.
    expect(result.totalDirectives).toBe(3);
    expect(result.perFile).toEqual([{ file: 'beta.md', count: 3 }]);
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
    expect(banner.message).toContain('11 always-on directives');
    expect(banner.message).toContain('over ceiling 5');
    // Top file (alpha.md, 6) appears in the Top-files line.
    expect(banner.message).toContain('alpha.md (6)');
    expect(banner.message).toContain('instruction-budget audit (#687; archived in the private Meta-Vault)');
  });
});

// ---------------------------------------------------------------------------
// Never-throws: missing / unreadable rulesDir
// ---------------------------------------------------------------------------

describe('never throws on a missing rulesDir', () => {
  const missingDir = join(tmpdir(), 'instr-budget-does-not-exist-xyz-987');

  it('computeInstructionBudget returns the safe empty shape', () => {
    const result = computeInstructionBudget({ rulesDir: missingDir, ceiling: 480 });

    expect(result).toEqual({
      totalDirectives: 0,
      perFile: [],
      ceiling: 480,
      overBudget: false,
      severity: 'ok',
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
  const FALLBACK = { enabled: true, ceiling: 480, mode: 'warn' };

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
      mode: 'warn',
    });
  });

  it('falls back to defaults when no instruction file exists', () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), 'instr-budget-noconfig-'));
    tmpDirs.push(emptyRoot);

    expect(loadInstructionBudgetConfig(emptyRoot)).toEqual({
      enabled: true,
      ceiling: 480,
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
    expect(banner.message).toContain('11 always-on directives');
    expect(banner.message).toContain('over ceiling 5');
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
    expect(banner.message).toContain('over ceiling 5');
  });
});
