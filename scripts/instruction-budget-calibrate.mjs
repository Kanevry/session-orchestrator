#!/usr/bin/env node
/**
 * instruction-budget-calibrate.mjs — print an `instruction-budget:` Session
 * Config block measured on THIS repo's rule corpus (#1995).
 *
 * ## Why
 *
 * The guard's DEFAULT_* ceilings are the plugin repo's own growth ratchet. In a
 * consumer repo they measure nothing about that repo (the breach line fired in
 * 15 of 32 consumer repos, 2026-11-09), so `checkInstructionBudget` now reports
 * an axis without its own key as "not calibrated" and points here. This CLI is
 * read-only: it measures with `computeInstructionBudget` and PRINTS a block the
 * operator commits into `## Session Config`. It never writes a file.
 *
 * WHERE the block goes is part of the output (#1995 F2/F4): the loader reads
 * `CLAUDE.md` whenever it exists (else `AGENTS.md`) and only the FIRST
 * `instruction-budget:` block in it. So the CLI names that file and, when it
 * already has a block, tells the operator to REPLACE it and lists the keys the
 * existing block sets — pasting a second block below it would change nothing.
 *
 * ## Usage
 *
 *   node scripts/instruction-budget-calibrate.mjs [--repo-root <dir>] [--json]
 *
 * Default repo root: `git rev-parse --show-toplevel` of the cwd, else the cwd.
 * stdout: the YAML block (or, with --json, one JSON object that also carries
 * `hostFile` and `existingBlock`). Where-to-paste instruction + diagnostics: stderr.
 *
 * Exit codes (`.claude/rules/cli-design.md`):
 *   0 — block printed
 *   1 — usage error (unknown flag, missing/invalid --repo-root)
 *   2 — unexpected/system error
 */

import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  computeInstructionBudget,
  findInstructionBudgetBlock,
  formatCalibrateInstruction,
  PATH_SCOPED_NEAR_THRESHOLD,
  resolveInstructionBudgetHostFile,
} from './lib/instruction-budget-guard.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { execFileSync } from './lib/native-command.mjs';

const USAGE = [
  'Usage: node scripts/instruction-budget-calibrate.mjs [--repo-root <dir>] [--json]',
  '',
  '  --repo-root  optional  repo to measure (default: git top-level of cwd, else cwd)',
  '  --json       optional  print one JSON object instead of the YAML block',
  '  --help       print this text',
  '',
  'Prints an instruction-budget: block for ## Session Config. Writes no file.',
  'Exit codes: 0 printed, 1 usage error, 2 unexpected error',
].join('\n');

const EXIT_USAGE = 1;
const EXIT_SYSTEM = 2;

/**
 * Relative headroom over the measured value — the SAME +5 % every byte and
 * directive default in `instruction-budget-guard.mjs` was calibrated with
 * (see DEFAULT_BYTE_CEILING: "480 over its ~457 baseline = +5.03%").
 */
export const HEADROOM_RATIO = 0.05;

/**
 * Absolute byte floor of the headroom. 5 % of a small corpus is smaller than
 * one rule edit, so a calibrated ceiling would fire on the next edit. The
 * guard's own derivation names the unit the ratchet should tolerate: "+5% ≈
 * 5.4 KB ≈ one medium always-on rule file (verification-before-completion.md
 * is 6.1 KB)". This is that file, counted by the guard's own byte counter:
 *
 *   computeInstructionBudget({ repoRoot }).perFile
 *     .find((f) => f.file === 'verification-before-completion.md')
 *   → { count: 32, bytes: 6113 }   (2026-11-10T00:02Z @ c47eb57e)
 *
 * BV-004 ceiling: a fixed snapshot of one file. Revisit trigger — re-measure
 * when that rule file changes by more than ~1 KB, or when a calibrated consumer
 * axis fires on a single ordinary rule edit.
 */
export const HEADROOM_FLOOR_BYTES = 6113;

/**
 * Absolute directive floor of the headroom: `countDirectives` of the same
 * reference file (32, same measurement as {@link HEADROOM_FLOOR_BYTES}). Same
 * BV-004 revisit trigger.
 */
export const HEADROOM_FLOOR_DIRECTIVES = 32;

/** Rounding unit for byte ceilings. */
const BYTE_ROUND = 1000;

/**
 * Ceiling for one axis: measured value + max(5 %, floor).
 *
 * Byte axes are rounded DOWN to the nearest 1000 when that still leaves the
 * full floor of headroom (and, for the path-scoped axis, keeps the corpus below
 * the #1419 near-threshold); otherwise rounded UP — a round-up can never cut
 * headroom, so it is always valid. Directives are not rounded.
 *
 * The path-scoped axis additionally needs `value < ceiling × 0.9`, or the
 * guard's near-threshold line (PATH_SCOPED_NEAR_THRESHOLD) would fire on the
 * very corpus the block was calibrated for — +5 % alone sits at ~95 %.
 *
 * @param {number} value  measured value (non-negative integer)
 * @param {{ bytes: boolean, nearThreshold?: number }} kind
 * @returns {number}
 */
