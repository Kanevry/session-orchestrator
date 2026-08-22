/**
 * tests/lib/validate/check-rules.test.mjs
 *
 * Tests for scripts/lib/validate/check-rules.mjs (FA4 #697).
 *
 * The gate validates every .claude/rules/*.md that carries `auto-generated: true`
 * against three invariants:
 *   (a) never-always-on: must have globs or host-class
 *   (b) learning-key must be present
 *   (c) expires-at must be present
 *
 * Plus two COHORT-INDEPENDENT invariants that bind on every rule file:
 *   (d) the frontmatter must parse (#1015)
 *   (e) harness parity (#1108) — a rule that expresses a path restriction must
 *       express it in `paths:`, the only scope key Claude Code's own loader
 *       reads. `globs:`-only, or `globs:`/`paths:` carrying different pattern
 *       sets, means the rule loads in different contexts on different
 *       harnesses. See Case 13 at the end of this file.
 *
 * Every non-empty `globs:` fixture below therefore carries a mirroring
 * `paths:` — it is the shape the repo's rules now use, and without it each
 * fixture would trip (e) and stop isolating the invariant it is testing.
 *
 * Rules WITHOUT `auto-generated: true` are silently skipped.
 * No auto-generated rules found → exit 0.
 * Any invariant violation → exit 1.
 * Missing plugin-root arg → exit 1 (usage error).
 *
 * Strategy: spawn the CLI via spawnSync with a tmp plugin-root that contains
 * .claude/rules/ fixtures, matching the pattern used by check-rules-references.test.mjs.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'lib', 'validate', 'check-rules.mjs');

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const tmpRoots = [];

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'check-rules-'));
  tmpRoots.push(root);
  const rulesDir = join(root, '.claude', 'rules');
  mkdirSync(rulesDir, { recursive: true });
  return { root, rulesDir };
}

function writeRule(rulesDir, name, content) {
  writeFileSync(join(rulesDir, name), content, 'utf8');
}

function run(pluginRoot) {
  return spawnSync('node', [SCRIPT, pluginRoot], { encoding: 'utf8', timeout: 15_000 });
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Case 1: no .claude/rules/ directory → exit 0
// ---------------------------------------------------------------------------

describe('check-rules — absent rules directory', () => {
  it('exits 0 when .claude/rules/ directory does not exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'check-rules-no-dir-'));
    tmpRoots.push(root);
    // No .claude/rules/ directory created.

    const r = run(root);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASS:');
    expect(r.stdout).toContain('Results:');
    expect(r.stdout).not.toContain('FAIL:');
  });
});

// ---------------------------------------------------------------------------
// Case 2: .claude/rules/ exists but contains no auto-generated rules → exit 0
// ---------------------------------------------------------------------------

describe('check-rules — no auto-generated rules', () => {
  it('exits 0 when rules dir has no .md files', () => {
    const { root, rulesDir } = makeFixture();
    // rulesDir exists but contains no files.
    void rulesDir;

    const r = run(root);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASS:');
    expect(r.stdout).toContain('Results:');
    expect(r.stdout).not.toContain('FAIL:');
  });

  it('exits 0 when all .md files lack auto-generated: true', () => {
    const { root, rulesDir } = makeFixture();
    // A handwritten rule with no auto-generated key.
    writeRule(rulesDir, 'handwritten.md', '---\ndescription: A handwritten rule\nglobs: ["src/**"]\npaths: ["src/**"]\n---\n# Rule\nSome content.\n');

    const r = run(root);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASS:');
    expect(r.stdout).toContain('Results:');
    expect(r.stdout).not.toContain('FAIL:');
  });
});

// ---------------------------------------------------------------------------
// Case 3: always-on auto-generated rule (no globs, no host-class) → exit 1
// ---------------------------------------------------------------------------

describe('check-rules — always-on auto-generated rule', () => {
  it('exits 1 and names the file when auto-generated rule has no activation axis', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(
      rulesDir,
      'generated-always-on.md',
      '---\nauto-generated: true\nlearning-key: anti-pattern/use-strict\nexpires-at: 2099-01-01\n---\n# Rule\nContent.\n',
    );

    const r = run(root);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('FAIL:');
    expect(r.stdout).toContain('.claude/rules/generated-always-on.md');
    expect(r.stdout).toContain('always-on');
    expect(r.stdout).toContain('Results:');
  });

  it('FAIL line mentions never-always-on invariant violation', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(
      rulesDir,
      'bad-always-on.md',
      '---\nauto-generated: true\nlearning-key: anti-pattern/no-globs\nexpires-at: 2099-06-01\n---\n# Bad\n',
    );

    const r = run(root);

    expect(r.status).toBe(1);
    // The FAIL line must identify the file AND name the invariant.
    expect(r.stdout).toMatch(/FAIL:.*\.claude\/rules\/bad-always-on\.md/);
    expect(r.stdout).toContain('never-always-on');
  });
});

// ---------------------------------------------------------------------------
// Case 4: auto-generated rule missing learning-key → exit 1
// ---------------------------------------------------------------------------

describe('check-rules — missing learning-key', () => {
  it('exits 1 and names learning-key in the FAIL line', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(
      rulesDir,
      'no-learning-key.md',
      '---\nauto-generated: true\nglobs: ["src/**/*.ts"]\npaths: ["src/**/*.ts"]\nexpires-at: 2099-01-01\n---\n# Rule\nContent.\n',
    );

    const r = run(root);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('FAIL:');
    expect(r.stdout).toContain('.claude/rules/no-learning-key.md');
    expect(r.stdout).toContain('learning-key');
  });
});

