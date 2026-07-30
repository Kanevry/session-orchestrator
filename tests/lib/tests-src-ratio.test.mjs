/**
 * tests-src-ratio.test.mjs — pins the TV-003 measurement RECIPE.
 *
 * ## TV-001: the bugs this catches that the existing suite does not
 *
 * The suite has no coverage of this module at all (it is new), but "it is new"
 * is not a TV-001 justification. These are the concrete, nameable defects — all
 * of them defects of the MEASURING INSTRUMENT, which is the class that produced
 * six divergent numbers for one metric:
 *
 *   1. PARTITION BREAK — a tracked code file counted in BOTH buckets, or in
 *      NEITHER. This is exactly how the six numbers arose: each hand-picked src
 *      list (`scripts+hooks`, `+skills`, `everything`) silently dropped files.
 *      A future edit re-introducing an explicit src directory list would drop
 *      any new top-level dir on the floor, moving the ratio with no code change.
 *      Pinned by asserting testLoc + srcLoc === the fixture's known total.
 *
 *   2. EOF-NEWLINE OFF-BY-ONE — `wc -l` counts newline BYTES, so a file whose
 *      last line lacks a trailing newline is undercounted by one. An invisible
 *      byte would move the published metric.
 *
 *   3. EXTENSION LEAK — a `.md` or `.json` fixture under `tests/` counted as
 *      test LOC would inflate the numerator only, biasing the ratio upward and
 *      manufacturing a corridor breach out of documentation.
 *
 *   4. CORRIDOR VERDICT INVERSION — `withinCorridor` / `consolidationWaveRequired`
 *      disagreeing with the ratio, or the boundary (ratio === ceiling) flipping.
 *      TV-003 says "≤ 1.60", so equality is INSIDE.
 *
 *   5. DIVIDE-BY-ZERO — a src-less file set yielding Infinity, which a consumer
 *      reads as a corridor breach.
 *
 * ## Why a fixture and not the real repo
 *
 * The live ratio moves with every commit, so asserting it would be a time bomb
 * that goes red on a date nobody chose (learning `test-fixture-time-bomb`; the
 * same class W1 defused today). This file therefore pins the RECIPE against a
 * controlled file set and never asserts a live repo number.
 *
 * No git repository is created here: enumeration is injected into `measure()`,
 * and the CLI is exercised through `--stdin`. That keeps the test off the shared
 * git index entirely (PSA-007).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  classifyPath,
  countPhysicalLines,
  measure,
  parseArgs,
  DEFAULT_CEILING,
  CODE_EXTENSIONS,
} from '../../scripts/lib/tests-src-ratio.mjs';

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'scripts',
  'lib',
  'tests-src-ratio.mjs',
);

/**
 * A controlled corpus with hand-countable line totals.
 *
 * src  = 10 + 5 + 4  = 19 physical lines   (scripts/, hooks/, skills/)
 * test = 20 + 8      = 28 physical lines   (a .test.mjs + a code fixture)
 * ratio = 28 / 19    = 1.4737
 *
 * `skills/deep.mjs` is present specifically because it is the file the three
 * competing interpretations disagreed about — here it is unambiguously src.
 */
const FIXTURE = {
  'scripts/tool.mjs': 'a\n'.repeat(10), // 10 lines
  'hooks/guard.mjs': 'b\n'.repeat(5), //  5 lines
  'skills/deep.mjs': 'c\n'.repeat(4), //  4 lines
  'tests/thing.test.mjs': 'd\n'.repeat(20), // 20 lines
  'tests/fixtures/helper.mjs': 'e\n'.repeat(8), //  8 lines
  // Non-code under tests/ — must be invisible to BOTH buckets (bug class 3).
  'tests/fixtures/golden.json': '{\n"a":1\n}\n',
  'tests/README.md': 'x\n'.repeat(50),
  'docs/guide.md': 'y\n'.repeat(99),
};

const EXPECTED_SRC_LOC = 19;
const EXPECTED_TEST_LOC = 28;

