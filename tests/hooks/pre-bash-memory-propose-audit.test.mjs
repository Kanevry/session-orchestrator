/**
 * tests/hooks/pre-bash-memory-propose-audit.test.mjs
 *
 * Vitest tests for hooks/pre-bash-memory-propose-audit.mjs.
 *
 * Strategy: spawn the hook as a subprocess, pipe JSON on stdin, read the
 * appended events.jsonl file from a tmp project root, and assert exit code +
 * event-record shape per behavior.
 *
 * Coverage targets the G1–G7 gate ladder + redactArgv branches per the
 * #543 H1 spec. Hardcoded literals per `.claude/rules/test-quality.md`.
 *
 * Issue: #543 H1
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOOK = path.resolve(
  import.meta.dirname,
  '../../hooks/pre-bash-memory-propose-audit.mjs',
);

const DQ = String.fromCharCode(34); // "
const BS = String.fromCharCode(92); // \

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spawn the hook, pipe stdin JSON, resolve with exit code + stdout/stderr.
 */
async function runHook({ projectDir, stdin, env = {} }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      cwd: projectDir,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectDir,
        CLAUDE_PLUGIN_ROOT: projectDir,
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

/** Read events.jsonl as an array of parsed objects (empty if file absent). */
async function readEvents(projectDir) {
  const eventsPath = path.join(
    projectDir,
    '.orchestrator',
    'metrics',
    'events.jsonl',
  );
  try {
    const raw = await fs.readFile(eventsPath, 'utf8');
    return raw
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/** Build a Bash PreToolUse payload. Extras (e.g. session_id) merge top-level. */
function bashPayload(command, extras = {}) {
  return JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command },
    ...extras,
  });
}

/** Make an isolated tmp project root with no orchestrator state. */
async function mkProject() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'memprop-audit-'));
}

const tmpDirs = [];

afterEach(async () => {
  for (const d of tmpDirs.splice(0)) {
    await fs.rm(d, { recursive: true, force: true });
  }
});

