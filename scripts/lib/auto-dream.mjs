/**
 * auto-dream.mjs — Auto-Dream Post-Session Hook helper (issue #502, PRD F2.2).
 *
 * Provides the decision + I/O surface used by session-end Phase 3.6.5 and by
 * /memory-cleanup --dry-run / --apply-pending. Decides whether the post-session
 * dream should fire, writes the proposed diff to `.orchestrator/pending-dream.md`
 * atomically, and applies it in a follow-up session.
 *
 * Decision inputs (PRD F2.2 acceptance criteria):
 *   - memory-cleanup-threshold (default 5) — sessions since last cleanup
 *   - memory-cleanup-soft-limit (default 180) — MEMORY.md line ceiling
 *   - kill-switch: threshold === 0 → never trigger
 *
 * Proposal-emit min-confidence filter (issue #566): the `auto-dream.min-confidence`
 * key (default 0.5) is PARSED in `scripts/lib/config/auto-dream.mjs`, but its FILTER
 * BEHAVIOR lives in `collectProposals()` (`scripts/lib/memory-proposals/collector.mjs`
 * ~L319). Accepted trade-off (#589 MED-2): filter co-located with the queue it filters;
 * renaming to a `memory.proposals.*` key would break #566's naming. Phase 3.6.3.
 *
 * No external deps — Node 20+ stdlib only.
 */

import { readFile, writeFile, rename, unlink, mkdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { filterRealSessions } from './session-schema.mjs';

// ---------------------------------------------------------------------------
// Signal reader — MEMORY.md size + sessions-since-last-cleanup
// ---------------------------------------------------------------------------

/**
 * Read decision signals used by `shouldDispatchAutoDream`.
 *
 * Returns:
 *   - memoryLines: line count of MEMORY.md (0 if absent).
 *   - lastCleanupAt: max `memory_cleanup_at` ISO timestamp across sessions.jsonl
 *     (null if no entry carries the field).
 *   - sessionsSinceCleanup: count of sessions.jsonl entries with `started_at >
 *     lastCleanupAt` (or total entries when lastCleanupAt is null).
 *   - sessionsFilePath: resolved path to sessions.jsonl (for diagnostics).
 *
 * Schema-additive: `memory_cleanup_at` is read but never assumed present.
 *
 * @param {object} args
 * @param {string} args.repoRoot   Absolute path to the repo root.
 * @param {string} args.memoryDir  Absolute path to the memory dir (use resolveMemoryDir() from './memory-paths.mjs').
 * @returns {Promise<{memoryLines:number, lastCleanupAt:string|null, sessionsSinceCleanup:number, sessionsFilePath:string}>}
 */
export async function readDreamSignals({ repoRoot, memoryDir }) {
  const memoryPath = path.join(memoryDir, 'MEMORY.md');
  const sessionsFilePath = path.join(repoRoot, '.orchestrator', 'metrics', 'sessions.jsonl');

  // 1. Line count of MEMORY.md (missing → 0)
  let memoryLines = 0;
  if (existsSync(memoryPath)) {
    const raw = await readFile(memoryPath, 'utf8');
    memoryLines = raw.length === 0 ? 0 : raw.split('\n').length;
  }

  // 2. Read sessions.jsonl entries to compute lastCleanupAt + sessionsSinceCleanup
  let lastCleanupAt = null;
  let sessionsSinceCleanup = 0;

  if (existsSync(sessionsFilePath)) {
    const raw = await readFile(sessionsFilePath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    const entries = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        // Malformed line — skip silently, this is a best-effort signal reader.
      }
    }

    // Abandoned-session filter (#834): sessions.jsonl carries phantom
    // `status: 'abandoned'` stubs (session-close-backfill records for
    // sessions that ended without a real close). They are legitimate DATA
    // but not legitimate SIGNAL — a burst of abandoned stubs must not fire
    // /memory-cleanup off zero real work. filterRealSessions() is the
    // shared, tested implementation (scripts/lib/session-schema/filters.mjs).
    const realEntries = filterRealSessions(entries);

    // Find the most recent memory_cleanup_at timestamp across all REAL entries.
    for (const entry of realEntries) {
      const ts = entry.memory_cleanup_at;
      if (typeof ts === 'string' && ts.length > 0) {
        if (lastCleanupAt === null || ts > lastCleanupAt) {
          lastCleanupAt = ts;
        }
      }
    }

    // Count REAL entries newer than the last cleanup (or total REAL entries
    // when no cleanup ever ran).
    if (lastCleanupAt === null) {
      sessionsSinceCleanup = realEntries.length;
    } else {
      for (const entry of realEntries) {
        const startedAt = entry.started_at;
        if (typeof startedAt === 'string' && startedAt > lastCleanupAt) {
          sessionsSinceCleanup += 1;
        }
      }
    }
  }

  return { memoryLines, lastCleanupAt, sessionsSinceCleanup, sessionsFilePath };
}

