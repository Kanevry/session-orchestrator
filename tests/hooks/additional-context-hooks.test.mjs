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
 *     - emits hookSpecificOutput on wave-complete signal
 *     - stdout is empty (no additionalContext) for non-wave-complete signals
 *     - exits 0 with empty stdin (no wave-signal)
 *
 *   post-tool-failure-corrective-context.mjs
 *     - emits hookSpecificOutput.additionalContext on tool failure
 *     - additionalContext is capped at 500 chars
 *     - newlines in error are stripped from additionalContext (SEC-016)
 *     - hookEventName is PostToolUseFailure
 *
 *   post-edit-validate.mjs
 *     - exits 0 for non-TS files (smoke test — hook never blocks)
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
  it('exits 0 on wave-complete signal', () => {
    const result = runHook('hooks/post-tool-batch-wave-signal.mjs', {
      wave_signal: 'wave-complete',
      wave_number: 3,
      next_wave_role: 'quality-reviewer',
      batch_id: 'b-001',
      batch_size: 7,
      completed_at: '2026-05-17T10:00:00.000Z',
    });
    expect(result.status).toBe(0);
  });

  it('emits hookSpecificOutput.hookEventName = PostToolBatch on wave-complete signal', () => {
    const result = runHook('hooks/post-tool-batch-wave-signal.mjs', {
      wave_signal: 'wave-complete',
      wave_number: 3,
      next_wave_role: 'quality-reviewer',
      batch_id: 'b-001',
      batch_size: 7,
      completed_at: '2026-05-17T10:00:00.000Z',
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PostToolBatch');
  });

  it('emits additionalContext containing wave number on wave-complete signal', () => {
    const result = runHook('hooks/post-tool-batch-wave-signal.mjs', {
      wave_signal: 'wave-complete',
      wave_number: 3,
      next_wave_role: 'quality-reviewer',
      batch_id: 'b-001',
      batch_size: 7,
      completed_at: '2026-05-17T10:00:00.000Z',
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput.additionalContext).toContain('Wave 3');
  });

  it('emits additionalContext containing next agent role on wave-complete signal', () => {
    const result = runHook('hooks/post-tool-batch-wave-signal.mjs', {
      wave_signal: 'wave-complete',
      wave_number: 5,
      next_wave_role: 'test-writer',
      batch_id: 'b-007',
      batch_size: 4,
      completed_at: '2026-05-17T12:00:00.000Z',
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput.additionalContext).toContain('test-writer');
  });

  it('produces no stdout output when wave_signal is not wave-complete', () => {
    const result = runHook('hooks/post-tool-batch-wave-signal.mjs', {
      batch_id: 'b-002',
      batch_size: 3,
    });
    expect(result.status).toBe(0);
    // Non-wave-complete payloads must not emit any hookSpecificOutput
    expect(result.stdout.trim()).toBe('');
  });

  it('exits 0 with empty-object stdin (no wave-signal field)', () => {
    const result = runHook('hooks/post-tool-batch-wave-signal.mjs', {});
    expect(result.status).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// post-tool-batch-wave-signal.mjs — wave-lifecycle events (#610)
// ---------------------------------------------------------------------------

describe('post-tool-batch-wave-signal.mjs wave-lifecycle events (#610)', () => {
  it('emits orchestrator.wave.completed on wave-complete signal', () => {
    const result = runHook('hooks/post-tool-batch-wave-signal.mjs', {
      wave_signal: 'wave-complete',
      wave_number: 3,
      next_wave_role: 'quality-reviewer',
      batch_id: 'b-001',
      batch_size: 7,
    });
    expect(result.status).toBe(0);
    const wave = readEvents().find((e) => e.event === 'orchestrator.wave.completed');
    expect(wave).toBeDefined();
    expect(wave.wave_number).toBe(3);
    expect(wave.next_wave_role).toBe('quality-reviewer');
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

  it('wave.completed record carries a parseable ISO timestamp', () => {
    runHook('hooks/post-tool-batch-wave-signal.mjs', { wave_signal: 'wave-complete', wave_number: 4 });
    const wave = readEvents().find((e) => e.event === 'orchestrator.wave.completed');
    expect(wave).toBeDefined();
    expect(Number.isNaN(Date.parse(wave.timestamp))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// post-tool-failure-corrective-context.mjs
// ---------------------------------------------------------------------------

describe('post-tool-failure-corrective-context.mjs additionalContext (#428 adjusted)', () => {
  it('exits 0 on a Bash tool failure', () => {
    const result = runHook('hooks/post-tool-failure-corrective-context.mjs', {
      tool_name: 'Bash',
      exit_code: 1,
      error: 'command not found: tsgo',
    });
    expect(result.status).toBe(0);
  });

  it('emits hookSpecificOutput.hookEventName = PostToolUseFailure', () => {
    const result = runHook('hooks/post-tool-failure-corrective-context.mjs', {
      tool_name: 'Bash',
      exit_code: 1,
      error: 'command not found: tsgo',
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PostToolUseFailure');
  });

  it('additionalContext contains the failing tool name', () => {
    const result = runHook('hooks/post-tool-failure-corrective-context.mjs', {
      tool_name: 'Bash',
      exit_code: 1,
      error: 'command not found: tsgo',
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput.additionalContext).toContain('Bash');
  });

  it('additionalContext is capped at 500 characters', () => {
    // Send a very long error to trigger the 500-char cap
    const longError = 'x'.repeat(2000);
    const result = runHook('hooks/post-tool-failure-corrective-context.mjs', {
      tool_name: 'Bash',
      exit_code: 1,
      error: longError,
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput.additionalContext.length).toBeLessThanOrEqual(500);
  });

  it('strips newlines from error field before surfacing to additionalContext (SEC-016)', () => {
    // Actual newline characters in the error string must not appear in
    // additionalContext — they could inject fake log lines.
    const result = runHook('hooks/post-tool-failure-corrective-context.mjs', {
      tool_name: 'Bash',
      exit_code: 1,
      error: 'line one\nline two\nline three',
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput.additionalContext).not.toContain('\n');
  });

  it('strips carriage returns from error field (SEC-016)', () => {
    const result = runHook('hooks/post-tool-failure-corrective-context.mjs', {
      tool_name: 'Bash',
      exit_code: 1,
      error: 'windows\r\nline\r\nending',
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput.additionalContext).not.toContain('\r');
  });

  it('strips ANSI escape bytes (ESC = 0x1b) from error field (SEC-016)', () => {
    // Defense-in-depth: ANSI escape codes from terminal tool output should not flow
    // into Claude's additionalContext as raw bytes. Sealing the F2 false-positive
    // finding — the hook's split('\x1b').join(' ') pattern strips ESC correctly.
    const result = runHook('hooks/post-tool-failure-corrective-context.mjs', {
      tool_name: 'Bash',
      exit_code: 1,
      error: 'malicious [31mERROR[0m injection attempt',
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput.additionalContext).not.toContain('');
  });

  it('exits 0 with an empty-object payload (no tool_name)', () => {
    const result = runHook('hooks/post-tool-failure-corrective-context.mjs', {});
    expect(result.status).toBe(0);
  });

  it('emits hookSpecificOutput even when tool_name is absent', () => {
    // Hook must always emit — a missing tool_name falls back to "unknown tool"
    const result = runHook('hooks/post-tool-failure-corrective-context.mjs', {
      exit_code: 1,
      error: 'something failed',
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PostToolUseFailure');
    // Fallback label is "unknown tool"
    expect(parsed.hookSpecificOutput.additionalContext).toContain('unknown tool');
  });
});

// ---------------------------------------------------------------------------
// post-edit-validate.mjs (smoke — exits 0 for non-TS files; never blocks)
// ---------------------------------------------------------------------------

describe('post-edit-validate.mjs — never blocks (smoke)', () => {
  it('exits 0 for a README.md file (non-TS extension filtered out)', () => {
    const result = spawnSync(
      process.execPath,
      [path.join(PLUGIN_ROOT, 'hooks/post-edit-validate.mjs')],
      {
        input: JSON.stringify({
          tool_name: 'Edit',
          tool_input: { file_path: path.join(PLUGIN_ROOT, 'README.md') },
        }),
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
    // A .md file is filtered by the TS_EXTS set — hook exits 0 silently
    expect(result.status).toBe(0);
    // Non-TS files produce no stderr output
    expect(result.stderr.trim()).toBe('');
  });

  it('exits 0 for an empty stdin payload (G1 null-stdin guard)', () => {
    const result = spawnSync(
      process.execPath,
      [path.join(PLUGIN_ROOT, 'hooks/post-edit-validate.mjs')],
      {
        input: '',
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
    expect(result.status).toBe(0);
    expect(result.stderr.trim()).toBe('');
  });

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
