/**
 * io.mjs — stdin/stdout helpers implementing the Claude Code hook I/O contract,
 * plus shared atomic file-write helpers used by skills that need crash-safe
 * sidecar JSON output (e.g. persona-panel, issue #457).
 *
 * Provides promise-based stdin JSON reading and structured exit helpers used by
 * PreToolUse / PostToolUse hooks in the session-orchestrator v3 migration, and
 * `writeJsonAtomic` (async) + `writeJsonAtomicSync` (sync) for tmp+rename JSON
 * writes. The async variant supports optional pre-write validation; the sync
 * variant is hot-path-friendly for hooks and session-lock writers that cannot
 * await.
 *
 * No external dependencies — Node 20+ stdlib only.
 *
 * Part of v3.0.0 migration (Epic #124, issue #131); writeJsonAtomic added for
 * #457; writeJsonAtomicSync extracted for #558 M1.
 */

import { writeFile, rename, mkdir } from 'node:fs/promises';
import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync, writeSync } from 'node:fs';
import path, { dirname } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the deny reason string, optionally appending a suggestion.
 *
 * Multi-line `reason` values are passed through verbatim — callers that need a
 * several-line rationale (e.g. hooks/pre-bash-destructive-guard.mjs) rely on
 * this. `JSON.stringify` later escapes the newlines, so the emitted payload
 * still occupies exactly one stdout line.
 *
 * @param {string} reason
 * @param {string|undefined} suggestion
 * @returns {string}
 */
function _formatReason(reason, suggestion) {
  return suggestion ? `${reason} — ${suggestion}` : reason;
}

/** Max length of the operator-facing `systemMessage` headline. */
const DENY_HEADLINE_MAX = 200;

/**
 * Hard ceiling (in characters) for `permissionDecisionReason`.
 *
 * Rationale is empirical, not a round number pulled from the air. Measured
 * worst-case reason lengths across all 12 live `emitDeny` call sites:
 *
 * | call site                                    | measured chars |
 * |----------------------------------------------|----------------|
 * | pre-bash-destructive-guard (worst of 13 rules) | 435          |
 * | pre-bash-templates-first (fixed part)         | 348 + command |
 * | pre-bash-issue-budget (formatBlockReason)     | 652           |
 * | config-protection (all 6 reasons at once)     | 432           |
 * | enforce-scope (LIVE wave-scope, 18 paths)     | 1 322         |
 * | enforce-scope (deep wave, 144-path union)     | ~9 068        |
 *
 * `enforce-scope` joins `allowedPaths` into BOTH the reason and the suggestion,
 * so its length grows at ~2× the union. A deep session (18 agents) with a wide
 * union is the binding constraint at ~9 k — which is why the ceiling is NOT the
 * 8 000 originally proposed: that would clip a legitimate deep-wave scope
 * violation exactly when the operator most needs the path list. 16 000 sits
 * ~1.8× above that worst case and ~12× above the largest measured live reason,
 * while staying ~4× below the 65 536-byte kernel pipe buffer — so even the clamp
 * ALONE keeps a typical-ASCII envelope inside one buffer.
 */
const DENY_REASON_MAX = 16_000;

/**
 * Hard ceiling (in characters) for the operator-facing `systemMessage` that
 * {@link emitWarn} emits.
 *
 * Same ceiling as {@link DENY_REASON_MAX}, and for the same measured reason:
 * the warn path shares its call sites with the deny path — `enforce-scope` calls
 * `emitDeny(reason, suggestion)` under `strict` and `emitWarn(reason — suggestion)`
 * under `warn`, on the identical text. The binding case is therefore identical
 * too (a deep wave's 144-path allowedPaths union, ~9 068 chars, interpolated into
 * both halves), so a tighter warn ceiling would clip exactly the path list the
 * operator needs. 16 000 stays ~4× below the 65 536-byte kernel pipe buffer.
 *
 * NOT reused as a shared alias by accident: `emitDeny` splits its text across a
 * clipped 200-char headline plus the full `permissionDecisionReason`, whereas
 * `systemMessage` is the warn path's ONLY carrier — this constant is what makes
 * that difference explicit rather than incidental.
 */
