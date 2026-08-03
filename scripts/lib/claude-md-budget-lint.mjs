#!/usr/bin/env node
/**
 * claude-md-budget-lint.mjs — #722 Epic A Wave 3.
 *
 * Raw-file-property lint for a CLAUDE.md / AGENTS.md instruction file: line
 * count, per-line character length, and (optionally) a provenance-header
 * check on line 1. The line-count budget excludes ONE named exempt region —
 * the runtime-critical `## Session Config` block, which is machine-parsed
 * configuration rather than trimmable prose (#959); see
 * `findSessionConfigRegion()`. Its opening-heading predicate is IMPORTED from
 * the runtime parser (`config/section-extractor.mjs`) so this lint can never
 * be more permissive than the parser it measures for.
 *
 * NOT extended to `## Skill Evolution` / `## Dispatcher Autonomy` despite
 * those blocks being equally machine-parsed (19 of the 61 non-exempt lines).
 * Measured reason, not taste: `config/{skill-evolution,dispatcher-autonomy}.mjs`
 * anchor on the YAML KEY (`matchBlockHeader(line, 'skill-evolution')`), never
 * on the `##` heading — the heading is prose decoration the parser ignores, so
 * there is no runtime region boundary for a lint predicate to agree WITH.
 * Exempting by heading there would assert a region the runtime does not
 * delimit that way: a fresh instance of the very defect this import fixes.
 * Deliberately narrow scope — this module measures
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
import { isSessionConfigHeading } from './config/section-extractor.mjs';

/** Thrown by `lintClaudeMd()` on any infra-level failure (missing/unreadable file). */
export class ClaudeMdLintInfraError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ClaudeMdLintInfraError';
  }
}

/**
 * Default line-count ceiling — mirrors the "lean root" convention (pointers,
 * not prose). Applied to the file's NON-EXEMPT lines (see
 * `findSessionConfigRegion()` below), never to the raw count.
 *
 * **Derived from measurement, not aspiration (#959).** The predecessor value
 * 150 was applied to the RAW line count and was therefore structurally
 * unreachable for this repo: the `## Session Config` block alone is
 * runtime-critical (parsed by `scripts/parse-config.mjs`;
 * `claude-md-drift-check` Check 6 enforces top-level-key parity against
 * `docs/session-config-template.md`) and cannot be trimmed as prose. An
 * unreachable ceiling manufactures standing deletion pressure with no
 * nameable target per file — the same failure that killed the tests:src
 * ceiling of 1.20 (`.claude/rules/test-value.md` § TV-003).
 *
 * Measured 2026-07-31 at HEAD 1f7b449: this repo's CLAUDE.md is 209 lines in
 * this lint's units (`wc -l` reports 208 — see the off-by-one note on
 * `lintClaudeMd`), of which the Session Config block spans 148 (heading at
 * line 42, next `## ` heading at line 190), leaving **61 non-exempt lines**.
 * 61 × 1.31 ≈ 80 — the same re-derivation headroom TV-003 used when it moved
 * 1.20 → 1.60 (+33%). Every shipped invocation path is `--mode warn` or the
 * never-gating session-start banner, so a tight ceiling costs at most one
 * warn line.
 */
export const DEFAULT_MAX_LINES = 80;
/** Default per-line character ceiling. */
export const DEFAULT_MAX_LINE_CHARS = 400;

/** First-line provenance-header probe — accepts ANY source attribution, not only
 * the plugin's own string (a baseline-generated CLAUDE.md carries its own header). */
const PROVENANCE_HEADER_RE = /^<!--\s*source:/;

/**
 * Opening heading of the ONE named exempt region: the runtime-critical
 * `## Session Config` block (#959).
 *
 * **The predicate is IMPORTED, never re-derived here.** This module measures a
 * block that `parseSessionConfig` parses; if the two disagree about where the
 * block begins, the measurement describes a file the runtime never sees. The
 * first version of this lint owned a local regex that tolerated a trailing
 * HTML comment — justified by this repo's own `## Current State <!-- … -->`
 * convention — which made it the LOOSEST of five copies of this fact and the
 * only one that mattered. An author decorating the heading as that cited
 * convention encourages got: `_extractConfigSection` → `[]` (every runtime
 * config key silently at its default) while this lint reported
 * `148 exempt: "## Session Config"`, affirming the block at the exact moment
 * the runtime had lost it.
 *
 * Invariant, now structural rather than reviewed: **this lint can never accept
 * a heading the runtime parser rejects, because it asks the runtime parser.**
 * The import is safe at bootstrap-scaffold time — `section-extractor.mjs`
 * imports nothing (verified; keep it so).
 *
 * The remaining copies of this fact live in `config-protection.mjs:112`,
 * `product-repo-detect.mjs:113`, `ecosystem-wizard/config-writer.mjs:214`, and
 * `harness-audit/categories/category4.mjs:163`. They are outside this fix's
 * file scope; each is an exact-literal match, so none is looser than the
 * parser — the dangerous asymmetry was here alone.
 */

