/**
 * remote-dispatch.mjs — dispatch a wave subagent to a REMOTE host over the
 * `offload` CLI, and measure the result at the produced patch file rather than
 * from the model's own prose (#1160, repo-side half b).
 *
 * Relationship to `foreign-dispatch.mjs`: same contract, different channel.
 * That module sends a task to a foreign MODEL on this machine; this one sends
 * a task to Claude on ANOTHER machine. Both share the parts that must not
 * diverge and are therefore IMPORTED from the common base (`dispatch-common.mjs`,
 * #1204), never copied: the `never_foreign` role lock ({@link isNeverForeignRole}),
 * the run-id path-segment validator ({@link isSafeRunId}), the SIGTERM→SIGKILL
 * child runner ({@link runChild}), and the two budget constants.
 *
 * Three properties are load-bearing here and each has a test:
 *
 *   1. **The prompt travels on STDIN, never in argv.** `offload`'s own help
 *      states "prompts travel by file (mode 600), never argv"; argv is visible
 *      to every process on the host via `ps`.
 *   2. **The patch never lands in the repo the coordinator commits from.**
 *      `--patch` is validated to resolve under `os.tmpdir()` AND outside
 *      `repoRoot`, so a remote result cannot be swept into a local commit by
 *      an unrelated `git add`.
 *   3. **The patch is READ, never applied.** Applying it is the coordinator's
 *      own step, after review — this module returns counts and paths only.
 *
 * The remote side enforces its own timeout; the wall-clock kill here is the
 * backstop for a channel that stops answering (`timeoutSec + 60`).
 */

import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { emitEvent, sessionAttribution } from '../events.mjs';
import { isPathInside } from '../path-utils.mjs';
import {
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_TIMEOUT_SEC,
  isNeverForeignRole,
  isSafeRunId,
  runChild,
} from './dispatch-common.mjs';

/** The `offload` binary. Resolved on PATH; a missing binary surfaces as ENOENT
 * and is classified as a CHANNEL failure, never as a model failure. */
export const OFFLOAD_BIN = 'offload';

/** Local grace added to the remote budget before the wall-clock kill fires, in
 * seconds. The remote side has its own `--timeout`; killing locally at the same
 * instant would race it and report `timeout` for runs the remote was about to
 * report as `empty-diff` or `remote-command-failed`.
 *
 * Named ceiling (BV-004): 60 s covers the sync-back of a patch after the remote
 * command itself has finished. Revisit if a measured healthy run is ever killed
 * locally while the remote reported success — raise this, never drop the kill. */
export const LOCAL_TIMEOUT_GRACE_SEC = 60;

/** Longest run-id / host accepted as an argv value and path segment. */
export const MAX_ID_LEN = 64;

/**
 * `offload` exit code → failure reason. Measured against `offload --help`
 * (2026-09-02). Kept as data so a new code shows up as `undefined` (mapped to
 * `remote-command-failed` below) rather than being silently read as success.
 * @type {Readonly<Record<number, string>>}
 */
export const OFFLOAD_EXIT_REASONS = Object.freeze({
  1: 'usage-config',
  2: 'host-unreachable',
  3: 'remote-command-failed',
  4: 'sync-failed',
  5: 'timeout',
  6: 'empty-diff',
  7: 'rate-limited',
  8: 'write-lock-busy',
});

/** Event name — the only ledger record a remote dispatch produces. A Bash-spawned
 * child fires no `SubagentStop` hook, so nothing else in the chain sees it. */
export const REMOTE_DISPATCH_EVENT = 'orchestrator.remote_dispatch.completed';

/** Chars of merged child output retained per stream on the envelope. Enough for
 * exit-7's reset time and a stack tail; short enough that the envelope stays
 * loggable. Never emitted in telemetry. */
const TAIL_CHARS = 2000;

/** Refuse to parse a patch larger than this; `patchBytes` is still reported.
 * Named ceiling (BV-004): 64 MiB is far past any review-sized diff. Revisit if
 * a legitimate remote patch is ever measured above it. */
