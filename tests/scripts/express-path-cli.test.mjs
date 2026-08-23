/**
 * tests/scripts/express-path-cli.test.mjs
 *
 * Behavioural tests for the `scripts/express-path.mjs` CLI (#1146).
 *
 * THE bug every test below guards against is one bug, in two halves. At HEAD
 * 01eb35d `evaluateExpressPath` had zero production callers — its only "caller"
 * was a fenced ```js block in a markdown file — so the express-path ledger stayed
 * empty no matter what any session did. The CLI is what a coordinator can
 * actually RUN in Phase 8.5, and these tests exercise it as a REAL subprocess so
 * the exit-code contract (0 completed / 1 input / 2 config I/O — per
 * `.claude/rules/cli-design.md`) is seen exactly as a shell caller sees it.
 *
 * LEDGER SAFETY. Every run passes an explicit `--repo-root` under `mkdtemp`, and
 * `CLAUDE_PROJECT_DIR` is additionally pinned to that same tmp tree so a
 * regression in the repoRoot plumbing cannot append to the operator's real
 * `.orchestrator/metrics/events.jsonl` — the same two-guard shape
 * `tests/lib/express-path.test.mjs` uses.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', '..', 'scripts', 'express-path.mjs');

let repoRoot;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'express-path-cli-'));
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

/**
 * Run the CLI as a real subprocess. `spawnSync` (not `execFileSync`) because
 * BOTH streams matter on BOTH outcomes here: the banner is a stderr assertion on
 * the SUCCESS path, and `execFileSync` discards stderr when the exit code is 0.
 *
 * @param {string[]} args
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function runCli(args) {
  const res = spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: repoRoot,
      CLANK_EVENT_SECRET: '',
      CLANK_EVENT_URL: '',
    },
  });
  return {
    status: typeof res.status === 'number' ? res.status : 2,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

/** Read every event record the tmp repoRoot received. */
function readLedger() {
  const file = join(repoRoot, '.orchestrator', 'metrics', 'events.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

/** Write a CLAUDE.md carrying an `express-path:` block into the tmp repo. */
function writeConfig(enabled) {
  writeFileSync(
    join(repoRoot, 'CLAUDE.md'),
    ['# Tmp', '', 'express-path:', `  enabled: ${enabled}`, ''].join('\n'),
    'utf8',
  );
}

/**
 * Plant a session.lock the way `sessionAttribution()` expects to find one —
 * same field set `parseLock()` requires (`scripts/lib/session-lock.mjs:200-209`).
 */
function writeLock(fields) {
  mkdirSync(join(repoRoot, '.orchestrator'), { recursive: true });
  writeFileSync(
    join(repoRoot, '.orchestrator', 'session.lock'),
    JSON.stringify({
      session_id: 'cli-test-uuid',
      started_at: '2026-08-23T10:00:00.000Z',
      mode: 'housekeeping',
      pid: process.pid,
      host: 'test-host',
      ttl_hours: 8,
      ...fields,
    }),
    'utf8',
  );
}

describe('express-path.mjs CLI — the verdict', () => {
  it('activates on housekeeping / 2 tasks / no parallel agents and exits 0', () => {
    // Bug: an activation that exits non-zero (or prints prose) makes the CLI
    // unusable from a coordinator turn — the caller cannot tell a fast path
    // from a crash, which is how prose-only wiring survived in the first place.
    writeConfig(true);
    const res = runCli([
      '--repo-root', repoRoot,
      '--session-type', 'housekeeping',
      '--task-count', '2',
      '--parallel-agents', 'false',
    ]);
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({
      activated: true,
      reasons: ['enabled', 'session-type-housekeeping', 'scope-within-limit', 'no-parallel-agents'],
    });
  });

  it('prints the verbatim activation banner on stderr, never on stdout', () => {
    // Bug: `commands/go.md` and session-plan's Short-Circuit both key off this
    // EXACT line. A diagnostic prefix, a reworded banner, or the banner landing
    // on stdout (where it would corrupt the JSON a caller parses) each break a
    // documented detection branch.
    writeConfig(true);
    const res = runCli([
      '--repo-root', repoRoot,
      '--session-type', 'housekeeping',
      '--task-count', '2',
      '--parallel-agents', 'false',
    ]);
    expect(res.stderr).toContain(
      'Express path activated — 2 tasks, coordinator-direct, no inter-wave checks.',
    );
    // Verbatim: no `express-path:` diagnostic prefix on the banner line itself.
    expect(res.stderr).not.toContain('express-path: Express path activated');
    // stdout stays parseable as exactly one JSON verdict.
    expect(res.stdout).not.toContain('Express path activated');
    expect(JSON.parse(res.stdout).activated).toBe(true);
  });

  it('refuses a deep session and still exits 0 — a refusal is an answer', () => {
    // Bug: exiting non-zero on `activated:false` would make every non-express
    // session look like a failed command, and a `set -e` caller would abort the
    // session-start flow on the NORMAL path.
    writeConfig(true);
    const res = runCli([
      '--repo-root', repoRoot,
      '--session-type', 'deep',
      '--task-count', '2',
      '--parallel-agents', 'false',
    ]);
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({
      activated: false,
      reasons: ['session-type-not-housekeeping'],
    });
  });

  it('honours an operator opt-out written in the repo-root config', () => {
    // Bug: resolving the config from cwd (parse-config.mjs's walk-up) instead of
    // --repo-root would read a DIFFERENT repo's CLAUDE.md than the one being
    // recorded — the opt-out would be silently ignored.
    writeConfig(false);
    const res = runCli([
      '--repo-root', repoRoot,
      '--session-type', 'housekeeping',
      '--task-count', '1',
      '--parallel-agents', 'false',
    ]);
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({
      activated: false,
      reasons: ['disabled-by-config'],
    });
  });
});

describe('express-path.mjs CLI — input contract', () => {
  it.each([
    { why: 'no --repo-root', args: ['--session-type', 'housekeeping', '--task-count', '2'] },
    { why: 'no --session-type', args: ['--repo-root', '<ROOT>', '--task-count', '2'] },
    { why: 'no --task-count', args: ['--repo-root', '<ROOT>', '--session-type', 'housekeeping'] },
    {
      why: 'a non-integer --task-count',
      args: ['--repo-root', '<ROOT>', '--session-type', 'housekeeping', '--task-count', 'two'],
    },
    {
      why: 'a --parallel-agents value that is neither true nor false',
      args: [
        '--repo-root', '<ROOT>', '--session-type', 'housekeeping',
        '--task-count', '2', '--parallel-agents', 'maybe',
      ],
    },
  ])('exits 1 and writes nothing to the ledger: $why', ({ args }) => {
    // Bug: the library fails CLOSED on an unmeasured input, so a CLI that
    // silently forwarded a missing/garbage value would record a REFUSAL caused
    // by its own arg handling — indistinguishable in the ledger from a genuine
    // condition failure, which is the exact confusion #1119 set out to end.
    const res = runCli(args.map((a) => (a === '<ROOT>' ? repoRoot : a)));
    expect(res.status).toBe(1);
    expect(readLedger()).toHaveLength(0);
  });

  it('exits 1 rather than creating a ledger under a mistyped --repo-root', () => {
    // Bug: emitEvent mkdir -p's its destination, so a typo'd root would be
    // CREATED and receive the only copy of the record. An orphan
    // .orchestrator/metrics/ tree answers no question and is never looked at.
    const missing = join(repoRoot, 'no-such-repo');
    const res = runCli([
      '--repo-root', missing,
      '--session-type', 'housekeeping',
      '--task-count', '2',
    ]);
    expect(res.status).toBe(1);
    expect(existsSync(missing)).toBe(false);
  });

  it('exits 2 when an explicitly named --config-file does not exist', () => {
    // Bug: guessing past an unreadable config could activate a fast path that
    // skips every inter-wave quality gate, in a repo whose config may well have
    // carried `express-path.enabled: false`. Config I/O is a system error (2),
    // deliberately distinct from the input class (1).
    const res = runCli([
      '--repo-root', repoRoot,
      '--session-type', 'housekeeping',
      '--task-count', '2',
      '--config-file', join(repoRoot, 'nope.md'),
    ]);
    expect(res.status).toBe(2);
    expect(readLedger()).toHaveLength(0);
  });

  it('still evaluates when the repo has no CLAUDE.md, omitting `enabled` from the record', () => {
    // Bug: treating an ABSENT config as an error would make the CLI unusable in
    // a fresh repo; treating it as a MEASURED `enabled: true` would fabricate an
    // operator decision nobody made. Absent is not measured.
    const res = runCli([
      '--repo-root', repoRoot,
      '--session-type', 'housekeeping',
      '--task-count', '2',
      '--parallel-agents', 'false',
    ]);
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout).activated).toBe(true);
    const [record] = readLedger();
    expect(record).not.toHaveProperty('enabled');
  });
});