// ---------------------------------------------------------------------------
// Case 5: auto-generated rule missing expires-at → exit 1
// ---------------------------------------------------------------------------

describe('check-rules — missing expires-at', () => {
  it('exits 1 and names expires-at in the FAIL line', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(
      rulesDir,
      'no-expires.md',
      '---\nauto-generated: true\nglobs: ["scripts/**"]\npaths: ["scripts/**"]\nlearning-key: anti-pattern/missing-expiry\n---\n# Rule\nContent.\n',
    );

    const r = run(root);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('FAIL:');
    expect(r.stdout).toContain('.claude/rules/no-expires.md');
    expect(r.stdout).toContain('expires-at');
  });
});

// ---------------------------------------------------------------------------
// Case 6: VALID auto-generated rule (globs + learning-key + expires-at) → exit 0
// ---------------------------------------------------------------------------

describe('check-rules — valid auto-generated rule', () => {
  it('exits 0 and emits a PASS line when all invariants are satisfied', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(
      rulesDir,
      'valid-generated.md',
      '---\nauto-generated: true\nglobs: ["src/**/*.ts"]\npaths: ["src/**/*.ts"]\nlearning-key: anti-pattern/use-strict\nexpires-at: 2099-12-31\n---\n# Rule\nContent.\n',
    );

    const r = run(root);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASS:');
    expect(r.stdout).toContain('.claude/rules/valid-generated.md');
    expect(r.stdout).toContain('Results:');
    expect(r.stdout).not.toContain('FAIL:');
  });

  it('emits the correct pass/fail summary when the rule is valid', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(
      rulesDir,
      'valid-gen.md',
      '---\nauto-generated: true\nglobs: ["tests/**"]\npaths: ["tests/**"]\nlearning-key: fragile-pattern/test-fixture\nexpires-at: 2099-06-01\n---\n# Rule\n',
    );

    const r = run(root);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Results: 1 passed, 0 failed');
  });
});

// ---------------------------------------------------------------------------
// Case 7: host-class-only auto-generated rule (no globs but host-class present)
// → exit 0. host-class is a valid activation axis.
// ---------------------------------------------------------------------------

describe('check-rules — host-class-only activation axis', () => {
  it('exits 0 when auto-generated rule has host-class instead of globs', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(
      rulesDir,
      'host-class-rule.md',
      '---\nauto-generated: true\nhost-class: mac-m-series\nlearning-key: recurring-issue/m-series-path\nexpires-at: 2099-01-01\n---\n# Rule\nContent.\n',
    );

    const r = run(root);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASS:');
    expect(r.stdout).toContain('.claude/rules/host-class-rule.md');
    expect(r.stdout).not.toContain('FAIL:');
  });
});

