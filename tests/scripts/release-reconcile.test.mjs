/**
 * tests/scripts/release-reconcile.test.mjs
 *
 * #1537: npm accepts an upload (HTTP 202 + target receipt) before its
 * publish-time checks make the version installable. `--reconcile` resumes the
 * verification later from the persisted publish proof — read-only, bounded,
 * and never deriving success from `latest` alone. No test here touches the
 * network: every npm call goes through an injected runImpl.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  archiveIntegrity,
  buildReleaseProof,
  writeReleaseProof,
  releaseProofPath,
  reconcileRelease,
  printReconcileResult,
  printPublishOutcome,
  validateFlags,
} from '../../scripts/release.mjs';
import { makeTmpDir, removeTree } from '../_helpers/tmp-fixture.mjs';

const TARGET = '9.9.1';
const BYTES = Buffer.from('checked archive bytes for 9.9.1');

let root;
let archive;
beforeEach(() => {
  root = makeTmpDir('release-reconcile-');
  archive = join(root, 'checked.tgz');
  writeFileSync(archive, BYTES);
});
afterEach(() => removeTree(root));

function persistProof() {
  const proof = buildReleaseProof({
    target: TARGET,
    artifact: { digest: 'a'.repeat(64), integrity: archiveIntegrity(archive) },
    commit: 'c8f3f3ee',
    receiptAt: '2026-10-08T00:00:00.000Z',
  });
  const written = writeReleaseProof(root, proof);
  expect(written.ok).toBe(true);
  return proof;
}

const NOT_FOUND = {
  status: 1,
  stdout: JSON.stringify({ error: { code: 'E404', summary: `No match found for version ${TARGET}` } }),
  stderr: 'npm error code E404',
};
const manifest = (integrity, latest = TARGET) => ({
  status: 0,
  stdout: JSON.stringify({ version: TARGET, 'dist-tags': { latest }, dist: { integrity } }),
  stderr: '',
});

/** Registry fake: 404 until `availableFrom`, then the manifest; `npm pack` drops `packBytes`. */
function registry({ availableFrom = 1, integrity, packBytes = BYTES, calls }) {
  let views = 0;
  return (cmd, args, opts) => {
    calls.push([cmd, ...args]);
    if (cmd === 'npm' && args[0] === 'view') {
      views += 1;
      return views >= availableFrom ? manifest(integrity) : NOT_FOUND;
    }
    if (cmd === 'npm' && args[0] === 'pack') {
      const dest = args[args.indexOf('--pack-destination') + 1];
      expect(opts.cwd).toBe(dest);
      writeFileSync(join(dest, `session-orchestrator-${TARGET}.tgz`), packBytes);
      return { status: 0, stdout: JSON.stringify([{ filename: `session-orchestrator-${TARGET}.tgz` }]), stderr: '' };
    }
    throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
  };
}

