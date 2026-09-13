/**
 * tests/unit/hook-issue-budget-refund.test.mjs
 *
 * Vitest unit tests for hooks/post-bash-issue-budget-refund.mjs (#1347).
 *
 * THE BUG (issue #1347): the budget slot is booked in PreToolUse, i.e. BEFORE
 * the command runs. When `glab issue create` failed (network, rejected label,
 * expired auth) and the coordinator retried, the SAME issue consumed two slots
 * — with `max-per-session: 12` + `mode: strict` that pushed a legitimate issue
 * into overflow parking. No test in the suite charged a slot and then observed a
 * FAILED command, so nothing was red.
 *
 * Strategy mirrors tests/unit/hook-issue-budget.test.mjs: spawn both real hooks
 * as subprocesses, pipe JSON on stdin, then read the production counter file
 * through the production path helper. No mocking of production logic.
 *
 * Exit-code / stdout contract: the refund hook is post-hoc — it has no decision
 * to make, so EVERY path exits 0 with EMPTY stdout (an envelope there would be
 * read by Claude as a decision about a tool that already ran).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { budgetStatePath } from '@lib/issue-budget.mjs';

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '../..');
const CHARGE_HOOK = path.join(PLUGIN_ROOT, 'hooks/pre-bash-issue-budget.mjs');
const REFUND_HOOK = path.join(PLUGIN_ROOT, 'hooks/post-bash-issue-budget-refund.mjs');

const SESSION = 'refund-session-001';
const CREATE = 'glab issue create --title "flaky" --label "type::bug,priority::medium"';

const tmpDirs = [];

afterEach(async () => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

async function mkProject({ mode = 'strict', max = 3 } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'issue-budget-refund-'));
  tmpDirs.push(dir);
  const body = [
    '# Fixture repo',
    '',
    '## Session Config',
    '',
    'waves: 5',
    'issue-budget:',
    `  max-per-session: ${max}`,
    `  mode: ${mode}`,
    '  overflow: collect-issue',
    '',
  ].join('\n');
  await fs.writeFile(path.join(dir, 'CLAUDE.md'), body, 'utf8');
  return dir;
}

/**
 * Same env discipline as the charge-hook suite (#1151): a live operator session
 * exports `CLAUDE_CODE_SESSION_ID`, which both hooks read as their session-id
 * fallback — leaving it in place would key the fixture's counter to the
 * operator's real session and make the verdict depend on where the suite ran.
 */
function runHook(hook, { projectDir, stdin }) {
  const env = {
    ...process.env,
    CLAUDE_PROJECT_DIR: projectDir,
    CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
    SO_HOOK_PROFILE: 'full',
  };
  delete env.CLAUDE_CODE_SESSION_ID;

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [hook], {
      cwd: projectDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(stdin));
  });
}

const charge = (projectDir, command = CREATE) =>
  runHook(CHARGE_HOOK, {
    projectDir,
    stdin: { session_id: SESSION, tool_name: 'Bash', tool_input: { command } },
  });

const failure = (projectDir, { command = CREATE, toolUseId = 'toolu_fail_1' } = {}) =>
  runHook(REFUND_HOOK, {
    projectDir,
    stdin: {
      session_id: SESSION,
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_input: { command },
      tool_use_id: toolUseId,
      exit_code: 1,
      error: 'fatal: could not read Username for https://gitlab.example',
    },
  });

/** A refund-hook delivery with an EXPLICIT payload shape (signal-isolation). */
const deliver = (projectDir, stdin) =>
  runHook(REFUND_HOOK, {
    projectDir,
    stdin: { session_id: SESSION, tool_name: 'Bash', tool_input: { command: CREATE }, ...stdin },
  });

const success = (projectDir, { command = CREATE } = {}) =>
  runHook(REFUND_HOOK, {
    projectDir,
    stdin: {
      session_id: SESSION,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command },
      tool_use_id: 'toolu_ok_1',
      tool_response: { is_error: false, stdout: 'https://gitlab.example/g/p/-/issues/7' },
    },
  });

