/**
 * check-untracked-test-deps.test.mjs — proof that the untracked-test-dependency
 * guard BITES.
 *
 * A green check proves nothing about a guard that has never bitten
 * (`.claude/rules/testing.md` § Negative-Assertion). Every positive below is
 * therefore a PLANTED DEFECT with a NEGATIVE TWIN that differs in exactly the
 * one property the rule turns on — without the twin, a rule that flags
 * everything would pass the positive too.
 *
 * Deliberately NOT an acceptance criterion: "the check reports 0 findings
 * against this repo". That is the tautological trap `tests/scripts/
 * site-numbers.test.mjs` names in its own header — it is satisfied by a check
 * that detects nothing at all. FR-3 below carries the bite instead: it
 * reproduces the pre-fix shape of the real CI-red defect, which is the best
 * negative evidence available and would otherwise be lost the moment that file
 * is repaired.
 *
 * Every fixture source lives inside a TEMPLATE LITERAL, which the check masks
 * as data — that is what keeps this file from flagging itself, structurally
 * rather than by self-exemption.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  scanUntrackedTestDeps,
  resolveUntrackedOracle,
  normalizeCandidate,
  extractLiteralCandidates,
  maskSource,
} from '../../../scripts/lib/validate/check-untracked-test-deps.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CHECK = join(REPO_ROOT, 'scripts', 'lib', 'validate', 'check-untracked-test-deps.mjs');

/** The store pattern this repo actually ships (`.gitignore:40`). */
const GITIGNORE = '.orchestrator/metrics/*.jsonl\n';

const tmpDirs = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/**
 * Build a throwaway git repo from a `{ relPath: content }` map and stage it, so
 * `git ls-files` enumerates the fixture exactly as it does a real checkout.
 *
 * @param {Record<string, string>} files
 * @returns {string} absolute fixture root
 */
function makeRepo(files) {
  const root = mkdtempSync(join(tmpdir(), 'untracked-test-deps-'));
  tmpDirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  spawnSync('git', ['init', '-b', 'main'], { cwd: root, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: root, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root, encoding: 'utf8' });
  spawnSync('git', ['add', '-A'], { cwd: root, encoding: 'utf8' });
  return root;
}

