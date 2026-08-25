/**
 * SPIRAL/FAILED carryover issue creator (#261) + Broken-Window closure-issue
 * filer (#730/H5) — session-end escalation issue filing.
 *
 * When wave-executor detects 2×SPIRAL on the same task or a FAILED agent with no
 * prior carryover, this module auto-creates a GitLab/GitHub issue so the escalated
 * work is tracked even if the user is inactive. Since #730/H5 it also hosts
 * `createBrokenWindowIssue` — session-end Phase 2.6 files hard-due-date closure
 * issues for knowingly-broken shipments through the same dedup/fail-open core.
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
 *
 * Host pinning (#839): every `glab`/`gh` spawn below (the dedup lookup AND the
 * `issue create` write) is pinned to the resolved repo via `-R <spec>`. A bare
 * spawn falls back to the ambient `GITLAB_HOST`/`GH_HOST`, which can silently
 * resolve to the WRONG GitLab instance on a multi-host machine — for a WRITE
 * path (`issue create`) that means either filing into the wrong project, or
 * failing open and defeating `findExistingLabeledIssue`'s dedup (which itself
 * fails open to `{exists:false}` on any CLI error), risking double-filed
 * issues. See `scripts/lib/vcs-repo-spec.mjs` for the full rationale.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { digestSha256Short } from './crypto-digest-utils.mjs';
import {
  chargeIssueBudget,
  formatBlockReason,
  resolveIssueBudgetSessionId,
} from './issue-budget.mjs';
import { resolveProjectDir } from './platform.mjs';
import { resolveRepoSpec } from './vcs-repo-spec.mjs';

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
 * True when the argv describes an issue-CREATE call (not a list/search).
 * The dedup lookups in this module also go through `runCli`, and those must
 * never be charged against the issue budget.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @returns {boolean}
 */
function isIssueCreateArgv(cmd, args) {
  if (cmd !== 'gh' && cmd !== 'glab') return false;
  if (!Array.isArray(args) || args.length < 2) return false;
  return args[0] === 'issue' && (args[1] === 'create' || args[1] === 'new');
}

/**
 * Under vitest, a `repoRoot` that resolves to the ambient working copy is almost
 * always the default-parameter leak (#1105): the test meant to pass a synthetic
 * `mkdtemp` root but did not, and the issue-budget ledger would be charged in
 * the operator's real tree. Production keeps the cwd default unchanged; this
 * gate only fires when `process.env.VITEST` is set.
 *
 * @param {string} budgetRoot — ledger root about to be passed to `chargeIssueBudget`
 * @returns {string|null} refusal message, or null when charging may proceed
 */
function refuseAmbientLedgerUnderVitest(budgetRoot) {
  if (!process.env.VITEST) return null;
  if (path.resolve(budgetRoot) === path.resolve(process.cwd())) {
    return (
      'spiral-carryover: refusing to charge the issue-budget ledger at the ambient ' +
      'repo root under VITEST — pass an explicit synthetic repoRoot'
    );
  }
  return null;
}

