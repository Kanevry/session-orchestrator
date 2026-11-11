/**
 * context-threshold.mjs — measure a session's own context size from its
 * transcript and decide the one-time threshold hints (#1960).
 *
 * Context = `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`
 * of the LAST valid assistant line of the session's MAIN chain. Sidechain lines
 * (`isSidechain: true`, subagent turns written into the parent transcript by
 * older harness builds) are never counted; neither is a zero-token line (the
 * harness writes `<synthetic>` error turns with all-zero usage, which would
 * read as an empty context).
 *
 * Cost: the hook runs on every PostToolUse, so the transcript is only ever
 * TAIL-read — `TAIL_STEPS` bytes from the end, widening only while no valid
 * line was found (a single huge tool_result line can push the last assistant
 * line out of a small window). The whole file is never read past
 * `TAIL_STEPS.at(-1)` bytes; beyond that the context is "nicht messbar".
 *
 * Three states, never two (`measured` / `unmeasurable` / fired markers):
 * an unmeasurable call returns `{ status: 'unmeasurable' }` and callers must
 * neither write a marker nor report "below the threshold" for it — the label
 * is {@link UNMEASURABLE_LABEL}.
 *
 * Imports node builtins plus `io.mjs` (already hook-reachable via loop-guard):
 * the module is reached from a PostToolUse hook and must stay cheap to load.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeJsonAtomicSync } from './io.mjs';

/** Label for a context that could not be measured. Never "unter der Schwelle". */
export const UNMEASURABLE_LABEL = 'nicht messbar';

/** Tail-read windows in bytes, tried in order until a valid line is found. */
export const TAIL_STEPS = Object.freeze([64 * 1024, 512 * 1024, 2 * 1024 * 1024]);

/**
 * Token sum of one parsed transcript record when it is a valid main-chain
 * assistant line, else null.
 *
 * @param {unknown} rec
 * @returns {number|null}
 */
export function contextTokensOf(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const r = /** @type {Record<string, any>} */ (rec);
  if (r.type !== 'assistant') return null;
  if (r.isSidechain === true) return null;
  const usage = r.message?.usage;
  if (!usage || typeof usage !== 'object') return null;
  let sum = 0;
  let any = false;
  for (const key of ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
    const v = usage[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      sum += v;
      any = true;
    }
  }
  return any && sum > 0 ? sum : null;
}

/**
 * Scan JSONL text from the end and return the token sum of the last valid
 * main-chain assistant line.
 *
 * @param {string} text
 * @param {{ dropFirstLine?: boolean }} [opts] — drop the first line when the
 *   text starts mid-file (it is a cut line)
 * @returns {number|null}
 */
export function lastContextTokens(text, { dropFirstLine = false } = {}) {
  const lines = text.split('\n');
  const start = dropFirstLine ? 1 : 0;
  for (let i = lines.length - 1; i >= start; i--) {
    const line = lines[i];
    // Cheap pre-filter before JSON.parse — most lines are user/tool records.
    if (!line || !line.includes('"assistant"') || !line.includes('"usage"')) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const tokens = contextTokensOf(rec);
    if (tokens !== null) return tokens;
  }
  return null;
}

/**
 * Measure the context of the transcript at `transcriptPath`.
 *
 * @param {unknown} transcriptPath — `transcript_path` from the hook payload
 * @param {{ steps?: readonly number[] }} [opts]
 * @returns {{ status: 'measured', tokens: number, bytesRead: number }
 *   | { status: 'unmeasurable', reason: string, bytesRead: number }}
 */
