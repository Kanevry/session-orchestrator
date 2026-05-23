/**
 * memory-banner.mjs — Phase 6.7 "What I Remembered" banner renderer (issue #505).
 *
 * Produces the session-start banner string the caller (session-start Phase 6.7)
 * then prints. Pure-ish: only `readBannerInputs` does I/O; `formatBanner` and
 * the helpers are deterministic and unit-testable on their own.
 *
 * Behavioural contract (issue #505 AC):
 *   - Header: "📚 Loaded from memory"
 *   - Top-5 active learnings (subject, confidence to 1 decimal, type)
 *   - Stats line: memory files · sessions ever · days since last cleanup
 *   - Peer-card excerpts (USER.md / AGENT.md), one line each when present
 *   - Fresh-repo fallback: a single line when no learnings and no sessions
 *   - Disabled or persistence=off: returns '' (silent no-op for the caller)
 *
 * Truncation rule: any composed visible line longer than 80 chars is truncated
 * with a trailing ellipsis so the rendered length is ≤ 80.
 *
 * No external deps beyond stdlib + existing intra-repo helpers.
 */

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { resolveMemoryDir, readDreamSignals } from './auto-dream.mjs';
import { readPeerCards } from './peer-cards/reader.mjs';
import { surfaceTopN } from './learnings/surface.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max visible width of any single banner line, including bullet/prefix. */
const MAX_LINE_WIDTH = 80;

/** Header rendered above the body (omitted on fresh-repo fallback). */
const HEADER_LINE = '📚 Loaded from memory';

/** Verbatim fresh-repo fallback line (mandated by AC). */
const FRESH_LINE =
  "📚 Memory: 0 entries yet (first session). I'll start learning from this session forward.";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Truncate a string so its visible length is ≤ MAX_LINE_WIDTH. Appends a
 * single-character horizontal-ellipsis ('…') when truncated. No-ops when the
 * input is already within bounds.
 *
 * Operates on UTF-16 code units via String.length — which is what every
 * terminal renderer Counts anyway for the kinds of latin-script content
 * this banner shows. Multi-codepoint emoji (e.g. the header's 📚) are
 * never inside the truncated portion in normal use, but the function
 * tolerates them by trimming the LAST codepoint of any trailing surrogate
 * pair before appending the ellipsis (defence in depth).
 *
 * @param {string} line
 * @param {number} [width=MAX_LINE_WIDTH]
 * @returns {string}
 */
export function truncateLine(line, width = MAX_LINE_WIDTH) {
  if (typeof line !== 'string') return '';
  if (line.length <= width) return line;
  let cut = line.slice(0, width - 1);
  // Avoid splitting a surrogate pair (orphaned high-surrogate).
  const lastCode = cut.charCodeAt(cut.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    cut = cut.slice(0, -1);
  }
  return cut + '…';
}

/**
 * Format a single learning line for the banner.
 *
 * Shape: `  • <subject> (<confidence-1dec>, <type>)`
 * Long subjects are truncated with '…' inside the line so the whole rendered
 * line is ≤ 80 chars.
 *
 * @param {{subject: string, confidence: number, type: string}} learning
 * @returns {string}
 */
export function formatLearningLine({ subject, confidence, type }) {
  const subj = typeof subject === 'string' ? subject : '';
  const conf =
    typeof confidence === 'number' && Number.isFinite(confidence)
      ? confidence.toFixed(1)
      : '0.0';
  const ty = typeof type === 'string' && type.length > 0 ? type : 'unknown';

  // Build naive first; truncate at the line level so the suffix stays intact.
  const naive = `  • ${subj} (${conf}, ${ty})`;
  if (naive.length <= MAX_LINE_WIDTH) return naive;

  // Trim the subject only — keep the trailing (confidence, type) suffix
  // visible because that's what carries actionable signal.
  const suffix = ` (${conf}, ${ty})`;
  const prefix = '  • ';
  // Budget for subject = MAX - prefix.length - suffix.length - 1 (for '…').
  const budget = MAX_LINE_WIDTH - prefix.length - suffix.length - 1;
  if (budget <= 0) {
    // Suffix alone overshoots — fall back to plain truncation.
    return truncateLine(naive);
  }
  let trimmed = subj.slice(0, budget);
  // Defensive: avoid orphan high-surrogate at the tail.
  const lastCode = trimmed.charCodeAt(trimmed.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    trimmed = trimmed.slice(0, -1);
  }
  return `${prefix}${trimmed}…${suffix}`;
}

/**
 * Format the stats line. Renders "last cleanup: never" when daysSinceCleanup
 * is null; otherwise renders "last cleanup <K> days ago".
 *
 * @param {{memoryFiles: number, sessionsEver: number, daysSinceCleanup: number|null}} stats
 * @returns {string}
 */
export function formatStatsLine({ memoryFiles, sessionsEver, daysSinceCleanup }) {
  const mf = Number.isFinite(memoryFiles) ? memoryFiles : 0;
  const se = Number.isFinite(sessionsEver) ? sessionsEver : 0;
  const cleanup =
    daysSinceCleanup === null || daysSinceCleanup === undefined
      ? 'last cleanup: never'
      : `last cleanup ${daysSinceCleanup} days ago`;
  const line = `${mf} memory files · ${se} sessions ever · ${cleanup}`;
  return truncateLine(line);
}

/**
 * Extract a short excerpt from a peer-card body. Returns [sectionHeader, firstContentLine].
 *
 *   - sectionHeader: text of the first `## <text>` line (without the `## ` prefix), or null.
 *   - firstContentLine: first non-blank line AFTER the section header (or the first
 *     non-blank line at all when no `##` header exists). Leading whitespace stripped.
 *
 * Returns [null, null] when the body is empty or whitespace-only.
 *
 * @param {string|null|undefined} cardBody
 * @returns {[string|null, string|null]}
 */
export function extractCardExcerpt(cardBody) {
  if (typeof cardBody !== 'string' || cardBody.length === 0) return [null, null];

  const lines = cardBody.split('\n');
  const isBlank = (l) => /^\s*$/.test(l);

  let headerIdx = -1;
  let header = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      header = m[1];
      headerIdx = i;
      break;
    }
  }

  // Search for the first non-blank line AFTER the header; if no header, scan
  // from the beginning. Skip lines that are themselves `##` headers (a later
  // section header is not "content").
  const startIdx = headerIdx >= 0 ? headerIdx + 1 : 0;
  let content = null;
  for (let i = startIdx; i < lines.length; i += 1) {
    const raw = lines[i];
    if (isBlank(raw)) continue;
    // Skip another header line — we want content text, not the next heading.
    if (/^##\s+/.test(raw)) continue;
    content = raw.replace(/^\s+/, '');
    break;
  }

  if (header === null && content === null) return [null, null];
  return [header, content];
}

