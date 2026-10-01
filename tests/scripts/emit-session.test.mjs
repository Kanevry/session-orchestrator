/**
 * tests/scripts/emit-session.test.mjs
 *
 * Vitest suite for scripts/emit-session.mjs — the validating writer for
 * session JSONL entries (Issue #249 follow-up). Exercises the CLI via
 * child_process so exit codes and stdout/stderr contracts are verified
 * end-to-end, not just the library surface.
 *
 * TRAP — the CLI reads the STATE.md under its OWN `process.cwd()`
 * (`emit-session.mjs` → `resolveStateMdPath(process.cwd())`, #1247). Spawning
 * it with the inherited cwd therefore pointed it at THIS repo's live
 * `.claude/STATE.md`: the suite was green only while that file happened to
 * carry no `session-profile:`, and went red the moment a real session wrote
 * one (`emit-session: WARN STATE.md session_profile=… belongs to session=…`
 * against `expect(r.stderr).toBe('')`). That is the live-repo pin
 * `.claude/rules/test-hygiene.md` § "A test that measures against the LIVE
 * repo pins its defect state" forbids. Every spawn therefore runs in
 * `HERMETIC_CWD` — an empty mkdtemp dir with no state directory at all —
 * unless a test passes its own `cwd`/`SO_STATE_DIR`.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializeSessionLineChecked } from '../../scripts/emit-session.mjs';
import { validateSession, ValidationError } from '../../scripts/lib/session-schema.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts', 'emit-session.mjs');

function validEntry(overrides = {}) {
  return {
    session_id: 'main-2026-04-24-1600',
    session_type: 'deep',
    started_at: '2026-04-24T16:00:00Z',
    completed_at: '2026-04-24T16:30:00Z',
    total_waves: 5,
    waves: [{ wave: 1, role: 'Discovery' }],
    agent_summary: { complete: 3, partial: 0, failed: 0, spiral: 0 },
    total_agents: 3,
    total_files_changed: 2,
    ...overrides,
  };
}

// An empty directory that contains none of `.claude` / `.codex` / `.cursor` /
// `.pi` (STATE_DIR_CANDIDATES), so the CLI's STATE.md probe finds nothing and
// derives no `session_profile` — see the TRAP note in the file docblock.
const HERMETIC_CWD = mkdtempSync(join(tmpdir(), 'emit-session-cwd-'));

afterAll(() => {
  rmSync(HERMETIC_CWD, { recursive: true, force: true });
});

function runCli(args, stdin = null, options = {}) {
  const input = stdin ?? undefined;
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    input,
    encoding: 'utf8',
    cwd: options.cwd ?? HERMETIC_CWD,
    env: options.env ? { ...process.env, ...options.env } : process.env,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe('emit-session.mjs CLI', () => {
  let tmp;
  let targetFile;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'emit-session-'));
    targetFile = join(tmp, 'sessions.jsonl');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('appends a valid entry and exits 0', () => {
    const entry = validEntry();
    const r = runCli(['--file', targetFile, '--entry', JSON.stringify(entry)]);
    expect(r.status).toBe(0);
    // No source supplies session_start_ref here, and that is said (#1457).
    expect(r.stderr).toBe('emit-session: WARN no session_start_ref — STATE.md carried none, no own session.started head_sha available\n');
    const contents = readFileSync(targetFile, 'utf8');
    const lines = contents.trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.session_id).toBe(entry.session_id);
    expect(parsed.schema_version).toBe(2);
  });

  it('stamps schema_version:2 on entries that omit it', () => {
    const entry = validEntry();
    delete entry.schema_version;
    runCli(['--file', targetFile, '--entry', JSON.stringify(entry)]);
    const parsed = JSON.parse(readFileSync(targetFile, 'utf8').trim());
    expect(parsed.schema_version).toBe(2);
  });

  it('emits a summary JSON line on stdout', () => {
    const entry = validEntry();
    const r = runCli(['--file', targetFile, '--entry', JSON.stringify(entry)]);
    const summary = JSON.parse(r.stdout.trim());
    expect(summary.action).toBe('appended');
    expect(summary.session_id).toBe(entry.session_id);
    expect(summary.schema_version).toBe(2);
    expect(summary.path).toBe(targetFile);
  });

  it('exits 1 on validation error and does NOT touch the file', () => {
    const entry = validEntry({ session_type: 'bogus' });
    const r = runCli(['--file', targetFile, '--entry', JSON.stringify(entry)]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/validation failed.*session_type/);
    expect(existsSync(targetFile)).toBe(false);
  });

  it('exits 1 on missing required field', () => {
    const entry = validEntry();
    delete entry.session_id;
    const r = runCli(['--file', targetFile, '--entry', JSON.stringify(entry)]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/session_id/);
    expect(existsSync(targetFile)).toBe(false);
  });

  it('exits 2 on non-JSON input', () => {
    const r = runCli(['--file', targetFile, '--entry', 'not-json{']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/not valid JSON/);
  });

  it('exits 2 on empty stdin and no --entry', () => {
    const r = runCli(['--file', targetFile], '');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/no entry provided/);
  });

  it('reads from stdin when --entry is omitted', () => {
    const entry = validEntry();
    const r = runCli(['--file', targetFile], JSON.stringify(entry));
    expect(r.status).toBe(0);
    const lines = readFileSync(targetFile, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).session_id).toBe(entry.session_id);
  });

  it('exits 2 on unknown argument', () => {
    const r = runCli(['--bogus', 'x'], JSON.stringify(validEntry()));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/unknown argument/);
  });

  it('appends multiple invocations atomically (line-per-call)', () => {
    runCli(['--file', targetFile, '--entry', JSON.stringify(validEntry({ session_id: 'a' }))]);
    runCli(['--file', targetFile, '--entry', JSON.stringify(validEntry({ session_id: 'b' }))]);
    runCli(['--file', targetFile, '--entry', JSON.stringify(validEntry({ session_id: 'c' }))]);
    const lines = readFileSync(targetFile, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).session_id).toBe('a');
    expect(JSON.parse(lines[1]).session_id).toBe('b');
    expect(JSON.parse(lines[2]).session_id).toBe('c');
  });

  it('creates parent directories if missing', () => {
    const deep = join(tmp, 'deep', 'nested', 'sessions.jsonl');
    const r = runCli(['--file', deep, '--entry', JSON.stringify(validEntry())]);
    expect(r.status).toBe(0);
    expect(existsSync(deep)).toBe(true);
    expect(statSync(deep).size).toBeGreaterThan(0);
  });

  it('--help exits 0 with usage text', () => {
    const r = runCli(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Usage: node scripts\/emit-session\.mjs/);
  });
});

// ---------------------------------------------------------------------------
// #321 — pre-validation repair integration (clamp + alias)
// ---------------------------------------------------------------------------

// #1390 P1 — the producer never normalized per-wave key aliases, so a record
// composed with `agents_completed` landed on disk without the canonical
// `agent_count_completed` every consumer except the vault renderer reads.
describe('emit-session.mjs CLI — #1390 per-wave alias at write time', () => {
  it('writes agent_count_completed for a wave that carries only agents_completed', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'emit-session-1390-'));
    try {
      const targetFile = join(tmp, 'sessions.jsonl');
      const entry = validEntry({ waves: [{ wave: 1, role: 'Impl', agents_completed: 3 }] });
      const r = runCli(['--file', targetFile, '--entry', JSON.stringify(entry)]);
      expect(r.status).toBe(0);
      const written = JSON.parse(readFileSync(targetFile, 'utf8').trim());
      expect(written.waves[0].agent_count_completed).toBe(3);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('emit-session.mjs CLI — #321 pre-validation repair', () => {
  let tmp;
  let targetFile;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'emit-session-321-'));
    targetFile = join(tmp, 'sessions.jsonl');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // #701.2 — completed_at < started_at inversion guard: clampTimestampsMonotonic sets
  // _clamped:true + _original_completed_at, and clamps completed_at to started_at.
  it('clamps inversion: exits 0 (clamped, not error) and writes appended record', () => {
    const entry = validEntry({
      session_id: 'inv-clamp-1',
      started_at: '2026-04-24T16:30:00Z',
      completed_at: '2026-04-24T16:00:00Z',
    });
    const r = runCli(['--file', targetFile, '--entry', JSON.stringify(entry)]);
    expect(r.status).toBe(0);
    expect(existsSync(targetFile)).toBe(true);
    const written = JSON.parse(readFileSync(targetFile, 'utf8').trim());
    expect(written._clamped).toBe(true);
    expect(written.completed_at).toBe('2026-04-24T16:30:00Z');
    expect(written._original_completed_at).toBe('2026-04-24T16:00:00Z');
  });

  it('clamps inversion: STDERR contains WARN session_id=... and clamped phrasing', () => {
    const entry = validEntry({
      session_id: 'inv-clamp-2',
      started_at: '2026-04-24T16:30:00Z',
      completed_at: '2026-04-24T16:00:00Z',
    });
    const r = runCli(['--file', targetFile, '--entry', JSON.stringify(entry)]);
    expect(r.stderr).toMatch(/WARN session_id=inv-clamp-2/);
    expect(r.stderr).toMatch(/clamped/);
  });

  it('clamps inversion: STDOUT remains a single parseable JSON line (no warn leakage)', () => {
    const entry = validEntry({
      session_id: 'inv-clamp-3',
      started_at: '2026-04-24T16:30:00Z',
      completed_at: '2026-04-24T16:00:00Z',
    });
    const r = runCli(['--file', targetFile, '--entry', JSON.stringify(entry)]);
    const stdoutLines = r.stdout.split('\n').filter((l) => l.length > 0);
    expect(stdoutLines).toHaveLength(1);
    const parsed = JSON.parse(stdoutLines[0]);
    expect(parsed.action).toBe('appended');
    expect(parsed.session_id).toBe('inv-clamp-3');
    // Sanity: STDOUT should not contain WARN markers
    expect(r.stdout).not.toMatch(/WARN/);
  });

  it('legacy ended_at only: exit 0, appended record carries completed_at', () => {
    const entry = validEntry();
    delete entry.completed_at;
    entry.ended_at = '2026-04-24T16:30:00Z';
    const r = runCli(['--file', targetFile, '--entry', JSON.stringify(entry)]);
    expect(r.status).toBe(0);
    const written = JSON.parse(readFileSync(targetFile, 'utf8').trim());
    expect(written.completed_at).toBe('2026-04-24T16:30:00Z');
    // ended_at preserved alongside aliased completed_at — not stripped by emit-session
    // (only duration_ms is dropped by aliasLegacyEndedAt; the canonical schema
    // does not reject extra ended_at as it is an unknown additive field).
    expect(written.ended_at).toBe('2026-04-24T16:30:00Z');
  });

  it('both completed_at + ended_at differing: STDERR mentions conflict, prefers completed_at', () => {
    const entry = validEntry({
      session_id: 'conflict-1',
      started_at: '2026-04-24T16:00:00Z',
      completed_at: '2026-04-24T16:30:00Z',
    });
    entry.ended_at = '2026-04-24T17:00:00Z';
    const r = runCli(['--file', targetFile, '--entry', JSON.stringify(entry)]);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/conflict/i);
    expect(r.stderr).toMatch(/preferring completed_at/);
    const written = JSON.parse(readFileSync(targetFile, 'utf8').trim());
    expect(written.completed_at).toBe('2026-04-24T16:30:00Z');
    expect(written._completed_at_conflict).toBe(true);
  });

  it('already-canonical input: no clamp/alias warns on STDERR', () => {
    const entry = validEntry();
    const r = runCli(['--file', targetFile, '--entry', JSON.stringify(entry)]);
    expect(r.status).toBe(0);
    // The only line is the missing-session_start_ref WARN (#1457), never a clamp/alias one.
    expect(r.stderr).toBe('emit-session: WARN no session_start_ref — STATE.md carried none, no own session.started head_sha available\n');
    const written = JSON.parse(readFileSync(targetFile, 'utf8').trim());
    expect(written._clamped).toBeUndefined();
    expect(written._completed_at_conflict).toBeUndefined();
    expect(written._original_completed_at).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// #662 — pre-write round-trip self-validation seam (serializeSessionLineChecked)
// ---------------------------------------------------------------------------

describe('emit-session.mjs — serializeSessionLineChecked (#662 round-trip seam)', () => {
  it('accepts a valid session and returns a newline-terminated JSONL line that round-trips', () => {
    const validated = validateSession(validEntry());
    const line = serializeSessionLineChecked(validated);
    expect(line.endsWith('\n')).toBe(true);
    const reparsed = JSON.parse(line);
    expect(reparsed.session_id).toBe('main-2026-04-24-1600');
    expect(reparsed.total_agents).toBe(3);
    expect(reparsed.agent_summary).toEqual({ complete: 3, partial: 0, failed: 0, spiral: 0 });
  });

  it('REJECTS a record whose required field is undefined (silently dropped by JSON.stringify)', () => {
    // total_agents: undefined survives validateSession-by-construction here
    // (we hand-build the post-validate object), but JSON.stringify drops the
    // key, so the round-tripped object is missing a required field. The seam
    // catches this BEFORE any append.
    const broken = { ...validateSession(validEntry()), total_agents: undefined };
    expect(() => serializeSessionLineChecked(broken)).toThrow(ValidationError);
    expect(() => serializeSessionLineChecked(broken)).toThrow(/total_agents/);
  });

  it('REJECTS a non-serializable record (circular reference)', () => {
    const broken = { ...validateSession(validEntry()) };
    broken.self = broken; // circular — JSON.stringify throws TypeError
    expect(() => serializeSessionLineChecked(broken)).toThrow(ValidationError);
    expect(() => serializeSessionLineChecked(broken)).toThrow(/not JSON-serializable/);
  });
});

describe('emit-session.mjs CLI — #662 round-trip seam (end-to-end, file untouched on reject)', () => {
  let tmp;
  let targetFile;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'emit-session-662-'));
    targetFile = join(tmp, 'sessions.jsonl');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('accepts a valid entry end-to-end (exit 0, line appended)', () => {
    const entry = validEntry({ session_id: 'rt-ok' });
    const r = runCli(['--file', targetFile, '--entry', JSON.stringify(entry)]);
    expect(r.status).toBe(0);
    const written = JSON.parse(readFileSync(targetFile, 'utf8').trim());
    expect(written.session_id).toBe('rt-ok');
  });
});

// ---------------------------------------------------------------------------
// #1247 — session_profile derivation from STATE.md when the entry omits it
// ---------------------------------------------------------------------------
//
// SO_STATE_DIR (scripts/lib/state-md/frontmatter-mutators.mjs
// resolveStateArtifactPath) accepts an ABSOLUTE override directory — resolved
// via path.resolve, which discards every segment before an absolute one — so
// these tests point it straight at a tmp dir's STATE.md without needing to
// chdir the spawned child or touch this repo's own real STATE.md.

describe('emit-session.mjs CLI — #1247 session_profile derivation', () => {
  let tmp;
  let targetFile;
  let stateDir;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'emit-session-1247-'));
    targetFile = join(tmp, 'sessions.jsonl');
    stateDir = join(tmp, 'state');
    mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // `owner` is the STATE.md frontmatter `session:` — the session that OWNS the
  // document, which is not necessarily the session a record describes.
  function writeStateMd(profile, owner = 'main-2026-09-13-1', startRef = null) {
    const lines = ['---', `session: ${owner}`, 'session-type: deep'];
    if (profile !== null) lines.push(`session-profile: ${profile}`);
    if (startRef !== null) lines.push(`session-start-ref: ${startRef}`);
    lines.push('---', '');
    writeFileSync(join(stateDir, 'STATE.md'), lines.join('\n'), 'utf8');
  }

  it('fills session_profile from STATE.md when the entry omits the key', () => {
    writeStateMd('ultradeep', 'profile-fill');
    const entry = validEntry({ session_id: 'profile-fill' });
    const r = runCli(['--file', targetFile, '--entry', JSON.stringify(entry)], null, {
      env: { SO_STATE_DIR: stateDir },
    });
    expect(r.status).toBe(0);
    const written = JSON.parse(readFileSync(targetFile, 'utf8').trim());
    expect(written.session_profile).toBe('ultradeep');
  });

  it('leaves session_profile absent (never null/empty-string) when STATE.md carries no profile', () => {
    writeStateMd(null, 'profile-absent');
    const entry = validEntry({ session_id: 'profile-absent' });
    const r = runCli(['--file', targetFile, '--entry', JSON.stringify(entry)], null, {
      env: { SO_STATE_DIR: stateDir },
    });
    expect(r.status).toBe(0);
    const written = JSON.parse(readFileSync(targetFile, 'utf8').trim());
    expect('session_profile' in written).toBe(false);
  });

  it('an explicit session_profile on the entry always wins over STATE.md', () => {
    writeStateMd('ultradeep', 'profile-explicit');
    const entry = validEntry({ session_id: 'profile-explicit', session_profile: 'deep' });
    const r = runCli(['--file', targetFile, '--entry', JSON.stringify(entry)], null, {
      env: { SO_STATE_DIR: stateDir },
    });
    expect(r.status).toBe(0);
    const written = JSON.parse(readFileSync(targetFile, 'utf8').trim());
    expect(written.session_profile).toBe('deep');
  });

  // Bug: the profile was taken from whatever STATE.md sat on disk, with no
  // ownership check. Two sessions share one working copy (or a foreign /plan
  // session left its STATE.md behind): session A is `ultradeep` and owns
  // STATE.md, session B is a plain `deep` and closes — B's record was stamped
  // `session_profile: "ultradeep"` and its waves filed under the ultradeep
  // sizing row. Exactly the cross-contamination #1247 exists to remove.
  // The start ref shares the ownership check: a refactor that adopts it
  // outside that check files session A's commit range under session B.
  it('omits session_profile and session_start_ref when STATE.md belongs to a DIFFERENT session', () => {
    writeStateMd('ultradeep', 'main-2026-09-13-session-A', '8f6ac02277d889413bed283f9ab6c747f841ac03');
    const entry = validEntry({ session_id: 'main-2026-09-13-session-B' });
    const r = runCli(['--file', targetFile, '--entry', JSON.stringify(entry)], null, {
      env: { SO_STATE_DIR: stateDir },
    });
    expect(r.status).toBe(0);
    const written = JSON.parse(readFileSync(targetFile, 'utf8').trim());
    expect('session_profile' in written).toBe(false);
    expect('session_start_ref' in written).toBe(false);
    expect(r.stderr).toContain('main-2026-09-13-session-A');
  });

  // Same bug, the unprovable-ownership half: a STATE.md with no `session:` key
  // names no owner, so adopting its profile would be a guess.
  it('omits session_profile when STATE.md names no owning session', () => {
    writeFileSync(
      join(stateDir, 'STATE.md'),
      ['---', 'session-type: deep', 'session-profile: ultradeep', '---', ''].join('\n'),
      'utf8'
    );
    const entry = validEntry({ session_id: 'no-owner' });
    const r = runCli(['--file', targetFile, '--entry', JSON.stringify(entry)], null, {
      env: { SO_STATE_DIR: stateDir },
    });
    expect(r.status).toBe(0);
    const written = JSON.parse(readFileSync(targetFile, 'utf8').trim());
    expect('session_profile' in written).toBe(false);
  });

  // #1339 P8 — bug: no producer copied STATE.md `session-start-ref` into the
  // record (4 of the last 25 real records carried it, all hand-composed), so
  // `/evolve analyze` fell back to a time window that attributes a parallel
  // session's commits to this one.
  //
  // Rows 2-3, bug: only a FULL hex sha makes a range — `HEAD` or a short sha
  // copied verbatim hands `/evolve analyze` a moving or ambiguous endpoint.
  // Rows 4-5, bug: an EXPLICIT key on the record (even `null`) must win —
  // overwriting it from STATE.md discards the coordinator's own assertion.
  it.each([
    ['a full sha: copied', '8f6ac02277d889413bed283f9ab6c747f841ac03', {}, true,
      '8f6ac02277d889413bed283f9ab6c747f841ac03', ''],
    ['HEAD: omitted with a WARN', 'HEAD', {}, false, undefined,
      'emit-session: WARN STATE.md session-start-ref=HEAD is not a full hex sha; omitting session_start_ref\n'
      + 'emit-session: WARN no session_start_ref — STATE.md ref discarded (not a full hex sha), '
      + 'no own session.started head_sha available\n'],
    ['an 8-hex short sha: omitted with a WARN', '8f6ac022', {}, false, undefined,
      'emit-session: WARN STATE.md session-start-ref=8f6ac022 is not a full hex sha; omitting session_start_ref\n'
      + 'emit-session: WARN no session_start_ref — STATE.md ref discarded (not a full hex sha), '
      + 'no own session.started head_sha available\n'],
    ['a full sha, but the entry carries its own sha: the entry wins', '8f6ac02277d889413bed283f9ab6c747f841ac03',
      { session_start_ref: 'a4e6d2550000000000000000000000000000beef' }, true,
      'a4e6d2550000000000000000000000000000beef', ''],
    ['a full sha, but the entry carries an explicit null: the null wins', '8f6ac02277d889413bed283f9ab6c747f841ac03',
      { session_start_ref: null }, true, null, ''],
  ])('STATE.md session-start-ref is %s', (_label, stateRef, entryOverrides, expectPresent, expectRef, expectStderr) => {
    writeFileSync(
      join(stateDir, 'STATE.md'),
      ['---', 'session: start-ref-fill', `session-start-ref: ${stateRef}`, '---', ''].join('\n'),
      'utf8'
    );
    const entry = validEntry({ session_id: 'start-ref-fill', ...entryOverrides });
    const r = runCli(['--file', targetFile, '--entry', JSON.stringify(entry)], null, {
      env: { SO_STATE_DIR: stateDir },
    });
    expect(r.status).toBe(0);
    const written = JSON.parse(readFileSync(targetFile, 'utf8').trim());
    expect('session_start_ref' in written).toBe(expectPresent);
    expect(written.session_start_ref).toBe(expectRef);
    expect(r.stderr).toBe(expectStderr);
  });

  // Bug: the readFileSync was guarded by existsSync only, so any read error
  // (EISDIR when STATE.md is a directory, EACCES, EPERM) escaped to the
  // top-level handler — emit-session exited 2 having appended NOTHING. An
  // OPTIONAL enrichment read decided whether sessions.jsonl got a line at all.
  it('still appends the record when STATE.md is unreadable (EISDIR)', () => {
    mkdirSync(join(stateDir, 'STATE.md'), { recursive: true });
    const entry = validEntry({ session_id: 'unreadable-state-md' });
    const r = runCli(['--file', targetFile, '--entry', JSON.stringify(entry)], null, {
      env: { SO_STATE_DIR: stateDir },
    });
    expect(r.status).toBe(0);
    expect(existsSync(targetFile)).toBe(true);
    const written = JSON.parse(readFileSync(targetFile, 'utf8').trim());
    expect(written.session_id).toBe('unreadable-state-md');
    expect('session_profile' in written).toBe(false);
  });
});

// #1436 / #1443 — the token rollup, raw_session_id and the session_start_ref
// events fallback are derived by the writer itself. Bug caught by the block as a
// whole: emit-session never read subagents.jsonl, so no session record carried
// a token total and the autopilot token budget had nothing to compare.
describe('emit-session.mjs CLI — #1436 token rollup, raw_session_id, start-ref fallback', () => {
  const U = '11111111-2222-4333-8444-555555555555';
  const SHA = 'a4e6d2550000000000000000000000000000beef';
  const SHA_B = 'c'.repeat(40);
  let tmp;
  let targetFile;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'emit-session-1436-'));
    targetFile = join(tmp, 'sessions.jsonl');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // Field set of a post-#949 schema_version 2 stop record (see
  // tests/lib/session-token-rollup.test.mjs stopRecord for the golden source).
  function stop(agent, input, output, parent = U) {
    return {
      timestamp: '2026-09-25T10:00:00.000Z',
      event: 'stop',
      agent_id: agent,
      schema_version: 2,
      agent_type: 'Explore',
      parent_session_id: parent,
      duration_ms: 1000,
      start_record_found: true,
      subagent_transcript_found: true,
      token_input: input,
      token_output: output,
      total_cost_usd: null,
    };
  }
  function writeJsonlIn(name, records) {
    writeFileSync(join(tmp, name), records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  }
  const readWritten = () => JSON.parse(readFileSync(targetFile, 'utf8').trim());
  // Blank the harness ids this suite may itself run under, so the
  // process-local witness is decided by the test, not by the host.
  const NO_NATIVE_ID = { CLAUDE_CODE_SESSION_ID: '', CODEX_THREAD_ID: '', SO_PLATFORM: '' };

  it('merges the own-UUID rollup (other sessions excluded) and stamps raw_session_id', () => {
    writeJsonlIn('subagents.jsonl', [stop('a1', 100, 200), stop('a2', 50, 60), stop('x', 9, 9, 'other-uuid')]);
    const r = runCli(['--file', targetFile, '--session-uuid', U, '--entry', JSON.stringify(validEntry())]);
    expect(r.status).toBe(0);
    const w = readWritten();
    expect(w.total_tokens).toBe(410);
    expect(w.total_token_input).toBe(150);
    expect(w.total_token_output).toBe(260);
    expect(w.matched_records).toBe(2);
    expect(w.subagents_with_tokens).toBe(2);
    expect(w.raw_session_id).toBe(U);
    // unknown model → null cost → omitted, never a fabricated 0
    expect('total_cost_usd' in w).toBe(false);
    // #1475 — the coverage counters say why: 0 of 2 records priced. Bug
    // caught: they stayed in the rollup's return value and never reached the
    // ledger, so an omitted cost could not be told from an unmeasured one.
    expect(w.cost_records_priced).toBe(0);
    expect(w.cost_records_total).toBe(2);
    // The rollup's diagnostics explain an omission; they never enter the ledger.
    expect('match_status' in w).toBe(false);
    expect('ledger_records' in w).toBe(false);
  });

  it('an explicit total_tokens on the entry wins and suppresses the merge', () => {
    writeJsonlIn('subagents.jsonl', [stop('a1', 100, 200)]);
    const entry = validEntry({ total_tokens: 7 });
    const r = runCli(['--file', targetFile, '--session-uuid', U, '--entry', JSON.stringify(entry)]);
    expect(r.status).toBe(0);
    const w = readWritten();
    expect(w.total_tokens).toBe(7);
    expect('matched_records' in w).toBe(false);
  });

  it('a missing subagents.jsonl omits every rollup key, WARNs, and still appends', () => {
    const r = runCli(['--file', targetFile, '--session-uuid', U, '--entry', JSON.stringify(validEntry())]);
    expect(r.status).toBe(0);
    const w = readWritten();
    for (const key of ['total_tokens', 'total_token_input', 'total_token_output', 'matched_records', 'subagents_with_tokens']) {
      expect(key in w).toBe(false);
    }
    expect(r.stderr).toContain(`token rollup found no subagents.jsonl records for ${U} (ledger absent)`);
  });

  it('a ledger with only foreign records reports the count and omits every rollup key', () => {
    writeJsonlIn('subagents.jsonl', [stop('x', 100, 200, 'other-uuid'), stop('y', 50, 60, 'other-uuid')]);
    const r = runCli(['--file', targetFile, '--session-uuid', U, '--entry', JSON.stringify(validEntry())]);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain(`2 subagents.jsonl record(s) present, none with parent_session_id=${U}`);
    expect(r.stderr).toContain('not attributable via this UUID, not zero cost');
    const w = readWritten();
    for (const key of [
      'total_tokens', 'total_token_input', 'total_token_output',
      'total_token_input_uncached', 'total_token_cache_read', 'total_token_cache_creation',
      'total_cost_usd', 'subagents_with_tokens', 'matched_records', '_token_schema',
      'cost_records_priced', 'cost_records_total',
      'match_status', 'ledger_records',
    ]) {
      expect(key in w).toBe(false);
    }
  });

  // Bug: one fractional token value in subagents.jsonl made the rollup's
  // total_tokens fractional; it was merged BEFORE validateSession(), which
  // requires an integer — exit 1, no line appended, /close aborted over an
  // optional enrichment.
  it('a fractional token value omits total_tokens with a WARN and still appends', () => {
    writeJsonlIn('subagents.jsonl', [stop('a1', 100.5, 200)]);
    const r = runCli(['--file', targetFile, '--session-uuid', U, '--entry', JSON.stringify(validEntry())]);
    expect(r.status).toBe(0);
    expect('total_tokens' in readWritten()).toBe(false);
    expect(r.stderr).toContain('emit-session: WARN token rollup produced an invalid field (total_tokens');
  });

  // Bug: with neither STATE.md nor an own session.started event supplying a
  // ref, session_start_ref was omitted silently — indistinguishable from a
  // record whose writer never looked.
  it('WARNs when no source supplies session_start_ref, and still appends', () => {
    const r = runCli(['--file', targetFile, '--session-uuid', U, '--entry', JSON.stringify(validEntry())]);
    expect(r.status).toBe(0);
    expect('session_start_ref' in readWritten()).toBe(false);
    expect(r.stderr).toContain(
      'emit-session: WARN no session_start_ref — STATE.md carried none, no own session.started head_sha available'
    );
  });

  // Bug (#1457 point 2): the WARN sat inside the own-UUID branch, so without
  // --session-uuid and without an owned current-session.json the ref was
  // omitted with no word at all.
  it('WARNs about the missing session_start_ref even without any own UUID', () => {
    const cwd = join(tmp, 'no-uuid-wc');
    mkdirSync(cwd, { recursive: true });
    const r = runCli(['--file', targetFile, '--entry', JSON.stringify(validEntry())], null, { cwd, env: NO_NATIVE_ID });
    expect(r.status).toBe(0);
    const w = readWritten();
    expect('session_start_ref' in w).toBe(false);
    expect('raw_session_id' in w).toBe(false);
    expect(r.stderr).toContain(
      'emit-session: WARN no session_start_ref — STATE.md carried none, no own session.started head_sha available'
    );
  });

  it('adopts the UUID from an OWNED current-session.json only — a foreign marker is WARNed', () => {
    writeJsonlIn('subagents.jsonl', [stop('a1', 1, 2)]);
    const cwd = join(tmp, 'wc');
    mkdirSync(join(cwd, '.orchestrator'), { recursive: true });
    const marker = join(cwd, '.orchestrator', 'current-session.json');

    writeFileSync(marker, JSON.stringify({ session_id: U, semantic_session_id: 'someone-else-session-1' }));
    const foreign = runCli(['--file', targetFile, '--entry', JSON.stringify(validEntry())], null, { cwd, env: NO_NATIVE_ID });
    expect(foreign.status).toBe(0);
    expect('raw_session_id' in readWritten()).toBe(false);
    expect(foreign.stderr).toContain('someone-else-session-1');

    rmSync(targetFile);
    writeFileSync(marker, JSON.stringify({ session_id: U, semantic_session_id: validEntry().session_id }));
    const owned = runCli(['--file', targetFile, '--entry', JSON.stringify(validEntry())], null, { cwd, env: NO_NATIVE_ID });
    expect(owned.status).toBe(0);
    const w = readWritten();
    expect(w.raw_session_id).toBe(U);
    expect(w.total_tokens).toBe(3);

    // A process-local id that is NOT the marker's outranks the matching label:
    // the marker was written by a peer that minted the same semantic id.
    rmSync(targetFile);
    const peer = runCli(['--file', targetFile, '--entry', JSON.stringify(validEntry())], null, {
      cwd,
      env: { ...NO_NATIVE_ID, SO_PLATFORM: 'claude', CLAUDE_CODE_SESSION_ID: '99999999-2222-4333-8444-555555555555' },
    });
    expect(peer.status).toBe(0);
    expect('raw_session_id' in readWritten()).toBe(false);
  });

  // Bugs caught, one per row: a scan that ignores the UUID takes a parallel
  // session's start sha; a tail-first (last-match-wins) scan takes the sha a
  // resume re-emitted under the same raw id instead of the session's real start;
  // a scan that skips an own start event lacking head_sha takes a later
  // compact/resume event's sha — the FIRST own event decides, sha or not; and
  // after an events.jsonl rotation the first SURVIVING own event can itself be
  // a compact re-emit, whose later sha must not pass as the start (#1457 p3).
  it.each([
    ['a foreign session.started precedes the own one', [
      { event: 'orchestrator.session.started', session_id: 'other-uuid', head_sha: 'b'.repeat(40) },
      { event: 'orchestrator.session.started', session_id: U, head_sha: SHA },
    ], SHA],
    ['a resume re-emitted the own session.started (first match wins)', [
      { event: 'orchestrator.session.started', session_id: U, head_sha: SHA },
      { event: 'orchestrator.session.started', session_id: U, head_sha: SHA_B },
    ], SHA],
    ['the first own session.started carries no head_sha (a later resume sha is not the start)', [
      { event: 'orchestrator.session.started', session_id: U },
      { event: 'orchestrator.session.started', session_id: U, head_sha: SHA_B },
    ], undefined],
    ['rotation left a compact re-emit as the first surviving own session.started', [
      { event: 'orchestrator.session.started', session_id: U, head_sha: SHA_B, native_source: 'compact' },
    ], undefined],
    ['rotation left a resume re-emit as the first surviving own session.started', [
      { event: 'orchestrator.session.started', session_id: U, head_sha: SHA_B, native_source: 'resume' },
    ], undefined],
  ])('derives session_start_ref from the FIRST own session.started when STATE.md carries none: %s', (_label, events, expected) => {
    writeJsonlIn('events.jsonl', events);
    const r = runCli(['--file', targetFile, '--session-uuid', U, '--entry', JSON.stringify(validEntry())]);
    expect(r.status).toBe(0);
    const w = readWritten();
    expect('session_start_ref' in w).toBe(expected !== undefined);
    expect(w.session_start_ref).toBe(expected);
  });

  it('drops an explicit short session_start_ref instead of writing an ambiguous ref (#1443)', () => {
    const entry = validEntry({ session_start_ref: 'ae452d33' });
    const r = runCli(['--file', targetFile, '--entry', JSON.stringify(entry)]);
    expect(r.status).toBe(0);
    expect('session_start_ref' in readWritten()).toBe(false);
    expect(r.stderr).toContain('session_start_ref=ae452d33 is not a full hex sha');
  });
});
