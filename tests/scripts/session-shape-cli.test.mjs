/**
 * tests/scripts/session-shape-cli.test.mjs
 *
 * Behavioural tests for the `scripts/session-shape.mjs` CLI.
 *
 * THE bug every test below guards against: a shape library with no entrypoint is
 * the repo's standing disease (built, not wired) — its only caller would be a
 * fenced code block in a skill file, which no process runs, so the ledger stays
 * empty no matter what any session does. The CLI is what a coordinator can
 * actually RUN once the Q&A has resolved `--session-type` and `--profile`, and
 * these tests exercise it as a REAL subprocess so the exit-code contract
 * (0 resolved / 1 input / 2 config I/O — per `.claude/rules/cli-design.md`) is
 * seen exactly as a shell caller sees it.
 *
 * LEDGER SAFETY. Every run passes an explicit `--repo-root` under `mkdtemp`, and
 * `CLAUDE_PROJECT_DIR` is additionally pinned to that same tmp tree so a
 * regression in the repoRoot plumbing cannot append to the operator's real
 * `.orchestrator/metrics/events.jsonl` — the same two-guard shape
 * `tests/scripts/express-path-cli.test.mjs` uses.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', '..', 'scripts', 'session-shape.mjs');

let repoRoot;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'session-shape-cli-'));
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

/**
 * Run the CLI as a real subprocess. `spawnSync` (not `execFileSync`) because
 * BOTH streams matter on BOTH outcomes: stdout carries the shape on success and
 * `execFileSync` discards stderr when the exit code is 0.
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

/** Write a CLAUDE.md carrying a `## Session Config` block into the tmp repo. */
function writeConfig(lines) {
  writeFileSync(join(repoRoot, 'CLAUDE.md'), ['# Tmp', '', '## Session Config', '', ...lines, ''].join('\n'), 'utf8');
}

describe('session-shape CLI — success path', () => {
  it('prints exactly ONE JSON line on stdout and exits 0', () => {
    // Bug: a CLI whose stdout mixes diagnostics with the payload cannot be piped
    // into `jq`, which is the only way a coordinator consumes it. Human lines
    // belong on stderr (`cli-design.md` § JSON-First).
    const res = runCli(['--repo-root', repoRoot, '--session-type', 'feature']);
    expect(res.status).toBe(0);
    const lines = res.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    const shape = JSON.parse(lines[0]);
    expect(shape.totalWaves).toBe(3);
    expect(shape.discovery).toBe(false);
  });

  it('reads agents-per-wave from the repo CLAUDE.md instead of the built-in default', () => {
    // Bug: a CLI that never reads the repo's Session Config publishes a shape
    // computed from defaults — a deep wave capped at 6 in a repo that
    // configured `6 (deep: 18)`, with nothing saying the config was ignored.
    writeConfig(['agents-per-wave: 6 (deep: 18)', 'waves: 5']);
    const res = runCli(['--repo-root', repoRoot, '--session-type', 'deep']);
    expect(res.status).toBe(0);
    const shape = JSON.parse(res.stdout.trim());
    expect(shape.waves.map((w) => w.agentCap)).toEqual([8, 10, 8, 6, 4]);
  });

  it('emits the ledger record by default and NOTHING under --no-event', () => {
    // Bug, both directions: a CLI that never emits leaves the shape
    // unfalsifiable (the whole reason this event exists), and a planning
    // dry-run that DOES emit records a session that never ran.
    const emitted = runCli(['--repo-root', repoRoot, '--session-type', 'housekeeping']);
    expect(emitted.status).toBe(0);
    expect(
      readLedger().filter((r) => r.event === 'orchestrator.session.shape_resolved'),
    ).toHaveLength(1);

    rmSync(join(repoRoot, '.orchestrator'), { recursive: true, force: true });
    const dry = runCli([
      '--repo-root',
      repoRoot,
      '--session-type',
      'deep',
      '--profile',
      'ultradeep',
      '--no-event',
    ]);
    expect(dry.status).toBe(0);
    expect(JSON.parse(dry.stdout.trim()).totalWaves).toBe(7);
    expect(readLedger()).toEqual([]);
  });

  it('honours --known-scope true by dropping the Discovery wave', () => {
    // Bug: a flag parsed loosely (`Boolean('false')` is true) would keep or drop
    // a whole wave on a string comparison nobody checked.
    const res = runCli([
      '--repo-root',
      repoRoot,
      '--session-type',
      'deep',
      '--known-scope',
      'true',
      '--no-event',
    ]);
    expect(res.status).toBe(0);
    const shape = JSON.parse(res.stdout.trim());
    expect(shape.totalWaves).toBe(4);
    expect(shape.waves[0].role).toBe('Impl-Core');
  });
});

