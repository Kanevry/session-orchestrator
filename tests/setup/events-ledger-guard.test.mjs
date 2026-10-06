/**
 * tests/setup/events-ledger-guard.test.mjs — #1397 item 11, #1527.
 *
 * Named bug (TV-001): a test's explicit repoRoot inside a linked worktree maps
 * its probe into the main checkout's ledger. All destinations below are
 * throwaway fixtures; even the negative nonce assertions never read live data.
 *
 * Do NOT import ./events-ledger-guard.mjs here: the sandbox must arrive through
 * vitest.config.mjs setupFiles, otherwise the wiring test would mask its defect.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EVENTS_LEDGER_SANDBOX_ENV } from '../../scripts/lib/events.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TYPE = 'test.events_ledger_guard.probe';
const ledger = (root) => path.join(root, '.orchestrator', 'metrics', 'events.jsonl');
const has = (file, nonce) => existsSync(file) && readFileSync(file, 'utf8').includes(nonce);

describe('events-ledger-guard (#1397 item 11, #1527)', () => {
  const sandbox = process.env[EVENTS_LEDGER_SANDBOX_ENV];
  let dir;
  let project;
  let emitEvent;
  let eventsFilePath;

  beforeEach(async () => {
    expect(sandbox, 'setupFiles must register tests/setup/events-ledger-guard.mjs').toBeTruthy();
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'events-ledger-probe-')));
    project = path.join(dir, 'project');
    mkdirSync(project);

    // Narrow the effective OS temp root to the guard's existing directory.
    // Our sibling fixture is outside it, so default redirection is observable
    // even when the checkout itself is under tmp (CI / materialised gates).
    // Everything remains physically under the original tmpdir().
    const guardRoot = path.dirname(path.dirname(path.dirname(sandbox)));
    vi.stubEnv('TMPDIR', guardRoot);
    vi.stubEnv('TMP', guardRoot);
    vi.stubEnv('TEMP', guardRoot);
    expect(realpathSync(tmpdir())).toBe(realpathSync(guardRoot));
    expect(dir.startsWith(realpathSync(guardRoot) + path.sep)).toBe(false);
    for (const key of ['CLAUDE_PROJECT_DIR', 'CODEX_PROJECT_DIR', 'CURSOR_PROJECT_DIR', 'PI_PROJECT_DIR']) {
      vi.stubEnv(key, project);
    }
    vi.stubEnv('CLANK_EVENT_SECRET', undefined);
    vi.stubEnv('CLANK_EVENT_URL', undefined);
    // getProjectDir() is memoized; each probe must bind it to this fixture,
    // including emitEvent's attribution reads, never the invoking checkout.
    vi.resetModules();
    ({ emitEvent, eventsFilePath } = await import('../../scripts/lib/events.mjs'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('redirects an in-process default to the setupFiles sandbox', async () => {
    const nonce = randomUUID();
    expect(eventsFilePath()).toBe(sandbox);
    await emitEvent(TYPE, { nonce });
    expect(has(sandbox, nonce)).toBe(true);
    expect(has(ledger(project), nonce)).toBe(false);
  });

  it('redirects a CLI child default to the inherited setupFiles sandbox', () => {
    const nonce = randomUUID();
    const r = spawnSync(
      process.execPath,
      [path.join(ROOT, 'scripts', 'emit-event.mjs'), '--type', TYPE, '--payload', JSON.stringify({ nonce })],
      { cwd: project, env: { ...process.env }, encoding: 'utf8', timeout: 5_000 },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(has(sandbox, nonce)).toBe(true);
    expect(has(ledger(project), nonce)).toBe(false);
  });

  it('keeps an explicit repoRoot outside the sandbox on its own fixture', async () => {
    const nonce = randomUUID();
    expect(eventsFilePath(project)).toBe(ledger(project));
    await emitEvent(TYPE, { nonce }, { repoRoot: project });
    expect(has(ledger(project), nonce)).toBe(true);
    expect(has(sandbox, nonce)).toBe(false);
  });

  it('keeps an explicit filePath outside the sandbox on that exact file', async () => {
    const nonce = randomUUID();
    const file = path.join(dir, 'explicit.jsonl');
    await emitEvent(TYPE, { nonce }, { filePath: file });
    expect(has(file, nonce)).toBe(true);
    expect(has(sandbox, nonce)).toBe(false);
    expect(has(ledger(project), nonce)).toBe(false);
  });

  it('maps an explicit linked-worktree subdirectory into its synthetic main checkout', async () => {
    // Minimal real Git layout consumed by the spawn-free resolver. No pointer
    // or common directory connects this fixture to the invoking repository.
    const main = path.join(dir, 'main');
    const worktree = path.join(dir, 'worktree');
    const gitdir = path.join(main, '.git', 'worktrees', 'probe');
    mkdirSync(gitdir, { recursive: true });
    mkdirSync(worktree);
    writeFileSync(path.join(worktree, '.git'), `gitdir: ${gitdir}\n`);
    writeFileSync(path.join(gitdir, 'commondir'), '../..\n');
    const root = path.join(worktree, 'probe');
    const mapped = ledger(path.join(main, 'probe'));
    const nonce = randomUUID();
    expect(eventsFilePath(root)).toBe(mapped);
    await emitEvent(TYPE, { nonce }, { repoRoot: root });
    expect(has(mapped, nonce)).toBe(true);
    expect(has(ledger(root), nonce)).toBe(false);
    expect(has(sandbox, nonce)).toBe(false);
  });

  it.each(['outside', 'relative', 'whitespace'])('ignores an invalid sandbox value: %s', (kind) => {
    const invalid = {
      outside: path.join(dir, 'decoy.jsonl'),
      relative: 'rel/events.jsonl',
      whitespace: '   ',
    };
    vi.stubEnv(EVENTS_LEDGER_SANDBOX_ENV, invalid[kind]);
    expect(eventsFilePath()).toBe(ledger(project));
  });
});
