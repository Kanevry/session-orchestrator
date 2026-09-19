/**
 * tests/setup/events-ledger-guard.test.mjs — #1397 item 11.
 *
 * Named bug (TV-001): a test run appends to the REAL
 * `.orchestrator/metrics/events.jsonl`. Every assertion below writes a random
 * nonce and then looks for it in the sandbox AND in the real ledger, so a
 * concurrent writer to the real ledger (the live session's own hooks) cannot
 * make it pass or fail.
 *
 * This file deliberately does NOT import `./events-ledger-guard.mjs`: importing
 * it would apply the guard itself and mask a missing `setupFiles` entry. The
 * sandbox variable must arrive through `vitest.config.mjs` — that is the wiring
 * under test.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { emitEvent, eventsFilePath, EVENTS_LEDGER_SANDBOX_ENV } from '../../scripts/lib/events.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_LEDGER = path.join(ROOT, '.orchestrator', 'metrics', 'events.jsonl');
const TYPE = 'test.events_ledger_guard.probe';

// The pre-push hook runs the full gate in a checkout materialised UNDER the temp
// root. There the default destination is already a throwaway tree, and the
// guard leaves tmp destinations alone by design — the redirect cannot be
// observed, so the redirect assertions skip rather than fail.
const ROOT_UNDER_TMP = [tmpdir(), realpathSync(tmpdir())].some((t) =>
  (ROOT + path.sep).startsWith(path.resolve(t) + path.sep),
);

const has = (file, nonce) => existsSync(file) && readFileSync(file, 'utf8').includes(nonce);

describe.skipIf(ROOT_UNDER_TMP)('events-ledger-guard (#1397 item 11)', () => {
  const sandbox = process.env[EVENTS_LEDGER_SANDBOX_ENV];

  it('an in-process default emitEvent lands in the sandbox, not the real ledger', async () => {
    expect(sandbox, 'setupFiles must register tests/setup/events-ledger-guard.mjs').toBeTruthy();
    const nonce = randomUUID();
    await emitEvent(TYPE, { nonce });
    expect(has(sandbox, nonce)).toBe(true);
    expect(has(REAL_LEDGER, nonce)).toBe(false);
  });

  it('a script spawned with cwd = repo root lands in the sandbox, not the real ledger', () => {
    const nonce = randomUUID();
    const r = spawnSync(
      process.execPath,
      [path.join(ROOT, 'scripts', 'emit-event.mjs'), '--type', TYPE, '--payload', JSON.stringify({ nonce })],
      { cwd: ROOT, encoding: 'utf8', timeout: 15_000 },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(has(sandbox, nonce)).toBe(true);
    expect(has(REAL_LEDGER, nonce)).toBe(false);
  });

  it('an explicit repoRoot or filePath outside the temp root is never redirected', async () => {
    // Gitignored scratch dir inside the repo: outside the temp root, so a
    // redirect WOULD apply if the explicit branches honoured the sandbox.
    const dir = path.join(ROOT, '.orchestrator', 'tmp', `events-ledger-guard-${randomUUID()}`);
    try {
      const viaRoot = randomUUID();
      await emitEvent(TYPE, { nonce: viaRoot }, { repoRoot: dir });
      expect(has(path.join(dir, '.orchestrator', 'metrics', 'events.jsonl'), viaRoot)).toBe(true);
      expect(has(sandbox, viaRoot)).toBe(false);

      const viaFile = randomUUID();
      const file = path.join(dir, 'explicit.jsonl');
      await emitEvent(TYPE, { nonce: viaFile }, { filePath: file });
      expect(has(file, viaFile)).toBe(true);
      expect(has(sandbox, viaFile)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a sandbox value outside the temp root, relative, or whitespace-only is ignored', () => {
    try {
      delete process.env[EVENTS_LEDGER_SANDBOX_ENV];
      const unguarded = eventsFilePath();
      for (const bad of [path.join(ROOT, '.orchestrator', 'decoy.jsonl'), 'rel/events.jsonl', '   ']) {
        process.env[EVENTS_LEDGER_SANDBOX_ENV] = bad;
        expect(eventsFilePath(), JSON.stringify(bad)).toBe(unguarded);
      }
    } finally {
      process.env[EVENTS_LEDGER_SANDBOX_ENV] = sandbox;
    }
  });
});
