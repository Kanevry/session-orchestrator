import { describe, expect, it } from 'vitest';
import { makeCheckResult, makeFinding } from '../../../scripts/lib/security-delta/contract.mjs';
import { runSecurityDelta } from '../../../scripts/lib/security-delta/runner.mjs';

const ok = (id, findings = []) => ({
  id,
  network: false,
  run: async () => makeCheckResult({ id, status: 'ok', checked: 1, findings }),
});

describe('runSecurityDelta', () => {
  // Bug caught: a hung check (slow registry, stuck binary) holding the close past the budget.
  it('replaces a check that misses the total budget by degraded/budget and returns on time', async () => {
    const hung = { id: 'gitleaks', network: false, run: () => new Promise(() => {}) };
    const started = Date.now();
    const result = await runSecurityDelta({
      repoRoot: '/nonexistent',
      base: 'a',
      head: 'b',
      mode: 'warn',
      checks: [ok('floating-tag'), hung],
      budget: { totalMs: 50, networkMs: 30 },
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.checks.find((c) => c.id === 'gitleaks')).toMatchObject({ status: 'degraded', reason: 'budget' });
    expect(result.checks.find((c) => c.id === 'floating-tag').status).toBe('ok');
    expect(result.status).toBe('degraded');
  });

  // Bug caught: mode off still running checks (network traffic at a close that opted out).
  it('runs no check under mode off', async () => {
    let calls = 0;
    const spy = {
      id: 'lockfile',
      network: true,
      run: async () => {
        calls += 1;
        return makeCheckResult({ id: 'lockfile', status: 'ok' });
      },
    };
    const result = await runSecurityDelta({ base: 'a', head: 'b', mode: 'off', checks: [spy] });
    expect(calls).toBe(0);
    expect(result).toMatchObject({ status: 'skipped', verdict: 'pass', checks: [] });
  });

  // Bug caught: the verdict ignoring mode — warn must never block, strict must.
  it('blocks an introduced malicious package only under strict', async () => {
    const mal = makeFinding({
      class: 'malicious',
      severity: 'critical',
      ecosystem: 'npm',
      package: 'evil-pkg',
      version: '1.0.0',
      ids: ['MAL-2026-1'],
      file: 'package-lock.json',
      introduced: true,
    });
    const checks = [ok('lockfile', [mal])];
    const strict = await runSecurityDelta({ base: 'a', head: 'b', mode: 'strict', checks });
    const warn = await runSecurityDelta({ base: 'a', head: 'b', mode: 'warn', checks });
    expect(strict.verdict).toBe('block');
    expect(strict.totals.blocking).toBe(1);
    expect(warn.verdict).toBe('warn');
  });
});