const WARN_MESSAGE_MAX = 16_000;

/**
 * Reason substituted when a caller denies without supplying one.
 *
 * A guard must never fail on its own bookkeeping: throwing here used to land in
 * the fail-open `main().catch(() => emitAllow())` of four hooks
 * (pre-bash-destructive-guard, pre-bash-issue-budget, pre-bash-templates-first,
 * config-protection) and turn a deny into an ALLOW. The programmer-error signal
 * is preserved as a stderr diagnostic instead of a throw.
 */
const EMPTY_REASON_FALLBACK =
  'Denied by a session-orchestrator guard that did not supply a reason (guard bug — see stderr). '
  + 'Blocking rather than allowing: a guard must fail closed.';

/** stdout file descriptor. */
const STDOUT_FD = 1;

/** Backoff between EAGAIN retries in the synchronous stdout writer. */
const STDOUT_EAGAIN_BACKOFF_MS = 1;

/**
 * Clip `text` to `max` characters, marking the cut with an ellipsis.
 *
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function _clip(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Derive the short operator-facing headline from a (possibly multi-line) reason.
 * First line only, clipped — the full text stays in `permissionDecisionReason`.
 *
 * @param {string} reason
 * @returns {string}
 */
function _denyHeadline(reason) {
  return `⛔ ${_clip(reason.split('\n')[0].trim(), DENY_HEADLINE_MAX)}`;
}

/**
 * Clamp a reason/message to `max` characters, appending a visible marker that
 * names how much was dropped. The marker is budgeted INSIDE the ceiling, so the
 * returned string never exceeds it.
 *
 * @param {string} reason
 * @param {number} [max=DENY_REASON_MAX]
 * @returns {string}
 */
function _clampReason(reason, max = DENY_REASON_MAX) {
  if (reason.length <= max) return reason;
  const marker = `\n… [truncated: showing ${max} of ${reason.length} characters]`;
  return reason.slice(0, max - marker.length) + marker;
}

/**
 * Synchronously write one line (a trailing `\n` is appended) to stdout,
 * looping until every byte is handed to the kernel.
 *
 * ## Why this exists instead of `console.log`
 *
 * `process.stdout` is **asynchronous when it is a pipe on macOS** (Node docs,
 * "process I/O": "Pipes and sockets: … asynchronous on macOS") — exactly the
 * configuration every Claude Code hook runs under. `console.log` therefore only
 * QUEUES the write: whatever does not fit into the 65 536-byte kernel pipe
 * buffer stays in libuv's write queue, and `process.exit()` discards it. The
 * observable result is a truncated, unparseable JSON envelope delivered with
 * exit 0.
 *
 * Before #906 that truncation was harmless: `emitDeny` exited **2**, which
 * blocks regardless of stdout. Once the helper moved to `exit 0` + structured
 * JSON, the same truncation flipped the guard layer from fail-CLOSED to
 * fail-OPEN — a >64 KB reason meant the harness saw no structured output and
 * ALLOWED the tool call. `writeSync` bypasses the libuv queue entirely, so the
 * bytes are in the kernel before `process.exit` runs.
 *
 * EAGAIN is expected when fd 1 is non-blocking and the pipe is momentarily
 * full; the loop backs off and retries rather than dropping the tail. Any other
 * error (EPIPE — reader gone) is reported to the caller, which must then decide
 * how to signal WITHOUT stdout. Never throws.
 *
 * @param {string} line  Payload without trailing newline.
 * @returns {{ ok: true, bytesWritten: number } | { ok: false, bytesWritten: number, error: string }}
 */