describe('session-shape CLI — exit codes', () => {
  it('exits 1 when --repo-root is missing, and never defaults it from the env', () => {
    // Bug (#941): a CLI that fills repoRoot from SO_PROJECT_DIR / cwd reinstates
    // exactly the ambient destination the library refuses — a synthetic record
    // in the operator's real fleet ledger.
    const res = runCli(['--session-type', 'deep']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--repo-root is required');
    expect(res.stdout).toBe('');
  });

  it('exits 1 on a non-existent --repo-root instead of creating the tree', () => {
    // Bug: the emitter's mkdir would CREATE a typo'd root, leaving an orphan
    // `.orchestrator/metrics/` directory that answers no question.
    const res = runCli([
      '--repo-root',
      join(repoRoot, 'nope', 'deeper'),
      '--session-type',
      'deep',
    ]);
    expect(res.status).toBe(1);
    expect(existsSync(join(repoRoot, 'nope'))).toBe(false);
  });

  it('exits 1 on an unknown --session-type or --profile rather than crashing with a stack', () => {
    // Bug: the library throws TypeError. Letting it reach the top-level catch
    // would report an INPUT mistake as exit 2 (system error) plus a stack trace
    // — the operator then debugs the CLI instead of fixing the flag.
    const badType = runCli(['--repo-root', repoRoot, '--session-type', 'ultradeep']);
    expect(badType.status).toBe(1);
    expect(badType.stderr).toContain('unknown sessionType');
    // Bug: the library's message already carries the `session-shape: ` prefix
    // that `warn()` prepends, so the operator read
    // `session-shape: session-shape: unknown sessionType …` — which looks like a
    // defect in the tool rather than a typo in the flag they just passed.
    expect(badType.stderr).not.toContain('session-shape: session-shape:');

    const badProfile = runCli([
      '--repo-root',
      repoRoot,
      '--session-type',
      'deep',
      '--profile',
      'turbo',
    ]);
    expect(badProfile.status).toBe(1);
    expect(badProfile.stderr).toContain('unknown profile');
  });

  it('exits 1 on an unknown flag and 1 on a malformed --task-count', () => {
    // Bug: a silently-ignored unknown flag lets `--waves 7` look accepted while
    // changing nothing, and a non-integer task count would reach the ledger as
    // NaN.
    expect(runCli(['--repo-root', repoRoot, '--session-type', 'deep', '--waves', '7']).status).toBe(
      1,
    );
    expect(
      runCli(['--repo-root', repoRoot, '--session-type', 'deep', '--task-count', 'lots']).status,
    ).toBe(1);
  });

  it('exits 2 when the config file exists but cannot be parsed', () => {
    // Bug: guessing past an unparseable Session Config publishes a shape with
    // the wrong agent budget under a green exit code. A config that is simply
    // ABSENT is a different case and stays exit 0 (asserted above).
    writeConfig(['agents-per-wave: not-a-number']);
    const res = runCli(['--repo-root', repoRoot, '--session-type', 'deep']);
    expect(res.status).toBe(2);
    expect(res.stdout).toBe('');
  });

  it('--help prints usage on stdout and exits 0', () => {
    // Bug: usage on stderr with a non-zero exit makes `--help` indistinguishable
    // from a failure in any script that checks the exit code.
    const res = runCli(['--help']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('--session-type');
  });
});
