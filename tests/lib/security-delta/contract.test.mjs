import { describe, expect, it } from 'vitest';

import {
  deriveStatus,
  deriveVerdict,
  makeCheckResult,
  makeFinding,
  normalizeOsvSeverity,
} from '../../../scripts/lib/security-delta/contract.mjs';

const finding = (over) =>
  makeFinding({ class: 'vuln', severity: 'critical', ecosystem: 'npm', package: 'pkg', version: '1.0.0', fixedIn: '1.0.1', introduced: true, ...over });
const check = (findings, status = 'ok') => makeCheckResult({ id: 'lockfile', status, checked: 1, findings });

describe('deriveVerdict — only introduced findings move the verdict; only an introduced malicious or fixable critical one blocks, and only under strict', () => {
  it.each([
    ['strict', finding({}), 'block'],
    ['strict', finding({ class: 'malicious', fixedIn: null }), 'block'],
    ['strict', finding({ fixedIn: null }), 'warn'], // critical without a known fix
    ['strict', finding({ introduced: false }), 'pass'], // pre-existing: listed, never moves the verdict
    ['strict', finding({ severity: 'high' }), 'warn'],
    ['warn', finding({ class: 'malicious', fixedIn: null }), 'warn'],
    ['off', finding({ class: 'malicious', fixedIn: null }), 'pass'],
  ])('mode %s → %s', (mode, f, verdict) => {
    expect(deriveVerdict(mode, [check([f])])).toBe(verdict);
  });

  it('a degraded run without findings passes (fail-open)', () => {
    expect(deriveVerdict('strict', [makeCheckResult({ id: 'lockfile', status: 'degraded', unchecked: 3 })])).toBe('pass');
  });
});

describe('deriveStatus — a partial measurement never reads as clean', () => {
  it('degraded wins over findings', () => {
    const checks = [check([finding({})]), makeCheckResult({ id: 'gitleaks', status: 'degraded', unchecked: 1 })];
    expect(deriveStatus(checks)).toBe('degraded');
  });

  it('all skipped or not measurable → skipped, not clean', () => {
    const checks = [
      makeCheckResult({ id: 'gitleaks', status: 'skipped', reason: 'binary-absent' }),
      makeCheckResult({ id: 'runtime-floor', status: 'not-measurable', reason: 'lts-alias' }),
    ];
    expect(deriveStatus(checks)).toBe('skipped');
  });
});

describe('makeCheckResult — status ok cannot carry unchecked items', () => {
  it('throws for ok with unchecked > 0', () => {
    expect(() => makeCheckResult({ id: 'lockfile', status: 'ok', unchecked: 2 })).toThrow(/use degraded/);
  });
});

describe('normalizeOsvSeverity', () => {
  it.each([['MODERATE', 'medium'], ['CRITICAL', 'critical'], ['bogus', 'unknown'], [undefined, 'unknown']])('%s → %s', (word, sev) => {
    expect(normalizeOsvSeverity(word)).toBe(sev);
  });
});
