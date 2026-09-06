/**
 * tests/lib/plugin-update-banner.test.mjs
 *
 * Suite for scripts/lib/plugin-update-banner.mjs (#nnn, d7 R2).
 *
 * THE DEFECT THIS FILE PINS — measured 2026-09-06: the operator's host ran the
 * marketplace-cache copy at 3.19.0 (installed 2026-08-09) while repo and npm
 * were at 3.24.0. Five minors, four weeks, no warning of any kind, because no
 * code anywhere compared installed against available. Each `it()` below names
 * the concrete bug it would catch (TV-001); the two that matter most are
 * (a) the five-minor silence itself and (c) a FAILED fetch reading as
 * "up to date", which would re-create the silence behind a green check (#1031).
 *
 * Isolation: `env` is passed EXPLICITLY to every call. Reading `process.env`
 * would make an ambient `DO_NOT_TRACK` on the developer's machine turn every
 * assertion below into a vacuous pass — the probe would return null for the
 * wrong reason and the suite would stay green.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkPluginUpdate,
  readCachedLatest,
  readInstalledPluginVersion,
  CACHE_FILENAME,
  CACHE_TTL_MS,
} from '@lib/plugin-update-banner.mjs';

const NOW = Date.parse('2026-09-06T12:00:00.000Z');

let tmpRoot;
let pluginRoot;
let cacheDir;
const savedEnv = {};

/** Host-state env keys this suite redirects into the fixture (never the operator's). */
const ISOLATED_ENV_KEYS = [
  'SO_CONFIG_HOME',
  'SO_SESSION_REGISTRY_DIR',
  'SO_VAULT_DIR',
  'SO_TELEMETRY_DISABLED',
];

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'plugin-update-banner-'));
  pluginRoot = join(tmpRoot, 'plugin');
  cacheDir = join(tmpRoot, '.orchestrator', 'runtime');
  mkdirSync(pluginRoot, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });

  for (const key of ISOLATED_ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.SO_CONFIG_HOME = join(tmpRoot, 'config');
  process.env.SO_SESSION_REGISTRY_DIR = join(tmpRoot, 'registry');
  process.env.SO_VAULT_DIR = join(tmpRoot, 'vault');
  process.env.SO_TELEMETRY_DISABLED = '1';
});

