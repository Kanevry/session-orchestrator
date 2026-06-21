/**
 * namespace.mjs — Per-project vault namespace resolver (Issue #660).
 *
 * Derives a single-segment, sanitised, leak-guarded directory name that scopes
 * vault writes under `40-learnings/<repoNs>/` and `50-sessions/<repoNs>/`.
 *
 * Contract:
 *   resolveRepoNamespace({ vaultName?, cwd? }) → string
 *
 *   - Pure + deterministic (given the same git remote / cwd / vaultName input).
 *   - Returns a lowercase kebab slug safe for use as a filesystem path segment.
 *   - Redacts owner-privacy leaks (CP1/CP6/CP10) to 'redacted-repo' + stderr WARN.
 *   - Falls back to 'unknown-repo' when slug derivation produces an empty string.
 */

import { deriveRepo } from './process.mjs';
import { subjectToSlug } from './utils.mjs';
import { isOwnerLeakySegment } from '../../lib/validate/check-owner-leakage.mjs';

/**
 * Resolve the sanitised repository namespace segment for vault path scoping.
 *
 * @param {object}  [opts]
 * @param {string|null} [opts.vaultName] - Optional override for the repo identifier.
 *   When non-empty and non-whitespace, used in place of the git-derived repo name.
 *   When absent, the namespace is derived from the git origin via deriveRepo().
 * @returns {string} A single kebab-slug path segment, e.g. 'session-orchestrator'.
 *   Special returns:
 *   - 'unknown-repo'  — slug derivation produced an empty string.
 *   - 'redacted-repo' — the raw or slugified value matched an owner-leakage pattern
 *     (CP1 personal home path / CP6 private slug / CP10 personal name in Projects path).
 */
export function resolveRepoNamespace({ vaultName = null } = {}) {
  // Choose the base identifier: explicit override first, then git-derived.
  const base = (vaultName && typeof vaultName === 'string' && vaultName.trim())
    ? vaultName.trim()
    : deriveRepo();

  // Sanitise: collapse to last path segment, lowercase, strip non-[a-z0-9-].
  const seg = subjectToSlug(base);

  // Leak-guard: check both the raw base AND the sanitised segment.
  // A personal home path or a private project slug must be caught before writing
  // to the vault. We check both forms because:
  //   - CP1 matches the raw base (contains the personal home path prefix)
  //   - CP6/CP10 may match either form depending on how the slug strips context
  const rawMatch = isOwnerLeakySegment(base);
  if (rawMatch !== null) {
    process.stderr.write(
      `WARN vault-mirror/namespace: owner-privacy leak detected in repo identifier (pattern: ${rawMatch}); redacting to 'redacted-repo'\n`,
    );
    return 'redacted-repo';
  }

  const segMatch = isOwnerLeakySegment(seg);
  if (segMatch !== null) {
    process.stderr.write(
      `WARN vault-mirror/namespace: owner-privacy leak detected in sanitised namespace segment (pattern: ${segMatch}); redacting to 'redacted-repo'\n`,
    );
    return 'redacted-repo';
  }

  // Fallback for degenerate inputs (empty slug after sanitisation).
  if (!seg) {
    return 'unknown-repo';
  }

  return seg;
}