// ---------------------------------------------------------------------------
// Case 8: handwritten always-on rule (no auto-generated key) → exit 0
// The gate must NOT audit handwritten rules.
// ---------------------------------------------------------------------------

describe('check-rules — handwritten always-on rule is not flagged', () => {
  it('exits 0 for a handwritten rule that has no activation axis', () => {
    const { root, rulesDir } = makeFixture();
    // A rule WITHOUT auto-generated: true, also without globs/host-class
    // (i.e., always-on). The gate must ignore it.
    writeRule(
      rulesDir,
      'always-on-handwritten.md',
      '---\ndescription: A handwritten always-on rule\nalwaysApply: true\n---\n# Always-on\nThis is intentionally always-on.\n',
    );

    const r = run(root);

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('FAIL:');
  });

  it('exits 0 even when handwritten and generated rules coexist and only generated violates', () => {
    const { root, rulesDir } = makeFixture();
    // Handwritten rule — always-on, no auto-generated. Must be ignored.
    writeRule(
      rulesDir,
      'handwritten.md',
      '---\ndescription: Handwritten\n---\n# Handwritten\n',
    );
    // Generated rule — valid.
    writeRule(
      rulesDir,
      'valid-gen.md',
      '---\nauto-generated: true\nglobs: ["src/**"]\npaths: ["src/**"]\nlearning-key: anti-pattern/foo\nexpires-at: 2099-01-01\n---\n# Gen\n',
    );

    const r = run(root);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASS:');
    expect(r.stdout).not.toContain('FAIL:');
  });
});

// ---------------------------------------------------------------------------
// Case 9: missing plugin-root argument → exit 1 (usage error)
// ---------------------------------------------------------------------------

describe('check-rules — missing plugin-root argument', () => {
  it('exits 1 and writes usage to stderr when no argument is supplied', () => {
    const r = spawnSync('node', [SCRIPT], { encoding: 'utf8', timeout: 15_000 });

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Usage:');
    expect(r.stderr).toContain('check-rules.mjs');
  });
});

// ---------------------------------------------------------------------------
// Case 10: multiple violations in one rule — all three fail lines appear
// ---------------------------------------------------------------------------

describe('check-rules — multiple violations in a single rule', () => {
  it('emits three FAIL lines when a rule violates all three invariants', () => {
    const { root, rulesDir } = makeFixture();
    // auto-generated: true, but no globs/host-class, no learning-key, no expires-at
    writeRule(
      rulesDir,
      'fully-broken.md',
      '---\nauto-generated: true\n---\n# Broken\nContent.\n',
    );

    const r = run(root);

    expect(r.status).toBe(1);
    // Three separate FAIL lines: always-on, missing learning-key, missing expires-at.
    const failLines = r.stdout.split('\n').filter((l) => l.includes('FAIL:'));
    expect(failLines).toHaveLength(3);
    expect(r.stdout).toContain('Results: 0 passed, 3 failed');
  });
});

// ---------------------------------------------------------------------------
// Case 12 (#892): auto-generated rule with an EMPTY globs array (`globs: []`)
// must earn a distinct, accurate FAIL — "matches NOTHING, never loads" — and
// NEVER the inverted "always-on" message. This is the auto-generated twin of
// the handwritten-branch fix in tests/rules/check-rules-handwritten.test.mjs
// (#880 QA Defect 1). Critically, a co-present `host-class:` key must NOT
// rescue the rule into a PASS — rule-loader.mjs's globs.length === 0
// exclusion is unconditional.
// ---------------------------------------------------------------------------

