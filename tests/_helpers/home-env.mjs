/**
 * tests/_helpers/home-env.mjs
 *
 * Point `os.homedir()` at a throwaway directory on EVERY platform (#1613).
 *
 * Why HOME alone is not enough: `os.homedir()` reads `$HOME` on POSIX but
 * `%USERPROFILE%` on Windows (libuv `uv_os_homedir`; falls back to the
 * profile API, never to `HOME`). A test that isolates the home by setting only
 * `HOME` therefore reads — and can WRITE — the developer's real
 * `C:\Users\<name>\...` when the suite runs natively on Windows (measured
 * 2026-10-22 on the Windows PC at fd8d3673: telemetry consent, Navigator config
 * and the `~` expansion of vault paths all resolved to the real profile).
 *
 * Setting `USERPROFILE` as well is inert on POSIX: Node never reads it there,
 * so nothing these tests prove on macOS/Linux changes.
 */

import { vi } from 'vitest';

/**
 * Env entries that make a CHILD process resolve `os.homedir()` to `dir`.
 * Spread into a spawn env: `env: { ...process.env, ...homeEnv(tmp) }`.
 *
 * @param {string} dir  The fake home directory.
 * @returns {{ HOME: string, USERPROFILE: string }}
 */
export function homeEnv(dir) {
  return { HOME: dir, USERPROFILE: dir };
}

/**
 * Same as {@link homeEnv}, for the CURRENT process via `vi.stubEnv`, so
 * `vi.unstubAllEnvs()` (or `unstubEnvs: true`) restores both keys.
 *
 * @param {string} dir  The fake home directory.
 */
export function stubHome(dir) {
  vi.stubEnv('HOME', dir);
  vi.stubEnv('USERPROFILE', dir);
}
