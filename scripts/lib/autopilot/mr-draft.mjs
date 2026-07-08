// scripts/lib/autopilot/mr-draft.mjs
//
// Draft MR/PR creation module for autopilot --multi-story per OPEN-6 PRD.
// Implements the security pattern from ADR-364 C5: execFile (NOT shell) +
// binary allowlist + shell-metacharacter rejection on title/description.
//
// Policy values: 'off' (default), 'on-loop-start', 'on-green' (deferred).
//
// References:
//   - "Autopilot Phase D — Per-Story Worktree Pipelines" (#341; archived in the private Meta-Vault) (OPEN-6 [DECIDED])
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
    let mrs;
    try {
      mrs = JSON.parse(stdout);
    } catch {
      throw new MrDraftError(
        `glab output could not be parsed as JSON (stdout: ${stdout.slice(0, 120)})`,
        'EXEC_FAILURE',
      );
    }
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
    let prs;
    try {
      prs = JSON.parse(stdout);
    } catch {
      throw new MrDraftError(
        `gh output could not be parsed as JSON (stdout: ${stdout.slice(0, 120)})`,
        'EXEC_FAILURE',
      );
    }
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
// Evidence block (issue #669 — downstream-human-review legibility)
// ---------------------------------------------------------------------------
// arXiv 2604.16754: reviewing an agent PR takes +441% longer because the
// reasoning is discarded at diff-time. Attaching a structured evidence block —
// decision-trace, fresh gate exit-codes, changed-files, carryover — makes the
// agent's work legible so a human reviews faster.
//
// Default-ON; opt-OUT via the SO_MR_EVIDENCE env-var (mirrors the
// SO_VAULT_DIR / SO_BASELINE_PATH host-local env-override idiom). When
// SO_MR_EVIDENCE === 'off' the block is omitted entirely.

/**
 * Render a single markdown line, falling back to a literal "n/a" when the
 * value is missing/blank. Keeps the block markdown-safe and graceful.
 * @param {unknown} value
 * @returns {string}
 */
function evidenceValueOr(value) {
  if (value === null || value === undefined) return 'n/a';
  const s = String(value).trim();
  return s.length === 0 ? 'n/a' : s;
}

/**
 * Render the quality-gate sub-section: one row per gate with its exit code and
 * (optional) count summary. A missing gate renders as "n/a".
 * @param {object} [gates] - { test?, typecheck?, lint? } each { exitCode?, summary? }
 * @returns {string[]}
 */
function renderGateRows(gates) {
  const g = gates && typeof gates === 'object' ? gates : {};
  const row = (label, gate) => {
    if (!gate || typeof gate !== 'object') return `| ${label} | n/a | n/a |`;
    const exit =
      gate.exitCode === null || gate.exitCode === undefined
        ? 'n/a'
        : String(gate.exitCode);
    const summary = evidenceValueOr(gate.summary);
    return `| ${label} | ${exit} | ${summary} |`;
  };
  return [
    '| Gate | Exit code | Summary |',
    '| --- | --- | --- |',
    row('test', g.test),
    row('typecheck', g.typecheck),
    row('lint', g.lint),
  ];
}

/**
 * Build the structured `## Evidence` block (collapsible <details>) from the
 * OPTIONAL evidence fields on the draft context. Every sub-section degrades to
 * "n/a" when its source field is absent — so existing callers
 * (worktree-pipeline.mjs, skill-evolution/mr-opener.mjs) that pass none of
 * these fields keep working and simply render an all-"n/a" block.
 *
 * @param {object} ctx
 * @param {Array<{wave?: string|number, summary?: string}>|string} [ctx.waveSummary]
 *   Per-wave decision trace. Array of {wave, summary} rows, or a pre-rendered string.
 * @param {{test?: object, typecheck?: object, lint?: object}} [ctx.gateResults]
 *   Quality-gate outcomes; each gate is {exitCode, summary}.
 * @param {string[]|string} [ctx.changedFiles]
 *   Changed-files list (array of paths or a pre-rendered string).
 * @param {Array<{ref?: string, note?: string}>|string} [ctx.carryover]
 *   Carryover items (array of {ref, note} or a pre-rendered string).
 * @returns {string[]} markdown lines (empty array when no block should render)
 */
