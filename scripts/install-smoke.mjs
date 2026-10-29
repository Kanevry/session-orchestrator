#!/usr/bin/env node
/**
 * install-smoke.mjs — repeatable clean-install smoke for Claude Code and Codex (#1764).
 *
 * WHY: the setup docs claim an install run per release, but the recorded runs
 * proved install only — a session WITH model calls never ran, because an empty
 * profile has no login. Every release makes that record stale again, so this is
 * ONE maintainer command, rerun after each release: install the plugin into an
 * EMPTY profile, check runtime readiness (#1848), then drive bootstrap and a
 * feature session through a model endpoint given only by environment variables.
 * It is a measurement tool for a maintainer, not a CI job.
 *
 * PROFILE ISOLATION: everything lives under one `mkdtemp` root (`home/`,
 * `config/` or `codex/`, `work/`, `tmp/`), and the child environment is built
 * from an ALLOWLIST — never `{...process.env}` — with HOME, USERPROFILE, the
 * XDG dirs and TMPDIR/TEMP/TMP pointing into that root. So no owner config,
 * session identity (CLAUDE_CODE_SESSION_ID), gate or navigator variable of the
 * maintainer's shell reaches the harness under test, and the harness writes
 * its profile, caches and temp files there. The root is deleted at the end;
 * with --keep only its key file is removed.
 *
 * NOT A SANDBOX (residual risk): the model steps pass
 * `--dangerously-skip-permissions` (Claude) and
 * `--dangerously-bypass-approvals-and-sandbox` (Codex), and every tool call
 * runs as the maintainer's OS user. Redirected HOME is not confinement: a tool
 * call can still read or change any file that user can reach by absolute path
 * (other checkouts, ~/.ssh, CLI credentials). Whoever answers the model calls —
 * the endpoint behind SMOKE_*_BASE_URL — and the plugin under test (--source)
 * therefore act with the maintainer's rights. Run it only against an endpoint
 * and a source you trust, or as a separate OS user / in a VM.
 *
 * SECRETS (SEC-008): credentials come only from SMOKE_* env vars and are in no
 * tool call's ENVIRONMENT: Claude Code reads the key through an `apiKeyHelper`
 * that prints a 0600 file in the throwaway root, and Codex gets it as `env_key`
 * with SMOKE_* excluded from its tool shells (a tool's `printenv` saw 0 bytes
 * on both, measured 2026-10-28). Same OS user, so a deliberate read of the key
 * file is not prevented. Every string of the receipt and of the step log is
 * scrubbed of each credential value before it is cut, printed or written.
 *
 * All process starts go through spawnNativeSync (no direct node:child_process).
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isMainModule } from './lib/is-main-module.mjs';
import { spawnNativeSync } from './lib/native-command.mjs';
import { codexInstallRoot } from './runtime-readiness.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_ID = 'session-orchestrator@kanevry';
const HARNESSES = ['claude', 'codex', 'codex-clone'];
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const SHORT_TIMEOUT_MS = 60_000;
const TAIL_CHARS = 400;
const ENV_ALLOWLIST = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'SHELL', 'USER', 'LOGNAME', 'SystemRoot', 'ComSpec', 'PATHEXT'];
const CLAUDE_MODEL_SLOTS = [
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
];

export const EXIT = { pass: 0, usage: 1, system: 2, partial: 3, fail: 4 };

const HELP = `Usage: node scripts/install-smoke.mjs --harness <claude|codex|codex-clone> [options]

Installs session-orchestrator into an EMPTY, throwaway profile and (with a model)
runs bootstrap plus one feature session in a scratch project (#1764).

Options:
  --harness <h>      claude | codex | codex-clone (required)
  --source <s>       owner/repo or a local directory (default Kanevry/session-orchestrator)
  --ref <ref>        git ref (default main)
  --model <id>       model id served by the endpoint; without it model steps are skipped
  --task <text>      feature task for the session step
                     (default "Add a CONTRIBUTING.md that explains how to run the tests")
  --repair           if the install is not runtime-ready, run runtime-readiness --repair
  --no-model         skip the model steps even when credentials are set
  --keep             keep the tmp root (default: delete it)
  --json             print the receipt as JSON on stdout
  --out <file>       also write the receipt JSON to <file>
  --timeout-min <n>  timeout per model step in minutes (default 20; install steps 5)
  --help             show this help

Credentials come ONLY from the environment, never from argv:
  claude:            SMOKE_ANTHROPIC_BASE_URL, SMOKE_ANTHROPIC_API_KEY
  codex/codex-clone: SMOKE_OPENAI_BASE_URL (incl. /v1), SMOKE_OPENAI_API_KEY,
                     optional SMOKE_OPENAI_WIRE_API (default responses)
Missing credentials, --no-model or no --model record the model steps as skipped.

Exit codes:
  0  pass     every step ok
  3  partial  no step failed, at least one skipped
  4  fail     at least one step failed
  1  usage error
  2  system error

Examples:
  node scripts/install-smoke.mjs --harness claude --no-model
  SMOKE_OPENAI_BASE_URL=... SMOKE_OPENAI_API_KEY=... \\
    node scripts/install-smoke.mjs --harness codex --model <id> --json --out smoke.json
`;

class UsageError extends Error {}

/**
 * Parse CLI arguments into options.
 * @param {string[]} argv
 * @returns {object}
 */
