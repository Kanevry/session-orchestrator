/**
 * tests/lib/validate/check-auq-clarity.test.mjs
 *
 * Tests for scripts/lib/validate/check-auq-clarity.mjs (#1107 wave 4).
 *
 * The guard is a RATCHET over the AUQ question corpus: it gates on the two hard
 * limits H1 (header <= 12 code points) and H2 (2-4 options per question,
 * `(Recommended)` only at index 0), and on nothing else. Every case below names
 * the concrete defect it would catch; a case that cannot name one is not here.
 *
 * Fixture strategy — copied from tests/scripts/auq-audit.test.mjs, and load-bearing:
 *
 *   1. Fixtures are COPIES OF REAL TEMPLATES with one deliberate mutation. A
 *      hand-written AUQ block would encode what the parser expects rather than
 *      what the repo actually contains (the "unfaithful double" in
 *      .claude/rules/testing.md).
 *   2. Never measured against the live repo for the RED cases. Wave 3 of #1107
 *      took the corpus from 21/72 to 72/72, and two gate tests that pinned the
 *      old defect count went red for the repair. A test that requires the repo
 *      to stay broken punishes fixing it.
 *   3. The checker enumerates the corpus with `git ls-files`, which finds
 *      nothing inside a bare tmp directory — hence `--file <relative path>` in
 *      every fixture case.
 *   4. Mutations are applied with `writeFileSync`, never `perl -pi`: a first
 *      attempt at the code-point case with `perl -0pi` mangled the UTF-8 into
 *      mojibake and turned a 10-code-point header into a 14-character one,
 *      inverting the very result under test (.claude/rules/bash-harness-pitfalls.md §4).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'lib', 'validate', 'check-auq-clarity.mjs');
const VALIDATE_PLUGIN = join(REPO_ROOT, 'scripts', 'validate-plugin.mjs');

/**
 * A real, currently-clean template with a `header:` literal of 9 code points.
 * The fake regression only proves something against a template that passes
 * BEFORE the mutation.
 */
const CLEAN_TEMPLATE = 'skills/bootstrap/SKILL.md';

/** A real template whose option list ends in an ellipsis -> `optionCountUnknown`. */
const ELLIPSIS_TEMPLATE = 'skills/evolve/SKILL.md';

/** A real Cursor rule carrying a prose-fallback question (population C-mdc). */
const MDC_TEMPLATE = '.cursor/rules/000-session-orchestrator.mdc';

let tmpRoot;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'check-auq-clarity-'));
});