const MAX_PATCH_PARSE_BYTES = 64 * 1024 * 1024;

const tail = (s) => (s.length > TAIL_CHARS ? s.slice(-TAIL_CHARS) : s);

/** @param {unknown} v @returns {boolean} safe as an argv value and path segment. */
function isSafeId(v) {
  const s = String(v ?? '');
  return s.length > 0 && s.length <= MAX_ID_LEN && isSafeRunId(s);
}

/** Longest `repo` accepted as an argv operand. */
const MAX_REPO_LEN = 128;

/**
 * A repo argument safe as the first positional of `offload claude`.
 *
 * Same character allowlist as `SAFE_PATH_RE` in `scripts/lib/config/remote-hosts.mjs`
 * (a `repo-path` declared there is exactly what arrives here), plus two rules the
 * charset alone cannot express: the first character may never be `-`, or the CLI
 * reads the operand as an OPTION and silently consumes the token after it; and
 * `..` may never appear, so a repo argument cannot climb out of the remote's
 * project root.
 */
const SAFE_REPO_RE = /^[A-Za-z0-9._~/][A-Za-z0-9._~/-]{0,127}$/;

/** @param {unknown} v @returns {boolean} */
function isSafeRepo(v) {
  const s = String(v ?? '');
  return s.length > 0 && s.length <= MAX_REPO_LEN && SAFE_REPO_RE.test(s) && !s.includes('..');
}

/**
 * A model name safe as the argv value of `--model`. Deliberately NARROWER than
 * {@link SAFE_REPO_RE} — a model is a bare name (`sonnet`, `claude-opus-4.5`),
 * never a path — and anchored against a leading `-` for the same option-token
 * reason.
 */
const SAFE_MODEL_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/;

/** @param {unknown} v @returns {boolean} */
function isSafeModel(v) {
  return SAFE_MODEL_RE.test(String(v ?? ''));
}

/**
 * Directories a remote patch may live in. Both spellings of the temp directory
 * are accepted because macOS resolves `os.tmpdir()` through a symlink
 * (`/var/folders/...` ↔ `/private/var/folders/...`) and a caller that passed a
 * realpath'd directory is not doing anything unsafe.
 * @returns {string[]}
 */
function tmpRoots() {
  const t = path.resolve(os.tmpdir());
  const roots = [t];
  try {
    const real = fs.realpathSync(t);
    if (real !== t) roots.push(real);
  } catch {
    /* tmpdir unreadable — the lexical root still applies */
  }
  return roots;
}

/**
 * Paths touched by a unified diff. `+++ b/<path>` covers modified files; a
 * created file has `+++ /dev/null`-free `+++ b/…` too, but a DELETED file's
 * `+++` is `/dev/null`, so `diff --git a/x b/x` is read as well — the same
 * blindness `foreign-dispatch.mjs` documents for `git diff` alone.
 * @param {string} patch
 * @returns {string[]} sorted, de-duplicated
 */
export function parsePatchFiles(patch) {
  /** @type {Set<string>} */
  const files = new Set();
  for (const line of String(patch || '').split('\n')) {
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim().split('\t')[0];
      if (p && p !== '/dev/null') files.add(p.replace(/^b\//, ''));
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line.trim());
      if (m) files.add(m[2]);
    }
  }
  return [...files].sort();
}

