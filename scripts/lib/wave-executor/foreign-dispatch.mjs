/**
 * foreign-dispatch.mjs — dispatch a wave subagent to a FOREIGN model over the
 * Cursor channel (`cursor-agent`), in a detached git worktree, and measure the
 * result at the filesystem rather than from the model's own prose (#1150).
 *
 * Why this module exists rather than a shell wrapper:
 *   - `never_foreign` (the hard role lock in account-switch
 *     `tools/routing/routing.yaml`) is enforced by NOTHING on the Cursor
 *     channel — `dispatch-cursor.sh` does not read it. This adapter is the only
 *     enforcement point for a foreign dispatch that goes through here.
 *   - `dispatch-cursor.sh` keeps its stream log in a `mktemp` file deleted by a
 *     shell trap and surfaces only the last 20 stdout lines. A supervising
 *     Claude reviewer needs the whole stream, so we spawn `cursor-agent`
 *     directly and keep the log.
 *   - A Bash child process fires no `SubagentStop` hook, so wave telemetry
 *     cannot see a foreign dispatch at all. The
 *     `orchestrator.foreign_dispatch.completed` event emitted here is that
 *     replacement signal.
 *
 * Supervision is NOT optional: `routing.yaml` records
 * `foreign_impl_supervision_required: claude-review` because a measured
 * foreign implementation was test-green and semantically wrong. This module
 * returns the diff so a Claude reviewer can read it; it never merges anything.
 *
 * ## Containment: the worktree is NOT a boundary
 *
 * A linked git worktree isolates the working TREE and nothing else. Measured
 * 2026-08-25 in this repo: `git config --get core.hooksPath` →
 * `<repo>/.husky/_`, and `rev-parse --git-common-dir` → `.git` — both resolve
 * to the operator's REAL repository from inside any linked worktree. A foreign
 * model running with write+shell access there can therefore write a git hook
 * that executes on the coordinator's NEXT commit, and every review surface this
 * module offers is blind to it: `result.diff` only covers paths inside the
 * worktree, `git status` ignores a gitignored hooks directory, and the
 * telemetry event counts `changed_files` only. Three defences answer that, all
 * local to this module:
 *
 *   1. `--sandbox enabled` in the argv (see {@link FOREIGN_AGENT_BASE_ARGS}).
 *   2. An ALLOWLISTED child environment, never `process.env` inheritance
 *      (see {@link FOREIGN_ENV_ALLOWLIST}).
 *   3. A before/after fingerprint of the effective hooks directory, surfaced as
 *      `hookTampering` on the envelope so the reviewer has a mechanical signal
 *      rather than an eyeball pass over a diff that structurally cannot show it.
 *
 * None of the three is sufficient alone, and the caller is expected to read
 * `hookTampering` — a `true` there invalidates the run regardless of `ok`.
 */

import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { emitEvent, sessionAttribution } from '../events.mjs';
import { isPathInside } from '../path-utils.mjs';

/**
 * Roles that may NEVER run on a foreign model. Copied verbatim from
 * account-switch `tools/routing/routing.yaml` § never_foreign (read 2026-08-25).
 * Keep in sync by hand — the YAML lives in a different repo and is parsed there
 * by awk, not by a shared library.
 * @type {readonly string[]}
 */
export const NEVER_FOREIGN_ROLES = Object.freeze([
  'impl-core',
  'security-review',
  'migration',
  'release',
  'secrets',
  'incident',
  'refactor-crosscut',
]);

/** Default wall-clock budget for one foreign dispatch, in seconds.
 * This is a FLOOR, not a suggestion: measured 2026-08-23, `cursor-grok-4.6-high`
 * ran 2 of 3 hard-test tasks past a 540 s cap (recorded as DNF). Lowering this
 * manufactures timeouts and reads as model failure. */
export const DEFAULT_TIMEOUT_SEC = 900;

