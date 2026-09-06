/**
 * tests/telemetry/config.test.mjs — pure env-resolution contract for the ingest
 * server config (Epic #841, S5 / GitLab #846; PRD §3-FA4).
 *
 * resolveConfig(env) is PURE — every test passes an explicit env object (never
 * process.env), so there is no I/O and no host path in this file. The tests pin
 * the documented v1 defaults, the whitespace-trap fallback, the trustProxy '0'
 * opt-out, and the positive-number clamp: a negative / zero / NaN override must
 * fall back to the default rather than leak a bad value into the limiter or the
 * body-cap check (.claude/rules/development.md § Env-var fallback whitespace trap).
 */

import { describe, it, expect } from 'vitest';
import { resolveConfig } from '../../server/ingest/config.mjs';

describe('resolveConfig — documented v1 defaults', () => {
  it('resolves the full default config from an empty env', () => {
    expect(resolveConfig({})).toEqual({
      port: 8787,
      dbPath: './data/records.db',
      bodyCap: 32768,
      rateWindowMs: 3600000,
      rateLimit: 60,
      maxTrackedIps: 50000,
      trustProxy: true,
      retentionMonths: 24,
      retentionIntervalMs: 86400000,
      // #1234 — server-side fleet attribution. Empty by default, so an unset
      // SO_INGEST_FLEET_ANON_IDS leaves storage taking the client's word exactly
      // as before; see tests/server/fleet-attribution-and-digest-range.test.mjs.
      fleetAnonIds: new Set(),
    });
  });
});

describe('resolveConfig — env overrides', () => {
  it('parses a valid numeric override', () => {
    expect(resolveConfig({ SO_INGEST_BODY_CAP: '4096' }).bodyCap).toBe(4096);
  });

  it('opts out of trustProxy on the explicit "0" sentinel', () => {
    expect(resolveConfig({ SO_INGEST_TRUST_PROXY: '0' }).trustProxy).toBe(false);
  });

  it('keeps trustProxy on for the explicit "1" sentinel', () => {
    expect(resolveConfig({ SO_INGEST_TRUST_PROXY: '1' }).trustProxy).toBe(true);
  });

  it('falls back to the default on a whitespace-only value (whitespace trap)', () => {
    // A whitespace value is truthy → a naive `||` would return the spaces verbatim.
    expect(resolveConfig({ SO_INGEST_BODY_CAP: '   ' }).bodyCap).toBe(32768);
  });
});

describe('resolveConfig — positive-number clamp (no NaN / zero / negative leak)', () => {
  it.each([
    ['negative', '-5'],
    ['zero', '0'],
    ['non-numeric', 'lots'],
    ['NaN literal', 'NaN'],
    ['whitespace', '  '],
  ])('falls back to the default bodyCap on a %s override', (_name, raw) => {
    expect(resolveConfig({ SO_INGEST_BODY_CAP: raw }).bodyCap).toBe(32768);
  });

  it('clamps a negative rate limit back to the default (never a negative limit into the limiter)', () => {
    expect(resolveConfig({ SO_INGEST_RATE_LIMIT: '-1' }).rateLimit).toBe(60);
  });

  it('clamps a zero retention window back to the default (never prunes everything)', () => {
    expect(resolveConfig({ SO_INGEST_RETENTION_MONTHS: '0' }).retentionMonths).toBe(24);
  });
});

// ---------------------------------------------------------------------------
// GitLab #1234 BUG 3 — the stored `fleet` column was whatever the client
// declared, and the client was wrong for 394 of 490 records (80,4 %, measured
// 2026-09-06): the operator's own second Mac declared itself external.
// `SO_INGEST_FLEET_ANON_IDS` is the server-side allowlist that makes the
// classification independent of the client being honest — or even correct.
// (Merged in from the misplaced tests/server/fleet-attribution-and-digest-range.test.mjs;
// tests/server/ does not exist in this repo and this file already owns resolveConfig.)
// ---------------------------------------------------------------------------

const OPERATOR_ID = 'a3bb4907-1111-4222-8333-444444444444';
const EXTERNAL_ID = '2773675c-5555-4666-8777-888888888888';

describe('resolveConfig — SO_INGEST_FLEET_ANON_IDS', () => {
  it('is an empty Set by default, so an unset var changes nothing', () => {
    expect(resolveConfig({}).fleetAnonIds).toEqual(new Set());
  });

  it('parses a comma list whitespace-safely and lowercases', () => {
    const { fleetAnonIds } = resolveConfig({ SO_INGEST_FLEET_ANON_IDS: ` ${OPERATOR_ID.toUpperCase()} , , ${EXTERNAL_ID}` });
    expect([...fleetAnonIds].sort()).toEqual([EXTERNAL_ID, OPERATOR_ID].sort());
  });
});