export function writeStdoutLineSync(line) {
  const buf = Buffer.from(`${line}\n`, 'utf8');
  let offset = 0;
  while (offset < buf.length) {
    let written;
    try {
      written = writeSync(STDOUT_FD, buf, offset, buf.length - offset);
    } catch (err) {
      const code = err?.code;
      if (code === 'EAGAIN' || code === 'EINTR') {
        // Synchronous backoff: Atomics.wait is the only event-loop-free sleep,
        // and the event loop is precisely what we cannot yield to here.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, STDOUT_EAGAIN_BACKOFF_MS);
        continue;
      }
      return { ok: false, bytesWritten: offset, error: code ?? String(err) };
    }
    offset += written;
  }
  return { ok: true, bytesWritten: offset };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Read process.stdin to EOF and parse as JSON.
 * @returns {Promise<object|null>} Parsed JSON object, or null on empty stream.
 * @throws {SyntaxError} If stdin contains non-empty, non-JSON data.
 * @throws {Error} If the 1 MB size limit or 5 s timeout is exceeded.
 */
export async function readStdin() {
  const MAX_BYTES = 1_048_576; // 1 MB guard
  const TIMEOUT_MS = 5_000;   // 5 s guard

  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error('io.mjs: readStdin timed out after 5 s'));
    }, TIMEOUT_MS);

    const chunks = [];
    let totalBytes = 0;

    // If stdin is already closed (e.g. not a TTY with no data), handle cleanly.
    if (process.stdin.readableEnded) {
      clearTimeout(timer);
      resolve(null);
      return;
    }

    process.stdin.setEncoding('utf8');

    const onData = (chunk) => {
      if (controller.signal.aborted) return;
      totalBytes += Buffer.byteLength(chunk, 'utf8');
      if (totalBytes > MAX_BYTES) {
        cleanup();
        reject(new Error(`io.mjs: stdin payload exceeds 1 MB limit (${totalBytes} bytes read)`));
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = () => {
      if (controller.signal.aborted) return;
      cleanup();
      const raw = chunks.join('').trim();
      if (raw === '') {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new SyntaxError(`io.mjs: stdin is not valid JSON — got: ${raw.slice(0, 120)}`));
      }
    };

    const onError = (err) => {
      cleanup();
      reject(err);
    };

    const cleanup = () => {
      clearTimeout(timer);
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.off('error', onError);
    };

    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onError);

    // Resume in case the stream is paused (e.g. in flowing mode was never started).
    process.stdin.resume();
  });
}

/**
 * Allow the current hook invocation — exits 0 silently.
 * @returns {never}
 */
export function emitAllow() {
  process.exit(0);
}