export function buildEvidenceBlock(ctx = {}) {
  const { waveSummary, gateResults, changedFiles, carryover } = ctx;

  // --- Decision-trace / per-wave summary ---
  const waveLines = [];
  if (typeof waveSummary === 'string' && waveSummary.trim().length > 0) {
    waveLines.push(waveSummary.trim());
  } else if (Array.isArray(waveSummary) && waveSummary.length > 0) {
    for (const w of waveSummary) {
      const label = evidenceValueOr(w?.wave);
      const summary = evidenceValueOr(w?.summary);
      waveLines.push(`- **${label}:** ${summary}`);
    }
  } else {
    waveLines.push('n/a');
  }

  // --- Changed-files summary ---
  const fileLines = [];
  if (typeof changedFiles === 'string' && changedFiles.trim().length > 0) {
    fileLines.push(changedFiles.trim());
  } else if (Array.isArray(changedFiles) && changedFiles.length > 0) {
    fileLines.push(`${changedFiles.length} file(s) changed:`);
    for (const f of changedFiles) fileLines.push(`- \`${evidenceValueOr(f)}\``);
  } else {
    fileLines.push('n/a');
  }

  // --- Carryover ---
  const carryLines = [];
  if (typeof carryover === 'string' && carryover.trim().length > 0) {
    carryLines.push(carryover.trim());
  } else if (Array.isArray(carryover) && carryover.length > 0) {
    for (const c of carryover) {
      const ref = evidenceValueOr(c?.ref);
      const note = evidenceValueOr(c?.note);
      carryLines.push(`- ${ref} — ${note}`);
    }
  } else {
    carryLines.push('n/a');
  }

  return [
    '## Evidence',
    '<details><summary>Decision-trace + verification evidence (for downstream human review)</summary>',
    '',
    '### Decision trace (per wave)',
    ...waveLines,
    '',
    '### Quality gates',
    ...renderGateRows(gateResults),
    '',
    '### Changed files',
    ...fileLines,
    '',
    '### Carryover',
    ...carryLines,
    '',
    '</details>',
  ];
}

// ---------------------------------------------------------------------------
// Build MR body
// ---------------------------------------------------------------------------

/**
 * Build the MR title and description from issue + autopilot context.
 * Title is trimmed to ≤200 chars with '…' suffix if truncated.
 * Description is capped at 10000 chars.
 *
 * An additive `## Evidence` block (decision-trace, gate exit-codes,
 * changed-files, carryover) is appended by default for downstream-human-review
 * legibility (issue #669). Opt out by setting the SO_MR_EVIDENCE env-var to
 * 'off'. The evidence fields on `ctx` are all OPTIONAL — absent fields render
 * as "n/a", so existing callers that pass none of them keep working.
 *
 * @param {object} ctx
 * @param {string} ctx.issueTitle
 * @param {number} ctx.issueIid
 * @param {string} ctx.parentRunId
 * @param {string} ctx.worktreePath
 * @param {Array|string} [ctx.waveSummary]   - optional per-wave decision trace
 * @param {object} [ctx.gateResults]         - optional { test, typecheck, lint } gate outcomes
 * @param {string[]|string} [ctx.changedFiles] - optional changed-files summary
 * @param {Array|string} [ctx.carryover]     - optional carryover items
 * @returns {{title: string, description: string}}
 */
export function buildMrBody(ctx) {
  const { issueTitle, issueIid, parentRunId, worktreePath } = ctx;

  const rawTitle = `[WIP] ${issueTitle} (Autopilot Loop #${parentRunId})`;
  const title =
    rawTitle.length > 200 ? rawTitle.slice(0, 199) + '…' : rawTitle;

  const lines = [
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
  ];

  // Evidence block — default ON, opt OUT via SO_MR_EVIDENCE=off (issue #669).
  if (process.env.SO_MR_EVIDENCE !== 'off') {
    lines.push('', ...buildEvidenceBlock(ctx));
  }

  lines.push(
    '',
    '---',
    `*Generated by session-orchestrator autopilot on ${new Date().toISOString()}*`,
  );

  const description = lines.join('\n');

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
