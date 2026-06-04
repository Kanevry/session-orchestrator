/**
 * tests/lib/validate/check-unicode-safety.test.mjs
 *
 * Tests for scripts/lib/validate/check-unicode-safety.mjs (#626).
 *
 * The validator scans tracked text files for dangerous / invisible Unicode
 * (zero-width, bidi-override, tag-block, orphan variation-selectors, soft
 * hyphen), non-curated emoji in STRICT contexts (code files + .md frontmatter),
 * and mixed-script homoglyphs in STRICT identifier tokens. The repo's deliberate
 * banner/status emoji set is tolerated; markdown prose is LENIENT (invisibles
 * still flagged, deliberate emoji allowed). Exit 0 = clean, 1 = violations,
 * 2 = tool error. --json emits the violation array; --write strips
 * dangerous-invisibles from writable files.
 *
 * Two surfaces are exercised:
 *   - The exported `collectUnicodeViolations(root)` collector (pure) against
 *     tmpdir fixtures (git is initialised so `git ls-files` enumerates).
 *   - The full CLI via spawnSync (exit-code + PASS/FAIL / --json output) against
 *     tmpdir plugin roots, plus a load-bearing REGRESSION PIN against the REAL
 *     repo tree.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { collectUnicodeViolations } from '@lib/validate/check-unicode-safety.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'lib', 'validate', 'check-unicode-safety.mjs');

// Code points used in fixtures (kept out of the source bytes of THIS test file
// so the scanner's self-exclusion is not load-bearing for the planted cases).
const ZWSP = String.fromCodePoint(0x200b); // zero-width space
const RLO = String.fromCodePoint(0x202e); // bidi right-to-left override
const CYRILLIC_A = String.fromCodePoint(0x0430); // Cyrillic 'а' (homoglyph of Latin a)
const ROCKET = String.fromCodePoint(0x1f680); // 🚀 — NOT in the deliberate allow-list
const LAMBDA = String.fromCodePoint(0x03bb); // λ — Greek small lambda (NOT a homoglyph vector)
const ALPHA = String.fromCodePoint(0x03b1); // α — Greek small alpha
const BETA = String.fromCodePoint(0x03b2); // β — Greek small beta
const GAMMA = String.fromCodePoint(0x03b3); // γ — Greek small gamma
const BOM = String.fromCodePoint(0xfeff); // U+FEFF byte-order mark
const WARN = String.fromCodePoint(0x26a0); // ⚠ — curated deliberate symbol

// ---------------------------------------------------------------------------
// Fixture helpers — build a tmp plugin-root, git-init it so `git ls-files`
// enumerates the planted files.
// ---------------------------------------------------------------------------

const tmpRoots = [];

/** Make a git-initialised tmp plugin-root and return its path. */
function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'check-unicode-'));
  tmpRoots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}

/** Write a file under the fixture root and stage it so git ls-files sees it. */
function writeTracked(root, relPath, content) {
  const full = join(root, relPath);
  const dir = join(full, '..');
  mkdirSync(dir, { recursive: true });
  writeFileSync(full, content, 'utf8');
  execFileSync('git', ['add', '-f', relPath], { cwd: root });
}

