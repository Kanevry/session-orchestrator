import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../scripts/lib/process-group.mjs', async (importOriginal) => ({
  ...await importOriginal(), spawnInGroup: vi.fn(),
}));
vi.mock('../../scripts/lib/events.mjs', async (importOriginal) => ({
  ...await importOriginal(), emitEvent: vi.fn(),
}));
import { spawnInGroup } from '../../scripts/lib/process-group.mjs';
import { emitEvent } from '../../scripts/lib/events.mjs';
import { gateKillFields, runQualityGateWithRetry } from '../../scripts/lib/quality-gate.mjs';
import {
  runCheck, commandKillFields, gateTimeoutEnvelope, joinGateKillFields, publishGateOutcome,
} from '../../scripts/lib/gates/gate-helpers.mjs';

const error = 'nicht messbar auf win32: CIM denied';
const run = { exitCode: 124, timedOut: true, output: 'partial', fullOutput: 'partial',
  killSignals: ['taskkill'], survivors: null, ok: false, error, pgid: 4242, durationMs: 20 };
const roots = [];
afterEach(() => {
  vi.clearAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('unmeasurable survivors', () => {
  it('keeps runCommand failure, diagnostics and event measurement through the retry boundary', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'gate-null-'));
    roots.push(repoRoot);
    spawnInGroup.mockResolvedValue(run);
    const result = await runQualityGateWithRetry({ repoRoot, maxRetries: 0,
      commands: { lint: 'configured-command', typecheck: 'skip', test: 'skip' } });
    expect(result.ok).toBe(false);
    expect(result.finalFailure.exitCode).toBe(124);
    expect(result.finalFailure.output).toContain(`Überlebende nicht messbar: ${error}`);
    const bundle = JSON.parse(readFileSync(result.diagnosticsBundlePath, 'utf8'));
    expect(bundle.finalError).toMatchObject({ survivors: null, error, timedOut: true });
    expect(emitEvent).toHaveBeenCalledWith('orchestrator.quality_gate.failed',
      expect.objectContaining({ survivors: null, error, timed_out: true }), expect.any(Object));
  });

  it('preserves null and the measurement error in both envelope adapters and telemetry', () => {
    expect(gateKillFields(run)).toMatchObject({ survivors: null, error });
    expect(commandKillFields(run)).toMatchObject({ survivors: null, error });
    expect(gateTimeoutEnvelope({ variant: 'full-gate', timeoutMs: 20, run }))
      .toMatchObject({ survivors: null, error: 'gate-timeout', cleanup_error: error });
  });

  it.each(['outer', 'inner'])('keeps a %s unknown measurement when joining measured ladders', (side) => {
    const outer = side === 'outer' ? { timed_out: true, survivors: null, error, kill_signals: ['taskkill'] }
      : { timed_out: false, survivors: 0, kill_signals: [] };
    const test = side === 'inner' ? { status: 'fail', timed_out: true, survivors: null, error, kill_signals: ['taskkill'] }
      : { status: 'pass', timed_out: false, survivors: [], kill_signals: [] };
    expect(joinGateKillFields({ outer, gateStdout: JSON.stringify({ test }) }))
      .toMatchObject({ timed_out: true, survivors: null, error });
  });

  it('publishes unknown survivors as a warning and one failure envelope', () => {
    const result = publishGateOutcome({ result: run, variant: 'full-gate', timeoutMs: 20 });
    expect(result.exitCode).toBe(124);
    expect(JSON.parse(result.stdout).survivors).toBeNull();
    expect(result.warnings).toEqual([`Überlebende nicht messbar: ${error}`]);
  });

  it('keeps runCheck fail and names the unmeasurable timeout instead of an empty list', async () => {
    spawnInGroup.mockResolvedValue(run);
    const result = await runCheck('configured-command', { timeoutMs: 20 });
    expect(result).toMatchObject({ status: 'fail', survivors: null, error, ok: false });
    expect(result.fullOutput).toContain(`Überlebende nicht messbar: ${error}`);
  });
});

// #1704 follow-up: spawnInGroup reports a group reaped after a NORMAL exit in
// `leftoverGroup`; before this, every gate adapter dropped it, so the reaped
// leftover was invisible in the gate output, the envelope and the diagnostics.
describe('leftover process group after a normal exit', () => {
  const leftoverGroup = { pgid: 5151, signals: ['SIGTERM', 'SIGKILL'], survivors: [] };
  const passed = { exitCode: 0, timedOut: false, output: 'ok', fullOutput: 'ok',
    killSignals: [], survivors: [], pgid: 5151, durationMs: 20, leftoverGroup };

  it('carries it through runCheck, the command envelope and the retry diagnostics without changing status', async () => {
    spawnInGroup.mockResolvedValue(passed);
    const result = await runCheck('configured-command', { timeoutMs: 20 });
    expect(result).toMatchObject({ status: 'pass', exitCode: 0, killSignals: [], survivors: [], leftoverGroup });
    expect(result.output).toContain('gate: reaped process group 5151 left running after exit: SIGTERM→SIGKILL');
    expect(commandKillFields(result).leftover_group).toEqual(leftoverGroup);
    expect(commandKillFields({ ...result, leftoverGroup: null })).not.toHaveProperty('leftover_group');

    const repoRoot = mkdtempSync(join(tmpdir(), 'gate-leftover-'));
    roots.push(repoRoot);
    spawnInGroup.mockResolvedValue({ ...passed, exitCode: 1 });
    const gate = await runQualityGateWithRetry({ repoRoot, maxRetries: 0,
      commands: { lint: 'configured-command', typecheck: 'skip', test: 'skip' } });
    expect(gate.finalFailure.output).toContain('gate: reaped process group 5151 left running after exit');
    const bundle = JSON.parse(readFileSync(gate.diagnosticsBundlePath, 'utf8'));
    expect(bundle.finalError).toMatchObject({ leftoverGroup });
  });
});
