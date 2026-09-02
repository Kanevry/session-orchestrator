/**
 * tests/scripts/validate-wave-scope-disjoint.test.mjs
 *
 * Vitest suite for the two #1020 CLI modes of scripts/validate-wave-scope.mjs:
 * `--assert-disjoint <sidecar>` and `--union <sidecar>`.
 *
 * SCOPE BOUNDARY (TV-004): the collision SEMANTICS — the three stages, the
 * suffix-compatibility filter, the `<unnamed#i>` contract, fail-closed on a
 * non-array — are already pinned at the library level in
 * tests/lib/scope-gate-collisions.test.mjs and are NOT restated here. This file
 * tests only what the CLI layer owns and the library cannot see:
 *   - flag routing (a new flag swallowed by `--assert-subset`'s blind
 *     argv[i+1] consumption would silently never run)
 *   - exit-code taxonomy (0 valid / 1 validation finding / 2 I/O)
 *   - the sidecar's shape guard, which is STRICTER than the library's tolerance
 *   - `knownFiles` INJECTION — the library takes it as a parameter, so only a
 *     CLI test can prove `git ls-files` is actually spawned and fed in
 *   - the stdout contract (one JSON document per run, and which one)
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const SCRIPT = resolve(REPO_ROOT, 'scripts/validate-wave-scope.mjs');

/** A schema-valid manifest. `role` drives --union's test-sibling expansion. */
const MANIFEST = {
  wave: 3,
  role: 'Impl-Core',
  enforcement: 'warn',
  allowedPaths: ['scripts/**', 'tests/**'],
  blockedCommands: [],
};

/**
 * Run the validator with a sidecar written to a throwaway dir.
 * `cwd` is pinned to the repo root so the `git ls-files` injection resolves the
 * same tree on every host (portable — derived from import.meta.url, never a
 * hardcoded home path).
 */
