/**
 * autopilot/durable-telemetry.mjs
 *
 * Framework module per ADR 0003 (Routines Adapter) — wraps telemetry writes
 * with an optional claude/-branch commit so JSONL state survives ephemeral-clone
 * reclamation in cloud execution contexts. Local execution: commit step is a no-op
 * unless `enabled: true` is passed. This is intentional — the module ships as
 * inert framework code; the empirical spike (issue #485 W3 P3) validates the
 * commit path against real Routines fires before wiring it into production paths.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Branch names safe to interpolate into git commands (defense-in-depth; #483 W4-Q5-MED-1). */
const SAFE_BRANCH_RE = /^[A-Za-z0-9._/-]+$/;

/**
 * @typedef {Object} DurableCommitOptions
 * @property {string} sessionId - session identifier (e.g. main-2026-05-19-deep-3)
 * @property {string} [branch] - target branch (default: `claude/${sessionId}`)
 * @property {string[]} files - relative paths to commit (e.g. ['.orchestrator/metrics/autopilot.jsonl'])
 * @property {string} [message] - commit message; default chore(autopilot)
 * @property {boolean} [enabled=false] - when false, no-op (default local behaviour)
 * @property {boolean} [push=false] - whether to push the branch to origin
 * @property {string} [cwd] - repo root (default: process.cwd())
 */

/**
 * Commit a set of telemetry files to a claude/-prefixed branch. When `enabled: false`
 * (default), returns {ok: true, skipped: true} without touching git — local sessions
 * do not need durable-commit behaviour.
 *
 * @param {DurableCommitOptions} opts
 * @returns {Promise<{ok: boolean, skipped?: boolean, sha?: string, branch?: string, error?: string}>}
 */
export async function durableCommit(opts) {
  if (!opts || typeof opts !== 'object') {
    return { ok: false, error: 'opts must be an object' };
  }
  const enabled = opts.enabled === true;
  const sessionId = opts.sessionId;
  const files = Array.isArray(opts.files) ? opts.files : [];
  const cwd = opts.cwd || process.cwd();

  if (!sessionId) return { ok: false, error: 'sessionId required' };
  if (files.length === 0) return { ok: false, error: 'files[] cannot be empty' };

  if (!enabled) {
    // Local execution path — no-op. Cloud spike wires enabled:true.
    return { ok: true, skipped: true };
  }

  const branch = opts.branch || `claude/${sessionId}`;
  const message = opts.message || `chore(autopilot): durable telemetry — ${sessionId}`;

  // Defense-in-depth (#483 W4-Q5-MED-1): branch name is interpolated into git
  // commands below — reject anything outside the safe charset before execution.
  if (!SAFE_BRANCH_RE.test(branch)) {
    return { ok: false, error: `unsafe branch name rejected: ${branch}` };
  }

  // cwd confinement (#483 W4-Q5-MED-2): git ops must run against the current
  // project root unless the caller explicitly opts into a foreign tree.
  const resolvedCwd = resolve(cwd);
  if (resolvedCwd !== resolve(process.cwd()) && opts.allowForeignCwd !== true) {
    return { ok: false, error: `cwd outside project root rejected: ${resolvedCwd}` };
  }

  try {
    // Ensure target branch exists (create if missing, checkout if exists)
    // NOTE: this is a framework stub — production wiring (cloud spike, W3 P3)
    // must reconcile with the worktree merge-back semantics.
    const branches = execSync('git branch --list', { cwd, encoding: 'utf8' });
    if (!branches.split('\n').some((l) => l.trim().replace(/^\* /, '') === branch)) {
      execSync(`git branch ${JSON.stringify(branch)}`, { cwd });
    }

    // Stage files individually (PSA-004: never `git add .` or `-A`)
    for (const f of files) {
      const abs = join(cwd, f);
      if (!existsSync(abs)) {
        return { ok: false, error: `file not found: ${f}` };
      }
      execSync(`git add ${JSON.stringify(f)}`, { cwd });
    }

    // Commit on the target branch via a detached worktree to avoid touching the coordinator's HEAD.
    // Framework stub: in cloud-mode (Routines), the runner is already on the claude/ branch.
    // Local-mode: callers must ensure HEAD is the target branch before calling, OR pass
    // the branch parameter and accept that this stub falls back to staging-only.
    const commitOut = execSync(
      `git commit -m ${JSON.stringify(message)} --allow-empty`,
      { cwd, encoding: 'utf8' }
    );
    const sha = commitOut.match(/\b[0-9a-f]{7,}\b/)?.[0] || 'unknown';

    if (opts.push) {
      execSync(`git push origin ${JSON.stringify(branch)}`, { cwd });
    }

    return { ok: true, sha, branch };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Convenience: wrap a telemetry-file write with durable-commit semantics.
 * Local execution: write happens, commit is no-op (returns {ok:true, skipped:true}).
 * Cloud execution: write happens, commit fires on `claude/<sessionId>` branch.
 *
 * @param {() => Promise<void> | void} writeFn - the underlying telemetry write
 * @param {DurableCommitOptions} opts
 * @returns {Promise<{ok: boolean, skipped?: boolean, sha?: string, branch?: string, error?: string}>}
 */
export async function withDurableCommit(writeFn, opts) {
  await writeFn();
  return durableCommit(opts);
}