async function readCount(projectDir) {
  const file = budgetStatePath(projectDir, SESSION);
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

describe('post-bash-issue-budget-refund.mjs (#1347)', () => {
  it('leaves the counter unchanged across a charged-then-failed create', async () => {
    const dir = await mkProject();
    await charge(dir);
    expect((await readCount(dir)).count).toBe(1);

    const res = await failure(dir);
    expect({ code: res.code, stdout: res.stdout }).toEqual({ code: 0, stdout: '' });
    expect((await readCount(dir)).count).toBe(0);
  });

  it('is a no-op after a SUCCESSFUL create — the slot stays spent', async () => {
    const dir = await mkProject();
    await charge(dir);
    const res = await success(dir);
    expect({ code: res.code, stdout: res.stdout, stderr: res.stderr }).toEqual({
      code: 0,
      stdout: '',
      stderr: '',
    });
    expect((await readCount(dir)).count).toBe(1);
  });

  // The charge record is REMOVED when its refund is honoured, so a re-delivered
  // failure of the SAME call finds nothing. NAMED CEILING (BV-004): two separate
  // Bash calls running the byte-identical create are indistinguishable under the
  // fallback key, so a re-delivery can consume the other call's record — bounded
  // by construction at the number of charges actually recorded, never beyond it.
  it('refunds one charged create once, and a re-delivered failure gives back nothing', async () => {
    const dir = await mkProject({ max: 5 });
    await charge(dir);
    await charge(dir, 'glab issue create --title "second"');
    expect((await readCount(dir)).count).toBe(2);

    await failure(dir, { toolUseId: 'toolu_dup' });
    await failure(dir, { toolUseId: 'toolu_dup' });
    expect((await readCount(dir)).count).toBe(1);
  });

  // Sec-M1 (exploit measured): `glab issue create --title X && false` CREATES the
  // issue and exits 1. `isFailure()` judges the whole Bash call, so the first cut
  // refunded the slot of a create that had succeeded.
  it('refuses to refund a chain whose failure is not attributable to the create', async () => {
    const dir = await mkProject();
    const chain = `${CREATE} && false`;
    await charge(dir, chain);
    expect((await readCount(dir)).count).toBe(1);

    const res = await failure(dir, { command: chain, toolUseId: 'toolu_chain_decoy' });
    expect(res.code).toBe(0);
    expect(res.stderr).toContain('chain-not-attributable');
    expect((await readCount(dir)).count).toBe(1);
  });

  // H2 / Sec-M2 (the drain): at the cap the pre-hook PARKS the create and denies
  // WITHOUT charging, yet the failure event still fires. Retrying a DENIED create
  // must not mint slots — measured against the first cut: cap 3, three retries,
  // `count` 0 with the parked record still in `overflow[]`.
  it('refunds nothing for a create parked at the cap, however often it is retried', async () => {
    const dir = await mkProject({ max: 1 });
    await charge(dir);
    await charge(dir, 'glab issue create --title "parked"');
    const parked = await readCount(dir);
    expect({ count: parked.count, overflow: parked.overflow.length }).toEqual({ count: 1, overflow: 1 });

    for (const id of ['toolu_r1', 'toolu_r2', 'toolu_r3']) {
      await failure(dir, { command: 'glab issue create --title "parked"', toolUseId: id });
    }
    const after = await readCount(dir);
    expect({ count: after.count, overflow: after.overflow.length }).toEqual({ count: 1, overflow: 1 });
  });

  it('refunds the exempt counter for an exempt create, leaving count untouched', async () => {
    const dir = await mkProject();
    const exemptCmd = 'glab issue create --title "[Carryover] agent FAILED follow-up"';
    await charge(dir);
    await charge(dir, exemptCmd);
    expect(await readCount(dir)).toMatchObject({ count: 1, exempt: 1 });

    await failure(dir, { command: exemptCmd, toolUseId: 'toolu_exempt' });
    expect(await readCount(dir)).toMatchObject({ count: 1, exempt: 0 });
  });

  // QA-H1: all six original tests fed a fixture carrying THREE failure signals at
  // once, so the `tool_response.is_error` clause was a surviving mutant and a
  // payload with none of them was a silent no-op.
  describe('failure signals, one at a time', () => {
    it.each([
      ['exit_code only', { hook_event_name: 'PostToolUseFailure', exit_code: 1 }],
      ['error only', { hook_event_name: 'PostToolUseFailure', error: 'auth failed' }],
      ['tool_response.is_error only, exit_code 0', {
        hook_event_name: 'PostToolUse', exit_code: 0, tool_response: { is_error: true },
      }],
      // The Cursor bridge forwards `is_error` at TOP level and no exit_code/error
      // at all (scripts/lib/cursor-hook-bridge.mjs normalizeCursorHookPayload).
      ['top-level is_error only (Cursor bridge shape)', {
        hook_event_name: 'PostToolUseFailure', cursor_event_name: 'postToolUseFailure', is_error: true,
      }],
    ])('refunds on %s', async (_label, payload) => {
      const dir = await mkProject();
      await charge(dir);
      const res = await deliver(dir, payload);
      expect(res.code).toBe(0);
      expect((await readCount(dir)).count).toBe(0);
    });

    it('no-ops LOUDLY on a failure event carrying no failure field', async () => {
      const dir = await mkProject();
      await charge(dir);
      const res = await deliver(dir, {
        hook_event_name: 'PostToolUseFailure',
        cursor_event_name: 'postToolUseFailure',
      });
      expect(res.code).toBe(0);
      expect(res.stdout).toBe('');
      expect(res.stderr).toContain('carried no failure field');
      expect((await readCount(dir)).count).toBe(1);
    });
  });

  it('never drives the counter below zero when nothing was charged', async () => {
    const dir = await mkProject();
    const res = await failure(dir);
    expect(res.code).toBe(0);
    const state = await readCount(dir);
    expect(state === null ? 0 : state.count).toBe(0);
  });

  it('refunds one slot per issue-create statement of a failed chain', async () => {
    const dir = await mkProject({ max: 5 });
    const chain = `${CREATE} && glab issue create --title "second" --label "type::bug,priority::low"`;
    await charge(dir, chain);
    expect((await readCount(dir)).count).toBe(2);

    await failure(dir, { command: chain, toolUseId: 'toolu_chain' });
    expect((await readCount(dir)).count).toBe(0);
  });

  it('ignores a failed command that creates no issue', async () => {
    const dir = await mkProject();
    await charge(dir);
    const res = await failure(dir, { command: 'glab mr create --title x' });
    expect({ code: res.code, stdout: res.stdout, stderr: res.stderr }).toEqual({
      code: 0,
      stdout: '',
      stderr: '',
    });
    expect((await readCount(dir)).count).toBe(1);
  });
});
