import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { deriveVerdict } from '../../../scripts/lib/security-delta/contract.mjs';
import { runLockfileCheck } from '../../../scripts/lib/security-delta/osv.mjs';

const ROOT = process.cwd();
const lockFixture = (name) => readFileSync(path.join(ROOT, 'tests/fixtures/security-delta/lockfiles', name), 'utf8');
const osvFixture = (name) => JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/security-delta/osv', name), 'utf8'));

/** Fake git: `files` maps path → { base, head } content (null = absent at that ref). */
function fakeGit(files) {
  return async (args) => {
    if (args[0] === 'diff') return `${Object.keys(files).join('\0')}\0`;
    const [ref, file] = args[1].split(/:(.*)/s);
    const text = files[file]?.[ref];
    if (text === null || text === undefined) throw new Error(`fatal: path '${file}' does not exist in '${ref}'`);
    return text;
  };
}

/** Fake transport with the httpRequest response shape; records every call. */
function fakeRequest({ batch, details = {}, failBatch = null }) {
  const calls = [];
  const request = async (url, opts) => {
    calls.push({ url, body: opts.body });
    if (url.endsWith('/querybatch')) {
      if (failBatch) throw failBatch;
      return { ok: true, status: 200, json: async () => batch, text: async () => JSON.stringify(batch) };
    }
    const id = decodeURIComponent(url.split('/').pop());
    if (!details[id]) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    return { ok: true, status: 200, json: async () => details[id], text: async () => '' };
  };
  return { request, calls };
}

const repoRoot = tmpdir(); // no .npmrc there: no private scopes
const uvRange = (baseLock, headLock) => fakeGit({ 'uv.lock': { base: lockFixture(baseLock), head: lockFixture(headLock) } });

describe('runLockfileCheck — litellm acceptance case from #1769', () => {
  it('litellm 1.107.0 answered with MAL-2026-2144 is one malicious critical finding', async () => {
    const { request, calls } = fakeRequest({ batch: osvFixture('querybatch.json'), details: { 'MAL-2026-2144': osvFixture('vuln-mal.json') } });
    const result = await runLockfileCheck({
      repoRoot, base: 'base', head: 'head', request,
      runGit: uvRange('uv-litellm-1.106.2.lock', 'uv-litellm-1.107.0.lock'),
    });
    expect(JSON.parse(calls[0].body)).toEqual({
      queries: [{ package: { name: 'litellm', ecosystem: 'PyPI' }, version: '1.107.0' }],
    });
    expect(result.status).toBe('ok');
    expect(result.checked).toBe(1);
    expect(result.findings).toEqual([
      expect.objectContaining({
        class: 'malicious', severity: 'critical', ecosystem: 'PyPI', package: 'litellm',
        version: '1.107.0', fixedIn: null, ids: ['MAL-2026-2144'], file: 'uv.lock', introduced: true,
      }),
    ]);
  });

  it('litellm 1.106.2 answered with {} (no vulns key) is no finding and does not crash', async () => {
    const { request } = fakeRequest({ batch: osvFixture('empty.json') });
    const result = await runLockfileCheck({
      repoRoot, base: 'base', head: 'head', request,
      runGit: uvRange('uv-base.lock', 'uv-litellm-1.106.2.lock'),
    });
    expect(result).toMatchObject({ status: 'ok', reason: null, checked: 1, unchecked: 0, findings: [] });
  });
});

