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
 * No external deps — Node 20+ stdlib only.
 */

import { readFile, writeFile, rename, unlink, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the project-specific memory directory used by the Claude Code harness.
 *
 * Mirrors the harness convention: `~/.claude/projects/<encoded-cwd>/memory/`
 * where `<encoded-cwd>` is the cwd with BOTH `/` AND `.` replaced by `-`. The
 * dot replacement matters for users with a trailing-`.` in their home dir
 * (e.g. `/Users/bernhardg.`) — without it the resolved path diverges from
 * what the harness actually wrote.
 *
 * Verified empirically against `~/.claude/projects/` directory naming.
 *
 * @returns {string} Absolute path to the memory directory (not guaranteed to exist).
 */
export function resolveMemoryDir() {
  const encoded = process.cwd().replaceAll('/', '-').replaceAll('.', '-');
  return path.join(os.homedir(), '.claude', 'projects', encoded, 'memory');
}

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
 * @param {string} args.memoryDir  Absolute path to the memory dir (use resolveMemoryDir()).
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

    // Find the most recent memory_cleanup_at timestamp across all entries.
    for (const entry of entries) {
      const ts = entry.memory_cleanup_at;
      if (typeof ts === 'string' && ts.length > 0) {
        if (lastCleanupAt === null || ts > lastCleanupAt) {
          lastCleanupAt = ts;
        }
      }
    }

    // Count entries newer than the last cleanup (or total when no cleanup ever ran).
    if (lastCleanupAt === null) {
      sessionsSinceCleanup = entries.length;
    } else {
      for (const entry of entries) {
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
 * @param {string} args.diff                Markdown body (typically a unified-diff block).
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
 * Apply the pending dream by overwriting MEMORY.md with the body the
 * proposal carries, then deleting the sidecar.
 *
 * Behaviour (PRD F2.2):
 *   - Returns `{ applied: false, reason: 'missing' }` when no sidecar exists.
 *   - Returns `{ applied: false, reason: 'stale' }` when the sidecar is older
 *     than 14 days (caller should re-run --dry-run).
 *   - On success: deletes the sidecar, returns line-count deltas.
 *
 * The proposal is expected to embed the *complete* replacement body of
 * MEMORY.md inside a fenced ```` ```diff ```` or ```` ```markdown ```` block.
 * Free-form bodies are accepted but treated as the full replacement verbatim —
 * the dry-run subagent owns the format; this helper is the consumer.
 *
 * @param {object} args
 * @param {string} args.repoRoot
 * @param {string} args.memoryDir
 * @param {number} [args.maxAgeDays=14]
 * @returns {Promise<{applied:boolean, reason?:string, linesBefore?:number, linesAfter?:number, path?:string}>}
 */
export async function applyPendingDream({ repoRoot, memoryDir, maxAgeDays = 14 }) {
  const target = pendingDreamPath(repoRoot);
  if (!existsSync(target)) {
    return { applied: false, reason: 'missing' };
  }

  const content = await readFile(target, 'utf8');
  const { frontmatter, body } = parsePendingDream(content);

  // Staleness check — refuse if generated_at is older than maxAgeDays.
  const generatedAt = frontmatter.generated_at;
  if (typeof generatedAt === 'string' && generatedAt.length > 0) {
    const generatedMs = Date.parse(generatedAt);
    if (!Number.isNaN(generatedMs)) {
      const ageDays = (Date.now() - generatedMs) / (1000 * 60 * 60 * 24);
      if (ageDays > maxAgeDays) {
        return { applied: false, reason: 'stale', ageDays: Math.round(ageDays) };
      }
    }
  }

  const memoryPath = path.join(memoryDir, 'MEMORY.md');
  let linesBefore = 0;
  if (existsSync(memoryPath)) {
    const raw = await readFile(memoryPath, 'utf8');
    linesBefore = raw.length === 0 ? 0 : raw.split('\n').length;
  }

  const newBody = extractDiffBlock(body).trimEnd() + '\n';
  await mkdir(path.dirname(memoryPath), { recursive: true });
  const tmp = `${memoryPath}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, newBody, 'utf8');
  await rename(tmp, memoryPath);

  const linesAfter = newBody.length === 0 ? 0 : newBody.split('\n').length;

  // Consume the sidecar — success leaves no pending file behind.
  await unlink(target);

  return { applied: true, linesBefore, linesAfter, path: memoryPath };
}
