/**
 * tests/setup/events-ledger-guard.mjs — vitest `setupFiles` entry (#1397 item 11).
 *
 * THE BUG THIS CATCHES (TV-001): a test run appends synthetic records to the
 * REAL `.orchestrator/metrics/events.jsonl`, stamped with the LIVE session id.
 * `emitEvent()` without `filePath`/`repoRoot` resolves the ledger through
 * `SO_PROJECT_DIR` — a `*_PROJECT_DIR` env var, else a walk up from the cwd for
 * `CLAUDE.md` — and neither the vitest workers nor the scripts they spawn with
 * `cwd: <repo root>` carry a project-dir override. Measured 2026-09-19 @
 * d92c2ca4: one run of `tests/scripts/orchestrators-e2e.test.mjs` +
 * `tests/integration/learning-memory-modernization.test.mjs` appended 10 lines
 * (4 `quality_gate.passed`, 2 `secret_masker.applied`, 2 `vault.mirror_completed`,
 * 2 `vault.mirror_run_completed`). One such gate record decided an `/eval`
 * gate-health verdict (main-2026-09-18-session-10).
 *
 * WHY ONE ENV VAR AND NOT A PER-CALL-SITE FIX: 67 test files spawn an
 * emitter-reachable script, and in-process `emitEvent` calls resolve the same
 * way. An env var set here reaches both at once — the worker's own `process.env`
 * and every child that inherits it. The redirect rule itself lives in
 * `scripts/lib/events.mjs` (`sandboxedDefault`): only a DEFAULT destination that
 * would land OUTSIDE the OS temp root is redirected. Fixture project dirs under
 * tmp and every explicit `repoRoot`/`filePath` keep resolving exactly as before.
 *
 * WHAT IT DOES NOT COVER (BV-004 ceiling): a child spawned with an env that does
 * not spread `process.env`, and a raw writer that hand-joins
 * `<root>/.orchestrator/metrics/events.jsonl` instead of calling
 * `eventsFilePath()`. Revisit trigger: the next test-made line found in the
 * real ledger — inspect the sandbox too, it holds what the guard caught.
 *
 * Same shape as `vault-guard.mjs`: unconditional (no heuristic about whether an
 * inherited value is "safe"), one directory per run derived from `process.ppid`
 * (forks pool re-evaluates this module per test file; `mkdtemp` would leave one
 * directory per file), canonical temp root, symlink-planted path refused.
 */

import { lstatSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { EVENTS_LEDGER_SANDBOX_ENV } from '../../scripts/lib/events.mjs';

/** Prefix of every directory this guard mints — the wiring is greppable on disk. */
export const EVENTS_LEDGER_GUARD_PREFIX = 'so-events-ledger-guard-';

/**
 * Point `env[EVENTS_LEDGER_SANDBOX_ENV]` at
 * `<tmp>/<prefix><runId>/.orchestrator/metrics/events.jsonl`.
 *
 * The directory is reused only when it is a plain directory; anything else at
 * that predictable path (a symlink planted in a shared temp root) gets a fresh
 * `mkdtemp` name instead — the same TOCTOU-narrowing check as vault-guard.
 *
 * @param {Record<string, string|undefined>} env  environment object to mutate.
 * @param {{ tmpRoot?: string, runId?: string }} [opts]
 * @returns {{ ledger: string, previous: string|undefined }}
 */
export function guardEventsLedger(env, { tmpRoot = tmpdir(), runId = String(process.ppid) } = {}) {
  const root = realpathSync(tmpRoot);
  let dir = path.join(root, `${EVENTS_LEDGER_GUARD_PREFIX}${runId}`);
  const st = lstatSync(dir, { throwIfNoEntry: false });
  if (st === undefined) mkdirSync(dir, { recursive: true });
  else if (!st.isDirectory()) dir = mkdtempSync(path.join(root, EVENTS_LEDGER_GUARD_PREFIX));

  const previous = env[EVENTS_LEDGER_SANDBOX_ENV];
  // The sandbox mirrors the production layout — `<fake root>/.orchestrator/
  // metrics/events.jsonl` — so the redirect changes the destination only, never
  // the path's shape (tests/lib/events.test.mjs pins that suffix on the default).
  const ledger = path.join(dir, '.orchestrator', 'metrics', 'events.jsonl');
  env[EVENTS_LEDGER_SANDBOX_ENV] = ledger;
  return { ledger, previous };
}

export const appliedEventsLedgerGuard = guardEventsLedger(process.env);

// No exit-time cleanup: vault-guard measured that a forks-pool worker never
// reaches a normal exit, so such a hook never runs. The OS reaps the temp root;
// a NON-empty sandbox is the evidence of what the suite would have written.
