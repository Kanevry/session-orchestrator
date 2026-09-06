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
 *   --ledger-root <path>     Repo root the telemetry event is pinned to (and the
 *                            root session attribution is read from). Only the
 *                            pre-push hook passes it; see the emission block below.
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

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { die, warn } from './lib/common.mjs';
import { loadQualityGatesPolicy, resolveCommand } from './lib/quality-gates-policy.mjs';
import { emitEvent, sessionAttribution } from './lib/events.mjs';
import { admitSuiteCounts } from './lib/gates/gate-helpers.mjs';
import { findScopeFile } from './lib/scope-gate.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const GATES_DIR = join(__dirname, 'lib', 'gates');

const VALID_VARIANTS = ['baseline', 'incremental', 'full-gate', 'per-file'];

/**
 * Ceiling on the gate sub-script's captured stdout. A gate writes one JSON line
 * (5-line command tails + ≤50 debug artifacts), so this is effectively
 * unreachable — it exists only so a pathological gate cannot be killed
 * mid-write by the default 1 MiB spawnSync cap.
 */
const GATE_STDOUT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

const DEFAULT_TEST_CMD = 'npm test';
const DEFAULT_TYPECHECK_CMD = 'npm run typecheck';
const DEFAULT_LINT_CMD = 'npm run lint';

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
    '[--files <file1,file2,...>] [--session-start-ref <ref>] [--ledger-root <path>]\n\n' +
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
let ledgerRootArg = '';

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
    case '--ledger-root':
      if (i + 1 >= argv.length) die('Missing value for --ledger-root');
      ledgerRootArg = argv[++i];
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

/**
 * Lift the suite counts out of a gate sub-script's JSON stdout envelope (#954).
 *
 * This function is the ENVELOPE ADAPTER only. The numeric admission policy —
 * which triples count as a measurement and which are refused — lives once in
 * {@link admitSuiteCounts} (`scripts/lib/gates/gate-helpers.mjs`, #967 item 2),
 * shared with `suiteCountsFromOutput` in `scripts/lib/quality-gate.mjs`. Before
 * that split, the same `counts` field was written under two different policies
 * and a consumer had to know both to read one number.
 *
 * The four rejections that stay here are envelope-shaped, not numeric:
 *
 *   1. stdout is absent or not parseable JSON;
 *   2. `test` is not the object form — only `gate-full.mjs` reports numbers;
 *      `gate-{baseline,incremental,per-file}.mjs` emit a bare status STRING, so
 *      a non-full-gate variant structurally cannot carry counts;
 *   3. the test gate was skipped (`status` neither `pass` nor `fail`);
 *   4. the test COMMAND was detected as a stub (`echo …` / no-op) — a stub's
 *      output parses to 0/0, which would be a fabricated zero.
 *
 * `failed` is NO LONGER derived here. Since #967 item 1 `gate-full.mjs`
 * publishes it explicitly, so the whole `test` object is handed through and
 * `admitSuiteCounts`'s `passed + failed === total` check becomes a real guard
 * against producer/consumer envelope drift instead of an identity that a local
 * `total - passed` derivation could never fail.
 *
 * Never throws — a malformed envelope yields `null`.
 *
 * @param {string} stdout — the gate sub-script's captured stdout.
 * @returns {{ passed: number, failed: number, total: number }|null}
 */
function suiteCountsFromGateStdout(stdout) {
  if (typeof stdout !== 'string' || !stdout.trim()) return null;

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const test = parsed.test;
  if (test === null || typeof test !== 'object' || Array.isArray(test)) return null;
  if (test.status !== 'pass' && test.status !== 'fail') return null;
  if (parsed.stubbed && typeof parsed.stubbed === 'object' && parsed.stubbed.test) return null;

  return admitSuiteCounts(test);
}

/**
 * Lift `test.failed_files` out of a gate sub-script's JSON stdout envelope.
 *
 * Envelope adapter, same posture as {@link suiteCountsFromGateStdout}: it
 * decides only whether a NAMED-FILE measurement exists, never what the names
 * mean. `null` — never `[]` — for every non-measurement, so the caller OMITS
 * the key instead of publishing an empty array that reads as "no file failed".
 *
 * Only `gate-full.mjs` publishes the key, and only when the runner printed a
 * file-level summary; every other variant emits a bare status string.
 *
 * Never throws.
 *
 * @param {string} stdout — the gate sub-script's captured stdout.
 * @returns {string[]|null}
 */