// ---------------------------------------------------------------------------
// Decision function
// ---------------------------------------------------------------------------

/**
 * Decide whether session-end Phase 3.6.5 should dispatch /memory-cleanup --dry-run.
 *
 * Rules (PRD F2.2):
 *   - threshold === 0 → never trigger (kill-switch).
 *   - memoryLines > softLimit → trigger (size-based).
 *   - sessionsSinceLastCleanup >= threshold → trigger (cadence-based).
 *
 * The function is read-only — it never writes any file. Callers may pass an
 * explicit `signals` object for testing; when omitted, readDreamSignals() is
 * invoked.
 *
 * @param {object} args
 * @param {string} args.repoRoot
 * @param {string} args.memoryDir
 * @param {number} [args.threshold=5]   memory-cleanup-threshold from config.
 * @param {number} [args.softLimit=180] memory-cleanup-soft-limit from config.
 * @param {object} [args.signals]       Pre-computed signals (skips disk reads).
 * @returns {Promise<{trigger:boolean, reason:string, signals:object}>}
 */
export async function shouldDispatchAutoDream({
  repoRoot,
  memoryDir,
  threshold = 5,
  softLimit = 180,
  signals,
} = {}) {
  // Kill-switch first — bail before any I/O.
  if (threshold === 0) {
    return {
      trigger: false,
      reason: 'kill-switch (memory-cleanup-threshold=0)',
      signals: signals ?? { memoryLines: 0, sessionsSinceCleanup: 0, lastCleanupAt: null },
    };
  }

  const resolved = signals ?? (await readDreamSignals({ repoRoot, memoryDir }));

  // Size-based trigger first — overrides cadence.
  if (resolved.memoryLines > softLimit) {
    return {
      trigger: true,
      reason: `memory-soft-limit-exceeded (lines=${resolved.memoryLines} > softLimit=${softLimit})`,
      signals: resolved,
    };
  }

  // Cadence-based trigger.
  if (resolved.sessionsSinceCleanup >= threshold) {
    return {
      trigger: true,
      reason: `cadence-threshold-met (sessions-since-cleanup=${resolved.sessionsSinceCleanup} >= threshold=${threshold})`,
      signals: resolved,
    };
  }

  return {
    trigger: false,
    reason: `under-thresholds (memory=${resolved.memoryLines}/${softLimit}, sessions=${resolved.sessionsSinceCleanup}/${threshold})`,
    signals: resolved,
  };
}

// ---------------------------------------------------------------------------
// pending-dream.md — atomic write / read / apply
// ---------------------------------------------------------------------------

/**
 * Resolve the canonical pending-dream sidecar path. The file lives under
 * `.orchestrator/pending-dream.md` relative to the repo root so it survives
 * across sessions while staying out of the vault-mirror scope.
 *
 * @param {string} repoRoot
 * @returns {string}
 */
function pendingDreamPath(repoRoot) {
  return path.join(repoRoot, '.orchestrator', 'pending-dream.md');
}

