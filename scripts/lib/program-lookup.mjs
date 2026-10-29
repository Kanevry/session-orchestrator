/**
 * Locate Windows programs through absolute PATH entries only. No process is
 * started here and node:child_process is not imported, so modules that must
 * stay free of it (scripts/lib/zx.mjs, loaded by a vitest setup file) can use
 * the lookup too. scripts/lib/native-command.mjs re-exports both functions.
 */
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

const winPath = path.win32;

/** A PATH entry inside a dependency tree (`npm run` prepends `<repo>\node_modules\.bin`). */
export const NODE_MODULES_SEGMENT = /(^|[\\/])node_modules([\\/]|$)/i;

/**
 * Case-insensitive Windows containment: is `file` at or below `dir`?
 * @param {string} dir
 * @param {string} file
 * @returns {boolean}
 */
function withinDirectory(dir, file) {
  const rel = winPath.relative(winPath.normalize(dir).toLowerCase(), winPath.normalize(file).toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !winPath.isAbsolute(rel));
}

/**
 * PATH entries (key matched case-insensitively), surrounding double quotes stripped.
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]}
 */
export function pathEntries(env) {
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path');
  return (env[pathKey] || '').split(';').map((entry) => entry.replace(/^"(.*)"$/, '$1'));
}

/** Drive-letter (`C:\`) or UNC (`\\server\share`) path; `\x` and `C:x` depend on the current drive or directory. */
const FULLY_QUALIFIED = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/?.])/;

/**
 * Comparable form of a Windows directory: normalized, lower-case, without a
 * trailing separator, and with the trailing dots and spaces Windows drops
 * from every path component removed (`C:\repo.\` names `C:\repo`).
 * @param {string} dir
 * @returns {string}
 */
function comparableDir(dir) {
  // A `\\?\` or `\\.\` device prefix names the same directory as the plain
  // path; `\\?\UNC\server\share` is `\\server\share`.
  let resolved = dir.replace(/^[\\/]{2}[?.][\\/]UNC[\\/]/i, '\\\\').replace(/^[\\/]{2}[?.][\\/]/, '');
  // An 8.3 short name (`C:\REPO~1`) is another spelling of a long name; ask the filesystem.
  if (resolved.includes('~')) {
    try { resolved = realpathSync.native(resolved); } catch { /* keep the spelling as given */ }
  }
  return winPath.normalize(resolved).replace(/[. ]+(?=[\\/]|$)/g, '').replace(/[\\/]+$/, '').toLowerCase();
}

/**
 * Whether a PATH entry may supply a program: fully qualified (drive or UNC,
 * never a `\\?\` or `\\.\` device path), neither the spawn's working directory
 * nor this process's own one, and not inside a node_modules tree.
 * Only those directories themselves are excluded, because the working
 * directory is the one Windows searches implicitly; entries below them stay
 * usable, so a session started in the home directory still finds per-user
 * installs. Ceilings: an entry that names the working directory through a
 * junction or symlink is not recognised (only 8.3 names are resolved), and
 * entries the user put below the repository (an activated in-repo venv's
 * Scripts\, direnv) are trusted like the user's own shell trusts them.
 * Revisit if PATH entries ever come from repository content.
 * @param {string} dir
 * @param {string} cwd
 * @param {string} [processCwd]
 * @returns {boolean}
 */
export function isTrustedPathEntry(dir, cwd, processCwd = process.cwd()) {
  if (!FULLY_QUALIFIED.test(dir)) return false;
  const entry = comparableDir(dir);
  // A relative spawn cwd is relative to this process's working directory.
  const spawnDir = winPath.resolve(processCwd, cwd);
  return entry !== comparableDir(spawnDir) && entry !== comparableDir(processCwd) && !NODE_MODULES_SEGMENT.test(entry);
}

