/**
 * tests/_helpers/perms.mjs
 *
 * Shared permission-enforcement detection helpers used to guard chmod-readonly
 * tests that are meaningless when the process runs as root (CI runs as root and
 * bypasses file-permission bits, causing write-failure assertions to fail).
 *
 * Two exports:
 *
 *   isRoot — fast check via process.getuid(). True when uid === 0.
 *
 *   permsEnforced() — empirical probe: creates a 0o500 (r-x------) tmp directory,
 *     attempts a write inside it, and returns true when the write was blocked
 *     (i.e., permissions ARE enforced). More robust than isRoot alone because it
 *     also covers perms-ignoring filesystems (e.g., some tmpfs mounts) where
 *     getuid() is non-zero but chmod still has no effect.
 *
 * Usage in test files:
 *
 *   import { isRoot } from '../_helpers/perms.mjs';
 *   it.skipIf(isRoot)('...test that requires chmod write-blocking...', () => { ... });
 *
 *   // Or use the empirical probe for belt-and-suspenders:
 *   import { permsEnforced } from '../_helpers/perms.mjs';
 *   it.skipIf(!permsEnforced())('...', () => { ... });
 *
 * Why this exists:
 *   chmod-readonly tests assert that an operation FAILS (EACCES/EPERM). When the
 *   process is root, file permission bits are bypassed and the operation succeeds,
 *   causing the assertion to fail. Skipping is the honest, low-risk fix: the test
 *   still provides local (non-root) coverage and the skip is self-documenting.
 *
 * Note: This module is test-only. Never import it from production code.
 */

import { mkdtempSync, rmdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * True when the current process is running as root (uid 0).
 * On Windows, process.getuid is undefined — defaults to false.
 */
export const isRoot =
  typeof process.getuid === 'function' && process.getuid() === 0;

/**
 * Empirically probe whether file permission enforcement is active by attempting
 * a write into a 0o500 (r-x------) temporary directory.
 *
 * Returns true  → permissions ARE enforced (write was blocked with EACCES/EPERM).
 * Returns false → permissions are NOT enforced (root bypass or permissive fs).
 *
 * The probe directory is always cleaned up, even on failure.
 */
export function permsEnforced() {
  let probeDir;
  try {
    probeDir = mkdtempSync(join(tmpdir(), 'perms-probe-'));
    chmodSync(probeDir, 0o500);
    try {
      writeFileSync(join(probeDir, 'test.txt'), 'probe', 'utf8');
      // Write succeeded → permissions NOT enforced.
      return false;
    } catch {
      // Write was blocked → permissions ARE enforced.
      return true;
    }
  } catch {
    // Could not even set up the probe — assume permissions not enforced to be safe.
    return false;
  } finally {
    if (probeDir) {
      try {
        chmodSync(probeDir, 0o755);
        rmdirSync(probeDir, { recursive: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}