/**
 * Deny the current **PreToolUse** hook invocation: emit exactly one JSON object
 * on stdout, then exit **0**.
 *
 * ## The contract (code.claude.com/docs/en/hooks), verbatim
 *
 * > "**Exit 2** means a blocking error. Claude Code **ignores stdout and any
 * > JSON in it**. Instead, stderr text is fed back to Claude as an error
 * > message."
 *
 * > "You must choose one approach per hook, **not both**: either use exit codes
 * > alone for signaling, or exit 0 and print JSON for structured control."
 *
 * > "Unlike other hooks that use a top-level `decision` field, **PreToolUse
 * > returns its decision inside a `hookSpecificOutput` object**" — which
 * > "requires a `hookEventName` field set to the event name."
 *
 * > PreToolUse top-level `decision` / `reason` are deprecated: "Use
 * > `hookSpecificOutput.permissionDecision` and
 * > `hookSpecificOutput.permissionDecisionReason` instead."
 *
 * Until #906 this function emitted stdout JSON **and** `exit 2` — the mixed
 * form the second quote forbids. The block still bit, but the reason was
 * discarded wholesale and the operator saw only `hook error: … No stderr
 * output`, i.e. what looks like a crash. Do not reintroduce either half of that
 * mixed form: `exit 2` here, or a flat top-level `{permissionDecision, reason}`.
 *
 * ## Emitted payload (single stdout line, nothing else on stdout)
 *
 * ```json
 * {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"<reason — suggestion>"},"systemMessage":"⛔ <first line of reason>"}
 * ```
 *
 * `permissionDecisionReason` is fed to **Claude**; the universal `systemMessage`
 * field is what the **operator** sees. Both are emitted on purpose: operator
 * visibility is the entire point of the #906 repair, and a `deny` whose cause is
 * invisible to the human is what pushed wave agents into circumventing the
 * enforcement layer. The headline is deliberately short (first line, clipped) —
 * the long text belongs in `permissionDecisionReason`.
 *
 * Multi-line reasons survive intact: `JSON.stringify` escapes the newlines, so
 * the payload stays exactly one line and consumers that parse stdout line-wise
 * (e.g. `scripts/lib/pi-hook-bridge.mjs`) keep working.
 *
 * ## PRECONDITION — PreToolUse hooks only
 *
 * `hookEventName` is hardcoded to `PreToolUse`. PostToolUse / Stop /
 * SubagentStop signal through a **top-level** `decision` / `reason` pair and
 * MUST NOT be routed through this helper.
 *
 * ## Delivery is part of the contract, not an implementation detail
 *
 * The envelope goes out through {@link writeStdoutLineSync}, never
 * `console.log`. On macOS a piped stdout is asynchronous, so `console.log` +
 * `process.exit(0)` silently drops everything past the 65 536-byte kernel pipe
 * buffer — a truncated envelope reads as "no structured output" and the tool
 * call is ALLOWED. Two independent bounds keep that from happening:
 *
 *  1. `permissionDecisionReason` is clamped to {@link DENY_REASON_MAX}, and the
 *     `opts.systemMessage` override to {@link DENY_HEADLINE_MAX}, so no caller
 *     — including one that funnels attacker-controlled tool input into the
 *     reason, as pre-bash-templates-first does with the raw bash command — can
 *     inflate the envelope past the buffer.
 *  2. The write itself is synchronous and loops to completion, so even an
 *     envelope that somehow exceeds the buffer still lands in full.
 *
 * Both are load-bearing: the clamp alone would not survive a caller that
 * bypasses it, and the synchronous write alone would ship 200 KB envelopes to
 * the harness. If stdout cannot be written at all (EPIPE — the reader is gone),
 * the helper exits **2**: with no structured channel left, the exit code is the
 * only remaining way to block, and the "never both" rule is not violated
 * because no parseable JSON was delivered.
 *
 * @param {string} reason  Human-readable denial reason. May be multi-line. When
 *        blank/absent the call still DENIES (with a generic reason plus a stderr
 *        diagnostic) — see {@link EMPTY_REASON_FALLBACK} for why this does not
 *        throw.
 * @param {string} [suggestion]  Optional remediation hint appended after " — ".
 * @param {object} [opts]
 * @param {string} [opts.systemMessage]  Override the derived operator headline.
 *        Ignored when blank; clipped to one short line.
 * @returns {never}
 */
