/**
 * instruction-budget-guard.mjs — #687 / #877 (FA2)
 *
 * Lightweight directive-budget guard for always-on `.claude/rules/*.md`.
 *
 * Sums the always-on directive count across the rule files that the
 * rule-loader classifies as always-on (no `globs:` frontmatter, and no
 * `paths:` alias either — issue #795: `paths:`-scoped rules are NOT
 * always-on and must not inflate this count) and warns when the total
 * exceeds a ceiling. "Mechanism over discipline" — the #668 instruction-
 * budget audit recommends this as a silent-now growth ratchet that only
 * fires when NEW always-on directives are added.
 *
 * #877 FA2 extends this additively with a BYTE dimension (`totalBytes` /
 * `perFile[].bytes`) and a per-tier surface split (`bySurface`). The
 * original directive-line heuristic only inspects bullet/digit/`##` lines —
 * the majority of an always-on rule file's payload (prose paragraphs, code
 * fences) never contributes to `totalDirectives`, so that count alone
 * understates the real instruction-budget cost. `bySurface` further splits
 * the always-on corpus by `entry.tier` (issue #692) so a coordinator-only
 * file (never reaches a wave agent) does not silently inflate what a wave
 * agent's own budget looks like. The invariant is `always ⊆ wave ⊆
 * coordinator` (NOT the additive `coordinator + wave === totalBytes`
 * identity — that double-counts the `always` tier, which sits in both
 * surfaces; see #877 issue discussion).
 *
 * Plain-JS — no Zod dependency. Never throws.
 *   - `computeInstructionBudget` always returns the full shape (never null).
 *   - `checkInstructionBudget` returns a banner object or null (session-start
 *     Phase 4 convention, mirroring checkQgCommandDrift / checkCiStatus).
 *
 * Always-on membership AND tier-surface gating are both delegated to
 * `loadApplicableRules` from `./rule-loader.mjs` (single SSOT) — we do NOT
 * hard-code the file list, and we do NOT hand-roll a second copy of the
 * tier-gate conditionals `applyGates` already implements (the `context`
 * param below is the exact mechanism rule-loader exposes for this).
 *
 * Cross-references:
 * - "2026-06-20 instruction-budget audit" (#668 / #687; archived in the private Meta-Vault)
 * - scripts/lib/rule-loader.mjs (always-on classification + tier-gate SSOT)
 * - scripts/lib/qg-command-drift-banner.mjs (banner-shape convention)
 * - scripts/lib/ci-status-banner.mjs (never-throws convention)
 * - issue #877 (FA2 — byte dimension + surface split)
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadApplicableRules } from './rule-loader.mjs';

/** Default directive ceiling (operator-chosen growth ratchet just above the ~457 baseline). */
export const DEFAULT_CEILING = 480;

/**
 * Read the `instruction-budget:` nested block from the `## Session Config`
 * section of CLAUDE.md (or AGENTS.md) at `repoRoot`. Synchronous + never throws.
 *
 * The block lives inside `## Session Config`, e.g.:
 *
 *   instruction-budget:
 *     enabled: true
 *     ceiling: 480
 *     mode: warn
 *
 * Behaviour:
 *   - Config-load failure (no instruction file / unreadable) → returns the
 *     graceful fallback `{ enabled: true, ceiling: DEFAULT_CEILING, mode: 'warn' }`
 *     so the probe still computes (mirrors the other session-start probes).
 *   - Absent block → same fallback (the feature is on-by-default, growth-ratchet).
 *   - Malformed individual values silently fall back to the per-key default.
 *
 * @param {string} repoRoot
 * @returns {{ enabled: boolean, ceiling: number, mode: 'warn' | 'off' }}
 */
export function loadInstructionBudgetConfig(repoRoot) {
  const fallback = { enabled: true, ceiling: DEFAULT_CEILING, mode: 'warn' };

  let content = null;
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    const file = join(repoRoot ?? process.cwd(), name);
    try {
      if (existsSync(file)) {
        content = readFileSync(file, 'utf8');
        break;
      }
    } catch {
      // unreadable — try the next candidate
    }
  }
  if (typeof content !== 'string') return fallback;

  try {
    return _parseInstructionBudget(content, fallback);
  } catch {
    return fallback;
  }
}

/**
 * Parse the `instruction-budget:` block out of raw markdown content.
 * Independent helper (testable without disk IO).
 *
 * @param {string} content - full file contents
 * @param {{ enabled: boolean, ceiling: number, mode: 'warn' | 'off' }} [defaults]
 * @returns {{ enabled: boolean, ceiling: number, mode: 'warn' | 'off' }}
 */