/**
 * Dispatch one wave task to a remote host via `offload claude`.
 *
 * @param {object} task
 * @param {string} task.host — `offload` host alias (`-H`).
 * @param {string} task.repo — repository argument handed to `offload claude`.
 * @param {string} task.prompt — written to the child's STDIN, never to argv.
 * @param {string} task.role — checked against the `never_foreign` lock FIRST.
 * @param {string} task.runId — becomes `--job`; a path segment, hence validated.
 * @param {number} [task.timeoutSec] — remote budget; the local kill adds 60 s.
 * @param {string} [task.model] — `--model`; omitted from argv when absent.
 * @param {string} [task.patchPath] — must resolve under `os.tmpdir()` and
 *   outside `repoRoot`. Defaults to `<tmpdir>/offload-<runId>.patch`.
 * @param {object} [deps]
 * @param {Function} [deps.spawnFn] — `child_process.spawn` seam.
 * @param {Function} [deps.now] — clock seam.
 * @param {Function} [deps.emitFn] — event-emitter seam.
 * @param {number} [deps.killGraceMs] — SIGTERM→SIGKILL grace.
 * @param {number} [deps.localGraceSec] — seconds added to the remote budget before
 *   the LOCAL wall-clock kill; a seam so the escalation is testable without a
 *   real 15-minute wait.
 * @param {string} [deps.repoRoot] — the tree the coordinator commits from.
 * @returns {Promise<object>} result envelope; `ok` is false unless the child
 *   exited 0 AND left a non-empty patch.
 */
