// scripts/lib/autopilot/mr-draft.mjs
//
// Draft MR/PR creation module for autopilot --multi-story per OPEN-6 PRD.
// Implements the security pattern from ADR-364 C5: execFile (NOT shell) +
// binary allowlist + shell-metacharacter rejection on title/description.
//
// Policy values: 'off' (default), 'on-loop-start', 'on-green' (deferred).
//
// References:
//   - docs/prd/2026-05-07-autopilot-phase-d.md (OPEN-6 [DECIDED])
//   - docs/adr/2026-05-10-364-remote-agent-substrate.md (C5 security finding)

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const realExecFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Binary allowlist (ADR-364 C5 + SEC-014)
// ---------------------------------------------------------------------------
// Bare binary names only — resolved at runtime via PATH by Node's execve.
// Reject any string containing '/' or '..' to prevent path traversal.
const MR_ALLOWLISTED_BINS = Object.freeze({
  glab: 'glab', // GitLab CLI
  gh: 'gh', // GitHub CLI
});

// ---------------------------------------------------------------------------
// CLI-argument-boundary rejection regex (ADR-364 C5 / OPEN-6 / SEC-PD-MED-1 W4 audit)
// ---------------------------------------------------------------------------
// Reject only characters that corrupt CLI arg semantics when passed to execFile
// with shell: false. The shell metacharacter check (formerly /[;&|`$(){}[\]<>!]/)
// was over-broad — `shell: false` already prevents shell interpretation, so the
// regex only served to suppress legitimate GitLab issue titles containing `()`
// or `[]` (e.g. "Fix nav bug (closes #123)"). Narrowed to newline + null byte
// per W4 Q6 security-reviewer finding SEC-PD-MED-1 (confidence 0.95).
const ARG_BOUNDARY_DANGEROUS = /[\n\r\0]/;

// ---------------------------------------------------------------------------
// MrDraftError
// ---------------------------------------------------------------------------

/**
 * Typed error class for MR-draft operations.
 * Codes: 'COLLISION' | 'VALIDATION' | 'EXEC_FAILURE' | 'POLICY_OFF' | 'POLICY_DEFER' | 'UNSUPPORTED_VCS'
 */
export class MrDraftError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'MrDraftError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

/**
 * Validate title and description for shell-metacharacter safety.
 * Throws MrDraftError(VALIDATION) if rejected.
 *
 * Rules:
 *   - title: non-empty string, ≤200 chars, no newlines, no shell-dangerous chars
 *   - description: string, ≤10000 chars, no shell-dangerous chars
 *
 * Note: this function is designed for validating user-supplied input fields
 * (e.g. raw issueTitle from the issue tracker). The assembled MR body produced
 * by buildMrBody() intentionally contains template-controlled characters such
 * as `()` and `[]` which come from trusted code, not user input. Call this
 * function with the raw user-supplied strings before assembling the body.
 *
 * @param {string} title
 * @param {string} description
 */
export function validateMrInputs(title, description) {
  if (typeof title !== 'string' || title.length === 0) {
    throw new MrDraftError('MR title must be a non-empty string', 'VALIDATION');
  }
  if (title.length > 200) {
    throw new MrDraftError(`MR title exceeds 200 chars (got ${title.length})`, 'VALIDATION');
  }
  if (ARG_BOUNDARY_DANGEROUS.test(title)) {
    throw new MrDraftError(
      'MR title must not contain newline or null-byte characters',
      'VALIDATION',
    );
  }

  if (typeof description !== 'string') {
    throw new MrDraftError('MR description must be a string', 'VALIDATION');
  }
  if (description.length > 10_000) {
    throw new MrDraftError(
      `MR description exceeds 10000 chars (got ${description.length})`,
      'VALIDATION',
    );
  }
  if (/\0/.test(description)) {
    throw new MrDraftError('MR description must not contain null bytes', 'VALIDATION');
  }
}

// ---------------------------------------------------------------------------
// Check for an existing open MR/PR
// ---------------------------------------------------------------------------