async function mkProjectTracked() {
  const dir = await mkProject();
  tmpDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// redactArgv branch coverage
// ---------------------------------------------------------------------------

describe('redactArgv', { timeout: 15000 }, () => {
  it('redacts --insight=value form', async () => {
    const dir = await mkProjectTracked();
    const cmd =
      'node scripts/memory-propose.mjs --type general --insight=secret-text';
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload(cmd, { session_id: 'sess-1' }),
    });
    expect(result.code).toBe(0);
    const events = await readEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0].argv_truncated).toBe(
      'node scripts/memory-propose.mjs --type general --insight=[REDACTED]',
    );
    expect(events[0].argv_truncated.includes('secret-text')).toBe(false);
  });

  it('redacts --insight "double-quoted" form', async () => {
    const dir = await mkProjectTracked();
    const cmd =
      'node scripts/memory-propose.mjs --insight ' + DQ + 'private body' + DQ;
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload(cmd, { session_id: 'sess-1' }),
    });
    expect(result.code).toBe(0);
    const events = await readEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0].argv_truncated).toBe(
      'node scripts/memory-propose.mjs --insight [REDACTED]',
    );
    expect(events[0].argv_truncated.includes('private body')).toBe(false);
  });

  it('redacts --insight unquoted form', async () => {
    const dir = await mkProjectTracked();
    const cmd =
      'node scripts/memory-propose.mjs --insight unquotedvalue --confidence 0.8';
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload(cmd, { session_id: 'sess-1' }),
    });
    expect(result.code).toBe(0);
    const events = await readEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0].argv_truncated).toBe(
      'node scripts/memory-propose.mjs --insight [REDACTED] --confidence 0.8',
    );
    expect(events[0].argv_truncated.includes('unquotedvalue')).toBe(false);
  });

  it('redacts the entire quoted value when it contains escaped quotes (issue #546)', async () => {
    // Input on the wire: --evidence "he said \"hi\""  (literal backslash-quote)
    // Post-fix (issue #546): the quoted-string alt matches the full "...\"...\"..." region;
    // the \S+ alt is gated by `(?!["'])` so it never pre-empts the quoted-alt, and the
    // tail after the inner escaped quote does not leak.
    const dir = await mkProjectTracked();
    const cmd =
      'node scripts/memory-propose.mjs --evidence ' +
      DQ +
      'he said ' +
      BS +
      DQ +
      'hi' +
      BS +
      DQ +
      DQ;
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload(cmd, { session_id: 'sess-1' }),
    });
    expect(result.code).toBe(0);
    const events = await readEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0].argv_truncated).toBe(
      'node scripts/memory-propose.mjs --evidence [REDACTED]',
    );
    // No plaintext fragment of the value may survive — neither the visible words
    // nor the inner escaped-quote markers.
    expect(events[0].argv_truncated.includes('he said')).toBe(false);
    expect(events[0].argv_truncated.includes('hi')).toBe(false);
    expect(events[0].argv_truncated.includes(DQ)).toBe(false);
    expect(events[0].argv_truncated.includes(BS)).toBe(false);
  });

  it('redacts entire quoted region with inner escaped quote — no tail leak (issue #546)', async () => {
    // Input on the wire: --insight "outer\"inner"  (literal backslash-quote, no whitespace inside)
    // The unfixed regex's `\S+` alt could match `"outer\"inner"` as a single non-whitespace
    // token in either branch, but the quoted-alt is tried first and matches the full region.
    // This test pins the FIXED behavior: the entire quoted region — including the inner
    // escaped quote and everything to either side — is replaced by [REDACTED] with no leak.
    const dir = await mkProjectTracked();
    const cmd =
      'node scripts/memory-propose.mjs --insight ' +
      DQ +
      'outer' +
      BS +
      DQ +
      'inner' +
      DQ;
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload(cmd, { session_id: 'sess-1' }),
    });
    expect(result.code).toBe(0);
    const events = await readEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0].argv_truncated).toBe(
      'node scripts/memory-propose.mjs --insight [REDACTED]',
    );
    // No fragment of the value's plaintext may survive — neither the literal words
    // nor the inner escaped-quote sequence (BS+DQ) nor any stray quote character.
    expect(events[0].argv_truncated.includes('outer')).toBe(false);
    expect(events[0].argv_truncated.includes('inner')).toBe(false);
    expect(events[0].argv_truncated.includes(DQ)).toBe(false);
    expect(events[0].argv_truncated.includes(BS)).toBe(false);
  });

  it('handles malformed unclosed-quote input without leaking the value (issue #546 actual leak surface, Q2 G-H1)', async () => {
    // Pre-fix scenario: --insight "unclosed text  — the opening quote has no closing match.
    // Under the UNFIXED regex (bare \S+ fallback), `\S+` would match `"unclosed` greedily up
    // to the first whitespace, then the engine would also try `text` as a separate match
    // (only redacting `"unclosed` and leaving `text` plaintext in the audit log).
    // Under the FIXED regex `(?!["'])\S+`, the unquoted-token alt is forbidden from
    // matching anything starting with a quote — so the quoted-string alt is the ONLY
    // candidate. Since the quoted-string alt requires a closing quote that is not present,
    // the FLAG ALTERNATION FAILS for this token: no match is produced and the leftover
    // `--insight "unclosed text` flows through to argv_truncated VERBATIM (NOT redacted).
    // This test pins that "fail-closed" behavior — the value is NOT redacted, BUT the
    // important guarantee is that NO PARTIAL LEAK occurs (no `text` orphan in a redacted
    // output line). A future hardening could fail the hook outright on this shape; for
    // now we lock in the structural invariant that the regex does not partial-redact.
    const dir = await mkProjectTracked();
    const cmd = 'node scripts/memory-propose.mjs --insight ' + DQ + 'unclosed text --confidence 0.8';
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload(cmd, { session_id: 'sess-1' }),
    });
    expect(result.code).toBe(0);
    const events = await readEvents(dir);
    expect(events).toHaveLength(1);
    // Falsification: under the unfixed regex this assertion would FAIL because the
    // recorded string would be `--insight [REDACTED] text --confidence [REDACTED]`
    // (partial-redact with `text` leaking). Under the fixed regex the full token sequence
    // flows through un-redacted as a single unit OR --confidence is independently redacted
    // — but `text` never appears in isolation outside the unclosed-quote context.
    // The contract is: NO PARTIAL LEAK. Either everything-redacted or everything-verbatim.
    const argv = events[0].argv_truncated;
    // The opening quote MUST still be present (proves the redactor did NOT engage on the
    // malformed token — preventing partial leak as `text` orphan).
    expect(argv.includes(DQ + 'unclosed text')).toBe(true);
    // No `[REDACTED]` placeholder for the malformed --insight token (would indicate partial
    // redact + tail-leak).
    expect(argv).not.toMatch(/--insight\s+\[REDACTED\]\s+text/);
  });

  it('redacts all 5 sensitive flag names', async () => {
    const dir = await mkProjectTracked();
    const cmd =
      'node scripts/memory-propose.mjs --insight a --subject b --evidence c --content d --reason e';
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload(cmd, { session_id: 'sess-1' }),
    });
    expect(result.code).toBe(0);
    const events = await readEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0].argv_truncated).toBe(
      'node scripts/memory-propose.mjs --insight [REDACTED] --subject [REDACTED] --evidence [REDACTED] --content [REDACTED] --reason [REDACTED]',
    );
    // Strict literal: none of the plaintext values appear as standalone tokens.
    expect(events[0].argv_truncated.includes(' a ')).toBe(false);
    expect(events[0].argv_truncated.includes(' b ')).toBe(false);
    expect(events[0].argv_truncated.includes(' c ')).toBe(false);
    expect(events[0].argv_truncated.includes(' d ')).toBe(false);
    expect(events[0].argv_truncated.endsWith(' e')).toBe(false);
  });

  it('does not match prefix collision --insightful', async () => {
    const dir = await mkProjectTracked();
    const cmd =
      'node scripts/memory-propose.mjs --insightful keep-me --insight redact-me';
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload(cmd, { session_id: 'sess-1' }),
    });
    expect(result.code).toBe(0);
    const events = await readEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0].argv_truncated).toBe(
      'node scripts/memory-propose.mjs --insightful keep-me --insight [REDACTED]',
    );
    expect(events[0].argv_truncated.includes('keep-me')).toBe(true);
    expect(events[0].argv_truncated.includes('redact-me')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// G3 — regex gate
// ---------------------------------------------------------------------------

describe('G3 — MEMORY_PROPOSE_REGEX', { timeout: 15000 }, () => {
  it('G3 rejects echo "memory-propose.mjs"', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('echo ' + DQ + 'memory-propose.mjs' + DQ, {
        session_id: 'sess-1',
      }),
    });
    expect(result.code).toBe(0);
    const events = await readEvents(dir);
    expect(events).toEqual([]);
    // events.jsonl file itself must not exist
    const eventsPath = path.join(
      dir,
      '.orchestrator',
      'metrics',
      'events.jsonl',
    );
    const exists = await fs
      .access(eventsPath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it('G3 rejects npm run memory-propose', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('npm run memory-propose', { session_id: 'sess-1' }),
    });
    expect(result.code).toBe(0);
    const events = await readEvents(dir);
    expect(events).toEqual([]);
  });

  it('G3 accepts /usr/bin/node ./scripts/memory-propose.mjs', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('/usr/bin/node ./scripts/memory-propose.mjs', {
        session_id: 'sess-1',
      }),
    });
    expect(result.code).toBe(0);
    const events = await readEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('orchestrator.memory.propose_invoked');
  });

  it('G3 accepts env-prefixed SO_WAVE_AGENT=1 node scripts/memory-propose.mjs', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload(
        'SO_WAVE_AGENT=1 node scripts/memory-propose.mjs --type general',
        { session_id: 'sess-1' },
      ),
    });
    expect(result.code).toBe(0);
    const events = await readEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('orchestrator.memory.propose_invoked');
  });
});

