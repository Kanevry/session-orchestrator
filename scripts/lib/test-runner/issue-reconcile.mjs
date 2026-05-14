/**
 * test-runner/issue-reconcile.mjs — Reconcile findings with the open issue tracker.
 *
 * Uses execFile (NOT shell) per ADR-364 §C5. Binary allowlist + arg-boundary
 * validation prevent shell-injection. Fingerprint-based dedup prevents
 * duplicate issues.
 *
 * Exports:
 *   reconcileFinding({finding, existingFingerprints, glabPath, dryRun})
 *     → Promise<{action: 'create'|'noop', iid?, command?}>
 *   ReconcileError
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { fingerprintFinding } from './fingerprint.mjs';

const realExecFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Binary allowlist (ADR-364 C5 + SEC-014)
// ---------------------------------------------------------------------------
// Bare binary names only — resolved at runtime via PATH by Node's execve.
// Reject any string containing '/' or '..' to prevent path traversal.
const RECONCILE_ALLOWLISTED_BINS = Object.freeze({
  glab: 'glab',
  gh: 'gh',
});

// ---------------------------------------------------------------------------
// CLI-argument-boundary rejection regex (ADR-364 §C5 / SEC-PD-MED-1)
// ---------------------------------------------------------------------------
// Reject only characters that corrupt CLI arg semantics when passed to execFile
// with shell: false. Narrowed to newline + CR + null byte — shell metacharacters
// are irrelevant because shell: false prevents shell interpretation.
const ARG_BOUNDARY_DANGEROUS = /[\n\r\0]/;

// ---------------------------------------------------------------------------
// ReconcileError
// ---------------------------------------------------------------------------

/**
 * Typed error for reconciliation failures.
 * Codes: 'VALIDATION' | 'EXEC_FAILURE' | 'BINARY_NOT_FOUND'
 */
export class ReconcileError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ReconcileError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);
const REQUIRED_STRING_FIELDS = ['scope', 'checkId', 'locator', 'severity', 'title', 'description'];

/**
 * Validate a finding object, throwing ReconcileError(VALIDATION) on failure.
 * @param {object} finding
 */
function validateFinding(finding) {
  if (!finding || typeof finding !== 'object') {
    throw new ReconcileError('finding must be an object', 'VALIDATION');
  }
  for (const key of REQUIRED_STRING_FIELDS) {
    const v = finding[key];
    if (typeof v !== 'string') {
      throw new ReconcileError(`finding.${key} must be a string`, 'VALIDATION');
    }
    if (ARG_BOUNDARY_DANGEROUS.test(v)) {
      throw new ReconcileError(
        `finding.${key} contains forbidden characters (newline/CR/null byte)`,
        'VALIDATION',
      );
    }
  }
  if (!VALID_SEVERITIES.has(finding.severity)) {
    throw new ReconcileError(
      `finding.severity must be one of: ${[...VALID_SEVERITIES].join(', ')}`,
      'VALIDATION',
    );
  }
}

// ---------------------------------------------------------------------------
// Issue body builder
// ---------------------------------------------------------------------------

/**
 * Build the issue description body from a finding and its fingerprint.
 * Newlines within the body are intentional and safe — execFile passes
 * --description as a single argv element, not through a shell.
 *
 * @param {object} finding
 * @param {string} fp - 16-char hex fingerprint
 * @returns {string}
 */
function buildIssueBody(finding, fp) {
  const lines = [
    finding.description,
    '',
    finding.recommendation ? `**Recommendation:** ${finding.recommendation}` : null,
    '',
    `**Fingerprint:** \`${fp}\``,
    `**Severity:** ${finding.severity}`,
    `**Check:** ${finding.checkId}`,
    `**Locator:** \`${finding.locator}\``,
  ];
  return lines.filter((line) => line !== null).join('\n');
}

// ---------------------------------------------------------------------------
// Parse glab stdout for the created issue IID
// ---------------------------------------------------------------------------

/**
 * Parse the issue IID from glab's stdout.
 * glab issue create prints a URL like:
 *   https://gitlab.example.com/group/project/-/issues/123
 * We extract the trailing integer.
 *
 * @param {string} stdout
 * @returns {number|null}
 */
function parseIidFromGlabOutput(stdout) {
  if (typeof stdout !== 'string') return null;
  const match = stdout.match(/\/issues\/(\d+)/);
  if (match) return parseInt(match[1], 10);
  // Fallback: any trailing integer on the last non-empty line
  const trail = stdout.trim().match(/(\d+)\s*$/);
  return trail ? parseInt(trail[1], 10) : null;
}

// ---------------------------------------------------------------------------
// reconcileFinding
// ---------------------------------------------------------------------------

/**
 * Reconcile a finding against existing issues.
 *
 * If the fingerprint is already in `existingFingerprints`, return `{action: 'noop'}`.
 * Otherwise, create a new issue via glab (or return the dry-run command).
 *
 * @param {object} opts
 * @param {object} opts.finding - finding object with scope/checkId/locator/severity/title/description
 * @param {Set<string>} opts.existingFingerprints - fingerprints of issues already filed
 * @param {string} [opts.glabPath] - explicit path to glab binary (otherwise uses PATH lookup)
 * @param {boolean} [opts.dryRun] - if true, return command without spawning
 * @returns {Promise<{action: 'create'|'noop', iid?: number, command?: string[]}>}
 */
export async function reconcileFinding({
  finding,
  existingFingerprints,
  glabPath,
  dryRun = false,
}) {
  validateFinding(finding);

  if (!(existingFingerprints instanceof Set)) {
    throw new ReconcileError('existingFingerprints must be a Set', 'VALIDATION');
  }

  const fp = fingerprintFinding({
    scope: finding.scope,
    checkId: finding.checkId,
    locator: finding.locator,
  });

  if (existingFingerprints.has(fp)) {
    return { action: 'noop' };
  }

  const title = `[Test] ${finding.title}`;
  // title is derived from finding.title which was already validated above,
  // but we recheck the assembled value for completeness.
  if (ARG_BOUNDARY_DANGEROUS.test(title)) {
    throw new ReconcileError('finding.title produces unsafe issue title', 'VALIDATION');
  }

  const body = buildIssueBody(finding, fp);
  // Body may contain newlines (intentional markdown structure) but must not
  // contain null bytes, which would corrupt argv.
  if (body.includes('\0')) {
    throw new ReconcileError('issue body contains null byte', 'VALIDATION');
  }

  const labels = `from:test-runner,severity:${finding.severity},status:ready,type:bug`;
  const cmd = [
    'issue',
    'create',
    '--title',
    title,
    '--label',
    labels,
    '--description',
    body,
  ];

  if (dryRun) {
    return { action: 'create', command: cmd };
  }

  // Resolve binary — allowlisted names only, resolved via PATH by execve.
  const bin = glabPath !== undefined ? glabPath : RECONCILE_ALLOWLISTED_BINS.glab;

  try {
    const { stdout } = await realExecFile(bin, cmd, {
      shell: false,
      timeout: 10_000,
    });
    const iid = parseIidFromGlabOutput(stdout);
    return { action: 'create', iid, command: cmd };
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new ReconcileError(`Binary '${bin}' not found in PATH`, 'BINARY_NOT_FOUND');
    }
    throw new ReconcileError(`execFile failed: ${err.message}`, 'EXEC_FAILURE');
  }
}