/**
 * Check if an MR/PR already exists for the source branch.
 *
 * @param {object} opts
 * @param {'glab'|'gh'} opts.vcs
 * @param {string} opts.branchName
 * @param {Function} [opts.execFile] - defaults to promisified execFile from node:child_process
 * @returns {Promise<{hasMR: boolean, mrIid: number|null, mrUrl: string|null}>}
 */
export async function checkExistingMR(opts) {
  const { vcs, branchName } = opts;
  const execFile = typeof opts.execFile === 'function' ? opts.execFile : realExecFile;

  if (vcs === 'glab') {
    const args = [
      'mr',
      'list',
      '--source-branch',
      branchName,
      '--state',
      'opened',
      '--output',
      'json',
    ];
    const { stdout } = await execFile('glab', args, { shell: false, timeout: 5_000 });
    const mrs = JSON.parse(stdout);
    const existing = mrs[0];
    return {
      hasMR: !!existing,
      mrIid: existing?.iid ?? null,
      mrUrl: existing?.web_url ?? null,
    };
  }

  if (vcs === 'gh') {
    const args = ['pr', 'list', '--head', branchName, '--state', 'open', '--json', 'number,url'];
    const { stdout } = await execFile('gh', args, { shell: false, timeout: 5_000 });
    const prs = JSON.parse(stdout);
    const existing = prs[0];
    return {
      hasMR: !!existing,
      mrIid: existing?.number ?? null,
      mrUrl: existing?.url ?? null,
    };
  }

  throw new MrDraftError(`Unsupported VCS for checkExistingMR: '${vcs}'`, 'UNSUPPORTED_VCS');
}

// ---------------------------------------------------------------------------
// Build MR body
// ---------------------------------------------------------------------------

/**
 * Build the MR title and description from issue + autopilot context.
 * Title is trimmed to ≤200 chars with '…' suffix if truncated.
 * Description is capped at 10000 chars.
 *
 * @param {object} ctx
 * @param {string} ctx.issueTitle
 * @param {number} ctx.issueIid
 * @param {string} ctx.parentRunId
 * @param {string} ctx.worktreePath
 * @returns {{title: string, description: string}}
 */
export function buildMrBody(ctx) {
  const { issueTitle, issueIid, parentRunId, worktreePath } = ctx;

  const rawTitle = `[WIP] ${issueTitle} (Autopilot Loop #${parentRunId})`;
  const title =
    rawTitle.length > 200 ? rawTitle.slice(0, 199) + '…' : rawTitle;

  const description = [
    '## Autopilot Draft',
    '',
    `**Issue:** #${issueIid}`,
    `**Loop:** ${parentRunId}`,
    `**Worktree:** ${worktreePath}`,
    '',
    '### Tests (TODO)',
    '- [ ] Unit tests passing',
    '- [ ] Integration tests passing',
    '- [ ] CI pipeline green',
    '',
    '### Code Review',
    '- [ ] Architecture review',
    '- [ ] Security review',
    '',
    '---',
    `*Generated by session-orchestrator autopilot on ${new Date().toISOString()}*`,
  ].join('\n');

  // Cap description at 10000 chars (issue titles fit easily; guard for adversarial input)
  const cappedDescription =
    description.length > 10_000 ? description.slice(0, 10_000) : description;

  return { title, description: cappedDescription };
}

// ---------------------------------------------------------------------------
// maybeCreateDraftMR — primary entry point
// ---------------------------------------------------------------------------

/**
 * Create a draft MR/PR per the policy.
 * Returns immediately if policy is 'off' or 'on-green' (the latter signals
 * the caller to defer; caller is responsible for re-invoking with a different
 * policy or after first green test).
 *
 * @param {object} loop
 * @param {'gitlab'|'github'} loop.vcs
 * @param {number} loop.issueIid
 * @param {string} loop.issueTitle
 * @param {string} loop.branchName
 * @param {string} loop.parentRunId
 * @param {string} loop.worktreePath
 * @param {'off'|'on-loop-start'|'on-green'} loop.draftMrPolicy
 * @param {object} [opts]
 * @param {Function} [opts.execFile]
 * @param {(level: string, msg: string) => void} [opts.log]
 * @returns {Promise<{created: boolean, deferred?: boolean, existing?: boolean, mrUrl?: string|null, error?: string}>}
 */
