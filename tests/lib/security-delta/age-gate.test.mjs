import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runAgeGateCheck } from '../../../scripts/lib/security-delta/age-gate.mjs';
import { dropBlob } from '../../_helpers/git-faults.mjs';

let repo;
afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
  repo = undefined;
});

const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

function makeRepo(baseFiles, headFiles) {
  repo = mkdtempSync(join(tmpdir(), 'secdelta-age-'));
  git('init', '-q');
  git('config', 'user.email', 'dev@example.org');
  git('config', 'user.name', 'Example');
  const commit = (files, msg) => {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, name)), { recursive: true });
      writeFileSync(join(repo, name), text);
    }
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', msg);
    return git('rev-parse', 'HEAD');
  };
  const base = commit({ 'README.txt': 'x\n', ...baseFiles }, 'base');
  const head = commit(headFiles, 'head');
  return { repoRoot: repo, base, head };
}

describe('runAgeGateCheck', () => {
  it('reports a changed pnpm lockfile without minimumReleaseAge, and nothing once pnpm-workspace.yaml sets it', async () => {
    const lock = { 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" };
    const missing = await runAgeGateCheck(makeRepo({}, lock));
    expect(missing.status).toBe('ok');
    expect(missing.findings).toHaveLength(1);
    expect(missing.findings[0]).toMatchObject({ class: 'age-gate-missing', severity: 'low', package: null, file: 'pnpm-lock.yaml', introduced: true });

    rmSync(repo, { recursive: true, force: true });
    const gated = await runAgeGateCheck(makeRepo({ 'pnpm-workspace.yaml': 'minimumReleaseAge: 1440\n' }, lock));
    expect(gated).toMatchObject({ status: 'ok', checked: 1, findings: [] });
  });

  // Bug caught: every close touching a lockfile in a repo that never had a gate
  // warned (introduced hardcoded true) — HR-101 noise.
  it.each([
    ['gate missing at base and head, lockfile changed', { '.npmrc': 'x=1\n', 'package-lock.json': '{"v":1}\n' }, { 'package-lock.json': '{"v":2}\n' }, false],
    ['gate removed in the range', { '.npmrc': 'min-release-age=3\n', 'package-lock.json': '{"v":1}\n' }, { '.npmrc': 'x=1\n', 'package-lock.json': '{"v":2}\n' }, true],
    ['new lockfile without a gate', {}, { 'package-lock.json': '{"v":1}\n' }, true],
  ])('marks age-gate-missing introduced only when the range caused it: %s', async (_name, baseFiles, headFiles, introduced) => {
    const r = await runAgeGateCheck(makeRepo(baseFiles, headFiles));
    expect(r.status).toBe('ok');
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ class: 'age-gate-missing', file: 'package-lock.json', introduced });
  });

  // Bug caught: ls-tree read the leading `:` as pathspec magic, so a lockfile that
  // existed at base looked new and its missing gate was reported as introduced (#1775).
  it('treats a pre-existing lockfile under a directory starting with ":" as pre-existing', async () => {
    const r = await runAgeGateCheck(makeRepo({ ':app/package-lock.json': '{"v":1}\n' }, { ':app/package-lock.json': '{"v":2}\n' }));
    expect(r.status).toBe('ok');
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ class: 'age-gate-missing', file: ':app/package-lock.json', introduced: false });
  });

  it('skips with no-lockfile-change when no lockfile changed in the range', async () => {
    const r = await runAgeGateCheck(makeRepo({ 'pnpm-lock.yaml': 'x\n' }, { 'src.txt': 'y\n' }));
    expect(r).toMatchObject({ status: 'skipped', reason: 'no-lockfile-change' });
  });

  it('counts an .npmrc git cannot read as unchecked, not as a missing gate (#1774)', async () => {
    // Bug caught: an unreadable .npmrc read as absent, so a configured gate was reported missing.
    const range = makeRepo({}, { 'package-lock.json': '{}\n', '.npmrc': 'min-release-age=7\n' });
    dropBlob(repo, range.head, '.npmrc');
    const r = await runAgeGateCheck(range);
    expect(r).toMatchObject({ status: 'degraded', reason: 'unreadable', checked: 0, unchecked: 1, findings: [] });
  });

  it('reports a missing gate as introduced when the base config cannot be read (#1774)', async () => {
    // Bug caught: an unreadable base read as "no gate there either", so a removed gate counted as pre-existing.
    // (#1775: the base lockfile is only tested for existence via the tree, so its blob is not read at all.)
    const range = makeRepo(
      { 'package-lock.json': '{}\n', '.npmrc': 'min-release-age=3\n' },
      { 'package-lock.json': '{"lockfileVersion":3}\n', '.npmrc': 'x=1\n' },
    );
    dropBlob(repo, range.base, '.npmrc');
    const r = await runAgeGateCheck(range);
    expect(r).toMatchObject({ status: 'degraded', reason: 'unreadable', checked: 1, unchecked: 1 });
    expect(r.findings[0]).toMatchObject({ class: 'age-gate-missing', file: 'package-lock.json', introduced: true });
  });

  it('tests a base lockfile above the 16 MB git buffer for existence only: pre-existing, not unreadable (#1775)', { timeout: 30_000 }, async () => {
    // Bug caught: existence was tested by reading the whole base file, so a 17 MB lockfile hit
    // maxBuffer and read as degraded/unreadable with introduced: true.
    const big = (v) => `{"v":${v},"pad":"${'x'.repeat(17 * 1024 * 1024)}"}\n`;
    const r = await runAgeGateCheck(makeRepo({ '.npmrc': 'x=1\n', 'package-lock.json': big(1) }, { 'package-lock.json': big(2) }));
    expect(r).toMatchObject({ status: 'ok', checked: 1, unchecked: 0 });
    expect(r.findings[0]).toMatchObject({ class: 'age-gate-missing', file: 'package-lock.json', introduced: false });
  });

  it('reports a defect inside a read path as internal-error, not as an unreadable file (#1775)', async () => {
    // Bug caught: the catch around gateFor counted any throw — here a TypeError — as unreadable.
    const helpers = '../../../scripts/lib/security-delta/floating-tags.mjs';
    vi.resetModules();
    vi.doMock(helpers, async (importOriginal) => ({
      ...(await importOriginal()),
      showFile: async () => {
        throw new TypeError('defect in a read path');
      },
    }));
    try {
      const { runAgeGateCheck: run } = await import('../../../scripts/lib/security-delta/age-gate.mjs');
      const r = await run(makeRepo({}, { 'package-lock.json': '{}\n' }));
      expect(r).toMatchObject({ status: 'degraded', reason: 'internal-error', unchecked: 1 });
    } finally {
      vi.doUnmock(helpers);
      vi.resetModules();
    }
  });
});
