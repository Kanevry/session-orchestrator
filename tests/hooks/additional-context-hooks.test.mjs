/**
 * tests/hooks/additional-context-hooks.test.mjs
 *
 * Tests for hookSpecificOutput.additionalContext emissions (#428 adjusted).
 *
 * Note: continueOnBlock is NOT applicable here. These hooks use the
 * hookSpecificOutput.additionalContext field — a surfacing mechanism that
 * passes corrective context to Claude at the next turn boundary.
 *
 * Covered:
 *   post-tool-batch-wave-signal.mjs
 *     - emits the complete hookSpecificOutput envelope on wave-complete
 *     - emits no stdout for non-wave-complete and empty-object payloads
 *     - preserves distinct wave-lifecycle event and boundary contracts
 *
 *   post-tool-failure-corrective-context.mjs
 *     - emits the complete hookSpecificOutput.additionalContext envelope
 *     - caps context at 500 chars and strips control characters (SEC-016)
 *     - preserves the unknown-tool fallback for empty/missing-tool payloads
 *
 *   post-edit-validate.mjs
 *     - includes remediation in failed typecheck JSONL output
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import path from 'node:path';

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '../..');

// ---------------------------------------------------------------------------
// Temporary project directory (wave-signal and failure hooks write to
// .orchestrator/current-session.json inside CLAUDE_PROJECT_DIR)
// ---------------------------------------------------------------------------

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ac-hooks-test-'));
});

afterEach(() => {
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function runHook(hookRelPath, inputObject) {
  return spawnSync(
    process.execPath,
    [path.join(PLUGIN_ROOT, hookRelPath)],
    {
      input: JSON.stringify(inputObject),
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: tmp,
        SO_HOOK_PROFILE: 'full',
        SO_DISABLED_HOOKS: '',
      },
    },
  );
}

/** Read parsed events.jsonl records written into the tmp CLAUDE_PROJECT_DIR. */
function readEvents() {
  const p = join(tmp, '.orchestrator', 'metrics', 'events.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// post-tool-batch-wave-signal.mjs
// ---------------------------------------------------------------------------

describe('post-tool-batch-wave-signal.mjs additionalContext (#428 adjusted)', () => {
  it('emits the complete PostToolBatch additionalContext envelope on wave-complete', () => {
    const result = runHook('hooks/post-tool-batch-wave-signal.mjs', {
      wave_signal: 'wave-complete',
      wave_number: 3,
      next_wave_role: 'quality-reviewer',
      batch_id: 'b-001',
      batch_size: 7,
      batch_completed_at: '2026-05-17T10:00:00.000Z',
    });

    expect({
      status: result.status,
      stdout: JSON.parse(result.stdout),
    }).toEqual({
      status: 0,
      stdout: {
        hookSpecificOutput: {
          hookEventName: 'PostToolBatch',
          additionalContext:
            'Wave 3 complete. Next agent role: quality-reviewer. Batch b-001 (7 tools) resolved at 2026-05-17T10:00:00.000Z.',
        },
      },
    });
  });

  it.each([
    {
      name: 'a non-wave-complete signal',
      input: { batch_id: 'b-002', batch_size: 3 },
    },
    {
      name: 'an empty-object payload',
      input: {},
    },
  ])('produces no stdout and exits 0 for $name', ({ input }) => {
    const result = runHook('hooks/post-tool-batch-wave-signal.mjs', input);

    expect({ status: result.status, stdout: result.stdout.trim() }).toEqual({
      status: 0,
      stdout: '',
    });
  });
});

// ---------------------------------------------------------------------------
// post-tool-batch-wave-signal.mjs — wave-lifecycle events (#610)
// ---------------------------------------------------------------------------

describe('post-tool-batch-wave-signal.mjs wave-lifecycle events (#610)', () => {
  it('emits orchestrator.wave.completed with metadata and an ISO timestamp', () => {
    const result = runHook('hooks/post-tool-batch-wave-signal.mjs', {
      wave_signal: 'wave-complete',
      wave_number: 3,
      next_wave_role: 'quality-reviewer',
      batch_id: 'b-001',
      batch_size: 7,
    });
    expect(result.status).toBe(0);
    const wave = readEvents().find((e) => e.event === 'orchestrator.wave.completed');
    expect(wave).toEqual(
      expect.objectContaining({
        event: 'orchestrator.wave.completed',
        wave_number: 3,
        next_wave_role: 'quality-reviewer',
      }),
    );
    expect(Number.isNaN(Date.parse(wave.timestamp))).toBe(false);
  });

  it('emits orchestrator.wave.started on wave-start signal', () => {
    const result = runHook('hooks/post-tool-batch-wave-signal.mjs', {
      wave_signal: 'wave-start',
      wave_number: 2,
      batch_id: 'b-010',
      batch_size: 5,
    });
    expect(result.status).toBe(0);
    const wave = readEvents().find((e) => e.event === 'orchestrator.wave.started');
    expect(wave).toBeDefined();
    expect(wave.wave_number).toBe(2);
  });

  it('emits no orchestrator.wave.* event when wave_signal is absent', () => {
    const result = runHook('hooks/post-tool-batch-wave-signal.mjs', { batch_id: 'b-002', batch_size: 3 });
    expect(result.status).toBe(0);
    const waveEvents = readEvents().filter(
      (e) => typeof e.event === 'string' && e.event.startsWith('orchestrator.wave.'),
    );
    expect(waveEvents).toEqual([]);
  });

  it('wave_number:0 is threaded and next_wave_role key is absent when omitted (#613)', () => {
    // Boundary: wave_number 0 is a valid number — it must be emitted, NOT dropped
    // as a falsy value (a `wave_number > 0` truthiness check would lose it). And
    // an OMITTED next_wave_role must be ABSENT from the payload (conditional-spread
    // contract), never present-as-null/undefined (a key with undefined value would
    // round-trip through JSON as absent, but emitting it would still be wrong shape).
    const result = runHook('hooks/post-tool-batch-wave-signal.mjs', {
      wave_signal: 'wave-complete',
      wave_number: 0,
      batch_id: 'b-zero',
      batch_size: 2,
    });
    expect(result.status).toBe(0);
    const wave = readEvents().find((e) => e.event === 'orchestrator.wave.completed');
    expect(wave).toBeDefined();
    expect(wave.wave_number).toBe(0);
    // next_wave_role was omitted from the input → key must not exist on the record.
    expect(Object.prototype.hasOwnProperty.call(wave, 'next_wave_role')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// post-tool-failure-corrective-context.mjs
// ---------------------------------------------------------------------------

describe('post-tool-failure-corrective-context.mjs additionalContext (#428 adjusted)', () => {
  it('emits the complete PostToolUseFailure additionalContext envelope', () => {
    const result = runHook('hooks/post-tool-failure-corrective-context.mjs', {
      tool_name: 'Bash',
      exit_code: 1,
      error: 'command not found: tsgo',
    });

    expect({
      status: result.status,
      stdout: JSON.parse(result.stdout),
    }).toEqual({
      status: 0,
      stdout: {
        hookSpecificOutput: {
          hookEventName: 'PostToolUseFailure',
          additionalContext:
            'Tool failure: Bash (exit 1). Error: command not found: tsgo Common cause: command or binary not on PATH. Try: verify the binary is installed and `which <cmd>` resolves it.',
        },
      },
    });
  });

  it('caps additionalContext at 500 characters when tool metadata is oversized', () => {
    const result = runHook('hooks/post-tool-failure-corrective-context.mjs', {
      tool_name: 'T'.repeat(1000),
      exit_code: 1,
      error: 'failed',
    });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput.additionalContext).toHaveLength(500);
  });

  it.each([
    {
      name: 'newlines',
      error: 'line one\nline two\nline three',
      forbidden: '\n',
    },
    {
      name: 'carriage returns',
      error: 'windows\r\nline\r\nending',
      forbidden: '\r',
    },
    {
      name: 'ANSI escape bytes',
      error: 'malicious [31mERROR[0m injection attempt',
      forbidden: '',
    },
  ])('strips $name from error before surfacing additionalContext (SEC-016)', ({ error, forbidden }) => {
    const result = runHook('hooks/post-tool-failure-corrective-context.mjs', {
      tool_name: 'Bash',
      exit_code: 1,
      error,
    });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput.additionalContext).not.toContain(forbidden);
  });

  it.each([
    {
      name: 'an empty-object payload',
      input: {},
      additionalContext:
        'Tool failure: unknown tool. Common cause: tool invocation failed. Try: check the error details above and retry with corrected parameters.',
    },
    {
      name: 'a payload without tool_name',
      input: { exit_code: 1, error: 'something failed' },
      additionalContext:
        'Tool failure: unknown tool (exit 1). Error: something failed Common cause: tool invocation failed. Try: check the error details above and retry with corrected parameters.',
    },
  ])('emits the unknown-tool fallback for $name', ({ input, additionalContext }) => {
    const result = runHook('hooks/post-tool-failure-corrective-context.mjs', input);

    expect({
      status: result.status,
      hookSpecificOutput: JSON.parse(result.stdout).hookSpecificOutput,
    }).toEqual({
      status: 0,
      hookSpecificOutput: {
        hookEventName: 'PostToolUseFailure',
        additionalContext,
      },
    });
  });
});

// ---------------------------------------------------------------------------
// post-edit-validate.mjs remediation contract
// ---------------------------------------------------------------------------

describe('post-edit-validate.mjs remediation output', () => {
  it('includes remediation field in stderr JSONL when typecheck fails', async () => {
    // This test verifies that post-edit-validate emits the `remediation` field
    // defined in the emitResult() contract when status is 'fail'.
    // We configure a typecheck command that always exits non-zero via Session Config.
    const { promises: fsp } = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'pev-remediation-'));

    try {
      // Create a minimal fake typecheck script that exits 1
      const fakeTc = join(dir, 'fake-tc.mjs');
      await fsp.writeFile(fakeTc, `#!/usr/bin/env node\nprocess.stderr.write('TS error: bad type\\n'); process.exit(1);\n`, { mode: 0o755 });
      await fsp.mkdir(join(dir, '.claude'), { recursive: true });
      await fsp.writeFile(
        join(dir, 'CLAUDE.md'),
        `# Test\n\n## Session Config\ntypecheck-command: ${process.execPath} ${fakeTc}\n`,
      );

      const result = spawnSync(
        process.execPath,
        [path.join(PLUGIN_ROOT, 'hooks/post-edit-validate.mjs')],
        {
          input: JSON.stringify({
            tool_name: 'Edit',
            tool_input: { file_path: join(dir, 'src', 'app.ts') },
          }),
          encoding: 'utf8',
          timeout: 15_000,
          env: {
            ...process.env,
            CLAUDE_PROJECT_DIR: dir,
            SO_HOOK_PROFILE: 'full',
            SO_DISABLED_HOOKS: '',
          },
        },
      );

      expect(result.status).toBe(0);
      const lines = result.stderr.split('\n').filter((l) => l.trim());
      expect(lines.length).toBeGreaterThanOrEqual(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.check).toBe('typecheck');
      expect(parsed.status).toBe('fail');
      // The remediation field must be present and non-empty on fail
      expect(typeof parsed.remediation).toBe('string');
      expect(parsed.remediation.length).toBeGreaterThan(0);
      expect(parsed.remediation).toContain('npm run typecheck');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