function failedFilesFromGateStdout(stdout) {
  if (typeof stdout !== 'string' || !stdout.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const files = parsed?.test?.failed_files;
  if (!Array.isArray(files) || files.length === 0) return null;
  const named = files.filter((f) => typeof f === 'string' && f.trim());
  return named.length > 0 ? named : null;
}

/**
 * Validate and resolve the `--ledger-root` flag (see the telemetry block below).
 *
 * Only the pre-push hook passes this, and it hands over a path the gate then
 * WRITES to — so a typo must not silently create an `.orchestrator/metrics/`
 * tree somewhere arbitrary. The check is therefore two-part: the value must be
 * an existing DIRECTORY, and it must already contain an `.orchestrator/`
 * directory — the marker of a root this harness has already been initialised in.
 *
 * The alternative check (`git rev-parse --show-toplevel` with cwd = that path,
 * compared against the value) is rejected on cost: it spawns a process on every
 * gate run to prove a property two `statSync` calls already prove. The one case
 * it accepts and this one rejects — a git root that has never run the
 * orchestrator — is precisely the case with no ledger to pin to.
 *
 * A bad value NEVER crashes the gate: it warns once on stderr and returns
 * `null`, which restores the previous resolution
 * (`CLAUDE_PROJECT_DIR ?? CODEX_PROJECT_DIR ?? repoRoot`) at the call sites.
 * The gate's exit code is the authoritative output; telemetry is best-effort.
 *
 * @param {string} value — raw flag value (`''` when the flag was not passed).
 * @returns {string|null} absolute, validated root — or `null` to fall back.
 */
function resolveLedgerRoot(value) {
  const raw = (value || '').trim();
  if (!raw) return null;
  const abs = resolve(raw);
  try {
    if (statSync(abs).isDirectory() && statSync(join(abs, '.orchestrator')).isDirectory()) {
      return abs;
    }
  } catch { /* falls through to the warn below */ }
  warn(
    `--ledger-root '${raw}' is not an initialised project root ` +
    '(existing directory containing .orchestrator/) — falling back to the default ' +
    'telemetry destination.',
  );
  return null;
}

/**
 * Resolve the active wave number from the wave-scope sidecar (#966 step 1).
 *
 * Mirrors `resolveWave()` in `hooks/pre-bash-memory-propose-audit.mjs` — the
 * same `.{pi,cursor,codex,claude}/wave-scope.json` precedence via
 * {@link findScopeFile} — with ONE deliberate difference: the hook returns `0`
 * for "no wave-scope file", this returns `null`.
 *
 * Absent is not zero. A human running `npm run quality-gate` from a `git push`
 * has no wave at all, and that is the common case; publishing `wave_number: 0`
 * would invent a wave 0 that every consumer then has to special-case. The
 * caller spreads the result so the KEY is omitted, exactly as `counts` is.
 *
 * A non-positive or non-numeric `wave` field is treated the same way — waves
 * are 1-indexed, so `0` on disk carries no more information than an absent file.
 *
 * Never throws.
 *
 * @param {string} projectDir — directory whose wave-scope sidecar to read.
 * @returns {number|null} positive wave number, or `null` when there is no wave.
 */
function resolveWaveNumber(projectDir) {
  try {
    const waveFile = findScopeFile(projectDir);
    if (!waveFile || !existsSync(waveFile)) return null;
    const wave = JSON.parse(readFileSync(waveFile, 'utf8'))?.wave;
    if (typeof wave !== 'number' || !Number.isFinite(wave) || wave <= 0) return null;
    return Math.trunc(wave);
  } catch {
    return null;
  }
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

// `npm_config_loglevel` is INHERITED by every descendant, and the pre-push hook
// invokes this script as `npm run --silent quality-gate` — which sets it to
// `silent`. That level then reached the gate's own children: `npm pack
// --dry-run` emitted ZERO `npm notice` lines instead of 818 (measured
// 2026-08-22), so the release leakage test saw an empty listing, and several
// validate-plugin/e2e tests that shell out to npm went red the same way. Every
// one of them passes under a bare `npm test` and fails only INSIDE the gate,
// which is the hardest shape to diagnose and cost an hour of chasing phantoms.
//
// Pinned rather than deleted: an explicit level makes the gate's children
// independent of how the gate itself was invoked. `--silent` still does its real
// job — keeping THIS process's stdout to the single JSON envelope — because the
// children's output is captured by `runCheck`, never streamed.
const env = {
  ...process.env,
  npm_config_loglevel: 'notice',
  TYPECHECK_CMD,
  TEST_CMD,
  LINT_CMD,
  FILES: files,
  SESSION_START_REF: sessionStartRef,
};

// stdout is PIPED (not inherited) so the suite counts the gate already computed
// can be lifted straight off its JSON envelope into telemetry (#954) instead of
// travelling as prose through the STATE.md header. The envelope is re-emitted
// verbatim below, so the stdout contract is unchanged — a gate sub-script writes
// exactly one JSON line at the very end (its own child commands are captured by
// `runCheck`), so nothing streamed before and nothing streams now. stderr stays
// inherited, keeping warnings live.
const result = spawnSync('node', [gatePath], {
  env,
  stdio: ['inherit', 'pipe', 'inherit'],
  encoding: 'utf8',
  maxBuffer: GATE_STDOUT_MAX_BUFFER_BYTES,
});

const gateStdout = typeof result.stdout === 'string' ? result.stdout : '';
if (gateStdout) process.stdout.write(gateStdout);

if (result.error && typeof result.status !== 'number') {
  die(`Failed to run gate script: ${result.error.message}`);
}

// Quality-gate telemetry — one canonical event per gate run via emitEvent
// (single emission path). `sessionAttribution` is the shared helper in
// events.mjs (#941); this CLI wrapper runs against the CWD `repoRoot`, so the
// bare emitEvent destination (SO_PROJECT_DIR default) is correct here.
//
// EXCEPT under the pre-push hook, which is the one caller that runs the gate in
// a tree that is about to be DELETED. `.husky/pre-push` materialises the tracked
// tree into a temp dir and deliberately scrubs every `*PROJECT_DIR` name before
// invoking the gate there, so `getProjectDir()` resolves to that temp tree (it
// carries both a CLAUDE.md (or AGENTS.md) and a .git) and the record lands in
// `<tmp>/.orchestrator/metrics/events.jsonl`, which the hook's EXIT trap then
// removes. Measured 2026-09-06: a pre-push run that BLOCKED a push left no
// `orchestrator.quality_gate.failed` line in this repo's ledger at all — the
// gate failure was, by construction, the one event that could never be recorded.
//
// `--ledger-root` is that hook's channel for handing back the root it already
// knows (`git rev-parse --show-toplevel`, read BEFORE it cds). It pins ONLY the
// telemetry destination and the attribution root — every other path the gate
// resolves stays inside the tree actually under test, which is the whole point
// of the materialisation. Absent (every other caller) → unchanged behaviour:
// `emitEvent`'s own default resolution.
//
// It is an ARGV FLAG and not an env var, and that is load-bearing. Measured
// 2026-09-06 with the env-var form: `SO_GATE_LEDGER_ROOT=$tmp npx vitest run
// tests/scripts/run-quality-gate.test.mjs -t "telemetry emission"` → `8 failed |
// 1 passed`. The chain was: hook exports the var → `npm run quality-gate` →
// `gate-full.mjs` spawns `npm test` → every vitest worker inherits it → the
// suite's own gate spawns spread `...process.env`, so the pinned root outranked
// their per-test project dir and the gate's telemetry tests wrote to the hook's
// root. The gate that releases 4.0.0 would have blocked on itself. An env var is
// inherited by every descendant; a flag reaches exactly one process.
//
// Best-effort: a telemetry failure must NEVER alter the gate's authoritative
// exit code — which is why the counts parse also lives inside this try.
const exitCode = result.status ?? 1;
const ledgerRoot = resolveLedgerRoot(ledgerRootArg);
try {
  const counts = suiteCountsFromGateStdout(gateStdout);
  // The names behind `counts.failed`. Absent, never `[]` — see
  // `failedFilesFromGateStdout`.
  const failedFiles = failedFilesFromGateStdout(gateStdout);
  // Wave-scope sidecar is read from the SAME project dir the event lands in
  // (emitEvent's own destination precedence), so a tmp-scoped run cannot pick
  // up the host repo's live wave. Mirrors the hook's projectDir resolution.
  const waveNumber = resolveWaveNumber(
    ledgerRoot ?? process.env.CLAUDE_PROJECT_DIR ?? process.env.CODEX_PROJECT_DIR ?? repoRoot,
  );
  await emitEvent(
    `orchestrator.quality_gate.${exitCode === 0 ? 'passed' : 'failed'}`,
    {
      variant,
      exit_code: exitCode,
      ...(counts ? { counts } : {}),
      ...(failedFiles ? { failed_files: failedFiles } : {}),
      ...(waveNumber !== null ? { wave_number: waveNumber } : {}),
      ...sessionAttribution(ledgerRoot ?? repoRoot),
    },
    // `{}` is byte-identical to omitting the argument (`opts.repoRoot ??
    // getProjectDir()`), so the default path is untouched.
    ledgerRoot ? { repoRoot: ledgerRoot } : {},
  );
} catch { /* best-effort telemetry — gate result is authoritative */ }

process.exit(exitCode);