export function _parseInstructionBudget(content, defaults) {
  const base = defaults ?? { enabled: true, ceiling: DEFAULT_CEILING, mode: 'warn' };
  if (typeof content !== 'string' || content === '') return { ...base };

  const lines = content.split(/\r?\n/);
  let inBlock = false;
  let keyIndent = 0;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      // The block key normally sits at column 0 inside `## Session Config`,
      // but tolerate a leading indent (e.g. nested under another mapping).
      const m = line.match(/^(\s*)instruction-budget:\s*$/);
      if (m) {
        inBlock = true;
        keyIndent = m[1].length;
      }
      continue;
    }
    // Blank lines stay inside the block (mid-block spacing is tolerated).
    if (line.trim() === '') {
      blockLines.push(line);
      continue;
    }
    // A child line must be indented STRICTLY DEEPER than the block key.
    // Any line at or below the key's indent (incl. column 0) closes the block.
    const indent = line.length - line.replace(/^\s+/, '').length;
    if (indent <= keyIndent) break;
    blockLines.push(line);
  }

  if (blockLines.length === 0) return { ...base };

  let enabled = base.enabled;
  let ceiling = base.ceiling;
  let mode = base.mode;

  for (const rawLine of blockLines) {
    const clean = rawLine.replace(/\s*#.*$/, '').replace(/\s+$/, '');
    if (!clean.trim()) continue;

    const kvMatch = clean.match(/^\s+([a-zA-Z_-]+):\s*(.*)/);
    if (!kvMatch) continue;

    const k = kvMatch[1];
    let v = kvMatch[2].trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1);

    switch (k) {
      case 'enabled':
        // Default on → only flip to false on explicit "false".
        enabled = v.toLowerCase() !== 'false';
        break;
      case 'ceiling': {
        if (/^-?\d+$/.test(v)) {
          const n = Number.parseInt(v, 10);
          if (Number.isFinite(n) && n > 0) ceiling = n;
        }
        break;
      }
      case 'mode':
        // Only `off` silences; any other value (incl. `warn`) surfaces the banner.
        mode = v.toLowerCase() === 'off' ? 'off' : 'warn';
        break;
    }
  }

  return { enabled, ceiling, mode };
}

/**
 * Skips a leading YAML frontmatter block (`---` … `---`) and returns the
 * remaining lines. Shared frontmatter classification for BOTH the directive
 * counter and the byte-walk (#877) — a single SSOT so the two dimensions
 * can never drift on "where does the file's body actually start".
 *
 * @param {string} content - raw file contents
 * @returns {string[]} lines after the frontmatter block (or all lines when
 *   there is no leading frontmatter / it never closes)
 */
function stripFrontmatterLines(content) {
  if (typeof content !== 'string' || content === '') return [];

  const lines = content.split(/\r?\n/);
  let i = 0;

  // Skip a leading YAML frontmatter block: `---` … `---`.
  if (lines[0] !== undefined && lines[0].trim() === '---') {
    let j = 1;
    while (j < lines.length && lines[j].trim() !== '---') j++;
    // Only skip if a closing fence was found; otherwise leave i at 0.
    if (j < lines.length) i = j + 1;
  }

  return lines.slice(i);
}

/**
 * Count always-on directives in a single rule file's content.
 *
 * Deterministic heuristic — counts lines that represent a directive:
 *   - bullets:       /^\s*[-*+]\s/
 *   - ordered items: /^\s*\d+[.)]\s/
 *   - headings ≥2:   /^#{2,}\s/
 *
 * Fenced code blocks (``` … ```) are excluded entirely, and a leading
 * `---` … `---` YAML frontmatter block is skipped before counting (shared
 * skip logic with the byte-walk below — see `stripFrontmatterLines`).
 *
 * Exported (#877) so `countContentBytes` reuses this exact classification
 * instead of a second hand-rolled copy — see the module doc's "Guard &
 * Threshold Design" cross-reference in `.claude/rules/development.md` on
 * why a duplicated classifier is a drift hazard, not a convenience.
 *
 * @param {string} content - raw file contents
 * @returns {number}
 */
export function countDirectives(content) {
  const lines = stripFrontmatterLines(content);

  let count = 0;
  let inFence = false;

  for (const line of lines) {
    // Toggle code-fence state on any line that opens/closes a fence.
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (
      /^\s*[-*+]\s/.test(line) ||
      /^\s*\d+[.)]\s/.test(line) ||
      /^#{2,}\s/.test(line)
    ) {
      count++;
    }
  }

  return count;
}

