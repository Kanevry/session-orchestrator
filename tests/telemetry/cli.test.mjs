/**
 * tests/telemetry/cli.test.mjs
 *
 * Integration tests for scripts/telemetry.mjs — the operator CLI (Epic #841,
 * Issue #844 / S3). Strategy: spawn the CLI as a real subprocess with an ISOLATED
 * HOME (mkdtempSync) so all host-local state (telemetry.json, telemetry-queue.ndjson)
 * lands under the tmp dir — os.homedir() honors $HOME on POSIX. Env kill-switches
 * inherited from the runner are explicitly cleared per run so consent resolves
 * deterministically.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unwritablePath } from '../_helpers/unwritable-path.mjs';

const CLI = path.resolve(import.meta.dirname, '../../scripts/telemetry.mjs');
const REPO_VERSION = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, '../../package.json'), 'utf8'),
).version;

let tmpHome;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'telemetry-cli-'));
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

/** Path where the CLI persists consent under the isolated HOME. */
function telemetryJsonPath() {
  return join(tmpHome, '.config', 'session-orchestrator', 'telemetry.json');
}

function runCli(args, extraEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: tmpHome,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: tmpHome,
      // Clear ambient kill-switches / opt-ins so consent resolves from the file.
      DO_NOT_TRACK: '',
      SO_TELEMETRY: '',
      SO_TELEMETRY_DISABLED: '',
      SO_TELEMETRY_DEBUG: '',
      SO_TELEMETRY_ENDPOINT: '',
      ...extraEnv,
    },
  });
}

// ---------------------------------------------------------------------------
// status --json
// ---------------------------------------------------------------------------

describe('telemetry status --json', () => {
  it('emits the resolved posture shape with no consent on a fresh host', () => {
    const res = runCli(['status', '--json']);
    expect(res.status).toBe(0);

    const out = JSON.parse(res.stdout);
    expect(out).toMatchObject({
      state: 'no-consent',
      send: false,
      consent: null,
      anon_id_present: false,
      last_flush_at: null,
      queue: { count: 0, bytes: 0 },
    });
  });
});

// ---------------------------------------------------------------------------
// enable → disable roundtrip
// ---------------------------------------------------------------------------

describe('telemetry enable / disable roundtrip', () => {
  it('persists granted then denied consent, reflected in status', () => {
    const enableRes = runCli(['enable']);
    expect(enableRes.status).toBe(0);
    expect(existsSync(telemetryJsonPath())).toBe(true);

    const afterEnable = JSON.parse(runCli(['status', '--json']).stdout);
    expect(afterEnable.state).toBe('enabled-consent');
    expect(afterEnable.send).toBe(true);
    expect(afterEnable.consent).toBe('granted');

    const disableRes = runCli(['disable']);
    expect(disableRes.status).toBe(0);

    const afterDisable = JSON.parse(runCli(['status', '--json']).stdout);
    expect(afterDisable.state).toBe('disabled-consent');
    expect(afterDisable.send).toBe(false);
    expect(afterDisable.consent).toBe('denied');
  });
});

// ---------------------------------------------------------------------------
// unknown subcommand → exit 1
// ---------------------------------------------------------------------------

describe('telemetry — unknown subcommand', () => {
  it('exits 1 and names the offending subcommand on stderr', () => {
    const res = runCli(['bogus']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('unknown subcommand');
    expect(res.stderr).toContain('bogus');
  });
});

// ---------------------------------------------------------------------------
// show — placeholder id, no state file written
// ---------------------------------------------------------------------------

describe('telemetry show', () => {
  it('previews with an anon_id placeholder and never creates telemetry.json', () => {
    const res = runCli(['show', '--json']);
    expect(res.status).toBe(0);

    const record = JSON.parse(res.stdout);
    expect(record.record_kind).toBe('usage-ping');
    expect(record.anon_id).toBe('(generated on first send)');

    // The lazy-ID invariant holds for `show`: nothing is minted or persisted.
    expect(existsSync(telemetryJsonPath())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// enable under DO_NOT_TRACK=1 → WARN on stderr (env override still wins)
// ---------------------------------------------------------------------------

describe('telemetry enable under DO_NOT_TRACK=1', () => {
  it('persists consent but warns that the env kill-switch overrides the file', () => {
    const res = runCli(['enable'], { DO_NOT_TRACK: '1' });
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('DO_NOT_TRACK');
    expect(res.stderr.toLowerCase()).toContain('override');

    // The file records the grant, but effective posture stays disabled-env.
    expect(existsSync(telemetryJsonPath())).toBe(true);
    const status = JSON.parse(runCli(['status', '--json'], { DO_NOT_TRACK: '1' }).stdout);
    expect(status.state).toBe('disabled-env');
    expect(status.send).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// --help / --version (exit 0)
// ---------------------------------------------------------------------------

describe('telemetry --help / --version', () => {
  it('--help prints the usage block and exits 0', () => {
    const res = runCli(['--help']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('SUBCOMMANDS');
    expect(res.stdout).toContain('EXIT CODES');
  });

  it('--version prints the plugin version and exits 0', () => {
    const res = runCli(['--version']);
    expect(res.status).toBe(0);
    // SO_PLUGIN_ROOT resolves via import.meta walk-up → the repo version; if the
    // root is unresolvable in some environment the resolver returns 'unknown'.
    expect(res.stdout.trim() === REPO_VERSION || res.stdout.trim() === 'unknown').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// human-readable status (no --json)
// ---------------------------------------------------------------------------

describe('telemetry status (human-readable)', () => {
  it('prints the labelled posture block on a fresh host', () => {
    const res = runCli(['status']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('state:');
    expect(res.stdout).toContain('no-consent');
    expect(res.stdout).toContain('send:');
    expect(res.stdout).toContain('queue:');
  });
});

// ---------------------------------------------------------------------------
// persist failure → exit 2 (unwritable HOME makes telemetry.json write fail)
// ---------------------------------------------------------------------------

describe('telemetry enable / disable — persist failure exits 2', () => {
  it('enable exits 2 with a stderr diagnostic when consent cannot be persisted', () => {
    if (process.platform === 'win32') return; // unwritablePath is POSIX-only
    const res = runCli(['enable'], { HOME: unwritablePath('telemetry-home') });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('failed to persist');
  });

  it('disable exits 2 with a stderr diagnostic when consent cannot be persisted', () => {
    if (process.platform === 'win32') return; // unwritablePath is POSIX-only
    const res = runCli(['disable'], { HOME: unwritablePath('telemetry-home') });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('failed to persist');
  });
});