/**
 * Run a CLI command and return { ok, stdout, stderr }. Never throws.
 *
 * ISSUE-BUDGET GATE (both Node producers funnel through here): before shelling
 * out to an issue-create call, the same `chargeIssueBudget` decision the
 * `pre-bash-issue-budget` hook applies is evaluated here — otherwise the
 * programmatic path would be a hole straight through the shell-level cap.
 *
 * In practice BOTH current callers are exempt by class (`createSpiralCarryoverIssue`
 * emits `[Carryover] [SPIRAL|FAILED] …`, `createBrokenWindowIssue` emits the
 * `broken-window` label), so this gate is a no-op for them by design — that is
 * exactly the session-end promise at SKILL.md:319 / :1113 being preserved. It
 * bites for any FUTURE non-exempt producer added to this module.
 *
 * REPO BINDING (#1058 follow-on). The ledger root is the `repoRoot` the CALLER
 * named — the same value that already decides the `-R` host-pinning spec a few
 * lines down. Before this parameter existed, `runCli` re-derived it from
 * `process.env.CLAUDE_PROJECT_DIR || process.cwd()`, so one call could file an
 * issue into repo A (via `-R`) while charging repo B's budget ledger. Two
 * answers to "which repo" inside one call path is the defect; the caller's
 * answer is the authoritative one.
 *
 * That split brain was also a live test leak, measured 2026-08-23: a sandboxed
 * `CLAUDE_PROJECT_DIR=$(mktemp -d) npx vitest run tests/lib/spiral-carryover.test.mjs`
 * left `{"sessionId":"1c2e5507-…","count":0,"exempt":15}` in the sandbox — 15
 * bookings per run, carrying the REAL session id, which under a plain
 * `npm test` land in this repo's live issue-budget ledger (since #1141 the
 * per-session file `.orchestrator/runtime/issue-budget/<hash>.json`; the path
 * is owned by `budgetStateRel` in `scripts/lib/issue-budget.mjs` — no caller,
 * including this one, spells it out).
 *
 * The `repoRoot`-less fallback is `resolveProjectDir()` from `platform.mjs` —
 * the SAME resolver `hooks/pre-bash-issue-budget.mjs` uses, so both producers
 * of this ledger agree on which file they are charging. It strictly supersedes
 * the hand-rolled expression it replaces: env fast-path first (including the
 * Codex/Cursor/pi variants), then a walk-up for the instruction file — `CLAUDE.md`
 * on Claude Code, `AGENTS.md` on Codex CLI (transparent aliases) — or `.git`, then cwd.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {string} [repoRoot] — repo whose issue-budget ledger this call is
 *   charged against. Falls back to `resolveProjectDir()` when absent.
 * @returns {{ ok: boolean, stdout: string, stderr: string, budgetBlocked?: boolean }}
 */
