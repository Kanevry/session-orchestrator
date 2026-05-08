/**
 * tests/hooks/post-tool-batch.test.mjs
 *
 * Tests for hooks/post-tool-batch-wave-signal.mjs (#342).
 *
 * Strategy: spawn the hook via node with stdin piped, CLAUDE_PROJECT_DIR
 * pointing to a tmp sandbox. Assert:
 *   1. Happy path — valid payload → writes last_batch signal to
 *      current-session.json, exits 0.
 *   2. Malformed stdin — exits 0 and writes a null-field last_batch.
 *   3. Idempotency — two invocations; last_batch reflects the second call.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOOK = new URL('../../hooks/post-tool-batch-wave-signal.mjs', import.meta.url).pathname;
const SESSION_REL = join('.orchestrator', 'current-session.json');

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ptb-test-'));
});

afterEach(() => {
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

function runHook(stdinJson) {
  return spawnSync(process.execPath, [HOOK], {
    input: stdinJson,
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: tmp,
      SO_HOOK_PROFILE: 'full',
      SO_DISABLED_HOOKS: '',
    },
    timeout: 10_000,
  });
}

function readSessionFile() {
  const filePath = join(tmp, SESSION_REL);
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

describe('post-tool-batch-wave-signal hook', () => {
  it('happy path: valid payload writes last_batch signal and exits 0', () => {
    const payload = JSON.stringify({
      batch_id: 'wave3-batch1',
      batch_size: 6,
      batch_completed_at: '2026-05-08T10:05:00.000Z',
      agent_id: 'coordinator',
      parent_session_id: 'main-2026-05-08-deep',
    });

    const result = runHook(payload);
    expect(result.status).toBe(0);

    const session = readSessionFile();
    expect(typeof session.last_batch).toBe('object');
    expect(session.last_batch).not.toBeNull();

    const lb = session.last_batch;
    expect(lb.batch_id).toBe('wave3-batch1');
    expect(lb.batch_size).toBe(6);
    expect(lb.completed_at).toBe('2026-05-08T10:05:00.000Z');
    expect(lb.agent_id).toBe('coordinator');
    expect(lb.parent_session_id).toBe('main-2026-05-08-deep');
  });

  it('malformed stdin: exits 0 and writes a null-field last_batch', () => {
    const result = runHook('{{not valid json}}');
    expect(result.status).toBe(0);

    const session = readSessionFile();
    expect(typeof session.last_batch).toBe('object');
    const lb = session.last_batch;
    expect(lb.batch_id).toBeNull();
    expect(lb.batch_size).toBeNull();
  });

  it('idempotency: second invocation overwrites last_batch with the new values', () => {
    const payload1 = JSON.stringify({ batch_id: 'batch-A', batch_size: 2 });
    const payload2 = JSON.stringify({ batch_id: 'batch-B', batch_size: 4 });

    runHook(payload1);
    runHook(payload2);

    const session = readSessionFile();
    // last_batch is always overwritten — only the second value survives
    expect(session.last_batch.batch_id).toBe('batch-B');
    expect(session.last_batch.batch_size).toBe(4);
    // The resulting file must be valid JSON (no corruption)
    expect(typeof session.last_batch.completed_at).toBe('string');
  });
});