/**
 * Byte-walk companion to `countDirectives` (#877 FA2). Sums the UTF-8 byte
 * length of a rule file's BODY (everything after a leading YAML frontmatter
 * block, reusing `stripFrontmatterLines` — the exact same frontmatter
 * classification `countDirectives` uses, so the two dimensions can never
 * disagree on where the body starts).
 *
 * Deliberately UNLIKE `countDirectives`: fenced code blocks are NOT
 * excluded here. That divergence is the entire point of the byte
 * dimension — the #877 audit measured that fenced-code and prose bytes
 * (both invisible to the directive-line heuristic) still consume real
 * instruction-budget payload. Frontmatter is excluded from both dimensions
 * identically because it is metadata, not instructional content.
 *
 * @param {string} content - raw file contents
 * @returns {number} UTF-8 byte length of the body (0 for empty/non-string input)
 */
function countContentBytes(content) {
  const lines = stripFrontmatterLines(content);
  if (lines.length === 0) return 0;
  return Buffer.byteLength(lines.join('\n'), 'utf8');
}

/**
 * Sums `countContentBytes` over an entry list already filtered to
 * `alwaysOn === true`. Small private helper so the three surface totals
 * below (`coordinator` / `wave` / `always`) share one summation shape.
 *
 * @param {Array<{content: string}>} entries
 * @returns {number}
 */
function sumBytes(entries) {
  let bytes = 0;
  for (const entry of entries) bytes += countContentBytes(entry.content);
  return bytes;
}

/**
 * Pure computation — always returns the full shape (never null, never throws).
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]  project root (defaults to process.cwd()).
 * @param {string} [opts.rulesDir]  rules directory (defaults to <repoRoot>/.claude/rules).
 * @param {number} [opts.ceiling]   directive ceiling (defaults to DEFAULT_CEILING).
 * @param {'wave'|'coordinator'|null} [opts.context]  (#877) narrows the
 *   PRIMARY totals (`totalDirectives`/`totalBytes`/`perFile`) to what a
 *   WAVE agent actually receives when `'wave'` (excludes `tier:
 *   coordinator-only`, via rule-loader's own tier gate — no hand-rolled
 *   tier conditionals here). `null` (default) or `'coordinator'` both
 *   preserve the pre-#877 shape: every always-on rule, tier-agnostic — the
 *   coordinator, by definition, receives the full always-on corpus (see
 *   `bySurface.coordinator` below). This is independent of `bySurface`,
 *   which is ALWAYS computed for all three surfaces regardless of `context`.
 * @returns {{
 *   totalDirectives: number,
 *   totalBytes: number,
 *   perFile: Array<{ file: string, count: number, bytes: number }>,
 *   ceiling: number,
 *   overBudget: boolean,
 *   severity: 'ok' | 'warn',
 *   bySurface: { coordinator: number, wave: number, always: number },
 * }}
 *   perFile is sorted DESC by count. On missing/unreadable dir →
 *   { totalDirectives: 0, totalBytes: 0, perFile: [], ceiling, overBudget: false,
 *     severity: 'ok', bySurface: { coordinator: 0, wave: 0, always: 0 } }.
 *
 *   bySurface invariant (#877 — NOT the additive `coordinator + wave ===
 *   totalBytes` identity, which double-counts the `always` tier):
 *     always ⊆ wave ⊆ coordinator
 *     bySurface.coordinator === totalBytes (of the FULL always-on set) —
 *       the coordinator is the top-level context that decides what to
 *       inject into each wave dispatch, so it structurally sees the entire
 *       always-on corpus regardless of any file's `tier:`. This is a
 *       DIRECT alias, not a tier-filtered derivation — it holds
 *       unconditionally, not merely because the current corpus happens to
 *       have zero `tier: wave-only` always-on files.
 *     bySurface.wave === bytes of every always-on rule whose tier is not
 *       'coordinator-only' (i.e. what `loadApplicableRules({context:'wave'})`
 *       returns) — equivalently "always + wave-only" bytes, since every
 *       always-on rule in this repo's corpus carries exactly one of the
 *       three tier values.
 *     bySurface.always === bytes of always-on rules with `tier === 'always'` only
 */
