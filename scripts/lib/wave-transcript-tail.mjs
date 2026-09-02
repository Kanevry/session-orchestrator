#!/usr/bin/env node
/**
 * wave-transcript-tail.mjs — FA-1 wave supervision (#1114).
 *
 * Tails the LIVE subagent transcripts of the OWN session and brings the
 * existing `stagnation_detected` event to fire DURING a wave, instead of only
 * after it from the coordinator's post-wave review (see
 * `skills/wave-executor/circuit-breaker.md`: *"these checks run … after the
 * wave completes — not during the agent's execution"*).
 *
 * Substrate (measured 2026-08-25):
 *   ~/.claude/projects/<encoded-repo-path>/<session-uuid>/subagents/
 *     agent-<id>.jsonl        — append-only NDJSON, flushed PER TURN
 *     agent-<id>.meta.json    — {"agentType","description","toolUseId",…}
 *   The `subagents/` directory does not exist until the first spawn, so the
 *   tailer POLLS for it to appear rather than exiting on ENOENT.
 *
 * Three detectors (PRD docs/prd/2026-08-22-wellen-supervision.md § FA-1):
 *   - psa007-git-write — a subagent ran a git INDEX/HISTORY write (PSA-007).
 *   - error-echo       — 3x the same error class on the same file.
 *   - status-partial   — the agent wrote STATUS: partial|blocked|failed.
 *
 * Fail-open by construction: every failure path writes ONE stderr line and
 * keeps polling (or exits 0). No agent is ever blocked — the tailer is an
 * out-of-process observer with no channel back into the wave.
 *
 * Multi-session safety: only `<own-session-uuid>/subagents/` is read. A peer
 * session's transcripts in the same projects directory are never touched.
 *
 * Single instance per working copy: the monitor starts on
 * `on-skill-invoke:wave-executor`, which a deep session triggers repeatedly, so
 * a second tailer would double every record. It claims a PID lockfile at
 * `.orchestrator/wave-transcript-tail.lock` and exits 0 when another live
 * tailer holds it.
 *
 * Flags:
 *   --tail          Run the tail loop (required; no other mode supported).
 *   --interval=N    Poll cadence in seconds (default 2).
 *   --help, -h      Print usage to stderr and exit 0.
 *
 * Exit codes:
 *   0 — clean shutdown (SIGTERM/SIGINT), or fail-open give-up.
 *   1 — user/input error (unknown flag, --tail missing).
 *   2 — system error inside the tail loop.
 */

