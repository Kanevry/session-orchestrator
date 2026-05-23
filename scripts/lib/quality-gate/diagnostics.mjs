/**
 * scripts/lib/quality-gate/diagnostics.mjs
 *
 * Diagnostics-bundle redaction helpers for the auto-fix loop (#521 + #525).
 * Strips token-shaped strings, secret env-var values, sensitive HTTP headers,
 * and user-path identifiers before persisting the bundle to disk.
 *
 * Extracted from scripts/lib/quality-gate.mjs in #525 to give W4 tests a clean
 * module surface and isolate redaction concerns from gate-runner concerns.
 *
 * @see .claude/rules/quality-gates-autofix.md § Session Config Command Injection
 * @see scripts/lib/quality-gate.mjs (consumer — writes diagnostics bundle)
 */

/**
 * Token-shaped patterns that may appear in diagnostics output (gate command
 * output lines, corrective_context entries, etc.).  Replace each match with a
 * placeholder so bundles are safe to attach to issue trackers or share with
 * support.
 *
 * Ordering: more-specific patterns first (long prefixes before short ones) to
 * prevent partial overlap.
 */
const REDACTION_PATTERNS = [
  [/ghp_[A-Za-z0-9]{36}/g, '***GITHUB_PAT***'],
  [/glpat-[A-Za-z0-9_-]{20,}/g, '***GITLAB_PAT***'],
  [/npm_[A-Za-z0-9]{36,}/g, '***NPM_TOKEN***'],
  [/AKIA[0-9A-Z]{16}/g, '***AWS_ACCESS_KEY***'],
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, '***ANTHROPIC_KEY***'],
  [/sbp_[A-Za-z0-9_-]{40,}/g, '***SUPABASE_TOKEN***'],
  [/sk-[A-Za-z0-9]{40,}/g, '***OPENAI_KEY***'],
  [/xox[bpae]-[A-Za-z0-9-]+/g, '***SLACK_TOKEN***'],
  [/sk_(live|test)_[A-Za-z0-9]{24,}/g, '***STRIPE_KEY***'],
  [/pk_(live|test)_[A-Za-z0-9]{24,}/g, '***STRIPE_PK***'],
  [/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '***JWT***'],
  [/https:\/\/(discord(app)?\.com|hooks\.slack\.com)\/[^\s"']+/g, '***WEBHOOK_URL***'],
  [/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***REDACTED***'],
  [/Authorization:\s*Basic\s+[A-Za-z0-9+/=]+/gi, 'Authorization: Basic ***REDACTED***'],
  [/Cookie:\s*[^\n\r]+/gi, 'Cookie: ***REDACTED***'],
  [/\/Users\/[^/\s"']+\//g, '/Users/<redacted>/'],
  [/\/home\/[^/\s"']+\//g, '/home/<redacted>/'],
];

/**
 * Matches env-var names that are semantically secret-bearing.
 * Keys matching this pattern have their VALUES redacted (the key name is kept
 * so operators can still audit which secret categories were present).
 */
const SECRET_ENV_NAME_RE = /^([A-Z][A-Z0-9_]*(?:_TOKEN|_KEY|_SECRET|_PASSWORD|_CREDENTIAL[A-Z_]*))$/;

/**
 * Redact secrets, env-var values, and user-specific paths from a diagnostics
 * bundle before writing it to disk.
 *
 * Applies two passes:
 *  1. Strip values of env-var keys that match SECRET_ENV_NAME_RE.
 *  2. Serialize the bundle to JSON, apply REDACTION_PATTERNS against the full
 *     JSON string, then parse back.  This catches token-shaped strings nested
 *     anywhere in the object graph (gate output lines, corrective_context
 *     entries, error messages) without requiring a recursive string-walker.
 *
 * Never throws — on any error the original bundle is returned so the write
 * still completes (a partially-unredacted bundle is better than a lost bundle).
 *
 * @param {object} bundle
 * @returns {object}
 */
export function redactDiagnosticsBundle(bundle) {
  try {
    // Deep-clone via JSON round-trip so we never mutate the caller's object.
    const copy = JSON.parse(JSON.stringify(bundle ?? {}));

    // Pass 1 — redact secret-bearing env-var values.
    if (copy.env && typeof copy.env === 'object') {
      for (const key of Object.keys(copy.env)) {
        if (SECRET_ENV_NAME_RE.test(key)) {
          copy.env[key] = '***REDACTED***';
        }
      }
    }

    // Pass 2 — regex-replace token/path patterns over the full JSON string.
    let serialized = JSON.stringify(copy);
    for (const [re, replacement] of REDACTION_PATTERNS) {
      serialized = serialized.replace(re, replacement);
    }
    return JSON.parse(serialized);
  } catch {
    // Return unredacted rather than losing the bundle entirely.
    return bundle ?? {};
  }
}