export function emitDeny(reason, suggestion, opts = {}) {
  // Coerce defensively and never throw: a throw inside a deny path unwinds into
  // the fail-open `main().catch(() => emitAllow())` that four hooks install,
  // turning the deny into an ALLOW. A guard must never fail open on its own
  // bookkeeping — so a missing reason degrades to a generic deny plus a loud
  // stderr diagnostic, which keeps the programmer-error signal without the
  // fail-open blast radius.
  const raw = typeof reason === 'string'
    ? reason
    : (reason === null || reason === undefined ? '' : String(reason));
  const missingReason = raw.trim() === '';
  if (missingReason) {
    try {
      process.stderr.write(
        '⚠ io.mjs: emitDeny called without a reason — denying with a generic message (guard bug)\n',
      );
    } catch { /* stderr may be closed; the deny below is what matters */ }
  }
  const permissionDecisionReason = _clampReason(
    String(_formatReason(missingReason ? EMPTY_REASON_FALLBACK : raw, suggestion)),
  );
  const override = typeof opts?.systemMessage === 'string' ? opts.systemMessage.trim() : '';
  const line = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason,
    },
    systemMessage: override !== ''
      ? _clip(override, DENY_HEADLINE_MAX)
      : _denyHeadline(permissionDecisionReason),
  });
  const result = writeStdoutLineSync(line);
  // stdout delivered → exit 0 (structured channel). stdout unwritable → exit 2,
  // the only blocking signal left. Never exit 0 on a failed write: that is the
  // fail-open case this whole helper exists to prevent.
  process.exit(result.ok ? 0 : 2);
}

/**
 * Emit an operator-visible warning and exit **0** — "allow, with a notice".
 *
 * ## Why this is not stderr-only (#916)
 *
 * Until #916 this helper wrote only to stderr. Under the exit-0 branch of the
 * hook contract that channel goes nowhere: `docs/plugin-architecture-v3.md`
 * states "stderr | Only for debugging. Not surfaced to the user.", and
 * `skills/hook-development/SKILL.md` puts it plainly — "When the hook exits 0
 * here it is **silent** — no stdout, no stderr". So every `enforcement: warn`
 * scope/command violation was announced to a debug log and to nobody else. A
 * warning that reaches neither the operator nor the model is not a warning.
 *
 * The visible channel is the universal top-level `systemMessage` field — the
 * same one {@link emitDeny} already rides for its ⛔ headline, and the one
 * {@link emitSystemMessage} documents. It is emitted here WITHOUT any
 * `hookSpecificOutput` / `permissionDecision`, which is precisely what keeps
 * warn non-blocking: the harness sees a message but no decision.
 *
 * stderr is retained unchanged for debug-log and CI-capture parity.
 *
 * ## Consumer contract — stdout in the warn path is no longer empty
 *
 * `scripts/lib/pi-hook-bridge.mjs#readHookDecision` scans stdout line-wise and
 * keeps the first line that actually carries a `permissionDecision`; a
 * decision-less JSON line (this one) is skipped, so the Pi lane reports
 * `{decision: null, deny: false, malformed: false}` ⇒ not blocked. Verified
 * empirically, not assumed. Codex does not wire these hooks at all
 * (`hooks/hooks-codex.json` has `"PreToolUse": []`), and `hooks/hooks-cursor.json`
 * is a documentation-only mapping reference with no in-repo executor.
 *
 * ## Delivery: the same two bounds {@link emitDeny} uses, for a sharper reason
 *
 * The write goes through {@link writeStdoutLineSync}, never `console.log`, and
 * the message is clamped to {@link WARN_MESSAGE_MAX}. On macOS a piped stdout is
 * asynchronous, so `console.log` + `process.exit(0)` drops everything past the
 * 65 536-byte kernel pipe buffer — and `enforce-scope` interpolates the whole
 * `allowedPaths` union into its warn text TWICE, so this path genuinely reaches
 * five figures. A truncated line here is worse than a lost warning: the Pi
 * bridge classifies an unparseable `{`-prefixed line as `malformed`, which for
 * PreToolUse fails CLOSED — i.e. pipe truncation would silently convert
 * `enforcement: warn` into a hard block. Both bounds are load-bearing.
 *
 * ## Deliberate asymmetry to emitDeny: an unwritable stdout still exits 0
 *
 * {@link emitDeny} exits 2 when stdout cannot be written, because with no
 * structured channel left the exit code is its only way to block. The warn path
 * inverts that: its decision is "allow", so a failed write must cost the
 * NOTICE, never the permission. Exiting non-zero here would turn a dropped
 * warning into a blocked tool call.
 *
 * @param {string} message  Warning text. Emitted on stderr and as the
 *        `systemMessage` payload, both prefixed with "⚠ ".
 * @returns {never}
 */
