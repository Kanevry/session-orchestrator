/**
 * tests/telemetry/schema.test.mjs
 *
 * Unit tests for the usage-ping schema, whitelist projection, duration bucketing,
 * and payload builder (Epic #841, S2 / GitLab #843):
 *   scripts/lib/telemetry/schema.mjs — projectUsagePing / deriveDurationBucket /
 *   buildUsagePing (roster loader + filter live in roster.test.mjs)
 *
 * The load-bearing test is the Data-Minimization projection: planted leaky fields
 * (repo / path / prompt / args / hostname) MUST be dropped, asserted individually.
 *
 * ── FAKE-REGRESSION (privacy tripwire, per .claude/rules/testing.md) ──────────
 * The "drops every planted non-whitelisted field" test bites only because
 * USAGE_PING_FIELDS is the ONLY gate. Verified this session by temporarily adding
 * 'repo' to USAGE_PING_FIELDS: the `'repo' in projected → false` assertion went
 * RED (1 failed), confirming the guard is real; reverted → green. A green test
 * alone never proves an absence guard bites — only the red-on-drift observation
 * does.
 *
 * Duration/build inputs use fixed ISO timestamps, so no assertion can time-bomb.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  USAGE_PING_SCHEMA_VERSION,
  USAGE_PING_FIELDS,
  DURATION_BUCKETS,
  projectUsagePing,
  deriveDurationBucket,
  buildUsagePing,
  normalizeOs,
  normalizeArch,
} from '../../scripts/lib/telemetry/schema.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The repo's real package.json version — the SSOT the dedup'd resolver reads. */
const REPO_VERSION = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;

const START = '2026-07-20T00:00:00.000Z';
/** deriveDurationBucket for a duration of `seconds` (test-data setup, not a mirrored assertion). */
function bucketFor(seconds) {
  const completed = new Date(Date.parse(START) + seconds * 1000).toISOString();
  return deriveDurationBucket(START, completed);
}

describe('usage-ping constants', () => {
  it('schema version is 1', () => {
    expect(USAGE_PING_SCHEMA_VERSION).toBe(1);
  });

  it('exposes the exact duration-bucket tokens', () => {
    expect(DURATION_BUCKETS).toEqual(['<15m', '15-60m', '1-3h', '>3h']);
  });

  it('whitelist carries the agreed field set', () => {
    expect(USAGE_PING_FIELDS).toEqual([
      'record_kind',
      'schema_version',
      'anon_id',
      'sent_at',
      'plugin_version',
      'platform',
      'os',
      'arch',
      'node_major',
      'ci',
      'fleet',
      'session_type',
      'duration_bucket',
      'skills',
      'commands',
    ]);
  });
});

describe('projectUsagePing — Data-Minimization whitelist', () => {
  const planted = {
    record_kind: 'usage-ping',
    schema_version: 1,
    skills: ['session-orchestrator:session-start'],
    commands: ['session'],
    // planted leaky fields — MUST be dropped
    repo: 'my-private-repo',
    path: '/home/user/secret',
    prompt: 'do the secret thing',
    args: ['-x', '--secret'],
    hostname: 'workstation-01',
  };

  it('keeps whitelisted fields', () => {
    const projected = projectUsagePing(planted);
    expect(projected.record_kind).toBe('usage-ping');
    expect(projected.schema_version).toBe(1);
    expect(projected.skills).toEqual(['session-orchestrator:session-start']);
    expect(projected.commands).toEqual(['session']);
  });

  it('drops the planted repo field', () => {
    expect('repo' in projectUsagePing(planted)).toBe(false);
  });

  it('drops the planted path field', () => {
    expect('path' in projectUsagePing(planted)).toBe(false);
  });

  it('drops the planted prompt field', () => {
    expect('prompt' in projectUsagePing(planted)).toBe(false);
  });

  it('drops the planted args field', () => {
    expect('args' in projectUsagePing(planted)).toBe(false);
  });

  it('drops the planted hostname field', () => {
    expect('hostname' in projectUsagePing(planted)).toBe(false);
  });

  it('copies array fields as NEW arrays (no reference leak)', () => {
    const input = { skills: ['a'], commands: ['b'] };
    const projected = projectUsagePing(input);
    expect(projected.skills).not.toBe(input.skills);
    expect(projected.commands).not.toBe(input.commands);
    projected.skills.push('mutated');
    expect(input.skills).toEqual(['a']);
  });

  it('returns {} for non-object input', () => {
    expect(projectUsagePing(null)).toEqual({});
    expect(projectUsagePing('nope')).toEqual({});
  });
});

describe('deriveDurationBucket — boundaries', () => {
  it('< 900s is <15m (899s)', () => {
    expect(bucketFor(899)).toBe('<15m');
  });

  it('900s crosses into 15-60m', () => {
    expect(bucketFor(900)).toBe('15-60m');
  });

  it('3599s is still 15-60m', () => {
    expect(bucketFor(3599)).toBe('15-60m');
  });

  it('3600s (exactly 1h) crosses into 1-3h', () => {
    expect(bucketFor(3600)).toBe('1-3h');
  });

  it('3601s is 1-3h', () => {
    expect(bucketFor(3601)).toBe('1-3h');
  });

  it('10800s (exactly 3h) is still 1-3h', () => {
    expect(bucketFor(10800)).toBe('1-3h');
  });

  it('10801s crosses into >3h', () => {
    expect(bucketFor(10801)).toBe('>3h');
  });

  it('unparsable timestamps fall back to the conservative <15m', () => {
    expect(deriveDurationBucket('not-a-date', 'also-bad')).toBe('<15m');
  });

  it('negative duration (completed before started) falls back to <15m', () => {
    expect(deriveDurationBucket('2026-07-20T02:00:00.000Z', '2026-07-20T00:00:00.000Z')).toBe('<15m');
  });
});

