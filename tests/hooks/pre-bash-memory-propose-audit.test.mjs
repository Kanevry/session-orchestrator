/**
 * tests/hooks/pre-bash-memory-propose-audit.test.mjs
 *
 * Vitest tests for hooks/pre-bash-memory-propose-audit.mjs.
 *
 * Strategy: spawn the hook as a subprocess, pipe JSON on stdin, read the
 * appended events.jsonl file from a tmp project root, and assert exit code +
 * event-record shape per behavior.
 *
 * Coverage targets the G1–G7 gate ladder + the #1415 argv-summary contract
 * (`command_hash` / `flags_present` / `argv_length`, which replaced the
 * flag-redacted `argv_truncated` on 2026-09-21). Hardcoded literals per
 * `.claude/rules/test-quality.md`.
 *
 * Issues: #543 H1, #1415
 */

import { describe, it, expect, afterEach } from 'vitest';
import { expectAllow } from '../_helpers/hook-decision.mjs';
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
// G6 — argv summary (#1415): command_hash / flags_present / argv_length
//
// Until 2026-09-21 this block pinned `argv_truncated`, a merely flag-redacted
// copy of the Bash command, written into a TRACKED events.jsonl line and — with
// the webhook configured — onto the network. The redaction covered five flag
// VALUES and no more: `$VAR`, `$(cat secret)` and any secret written elsewhere
// on the line went out verbatim. The field had ZERO production readers.
// The replacement is non-reversible by construction, and these tests pin it in
// BOTH directions: the summary fields are present AND the raw text is gone.
// ---------------------------------------------------------------------------

/** The hook's own recipe, restated independently: sha256(command), 16 hex. */
const HASH_RE = /^[0-9a-f]{16}$/;

describe('G6 — command_hash', { timeout: 15000 }, () => {
  it('emits a 16-hex-character hash and no raw command field', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload(
        'node scripts/memory-propose.mjs --type general --insight=secret-text',
        { session_id: 'sess-1' },
      ),
    });
    expectAllow(result);
    const events = await readEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0].command_hash).toMatch(HASH_RE);
    // Both directions, per 8f15f77b: hash present AND no raw-text field put back
    // beside it. Without the second half someone could restore `argv_truncated`
    // (or a `command`) next to the hash and no suite would go red.
    expect(events[0].argv_truncated).toBeUndefined();
    expect(events[0].command).toBeUndefined();
  });

  it('is deterministic for the same command', async () => {
    const cmd = 'node scripts/memory-propose.mjs --type general --subject abc';
    const dirA = await mkProjectTracked();
    const dirB = await mkProjectTracked();
    expectAllow(
      await runHook({ projectDir: dirA, stdin: bashPayload(cmd, { session_id: 'sess-1' }) }),
    );
    expectAllow(
      await runHook({ projectDir: dirB, stdin: bashPayload(cmd, { session_id: 'sess-2' }) }),
    );
    const [a] = await readEvents(dirA);
    const [b] = await readEvents(dirB);
    expect(a.command_hash).toBe(b.command_hash);
    // Hardcoded literal, NOT recomputed in the test (tautological-computation
    // ban, `.claude/rules/testing.md`): this is sha256 of the exact command
    // string above, first 16 hex chars.
    expect(a.command_hash).toBe('74310a9eb69d00cd');
  });

  it('differs for a command that differs by one character', async () => {
    const dirA = await mkProjectTracked();
    const dirB = await mkProjectTracked();
    expectAllow(
      await runHook({
        projectDir: dirA,
        stdin: bashPayload('node scripts/memory-propose.mjs --type general', {
          session_id: 'sess-1',
        }),
      }),
    );
    expectAllow(
      await runHook({
        projectDir: dirB,
        stdin: bashPayload('node scripts/memory-propose.mjs --type generaL', {
          session_id: 'sess-1',
        }),
      }),
    );
    const [a] = await readEvents(dirA);
    const [b] = await readEvents(dirB);
    expect(a.command_hash).not.toBe(b.command_hash);
  });
});

describe('G6 — flags_present', { timeout: 15000 }, () => {
  it('reports the known flag NAMES only, never their values', async () => {
    const dir = await mkProjectTracked();
    const cmd =
      'node scripts/memory-propose.mjs --type general --subject b --insight c ' +
      '--evidence d --confidence 0.8 --dry-run --file-paths hooks/x.mjs';
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload(cmd, { session_id: 'sess-1' }),
    });
    expectAllow(result);
    const events = await readEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0].flags_present).toEqual([
      'type',
      'subject',
      'insight',
      'evidence',
      'confidence',
      'dry-run',
      'file-paths',
    ]);
  });

  it('is empty when the command carries no known flag', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('node scripts/memory-propose.mjs', { session_id: 'sess-1' }),
    });
    expectAllow(result);
    const events = await readEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0].flags_present).toEqual([]);
  });

  it('does not report a flag-shaped VALUE as a flag', async () => {
    // The leak a `--\S+` scrape would re-open: the value itself looks like a
    // flag. The closed KNOWN_FLAGS list makes it structurally unreportable.
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload(
        'node scripts/memory-propose.mjs --insight --my-secret-token-value',
        { session_id: 'sess-1' },
      ),
    });
    expectAllow(result);
    const events = await readEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0].flags_present).toEqual(['insight']);
    expect(JSON.stringify(events[0]).includes('my-secret-token-value')).toBe(false);
  });

  it('does not report the prefix collision --insightful as --insight', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('node scripts/memory-propose.mjs --insightful keep-me', {
        session_id: 'sess-1',
      }),
    });
    expectAllow(result);
    const events = await readEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0].flags_present).toEqual([]);
  });

  it('reports the --flag=value spelling too', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload(
        'node scripts/memory-propose.mjs --type=general --insight=secret-text',
        { session_id: 'sess-1' },
      ),
    });
    expectAllow(result);
    const events = await readEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0].flags_present).toEqual(['type', 'insight']);
  });
});