/**
 * Format a peer-card excerpt line. Returns null when the excerpt is empty.
 *
 * @param {'USER.md'|'AGENT.md'} label
 * @param {[string|null, string|null]} excerpt
 * @returns {string|null}
 */
function formatPeerExcerptLine(label, excerpt) {
  if (!Array.isArray(excerpt)) return null;
  const [section, content] = excerpt;
  if (!section && !content) return null;

  // When section is missing, fall back to a label-only prefix; when content
  // is missing, drop the trailing colon-content portion.
  let line;
  if (section && content) {
    line = `  ${label} — ${section}: ${content}`;
  } else if (section && !content) {
    line = `  ${label} — ${section}`;
  } else {
    // !section && content
    line = `  ${label} — ${content}`;
  }
  return truncateLine(line);
}

// ---------------------------------------------------------------------------
// Pure formatter
// ---------------------------------------------------------------------------

/**
 * Assemble the banner string from pre-cleaned inputs. No I/O, no JSON
 * stringification — every value passed in is already a scalar or a
 * pre-formatted excerpt tuple.
 *
 * Fresh-repo fallback: when `inputs.fresh === true`, the function returns
 * the AC-mandated single line EXACTLY (no header, no stats, no peers).
 *
 * @param {object} inputs
 * @param {Array<{subject:string, confidence:number, type:string}>} inputs.topLearnings
 * @param {{memoryFiles:number, sessionsEver:number, daysSinceCleanup:number|null}|null} inputs.stats
 * @param {{user:[string|null,string|null]|null, agent:[string|null,string|null]|null}} inputs.peerExcerpts
 * @param {boolean} inputs.fresh
 * @returns {string}
 */