describe('buildUsagePing', () => {
  const roster = {
    skills: new Set(['session-orchestrator:session-start']),
    commands: new Set(['session']),
  };
  const sessionRecord = {
    session_type: 'deep',
    started_at: '2026-07-20T00:00:00.000Z',
    completed_at: '2026-07-20T02:00:00.000Z', // 2h → 1-3h
  };
  const skillInvocations = [
    { skill: 'session-orchestrator:session-start', event: 'selected' },
    { skill: 'session-orchestrator:session-start', event: 'selected' }, // duplicate
    { skill: 'my-private-skill', event: 'selected' }, // off-roster → other
  ];

  it('builds a whitelist-clean usage-ping without anon_id', () => {
    const ping = buildUsagePing({
      sessionRecord,
      skillInvocations,
      ownerConfig: { telemetry: { enabled: true } },
      env: { CI: 'true' },
      now: START,
      roster,
    });

    expect(ping.record_kind).toBe('usage-ping');
    expect(ping.schema_version).toBe(1);
    expect(ping.sent_at).toBe(START);
    expect(ping.session_type).toBe('deep');
    expect(ping.duration_bucket).toBe('1-3h');
    expect(ping.skills).toEqual(['other', 'session-orchestrator:session-start']);
    expect(ping.commands).toEqual([]);
    expect(ping.ci).toBe(true);
    expect(ping.fleet).toBe(true);
    // anon_id is set downstream by ensureAnonId, never by the builder.
    expect('anon_id' in ping).toBe(false);
    // environment-derived fields are wired to the right sources. process.platform
    // and process.arch are always in the closed sets on any real runner, so the
    // client-side normalization is a no-op here.
    expect(ping.os).toBe(process.platform);
    expect(ping.arch).toBe(process.arch);
    expect(ping.node_major).toBe(parseInt(process.versions.node, 10));
    // plugin_version resolves through the shared readPluginVersionFromPackageJson
    // helper (dedup): it equals the repo's package.json version, or 'unknown' if
    // the plugin root is unresolvable in this environment.
    expect(ping.plugin_version === REPO_VERSION || ping.plugin_version === 'unknown').toBe(true);
  });

  it("maps an unknown session_type to 'other'", () => {
    const ping = buildUsagePing({
      sessionRecord: { session_type: 'weird', started_at: START, completed_at: START },
      skillInvocations: [],
      env: {},
      now: START,
      roster,
    });
    expect(ping.session_type).toBe('other');
  });

  it('derives ci=false and fleet=false by default', () => {
    const ping = buildUsagePing({
      sessionRecord,
      skillInvocations: [],
      env: {},
      now: START,
      roster,
    });
    expect(ping.ci).toBe(false);
    expect(ping.fleet).toBe(false);
  });

  it("treats CI='0' and CI='false' as not-CI", () => {
    const zero = buildUsagePing({ sessionRecord, skillInvocations: [], env: { CI: '0' }, now: START, roster });
    const falsey = buildUsagePing({ sessionRecord, skillInvocations: [], env: { CI: 'false' }, now: START, roster });
    expect(zero.ci).toBe(false);
    expect(falsey.ci).toBe(false);
  });

  it('fleet is false when owner telemetry is disabled', () => {
    const ping = buildUsagePing({
      sessionRecord,
      skillInvocations: [],
      ownerConfig: { telemetry: { enabled: false } },
      env: {},
      now: START,
      roster,
    });
    expect(ping.fleet).toBe(false);
  });

  it('projects cleanly with the default (real-repo) roster without throwing', () => {
    const ping = buildUsagePing({ sessionRecord, skillInvocations, env: {}, now: START });
    // session-start IS in the real roster → survives; the private skill → other.
    expect(ping.skills).toContain('session-orchestrator:session-start');
    expect(ping.skills).toContain('other');
    expect(ping.duration_bucket).toBe('1-3h');
  });
});

describe('normalizeOs — closed-set client-side normalization', () => {
  it('keeps an in-set os verbatim', () => {
    expect(normalizeOs('linux')).toBe('linux');
    expect(normalizeOs('darwin')).toBe('darwin');
    expect(normalizeOs('win32')).toBe('win32');
    expect(normalizeOs('android')).toBe('android');
  });

  it("maps an unknown os to 'other'", () => {
    expect(normalizeOs('plan9')).toBe('other');
    expect(normalizeOs('quantum99')).toBe('other');
  });

  it("maps a non-string / empty os to 'other'", () => {
    expect(normalizeOs('')).toBe('other');
    expect(normalizeOs(undefined)).toBe('other');
    expect(normalizeOs(42)).toBe('other');
  });
});

describe('normalizeArch — closed-set client-side normalization', () => {
  it('keeps an in-set arch verbatim (incl. loong64 — sent, not degraded)', () => {
    expect(normalizeArch('loong64')).toBe('loong64');
    expect(normalizeArch('x64')).toBe('x64');
    expect(normalizeArch('arm64')).toBe('arm64');
    expect(normalizeArch('s390x')).toBe('s390x');
  });

  it("maps an unknown arch to 'other'", () => {
    expect(normalizeArch('quantum99')).toBe('other');
    expect(normalizeArch('sparc')).toBe('other');
  });

  it("maps a non-string / empty arch to 'other'", () => {
    expect(normalizeArch('')).toBe('other');
    expect(normalizeArch(undefined)).toBe('other');
    expect(normalizeArch(64)).toBe('other');
  });
});