export function emitWarn(message) {
  // Coerce defensively: a throw here would unwind into the callers' top-level
  // `main().catch(() => emitDeny(...))`, turning an allow-with-notice into a DENY.
  const raw = typeof message === 'string'
    ? message
    : (message === null || message === undefined ? '' : String(message));
  const text = `⚠ ${_clampReason(raw, WARN_MESSAGE_MAX)}`;

  // Debug channel — unchanged. Invisible under exit 0, kept for log/CI capture.
  try {
    console.error(text);
  } catch { /* stderr may be closed; the visible channel below is what matters */ }

  // Visible channel. Return value is deliberately ignored — see the asymmetry
  // note above: a warning that cannot be delivered must not become a block.
  writeStdoutLineSync(JSON.stringify({ systemMessage: text }));
  process.exit(0);
}

/**
 * Inject a system message into the hook response without exiting.
 * @param {string} msg  Message text wrapped in a systemMessage JSON envelope on stdout.
 */
export function emitSystemMessage(msg) {
  console.log(JSON.stringify({ systemMessage: msg }));
}

/**
 * Atomically write a JSON value to filePath. Creates parent directories as needed.
 *
 * Crash-safe pattern: write to `<filePath>.<rand>.tmp`, then `rename()` over the
 * target. Same-filesystem rename is atomic on POSIX, so partial-write states are
 * impossible — observers see either the previous contents or the new ones, never
 * a half-written file.
 *
 * When `validatorFn` is provided, the value is validated BEFORE any disk write.
 * Validation failure throws an Error with `.validationErrors` attached and leaves
 * the target file untouched.
 *
 * Caller is responsible for path-confinement (see scripts/lib/path-utils.mjs#validatePathInsideProject)
 * — this helper does NOT validate that filePath lives inside the project.
 *
 * Added for persona-panel sidecar writes (issue #457).
 *
 * @param {string} filePath  Target path; parent dirs created with mkdir -p semantics.
 * @param {*} value          JSON-serializable value.
 * @param {object} [opts]
 * @param {(value: *) => {ok: boolean, errors?: Array<object>}} [opts.validatorFn]
 *        Pre-write validator. Throws (without writing) on `ok=false`.
 * @param {number} [opts.indent=2]  JSON.stringify indent.
 * @returns {Promise<{ path: string, bytes: number }>}
 * @throws {Error} If validatorFn rejects the value (with `.validationErrors` array attached).
 */
export async function writeJsonAtomic(filePath, value, opts = {}) {
  const { validatorFn, indent = 2 } = opts;

  if (typeof validatorFn === 'function') {
    const result = validatorFn(value);
    if (!result || result.ok !== true) {
      const err = new Error('writeJsonAtomic: validation failed before write');
      err.validationErrors = (result && result.errors) || [];
      throw err;
    }
  }

  await mkdir(dirname(filePath), { recursive: true });

  const tmp = `${filePath}.${randomUUID().slice(0, 8)}.tmp`;
  const content = JSON.stringify(value, null, indent);
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, filePath);

  return { path: filePath, bytes: Buffer.byteLength(content, 'utf8') };
}

