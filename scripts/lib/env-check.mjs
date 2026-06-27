/**
 * env-check.mjs — env / runtime checks.
 *
 * Split out of scripts/lib/hardening.mjs (concern A). Pure ESM; no I/O at
 * import time. Re-exported by hardening.mjs as a barrel so existing importers
 * keep working unchanged.
 *
 * Layering: hook-safe — pure functions only; no I/O at import time;
 * ESM-pure for fast hook hot-paths. Hooks (under `hooks/`) import from
 * this lib; this lib MUST NOT reverse-import from `hooks/`. Cross-cutting
 * invariant for all exports below — see #554 A2.
 */

import { resolveProjectDir } from './platform.mjs';

/**
 * Assert that the running Node.js version meets the minimum major version.
 * Throws an Error with a clear message if the current major is below `min`.
 * Returns void on success.
 *
 * @param {number} [min=20]
 * @returns {Promise<void>}
 */
export async function assertNodeVersion(min = 20) {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < min) {
    throw new Error(
      `Node.js ${min}+ is required, but found ${process.versions.node}. ` +
      `Please upgrade Node.js before running session-orchestrator scripts.`
    );
  }
}

/**
 * Check whether a Node module is importable.
 * Returns true on success, false on failure. Does NOT throw.
 *
 * @param {string} name — module name (e.g. "zx")
 * @returns {Promise<boolean>}
 */
export async function assertDepInstalled(name) {
  try {
    await import(name);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run environment checks and return a structured result.
 *
 * Hard checks (ok = false if any fail):
 *   - Node >= 20
 *
 * Soft checks (warning only):
 *   - 'zx' importable
 *   - SO_PROJECT_DIR resolvable (resolveProjectDir returns a non-empty string)
 *
 * @returns {Promise<{ok: boolean, missing: string[], warnings: string[]}>}
 */
export async function checkEnvironment() {
  const missing = [];
  const warnings = [];

  // Hard: Node >= 20
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  if (nodeMajor < 20) {
    missing.push(`node>=20 (found ${process.versions.node})`);
  }

  // Soft: zx installed
  const hasZx = await assertDepInstalled('zx');
  if (!hasZx) {
    warnings.push("'zx' is not installed — run 'npm ci' in the plugin root before executing wave scripts.");
  }

  // Soft: SO_PROJECT_DIR resolvable
  const projectDir = resolveProjectDir();
  if (!projectDir) {
    warnings.push('SO_PROJECT_DIR could not be resolved — wave scripts may not locate the project root correctly.');
  }

  return {
    ok: missing.length === 0,
    missing,
    warnings,
  };
}
