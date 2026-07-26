#!/usr/bin/env node
/**
 * claude-md-budget-lint.mjs — #722 Epic A Wave 3.
 *
 * Raw-file-property lint for a CLAUDE.md / AGENTS.md instruction file: line
 * count, per-line character length, and (optionally) a provenance-header
 * check on line 1. Deliberately narrow scope — this module measures
 * properties of the instruction file itself and is NOT a replacement for
 * `instruction-budget-guard.mjs` (which measures always-on directive COUNT
 * across `.claude/rules/*.md`). The two are complementary probes, not
 * layered: this lint fires at bootstrap-scaffold time (before `.claude/rules/`
 * even exists), the directive-budget guard fires at session-start once rules
 * are synced.
 *
 * CLI target resolution mirrors the project-instruction alias rule: when
 * `--file` is omitted, `--repo-root` is searched for `CLAUDE.md` first and
 * `AGENTS.md` second.
 *
 * Stdlib-only, no third-party deps. `lintClaudeMd()` is pure computation and
 * throws `ClaudeMdLintInfraError` on any unreadable/missing-file condition —
 * the CLI (`main()`) is the sole place that catches this and maps it to
 * exit 2 (a genuine infra error). CLI-argument errors (parsed in
 * `parseArgs()`/`argError()`) are a SEPARATE class and map to exit 1 instead
 * — see the exit-code contract below.
 *
 * Exit-code contract (#892 CLI-arg hygiene fix — DIVERGES from
 *   skills/claude-md-drift-check/checker.mjs, which still conflates CLI
 *   argument errors with infra errors under exit 2; that module is out of
 *   this fix's file scope, so the divergence is deliberate and not
 *   backported there):
 *   0 — no violations, OR violations present but --mode warn
 *   1 — violations present AND --mode hard (the CLI default), OR a CLI
 *       argument error (missing flag value, unknown flag, invalid --mode,
 *       non-numeric --max-lines/--max-line-chars) — per
 *       .claude/rules/cli-design.md § Exit Codes, an argument error is a
 *       USER/input error, never a system error.
 *   2 — infra error ONLY: missing/unreadable CLAUDE.md/AGENTS.md target file
 *       (surfaced by lintClaudeMd()/resolveLintTarget()).
 *
 * Cross-references:
 * - scripts/lib/instruction-budget-guard.mjs (sibling directive-count probe)
 * - skills/claude-md-drift-check/checker.mjs (infra-error half of the exit-code contract this mirrors; CLI-arg-error half deliberately diverges, see above)
 * - scripts/lib/description-surface.mjs (source of the argError()/CLI-arg-hygiene pattern this module now follows, #878 FA2c)
 * - scripts/lib/rules-sync.mjs (PLUGIN_HEADER_PREFIX provenance-header convention)
 * - skills/bootstrap/fast-template.md § Step 2c (bootstrap wiring)
 * - skills/bootstrap/SKILL.md § Phase 4.5 (bootstrap wiring)
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, resolve } from 'node:path';
import { resolveInstructionFile } from './common.mjs';

/** Thrown by `lintClaudeMd()` on any infra-level failure (missing/unreadable file). */
export class ClaudeMdLintInfraError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ClaudeMdLintInfraError';
  }
}

/** Default line-count ceiling — mirrors the "lean root" convention (pointers, not prose). */
export const DEFAULT_MAX_LINES = 150;
/** Default per-line character ceiling. */
export const DEFAULT_MAX_LINE_CHARS = 400;

/** First-line provenance-header probe — accepts ANY source attribution, not only
 * the plugin's own string (a baseline-generated CLAUDE.md carries its own header). */
const PROVENANCE_HEADER_RE = /^<!--\s*source:/;

/**
 * Lints a CLAUDE.md / AGENTS.md file's raw properties. Pure computation —
 * never catches its own read failures; throws `ClaudeMdLintInfraError`.
 *
 * @param {object} opts
 * @param {string} opts.filePath - absolute or cwd-relative path to the file.
 * @param {number} [opts.maxLines] - line-count ceiling (default 150).
 * @param {number} [opts.maxLineChars] - per-line char ceiling (default 400).
 * @param {boolean} [opts.requireProvenance] - when true, a missing/absent
 *   provenance header on line 1 is a violation (default false).
 * @returns {{
 *   status: 'ok' | 'invalid',
 *   file: string,
 *   lineCount: number,
 *   maxLineCharsSeen: number,
 *   hasProvenance: boolean,
 *   violations: Array<{ rule: 'max-lines' | 'max-line-chars' | 'provenance-header', message: string, line?: number }>,
 * }}
 * @throws {ClaudeMdLintInfraError} when filePath is missing, not a file, or unreadable.
 */
