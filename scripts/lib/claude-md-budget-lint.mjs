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
 * exit 2, mirroring the `checker.mjs` contract below.
 *
 * Exit-code contract (mirrors skills/claude-md-drift-check/checker.mjs):
 *   0 — no violations, OR violations present but --mode warn
 *   1 — violations present AND --mode hard (the CLI default)
 *   2 — infra error (missing file, unreadable file, invalid --mode)
 *
 * Cross-references:
 * - scripts/lib/instruction-budget-guard.mjs (sibling directive-count probe)
 * - skills/claude-md-drift-check/checker.mjs (exit-code contract this mirrors)
 * - scripts/lib/rules-sync.mjs (PLUGIN_HEADER_PREFIX provenance-header convention)
 * - skills/bootstrap/fast-template.md § Step 2c (bootstrap wiring)
 * - skills/bootstrap/SKILL.md § Phase 4.5 (bootstrap wiring)
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
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

// ── CLI ───────────────────────────────────────────────────────────────────────

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
    if (a === '--file') out.file = argv[++i];
    else if (a === '--repo-root') out.repoRoot = argv[++i];
    else if (a === '--max-lines') out.maxLines = Number.parseInt(argv[++i], 10);
    else if (a === '--max-line-chars') out.maxLineChars = Number.parseInt(argv[++i], 10);
    else if (a === '--require-provenance') out.requireProvenance = true;
    else if (a === '--mode') out.mode = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'Usage: claude-md-budget-lint.mjs [--file CLAUDE.md|AGENTS.md] [--repo-root PATH] [--max-lines 150] ' +
          '[--max-line-chars 400] [--require-provenance] [--mode hard|warn] [--json]\n'
      );
      process.exit(0);
    } else {
      process.stderr.write(JSON.stringify({ status: 'infra-error', reason: `unknown arg: ${a}` }) + '\n');
      process.exit(2);
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
  const args = parseArgs(process.argv.slice(2));

  if (!['hard', 'warn'].includes(args.mode)) {
    process.stderr.write(JSON.stringify({ status: 'infra-error', reason: `invalid --mode: ${args.mode}` }) + '\n');
    process.exit(2);
  }
  if (!Number.isFinite(args.maxLines) || !Number.isFinite(args.maxLineChars)) {
    process.stderr.write(JSON.stringify({ status: 'infra-error', reason: 'invalid --max-lines/--max-line-chars' }) + '\n');
    process.exit(2);
  }

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
