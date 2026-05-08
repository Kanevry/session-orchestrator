/**
 * tests/hooks/post-tool-failure.test.mjs
 *
 * Tests for hooks/post-tool-failure-corrective-context.mjs (#342).
 *
 * Strategy: spawn the hook via node with stdin piped, CLAUDE_PROJECT_DIR
 * pointing to a tmp sandbox. Assert:
 *   1. Happy path — valid payload → writes corrective_context entry to
 *      current-session.json, exits 0.
 *   2. Malformed stdin — exits 0 (informational hook never throws).
 *   3. Idempotency — two invocations produce a valid JSON file with 2 entries.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOOK = new URL('../../hooks/post-tool-failure-corrective-context.mjs', import.meta.url).pathname;
const SESSION_REL = join('.orchestrator', 'current-session.json');

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ptf-test-'));
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
      // Ensure hook is not disabled
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

describe('post-tool-failure-corrective-context hook', () => {
  it('happy path: valid payload writes corrective_context entry and exits 0', () => {
    const payload = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'ls /nonexistent' },
      error: 'No such file or directory',
      exit_code: 1,
    });

    const result = runHook(payload);
    expect(result.status).toBe(0);

    const session = readSessionFile();
    expect(Array.isArray(session.corrective_context)).toBe(true);
    expect(session.corrective_context).toHaveLength(1);

    const entry = session.corrective_context[0];
    expect(entry.tool_name).toBe('Bash');
    expect(entry.exit_code).toBe(1);
    expect(typeof entry.error_summary).toBe('string');
    expect(entry.error_summary).toContain('No such file');
    expect(typeof entry.timestamp).toBe('string');
  });

  it('malformed stdin (not JSON): exits 0 and writes a null-field entry', () => {
    const result = runHook('this is not json at all!!!');
    expect(result.status).toBe(0);

    // Hook still writes a record with null fields — current-session.json must exist
    const session = readSessionFile();
    expect(Array.isArray(session.corrective_context)).toBe(true);
    expect(session.corrective_context).toHaveLength(1);

    const entry = session.corrective_context[0];
    expect(entry.tool_name).toBeNull();
    expect(entry.exit_code).toBeNull();
    expect(entry.error_summary).toBeNull();
  });

  it('idempotency: two invocations produce two entries in a valid JSON file', () => {
    const payload = JSON.stringify({
      tool_name: 'Write',
      error: 'Permission denied',
      exit_code: 2,
    });

    runHook(payload);
    runHook(payload);

    const session = readSessionFile();
    expect(Array.isArray(session.corrective_context)).toBe(true);
    expect(session.corrective_context).toHaveLength(2);

    // Both entries must be well-formed
    for (const entry of session.corrective_context) {
      expect(entry.tool_name).toBe('Write');
      expect(entry.exit_code).toBe(2);
    }
  });
});