export async function maybeCreateDraftMR(loop, opts = {}) {
  const log =
    typeof opts.log === 'function'
      ? opts.log
      : (_level, _msg) => {}; // no-op default
  const execFile = typeof opts.execFile === 'function' ? opts.execFile : realExecFile;

  const { draftMrPolicy, vcs, issueIid, issueTitle, branchName, parentRunId, worktreePath } = loop;

  // --- Policy: off ---
  if (draftMrPolicy === 'off') {
    log('info', 'mr-draft: policy=off, skipping MR creation');
    return { created: false };
  }

  // --- Policy: on-green (deferred) ---
  if (draftMrPolicy === 'on-green') {
    log('info', 'mr-draft: policy=on-green, deferring MR creation until first green test');
    return { created: false, deferred: true };
  }

  // --- Policy: on-loop-start ---
  if (draftMrPolicy === 'on-loop-start') {
    // Map loop.vcs ('gitlab'|'github') to CLI binary ('glab'|'gh')
    let vcsBin;
    if (vcs === 'gitlab') {
      vcsBin = MR_ALLOWLISTED_BINS.glab;
    } else if (vcs === 'github') {
      vcsBin = MR_ALLOWLISTED_BINS.gh;
    } else {
      throw new MrDraftError(`Unsupported vcs value: '${vcs}'`, 'UNSUPPORTED_VCS');
    }

    // Validate user-supplied issueTitle before building.
    // validateMrInputs guards against shell-dangerous chars from the issue
    // tracker. The description arg is '' here because the description is
    // entirely template-controlled (checkboxes, headers) — only issueTitle
    // is user-supplied and needs the injection guard. The assembled body
    // intentionally contains '()' and '[ ]' from the trusted template.
    validateMrInputs(issueTitle, '');

    // Build title/description from validated inputs
    const { title, description } = buildMrBody({
      issueTitle,
      issueIid,
      parentRunId,
      worktreePath,
    });

    // Collision check — skip if MR already exists
    let existingCheck;
    try {
      existingCheck = await checkExistingMR({
        vcs: vcsBin, // 'glab' or 'gh'
        branchName,
        execFile,
      });
    } catch (err) {
      log('error', `mr-draft: collision check failed — ${err.message}`);
      return { created: false, error: err.message };
    }

    if (existingCheck.hasMR) {
      log(
        'info',
        `mr-draft: existing MR found (iid=${existingCheck.mrIid}), skipping creation`,
      );
      return { created: false, existing: true, mrUrl: existingCheck.mrUrl };
    }

    // Build arg vector — no template-string interpolation in command args
    let createArgs;
    if (vcs === 'gitlab') {
      createArgs = [
        'mr',
        'create',
        '--draft',
        '--title',
        title,
        '--description',
        description,
        '--source-branch',
        branchName,
      ];
    } else {
      // github
      createArgs = [
        'pr',
        'create',
        '--draft',
        '--title',
        title,
        '--body',
        description,
        '--head',
        branchName,
      ];
    }

    // Execute MR/PR creation
    try {
      const { stdout } = await execFile(vcsBin, createArgs, {
        shell: false,
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      });
      const mrUrl = stdout.trim() || null;
      log('info', `mr-draft: created draft MR/PR — ${mrUrl}`);
      return { created: true, mrUrl };
    } catch (err) {
      if (err.code === 'ENOENT') {
        log('error', `mr-draft: binary '${vcsBin}' not found in PATH`);
        return { created: false, error: 'binary not found' };
      }
      log('error', `mr-draft: execFile failed — ${err.message}`);
      return { created: false, error: err.message };
    }
  }

  // --- Unknown policy ---
  throw new MrDraftError(
    `Unknown draftMrPolicy: '${draftMrPolicy}'. Expected 'off', 'on-loop-start', or 'on-green'`,
    'VALIDATION',
  );
}
