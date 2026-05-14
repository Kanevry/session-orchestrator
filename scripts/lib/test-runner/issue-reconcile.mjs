/**
 * test-runner/issue-reconcile.mjs — Reconcile findings with the open issue tracker.
 *
 * Uses execFile (NOT shell) per ADR-364 §C5. Binary allowlist + arg-boundary
 * validation prevent shell-injection. Fingerprint-based dedup prevents
 * duplicate issues.
 *
 * Exports:
 *   reconcileFinding({finding, existingFingerprints, dryRun, execFile})
 *     → Promise<{action: 'create'|'noop', iid?, command?}>
 *
 *   listExistingFindings({project, label, maxBuffer, execFile})
 *     → Promise<{ok: true, issues: Array<{iid, title, body}>, fingerprints: Set<string>}
 *              | {ok: false, error}>
 *
 *   createFinding({project, fingerprint, title, body, labels, dryRun, maxBuffer, execFile})
 *     → Promise<{ok: true, action: 'create', iid?, command?} | {ok: false, error}>
 *
 *   updateFinding({project, iid, comment, dryRun, maxBuffer, execFile})
 *     → Promise<{ok: true, action: 'comment', command?} | {ok: false, error}>
 *
 *   triageDecision(finding, candidates)
 *     → {action: 'create'|'update'|'ignore', target?, reason: string, confidence: number}
 *
 *   ReconcileError
 *
 * Security:
 *   - #388 (SEC-IR-MED-1): sentinel injection hardening — sanitizeRecommendation()
 *     strips **Fingerprint:** literals from free-text fields before they are
 *     embedded in the body (before the authoritative sentinel line is appended).
 *   - #389 (SEC-IR-LOW-1): maxBuffer set to 4 MB on every execFile call;
 *     body > 65536 bytes is rejected with BODY_TOO_LARGE.
 *   - ADR-364 §C5 / HIGH: glabPath parameter removed. All call sites use
 *     RECONCILE_ALLOWLISTED_BINS.glab. Tests inject behaviour via opts.execFile
 *     (same DI seam as mr-draft.mjs) — never via caller-supplied binary paths.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { fingerprintFinding } from './fingerprint.mjs';

const realExecFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Constants (#389)
// ---------------------------------------------------------------------------

/** Default maxBuffer for all execFile calls — 4 MB (#389 SEC-IR-LOW-1). */
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

/** Maximum allowed issue body length in bytes (#389 SEC-IR-LOW-1). */
const MAX_BODY_BYTES = 65536;

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
 * Codes: 'VALIDATION' | 'EXEC_FAILURE' | 'BINARY_NOT_FOUND' | 'BODY_TOO_LARGE'
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
// Sentinel sanitization (#388 SEC-IR-MED-1)
// ---------------------------------------------------------------------------

/**
 * Sanitize free-text recommendation fields before embedding in the issue body.
 * Replaces any literal `**Fingerprint:**` with `__Fingerprint__` to prevent
 * a crafted recommendation from spoofing the authoritative fingerprint sentinel
 * line that is appended by buildIssueBody().
 *
 * Context: glab parses issue bodies as Markdown. If `recommendation` contained
 * `**Fingerprint:** <attacker-hash>`, a grep for the fingerprint sentinel in
 * listExistingFindings() would match the spoofed value instead of the real one,
 * bypassing dedup. Replacing the literal prevents the attack without altering
 * the semantic meaning of the recommendation text.
 *
 * @param {string|undefined|null} text
 * @returns {string|undefined|null}
 */
function sanitizeRecommendation(text) {
  if (!text || typeof text !== 'string') return text;
  // gi flag: case-insensitive match so **fingerprint:** and **FINGERPRINT:** variants
  // are also neutralized. Sanitizer is intentionally broader than the case-sensitive
  // extractor regex — this is the correct asymmetry (#388 SEC-IR-MED-1).
  return text.replace(/\*\*Fingerprint:\*\*/gi, '__Fingerprint__');
}

// ---------------------------------------------------------------------------
// Body-length validation (#389 SEC-IR-LOW-1)
// ---------------------------------------------------------------------------