/**
 * Grace period between SIGTERM and SIGKILL, in ms.
 *
 * `child.kill('SIGTERM')` is a REQUEST: a child that installs a handler and
 * ignores it never emits `close`, and this module's only resolve paths are
 * `close` and `error` — so without escalation a wedged `cursor-agent` hangs
 * `dispatchForeign` forever and takes the whole wave with it. SIGKILL is not
 * catchable, so the escalation always terminates.
 *
 * Named ceiling (BV-004): 10 s is enough for a cooperative child to flush its
 * stream-json tail and exit. Revisit if a well-behaved `cursor-agent` is ever
 * measured needing longer than that to shut down — raise the constant, never
 * drop the escalation.
 */
export const DEFAULT_KILL_GRACE_MS = 10_000;

/**
 * argv prefix for every foreign dispatch, ahead of `--model`/`--output-format`.
 *
 * `--sandbox enabled` is load-bearing, not decoration. Measured against
 * `cursor-agent --help` (2026-08-25): `--sandbox <mode>` exists with
 * `(choices: "enabled", "disabled")` and is documented as "Explicitly enable or
 * disable sandbox mode (overrides config)". It is a DIFFERENT axis from
 * `--force` ("Force allow commands unless explicitly denied", alias `--yolo`):
 * `--force` governs whether a tool call is auto-approved, `--sandbox` governs
 * what an approved call may reach. The two compose — auto-approved AND confined
 * — which is why `--force` can stay without leaving the run at full yolo.
 *
 * Named ceiling (BV-004): the flag's EXISTENCE is measured; the sandbox's
 * confinement SEMANTICS are not, because verifying them requires spawning the
 * real binary against a live account. Revisit trigger: if a foreign dispatch is
 * ever observed writing outside its worktree despite this flag, the sandbox is
 * not the boundary it is assumed to be here and the `hookTampering` check below
 * becomes the only defence rather than the backstop.
 * @type {readonly string[]}
 */
export const FOREIGN_AGENT_BASE_ARGS = Object.freeze([
  '--print',
  '--force',
  '--sandbox',
  'enabled',
]);

/**
 * The ONLY environment variables handed to the foreign child.
 *
 * An allowlist rather than a denylist by construction: the coordinator's own
 * environment routinely carries `CLANK_EVENT_SECRET`, host PATs and other
 * repo-unrelated credentials, and inheriting `process.env` hands every one of
 * them to a foreign model with shell access. A denylist would need updating
 * every time a new secret enters the environment; this list needs updating only
 * when `cursor-agent` genuinely needs something new.
 *
 * `CURSOR_API_KEY` / `CURSOR_API_ENDPOINT` are the channel's own credentials
 * (documented on `cursor-agent --help`); the rest is the minimum a CLI needs to
 * locate its config, its shell and its temp space.
 * @type {readonly string[]}
 */
export const FOREIGN_ENV_ALLOWLIST = Object.freeze([
  'PATH',
  'HOME',
  'TMPDIR',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TERM',
  'USER',
  'LOGNAME',
  'CURSOR_API_KEY',
  'CURSOR_API_ENDPOINT',
  'CURSOR_CONFIG_DIR',
]);

/** Prefix every foreign worktree parent directory carries under the tmp root.
 * {@link removeForeignWorktree} refuses to `--force`-remove anything outside a
 * directory named this way. */
export const FOREIGN_TMP_PREFIX = 'so-foreign';

/** A runId names a directory and a log file. Anything outside this alphabet —
 * or the two relative-path literals the alphabet happens to admit — can escape
 * the parent it is joined to. */
const SAFE_RUN_ID = /^[A-Za-z0-9._-]+$/;

/**
 * @param {unknown} runId
 * @returns {boolean} true when the id is safe to use as a path segment.
 */
function isSafeRunId(runId) {
  const s = String(runId ?? '');
  if (s === '.' || s === '..') return false; // admitted by SAFE_RUN_ID, still an escape
  return SAFE_RUN_ID.test(s);
}