export async function dispatchRemote(
  { host, repo, prompt, role, runId, timeoutSec = DEFAULT_TIMEOUT_SEC, model, patchPath },
  {
    spawnFn = nodeSpawn,
    now = Date.now,
    emitFn = emitEvent,
    killGraceMs = DEFAULT_KILL_GRACE_MS,
    localGraceSec = LOCAL_TIMEOUT_GRACE_SEC,
    repoRoot,
  } = {},
) {
  /** Refusal envelope + its telemetry record. A refused dispatch must leave a
   * ledger record rather than a silence, and `exit_code: null` + `patch_files: 0`
   * keep "refused" distinguishable from "attempted and measured empty". */
  const refuse = async (reason) => {
    try {
      await emitFn(
        REMOTE_DISPATCH_EVENT,
        {
          ...sessionAttribution(repoRoot),
          host,
          role,
          run_id: runId,
          ok: false,
          reason,
          exit_code: null,
          duration_ms: 0,
          patch_files: 0,
          patch_bytes: 0,
        },
        { repoRoot },
      );
    } catch {
      /* telemetry must never fail a refusal */
    }
    return {
      ok: false,
      reason,
      role,
      host,
      repo,
      runId,
      exitCode: null,
      timedOut: false,
      durationMs: 0,
      patchPath: null,
      patchFiles: [],
      patchBytes: 0,
      stdoutTail: '',
      stderrTail: '',
    };
  };

  // Hard role lock FIRST — before any spawn, any file, any side effect.
  if (isNeverForeignRole(role)) return refuse('never-foreign-role');
  if (!isSafeId(runId)) return refuse('unsafe-run-id');
  if (!isSafeId(host)) return refuse('unsafe-host');
  // `repo` is the first positional and `model` the value of `--model`: both
  // reach argv, and both were previously stringified straight into it. A value
  // starting with `-` is read by the CLI as an option, which shifts every
  // operand after it — the same injection class the two checks above prevent.
  if (!isSafeRepo(repo)) return refuse('unsafe-repo');
  // The truthiness test mirrors the `...(model ? ['--model', …] : [])` argv line
  // below on purpose: a falsy model is OMITTED from argv, so it is absent, not
  // unsafe. Validating a shape that never reaches argv would refuse callers for
  // a value the CLI never sees.
  if (model && !isSafeModel(model)) return refuse('unsafe-model');

  const patchTarget = path.resolve(
    String(patchPath || path.join(os.tmpdir(), `offload-${runId}.patch`)),
  );
  const underTmp = tmpRoots().some((r) => patchTarget === r || isPathInside(patchTarget, r));
  const rootResolved = repoRoot ? path.resolve(String(repoRoot)) : null;
  const insideRepo =
    rootResolved !== null &&
    (patchTarget === rootResolved || isPathInside(patchTarget, rootResolved));
  // A patch inside the coordinator's tree is not a delivery, it is a
  // contamination: the next `git add` sweeps a remote model's output into a
  // local commit with nobody having reviewed it.
  if (!underTmp || insideRepo) return refuse('unsafe-patch-path');

  const startedAt = now();
  const args = [
    'claude',
    String(repo),
    '-H',
    String(host),
    '--job',
    String(runId),
    '--write',
    '--patch',
    patchTarget,
    ...(model ? ['--model', String(model)] : []),
    '--timeout',
    String(timeoutSec),
  ];

  let stdout = '';
  let stderr = '';
  // Wrapping the spawn seam is how the prompt reaches STDIN and how the two
  // streams stay SEPARATE — runChild merges them by design, but exit 7's reset
  // time arrives on stderr and the operator needs it distinguishable.
  const spawnWithStdin = (cmd, argv, options) => {
    const child = spawnFn(cmd, argv, options);
    child.stdout?.on('data', (c) => {
      stdout += c.toString();
    });
    child.stderr?.on('data', (c) => {
      stderr += c.toString();
    });
    try {
      child.stdin?.write(String(prompt ?? ''));
      child.stdin?.end();
    } catch {
      /* a child that died before its stdin opened is reported by exit/error */
    }
    return child;
  };

  const { exitCode, timerFired, errorCode } = await runChild(
    OFFLOAD_BIN,
    args,
    { stdio: ['pipe', 'pipe', 'pipe'] },
    {
      spawnFn: spawnWithStdin,
      timeoutMs: (Number(timeoutSec) + Number(localGraceSec)) * 1000,
      killGraceMs,
    },
  );

  // A missing patch file and a 0-byte one are the SAME observable state:
  // nothing came back. Never an error class of its own.
  let patchBytes = 0;
  try {
    patchBytes = fs.statSync(patchTarget).size;
  } catch {
    /* no patch file — patchBytes stays 0 */
  }
  /** @type {string[]} */
  let patchFiles = [];
  if (patchBytes > 0 && patchBytes <= MAX_PATCH_PARSE_BYTES) {
    try {
      patchFiles = parsePatchFiles(fs.readFileSync(patchTarget, 'utf8'));
    } catch {
      // Unreadable body, measured size: report the bytes, claim no paths.
      patchFiles = [];
    }
  }

  let reason;
  if (errorCode === 'ENOENT') reason = 'channel-unavailable';
  else if (timerFired) reason = 'timeout';
  else if (exitCode !== 0) reason = OFFLOAD_EXIT_REASONS[exitCode] || 'remote-command-failed';
  else if (patchBytes === 0) reason = 'empty-diff';
  const ok = reason === undefined;

  const durationMs = now() - startedAt;

  try {
    await emitFn(
      REMOTE_DISPATCH_EVENT,
      {
        ...sessionAttribution(repoRoot),
        host,
        role,
        run_id: runId,
        ok,
        // Present only when the dispatch failed, so absence means success and
        // every failure class is groupable without string-matching a message.
        ...(reason ? { reason } : {}),
        exit_code: exitCode,
        duration_ms: durationMs,
        patch_files: patchFiles.length,
        patch_bytes: patchBytes,
        // Deliberately ABSENT: the prompt, the patch body, and `patch_path` —
        // this record also travels over the optional Clank webhook with no
        // redaction, and a tmp path names the run id and the operator's host.
      },
      { repoRoot },
    );
  } catch {
    /* telemetry must never fail a dispatch */
  }

  return {
    ok,
    ...(reason ? { reason } : {}),
    role,
    host,
    repo,
    runId,
    exitCode,
    timedOut: timerFired,
    durationMs,
    patchPath: patchTarget,
    patchFiles,
    patchBytes,
    stdoutTail: tail(stdout),
    stderrTail: tail(stderr),
  };
}