afterEach(() => {
  for (const key of ISOLATED_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** Write the fixture plugin's package.json. */
function installVersion(version) {
  writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({ name: 'session-orchestrator', version }));
}

/** Seed the latest-version cache with an explicit age. */
function seedCache(version, ageMs) {
  writeFileSync(
    join(cacheDir, CACHE_FILENAME),
    JSON.stringify({ version, fetched_at: new Date(NOW - ageMs).toISOString() }),
  );
}

/** A fetch double that records its calls and answers with `body`. */
function fakeFetch(body, { ok = true } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return { ok, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

/** A fetch double that always rejects, mimicking offline / AbortSignal timeout. */
function rejectingFetch(message = 'The operation was aborted due to timeout') {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    throw new Error(message);
  };
  fn.calls = calls;
  return fn;
}

const run = (over = {}) =>
  checkPluginUpdate({ pluginRoot, cacheDir, env: {}, now: NOW, ...over });

describe('checkPluginUpdate — version comparison', () => {
  // BUG: 3.19.0 loaded against 3.24.0 published produced NO signal for four
  // weeks. This is that exact case, with the exact numbers.
  it('(a) warns with both versions when the install is 5 minors behind', async () => {
    installVersion('3.19.0');
    const fetchImpl = fakeFetch({ version: '3.24.0' });

    const result = await run({ fetchImpl });

    expect(result).not.toBeNull();
    expect(result.severity).toBe('warn');
    expect(result.installed).toBe('3.19.0');
    expect(result.latest).toBe('3.24.0');
    expect(result.message).toContain('3.19.0');
    expect(result.message).toContain('3.24.0');
    expect(result.message).toContain('5 Minors zurück');
    // The remedy has to be in the line: a warning the operator cannot act on
    // is the same silence with extra steps.
    expect(result.message).toContain('/plugin update session-orchestrator@kanevry');
    expect(result.message).toContain('neu starten');
  });

  // BUG: an off-by-one plural or a `>=` in the minor comparison would make the
  // probe warn on every session where the install is CURRENT — the fastest way
  // to teach an operator to ignore the line (HR-101).
  it('(b) says nothing when installed equals latest', async () => {
    installVersion('3.24.0');
    expect(await run({ fetchImpl: fakeFetch({ version: '3.24.0' }) })).toBeNull();
  });

  it('stays silent on patch-only drift', async () => {
    installVersion('3.24.0');
    expect(await run({ fetchImpl: fakeFetch({ version: '3.24.7' }) })).toBeNull();
  });

  it('warns on a major jump', async () => {
    installVersion('3.24.0');
    const major = await run({ fetchImpl: fakeFetch({ version: '4.0.0' }) });
    expect(major.message).toContain('1 Major zurück');
  });

  // BUG: a local checkout is routinely AHEAD of the registry between releases.
  // A naive `installed !== latest` test would warn on every single session in
  // this very repo.
  it('says nothing when the running build is ahead of the registry', async () => {
    installVersion('3.25.0');
    expect(await run({ fetchImpl: fakeFetch({ version: '3.24.0' }) })).toBeNull();
  });
});

describe('checkPluginUpdate — fail silent, never optimistic (#1031)', () => {
  // BUG: the whole point. A fetch that failed says NOTHING about freshness. If
  // it were allowed to write a cache entry — or to be read as "no update" — the
  // next 24 h of session starts would confidently report an all-clear nobody
  // measured, which is precisely the four-week silence this probe exists to end.
  it('(c) returns null on a rejected/timed-out fetch and writes NO cache entry', async () => {
    installVersion('3.19.0');
    const fetchImpl = rejectingFetch();

    const result = await run({ fetchImpl });

    expect(result).toBeNull();
    expect(fetchImpl.calls).toHaveLength(1);
    // Nothing on disk: no "ok", no sentinel, nothing a later run could read.
    expect(existsSync(join(cacheDir, CACHE_FILENAME))).toBe(false);
    expect(readCachedLatest({ cacheDir, now: NOW })).toBeNull();
  });

  it('returns null on a non-2xx response and writes no cache entry', async () => {
    installVersion('3.19.0');
    const fetchImpl = fakeFetch({ version: '3.24.0' }, { ok: false });

    expect(await run({ fetchImpl })).toBeNull();
    expect(existsSync(join(cacheDir, CACHE_FILENAME))).toBe(false);
  });

  it('returns null on a malformed registry document and writes no cache entry', async () => {
    installVersion('3.19.0');

    expect(await run({ fetchImpl: fakeFetch({ nope: true }) })).toBeNull();
    expect(existsSync(join(cacheDir, CACHE_FILENAME))).toBe(false);
  });

  it('returns null (no request) when the installed version is unreadable', async () => {
    // No package.json in pluginRoot at all.
    const fetchImpl = fakeFetch({ version: '3.24.0' });
    expect(await run({ fetchImpl })).toBeNull();
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('returns null (no request) when no cacheDir is given', async () => {
    installVersion('3.19.0');
    const fetchImpl = fakeFetch({ version: '3.24.0' });
    expect(await checkPluginUpdate({ pluginRoot, env: {}, now: NOW, fetchImpl })).toBeNull();
    expect(fetchImpl.calls).toHaveLength(0);
  });
});

describe('checkPluginUpdate — cache', () => {
  // BUG: without a TTL-respecting cache read, every session start on the host
  // issues an npm request — a per-session network call for a number that
  // changes a few times a month.
  it('(d) does not call fetch when a fresh cache entry exists', async () => {
    installVersion('3.19.0');
    seedCache('3.24.0', 60 * 60 * 1000); // 1 h old
    const fetchImpl = fakeFetch({ version: '9.9.9' });

    const result = await run({ fetchImpl });

    expect(fetchImpl.calls).toHaveLength(0);
    expect(result.latest).toBe('3.24.0');
  });

  it('refetches once the cache entry is older than 24 h', async () => {
    installVersion('3.19.0');
    seedCache('3.20.0', CACHE_TTL_MS + 1000);
    const fetchImpl = fakeFetch({ version: '3.24.0' });

    const result = await run({ fetchImpl });

    expect(fetchImpl.calls).toHaveLength(1);
    expect(result.latest).toBe('3.24.0');
    // ...and the refreshed value is persisted with the injected clock.
    const onDisk = JSON.parse(readFileSync(join(cacheDir, CACHE_FILENAME), 'utf8'));
    expect(onDisk.version).toBe('3.24.0');
    expect(Date.parse(onDisk.fetched_at)).toBe(NOW);
  });

  // BUG: a future-dated stamp (clock skew, hand edit) would pin `now - fetched`
  // negative and keep the entry "fresh" forever — a cache that never expires.
  it('treats a future-dated cache stamp as stale', () => {
    seedCache('3.24.0', -60_000);
    expect(readCachedLatest({ cacheDir, now: NOW })).toBeNull();
  });

  it('treats a corrupt cache file as absent', () => {
    writeFileSync(join(cacheDir, CACHE_FILENAME), '{not json');
    expect(readCachedLatest({ cacheDir, now: NOW })).toBeNull();
  });
});

describe('checkPluginUpdate — kill switches', () => {
  // BUG: a probe that talks to a public registry on every session start with no
  // off switch is telemetry an operator never agreed to. Each of these must
  // short-circuit BEFORE the request, not merely suppress the banner after it.
  it.each([
    ['SO_DISABLE_UPDATE_CHECK', '1'],
    ['DO_NOT_TRACK', '1'],
    ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', '1'],
  ])('(e) %s=%s returns null without any fetch', async (key, value) => {
    installVersion('3.19.0');
    const fetchImpl = fakeFetch({ version: '3.24.0' });

    const result = await run({ env: { [key]: value }, fetchImpl });

    expect(result).toBeNull();
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('ignores a kill switch set to an explicitly falsy value', async () => {
    installVersion('3.19.0');
    const fetchImpl = fakeFetch({ version: '3.24.0' });

    const result = await run({ env: { DO_NOT_TRACK: '0', SO_DISABLE_UPDATE_CHECK: '' }, fetchImpl });

    expect(result).not.toBeNull();
    expect(fetchImpl.calls).toHaveLength(1);
  });
});

describe('readInstalledPluginVersion', () => {
  // BUG (d7 reason 3): bootstrap.lock's refreshed-plugin-version was stamped
  // from the CHECKOUT's package.json while 3.19.0 was the code actually loaded.
  // The default MUST be the running module's own package root, so the answer
  // cannot disagree with the bytes that are executing.
  it('defaults to the running plugin package, not $CLAUDE_PLUGIN_ROOT', () => {
    const saved = process.env.CLAUDE_PLUGIN_ROOT;
    installVersion('0.0.1-fixture');
    process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;
    try {
      const running = readInstalledPluginVersion();
      expect(running).not.toBe('0.0.1-fixture');
      // It is this repo's real package.json — the one next to scripts/lib/.
      const repoVersion = JSON.parse(
        readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
      ).version;
      expect(running).toBe(repoVersion);
      // ...and an explicit root still wins for callers that know better.
      expect(readInstalledPluginVersion(pluginRoot)).toBe('0.0.1-fixture');
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
      else process.env.CLAUDE_PLUGIN_ROOT = saved;
    }
  });
});
