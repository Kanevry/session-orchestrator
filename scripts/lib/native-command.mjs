/** Shell-free command launching for native Windows and Unix hosts. */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
// Namespace import, read at call time: a test's partial vi.mock factory for
// node:child_process then still imports cleanly, and every call reaches the
// mocked function that is current when the call happens.
import * as childProcess from 'node:child_process';
import { isTrustedPathEntry, pathEntries, resolveExecutable, resolveGitBash } from './program-lookup.mjs';

export { resolveExecutable, resolveGitBash };

const winPath = path.win32;

/**
 * Windows cannot spawn npm's .cmd shim without cmd.exe. Run its JavaScript
 * entrypoint with this Node instead, preserving each argument literally.
 * Supports Node's bundled npm (including nvm-windows) and npm on PATH.
 * Every other bare name on Windows resolves through `resolveExecutable`;
 * Unix returns `{cmd, args}` unchanged.
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} [context] Host overrides for platform regression tests.
 * @returns {{cmd: string, args: string[]}}
 */
export function resolveNativeCommand(cmd, args, {
  platform = process.platform, execPath = process.execPath, env = process.env, exists = existsSync, cwd = process.cwd(),
} = {}) {
  if (platform !== 'win32') return { cmd, args };
  if (!/^npm(?:\.cmd)?$/i.test(cmd)) return { cmd: resolveExecutable(cmd, { platform, env, cwd, exists }), args };
  // Node's own directory first, then PATH entries under the same filters as
  // resolveExecutable: never select npm from the working repo or a dependency.
  const pathDirs = pathEntries(env).filter((dir) => isTrustedPathEntry(dir, cwd));
  for (const dir of [winPath.dirname(execPath), ...pathDirs]) {
    if (!winPath.isAbsolute(dir)) continue;
    const cli = winPath.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (exists(cli)) return { cmd: execPath, args: [cli, ...args] };
  }
  throw Object.assign(new Error('Cannot locate npm-cli.js beside Node or on PATH; install npm with Node.js.'), { code: 'ENOENT' });
}

/** The working directory a spawn will use, as a path string (Node also accepts a file: URL). */
function spawnCwd(options) {
  const cwd = options?.cwd;
  if (cwd instanceof URL) return fileURLToPath(cwd);
  return typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd();
}

/** Like spawnSync, with shell-free Windows npm support and spawn-style errors. */
export function spawnNativeSync(cmd, args, options = {}) {
  try {
    const command = resolveNativeCommand(cmd, args, { env: options.env ?? process.env, cwd: spawnCwd(options) });
    return childProcess.spawnSync(command.cmd, command.args, { ...options, shell: false });
  } catch (error) {
    return { error, status: null, stdout: '', stderr: '' };
  }
}

/**
 * Test for a command using the host's executable locator, without a shell.
 * Windows runs where.exe by its absolute System32 path: a bare `where.exe`
 * resolves the current directory first, so a copy planted in the working repo
 * would run (NoDefaultCurrentDirectoryInExePath does not prevent that).
 * @param {string} bin
 * @param {{platform?: string, spawn?: typeof childProcess.spawnSync, env?: NodeJS.ProcessEnv}} [context] Host overrides for platform regression tests.
 * @returns {boolean}
 */
export function commandOnPath(bin, { platform = process.platform, spawn = childProcess.spawnSync, env = process.env } = {}) {
  let locator = 'which';
  if (platform === 'win32') {
    const systemRoot = env.SystemRoot || env.windir || 'C:\\Windows';
    // Fail closed ("not found") rather than spawn a name the cwd could shadow.
    if (!path.win32.isAbsolute(systemRoot)) return false;
    locator = path.win32.join(systemRoot, 'System32', 'where.exe');
  }
  return spawn(locator, [bin], {
    encoding: 'utf8', timeout: 10_000, shell: false,
  }).status === 0;
}

// ---------------------------------------------------------------------------
// Drop-in replacements for node:child_process. Unix passes every call through
// with the same argument objects. Windows resolves the program of a non-shell
// call through `resolveNativeCommand`, and gives every shell call
// NoDefaultCurrentDirectoryInExePath=1 (cmd.exe honours it; Node's own
// program search does not).
// ---------------------------------------------------------------------------

/**
 * Stand-in program for a name that did not resolve. `?` cannot occur in a
 * Windows file name, so this absolute path never exists: libuv fails it with
 * ENOENT before creating a process, and the caller receives Node's own failure
 * through Node's own channel (result object, throw, 'error' event, callback),
 * with its own event order and stdio streams. Relabelling restores the name
 * the caller passed. Building a ChildProcess by hand would have to replicate
 * the stdio streams and the 'error' then 'close' sequence for every option.
 */
const UNRESOLVED = 'C:\\?\\unresolved-program';

const onWindows = () => process.platform === 'win32';

/** Replace the stand-in with the caller's program name in a spawn error. */
function relabel(error, file) {
  if (!error || typeof error !== 'object') return error;
  for (const key of ['message', 'stack', 'syscall', 'path', 'cmd']) {
    if (typeof error[key] === 'string') error[key] = error[key].replaceAll(UNRESOLVED, file);
  }
  return error;
}

/** Options for a shell call on Windows: a copy whose env sets NoDefaultCurrentDirectoryInExePath. */
function shellOptions(options) {
  return { ...options, env: { ...(options?.env ?? process.env), NoDefaultCurrentDirectoryInExePath: '1' } };
}

