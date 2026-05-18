/**
 * discovery-helpers.mjs — Shared utilities for /discovery and /test --since filtering.
 *
 * Pure ESM, Node stdlib only. No shell injection: uses execFile throughout.
 *
 * Exports:
 *   changedFilesSince(ref) → Promise<string[]>
 *
 * Part of the Clawpatch Borrow Cluster (issue #420).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

/**
 * Characters that should never appear in a git ref passed to execFile args.
 *
 * NOTE — layered defence: `execFile` is the primary injection guard (it passes
 * args directly to the OS without invoking a shell, so none of these characters
 * can trigger shell interpretation).  This regex is a secondary sanity-check
 * that catches clearly-malformed refs early, before the process is spawned, and
 * provides a human-readable error message.  Do NOT rely on this regex as the
 * sole injection barrier.
 *
 * Includes `\n` and `\r` to reject pathological env-injected refs that contain
 * embedded newlines (can occur in certain CI variable-expansion scenarios).
 *
 * @type {RegExp}
 */
const UNSAFE_REF_CHARS = /[;|&`$<>\\\n\r]/;

/**
 * Validate that `ref` does not contain shell-injection-relevant characters.
 * Throws a TypeError if the ref is invalid.
 *
 * @param {string} ref
 */
function validateRef(ref) {
  if (UNSAFE_REF_CHARS.test(ref)) {
    throw new TypeError(
      `Invalid ref '${ref}': contains shell-unsafe characters (;|&\`$<>\\, newlines). ` +
        `Use a plain git ref like HEAD~3, a commit hash, or a branch name.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the list of files changed between `ref` and HEAD.
 *
 * Resolution:
 *   1. Validates the ref with git rev-parse (confirms it is resolvable).
 *   2. Runs git diff --name-only <ref>..HEAD.
 *   3. Returns sorted, de-duplicated relative paths (no leading ./ or /).
 *
 * Empty result (no files changed) → returns [] — the CALLER decides whether
 * to skip or proceed with a full scan.
 *
 * @param {string} ref - Git ref (commit hash, branch name, tag, HEAD~N, …).
 * @returns {Promise<string[]>} Sorted array of relative file paths.
 * @throws {Error} If the ref cannot be resolved or git is unavailable.
 */
export async function changedFilesSince(ref) {
  if (!ref || typeof ref !== 'string' || !ref.trim()) {
    throw new TypeError(`changedFilesSince: ref must be a non-empty string, got: ${JSON.stringify(ref)}`);
  }

  const trimmedRef = ref.trim();
  validateRef(trimmedRef);

  // Step 1: verify the ref is resolvable.
  try {
    await execFileAsync('git', ['rev-parse', '--verify', trimmedRef], {
      encoding: 'utf8',
      // No shell — args are passed directly to git.
    });
  } catch (err) {
    const detail = err.stderr ? err.stderr.trim() : String(err);
    throw new Error(
      `Cannot resolve ref '${trimmedRef}'. Common causes: shallow clone ` +
        `(run 'git fetch --unshallow'), local-only refs that have not been ` +
        `fetched, or a typo. Use HEAD~N or 'git log --oneline' to list ` +
        `available refs. Original error: ${detail}`,
      { cause: err },
    );
  }

  // Step 2: compute changed files.
  let rawOutput;
  try {
    const result = await execFileAsync('git', ['diff', '--name-only', `${trimmedRef}..HEAD`], {
      encoding: 'utf8',
    });
    rawOutput = result.stdout ?? result;
  } catch (err) {
    // A non-zero exit from git diff --name-only is unusual (the ref already
    // validated above) but surface as a clear error.
    const detail = err.stderr ? err.stderr.trim() : String(err);
    throw new Error(
      `git diff --name-only ${trimmedRef}..HEAD failed: ${detail}`,
      { cause: err },
    );
  }

  // Step 3: normalise paths.
  const paths = String(rawOutput)
    .split('\n')
    .map((p) => p.trim())
    // Remove empty lines (trailing newline, etc.).
    .filter(Boolean)
    // Strip leading ./ if somehow present.
    .map((p) => (p.startsWith('./') ? p.slice(2) : p))
    // Strip leading / if somehow present (safety net).
    .map((p) => (p.startsWith('/') ? p.slice(1) : p));

  // Deduplicate + sort alphabetically.
  return [...new Set(paths)].sort();
}