describe('check-rules — auto-generated rule with empty globs array (#892)', () => {
  it('FAILs with an accurate "matches NOTHING / never loads" message, not "always-on"', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(
      rulesDir,
      'empty-globs-generated.md',
      '---\nauto-generated: true\nglobs: []\nlearning-key: anti-pattern/dead-rule\nexpires-at: 2099-01-01\n---\n# Empty Globs\nContent.\n',
    );

    const r = run(root);

    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/FAIL:.*empty-globs-generated\.md.*matches NOTHING/);
    expect(r.stdout).toMatch(/FAIL:.*empty-globs-generated\.md.*never loads/);
    // The OLD (inverted, pre-#892) message must NOT appear for this file —
    // that message asserted the rule "is always-on", the exact opposite of
    // the true "matches nothing, never loads" outcome.
    expect(r.stdout).not.toMatch(/FAIL:.*empty-globs-generated\.md.*is always-on/);
    expect(r.stdout).not.toMatch(/PASS:.*empty-globs-generated\.md/);
  });

  it('still FAILs the empty-globs message when a co-present host-class: key would otherwise satisfy the axis', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(
      rulesDir,
      'empty-globs-with-hostclass.md',
      '---\nauto-generated: true\nglobs: []\nhost-class: mac-m-series\nlearning-key: anti-pattern/dead-rule-hostclass\nexpires-at: 2099-01-01\n---\n# Empty Globs, Host-Class\nContent.\n',
    );

    const r = run(root);

    expect(r.status).toBe(1);
    // host-class: cannot rescue an empty globs array from rule-loader.mjs's
    // unconditional globs.length === 0 exclusion — the rule still never
    // loads, so it must still FAIL, never silently PASS.
    expect(r.stdout).toMatch(/FAIL:.*empty-globs-with-hostclass\.md.*matches NOTHING/);
    expect(r.stdout).not.toMatch(/PASS:.*empty-globs-with-hostclass\.md/);
  });
});

// ---------------------------------------------------------------------------
// Case 11: mixed valid and invalid auto-generated rules
// ---------------------------------------------------------------------------

describe('check-rules — mixed valid and invalid auto-generated rules', () => {
  it('exits 1 and reports exactly one FAIL when one valid and one invalid rule exist', () => {
    const { root, rulesDir } = makeFixture();
    // Valid generated rule.
    writeRule(
      rulesDir,
      'aaaa-valid.md',
      '---\nauto-generated: true\nglobs: ["src/**"]\npaths: ["src/**"]\nlearning-key: anti-pattern/correct\nexpires-at: 2099-01-01\n---\n# Valid\n',
    );
    // Invalid generated rule — missing expires-at.
    writeRule(
      rulesDir,
      'zzzz-invalid.md',
      '---\nauto-generated: true\nglobs: ["tests/**"]\npaths: ["tests/**"]\nlearning-key: anti-pattern/broken\n---\n# Broken\n',
    );

    const r = run(root);

    expect(r.status).toBe(1);
    // The valid rule passes, the invalid rule fails.
    const failLines = r.stdout.split('\n').filter((l) => l.includes('FAIL:'));
    expect(failLines).toHaveLength(1);
    expect(failLines[0]).toContain('zzzz-invalid.md');
    expect(r.stdout).toContain('PASS:');
    expect(r.stdout).toContain('aaaa-valid.md');
    expect(r.stdout).toContain('Results: 1 passed, 1 failed');
  });
});

// ---------------------------------------------------------------------------
// Case 12: MALFORMED FRONTMATTER (#1015) — was a silent `continue`, now a FAIL.
//
// The blind spot this closes: rule-loader.mjs catches the SAME
// `parseGlobsFrontmatter` throw (~:500-507), falls back to
// `globs=null, meta={}, parseError=true`, and then (~:519-530) pushes the entry
// with `alwaysOn: true`. Empty meta means applyGates() has nothing to gate on,
// so the file ALSO clears tier/host-class/mode/expiry gating by design. Net
// effect: the one file this validator declined to audit was precisely the file
// the loader loads always-on, everywhere, with no expiry — and it is the
// landing state of a frontmatter injection whose payload is colon-less.
//
// PAYLOAD NOTE — the injected key is `tier: always`, deliberately NOT
// `expires-at:`/`globs:`: the renderer emits those two LATER in the same block,
// so an injected copy is overwritten and the fixture would go green with no
// guard at all. `tier` is never emitted, so it SURVIVES and discriminates.
// ---------------------------------------------------------------------------

/** Parse the validator's stdout into its finding arrays (never a file-wide grep). */
function findings(stdout) {
  const lines = stdout.split('\n');
  return {
    fail: lines.filter((l) => l.includes('FAIL:')),
    pass: lines.filter((l) => l.includes('PASS:')),
    warn: lines.filter((l) => l.includes('WARN:')),
  };
}