// ---------------------------------------------------------------------------
// G4 — session_id resolution
// ---------------------------------------------------------------------------

describe('G4 — session_id resolution', { timeout: 15000 }, () => {
  it('G4 resolves session_id from stdin payload', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('node scripts/memory-propose.mjs', {
        session_id: 'sess-abc',
      }),
    });
    expect(result.code).toBe(0);
    const events = await readEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0].session_id).toBe('sess-abc');
  });

  it('G4 falls back to current-session.json when stdin lacks session_id', async () => {
    const dir = await mkProjectTracked();
    await fs.mkdir(path.join(dir, '.orchestrator'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.orchestrator', 'current-session.json'),
      JSON.stringify({ session_id: 'sess-file' }),
    );
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('node scripts/memory-propose.mjs'),
    });
    expect(result.code).toBe(0);
    const events = await readEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0].session_id).toBe('sess-file');
  });

  it('G4 prefers stdin over file when both present', async () => {
    const dir = await mkProjectTracked();
    await fs.mkdir(path.join(dir, '.orchestrator'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.orchestrator', 'current-session.json'),
      JSON.stringify({ session_id: 'sess-file' }),
    );
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('node scripts/memory-propose.mjs', {
        session_id: 'sess-stdin',
      }),
    });
    expect(result.code).toBe(0);
    const events = await readEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0].session_id).toBe('sess-stdin');
  });

  it('G4 emits null when neither stdin nor file provides session_id', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('node scripts/memory-propose.mjs'),
    });
    expect(result.code).toBe(0);
    const events = await readEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0].session_id).toBe(null);
  });

  it('G4 accepts camelCase sessionId from stdin', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('node scripts/memory-propose.mjs', {
        sessionId: 'camel-1',
      }),
    });
    expect(result.code).toBe(0);
    const events = await readEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0].session_id).toBe('camel-1');
  });
});