/**
 * @param {string} role
 * @returns {boolean} true when the role is locked to Claude.
 */
export function isNeverForeignRole(role) {
  return NEVER_FOREIGN_ROLES.includes(String(role || '').trim());
}

/**
 * Build the allowlisted child environment.
 * @param {Record<string, string|undefined>} [source]
 * @returns {Record<string, string>}
 */
function buildForeignEnv(source) {
  const src = source || process.env;
  /** @type {Record<string, string>} */
  const env = {};
  for (const key of FOREIGN_ENV_ALLOWLIST) {
    const value = src[key];
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}

/**
 * Recursively collect tool-call names from one parsed stream event.
 *
 * The vocabulary is deliberately NOT pinned to a known list (`readToolCall`,
 * `grepToolCall`, `globToolCall`, `shellToolCall`, `editToolCall`, …): a new
 * `cursor-agent` release adds tool names, and a hard-coded list would silently
 * count them as zero. Anything whose object KEY or string VALUE ends in
 * `ToolCall` counts.
 *
 * Depth is capped at 6 — deep enough for every observed event shape; a runaway
 * nested payload must not turn stream parsing into a hang. Revisit if a future
 * stream format nests tool events deeper than that.
 *
 * @param {unknown} node
 * @param {Record<string, number>} sink
 * @param {number} [depth]
 */
function collectToolCalls(node, sink, depth = 0) {
  if (depth > 6 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectToolCalls(item, sink, depth + 1);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (/ToolCall$/.test(key)) sink[key] = (sink[key] || 0) + 1;
    else if (typeof value === 'string' && /ToolCall$/.test(value)) {
      sink[value] = (sink[value] || 0) + 1;
    }
    collectToolCalls(value, sink, depth + 1);
  }
}

/**
 * Extract assistant text from one parsed stream event, if it carries any.
 * @param {Record<string, unknown>} obj
 * @returns {string|null}
 */
function extractText(obj) {
  if (typeof obj.result === 'string' && obj.result.trim()) return obj.result;
  const message = obj.message;
  if (message && typeof message === 'object') {
    const content = /** @type {{content?: unknown}} */ (message).content;
    if (Array.isArray(content)) {
      const parts = content
        .filter((c) => c && typeof c === 'object' && typeof (/** @type {{text?: unknown}} */ (c).text) === 'string')
        .map((c) => /** @type {{text: string}} */ (c).text);
      if (parts.length > 0) return parts.join('');
    }
    if (typeof (/** @type {{text?: unknown}} */ (message).text) === 'string') {
      return /** @type {{text: string}} */ (message).text;
    }
  }
  if (typeof obj.text === 'string' && obj.text.trim()) return obj.text;
  return null;
}

/** The NUL character, built rather than written: a literal control byte in
 * authored source is invisible in review, and a regex form trips
 * `no-control-regex`. */
const NUL_BYTE = String.fromCharCode(0);

/**
 * Tolerant parse of a `cursor-agent --output-format stream-json` capture.
 *
 * The capture is stdout AND stderr merged, so it contains lines that are not
 * JSON at all (progress chatter, warnings) and — measured — literal NUL bytes.
 * Both are skipped silently; a parse failure is data, never an exception.
 *
 * @param {string} raw — the merged capture.
 * @returns {{toolCounts: Record<string, number>, toolCallTotal: number,
 *   resultText: string, parsedLines: number, skippedLines: number}}
 */
export function parseCursorStream(raw) {
  /** @type {Record<string, number>} */
  const toolCounts = {};
  let resultText = '';
  let parsedLines = 0;
  let skippedLines = 0;

  const cleaned = String(raw ?? '').split(NUL_BYTE).join('');

  for (const line of cleaned.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      skippedLines += 1;
      continue;
    }
    if (obj === null || typeof obj !== 'object') {
      skippedLines += 1;
      continue;
    }
    parsedLines += 1;
    collectToolCalls(obj, toolCounts);
    const text = extractText(obj);
    if (text) resultText = text;
  }

  const toolCallTotal = Object.values(toolCounts).reduce((a, b) => a + b, 0);
  return { toolCounts, toolCallTotal, resultText, parsedLines, skippedLines };
}

