/**
 * io.mjs — stdin/stdout helpers implementing the Claude Code hook I/O contract,
 * plus shared atomic file-write helpers used by skills that need crash-safe
 * sidecar JSON output (e.g. persona-panel, issue #457).
 *
 * Provides promise-based stdin JSON reading and structured exit helpers used by
 * PreToolUse / PostToolUse hooks in the session-orchestrator v3 migration, and
 * `writeJsonAtomic` for tmp+rename JSON writes with optional pre-write validation.
 *
 * No external dependencies — Node 20+ stdlib only.
 *
 * Part of v3.0.0 migration (Epic #124, issue #131); writeJsonAtomic added for #457.
 */

import { writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the deny reason string, optionally appending a suggestion.
 * @param {string} reason
 * @param {string|undefined} suggestion
 * @returns {string}
 */
function _formatReason(reason, suggestion) {
  return suggestion ? `${reason} — ${suggestion}` : reason;
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
 * Deny the current hook invocation with a structured JSON reason on stdout, then exit 2.
 * @param {string} reason  Non-empty human-readable denial reason.
 * @param {string} [suggestion]  Optional remediation hint appended after " — ".
 * @returns {never}
 */
export function emitDeny(reason, suggestion) {
  if (!reason) throw new TypeError('io.mjs: emitDeny requires a non-empty reason string');
  console.log(JSON.stringify({ permissionDecision: 'deny', reason: _formatReason(reason, suggestion) }));
  process.exit(2);
}

/**
 * Emit a warning message to stderr and exit 0 (allow with notice).
 * @param {string} message  Warning text written to stderr prefixed with "⚠ ".
 * @returns {never}
 */
export function emitWarn(message) {
  console.error(`⚠ ${message}`);
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