describe('runLockfileCheck — degraded measurement never reads as clean', () => {
  it('querybatch timeout → degraded/timeout with every public package unchecked', async () => {
    const { request } = fakeRequest({ failBatch: new Error('HTTP request timed out') });
    const result = await runLockfileCheck({
      repoRoot, base: 'base', head: 'head', request,
      runGit: fakeGit({
        'package-lock.json': { base: lockFixture('package-lock.base.json'), head: lockFixture('package-lock.head.json') },
      }),
    });
    // No .npmrc here: lodash, b and @example-private/y count; @acme-internal/x and left-pad
    // resolve from foreign hosts and are excluded, not unchecked.
    expect(result).toMatchObject({ status: 'degraded', reason: 'timeout', checked: 0, unchecked: 3, findings: [] });
  });

  it('GHSA detail: CRITICAL word → critical, fixedIn = lowest fix above the found version of the matching package', async () => {
    const lock = (v) => JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/lodash': { version: v, resolved: `https://registry.npmjs.org/lodash/-/lodash-${v}.tgz` } } });
    const runGit = fakeGit({ 'package-lock.json': { base: lock('4.17.10'), head: lock('4.17.15') } });
    const batch = { results: [{ vulns: [{ id: 'GHSA-p6mc-m468-83gw', modified: '2026-01-01T00:00:00Z' }] }] };
    const { request } = fakeRequest({ batch, details: { 'GHSA-p6mc-m468-83gw': osvFixture('vuln-ghsa.json') } });
    const full = await runLockfileCheck({ repoRoot, base: 'base', head: 'head', request, runGit });
    // 4.17.12 is below 4.17.15 and lodash-es's 4.17.16 belongs to another package.
    expect(full.findings[0]).toMatchObject({ class: 'vuln', severity: 'critical', fixedIn: '4.17.21' });
    expect(full.status).toBe('ok');

    const capped = await runLockfileCheck({ repoRoot, base: 'base', head: 'head', request, runGit, maxDetails: 0 });
    expect(capped).toMatchObject({ status: 'degraded', reason: 'detail-cap', checked: 1, unchecked: 1 });
    expect(capped.findings[0]).toMatchObject({ class: 'vuln', severity: 'unknown', fixedIn: null });
  });

  it('a blank-version decoy and a broken sibling lockfile cost only themselves: the MAL package still blocks under strict', async () => {
    const lock = (pkgs) => JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...pkgs } });
    const runGit = fakeGit({
      'package-lock.json': {
        base: lock({}),
        head: lock({ 'node_modules/decoy': { version: '' }, 'node_modules/evil-pkg': { version: '6.6.6' } }),
      },
      'tools/pnpm-lock.yaml': { base: 'packages: {}\n', head: 'packages: [unclosed\n' },
    });
    // OSV treats an empty version as "any version": answer MAL for every query, as the real API could.
    const request = async (url, opts) => {
      const n = JSON.parse(opts.body).queries.length;
      return { ok: true, status: 200, json: async () => ({ results: Array.from({ length: n }, () => ({ vulns: [{ id: 'MAL-2026-1' }] })) }) };
    };
    const result = await runLockfileCheck({ repoRoot, base: 'base', head: 'head', request, runGit });
    expect(result).toMatchObject({ status: 'degraded', checked: 1, unchecked: 2 });
    expect(result.findings).toEqual([expect.objectContaining({ class: 'malicious', package: 'evil-pkg', version: '6.6.6' })]);
    expect(deriveVerdict('strict', [result])).toBe('block');
  });

  it('a pin with a trailing --hash is queried; a new unpinned requirement makes the result degraded/unpinned', async () => {
    const runGit = fakeGit({
      'requirements.txt': { base: '', head: 'example-hashed==1.0 --hash=sha256:00ff\nexample-loose>=2\n' },
    });
    const { request, calls } = fakeRequest({ batch: { results: [{}] } });
    const result = await runLockfileCheck({ repoRoot, base: 'base', head: 'head', request, runGit });
    expect(JSON.parse(calls[0].body).queries).toEqual([{ package: { name: 'example-hashed', ecosystem: 'PyPI' }, version: '1.0' }]);
    expect(result).toMatchObject({ status: 'degraded', reason: 'unpinned', checked: 1, unchecked: 1 });
  });

  it('a critical advisory without a fix next to a low advisory with one gives fixedIn null, so strict does not block', async () => {
    const lock = (v) => JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/example-lib': { version: v } } });
    const runGit = fakeGit({ 'package-lock.json': { base: lock('1.0.0'), head: lock('1.1.0') } });
    const advisory = (severity, fixed) => ({
      database_specific: { severity },
      affected: [{ package: { ecosystem: 'npm', name: 'example-lib' }, ranges: [{ events: [{ introduced: '0' }, ...(fixed ? [{ fixed }] : [])] }] }],
    });
    const { request } = fakeRequest({
      batch: { results: [{ vulns: [{ id: 'GHSA-crit' }, { id: 'GHSA-low' }] }] },
      details: { 'GHSA-crit': advisory('CRITICAL', null), 'GHSA-low': advisory('LOW', '1.2.0') },
    });
    const result = await runLockfileCheck({ repoRoot, base: 'base', head: 'head', request, runGit });
    expect(result.findings[0]).toMatchObject({ severity: 'critical', fixedIn: null });
    expect(deriveVerdict('strict', [result])).toBe('warn');
  });

  it('a malformed sibling advisory (affected not an array) does not drop the MAL finding: strict still blocks', async () => {
    const lock = (pkgs) => JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...pkgs } });
    const runGit = fakeGit({ 'package-lock.json': { base: lock({}), head: lock({ 'node_modules/evil-pkg': { version: '6.6.6' } }) } });
    const { request } = fakeRequest({
      batch: { results: [{ vulns: [{ id: 'MAL-2026-1' }, { id: 'GHSA-x' }] }] },
      details: { 'GHSA-x': { database_specific: { severity: 'HIGH' }, affected: { not: 'array' } } },
    });
    const result = await runLockfileCheck({ repoRoot, base: 'base', head: 'head', request, runGit });
    expect(result.findings).toEqual([
      expect.objectContaining({ class: 'malicious', severity: 'critical', package: 'evil-pkg', version: '6.6.6', fixedIn: null }),
    ]);
    expect(deriveVerdict('strict', [result])).toBe('block');
  });

  it('a git error other than "path absent at ref" counts the file unchecked instead of reading it as empty', async () => {
    const runGit = async (args) => {
      if (args[0] === 'diff') return 'package-lock.json\0';
      if (args[1].startsWith('base:')) throw new Error("fatal: path 'package-lock.json' does not exist in 'base'");
      throw new Error('stdout maxBuffer length exceeded');
    };
    const { request, calls } = fakeRequest({ batch: { results: [] } });
    const result = await runLockfileCheck({ repoRoot, base: 'base', head: 'head', request, runGit });
    expect(result).toMatchObject({ status: 'degraded', reason: 'unparsed', checked: 0, unchecked: 1 });
    expect(calls).toHaveLength(0);
  });

  it('no base ref → skipped/no-range; no changed lockfile → skipped/no-lockfile-change', async () => {
    const { request, calls } = fakeRequest({ batch: osvFixture('empty.json') });
    expect(await runLockfileCheck({ repoRoot, base: '', head: 'head', request })).toMatchObject({ status: 'skipped', reason: 'no-range' });
    const none = await runLockfileCheck({ repoRoot, base: 'base', head: 'head', request, runGit: fakeGit({ 'README.md': { base: 'a', head: 'b' } }) });
    expect(none).toMatchObject({ status: 'skipped', reason: 'no-lockfile-change' });
    expect(calls).toHaveLength(0);
  });
});