describe('check-rules — malformed frontmatter is a FAIL, not a skip (#1015)', () => {
  it('exits 1 and names the file when an auto-generated rule has unparseable frontmatter', () => {
    const { root, rulesDir } = makeFixture();
    // A colon-less injected line — the exact shape rule-loader.mjs turns into
    // an always-on, gate-clearing rule. FALSIFICATION: with the previous
    // `catch { continue }` this fixture produced 0 FAILs and exit 0.
    writeRule(
      rulesDir,
      'unparseable-generated.md',
      [
        '---',
        'auto-generated: true',
        'description: benign start',
        'INJECTED LINE WITH NO COLON',
        'tier: always',
        'globs:',
        '  - "src/**"',
        'learning-key: anti-pattern/x',
        'expires-at: 2099-01-01',
        '---',
        '# body',
        '',
      ].join('\n'),
    );

    const r = run(root);

    expect(r.status).toBe(1);
    const { fail, pass } = findings(r.stdout);
    expect(fail).toHaveLength(1);
    expect(fail[0]).toContain('unparseable-generated.md');
    expect(fail[0]).toContain('does not parse');
    expect(pass.filter((l) => l.includes('unparseable-generated.md'))).toEqual([]);
  });

  it('fails cohort-independently — a HANDWRITTEN rule with unparseable frontmatter also FAILs', () => {
    // The handwritten branch is WARN-only, but the parse failure happens BEFORE
    // the cohort split and is not a cohort finding: an unparseable handwritten
    // rule loads always-on with empty meta exactly like an auto-generated one.
    const { root, rulesDir } = makeFixture();
    writeRule(
      rulesDir,
      'unparseable-handwritten.md',
      ['---', 'description: a handwritten rule', 'NO COLON HERE', 'tier: always', '---', '# body', ''].join('\n'),
    );

    const r = run(root);

    expect(r.status).toBe(1);
    const { fail } = findings(r.stdout);
    expect(fail).toHaveLength(1);
    expect(fail[0]).toContain('unparseable-handwritten.md');
  });

  it('isolates per file — a sound sibling still PASSes while the unparseable one FAILs', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(
      rulesDir,
      'aaaa-sound.md',
      '---\nauto-generated: true\nglobs: ["src/**"]\npaths: ["src/**"]\nlearning-key: anti-pattern/ok\nexpires-at: 2099-01-01\n---\n# Sound\n',
    );
    writeRule(
      rulesDir,
      'zzzz-unparseable.md',
      ['---', 'auto-generated: true', 'NO COLON HERE', '---', '# body', ''].join('\n'),
    );

    const r = run(root);

    expect(r.status).toBe(1);
    const { fail, pass } = findings(r.stdout);
    expect(fail).toHaveLength(1);
    expect(fail[0]).toContain('zzzz-unparseable.md');
    expect(pass.filter((l) => l.includes('aaaa-sound.md'))).toHaveLength(1);
  });

  it('does not fire on a rule that has no frontmatter block at all (parses to globs:null)', () => {
    // Boundary: "no frontmatter" is NOT "malformed frontmatter" —
    // parseGlobsFrontmatter returns { globs: null, meta: {} } without throwing.
    // Such a file is a handwritten always-on rule, which stays WARN-only.
    // Guards against the FAIL being widened into a hard gate on every
    // frontmatter-less doc, which would break the handwritten cohort's
    // deliberate warn-mode posture (#880).
    const { root, rulesDir } = makeFixture();
    writeRule(rulesDir, 'no-frontmatter.md', '# Just a heading\n\nSome prose.\n');

    const r = run(root);

    expect(r.status).toBe(0);
    expect(findings(r.stdout).fail).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Case 13 (#1108): HARNESS-PARITY — a rule that expresses a path restriction
// must express it in `paths:`.
//
// Claude Code's own rule loader reads ONLY `paths:` and treats a rule without
// it as unconditional ("rules without a `paths` field are loaded
// unconditionally and apply to all files" — code.claude.com/docs/en/memory
// § Path-specific rules). `globs:` is the CURSOR field name. Measured
// 2026-08-22 before the fix this guards: 16 of 31 rule files carried `globs:`
// and 0 carried `paths:`, so all 31 loaded unconditionally — 186,993 bytes
// ≈ 46,700 tokens per dispatch. The fix (adding `paths:` alongside `globs:`)
// landed the same day; these tests are the RECURRENCE guard, which is what was
// missing, not the fix.
//
// Formulated as PARITY, not presence: the contexts a rule loads in under
// Claude Code's loader (reads `paths:`) must equal those under rule-loader.mjs
// (reads `globs:`, falls back to `paths:` — #795, globs wins).
// ---------------------------------------------------------------------------

describe('check-rules — harness parity: globs: without paths: (#1108)', () => {
  // BUG CAUGHT: the exact regression this guard exists for — a NEW rule
  // authored with only `globs:` (the Cursor key) passes every other invariant
  // and is silently loaded ALWAYS-ON by Claude Code. Before this check the
  // same fixture exited 0 with a PASS line.
  it('FAILs a handwritten rule that declares globs: but no paths:', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(
      rulesDir,
      'globs-only.md',
      '---\ntier: wave-only\nglobs:\n  - "src/**"\nreview-date: 2026-10-23\n---\n# Globs Only\nContent.\n',
    );

    const r = run(root);

    expect(r.status).toBe(1);
    const { fail, pass } = findings(r.stdout);
    expect(fail).toHaveLength(1);
    expect(fail[0]).toContain('globs-only.md');
    expect(fail[0]).toContain('no paths:');
    // The file must not ALSO earn the handwritten PASS — a file that FAILs
    // must never simultaneously PASS.
    expect(pass.filter((l) => l.includes('globs-only.md'))).toEqual([]);
  });

  // BUG CAUGHT: wiring the parity check into the handwritten branch only.
  // scripts/lib/reconcile/renderer.mjs (~:264) emits `globs:` and never
  // `paths:`, so the auto-generated cohort is the cohort with a LIVE producer
  // of this defect — a handwritten-only check would miss every machine-written
  // rule from the next reconcile run onward.
  it('FAILs an auto-generated rule that declares globs: but no paths: (cohort-independent)', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(
      rulesDir,
      'gen-globs-only.md',
      '---\nauto-generated: true\nglobs: ["scripts/**"]\nlearning-key: anti-pattern/x\nexpires-at: 2099-01-01\n---\n# Gen\n',
    );

    const r = run(root);

    expect(r.status).toBe(1);
    const { fail, pass } = findings(r.stdout);
    expect(fail).toHaveLength(1);
    expect(fail[0]).toContain('gen-globs-only.md');
    expect(fail[0]).toContain('no paths:');
    expect(pass.filter((l) => l.includes('gen-globs-only.md'))).toEqual([]);
  });

  // BUG CAUGHT: an over-broad check that demands BOTH keys. `paths:` alone is
  // the form the native documentation prescribes and the form the primary
  // downstream consumer uses exclusively (projects-baseline: 26 rule files,
  // all `paths:`, 0 `globs:`). Demanding `globs:` too would turn that repo red
  // and would contradict validate-vendored-rules.mjs (~:289), which already
  // owns the globs:-is-canonical-for-vendored-rules preference at WARN level.
  it('does not fire on a paths:-only rule (the shape Claude Code documents)', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(
      rulesDir,
      'paths-only-rule.md',
      '---\ntier: wave-only\npaths:\n  - "src/**"\nreview-date: 2026-10-23\n---\n# Paths Only\nContent.\n',
    );

    const r = run(root);

    expect(r.status).toBe(0);
    expect(findings(r.stdout).fail).toEqual([]);
  });
});

describe('check-rules — harness parity: globs:/paths: divergence (#1108)', () => {
  // BUG CAUGHT: an order-sensitive comparison (a bare
  // `JSON.stringify(globs) === JSON.stringify(paths)` on the unsorted lists)
  // reporting two IDENTICAL pattern sets as divergent. A glob list is matched
  // any-of, so order carries no meaning and a reordered mirror is not a defect.
  it('does not fire when the two lists carry the same patterns in a different order', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(
      rulesDir,
      'reordered.md',
      '---\ntier: wave-only\nglobs:\n  - "b/**"\n  - "a/**"\npaths:\n  - "a/**"\n  - "b/**"\nreview-date: 2026-10-23\n---\n# Reordered\n',
    );

    const r = run(root);

    expect(r.status).toBe(0);
    expect(findings(r.stdout).fail).toEqual([]);
  });

  // BUG CAUGHT: comparing the two keys by their RAW frontmatter text instead of
  // their parsed lists. Flow style and block style are the same list to
  // rule-loader.mjs, so a text comparison reports a false divergence on a rule
  // that is perfectly mirrored — and would push authors toward the one form
  // that happens to satisfy the checker.
  it('does not fire when one key uses flow style and the other block style', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(
      rulesDir,
      'mixed-style.md',
      '---\ntier: wave-only\nglobs: ["a/**", "b/**"]\npaths:\n  - "a/**"\n  - "b/**"\nreview-date: 2026-10-23\n---\n# Mixed Style\n',
    );

    const r = run(root);

    expect(r.status).toBe(0);
    expect(findings(r.stdout).fail).toEqual([]);
  });

  // BUG CAUGHT: a comparison too coarse to see a real difference (comparing
  // only list LENGTHS, or only "both keys present"). The two lists here are the
  // same length and differ in every element — Claude Code would scope this rule
  // to tests/, rule-loader.mjs and Cursor to src/. Same rule, two harnesses,
  // disjoint activation.
  it('FAILs when both keys are present with equal-length but different pattern sets', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(
      rulesDir,
      'divergent.md',
      '---\ntier: wave-only\nglobs:\n  - "src/**"\n  - "lib/**"\npaths:\n  - "tests/**"\n  - "docs/**"\nreview-date: 2026-10-23\n---\n# Divergent\n',
    );

    const r = run(root);

    expect(r.status).toBe(1);
    const { fail, pass } = findings(r.stdout);
    expect(fail).toHaveLength(1);
    expect(fail[0]).toContain('divergent.md');
    expect(fail[0]).toContain('DIFFERENT pattern sets');
    expect(pass.filter((l) => l.includes('divergent.md'))).toEqual([]);
  });
});