export function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        harness: { type: 'string' },
        source: { type: 'string', default: 'Kanevry/session-orchestrator' },
        ref: { type: 'string', default: 'main' },
        model: { type: 'string' },
        task: { type: 'string', default: 'Add a CONTRIBUTING.md that explains how to run the tests' },
        repair: { type: 'boolean', default: false },
        'no-model': { type: 'boolean', default: false },
        keep: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        out: { type: 'string' },
        'timeout-min': { type: 'string', default: '20' },
        help: { type: 'boolean', default: false },
      },
    });
  } catch (error) {
    throw new UsageError(error.message);
  }
  const v = parsed.values;
  if (v.help) return { help: true };
  if (!HARNESSES.includes(v.harness)) throw new UsageError(`--harness must be one of ${HARNESSES.join(', ')}`);
  const timeoutMin = Number(v['timeout-min']);
  if (!Number.isFinite(timeoutMin) || timeoutMin <= 0) throw new UsageError('--timeout-min must be a positive number');
  if (!v.task.trim()) throw new UsageError('--task must not be empty');
  return {
    help: false,
    harness: v.harness,
    source: v.source,
    ref: v.ref,
    model: v.model ?? null,
    task: v.task,
    repair: v.repair,
    noModel: v['no-model'],
    keep: v.keep,
    json: v.json,
    out: v.out ?? null,
    modelTimeoutMs: Math.round(timeoutMin * 60_000),
  };
}

/**
 * Read the model credentials for a harness from the environment.
 * @param {'claude'|'codex'|'codex-clone'} harness
 * @param {Record<string,string|undefined>} env
 * @returns {{baseUrl:string, apiKey:string, wireApi?:string}|null} null when incomplete
 */
export function readCredentials(harness, env = process.env) {
  const pick = (k) => (env[k] || '').trim();
  if (harness === 'claude') {
    const baseUrl = pick('SMOKE_ANTHROPIC_BASE_URL');
    const apiKey = pick('SMOKE_ANTHROPIC_API_KEY');
    return baseUrl && apiKey ? { baseUrl, apiKey } : null;
  }
  const baseUrl = pick('SMOKE_OPENAI_BASE_URL');
  const apiKey = pick('SMOKE_OPENAI_API_KEY');
  return baseUrl && apiKey ? { baseUrl, apiKey, wireApi: pick('SMOKE_OPENAI_WIRE_API') || 'responses' } : null;
}

/**
 * Build the child environment from an allowlist plus explicit isolation values.
 * Never spreads the parent env: inherited ANTHROPIC_*, CLAUDE_CODE_* (incl. the
 * coordinator's CLAUDE_CODE_SESSION_ID), CLAUDECODE, SO_*, NAVIGATOR_* stay out.
 * @param {{harness:string, root:string, parentEnv?:object, model?:string|null, credentials?:object|null}} opts
 * @returns {Record<string,string>}
 */
export function buildChildEnv({ harness, root, parentEnv = process.env, model = null, credentials = null }) {
  const env = {};
  for (const key of ENV_ALLOWLIST) {
    if (typeof parentEnv[key] === 'string' && parentEnv[key] !== '') env[key] = parentEnv[key];
  }
  const home = path.join(root, 'home');
  env.HOME = home;
  // Windows resolves the home through USERPROFILE / APPDATA, not HOME: without
  // these, codex-install stages into the maintainer's real profile (Codex review
  // 2026-10-28). XDG_CACHE_HOME is the plugin-package stage dir on Unix.
  env.USERPROFILE = home;
  env.APPDATA = path.join(home, 'AppData', 'Roaming');
  env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
  env.XDG_CONFIG_HOME = path.join(home, '.config');
  env.XDG_CACHE_HOME = path.join(home, '.cache');
  env.XDG_DATA_HOME = path.join(home, '.local', 'share');
  for (const k of ['TMPDIR', 'TEMP', 'TMP']) env[k] = path.join(root, 'tmp');
  env.DISABLE_AUTOUPDATER = '1';
  // A throwaway profile must not send usage telemetry, and the one-time consent
  // question would end a headless session before it reaches the plan (the
  // session-start hook only skips it under CI, measured 2026-10-28, 5.14.0).
  env.SO_TELEMETRY_DISABLED = '1';
  if (harness === 'claude') {
    env.CLAUDE_CONFIG_DIR = path.join(root, 'config');
    if (model && credentials) {
      // The key reaches Claude Code through `apiKeyHelper` (claudeSettingsJson),
      // never as ANTHROPIC_API_KEY: Claude Code passes its whole environment to
      // every Bash tool call, so one `env` by the model would put the key into
      // the transcript and the model input (seen 2026-10-28 for its messaging token).
      env.ANTHROPIC_BASE_URL = credentials.baseUrl;
      // All four slots: an unset slot names a model the endpoint lacks and
      // Claude Code silently retries for minutes (measured 2026-10-28, 2.1.312).
      for (const slot of CLAUDE_MODEL_SLOTS) env[slot] = model;
    }
  } else {
    env.CODEX_HOME = path.join(root, 'codex');
    if (model && credentials) env.SMOKE_OPENAI_API_KEY = credentials.apiKey;
  }
  return env;
}

/**
 * Claude Code `settings.json` for the throwaway CLAUDE_CONFIG_DIR: the API key
 * comes from `apiKeyHelper`, a command that prints a 0600 key file, so the key
 * is not in any tool call's environment.
 * @param {string} keyFile absolute path inside the throwaway root
 * @returns {string}
 */
