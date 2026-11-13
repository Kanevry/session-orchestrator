#!/usr/bin/env node
/**
 * pi-install.mjs — Register Session Orchestrator as a Pi package.
 *
 * Usage:
 *   node scripts/pi-install.mjs [TARGET] [--global] [--settings-only]
 *
 * Default mode writes project-local settings to TARGET/.pi/settings.json and,
 * when the `pi` binary is available, delegates to `pi install <source> -l`.
 * `--settings-only` skips the binary call so CI and fresh machines can validate
 * the package registration path without a global Pi install.
 */

import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { die } from './lib/common.mjs';
import { atomicWriteWithBackup } from './lib/io.mjs';
import { spawnSync } from './lib/native-command.mjs';

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(__filename);
const SO_ROOT = path.dirname(SCRIPT_DIR);

const args = process.argv.slice(2);

if (args.includes('-h') || args.includes('--help')) {
  process.stdout.write(
    [
      'Usage: node scripts/pi-install.mjs [TARGET] [--global] [--settings-only]',
      '',
      'Register Session Orchestrator as a Pi package.',
      '',
      '  TARGET            project to install into (default: the current directory)',
      '  --global          register for the whole host instead of one project',
      '  --settings-only   write settings without calling the `pi` binary',
      '  -h, --help        show this help',
      '',
    ].join('\n')
  );
  process.exit(0);
}

// Unknown flags used to be dropped silently by the `positional` filter below,
// so `--help` fell through to a FULL INSTALL into the current directory and
// reported "Done." — measured 2026-09-13.
const KNOWN_FLAGS = new Set(['--global', '--settings-only']);
const unknownFlag = args.find((arg) => arg.startsWith('-') && !KNOWN_FLAGS.has(arg));
if (unknownFlag) {
  die(`unknown option: ${unknownFlag}. Run with --help for usage.`);
}

const globalMode = args.includes('--global');
const settingsOnly = args.includes('--settings-only');
const positional = args.filter((arg) => !arg.startsWith('-'));
const target = positional[0] ? path.resolve(positional[0]) : process.cwd();
const piAgentHome = process.env.PI_AGENT_HOME
  ? path.resolve(process.env.PI_AGENT_HOME)
  : path.join(os.homedir(), '.pi', 'agent');

function readSettings(filePath) {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (e) {
    die(`Failed to parse ${filePath}: ${e.message}`);
  }
}

function upsertPackage(settings, source) {
  const next = { ...settings };
  const packages = Array.isArray(next.packages) ? [...next.packages] : [];
  const hasSource = packages.some((entry) => {
    if (typeof entry === 'string') return entry === source;
    return entry && typeof entry === 'object' && entry.source === source;
  });
  if (!hasSource) packages.push(source);
  next.packages = packages;
  return next;
}

// GH#88: tmp+rename, so a write that fails after the open leaves the old file
// (and every foreign package entry in it) intact instead of truncated. A
// symlinked settings file, dangling or not, is written through to its target:
// a rename onto the link path would replace the link with a regular file. An
// existing file keeps its permission bits (it may hold other packages'
// credentials); the tmp file is created with them, so there is no wider
// window. Ceiling: the umask still applies at creation, so it can only narrow.
function writeTarget(filePath) {
  let target = filePath;
  for (let hops = 0; hops < 40; hops += 1) {
    let stat;
    try {
      stat = lstatSync(target);
    } catch {
      return target;
    }
    if (!stat.isSymbolicLink()) return target;
    // The kernel resolves a relative link target (`..` included) against the
    // link's REAL directory, not the path it was reached by (GNU stow layouts).
    let linkDir;
    try {
      linkDir = realpathSync(path.dirname(target));
    } catch (e) {
      die(`Cannot resolve the directory of symlink ${target}: ${e.message}`);
    }
    target = path.resolve(linkDir, readlinkSync(target));
  }
  die(`Too many symlink levels resolving ${filePath}`);
}

// `target` comes from writeTarget(), the same resolution the read used, so
// read and write always hit the same file.
function writeSettings(target, settings) {
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : undefined;
  const res = atomicWriteWithBackup(target, JSON.stringify(settings, null, 2) + '\n', {
    tmpPrefix: '.settings.json.tmp',
    mode,
  });
  if (!res.ok) die(`Failed to write ${target}: ${res.error}`);
}

function isDirectory(filePath) {
  try {
    return statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function commandAvailable(command) {
  const lookup = process.platform === 'win32'
    ? spawnSync('where', [command], { stdio: 'ignore' })
    : spawnSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' });
  return lookup.status === 0;
}

const settingsPath = globalMode
  ? path.join(piAgentHome, 'settings.json')
  : path.join(target, '.pi', 'settings.json');
const source = SO_ROOT;

if (!globalMode && !isDirectory(target)) {
  die(`Target project directory does not exist: ${target}`);
}

process.stdout.write('Session Orchestrator — Pi Setup\n');
process.stdout.write('===============================\n');
process.stdout.write('\n');
process.stdout.write(`Source:   ${source}\n`);
process.stdout.write(`Settings: ${settingsPath}\n`);
process.stdout.write(`Scope:    ${globalMode ? 'global' : 'project-local'}\n`);
process.stdout.write('\n');

if (!settingsOnly) {
  if (!commandAvailable('pi')) {
    die('pi is required for install mode. Install @earendil-works/pi-coding-agent or rerun with --settings-only.');
  }
  const piArgs = ['install', source];
  if (!globalMode) piArgs.push('-l');
  const result = spawnSync('pi', piArgs, {
    cwd: target,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const settingsFile = writeTarget(settingsPath);
const settings = upsertPackage(readSettings(settingsFile), source);
writeSettings(settingsFile, settings);

process.stdout.write('Done. Session Orchestrator registered as a Pi package.\n');
process.stdout.write('\n');
process.stdout.write('Next steps:\n');
process.stdout.write('  1. Trust the project in Pi when prompted so project-local package resources can load.\n');
process.stdout.write('  2. Restart or /reload Pi.\n');
process.stdout.write('  3. Use /session deep, /plan feature, /discovery, or /go from the Pi prompt menu.\n');