export function lintClaudeMd(opts = {}) {
  const {
    filePath,
    maxLines = DEFAULT_MAX_LINES,
    maxLineChars = DEFAULT_MAX_LINE_CHARS,
    requireProvenance = false,
  } = opts;

  if (!filePath || typeof filePath !== 'string') {
    throw new ClaudeMdLintInfraError('lintClaudeMd: opts.filePath is required');
  }

  let content;
  try {
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      throw new ClaudeMdLintInfraError(`file not found: ${filePath}`);
    }
    content = readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err instanceof ClaudeMdLintInfraError) throw err;
    throw new ClaudeMdLintInfraError(`failed to read ${filePath}: ${err.message}`);
  }

  const lines = content.split('\n');
  const lineCount = lines.length;
  const violations = [];
  let maxLineCharsSeen = 0;

  for (let i = 0; i < lines.length; i++) {
    const len = lines[i].length;
    if (len > maxLineCharsSeen) maxLineCharsSeen = len;
    if (len > maxLineChars) {
      violations.push({
        rule: 'max-line-chars',
        message: `Line ${i + 1} is ${len} chars, exceeds max-line-chars ${maxLineChars}`,
        line: i + 1,
      });
    }
  }

  if (lineCount > maxLines) {
    violations.push({
      rule: 'max-lines',
      message: `File has ${lineCount} lines, exceeds max-lines ${maxLines} — consider trimming to pointers (lean-root convention)`,
    });
  }

  const hasProvenance = lines.length > 0 && PROVENANCE_HEADER_RE.test(lines[0]);

  if (requireProvenance && !hasProvenance) {
    violations.push({
      rule: 'provenance-header',
      message: "Line 1 does not carry a provenance header (expected '<!-- source: ...')",
      line: 1,
    });
  }

  return {
    status: violations.length === 0 ? 'ok' : 'invalid',
    file: filePath,
    lineCount,
    maxLineCharsSeen,
    hasProvenance,
    violations,
  };
}

/**
 * Banner wrapper — session-start Phase 4 convention (#878 FA2b). Resolves
 * the repo's CLAUDE.md/AGENTS.md via `resolveInstructionFile` and lints it
 * via `lintClaudeMd()` in **warn-only** mode: this probe NEVER gates
 * session-start — its exit code is never evaluated as a pass/fail signal,
 * only its violation list is rendered (mirrors `checkInstructionBudget` /
 * `checkReconcileNudge` / the other Phase 4 "banner-or-null" probes).
 *
 * Returns null (silent no-op) when:
 *   - no CLAUDE.md/AGENTS.md resolves under `opts.repoRoot`
 *   - the resolved file has zero violations (`status === 'ok'`)
 *   - `resolveInstructionFile` or `lintClaudeMd` fails for any reason
 *     (never throw out of a banner wrapper — mirrors every sibling probe)
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot] project root (defaults to process.cwd()).
 * @param {number} [opts.maxLines] forwarded to lintClaudeMd (default DEFAULT_MAX_LINES).
 * @param {number} [opts.maxLineChars] forwarded to lintClaudeMd (default DEFAULT_MAX_LINE_CHARS).
 * @returns {{ severity: 'warn', message: string } | null}
 */