/**
 * Paths kept out of the measurement: an `npm install` inside the worktree must
 * not drown the model's actual edits.
 *
 * Applied at QUERY time (`git ls-files --exclude=…`), NOT by writing an
 * `info/exclude` file — measured 2026-08-25 in a synthetic repo:
 *   - `<per-worktree gitdir>/info/exclude` (what `rev-parse --git-dir` returns
 *     from inside a linked worktree) is NOT read by git: `status --porcelain`
 *     still printed `?? node_modules/` after writing it.
 *   - The file git DOES read is `--git-common-dir/info/exclude`, i.e. the
 *     SHARED `.git/info/exclude` of the operator's real repo. Writing there to
 *     tidy a throwaway worktree mutates the main working copy (PSA-003), so we
 *     do not write an exclude file at all.
 * @type {readonly string[]}
 */
export const MEASUREMENT_EXCLUDES = Object.freeze(['node_modules']);

/**
 * Run the child process, capturing stdout+stderr merged, with a hand-rolled
 * SIGTERM timeout that ESCALATES to SIGKILL. `spawnFn` is the DI seam so tests
 * never touch the real `cursor-agent` binary.
 *
 * The escalation is the difference between a bounded dispatch and a hung wave:
 * this function's only resolve paths are the child's `close` and `error`
 * events, so a child that ignores SIGTERM never lets the promise settle. See
 * {@link DEFAULT_KILL_GRACE_MS}.
 *
 * @returns {Promise<{capture: string, exitCode: number|null, signal: string|null,
 *   timerFired: boolean, killSignals: string[], errorCode: string|null}>}
 */
function runChild(cmd, args, options, { spawnFn, timeoutMs, killGraceMs }) {
  return new Promise((resolve) => {
    /** @type {string[]} */
    const killSignals = [];
    let child;
    try {
      child = spawnFn(cmd, args, options);
    } catch (err) {
      resolve({
        capture: `spawn failed: ${err && err.message}`,
        exitCode: null,
        signal: null,
        timerFired: false,
        killSignals,
        errorCode: (err && err.code) || null,
      });
      return;
    }

    let capture = '';
    let timerFired = false;
    let settled = false;
    let errorCode = null;
    /** @type {ReturnType<typeof setTimeout>|null} */
    let graceTimer = null;

    const onChunk = (chunk) => {
      capture += chunk.toString();
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);

    const send = (signal) => {
      killSignals.push(signal);
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    };

    const timer = setTimeout(() => {
      timerFired = true;
      send('SIGTERM');
      // SIGTERM is a request; SIGKILL is not. A child that installs a handler
      // and declines to exit would otherwise hang this promise forever.
      graceTimer = setTimeout(() => send('SIGKILL'), killGraceMs);
      graceTimer.unref?.();
    }, timeoutMs);

    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve({ capture, exitCode, signal, timerFired, killSignals, errorCode });
    };

    child.on('error', (err) => {
      errorCode = (err && err.code) || null;
      capture += `\nchild error: ${err && err.message}`;
      finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal ?? null));
  });
}

/** Read `git` output as text, returning '' on failure (a detached worktree with
 * no commits still answers, but a broken invocation must not throw here). */
