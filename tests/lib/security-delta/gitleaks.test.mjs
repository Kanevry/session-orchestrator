import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { commandOnPath } from '../../../scripts/lib/native-command.mjs';
import { runGitleaksCheck } from '../../../scripts/lib/security-delta/gitleaks.mjs';

const REPORT_FIXTURE = join(process.cwd(), 'tests/fixtures/security-delta/runtime/gitleaks-report.json');
const range = { repoRoot: process.cwd(), base: 'a'.repeat(40), head: 'b'.repeat(40) };

/** Fake spawn: `version` prints a version; the scan copies the fixture to --report-path. */
function fakeSpawn({ version = '8.30.1', hang = false } = {}) {
  const calls = [];
  const impl = (cmd, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.kill = () => setImmediate(() => child.emit('close', null));
    setImmediate(() => {
      if (args[0] === 'version') {
        child.stdout.end(`${version}\n`);
        child.emit('close', 0);
        return;
      }
      if (hang) return;
      copyFileSync(REPORT_FIXTURE, args[args.indexOf('--report-path') + 1]);
      child.emit('close', 0);
    });
    return child;
  };
  return { impl, calls };
}

describe('runGitleaksCheck', () => {
  it('skips with binary-absent when gitleaks is not on PATH', async () => {
    const r = await runGitleaksCheck({ ...range, onPath: () => false, spawnImpl: () => { throw new Error('must not spawn'); } });
    expect(r).toMatchObject({ status: 'skipped', reason: 'binary-absent', findings: [] });
  });

  it('counts per file without ever returning a secret value (SEC-008) and deletes the temp report', async () => {
    const { impl, calls } = fakeSpawn();
    const r = await runGitleaksCheck({ ...range, onPath: () => true, spawnImpl: impl });
    expect(JSON.stringify(r)).not.toContain('FAKE-NOT-A-SECRET-0000');
    expect(r.status).toBe('ok');
    expect(r.findings.map((f) => [f.file, f.ids, f.class, f.introduced])).toEqual([
      ['config/app.env', ['example-token', 'generic-api-key'], 'secret', true],
      ['scripts/deploy.sh', ['generic-api-key'], 'secret', true],
    ]);
    const scanArgs = calls[1];
    expect(scanArgs[0]).toBe('git');
    expect(scanArgs).toContain(`--log-opts=${range.base}..${range.head}`);
    expect(scanArgs).toContain('--redact=100');
    expect(existsSync(scanArgs[scanArgs.indexOf('--report-path') + 1])).toBe(false);
  });

  it('uses the detect form for gitleaks older than 8.19 and degrades on timeout', async () => {
    const old = fakeSpawn({ version: 'v8.18.4' });
    await runGitleaksCheck({ ...range, onPath: () => true, spawnImpl: old.impl });
    expect(old.calls[1].slice(0, 2)).toEqual(['detect', '--source']);

    const hung = fakeSpawn({ hang: true });
    const r = await runGitleaksCheck({ ...range, onPath: () => true, spawnImpl: hung.impl, timeoutMs: 50 });
    expect(r).toMatchObject({ status: 'degraded', reason: 'timeout', unchecked: 1 });
  });

  // Bug caught: a flag spelling the installed gitleaks rejects (it exits non-zero → degraded, never counted).
  it.skipIf(!commandOnPath('gitleaks'))('finds a secret added in the range with the real gitleaks binary', { timeout: 30_000 }, async () => {
    const repo = mkdtempSync(join(tmpdir(), 'secdelta-gl-'));
    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    try {
      git('init', '-q');
      git('config', 'user.email', 'dev@example.org');
      git('config', 'user.name', 'Example');
      writeFileSync(join(repo, 'a.txt'), 'x\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'base');
      const base = git('rev-parse', 'HEAD');
      // Synthetic GitLab-PAT-shaped value (the default 8.30.1 config flags it; a synthetic AKIA
      // key it does not), assembled at runtime so no literal token shape sits in this file.
      writeFileSync(join(repo, 'cfg.env'), `gitlab_token = "${['glpat', 'Zx9Kq2Lm7Np4Rt8Vw3Yb'].join('-')}"\n`);
      git('add', '-A');
      git('commit', '-q', '-m', 'head');
      const r = await runGitleaksCheck({ repoRoot: repo, base, head: git('rev-parse', 'HEAD'), timeoutMs: 20_000 });
      expect(r.status).toBe('ok');
      expect(r.findings.map((f) => [f.file, f.ids])).toEqual([['cfg.env', ['gitlab-pat']]]);
      expect(JSON.stringify(r)).not.toContain('Zx9Kq2Lm7Np4Rt8Vw3Yb');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
