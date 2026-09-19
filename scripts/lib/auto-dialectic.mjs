/**
 * auto-dialectic.mjs — Cadence helper for the dialectic derivation (#506, F2.5).
 *
 * Mirrors the auto-dream.mjs API shape exactly. Decides whether a dialectic
 * derivation is DUE, writes the proposed peer-card diff to
 * `.orchestrator/dialectic-pending.md` atomically, and tracks the last-run
 * timestamp at `.orchestrator/dialectic-last-run`.
 *
 * Who calls what (the session-end Phase 3.6.7 auto-trigger is GONE — #1288):
 *   - `shouldDispatchAutoDialectic` — read by the session-start `maintenance-due`
 *     probe (`scripts/lib/maintenance-due-banner.mjs`) to report the `dialectic`
 *     signal. Side-effect-free by contract: a variant advancing the last-run stamp
 *     would consume the signal it reports.
 *   - `writeDialecticPending` / `consumeDialecticPending` / `writeDialecticLastRun` —
 *     called by `/evolve dialectic` (Step 6.4 in
 *     `skills/evolve/references/evolve-dialectic-mode.md`), the only trigger today.
 *   - `renderPendingBody` / `comparePendingBody` (#1386) — the same Step 6.4 builds
 *     the sidecar body with the former on the dry-run path and, on `--apply`,
 *     compares the freshly derived body against the reviewed sidecar with the
 *     latter before writing any peer card.
 *   - Both sidecars are READ by the same `maintenance-due` probe.
 *
 * Decision inputs (PRD F2.5 acceptance criteria):
 *   - dialectic.cadence (default 5) — sessions since last dialectic run
 *   - kill-switch: cadence === 0 → never trigger
 *   - AC4 precondition: skip when no new sessions AND no new learnings since
 *     last run (no-op input → no-op output)
 *
 * Pure-function decision; side effects (sidecar write, timestamp update) are
 * separate helpers. No external deps — Node 20+ stdlib only.
 */

