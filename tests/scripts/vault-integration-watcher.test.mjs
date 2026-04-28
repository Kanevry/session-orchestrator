/**
 * tests/scripts/vault-integration-watcher.test.mjs
 *
 * Unit / integration tests for scripts/vault-integration-watcher.mjs (Issue #306).
 *
 * Approach: spawn the script via spawnSync with a PATH-overridden stub `glab`
 * binary that reads its responses from a per-test fixture directory injected via
 * the GLAB_FIXTURE_DIR environment variable. The stub reads
 * `<GLAB_FIXTURE_DIR>/<subcommand>-<id>.json` (or a fallback) and writes its
 * stdout as the JSON payload.
 *
 * Tests cover:
 *   1. both-closed → streak 1, tick posted (not yet flip-ready)
 *   2. one-closed → bleibt warn tick
 *   3. streak of 3 accumulated → flip-ready comment triggered
 *   4. idempotence — flip-ready marker already present → early exit
 *   5. stagnation marker already present → early exit
 *   6. stagnation guard triggers after 60d (mocked created_at)
 *   7. dry-run: no glab note add calls, stdout contains comment-dry-run action
 *   8. missing glab binary → exits 2
 *   9. all dep issues closed + streak=2 → no flip-ready yet
 *  10. comment body format — contains YYYY-MM-DD and streak N/3
 *  11. streak resets on warn tick
 *  12. --verbose flag passes without error
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  chmodSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Paths ─────────────────────────────────────────────────────────────────────

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts', 'vault-integration-watcher.mjs');
const FIXTURES_DIR = join(REPO_ROOT, 'tests', 'fixtures');
const STUB_GLAB = join(FIXTURES_DIR, 'glab');

// ── Markers (copy of production constants, used in assertions) ─────────────────

const MARKER_TICK = '<!-- vault-watcher:v1 -->';
const MARKER_FLIP = '<!-- vault-watcher:v1:flip-ready -->';
const MARKER_STAGNATION = '<!-- vault-watcher:v1:stagnation -->';

// ── Stub glab binary ──────────────────────────────────────────────────────────

const STUB_GLAB_SOURCE = `#!/usr/bin/env node
/**
 * Stub glab binary for vault-integration-watcher tests.
 * Reads fixture data from GLAB_FIXTURE_DIR.
 *
 * Supported invocations:
 *   glab issue view <id> --output json
 *   glab issue view <id> --comments --output json
 *   glab issue note add <id> --message <body>
 */
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const fixtureDir = process.env.GLAB_FIXTURE_DIR;
const callLog = process.env.GLAB_CALL_LOG;

// Log call for assertion
if (callLog) {
  appendFileSync(callLog, JSON.stringify(args) + '\\n');
}

// glab issue note add <id> --message <body>
if (args[0] === 'issue' && args[1] === 'note' && args[2] === 'add') {
  // Just succeed silently
  process.exit(0);
}

