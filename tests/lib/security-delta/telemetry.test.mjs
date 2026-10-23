import { describe, expect, it } from 'vitest';
import { makeCheckResult, makeFinding } from '../../../scripts/lib/security-delta/contract.mjs';
import { runSecurityDelta } from '../../../scripts/lib/security-delta/runner.mjs';
import { buildDeltaEventPayload } from '../../../scripts/lib/security-delta/telemetry.mjs';

describe('buildDeltaEventPayload', () => {
  // Bug caught: package names, paths or advisory ids leaking into events.jsonl (which may be POSTed to a webhook).
  it('carries counts only — no package, version, file, id or reason text', async () => {
    const vuln = makeFinding({
      class: 'vuln',
      severity: 'critical',
      ecosystem: 'npm',
      package: 'leaky-lib',
      version: '9.8.7',
      fixedIn: '9.8.8',
      ids: ['GHSA-aaaa-bbbb-cccc'],
      file: 'apps/secret-app/package-lock.json',
      introduced: true,
    });
    const secret = makeFinding({ class: 'secret', severity: 'high', file: 'config/private-token.env', introduced: true });
    const checks = [
      {
        id: 'lockfile',
        network: true,
        run: async () => makeCheckResult({ id: 'lockfile', status: 'ok', checked: 3, findings: [vuln] }),
      },
      {
        id: 'gitleaks',
        network: false,
        run: async () =>
          makeCheckResult({ id: 'gitleaks', status: 'degraded', reason: 'scan-said-zzqq-word', unchecked: 1, findings: [secret] }),
      },
    ];
    const result = await runSecurityDelta({ base: 'a', head: 'b', mode: 'strict', checks });
    const payload = buildDeltaEventPayload(result);
    const json = JSON.stringify(payload);
    for (const leak of ['leaky-lib', '9.8.7', '9.8.8', 'GHSA-aaaa', 'secret-app', 'private-token', 'zzqq', 'secdelta:']) {
      expect(json).not.toContain(leak);
    }
    expect(payload).toMatchObject({
      mode: 'strict',
      verdict: 'block',
      findings_total: 2,
      introduced_total: 2,
      blocking_total: 1,
      budget_exceeded: false,
    });
    expect(payload.by_class).toMatchObject({ vuln: 1, secret: 1, malicious: 0 });
    expect(payload.checks.lockfile).toMatchObject({ status: 'ok', checked: 3, findings: 1 });
  });
});
