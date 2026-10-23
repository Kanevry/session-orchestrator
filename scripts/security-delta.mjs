#!/usr/bin/env node
/**
 * security-delta.mjs — close-time Security-Delta over one commit range (#1769, stage 1).
 *
 * Runs the five delta checks (lockfile advisories, runtime floor, floating
 * tags, gitleaks, age gate) via `runSecurityDelta()` and prints the Result.
 * Fail-open by design: only a `block` verdict (mode `strict` + an introduced
 * blocking finding) exits non-zero for a reason other than bad usage.
 *
 * Mode resolution: `--mode`, else Session Config `security-delta.mode`, else `off`.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { resolveInstructionFile } from './lib/common.mjs';
import { parseSessionConfig } from './lib/config.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { EXIT_BLOCK, MODES } from './lib/security-delta/contract.mjs';
import { runSecurityDelta } from './lib/security-delta/runner.mjs';
import { emitDeltaEvent } from './lib/security-delta/telemetry.mjs';

const PREFIX = 'security-delta:';
const EXIT_USAGE = 1;
const EXIT_CRASH = 2;
const execFileAsync = promisify(execFile);

const HELP = [
  'Usage: security-delta.mjs --range <base>..<head> [options]',
  '       security-delta.mjs --base <ref> [--head <ref>] [options]',
  '',
  'Checks what a commit range introduces: vulnerable or malicious lockfile',
  'packages (OSV), runtime floors below the supported line, floating image/action',
  'tags, secrets (gitleaks, if installed) and a missing package age gate.',
  '',
  'Options:',
  '  --range <base>..<head>   commit range to check (head defaults to HEAD);',
  '                           <base>...<head> is resolved to <merge-base>..<head>',
  '  --base <ref>             alternative to --range',
  '  --head <ref>             alternative to --range (default HEAD)',
  '  --repo-root <path>       repository root (default: current directory)',
  `  --mode ${MODES.join('|')}     override Session Config security-delta.mode (default off)`,
  '  --config-file <path>     Session Config file (default CLAUDE.md / AGENTS.md under --repo-root)',
  '  --json                   print the Result as one JSON line on stdout',
  '  --no-event               do not emit the orchestrator.security.delta event',
  '  --help                   show this help',
  '',
  'Exit codes:',
  '  0  pass, warn, degraded or skipped (fail-open)',
  '  1  usage error (bad flag, bad range, unknown mode, unreadable config file)',
  '  2  unexpected crash before any result existed',
  `  ${EXIT_BLOCK}  verdict block: mode strict and an introduced blocking finding`,
  '     (malicious package, or critical vulnerability with a known fix)',
  '',
  'Example:',
  '  node scripts/security-delta.mjs --range origin/main..HEAD --mode warn --json',
].join('\n');

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * A ref given on the command line: non-empty, no leading `-` (would read as
 * a git option), no whitespace.
 * @param {string} ref
 * @param {string} flag
 */
function assertRefShape(ref, flag) {
  if (ref.startsWith('-') || /\s/.test(ref)) throw new UsageError(`${flag} must not start with '-' or contain whitespace`);
}

/**
 * @param {{range?: string, base?: string, head?: string}} values
 * @returns {{base: string, head: string, threeDot: boolean}}
 */
function resolveRange(values) {
  if (typeof values.range === 'string') {
    if (values.base !== undefined || values.head !== undefined) throw new UsageError('use either --range or --base/--head');
    assertRefShape(values.range, '--range');
    const i = values.range.indexOf('..');
    if (i === -1) throw new UsageError('--range must look like <base>..<head>');
    // `<base>...<head>` is what the plan-verification.md accessor yields when
    // session-start-ref is unpinned; main() resolves it via git merge-base.
    const threeDot = values.range[i + 2] === '.';
    const base = values.range.slice(0, i);
    const head = values.range.slice(i + (threeDot ? 3 : 2)) || 'HEAD';
    if (!base) throw new UsageError('--range needs a base before ..');
    if (head.startsWith('.')) throw new UsageError('--range must look like <base>..<head> or <base>...<head>');
    assertRefShape(head, '--range');
    return { base, head, threeDot };
  }
  if (typeof values.base !== 'string') throw new UsageError('--range or --base is required');
  assertRefShape(values.base, '--base');
  const head = values.head ?? 'HEAD';
  assertRefShape(head, '--head');
  return { base: values.base, head, threeDot: false };
}

/**
 * Merge base of `base` and `head` — the base a three-dot range stands for.
 * @param {string} repoRoot
 * @param {string} base
 * @param {string} head
 * @returns {Promise<string>} commit SHA
 */
