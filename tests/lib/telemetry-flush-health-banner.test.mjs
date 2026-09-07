/**
 * tests/lib/telemetry-flush-health-banner.test.mjs
 *
 * Tests for scripts/lib/telemetry-flush-health-banner.mjs (#1255).
 *
 * Every test names the concrete bug it catches (TV-001). The probe's whole
 * reason to exist is that a `sandbox:probe-failed` flush refusal was recorded
 * and NEVER read back out, so its failure modes are all of the shape "the
 * banner is silent when it should speak, or speaks about a state that has
 * already been repaired".
 *
 * SAFETY: every test pins `repoRoot` to a tmp directory — no test reads or
 * writes the real repo's `.orchestrator/metrics/events.jsonl`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  checkTelemetryFlushHealth,
  renderBanner,
} from '../../scripts/lib/telemetry-flush-health-banner.mjs';

const tmpDirs = [];

beforeEach(() => {
  tmpDirs.length = 0;
});

afterEach(async () => {
  for (const d of tmpDirs.splice(0)) {
    await fs.rm(d, { recursive: true, force: true });
  }
});

async function mkRepo(lines) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flush-health-'));
  tmpDirs.push(dir);
  if (lines !== undefined) {
    const metrics = path.join(dir, '.orchestrator', 'metrics');
    await fs.mkdir(metrics, { recursive: true });
    await fs.writeFile(path.join(metrics, 'events.jsonl'), lines, 'utf8');
  }
  return dir;
}

const flush = (reason, extra = {}) =>
  JSON.stringify({
    timestamp: '2026-09-07T05:04:55.138Z',
    event: 'orchestrator.telemetry.flush',
    reason,
    schema_version: 1,
    ...extra,
  });

const hasControlChar = (s) =>
  [...s].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);

describe('checkTelemetryFlushHealth', () => {
  // BUG: sync.mjs fails closed with `sandbox:probe-failed`, on-session-end
  // records it, and before #1255 nothing read it — the operator saw a repo
  // that had not pinged in weeks as indistinguishable from a healthy one.
  it('warns with the reason interpolated when the newest flush was a sandbox refusal', async () => {
    const dir = await mkRepo(
      [
        JSON.stringify({ event: 'orchestrator.session.started' }),
        flush('sandbox:probe-failed', { outcome: 'skipped' }),
      ].join('\n') + '\n',
    );

    const out = checkTelemetryFlushHealth({ repoRoot: dir });

    expect(out).not.toBeNull();
    expect(out.severity).toBe('warn');
    expect(out.reason).toBe('sandbox:probe-failed');
    expect(out.message).toBe(
      '⚠ Telemetry: last flush refused by the sandbox guard (sandbox:probe-failed) — ' +
        'the guard could not complete its checks and failed closed; no ping was sent. ' +
        'See docs/telemetry.md § Sandbox guard.',
    );
    // The renderer is what a SKILL.md snippet calls — it must agree.
    expect(renderBanner({ repoRoot: dir })).toBe(out.message);
  });

  // BUG: scanning FORWARD (or matching "any sandbox reason anywhere in the
  // file") re-reports a refusal the repo has already recovered from — a
  // permanent banner that no successful flush can clear, which trains the
  // operator to ignore it (host-resources.md HR-101).
  it('is silent when a successful flush came AFTER an older sandbox refusal', async () => {
    const dir = await mkRepo(
      [
        flush('sandbox:probe-failed', { outcome: 'skipped' }),
        JSON.stringify({ event: 'orchestrator.session.started' }),
        flush('sent', { outcome: 'sent' }),
      ].join('\n') + '\n',
    );

    expect(checkTelemetryFlushHealth({ repoRoot: dir })).toBeNull();
    expect(renderBanner({ repoRoot: dir })).toBe('');
  });

  // BUG: a non-sandbox refusal ("persistence-disabled") is an operator CHOICE,
  // not a guard failure — warning about it would fire on every repo that turned
  // telemetry off.
  it('is silent when the newest flush reason is not a sandbox:* reason', async () => {
    const dir = await mkRepo(flush('persistence-disabled', { outcome: 'skipped' }) + '\n');
    expect(checkTelemetryFlushHealth({ repoRoot: dir })).toBeNull();
  });

  // BUG: a probe that throws on a missing ledger takes the whole SessionStart
  // probe run's budget slot with it — a fresh clone has no events.jsonl.
  it('returns null when the events ledger does not exist', async () => {
    const dir = await mkRepo(undefined);
    expect(checkTelemetryFlushHealth({ repoRoot: dir })).toBeNull();
  });

  // BUG: the ledger's last line is routinely a partial write while another
  // process appends. A JSON.parse without a guard throws there and kills the
  // probe; a `return null` on the first unparsable line hides the real refusal
  // sitting one line above it.
  it('skips a malformed last line and still finds the flush record above it', async () => {
    const dir = await mkRepo(
      [
        flush('sandbox:probe-failed', { outcome: 'skipped' }),
        '{"event":"orchestrator.session.sto',
      ].join('\n'),
    );

    const out = checkTelemetryFlushHealth({ repoRoot: dir });
    expect(out?.reason).toBe('sandbox:probe-failed');
  });

  // BUG: no flush record at all read as "something is wrong" would fire on
  // every repo that has never closed a session with the hook installed.
  it('returns null when the ledger holds no flush record', async () => {
    const dir = await mkRepo(
      JSON.stringify({ event: 'orchestrator.session.started' }) + '\n',
    );
    expect(checkTelemetryFlushHealth({ repoRoot: dir })).toBeNull();
  });

  // BUG: the `reason` comes out of an append-only ledger any process may write
  // and is interpolated straight into a terminal banner. An unbounded reason
  // (or one carrying an ANSI escape / control bytes) turns the SessionStart
  // banner into a scroll of attacker-shaped text — the sibling bound in
  // session-start-probes.mjs (`.slice(0, 200)`) exists for exactly this.
  it('bounds an oversized reason and strips control bytes before interpolating', async () => {
    const noisy = 'sandbox:' + 'x'.repeat(5000) + '\u001b[31m\u0000';
    const dir = await mkRepo(flush(noisy) + '\n');

    const out = checkTelemetryFlushHealth({ repoRoot: dir });

    expect(out).not.toBeNull();
    expect(out.message.length).toBeLessThan(400);
    expect(out.reason.length).toBeLessThanOrEqual(120);
    expect(hasControlChar(out.message)).toBe(false);
    expect(hasControlChar(out.reason)).toBe(false);
  });

  // BUG (HR-105, the defect this module's header cites as its reason to exist,
  // one layer down): an EACCES/EIO on the ledger used to collapse onto the same
  // `null` as "the last flush was fine". A repo whose ledger the probe cannot
  // read displayed as a healthy channel — unfalsifiable by construction.
  it.skipIf(process.getuid?.() === 0)(
    'warns with reason ledger-unreadable when the ledger cannot be read',
    async () => {
      const dir = await mkRepo(flush('sandbox:probe-failed') + '\n');
      const file = path.join(dir, '.orchestrator', 'metrics', 'events.jsonl');
      await fs.chmod(file, 0o000);
      try {
        const out = checkTelemetryFlushHealth({ repoRoot: dir });

        expect(out).not.toBeNull();
        expect(out.severity).toBe('warn');
        expect(out.reason).toBe('ledger-unreadable');
        expect(out.message).toContain('flush-health unknown');
        expect(out.message).toContain('EACCES');
      } finally {
        await fs.chmod(file, 0o600);
      }
    },
  );

  // BUG: a bad/absent repoRoot must degrade to silence, never to a path throw
  // inside the shared probe runner.
  it('returns null for a missing or non-string repoRoot', () => {
    expect(checkTelemetryFlushHealth({})).toBeNull();
    expect(checkTelemetryFlushHealth()).toBeNull();
    expect(checkTelemetryFlushHealth({ repoRoot: 42 })).toBeNull();
  });
});