function runCli(cmd, args, repoRoot) {
  if (isIssueCreateArgv(cmd, args)) {
    try {
      const budgetRoot = (typeof repoRoot === 'string' && repoRoot.trim())
        ? repoRoot
        : (resolveProjectDir() || process.cwd());
      const vitestLedgerRefusal = refuseAmbientLedgerUnderVitest(budgetRoot);
      if (vitestLedgerRefusal) {
        return { ok: false, stdout: '', stderr: vitestLedgerRefusal, budgetBlocked: true };
      }
      // The harness exports CLAUDE_CODE_SESSION_ID (measured 2026-08-21: it is
      // present in the Bash tool environment this module runs in). There is no
      // CLAUDE_SESSION_ID — reading that name made this whole block dead code
      // and left the cap permanently off on the programmatic path.
      const nativeRawId = process.env.CLAUDE_CODE_SESSION_ID ?? null;
      let currentSession = null;
      if (typeof nativeRawId === 'string' && nativeRawId.length > 0) {
        try {
          const parsed = JSON.parse(
            readFileSync(path.join(budgetRoot, '.orchestrator', 'current-session.json'), 'utf8'),
          );
          // SESSION BINDING (#1058). `current-session.json` is repo-global —
          // every session sharing this working copy writes the same path — so
          // the file in hand may describe a PEER session, not us.
          //
          // The binding itself is not new: `resolveIssueBudgetSessionId`
          // already requires `currentSession.session_id === nativeRawId` before
          // it will adopt the file's semantic label, and falls back to the raw
          // env id otherwise. What was missing is that the mismatch was
          // INVISIBLE — the comparison lives one module over, so a foreign file
          // was discarded with no trace, which is the same error class as using
          // it silently. Deciding it HERE makes the outcome identical and the
          // reason audible; it deliberately does not restate the wider
          // multi-id-space classifier `scripts/lib/quality-gate.mjs` needs
          // (that reader has no raw env id guaranteed in hand — this one does,
          // by the `typeof nativeRawId === 'string'` guard above).
          const foreignId = typeof parsed?.session_id === 'string' && parsed.session_id.length > 0
            ? parsed.session_id
            : null;
          if (foreignId !== null && foreignId !== nativeRawId) {
            process.stderr.write(
              '⚠️  spiral-carryover: .orchestrator/current-session.json belongs to another ' +
              `session (${foreignId}) — using the native session id for issue-budget ` +
              'accounting. Another session is active in this working copy (PSA-001).\n',
            );
          } else {
            currentSession = parsed;
          }
        } catch {
          // Missing or malformed records conservatively retain the native env key.
        }
      }
      const titleIdx = args.indexOf('--title');
      const verdict = chargeIssueBudget({
        repoRoot: budgetRoot,
        sessionId: resolveIssueBudgetSessionId(nativeRawId, currentSession),
        command: [cmd, ...args].join(' '),
        title: titleIdx >= 0 ? (args[titleIdx + 1] ?? null) : null,
      });
      if (verdict.decision === 'block') {
        return { ok: false, stdout: '', stderr: formatBlockReason(verdict), budgetBlocked: true };
      }
    } catch {
      // Fail open — a budget-bookkeeping failure must never lose a carryover.
    }
  }
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
 * Check whether an issue carrying `label` already exists for this task.
 * Searches open issues for the `<!-- task-hash: <hash> -->` marker in the body.
 *
 * Returns `{ exists: false }` on any CLI failure — caller treats this as
 * "probably no duplicate" and proceeds with creation (fail-open).
 *
 * @param {{
 *   taskHash: string,
 *   label: string,
 *   vcs?: 'gitlab' | 'github',
 *   repoRoot?: string,
 *   resolveRepoSpecFn?: (opts: { repoRoot: string, vcs: 'gitlab' | 'github' }) => string | undefined
 * }} opts
 * @returns {Promise<{ exists: boolean, issueId?: number, issueUrl?: string }>}
 */
async function findExistingLabeledIssue({
  taskHash,
  label,
  vcs = 'gitlab',
  repoRoot = process.cwd(),
  resolveRepoSpecFn = resolveRepoSpec,
} = {}) {
  if (!taskHash || typeof taskHash !== 'string') {
    return { exists: false };
  }

  const vcsResolved = vcs === 'github' ? 'github' : 'gitlab';
  const spec = resolveRepoSpecFn({ repoRoot, vcs: vcsResolved });

  try {
    if (vcsResolved === 'github') {
      // gh: list open issues carrying the label; body match is done locally.
      const args = [
        'issue',
        'list',
        '--label',
        label,
        '--state',
        'open',
        '--limit',
        '100',
        '--json',
        'number,url,body',
      ];
      if (spec) args.push('-R', spec);
      const res = runCli('gh', args, repoRoot);
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
    const args = ['issue', 'list', '--label', label, '--per-page', '100', '--output', 'json'];
    if (spec) args.push('-R', spec);
    const res = runCli('glab', args, repoRoot);
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
 * Check whether a carryover issue already exists for this task.
 * Thin wrapper over `findExistingLabeledIssue` with the `type:carryover` label.
 *
 * @param {{
 *   taskHash: string,
 *   vcs?: 'gitlab' | 'github',
 *   repoRoot?: string,
 *   resolveRepoSpecFn?: (opts: { repoRoot: string, vcs: 'gitlab' | 'github' }) => string | undefined
 * }} opts
 * @returns {Promise<{ exists: boolean, issueId?: number, issueUrl?: string }>}
 */
export async function findExistingCarryover({
  taskHash,
  vcs = 'gitlab',
  repoRoot = process.cwd(),
  resolveRepoSpecFn = resolveRepoSpec,
} = {}) {
  return findExistingLabeledIssue({ taskHash, label: 'type:carryover', vcs, repoRoot, resolveRepoSpecFn });
}

/**
 * Check whether a broken-window closure issue already exists for this task.
 * Thin wrapper over `findExistingLabeledIssue` with the `broken-window` label.
 *
 * @param {{
 *   taskHash: string,
 *   vcs?: 'gitlab' | 'github',
 *   repoRoot?: string,
 *   resolveRepoSpecFn?: (opts: { repoRoot: string, vcs: 'gitlab' | 'github' }) => string | undefined
 * }} opts
 * @returns {Promise<{ exists: boolean, issueId?: number, issueUrl?: string }>}
 */
export async function findExistingBrokenWindow({
  taskHash,
  vcs = 'gitlab',
  repoRoot = process.cwd(),
  resolveRepoSpecFn = resolveRepoSpec,
} = {}) {
  return findExistingLabeledIssue({ taskHash, label: 'broken-window', vcs, repoRoot, resolveRepoSpecFn });
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
 *   vcs?: 'gitlab' | 'github',
 *   repoRoot?: string,
 *   resolveRepoSpecFn?: (opts: { repoRoot: string, vcs: 'gitlab' | 'github' }) => string | undefined
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
  repoRoot = process.cwd(),
  resolveRepoSpecFn = resolveRepoSpec,
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

    // Resolve the -R/--repo host-pinning spec ONCE (#839); reuse the same
    // resolved value for the dedup lookup below instead of re-resolving.
    const spec = resolveRepoSpecFn({ repoRoot, vcs: vcsResolved });

    const taskHash = computeTaskHash(taskDescription);

    // Dedup check first.
    const existing = await findExistingCarryover({
      taskHash,
      vcs: vcsResolved,
      repoRoot,
      resolveRepoSpecFn: () => spec,
    });
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
    const labels = `priority::${priority},status:ready,type:carryover`;

    let cmd;
    let args;
    if (vcsResolved === 'github') {
      cmd = 'gh';
      args = ['issue', 'create', '--title', title, '--body', body, '--label', labels];
    } else {
      cmd = 'glab';
      args = ['issue', 'create', '--title', title, '--description', body, '--label', labels];
    }
    if (spec) args.push('-R', spec);

    const res = runCli(cmd, args, repoRoot);
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

/**
 * Compute a `YYYY-MM-DD` due-date `days` days from today (UTC).
 * `days` is clamped to a positive integer (>= 1); anything else falls back to 7.
 *
 * @param {number} days
 * @param {Date} [now] — injectable clock for deterministic tests
 * @returns {string} ISO date (YYYY-MM-DD)
 */
function computeDueDate(days, now = new Date()) {
  const n = Number.isInteger(days) && days >= 1 ? days : 7;
  const d = new Date(now.getTime());
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Build the markdown body for a broken-window closure issue. Embeds the
 * `task-hash` marker used by `findExistingBrokenWindow` for dedup.
 *
 * GitHub has no native due-date field, so for `vcs === 'github'` the due-date
 * is surfaced as the FIRST body line (`Due: <YYYY-MM-DD>`); on GitLab it lives
 * in the native `--due-date` flag and is also echoed in the body for context.
 *
 * @param {{
 *   item: { title?: string, source?: string, description?: string, sessionId?: string },
 *   taskHash: string,
 *   dueDate: string,
 *   vcs: 'gitlab' | 'github'
 * }} opts
 * @returns {string}
 */
function buildBrokenWindowBody({ item, taskHash, dueDate, vcs }) {
  const title = String(item?.title ?? '').trim() || '(untitled shipment)';
  const source = String(item?.source ?? '').trim() || '(unspecified)';
  const description = String(item?.description ?? '').trim() || '_(no description captured)_';
  const sessionId = String(item?.sessionId ?? '').trim() || '(unknown session)';

  const lines = [
    `<!-- task-hash: ${taskHash} -->`,
    '',
    `## [Broken-Window] ${title}`,
    '',
    `**Source:** \`${source}\``,
    `**Session:** \`${sessionId}\``,
    `**Due:** ${dueDate}`,
    '',
    '### What shipped broken',
    '',
    description,
    '',
    '### Why this is tracked',
    '',
    '- This shipped under a documented exception (echo-stub, WARN-lint, or an',
    '  overridden reviewer finding) despite a Full-Gate PASS.',
    '- The due-date above is HARD — this closure issue exists to force the',
    '  broken window shut before it normalises.',
    '',
    '_Auto-created by `scripts/lib/spiral-carryover.mjs` (session-end Phase 2.6, #730/H5)._',
  ];

  // GitHub has no native due-date field — surface it as the first body line.
  if (vcs === 'github') {
    return [`Due: ${dueDate}`, ...lines].join('\n');
  }
  return lines.join('\n');
}

/**
 * File a hard-terminated closure issue for a knowingly-broken shipment
 * (session-end Phase 2.6, #730/H5).
 *
 * Behavior:
 *   1. Compute a task hash from `<source>::<title>` and call
 *      `findExistingBrokenWindow`. If one exists, return
 *      `{ created: false, skipped: 'duplicate', issueId, issueUrl }`.
 *   2. Build title `[Broken-Window] <truncated title>`.
 *   3. Build body with embedded `<!-- task-hash: <hash> -->` marker.
 *   4. Shell out to `glab issue create --due-date <date>` (gitlab, native) or
 *      `gh issue create` (github; due-date lives in the body's first line).
 *   5. Parse stdout for the issue URL and return `{ created: true, issueId, issueUrl, due }`.
 *
 * Never throws. On any CLI failure returns `{ created: false, skipped: 'error', error }`.
 * `repoRoot` defaults to `process.cwd()` and is used (#839) to resolve the
 * `-R`/`--repo` host-pinning spec via `resolveRepoSpecFn` — previously accepted
 * only for signature symmetry and left unused.
 *
 * @param {{
 *   item: { title?: string, source?: string, description?: string, sessionId?: string },
 *   dueDays?: number,
 *   repoRoot?: string,
 *   resolveRepoSpecFn?: (opts: { repoRoot: string, vcs: 'gitlab' | 'github' }) => string | undefined,
 *   vcs?: 'gitlab' | 'github'
 * }} opts
 * @returns {Promise<{
 *   created: boolean,
 *   issueId?: number,
 *   issueUrl?: string,
 *   due?: string,
 *   skipped?: 'duplicate' | 'error',
 *   error?: string
 * }>}
 */
export async function createBrokenWindowIssue({
  item,
  dueDays = 7,
  repoRoot = process.cwd(),
  resolveRepoSpecFn = resolveRepoSpec,
  vcs = 'gitlab',
} = {}) {
  try {
    const vcsResolved = vcs === 'github' ? 'github' : 'gitlab';
    const title = String(item?.title ?? '').trim();
    const source = String(item?.source ?? '').trim();
    if (!title) {
      return { created: false, skipped: 'error', error: 'missing item.title' };
    }

    const dueDate = computeDueDate(dueDays);

    // Resolve the -R/--repo host-pinning spec ONCE (#839); reuse the same
    // resolved value for the dedup lookup below instead of re-resolving.
    const spec = resolveRepoSpecFn({ repoRoot, vcs: vcsResolved });

    // Dedup key: (source, title) pair — two different sources with the same
    // title are genuinely distinct broken windows and each file separately.
    const taskHash = computeTaskHash(`${source}::${title}`);

    const existing = await findExistingBrokenWindow({
      taskHash,
      vcs: vcsResolved,
      repoRoot,
      resolveRepoSpecFn: () => spec,
    });
    if (existing.exists) {
      return {
        created: false,
        skipped: 'duplicate',
        issueId: existing.issueId,
        issueUrl: existing.issueUrl,
      };
    }

    const issueTitle = `[Broken-Window] ${truncate(title, 80)}`;
    const body = buildBrokenWindowBody({ item, taskHash, dueDate, vcs: vcsResolved });
    const labels = 'broken-window,priority::high';

    let cmd;
    let args;
    if (vcsResolved === 'github') {
      cmd = 'gh';
      args = ['issue', 'create', '--title', issueTitle, '--body', body, '--label', labels];
    } else {
      cmd = 'glab';
      args = [
        'issue',
        'create',
        '--title',
        issueTitle,
        '--description',
        body,
        '--label',
        labels,
        '--due-date',
        dueDate,
      ];
    }
    if (spec) args.push('-R', spec);

    const res = runCli(cmd, args, repoRoot);
    if (!res.ok) {
      return { created: false, skipped: 'error', error: res.stderr.trim() || 'CLI invocation failed' };
    }

    const { issueId, issueUrl } = parseIssueCreateOutput(res.stdout);
    if (issueId === undefined) {
      // CLI succeeded but URL parse failed — still report created (with the due
      // date) so the caller doesn't retry endlessly; include raw stdout.
      return { created: true, issueUrl: res.stdout.trim(), due: dueDate };
    }
    return { created: true, issueId, issueUrl, due: dueDate };
  } catch (err) {
    const msg = err && err.message ? String(err.message) : 'unknown error';
    return { created: false, skipped: 'error', error: msg };
  }
}