export function computeInstructionBudget(opts = {}) {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const rulesDir = opts.rulesDir ?? join(repoRoot, '.claude/rules');
  const ceiling = typeof opts.ceiling === 'number' ? opts.ceiling : DEFAULT_CEILING;
  const context = opts.context === 'wave' ? 'wave' : null;

  const empty = {
    totalDirectives: 0,
    totalBytes: 0,
    perFile: [],
    ceiling,
    overBudget: false,
    severity: 'ok',
    bySurface: { coordinator: 0, wave: 0, always: 0 },
  };

  let allEntries;
  let waveEntries;
  try {
    // Empty scopePaths → only always-on rules (no glob matches) are
    // returned by either call. `context: null` is the pre-#877 shape
    // (tier-agnostic, and also the coordinator's own view — see doc
    // above); `context: 'wave'` applies rule-loader's own tier gate
    // (`applyGates`) — reused, not reimplemented.
    allEntries = loadApplicableRules({ rulesDir, scopePaths: [] });
    waveEntries = loadApplicableRules({ rulesDir, scopePaths: [], context: 'wave' });
  } catch {
    return empty;
  }

  if (!Array.isArray(allEntries) || !Array.isArray(waveEntries)) {
    return empty;
  }

  const alwaysOnAll = allEntries.filter((e) => e && e.alwaysOn === true);
  const alwaysOnWave = waveEntries.filter((e) => e && e.alwaysOn === true);

  const bySurface = {
    coordinator: sumBytes(alwaysOnAll),
    wave: sumBytes(alwaysOnWave),
    always: sumBytes(alwaysOnAll.filter((e) => e.tier === 'always')),
  };

  // Surface-selected entry set for the PRIMARY totals. `context: null`
  // (default) preserves pre-#877 behaviour — every always-on rule,
  // tier-agnostic (same set that defines `bySurface.coordinator`).
  // `context: 'wave'` narrows to what a wave agent receives — the exact
  // same filtered list `bySurface.wave` sums (no second, separately
  // computed entry list).
  const selectedEntries = context === 'wave' ? alwaysOnWave : alwaysOnAll;

  const perFile = [];
  let totalDirectives = 0;
  let totalBytes = 0;

  for (const entry of selectedEntries) {
    const count = countDirectives(entry.content);
    const bytes = countContentBytes(entry.content);
    totalDirectives += count;
    totalBytes += bytes;
    perFile.push({ file: basename(entry.path), count, bytes });
  }

  // Sort DESC by count; tie-break by filename for deterministic output.
  perFile.sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));

  const overBudget = totalDirectives > ceiling;

  return {
    totalDirectives,
    totalBytes,
    perFile,
    ceiling,
    overBudget,
    severity: overBudget ? 'warn' : 'ok',
    bySurface,
  };
}

/**
 * Banner wrapper — session-start Phase 4 convention.
 *
 * Reads `instruction-budget.{enabled,ceiling,mode}` from Session Config
 * (CLAUDE.md / AGENTS.md at `opts.repoRoot`, default process.cwd()):
 *   - `enabled: false` OR `mode: off` → returns null (silent no-op).
 *   - The config `ceiling` is used unless `opts.ceiling` is explicitly supplied
 *     (an explicit opt wins, keeping callers that pin a ceiling deterministic).
 *   - Config-load failure → graceful fallback `{enabled:true, ceiling:480,
 *     mode:warn}` so the probe still computes (mirrors the other probes).
 * Never throws.
 *
 * @param {object} [opts]  forwarded to computeInstructionBudget.
 * @param {string} [opts.repoRoot] project root for the config read.
 * @param {number} [opts.ceiling]  explicit ceiling override (wins over config).
 * @returns {{ severity: 'warn', message: string } | null}
 *   null when disabled / off / at-or-under ceiling OR on any read failure.
 */
export function checkInstructionBudget(opts = {}) {
  let cfg;
  try {
    cfg = loadInstructionBudgetConfig(opts.repoRoot);
  } catch {
    cfg = { enabled: true, ceiling: DEFAULT_CEILING, mode: 'warn' };
  }

  // Opt-out gates — return null without computing.
  if (!cfg.enabled || cfg.mode === 'off') return null;

  // An explicit ceiling opt wins over the config ceiling; otherwise use config.
  const ceiling = typeof opts.ceiling === 'number' ? opts.ceiling : cfg.ceiling;

  let budget;
  try {
    budget = computeInstructionBudget({ ...opts, ceiling });
  } catch {
    return null; // never throw out of the banner wrapper
  }

  if (!budget || !budget.overBudget) return null;

  const top = budget.perFile
    .slice(0, 3)
    .map((f) => `${f.file} (${f.count})`)
    .join(', ');

  const message = [
    `⚠ Instruction budget: ${budget.totalDirectives} always-on directives across ${budget.perFile.length} rules — over ceiling ${budget.ceiling}.`,
    `  Top files: ${top}`,
    '  See the instruction-budget audit (#687; archived in the private Meta-Vault) for the prune/demote list.',
  ].join('\n');

  return { severity: 'warn', message };
}