/**
 * Resolve a bare program name to an absolute file on Windows, through PATH
 * entries that `isTrustedPathEntry` accepts. Node's spawn on Windows searches
 * the spawn's working directory before PATH for a bare name; resolving here
 * first means only PATH programs run. Skips entries without a drive or UNC
 * root, the working directory itself and any `node_modules` entry (`npm run`
 * prepends `<repo>\node_modules\.bin`).
 * Candidates per entry follow libuv: a name with an extension is tried as
 * given, then with `.com` and `.exe` appended; a name without one only with
 * `.com`, then `.exe`. Unix, and names carrying a directory or drive, are
 * returned unchanged.
 * @param {string} name
 * @param {{platform?: string, env?: NodeJS.ProcessEnv, cwd?: string, exists?: (file: string) => boolean}} [context]
 * @returns {string}
 * @throws {Error} code ENOENT when no entry holds the program; the message carries no host path.
 */
export function resolveExecutable(name, {
  platform = process.platform, env = process.env, cwd = process.cwd(), exists = existsSync,
} = {}) {
  if (platform !== 'win32' || /[\\/:]/.test(name) || winPath.isAbsolute(name)) return name;
  const candidates = winPath.extname(name) ? [name, `${name}.com`, `${name}.exe`] : [`${name}.com`, `${name}.exe`];
  for (const dir of pathEntries(env)) {
    if (!isTrustedPathEntry(dir, cwd)) continue;
    for (const candidate of candidates) {
      const file = winPath.join(dir, candidate);
      if (exists(file)) return file;
    }
  }
  throw Object.assign(new Error(`Cannot locate "${name}" on a PATH entry other than the working directory.`), { code: 'ENOENT' });
}

/**
 * The bash that runs a `bash -c` script. Unix keeps the PATH lookup of `bash`.
 * Windows needs Git Bash: outside a Git Bash session, `bash` on PATH is
 * System32\bash.exe, the WSL launcher, which runs the script inside a Linux
 * distribution (or not at all). Lookup order: Git under ProgramFiles /
 * ProgramFiles(x86), then beside an absolute `git.exe` on PATH: the Git root
 * candidates `..` and `..\..` of its directory (installer `cmd\`, portable
 * `mingw64\bin\`), each probed for `bin\bash.exe`, then `usr\bin\bash.exe`.
 * Throws (code ENOENT) when none exists — never falls back to WSL and never
 * returns a path under System32.
 * The error message carries no host path, so callers may surface it verbatim.
 * @param {{platform?: string, env?: NodeJS.ProcessEnv, exists?: (file: string) => boolean, cwd?: string}} [context]
 * @returns {string}
 */
export function resolveGitBash({
  platform = process.platform, env = process.env, exists = existsSync, cwd = process.cwd(),
} = {}) {
  if (platform !== 'win32') return 'bash';
  const system32 = winPath.join(env.SystemRoot || 'C:\\Windows', 'System32');
  // The bash.exe itself must sit in a trusted directory too: a trusted git.exe
  // directory does not vouch for a sibling bin\ that is the working directory.
  const usable = (file) => !withinDirectory(system32, file) && isTrustedPathEntry(winPath.dirname(file), cwd) && exists(file);
  for (const dir of [env.ProgramFiles, env['ProgramFiles(x86)']]) {
    if (!dir || !winPath.isAbsolute(dir)) continue;
    const candidate = winPath.join(dir, 'Git', 'bin', 'bash.exe');
    if (usable(candidate)) return candidate;
  }
  for (const dir of pathEntries(env)) {
    // Same filter as resolveExecutable, so the working directory or a
    // dependency cannot supply the git.exe + bash.exe pair.
    if (!isTrustedPathEntry(dir, cwd)) continue;
    if (!exists(winPath.join(dir, 'git.exe'))) continue;
    for (const root of [winPath.resolve(dir, '..'), winPath.resolve(dir, '..', '..')]) {
      for (const candidate of [winPath.join(root, 'bin', 'bash.exe'), winPath.join(root, 'usr', 'bin', 'bash.exe')]) {
        if (usable(candidate)) return candidate;
      }
    }
  }
  throw Object.assign(new Error('Cannot locate Git Bash (Git for Windows); the WSL bash.exe is never used. Install Git for Windows.'), { code: 'ENOENT' });
}
