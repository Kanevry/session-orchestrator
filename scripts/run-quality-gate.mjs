#!/usr/bin/env node
/**
 * run-quality-gate.mjs — Run quality gate checks and output structured JSON results.
 * Port of run-quality-gate.sh (issue #218). Preserves all 4 variants and the same
 * CLI surface / JSON output shape / exit codes.
 *
 * Usage:
 *   node scripts/run-quality-gate.mjs --variant <variant> [options]
 *
 * Flags:
 *   --variant <v>            Required. baseline | incremental | full-gate | per-file
 *   --config <json-or-file>  Config JSON string or path to JSON file
 *                            (from parse-config output). When omitted, command
 *                            defaults from the policy file or built-in defaults apply.
 *   --files <f1,f2,...>      Comma-separated file list (incremental + per-file).
 *   --session-start-ref <r>  Git ref for diff base (incremental, to find changed files).
 *   -h, --help               Show this help and exit.
 *
 * Exit codes:
 *   0 — pass (or informational; non-blocking variants always exit 0)
 *   1 — script error (bad arguments, missing dependencies)
 *   2 — gate failed (full-gate only: typecheck/test/lint errors)
 *
 * The gate sub-scripts in scripts/lib/gates/ are NOT reimplemented here; they are
 * invoked via child_process.spawn('bash', [path, ...]) with the required env vars.
 *
 * References:
 *   scripts/run-quality-gate.sh                  — original shell orchestrator
 *   scripts/lib/quality-gates-policy.mjs         — loadQualityGatesPolicy, resolveCommand
 *   scripts/lib/common.mjs                       — die, warn, findProjectRoot
 *   scripts/lib/gates/gate-{baseline,incremental,full,per-file}.mjs
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { die, warn } from './lib/common.mjs';
import { loadQualityGatesPolicy, resolveCommand } from './lib/quality-gates-policy.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const GATES_DIR = join(__dirname, 'lib', 'gates');

const VALID_VARIANTS = ['baseline', 'incremental', 'full-gate', 'per-file'];

const DEFAULT_TEST_CMD = 'pnpm test --run';
const DEFAULT_TYPECHECK_CMD = 'tsgo --noEmit';
const DEFAULT_LINT_CMD = 'pnpm lint';

// Gate sub-script mapping
const GATE_SCRIPT = {
  baseline:    join(GATES_DIR, 'gate-baseline.mjs'),
  incremental: join(GATES_DIR, 'gate-incremental.mjs'),
  'full-gate': join(GATES_DIR, 'gate-full.mjs'),
  'per-file':  join(GATES_DIR, 'gate-per-file.mjs'),
};

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);

if (argv.includes('-h') || argv.includes('--help')) {
  process.stdout.write(
    'Usage: run-quality-gate.mjs --variant <variant> [--config <json-or-file>] ' +
    '[--files <file1,file2,...>] [--session-start-ref <ref>]\n\n' +
    'Variants: baseline, incremental, full-gate, per-file\n\n' +
    'Exit codes:\n' +
    '  0 — pass (non-blocking variants always exit 0)\n' +
    '  1 — script error (bad arguments, missing dependencies)\n' +
    '  2 — gate failed (full-gate only)\n',
  );
  process.exit(0);
}

let variant = '';
let config = '';
let files = '';
let sessionStartRef = '';

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  switch (arg) {
    case '--variant':
      if (i + 1 >= argv.length) die('Missing value for --variant');
      variant = argv[++i];
      break;
    case '--config':
      if (i + 1 >= argv.length) die('Missing value for --config');
      config = argv[++i];
      break;
    case '--files':
      if (i + 1 >= argv.length) die('Missing value for --files');
      files = argv[++i];
      break;
    case '--session-start-ref':
      if (i + 1 >= argv.length) die('Missing value for --session-start-ref');
      sessionStartRef = argv[++i];
      break;
    default:
      die(`Unknown argument: ${arg}`);
  }
}

if (!variant) die('Missing required argument: --variant');
if (!VALID_VARIANTS.includes(variant)) {
  die(`Invalid variant: '${variant}' (allowed: ${VALID_VARIANTS.join(', ')})`);
}

// ---------------------------------------------------------------------------
// Command resolution — policy-file-first (#183), then config, then defaults
// ---------------------------------------------------------------------------

/**
 * Resolve a command string from:
 *   1. quality-gates policy file (.orchestrator/policy/quality-gates.json)
 *   2. Session Config passed via --config (JSON string or file path)
 *   3. Built-in default
 *
 * Mirrors extract_command() in run-quality-gate.sh.
 *
 * @param {object|null} policy
 * @param {"test"|"typecheck"|"lint"} policyKey
 * @param {string} configKey   e.g. "test-command"
 * @param {object|null} configJson  parsed --config JSON (or null)
 * @param {string} defaultCmd
 * @returns {string}
 */
function extractCommand(policy, policyKey, configKey, configJson, defaultCmd) {
  // 1. Policy file takes precedence
  const fromPolicy = resolveCommand(policy, policyKey, '');
  if (fromPolicy) return fromPolicy;

  // 2. Session Config
  if (configJson !== null && typeof configJson === 'object') {
    const val = configJson[configKey];
    if (val && typeof val === 'string' && val !== 'null') return val;
  }

  // 3. Built-in default
  return defaultCmd;
}

// Load policy file (never throws)
const repoRoot = process.cwd();
const policy = loadQualityGatesPolicy(repoRoot);

// Parse --config (JSON string or file path)
let configJson = null;
if (config) {
  if (existsSync(config)) {
    try {
      configJson = JSON.parse(readFileSync(config, 'utf8'));
    } catch (err) {
      warn(`Could not parse config file '${config}': ${err.message}; using defaults`);
    }
  } else {
    try {
      configJson = JSON.parse(config);
    } catch {
      warn('Config is neither a valid file path nor valid JSON; using defaults');
    }
  }
}

const TYPECHECK_CMD = extractCommand(policy, 'typecheck', 'typecheck-command', configJson, DEFAULT_TYPECHECK_CMD);
const TEST_CMD      = extractCommand(policy, 'test',      'test-command',      configJson, DEFAULT_TEST_CMD);
const LINT_CMD      = extractCommand(policy, 'lint',      'lint-command',      configJson, DEFAULT_LINT_CMD);

// ---------------------------------------------------------------------------
// Gate dispatch — shell-out to existing gate-*.mjs sub-scripts
// ---------------------------------------------------------------------------

const gatePath = GATE_SCRIPT[variant];

if (!existsSync(gatePath)) {
  die(`Gate script not found: ${gatePath}`);
}

const env = {
  ...process.env,
  TYPECHECK_CMD,
  TEST_CMD,
  LINT_CMD,
  FILES: files,
  SESSION_START_REF: sessionStartRef,
};

const result = spawnSync('node', [gatePath], {
  env,
  stdio: 'inherit',
});

if (result.error) {
  die(`Failed to run gate script: ${result.error.message}`);
}

process.exit(result.status ?? 1);