import { readFile, writeFile, rename, unlink, mkdir, readdir, stat, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { filterRealSessions } from './session-schema.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default cadence: dispatch every N sessions when nothing else interferes. */
export const DEFAULT_CADENCE = 5;

/** Repo-relative path to the last-run timestamp file. */
export const DIALECTIC_LAST_RUN_PATH = '.orchestrator/dialectic-last-run';

/** Repo-relative path to the pending dialectic proposal sidecar. */
export const DIALECTIC_PENDING_PATH = '.orchestrator/dialectic-pending.md';

/** Repo-relative directory the consumed sidecars are archived into (#1388 P9). */
export const DIALECTIC_CONSUMED_DIR = '.orchestrator/consumed';

/**
 * Retention ceiling for `.orchestrator/consumed/` — newest N archived sidecars
 * survive a consume, older ones are pruned.
 *
 * Ceiling + revisit trigger (BV-004): newest 10; revisit if `checkStaleArtifacts`
 * (`scripts/lib/project-hygiene.mjs`) ever reports a `consumed/` file. That probe
 * counts every untracked `.orchestrator/**` file older than 30 days, so an
 * unbounded archive would become a standing hygiene finding.
 */
export const DIALECTIC_CONSUMED_RETENTION = 10;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function lastRunPath(repoRoot) {
  return path.join(repoRoot, DIALECTIC_LAST_RUN_PATH);
}

function pendingPath(repoRoot) {
  return path.join(repoRoot, DIALECTIC_PENDING_PATH);
}

function consumedDirPath(repoRoot) {
  return path.join(repoRoot, DIALECTIC_CONSUMED_DIR);
}

function sessionsJsonlPath(repoRoot) {
  return path.join(repoRoot, '.orchestrator', 'metrics', 'sessions.jsonl');
}

function learningsJsonlPath(repoRoot) {
  return path.join(repoRoot, '.orchestrator', 'metrics', 'learnings.jsonl');
}

// ---------------------------------------------------------------------------
// Last-run timestamp reader (defensive — never throws)
// ---------------------------------------------------------------------------

/**
 * Read `.orchestrator/dialectic-last-run`. Returns the trimmed ISO timestamp
 * string, or `null` when the file is absent / unreadable / empty / malformed.
 *
 * Defensive: any filesystem or parse error degrades to `null` (signal-reader
 * convention — same as auto-dream.mjs which never throws on missing inputs).
 *
 * @param {object} args
 * @param {string} args.repoRoot Absolute path to the repo root.
 * @returns {Promise<string|null>}
 */
export async function readDialecticLastRun({ repoRoot } = {}) {
  if (!repoRoot) return null;
  const target = lastRunPath(repoRoot);
  if (!existsSync(target)) return null;
  try {
    const raw = await readFile(target, 'utf8');
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    // Validate as a parseable ISO timestamp (best-effort).
    const ms = Date.parse(trimmed);
    if (Number.isNaN(ms)) return null;
    return trimmed;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Signal reader — sessions + learnings since lastRun
// ---------------------------------------------------------------------------

/**
 * Count sessions.jsonl + learnings.jsonl entries newer than the last-run
 * timestamp. When no last-run timestamp exists, returns the total entry count
 * for each stream (mirrors auto-dream's "no prior cleanup" branch).
 *
 * Schema-defensive: malformed JSONL lines are silently skipped (best-effort
 * signal reader). Entries lacking the relevant timestamp field are not counted
 * against the cadence — only entries we can date inclusively.
 *
 * Timestamp fields used:
 *   - sessions.jsonl: `started_at` (string ISO)
 *   - learnings.jsonl: `created_at` (string ISO) — falls back to `updated_at`
 *     when `created_at` is absent.
 *
 * @param {object} args
 * @param {string} args.repoRoot Absolute path to the repo root.
 * @returns {Promise<{lastRunAt:string|null, sessionsSinceLast:number, learningsSinceLast:number}>}
 */
export async function readDialecticSignals({ repoRoot } = {}) {
  const lastRunAt = await readDialecticLastRun({ repoRoot });

  let sessionsSinceLast = 0;
  let learningsSinceLast = 0;

  // Sessions
  const sessionsPath = sessionsJsonlPath(repoRoot);
  if (existsSync(sessionsPath)) {
    try {
      const raw = await readFile(sessionsPath, 'utf8');
      const lines = raw.split('\n').filter((l) => l.length > 0);
      const entries = [];
      for (const line of lines) {
        try {
          entries.push(JSON.parse(line));
        } catch {
          continue; // malformed line — skip silently
        }
      }
      // Abandoned-session filter (#834): mirrors auto-dream.mjs
      // readDreamSignals() — phantom `status: 'abandoned'` stubs are
      // legitimate DATA but not legitimate SIGNAL, and must not fire the
      // /evolve --dialectic cadence off zero real work.
      const realEntries = filterRealSessions(entries);
      for (const entry of realEntries) {
        const startedAt = entry.started_at;
        if (typeof startedAt !== 'string' || startedAt.length === 0) continue;
        if (lastRunAt === null || startedAt > lastRunAt) {
          sessionsSinceLast += 1;
        }
      }
    } catch {
      // Filesystem error reading sessions.jsonl — leave count at 0
    }
  }

  // Learnings
  const learningsPath = learningsJsonlPath(repoRoot);
  if (existsSync(learningsPath)) {
    try {
      const raw = await readFile(learningsPath, 'utf8');
      const lines = raw.split('\n').filter((l) => l.length > 0);
      for (const line of lines) {
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        const ts = entry.created_at ?? entry.updated_at;
        if (typeof ts !== 'string' || ts.length === 0) continue;
        if (lastRunAt === null || ts > lastRunAt) {
          learningsSinceLast += 1;
        }
      }
    } catch {
      // Filesystem error reading learnings.jsonl — leave count at 0
    }
  }

  return { lastRunAt, sessionsSinceLast, learningsSinceLast };
}

// ---------------------------------------------------------------------------
// Decision function
// ---------------------------------------------------------------------------

/**
 * Decide whether a dialectic derivation is DUE — i.e. whether the operator should
 * run `/evolve dialectic` (dry-run first). Read by the session-start
 * `maintenance-due` probe; no auto-trigger consumes this any more (#1288).
 *
 * Rules (PRD F2.5):
 *   - cadence === 0 → never trigger (kill-switch).
 *   - AC4 precondition: sessionsSinceLast === 0 AND learningsSinceLast === 0 →
 *     no new input since last run → skip with reason
 *     `no-new-input-since-last-run` (the reason string is part of the contract —
 *     the `maintenance-due` probe reports it verbatim).
 *   - sessionsSinceLast >= cadence → trigger (cadence threshold met).
 *   - Otherwise → skip with reason `under-threshold (sessions=N/M)`.
 *
 * Read-only: never writes any file. Callers may pass an explicit `signals`
 * object for testing; when omitted, `readDialecticSignals()` is invoked.
 *
 * @param {object} args
 * @param {string} args.repoRoot
 * @param {number} [args.cadence=5]    `dialectic.cadence` from config.
 * @param {object} [args.signals]      Pre-computed signals (skips disk reads).
 * @returns {Promise<{trigger:boolean, reason:string, signals:object}>}
 */
export async function shouldDispatchAutoDialectic({
  repoRoot,
  cadence = DEFAULT_CADENCE,
  signals,
} = {}) {
  // Kill-switch first — bail before any I/O.
  if (cadence === 0) {
    return {
      trigger: false,
      reason: 'kill-switch (dialectic.cadence=0)',
      signals: signals ?? { lastRunAt: null, sessionsSinceLast: 0, learningsSinceLast: 0 },
    };
  }

  const resolved = signals ?? (await readDialecticSignals({ repoRoot }));

  // AC4 precondition: no new input since the last run → no-op output.
  // This guard runs BEFORE the cadence check so a never-decremented
  // sessionsSinceLast (e.g. stuck above cadence due to a missed write) does
  // not re-dispatch on empty inputs.
  if (resolved.sessionsSinceLast === 0 && resolved.learningsSinceLast === 0) {
    return {
      trigger: false,
      reason: 'no-new-input-since-last-run',
      signals: resolved,
    };
  }

  // Cadence-based trigger.
  if (resolved.sessionsSinceLast >= cadence) {
    return {
      trigger: true,
      reason: `cadence-threshold-met (sessions=${resolved.sessionsSinceLast} >= cadence=${cadence})`,
      signals: resolved,
    };
  }

  return {
    trigger: false,
    reason: `under-threshold (sessions=${resolved.sessionsSinceLast}/${cadence})`,
    signals: resolved,
  };
}

// ---------------------------------------------------------------------------
// last-run — atomic write
// ---------------------------------------------------------------------------

/**
 * Write `.orchestrator/dialectic-last-run` with the given ISO timestamp.
 *
 * Atomicity: write to `<path>.<rand>.tmp`, then rename(). Same-fs rename is
 * atomic on POSIX — observers see either the previous file or the new one,
 * never a half-written intermediate (mirrors auto-dream.mjs:248-251).
 *
 * Defensive: returns `{ok: false, error}` on filesystem failure rather than
 * throwing — the caller logs the error and continues.
 *
 * Caller: `/evolve dialectic` Step 6.4 (`skills/evolve/references/evolve-dialectic-mode.md`),
 * after a successful `--apply` AND after the operator explicitly discards a
 * proposal. Without this write the maintenance-due `dialectic` signal never
 * resets (#1380). The session-end auto-trigger that used to call it is gone.
 *
 * @param {object} args
 * @param {string} args.repoRoot
 * @param {string} args.isoTimestamp ISO 8601 timestamp string.
 * @returns {Promise<{ok:boolean, error?:string, path?:string}>}
 */
export async function writeDialecticLastRun({ repoRoot, isoTimestamp } = {}) {
  if (!repoRoot) {
    return { ok: false, error: 'writeDialecticLastRun: repoRoot is required' };
  }
  if (typeof isoTimestamp !== 'string' || isoTimestamp.length === 0) {
    return { ok: false, error: 'writeDialecticLastRun: isoTimestamp must be a non-empty string' };
  }

  const target = lastRunPath(repoRoot);
  try {
    await mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(tmp, `${isoTimestamp}\n`, 'utf8');
    await rename(tmp, target);
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// pending dialectic sidecar — atomic write / read
// ---------------------------------------------------------------------------

/**
 * Write the proposed dialectic diff to `.orchestrator/dialectic-pending.md`
 * atomically.
 *
 * Caller: `/evolve dialectic` Step 6.4's dry-run branch
 * (`skills/evolve/references/evolve-dialectic-mode.md`) — `runDialecticDeriver()`
 * returns the diff and the caller persists it here. There is no session-end
 * auto-trigger any more (#1288).
 *
 * Caller supplies the body (a Markdown document containing the peer-card
 * diff and any narrative). This helper prepends a minimal hand-rolled YAML
 * frontmatter block carrying the metadata the operator's review and the later
 * `--apply` step rely on; the session-start `maintenance-due` probe reads the
 * resulting file's presence + age for its `pending-sidecar` signal. The
 * frontmatter is hand rolled (no js-yaml dep) — auto-dream pattern.
 *
 * Atomicity: tmp+rename (mirrors auto-dream.mjs:248-251).
 *
 * @param {object} args
 * @param {string}   args.repoRoot
 * @param {string}   args.diff             Markdown body (typically a unified-diff block).
 * @param {object}   [args.usage]          {input_tokens, output_tokens} from the subagent.
 * @param {string}   [args.sourceSession]  Session id that produced the proposal.
 * @param {string}   [args.model]          Model identifier (e.g., `claude-haiku-4-5`).
 * @param {number}   [args.learningsIn]    Count of learnings consumed.
 * @param {number}   [args.sessionsIn]     Count of sessions consumed.
 * @param {string[]} [args.cardsTargeted]  Peer-card slugs the diff would touch.
 * @returns {Promise<{path:string, bytes:number}>}
 */
export async function writeDialecticPending({
  repoRoot,
  diff,
  usage = null,
  sourceSession = null,
  model = null,
  learningsIn = null,
  sessionsIn = null,
  cardsTargeted = null,
} = {}) {
  if (typeof diff !== 'string' || diff.trim().length === 0) {
    throw new TypeError('writeDialecticPending: diff must be a non-empty string');
  }
  if (!repoRoot) {
    throw new TypeError('writeDialecticPending: repoRoot is required');
  }

  const target = pendingPath(repoRoot);
  await mkdir(path.dirname(target), { recursive: true });

  const generatedAt = new Date().toISOString();
  const inputTokens = usage && typeof usage.input_tokens === 'number' ? usage.input_tokens : null;
  const outputTokens =
    usage && typeof usage.output_tokens === 'number' ? usage.output_tokens : null;

  // Render cards_targeted as a JSON-style inline list (no js-yaml dep). Empty
  // array `[]` when callers pass an empty list; `null` when omitted.
  let cardsRendered = 'null';
  if (Array.isArray(cardsTargeted)) {
    cardsRendered = `[${cardsTargeted.map((c) => JSON.stringify(c)).join(', ')}]`;
  }

  const frontmatter = [
    '---',
    `generated_at: ${generatedAt}`,
    `source_session: ${JSON.stringify(sourceSession ?? 'unknown')}`,
    `model: ${JSON.stringify(model ?? 'unknown')}`,
    `input_tokens: ${JSON.stringify(inputTokens)}`,
    `output_tokens: ${JSON.stringify(outputTokens)}`,
    `learnings_in: ${JSON.stringify(learningsIn ?? null)}`,
    `sessions_in: ${JSON.stringify(sessionsIn ?? null)}`,
    `cards_targeted: ${cardsRendered}`,
    '---',
    '',
  ].join('\n');

  const content = `${frontmatter}${diff}${diff.endsWith('\n') ? '' : '\n'}`;
  const tmp = `${target}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, target);

  return { path: target, bytes: Buffer.byteLength(content, 'utf8') };
}

/**
 * Archive file name for a consumed sidecar: `<ISO-stamp>-<8 hex>-dialectic-pending.md`.
 * The stamp is `toISOString()` with `:` and `.` replaced by `-` — both are
 * illegal or awkward on several filesystems, and the form still sorts
 * lexicographically. The random suffix separates two consumes landing in the
 * SAME millisecond — without it the second rename would overwrite the first
 * archive silently.
 *
 * @returns {string}
 */
function archiveFileName() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${stamp}-${randomUUID().slice(0, 8)}-dialectic-pending.md`;
}

/**
 * Exactly the names {@link archiveFileName} produces. The prune touches nothing
 * else in the directory (#1390 P6): a loose suffix match would still delete an
 * unrelated `operator-dialectic-pending.md`.
 */
const ARCHIVE_NAME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}-dialectic-pending\.md$/;

/**
 * Prune `.orchestrator/consumed/` to the newest `DIALECTIC_CONSUMED_RETENTION`
 * archives. Only regular files whose name matches {@link ARCHIVE_NAME_RE} are
 * counted or removed — anything else in the directory is not this module's to
 * delete. Best-effort: every failure degrades to "pruned nothing" — an archive
 * that grew one file too long is never worth failing a consume over.
 *
 * "Newest" is mtime DESC with the filename as tiebreaker: the archive names
 * carry an ISO timestamp, which sorts lexicographically, so the two orderings
 * agree except inside one millisecond.
 *
 * @param {string} dir Absolute path to the consumed archive directory.
 * @returns {Promise<number>} Number of files removed.
 */
async function pruneConsumedArchive(dir) {
  let removed = 0;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && ARCHIVE_NAME_RE.test(e.name))
      .map((e) => e.name);
    if (files.length <= DIALECTIC_CONSUMED_RETENTION) return 0;

    const dated = [];
    for (const name of files) {
      let mtimeMs = 0;
      try {
        mtimeMs = (await stat(path.join(dir, name))).mtimeMs;
      } catch {
        mtimeMs = 0; // unreadable → oldest, pruned first
      }
      dated.push({ name, mtimeMs });
    }
    dated.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : -1));

    for (const { name } of dated.slice(DIALECTIC_CONSUMED_RETENTION)) {
      try {
        await unlink(path.join(dir, name));
        removed += 1;
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* best-effort — a prune failure never fails the consume */
  }
  return removed;
}

/**
 * Consume `.orchestrator/dialectic-pending.md` once its proposal has been
 * applied or explicitly discarded: the file is MOVED into
 * `.orchestrator/consumed/<ISO-timestamp>-dialectic-pending.md` rather than
 * unlinked (#1388 P9 — the sidecar was the only copy of what the operator
 * reviewed, and an unlink destroyed it). The maintenance-due probe reads an
 * explicit two-path list (`PENDING_SIDECARS`,
 * `scripts/lib/maintenance-due-banner.mjs`), so an archived file does not
 * re-raise `pending-sidecar` (#1380 stays fixed).
 *
 * The archive is pruned to `DIALECTIC_CONSUMED_RETENTION` entries on every
 * consume — see that constant for the ceiling and its revisit trigger.
 *
 * ENOENT is tolerated (`consumed: false`) — "already gone" is the desired end
 * state. Any other filesystem error returns `{ok: false, error}` rather than
 * throwing, matching `writeDialecticLastRun`.
 *
 * Symlink (#1390 P6, measured 2026-09-19): a pre-existing `.orchestrator/consumed`
 * symlink used to be followed — `mkdir` was a no-op on it, `rename` moved the
 * sidecar into its target, and the retention prune unlinked that target's
 * regular files beyond the newest 10 (a tmp repro deleted 3 of 12). The consume
 * now `lstat`s the directory first and REFUSES a symlink: it returns
 * `{ok: false, error}`, moves nothing and prunes nothing, so the pending
 * sidecar stays where it is for the caller to report. The prune additionally
 * only ever removes names this module writes (see `ARCHIVE_NAME_RE`). Ceiling:
 * the `lstat` → `rename` window is not atomic — a process swapping in a symlink
 * inside it wins; revisit if the consumed directory ever becomes writable by a
 * less-trusted uid than the operator's.
 *
 * @param {object} args
 * @param {string} args.repoRoot
 * @returns {Promise<{ok:boolean, consumed?:boolean, error?:string, path?:string, archivedTo?:string, pruned?:number}>}
 */
export async function consumeDialecticPending({ repoRoot } = {}) {
  if (!repoRoot) {
    return { ok: false, error: 'consumeDialecticPending: repoRoot is required' };
  }
  const target = pendingPath(repoRoot);
  if (!existsSync(target)) return { ok: true, consumed: false, path: target };

  const dir = consumedDirPath(repoRoot);
  const archivedTo = path.join(dir, archiveFileName());

  try {
    let dirStat = null;
    try {
      dirStat = await lstat(dir);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    if (dirStat?.isSymbolicLink()) {
      return {
        ok: false,
        path: target,
        error: `consumeDialecticPending: ${DIALECTIC_CONSUMED_DIR} is a symlink — refusing to archive or prune through it`,
      };
    }
    await mkdir(dir, { recursive: true });
    await rename(target, archivedTo);
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: true, consumed: false, path: target };
    return { ok: false, error: err.message };
  }

  const pruned = await pruneConsumedArchive(dir);
  return { ok: true, consumed: true, path: target, archivedTo, pruned };
}

/**
 * Read `.orchestrator/dialectic-pending.md` if present. Returns the raw file
 * body (including frontmatter) so callers can decide how to parse it.
 * Returns `null` when the file is absent or unreadable.
 *
 * Defensive: any filesystem error degrades to `null` — the file is a
 * cross-session sidecar, and a missing read is indistinguishable from
 * "no pending proposal" semantically.
 *
 * @param {object} args
 * @param {string} args.repoRoot
 * @returns {Promise<string|null>}
 */
export async function readDialecticPending({ repoRoot } = {}) {
  if (!repoRoot) return null;
  const target = pendingPath(repoRoot);
  if (!existsSync(target)) return null;
  try {
    return await readFile(target, 'utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// pending body — serializer + drift comparison (#1386, variant b)
// ---------------------------------------------------------------------------

/**
 * Serialize a deriver diff OBJECT (`result.diff = {user?, agent?}`) into the
 * Markdown body `writeDialecticPending` persists.
 *
 * This lived as a JS snippet in `skills/evolve/references/evolve-dialectic-mode.md`
 * Step 6.4 and is moved here VERBATIM so the dry-run write and the apply-time
 * comparison build the body from the same code — two hand-copied serializers
 * would report drift that is only formatting (#1386).
 *
 * Pure: no I/O, no throw. A non-object argument, or one with neither target as
 * a string, yields `''` — the caller's "nothing to review, write no sidecar"
 * branch.
 *
 * @param {{user?: string, agent?: string}} diff
 * @returns {string} Fenced Markdown body, or `''` when nothing was proposed.
 */
export function renderPendingBody(diff) {
  if (!diff || typeof diff !== 'object') return '';
  const FENCE = '`'.repeat(3);
  return ['user', 'agent']
    .filter((t) => typeof diff[t] === 'string')
    .map((t) => [`${FENCE}diff`, `# target: ${t}`, diff[t].trimEnd(), FENCE].join('\n'))
    .join('\n\n');
}

/**
 * Strip EXACTLY the leading frontmatter block `writeDialecticPending` wrote.
 *
 * The delimiters sit at fixed positions — line 0 and the next `---` LINE — so
 * this splits on the first two delimiter LINES only. A naive `split('---')`
 * breaks on a body containing a `---` line, and diff bodies do.
 *
 * @param {string} content
 * @returns {string} The body, or the whole input when no frontmatter is present.
 */
function stripPendingFrontmatter(content) {
  const lines = content.split('\n');
  if (lines[0] !== '---') return content;
  const end = lines.indexOf('---', 1);
  if (end === -1) return content; // unterminated → nothing to strip
  return lines.slice(end + 1).join('\n');
}

/**
 * Whitespace normalisation for the drift comparison: exactly ONE trailing
 * newline is removed from each side.
 *
 * `writeDialecticPending` appends a newline when the body lacks one, so the
 * persisted body is the rendered body plus `\n` — without this normalisation a
 * clean round-trip would always report drift. Nothing else is normalised (no
 * trim, no line-ending or indentation folding): anything more would hide real
 * drift in a diff body, where trailing whitespace is content.
 */
function normalizeTrailingNewline(text) {
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

/**
 * Compare a freshly derived pending body against the sidecar the operator
 * reviewed (#1386, variant b).
 *
 * `/evolve dialectic --apply` re-derives from the model, so what gets applied
 * is not necessarily what was approved in `.orchestrator/dialectic-pending.md`.
 * This makes that divergence VISIBLE at apply time; it does not make apply
 * deterministic.
 *
 * Never throws — every failure degrades to a result object, matching this
 * module's other readers.
 *
 * @param {object} args
 * @param {string} args.repoRoot
 * @param {string} args.body Fresh body, typically from `renderPendingBody()`.
 * @returns {Promise<{ok:boolean, drifted:boolean, sidecarAbsent:boolean, sidecarBody?:string, freshBody?:string, error?:string}>}
 */
export async function comparePendingBody({ repoRoot, body } = {}) {
  if (!repoRoot) {
    return {
      ok: false,
      drifted: false,
      sidecarAbsent: false,
      error: 'comparePendingBody: repoRoot is required',
    };
  }
  if (typeof body !== 'string') {
    return {
      ok: false,
      drifted: false,
      sidecarAbsent: false,
      error: 'comparePendingBody: body must be a string',
    };
  }

  const raw = await readDialecticPending({ repoRoot });
  // Applying without a sidecar is legitimate (the operator may never have run
  // the dry-run) — that is NOT drift.
  if (raw === null) return { ok: true, drifted: false, sidecarAbsent: true };

  const sidecarBody = stripPendingFrontmatter(raw);
  const drifted = normalizeTrailingNewline(sidecarBody) !== normalizeTrailingNewline(body);

  return { ok: true, drifted, sidecarAbsent: false, sidecarBody, freshBody: body };
}