/**
 * Atomically replace a file via tmp + renameSync. Synchronous companion to
 * {@link writeJsonAtomic} for hot-path code that cannot await — session-lock
 * acquire/replace, staging-fence intent logs, and other crash-safe sidecar
 * writes invoked from PreToolUse hooks where async would add a microtask hop.
 *
 * Crash-safe pattern: write to `<dir>/<tmpPrefix>.<rand>` then renameSync over
 * the target. Same-filesystem rename is atomic on POSIX, so partial-write
 * states are impossible — observers see either the previous contents or the
 * new ones, never a half-written file.
 *
 * Caller is responsible for path-confinement — this helper does NOT validate
 * that filePath lives inside the project (mirrors the async {@link writeJsonAtomic}
 * contract).
 *
 * Hook-safety: io.mjs MUST NOT reverse-import from `hooks/` — this helper is a
 * pure Node-stdlib utility (`node:fs`, `node:path`, `node:crypto`) so it can be
 * used from any layer without violating the layering rule in
 * `scripts/lib/hardening.mjs`.
 *
 * @param {string} filePath  Target path; parent dirs created with mkdir -p semantics.
 * @param {*} data           JSON-serializable value.
 * @param {object} [opts]
 * @param {number} [opts.indent=2]      JSON.stringify indent.
 * @param {string} [opts.tmpPrefix='.tmp']  Tmp-file prefix (callers pick their domain prefix).
 * @returns {{ ok: true } | { ok: false, reason: 'fs-error', error: string }}
 */
export function writeJsonAtomicSync(filePath, data, opts = {}) {
  const { indent = 2, tmpPrefix = '.tmp' } = opts;
  try {
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true });
    const tmpSuffix = randomBytes(6).toString('hex');
    const tmpFile = path.join(dir, `${tmpPrefix}.${tmpSuffix}`);
    writeFileSync(tmpFile, JSON.stringify(data, null, indent) + '\n', { encoding: 'utf8' });
    renameSync(tmpFile, filePath);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'fs-error', error: err?.message ?? String(err) };
  }
}

/**
 * Parse newline-delimited JSON (JSONL) into an array of parsed objects.
 *
 * Splits `raw` on '\n', drops blank / whitespace-only lines, and JSON.parses
 * each remaining line. This is the shared, tested replacement for the inline
 * `raw.split('\n').filter(l => l.trim().length > 0).map(JSON.parse)` idiom that
 * is re-implemented across ~30 metrics / event readers.
 *
 * Empty or whitespace-only input returns `[]` and never throws.
 *
 * @param {string} raw  Raw JSONL text.
 * @param {object} [opts]
 * @param {boolean} [opts.skipInvalid=false]  When `true`, silently skip lines
 *        that fail JSON.parse. When `false` (default), throw an Error naming the
 *        1-based source line number plus a short snippet of the offending line,
 *        so callers get actionable diagnostics.
 * @returns {object[]}  Parsed objects, in source order.
 * @throws {Error} When `skipInvalid` is false and a non-blank line is not valid JSON.
 */
export function readJsonlLines(raw, opts = {}) {
  const { skipInvalid = false } = opts;
  if (typeof raw !== 'string' || raw.trim().length === 0) return [];

  const out = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) continue;
    try {
      out.push(JSON.parse(line));
    } catch (err) {
      if (skipInvalid) continue;
      const snippet = line.length > 80 ? `${line.slice(0, 80)}…` : line;
      throw new Error(
        `io.mjs: readJsonlLines failed to parse JSON on line ${i + 1}: ${snippet} (${err?.message ?? String(err)})`,
        { cause: err },
      );
    }
  }
  return out;
}

/**
 * Read a UTF-8 JSONL file and parse it via {@link readJsonlLines}.
 *
 * A missing file returns `[]` rather than throwing — JSONL metrics / events
 * sidecars (e.g. `.orchestrator/metrics/*.jsonl`) are routinely absent on first
 * run, and callers should treat "no file" identically to "empty file".
 *
 * @param {string} filePath  Path to a UTF-8 JSONL file.
 * @param {object} [opts]    Forwarded to {@link readJsonlLines} (e.g. `{ skipInvalid: true }`).
 * @returns {object[]}  Parsed objects, or `[]` when the file does not exist.
 * @throws {Error} When the file exists but a non-blank line is invalid and `skipInvalid` is false.
 */
export function readJsonlFile(filePath, opts = {}) {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, 'utf8');
  return readJsonlLines(raw, opts);
}
