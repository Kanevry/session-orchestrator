import { existsSync as fileExistsSync } from 'node:fs';
import { win32 as path } from 'node:path';
import { $, quote } from 'zx';

export * from 'zx';

// Windows 11 / Node 24.14 / zx 8.8.5 / Git 2.55, measured 2026-10-14:
// MSYS halves backslashes in Node's -c command line before bash interprets
// ANSI-C quoting (\b becomes backspace, \r CR). Doubling zx's escapes gave
// 14/14 exact argument roundtrips, versus 10/14 with stock quote (#1612).
// Always start from stock quote, so repeated configuration cannot stack escapes.
const quoteGitBash = (arg) => quote(arg).replace(/\\/g, '\\\\');

/** Configure the zx singleton; injection also permits Windows checks on POSIX. */
export function configureZx({
  platform = process.platform,
  existsSync = fileExistsSync,
  target = $,
  env = process.env,
} = {}) {
  if (platform !== 'win32') return;

  const shell = typeof target.shell === 'string' ? path.normalize(target.shell) : '';
  const wsl = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'bash.exe');
  if (!target.shell || shell.toLowerCase() === wsl.toLowerCase()) {
    const candidates = [env.ProgramFiles, env['ProgramFiles(x86)']]
      .filter(Boolean).map(dir => path.join(dir, 'Git', 'bin', 'bash.exe'));
    let bash = candidates.find(candidate => existsSync(candidate));
    if (!bash) {
      for (const dir of (env.PATH || '').split(';').filter(Boolean)) {
        const gitDir = dir.replace(/^"|"$/g, '');
        if (!existsSync(path.join(gitDir, 'git.exe'))) continue;
        const candidate = path.resolve(gitDir, '..', 'bin', 'bash.exe');
        if (existsSync(candidate)) {
          bash = candidate;
          break;
        }
      }
    }
    if (!bash) return;
    target.shell = bash;
  }

  if (typeof target.shell === 'string' &&
      /\\(?:Git\\bin|usr\\bin)\\bash\.exe$/i.test(path.normalize(target.shell))) {
    target.quote = quoteGitBash;
  }
}

configureZx();