/** Spawn the CLI against a plugin root; returns the spawnSync result. */
function run(pluginRoot, ...extraArgs) {
  return spawnSync('node', [SCRIPT, pluginRoot, ...extraArgs], {
    encoding: 'utf8',
    timeout: 30_000,
  });
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 1: zero-width space in a .mjs → exit 1, FAIL names file:line:col + U+200B
// ---------------------------------------------------------------------------

describe('check-unicode-safety — zero-width space in code', () => {
  it('collectUnicodeViolations records the U+200B with file:line:column', () => {
    const root = makeFixture();
    writeTracked(root, 'foo.mjs', `const x = 1;\nconst y${ZWSP} = 2;\n`);

    const violations = collectUnicodeViolations(root);

    expect(violations).toEqual([
      { file: 'foo.mjs', line: 2, column: 8, kind: 'dangerous-invisible', codePoint: 'U+200B' },
    ]);
  });

  it('CLI exits 1 and the FAIL line names foo.mjs:2:8 and U+200B', () => {
    const root = makeFixture();
    writeTracked(root, 'foo.mjs', `const x = 1;\nconst y${ZWSP} = 2;\n`);

    const r = run(root);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('FAIL: foo.mjs:2:8 — dangerous-invisible U+200B');
    expect(r.stdout).toContain('Results: 0 passed, 1 failed');
  });
});

// ---------------------------------------------------------------------------
// Test 2: bidi override (U+202E) → exit 1
// ---------------------------------------------------------------------------

describe('check-unicode-safety — bidi override', () => {
  it('flags U+202E as dangerous-invisible and exits 1', () => {
    const root = makeFixture();
    writeTracked(root, 'evil.js', `const a = "safe${RLO}txet";\n`);

    const r = run(root);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('dangerous-invisible U+202E');
    expect(r.stdout).toContain('FAIL: evil.js:1:');
  });
});

// ---------------------------------------------------------------------------
// Test 3: confusable / mixed-script homoglyph in a code identifier → exit 1
// (confusable detection IS in scope: STRICT contexts, Latin+Cyrillic/Greek)
// ---------------------------------------------------------------------------

describe('check-unicode-safety — mixed-script homoglyph (in scope, strict only)', () => {
  it('flags a Cyrillic-а inside an ASCII identifier in a .mjs and exits 1', () => {
    const root = makeFixture();
    // `pаyload` — the second char is Cyrillic U+0430, the rest Latin.
    writeTracked(root, 'mod.mjs', `const p${CYRILLIC_A}yload = 1;\n`);

    const r = run(root);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('mixed-script U+430');
    expect(r.stdout).toContain('FAIL: mod.mjs:1:');
  });

  it('does NOT flag the same Cyrillic-а in markdown PROSE (lenient, homoglyph not scanned)', () => {
    const root = makeFixture();
    writeTracked(root, 'doc.md', `# Title\n\nA prose word p${CYRILLIC_A}yload appears here.\n`);

    const r = run(root);

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('mixed-script');
    expect(r.stdout).toContain('Results: 1 passed, 0 failed');
  });

  it('does NOT flag legit Greek-letter identifiers in a STRICT .mjs (Greek excluded from mixed-script, #626)', () => {
    const root = makeFixture();
    // `λmax` mixes Latin + Greek; `αβγ` is pure Greek. Neither is a homoglyph
    // attack — Greek math letters are visually distinct from Latin and are
    // legitimate identifiers. They must NOT be flagged in strict code context.
    writeTracked(
      root,
      'math.mjs',
      `const ${LAMBDA}max = 5;\nconst ${ALPHA}${BETA}${GAMMA} = 1;\n`,
    );

    const r = run(root);

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('mixed-script');
    expect(r.stdout).toContain('Results: 1 passed, 0 failed');
  });
});

// ---------------------------------------------------------------------------
// Test 4: clean tree + legit deliberate emoji in .md prose → exit 0
// ---------------------------------------------------------------------------

describe('check-unicode-safety — clean tree with deliberate prose emoji', () => {
  it('exits 0 when prose uses the curated banner/status emoji set', () => {
    const root = makeFixture();
    // ✓ is not Extended_Pictographic (dingbat) — never an emoji match anyway;
    // ⚠ (U+26A0) and 📚 (U+1F4DA) ARE in the deliberate allow-list.
    writeTracked(root, 'readme.md', '# Doc\n\n⚠ Warning and \u{1f4da} docs are fine in prose.\n');

    const r = run(root);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASS: no dangerous / invisible Unicode or homoglyphs found');
    expect(r.stdout).toContain('Results: 1 passed, 0 failed');
  });
});

// ---------------------------------------------------------------------------
// Test 5: strict-vs-lenient — a NON-curated emoji in code is flagged, the same
// emoji in markdown prose passes.
// ---------------------------------------------------------------------------

describe('check-unicode-safety — strict vs lenient emoji', () => {
  it('flags a non-curated emoji (🚀) in a .mjs (strict) → exit 1', () => {
    const root = makeFixture();
    writeTracked(root, 'app.mjs', `console.log("launch ${ROCKET}");\n`);

    const r = run(root);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('emoji U+1F680');
    expect(r.stdout).toContain('FAIL: app.mjs:1:');
  });

  it('does NOT flag the same non-curated emoji (🚀) in markdown PROSE → exit 0', () => {
    const root = makeFixture();
    writeTracked(root, 'notes.md', `# Notes\n\nWe shipped it ${ROCKET} today.\n`);

    const r = run(root);

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('emoji');
    expect(r.stdout).toContain('Results: 1 passed, 0 failed');
  });

  it('flags a non-curated emoji inside a .md FRONTMATTER block (strict) → exit 1', () => {
    const root = makeFixture();
    writeTracked(root, 'front.md', `---\ntitle: launch ${ROCKET}\n---\n\nProse body.\n`);

    const r = run(root);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('emoji U+1F680');
    expect(r.stdout).toContain('FAIL: front.md:2:');
  });
});

// ---------------------------------------------------------------------------
// Test 6: tool-error path — missing root / missing arg → exit 2 + stderr usage
// ---------------------------------------------------------------------------

describe('check-unicode-safety — tool-error path', () => {
  it('exits 2 when the plugin root does not exist', () => {
    const r = run('/nonexistent/path/does/not/exist-xyz');

    expect(r.status).toBe(2);
    expect(r.stderr).toContain('tool-error: plugin root not found');
  });

  it('exits 2 and writes a usage line when no plugin-root argument is supplied', () => {
    const r = spawnSync('node', [SCRIPT], { encoding: 'utf8', timeout: 15_000 });

    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Usage: check-unicode-safety.mjs <plugin-root>');
  });
});

// ---------------------------------------------------------------------------
// Test 7: --json emits a parseable violation array
// ---------------------------------------------------------------------------

describe('check-unicode-safety — --json output', () => {
  it('emits a JSON array of violations on stdout', () => {
    const root = makeFixture();
    writeTracked(root, 'bar.ts', `const z${ZWSP} = 3;\n`);

    const r = run(root, '--json');

    expect(r.status).toBe(1);
    const parsed = JSON.parse(r.stdout);
    expect(parsed).toEqual([
      { file: 'bar.ts', line: 1, column: 8, kind: 'dangerous-invisible', codePoint: 'U+200B' },
    ]);
  });

  it('emits an empty JSON array and exits 0 on a clean tree', () => {
    const root = makeFixture();
    writeTracked(root, 'clean.mjs', 'const ok = true;\n');

    const r = run(root, '--json');

    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Test 8: variation-selector carve-out — legit emoji-presentation U+FE0F passes,
// an ORPHAN variation selector is flagged.
// ---------------------------------------------------------------------------

describe('check-unicode-safety — variation-selector carve-out', () => {
  it('does NOT flag a U+FE0F that follows an Extended_Pictographic base (in prose)', () => {
    const root = makeFixture();
    // ⚠ (U+26A0, allow-listed pictographic) + VS-16 (U+FE0F) = legit emoji presentation.
    writeTracked(root, 'pres.md', '# Doc\n\nWarning ⚠️ rendered as emoji.\n');

    const r = run(root);

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('variation-selector');
    expect(r.stdout).toContain('Results: 1 passed, 0 failed');
  });

  it('flags an ORPHAN U+FE0F not preceded by a pictographic base → exit 1', () => {
    const root = makeFixture();
    // VS-16 right after a plain ASCII letter is an orphan variation selector.
    writeTracked(root, 'orphan.md', 'A️ orphan selector here.\n');

    const r = run(root);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('orphan-variation-selector U+FE0F');
  });
});

// ---------------------------------------------------------------------------
// Test 9: REGRESSION PIN (load-bearing) — the REAL repo tree must be clean.
//
// Green only AFTER the single stray U+00AD soft-hyphen in the gsd PRD is removed
// and the U+FE0F carve-out tolerates the 6 legitimate emoji-presentation
// selectors in the tree. If a future edit smuggles an invisible / bidi / orphan
// VS / non-curated code-context emoji / homoglyph, this pin fails.
// ---------------------------------------------------------------------------

describe('check-unicode-safety — REGRESSION PIN against the real repo', () => {
  it('the real tree has zero Unicode-safety violations (exit 0)', () => {
    const r = run(REPO_ROOT);

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('FAIL:');
    expect(r.stdout).toMatch(/Results: \d+ passed, 0 failed/);
  });
});

// ---------------------------------------------------------------------------
// Test 10: BOM + frontmatter — a leading U+FEFF must NOT defeat frontmatter
// detection (#626). The BOM itself is still flagged as dangerous-invisible AND
// the frontmatter is still scanned STRICT (a non-curated emoji inside it fails).
// ---------------------------------------------------------------------------

describe('check-unicode-safety — BOM before frontmatter', () => {
  it('flags the BOM AND still scans the frontmatter strict (non-curated emoji inside fails)', () => {
    const root = makeFixture();
    // BOM + `---\n…emoji…\n---` + prose. Pre-fix, startsWith('---\n') failed
    // after the BOM, so the frontmatter was treated as lenient prose and the
    // 🚀 slipped through. Post-fix: BOM flagged (dangerous-invisible) AND the
    // emoji in the frontmatter flagged (strict).
    writeTracked(root, 'bom.md', `${BOM}---\ntitle: launch ${ROCKET}\n---\n\nProse body.\n`);

    const r = run(root);

    expect(r.status).toBe(1);
    // The BOM itself is still flagged.
    expect(r.stdout).toContain('dangerous-invisible U+FEFF');
    // The frontmatter is scanned STRICT → the non-curated emoji is flagged.
    expect(r.stdout).toContain('emoji U+1F680');
  });

  it('a curated emoji inside BOM-prefixed frontmatter passes (only the BOM is flagged)', () => {
    const root = makeFixture();
    // ⚠ is a curated deliberate symbol — it passes even in strict frontmatter.
    // Only the BOM should be flagged here.
    writeTracked(root, 'bom-ok.md', `${BOM}---\ntitle: ${WARN} heads up\n---\n\nBody.\n`);

    const r = run(root);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('dangerous-invisible U+FEFF');
    expect(r.stdout).not.toContain('emoji');
  });
});

// ---------------------------------------------------------------------------
// Test 11: --write idempotence (#626) — stripping is a fixpoint and curated
// emoji survive the strip (only dangerous-invisibles are removed).
// ---------------------------------------------------------------------------

describe('check-unicode-safety — --write idempotence', () => {
  it('strip(strip(x)) === strip(x) and curated emoji survive the strip', async () => {
    const { stripDangerousInvisibles } = await import('@lib/validate/check-unicode-safety.mjs');
    // A .md prose body mixing a dangerous-invisible (ZWSP), a curated emoji (⚠),
    // and a non-curated emoji (🚀). Only the ZWSP must be removed; both emoji
    // survive (the stripper removes dangerous-invisibles + orphan VS only).
    const input = `# Doc\n\nWarning ${WARN} and ship ${ROCKET}${ZWSP} today.\n`;

    const once = stripDangerousInvisibles(input);
    const twice = stripDangerousInvisibles(once);

    // Idempotence: a second strip is a no-op.
    expect(twice).toBe(once);
    // The dangerous-invisible ZWSP is gone.
    expect(once).not.toContain(ZWSP);
    // Both curated and non-curated emoji survive (strip touches invisibles only).
    expect(once).toContain(WARN);
    expect(once).toContain(ROCKET);
  });

  it('CLI --write strips a dangerous-invisible from a writable .md and the rescan is clean', () => {
    const root = makeFixture();
    writeTracked(root, 'fix.md', `# Title\n\nText with a hidden${ZWSP} zero-width space.\n`);

    // First pass with --write strips the invisible; the post-strip rescan is clean.
    const r = run(root, '--write');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`stripped dangerous-invisibles from fix.md`);

    // A second --write run is idempotent: nothing left to strip, still exit 0.
    const r2 = run(root, '--write');
    expect(r2.status).toBe(0);
    expect(r2.stdout).not.toContain('stripped dangerous-invisibles');
  });
});
