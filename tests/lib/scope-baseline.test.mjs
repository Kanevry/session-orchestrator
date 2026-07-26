/**
 * tests/lib/scope-baseline.test.mjs
 *
 * Unit-test suite for scripts/lib/scope-baseline.mjs — the Scope Governor
 * baseline-freeze + drift-tripwire module (issue #899, S6 of Epic #894).
 *
 * Three exports under test: `writeBaseline()`, `readBaseline()`, and
 * `computeDrift()` (the S2 2x-tripwire, issue #896).
 *
 * The FIRST test below is the one this suite exists to guard: an
 * exactly-on-plan session MUST read `filesRatio === 1.0`. Three PRD
 * revisions shipped a tripwire that was green and blunt — reading 0.67
 * (only the numerator filtered) and 1.2 (plan-verification.md:45 applied
 * literally, excluding all of `.claude/`). See the module's own docstring
 * for the full rationale behind `DRIFT_EXCLUDE_PATTERNS`'s deliberate
 * narrowing of that exclusion.
 *
 * All fixtures live under `os.tmpdir()` mkdtemp roots, tracked in
 * `tmpRoots` and removed in `afterEach`. This suite NEVER exercises the
 * live repo's `.claude/STATE.md` — every STATE.md fixture below carries
 * ONLY the canonical `session` key (never `session-id`), so a wrong
 * implementation that read `session-id` instead of `session` would fail
 * the staleness-detection tests here (it would not against this repo's own
 * live STATE.md, which happens to carry both keys with identical values).
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  writeBaseline,
  readBaseline,
  computeDrift,
  countPlannedFiles,
  filterPlannedFiles,
} from '@lib/scope-baseline.mjs';
import { parseStateMd, serializeStateMd } from '@lib/state-md.mjs';
import { STATE_LOCK_PATH } from '@lib/locks/state-md-lock.mjs';
import { unwritablePath } from '../_helpers/unwritable-path.mjs';

/**
 * The S6-epic seven-file change set (#899 fixture, reused verbatim by the
 * #894 review-fix F1 tests below): two of these are test files, excluded by
 * `DRIFT_EXCLUDE_PATTERNS` on BOTH sides of the ratio; the remaining five
 * (including a `.claude/rules/**` deliverable, deliberately NOT excluded —
 * see the module's `DRIFT_EXCLUDE_PATTERNS` doc comment) survive filtering.
 */
const SEVEN_FILE_CHANGE_SET = [
  'scripts/lib/scope-baseline.mjs',
  '.claude/rules/receiving-review.md',
  'skills/wave-executor/wave-loop.md',
  'skills/session-end/plan-verification.md',
  'skills/session-start/SKILL.md',
  'tests/lib/scope-baseline.test.mjs',
  'tests/rules/receiving-review.test.mjs',
];

// ─── Fixtures & helpers ──────────────────────────────────────────────────

const tmpRoots = [];

/** Plain tmp dir — no git. Used by writeBaseline()/readBaseline() tests. */
function makeTmpDir() {
  const root = mkdtempSync(join(tmpdir(), 'scope-baseline-'));
  tmpRoots.push(root);
  return root;
}

/** Tmp dir + local git identity. Used by computeDrift() tests. */
function makeTmpRepo() {
  const root = makeTmpDir();
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'scope-baseline-test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Scope Baseline Test'], { cwd: root });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
  return root;
}

function statePathFor(root) {
  return join(root, '.claude', 'STATE.md');
}

/** Writes `content` directly to `<root>/.claude/STATE.md`, creating the directory first. */
function seedState(root, content) {
  const statePath = statePathFor(root);
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, content, { encoding: 'utf8' });
  return statePath;
}

/** Replaces the standalone `session: ...` line (never `scope-baseline-session`) via an anchored regex. */
function setSessionField(statePath, newSession) {
  const raw = readFileSync(statePath, 'utf8');
  const updated = raw.replace(/^session: .*$/m, `session: ${newSession}`);
  writeFileSync(statePath, updated, 'utf8');
  return updated;
}

/** Writes each relPath (creating parent dirs) and commits them all in one commit. */
function writeFilesAndCommit(root, relPaths, message) {
  for (const rel of relPaths) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `content for ${rel}\n`, 'utf8');
  }
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: root });
}

/** Seeds README.md as an initial commit and returns its SHA. */
function initialCommit(root) {
  writeFileSync(join(root, 'README.md'), '# tmp\n', 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: root });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}

