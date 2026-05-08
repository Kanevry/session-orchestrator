/**
 * SPIRAL/FAILED carryover issue creator (#261).
 *
 * When wave-executor detects 2×SPIRAL on the same task or a FAILED agent with no
 * prior carryover, this module auto-creates a GitLab/GitHub issue so the escalated
 * work is tracked even if the user is inactive.
 *
 * Session-end Phase 1.6 (Safety Review) also invokes this module as a fallback
 * safety net: it walks STATE.md Wave History and retro-creates a carryover for
 * any SPIRAL/FAILED agent whose line is missing the `→ issue #NNN` suffix.
 *
 * Design notes:
 *   - Stdlib only. Shells out via `execFileSync` (argv-array form — no shell
 *     interpolation, safe for titles/bodies with quotes or special chars).
 *   - Duplicate detection greps issue bodies for a `<!-- task-hash: <hash> -->`
 *     marker so repeated invocations are idempotent.
 *   - All errors are swallowed — functions return `{ created: false, skipped: 'error', error }`
 *     instead of throwing. Losing a carryover issue is bad; crashing the session
 *     close because `glab` is unreachable is worse. Fail open, keep moving.
 *
 * This module intentionally does NOT reuse `scripts/lib/vault-backfill/glab.mjs`
 * — that helper is vault-specific and wider in scope than needed here.
 */

import { execFileSync } from 'node:child_process';
import { digestSha256Short } from './crypto-digest-utils.mjs';

/**
 * Compute a stable 8-char sha256 hash of a task description.
 * Used as the dedup key embedded in carryover issue bodies.
 *
 * @param {string} taskDescription
 * @returns {string} 8 lowercase hex chars
 */
export function computeTaskHash(taskDescription) {
  return digestSha256Short(taskDescription);
}

/**
 * Truncate a string to `max` chars, appending an ellipsis if truncated.
 * @param {string} s
 * @param {number} max
 * @returns {string}
 */
function truncate(s, max) {
  const str = String(s ?? '');
  if (str.length <= max) return str;
  return `${str.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Run a CLI command and return { ok, stdout, stderr }. Never throws.
 * @param {string} cmd
 * @param {string[]} args
 * @returns {{ ok: boolean, stdout: string, stderr: string }}
 */
function runCli(cmd, args) {
  try {
    const stdout = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, stdout: String(stdout ?? ''), stderr: '' };
  } catch (err) {
    const stderr = err && err.stderr ? String(err.stderr) : (err && err.message ? err.message : 'unknown error');
    const stdout = err && err.stdout ? String(err.stdout) : '';
    return { ok: false, stdout, stderr };
  }
}

/**
 * Parse an issue URL printed by `glab issue create` / `gh issue create` stdout
 * and return the numeric id (last path segment) plus the URL. Tolerant of
 * trailing whitespace and multiple lines — takes the last non-empty line that
 * looks like a URL.
 *
 * @param {string} stdout
 * @returns {{ issueId: number | undefined, issueUrl: string | undefined }}
 */
function parseIssueCreateOutput(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const m = line.match(/https?:\/\/\S+?\/(?:issues|-\/issues)\/(\d+)\b/);
    if (m) {
      return { issueId: Number(m[1]), issueUrl: line.match(/https?:\/\/\S+/)?.[0] };
    }
  }
  return { issueId: undefined, issueUrl: undefined };
}

/**
 * Check whether a carryover issue already exists for this task.
 * Searches open `type:carryover` issues for the `<!-- task-hash: <hash> -->`
 * marker in the body.
 *
 * Returns `{ exists: false }` on any CLI failure — caller treats this as
 * "probably no duplicate" and proceeds with creation (fail-open).
 *
 * @param {{ taskHash: string, vcs?: 'gitlab' | 'github' }} opts
 * @returns {Promise<{ exists: boolean, issueId?: number, issueUrl?: string }>}
 */
export async function findExistingCarryover({ taskHash, vcs = 'gitlab' } = {}) {
  if (!taskHash || typeof taskHash !== 'string') {
    return { exists: false };
  }

  try {
    if (vcs === 'github') {
      // gh: search bodies via --search; keep per-page generous.
      const res = runCli('gh', [
        'issue',
        'list',
        '--label',
        'type:carryover',
        '--state',
        'open',
        '--limit',
        '100',
        '--json',
        'number,url,body',
      ]);
      if (!res.ok) return { exists: false };
      let arr;
      try {
        arr = JSON.parse(res.stdout);
      } catch {
        return { exists: false };
      }
      if (!Array.isArray(arr)) return { exists: false };
      const marker = `<!-- task-hash: ${taskHash} -->`;
      const hit = arr.find((it) => typeof it?.body === 'string' && it.body.includes(marker));
      if (hit) {
        return { exists: true, issueId: Number(hit.number), issueUrl: String(hit.url ?? '') };
      }
      return { exists: false };
    }

    // Default: gitlab via glab.
    const res = runCli('glab', [
      'issue',
      'list',
      '--label',
      'type:carryover',
      '--per-page',
      '100',
      '--output',
      'json',
    ]);
    if (!res.ok) return { exists: false };
    let arr;
    try {
      arr = JSON.parse(res.stdout);
    } catch {
      return { exists: false };
    }
    if (!Array.isArray(arr)) return { exists: false };
    const marker = `<!-- task-hash: ${taskHash} -->`;
    const hit = arr.find((it) => typeof it?.description === 'string' && it.description.includes(marker));
    if (hit) {
      return {
        exists: true,
        issueId: Number(hit.iid ?? hit.id),
        issueUrl: String(hit.web_url ?? ''),
      };
    }
    return { exists: false };
  } catch {
    return { exists: false };
  }
}

/**
 * Build the markdown body for a carryover issue. Embeds the `task-hash` marker
 * used by `findExistingCarryover` for dedup.
 *
 * @param {{ taskDescription: string, kind: 'SPIRAL' | 'FAILED', context: string, taskHash: string }} opts
 * @returns {string}
 */
function buildCarryoverBody({ taskDescription, kind, context, taskHash }) {
  const safeContext = String(context ?? '').trim() || '_(no prior context captured)_';
  return [
    `<!-- task-hash: ${taskHash} -->`,
    '',
    `## [Carryover] [${kind}] Escalated from wave-executor`,
    '',
    `**Kind:** \`${kind}\``,
    `**Task hash:** \`${taskHash}\``,
    '',
    '### Task',
    '',
    String(taskDescription ?? '').trim() || '_(no task description provided)_',
    '',
    '### Prior context (from STATE.md Deviations / Wave History)',
    '',
    safeContext,
    '',
    '### Retry hint',
    '',
    kind === 'SPIRAL'
      ? '- Agent hit 2×SPIRAL on this task. Narrow scope further (single file/function) before re-dispatching.'
      : '- Agent reported FAILED. Review the prior context for the underlying error class (edit-format-friction, scope-denied, command-blocked, or other) and adjust instructions accordingly.',
    '- Verify the agent\'s mental model of the affected files matches reality (re-read before editing).',
    '',
    '_Auto-created by `scripts/lib/spiral-carryover.mjs` (#261)._',
  ].join('\n');
}