/**
 * Write the proposed dream diff to `.orchestrator/pending-dream.md` atomically.
 *
 * Caller supplies the body (a Markdown document containing the diff and any
 * narrative). This helper prepends a minimal YAML frontmatter block carrying
 * the metadata session-end's Final Report and the next session's --apply-pending
 * step both rely on.
 *
 * Atomicity: write to `<path>.<rand>.tmp`, then rename(). Same-fs rename is
 * atomic on POSIX — observers see either the previous file or the new one,
 * never a half-written intermediate.
 *
 * @param {object} args
 * @param {string} args.repoRoot
 * @param {string} args.diff                Complete-replacement MEMORY.md body, in exactly one
 *   fenced ```markdown block (never git-style unified-diff hunks) — see the
 *   Serialisation contract in `skills/memory-cleanup/SKILL.md`.
 * @param {string} [args.sourceSession]     Session id that produced the proposal.
 * @param {number} [args.memoryLinesBefore] MEMORY.md line count before.
 * @param {number} [args.proposedLinesAfter] MEMORY.md line count after the proposed diff.
 * @returns {Promise<{path:string, bytes:number}>}
 */
export async function writePendingDream({
  repoRoot,
  diff,
  sourceSession = null,
  memoryLinesBefore = null,
  proposedLinesAfter = null,
}) {
  if (typeof diff !== 'string' || diff.trim().length === 0) {
    throw new TypeError('writePendingDream: diff must be a non-empty string');
  }

  const target = pendingDreamPath(repoRoot);
  await mkdir(path.dirname(target), { recursive: true });

  const generatedAt = new Date().toISOString();
  const frontmatter = [
    '---',
    `generated_at: ${generatedAt}`,
    `source_session: ${JSON.stringify(sourceSession ?? 'unknown')}`,
    `memory_lines_before: ${JSON.stringify(memoryLinesBefore ?? null)}`,
    `proposed_lines_after: ${JSON.stringify(proposedLinesAfter ?? null)}`,
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
 * Read `.orchestrator/pending-dream.md` if present. Returns the raw file body
 * (including frontmatter) so callers can decide how to parse it. Returns null
 * when the file is absent.
 *
 * @param {object} args
 * @param {string} args.repoRoot
 * @returns {Promise<string|null>}
 */
export async function readPendingDream({ repoRoot }) {
  const target = pendingDreamPath(repoRoot);
  if (!existsSync(target)) return null;
  return readFile(target, 'utf8');
}

/**
 * Internal: parse the YAML-style frontmatter block at the top of a
 * pending-dream.md file. Returns the parsed fields and the body that follows.
 *
 * The frontmatter is intentionally hand-rolled (no yaml dep) — it only carries
 * the three flat keys writePendingDream() emits.
 *
 * @param {string} content
 * @returns {{frontmatter: Record<string,string>, body: string}}
 */
function parsePendingDream(content) {
  const lines = content.split('\n');
  if (lines[0] !== '---') {
    return { frontmatter: {}, body: content };
  }
  const frontmatter = {};
  let i = 1;
  while (i < lines.length && lines[i] !== '---') {
    const line = lines[i];
    const idx = line.indexOf(':');
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      frontmatter[key] = val;
    }
    i += 1;
  }
  // Skip the closing '---' and an optional blank separator line.
  let bodyStart = i + 1;
  if (lines[bodyStart] === '') bodyStart += 1;
  return { frontmatter, body: lines.slice(bodyStart).join('\n') };
}

/**
 * Internal: extract a fenced code block tagged as `diff` or `markdown` from
 * the body, returning its inner contents. When no fenced diff is present,
 * returns the full body verbatim — letting --dry-run drop a freeform proposal.
 *
 * @param {string} body
 * @returns {string}
 */
function extractDiffBlock(body) {
  const fenceMatch = body.match(/```(?:diff|markdown)?\n([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1];
  return body;
}

/**
 * Internal: detect whether an extracted block is a git-style unified diff
 * (hunks meant to be applied against an existing file) rather than a
 * complete-replacement Markdown body (issue #717).
 *
 * Detection is keyed on git-diff-SPECIFIC line signatures — deliberately NOT
 * a bare `^[+-]` / `^- ` matcher, because MEMORY.md legitimately contains
 * markdown bullets (`- [Title](file.md) — hook`) that such a naive matcher
 * would false-positive on.
 *
 * @param {string} block
 * @returns {boolean}
 */
function isGitStyleDiff(block) {
  return /^--- /m.test(block) || /^\+\+\+ /m.test(block) || /^@@ .* @@/m.test(block);
}

/**
 * Internal: count fenced ```diff / ```markdown (or untagged ```) code blocks
 * in a raw sidecar body. More than one such fence is the multi-file /
 * multi-hunk sidecar signature (issue #717) — `extractDiffBlock()` only ever
 * consumes the FIRST fence, so a multi-fence body silently drops every
 * subsequent hunk/section if applied naively.
 *
 * @param {string} body
 * @returns {number}
 */
function countFencedBlocks(body) {
  const matches = body.match(/```(?:diff|markdown)?\n[\s\S]*?```/g);
  return matches ? matches.length : 0;
}

/**
 * Internal: detect a fenced code block tagged with a language extractDiffBlock()
 * does not recognize (issue #720) — e.g. ```js, ```python. extractDiffBlock()'s
 * regex only matches `diff` / `markdown` / untagged (bare ``` immediately
 * followed by a newline) fences; any OTHER tag word sits between the opening
 * ``` and the required newline, so the match fails outright and
 * extractDiffBlock() falls back to returning the RAW body verbatim — literal
 * fence markers included — which would otherwise be written straight into
 * MEMORY.md unrefused.
 *
 * Detection is keyed on `extractedBlock === body` (extraction found nothing to
 * strip) AND the body containing an actual fence-opening line. The first half
 * of that conjunction alone is not sufficient: a genuinely fence-free freeform
 * body (issue #502's accepted verbatim-fallback contract) also has
 * `extractedBlock === body`, and must NOT be refused.
 *
 * @param {string} body
 * @param {string} extractedBlock
 * @returns {boolean}
 */
function hasUnrecognizedFence(body, extractedBlock) {
  return extractedBlock === body && /^```/m.test(body);
}

/**
 * Apply the pending dream by overwriting MEMORY.md with the body the
 * proposal carries, then deleting the sidecar.
 *
 * Behaviour (PRD F2.2):
 *   - Returns `{ applied: false, reason: 'missing' }` when no sidecar exists.
 *   - Returns `{ applied: false, reason: 'stale' }` when the sidecar is older
 *     than 14 days (caller should re-run --dry-run).
 *   - Returns `{ applied: false, reason: 'stale-index', driftMs }` (#788) when
 *     MEMORY.md's mtime is newer than the sidecar's `generated_at` — MEMORY.md
 *     was updated BETWEEN the producing --dry-run and this apply, so a
 *     complete-replacement write would clobber those interim edits. MEMORY.md
 *     is left untouched and the sidecar is PRESERVED so the caller can re-run
 *     --dry-run against the current MEMORY.md. A missing MEMORY.md never
 *     triggers this (nothing to clobber). Strict `>`: equal mtimes are clock
 *     resolution noise, not a drift signal.
 *   - Returns `{ applied: false, reason: 'unsupported-format' }` (#717) when
 *     the extracted block is a git-style diff (`isGitStyleDiff()`), the raw
 *     sidecar body contains more than one fenced block (`countFencedBlocks()`
 *     > 1), or the body contains a fence tagged with an unrecognized language
 *     (`hasUnrecognizedFence()`, issue #720 — e.g. ```js, ```python; only
 *     `diff` / `markdown` / untagged fences are recognized). MEMORY.md is left
 *     untouched and the sidecar is PRESERVED (not unlinked) so the proposal
 *     can be regenerated in the correct format.
 *   - On success: deletes the sidecar, returns line-count deltas.
 *
 * The proposal is expected to embed the *complete* replacement body of
 * MEMORY.md inside a single fenced ```` ```diff ```` or ```` ```markdown ````
 * block. Free-form bodies are accepted but treated as the full replacement
 * verbatim — the dry-run subagent owns the format; this helper is the
 * consumer, and it refuses formats it cannot safely apply (see above).
 *
 * @param {object} args
 * @param {string} args.repoRoot
 * @param {string} args.memoryDir
 * @param {number} [args.maxAgeDays=14]
 * @returns {Promise<{applied:boolean, reason?:string, ageDays?:number, driftMs?:number, linesBefore?:number, linesAfter?:number, path?:string}>}
 */
export async function applyPendingDream({ repoRoot, memoryDir, maxAgeDays = 14 }) {
  const target = pendingDreamPath(repoRoot);
  if (!existsSync(target)) {
    return { applied: false, reason: 'missing' };
  }

  const content = await readFile(target, 'utf8');
  const { frontmatter, body } = parsePendingDream(content);

  const memoryPath = path.join(memoryDir, 'MEMORY.md');

  // Staleness check — refuse if generated_at is older than maxAgeDays.
  const generatedAt = frontmatter.generated_at;
  if (typeof generatedAt === 'string' && generatedAt.length > 0) {
    const generatedMs = Date.parse(generatedAt);
    if (!Number.isNaN(generatedMs)) {
      const ageDays = (Date.now() - generatedMs) / (1000 * 60 * 60 * 24);
      if (ageDays > maxAgeDays) {
        return { applied: false, reason: 'stale', ageDays: Math.round(ageDays) };
      }

      // Drift check (#788) — refuse if MEMORY.md changed AFTER the producing
      // --dry-run. applyPendingDream is a complete-replacement write frozen on
      // the dry-run snapshot; an interim MEMORY.md edit would be silently
      // clobbered. A missing MEMORY.md has nothing to clobber.
      //
      // Resolution note: `generated_at` is `new Date().toISOString()`, truncated
      // to whole milliseconds, whereas statSync().mtimeMs carries sub-ms
      // (nanosecond) precision on APFS/ext4. Comparing them raw makes a
      // MEMORY.md written in the SAME millisecond as the sidecar (mtimeMs
      // fractionally > the floored generatedMs) look like drift. Floor mtimeMs
      // to the resolution `generated_at` actually has, then apply strict `>`
      // (mirrors `ageDays > maxAgeDays`): same-millisecond = clock-resolution
      // noise, not a drift signal; a later write (≥1ms) is a real signal.
      if (existsSync(memoryPath)) {
        const memoryMtimeMs = statSync(memoryPath).mtimeMs;
        if (Math.floor(memoryMtimeMs) > generatedMs) {
          return { applied: false, reason: 'stale-index', driftMs: Math.round(memoryMtimeMs - generatedMs) };
        }
      }
    }
  }

  let linesBefore = 0;
  if (existsSync(memoryPath)) {
    const raw = await readFile(memoryPath, 'utf8');
    linesBefore = raw.length === 0 ? 0 : raw.split('\n').length;
  }

  const extractedBlock = extractDiffBlock(body);

  // Guard (#717, extended #720): refuse formats this applier cannot safely
  // consume. A git-style diff (hunks), a multi-fence body, or a fence tagged
  // with a language extractDiffBlock() doesn't recognize (e.g. ```js) written
  // verbatim (fence markers included) as the new MEMORY.md would corrupt the
  // index / silently drop subsequent sections / pollute MEMORY.md with a
  // literal fence marker. Preserve the sidecar — do NOT write, do NOT unlink
  // — so the operator can regenerate a complete-body proposal via --dry-run.
  if (isGitStyleDiff(extractedBlock) || countFencedBlocks(body) > 1 || hasUnrecognizedFence(body, extractedBlock)) {
    return { applied: false, reason: 'unsupported-format' };
  }

  const newBody = extractedBlock.trimEnd() + '\n';
  await mkdir(path.dirname(memoryPath), { recursive: true });
  const tmp = `${memoryPath}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, newBody, 'utf8');
  await rename(tmp, memoryPath);

  const linesAfter = newBody.length === 0 ? 0 : newBody.split('\n').length;

  // Consume the sidecar — success leaves no pending file behind.
  await unlink(target);

  return { applied: true, linesBefore, linesAfter, path: memoryPath };
}