function runWithSidecar(sidecar, argsFor, manifest = MANIFEST) {
  const dir = mkdtempSync(join(tmpdir(), 'vws-disjoint-'));
  const sidecarPath = join(dir, 'agent-scopes.json');
  writeFileSync(sidecarPath, JSON.stringify(sidecar));
  try {
    return spawnSync('node', [SCRIPT, ...argsFor(sidecarPath)], {
      input: JSON.stringify(manifest),
      encoding: 'utf8',
      cwd: REPO_ROOT,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const disjointArgs = (p) => ['--assert-disjoint', p];
const unionArgs = (p) => ['--union', p];

// ---------------------------------------------------------------------------
// --assert-disjoint — the finding
//
// BUG CAUGHT: a file handed to TWO agents of one wave has no pre-dispatch
// detector. --assert-subset checks each agent against the UNION, a subset
// relation both overlapping agents satisfy; the commit guard only ever sees the
// union too. #1020 Vorfall 3 surfaced afterwards, from an agent's own PSA-002
// report — the round ended well by luck, not construction.
// ---------------------------------------------------------------------------

// #1123: the validator warns on manifests without a session field; these fixtures
// predate the field. Strip exactly that one warning so byte-empty-stderr pins keep biting.
const stripSessionWarn = (s) => s.replace(/^WARNING: no session field — [^\n]*\n/m, '');

describe('validate-wave-scope.mjs — --assert-disjoint findings (#1020)', () => {
  it('exits 1 and names BOTH agent ids plus the witness file', () => {
    const r = runWithSidecar(
      [
        { id: 'W3-I1', files: ['scripts/a.mjs', 'tests/scripts/shared.test.mjs'] },
        { id: 'W3-I3', files: ['scripts/b.mjs', 'tests/scripts/shared.test.mjs'] },
      ],
      disjointArgs,
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/wave scope collision \(concrete\)/);
    expect(r.stderr).toMatch(/"W3-I1"/);
    expect(r.stderr).toMatch(/"W3-I3"/);
    expect(r.stderr).toMatch(/tests\/scripts\/shared\.test\.mjs/);
  });

  // THE most important negative test: a gate that fires on a clean wave is
  // worse than no gate, and any stray stderr byte on the success path breaks
  // the `expect(r.stderr).toBe('')` assertions the existing suite carries for
  // every other happy path of this script.
  it('exits 0 with EMPTY stderr for a disjoint wave plan', () => {
    const r = runWithSidecar(
      [
        { id: 'W3-I1', files: ['scripts/a.mjs'] },
        { id: 'W3-I3', files: ['scripts/b.mjs', 'tests/scripts/b.test.mjs'] },
      ],
      disjointArgs,
    );
    expect(r.status).toBe(0);
    expect(stripSessionWarn(r.stderr)).toBe('');
  });

  // BUG CAUGHT: findScopeCollisions returns ok:false for duplicate ids with an
  // EMPTY collisions array. A CLI that only printed `collisions` would exit 1
  // with no explanation at all; one that folded them into the collision list
  // would report an agent colliding with itself, which is noise. Two records
  // sharing an id also hide one agent's scope from every per-agent check.
  it('reports a duplicate agent id as its OWN finding, not as a collision', () => {
    const r = runWithSidecar(
      [
        { id: 'W3-I1', files: ['scripts/a.mjs'] },
        { id: 'W3-I1', files: ['scripts/b.mjs'] },
      ],
      disjointArgs,
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/duplicate agent id/);
    expect(r.stderr).toMatch(/"W3-I1"/);
    expect(r.stderr).not.toMatch(/wave scope collision/);
  });

  // BUG CAUGHT: requiring `id` in the CLI shape guard would REJECT exactly the
  // record scope-gate deliberately keeps — an unreviewed scope is the one that
  // collides (normalizeAgentScopes runs it as `<unnamed#i>` rather than
  // dropping it). A dropped record is a FALSE NEGATIVE: the wave reports clean.
  it('keeps an id-less record in the check under its synthetic id', () => {
    const r = runWithSidecar(
      [{ files: ['scripts/a.mjs'] }, { id: 'W3-I3', files: ['scripts/a.mjs'] }],
      disjointArgs,
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/<unnamed#0>/);
    expect(r.stderr).toMatch(/scripts\/a\.mjs/);
  });
});

// ---------------------------------------------------------------------------
// knownFiles injection
//
// BUG CAUGHT: scope-gate.mjs is hook-safe and MUST NOT spawn a process, so
// `knownFiles` arrives as a parameter — the CLI owns the `git ls-files` spawn.
// A CLI that forgot it (or passed [] ) still exits 0 on this input, because the
// library's stage-3b prefix fallback cannot settle this pair: neither glob is
// recursive, so ONLY a real tracked witness proves the intersection. Every
// library test injects knownFiles itself and is structurally blind to this.
// ---------------------------------------------------------------------------

describe('validate-wave-scope.mjs — --assert-disjoint knownFiles injection (#1020)', () => {
  it('detects a glob∩glob overlap witnessed only by a real tracked file', () => {
    // Both patterns match the tracked file scripts/lib/scope-gate.mjs; neither
    // is recursive (`**` / trailing `/`), so stage 3b is inert by construction.
    const r = runWithSidecar(
      [
        { id: 'W3-I1', files: ['scripts/lib/*.mjs'] },
        { id: 'W3-I3', files: ['scripts/*/scope-gate.mjs'] },
      ],
      disjointArgs,
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/wave scope collision \(glob-expanded\)/);
  });
});

// ---------------------------------------------------------------------------
// Sidecar I/O + shape guard
//
// BUG CAUGHT (recorded learning, conf 0.80 — "a reader that returns empty for a
// missing file cannot carry a CLI's absent-input guard"): unionFileScopes and
// findScopeCollisions are fail-closed and never throw. A mistyped sidecar path,
// an object map, or a `file:` typo would otherwise yield an empty agent list —
// "no agents, therefore no collisions, therefore exit 0" — on input the
// operator NAMED and the tool did not honour.
// ---------------------------------------------------------------------------

describe('validate-wave-scope.mjs — #1020 sidecar I/O and shape guard', () => {
  it.each([
    ['--assert-disjoint', disjointArgs],
    ['--union', unionArgs],
  ])('%s exits 2 when the sidecar path does not exist', (_flag, argsFor) => {
    const r = spawnSync('node', [SCRIPT, ...argsFor('/nonexistent/agent-scopes.json')], {
      input: JSON.stringify(MANIFEST),
      encoding: 'utf8',
      cwd: REPO_ROOT,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Cannot read --(assert-disjoint|union) file/);
  });

  it('exits 2 when the sidecar is a directory, not a regular file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vws-disjoint-dir-'));
    try {
      // statSync(dir).isFile() is false for EVERY uid (root and non-root
      // alike), so this stays an I/O error on the root CI container too.
      const r = spawnSync('node', [SCRIPT, '--assert-disjoint', dir], {
        input: JSON.stringify(MANIFEST),
        encoding: 'utf8',
        cwd: REPO_ROOT,
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/Cannot read --assert-disjoint file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 1 when the sidecar is not valid JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vws-disjoint-malformed-'));
    const p = join(dir, 'agent-scopes.json');
    writeFileSync(p, '[ { not valid');
    try {
      const r = spawnSync('node', [SCRIPT, '--assert-disjoint', p], {
        input: JSON.stringify(MANIFEST),
        encoding: 'utf8',
        cwd: REPO_ROOT,
      });
      expect(r.status).toBe(1);
      expect(stripSessionWarn(r.stderr)).toBe(`ERROR: --assert-disjoint file is not valid JSON: ${p}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The array form is load-bearing, not stylistic: an object keyed by agent id
  // CANNOT represent a duplicated id — JSON.parse keeps the last one — so the
  // duplicate finding above would be structurally unreachable.
  it('exits 1 with its own message when the sidecar is an object map, not an array', () => {
    const r = runWithSidecar({ 'W3-I1': ['scripts/a.mjs'] }, disjointArgs);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/must be a JSON array of \{id, files\} records/);
    expect(r.stderr).toMatch(/swallow a duplicate agent id/);
  });

  it('exits 1 when a record is not an object', () => {
    const r = runWithSidecar([{ id: 'W3-I1', files: ['scripts/a.mjs'] }, 'scripts/b.mjs'], disjointArgs);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/entry #1 must be an object with a "files" array/);
  });

  // The silent-vanish case: `file:` instead of `files:`. normalizeAgentScopes
  // turns it into [] and the wave reports clean with a whole agent unchecked.
  it('exits 1 on a "files" key typo rather than silently dropping the scope', () => {
    const r = runWithSidecar(
      [
        { id: 'W3-I1', files: ['scripts/a.mjs'] },
        { id: 'W3-I3', file: ['scripts/a.mjs'] },
      ],
      disjointArgs,
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/entry #1 \("W3-I3"\) must have a "files" string array/);
  });

  it('exits 1 when files contains a non-string entry', () => {
    const r = runWithSidecar([{ id: 'W3-I1', files: ['scripts/a.mjs', 42] }], disjointArgs);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/must have a "files" string array/);
  });
});

// ---------------------------------------------------------------------------
// --union — the query mode
// ---------------------------------------------------------------------------

describe('validate-wave-scope.mjs — --union (#1020)', () => {
  const SCOPES = [
    { id: 'W3-I1', files: ['scripts/lib/alpha.mjs', 'tests/lib/alpha.test.mjs'] },
    { id: 'W3-I3', files: ['scripts/lib/beta.mjs', 'scripts/lib/alpha.mjs'] },
  ];

  // BUG CAUGHT: the union computed by hand next to the briefs is what #1020 is
  // about — five divergences in one session. A union that silently loses an
  // agent's entry, or re-orders them, produces a manifest whose diff no longer
  // matches the plan a human reads beside it.
  it('prints the deduplicated union in first-seen order on stdout, exit 0', () => {
    const r = runWithSidecar(SCOPES, unionArgs);
    expect(r.status).toBe(0);
    expect(stripSessionWarn(r.stderr)).toBe('');
    expect(JSON.parse(r.stdout).slice(0, 3)).toEqual([
      'scripts/lib/alpha.mjs',
      'tests/lib/alpha.test.mjs',
      'scripts/lib/beta.mjs',
    ]);
  });

  // BUG CAUGHT: reading the role from anywhere but the manifest (hardcoding it,
  // or passing `{ enabled: true }`) hands a Quality phase-1 simplification agent
  // write access to the test suite — the "delete a dead export, then edit the
  // test to match" failure mode the role gate exists to prevent.
  it('expands test siblings for role Impl-Core', () => {
    const r = runWithSidecar(SCOPES, unionArgs);
    expect(JSON.parse(r.stdout)).toContain('tests/**/beta*.test.mjs');
  });

  it('does NOT expand for role Quality — the role gate lives in the helper', () => {
    const r = runWithSidecar(SCOPES, unionArgs, { ...MANIFEST, role: 'Quality' });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([
      'scripts/lib/alpha.mjs',
      'tests/lib/alpha.test.mjs',
      'scripts/lib/beta.mjs',
    ]);
  });

  // BUG CAUGHT: mixing the manifest echo and the union on stdout breaks every
  // `JSON.parse(stdout)` caller — including this script's own existing suite
  // (tests/scripts/validate-wave-scope.test.mjs). --union is a QUERY mode: it
  // REPLACES the echo, so stdout carries exactly one JSON document.
  it('emits ONLY the union — the manifest echo is suppressed', () => {
    const r = runWithSidecar(SCOPES, unionArgs);
    const parsed = JSON.parse(r.stdout); // would throw on two concatenated docs
    expect(Array.isArray(parsed)).toBe(true);
    expect(r.stdout).not.toMatch(/"blockedCommands"/);
  });

  // BUG CAUGHT (#1195 follow-through, W4 architect HIGH-1): a `peer-session-*`
  // record unioned into `allowedPaths` GRANTS every agent of this wave write
  // access to the peer session's files — the exact inverse of what wave-loop.md
  // § 3.1a says the record means ("a territory NO agent of this wave may
  // write"). It also makes the peer branch of hooks/post-bash-write-verify.mjs
  // dead code, because that hook only ever sees paths OUTSIDE allowedPaths.
  it('EXCLUDES a peer-session record from the union (#1195)', () => {
    const r = runWithSidecar(
      [
        { id: 'W3-I1', files: ['scripts/lib/alpha.mjs'] },
        { id: 'peer-session-2026-09-02-x', files: ['scripts/lib/peer-owned.mjs', 'peer/**'] },
      ],
      unionArgs,
      { ...MANIFEST, role: 'Quality' }, // no test-sibling expansion — pin the exact array
    );
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(['scripts/lib/alpha.mjs']);
  });

  // BUG CAUGHT: excluding peer records in the wrong LAYER — inside the sidecar
  // reader, or in findScopeCollisions — would also hide a peer/agent path
  // collision, which § 3.1a argues is precisely the collision that must
  // surface. The exclusion belongs to the union alone.
  it('still FAILS --assert-disjoint when a peer record collides with an agent (#1195)', () => {
    const r = runWithSidecar(
      [
        { id: 'W3-I1', files: ['scripts/lib/alpha.mjs'] },
        { id: 'peer-session-2026-09-02-x', files: ['scripts/lib/alpha.mjs'] },
      ],
      disjointArgs,
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/wave scope collision/);
    expect(r.stderr).toContain('peer-session-2026-09-02-x');
  });

  // BUG CAUGHT: computing the union BEFORE the collision check would emit a
  // usable-looking allowedPaths array derived from a plan that double-assigns a
  // file — the caller writes it into the manifest and the defect is laundered
  // into the artefact that is supposed to prevent it.
  it('produces NOTHING on stdout when --assert-disjoint blocks in the same run', () => {
    const r = runWithSidecar(
      [
        { id: 'W3-I1', files: ['scripts/a.mjs'] },
        { id: 'W3-I3', files: ['scripts/a.mjs'] },
      ],
      (p) => ['--assert-disjoint', p, '--union', p],
    );
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/wave scope collision/);
  });
});

// ---------------------------------------------------------------------------
// R1 — flag parsing must not swallow a sibling flag
//
// BUG CAUGHT: `--assert-subset` consumes argv[i + 1] BLIND. A new flag routed
// through parseArgs' positional fallback would be read as the wave-scope.json
// path and its mode would never run — silently, with exit 0. That is the
// "built but not wired" class: the check exists, the flag is passed, nothing
// happens.
// ---------------------------------------------------------------------------

describe('validate-wave-scope.mjs — #1020 flag parsing (R1)', () => {
  /** Writes both sidecars and runs with the given argv order. */
  function runBoth(order, fileScope, agentScopes) {
    const dir = mkdtempSync(join(tmpdir(), 'vws-both-'));
    const fsPath = join(dir, 'agent-filescope.json');
    const asPath = join(dir, 'agent-scopes.json');
    writeFileSync(fsPath, JSON.stringify(fileScope));
    writeFileSync(asPath, JSON.stringify(agentScopes));
    const args =
      order === 'subset-first'
        ? ['--assert-subset', fsPath, '--assert-disjoint', asPath]
        : ['--assert-disjoint', asPath, '--assert-subset', fsPath];
    try {
      return spawnSync('node', [SCRIPT, ...args], {
        input: JSON.stringify(MANIFEST),
        encoding: 'utf8',
        cwd: REPO_ROOT,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const COLLIDING = [
    { id: 'W3-I1', files: ['scripts/a.mjs'] },
    { id: 'W3-I3', files: ['scripts/a.mjs'] },
  ];

  it.each(['subset-first', 'disjoint-first'])(
    'runs the collision check in argv order %s (a satisfied subset does not mask it)',
    (order) => {
      // fileScope ⊆ allowedPaths holds, so ONLY the collision check can fail.
      const r = runBoth(order, ['scripts/a.mjs'], COLLIDING);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/wave scope collision/);
      expect(r.stderr).not.toMatch(/agent fileScope not ⊆ allowedPaths/);
    },
  );

  // R2: the collision check runs AFTER --assert-subset, for the same reason
  // #970 runs after #796 — a manifest violating both keeps the older, pinned
  // subset message rather than reporting a different failure than it used to.
  it.each(['subset-first', 'disjoint-first'])(
    'keeps the #796 subset message first when BOTH are violated (order %s)',
    (order) => {
      const r = runBoth(order, ['docs/x.md'], COLLIDING);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/agent fileScope not ⊆ allowedPaths/);
      expect(r.stderr).not.toMatch(/wave scope collision/);
    },
  );

  it.each(['--assert-disjoint', '--union'])(
    '%s exits 1 with its own message when given no value',
    (flag) => {
      const r = spawnSync('node', [SCRIPT, flag], {
        input: JSON.stringify(MANIFEST),
        encoding: 'utf8',
        cwd: REPO_ROOT,
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toBe(`ERROR: ${flag} requires a file-path argument\n`);
    },
  );

  // The blind-consumption trap, refused rather than inherited: a flag in value
  // position means the operator forgot a path, and swallowing it would run
  // neither mode while exiting 0.
  it('refuses a flag in the value position instead of swallowing it', () => {
    const r = spawnSync('node', [SCRIPT, '--assert-disjoint', '--union', 'x.json'], {
      input: JSON.stringify(MANIFEST),
      encoding: 'utf8',
      cwd: REPO_ROOT,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toBe('ERROR: --assert-disjoint requires a file-path argument\n');
  });
});

// ---------------------------------------------------------------------------
// R3/R4 — the untouched path
//
// BUG CAUGHT: stdout is byte-identical passthrough today. Re-serialising it
// (JSON.stringify of the parsed object) would pass every `toMatchObject` and
// `JSON.parse` assertion in the existing suite while changing the bytes — and
// hooks/post-bash-write-verify.mjs fingerprints the union via scopeSignature(),
// so a reformatted manifest written back reads as tampering.
// ---------------------------------------------------------------------------

describe('validate-wave-scope.mjs — #1020 no-flag regression (R3/R4)', () => {
  it('echoes stdout byte-identically and writes nothing to stderr without the new flags', () => {
    const input = JSON.stringify(MANIFEST);
    const r = spawnSync('node', [SCRIPT], { input, encoding: 'utf8', cwd: REPO_ROOT });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${input}\n`);
    expect(stripSessionWarn(r.stderr)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// FAKE REGRESSION — #1020 Vorfall 3, at the CLI boundary
//
// The library-level fake regression (tests/lib/scope-gate-collisions.test.mjs)
// proves findScopeCollisions returns ok:false. This one proves the CLI is
// actually WIRED to it: same incident assignment, exit 1 with a named witness;
// same wave with the file assigned once, exit 0. A library that reports the
// collision behind a CLI that never calls it is the "built but not wired" bug.
// ---------------------------------------------------------------------------

describe('validate-wave-scope.mjs — fake regression on #1020 Vorfall 3', () => {
  // The real double-assignment: tests/scripts/sweep-expired-learnings-cli.test.mjs
  // handed to two agents of the same W3 wave in session
  // feat-memory-pipeline-1015-1014-1016-2026-08-11-deep-1. It was caught only
  // afterwards, by an agent's own PSA-002 report.
  const INCIDENT_FILE = 'tests/scripts/sweep-expired-learnings-cli.test.mjs';

  it('goes RED on the incident assignment', () => {
    const r = runWithSidecar(
      [
        { id: 'W3-I1', files: ['scripts/sweep-expired-learnings.mjs', INCIDENT_FILE] },
        { id: 'W3-I3', files: ['scripts/lib/learnings/prune.mjs', INCIDENT_FILE] },
      ],
      disjointArgs,
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(INCIDENT_FILE);
    expect(r.stderr).toMatch(/wave scope collision \(concrete\)/);
  });

  it('goes GREEN once the file belongs to exactly one agent', () => {
    const r = runWithSidecar(
      [
        { id: 'W3-I1', files: ['scripts/sweep-expired-learnings.mjs', INCIDENT_FILE] },
        { id: 'W3-I3', files: ['scripts/lib/learnings/prune.mjs'] },
      ],
      disjointArgs,
    );
    expect(r.status).toBe(0);
    expect(stripSessionWarn(r.stderr)).toBe('');
  });
});