export function formatBanner(inputs) {
  if (!inputs || typeof inputs !== 'object') return '';

  if (inputs.fresh === true) {
    return FRESH_LINE;
  }

  const lines = [HEADER_LINE];

  const topLearnings = Array.isArray(inputs.topLearnings) ? inputs.topLearnings : [];
  for (const learning of topLearnings) {
    if (!learning || typeof learning !== 'object') continue;
    lines.push(formatLearningLine(learning));
  }

  if (inputs.stats && typeof inputs.stats === 'object') {
    lines.push(formatStatsLine(inputs.stats));
  }

  const peers = inputs.peerExcerpts ?? {};
  const userLine = formatPeerExcerptLine('USER.md', peers.user);
  if (userLine) lines.push(userLine);
  const agentLine = formatPeerExcerptLine('AGENT.md', peers.agent);
  if (agentLine) lines.push(agentLine);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// I/O — readBannerInputs
// ---------------------------------------------------------------------------

/**
 * Count lines (newline-terminated entries) in a JSONL file. Missing files
 * resolve to 0; read errors resolve to 0. Empty trailing lines are not
 * counted, matching the JSONL convention.
 *
 * @param {string} filePath
 * @returns {Promise<number>}
 */
async function countJsonlLines(filePath) {
  if (!existsSync(filePath)) return 0;
  try {
    const raw = await readFile(filePath, 'utf8');
    if (raw.length === 0) return 0;
    return raw.split('\n').filter((l) => l.length > 0).length;
  } catch {
    return 0;
  }
}

/**
 * Count `*.md` files in a directory (non-recursive). Missing directory or
 * read errors resolve to 0. MEMORY.md is INCLUDED in the count — the stats
 * line uses "memory files" as a count of all markdown notes in the memory
 * dir, per the AC.
 *
 * @param {string} dir
 * @returns {Promise<number>}
 */
async function countMemoryFiles(dir) {
  if (!existsSync(dir)) return 0;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    let count = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name.toLowerCase().endsWith('.md')) count += 1;
    }
    return count;
  } catch {
    return 0;
  }
}

/**
 * Read every input the banner formatter needs. Pure data — no string
 * formatting. Each subsystem is read defensively: errors degrade to a
 * sensible empty value rather than throwing.
 *
 * @param {object} args
 * @param {string} args.repoRoot — absolute path
 * @param {string} [args.memoryDir] — defaults to `resolveMemoryDir()`
 * @param {string} [args.learningsPath] — defaults to `<repoRoot>/.orchestrator/metrics/learnings.jsonl`
 * @param {Date}   [args.now] — injectable clock for tests
 * @returns {Promise<{
 *   topLearnings: Array<{subject:string, confidence:number, type:string}>,
 *   stats: {memoryFiles:number, sessionsEver:number, daysSinceCleanup:number|null}|null,
 *   peerExcerpts: {user:[string|null,string|null]|null, agent:[string|null,string|null]|null},
 *   fresh: boolean,
 * }>}
 */
