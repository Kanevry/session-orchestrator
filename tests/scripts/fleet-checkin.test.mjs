/**
 * tests/scripts/fleet-checkin.test.mjs — the check-in writer CLI (#1462).
 *
 * Spawns the real CLI (the production call shape, TV-005) with a per-test
 * NAVIGATOR_CONFIG_DIR, events sandbox and project dir. Defects caught:
 *   - a check-in readable by other users (mode ≠ 0600 / dir ≠ 0700);
 *   - an invalid check-in still landing on disk, or exiting 0;
 *   - a traversal session id writing outside `checkin/`;
 *   - the event leaking `auftrag_ref`, or misreporting the navigator state;
 *   - stdout lacking the navigator address session-start must address its hint
 *     to, or carrying one the lease validator refused;
 *   - stdout lacking the fallback deadline, or one that waits for a navigator
 *     that is not active (#1501 item 8: the deadline lived only as prose).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EVENTS_LEDGER_SANDBOX_ENV } from '../../scripts/lib/events.mjs';
import { validateCheckin, utcSecondsTimestamp } from '../../scripts/lib/fleet-protocol.mjs';

const CLI = path.resolve(import.meta.dirname, '../../scripts/fleet-checkin.mjs');

let tmp;
let navDir;
let ledger;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-checkin-'));
  navDir = path.join(tmp, 'navigator');
  ledger = path.join(tmp, '.orchestrator', 'metrics', 'events.jsonl');
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

/**
 * @param {string} stdin
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string }>}
 */
function runCli(stdin) {
  const env = {
    ...process.env,
    NAVIGATOR_CONFIG_DIR: navDir,
    [EVENTS_LEDGER_SANDBOX_ENV]: ledger,
    CLAUDE_PROJECT_DIR: tmp,
  };
  // Removed, not set: the live session id must not stamp the record, and a
  // configured webhook must not turn the test into a network client.
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CLANK_EVENT_SECRET;
  delete env.CLANK_EVENT_URL;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI], { env, cwd: tmp, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

function checkin(overrides = {}) {
  return {
    session: 'sess-1',
    plattform: 'kopflos',
    repo: 'session-orchestrator',
    modus: 'feature',
    auftrag_ref: '#1462-secret-ref',
    kandidaten: ['#1462'],
    schreibbereich: ['scripts/fleet-checkin.mjs'],
    rueckfall: 'stop',
    ...overrides,
  };
}

async function readEvents() {
  const raw = await fs.readFile(ledger, 'utf8').catch(() => '');
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function exists(p) {
  return fs.stat(p).then(() => true, () => false);
}

describe('fleet-checkin CLI', () => {
  it('valid input → 0600 file in a 0700 dir, zeit stamped, one event without auftrag_ref', async () => {
    const r = await runCli(JSON.stringify(checkin()));
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    const file = path.join(navDir, 'checkin', 'sess-1.json');
    const content = JSON.parse(await fs.readFile(file, 'utf8'));
    // No active navigator: nobody will write auflagen/, so the fallback is due at once.
    expect(out).toEqual({
      ok: true,
      path: file,
      navigator_state: 'none',
      navigator_adresse: null,
      fallback_due_at: content.zeit,
      event: true,
    });

    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.join(navDir, 'checkin'))).mode & 0o777).toBe(0o700);

    expect(content.zeit).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(validateCheckin(content)).toEqual([]);

    const events = (await readEvents()).filter((e) => e.event === 'orchestrator.fleet.checkin');
    expect(events).toHaveLength(1);
    expect(events[0].navigator_state).toBe('none');
    expect(events[0].session).toBe('sess-1');
    expect(events[0]).not.toHaveProperty('auftrag_ref');
  });

  it('missing repo → exit 2, stderr names repo, no file', async () => {
    const input = checkin();
    delete input.repo;
    const r = await runCli(JSON.stringify(input));
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/fleet-checkin: .*repo/);
    expect(await exists(path.join(navDir, 'checkin', 'sess-1.json'))).toBe(false);
  });

  it('traversal session id → exit 2, nothing written anywhere under the tmp root', async () => {
    const r = await runCli(JSON.stringify(checkin({ session: '../evil' })));
    expect(r.code).toBe(2);
    expect(await exists(path.join(navDir, 'evil.json'))).toBe(false);
    expect(await exists(navDir)).toBe(false);
  });

  it('non-JSON stdin → exit 2', async () => {
    const r = await runCli('not json');
    expect(r.code).toBe(2);
    expect(await exists(navDir)).toBe(false);
  });

  // navigator_adresse is what session-start addresses its one hint to: only a
  // value the lease validator accepted may ever reach it, never a raw string.
  // fallback_due_at: 10 min after zeit only while a navigator is active; an unreadable lease is no navigator.
  it.each([
    ['a lease without adresse', {}, 'active', null, 600_000],
    ['a lease with a peer-name adresse', { adresse: 'navigator-d7' }, 'active', 'navigator-d7', 600_000],
    ['an adresse the validator refuses', { adresse: 'navigator-d7\u001b[2J; rm' }, 'unreadable', null, 0],
  ])('%s → navigator_state, navigator_adresse and the fallback deadline on stdout', async (_shape, extra, state, adresse, fallbackAfterMs) => {
    const now = Date.now();
    await fs.mkdir(path.join(navDir, 'leases'), { recursive: true });
    await fs.writeFile(
      path.join(navDir, 'leases', 'navigator.json'),
      JSON.stringify({
        session_id: 'nav-1',
        plattform: 'claude',
        seit: utcSecondsTimestamp(new Date(now - 60_000)),
        laeuft_ab: utcSecondsTimestamp(new Date(now + 3_600_000)),
        ...extra,
      }),
    );
    const r = await runCli(JSON.stringify(checkin()));
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out).toMatchObject({ navigator_state: state, navigator_adresse: adresse });
    const content = JSON.parse(await fs.readFile(path.join(navDir, 'checkin', 'sess-1.json'), 'utf8'));
    expect(Date.parse(out.fallback_due_at) - Date.parse(content.zeit)).toBe(fallbackAfterMs);
    const events = (await readEvents()).filter((e) => e.event === 'orchestrator.fleet.checkin');
    expect(events[0].navigator_state).toBe(state);
  });

  it('a caller-supplied zeit is overwritten by the CLI stamp (never trusted)', async () => {
    // Second-precision stamp: compare against the run's own window, floored to
    // the second — never against a calendar field (the year flips at midnight).
    const before = Math.floor(Date.now() / 1000) * 1000;
    const r = await runCli(JSON.stringify(checkin({ zeit: '1999-01-01T00:00:00Z' })));
    const after = Date.now();
    expect(r.code, r.stderr).toBe(0);
    const content = JSON.parse(await fs.readFile(path.join(navDir, 'checkin', 'sess-1.json'), 'utf8'));
    expect(content.zeit).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(Date.parse(content.zeit)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(content.zeit)).toBeLessThanOrEqual(after);
  });

  it('a symlink planted at checkin/ → exit 1, nothing written through it', async () => {
    const elsewhere = path.join(tmp, 'elsewhere');
    await fs.mkdir(elsewhere, { recursive: true });
    await fs.mkdir(navDir, { recursive: true, mode: 0o700 });
    await fs.symlink(elsewhere, path.join(navDir, 'checkin'));
    const r = await runCli(JSON.stringify(checkin()));
    expect(r.code).toBe(1);
    expect(await fs.readdir(elsewhere)).toEqual([]);
  });
});
