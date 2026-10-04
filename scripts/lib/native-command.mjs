/** Shell-free command launching for native Windows and Unix hosts. */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Windows cannot spawn npm's .cmd shim without cmd.exe. Run its JavaScript
 * entrypoint with this Node instead, preserving each argument literally.
 * Supports Node's bundled npm (including nvm-windows) and npm on PATH.
 * Other commands and Unix retain their normal executable lookup.
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} [context] Host overrides for platform regression tests.
 * @returns {{cmd: string, args: string[]}}
 */
export function resolveNativeCommand(cmd, args, {
  platform = process.platform, execPath = process.execPath, env = process.env, exists = existsSync,
} = {}) {
  if (platform !== 'win32' || !/^npm(?:\.cmd)?$/i.test(cmd)) return { cmd, args };
  const winPath = path.win32;
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path');
  const dirs = [winPath.dirname(execPath), ...(env[pathKey] || '').split(';')];
  for (const dir of dirs) {
    // Ignore empty/relative PATH entries: never select npm from the working repo.
    const absolute = dir.replace(/^"(.*)"$/, '$1');
    if (!winPath.isAbsolute(absolute)) continue;
    const cli = winPath.join(absolute, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (exists(cli)) return { cmd: execPath, args: [cli, ...args] };
  }
  throw Object.assign(new Error('Cannot locate npm-cli.js beside Node or on PATH; install npm with Node.js.'), { code: 'ENOENT' });
}

/** Like spawnSync, with shell-free Windows npm support and spawn-style errors. */
export function spawnNativeSync(cmd, args, options = {}) {
  try {
    const command = resolveNativeCommand(cmd, args, { env: options.env ?? process.env });
    return spawnSync(command.cmd, command.args, { ...options, shell: false });
  } catch (error) {
    return { error, status: null, stdout: '', stderr: '' };
  }
}

/** Test for a command using the host's executable locator, without a shell. */
export function commandOnPath(bin) {
  return spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [bin], {
    encoding: 'utf8', timeout: 10_000, shell: false,
  }).status === 0;
}
