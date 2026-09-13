/**
 * tests/scripts/emit-session.test.mjs
 *
 * Vitest suite for scripts/emit-session.mjs — the validating writer for
 * session JSONL entries (Issue #249 follow-up). Exercises the CLI via
 * child_process so exit codes and stdout/stderr contracts are verified
 * end-to-end, not just the library surface.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

function runCli(args, stdin = null, options = {}) {
  const input = stdin ?? undefined;
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    input,
    encoding: 'utf8',
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
    expect(r.stderr).toBe('');
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
    expect(r.stderr).toBe('');
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
  function writeStateMd(profile, owner = 'main-2026-09-13-1') {
    const lines = ['---', `session: ${owner}`, 'session-type: deep'];
    if (profile !== null) lines.push(`session-profile: ${profile}`);
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
  it('omits session_profile when STATE.md belongs to a DIFFERENT session', () => {
    writeStateMd('ultradeep', 'main-2026-09-13-session-A');
    const entry = validEntry({ session_id: 'main-2026-09-13-session-B' });
    const r = runCli(['--file', targetFile, '--entry', JSON.stringify(entry)], null, {
      env: { SO_STATE_DIR: stateDir },
    });
    expect(r.status).toBe(0);
    const written = JSON.parse(readFileSync(targetFile, 'utf8').trim());
    expect('session_profile' in written).toBe(false);
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