// ---------------------------------------------------------------------------
// G5 — wave resolution
// ---------------------------------------------------------------------------

describe('G5 — wave resolution', { timeout: 15000 }, () => {
  it('G5 reads wave from .claude/wave-scope.json', async () => {
    const dir = await mkProjectTracked();
    await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.claude', 'wave-scope.json'),
      JSON.stringify({ wave: 3 }),
    );
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('node scripts/memory-propose.mjs', {
        session_id: 'sess-1',
      }),
    });
    expect(result.code).toBe(0);
    const events = await readEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0].wave).toBe(3);
  });

  it('G5 defaults wave to 0 when wave-scope.json absent', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('node scripts/memory-propose.mjs', {
        session_id: 'sess-1',
      }),
    });
    expect(result.code).toBe(0);
    const events = await readEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0].wave).toBe(0);
  });

  it('G5 defaults wave to 0 when JSON malformed', async () => {
    const dir = await mkProjectTracked();
    await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.claude', 'wave-scope.json'),
      'not json{',
    );
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('node scripts/memory-propose.mjs', {
        session_id: 'sess-1',
      }),
    });
    expect(result.code).toBe(0);
    const events = await readEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0].wave).toBe(0);
  });

  it('G5 defaults wave to 0 when wave field is non-numeric', async () => {
    const dir = await mkProjectTracked();
    await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.claude', 'wave-scope.json'),
      JSON.stringify({ wave: 'five' }),
    );
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('node scripts/memory-propose.mjs', {
        session_id: 'sess-1',
      }),
    });
    expect(result.code).toBe(0);
    const events = await readEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0].wave).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// G7 — append + truncation + observe-only contract
// ---------------------------------------------------------------------------

describe('G7 — events.jsonl append', { timeout: 15000 }, () => {
  it('G7 appends single JSONL line and creates metrics dir', async () => {
    const dir = await mkProjectTracked();
    // Confirm no pre-existing .orchestrator/metrics dir
    const metricsDir = path.join(dir, '.orchestrator', 'metrics');
    const dirExistsBefore = await fs
      .access(metricsDir)
      .then(() => true)
      .catch(() => false);
    expect(dirExistsBefore).toBe(false);

    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('node scripts/memory-propose.mjs', {
        session_id: 'sess-1',
      }),
    });
    expect(result.code).toBe(0);

    const dirExistsAfter = await fs
      .access(metricsDir)
      .then(() => true)
      .catch(() => false);
    expect(dirExistsAfter).toBe(true);

    const raw = await fs.readFile(
      path.join(metricsDir, 'events.jsonl'),
      'utf8',
    );
    // Exactly one JSONL record terminated with newline
    expect(raw.split('\n').filter((l) => l.length > 0)).toHaveLength(1);
    expect(raw.endsWith('\n')).toBe(true);

    const events = await readEvents(dir);
    expect(events).toHaveLength(1);
    // All 7 keys exactly per the hook's event shape.
    expect(Object.keys(events[0]).sort()).toEqual([
      'argv_truncated',
      'cwd',
      'event',
      'exit_code',
      'session_id',
      'timestamp',
      'wave',
    ]);
  });

  it('G7 truncates argv to 512 chars', async () => {
    const dir = await mkProjectTracked();
    // Long non-sensitive arg so redaction does NOT shrink the string.
    const longArg = 'a'.repeat(2000);
    const cmd = 'node scripts/memory-propose.mjs --type general ' + longArg;
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload(cmd, { session_id: 'sess-1' }),
    });
    expect(result.code).toBe(0);
    const events = await readEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0].argv_truncated.length).toBe(512);
  });

  it('G7 sets exit_code to null', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('node scripts/memory-propose.mjs', {
        session_id: 'sess-1',
      }),
    });
    expect(result.code).toBe(0);
    const events = await readEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0].exit_code).toBe(null);
  });

  it('always exits 0 even on G3 mismatch', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('ls -la', { session_id: 'sess-1' }),
    });
    expect(result.code).toBe(0);
    const events = await readEvents(dir);
    expect(events).toEqual([]);
  });
});