/** N distinct real filenames under src/ — genuine per-file drift, not a token diff. */
function makeNFileNames(prefix, n) {
  const names = [];
  for (let i = 0; i < n; i++) {
    names.push(`src/${prefix}-${String(i).padStart(3, '0')}.mjs`);
  }
  return names;
}

/** A matching (non-stale) STATE.md fixture with an explicit session-start-ref. */
function driftStateFixture({ session, baselineSession, sessionStartRef, plannedFiles, branch = 'main' }) {
  return [
    '---',
    'schema-version: 1',
    `session: ${session}`,
    `branch: ${branch}`,
    `session-start-ref: ${sessionStartRef}`,
    'status: active',
    'updated: 2026-07-25T10:00:00Z',
    'scope-baseline-intent: S6-scope-freeze',
    'scope-baseline-owner-boundary: scripts/lib/scope-baseline.mjs',
    `scope-baseline-planned-files: ${plannedFiles}`,
    `scope-baseline-session: ${baselineSession}`,
    'scope-baseline-frozen-at: 2026-07-25T10:05:00.000Z',
    '---',
    '',
    '## Body',
    '',
  ].join('\n');
}

/**
 * A STATE.md fixture carrying `session` + `session-start-ref` but NO
 * `scope-baseline-*` keys at all — the pre-freeze state `writeBaseline()`
 * expects to write INTO. Used by the #894 review-fix F1 true end-to-end
 * test, which freezes via `writeBaseline()` itself rather than hand-writing
 * `scope-baseline-planned-files` into the fixture the way `driftStateFixture`
 * above does.
 */
function preBaselineStateFixture({ session, sessionStartRef, branch = 'main' }) {
  return [
    '---',
    'schema-version: 1',
    `session: ${session}`,
    `branch: ${branch}`,
    `session-start-ref: ${sessionStartRef}`,
    'status: active',
    'updated: 2026-07-25T10:00:00Z',
    '---',
    '',
    '## Body',
    '',
  ].join('\n');
}

/** Same as driftStateFixture but with NO session-start-ref key at all (fallback-path fixture). */
function driftStateFixtureNoRef({ session, baselineSession, plannedFiles, branch = 'main' }) {
  return [
    '---',
    'schema-version: 1',
    `session: ${session}`,
    `branch: ${branch}`,
    'status: active',
    'updated: 2026-07-25T10:00:00Z',
    'scope-baseline-intent: S6-scope-freeze',
    'scope-baseline-owner-boundary: scripts/lib/scope-baseline.mjs',
    `scope-baseline-planned-files: ${plannedFiles}`,
    `scope-baseline-session: ${baselineSession}`,
    'scope-baseline-frozen-at: 2026-07-25T10:05:00.000Z',
    '---',
    '',
    '## Body',
    '',
  ].join('\n');
}

const FIXTURE_WITH_SESSION_A = `---
schema-version: 1
session: session-A
branch: feature/scope-governor
session-start-ref: abc1234
status: active
updated: 2026-07-25T10:00:00Z
---

## Body
`;

const FIXTURE_NO_SESSION = `---
schema-version: 1
branch: feature/scope-governor
status: active
updated: 2026-07-25T10:00:00Z
---

## Body
`;

const FIXTURE_MALFORMED = `---
  bad-indent: oops
---

## Body
`;