export function measureContext(transcriptPath, { steps = TAIL_STEPS } = {}) {
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) {
    return { status: 'unmeasurable', reason: 'no transcript_path', bytesRead: 0 };
  }
  let fd;
  try {
    // O_NONBLOCK: a FIFO at the path would otherwise block this synchronous
    // open until the hook timeout. Symlinks are still followed (no O_NOFOLLOW):
    // nothing shows the harness never hands a symlinked transcript path, and
    // the fstat below already refuses anything but a regular file.
    fd = fs.openSync(transcriptPath, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  } catch (err) {
    return { status: 'unmeasurable', reason: `open failed: ${err?.code ?? 'unknown'}`, bytesRead: 0 };
  }
  let bytesRead = 0;
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { status: 'unmeasurable', reason: 'not a regular file', bytesRead: 0 };
    const size = st.size;
    for (const step of steps) {
      const len = Math.min(step, size);
      const buf = Buffer.alloc(len);
      const pos = size - len;
      const n = fs.readSync(fd, buf, 0, len, pos);
      bytesRead += n;
      const tokens = lastContextTokens(buf.toString('utf8', 0, n), { dropFirstLine: pos > 0 });
      if (tokens !== null) return { status: 'measured', tokens, bytesRead };
      if (len >= size) break; // whole file seen
    }
    return { status: 'unmeasurable', reason: 'no usage line in tail', bytesRead };
  } catch (err) {
    return { status: 'unmeasurable', reason: `read failed: ${err?.code ?? 'unknown'}`, bytesRead };
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * Check-in value for `kontext_k`: whole thousands, or {@link UNMEASURABLE_LABEL}.
 *
 * @param {ReturnType<typeof measureContext>} m
 * @returns {number|string}
 */
export function kontextK(m) {
  return m.status === 'measured' ? Math.round(m.tokens / 1000) : UNMEASURABLE_LABEL;
}

/**
 * Decide which hints fire for a MEASURED value. Pure.
 *
 * `fired` holds the levels already announced this session. A value below
 * `prepareK` after a hint fired (a /compact shrank the context) re-arms both
 * levels, so the next crossing is announced again.
 *
 * @param {{ tokens: number, prepareK: number, handoverK: number,
 *   fired: { prepare?: boolean, handover?: boolean } }} args
 * @returns {{ hints: Array<'prepare'|'handover'>,
 *   fired: { prepare: boolean, handover: boolean }, changed: boolean }}
 */
export function decideHints({ tokens, prepareK, handoverK, fired }) {
  const prev = { prepare: fired?.prepare === true, handover: fired?.handover === true };
  if (tokens < prepareK * 1000) {
    const changed = prev.prepare || prev.handover;
    return { hints: [], fired: { prepare: false, handover: false }, changed };
  }
  /** @type {Array<'prepare'|'handover'>} */
  const hints = [];
  const next = { ...prev };
  if (tokens >= handoverK * 1000) {
    if (!prev.handover) hints.push('handover');
    // Crossing straight past both levels in one jump announces only the
    // stronger one; prepare is implied and must not fire later on top.
    next.prepare = true;
    next.handover = true;
  } else if (!prev.prepare) {
    hints.push('prepare');
    next.prepare = true;
  }
  const changed = next.prepare !== prev.prepare || next.handover !== prev.handover;
  return { hints, fired: next, changed };
}

/**
 * Hint text in the wording of #1960, with the measured value.
 *
 * @param {'prepare'|'handover'} level
 * @param {number} tokens
 * @param {{ prepareK: number, handoverK: number }} cfg
 * @returns {string}
 */
export function hintText(level, tokens, { prepareK, handoverK }) {
  const k = Math.round(tokens / 1000);
  return level === 'handover'
    ? `Kontext ${handoverK}k: am nächsten MR-Schnitt übergeben. (gemessen: ${k}k)`
    : `Kontext ${prepareK}k: Übergabe-Datei vorbereiten, keine neue Welle mehr beginnen. (gemessen: ${k}k)`;
}

// ---------------------------------------------------------------------------
// Once-marker (per session, under os.tmpdir())
// ---------------------------------------------------------------------------

/**
 * Marker file for one session. Keyed by the session's own id; the env override
 * exists for test isolation only.
 *
 * @param {string} sessionId
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function markerPath(sessionId, env = process.env) {
  const dir = (env.SO_CONTEXT_THRESHOLD_DIR || '').trim() || os.tmpdir();
  return path.join(dir, `so-context-threshold-${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}

/**
 * Read the fired levels. A marker counts only when it names THIS session id
 * AND this transcript path and belongs to this uid — a file another process
 * pre-created for a guessed id cannot switch the hint off. Anything else reads
 * as "nothing fired" (the hint repeats rather than going silent).
 *
 * @param {string} file
 * @param {{ sessionId: string, transcriptPath: string }} own
 * @returns {{ prepare: boolean, handover: boolean }}
 */
export function readMarker(file, { sessionId, transcriptPath }) {
  const none = { prepare: false, handover: false };
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile()) return none;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return none;
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!m || m.session_id !== sessionId || m.transcript_path !== transcriptPath) return none;
    return { prepare: m.fired?.prepare === true, handover: m.fired?.handover === true };
  } catch {
    return none;
  }
}

/**
 * Atomically write the fired levels (tmp + rename via `writeJsonAtomicSync`,
 * mode 0600). Throws on a failed write so the hook logs it and stays silent
 * rather than repeating the hint on every call.
 *
 * @param {string} file
 * @param {{ sessionId: string, transcriptPath: string,
 *   fired: { prepare: boolean, handover: boolean }, tokens: number }} rec
 */
export function writeMarker(file, { sessionId, transcriptPath, fired, tokens }) {
  const res = writeJsonAtomicSync(file, {
    session_id: sessionId,
    transcript_path: transcriptPath,
    fired,
    measured_tokens: tokens,
    at: new Date().toISOString(),
  }, { tmpPrefix: '.tmp-context-threshold', mode: 0o600 });
  if (!res.ok) throw new Error(`marker write failed: ${res.code ?? res.error ?? 'unknown'}`);
}