/**
 * Validate that a body string does not exceed MAX_BODY_BYTES.
 * Returns {ok: false, error} on violation; callers propagate this directly.
 *
 * @param {string} body
 * @returns {{ok: false, error: {code: string, message: string}}|null}
 */
function checkBodyLength(body) {
  const byteLength = Buffer.byteLength(body, 'utf8');
  if (byteLength > MAX_BODY_BYTES) {
    return {
      ok: false,
      error: {
        code: 'BODY_TOO_LARGE',
        message: `Body exceeds maximum allowed size of ${MAX_BODY_BYTES} bytes (got ${byteLength} bytes)`,
      },
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Issue body builder
// ---------------------------------------------------------------------------

/**
 * Build the issue description body from a finding and its fingerprint.
 * Newlines within the body are intentional and safe — execFile passes
 * --description as a single argv element, not through a shell.
 *
 * Applies sanitizeRecommendation() to the recommendation field (#388) before
 * embedding it, so the authoritative `**Fingerprint:** \`<fp>\`` sentinel
 * line cannot be spoofed by attacker-controlled recommendation text.
 *
 * @param {object} finding
 * @param {string} fp - 16-char hex fingerprint
 * @returns {string}
 */
function buildIssueBody(finding, fp) {
  const safeRecommendation = sanitizeRecommendation(finding.recommendation);
  const lines = [
    finding.description,
    '',
    safeRecommendation ? `**Recommendation:** ${safeRecommendation}` : null,
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
// Extract fingerprints from issue bodies
// ---------------------------------------------------------------------------

/**
 * Extract the 16-hex fingerprint from an issue body string.
 * Matches the authoritative sentinel line: `**Fingerprint:** \`<16-hex>\``
 *
 * @param {string} body
 * @returns {string|null}
 */
function extractFingerprintFromBody(body) {
  if (typeof body !== 'string') return null;
  const match = body.match(/\*\*Fingerprint:\*\*\s*`([0-9a-f]{16})`/);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Levenshtein distance (pure) — used by triageDecision
// ---------------------------------------------------------------------------

/**
 * Compute the Levenshtein edit distance between two strings.
 * Pure function; no external dependencies.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function levenshtein(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return Infinity;
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;

  // Two-row DP to keep memory O(min(m,n)).
  let prev = Array.from({ length: lb + 1 }, (_, i) => i);
  let curr = new Array(lb + 1);

  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[lb];
}

// ---------------------------------------------------------------------------
// reconcileFinding (Track A — backwards-compatible original export)
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
 * @param {boolean} [opts.dryRun] - if true, return command without spawning
 * @param {Function} [opts.execFile] - DI seam for testing; defaults to node:child_process execFile
 * @returns {Promise<{action: 'create'|'noop', iid?: number, command?: string[]}>}
 */
export async function reconcileFinding({
  finding,
  existingFingerprints,
  dryRun = false,
  execFile: execFileOpt,
}) {
  // Resolve execFile — DI seam for tests; never caller-supplied binary path (ADR-364 §C5 HIGH fix).
  const execFileFn = typeof execFileOpt === 'function' ? execFileOpt : realExecFile;
  // Binary is always the allowlisted value — never caller-supplied.
  const bin = RECONCILE_ALLOWLISTED_BINS.glab;

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

  // #389 MED-1: body-length cap in reconcileFinding backwards-compat path.
  const bodyLengthError = checkBodyLength(body);
  if (bodyLengthError) {
    throw new ReconcileError(bodyLengthError.error.message, bodyLengthError.error.code);
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

  try {
    const { stdout } = await execFileFn(bin, cmd, {
      shell: false,
      timeout: 10_000,
      maxBuffer: DEFAULT_MAX_BUFFER,
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

// ---------------------------------------------------------------------------
// listExistingFindings — query glab for open test-runner findings (#384)
// ---------------------------------------------------------------------------

/**
 * List existing test-runner findings from the issue tracker.
 *
 * Calls `glab issue list --label <label> --output json` and extracts
 * fingerprints from issue bodies for downstream dedup.
 *
 * @param {object} [opts]
 * @param {string} [opts.project] - GitLab project path (passed via --repo if provided)
 * @param {string} [opts.label='from:test-runner'] - label filter for the query
 * @param {number} [opts.maxBuffer=4194304] - maxBuffer for execFile (4 MB default, #389)
 * @param {Function} [opts.execFile] - DI seam for testing; defaults to node:child_process execFile
 * @returns {Promise<
 *   {ok: true, issues: Array<{iid: number, title: string, body: string}>, fingerprints: Set<string>}
 *   | {ok: false, error: {code: string, message: string}}
 * >}
 */
export async function listExistingFindings({
  project,
  label = 'from:test-runner',
  maxBuffer = DEFAULT_MAX_BUFFER,
  execFile: execFileOpt,
} = {}) {
  // Binary is always the allowlisted value — never caller-supplied (ADR-364 §C5 HIGH fix).
  const bin = RECONCILE_ALLOWLISTED_BINS.glab;
  const execFileFn = typeof execFileOpt === 'function' ? execFileOpt : realExecFile;

  // Validate label arg boundary
  if (ARG_BOUNDARY_DANGEROUS.test(label)) {
    return {
      ok: false,
      error: { code: 'VALIDATION', message: 'label contains forbidden characters' },
    };
  }

  const args = ['issue', 'list', '--label', label, '--output', 'json'];

  // Optionally scope to a specific project (--repo flag)
  if (project !== undefined) {
    if (ARG_BOUNDARY_DANGEROUS.test(project)) {
      return {
        ok: false,
        error: { code: 'VALIDATION', message: 'project contains forbidden characters' },
      };
    }
    args.push('--repo', project);
  }

  let stdout;
  try {
    const result = await execFileFn(bin, args, {
      shell: false,
      timeout: 15_000,
      maxBuffer,
    });
    stdout = result.stdout;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {
        ok: false,
        error: {
          code: 'BINARY_NOT_FOUND',
          message: `Binary '${bin}' not found in PATH`,
        },
      };
    }
    return {
      ok: false,
      error: {
        code: 'EXEC_FAILURE',
        message: `execFile failed: ${err.message}`,
      },
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return {
      ok: false,
      error: {
        code: 'PARSE_ERROR',
        message: 'Failed to parse glab JSON output',
      },
    };
  }

  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      error: {
        code: 'PARSE_ERROR',
        message: 'Expected glab output to be a JSON array',
      },
    };
  }

  const issues = parsed.map((issue) => ({
    iid: issue.iid ?? issue.number ?? null,
    title: issue.title ?? '',
    body: issue.description ?? issue.body ?? '',
  }));

  // Build fingerprint dedup set from issue bodies
  const fingerprints = new Set();
  for (const issue of issues) {
    const fp = extractFingerprintFromBody(issue.body);
    if (fp !== null) {
      fingerprints.add(fp);
    }
  }

  return { ok: true, issues, fingerprints };
}

// ---------------------------------------------------------------------------
// createFinding — create a new GitLab issue (#384)
// ---------------------------------------------------------------------------

/**
 * Create a new finding as a GitLab issue.
 *
 * @param {object} opts
 * @param {string} [opts.project] - GitLab project path (--repo)
 * @param {string} opts.fingerprint - 16-hex fingerprint (appended as sentinel)
 * @param {string} opts.title - issue title (no [Test] prefix added here — caller decides)
 * @param {string} opts.body - issue description body; must not exceed 65536 bytes (#389)
 * @param {string} [opts.labels='from:test-runner'] - comma-separated label string
 * @param {boolean} [opts.dryRun=false] - if true, return command without spawning
 * @param {number} [opts.maxBuffer=4194304] - maxBuffer for execFile (4 MB, #389)
 * @param {Function} [opts.execFile] - DI seam for testing; defaults to node:child_process execFile
 * @returns {Promise<
 *   {ok: true, action: 'create', iid?: number, command?: string[]}
 *   | {ok: false, error: {code: string, message: string}}
 * >}
 */
export async function createFinding({
  project,
  fingerprint,
  title,
  body,
  labels = 'from:test-runner',
  dryRun = false,
  maxBuffer = DEFAULT_MAX_BUFFER,
  execFile: execFileOpt,
}) {
  // --- Input validation ---
  if (typeof title !== 'string' || title.length === 0) {
    return { ok: false, error: { code: 'VALIDATION', message: 'title must be a non-empty string' } };
  }
  if (ARG_BOUNDARY_DANGEROUS.test(title)) {
    return {
      ok: false,
      error: { code: 'VALIDATION', message: 'title contains forbidden characters (newline/CR/null byte)' },
    };
  }
  if (typeof body !== 'string') {
    return { ok: false, error: { code: 'VALIDATION', message: 'body must be a string' } };
  }
  if (body.includes('\0')) {
    return { ok: false, error: { code: 'VALIDATION', message: 'body contains null byte' } };
  }
  if (typeof fingerprint !== 'string' || fingerprint.length === 0) {
    return {
      ok: false,
      error: { code: 'VALIDATION', message: 'fingerprint must be a non-empty string' },
    };
  }
  if (typeof labels !== 'string') {
    return { ok: false, error: { code: 'VALIDATION', message: 'labels must be a string' } };
  }
  if (ARG_BOUNDARY_DANGEROUS.test(labels)) {
    return {
      ok: false,
      error: { code: 'VALIDATION', message: 'labels contains forbidden characters' },
    };
  }

  // #389: body-length cap
  const bodyLengthError = checkBodyLength(body);
  if (bodyLengthError) return bodyLengthError;

  const args = ['issue', 'create', '--title', title, '--label', labels, '--description', body];

  if (project !== undefined) {
    if (ARG_BOUNDARY_DANGEROUS.test(project)) {
      return {
        ok: false,
        error: { code: 'VALIDATION', message: 'project contains forbidden characters' },
      };
    }
    args.push('--repo', project);
  }

  if (dryRun) {
    return { ok: true, action: 'create', command: args };
  }

  // Binary is always the allowlisted value — never caller-supplied (ADR-364 §C5 HIGH fix).
  const bin = RECONCILE_ALLOWLISTED_BINS.glab;
  const execFileFn = typeof execFileOpt === 'function' ? execFileOpt : realExecFile;

  try {
    const { stdout } = await execFileFn(bin, args, {
      shell: false,
      timeout: 10_000,
      maxBuffer,
    });
    const iid = parseIidFromGlabOutput(stdout);
    return { ok: true, action: 'create', iid, command: args };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {
        ok: false,
        error: {
          code: 'BINARY_NOT_FOUND',
          message: `Binary '${bin}' not found in PATH`,
        },
      };
    }
    return {
      ok: false,
      error: {
        code: 'EXEC_FAILURE',
        message: `execFile failed: ${err.message}`,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// updateFinding — add a comment to an existing issue (#384)
// ---------------------------------------------------------------------------

/**
 * Add a comment to an existing finding issue.
 *
 * @param {object} opts
 * @param {string} [opts.project] - GitLab project path (--repo)
 * @param {number} opts.iid - issue IID to comment on
 * @param {string} opts.comment - comment body; must not exceed 65536 bytes (#389)
 * @param {boolean} [opts.dryRun=false] - if true, return command without spawning
 * @param {number} [opts.maxBuffer=4194304] - maxBuffer for execFile (4 MB, #389)
 * @param {Function} [opts.execFile] - DI seam for testing; defaults to node:child_process execFile
 * @returns {Promise<
 *   {ok: true, action: 'comment', command?: string[]}
 *   | {ok: false, error: {code: string, message: string}}
 * >}
 */
export async function updateFinding({
  project,
  iid,
  comment,
  dryRun = false,
  maxBuffer = DEFAULT_MAX_BUFFER,
  execFile: execFileOpt,
}) {
  // --- Input validation ---
  if (!Number.isInteger(iid) || iid < 1) {
    return { ok: false, error: { code: 'VALIDATION', message: 'iid must be a positive integer' } };
  }
  if (typeof comment !== 'string' || comment.length === 0) {
    return {
      ok: false,
      error: { code: 'VALIDATION', message: 'comment must be a non-empty string' },
    };
  }
  if (comment.includes('\0')) {
    return { ok: false, error: { code: 'VALIDATION', message: 'comment contains null byte' } };
  }

  // #389: body-length cap (applies to comment body as well)
  const commentLengthError = checkBodyLength(comment);
  if (commentLengthError) return commentLengthError;

  // glab issue note --message <comment> <iid>
  // iid is a number — safe to convert to string; no arg-boundary concerns
  const args = ['issue', 'note', String(iid), '--message', comment];

  if (project !== undefined) {
    if (ARG_BOUNDARY_DANGEROUS.test(project)) {
      return {
        ok: false,
        error: { code: 'VALIDATION', message: 'project contains forbidden characters' },
      };
    }
    args.push('--repo', project);
  }

  if (dryRun) {
    return { ok: true, action: 'comment', command: args };
  }

  // Binary is always the allowlisted value — never caller-supplied (ADR-364 §C5 HIGH fix).
  const bin = RECONCILE_ALLOWLISTED_BINS.glab;
  const execFileFn = typeof execFileOpt === 'function' ? execFileOpt : realExecFile;

  try {
    await execFileFn(bin, args, {
      shell: false,
      timeout: 10_000,
      maxBuffer,
    });
    return { ok: true, action: 'comment', command: args };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {
        ok: false,
        error: {
          code: 'BINARY_NOT_FOUND',
          message: `Binary '${bin}' not found in PATH`,
        },
      };
    }
    return {
      ok: false,
      error: {
        code: 'EXEC_FAILURE',
        message: `execFile failed: ${err.message}`,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// triageDecision — pure decision function (#384)
// ---------------------------------------------------------------------------

/**
 * Pure triage decision: determine the action for a finding given a list of
 * existing issue candidates.
 *
 * Decision logic (in priority order):
 *   1. Any candidate body contains `**Fingerprint:** \`<finding.fingerprint>\``
 *      → { action: 'ignore', target: <iid>, reason: 'fingerprint exact match', confidence: 1.0 }
 *   2. Any candidate title has Levenshtein distance ≤ 2 from finding.title
 *      → { action: 'update', target: <iid>, reason: 'fuzzy title match', confidence: 0.7 }
 *   3. Otherwise
 *      → { action: 'create', reason: 'no match', confidence: 1.0 }
 *
 * This function is intentionally pure (no execFile, fs, or fetch) so it can be
 * tested deterministically without DI.
 *
 * @param {{ fingerprint: string, title: string }} finding
 * @param {Array<{iid: number, title: string, body: string}>} candidates
 * @returns {{ action: 'create'|'update'|'ignore', target?: number, reason: string, confidence: number }}
 */
export function triageDecision(finding, candidates) {
  if (!finding || typeof finding !== 'object') {
    return { action: 'create', reason: 'invalid finding', confidence: 1.0 };
  }
  if (!Array.isArray(candidates)) {
    return { action: 'create', reason: 'no match', confidence: 1.0 };
  }

  const { fingerprint, title } = finding;

  // Pass 1: fingerprint exact match (highest priority)
  if (typeof fingerprint === 'string' && fingerprint.length > 0) {
    for (const candidate of candidates) {
      const candidateFp = extractFingerprintFromBody(candidate.body ?? '');
      if (candidateFp === fingerprint) {
        return {
          action: 'ignore',
          target: candidate.iid,
          reason: 'fingerprint exact match',
          confidence: 1.0,
        };
      }
    }
  }

  // Pass 2: fuzzy title match (Levenshtein ≤ 2)
  if (typeof title === 'string' && title.length > 0) {
    for (const candidate of candidates) {
      const dist = levenshtein(title, candidate.title ?? '');
      if (dist <= 2) {
        return {
          action: 'update',
          target: candidate.iid,
          reason: 'fuzzy title match',
          confidence: 0.7,
        };
      }
    }
  }

  // Pass 3: no match
  return { action: 'create', reason: 'no match', confidence: 1.0 };
}
