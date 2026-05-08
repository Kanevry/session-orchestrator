/**
 * tests/hooks/cwd-change-restore.test.mjs
 *
 * Tests for hooks/cwd-change-restore.mjs (#342).
 *
 * Strategy: spawn the hook via node with stdin piped, CLAUDE_PROJECT_DIR
 * pointing to a tmp sandbox. Assert:
 *   1. Happy path — valid {previous_cwd, new_cwd} payload → appends record to
 *      cwd_changes array in current-session.json, exits 0.
 *   2. Malformed stdin — exits 0 and writes a null-field entry.
 *   3. Idempotency — two invocations accumulate two entries in valid JSON.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOOK = new URL('../../hooks/cwd-change-restore.mjs', import.meta.url).pathname;
const SESSION_REL = join('.orchestrator', 'current-session.json');

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cwd-hook-test-'));
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

describe('cwd-change-restore hook', () => {
  it('happy path: valid payload appends cwd_changes entry and exits 0', () => {
    const payload = JSON.stringify({
      previous_cwd: '/Users/ada/Projects/session-orchestrator',
      new_cwd: '/tmp/some-worktree',
    });

    const result = runHook(payload);
    expect(result.status).toBe(0);

    const session = readSessionFile();
    expect(Array.isArray(session.cwd_changes)).toBe(true);
    expect(session.cwd_changes).toHaveLength(1);

    const entry = session.cwd_changes[0];
    expect(entry.previous_cwd).toBe('/Users/ada/Projects/session-orchestrator');
    expect(entry.new_cwd).toBe('/tmp/some-worktree');
    expect(typeof entry.timestamp).toBe('string');
  });

  it('malformed stdin: exits 0 and writes a null-field entry', () => {
    const result = runHook('not json at all');
    expect(result.status).toBe(0);

    const session = readSessionFile();
    expect(Array.isArray(session.cwd_changes)).toBe(true);
    expect(session.cwd_changes).toHaveLength(1);

    const entry = session.cwd_changes[0];
    expect(entry.previous_cwd).toBeNull();
    expect(entry.new_cwd).toBeNull();
    expect(typeof entry.timestamp).toBe('string');
  });

  it('idempotency: two invocations accumulate two entries in a valid JSON file', () => {
    const payload1 = JSON.stringify({
      previous_cwd: '/repo',
      new_cwd: '/tmp/worktree-A',
    });
    const payload2 = JSON.stringify({
      previous_cwd: '/tmp/worktree-A',
      new_cwd: '/repo',
    });

    runHook(payload1);
    runHook(payload2);

    const session = readSessionFile();
    expect(Array.isArray(session.cwd_changes)).toBe(true);
    expect(session.cwd_changes).toHaveLength(2);

    expect(session.cwd_changes[0].new_cwd).toBe('/tmp/worktree-A');
    expect(session.cwd_changes[1].new_cwd).toBe('/repo');

    // Both entries must have timestamps (ISO strings)
    for (const entry of session.cwd_changes) {
      expect(typeof entry.timestamp).toBe('string');
      expect(entry.timestamp.length).toBeGreaterThan(0);
    }
  });
});
