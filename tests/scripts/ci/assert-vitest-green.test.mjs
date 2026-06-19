import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  verifyVitestResult,
  assertVitestGreenFile,
} from '../../../scripts/ci/assert-vitest-green.mjs';

// A complete, all-passing vitest-4 JSON result (realistic field set).
const GREEN = {
  numTotalTestSuites: 446,
  numPassedTestSuites: 446,
  numFailedTestSuites: 0,
  numTotalTests: 9871,
  numPassedTests: 9871,
  numFailedTests: 0,
  success: true,
};

describe('verifyVitestResult — green path', () => {
  it('accepts a complete all-passing result', () => {
    const r = verifyVitestResult(GREEN);
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('all tests passed');
    expect(r.summary.numPassedTests).toBe(9871);
  });
});

describe('verifyVitestResult — fail-closed paths', () => {
  it('rejects when numFailedTests > 0', () => {
    const r = verifyVitestResult({ ...GREEN, success: false, numFailedTests: 12, numPassedTests: 9859 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('12 failed test(s)');
  });

  it('rejects when a suite failed even if test counts look clean', () => {
    const r = verifyVitestResult({ ...GREEN, success: false, numFailedTestSuites: 1 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('1 failed test suite(s)');
  });

  it('rejects when success is false but counts were not parsed (success guard fires first)', () => {
    const r = verifyVitestResult({ ...GREEN, success: false });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('success is false (expected true)');
  });

  it('rejects a truncated run below the default 5000-test floor', () => {
    const r = verifyVitestResult({ ...GREEN, numTotalTests: 120, numPassedTests: 120 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('only 120 total tests (< floor 5000) — truncated or partial run');
  });

  it('rejects when a required numeric field is missing (half-written JSON)', () => {
    const partial = { success: true, numPassedTests: 9871, numFailedTests: 0, numFailedTestSuites: 0 };
    const r = verifyVitestResult(partial);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('missing/invalid field "numTotalTests" (truncated or wrong-shape JSON)');
  });

  it('rejects a non-object result', () => {
    expect(verifyVitestResult(null).ok).toBe(false);
    expect(verifyVitestResult('done').ok).toBe(false);
  });

  it('honors a custom minTests floor', () => {
    const r = verifyVitestResult({ ...GREEN, numTotalTests: 200, numPassedTests: 200 }, { minTests: 100 });
    expect(r.ok).toBe(true);
  });
});

describe('assertVitestGreenFile — file IO fail-closed', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'assert-vitest-green-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns ok for a green result file', () => {
    const p = join(dir, 'result.json');
    writeFileSync(p, JSON.stringify(GREEN));
    expect(assertVitestGreenFile(p).ok).toBe(true);
  });

  it('fails closed when the file is absent', () => {
    const r = assertVitestGreenFile(join(dir, 'does-not-exist.json'));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('cannot read result file');
  });

  it('fails closed on unparseable JSON', () => {
    const p = join(dir, 'garbage.json');
    writeFileSync(p, 'this is not json {');
    const r = assertVitestGreenFile(p);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('not valid JSON');
  });
});
