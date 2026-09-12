/**
 * tests/lib/ux-grill/run-record.test.mjs
 *
 * Contract tests for `scripts/lib/ux-grill/run-record.mjs` — the ONLY
 * reader/writer of the ux-grill ledger. Two writers share one append-only file
 * (`collect()` appends, `compare()` patches), so the two properties that matter
 * are that the PATCH pass destroys nothing it does not own, and that the
 * baseline lookup picks the right record. Both are exercised against real files
 * in a tmp repo, never against a mocked `fs`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendRunRecord,
  findPreviousRun,
  updateRunRecordCompare,
} from '../../../scripts/lib/ux-grill/run-record.mjs';
import { runRecordPath } from '../../../scripts/lib/ux-grill/paths.mjs';

/** @type {string[]} */
const tmpDirs = [];

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ux-grill-runrecord-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

function writeLedger(repoRoot, text) {
  const ledger = runRecordPath(repoRoot);
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  fs.writeFileSync(ledger, text, 'utf8');
  return ledger;
}

const record = (overrides = {}) => ({
  schema_version: 1,
  run_id: 'run-1',
  timestamp: '2026-09-12T10:00:00.000Z',
  manifest_hash: 'mh-1',
  rubric_hash: 'rh-1',
  build: 'prod',
  viewports: ['desktop'],
  routes: ['/'],
  counts_by_severity: { high: 1, medium: 0, low: 0 },
  provisional_count: 0,
  compare: { new: 0, persisting: 0, fixed: 0 },
  skipped: [],
  pencil_coverage: [],
  ...overrides,
});

describe('updateRunRecordCompare() — the patch pass preserves everything it does not own', () => {
  it('rewrites only the target line, keeps an unparseable neighbour byte-identical and preserves order', () => {
    const repoRoot = makeRepo();
    const foreign = JSON.stringify(record({ run_id: 'foreign-1' }));
    const truncated = '{"run_id":';
    const target = JSON.stringify(record({ run_id: 'run-1' }));
    const ledger = writeLedger(repoRoot, `${foreign}\n${truncated}\n${target}\n`);

    const result = updateRunRecordCompare(repoRoot, 'run-1', { new: 3, persisting: 4, fixed: 5 });

    expect(result.updated).toBe(1);
    expect(result.skippedLines).toBe(1);

    const text = fs.readFileSync(ledger, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    const lines = text.split('\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(foreign);
    expect(lines[1]).toBe(truncated);
    expect(JSON.parse(lines[2]).run_id).toBe('run-1');
    expect(JSON.parse(lines[2]).compare).toEqual({ new: 3, persisting: 4, fixed: 5 });
    expect(JSON.parse(lines[0]).compare).toEqual({ new: 0, persisting: 0, fixed: 0 });
  });

  it('rejects a negative count and leaves the ledger untouched', () => {
    const repoRoot = makeRepo();
    const original = `${JSON.stringify(record())}\n`;
    const ledger = writeLedger(repoRoot, original);

    expect(() => updateRunRecordCompare(repoRoot, 'run-1', { new: -1, persisting: 0, fixed: 0 })).toThrow(TypeError);
    expect(fs.readFileSync(ledger, 'utf8')).toBe(original);
  });
});

describe('findPreviousRun() — baseline selection', () => {
  it('returns the most recent record sharing BOTH manifest hash and build, before the current run', () => {
    const repoRoot = makeRepo();
    writeLedger(
      repoRoot,
      [
        JSON.stringify(record({ run_id: 'prodA', build: 'prod' })),
        JSON.stringify(record({ run_id: 'devA', build: 'dev' })),
        JSON.stringify(record({ run_id: 'prodB', build: 'prod' })),
        JSON.stringify(record({ run_id: 'prodC', build: 'prod' })),
      ].join('\n') + '\n',
    );

    const found = findPreviousRun(repoRoot, { manifestHash: 'mh-1', build: 'prod', beforeRunId: 'prodB' });

    expect(found?.run_id).toBe('prodA');
  });

  it('returns null when no record shares the manifest hash — a baseline run, not a clean one', () => {
    const repoRoot = makeRepo();
    writeLedger(repoRoot, `${JSON.stringify(record({ run_id: 'other', manifest_hash: 'mh-2' }))}\n`);

    expect(findPreviousRun(repoRoot, { manifestHash: 'mh-1', build: 'prod', beforeRunId: 'run-1' })).toBeNull();
  });
});

describe('appendRunRecord() — write shape and validation', () => {
  it('writes bytes identical to the bare appendFileSync shape collect.mjs uses today', () => {
    const viaHelper = makeRepo();
    const viaBare = makeRepo();
    const rec = record();

    appendRunRecord(viaHelper, rec);

    const bareLedger = runRecordPath(viaBare);
    fs.mkdirSync(path.dirname(bareLedger), { recursive: true });
    fs.appendFileSync(bareLedger, `${JSON.stringify(rec)}\n`, 'utf8');

    expect(fs.readFileSync(runRecordPath(viaHelper), 'utf8')).toBe(fs.readFileSync(bareLedger, 'utf8'));
  });

  it('rejects an invalid `build` and writes no ledger line at all', () => {
    const repoRoot = makeRepo();

    expect(() => appendRunRecord(repoRoot, record({ build: 'staging' }))).toThrow(TypeError);
    expect(fs.existsSync(runRecordPath(repoRoot))).toBe(false);
  });
});