async function mergeBase(repoRoot, base, head) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync('git', ['-C', repoRoot, 'merge-base', base, head]));
  } catch (err) {
    const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
    throw new UsageError(`--range ${base}...${head}: git merge-base failed (${detail})`);
  }
  const sha = stdout.trim();
  if (!sha) throw new UsageError(`--range ${base}...${head}: git merge-base found no common ancestor`);
  return sha;
}

/**
 * Session Config `security-delta.mode`, or `off` when absent.
 * @param {string} repoRoot
 * @param {string|undefined} explicit  `--config-file`
 * @returns {string}
 */
function modeFromConfig(repoRoot, explicit) {
  let file;
  if (explicit) {
    file = resolve(explicit);
    if (!existsSync(file)) throw new UsageError(`config file not found: ${explicit}`);
  } else if (process.env.SO_CONFIG_FILE && existsSync(join(repoRoot, process.env.SO_CONFIG_FILE))) {
    file = join(repoRoot, process.env.SO_CONFIG_FILE);
  } else {
    file = resolveInstructionFile(repoRoot)?.path ?? null;
  }
  if (file === null) return 'off';

  let config;
  try {
    config = parseSessionConfig(readFileSync(file, 'utf8'));
  } catch (err) {
    // Fail-open: an unparsable config must not turn the close into a failure.
    process.stderr.write(`${PREFIX} WARN: could not read Session Config (${err instanceof Error ? err.message : String(err)}); mode off\n`);
    return 'off';
  }
  const mode = config?.['security-delta']?.mode;
  if (mode === undefined || mode === null) return 'off';
  if (!MODES.includes(mode)) {
    process.stderr.write(`${PREFIX} WARN: Session Config security-delta.mode ${JSON.stringify(mode)} is not ${MODES.join('|')}; mode off\n`);
    return 'off';
  }
  return mode;
}

/**
 * Short human summary. Findings never carry a secret value (the gitleaks check
 * reports file + rule only), so printing them is safe.
 * @param {Awaited<ReturnType<typeof runSecurityDelta>>} result
 * @returns {string}
 */
function formatHuman(result) {
  const t = result.totals;
  const lines = [
    `security-delta ${result.range} mode=${result.mode}: status=${result.status} verdict=${result.verdict}`,
    `  findings=${t.findings} introduced=${t.introduced} blocking=${t.blocking} checked=${t.checked} unchecked=${t.unchecked} ms=${result.ms.total}`,
  ];
  for (const c of result.checks) {
    lines.push(`  [${c.id}] ${c.status}${c.reason ? ` (${c.reason})` : ''} checked=${c.checked} unchecked=${c.unchecked}`);
    for (const f of c.findings) {
      const subject = f.package ? `${f.package}${f.version ? `@${f.version}` : ''}` : f.file;
      const where = f.package && f.file ? ` in ${f.file}` : '';
      lines.push(`    - ${f.class} ${f.severity} ${subject}${where}${f.introduced ? ' (introduced)' : ''}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>} exit code
 */
export async function main(argv = process.argv.slice(2)) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        range: { type: 'string' },
        base: { type: 'string' },
        head: { type: 'string' },
        'repo-root': { type: 'string' },
        mode: { type: 'string' },
        'config-file': { type: 'string' },
        json: { type: 'boolean', default: false },
        'no-event': { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    process.stderr.write(`${PREFIX} ${err instanceof Error ? err.message : String(err)}\n${HELP}\n`);
    return EXIT_USAGE;
  }
  if (values.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }

  let range;
  let mode;
  const repoRoot = resolve(values['repo-root'] ?? process.cwd());
  try {
    range = resolveRange(values);
    if (values.mode !== undefined) {
      if (!MODES.includes(values.mode)) throw new UsageError(`--mode must be one of ${MODES.join('|')}, got ${JSON.stringify(values.mode)}`);
      mode = values.mode;
    } else {
      mode = modeFromConfig(repoRoot, values['config-file']);
    }
    // Mode off runs no check, so it neither needs nor fails on the merge base.
    if (range.threeDot && mode !== 'off') range = { ...range, base: await mergeBase(repoRoot, range.base, range.head) };
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${PREFIX} ${err.message}\n`);
      return EXIT_USAGE;
    }
    throw err;
  }

  const result = await runSecurityDelta({ repoRoot, base: range.base, head: range.head, mode });

  if (!values['no-event'] && mode !== 'off') await emitDeltaEvent(result, { repoRoot });

  // One write, then return: the caller sets exitCode and lets the process end
  // naturally, so a large line is never cut at the pipe buffer.
  process.stdout.write(values.json ? `${JSON.stringify(result)}\n` : formatHuman(result));
  return result.verdict === 'block' ? EXIT_BLOCK : 0;
}

if (isMainModule(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`${PREFIX} crashed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = EXIT_CRASH;
    },
  );
}
