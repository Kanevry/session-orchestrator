/**
 * instruction-budget-guard.mjs — #687
 *
 * Lightweight directive-budget guard for always-on `.claude/rules/*.md`.
 *
 * Sums the always-on directive count across the rule files that the
 * rule-loader classifies as always-on (no `globs:` frontmatter) and warns
 * when the total exceeds a ceiling. "Mechanism over discipline" — the
 * #668 instruction-budget audit recommends this as a silent-now growth
 * ratchet that only fires when NEW always-on directives are added.
 *
 * Plain-JS — no Zod dependency. Never throws.
 *   - `computeInstructionBudget` always returns the full shape (never null).
 *   - `checkInstructionBudget` returns a banner object or null (session-start
 *     Phase 4 convention, mirroring checkQgCommandDrift / checkCiStatus).
 *
 * Always-on membership is delegated to `loadApplicableRules` from
 * `./rule-loader.mjs` (single SSOT) — we do NOT hard-code the file list.
 *
 * Cross-references:
 * - "2026-06-20 instruction-budget audit" (#668 / #687; archived in the private Meta-Vault)
 * - scripts/lib/rule-loader.mjs (always-on classification SSOT)
 * - scripts/lib/qg-command-drift-banner.mjs (banner-shape convention)
 * - scripts/lib/ci-status-banner.mjs (never-throws convention)
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
 * Count always-on directives in a single rule file's content.
 *
 * Deterministic heuristic — counts lines that represent a directive:
 *   - bullets:       /^\s*[-*+]\s/
 *   - ordered items: /^\s*\d+[.)]\s/
 *   - headings ≥2:   /^#{2,}\s/
 *
 * Fenced code blocks (``` … ```) are excluded entirely, and a leading
 * `---` … `---` YAML frontmatter block is skipped before counting.
 *
 * @param {string} content - raw file contents
 * @returns {number}
 */
function countDirectives(content) {
  if (typeof content !== 'string' || content === '') return 0;

  const lines = content.split(/\r?\n/);
  let i = 0;

  // Skip a leading YAML frontmatter block: `---` … `---`.
  if (lines[0] !== undefined && lines[0].trim() === '---') {
    let j = 1;
    while (j < lines.length && lines[j].trim() !== '---') j++;
    // Only skip if a closing fence was found; otherwise leave i at 0.
    if (j < lines.length) i = j + 1;
  }

  let count = 0;
  let inFence = false;

  for (; i < lines.length; i++) {
    const line = lines[i];

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
 * Pure computation — always returns the full shape (never null, never throws).
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]  project root (defaults to process.cwd()).
 * @param {string} [opts.rulesDir]  rules directory (defaults to <repoRoot>/.claude/rules).
 * @param {number} [opts.ceiling]   directive ceiling (defaults to DEFAULT_CEILING).
 * @returns {{
 *   totalDirectives: number,
 *   perFile: Array<{ file: string, count: number }>,
 *   ceiling: number,
 *   overBudget: boolean,
 *   severity: 'ok' | 'warn',
 * }}
 *   perFile is sorted DESC by count. On missing/unreadable dir →
 *   { totalDirectives: 0, perFile: [], ceiling, overBudget: false, severity: 'ok' }.
 */
export function computeInstructionBudget(opts = {}) {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const rulesDir = opts.rulesDir ?? join(repoRoot, '.claude/rules');
  const ceiling = typeof opts.ceiling === 'number' ? opts.ceiling : DEFAULT_CEILING;

  const empty = {
    totalDirectives: 0,
    perFile: [],
    ceiling,
    overBudget: false,
    severity: 'ok',
  };

  let entries;
  try {
    // Empty scopePaths → only always-on rules (no glob matches) are returned.
    entries = loadApplicableRules({ rulesDir, scopePaths: [] });
  } catch {
    return empty;
  }

  if (!Array.isArray(entries)) return empty;

  const perFile = [];
  let totalDirectives = 0;

  for (const entry of entries) {
    if (!entry || entry.alwaysOn !== true) continue;
    const count = countDirectives(entry.content);
    totalDirectives += count;
    perFile.push({ file: basename(entry.path), count });
  }

  // Sort DESC by count; tie-break by filename for deterministic output.
  perFile.sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));

  const overBudget = totalDirectives > ceiling;

  return {
    totalDirectives,
    perFile,
    ceiling,
    overBudget,
    severity: overBudget ? 'warn' : 'ok',
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