function gitText(args, execFn) {
  try {
    return String(execFn('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  } catch {
    return '';
  }
}

/**
 * Fingerprint the hooks git would actually RUN for `repoRoot`.
 *
 * Covers both the configured `core.hooksPath` (measured in this repo:
 * `<repo>/.husky/_`) and the default `<git-common-dir>/hooks`, plus the config
 * VALUE itself — repointing `core.hooksPath` at an attacker-chosen directory is
 * a tampering shape that leaves every existing hook file byte-identical.
 *
 * Best-effort and fail-OPEN by design: a `null` return means "not measured",
 * never "unchanged". The caller must treat a null on either side as unknown
 * rather than clean — a fingerprint that failed closed would turn any
 * unreadable hooks directory into a false tampering alarm, and
 * `.claude/rules/host-resources.md` § HR-101 is what a chronically-firing
 * warning costs.
 *
 * @param {string} repoRoot
 * @param {Function} execFn
 * @returns {string|null}
 */
function hooksFingerprint(repoRoot, execFn) {
  try {
    const commonDir = gitText(['-C', repoRoot, 'rev-parse', '--git-common-dir'], execFn).trim();
    if (!commonDir) return null;
    // `git config --get` exits non-zero when unset; gitText turns that into ''.
    const configured = gitText(['-C', repoRoot, 'config', '--get', 'core.hooksPath'], execFn).trim();
    const hooksDir = configured
      ? path.resolve(repoRoot, configured)
      : path.resolve(repoRoot, commonDir, 'hooks');

    const hash = crypto.createHash('sha256');
    hash.update(`hooksPath:${configured}\n`);

    let names = [];
    try {
      names = fs
        .readdirSync(hooksDir, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => e.name)
        .sort();
    } catch {
      // No hooks directory at all is a legitimate, stable state — fingerprint
      // it as such so CREATING one later reads as a change.
      return hash.digest('hex');
    }

    for (const name of names) {
      hash.update(name);
      hash.update(NUL_BYTE);
      try {
        hash.update(crypto.createHash('sha256').update(fs.readFileSync(path.join(hooksDir, name))).digest('hex'));
      } catch {
        hash.update('unreadable');
      }
      hash.update('\n');
    }
    return hash.digest('hex');
  } catch {
    return null;
  }
}

/**
 * Dispatch one wave subagent to a foreign model over the Cursor channel.
 *
 * The worktree is deliberately NOT removed on the way out — a failed run stays
 * inspectable. Cleanup is the caller's, via {@link removeForeignWorktree}.
 *
 * @param {object} args
 * @param {string} args.model — e.g. `composer-2.5`, `cursor-grok-4.6-high`.
 * @param {string} args.prompt — the full agent prompt (positional argument).
 * @param {string} args.repoRoot — the repo the worktree is created from.
 * @param {string} args.role — routing role; checked against NEVER_FOREIGN_ROLES.
 * @param {number} [args.timeoutSec] — wall-clock budget (default 900; a floor).
 * @param {string} args.runId — unique id; names the worktree and the log file.
 * @param {string} [args.worktreeRoot] — explicit worktree path (default
 *   `<tmpdir>/so-foreign/<runId>`). Never under `.claude/worktrees/`, which is
 *   read by the repo's own worktree scanners.
 * @param {object} [deps]
 * @param {Function} [deps.spawnFn] — `child_process.spawn` seam.
 * @param {Function} [deps.now] — clock seam (ms).
 * @param {Function} [deps.execFn] — `child_process.execFileSync` seam (git).
 * @param {Function} [deps.emitFn] — event-emitter seam.
 * @param {number} [deps.killGraceMs] — SIGTERM→SIGKILL grace (default 10 s).
 * @param {Record<string, string|undefined>} [deps.envSource] — environment the
 *   allowlist is drawn from (default `process.env`).
 * @returns {Promise<object>} result envelope; `ok` is false unless the child
 *   exited 0, did not time out, AND left a non-empty diff.
 */
export async function dispatchForeign(
  { model, prompt, repoRoot, role, timeoutSec = DEFAULT_TIMEOUT_SEC, runId, worktreeRoot },
  {
    spawnFn = nodeSpawn,
    now = Date.now,
    execFn = execFileSync,
    emitFn = emitEvent,
    killGraceMs = DEFAULT_KILL_GRACE_MS,
    envSource,
  } = {}
) {
  /** Refusal envelope + its telemetry record. `docs/events-schema.md` promises
   * the completion event is "emitted on refusals too", so a refused dispatch
   * must leave a ledger record rather than a silence — and it carries
   * `exit_code: null` + `changed_files: 0` PRESENT so "refused" stays
   * distinguishable from "attempted and measured". */
  const refuse = async (reason) => {
    try {
      await emitFn(
        'orchestrator.foreign_dispatch.completed',
        {
          ...sessionAttribution(repoRoot),
          model,
          role,
          ok: false,
          reason,
          exit_code: null,
          timed_out: false,
          duration_s: 0,
          changed_files: 0,
        },
        { repoRoot }
      );
    } catch {
      /* telemetry must never fail a refusal */
    }
    return {
      ok: false,
      reason,
      role,
      model,
      exitCode: null,
      timedOut: false,
      durationSec: 0,
      toolCounts: {},
      diff: '',
      diffStat: '',
      changedFiles: [],
      modifiedFiles: [],
      newFiles: [],
      resultText: '',
      worktreePath: null,
      logPath: null,
      killSignals: [],
      hookTampering: null,
    };
  };

  // Hard role lock FIRST — before any worktree, any spawn, any side effect.
  // dispatch-cursor.sh does not enforce this; this adapter is the only gate.
  if (isNeverForeignRole(role)) return refuse('never-foreign-role');

  // runId names a directory and a log file, so it is a path segment before it
  // is an identifier: `../../x` would place the worktree — and the `--force`
  // removal that follows it — anywhere the process can write.
  if (!isSafeRunId(runId)) return refuse('unsafe-run-id');

  // A worktree INSIDE the repo is not a detached workspace: it lands in the
  // tree the coordinator commits from and is read by this repo's own worktree
  // scanners. Equality is rejected with containment — `git worktree add` onto
  // the repo root itself is the worst case of the same mistake.
  if (worktreeRoot) {
    const wtResolved = path.resolve(String(worktreeRoot));
    const rootResolved = path.resolve(String(repoRoot || ''));
    if (wtResolved === rootResolved || isPathInside(wtResolved, rootResolved)) {
      return refuse('unsafe-worktree-root');
    }
  }

  const startedAt = now();
  // A FIXED `<tmpdir>/so-foreign/<runId>` is guessable and pre-creatable by any
  // other process on the host; mkdtemp's 0700 random parent is not.
  const parent = worktreeRoot
    ? path.dirname(path.resolve(String(worktreeRoot)))
    : fs.mkdtempSync(path.join(os.tmpdir(), `${FOREIGN_TMP_PREFIX}-`));
  const wt = worktreeRoot ? path.resolve(String(worktreeRoot)) : path.join(parent, String(runId));
  let logPath = path.join(parent, `${runId}.log.jsonl`);

  fs.mkdirSync(parent, { recursive: true });

  // Snapshot the hooks git would run BEFORE handing the tree to a foreign
  // model — see the module header: the worktree shares them with the real repo.
  const hooksBefore = hooksFingerprint(repoRoot, execFn);

  // Detached, never branch-oriented: createWorktree()/enterWorktree() both
  // create or check out a BRANCH, which a throwaway foreign run must not do.
  execFn('git', ['-C', repoRoot, 'worktree', 'add', '--detach', wt, 'HEAD'], { encoding: 'utf8' });

  const { capture, exitCode, signal, timerFired, killSignals, errorCode } = await runChild(
    'cursor-agent',
    [
      ...FOREIGN_AGENT_BASE_ARGS,
      '--model',
      String(model),
      '--output-format',
      'stream-json',
      String(prompt),
    ],
    // NOT `{ ...process.env }`: an inherited environment hands every credential
    // the coordinator holds to a foreign model with shell access.
    { cwd: wt, env: buildForeignEnv(envSource) },
    { spawnFn, timeoutMs: timeoutSec * 1000, killGraceMs }
  );

  // The log is kept, not trap-deleted: a supervising Claude reviewer needs the
  // whole stream, and `dispatch-cursor.sh` losing it is why this module exists.
  // `wx` so a pre-planted symlink at the log path fails loudly instead of being
  // followed into whatever it points at.
  let logError;
  try {
    fs.writeFileSync(logPath, capture, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    // A lost log must not fail the dispatch — but it must not be claimed
    // either, so the path is nulled rather than left pointing at nothing.
    logError = err && err.message ? err.message : String(err);
    logPath = null;
  }

  // A missing binary is NOT a model failure. Classified as `exit-nonzero` it
  // reads as "the foreign model could not do the task", which sends the
  // coordinator hunting the prompt instead of the channel — and leaves the
  // just-created worktree registered in the operator's REAL repo.
  if (errorCode === 'ENOENT') {
    removeForeignWorktree({ repoRoot, worktreePath: wt }, { execFn, allowAnyPath: true });
    const durationSec = Math.round(((now() - startedAt) / 1000) * 100) / 100;
    try {
      await emitFn(
        'orchestrator.foreign_dispatch.completed',
        {
          ...sessionAttribution(repoRoot),
          model,
          role,
          ok: false,
          reason: 'channel-unavailable',
          exit_code: null,
          timed_out: false,
          duration_s: durationSec,
          changed_files: 0,
        },
        { repoRoot }
      );
    } catch {
      /* telemetry must never fail a dispatch */
    }
    return {
      ok: false,
      reason: 'channel-unavailable',
      role,
      model,
      exitCode: null,
      timedOut: false,
      durationSec,
      toolCounts: {},
      diff: '',
      diffStat: '',
      changedFiles: [],
      modifiedFiles: [],
      newFiles: [],
      resultText: '',
      worktreePath: null,
      logPath,
      ...(logError ? { logError } : {}),
      killSignals,
      hookTampering: null,
    };
  }

  const { toolCounts, resultText } = parseCursorStream(capture);
  const timedOut = timerFired || signal === 'SIGTERM' || signal === 'SIGKILL' || exitCode === 143;

  // Measure at the filesystem, never from the model's prose.
  //
  // `git diff` covers TRACKED files only — measured 2026-08-25, it is blind to
  // a file the model creates (`diff --name-only` printed nothing for a brand-new
  // file that `ls-files --others` listed). Since a foreign impl agent's output
  // is frequently a NEW file, a diff-only measurement would classify a
  // successful run as `empty-diff`. Untracked files are therefore enumerated
  // separately — without `git add`, which is an index write (PSA-007).
  const diffStat = gitText(['-C', wt, 'diff', '--stat'], execFn).trim();
  const nameOnly = gitText(['-C', wt, 'diff', '--name-only'], execFn);
  const diff = gitText(['-C', wt, 'diff'], execFn);
  const untracked = gitText(
    [
      '-C',
      wt,
      'ls-files',
      '--others',
      '--exclude-standard',
      ...MEASUREMENT_EXCLUDES.map((p) => `--exclude=${p}`),
    ],
    execFn
  );
  const toLines = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean);
  const modifiedFiles = toLines(nameOnly);
  const newFiles = toLines(untracked);
  const changedFiles = [...new Set([...modifiedFiles, ...newFiles])].sort();

  let reason;
  if (timedOut) reason = 'timeout';
  else if (exitCode !== 0) reason = 'exit-nonzero';
  else if (changedFiles.length === 0) reason = 'empty-diff';
  const ok = reason === undefined;

  // The diff above covers the worktree only. This covers the one surface a
  // `--force` foreign model could reach OUTSIDE it that also executes later.
  const hooksAfter = hooksFingerprint(repoRoot, execFn);
  const hookTampering = hooksBefore && hooksAfter ? hooksBefore !== hooksAfter : null;

  const durationSec = Math.round(((now() - startedAt) / 1000) * 100) / 100;

  // SubagentStop telemetry cannot fire for a Bash child (#1150 / D4 finding 5) —
  // this event is the only ledger record a foreign dispatch produces.
  try {
    await emitFn(
      'orchestrator.foreign_dispatch.completed',
      {
        ...sessionAttribution(repoRoot),
        model,
        role,
        ok,
        // Present only when the dispatch failed, so absence means success —
        // and every failure class (refusal, channel, timeout, empty-diff) is
        // groupable in the ledger without string-matching a message.
        ...(reason ? { reason } : {}),
        exit_code: exitCode,
        timed_out: timedOut,
        duration_s: durationSec,
        changed_files: changedFiles.length,
        ...(hookTampering === true ? { hook_tampering: true } : {}),
      },
      { repoRoot }
    );
  } catch {
    /* telemetry must never fail a dispatch */
  }

  return {
    ok,
    ...(reason ? { reason } : {}),
    role,
    model,
    exitCode,
    timedOut,
    durationSec,
    toolCounts,
    diff,
    diffStat,
    changedFiles,
    modifiedFiles,
    newFiles,
    resultText,
    worktreePath: wt,
    logPath,
    ...(logError ? { logError } : {}),
    killSignals,
    // true = the effective hooks directory changed across the dispatch;
    // false = it did not; null = NOT MEASURED (never read as "clean").
    hookTampering,
  };
}

/**
 * True when `p` is a path this module could plausibly have created: strictly
 * inside the OS temp root, under a first-level directory whose name starts with
 * {@link FOREIGN_TMP_PREFIX}.
 *
 * Accepts both parent shapes on purpose — the mkdtemp default
 * (`<tmpdir>/so-foreign-a1b2c3/<runId>`) and an explicitly-passed
 * `<tmpdir>/so-foreign/<runId>`.
 *
 * @param {unknown} p
 * @returns {boolean}
 */
export function isForeignWorktreePath(p) {
  if (typeof p !== 'string' || p === '' || p.includes(NUL_BYTE)) return false;
  const tmp = os.tmpdir();
  let resolved;
  try {
    resolved = path.resolve(p);
    if (!isPathInside(resolved, tmp)) return false;
  } catch {
    return false;
  }
  const [first] = path.relative(path.resolve(tmp), resolved).split(path.sep);
  return Boolean(first) && first.startsWith(FOREIGN_TMP_PREFIX);
}

/**
 * Remove a foreign worktree once its diff has been reviewed. Separate from
 * {@link dispatchForeign} on purpose: a failed run must stay on disk until the
 * caller has read it.
 *
 * `git worktree remove --force` DELETES the directory including uncommitted
 * work, so the path is checked before git is called, not after: this function's
 * argument travels through a result envelope and a coordinator prompt, and a
 * `worktreePath` that is not one of ours is a request to destroy something
 * nobody here created (PSA-003). A refusal makes NO git call at all.
 *
 * @param {{repoRoot: string, worktreePath: string}} args
 * @param {{execFn?: Function, allowAnyPath?: boolean}} [deps] — `allowAnyPath`
 *   is the INTERNAL escape used by {@link dispatchForeign} to clean up a
 *   worktree it just created at a caller-supplied `worktreeRoot`; that path was
 *   already validated against `repoRoot` there. Callers do not set it.
 * @returns {{ok: boolean, reason?: string, error?: string}}
 */
export function removeForeignWorktree(
  { repoRoot, worktreePath },
  { execFn = execFileSync, allowAnyPath = false } = {}
) {
  if (!allowAnyPath && !isForeignWorktreePath(worktreePath)) {
    return {
      ok: false,
      reason: 'unsafe-worktree-path',
      error: `refusing to force-remove a path outside <tmpdir>/${FOREIGN_TMP_PREFIX}*: ${worktreePath}`,
    };
  }
  try {
    execFn('git', ['-C', repoRoot, 'worktree', 'remove', '--force', worktreePath], {
      encoding: 'utf8',
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}