afterEach(() => {
  while (tmpRoots.length > 0) {
    const root = tmpRoots.pop();
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── writeBaseline() ───────────────────────────────────────────────────────

describe('writeBaseline()', () => {
  it('a fresh freeze writes exactly the five scope-baseline-* keys, leaving branch/session-start-ref unduplicated and all other keys untouched', async () => {
    const root = makeTmpDir();
    const statePath = seedState(root, FIXTURE_WITH_SESSION_A);

    const result = await writeBaseline({
      repoRoot: root,
      intent: 'S6-scope-freeze',
      ownerBoundary: 'scripts/lib/scope-baseline.mjs',
      plannedFiles: makeNFileNames('pf', 5),
    });
    expect(result).toEqual({ written: true });

    const raw = readFileSync(statePath, 'utf8');
    const parsed = parseStateMd(raw);
    const fm = parsed.frontmatter;
    const frozenAt = fm['scope-baseline-frozen-at'];
    const { 'scope-baseline-frozen-at': _omitted, ...rest } = fm;

    expect(rest).toEqual({
      'schema-version': 1,
      session: 'session-A',
      branch: 'feature/scope-governor',
      'session-start-ref': 'abc1234',
      status: 'active',
      updated: '2026-07-25T10:00:00Z',
      'scope-baseline-intent': 'S6-scope-freeze',
      'scope-baseline-owner-boundary': 'scripts/lib/scope-baseline.mjs',
      'scope-baseline-planned-files': 5,
      'scope-baseline-session': 'session-A',
    });
    expect(typeof frozenAt).toBe('string');

    const branchLines = raw.split('\n').filter((line) => line.startsWith('branch:'));
    expect(branchLines).toHaveLength(1);
    const refLines = raw.split('\n').filter((line) => line.startsWith('session-start-ref:'));
    expect(refLines).toHaveLength(1);
  });

  it('scope-baseline-frozen-at is a parseable ISO-8601 timestamp', async () => {
    const root = makeTmpDir();
    const statePath = seedState(root, FIXTURE_WITH_SESSION_A);
    await writeBaseline({ repoRoot: root, intent: 'I1', ownerBoundary: 'O1', plannedFiles: makeNFileNames('pf', 3) });

    const fm = parseStateMd(readFileSync(statePath, 'utf8')).frontmatter;
    const frozenAt = fm['scope-baseline-frozen-at'];

    expect(Number.isNaN(Date.parse(frozenAt))).toBe(false);
    expect(frozenAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('a second call for the same session is rejected as already-frozen, with no mutation', async () => {
    const root = makeTmpDir();
    const statePath = seedState(root, FIXTURE_WITH_SESSION_A);
    const first = await writeBaseline({ repoRoot: root, intent: 'I1', ownerBoundary: 'O1', plannedFiles: makeNFileNames('pf', 3) });
    expect(first).toEqual({ written: true });
    const afterFirst = readFileSync(statePath, 'utf8');

    const second = await writeBaseline({ repoRoot: root, intent: 'I2-different', ownerBoundary: 'O2-different', plannedFiles: makeNFileNames('pf2', 9) });

    expect(second).toEqual({ written: false, reason: 'already-frozen' });
    expect(readFileSync(statePath, 'utf8')).toBe(afterFirst);
  });

  it('a stale baseline (different session) is fully overwritten', async () => {
    const root = makeTmpDir();
    const statePath = seedState(root, FIXTURE_WITH_SESSION_A);
    await writeBaseline({ repoRoot: root, intent: 'I1', ownerBoundary: 'O1', plannedFiles: makeNFileNames('pf', 3) });
    setSessionField(statePath, 'session-B');

    const second = await writeBaseline({ repoRoot: root, intent: 'I2', ownerBoundary: 'O2', plannedFiles: makeNFileNames('pf2', 7) });

    expect(second).toEqual({ written: true });
    const fm = parseStateMd(readFileSync(statePath, 'utf8')).frontmatter;
    expect(fm['scope-baseline-session']).toBe('session-B');
    expect(fm['scope-baseline-intent']).toBe('I2');
    expect(fm['scope-baseline-owner-boundary']).toBe('O2');
    expect(fm['scope-baseline-planned-files']).toBe(7);
  });

  it('freezes with scope-baseline-session: null when STATE.md has no session field', async () => {
    const root = makeTmpDir();
    const statePath = seedState(root, FIXTURE_NO_SESSION);

    const result = await writeBaseline({ repoRoot: root, intent: 'I1', ownerBoundary: 'O1', plannedFiles: makeNFileNames('pf', 4) });

    expect(result).toEqual({ written: true });
    const fm = parseStateMd(readFileSync(statePath, 'utf8')).frontmatter;
    expect(fm['scope-baseline-session']).toBe(null);
  });

  it('a second call with session STILL absent matches (both sides null) and is rejected as already-frozen, not treated as stale', async () => {
    const root = makeTmpDir();
    seedState(root, FIXTURE_NO_SESSION);
    const first = await writeBaseline({ repoRoot: root, intent: 'I1', ownerBoundary: 'O1', plannedFiles: makeNFileNames('pf', 4) });
    expect(first).toEqual({ written: true });

    const second = await writeBaseline({ repoRoot: root, intent: 'I2', ownerBoundary: 'O2', plannedFiles: makeNFileNames('pf2', 8) });

    expect(second).toEqual({ written: false, reason: 'already-frozen' });
  });

  // ── #894 review finding F1 — the denominator must be filtered IN CODE ──
  it('given the RAW seven-file union as plannedFiles, filters it internally and freezes scope-baseline-planned-files: 5 (two test files excluded by code, not by the caller)', async () => {
    const root = makeTmpDir();
    const statePath = seedState(root, FIXTURE_WITH_SESSION_A);

    const result = await writeBaseline({
      repoRoot: root,
      intent: 'S6-scope-freeze',
      ownerBoundary: 'scripts/lib/scope-baseline.mjs',
      plannedFiles: SEVEN_FILE_CHANGE_SET,
    });

    expect(result).toEqual({ written: true });
    const fm = parseStateMd(readFileSync(statePath, 'utf8')).frontmatter;
    expect(fm['scope-baseline-planned-files']).toBe(5);
  });

  it(
    'a held STATE.md lock times out → {written:false, reason:"lock-timeout"}, no exception, STATE.md unchanged',
    { timeout: 20000 },
    async () => {
      const root = makeTmpDir();
      const statePath = seedState(root, FIXTURE_WITH_SESSION_A);

      // Hold the lock externally with our OWN pid so isPidAliveOnHost() sees
      // it as live (never stale-overridden) — forces the full poll-to-deadline path.
      mkdirSync(join(root, '.orchestrator'), { recursive: true });
      writeFileSync(
        join(root, STATE_LOCK_PATH),
        JSON.stringify(
          { pid: process.pid, host: hostname(), acquiredAt: new Date().toISOString(), holder: 'external-test-holder' },
          null,
          2
        ) + '\n',
        'utf8'
      );

      await expect(
        writeBaseline({ repoRoot: root, intent: 'I1', ownerBoundary: 'O1', plannedFiles: makeNFileNames('pf', 3) })
      ).resolves.toEqual({ written: false, reason: 'lock-timeout' });

      expect(readFileSync(statePath, 'utf8')).toBe(FIXTURE_WITH_SESSION_A);
    }
  );

  // ── #894 review finding F4 — honest error-reason mapping ──────────────
  it('an fs-error acquiring the lock (unwritable lock directory) → {written:false, reason:"lock-fs-error"}, NOT "lock-timeout"', async () => {
    // unwritablePath() yields a path whose creation fails FAST with ENOTDIR
    // for every uid (root and non-root alike) — see tests/_helpers/unwritable-path.mjs.
    // acquireStateLock()'s mkdirSync(dir, {recursive:true}) for the
    // .orchestrator/state.lock directory fails immediately with this reason,
    // BEFORE writeBaseline()'s transformer ever runs — so this exercises the
    // acquire-failure branch of the F4 mapping, distinct from the
    // held-lock-poll-to-deadline branch above.
    const root = unwritablePath('scope-baseline-fs-error');

    const result = await writeBaseline({ repoRoot: root, intent: 'I1', ownerBoundary: 'O1', plannedFiles: makeNFileNames('pf', 3) });

    expect(result).toEqual({ written: false, reason: 'lock-fs-error' });
  });

  // ── #903 — the back-compat plain-number call shape is REMOVED ──────────
  // (issue #903: the number path was an unverified re-entry vector for the
  // exact F1 filter-bypass bug — a caller could hand `writeBaseline()` an
  // already-counted, possibly UNFILTERED number, stored verbatim with no
  // `filterExcluded()` pass at all). `plannedFiles` now MUST be an array;
  // anything else is rejected UP FRONT, before STATE.md is even read or the
  // lock is taken — no exception, no half-written state.
  it('a bare number for plannedFiles (the removed #903 back-compat call shape) is rejected up front → {written:false, reason:"invalid-planned-files"}, STATE.md untouched', async () => {
    const root = makeTmpDir();
    const statePath = seedState(root, FIXTURE_WITH_SESSION_A);

    const result = await writeBaseline({
      repoRoot: root,
      intent: 'I1',
      ownerBoundary: 'O1',
      plannedFiles: SEVEN_FILE_CHANGE_SET.length, // 7 — the exact pre-#903 call shape
    });

    expect(result).toEqual({ written: false, reason: 'invalid-planned-files' });
    expect(readFileSync(statePath, 'utf8')).toBe(FIXTURE_WITH_SESSION_A);
  });

  it('any other non-array plannedFiles (string) is rejected the same way → {written:false, reason:"invalid-planned-files"}, STATE.md untouched', async () => {
    const root = makeTmpDir();
    const statePath = seedState(root, FIXTURE_WITH_SESSION_A);

    const result = await writeBaseline({ repoRoot: root, intent: 'I1', ownerBoundary: 'O1', plannedFiles: 'not-a-valid-type' });

    expect(result).toEqual({ written: false, reason: 'invalid-planned-files' });
    expect(readFileSync(statePath, 'utf8')).toBe(FIXTURE_WITH_SESSION_A);
  });

  // The F1 filter-safety proof (denominator filtered through the SAME
  // `filterExcluded()` primitive the numerator uses) continues to live in
  // the "E2E (#894 F1)" `computeDrift()` test below — it already
  // demonstrates an UNFILTERED raw array (`SEVEN_FILE_CHANGE_SET`, 2
  // excludable test files included) resolving to `filesRatio === 1.0`, not
  // 0.71. Not duplicated here — see testing.md's "Duplication" checklist.

  it('no STATE.md on disk → {written:false, reason:"no-state-md"}', async () => {
    const root = makeTmpDir();

    const result = await writeBaseline({ repoRoot: root, intent: 'I1', ownerBoundary: 'O1', plannedFiles: makeNFileNames('pf', 3) });

    expect(result).toEqual({ written: false, reason: 'no-state-md' });
  });

  it('malformed STATE.md frontmatter → {written:false, reason:"unreadable-state-md"}, file untouched', async () => {
    const root = makeTmpDir();
    const statePath = seedState(root, FIXTURE_MALFORMED);

    const result = await writeBaseline({ repoRoot: root, intent: 'I1', ownerBoundary: 'O1', plannedFiles: makeNFileNames('pf', 3) });

    expect(result).toEqual({ written: false, reason: 'unreadable-state-md' });
    expect(readFileSync(statePath, 'utf8')).toBe(FIXTURE_MALFORMED);
  });
});

// ─── readBaseline() ─────────────────────────────────────────────────────

describe('readBaseline()', () => {
  it('returns null when no baseline has ever been frozen', () => {
    const root = makeTmpDir();
    seedState(root, FIXTURE_WITH_SESSION_A);

    expect(readBaseline(root)).toBe(null);
  });

  it('returns {stale:true, baselineSession, currentSession} (not null) when the baseline belongs to a different session', async () => {
    const root = makeTmpDir();
    const statePath = seedState(root, FIXTURE_WITH_SESSION_A);
    await writeBaseline({ repoRoot: root, intent: 'I1', ownerBoundary: 'O1', plannedFiles: makeNFileNames('pf', 5) });
    setSessionField(statePath, 'session-B');

    const result = readBaseline(root);

    expect(result).toEqual({ stale: true, baselineSession: 'session-A', currentSession: 'session-B' });
  });

  it('returns the full baseline object with all seven fields on a fresh (matching-session) baseline', async () => {
    const root = makeTmpDir();
    seedState(root, FIXTURE_WITH_SESSION_A);
    await writeBaseline({
      repoRoot: root,
      intent: 'S6-scope-freeze',
      ownerBoundary: 'scripts/lib/scope-baseline.mjs',
      plannedFiles: makeNFileNames('pf', 5),
    });

    const baseline = readBaseline(root);

    expect(baseline).toEqual({
      intent: 'S6-scope-freeze',
      ownerBoundary: 'scripts/lib/scope-baseline.mjs',
      plannedFiles: 5,
      session: 'session-A',
      frozenAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      branch: 'feature/scope-governor',
      sessionStartRef: 'abc1234',
    });
  });
});

// ─── countPlannedFiles() / filterPlannedFiles() ─────────────────────────
// (#894 review finding F1 — the exported denominator-filtering primitive)

describe('countPlannedFiles() / filterPlannedFiles()', () => {
  it('filters the seven-file union down to the five non-test deliverables', () => {
    expect(countPlannedFiles(SEVEN_FILE_CHANGE_SET)).toBe(5);
    expect(filterPlannedFiles(SEVEN_FILE_CHANGE_SET)).toEqual([
      'scripts/lib/scope-baseline.mjs',
      '.claude/rules/receiving-review.md',
      'skills/wave-executor/wave-loop.md',
      'skills/session-end/plan-verification.md',
      'skills/session-start/SKILL.md',
    ]);
  });

  it('an empty array filters to an empty array / count 0', () => {
    expect(countPlannedFiles([])).toBe(0);
    expect(filterPlannedFiles([])).toEqual([]);
  });
});

// ─── computeDrift() ─────────────────────────────────────────────────────

describe('computeDrift()', () => {
  // ── THE test that must be written first (per issue #899) ──────────────
  it('an exactly-on-plan session (5 counted deliverables / 5 planned) reads filesRatio === 1.0', () => {
    const root = makeTmpRepo();
    const sha = initialCommit(root);
    writeFilesAndCommit(root, SEVEN_FILE_CHANGE_SET, 'S6 epic seven-file change set');
    seedState(root, driftStateFixture({ session: 'session-A', baselineSession: 'session-A', sessionStartRef: sha, plannedFiles: 5 }));

    const result = computeDrift({ repoRoot: root });

    expect(result).toEqual({
      ok: true,
      skipped: false,
      filesRatio: 1,
      plannedFiles: 5,
      actualFiles: 5,
      breached: false,
      threshold: 2.0,
      refUsed: sha,
    });
  });

  // ── #894 review finding F1 — a TRUE end-to-end path where NEITHER side's
  // count is hand-written into the fixture. The test above hardcodes
  // `plannedFiles: 5` directly into the STATE.md fixture via
  // `driftStateFixture()` — it could never catch an unfiltered denominator,
  // because the denominator never runs through any code path in that test.
  // This one freezes via `writeBaseline()` itself, passing the RAW file
  // array, so the "5" the assertion checks is produced by
  // `countPlannedFiles()` (the denominator) exactly as `filterExcluded()`
  // (the numerator) produces its own "5" from the live git diff — same
  // helper, two call sites, one number.
  it('E2E (#894 F1): writeBaseline() given the RAW file array, then computeDrift() against a matching real diff, reads filesRatio === 1.0', async () => {
    const root = makeTmpRepo();
    const sha = initialCommit(root);
    writeFilesAndCommit(root, SEVEN_FILE_CHANGE_SET, 'S6 epic seven-file change set');
    seedState(root, preBaselineStateFixture({ session: 'session-A', sessionStartRef: sha }));

    const writeResult = await writeBaseline({
      repoRoot: root,
      intent: 'S6-scope-freeze',
      ownerBoundary: 'scripts/lib/scope-baseline.mjs',
      plannedFiles: SEVEN_FILE_CHANGE_SET,
    });
    expect(writeResult).toEqual({ written: true });

    const result = computeDrift({ repoRoot: root });

    expect(result).toEqual({
      ok: true,
      skipped: false,
      filesRatio: 1,
      plannedFiles: 5,
      actualFiles: 5,
      breached: false,
      threshold: 2.0,
      refUsed: sha,
    });
  });

  // FAKE-REGRESSION (#894 F1): simulates the PRE-FIX bug directly — freezing
  // the RAW, unfiltered file count (7, `SEVEN_FILE_CHANGE_SET.length`)
  // instead of routing it through `countPlannedFiles()`. Proves the fix
  // actually changes behaviour: an unfiltered denominator reads filesRatio
  // 0.71 (5 filtered actual / 7 unfiltered planned), not the correct 1.0.
  // Discriminates the E2E test above from a no-op "fix" that never actually
  // filters.
  it('FAKE-REGRESSION (#894 F1): an unfiltered planned-files count (7, not 5) reads filesRatio 0.71 — proves the denominator fix is load-bearing', () => {
    const root = makeTmpRepo();
    const sha = initialCommit(root);
    writeFilesAndCommit(root, SEVEN_FILE_CHANGE_SET, 'S6 epic seven-file change set');
    seedState(
      root,
      driftStateFixture({
        session: 'session-A',
        baselineSession: 'session-A',
        sessionStartRef: sha,
        plannedFiles: SEVEN_FILE_CHANGE_SET.length,
      })
    );

    const result = computeDrift({ repoRoot: root });

    expect(result.actualFiles).toBe(5);
    expect(result.plannedFiles).toBe(7);
    expect(result.filesRatio).toBe(0.71);
  });

  it('negative control: 19 changed files against plannedFiles: 10 reads filesRatio 1.9, not breached', () => {
    const root = makeTmpRepo();
    const sha = initialCommit(root);
    writeFilesAndCommit(root, makeNFileNames('nc', 19), 'negative control drift');
    seedState(root, driftStateFixture({ session: 'session-A', baselineSession: 'session-A', sessionStartRef: sha, plannedFiles: 10 }));

    const result = computeDrift({ repoRoot: root });

    expect(result.filesRatio).toBe(1.9);
    expect(result.breached).toBe(false);
  });

  // FAKE-REGRESSION (#899): a guard that only ever reports breached:false
  // would pass the 1.0 test AND the negative-control test above too. This
  // fixture drives REAL drift — 21 genuinely distinct committed files, not
  // a plannedFiles:1 trick — past the 2x threshold and must read breached:true.
  it('FAKE-REGRESSION (#899): 21 changed files against plannedFiles: 10 (ratio 2.1) reads breached: true', () => {
    const root = makeTmpRepo();
    const sha = initialCommit(root);
    writeFilesAndCommit(root, makeNFileNames('fr', 21), 'genuine drift past threshold');
    seedState(root, driftStateFixture({ session: 'session-A', baselineSession: 'session-A', sessionStartRef: sha, plannedFiles: 10 }));

    const result = computeDrift({ repoRoot: root });

    expect(result.actualFiles).toBe(21);
    expect(result.filesRatio).toBe(2.1);
    expect(result.breached).toBe(true);
  });

  it('filesRatio exactly 2.0 is breached (>= threshold, not >)', () => {
    const root = makeTmpRepo();
    const sha = initialCommit(root);
    writeFilesAndCommit(root, makeNFileNames('bd', 20), 'exactly-double drift');
    seedState(root, driftStateFixture({ session: 'session-A', baselineSession: 'session-A', sessionStartRef: sha, plannedFiles: 10 }));

    const result = computeDrift({ repoRoot: root });

    expect(result.filesRatio).toBe(2);
    expect(result.breached).toBe(true);
  });

  it('a diff of only test/lock/generated files reads filesRatio === 0', () => {
    const root = makeTmpRepo();
    const sha = initialCommit(root);
    writeFilesAndCommit(root, ['foo.test.mjs', 'bar.spec.ts', 'package-lock.json', 'dist/build.js'], 'excluded-only drift');
    seedState(root, driftStateFixture({ session: 'session-A', baselineSession: 'session-A', sessionStartRef: sha, plannedFiles: 3 }));

    const result = computeDrift({ repoRoot: root });

    expect(result.actualFiles).toBe(0);
    expect(result.filesRatio).toBe(0);
  });

  // FAKE-REGRESSION (#899): plan-verification.md:45's per-session-state
  // exclusion, applied LITERALLY, would exclude the ENTIRE .claude/
  // directory — silently zeroing a rule-file deliverable out of the
  // numerator. DRIFT_EXCLUDE_PATTERNS deliberately narrows the exclusion to
  // session-ARTEFACT subpaths only, so .claude/rules/** changes stay
  // counted. Placed right after the exclusion green-path test above to
  // prove exclusion correctness cuts both ways.
  it('FAKE-REGRESSION (#899): computeDrift() counts .claude/rules/** changes instead of zeroing the whole .claude/ dir', () => {
    const root = makeTmpRepo();
    const sha = initialCommit(root);
    writeFilesAndCommit(root, ['.claude/rules/receiving-review.md', '.claude/rules/testing.md'], 'two rule deliverables');
    seedState(root, driftStateFixture({ session: 'session-A', baselineSession: 'session-A', sessionStartRef: sha, plannedFiles: 2 }));

    const result = computeDrift({ repoRoot: root });

    expect(result.actualFiles).toBe(2);
    expect(result.filesRatio).toBe(1);
  });

  it('no STATE.md → skipped with reason no-state-md', () => {
    const root = makeTmpRepo();
    initialCommit(root);

    const result = computeDrift({ repoRoot: root });

    expect(result).toEqual({ ok: true, skipped: true, reason: 'no-state-md' });
  });

  it('malformed STATE.md frontmatter → skipped with reason unreadable-state-md', () => {
    const root = makeTmpRepo();
    initialCommit(root);
    seedState(root, FIXTURE_MALFORMED);

    const result = computeDrift({ repoRoot: root });

    expect(result).toEqual({ ok: true, skipped: true, reason: 'unreadable-state-md' });
  });

  it('a STATE.md with no scope-baseline-session key → skipped with reason no-baseline, no filesRatio computed', () => {
    const root = makeTmpRepo();
    initialCommit(root);
    seedState(root, FIXTURE_WITH_SESSION_A);

    const result = computeDrift({ repoRoot: root });

    expect(result).toEqual({ ok: true, skipped: true, reason: 'no-baseline' });
  });

  it('a stale baseline (different session) → skipped with reason stale-baseline, no filesRatio computed', () => {
    const root = makeTmpRepo();
    initialCommit(root);
    seedState(
      root,
      driftStateFixture({ session: 'session-NEW', baselineSession: 'session-OLD', sessionStartRef: 'abc1234', plannedFiles: 3 })
    );

    const result = computeDrift({ repoRoot: root });

    expect(result).toEqual({ ok: true, skipped: true, reason: 'stale-baseline' });
  });

  it('an unresolvable session-start-ref (garbage SHA) → skipped with reason unresolvable-ref', () => {
    const root = makeTmpRepo();
    initialCommit(root);
    seedState(
      root,
      driftStateFixture({
        session: 'session-A',
        baselineSession: 'session-A',
        sessionStartRef: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        plannedFiles: 3,
      })
    );

    const result = computeDrift({ repoRoot: root });

    expect(result).toEqual({ ok: true, skipped: true, reason: 'unresolvable-ref' });
  });

  it('precedence: stale-baseline wins over unresolvable-ref when both conditions hold simultaneously', () => {
    const root = makeTmpRepo();
    initialCommit(root);
    seedState(
      root,
      driftStateFixture({
        session: 'session-NEW',
        baselineSession: 'session-OLD',
        sessionStartRef: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        plannedFiles: 3,
      })
    );

    const result = computeDrift({ repoRoot: root });

    expect(result).toEqual({ ok: true, skipped: true, reason: 'stale-baseline' });
  });

  it('missing session-start-ref falls back to origin/main...HEAD (not a skip); refUsed reports the fallback', () => {
    const root = makeTmpRepo();
    const sha = initialCommit(root);
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', sha], { cwd: root });
    writeFilesAndCommit(root, ['src/feature.mjs', 'src/helper.mjs'], 'work');
    seedState(root, driftStateFixtureNoRef({ session: 'session-A', baselineSession: 'session-A', plannedFiles: 2 }));

    const result = computeDrift({ repoRoot: root });

    expect(result.skipped).toBe(false);
    expect(result.refUsed).toBe('origin/main...HEAD');
    expect(result.actualFiles).toBe(2);
    expect(result.filesRatio).toBe(1);
  });

  it('never throws even when repoRoot is not a git repository at all', () => {
    const root = makeTmpDir();
    seedState(
      root,
      driftStateFixture({
        session: 'session-A',
        baselineSession: 'session-A',
        sessionStartRef: '0000000000000000000000000000000000000a',
        plannedFiles: 1,
      })
    );

    expect(() => computeDrift({ repoRoot: root })).not.toThrow();
    const result = computeDrift({ repoRoot: root });
    expect(result).toEqual({ ok: true, skipped: true, reason: 'unresolvable-ref' });
  });
});

// ─── Frontmatter round-trip (serialize ∘ parse fixpoint) ────────────────

describe('frontmatter round-trip', () => {
  it('the five scope-baseline-* keys are a serialize(parse(...)) byte fixpoint, and planned-files stays typed as number', async () => {
    const root = makeTmpDir();
    const statePath = seedState(root, FIXTURE_WITH_SESSION_A);
    await writeBaseline({
      repoRoot: root,
      intent: 'freeze-five-files',
      ownerBoundary: 'scripts/lib/scope-baseline.mjs',
      plannedFiles: makeNFileNames('pf', 5),
    });

    const raw1 = readFileSync(statePath, 'utf8');
    const parsed1 = parseStateMd(raw1);
    const reserialized1 = serializeStateMd(parsed1);
    const parsed2 = parseStateMd(reserialized1);
    const reserialized2 = serializeStateMd(parsed2);

    expect(reserialized2).toBe(reserialized1);
    expect(parsed2.frontmatter['scope-baseline-planned-files']).toBe(5);
    expect(typeof parsed2.frontmatter['scope-baseline-planned-files']).toBe('number');
  });

  it('an intent string containing a colon survives two round trips', async () => {
    const root = makeTmpDir();
    const statePath = seedState(root, FIXTURE_WITH_SESSION_A);
    await writeBaseline({
      repoRoot: root,
      intent: 'freeze scope: five deliverables',
      ownerBoundary: 'scripts/lib/scope-baseline.mjs',
      plannedFiles: makeNFileNames('pf', 5),
    });

    const parsed1 = parseStateMd(readFileSync(statePath, 'utf8'));
    expect(parsed1.frontmatter['scope-baseline-intent']).toBe('freeze scope: five deliverables');

    const reserialized1 = serializeStateMd(parsed1);
    const parsed2 = parseStateMd(reserialized1);
    const reserialized2 = serializeStateMd(parsed2);
    const parsed3 = parseStateMd(reserialized2);

    expect(parsed3.frontmatter['scope-baseline-intent']).toBe('freeze scope: five deliverables');
  });
});
