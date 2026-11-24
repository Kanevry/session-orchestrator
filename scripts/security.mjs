#!/usr/bin/env node
/**
 * security.mjs — read-only `/security` CLI (#2201).
 *
 * Dispatches one mode module `./lib/security/<mode>.mjs` (contract:
 * `./lib/security/contract.mjs`) and prints its Result. The CLI only reads: it
 * writes no file and emits no event — the skill layer does that.
 */
import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { isMainModule } from './lib/is-main-module.mjs';
import { execFileSync } from './lib/native-command.mjs';
import { MODES, renderText, resultProblem } from './lib/security/contract.mjs';

const PREFIX = 'security:';
const EXIT_DEGRADED = 1;
const EXIT_USAGE = 2;
const MODULE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'lib', 'security');

// Literal specifiers (not a computed path) so the repo's reachability census
// sees every mode module as reached from this CLI. Keys must equal MODES.
const LOADERS = {
  status: () => import('./lib/security/status.mjs'),
  deps: () => import('./lib/security/deps.mjs'),
  posture: () => import('./lib/security/posture.mjs'),
  'agent-setup': () => import('./lib/security/agent-setup.mjs'),
};

const HELP = [
  'Usage: security.mjs [--mode <mode>] [--ref <commit>] [--json] [--repo-root <abs path>]',
  '',
  'Read-only security overview of a repository. Writes no file and emits no event.',
  '',
  'Modes:',
  '  status        which security mechanisms run in this repo (default)',
  '  deps          advisories of every lockfile, ranked fix now / can wait / not reachable',
  '  posture       package-manager and supply-chain settings against expected values',
  '  agent-setup   agent configuration: endpoint overrides, approvals off, wildcards, …',
  '',
  'Options:',
  `  --mode <m>          one of ${MODES.join('|')} (default status)`,
  '  --ref <commit>      judge this commit instead of the default (must not start with -)',
  '  --json              print exactly one JSON document on stdout',
  '  --repo-root <path>  absolute repository root (default: current directory)',
  '  -h, --help          show this help',
  '',
  'Exit codes:',
  '  0  status ok, findings or skipped',
  '  1  status degraded (the mode could not do its job)',
  '  2  usage error (unknown mode or flag, bad --ref, mode not available in this build)',
  '     or the mode crashed / returned a malformed result',
  '',
  'Example:',
  '  node scripts/security.mjs --mode status --json',
].join('\n');

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * @param {string[]} argv
 * @returns {{help: true} | {help: false, mode: string, ref: string|null, json: boolean, repoRoot: string}}
 */
function parseCli(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        mode: { type: 'string' },
        ref: { type: 'string' },
        json: { type: 'boolean', default: false },
        'repo-root': { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  if (values.help) return { help: true };
  const mode = values.mode ?? 'status';
  if (!MODES.includes(mode)) throw new UsageError(`unknown mode ${JSON.stringify(mode)} (expected ${MODES.join('|')})`);
  const rawRoot = values['repo-root'];
  if (rawRoot !== undefined && !isAbsolute(rawRoot)) throw new UsageError('--repo-root must be an absolute path');
  const repoRoot = resolve(rawRoot ?? process.cwd());
  // A missing root would read as an empty repo and report off/not-wired.
  let isDir;
  try {
    isDir = statSync(repoRoot).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw new UsageError(`--repo-root ${JSON.stringify(repoRoot)} is not an existing directory`);
  const ref = values.ref === undefined ? null : verifyRef(repoRoot, values.ref);
  return { help: false, mode, ref, json: values.json, repoRoot };
}

/**
 * Resolve `ref` to a full commit SHA, or throw UsageError.
 * @param {string} repoRoot
 * @param {string} ref
 * @returns {string}
 */
function verifyRef(repoRoot, ref) {
  if (ref === '' || ref.startsWith('-') || /\s/.test(ref)) throw new UsageError('--ref must be a commit and must not start with - or contain whitespace');
  try {
    return execFileSync('git', ['-C', repoRoot, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new UsageError(`--ref ${JSON.stringify(ref)} is not a commit in ${repoRoot}`);
  }
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>} exit code
 */
export async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseCli(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    process.stderr.write(`${PREFIX} ${err.message}\n\n${HELP}\n`);
    return EXIT_USAGE;
  }
  if (opts.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }

  const file = join(MODULE_DIR, `${opts.mode}.mjs`);
  if (!existsSync(file)) {
    process.stderr.write(`${PREFIX} mode ${opts.mode} not available in this build\n`);
    return EXIT_USAGE;
  }

  let result;
  try {
    const mod = await LOADERS[opts.mode]();
    if (typeof mod.run !== 'function') throw new TypeError(`${opts.mode}.mjs exports no run()`);
    result = await mod.run({ repoRoot: opts.repoRoot, ref: opts.ref, env: process.env, now: new Date() });
  } catch (err) {
    process.stderr.write(`${PREFIX} mode ${opts.mode} failed: ${err instanceof Error ? `${err.name}: ${err.message.split('\n')[0]}` : String(err)}\n`);
    return EXIT_USAGE;
  }
  const problem = resultProblem(result);
  if (problem) {
    process.stderr.write(`${PREFIX} mode ${opts.mode} returned a malformed result: ${problem}\n`);
    return EXIT_USAGE;
  }

  process.stdout.write(opts.json ? `${JSON.stringify(result)}\n` : renderText(result));
  return result.status === 'degraded' ? EXIT_DEGRADED : 0;
}

if (isMainModule(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}