// glab issue view <id> [--comments] --output json
if (args[0] === 'issue' && args[1] === 'view') {
  const id = args[2];
  const isComments = args.includes('--comments');
  const base = isComments ? \`comments-\${id}\` : \`issue-\${id}\`;
  const file = join(fixtureDir, base + '.json');
  if (existsSync(file)) {
    process.stdout.write(readFileSync(file, 'utf8'));
    process.exit(0);
  }
  // Fallback: generic issue
  const fallback = join(fixtureDir, isComments ? 'comments-default.json' : 'issue-default.json');
  if (existsSync(fallback)) {
    process.stdout.write(readFileSync(fallback, 'utf8'));
    process.exit(0);
  }
  process.stderr.write('stub glab: no fixture for ' + file + '\\n');
  process.exit(1);
}

process.stderr.write('stub glab: unrecognised args: ' + JSON.stringify(args) + '\\n');
process.exit(1);
`;

// ── Fixture helpers ───────────────────────────────────────────────────────────

/**
 * Write the stub glab script if it doesn't exist yet.
 */
function ensureStubGlab() {
  if (!existsSync(STUB_GLAB)) {
    mkdirSync(FIXTURES_DIR, { recursive: true });
    writeFileSync(STUB_GLAB, STUB_GLAB_SOURCE, 'utf8');
  }
  chmodSync(STUB_GLAB, 0o755);
}

/**
 * Create a minimal issue fixture.
 * @param {string} dir fixture directory
 * @param {string} id issue id (string)
 * @param {string} state 'opened' | 'closed'
 * @param {string} [createdAt]
 */
function writeIssueFixture(dir, id, state, createdAt = '2026-04-01T00:00:00Z') {
  writeFileSync(
    join(dir, `issue-${id}.json`),
    JSON.stringify({
      iid: Number(id),
      state,
      created_at: createdAt,
      closed_at: state === 'closed' ? '2026-04-28T00:00:00Z' : null,
    }),
    'utf8'
  );
}

/**
 * Create a comments fixture (array of note objects).
 * @param {string} dir fixture directory
 * @param {string} id issue id
 * @param {Array<{body: string, created_at: string}>} comments
 */
function writeCommentsFixture(dir, id, comments) {
  writeFileSync(join(dir, `comments-${id}.json`), JSON.stringify(comments), 'utf8');
}

/**
 * Build a tick comment body for a given verdict (simulates past watcher comment).
 * @param {string} verdict
 * @param {string} [date]
 * @returns {{body: string, created_at: string}}
 */
function makeTick(verdict, date = '2026-04-27') {
  return {
    body: `${MARKER_TICK}\n**${date} watcher tick**\n- Streak: 1/3\n- Verdict: ${verdict}`,
    created_at: `${date}T07:00:00Z`,
  };
}

// ── Run helper ────────────────────────────────────────────────────────────────

function runWatcher(args, { fixtureDir, callLog } = {}) {
  const env = {
    ...process.env,
    PATH: `${FIXTURES_DIR}:${process.env.PATH}`,
    GLAB_FIXTURE_DIR: fixtureDir ?? '',
    ...(callLog ? { GLAB_CALL_LOG: callLog } : {}),
  };

  return spawnSync(process.execPath, [SCRIPT, '--glab-bin', STUB_GLAB, ...args], {
    encoding: 'utf8',
    env,
    timeout: 30_000,
  });
}

/**
 * Parse stdout JSON action lines.
 * @param {string} stdout
 * @returns {Array<Record<string, unknown>>}
 */
function parseActions(stdout) {
  return (stdout ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l));
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('scripts/vault-integration-watcher.mjs', () => {
  let tmp;

  beforeEach(() => {
    ensureStubGlab();
    tmp = mkdtempSync(join(tmpdir(), 'vw-test-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // ── Test 1: both closed → tick posted, no flip yet ─────────────────────────

  it('both deps closed → tick posted with umstellungs-bereit, no flip-ready yet (streak=1)', () => {
    writeIssueFixture(tmp, '303', 'closed');
    writeIssueFixture(tmp, '304', 'closed');
    writeIssueFixture(tmp, '305', 'opened');
    writeCommentsFixture(tmp, '305', []); // no prior ticks

    const result = runWatcher(
      ['--issue', '305', '--dep-issues', '303,304', '--dry-run', '--verbose'],
      { fixtureDir: tmp }
    );

    expect(result.status).toBe(0);

    const actions = parseActions(result.stdout);
    const dryRunAction = actions.find((a) => a.action === 'comment-dry-run');
    expect(dryRunAction).toBeDefined();
    expect(dryRunAction.body).toContain(MARKER_TICK);
    expect(dryRunAction.body).toContain('umstellungs-bereit');
    expect(dryRunAction.body).toContain('1/3');

    const tickAction = actions.find((a) => a.action === 'tick-posted');
    expect(tickAction).toBeDefined();
    expect(tickAction.verdict).toBe('umstellungs-bereit');
    expect(tickAction.streak).toBe(1);
  });

  // ── Test 2: one dep still open → bleibt warn ──────────────────────────────

  it('one dep still open → tick posted with bleibt warn, streak 0', () => {
    writeIssueFixture(tmp, '303', 'closed');
    writeIssueFixture(tmp, '304', 'opened'); // still open
    writeIssueFixture(tmp, '305', 'opened');
    writeCommentsFixture(tmp, '305', []);

    const result = runWatcher(
      ['--issue', '305', '--dep-issues', '303,304', '--dry-run'],
      { fixtureDir: tmp }
    );

    expect(result.status).toBe(0);

    const actions = parseActions(result.stdout);
    const tickAction = actions.find((a) => a.action === 'tick-posted');
    expect(tickAction).toBeDefined();
    expect(tickAction.verdict).toBe('bleibt warn');
    expect(tickAction.streak).toBe(0);

    const dryRunAction = actions.find((a) => a.action === 'comment-dry-run');
    expect(dryRunAction.body).toContain('bleibt warn');
  });

  // ── Test 3: streak of 3 → flip-ready posted ───────────────────────────────

  it('streak of 3 accumulated → flip-ready trigger posted', () => {
    writeIssueFixture(tmp, '303', 'closed');
    writeIssueFixture(tmp, '304', 'closed');
    writeIssueFixture(tmp, '305', 'opened');

    // Simulate 2 prior umstellungs-bereit ticks
    writeCommentsFixture(tmp, '305', [
      makeTick('umstellungs-bereit', '2026-04-26'),
      makeTick('umstellungs-bereit', '2026-04-27'),
    ]);

    const result = runWatcher(
      ['--issue', '305', '--dep-issues', '303,304', '--dry-run'],
      { fixtureDir: tmp }
    );

    expect(result.status).toBe(0);

    const actions = parseActions(result.stdout);
    const flipAction = actions.find((a) => a.action === 'flip-ready-posted');
    expect(flipAction).toBeDefined();

    // The flip-ready comment body contains the sed snippet
    const dryRunActions = actions.filter((a) => a.action === 'comment-dry-run');
    expect(dryRunActions).toHaveLength(2); // tick + flip-ready
    const flipComment = dryRunActions.find((a) => a.body?.includes(MARKER_FLIP));
    expect(flipComment).toBeDefined();
    expect(flipComment.body).toContain('BEREIT ZUM FLIP');
    expect(flipComment.body).toContain('launchpad-ai-factory');
  });

  // ── Test 4: idempotence — flip-ready already present → early exit ──────────

  it('flip-ready marker already on issue → early exit, no new comment', () => {
    writeIssueFixture(tmp, '303', 'closed');
    writeIssueFixture(tmp, '304', 'closed');
    writeIssueFixture(tmp, '305', 'opened');

    writeCommentsFixture(tmp, '305', [
      { body: `${MARKER_FLIP}\n🚦 **BEREIT ZUM FLIP**`, created_at: '2026-04-25T07:00:00Z' },
    ]);

    const result = runWatcher(
      ['--issue', '305', '--dep-issues', '303,304'],
      { fixtureDir: tmp }
    );

    expect(result.status).toBe(0);

    const actions = parseActions(result.stdout);
    const earlyExit = actions.find((a) => a.action === 'early-exit');
    expect(earlyExit).toBeDefined();
    expect(earlyExit.reason).toBe('flip-ready');

    // No tick or flip comment should have been posted
    const tick = actions.find((a) => a.action === 'tick-posted');
    expect(tick).toBeUndefined();
  });

  // ── Test 5: stagnation marker already present → early exit ────────────────

  it('stagnation marker already on issue → early exit', () => {
    writeIssueFixture(tmp, '305', 'opened');

    writeCommentsFixture(tmp, '305', [
      { body: `${MARKER_STAGNATION}\n⚠️ Watcher-Stagnation`, created_at: '2026-04-20T07:00:00Z' },
    ]);

    const result = runWatcher(
      ['--issue', '305', '--dep-issues', '303,304'],
      { fixtureDir: tmp }
    );

    expect(result.status).toBe(0);

    const actions = parseActions(result.stdout);
    const earlyExit = actions.find((a) => a.action === 'early-exit');
    expect(earlyExit).toBeDefined();
    expect(earlyExit.reason).toBe('stagnation');
  });

  // ── Test 6: stagnation guard triggers after 60d ────────────────────────────

  it('stagnation guard triggers when issue created >60 days ago and verdict is bleibt warn', () => {
    const oldDate = new Date(Date.now() - 65 * 24 * 60 * 60 * 1000).toISOString();

    writeIssueFixture(tmp, '303', 'opened');
    writeIssueFixture(tmp, '304', 'opened');
    writeIssueFixture(tmp, '305', 'opened', oldDate);
    writeCommentsFixture(tmp, '305', []);

    const result = runWatcher(
      ['--issue', '305', '--dep-issues', '303,304', '--dry-run'],
      { fixtureDir: tmp }
    );

    expect(result.status).toBe(0);

    const actions = parseActions(result.stdout);
    const stagnationAction = actions.find((a) => a.action === 'stagnation-posted');
    expect(stagnationAction).toBeDefined();

    // The stagnation comment body should contain the marker
    const dryRunAction = actions.find((a) => a.action === 'comment-dry-run');
    expect(dryRunAction).toBeDefined();
    expect(dryRunAction.body).toContain(MARKER_STAGNATION);
  });

  // ── Test 7: dry-run — no real glab note add calls ──────────────────────────

  it('dry-run: outputs comment-dry-run action but no tick-posted live action', () => {
    writeIssueFixture(tmp, '303', 'closed');
    writeIssueFixture(tmp, '304', 'closed');
    writeIssueFixture(tmp, '305', 'opened');
    writeCommentsFixture(tmp, '305', []);

    const result = runWatcher(
      ['--issue', '305', '--dep-issues', '303,304', '--dry-run'],
      { fixtureDir: tmp }
    );

    expect(result.status).toBe(0);

    const actions = parseActions(result.stdout);

    // Should have comment-dry-run but NOT a live comment-posted
    const livePost = actions.find((a) => a.action === 'comment-posted');
    expect(livePost).toBeUndefined();

    const dryRun = actions.find((a) => a.action === 'comment-dry-run');
    expect(dryRun).toBeDefined();
  });

  // ── Test 8: missing glab binary → exits 2 ─────────────────────────────────

  it('non-existent glab binary → exits 2', () => {
    const result = spawnSync(
      process.execPath,
      [SCRIPT, '--glab-bin', '/nonexistent/glab', '--issue', '305', '--dep-issues', '303,304'],
      { encoding: 'utf8', timeout: 10_000 }
    );

    expect(result.status).toBe(2);
  });

  // ── Test 9: streak=2, both closed → no flip-ready yet ─────────────────────

  it('streak=2 (both closed) → tick posted but no flip-ready triggered', () => {
    writeIssueFixture(tmp, '303', 'closed');
    writeIssueFixture(tmp, '304', 'closed');
    writeIssueFixture(tmp, '305', 'opened');

    // Only 1 prior umstellungs-bereit tick (so new tick makes streak=2, not 3)
    writeCommentsFixture(tmp, '305', [makeTick('umstellungs-bereit', '2026-04-27')]);

    const result = runWatcher(
      ['--issue', '305', '--dep-issues', '303,304', '--dry-run'],
      { fixtureDir: tmp }
    );

    expect(result.status).toBe(0);

    const actions = parseActions(result.stdout);
    const tickAction = actions.find((a) => a.action === 'tick-posted');
    expect(tickAction).toBeDefined();
    expect(tickAction.streak).toBe(2);

    const flipAction = actions.find((a) => a.action === 'flip-ready-posted');
    expect(flipAction).toBeUndefined();
  });

  // ── Test 10: comment body contains today's date and streak N/3 ────────────

  it('comment body contains today YYYY-MM-DD and streak N/3 format', () => {
    writeIssueFixture(tmp, '303', 'closed');
    writeIssueFixture(tmp, '304', 'closed');
    writeIssueFixture(tmp, '305', 'opened');
    writeCommentsFixture(tmp, '305', []);

    const result = runWatcher(
      ['--issue', '305', '--dep-issues', '303,304', '--dry-run'],
      { fixtureDir: tmp }
    );

    expect(result.status).toBe(0);

    const actions = parseActions(result.stdout);
    const dryRunAction = actions.find((a) => a.action === 'comment-dry-run');
    expect(dryRunAction).toBeDefined();

    const today = new Date().toISOString().slice(0, 10);
    expect(dryRunAction.body).toContain(today);
    // Streak format: N/3
    expect(dryRunAction.body).toMatch(/\d+\/3/);
  });

  // ── Test 11: streak resets when a warn tick appears ───────────────────────

  it('streak resets to 0 when latest tick is bleibt warn', () => {
    writeIssueFixture(tmp, '303', 'opened'); // still open → warn verdict
    writeIssueFixture(tmp, '304', 'opened');
    writeIssueFixture(tmp, '305', 'opened');

    // 2 prior ready ticks, then 1 warn tick — streak should be 0 now
    writeCommentsFixture(tmp, '305', [
      makeTick('umstellungs-bereit', '2026-04-25'),
      makeTick('umstellungs-bereit', '2026-04-26'),
      makeTick('bleibt warn', '2026-04-27'),
    ]);

    const result = runWatcher(
      ['--issue', '305', '--dep-issues', '303,304', '--dry-run'],
      { fixtureDir: tmp }
    );

    expect(result.status).toBe(0);

    const actions = parseActions(result.stdout);
    const tickAction = actions.find((a) => a.action === 'tick-posted');
    expect(tickAction).toBeDefined();
    expect(tickAction.streak).toBe(0); // warn, so streak stays at 0
    expect(tickAction.verdict).toBe('bleibt warn');
  });

  // ── Test 12: --verbose flag passes without error ───────────────────────────

  it('--verbose flag passes without error and produces some stderr output', () => {
    writeIssueFixture(tmp, '303', 'closed');
    writeIssueFixture(tmp, '304', 'closed');
    writeIssueFixture(tmp, '305', 'opened');
    writeCommentsFixture(tmp, '305', []);

    const result = runWatcher(
      ['--issue', '305', '--dep-issues', '303,304', '--dry-run', '--verbose'],
      { fixtureDir: tmp }
    );

    expect(result.status).toBe(0);
    // Verbose mode emits diagnostic lines
    expect(result.stderr).toContain('[vault-watcher]');
  });
});