/** Node's optional-position handling for (file, [args], [options], [callback]). */
function normalizeFileArgs(args, options, callback) {
  if (typeof args === 'function') return { args: [], options: undefined, callback: args };
  if (args !== null && typeof args === 'object' && !Array.isArray(args)) [args, options, callback] = [[], args, options];
  if (typeof options === 'function') [options, callback] = [undefined, options];
  return { args: args ?? [], options, callback };
}

/** Run `fn` for a non-shell or shell call on Windows; see the section comment. */
function launchOnWindows(fn, file, rawArgs, { nullOptionsInvalid = false } = {}) {
  const { args, options, callback } = normalizeFileArgs(...rawArgs);
  // Input Node itself rejects reaches it unchanged, so its own validation
  // throws: a non-string, empty or NUL-containing program, and null options
  // for spawn/spawnSync.
  // Everything Node accepts (null args, null execFile options) is resolved.
  if (typeof file !== 'string' || file === '' || file.includes('\0') || (nullOptionsInvalid && options === null)) return fn(file, ...rawArgs);
  const tail = callback ? [callback] : [];
  if (options?.shell) return fn(file, args, shellOptions(options), ...tail);
  let command;
  try {
    command = resolveNativeCommand(file, args, { env: options?.env ?? process.env, cwd: spawnCwd(options) });
  } catch {
    return launchUnresolved(fn, file, args, options, callback);
  }
  return fn(command.cmd, command.args, options, ...tail);
}

/** Deliver ENOENT for `file` through `fn`'s own channel without starting `file`. */
function launchUnresolved(fn, file, args, options, callback) {
  const tail = callback ? [(error, ...output) => callback(relabel(error, file), ...output)] : [];
  let result;
  try {
    result = fn(UNRESOLVED, args, { ...options, shell: false }, ...tail);
  } catch (error) {
    throw relabel(error, file);
  }
  if (result && typeof result.emit === 'function') {
    result.spawnfile = file;
    if (Array.isArray(result.spawnargs)) result.spawnargs = [file, ...result.spawnargs.slice(1)];
    // Relabel inside emit: an added 'error' listener would hide an unhandled error.
    const emit = result.emit;
    result.emit = function relabelledEmit(event, ...rest) {
      if (event === 'error') relabel(rest[0], file);
      return emit.call(this, event, ...rest);
    };
  } else if (result?.error) {
    relabel(result.error, file);
  }
  return result;
}

/** Give a callback-style exec function Node's promisified shape: resolve {stdout, stderr}, reject with both attached, `.child` set. */
function withPromisify(fn) {
  Object.defineProperty(fn, promisify.custom, {
    value: (...argv) => {
      let child;
      const promise = new Promise((resolve, reject) => {
        child = fn(...argv, (error, stdout, stderr) => (
          error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr })));
      });
      promise.child = child;
      return promise;
    },
  });
  return fn;
}

/**
 * Drop-in for `child_process.spawnSync(file, [args], [options])`.
 * Windows: an unresolvable program returns Node's ENOENT result object.
 * @param {...unknown} argv
 * @returns {import('node:child_process').SpawnSyncReturns<string | Buffer>}
 */
export function spawnSync(...argv) {
  if (!onWindows()) return childProcess.spawnSync(...argv);
  return launchOnWindows(childProcess.spawnSync, argv[0], argv.slice(1), { nullOptionsInvalid: true });
}

/**
 * Drop-in for `child_process.spawn(file, [args], [options])`.
 * Windows: an unresolvable program yields a ChildProcess that emits 'error' (ENOENT) asynchronously.
 * @param {...unknown} argv
 * @returns {import('node:child_process').ChildProcess}
 */
export function spawn(...argv) {
  if (!onWindows()) return childProcess.spawn(...argv);
  return launchOnWindows(childProcess.spawn, argv[0], argv.slice(1), { nullOptionsInvalid: true });
}

/**
 * Drop-in for `child_process.execFileSync(file, [args], [options])`.
 * Windows: an unresolvable program throws Node's ENOENT error.
 * @param {...unknown} argv
 * @returns {string | Buffer}
 */
export function execFileSync(...argv) {
  if (!onWindows()) return childProcess.execFileSync(...argv);
  return launchOnWindows(childProcess.execFileSync, argv[0], argv.slice(1));
}

/**
 * Drop-in for `child_process.execFile(file, [args], [options], [callback])`,
 * including `util.promisify` support. Windows: an unresolvable program calls
 * back with ENOENT asynchronously.
 * @param {...unknown} argv
 * @returns {import('node:child_process').ChildProcess}
 */
export const execFile = withPromisify(function execFile(...argv) {
  if (!onWindows()) return childProcess.execFile(...argv);
  return launchOnWindows(childProcess.execFile, argv[0], argv.slice(1));
});

/**
 * Drop-in for `child_process.execSync(command, [options])`.
 * @param {...unknown} argv
 * @returns {string | Buffer}
 */
export function execSync(...argv) {
  if (!onWindows()) return childProcess.execSync(...argv);
  return childProcess.execSync(argv[0], shellOptions(argv[1]));
}

/**
 * Drop-in for `child_process.exec(command, [options], [callback])`, including `util.promisify` support.
 * @param {...unknown} argv
 * @returns {import('node:child_process').ChildProcess}
 */
export const exec = withPromisify(function exec(...argv) {
  if (!onWindows()) return childProcess.exec(...argv);
  const [command] = argv;
  let [, options, callback] = argv;
  if (typeof options === 'function') [options, callback] = [undefined, options];
  return childProcess.exec(command, shellOptions(options), ...(callback ? [callback] : []));
});