let dir;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tests-src-ratio-'));
  for (const [rel, content] of Object.entries(FIXTURE)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** measure() over the fixture, reading real files from disk. */
function measureFixture(overrides = {}) {
  const files = Object.keys(FIXTURE);
  const readFile = (rel) => FIXTURE[rel] ?? null;
  return measure({ files, readFile, ...overrides });
}

describe('classifyPath — the partition', () => {
  it('puts skills/ in src, resolving the interpretation that split the six numbers', () => {
    expect(classifyPath('skills/deep.mjs')).toBe('src');
    expect(classifyPath('scripts/lib/x.mjs')).toBe('src');
    expect(classifyPath('hooks/guard.mjs')).toBe('src');
    expect(classifyPath('server/app.js')).toBe('src');
  });

  it('counts code fixtures under tests/ as test corpus', () => {
    expect(classifyPath('tests/a.test.mjs')).toBe('test');
    expect(classifyPath('tests/fixtures/helper.mjs')).toBe('test');
    expect(classifyPath('tests/_helpers/hook-decision.mjs')).toBe('test');
  });

  it('excludes non-code from BOTH buckets (bug class 3: extension leak)', () => {
    expect(classifyPath('tests/README.md')).toBeNull();
    expect(classifyPath('tests/fixtures/golden.json')).toBeNull();
    expect(classifyPath('docs/guide.md')).toBeNull();
    expect(classifyPath('.claude/rules/test-value.md')).toBeNull();
    expect(classifyPath('data/records.jsonl')).toBeNull();
  });

  it('classifies every tracked code file into exactly one bucket (bug class 1)', () => {
    // Any new top-level directory must land in src by NEGATION, with no rule edit.
    for (const ext of CODE_EXTENSIONS) {
      expect(classifyPath(`brand-new-toplevel/mod${ext}`)).toBe('src');
      expect(classifyPath(`tests/nested/deep/mod${ext}`)).toBe('test');
    }
  });

  it('is not fooled by a path that merely starts with the letters "tests"', () => {
    expect(classifyPath('testsuite/runner.mjs')).toBe('src');
  });
});

describe('countPhysicalLines — bug class 2 (EOF-newline off-by-one)', () => {
  it('counts the last line whether or not the file ends with a newline', () => {
    expect(countPhysicalLines('a\nb\nc\n')).toBe(3);
    expect(countPhysicalLines('a\nb\nc')).toBe(3);
  });

  it('counts blank and comment lines rather than stripping them', () => {
    expect(countPhysicalLines('code\n\n// comment\n\ncode\n')).toBe(5);
  });

  it('reports 0 for an empty file and 1 for a single unterminated line', () => {
    expect(countPhysicalLines('')).toBe(0);
    expect(countPhysicalLines('one')).toBe(1);
  });
});

describe('measure — the recipe over a controlled corpus', () => {
  it('splits the fixture into the hand-counted buckets', () => {
    const r = measureFixture();
    expect(r.srcLoc).toBe(EXPECTED_SRC_LOC);
    expect(r.testLoc).toBe(EXPECTED_TEST_LOC);
    expect(r.srcFiles).toBe(3);
    expect(r.testFiles).toBe(2);
    expect(r.ratio).toBe(1.4737);
  });

  it('loses no code line between the two buckets (bug class 1: partition)', () => {
    const r = measureFixture();
    // HARDCODED, not derived via classifyPath(): computing the expected total
    // from the production classifier would mirror the very logic under test, so
    // dropping a directory from the partition would move BOTH sides in lockstep
    // and the assertion would stay green (testing.md § Tautological Computation).
    // Verified by fake-regression: with `skills/` dropped from src this goes red.
    expect(r.testLoc + r.srcLoc).toBe(EXPECTED_SRC_LOC + EXPECTED_TEST_LOC); // 47
    expect(r.srcFiles + r.testFiles).toBe(5); // the 5 code files in FIXTURE
  });

  it('treats the ceiling as inclusive — "≤ 1.60" per TV-003 (bug class 4)', () => {
    const atCeiling = measure({
      files: ['scripts/a.mjs', 'tests/a.test.mjs'],
      readFile: (rel) => (rel.startsWith('tests/') ? 'x\n'.repeat(160) : 'y\n'.repeat(100)),
    });
    expect(atCeiling.ratio).toBe(1.6);
    expect(atCeiling.withinCorridor).toBe(true);
    expect(atCeiling.consolidationWaveRequired).toBe(false);
  });

  it('flags a breach one line above the ceiling', () => {
    const over = measure({
      files: ['scripts/a.mjs', 'tests/a.test.mjs'],
      readFile: (rel) => (rel.startsWith('tests/') ? 'x\n'.repeat(161) : 'y\n'.repeat(100)),
    });
    expect(over.withinCorridor).toBe(false);
    expect(over.consolidationWaveRequired).toBe(true);
  });

  it('reports a null ratio rather than Infinity when there is no src (bug class 5)', () => {
    const r = measure({ files: ['tests/a.test.mjs'], readFile: () => 'x\n'.repeat(10) });
    expect(r.ratio).toBeNull();
    expect(r.withinCorridor).toBe(true);
  });

  it('counts unreadable files as skipped rather than as zero-line files', () => {
    const r = measure({
      files: ['scripts/gone.mjs', 'scripts/here.mjs'],
      readFile: (rel) => (rel === 'scripts/gone.mjs' ? null : 'a\n'.repeat(7)),
    });
    expect(r.skipped).toBe(1);
    expect(r.srcFiles).toBe(1);
    expect(r.srcLoc).toBe(7);
  });

  it('honours a caller-supplied ceiling', () => {
    const r = measureFixture({ ceiling: 1.0 });
    expect(r.ceiling).toBe(1.0);
    expect(r.withinCorridor).toBe(false);
  });
});

describe('parseArgs', () => {
  it('defaults to the TV-003 ceiling', () => {
    expect(parseArgs([]).ceiling).toBe(DEFAULT_CEILING);
  });

  it('rejects an unknown flag and a non-numeric ceiling', () => {
    expect(parseArgs(['--nope']).error).toMatch(/Unknown flag/);
    expect(parseArgs(['--ceiling', 'abc']).error).toMatch(/positive number/);
    expect(parseArgs(['--ceiling', '-1']).error).toMatch(/positive number/);
  });

  it('rejects more than one positional root', () => {
    expect(parseArgs(['/a', '/b']).error).toMatch(/at most one positional/);
  });
});

describe('CLI contract', () => {
  /** Run the script against the fixture dir via --stdin (no git repo involved). */
  function runCli(extraArgs = []) {
    const paths = Object.keys(FIXTURE).join('\n');
    const res = execFileSync('node', [SCRIPT, dir, '--stdin', ...extraArgs], {
      input: paths,
      encoding: 'utf8',
    });
    return res;
  }

  it('emits a parseable --json envelope naming the globs it used', () => {
    const parsed = JSON.parse(runCli(['--json']));
    expect(parsed.schema).toBe('tests-src-ratio/1');
    expect(parsed.ratio).toBe(1.4737);
    expect(parsed.testLoc).toBe(EXPECTED_TEST_LOC);
    expect(parsed.srcLoc).toBe(EXPECTED_SRC_LOC);
    // The envelope must be self-describing: a consumer never guesses the recipe.
    expect(parsed.definition.codeExtensions).toEqual([...CODE_EXTENSIONS]);
    expect(parsed.definition.numerator).toMatch(/tests\//);
    expect(parsed.definition.denominator).toMatch(/negation/);
    expect(parsed.definition.lineRule).toMatch(/physical lines/);
  });

  it('exits 0 under --check while inside the corridor', () => {
    const res = execFileSync('node', [SCRIPT, dir, '--stdin', '--check'], {
      input: Object.keys(FIXTURE).join('\n'),
      encoding: 'utf8',
    });
    expect(res).toMatch(/within corridor/);
  });

  it('exits 1 under --check when the corridor is breached', () => {
    // Same corpus, ceiling lowered below the fixture ratio — the breach path.
    let code = 0;
    let stdout;
    try {
      stdout = execFileSync('node', [SCRIPT, dir, '--stdin', '--check', '--ceiling', '1.0'], {
        input: Object.keys(FIXTURE).join('\n'),
        encoding: 'utf8',
      });
    } catch (err) {
      code = err.status;
      stdout = err.stdout;
    }
    expect(code).toBe(1);
    expect(stdout).toMatch(/consolidation wave required/);
  });

  it('exits 2 on a bad argument rather than reporting a number', () => {
    let code = 0;
    try {
      execFileSync('node', [SCRIPT, '--bogus'], { encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      code = err.status;
    }
    expect(code).toBe(2);
  });
});