export function calibrateAxis(value, kind) {
  const floor = kind.bytes ? HEADROOM_FLOOR_BYTES : HEADROOM_FLOOR_DIRECTIVES;
  const near = kind.nearThreshold;
  const valid = (c) => c >= value + floor && (near === undefined || value < c * near);

  let target = value + Math.max(Math.ceil(value * HEADROOM_RATIO), floor);
  if (near !== undefined) {
    while (!(value < target * near)) target += 1;
  }
  if (!kind.bytes) return target;

  const down = Math.floor(target / BYTE_ROUND) * BYTE_ROUND;
  return valid(down) ? down : Math.ceil(target / BYTE_ROUND) * BYTE_ROUND;
}

/**
 * Measure `repoRoot` and derive the four ceilings.
 *
 * @param {string} repoRoot
 * `hostFile` is the file the loader reads (null: neither CLAUDE.md nor AGENTS.md
 * exists); `existingBlock` is the block the loader reads in it today (null:
 * none), which the printed block must REPLACE.
 *
 * @returns {{ repoRoot: string,
 *   measured: { directives: number, bytes: number, generatedBytes: number, pathScopedBytes: number },
 *   ceilings: { ceiling: number, 'byte-ceiling': number, 'generated-byte-ceiling': number, 'path-scoped-byte-ceiling': number },
 *   block: string,
 *   hostFile: 'CLAUDE.md' | 'AGENTS.md' | null,
 *   existingBlock: { keys: string[] } | null }}
 */
export function calibrateInstructionBudget(repoRoot) {
  const budget = computeInstructionBudget({ repoRoot });
  const measured = {
    directives: budget.totalDirectives,
    bytes: budget.totalBytes,
    generatedBytes: budget.bySurface.generated.bytes,
    pathScopedBytes: budget.bySurface.pathScoped.bytes,
  };
  const ceilings = {
    ceiling: calibrateAxis(measured.directives, { bytes: false }),
    'byte-ceiling': calibrateAxis(measured.bytes, { bytes: true }),
    'generated-byte-ceiling': calibrateAxis(measured.generatedBytes, { bytes: true }),
    'path-scoped-byte-ceiling': calibrateAxis(measured.pathScopedBytes, {
      bytes: true,
      nearThreshold: PATH_SCOPED_NEAR_THRESHOLD,
    }),
  };
  const block = [
    'instruction-budget:',
    '  enabled: true',
    `  ceiling: ${ceilings.ceiling}`,
    `  byte-ceiling: ${ceilings['byte-ceiling']}`,
    `  generated-byte-ceiling: ${ceilings['generated-byte-ceiling']}`,
    `  path-scoped-byte-ceiling: ${ceilings['path-scoped-byte-ceiling']}`,
    '  mode: warn',
  ].join('\n');
  const host = resolveInstructionBudgetHostFile(repoRoot);
  const hostFile = host ? host.name : null;
  const existingBlock = host ? findInstructionBudgetBlock(host.content) : null;
  return { repoRoot, measured, ceilings, block, hostFile, existingBlock };
}

/** True when `p` is an existing regular file. */
function statSafeIsFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** git top-level of `cwd`, else `cwd`. */
function defaultRepoRoot(cwd) {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || cwd;
  } catch {
    return cwd;
  }
}

function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        'repo-root': { type: 'string' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    process.stderr.write(`instruction-budget-calibrate: ${err.message}\n${USAGE}\n`);
    return EXIT_USAGE;
  }
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  let repoRoot;
  if (values['repo-root'] !== undefined) {
    repoRoot = resolve(values['repo-root']);
    let isDir;
    try {
      isDir = statSync(repoRoot).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      process.stderr.write(`instruction-budget-calibrate: --repo-root is not a directory: ${repoRoot}\n`);
      return EXIT_USAGE;
    }
  } else {
    repoRoot = defaultRepoRoot(process.cwd());
  }

  const result = calibrateInstructionBudget(repoRoot);
  if (values.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stdout.write(`${result.block}\n`);
    // Same sentence as the banner, minus its leading "Run node …" — the
    // operator just ran it.
    const instruction = formatCalibrateInstruction(result).replace(/^Run node "[^"]*" and /, '');
    process.stderr.write(`instruction-budget-calibrate: measured ${repoRoot} — ${instruction}\n`);
    if (result.hostFile === 'CLAUDE.md' && statSafeIsFile(resolve(repoRoot, 'AGENTS.md'))) {
      process.stderr.write(
        'instruction-budget-calibrate: AGENTS.md is not read for this block while CLAUDE.md exists.\n',
      );
    }
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (err) {
    process.stderr.write(`instruction-budget-calibrate: unexpected error: ${err?.message ?? err}\n`);
    process.exitCode = EXIT_SYSTEM;
  }
}