describe('express-path.mjs CLI — the record', () => {
  it('lands the event in <repo-root>/.orchestrator/metrics/events.jsonl', () => {
    // THE bug: 0 express-path events across the ledger's entire history,
    // because nothing ever called the evaluator. The record landing in the
    // NAMED repo's ledger is the whole deliverable.
    writeConfig(true);
    runCli([
      '--repo-root', repoRoot,
      '--session-type', 'housekeeping',
      '--task-count', '2',
      '--parallel-agents', 'false',
    ]);
    const records = readLedger();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      event: 'orchestrator.express_path.evaluated',
      activated: true,
      enabled: true,
      session_type: 'housekeeping',
      task_count: 2,
      parallel_agents_required: false,
    });
  });

  it('records the refusal too, carrying the blocking reason', () => {
    // Bug: an emitter that fires only on activation leaves "did the express path
    // apply to this session?" unanswerable for every session where it did not —
    // which is most of them.
    writeConfig(true);
    runCli([
      '--repo-root', repoRoot,
      '--session-type', 'housekeeping',
      '--task-count', '9',
      '--parallel-agents', 'false',
    ]);
    const [record] = readLedger();
    expect(record).toMatchObject({
      event: 'orchestrator.express_path.evaluated',
      activated: false,
      reasons: ['scope-exceeds-limit'],
      task_count: 9,
    });
  });

  it('attributes the record to the session.lock present in the same repo', () => {
    // Bug: an unattributed record cannot be joined to the session it describes,
    // so "which sessions took the fast path" stays unanswerable even once the
    // events exist. sessionAttribution() reads the lock from repoRoot — a CLI
    // that dropped repoRoot would read the WRONG repo's lock, or none.
    writeConfig(true);
    writeLock({ session_id: 'uuid-abc', semantic_session_id: 'main-2026-08-23-session-9' });
    runCli([
      '--repo-root', repoRoot,
      '--session-type', 'housekeeping',
      '--task-count', '1',
      '--parallel-agents', 'false',
    ]);
    const [record] = readLedger();
    expect(record.session_id).toBe('uuid-abc');
    expect(record.semantic_session_id).toBe('main-2026-08-23-session-9');
  });

  it('omits parallel_agents_required entirely when --parallel-agents is not given', () => {
    // Bug: defaulting the flag to `false` in the CLI would write "it was
    // measured that no parallel agents are needed" for a coordinator that
    // asserted nothing — a fabricated measurement in the one ledger that exists
    // to answer why the path fired.
    writeConfig(true);
    runCli([
      '--repo-root', repoRoot,
      '--session-type', 'housekeeping',
      '--task-count', '2',
    ]);
    const [record] = readLedger();
    expect(record).not.toHaveProperty('parallel_agents_required');
    expect(record.reasons).toContain('parallel-agents-not-asserted');
  });
});

describe('express-path.mjs CLI — usage', () => {
  it('prints usage to stdout and exits 0 for --help', () => {
    const res = runCli(['--help']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('--repo-root');
    expect(res.stdout).toContain('Exit codes:');
  });

  it('rejects an unknown flag with the input exit code', () => {
    const res = runCli([
      '--repo-root', repoRoot,
      '--session-type', 'housekeeping',
      '--task-count', '2',
      '--bogus', 'x',
    ]);
    expect(res.status).toBe(1);
  });
});