describe('check-rules — harness parity leaves the empty-list special cases alone (#1108)', () => {
  // BUG CAUGHT: the parity check double-reporting on `paths: []`. That shape is
  // a path-restriction key by presence, yet rule-loader.mjs excludes it
  // unconditionally at `globs.length === 0` AFTER gating — so the accurate
  // finding is the existing "matches NOTHING / never loads" one, and a second,
  // opposite-sounding "loads ALWAYS-ON in Claude Code" line on the same file is
  // precisely the confusion #880 QA Defect 1 / #892 removed. Exactly one
  // finding, and it must be the empty-list one.
  it('reports only the empty-list finding for a paths: [] rule, never a parity finding', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(
      rulesDir,
      'empty-paths.md',
      '---\ntier: wave-only\npaths: []\nreview-date: 2026-10-23\n---\n# Empty Paths\nContent.\n',
    );

    const r = run(root);

    expect(r.status).toBe(0); // handwritten cohort stays warn-only
    const { fail, warn } = findings(r.stdout);
    expect(fail).toEqual([]);
    const own = warn.filter((l) => l.includes('empty-paths.md'));
    expect(own).toHaveLength(1);
    expect(own[0]).toContain('matches NOTHING');
  });

  // BUG CAUGHT: the parity check breaking the #892 module-header special case —
  // an auto-generated `globs: []` paired with `host-class:` must still earn its
  // ONE distinct "matches NOTHING" FAIL. A parity check that fired on the empty
  // list would add a contradictory second FAIL claiming the same rule loads
  // always-on.
  it('leaves the #892 empty-globs + host-class case at exactly one FAIL', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(
      rulesDir,
      'empty-globs-hostclass.md',
      '---\nauto-generated: true\nglobs: []\nhost-class: mac-m-series\nlearning-key: anti-pattern/dead\nexpires-at: 2099-01-01\n---\n# Empty\n',
    );

    const r = run(root);

    expect(r.status).toBe(1);
    const { fail } = findings(r.stdout);
    expect(fail).toHaveLength(1);
    expect(fail[0]).toContain('matches NOTHING');
    expect(fail[0]).not.toContain('no paths:');
  });
});