export function checkClaudeMdBudgetLint(opts = {}) {
  const repoRoot = opts.repoRoot ?? process.cwd();

  let filePath;
  try {
    const instructionFile = resolveInstructionFile(repoRoot);
    if (!instructionFile) return null;
    filePath = instructionFile.path;
  } catch {
    return null;
  }

  let result;
  try {
    result = lintClaudeMd({
      filePath,
      maxLines: typeof opts.maxLines === 'number' ? opts.maxLines : DEFAULT_MAX_LINES,
      maxLineChars: typeof opts.maxLineChars === 'number' ? opts.maxLineChars : DEFAULT_MAX_LINE_CHARS,
    });
  } catch {
    return null; // never throw out of the banner wrapper
  }

  if (!result || result.violations.length === 0) return null;

  const ruleNames = [...new Set(result.violations.map((v) => v.rule))].join(', ');
  const message =
    `⚠ CLAUDE.md budget lint: ${result.violations.length} violation(s) (${ruleNames}) in ${basename(filePath)} — ` +
    `run \`node scripts/lib/claude-md-budget-lint.mjs --mode warn\` for details.`;

  return { severity: 'warn', message };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

/**
 * Exit code 1 per `.claude/rules/cli-design.md` § Exit Codes — every failure
 * mode below (missing flag value, unrecognized flag, invalid --mode, a
 * non-numeric --max-lines/--max-line-chars) is a USER/input error, never a
 * system error (missing file, unreadable file), so none of them may use
 * exit 2. Mirrors `scripts/lib/description-surface.mjs`'s identical
 * `argError()` pattern (#878 FA2c) — #892 CLI-arg hygiene fix.
 */
function argError(reason) {
  process.stderr.write(JSON.stringify({ status: 'user-error', reason }) + '\n');
  process.exit(1);
}

function parseArgs(argv) {
  const out = {
    file: null,
    repoRoot: process.cwd(),
    maxLines: DEFAULT_MAX_LINES,
    maxLineChars: DEFAULT_MAX_LINE_CHARS,
    requireProvenance: false,
    mode: 'hard',
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') {
      const val = argv[++i];
      // A trailing `--file` with no following value must fail cleanly, not
      // silently fall back to --repo-root-based resolution.
      if (val === undefined) return argError('--file requires a value');
      out.file = val;
    } else if (a === '--repo-root') {
      const val = argv[++i];
      // A trailing `--repo-root` with no following value must fail cleanly,
      // not crash `resolve(undefined)` deeper in resolveLintTarget() with a
      // leaked internal TypeError message.
      if (val === undefined) return argError('--repo-root requires a value');
      out.repoRoot = val;
    } else if (a === '--max-lines') {
      const val = argv[++i];
      if (val === undefined) return argError('--max-lines requires a value');
      const parsed = Number.parseInt(val, 10);
      if (!Number.isFinite(parsed)) return argError(`invalid --max-lines: ${val}`);
      out.maxLines = parsed;
    } else if (a === '--max-line-chars') {
      const val = argv[++i];
      if (val === undefined) return argError('--max-line-chars requires a value');
      const parsed = Number.parseInt(val, 10);
      if (!Number.isFinite(parsed)) return argError(`invalid --max-line-chars: ${val}`);
      out.maxLineChars = parsed;
    } else if (a === '--require-provenance') {
      out.requireProvenance = true;
    } else if (a === '--mode') {
      const val = argv[++i];
      if (val === undefined) return argError('--mode requires a value');
      if (!['hard', 'warn'].includes(val)) return argError(`invalid --mode: ${val}`);
      out.mode = val;
    } else if (a === '--json') {
      out.json = true;
    } else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'Usage: claude-md-budget-lint.mjs [--file CLAUDE.md|AGENTS.md] [--repo-root PATH] [--max-lines 150] ' +
          '[--max-line-chars 400] [--require-provenance] [--mode hard|warn] [--json]\n' +
          'Exit codes: 0 = ok (no violations, or --mode warn with violations); ' +
          '1 = violations in --mode hard, OR a CLI argument error (missing flag value, unknown flag, ' +
          'invalid --mode, non-numeric --max-lines/--max-line-chars); ' +
          '2 = infra error (missing/unreadable CLAUDE.md/AGENTS.md target file).\n'
      );
      process.exit(0);
    } else {
      return argError(`unknown arg: ${a}`);
    }
  }
  return out;
}

function resolveLintTarget(args) {
  if (args.file) return args.file;
  const repoRoot = resolve(args.repoRoot);
  const instructionFile = resolveInstructionFile(repoRoot);
  if (!instructionFile) {
    throw new ClaudeMdLintInfraError(`no CLAUDE.md or AGENTS.md found under ${repoRoot}`);
  }
  return instructionFile.path;
}

function formatHuman(result, mode) {
  const lines = [
    `Instruction budget lint: ${result.status} (file: ${result.file}, lines: ${result.lineCount}, ` +
      `maxLineCharsSeen: ${result.maxLineCharsSeen}, provenance: ${result.hasProvenance}, mode: ${mode})`,
  ];
  for (const v of result.violations) {
    lines.push(`  - [${v.rule}] ${v.message}`);
  }
  return lines.join('\n');
}

function main() {
  // parseArgs() already validates --mode (enum), --max-lines/--max-line-chars
  // (numeric), missing flag values, and unknown flags — calling argError()
  // (exit 1) and terminating the process before returning on any violation.
  // By the time control reaches here, args carries only well-formed values;
  // no redundant re-validation needed (#892 CLI-arg hygiene fix).
  const args = parseArgs(process.argv.slice(2));

  let result;
  try {
    const filePath = resolveLintTarget(args);
    result = lintClaudeMd({
      filePath,
      maxLines: args.maxLines,
      maxLineChars: args.maxLineChars,
      requireProvenance: args.requireProvenance,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(JSON.stringify({ status: 'infra-error', reason }) + '\n');
    process.exit(2);
    return;
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(result) + '\n');
  } else {
    process.stdout.write(formatHuman(result, args.mode) + '\n');
  }

  process.exit(result.violations.length > 0 && args.mode === 'hard' ? 1 : 0);
}

const __filename = fileURLToPath(import.meta.url);
const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] !== null &&
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(__filename);

if (isMain) main();