/** Region terminator: the next top-level `## ` heading of ANY title (must still
 * match a decorated one like `## Skill Evolution <!-- … -->`). The bare-prefix
 * form deliberately does NOT match `### `, whose third char is `#`, not a space. */
const H2_PREFIX_RE = /^## /;

/**
 * Locates the `## Session Config` exempt region. **Fail-closed by
 * construction** — every uncertain case exempts NOTHING, so the budget can
 * only ever over-count, never under-count:
 *
 * - **0 occurrences** → exempt nothing. A consumer repo's CLAUDE.md, or an
 *   AGENTS.md with no config block, is measured in full.
 * - **≥2 occurrences** → exempt nothing AND report it to the caller as a
 *   violation. Exempting both would let an author hide arbitrary prose under a
 *   duplicated heading; exempting only the first is silently wrong.
 * - **exactly 1** → exempt from the heading line through the line before the
 *   next `## ` heading, or through EOF when none follows (a real in-repo
 *   fixture, `tests/fixtures/harness-audit/clean-repo/CLAUDE.md`, ends that way).
 *
 * @param {string[]} lines - the file split on '\n'.
 * @returns {{ exemptLines: number, headingLines: number[] }} `headingLines` is
 *   1-based and carries EVERY occurrence found (length ≥ 2 signals a duplicate).
 */
function findSessionConfigRegion(lines) {
  const headingIdx = [];
  for (let i = 0; i < lines.length; i++) {
    if (isSessionConfigHeading(lines[i])) headingIdx.push(i);
  }
  const headingLines = headingIdx.map((i) => i + 1);

  if (headingIdx.length !== 1) return { exemptLines: 0, headingLines };

  const start = headingIdx[0];
  let end = lines.length; // EOF-terminated block
  for (let i = start + 1; i < lines.length; i++) {
    if (H2_PREFIX_RE.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { exemptLines: end - start, headingLines };
}

/**
 * Lints a CLAUDE.md / AGENTS.md file's raw properties. Pure computation —
 * never catches its own read failures; throws `ClaudeMdLintInfraError`.
 *
 * Because every file ends with a trailing newline, `lineCount` is `wc -l` + 1.
 * That off-by-one is DELIBERATE and load-bearing: the ceiling in
 * `DEFAULT_MAX_LINES` was derived in these same units. Do not "fix" it.
 *
 * The `max-lines` ceiling is compared against `effectiveLineCount`
 * (= `lineCount` − `exemptLines`), not against the raw count — see
 * `findSessionConfigRegion()` for the one named exempt region and its
 * fail-closed 0-or-≥2 rule (#959). `lineCount` stays RAW so the split is
 * reportable rather than hidden.
 *
 * @param {object} opts
 * @param {string} opts.filePath - absolute or cwd-relative path to the file.
 * @param {number} [opts.maxLines] - NON-EXEMPT line-count ceiling (default 80).
 * @param {number} [opts.maxLineChars] - per-line char ceiling (default 400).
 * @param {boolean} [opts.requireProvenance] - when true, a missing/absent
 *   provenance header on line 1 is a violation (default false).
 * @returns {{
 *   status: 'ok' | 'invalid',
 *   file: string,
 *   lineCount: number,
 *   exemptLines: number,
 *   effectiveLineCount: number,
 *   maxLineCharsSeen: number,
 *   hasProvenance: boolean,
 *   violations: Array<{ rule: 'max-lines' | 'max-line-chars' | 'provenance-header' | 'duplicate-session-config', message: string, line?: number }>,
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

  const { exemptLines, headingLines } = findSessionConfigRegion(lines);
  const effectiveLineCount = lineCount - exemptLines;

  if (headingLines.length > 1) {
    violations.push({
      rule: 'duplicate-session-config',
      message:
        `Found ${headingLines.length} '## Session Config' headings (lines ${headingLines.join(', ')}) — ` +
        'exactly one is expected; NOTHING is exempted while duplicates exist, so the ' +
        'max-lines budget is measured against the raw line count',
      line: headingLines[1],
    });
  }

  if (effectiveLineCount > maxLines) {
    const exemptDesc =
      exemptLines > 0 ? `${exemptLines} exempt: "## Session Config"` : `${exemptLines} exempt`;
    violations.push({
      rule: 'max-lines',
      message:
        `File has ${lineCount} lines (${effectiveLineCount} non-exempt, ${exemptDesc}), ` +
        `exceeds max-lines ${maxLines} — consider trimming to pointers (lean-root convention)`,
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
    exemptLines,
    effectiveLineCount,
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
        'Usage: claude-md-budget-lint.mjs [--file CLAUDE.md|AGENTS.md] [--repo-root PATH] [--max-lines 80] ' +
          '[--max-line-chars 400] [--require-provenance] [--mode hard|warn] [--json]\n' +
          '--max-lines applies to NON-EXEMPT lines: a single `## Session Config` block is exempt ' +
          '(0 or 2+ such headings exempt nothing).\n' +
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
      `nonExempt: ${result.effectiveLineCount}, exempt: ${result.exemptLines}, ` +
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
