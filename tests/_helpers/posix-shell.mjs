/**
 * tests/_helpers/posix-shell.mjs — the POSIX shell a test spawns, on every platform.
 *
 * Tests that run `sh` or `bash` (husky hooks, script blocks extracted from a
 * skill, hook launchers) cannot rely on PATH on native Windows. Measured
 * 2026-10-22 on the Windows 11 test PC (`where sh & where bash`, SO#1613):
 * `sh` is not on PATH, and `bash` resolves to C:\Windows\System32\bash.exe,
 * which is WSL and cannot see Windows paths. Claude Code on Windows runs hooks
 * through Git Bash, so a test gets that interpreter: `<Git>\bin\sh.exe` or
 * `<Git>\bin\bash.exe`. These two are the wrappers that put /mingw64/bin and
 * /usr/bin first on PATH, so grep and sed resolve inside the script (measured
 * the same day: `command -v grep` → /usr/bin/grep).
 *
 * The lookup is the product's own: configureZx() from scripts/lib/zx.mjs, run
 * against a throwaway target so the zx singleton stays untouched.
 *
 * Limit of the Git launcher (measured 2026-10-22, SO#1613 wave 2): `bin\bash.exe`
 * cut a 9024-byte `-c` argument to 8254 bytes ("unexpected EOF while looking for
 * matching `}'"). Pass a long script as a temp file, not inline with `-c`.
 *
 * Off Windows every name is returned unchanged, so `'sh'`, `'/bin/sh'`,
 * `'bash'` and `'/bin/bash'` keep exactly the behaviour they had before.
 */

import { win32 } from 'node:path';
import { configureZx } from '../../scripts/lib/zx.mjs';

/** Directory holding Git Bash's sh.exe and bash.exe on win32, else null. */
function resolveGitBin() {
  if (process.platform !== 'win32') return null;
  const target = {};
  configureZx({ target });
  return typeof target.shell === 'string' ? win32.dirname(target.shell) : null;
}

const GIT_BIN = resolveGitBin();

/**
 * The executable to spawn for a POSIX shell.
 *
 * @param {'sh' | 'bash' | '/bin/sh' | '/bin/bash'} [name='sh'] what the test spawned before.
 * @returns {string} `name` unchanged off Windows; on Windows the Git Bash
 *   executable of the same basename, or `name` unchanged when Git Bash is absent
 *   (the spawn then fails exactly as before, which names the missing shell).
 */
export function posixShell(name = 'sh') {
  if (process.platform !== 'win32' || GIT_BIN === null) return name;
  const base = name.split('/').pop() === 'bash' ? 'bash' : 'sh';
  return win32.join(GIT_BIN, `${base}.exe`);
}