describe('G6 — no raw value reaches the event (#1415 negative test)', { timeout: 15000 }, () => {
  it('leaks no --insight/--subject/--evidence/--file-paths value anywhere in the record', async () => {
    // Every shape the OLD redactor let through is represented here: shell
    // expansion (`$VAR`, `$(cat …)`), a here-string, a quoted value with an
    // escaped inner quote, an unknown flag carrying a secret, and a repo path.
    const dir = await mkProjectTracked();
    const cmd =
      'node scripts/memory-propose.mjs ' +
      '--subject subject-sentinel-aaa ' +
      '--insight ' + DQ + 'insight sentinel ' + BS + DQ + 'bbb' + BS + DQ + DQ + ' ' +
      '--evidence=$(cat evidence-sentinel-ccc) ' +
      '--file-paths hooks/path-sentinel-ddd.mjs ' +
      '--unknown-flag unknown-sentinel-eee';
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload(cmd, { session_id: 'sess-1' }),
    });
    expectAllow(result);
    const events = await readEvents(dir);
    expect(events).toHaveLength(1);
    // String search over the SERIALIZED record — no field may carry any of them.
    const serialized = JSON.stringify(events[0]);
    expect(serialized.includes('subject-sentinel-aaa')).toBe(false);
    expect(serialized.includes('insight sentinel')).toBe(false);
    expect(serialized.includes('bbb')).toBe(false);
    expect(serialized.includes('evidence-sentinel-ccc')).toBe(false);
    expect(serialized.includes('path-sentinel-ddd')).toBe(false);
    expect(serialized.includes('unknown-sentinel-eee')).toBe(false);
    // …and the record is still useful: the invocation is countable + shaped.
    expect(events[0].command_hash).toMatch(HASH_RE);
    expect(events[0].flags_present).toEqual([
      'subject',
      'insight',
      'evidence',
      'file-paths',
    ]);
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
    expectAllow(result);
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

  it.each([
    '/usr/bin/node ./scripts/memory-propose.mjs',
    'SO_WAVE_AGENT=1 node scripts/memory-propose.mjs --type general',
  ])('G3 accepts node memory-propose invocation: %s', async (command) => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload(command, { session_id: 'sess-1' }),
    });
    expectAllow(result);
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
    expectAllow(result);
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
    expectAllow(result);
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
    expectAllow(result);
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
    expectAllow(result);
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
    expectAllow(result);
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
    expectAllow(result);
    const events = await readEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0].wave).toBe(3);
  });

  it.each([
    { name: 'absent', prepare: async () => {} },
    {
      name: 'malformed',
      prepare: async (dir) => {
        await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
        await fs.writeFile(path.join(dir, '.claude', 'wave-scope.json'), 'not json{');
      },
    },
    {
      name: 'non-numeric',
      prepare: async (dir) => {
        await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
        await fs.writeFile(
          path.join(dir, '.claude', 'wave-scope.json'),
          JSON.stringify({ wave: 'five' }),
        );
      },
    },
  ])('G5 defaults wave to 0 when wave-scope.json is $name', async ({ prepare }) => {
    const dir = await mkProjectTracked();
    await prepare(dir);
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('node scripts/memory-propose.mjs', {
        session_id: 'sess-1',
      }),
    });
    expectAllow(result);
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
    expectAllow(result);

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
    // All 10 keys exactly per the hook's event shape (#1177 added the
    // producer-owned schema_version alongside timestamp + event; #1415
    // replaced the single `argv_truncated` with the three summary fields).
    expect(Object.keys(events[0]).sort()).toEqual([
      'argv_length',
      'command_hash',
      'cwd',
      'event',
      'exit_code',
      'flags_present',
      'schema_version',
      'session_id',
      'timestamp',
      'wave',
    ]);
  });

  it('G7 records argv_length for an oversized command without growing the record', async () => {
    const dir = await mkProjectTracked();
    const longArg = 'a'.repeat(2000);
    const cmd = 'node scripts/memory-propose.mjs --type general ' + longArg;
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload(cmd, { session_id: 'sess-1' }),
    });
    expectAllow(result);
    const events = await readEvents(dir);
    expect(events).toHaveLength(1);
    // 47 chars of prefix + 2000 'a' — the LENGTH is reported, the text is not.
    // (The predecessor field capped at 512 chars of command TEXT; the cap is
    // gone because the text is gone.)
    expect(events[0].argv_length).toBe(2047);
    expect(events[0].command_hash).toMatch(HASH_RE);
    expect(JSON.stringify(events[0]).includes('aaaaaaaaaa')).toBe(false);
  });

  it('G7 sets exit_code to null', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('node scripts/memory-propose.mjs', {
        session_id: 'sess-1',
      }),
    });
    expectAllow(result);
    const events = await readEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0].exit_code).toBe(null);
  });
});