describe('reconcileRelease (#1537)', () => {
  it('accepted receipt, 404 for the first attempts, then available and installable', () => {
    // Bug caught: the old poll judged `npm view <pkg> version` (= latest) only
    // and gave up after 165 s; nothing verified the served bytes or a download.
    const proof = persistProof();
    expect(JSON.parse(readFileSync(releaseProofPath(root, TARGET), 'utf8'))).toMatchObject({
      target: TARGET, tag: `v${TARGET}`, commit: 'c8f3f3ee', integrity: proof.integrity,
    });
    const calls = [];
    let waits = 0;
    const result = reconcileRelease(root, TARGET, {
      attempts: 5,
      runImpl: registry({ availableFrom: 3, integrity: proof.integrity, calls }),
      waitImpl: () => { waits += 1; return { status: 0 }; },
    });
    expect(result).toMatchObject({ ok: true, state: 'installable', accepted: true, available: true, installable: true, attempts: 3 });
    expect(waits).toBe(2);
    expect(printReconcileResult(result, { log: () => {}, error: () => {} })).toBe(0);
  });

  it('a permanent 404 ends pending with exit 1 — never failed, never diagnosed as blocked', () => {
    const proof = persistProof();
    const calls = [];
    let waits = 0;
    const result = reconcileRelease(root, TARGET, {
      attempts: 4,
      runImpl: registry({ availableFrom: Infinity, integrity: proof.integrity, calls }),
      waitImpl: () => { waits += 1; return { status: 0 }; },
    });
    expect(result).toMatchObject({ ok: false, state: 'pending', reason: 'not-visible', accepted: true, available: false, attempts: 4 });
    expect(waits).toBe(3);
    expect(result.detail).toContain('--reconcile --target 9.9.1');
    const stderr = [];
    expect(printReconcileResult(result, { log: () => {}, error: (l) => stderr.push(l) })).toBe(1);
    expect(stderr.join('\n')).toContain('Still pending, not failed');
  });

  it('never invokes npm publish, git tag or git push (read-only by construction)', () => {
    const proof = persistProof();
    const calls = [];
    reconcileRelease(root, TARGET, {
      attempts: 3,
      runImpl: registry({ availableFrom: 2, integrity: proof.integrity, calls }),
      waitImpl: () => ({ status: 0 }),
    });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter(([cmd, sub]) => cmd === 'npm' && sub === 'publish')).toHaveLength(0);
    expect(calls.filter(([cmd, sub]) => cmd === 'git' && (sub === 'tag' || sub === 'push'))).toHaveLength(0);
    // The only download is the registry spec — never a pack of the repo itself.
    for (const call of calls.filter(([cmd, sub]) => cmd === 'npm' && sub === 'pack')) {
      expect(call[2]).toBe(`session-orchestrator@${TARGET}`);
    }
  });

  it('an integrity mismatch is failed — in the registry manifest or in the downloaded tarball', () => {
    const proof = persistProof();
    const other = `sha512-${'B'.repeat(86)}==`;
    const viaRegistry = reconcileRelease(root, TARGET, {
      attempts: 3, runImpl: registry({ integrity: other, calls: [] }), waitImpl: () => ({ status: 0 }),
    });
    expect(viaRegistry).toMatchObject({ ok: false, state: 'failed', reason: 'integrity-mismatch', attempts: 1 });

    const viaDownload = reconcileRelease(root, TARGET, {
      attempts: 3,
      runImpl: registry({ integrity: proof.integrity, packBytes: Buffer.from('different bytes'), calls: [] }),
      waitImpl: () => ({ status: 0 }),
    });
    expect(viaDownload).toMatchObject({ ok: false, state: 'failed', reason: 'integrity-mismatch', available: true, installable: false });
  });

  it('a missing proof exits 1 without querying — even when latest already equals the target', () => {
    const calls = [];
    const result = reconcileRelease(root, TARGET, {
      runImpl: registry({ integrity: `sha512-${'A'.repeat(86)}==`, calls }),
      waitImpl: () => ({ status: 0 }),
    });
    expect(result).toMatchObject({ ok: false, state: 'proof-missing', accepted: false });
    expect(result.detail).toContain('proof missing');
    expect(calls).toEqual([]);
    expect(printReconcileResult(result, { json: true, log: () => {} })).toBe(1);
  });
});

describe('--reconcile wiring', () => {
  it('refuses --reconcile combined with a writing mode, and --target without --reconcile', () => {
    // Bug caught: `--reconcile --publish` falling through to the publish branch.
    expect(validateFlags({ reconcile: true, publish: true })).toMatchObject({ ok: false, code: 2 });
    expect(validateFlags({ reconcile: true, 'set-version': '1.2.3' })).toMatchObject({ ok: false, code: 2 });
    expect(validateFlags({ target: '1.2.3' })).toMatchObject({ ok: false, code: 2 });
    expect(validateFlags({ reconcile: true, target: 'latest' })).toMatchObject({ ok: false, code: 2 });
    expect(validateFlags({ reconcile: true, target: '1.2.3' })).toEqual({ ok: true });
  });

  it('the --publish registry-timeout path points at --reconcile, not at propagation', () => {
    const stderr = [];
    printPublishOutcome({
      status: 'post-publish-reconciliation',
      propagation: { ok: false, kind: 'timeout', detail: 'registry did not report 9.9.1 after 12 attempts' },
      proof: { ok: true, detail: 'publish proof written to .orchestrator/runtime/release-9.9.1.json' },
      tag: 'v9.9.1', pushed: ['origin', 'github'],
      release: { ok: true, detail: 'GitHub release v9.9.1 created' },
      live: { ok: true, detail: 'attempt 1/1' },
      reconciliation: [{ phase: 'registry-propagation', kind: 'timeout', detail: 'registry did not report 9.9.1 after 12 attempts' }],
    }, TARGET, { log: () => {}, error: (l) => stderr.push(l) });
    expect(stderr.join('\n')).toContain('--reconcile --target 9.9.1');
  });
});