export async function readBannerInputs({ repoRoot, memoryDir, learningsPath, now } = {}) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new TypeError('readBannerInputs: repoRoot is required (absolute path)');
  }
  const memDir = typeof memoryDir === 'string' && memoryDir.length > 0
    ? memoryDir
    : resolveMemoryDir();
  const learningsFile = typeof learningsPath === 'string' && learningsPath.length > 0
    ? learningsPath
    : path.join(repoRoot, '.orchestrator', 'metrics', 'learnings.jsonl');
  const clock = now instanceof Date ? now : new Date();

  // --- Top learnings ---------------------------------------------------------
  let topLearnings = [];
  try {
    const surfaced = await surfaceTopN(learningsFile, 5, { now: clock });
    if (Array.isArray(surfaced)) {
      topLearnings = surfaced
        .filter((e) => e && typeof e === 'object')
        .map((e) => ({
          // Fallback to `id` (kebab-case slug, always present) when subject is missing
          // or empty — prevents empty `•  (0.9, type)` lines in the banner.
          // Source: deep-2026-05-23-deep-3 Q4 session-reviewer LOW finding (15 historical
          // learnings entries have subject:null and would have rendered blank).
          subject:
            typeof e.subject === 'string' && e.subject.length > 0
              ? e.subject
              : typeof e.id === 'string'
                ? e.id
                : '',
          confidence: typeof e.confidence === 'number' ? e.confidence : 0,
          type: typeof e.type === 'string' ? e.type : 'unknown',
        }));
    }
  } catch {
    topLearnings = [];
  }

  // --- Stats -----------------------------------------------------------------
  let stats;
  try {
    const signals = await readDreamSignals({ repoRoot, memoryDir: memDir });
    const memoryFiles = await countMemoryFiles(memDir);
    // We deliberately use the actual sessions.jsonl path under repoRoot for
    // the count of "sessions ever" — readDreamSignals exposes sessionsFilePath
    // computed the same way, so we re-derive locally to keep this dependency
    // surface lean and explicit.
    const sessionsPath = path.join(repoRoot, '.orchestrator', 'metrics', 'sessions.jsonl');
    const sessionsEver = await countJsonlLines(sessionsPath);

    let daysSinceCleanup = null;
    if (typeof signals?.lastCleanupAt === 'string' && signals.lastCleanupAt.length > 0) {
      const cleanupMs = Date.parse(signals.lastCleanupAt);
      if (Number.isFinite(cleanupMs)) {
        const deltaMs = clock.getTime() - cleanupMs;
        daysSinceCleanup = Math.max(0, Math.floor(deltaMs / 86_400_000));
      }
    }

    stats = { memoryFiles, sessionsEver, daysSinceCleanup };
  } catch {
    // Fall back to zero-state stats so the banner still renders sensibly
    // when the .orchestrator dir is missing entirely.
    stats = { memoryFiles: 0, sessionsEver: 0, daysSinceCleanup: null };
  }

  // --- Peer-card excerpts ----------------------------------------------------
  let peerExcerpts;
  try {
    const cards = await readPeerCards(repoRoot, { now: clock });
    const userExcerpt =
      cards?.user && typeof cards.user.body === 'string'
        ? extractCardExcerpt(cards.user.body)
        : null;
    const agentExcerpt =
      cards?.agent && typeof cards.agent.body === 'string'
        ? extractCardExcerpt(cards.agent.body)
        : null;

    // Normalize [null, null] tuples to null so the formatter can simply
    // check truthiness — both representations were spec-allowed but the
    // formatter is cleaner with one canonical "absent" sentinel.
    const normalize = (t) => {
      if (!Array.isArray(t)) return null;
      if (t[0] === null && t[1] === null) return null;
      return t;
    };
    peerExcerpts = {
      user: normalize(userExcerpt),
      agent: normalize(agentExcerpt),
    };
  } catch {
    peerExcerpts = { user: null, agent: null };
  }

  const fresh = topLearnings.length === 0 && (stats?.sessionsEver ?? 0) === 0;

  return { topLearnings, stats, peerExcerpts, fresh };
}

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------

/**
 * Render the Phase 6.7 banner string. Returns '' when the banner is disabled
 * via Session Config (`config.persistence === false`, or
 * `config.memory.banner.enabled === false`). The caller — session-start
 * Phase 6.7 — is responsible for printing.
 *
 * Defensive against partial / malformed config: a missing `memory.banner`
 * subtree is treated as enabled (default-on), matching the AC.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {string} [opts.memoryDir]
 * @param {object} opts.config — parseSessionConfig result
 * @param {Date} [opts.now]
 * @returns {Promise<string>}
 */
export async function renderMemoryBanner(opts = {}) {
  const { repoRoot, memoryDir, config, now } = opts;
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new TypeError('renderMemoryBanner: repoRoot is required (absolute path)');
  }

  // Silent no-op when persistence is off or banner is explicitly disabled.
  if (config && config.persistence === false) return '';
  if (
    config
    && typeof config.memory === 'object'
    && config.memory !== null
    && typeof config.memory.banner === 'object'
    && config.memory.banner !== null
    && config.memory.banner.enabled === false
  ) {
    return '';
  }

  const inputs = await readBannerInputs({ repoRoot, memoryDir, now });
  return formatBanner(inputs);
}
