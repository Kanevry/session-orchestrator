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
import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync } from 'node:fs';
import path, { dirname } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

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