import {
  existsSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

import { emitEvent, sessionAttribution } from './events.mjs';
import { tryAcquireFileLock, releaseFileLock } from './file-lock.mjs';
import { readLock, isLockLive } from './session-lock.mjs';
import { resolveSubagentSidecar } from '../../hooks/_lib/subagent-paths.mjs';

const DEFAULT_INTERVAL_S = 2;
const EVENTS_FILE_REL = '.orchestrator/metrics/events.jsonl';
const WAVE_SCOPE_REL = '.claude/wave-scope.json';

/**
 * Single-instance guard. `monitors/monitors.json` starts this tailer on
 * `on-skill-invoke:wave-executor`, and a deep session invokes wave-executor
 * repeatedly — so without a guard N tailers run concurrently, each seeds its
 * counters from byte 0, and each emits the same finding.
 *
 * Measured 2026-08-25 in this repo's own ledger: 4 of 5 `stagnation_detected`
 * records were exact duplicates in two pairs, 6 ms and 8 ms apart.
 */
const SINGLETON_LOCK_REL = '.orchestrator/wave-transcript-tail.lock';

/**
 * Occurrence threshold at which a pattern first emits. `error-echo` needs the
 * documented 3 repetitions (circuit-breaker.md § Decision Table); the other two
 * are single-shot facts — one `git commit` is already the PSA-007 violation.
 */
const EMIT_THRESHOLD = {
  'psa007-git-write': 1,
  'error-echo': 3,
  'status-partial': 1,
};

/**
 * Monitor output is rate-limited, so `occurrences` is an AGGREGATION WINDOW:
 * after the first emit a key re-emits only every N further hits.
 */
const RE_EMIT_EVERY = 10;

/**
 * git subcommands that mutate the shared index, the stash stack, or remote
 * history — the PSA-007 prohibition list, verbatim.
 */
const GIT_WRITE_RE = /^\s*git\s+(?:-[^\s]+\s+)*(add|commit|stash|push|mv|rm|reset|checkout\s+--)\b/;

/**
 * STATUS literals that all report as pattern `status-partial`.
 *
 * LINE-ANCHORED on purpose. A free-floating `/STATUS: partial/` fires on any
 * agent that merely QUOTES the marker — measured 2026-08-25 against this
 * session's own transcripts: 2 of 2 live hits were Explore agents citing the
 * PRD's acceptance criteria and describing this very detector, 0 were real
 * status reports. Agents report the marker at the start of its own line
 * (optionally bold); quotations sit mid-sentence or inside backticks.
 */
const STATUS_RE = /^[ \t*_]*STATUS:\s*(partial|blocked|failed)\b/im;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Encode a repo path the way Claude Code names its projects directory:
 * every `/` and `.` becomes `-`.
 *
 * Ceiling: derived from the observed encoding of paths without unusual
 * characters (`-Users-…-session-orchestrator`). Revisit if a repo path with
 * spaces or non-ASCII characters ever fails to resolve.
 *
 * @param {string} repoRoot
 * @returns {string}
 */
export function encodeProjectDir(repoRoot) {
  return String(repoRoot).replace(/[/.]/g, '-');
}

/** @param {unknown} v @returns {string} */
function trimmedString(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Resolve the TWO session identities this tailer needs. They are different
 * strings and neither substitutes for the other:
 *
 *   - `sessionId` — the harness UUID. Names the transcript DIRECTORY
 *     (`<projects>/<encoded-repo>/<uuid>/subagents/`) and the `session_id`
 *     binding in `.claude/wave-scope.json`.
 *   - `semanticSessionId` — the id both consumers of `stagnation_detected`
 *     JOIN on: `scripts/compute-grounding-injection.sh` intersects `.session`
 *     against the `session_id`s of `.orchestrator/metrics/sessions.jsonl`, and
 *     `skills/session-end/metrics-collection.md` filters `.session == $sid`.
 *     Both of those are SEMANTIC ids (`main-2026-08-24-session-1`), so a record
 *     whose `session` carries the UUID joins with nothing and the feature
 *     measures as zero records — indistinguishable from the pre-#1114 dead
 *     state. Measured 2026-08-25: all 5 ledger records carried the UUID.
 *
 * Precedence for `sessionId`: the harness env var, then a LIVE session lock,
 * then the newest session directory by mtime. Precedence for
 * `semanticSessionId`: `sessionAttribution()` (the same field `report()` emits
 * as `semantic_session_id`, so the two can never disagree), then a live lock,
 * then the raw id with a stderr note.
 *
 * The lock tier is liveness-gated (`isLockLive`, heartbeat-based). A STALE lock
 * names a session whose transcript directory stopped growing, so trusting it
 * makes the tailer supervise nothing forever after one startup line — it falls
 * through to the mtime probe instead.
 *
 * Returns null when no raw id resolves — the caller then fails open with a
 * single stderr line.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {Record<string, string|undefined>} [opts.env]
 * @param {string} [opts.projectsDir] — `<projects>/<encoded-repo>` directory.
 * @returns {{ sessionId: string, source: string, semanticSessionId: string, semanticSource: string } | null}
 */
export function resolveSessionId({ repoRoot, env = process.env, projectsDir }) {
  let lock = null;
  try {
    lock = readLock({ repoRoot });
  } catch {
    // Unreadable lock — `lock` stays null and every lock tier below is skipped.
  }
  const liveLock = lock && isLockLive(lock) ? lock : null;

  /** @type {{sessionId: string, source: string} | null} */
  let raw = null;
  const fromEnv = trimmedString(env.CLAUDE_CODE_SESSION_ID);
  if (fromEnv) {
    raw = { sessionId: fromEnv, source: 'env' };
  } else if (trimmedString(liveLock?.session_id)) {
    raw = { sessionId: trimmedString(liveLock.session_id), source: 'session.lock' };
  } else if (projectsDir && existsSync(projectsDir)) {
    try {
      const newest = readdirSync(projectsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => ({ name: d.name, mtime: statSync(join(projectsDir, d.name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)[0];
      if (newest) raw = { sessionId: newest.name, source: 'newest-mtime' };
    } catch {
      // Unreadable projects dir — nothing left to try.
    }
  }
  if (!raw) return null;

  let semanticSessionId = '';
  let semanticSource = '';
  try {
    semanticSessionId = trimmedString(sessionAttribution(repoRoot).semantic_session_id);
    if (semanticSessionId) semanticSource = 'session-attribution';
  } catch {
    // Attribution unavailable — `semanticSessionId` stays '' and the lock tier runs.
  }
  if (!semanticSessionId && trimmedString(liveLock?.semantic_session_id)) {
    semanticSessionId = trimmedString(liveLock.semantic_session_id);
    semanticSource = 'session.lock';
  }
  if (!semanticSessionId) {
    // Honest degradation: the raw id is a real identifier, just not the one the
    // two consumers join on — so the record is still written, and the note says
    // why it will not appear in a per-session roll-up.
    semanticSessionId = raw.sessionId;
    semanticSource = 'raw-fallback';
    note(`no semantic session id resolvable — 'session' falls back to the raw id ${raw.sessionId}`);
  }

  return { ...raw, semanticSessionId, semanticSource };
}

/**
 * Read the wave number, but ONLY when the scope file proves it belongs to this
 * session. `.claude/wave-scope.json` binds to the WORKING COPY, not to a
 * session (the #1082 class), so an unbound file is reported as `null` rather
 * than attributed to whoever happens to be tailing.
 *
 * @param {string} repoRoot
 * @param {string} sessionId
 * @returns {number | null}
 */
export function readWaveNumber(repoRoot, sessionId) {
  try {
    const p = join(repoRoot, WAVE_SCOPE_REL);
    if (!existsSync(p)) return null;
    const scope = JSON.parse(readFileSync(p, 'utf8'));
    const bound = scope?.session_id ?? scope?.session ?? scope?.sessionId;
    if (typeof bound !== 'string' || bound !== sessionId) return null;
    const wave = scope?.wave ?? scope?.wave_number;
    return typeof wave === 'number' && Number.isFinite(wave) ? Math.trunc(wave) : null;
  } catch {
    return null;
  }
}

/**
 * Map an error message onto the taxonomy in `circuit-breaker.md`
 * § Error-Class Taxonomy.
 *
 * @param {string} text
 * @returns {'edit-format-friction'|'scope-denied'|'command-blocked'|'other'}
 */
export function classifyErrorClass(text) {
  const t = String(text || '');
  if (/String to replace not found|old_string|not unique|whitespace/i.test(t)) {
    return 'edit-format-friction';
  }
  if (/scope[- ]violation|outside .{0,20}file scope|not in .{0,20}allowedPaths|allowedPaths/i.test(t)) {
    return 'scope-denied';
  }
  if (/blocked[- ]command|destructive[- ]command|permissionDecision|command is blocked/i.test(t)) {
    return 'command-blocked';
  }
  return 'other';
}

/**
 * A git write inside a THROWAWAY fixture repo is not a PSA-007 breach — the
 * shared index PSA-007 protects is this working copy's, and a `mktemp -d`
 * scratch repo has its own. Measured 2026-08-25: the first live hit of this
 * detector was a sibling agent running `cd "$(mktemp -d)" … git add seed.txt`
 * to build a test fixture. Fixture seeding is routine in a test wave, so
 * without this the signal would fire constantly and be learned as noise
 * (host-resources.md HR-101: a signal may only warn if it is rare).
 *
 * Ceiling: recognises the temp-dir idioms actually in use (`mktemp`, `/tmp`,
 * `/private/tmp`, `/var/folders`, `$TMPDIR`). A fixture repo created somewhere
 * else is still reported — a false alarm, never a missed breach. Revisit if
 * agents start seeding fixtures outside these paths.
 */
const FIXTURE_CONTEXT_RE =
  /\bmktemp\b|\bcd\s+["']?(?:\/private)?\/(?:tmp|var\/folders)\/|\bcd\s+["']?\$\{?(?:TMPDIR|TMP|SCRATCH)/;

/**
 * True when the Bash command contains a git INDEX/HISTORY write in ANY
 * segment — a `git commit` after `&&` is still a `git commit`.
 *
 * Ceiling: segment splitting is literal on `&&`, `||`, `;`, `|` and newline. A
 * git write hidden inside a quoted string or a `$(…)` substitution is not
 * detected. Revisit if a real PSA-007 violation is ever missed that way.
 *
 * @param {string} command
 * @returns {boolean}
 */
export function isGitWrite(command) {
  const text = String(command || '');
  if (FIXTURE_CONTEXT_RE.test(text)) return false;
  return text.split(/&&|\|\||;|\||\n/).some((seg) => GIT_WRITE_RE.test(seg));
}

/**
 * Fresh detector state. Held in memory only — a restart re-scans from byte 0
 * and de-duplicates against events already in events.jsonl (see `seedFromEvents`).
 *
 * @returns {{toolUses: Map<string, {file: string|null}>, counts: Map<string, number>, wildcards: Map<string, number>}}
 */
export function createState() {
  return { toolUses: new Map(), counts: new Map(), wildcards: new Map() };
}

/**
 * Dedup key: one counter per (agent, pattern, file, error_class).
 * @param {{agent_id: string, pattern: string, file: string|null, error_class?: string}} hit
 */
function dedupKey(hit) {
  return [hit.agent_id, hit.pattern, hit.file ?? '-', hit.error_class ?? '-'].join('|');
}

/**
 * Agent-agnostic key — the seed key for a record written before `agent_id`
 * existed (see `seedFromEvents`).
 * @param {{pattern: string, file: string|null, error_class?: string}} hit
 */
function wildcardKey(hit) {
  return [hit.pattern, hit.file ?? '-', hit.error_class ?? '-'].join('|');
}

/**
 * Apply the threshold + aggregation-window rule to one raw hit.
 * Returns the finding to emit, or null when it is swallowed by the window.
 *
 * The prior count is the MAX of the exact per-agent counter and the
 * agent-agnostic wildcard counter, so a seed record that predates the
 * `agent_id` field still suppresses the re-emit it was seeded for.
 *
 * @param {ReturnType<typeof createState>} state
 * @param {{agent_id: string, pattern: string, file: string|null, error_class?: string}} hit
 * @returns {object|null}
 */
function recordHit(state, hit) {
  const key = dedupKey(hit);
  const prior = Math.max(
    state.counts.get(key) ?? 0,
    state.wildcards?.get(wildcardKey(hit)) ?? 0,
  );
  const count = prior + 1;
  state.counts.set(key, count);
  const threshold = EMIT_THRESHOLD[hit.pattern] ?? 1;
  if (count < threshold) return null;
  if (count > threshold && (count - threshold) % RE_EMIT_EVERY !== 0) return null;
  return { ...hit, occurrences: count };
}

/**
 * Detect stagnation patterns in ONE parsed transcript record.
 *
 * Mutates `state` (tool-use ledger + occurrence counters) and returns the
 * findings that pass the threshold/aggregation window — i.e. exactly the
 * records that should reach events.jsonl.
 *
 * @param {Record<string, any>} rec — a parsed `agent-<id>.jsonl` line.
 * @param {ReturnType<typeof createState>} state
 * @param {object} [opts]
 * @param {string} [opts.repoRoot] — used to relativize absolute file paths.
 * @returns {Array<{pattern: string, agent_id: string, file: string|null, error_class?: string, occurrences: number}>}
 */
export function detectLine(rec, state, opts = {}) {
  const findings = [];
  if (!rec || typeof rec !== 'object') return findings;
  const agentId = typeof rec.agentId === 'string' ? rec.agentId : 'unknown';
  const content = Array.isArray(rec?.message?.content) ? rec.message.content : [];

  if (rec.type === 'assistant') {
    for (const block of content) {
      if (block?.type === 'tool_use') {
        // Ledger: a failed tool_result names only its tool_use_id, so the file
        // path has to be remembered from the CALL that produced it.
        if (typeof block.id === 'string') {
          state.toolUses.set(block.id, {
            file: relativizeFile(block?.input?.file_path ?? block?.input?.path, opts.repoRoot),
          });
        }
        if (block.name === 'Bash' && isGitWrite(block?.input?.command)) {
          const hit = recordHit(state, {
            pattern: 'psa007-git-write',
            agent_id: agentId,
            file: null,
          });
          if (hit) findings.push(hit);
        }
      } else if (block?.type === 'text' && STATUS_RE.test(String(block.text ?? ''))) {
        const hit = recordHit(state, {
          pattern: 'status-partial',
          agent_id: agentId,
          file: null,
        });
        if (hit) findings.push(hit);
      }
    }
    return findings;
  }

  if (rec.type === 'user') {
    for (const block of content) {
      if (block?.type !== 'tool_result') continue;
      // Two independent failure markers: the block's own `is_error`, and the
      // record-level `toolUseResult` degrading from object to STRING.
      const isError = block.is_error === true || typeof rec.toolUseResult === 'string';
      if (!isError) continue;
      const call = typeof block.tool_use_id === 'string' ? state.toolUses.get(block.tool_use_id) : null;
      const hit = recordHit(state, {
        pattern: 'error-echo',
        agent_id: agentId,
        file: call?.file ?? null,
        error_class: classifyErrorClass(blockText(block)),
      });
      if (hit) findings.push(hit);
    }
  }
  return findings;
}

/**
 * @param {any} block
 * @returns {string}
 */
function blockText(block) {
  const c = block?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x?.text === 'string' ? x.text : '')).join('\n');
  return '';
}

/**
 * @param {unknown} p
 * @param {string} [repoRoot]
 * @returns {string|null}
 */
function relativizeFile(p, repoRoot) {
  if (typeof p !== 'string' || p.length === 0) return null;
  if (repoRoot && isAbsolute(p)) {
    const rel = relative(repoRoot, p);
    return rel.startsWith('..') ? p : rel;
  }
  return p;
}

/**
 * Restart-safety: seed the occurrence counters from `stagnation_detected`
 * records already written for THIS session, so a re-scan from byte 0 does not
 * re-emit findings that are already in events.jsonl.
 *
 * `sessionId` here is the SEMANTIC id — the same value `report()` writes into
 * the record's `session` field, and the key both downstream consumers join on.
 * Producer and reader must use ONE key; the round-trip test in
 * `tests/lib/wave-transcript-tail.test.mjs` pins them together.
 *
 * VERSION BOUNDARY (`agent_id`, added #1114): records written before that field
 * existed carry no agent. Keying them on the literal `'unknown'` would seed a
 * counter no live hit can ever match, so a restart re-emits every one of them
 * as new — measured 2026-08-25: 4 of the 5 records in this repo's ledger predate
 * the field. Such a record therefore seeds the AGENT-AGNOSTIC wildcard counter
 * on (pattern, file, error_class), which `recordHit` reads alongside the exact
 * key. Records that DO carry `agent_id` keep the precise per-agent keying, so a
 * sibling agent's genuine first finding is never suppressed. The wildcard tier
 * shrinks to nothing on its own as pre-#1114 records age out of the ledger.
 *
 * @param {string[]} lines — raw events.jsonl lines.
 * @param {string} sessionId — the SEMANTIC session id.
 * @param {ReturnType<typeof createState>} state
 * @returns {number} how many counters were seeded
 */
export function seedFromEvents(lines, sessionId, state) {
  let seeded = 0;
  for (const line of lines) {
    if (!line.includes('stagnation_detected')) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec?.event !== 'stagnation_detected') continue;
    if (rec.source !== 'tail') continue;
    if (rec.session !== sessionId) continue;
    const shape = {
      pattern: String(rec.pattern ?? ''),
      file: rec.file ?? null,
      error_class: rec.error_class,
    };
    const occ = Number(rec.occurrences);
    if (!Number.isFinite(occ)) continue;

    const agentId = trimmedString(rec.agent_id);
    const bucket = agentId ? state.counts : state.wildcards;
    const key = agentId ? dedupKey({ ...shape, agent_id: agentId }) : wildcardKey(shape);
    if (!bucket) continue; // a hand-built state without the wildcard map
    if (occ > (bucket.get(key) ?? 0)) {
      bucket.set(key, Math.trunc(occ));
      seeded += 1;
    }
  }
  return seeded;
}

// ---------------------------------------------------------------------------
// I/O layer — thin shell around the pure detectors above
// ---------------------------------------------------------------------------

/** @param {string} msg */
function note(msg) {
  process.stderr.write(`wave-transcript-tail: ${msg}\n`);
}

/**
 * Single-instance guard: claim `<repoRoot>/.orchestrator/wave-transcript-tail.lock`.
 *
 * Reuses the repo's own POSIX lock primitive (`tryAcquireFileLock`) rather than
 * hand-rolling one — the same `linkSync` create-or-fail skeleton the state-lock
 * and staging-fence locks use. `staleCheck: 'pid'` is the correct policy HERE
 * (unlike on `session.lock`, where the recorded pid is the ephemeral hook's):
 * the tailer records its OWN long-lived pid, so a dead pid means a crashed
 * tailer whose lock must be reclaimed.
 *
 * A losing instance exits 0 with one stderr line — NOT a rate limit. Rate
 * limiting would still let two independently-seeded counters interleave; only
 * refusing the second process makes the ledger's occurrence counts mean
 * anything.
 *
 * @param {string} repoRoot
 * @returns {{ ok: true, lockPath: string } | { ok: false, reason: string, lockPath: string }}
 */
export function acquireSingleton(repoRoot) {
  const lockPath = join(repoRoot, SINGLETON_LOCK_REL);
  const res = tryAcquireFileLock(lockPath, {
    staleCheck: 'pid',
    holder: 'wave-transcript-tail',
    tmpPrefix: '.wave-transcript-tail.lock',
    warn: (msg) => note(msg),
    warnMessage: (reason, lp) => `reclaiming stale tailer lock (${reason}) at ${lp}`,
  });
  if (res.acquired) return { ok: true, lockPath };
  return { ok: false, reason: res.reason, lockPath };
}

/**
 * Release the single-instance lock. Owner-guarded, so a tailer can never unlink
 * a lock another live tailer holds (PSA-003).
 * @param {string} repoRoot
 */
export function releaseSingleton(repoRoot) {
  releaseFileLock(join(repoRoot, SINGLETON_LOCK_REL), { holder: 'wave-transcript-tail' });
}

/**
 * Read newly-appended bytes of an append-only file. Mirrors the offset
 * discipline of `convergence-monitor.mjs` — fs.watch is unreliable for appends
 * on macOS, so size polling is the robust pattern.
 *
 * @param {string} absPath
 * @param {number} prevOffset
 * @returns {{offset: number, lines: string[]}}
 */
function tailRead(absPath, prevOffset) {
  let fd = -1;
  try {
    const st = statSync(absPath);
    const start = st.size < prevOffset ? 0 : prevOffset;
    const toRead = st.size - start;
    if (toRead <= 0) return { offset: st.size, lines: [] };
    fd = openSync(absPath, 'r');
    const buf = Buffer.alloc(toRead);
    readSync(fd, buf, 0, toRead, start);
    const text = buf.toString('utf8');
    let workingText = text;
    let newOffset = st.size;
    if (!text.endsWith('\n')) {
      const lastNl = text.lastIndexOf('\n');
      if (lastNl === -1) return { offset: start, lines: [] };
      workingText = text.slice(0, lastNl + 1);
      newOffset = start + Buffer.byteLength(workingText, 'utf8');
    }
    return { offset: newOffset, lines: workingText.split('\n').filter((l) => l.length > 0) };
  } catch (err) {
    note(`read failed for ${absPath}: ${String(err?.message ?? err)}`);
    return { offset: prevOffset, lines: [] };
  } finally {
    if (fd !== -1) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * Cheap pre-filter before JSON.parse — most transcript lines carry neither a
 * tool call nor a status marker.
 * @param {string} line
 */
function mayCarrySignal(line) {
  return line.includes('"tool_use"') || line.includes('"tool_result"') || line.includes('STATUS:');
}

/**
 * Read the agent TYPE from the sidecar `agent-<id>.meta.json` the harness
 * writes next to the subagent transcript. `agentId` here comes from a
 * `readdirSync()` filename match (tailLoop below), not from untrusted stdin —
 * but it is validated through the SAME consolidated derivation (#1196) as the
 * hook-side copies for consistency: an id readdirSync happened to list that
 * fails `{1,64}`/charset/`'unknown'` short-circuits to the honest `'unknown'`
 * return, same as any other lookup failure.
 *
 * `projectsDir`/`sessionId` reconstruct the PARENT transcript path
 * (`<projectsDir>/<sessionId>.jsonl`) that `resolveSubagentSidecar()` expects —
 * the real on-disk location of the coordinator's own transcript, sibling of
 * the `subagents/` directory this function reads from.
 *
 * @param {string} projectsDir
 * @param {string} sessionId
 * @param {string} agentId
 * @returns {string}
 */
function readAgentType(projectsDir, sessionId, agentId) {
  const sidecar = resolveSubagentSidecar({
    transcriptPath: join(projectsDir, `${sessionId}.jsonl`),
    agentId,
  });
  if (sidecar === null) return 'unknown';
  try {
    const meta = JSON.parse(readFileSync(sidecar.meta, 'utf8'));
    const t = meta?.agentType;
    return typeof t === 'string' && t ? t : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Poll delay.
 *
 * The timer is deliberately NOT `unref()`d: an unref'd timer is the only handle
 * this process holds, so the event loop would drain and node would exit 0 the
 * instant the first tick was scheduled — a monitor that supervises nothing while
 * looking like a clean shutdown. Measured 2026-08-25: the unref'd variant
 * returned after ~0s instead of running until SIGTERM.
 *
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * @param {object} args
 * @param {number} args.intervalS
 */
async function tailLoop({ intervalS }) {
  const repoRoot = process.env.CLAUDE_PLUGIN_ROOT || process.cwd();

  // The monitor fires once per wave-executor INVOCATION, and a deep session
  // invokes it repeatedly — so refuse to be the second tailer.
  const singleton = acquireSingleton(repoRoot);
  if (!singleton.ok) {
    note(`another tailer already holds ${singleton.lockPath} (${singleton.reason}) — exiting`);
    process.exit(0);
  }
  process.on('exit', () => releaseSingleton(repoRoot));

  const projectsDir = join(homedir(), '.claude', 'projects', encodeProjectDir(repoRoot));
  const resolved = resolveSessionId({ repoRoot, projectsDir });
  if (!resolved) {
    note('cannot resolve session UUID (env, session.lock, mtime probe all empty) — exiting fail-open');
    process.exit(0);
  }
  const { sessionId, source, semanticSessionId, semanticSource } = resolved;
  const subagentsDir = join(projectsDir, sessionId, 'subagents');
  note(
    `tailing ${subagentsDir} (session via ${source}), ` +
      `joining as ${semanticSessionId} (via ${semanticSource}), interval ${intervalS}s`,
  );

  const state = createState();
  // Restart-safety: do not re-announce findings already recorded for this
  // session. Seeded on the SEMANTIC id — the same key `report()` writes.
  try {
    const evPath = join(repoRoot, EVENTS_FILE_REL);
    if (existsSync(evPath)) {
      const seeded = seedFromEvents(readFileSync(evPath, 'utf8').split('\n'), semanticSessionId, state);
      if (seeded > 0) note(`seeded ${seeded} prior finding counters from events.jsonl`);
    }
  } catch (err) {
    note(`could not seed from events.jsonl: ${String(err?.message ?? err)}`);
  }

  /** @type {Map<string, number>} */
  const offsets = new Map();
  /** @type {Map<string, string>} */
  const agentTypes = new Map();
  let sawDir = false;

  for (;;) {
    await sleep(intervalS * 1000);
    if (!existsSync(subagentsDir)) continue; // dir appears only at the first spawn
    if (!sawDir) {
      sawDir = true;
      note('subagents directory appeared — supervision live');
    }
    let files;
    try {
      files = readdirSync(subagentsDir).filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl'));
    } catch (err) {
      note(`readdir failed: ${String(err?.message ?? err)}`);
      continue;
    }
    for (const file of files) {
      const abs = join(subagentsDir, file);
      const tick = tailRead(abs, offsets.get(file) ?? 0);
      offsets.set(file, tick.offset);
      if (tick.lines.length === 0) continue;
      const agentId = file.slice('agent-'.length, -'.jsonl'.length);
      if (!agentTypes.has(agentId)) agentTypes.set(agentId, readAgentType(projectsDir, sessionId, agentId));
      for (const line of tick.lines) {
        if (!mayCarrySignal(line)) continue;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        for (const finding of detectLine(rec, state, { repoRoot })) {
          await report(finding, {
            repoRoot,
            sessionId,
            semanticSessionId,
            agentType: agentTypes.get(agentId) ?? 'unknown',
          });
        }
      }
    }
  }
}

/**
 * Build the `stagnation_detected` record for one finding.
 *
 * Field set = the `wave-loop.md:578` coordinator record (session, wave, agent,
 * pattern, error_class, file, occurrences) plus three additive identity fields:
 * `session_id`/`semantic_session_id` from `sessionAttribution`, and `agent_id`.
 *
 * `session` carries the SEMANTIC id, NOT the UUID — it is the join key of both
 * consumers (see `resolveSessionId`), and `seedFromEvents` reads it back on the
 * next restart. The UUID still travels, as the additive `session_id` field.
 *
 * `agent_id` is load-bearing, not decoration: `agent` carries the agent TYPE,
 * and a wave routinely runs several agents of the SAME type (measured: two
 * `Explore` agents in this session). Without the per-agent id the restart-safety
 * seed in `seedFromEvents` can only match by type, which would suppress a
 * sibling agent's genuine first finding — a false NEGATIVE in a supervision
 * tool. Keying on the id instead costs one additive field.
 *
 * @param {{pattern: string, agent_id: string, file: string|null, error_class?: string, occurrences: number}} finding
 * @param {{repoRoot: string, sessionId: string, semanticSessionId: string, agentType: string}} ctx
 * @returns {Record<string, any>}
 */
export function buildStagnationPayload(finding, ctx) {
  // The wave number is bound to the working copy by the RAW uuid (#1082), so
  // this one lookup keeps the uuid while `session` below carries the semantic id.
  const wave = readWaveNumber(ctx.repoRoot, ctx.sessionId);
  const payload = {
    ...sessionAttribution(ctx.repoRoot),
    session: ctx.semanticSessionId,
    wave,
    agent: ctx.agentType,
    agent_id: finding.agent_id,
    pattern: finding.pattern,
    source: 'tail',
    file: finding.file,
    occurrences: finding.occurrences,
  };
  if (finding.error_class) payload.error_class = finding.error_class;
  return payload;
}

/**
 * Write one finding: a short stdout line (the Monitor notification) plus the
 * `stagnation_detected` record in events.jsonl.
 *
 * @param {{pattern: string, agent_id: string, file: string|null, error_class?: string, occurrences: number}} finding
 * @param {{repoRoot: string, sessionId: string, semanticSessionId: string, agentType: string}} ctx
 */
async function report(finding, ctx) {
  const payload = buildStagnationPayload(finding, ctx);

  process.stdout.write(
    `stagnation_detected pattern=${finding.pattern} agent=${ctx.agentType} wave=${payload.wave ?? 'null'} ` +
      `file=${finding.file ?? 'null'} occurrences=${finding.occurrences}` +
      `${finding.error_class ? ` error_class=${finding.error_class}` : ''}\n`,
  );
  try {
    await emitEvent('stagnation_detected', payload, { repoRoot: ctx.repoRoot });
  } catch (err) {
    note(`event write failed: ${String(err?.message ?? err)}`);
  }
}

/**
 * @param {string[]} argv
 * @returns {{tail: boolean, intervalS: number, help: boolean}}
 */
export function parseArgs(argv) {
  let tail = false;
  let intervalS = DEFAULT_INTERVAL_S;
  let help = false;
  for (const arg of argv) {
    if (arg === '--tail') {
      tail = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg.startsWith('--interval=')) {
      const v = Number(arg.slice('--interval='.length));
      if (!Number.isFinite(v) || v <= 0) {
        note(`invalid --interval value: ${arg}`);
        process.exit(1);
      }
      intervalS = v;
    } else {
      note(`unknown flag: ${arg}`);
      process.exit(1);
    }
  }
  return { tail, intervalS, help };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stderr.write(
      [
        'Usage: wave-transcript-tail.mjs --tail [--interval=<seconds>]',
        '',
        'FA-1 wave supervision (#1114). Tails the live subagent transcripts of',
        'the OWN session and emits stagnation_detected(source:tail) records to',
        '.orchestrator/metrics/events.jsonl.',
        '',
        'Patterns: psa007-git-write, error-echo, status-partial.',
        '',
        'Flags:',
        '  --tail               Required. Run the tail loop.',
        '  --interval=<s>       Poll cadence in seconds (default 2).',
        '  --help, -h           Print this message.',
        '',
        'Single instance per working copy (.orchestrator/wave-transcript-tail.lock):',
        'a second tailer exits 0 rather than double-emitting every record.',
        '',
        'Exit codes: 0 clean/fail-open/already-running / 1 user-error / 2 system-error.',
      ].join('\n') + '\n',
    );
    process.exit(0);
  }
  if (!args.tail) {
    note('--tail is required');
    process.exit(1);
  }

  const shutdown = (sig) => {
    note(`shutdown on ${sig}`);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  tailLoop({ intervalS: args.intervalS }).catch((err) => {
    note(`tail loop failed: ${String(err?.message ?? err)}`);
    process.exit(2);
  });
}

// Run only when executed as a script — importing for unit tests must not parse
// vitest's argv and exit 1.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