afterAll(() => {
  if (tmpRoot && existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Runs the checker. Exit code is read from `status` directly — never through a
 * shell pipe, where `$?` would report the last stage instead of node.
 *
 * @param {string[]} args
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Copies a real repo template into a fresh fixture root under `rel`, optionally
 * mutating it on the way.
 *
 * @param {string} name    fixture sub-directory
 * @param {string} source  repo-relative path of the template to copy
 * @param {string} rel     repo-relative path inside the fixture
 * @param {(src: string) => string} [mutate]
 * @returns {{root: string, rel: string, abs: string, original: string}}
 */
function fixture(name, source, rel, mutate) {
  const root = join(tmpRoot, name);
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  cpSync(join(REPO_ROOT, source), abs);
  const original = readFileSync(abs, 'utf8');
  if (mutate) {
    const mutated = mutate(original);
    // A mutation that did not apply leaves a case that verifies nothing.
    expect(mutated, `mutation for fixture "${name}" did not apply`).not.toBe(original);
    writeFileSync(abs, mutated, 'utf8');
  }
  return { root, rel, abs, original };
}

// ---------------------------------------------------------------------------
// The production assertion: the ratchet holds on the live tree
// ---------------------------------------------------------------------------

describe('check-auq-clarity.mjs — live repository', () => {
  // Spawned once: the checker parses every tracked corpus file, so a per-case
  // spawn multiplies that work for no additional coverage. `hookTimeout` is
  // 30s where `testTimeout` is 10s (vitest.config.mjs) — the same reason the
  // sibling suites hoist their heavy spawns.
  let r;
  beforeAll(() => {
    r = run([REPO_ROOT]);
  });

  // CATCHES: a newly landed question whose header is truncated by the tool, or
  // whose option list is unusable. That IS the ratchet — this case is the guard
  // itself, not a test of the guard.
  it('exits 0 against the real repo and reports both hard limits', () => {
    expect(r.status, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/PASS: H1 .* 0 of \d+ questions break this limit/);
    expect(r.stdout).toMatch(/PASS: H2 .* 0 of \d+ questions break this limit/);
    expect(r.stdout).toMatch(/Results: \d+ passed, 0 failed/);
  });

  // CATCHES: the guard degenerating into a decoy by measuring an empty or
  // near-empty corpus while still printing "0 violations". The denominator is
  // asserted as a FLOOR, never an exact count — pinning "72" would go red on
  // every legitimate template edit (.claude/rules/testing.md, "Dynamic Artifact
  // Counts").
  it('measures a non-trivial corpus, not an empty one', () => {
    expect(r.status).toBe(0);
    const match = r.stdout.match(/PASS: H1 .* 0 of (\d+) questions/);
    expect(match).not.toBeNull();
    expect(Number(match[1])).toBeGreaterThanOrEqual(20);
  });
});

// ---------------------------------------------------------------------------
// Fake regression: does the guard bite at all?
// ---------------------------------------------------------------------------

describe('check-auq-clarity.mjs — fake regression on a copy of a real template', () => {
  // CATCHES: the guard is wired, runs, prints PASS lines, and can never fail —
  // the "built, wired, inert" variant of this repo's decoy class. A green run
  // proves nothing on its own; only a demonstrated red does.
  it('goes RED when a header grows past the hard limit, and green again when reverted', () => {
    const f = fixture('fake-regression', CLEAN_TEMPLATE, 'skills/demo/SKILL.md');

    const before = run([f.root, '--file', f.rel]);
    expect(before.status, `stdout:\n${before.stdout}`).toBe(0);

    const broken = f.original.replace(
      /header: "Archetype"/gu,
      'header: "Archetype With A Long Header"',
    );
    expect(broken).not.toBe(f.original);
    writeFileSync(f.abs, broken, 'utf8');

    const after = run([f.root, '--file', f.rel]);
    expect(after.status, `stdout:\n${after.stdout}`).toBe(1);
    expect(after.stdout).toContain('breaks hard limit H1');
    expect(after.stdout).toMatch(/Results: \d+ passed, 1 failed/);

    // The counter-direction. Without it the red could have come from anything
    // else about the run rather than from the mutation.
    writeFileSync(f.abs, f.original, 'utf8');
    const reverted = run([f.root, '--file', f.rel]);
    expect(reverted.status).toBe(0);
    expect(reverted.stdout).not.toContain('FAIL:');
  });
});

// ---------------------------------------------------------------------------
// What the guard must NOT do
// ---------------------------------------------------------------------------

describe('check-auq-clarity.mjs — gates on hard limits, not on the score', () => {
  // CATCHES: a guard that gates on points/grade or on any K1-K8 finding. The
  // eight weighted criteria carry measured false-positive rates of 14%-25%, so
  // such a guard objects to roughly every fourth CORRECT question and is
  // switched off within a month — taking every true finding with it.
  //
  // The mutation below is a real quality regression: measured with
  // `node scripts/auq-audit.mjs <fixture> --file <rel> --json`, the question
  // drops from 100 points / grade A to 80 points / grade B with one K1 finding.
  // The guard must stay green through exactly that.
  it('stays green for a question that loses points but breaks no hard limit', () => {
    const longQuestion =
      'Welchen Tech-Stack soll ich fuer das Grundgeruest verwenden, und welche ' +
      'Randbedingungen des Projekts, der Zielgruppe und des spaeteren Betriebs ' +
      'soll ich dabei beruecksichtigen?';
    const f = fixture('score-not-gated', CLEAN_TEMPLATE, 'skills/demo/SKILL.md', (src) =>
      src.replace(
        /question: "Welchen Tech-Stack soll ich für das Grundgerüst verwenden\?"/u,
        `question: "${longQuestion}"`,
      ),
    );

    const r = run([f.root, '--file', f.rel]);
    expect(r.status, `stdout:\n${r.stdout}`).toBe(0);
    expect(r.stdout).not.toContain('FAIL:');
  });

  // CATCHES: measuring the header in BYTES (`Buffer.byteLength`) or in UTF-16
  // units instead of Unicode code points. `"Größe — Ja"` is 10 code points and
  // 14 bytes; a byte-based check invents a violation for every umlaut and em
  // dash in a perfectly legal header.
  it('measures the header in code points, not bytes', () => {
    const header = 'Größe — Ja';
    expect([...header]).toHaveLength(10);
    expect(Buffer.byteLength(header, 'utf8')).toBe(14);

    const f = fixture('codepoints', CLEAN_TEMPLATE, 'skills/demo/SKILL.md', (src) =>
      src.replace(/header: "Archetype"/gu, `header: "${header}"`),
    );

    const r = run([f.root, '--file', f.rel]);
    expect(r.status, `stdout:\n${r.stdout}`).toBe(0);
    expect(r.stdout).not.toContain('breaks hard limit H1');
  });

  // CATCHES: treating `optionCountUnknown` as a violation. Several templates end
  // their option list in an ellipsis, so the true runtime option count is not
  // written down anywhere. clarity.mjs records that as a warn-level note and
  // breaks NO hurdle — "not checkable" is not "violated". A guard that keyed on
  // findings instead of `hurdlesBroken` would report violations that do not
  // exist, which is the fastest route to being switched off.
  it('does not fail a template whose option count is unknown', () => {
    const f = fixture('option-count-unknown', ELLIPSIS_TEMPLATE, 'skills/evolve/SKILL.md');
    const r = run([f.root, '--file', f.rel]);
    expect(r.status, `stdout:\n${r.stdout}`).toBe(0);
    expect(r.stdout).not.toContain('FAIL:');
  });
});

// ---------------------------------------------------------------------------
// Corpus reach
// ---------------------------------------------------------------------------

describe('check-auq-clarity.mjs — corpus reach beyond markdown', () => {
  // CATCHES: a guard narrowed to `.md`. `.cursor/rules/*.mdc` is the ONLY
  // surface a Cursor operator ever sees; a markdown-only reader hands it a clean
  // bill of health it never earned, because it never opened the file. The
  // mutation adds a fifth option, which keeps the block parseable (removing one
  // instead would drop the question entirely and prove nothing about reach).
  it('reads .cursor/rules/*.mdc and fails a hard-limit breach there', () => {
    const f = fixture('mdc-reach', MDC_TEMPLATE, '.cursor/rules/demo.mdc', (src) =>
      src.replace(
        '2. Option B — when B applies instead, and what it costs.\n',
        '2. Option B — when B applies instead, and what it costs.\n' +
          '3. Option C — a third path, and its price.\n' +
          '4. Option D — a fourth path, and its price.\n' +
          '5. Option E — a fifth path, and its price.\n',
      ),
    );

    const r = run([f.root, '--file', f.rel]);
    expect(r.status, `stdout:\n${r.stdout}`).toBe(1);
    expect(r.stdout).toContain('breaks hard limit H2');
    expect(r.stdout).toContain('.cursor/rules/demo.mdc');
  });

  // CATCHES: a broken file enumeration reported as a clean repo. Zero questions
  // found means the guard measured NOTHING, which prints identically to a clean
  // corpus unless it is called out — this is the exact shape of the failure the
  // guard was written to end, so it must fail closed.
  it('fails closed when the corpus is empty', () => {
    const root = join(tmpRoot, 'empty-corpus');
    mkdirSync(root, { recursive: true });
    const r = run([root, '--file', 'skills/does-not-exist/SKILL.md']);
    expect(r.status, `stdout:\n${r.stdout}`).toBe(1);
    expect(r.stdout).toContain('the AUQ corpus is empty');
  });
});

// ---------------------------------------------------------------------------
// Wiring — the whole point of this wave
// ---------------------------------------------------------------------------

describe('check-auq-clarity.mjs — wiring into validate-plugin.mjs', () => {
  // The orchestrator forks ~22 grandchildren and needs ~12s, over the 10s
  // `testTimeout`; `hookTimeout` is 30s. Same hoist, same reason, as
  // tests/scripts/validate-plugin.test.mjs and tests/agents/persona-reviewers.test.mjs.
  let r;
  beforeAll(() => {
    r = spawnSync(process.execPath, [VALIDATE_PLUGIN, REPO_ROOT], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
    });
  });

  // CATCHES: the guard existing, being tested, and having no caller — the
  // documented "built, documented, tested, never switched on" class this file
  // was created to close. Deleting the one registration line in
  // validate-plugin.mjs leaves every case above green; only this one goes red.
  it('runs as part of validate-plugin.mjs against the real repo', () => {
    expect(r.status, `stdout tail:\n${(r.stdout ?? '').slice(-2000)}`).toBe(0);
    expect(r.stdout).toContain('AUQ question corpus hard limits');
    expect(r.stdout).toMatch(/PASS: H1 .* questions break this limit/);
    expect(r.stdout).toMatch(/Results: \d+ passed, 0 failed/);
  });
});