export function claudeSettingsJson(keyFile) {
  if (/['\n]/.test(keyFile)) throw new Error('key file path must not contain a quote or newline');
  return `${JSON.stringify({ apiKeyHelper: `cat '${keyFile}'` }, null, 2)}\n`;
}

/**
 * Codex config.toml routing every model call to the smoke endpoint. The key is
 * referenced by env var name only (env_key), never written to disk, and kept
 * out of the tool shells: codex-cli 0.160.1 passes env_key to them (a tool's
 * `printenv` saw it, measured 2026-10-28), so the policy excludes SMOKE_*.
 * @param {{model:string, baseUrl:string, wireApi?:string}} opts
 * @returns {string}
 */
export function codexConfigToml({ model, baseUrl, wireApi = 'responses' }) {
  const q = (s) => JSON.stringify(String(s));
  return [
    `model = ${q(model)}`,
    'model_provider = "smoke"',
    '',
    '[model_providers.smoke]',
    'name = "smoke endpoint"',
    `base_url = ${q(baseUrl)}`,
    'env_key = "SMOKE_OPENAI_API_KEY"',
    `wire_api = ${q(wireApi)}`,
    '',
    '[shell_environment_policy]',
    'exclude = ["SMOKE_*"]',
    '',
  ].join('\n');
}

/**
 * Deep-copy a value replacing every occurrence of each secret in every string
 * with `<redacted>`. Secrets shorter than 4 chars are ignored (they would
 * shred ordinary text without protecting anything).
 * @template T
 * @param {T} value
 * @param {string[]} secrets
 * @returns {T}
 */
export function scrubSecrets(value, secrets) {
  const list = [...new Set(secrets.filter((s) => typeof s === 'string' && s.length >= 4))]
    .sort((a, b) => b.length - a.length);
  const walk = (v) => {
    if (typeof v === 'string') return list.reduce((s, secret) => s.split(secret).join('<redacted>'), v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value);
}

/**
 * Replace the tmp root with `<tmp>` and the home dir with `~` in every string.
 * @template T
 * @param {T} value
 * @param {{roots:string[], home:string}} opts
 * @returns {T}
 */
export function redactPaths(value, { roots, home }) {
  const pairs = [...new Set(roots.filter(Boolean))].sort((a, b) => b.length - a.length).map((r) => [r, '<tmp>']);
  if (home && home.length > 1) pairs.push([home, '~']);
  const walk = (v) => {
    if (typeof v === 'string') return pairs.reduce((s, [from, to]) => s.split(from).join(to), v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value);
}

/**
 * Overall verdict: any failed → fail; else any skipped → partial; else pass.
 * A skipped model step is never folded into pass.
 * @param {{status:string}[]} steps
 * @returns {'pass'|'partial'|'fail'}
 */
export function verdictOf(steps) {
  if (steps.length === 0 || steps.some((s) => s.status === 'failed')) return 'fail';
  if (steps.some((s) => s.status !== 'ok')) return 'partial';
  return 'pass';
}

/**
 * Parse `claude -p --output-format json` stdout, or the `stream-json` form,
 * whose last `type: "result"` line carries the same fields.
 * @param {string} stdout
 * @returns {{ok:boolean, isError:boolean|null, result:string, numTurns:number|null, durationMs:number|null}}
 */
export function parseClaudeResult(stdout) {
  let obj;
  const text = String(stdout || '').trim();
  try { obj = JSON.parse(text); } catch {
    // stream-json, or a log line before the JSON: take the last result line.
    const parsed = jsonLines(text);
    obj = parsed.findLast((o) => o.type === 'result') ?? parsed.at(-1) ?? null;
  }
  if (!obj || typeof obj !== 'object') return { ok: false, isError: null, result: '', numTurns: null, durationMs: null };
  const isError = typeof obj.is_error === 'boolean' ? obj.is_error : null;
  return {
    ok: isError === false,
    isError,
    result: typeof obj.result === 'string' ? obj.result : '',
    numTurns: Number.isFinite(obj.num_turns) ? obj.num_turns : null,
    durationMs: Number.isFinite(obj.duration_ms) ? obj.duration_ms : null,
  };
}

/**
 * Parse `codex exec --json` JSONL output.
 * @param {string} stdout
 * @returns {{finalText:string, turns:number, completed:boolean, failed:boolean, usage:object|null, malformed:number}}
 */
export function parseCodexEvents(stdout) {
  const out = { finalText: '', turns: 0, completed: false, failed: false, usage: null, malformed: 0 };
  for (const line of String(stdout || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let ev;
    try { ev = JSON.parse(t); } catch { out.malformed += 1; continue; }
    if (!ev || typeof ev !== 'object') { out.malformed += 1; continue; }
    if (ev.type === 'turn.started') out.turns += 1;
    else if (ev.type === 'turn.completed') { out.completed = true; out.usage = ev.usage ?? null; }
    else if (ev.type === 'turn.failed' || ev.type === 'error') out.failed = true;
    else if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') {
      out.finalText = ev.item.text;
    }
  }
  return out;
}

/** Claude tools that read instructions; a Write or an Edit naming the path is no read. */
const READ_TOOLS = new Set(['Skill', 'Read', 'Bash']);

/** Output of a shell read that found nothing. */
const NOT_FOUND_RE = /no such file|not found|cannot open|does not exist/i;

/**
 * Every JSON object line of a JSONL stream; other lines are skipped.
 * @param {string} text
 * @returns {object[]}
 */
function jsonLines(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { const o = JSON.parse(t); if (o && typeof o === 'object') out.push(o); } catch { /* not JSON */ }
  }
  return out;
}

/**
 * How many tool calls of a model run opened the plugin's own instructions —
 * the evidence that the harness routed the command to the plugin, rather than
 * the model acting on the words of the prompt. Measured 2026-10-28 (5.14.0,
 * codex-cli 0.160.1): `$session-orchestrator:session feature <task>` finished
 * rc 0 having written the task's file, with no plan — exit code and final text
 * alone could not tell that apart from a session that followed the skill.
 * Claude `stream-json`: `tool_use` blocks (a Skill call or a Read). Codex
 * `--json`: completed items other than the agent's own messages and reasoning.
 * @param {string} stdout
 * @param {'claude'|'codex'|'codex-clone'} harness
 * @param {string[]} needles fragments such as `skills/session-start/`, `:session-start`
 * @returns {number}
 */
export function skillEvidence(stdout, harness, needles) {
  const hit = (value) => {
    const s = JSON.stringify(value ?? '');
    return needles.some((n) => s.includes(n));
  };
  const events = jsonLines(stdout);
  let count = 0;
  if (harness === 'claude') {
    // Only instruction-reading calls whose tool_result came back and was not an
    // error: a call without a result, or a failed Read, read nothing (Codex
    // reviews 2026-10-28). Successful results carry no is_error at all.
    const succeeded = new Set();
    for (const ev of events) {
      for (const block of Array.isArray(ev.message?.content) ? ev.message.content : []) {
        if (block?.type === 'tool_result' && block.is_error !== true) succeeded.add(block.tool_use_id);
      }
    }
    for (const ev of events) {
      if (ev.type !== 'assistant' || !Array.isArray(ev.message?.content)) continue;
      for (const block of ev.message.content) {
        if (block?.type === 'tool_use' && READ_TOOLS.has(block.name) && succeeded.has(block.id) && hit(block.input)) count += 1;
      }
    }
    return count;
  }
  for (const ev of events) {
    const item = ev.type === 'item.completed' ? ev.item : null;
    if (!item || ['agent_message', 'reasoning'].includes(item.type)) continue;
    // A command that exited non-zero read nothing; neither did one whose
    // output is a "not found" message behind a masking `; true`. A heuristic:
    // a read that fails without saying so in its output still counts.
    if (item.type === 'command_execution'
      && (item.exit_code !== 0 || NOT_FOUND_RE.test(String(item.aggregated_output ?? '')))) continue;
    if (hit(item)) count += 1;
  }
  return count;
}

/**
 * Credential values of the running smoke. `tail()` scrubs with them BEFORE it
 * cuts: a key straddling the cut would otherwise survive as an unmatched
 * suffix (48 of 49 characters in a review reproduction, 2026-10-28). Set and
 * cleared by runSmoke(); the receipt is scrubbed once more as a whole.
 */
let activeSecrets = [];

/**
 * The last `n` characters of `s`, scrubbed of `secrets` BEFORE the cut.
 * @param {unknown} s
 * @param {number} n
 * @param {string[]} secrets
 * @returns {string}
 */
export function clipScrubbed(s, n, secrets) {
  const str = scrubSecrets(String(s ?? ''), secrets);
  return str.length > n ? str.slice(-n) : str;
}

function tail(s, n = TAIL_CHARS) {
  return clipScrubbed(s, n, activeSecrets);
}

function run(cmd, args, { cwd, env, timeoutMs }) {
  const started = Date.now();
  const r = spawnNativeSync(cmd, args, {
    cwd, env, input: '', encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024,
  });
  const timedOut = r.error?.code === 'ETIMEDOUT';
  return {
    rc: typeof r.status === 'number' ? r.status : null,
    stdout: r.stdout ?? '', stderr: r.stderr ?? '',
    ms: Date.now() - started, timedOut,
    error: r.error && !timedOut ? (r.error.code || r.error.message) : null,
  };
}

function failDetail(r) {
  if (r.timedOut) return 'timed out';
  if (r.error) return `spawn error: ${r.error}`;
  return `rc ${r.rc}: ${tail((r.stderr || '').trim() || (r.stdout || '').trim(), 300)}`;
}

function parseJson(text) {
  try { return JSON.parse(String(text).trim()); } catch {
    const lines = String(text).trim().split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      try { return JSON.parse(lines.slice(i).join('\n')); } catch { /* try a shorter suffix */ }
    }
    return null;
  }
}

function isLocalDir(source) {
  return existsSync(source);
}

function pickPath(entry) {
  if (!entry || typeof entry !== 'object') return null;
  for (const k of ['installPath', 'installedPath', 'path', 'root']) if (typeof entry[k] === 'string') return entry[k];
  return null;
}

/** Steps recorder: each step `{id,status,rc,ms,detail,...extra}`. */
function makeRecorder(steps, log) {
  return (id, status, r, detail, extra = {}) => {
    const step = { id, status, rc: r?.rc ?? null, ms: r?.ms ?? 0, detail: detail ?? '', ...extra };
    if (r?.timedOut) step.timedOut = true;
    steps.push(step);
    log(step);
    return step;
  };
}

function installClaude(ctx) {
  const { opts, env, root, record } = ctx;
  let source = opts.source;
  if (isLocalDir(source)) source = path.resolve(source);
  else if (opts.ref !== 'main') source = `https://github.com/${source}.git#${opts.ref}`;
  let r = run('claude', ['plugin', 'marketplace', 'add', source], { cwd: root, env, timeoutMs: INSTALL_TIMEOUT_MS });
  if (r.rc !== 0) return record('marketplace-add', 'failed', r, failDetail(r)) && false;
  record('marketplace-add', 'ok', r, source);
  r = run('claude', ['plugin', 'install', PLUGIN_ID], { cwd: root, env, timeoutMs: INSTALL_TIMEOUT_MS });
  if (r.rc !== 0) return record('plugin-install', 'failed', r, failDetail(r)) && false;
  const list = run('claude', ['plugin', 'list', '--json'], { cwd: root, env, timeoutMs: SHORT_TIMEOUT_MS });
  const arr = parseJson(list.stdout);
  const entry = Array.isArray(arr) ? arr.find((e) => String(e?.id || '').startsWith('session-orchestrator@')) : null;
  if (!entry) return record('plugin-install', 'failed', r, `plugin not listed after install: ${failDetail(list)}`) && false;
  ctx.plugin = { version: entry.version ?? null, installPath: pickPath(entry) };
  record('plugin-install', entry.enabled === false ? 'failed' : 'ok', r, `${entry.id} ${entry.version ?? '?'}${entry.enabled === false ? ' (disabled)' : ''}`);
  return entry.enabled !== false;
}

function installCodex(ctx) {
  const { opts, env, root, record } = ctx;
  const local = isLocalDir(opts.source);
  const args = ['plugin', 'marketplace', 'add', local ? path.resolve(opts.source) : opts.source];
  if (!local) args.push('--ref', opts.ref);
  let r = run('codex', args, { cwd: root, env, timeoutMs: INSTALL_TIMEOUT_MS });
  if (r.rc !== 0) return record('marketplace-add', 'failed', r, failDetail(r)) && false;
  record('marketplace-add', 'ok', r, args.slice(3).join(' '));
  r = run('codex', ['plugin', 'add', PLUGIN_ID, '--json'], { cwd: root, env, timeoutMs: INSTALL_TIMEOUT_MS });
  const added = parseJson(r.stdout);
  if (r.rc !== 0 || !added) return record('plugin-install', 'failed', r, failDetail(r)) && false;
  ctx.plugin = { version: added.version ?? null, installPath: added.installedPath ?? null };
  record('plugin-install', 'ok', r, `${added.pluginId ?? PLUGIN_ID} ${added.version ?? '?'}`);
  return true;
}

function installCodexClone(ctx) {
  const { opts, env, root, record } = ctx;
  const dir = path.join(root, 'clone');
  let r;
  if (isLocalDir(opts.source)) {
    const started = Date.now();
    const src = path.resolve(opts.source);
    cpSync(src, dir, { recursive: true, filter: (p) => !/[\\/](node_modules|\.git)$/.test(p) });
    r = { rc: 0, ms: Date.now() - started };
    record('clone', 'ok', r, `copied ${src}`);
  } else {
    const url = `https://github.com/${opts.source}.git`;
    r = run('git', ['clone', '--depth', '1', '--branch', opts.ref, url, dir], { cwd: root, env, timeoutMs: INSTALL_TIMEOUT_MS });
    if (r.rc !== 0) return record('clone', 'failed', r, failDetail(r)) && false;
    record('clone', 'ok', r, `${url}#${opts.ref}`);
  }
  r = run('npm', ['ci', '--ignore-scripts'], { cwd: dir, env, timeoutMs: INSTALL_TIMEOUT_MS });
  if (r.rc !== 0) return record('npm-ci', 'failed', r, failDetail(r)) && false;
  record('npm-ci', 'ok', r, 'npm ci --ignore-scripts');
  r = run(process.execPath, ['scripts/codex-install.mjs', '--json'], { cwd: dir, env, timeoutMs: INSTALL_TIMEOUT_MS });
  const res = parseJson(r.stdout);
  if (r.rc !== 0 || !res?.ok) return record('codex-install', 'failed', r, failDetail(r)) && false;
  const list = parseJson(run('codex', ['plugin', 'list', '--json'], { cwd: root, env, timeoutMs: SHORT_TIMEOUT_MS }).stdout);
  const entry = Array.isArray(list?.installed) ? list.installed.find((e) => e?.name === 'session-orchestrator') : null;
  // `codex plugin list --json` carries no install path; the cache dir is derived
  // from marketplace + version. Never fall back to the clone: it has its own
  // node_modules after `npm ci` and would measure a cache Codex never loads.
  let installPath = null;
  try { installPath = codexInstallRoot(list, env.CODEX_HOME).root; } catch { /* readiness records 'no install path' */ }
  ctx.plugin = { version: res.pluginVersion ?? entry?.version ?? null, installPath };
  record('codex-install', 'ok', r, `${res.pluginId ?? PLUGIN_ID} ${res.pluginVersion ?? '?'}`);
  return true;
}

function readiness(ctx) {
  const { env, root, record, opts } = ctx;
  const cli = path.join(REPO_ROOT, 'scripts', 'runtime-readiness.mjs');
  const target = ctx.plugin?.installPath;
  if (!target) { record('readiness', 'failed', null, 'no install path recorded'); return; }
  if (!existsSync(cli)) { record('readiness', 'failed', null, 'runtime-readiness.mjs missing in this checkout'); return; }
  const r = run(process.execPath, [cli, '--root', target, '--json'], { cwd: root, env, timeoutMs: INSTALL_TIMEOUT_MS });
  const res = parseJson(r.stdout);
  if (!res || (r.rc !== 0 && r.rc !== 3)) { record('readiness', 'failed', r, failDetail(r)); return; }
  const extra = { ready: res.ready === true, missing: res.missing?.length ?? null, declared: res.declared?.length ?? null };
  record('readiness', extra.ready ? 'ok' : 'failed', r,
    extra.ready ? `ready (${extra.declared} declared)` : `not ready: missing ${extra.missing}/${extra.declared}`, extra);
  if (extra.ready || !opts.repair) return;
  const rr = run(process.execPath, [cli, '--root', target, '--repair', '--json'], { cwd: root, env, timeoutMs: INSTALL_TIMEOUT_MS });
  const rep = parseJson(rr.stdout);
  if (!rep) { record('repair', 'failed', rr, failDetail(rr)); return; }
  const after = { ready: rep.ready === true, missing: rep.missing?.length ?? null };
  const before = rep.repaired?.before
    ? { ready: rep.repaired.before.ready === true, missing: rep.repaired.before.missing?.length ?? null }
    : { ready: extra.ready, missing: extra.missing };
  record('repair', after.ready ? 'ok' : 'failed', rr, `missing ${before.missing} -> ${after.missing}`, { before, after });
}

function scratch(ctx) {
  const { env, work, record } = ctx;
  const started = Date.now();
  writeFileSync(path.join(work, 'README.md'), '# smoke-app\n\nThrowaway project for the install smoke.\n');
  writeFileSync(path.join(work, 'package.json'),
    `${JSON.stringify({ name: 'smoke-app', private: true, scripts: { test: 'node --test' } }, null, 2)}\n`);
  writeFileSync(path.join(work, 'index.js'), 'export function add(a, b) {\n  return a + b;\n}\n');
  writeFileSync(path.join(work, 'index.test.js'),
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './index.js';\n\n"
    + "test('add', () => {\n  assert.equal(add(1, 2), 3);\n});\n");
  const git = (args) => run('git', args, { cwd: work, env, timeoutMs: SHORT_TIMEOUT_MS });
  for (const args of [['init', '-q'], ['add', '-A'],
    ['-c', 'user.name=smoke', '-c', 'user.email=smoke@example.org', 'commit', '-q', '-m', 'init']]) {
    const r = git(args);
    if (r.rc !== 0) { record('scratch', 'failed', r, `git ${args.at(-1)}: ${failDetail(r)}`); return false; }
  }
  record('scratch', 'ok', { rc: 0, ms: Date.now() - started }, 'git repo with README, package.json, index(.test).js');
  return true;
}

/**
 * One model turn. `resume: true` continues the most recent conversation of the
 * throwaway profile (Claude `-c`, Codex `exec resume --last`) — how an operator
 * answers a question the session asked.
 */
function modelCall(ctx, prompt, { resume = false } = {}) {
  const { opts, env, work } = ctx;
  // Dangerous-permission flags: safe ONLY because cwd (work/) and HOME/config
  // all live in the throwaway tmp root — see header.
  if (opts.harness === 'claude') {
    // stream-json (needs --verbose) carries the tool calls skillEvidence() reads.
    const r = run('claude', [...(resume ? ['-c'] : []), '-p', prompt, '--model', opts.model, '--output-format', 'stream-json',
      '--verbose', '--dangerously-skip-permissions'], { cwd: work, env, timeoutMs: opts.modelTimeoutMs });
    const p = parseClaudeResult(r.stdout);
    return { r, ok: r.rc === 0 && p.isError === false, text: p.result, numTurns: p.numTurns, durationMs: p.durationMs };
  }
  // --dangerously-bypass-hook-trust: a fresh CODEX_HOME holds no hook trust, so
  // without it the plugin's own hooks never run and the smoke would measure the
  // plugin without them. The hook source is the plugin under test.
  const r = run('codex', ['exec', ...(resume ? ['resume', '--last'] : []), '--skip-git-repo-check', '--json',
    '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', prompt],
  { cwd: work, env, timeoutMs: opts.modelTimeoutMs });
  const p = parseCodexEvents(r.stdout);
  return { r, ok: r.rc === 0 && !p.failed && p.completed, text: p.finalText, numTurns: p.turns, durationMs: null };
}

/**
 * Files the plugin itself writes before a plan: its state directories, and the
 * instruction file, where session-start Phase 1.1 records the one-time
 * Dispatcher Autonomy answer (measured 2026-10-28, Claude Code 2.1.312).
 */
const STATE_PATH_RE = /^(?:(?:\.orchestrator|\.claude|\.codex|\.cursor|\.pi|\.agents)\/|(?:CLAUDE|AGENTS)\.md$)/;

/**
 * Project files a model step left changed or new in the scratch repo, outside
 * the plugin's own state directories (`git status --porcelain` paths).
 * @param {string} porcelain
 * @returns {string[]}
 */
export function projectChanges(porcelain) {
  return String(porcelain || '').split('\n')
    .map((l) => l.slice(3).trim().replace(/^"|"$/g, ''))
    .map((p) => (p.includes(' -> ') ? p.split(' -> ').pop() : p))
    .filter((p) => p && !STATE_PATH_RE.test(p));
}

function gitInWork(ctx, args) {
  return run('git', ['-c', 'user.name=smoke', '-c', 'user.email=smoke@example.org', ...args],
    { cwd: ctx.work, env: ctx.env, timeoutMs: SHORT_TIMEOUT_MS });
}

function verifyBootstrap(work, harness) {
  const problems = [];
  const lockPath = path.join(work, '.orchestrator', 'bootstrap.lock');
  const lock = existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : null;
  if (lock === null) problems.push('.orchestrator/bootstrap.lock missing');
  else {
    if (!/^\s*version:/m.test(lock)) problems.push('bootstrap.lock lacks version:');
    if (!/^\s*tier:/m.test(lock)) problems.push('bootstrap.lock lacks tier:');
  }
  const candidates = harness === 'claude' ? ['CLAUDE.md'] : ['AGENTS.md', 'CLAUDE.md'];
  const hasConfig = candidates.some((f) => {
    const p = path.join(work, f);
    return existsSync(p) && readFileSync(p, 'utf8').includes('## Session Config');
  });
  if (!hasConfig) problems.push(`${candidates.join(' or ')} lacks ## Session Config`);
  return problems;
}

function modelSteps(ctx, skipReason) {
  const { opts, record, work } = ctx;
  const ns = opts.harness === 'claude' ? '/session-orchestrator' : '$session-orchestrator';
  if (skipReason) {
    record('bootstrap', 'skipped', null, skipReason);
    record('session', 'skipped', null, skipReason);
    return;
  }
  const b = modelCall(ctx, `${ns}:bootstrap --fast --no-interview`);
  const problems = b.ok ? verifyBootstrap(work, opts.harness) : [];
  const bExtra = {
    numTurns: b.numTurns, skillEvidence: skillEvidence(b.r.stdout, opts.harness, ['skills/bootstrap/', ':bootstrap']),
  };
  if (!b.ok) record('bootstrap', 'failed', b.r, b.r.rc === 0 ? `model reported error: ${tail(b.text, 300)}` : failDetail(b.r), bExtra);
  else if (problems.length) record('bootstrap', 'failed', b.r, problems.join('; '), bExtra);
  else record('bootstrap', 'ok', b.r, 'bootstrap.lock + Session Config present', bExtra);
  // Commit what bootstrap wrote, so the session step's own changes stand alone;
  // its SHA is the baseline — a model that COMMITS its implementation leaves a
  // clean `git status` (Codex review 2026-10-28), so committed changes count too.
  gitInWork(ctx, ['add', '-A']);
  gitInWork(ctx, ['commit', '-q', '--allow-empty', '-m', 'bootstrap']);
  const baseline = (gitInWork(ctx, ['rev-parse', 'HEAD']).stdout || '').trim();
  // A session ends at its plan and waits for /go. Before that it may ask the
  // operator questions; the smoke answers each with "1" (option 1 is the
  // recommended one by convention) and records what was asked. It never
  // answers past a SEC-008 detector hit: the session then stopped for an
  // incident, not for a choice (review 2026-10-28).
  const needles = ['skills/session-start/', ':session-start', 'commands/session.md'];
  let s = modelCall(ctx, `${ns}:session feature ${opts.task}`);
  let evidence = skillEvidence(s.r.stdout, opts.harness, needles);
  let ms = s.r.ms;
  const answered = [];
  let state = workState(ctx, baseline);
  let hits = secretHits(ctx);
  while (s.ok && !state.unreadable && !state.changed.length && !hits && !reachedGo(s.text)
    && answered.length < MAX_ANSWERS) {
    answered.push(tail(String(s.text || ''), 200));
    s = modelCall(ctx, '1', { resume: true });
    evidence += skillEvidence(s.r.stdout, opts.harness, needles);
    ms += s.r.ms;
    state = workState(ctx, baseline);
    hits = secretHits(ctx);
  }
  const text = String(s.text || '');
  const r = { ...s.r, ms };
  const extra = {
    skillEvidence: evidence, answered, projectFilesChanged: state.changed.slice(0, 10), reachedGo: reachedGo(text),
    numTurns: s.numTurns, finalTextTail: tail(text),
  };
  // A run that changed project files, never opened the session skill, stopped
  // on a leaked secret or never got to /go did not follow the session
  // protocol, whatever its exit code.
  if (!s.ok) record('session', 'failed', r, s.r.rc === 0 ? 'model reported error' : failDetail(s.r), extra);
  else if (state.unreadable) record('session', 'failed', r, `could not read the scratch repo's git state: ${state.unreadable}`, extra);
  else if (state.changed.length) record('session', 'failed', r, `changed project files before a plan was approved: ${state.changed.slice(0, 5).join(', ')}`, extra);
  else if (hits) record('session', 'failed', r, `stopped after ${hits} SEC-008 detector hit(s); not answered further`, extra);
  else if (evidence === 0) record('session', 'failed', r, 'no tool call opened the session-start skill', extra);
  else if (!extra.reachedGo) record('session', 'failed', r, `no plan offering /go after ${answered.length} answered question(s)`, extra);
  else record('session', 'ok', r, `plan offers /go after ${answered.length} answered question(s); ${evidence} skill reads`, extra);
}

/**
 * Project files the session changed since the post-bootstrap baseline commit:
 * uncommitted (`git status`) plus committed (`git diff baseline..HEAD`). A git
 * command that fails is reported as unreadable — never as "nothing changed".
 * @returns {{ changed: string[], unreadable: string|null }}
 */
function workState(ctx, baseline) {
  const st = gitInWork(ctx, ['status', '--porcelain', '--untracked-files=all']);
  if (st.rc !== 0) return { changed: [], unreadable: `git status ${failDetail(st)}` };
  if (!baseline) return { changed: [], unreadable: 'no baseline commit after bootstrap' };
  const diff = gitInWork(ctx, ['diff', '--name-only', `${baseline}..HEAD`]);
  if (diff.rc !== 0) return { changed: [], unreadable: `git diff ${failDetail(diff)}` };
  const committed = String(diff.stdout || '').split('\n').map((p) => p.trim()).filter((p) => p && !STATE_PATH_RE.test(p));
  return { changed: [...new Set([...projectChanges(st.stdout), ...committed])], unreadable: null };
}

/** SEC-008 detector hits so far in the scratch repo (0 when no ledger exists yet). */
function secretHits(ctx) {
  const file = path.join(ctx.work, '.orchestrator', 'metrics', 'events.jsonl'); // ledger-root: the scratch repo is a fresh `git init`, never a linked worktree
  return secretEmittedFrom(existsSync(file) ? readFileSync(file, 'utf8') : null)?.count ?? 0;
}

/**
 * The plugin's SEC-008 value detector (hooks/post-bash-write-verify.mjs) logs
 * `orchestrator.security.secret_emitted` when a Bash output carried the value
 * of a secret-named env var. Names only, never values. Measured 2026-10-28:
 * 2 of 5 Claude Code runs printed the session's CLAUDE_CODE_MESSAGING_TOKEN.
 * @param {string|null} eventsText the scratch repo's events.jsonl, null if absent
 * @returns {{count:number, envKeys:string[]}|null} null = no ledger, not measured
 */
export function secretEmittedFrom(eventsText) {
  if (eventsText === null) return null;
  const hits = jsonLines(eventsText).filter((e) => e.event === 'orchestrator.security.secret_emitted');
  const envKeys = [...new Set(hits.flatMap((e) => (Array.isArray(e.env_keys) ? e.env_keys : [])))].sort();
  return { count: hits.length, envKeys };
}

function secretHygiene(ctx) {
  const file = path.join(ctx.work, '.orchestrator', 'metrics', 'events.jsonl'); // ledger-root: the scratch repo is a fresh `git init`, never a linked worktree
  const found = secretEmittedFrom(existsSync(file) ? readFileSync(file, 'utf8') : null);
  if (found === null) ctx.record('secret-hygiene', 'skipped', null, 'no events ledger in the scratch repo (hooks did not log)');
  else if (found.count) ctx.record('secret-hygiene', 'failed', null, `${found.count} SEC-008 detector hit(s): ${found.envKeys.join(', ')}`, found);
  else ctx.record('secret-hygiene', 'ok', null, 'no SEC-008 detector hit', found);
}

/** Answers the smoke gives to one-time questions before it gives up. */
const MAX_ANSWERS = 3;

/**
 * True when the text is a plan handed over to the execute step: session-plan
 * prints its plan (mission status / wave plan / execution config) and ends
 * with "Use /go to begin." (`$session-orchestrator:go` on Codex). A mention of
 * /go alone is not enough (review 2026-10-28): "Do not run /go yet" and a
 * numbered question that mentions /go are not a hand-over. A heuristic over
 * model prose — its ceiling: a plan worded without any of the plan markers
 * reads as "no plan", and the receipt's finalTextTail lets a human check.
 * @param {string} text
 * @returns {boolean}
 */
export function reachedGo(text) {
  const all = String(text || '');
  const end = all.slice(-600);
  const GO = String.raw`(?:\/go|\/session-orchestrator:go|\$session-orchestrator:go)\b`;
  // An affirmative invitation right before the command ("Use /go", "Send
  // `/go`", "Starte ihn mit `/go`"), not a mention ("Before /go, choose …").
  const go = new RegExp(String.raw`\b(?:use|send|run|type|start|starte|nutze|tippe|mit)\b[^.?\n;]{0,20}?[\s\`'"(*]${GO}`, 'i').test(end);
  const plan = /mission-status|wave[- ]plan|execution config|^#{2,4} wave\b/im.test(all);
  const asks = /\b(?:reply|answer|respond|antworte)\b[^\n]{0,40}\b1\b/i.test(end) || /\?\s*$/.test(end);
  // A negation counts only inside the clause that names the command, so
  // "Do not change files yet; use /go" stays a hand-over.
  const negated = new RegExp(String.raw`\b(?:do not|don't|not yet|noch nicht|nicht)\b[^.;,\n]{0,30}${GO}`, 'i').test(end);
  return go && plan && !asks && !negated;
}

function toolVersion(ctx) {
  const name = ctx.opts.harness === 'claude' ? 'claude' : 'codex';
  const r = run(name, ['--version'], { cwd: ctx.root, env: ctx.env, timeoutMs: SHORT_TIMEOUT_MS });
  const version = (r.stdout || '').trim().split('\n')[0] || null;
  ctx.tool = { name, version };
  if (r.rc !== 0) { ctx.record('tool-version', 'failed', r, failDetail(r)); return false; }
  ctx.record('tool-version', 'ok', r, version);
  return true;
}

/**
 * Run the smoke and return the (already scrubbed) receipt.
 * @param {object} opts parsed options
 * @param {{env?:object, log?:(step:object)=>void}} [io]
 * @returns {object}
 */
export function runSmoke(opts, { env: parentEnv = process.env, log = () => {} } = {}) {
  const credentials = readCredentials(opts.harness, parentEnv);
  let skipReason = null;
  if (opts.noModel || !opts.model) skipReason = 'no-model-flag';
  else if (!credentials) skipReason = 'no-model-credentials';
  const secrets = credentials ? [credentials.apiKey, credentials.baseUrl] : [];
  const steps = [];
  const root = mkdtempSync(path.join(os.tmpdir(), 'so-install-smoke-'));
  let realRoot = root;
  try { realRoot = realpathSync(root); } catch { /* keep root */ }
  const ctx = {
    opts, root, work: path.join(root, 'work'), plugin: { version: null, installPath: null }, tool: { name: null, version: null },
    env: buildChildEnv({ harness: opts.harness, root, parentEnv, model: skipReason ? null : opts.model, credentials: skipReason ? null : credentials }),
    record: makeRecorder(steps, (s) => log(scrubSecrets(redactPaths(s, { roots: [root, realRoot], home: os.homedir() }), secrets))),
  };
  activeSecrets = secrets;
  try {
    for (const d of ['home/.config', 'home/.cache', 'tmp', 'work', opts.harness === 'claude' ? 'config' : 'codex']) {
      mkdirSync(path.join(root, d), { recursive: true });
    }
    if (opts.harness === 'claude' && !skipReason) {
      mkdirSync(path.join(root, 'secret'), { mode: 0o700 });
      const keyFile = path.join(root, 'secret', 'api-key');
      writeFileSync(keyFile, credentials.apiKey, { mode: 0o600 });
      writeFileSync(path.join(root, 'config', 'settings.json'), claudeSettingsJson(keyFile));
    } else if (opts.harness !== 'claude' && !skipReason) {
      writeFileSync(path.join(root, 'codex', 'config.toml'),
        codexConfigToml({ model: opts.model, baseUrl: credentials.baseUrl, wireApi: credentials.wireApi }));
    }
    const installers = { claude: installClaude, codex: installCodex, 'codex-clone': installCodexClone };
    if (toolVersion(ctx) && installers[opts.harness](ctx)) {
      readiness(ctx);
      if (scratch(ctx)) {
        modelSteps(ctx, skipReason);
        if (!skipReason) secretHygiene(ctx);
      }
    }
  } catch (error) {
    ctx.record('internal', 'failed', null, `${error.code ?? error.name}: ${error.message}`);
  } finally {
    activeSecrets = [];
    // --keep keeps the profile for inspection, never the key file.
    rmSync(opts.keep ? path.join(root, 'secret') : root, { recursive: true, force: true });
  }
  const receipt = {
    schema: 1,
    harness: opts.harness,
    date: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch, release: os.release(), node: process.version },
    tool: ctx.tool,
    source: opts.source,
    ref: opts.ref,
    plugin: ctx.plugin,
    model: skipReason ? null : opts.model,
    // Set in every child (buildChildEnv); named here so a reader of the receipt
    // knows the run never met the telemetry consent question.
    env: { SO_TELEMETRY_DISABLED: '1' },
    // The permission flags of every model step (see modelCall), so a reader
    // knows the Codex run ran the plugin's hooks without persisted trust.
    modelFlags: opts.harness === 'claude'
      ? ['--dangerously-skip-permissions']
      : ['--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust'],
    steps,
    verdict: verdictOf(steps),
  };
  const out = scrubSecrets(redactPaths(receipt, { roots: [root, realRoot], home: os.homedir() }), secrets);
  // After redaction: `<tmp>` would not tell the operator where the kept profile is.
  if (opts.keep) out.kept = root;
  return out;
}

function formatStep(s) {
  return `${s.status.padEnd(7)} ${s.id.padEnd(16)} ${String(s.ms).padStart(7)}ms  ${s.detail}`;
}

async function main(argv) {
  let opts;
  try { opts = parseCli(argv); } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`install-smoke: ${error.message}\n\n${HELP}`);
      return EXIT.usage;
    }
    throw error;
  }
  if (opts.help) { process.stdout.write(HELP); return EXIT.pass; }
  const log = opts.json ? (s) => process.stderr.write(`${formatStep(s)}\n`) : (s) => process.stdout.write(`${formatStep(s)}\n`);
  const receipt = runSmoke(opts, { log });
  const json = `${JSON.stringify(receipt, null, 2)}\n`;
  if (opts.out) writeFileSync(opts.out, json);
  if (opts.json) process.stdout.write(json);
  else process.stdout.write(`verdict: ${receipt.verdict}${receipt.kept ? ` (kept ${receipt.kept})` : ''}\n`);
  return EXIT[receipt.verdict];
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`install-smoke: system error: ${error.message}\n`);
    process.exitCode = EXIT.system;
  });
}