/**
 * Parse one `offload doctor --brief` line.
 *
 * Real line, measured 2026-09-02 against host `m5` (the leading hostname is
 * SCRUBBED to the synthetic `Ferdinands-…` convention of
 * `scripts/lib/host-identity.mjs`; every other segment is verbatim):
 * `Ferdinands-Macbook-2 ready=yes · load 14.23 · mem free 96% · headless: slots
 * none, keychain-route ok · 9 jobs · claude procs 12`
 *
 * Every metric is `null` when its segment is absent — never a fabricated `0`,
 * which would read as "measured, idle" for a host that answered nothing.
 * @param {string} raw
 * @returns {{ready: boolean, raw: string, load: number|null, memFreePct: number|null,
 *   jobs: number|null, claudeProcs: number|null}}
 */
export function parseDoctorLine(raw) {
  const text = String(raw ?? '');
  const num = (re) => {
    const m = re.exec(text);
    return m ? Number(m[1]) : null;
  };
  return {
    // `ready` is the ONLY decision field: anything that is not a literal
    // `ready=yes` is not-ready, including an unparseable line.
    ready: /\bready=yes\b/i.test(text),
    raw: text,
    load: num(/\bload\s+([0-9]+(?:\.[0-9]+)?)/i),
    memFreePct: num(/\bmem free\s+([0-9]+(?:\.[0-9]+)?)\s*%/i),
    jobs: num(/\b([0-9]+)\s+jobs?\b/i),
    claudeProcs: num(/\bclaude procs\s+([0-9]+)/i),
  };
}

/**
 * Host readiness check — `offload doctor -H <host> --brief`. Read-only.
 *
 * @param {object} opts
 * @param {string} opts.host
 * @param {Function} [opts.execFn] — `child_process.execFileSync` seam.
 * @param {number} [opts.timeoutMs]
 * @returns {{ready: boolean, raw: string, load: number|null, memFreePct: number|null,
 *   jobs: number|null, claudeProcs: number|null}}
 */
export function remoteDoctor({ host, execFn = execFileSync, timeoutMs = 90_000 }) {
  if (!isSafeId(host)) return { ...parseDoctorLine(''), raw: '' };
  let raw;
  try {
    raw = String(
      execFn(OFFLOAD_BIN, ['doctor', '-H', String(host), '--brief'], {
        encoding: 'utf8',
        timeout: timeoutMs,
      }),
    ).trim();
  } catch (err) {
    // A non-zero exit still carries diagnostic text on stdout/stderr; keep it
    // so the operator sees WHY, but never let it produce metrics.
    const out = err && (err.stdout || err.stderr);
    return {
      ready: false,
      raw: out ? String(out).trim() : String((err && err.message) || ''),
      load: null,
      memFreePct: null,
      jobs: null,
      claudeProcs: null,
    };
  }
  return parseDoctorLine(raw);
}

/**
 * THE adapter between {@link remoteDoctor} and the wave-resource gate's
 * `probeFn` seam (`scripts/lib/wave-resource-gate.mjs` → `applyOffloadDecision`).
 *
 * The gate's witness contract is `async (alias: string) => boolean`;
 * `remoteDoctor` is SYNC, takes an options object and returns a metrics record.
 * Passing `remoteDoctor` itself as `probeFn` therefore yields `undefined.ready`
 * on an object it never received an alias for, and no host is ever ready — the
 * documented witness could not produce an `offload` decision at all. This
 * function is the one shape both sides agree on; use it, never `remoteDoctor`
 * directly.
 *
 * Never throws: a probe that raises is a host that did not answer, i.e. NOT
 * ready. The gate must fail toward local, never toward a host it cannot vouch
 * for.
 *
 * @param {string} alias — declared host alias (`remote-hosts[].alias`).
 * @param {object} [opts]
 * @param {Function} [opts.execFn] — `child_process.execFileSync` seam.
 * @returns {Promise<boolean>} true only on a literal `ready=yes` line.
 */
export async function remoteReadyProbe(alias, { execFn } = {}) {
  try {
    return remoteDoctor({ host: alias, ...(execFn ? { execFn } : {}) }).ready === true;
  } catch {
    return false;
  }
}