/**
 * Create a carryover issue for a spiraled/failed task.
 *
 * Behavior:
 *   1. Compute a task hash and call `findExistingCarryover`. If one exists,
 *      return `{ created: false, skipped: 'duplicate', issueId, issueUrl }`.
 *   2. Build title `[Carryover] [<kind>] <truncated task description>`.
 *   3. Build body with embedded `<!-- task-hash: <hash> -->` marker.
 *   4. Shell out to `glab issue create` (gitlab) or `gh issue create` (github).
 *   5. Parse stdout for the issue URL and return `{ created: true, issueId, issueUrl }`.
 *
 * Never throws. On any CLI failure returns `{ created: false, skipped: 'error', error }`.
 *
 * @param {{
 *   taskDescription: string,
 *   kind: 'SPIRAL' | 'FAILED',
 *   context: string,
 *   priority?: 'high' | 'medium',
 *   vcs?: 'gitlab' | 'github'
 * }} opts
 * @returns {Promise<{
 *   created: boolean,
 *   issueId?: number,
 *   issueUrl?: string,
 *   skipped?: 'duplicate' | 'error',
 *   error?: string
 * }>}
 */
export async function createSpiralCarryoverIssue({
  taskDescription,
  kind,
  context,
  priority = 'high',
  vcs = 'gitlab',
} = {}) {
  try {
    if (kind !== 'SPIRAL' && kind !== 'FAILED') {
      return { created: false, skipped: 'error', error: `invalid kind: ${String(kind)}` };
    }
    if (priority !== 'high' && priority !== 'medium') {
      // Normalize to sane default rather than reject.
      priority = 'high';
    }
    const vcsResolved = vcs === 'github' ? 'github' : 'gitlab';

    const taskHash = computeTaskHash(taskDescription);

    // Dedup check first.
    const existing = await findExistingCarryover({ taskHash, vcs: vcsResolved });
    if (existing.exists) {
      return {
        created: false,
        skipped: 'duplicate',
        issueId: existing.issueId,
        issueUrl: existing.issueUrl,
      };
    }

    const truncatedDesc = truncate(String(taskDescription ?? '').trim() || '(untitled task)', 80);
    const title = `[Carryover] [${kind}] ${truncatedDesc}`;
    const body = buildCarryoverBody({ taskDescription, kind, context, taskHash });
    const labels = `priority:${priority},status:ready,type:carryover`;

    let cmd;
    let args;
    if (vcsResolved === 'github') {
      cmd = 'gh';
      args = ['issue', 'create', '--title', title, '--body', body, '--label', labels];
    } else {
      cmd = 'glab';
      args = ['issue', 'create', '--title', title, '--description', body, '--label', labels];
    }

    const res = runCli(cmd, args);
    if (!res.ok) {
      return { created: false, skipped: 'error', error: res.stderr.trim() || 'CLI invocation failed' };
    }

    const { issueId, issueUrl } = parseIssueCreateOutput(res.stdout);
    if (issueId === undefined) {
      // CLI succeeded but we could not parse the URL — still report created so
      // the caller doesn't retry endlessly, but include raw stdout for debugging.
      return {
        created: true,
        issueUrl: res.stdout.trim(),
      };
    }
    return { created: true, issueId, issueUrl };
  } catch (err) {
    const msg = err && err.message ? String(err.message) : 'unknown error';
    return { created: false, skipped: 'error', error: msg };
  }
}
