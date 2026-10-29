import { existsSync as fileExistsSync } from 'node:fs';
import { win32 as path } from 'node:path';
import { $, quote } from 'zx';
import { isTrustedPathEntry, resolveGitBash } from './program-lookup.mjs';

export * from 'zx';

// Windows 11 / Node 24.14 / zx 8.8.5 / Git 2.55, measured 2026-10-14:
// MSYS halves backslashes in Node's -c command line before bash interprets
// ANSI-C quoting (\b becomes backspace, \r CR). Doubling zx's escapes gave
// 14/14 exact argument roundtrips, versus 10/14 with stock quote (#1612).
// Always start from stock quote, so repeated configuration cannot stack escapes.
const quoteGitBash = (arg) => quote(arg).replace(/\\/g, '\\\\');

/**
 * Configure the zx singleton; injection also permits Windows checks on POSIX.
 * zx picks its default shell with `which`, which on Windows also searches the
 * current directory, so a bash.exe inside the working repo would become the
 * shell. Such a shell — in the working directory, relative, or under
 * node_modules — and zx's `shell: true` fallback (cmd.exe) are replaced like
 * an empty or WSL one; without Git Bash they are cleared rather than kept
 * (#1864). A shell selected elsewhere stays.
 */
export function configureZx({
  platform = process.platform,
  existsSync = fileExistsSync,
  target = $,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  if (platform !== 'win32') return;

  const shell = typeof target.shell === 'string' ? path.normalize(target.shell) : '';
  const wsl = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'bash.exe');
  // zx keeps its default `shell: true` (cmd.exe through Node, with zx's own
  // spawn and no NoDefaultCurrentDirectoryInExePath) when `which` finds no bash.
  const untrusted = target.shell === true || (shell !== '' && !isTrustedPathEntry(path.dirname(shell), cwd));
  if (!target.shell || shell.toLowerCase() === wsl.toLowerCase() || untrusted) {
    let bash;
    try {
      bash = resolveGitBash({ platform, env, exists: existsSync, cwd });
    } catch {
      // No Git Bash: an empty or WSL shell stays as it was; a shell from the repo never runs.
      if (untrusted) target.shell = '';
      return;
    }
    target.shell = bash;
  }

  if (typeof target.shell === 'string' &&
      /\\(?:Git\\bin|usr\\bin)\\bash\.exe$/i.test(path.normalize(target.shell))) {
    target.quote = quoteGitBash;
  }
}

configureZx();
