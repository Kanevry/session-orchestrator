/**
 * rollout-meta.mjs — reads the session metadata a Codex rollout transcript
 * carries on its first line (GitLab #1889). Pure, Node-built-ins only,
 * import-safe: it is loaded by the Stop hook `hooks/on-stop.mjs` on every
 * harness, and a module that throws at import time there breaks every turn end.
 *
 * ## What is measured and what is not
 *
 * MEASURED (codex-cli 0.160.1, macOS, 2026-11-02): line 0 of a rollout under
 * `~/.codex/sessions/` is a `session_meta` record; a one-shot `codex exec`
 * run carries `payload.source: "exec"` and `payload.originator: "codex_exec"`,
 * a subagent thread an OBJECT (`{"subagent":{…}}`), Codex Desktop `"vscode"`.
 *
 * MEASURED (same host and version, 2026-11-02): `codex exec resume <id> "<prompt>"`
 * APPENDS to the same rollout file — no new file, no second `session_meta`, line 0
 * unchanged (`source: "exec"`, `thread_source: "user"`). The resumed turn
 * appears as two `thread_settings_applied` events, then a second `task_started`
 * and `turn_context`. A resumed exec run is itself one process with one turn,
 * so its Stop is still its end and the marker still classifies it as `exec`.
 *
 * NOT MEASURED: an INTERACTIVE `codex resume` of an exec thread (needs a TTY).
 * Line 0 would still read `exec`, so that session would release its lock at
 * its first Stop and run its later turns lockless until the next SessionStart.
 * Ceiling accepted: no measured record tells the two resume routes apart.
 * Revisit when an interactive resume rollout can be captured.
 */
import fs from 'node:fs';

/**
 * Upper bound on the bytes `readCodexExecMarker()` reads from a rollout
 * (#1889). Measured 2026-11-02 (codex-cli 0.160.1): line 0 of 11 rollouts was
 * 22663–23161 bytes, almost all of it `payload.base_instructions`. Ceiling:
 * a first line longer than this classifies as 'no-meta' (no release, TTL
 * fallback). Revisit when Codex ships a longer base prompt.
 */
const CODEX_META_READ_BYTES = 256 * 1024;

/**
 * Tell a one-shot `codex exec` run from every other Codex thread by the first
 * line of its rollout transcript (#1889).
 *
 * Codex gives the hook process no env marker for exec mode, and the Stop
 * payload's own fields (`source`, `permission_mode`) do not discriminate.
 * The rollout named by the payload's `transcript_path` does: its line 0 is
 * `{"type":"session_meta","payload":{…,"originator":"codex_exec","source":"exec",…}}`.
 * A subagent thread carries `payload.source` as an OBJECT
 * (`{"subagent":{…}}`), never the string — so only the string `"exec"`
 * counts.
 *
 * Reads at most `CODEX_META_READ_BYTES` from offset 0 (never the whole file),
 * refuses anything that is not a regular file (a FIFO open would block), and
 * never throws. Every non-'exec' reason means "do not release".
 *
 * A `codex exec resume` run appends to the same rollout and still reads
 * `exec` here (measured); an interactive `codex resume` of an exec thread
 * would too (unmeasured ceiling, see the module header).
 *
 * @param {unknown} transcriptPath  the hook payload's `transcript_path`
 * @returns {{ exec: boolean, reason: 'exec'|'not-exec'|'no-path'|'unreadable'|'no-meta'|'subagent' }}
 */
export function readCodexExecMarker(transcriptPath) {
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) {
    return { exec: false, reason: 'no-path' };
  }

  let firstLine;
  let fd = null;
  try {
    if (!fs.statSync(transcriptPath).isFile()) return { exec: false, reason: 'unreadable' };
    fd = fs.openSync(transcriptPath, 'r');
    if (!fs.fstatSync(fd).isFile()) return { exec: false, reason: 'unreadable' };
    const buf = Buffer.alloc(CODEX_META_READ_BYTES);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.toString('utf8', 0, n);
    const nl = text.indexOf('\n');
    // No newline inside a full buffer: line 0 is longer than the bound.
    if (nl === -1 && n === buf.length) return { exec: false, reason: 'no-meta' };
    firstLine = nl === -1 ? text : text.slice(0, nl);
  } catch {
    return { exec: false, reason: 'unreadable' };
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* best-effort close */ }
    }
  }

  let meta;
  try {
    meta = JSON.parse(firstLine);
  } catch {
    return { exec: false, reason: 'no-meta' };
  }
  if (meta === null || typeof meta !== 'object' || meta.type !== 'session_meta') {
    return { exec: false, reason: 'no-meta' };
  }
  const source = meta.payload !== null && typeof meta.payload === 'object' ? meta.payload.source : undefined;
  if (source === 'exec') return { exec: true, reason: 'exec' };
  if (source !== null && typeof source === 'object' && 'subagent' in source) {
    return { exec: false, reason: 'subagent' };
  }
  return { exec: false, reason: 'not-exec' };
}