/** Run the check CLI against a fixture root. */
function run(root) {
  const r = spawnSync('node', [CHECK, root], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

// The module a test reaches THROUGH its import, which names the untracked path
// only as `join()` segments against a runtime `root` parameter — the exact
// shape that makes a `tests/**`-only scan score zero.
const LEDGER_MODULE = `
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

export function collect(root) {
  const ledger = join(root, '.orchestrator', 'metrics', 'sessions.jsonl');
  if (!existsSync(ledger)) return { missing: ['sessions'] };
  return { missing: [], raw: readFileSync(ledger, 'utf8') };
}
`;

describe('FR-1 — R2, transitive dependency through the import closure', () => {
  it('flags a test that passes a statically resolved real root into a closure naming an untracked path', () => {
    const root = makeRepo({
      '.gitignore': GITIGNORE,
      'scripts/ledger.mjs': LEDGER_MODULE,
      'tests/ledger.test.mjs': `
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { collect } from '../scripts/ledger.mjs';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

it('measures the real repo', () => {
  expect(collect(REPO_ROOT).missing).toEqual([]);
});
`,
      '.orchestrator/metrics/sessions.jsonl': '{"session":"x"}\n',
    });

    const { code, out } = run(root);
    expect(code).toBe(1);
    // The finding must name all three: WHICH test, WHICH untracked path, and
    // the INTERMEDIATE NODE — the route to the site is half the value, because
    // the test itself never mentions `.orchestrator` at all.
    expect(out).toContain('tests/ledger.test.mjs');
    expect(out).toContain('.orchestrator/metrics/sessions.jsonl');
    expect(out).toContain('scripts/ledger.mjs');
    expect(out).toContain('[R2]');
  });

  it('TWIN: does NOT flag the same closure when the root is a mkdtempSync temp dir', () => {
    const root = makeRepo({
      '.gitignore': GITIGNORE,
      'scripts/ledger.mjs': LEDGER_MODULE,
      // Identical to the positive but for the ROOT EXPRESSION. `HERE` is
      // deliberately present and unused: a rule keyed on "the file contains a
      // repo-root expression" (R1, 67 false positives) still fires here, so
      // this twin fails any loosening in that direction.
      'tests/ledger.test.mjs': `
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect } from '../scripts/ledger.mjs';

const HERE = fileURLToPath(import.meta.url);
const REPO_ROOT = mkdtempSync(join(tmpdir(), 'fixture-'));

it('measures a synthetic tree', () => {
  expect(collect(REPO_ROOT).missing).toEqual(['sessions']);
});
`,
      '.orchestrator/metrics/sessions.jsonl': '{"session":"x"}\n',
    });

    const { code, out } = run(root);
    expect(code).toBe(0);
    expect(out).toContain('PASS: R2');
  });
});

describe('FR-2 — R4, cwd-relative read of an untracked path', () => {
  it('flags a bare literal read through an identifier binding', () => {
    const root = makeRepo({
      '.gitignore': GITIGNORE,
      'tests/store.test.mjs': `
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const p = '.orchestrator/metrics/sessions.jsonl';
const lines = readFileSync(p, 'utf8').split('\\n').filter(Boolean);

it('validates every historical entry', () => {
  expect(lines.length).toBeGreaterThan(0);
});
`,
      '.orchestrator/metrics/sessions.jsonl': '{"session":"x"}\n',
    });

    const { code, out } = run(root);
    expect(code).toBe(1);
    expect(out).toContain('[R4]');
    expect(out).toContain('tests/store.test.mjs');
    expect(out).toContain('.orchestrator/metrics/sessions.jsonl');
  });

  it('TWIN: does NOT flag the same path when it is join()-wrapped against a temp dir', () => {
    const root = makeRepo({
      '.gitignore': GITIGNORE,
      // Identical read, identical literal — only the join() wrapping differs.
      // A rule keyed on "the test contains a bare untracked path literal"
      // (R3, 47 false positives) still fires here.
      'tests/store.test.mjs': `
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'fixture-'));
const target = join(tmp, '.orchestrator/metrics/sessions.jsonl');
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, '{}\\n');
const lines = readFileSync(target, 'utf8').split('\\n').filter(Boolean);

it('validates every synthetic entry', () => {
  expect(lines.length).toBe(1);
});
`,
      '.orchestrator/metrics/sessions.jsonl': '{"session":"x"}\n',
    });

    const { code, out } = run(root);
    expect(code).toBe(0);
    expect(out).toContain('PASS: R4');
  });
});

describe('FR-3 — the real CI-red defect, reproduced verbatim', () => {
  it('flags the pre-fix shape of tests/scripts/site-numbers.test.mjs', () => {
    // This is the strongest available negative evidence: the actual defect that
    // turned CI red. Once the live file is repaired that bite is gone unless it
    // is pinned here, so the load-bearing lines are reproduced verbatim — the
    // `fileURLToPath(new URL('../../', import.meta.url))` root, the relative
    // import at the same depth, and the `collect(REPO_ROOT)` call in beforeAll.
    const root = makeRepo({
      '.gitignore': GITIGNORE,
      'scripts/site-numbers.mjs': `
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

function countJsonlEntries(file) {
  if (!existsSync(file)) return null;
  return { entries: readFileSync(file, 'utf8').split('\\n').filter(Boolean).length };
}

const METRICS = [
  {
    id: 'sessions',
    source: 'grep -c . .orchestrator/metrics/sessions.jsonl',
    compute: (root) => {
      const r = countJsonlEntries(join(root, '.orchestrator', 'metrics', 'sessions.jsonl'));
      return r === null ? null : String(r.entries);
    },
  },
];

export function collect(root) {
  const values = {};
  const missing = [];
  for (const m of METRICS) {
    const v = m.compute(root);
    if (v === null) missing.push(m.id);
    else values[m.id] = v;
  }
  return { values, missing };
}
`,
      'tests/scripts/site-numbers.test.mjs': `
import { describe, it, expect, beforeAll } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collect } from '../../scripts/site-numbers.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts', 'site-numbers.mjs');

let current;
beforeAll(() => {
  const res = collect(REPO_ROOT);
  expect(res.missing).toEqual([]); // the real repo must be measurable
  current = res.values;
});

it('reports a sessions count', () => {
  expect(current.sessions).toBeTruthy();
});
`,
      '.orchestrator/metrics/sessions.jsonl': '{"session":"x"}\n',
    });

    const { code, out } = run(root);
    expect(code).toBe(1);
    expect(out).toContain('tests/scripts/site-numbers.test.mjs');
    expect(out).toContain('scripts/site-numbers.mjs');
    expect(out).toContain('.orchestrator/metrics/sessions.jsonl');
  });
});

describe('FR-4 — a rejected spec must not swallow the rest of the check-ignore batch', () => {
  it('still reports the ignored path when an escaping ../ candidate precedes it', () => {
    // `git check-ignore --stdin` aborts with `fatal` on the first `../` spec and
    // DISCARDS the remainder of the stream — measured, 44 of 45 hits swallowed.
    // The jsonl is deliberately ABSENT from disk (fresh-clone simulation), so
    // ONLY check-ignore can condemn it: if the batch is poisoned, the second
    // oracle half cannot cover for it and this test goes red.
    const root = makeRepo({
      '.gitignore': GITIGNORE,
      'scripts/ledger.mjs': `
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const ESCAPE = '../outside/thing.txt';

export function collect(root) {
  const ledger = join(root, '.orchestrator', 'metrics', 'sessions.jsonl');
  return { missing: existsSync(ledger) ? [] : ['sessions'], escape: ESCAPE };
}
`,
      'tests/ledger.test.mjs': `
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { collect } from '../scripts/ledger.mjs';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

it('measures the real repo', () => {
  expect(collect(REPO_ROOT).missing).toEqual([]);
});
`,
    });

    const { code, out } = run(root);
    expect(code).toBe(1);
    expect(out).toContain('.orchestrator/metrics/sessions.jsonl');
  });

  it('resolveUntrackedOracle survives a ../ spec and an exotic blob in the same batch', () => {
    // Both poisoners are real: the `../` form is the measured one, the JSON blob
    // appeared while measuring this check against the live corpus (a fixture
    // literal that merely happened to contain a slash) and degraded the whole
    // oracle to ls-files-only.
    const blob = '[{"number":63,"title":"enhancement: degrade gracefully"}]/.gitignore';
    const { untracked, error } = resolveUntrackedOracle(REPO_ROOT, [
      '../escape/x.txt',
      blob,
      '.orchestrator/metrics/sessions.jsonl',
      'package.json',
    ]);
    expect(error).toBe(null);
    expect(untracked.has('.orchestrator/metrics/sessions.jsonl')).toBe(true);
    expect(untracked.has('package.json')).toBe(false);
  });

  it('normalizeCandidate rejects the specs git refuses, before they reach the batch', () => {
    expect(normalizeCandidate('../outside/thing.txt')).toBe(null);
    expect(normalizeCandidate('/etc/passwd')).toBe(null);
    expect(normalizeCandidate('[{"n":1}]/x')).toBe(null);
    expect(normalizeCandidate(`${'a'.repeat(400)}/b`)).toBe(null);
    // …and keeps the ones that ARE repo-relative paths.
    expect(normalizeCandidate('./.orchestrator/metrics/sessions.jsonl'))
      .toBe('.orchestrator/metrics/sessions.jsonl');
    expect(normalizeCandidate('docs/prd')).toBe('docs/prd');
    // A single bare segment is a filename against an unknown base, never a
    // repo-relative path — accepting it made `node_modules` a finding.
    expect(normalizeCandidate('node_modules')).toBe(null);
    expect(normalizeCandidate('package.json')).toBe(null);
  });
});

describe('ignore marker', () => {
  it('exempts exactly the line that carries it', () => {
    const withMarker = (marker) => makeRepo({
      '.gitignore': GITIGNORE,
      'tests/store.test.mjs': `
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const p = '.orchestrator/metrics/sessions.jsonl';
let lines;
try {
  lines = readFileSync(p, 'utf8').split('\\n').filter(Boolean);${marker}
} catch {
  lines = [];
}

it('validates every historical entry', () => {
  expect(Array.isArray(lines)).toBe(true);
});
`,
      '.orchestrator/metrics/sessions.jsonl': '{"session":"x"}\n',
    });

    // Same fixture, marker absent → red. This pairing is what proves the marker
    // suppresses a finding rather than the fixture never having produced one.
    expect(run(withMarker('')).code).toBe(1);
    expect(run(withMarker(' // check-untracked-test-deps:ignore')).code).toBe(0);
  });
});

describe('false-positive regression over the live corpus', () => {
  it('flags almost none of the R3 candidate corpus (a loosening to R3 would flag all of it)', () => {
    // R3 — "the test contains a bare untracked path literal" — was measured at
    // 48 hits / 1 TP / 47 FP. The corpus is derived MECHANICALLY here rather
    // than hand-listed, so it tracks the repo instead of rotting: any future
    // relaxation of R2/R4 towards R3 turns this ratio from ~0 into ~1.
    const testFiles = [];
    const walk = (dir) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, ent.name);
        if (ent.isDirectory()) walk(abs);
        else if (abs.endsWith('.test.mjs')) testFiles.push(abs);
      }
    };
    walk(join(REPO_ROOT, 'tests'));

    const perFile = new Map();
    const allCandidates = [];
    for (const f of testFiles) {
      const src = readFileSync(f, 'utf8');
      const cands = extractLiteralCandidates(src, maskSource(src)).map((c) => c.candidate);
      perFile.set(f, cands);
      allCandidates.push(...cands);
    }
    const { untracked } = resolveUntrackedOracle(REPO_ROOT, allCandidates);
    const corpus = testFiles.filter((f) => perFile.get(f).some((c) => untracked.has(c)));

    // Floor, never a pinned count (`testing.md` § Dynamic Artifact Counts). A
    // vacuous corpus would make the ratio assertion below meaningless.
    expect(corpus.length).toBeGreaterThanOrEqual(20);

    const { findings } = scanUntrackedTestDeps(REPO_ROOT);
    const flagged = new Set(findings.map((f) => f.file));
    const flaggedInCorpus = corpus.filter((f) => flagged.has(f));

    // Under R3 this would be corpus.length; under R2+R4 it is a small handful.
    expect(flaggedInCorpus.length * 4).toBeLessThan(corpus.length);
  });
});

