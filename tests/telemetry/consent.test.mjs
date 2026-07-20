/**
 * tests/telemetry/consent.test.mjs
 *
 * Unit tests for scripts/lib/telemetry/consent.mjs (Epic #841, S1 / GL #842).
 *
 * Fail-closed is the load-bearing property: `send` may be true ONLY on an
 * explicitly affirmative signal. Each of the 11 contract invariants is pinned
 * by its own test below.
 *
 * Isolation: every test writes to a per-test mkdtempSync directory and injects
 * the path — NEVER ~/.config. No personal paths appear in any fixture.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  CONSENT_SCHEMA_VERSION,
  TELEMETRY_DIR,
  TELEMETRY_JSON_PATH,
  TELEMETRY_QUEUE_PATH,
  readTelemetryState,
  writeTelemetryState,
  resolveConsent,
  grantConsent,
  denyConsent,
  isCiEnv,
  isHeadless,
} from '../../scripts/lib/telemetry/consent.mjs';

let tmp;
let statePath;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'so-telemetry-'));
  statePath = join(tmp, 'telemetry.json');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('constants', () => {
  it('CONSENT_SCHEMA_VERSION is 1', () => {
    expect(CONSENT_SCHEMA_VERSION).toBe(1);
  });

  it('paths are anchored under the session-orchestrator config dir', () => {
    expect(TELEMETRY_JSON_PATH).toBe(join(TELEMETRY_DIR, 'telemetry.json'));
    expect(TELEMETRY_QUEUE_PATH).toBe(join(TELEMETRY_DIR, 'telemetry-queue.ndjson'));
  });
});

// ---------------------------------------------------------------------------
// Invariant 1 — Missing file → no-consent, send false, no throw.
// ---------------------------------------------------------------------------

describe('invariant 1: missing file', () => {
  it('reads as source=default with an all-null record', () => {
    const res = readTelemetryState({ path: statePath });
    expect(res.source).toBe('default');
    expect(res.errors).toEqual([]);
    expect(res.record).toEqual({
      schema_version: 1,
      consent: null,
      decided_at: null,
      anon_id: null,
      anon_id_created_at: null,
      last_flush_at: null,
    });
  });

  it('resolves to no-consent, send false, without throwing', () => {
    const { record } = readTelemetryState({ path: statePath });
    const verdict = resolveConsent({ env: {}, ownerConfig: {}, state: record, interactive: false });
    expect(verdict.state).toBe('no-consent');
    expect(verdict.send).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Invariant 2 — Corrupt file → source 'corrupt', default record, send false, WARN.
// ---------------------------------------------------------------------------

describe('invariant 2: corrupt file', () => {
  it('garbage bytes → corrupt, default record, stderr WARN, send false', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    writeFileSync(statePath, '\x00\x01\xffnot json at all', 'utf8');

    const res = readTelemetryState({ path: statePath });
    expect(res.source).toBe('corrupt');
    expect(res.record.consent).toBe(null);
    expect(res.record.schema_version).toBe(1);
    expect(res.errors.length).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('telemetry status');

    const verdict = resolveConsent({ state: res.record, env: {}, ownerConfig: {} });
    expect(verdict.send).toBe(false);
  });

  it('half JSON → corrupt', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    writeFileSync(statePath, '{"schema_version": 1, "consent":', 'utf8');
    expect(readTelemetryState({ path: statePath }).source).toBe('corrupt');
  });

  it('array instead of object → corrupt', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    writeFileSync(statePath, '[1, 2, 3]', 'utf8');
    const res = readTelemetryState({ path: statePath });
    expect(res.source).toBe('corrupt');
    expect(res.record.consent).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// Invariants 3 & 4 — no consent + interactive flag controls prompt only.
// ---------------------------------------------------------------------------

describe('invariants 3 & 4: no-consent prompt gating', () => {
  it('consent null + interactive false → prompt false, send false', () => {
    const verdict = resolveConsent({ env: {}, ownerConfig: {}, state: null, interactive: false });
    expect(verdict.state).toBe('no-consent');
    expect(verdict.prompt).toBe(false);
    expect(verdict.send).toBe(false);
  });

  it('consent null + interactive true → prompt true, send false', () => {
    const verdict = resolveConsent({ env: {}, ownerConfig: {}, state: null, interactive: true });
    expect(verdict.state).toBe('no-consent');
    expect(verdict.prompt).toBe(true);
    expect(verdict.send).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Invariant 5 — DO_NOT_TRACK is the top of the precedence stack.
// (Fake-regression target: SO_TELEMETRY-before-DO_NOT_TRACK must go RED here.)
// ---------------------------------------------------------------------------

describe('invariant 5: DO_NOT_TRACK precedence', () => {
  it('DO_NOT_TRACK=1 beats granted-consent AND fleet AND SO_TELEMETRY=1', () => {
    const verdict = resolveConsent({
      env: { DO_NOT_TRACK: '1', SO_TELEMETRY: '1' },
      ownerConfig: { telemetry: { enabled: true } },
      state: { consent: 'granted' },
      interactive: true,
    });
    expect(verdict.state).toBe('disabled-env');
    expect(verdict.send).toBe(false);
    expect(verdict.reason).toBe('DO_NOT_TRACK is set');
  });

  it.each([['1'], ['true'], ['yes'], [' 1 ']])(
    'DO_NOT_TRACK=%j counts as set → disabled-env',
    (value) => {
      const verdict = resolveConsent({
        env: { DO_NOT_TRACK: value, SO_TELEMETRY: '1' },
        state: { consent: 'granted' },
      });
      expect(verdict.state).toBe('disabled-env');
      expect(verdict.send).toBe(false);
    },
  );

  it.each([[''], ['0'], ['false'], ['FALSE']])(
    'DO_NOT_TRACK=%j does NOT count as set (SO_TELEMETRY=1 wins → enabled-env)',
    (value) => {
      const verdict = resolveConsent({
        env: { DO_NOT_TRACK: value, SO_TELEMETRY: '1' },
        state: null,
      });
      expect(verdict.state).toBe('enabled-env');
      expect(verdict.send).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// Invariant 6 — SO_TELEMETRY_DISABLED beats SO_TELEMETRY.
// ---------------------------------------------------------------------------

describe('invariant 6: disable-env beats enable-env', () => {
  it('SO_TELEMETRY_DISABLED=1 + SO_TELEMETRY=1 → disabled-env', () => {
    const verdict = resolveConsent({
      env: { SO_TELEMETRY_DISABLED: '1', SO_TELEMETRY: '1' },
      state: { consent: 'granted' },
    });
    expect(verdict.state).toBe('disabled-env');
    expect(verdict.send).toBe(false);
    expect(verdict.reason).toBe('SO_TELEMETRY_DISABLED=1');
  });
});

// ---------------------------------------------------------------------------
// Invariant 7 — fleet flag requires strict boolean true.
// ---------------------------------------------------------------------------

describe('invariant 7: fleet flag strictness', () => {
  it('ownerConfig.telemetry absent → no fleet (falls to no-consent)', () => {
    const verdict = resolveConsent({ env: {}, ownerConfig: {}, state: null });
    expect(verdict.state).toBe('no-consent');
    expect(verdict.send).toBe(false);
  });

  it('telemetry.enabled === true → enabled-fleet, send true', () => {
    const verdict = resolveConsent({
      env: {},
      ownerConfig: { telemetry: { enabled: true } },
      state: null,
    });
    expect(verdict.state).toBe('enabled-fleet');
    expect(verdict.send).toBe(true);
  });

  it('telemetry.enabled = "true" (string) → NOT fleet (no-consent)', () => {
    const verdict = resolveConsent({
      env: {},
      ownerConfig: { telemetry: { enabled: 'true' } },
      state: null,
    });
    expect(verdict.state).toBe('no-consent');
    expect(verdict.send).toBe(false);
  });

  it('telemetry.enabled = 1 (number) → NOT fleet (no-consent)', () => {
    const verdict = resolveConsent({
      env: {},
      ownerConfig: { telemetry: { enabled: 1 } },
      state: null,
    });
    expect(verdict.state).toBe('no-consent');
    expect(verdict.send).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Invariant 8 — fleet outranks stored denied; per-shell disable outranks fleet.
// ---------------------------------------------------------------------------

describe('invariant 8: fleet vs consent vs per-shell escape', () => {
  it('fleet enabled + stored consent denied → enabled-fleet (owner.yaml wins)', () => {
    const verdict = resolveConsent({
      env: {},
      ownerConfig: { telemetry: { enabled: true } },
      state: { consent: 'denied' },
    });
    expect(verdict.state).toBe('enabled-fleet');
    expect(verdict.send).toBe(true);
  });

  it('SO_TELEMETRY_DISABLED=1 beats fleet enabled (per-shell escape)', () => {
    const verdict = resolveConsent({
      env: { SO_TELEMETRY_DISABLED: '1' },
      ownerConfig: { telemetry: { enabled: true } },
      state: { consent: 'denied' },
    });
    expect(verdict.state).toBe('disabled-env');
    expect(verdict.send).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Stored-consent precedence when no env / fleet signal is present.
// ---------------------------------------------------------------------------

describe('stored consent', () => {
  it('consent granted → enabled-consent, send true', () => {
    const verdict = resolveConsent({ env: {}, ownerConfig: {}, state: { consent: 'granted' } });
    expect(verdict.state).toBe('enabled-consent');
    expect(verdict.send).toBe(true);
  });

  it('consent denied → disabled-consent, send false', () => {
    const verdict = resolveConsent({ env: {}, ownerConfig: {}, state: { consent: 'denied' } });
    expect(verdict.state).toBe('disabled-consent');
    expect(verdict.send).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Invariant 9 — isCiEnv / isHeadless.
// ---------------------------------------------------------------------------

describe('invariant 9: isCiEnv / isHeadless', () => {
  it('CI=1 → headless true', () => {
    expect(isHeadless({ CI: '1' }, { stdout: { isTTY: true } })).toBe(true);
  });

  it('CI="" + interactive TTY → not headless', () => {
    expect(isHeadless({ CI: '' }, { stdout: { isTTY: true } })).toBe(false);
  });

  it('CI="" + non-TTY stdout → headless', () => {
    expect(isHeadless({ CI: '' }, { stdout: { isTTY: false } })).toBe(true);
  });

  it('no CI + interactive TTY → not headless', () => {
    expect(isHeadless({}, { stdout: { isTTY: true } })).toBe(false);
  });

  it('stdout undefined → headless', () => {
    expect(isHeadless({}, {})).toBe(true);
  });

  it('isCiEnv: CI=false / CI=0 / CI="" → false', () => {
    expect(isCiEnv({ CI: 'false' })).toBe(false);
    expect(isCiEnv({ CI: '0' })).toBe(false);
    expect(isCiEnv({ CI: '' })).toBe(false);
  });

  it('isCiEnv: GITHUB_ACTIONS / GITLAB_CI present → true', () => {
    expect(isCiEnv({ GITHUB_ACTIONS: 'true' })).toBe(true);
    expect(isCiEnv({ GITLAB_CI: 'true' })).toBe(true);
    expect(isCiEnv({ CONTINUOUS_INTEGRATION: '1' })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invariant 10 — writeTelemetryState creates a missing directory.
// ---------------------------------------------------------------------------

describe('invariant 10: write creates missing directory', () => {
  it('writes into a not-yet-existent nested dir, ok true, and round-trips', () => {
    const nested = join(tmp, 'a', 'b', 'c', 'telemetry.json');
    expect(existsSync(join(tmp, 'a'))).toBe(false);

    const record = {
      schema_version: 1,
      consent: 'granted',
      decided_at: '2026-07-20T00:00:00.000Z',
      anon_id: null,
      anon_id_created_at: null,
      last_flush_at: null,
    };
    const res = writeTelemetryState(record, { path: nested });
    expect(res.ok).toBe(true);
    expect(existsSync(nested)).toBe(true);

    const back = readTelemetryState({ path: nested });
    expect(back.source).toBe('file');
    expect(back.record.consent).toBe('granted');
  });
});

// ---------------------------------------------------------------------------
// Invariant 11 — grantConsent on a corrupt file starts from defaults.
// ---------------------------------------------------------------------------

describe('invariant 11: grantConsent on corrupt file', () => {
  it('starts from default record, produces a valid granted record', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    writeFileSync(statePath, 'totally corrupt }{', 'utf8');

    const res = grantConsent({ path: statePath, now: '2026-07-20T12:00:00.000Z' });
    expect(res.ok).toBe(true);
    expect(res.record.consent).toBe('granted');
    expect(res.record.decided_at).toBe('2026-07-20T12:00:00.000Z');
    expect(res.record.anon_id).toBe(null);
    expect(res.record.schema_version).toBe(1);

    const back = readTelemetryState({ path: statePath });
    expect(back.source).toBe('file');
    expect(back.record.consent).toBe('granted');
  });
});

// ---------------------------------------------------------------------------
// grant/deny preserve anon_id fields and unknown fields (additive tolerance).
// ---------------------------------------------------------------------------

describe('grant/deny field preservation', () => {
  it('grantConsent leaves anon_id and unknown fields untouched', () => {
    const seed = {
      schema_version: 1,
      consent: null,
      decided_at: null,
      anon_id: '11111111-2222-3333-4444-555555555555',
      anon_id_created_at: '2026-07-01T00:00:00.000Z',
      last_flush_at: '2026-07-10T00:00:00.000Z',
      future_field: 'keep-me',
    };
    writeFileSync(statePath, JSON.stringify(seed), 'utf8');

    const res = grantConsent({ path: statePath, now: '2026-07-20T09:00:00.000Z' });
    expect(res.record.consent).toBe('granted');
    expect(res.record.decided_at).toBe('2026-07-20T09:00:00.000Z');
    expect(res.record.anon_id).toBe('11111111-2222-3333-4444-555555555555');
    expect(res.record.anon_id_created_at).toBe('2026-07-01T00:00:00.000Z');
    expect(res.record.last_flush_at).toBe('2026-07-10T00:00:00.000Z');
    expect(res.record.future_field).toBe('keep-me');
  });

  it('denyConsent records denied while preserving anon_id', () => {
    const seed = {
      schema_version: 1,
      consent: 'granted',
      decided_at: '2026-07-01T00:00:00.000Z',
      anon_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      anon_id_created_at: '2026-07-01T00:00:00.000Z',
      last_flush_at: null,
    };
    writeFileSync(statePath, JSON.stringify(seed), 'utf8');

    const res = denyConsent({ path: statePath, now: '2026-07-20T10:00:00.000Z' });
    expect(res.ok).toBe(true);
    expect(res.record.consent).toBe('denied');
    expect(res.record.decided_at).toBe('2026-07-20T10:00:00.000Z');
    expect(res.record.anon_id).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });
});

// ---------------------------------------------------------------------------
// readTelemetryState additive tolerance (valid partial file).
// ---------------------------------------------------------------------------

describe('readTelemetryState additive tolerance', () => {
  it('fills missing known fields from defaults and preserves unknown fields', () => {
    writeFileSync(statePath, JSON.stringify({ consent: 'granted', unknown_key: 42 }), 'utf8');
    const res = readTelemetryState({ path: statePath });
    expect(res.source).toBe('file');
    expect(res.record.consent).toBe('granted');
    expect(res.record.anon_id).toBe(null);
    expect(res.record.last_flush_at).toBe(null);
    expect(res.record.unknown_key).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// writeTelemetryState surfaces a filesystem failure without throwing.
// ---------------------------------------------------------------------------

describe('writeTelemetryState failure path', () => {
  it('returns ok:false when the target path is unwritable (a file sits where a dir is needed)', () => {
    const blocker = join(tmp, 'blocker');
    writeFileSync(blocker, 'i am a file, not a dir', 'utf8');
    // Ask to write "under" a regular file — mkdir/rename must fail, not throw.
    const res = writeTelemetryState({ schema_version: 1 }, { path: join(blocker, 'telemetry.json') });
    expect(res.ok).toBe(false);
    expect(typeof res.error).toBe('string');
  });
});