describe('validate-plugin output contract', () => {
  it('emits PASS/FAIL with exactly two leading spaces and a Results tally', () => {
    // `runCheck()` in scripts/validate-plugin.mjs counts `/^[ ]{2}(PASS|FAIL):/gm`
    // and strips `/^Results: /`. A drifted prefix here does not fail loudly — it
    // silently tallies zero, which is the failure mode this pins.
    const root = makeRepo({
      '.gitignore': GITIGNORE,
      'tests/store.test.mjs': `
import { readFileSync } from 'node:fs';
const p = '.orchestrator/metrics/sessions.jsonl';
const raw = readFileSync(p, 'utf8');
export { raw };
`,
      '.orchestrator/metrics/sessions.jsonl': '{"session":"x"}\n',
    });
    const { code, out } = run(root);
    expect(code).toBe(1);
    expect(out.match(/^ {2}FAIL: /gm)?.length).toBe(1);
    expect(out).toMatch(/^Results: \d+ passed, \d+ failed$/m);

    const clean = makeRepo({ '.gitignore': GITIGNORE, 'tests/noop.test.mjs': 'export const x = 1;\n' });
    const ok = run(clean);
    expect(ok.code).toBe(0);
    expect(ok.out.match(/^ {2}PASS: /gm)?.length).toBe(2);
  });

  it('exits 2 (tool error) outside a git repository, because the oracle needs git', () => {
    const bare = mkdtempSync(join(tmpdir(), 'untracked-test-deps-nogit-'));
    tmpDirs.push(bare);
    mkdirSync(join(bare, 'tests'), { recursive: true });
    writeFileSync(join(bare, 'tests', 'a.test.mjs'), 'export const x = 1;\n');
    const { code, out } = run(bare);
    expect(code).toBe(2);
    expect(out).toContain('not a git repository');
  });
});

describe('this repo, named', () => {
  it('reports every finding against the live tree by name', () => {
    // The bug this catches, and it is not hypothetical — it happened while
    // building this check: judging DIRECTORY candidates by "absent from
    // git ls-files" condemns `.git` (present in every clone by construction)
    // and every directory whose tracked children sit one level deeper. That
    // variant produced 31 findings across 8 test files. Both assertions below
    // go red on any such widening; neither can pass vacuously in that
    // direction. `relative()` keeps it portable (owner-leakage blocks absolute
    // home paths in tracked files).
    const { findings, error } = scanUntrackedTestDeps(REPO_ROOT);
    expect(error).toBe(null);
    const files = [...new Set(findings.map((f) => relative(REPO_ROOT, f.file)))].sort();
    // Every finding names a store file under .orchestrator/metrics/ — the only
    // untracked surface any test in this repo currently reaches.
    for (const f of findings) {
      expect(f.candidate).toMatch(/^\.orchestrator\/metrics\/.*\.jsonl$/);
    }
    // Bounded, not pinned: the two known accommodations may take the ignore
    // marker at any time, and a third genuine instance must be visible.
    expect(files.length).toBeLessThanOrEqual(3);
  });
});
