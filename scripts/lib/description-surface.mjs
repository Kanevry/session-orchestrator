#!/usr/bin/env node
/**
 * description-surface.mjs — #878 FA2c.
 *
 * Measures the frontmatter `description:` field across `agents/*.md`,
 * every skill's SKILL.md (`skills/<name>/SKILL.md`), and `commands/*.md` —
 * a surface invisible to both sibling probes: `claude-md-budget-lint.mjs` measures only the root
 * CLAUDE.md/AGENTS.md, `instruction-budget-guard.mjs` measures only
 * always-on `.claude/rules/*.md`. Neither ever looks at agent/skill/command
 * frontmatter.
 *
 * `agents/AGENTS.md` and any nested `CLAUDE.md` are excluded from the
 * `agents/*.md` walk (see `INSTRUCTION_FILENAMES`) — they are the authoring
 * SPEC for the `agents/` subtree, not an agent definition: no frontmatter,
 * no `description:` field of the kind this module measures. Mirrors the
 * identical exclusion already established for the same directory in
 * `scripts/lib/validate/check-agents.mjs` (`INSTRUCTION_FILENAMES` /
 * `isAgentDefFile`).
 *
 * The bug this module exists to avoid: a naive line-based scanner that
 * greps `^description:\s*(.*)` and stops there undercounts every file whose
 * description uses a YAML block scalar (`description: >`, `description: |`,
 * and the chomping variants `>-`, `|-`, `>+`, `|+`) — the block indicator
 * line itself carries none of the real content, which lives in the
 * INDENTED CONTINUATION LINES below it. A repo-wide 27 KB estimate quoted
 * in the originating PRD was itself produced by exactly this naive scanner
 * (see #878 issue discussion) — this module folds the continuation lines
 * and counts the REAL character/byte length instead, so the two totals
 * (`naiveTotalChars` vs `correctTotalChars`/`correctTotalBytes`) can be
 * reported side by side to make the undercount visible.
 *
 * Deliberately scoped OUT: this module does NOT enforce any length limit.
 * A repo-wide grep found no `1,024-character` (or any other) description
 * limit anywhere in this repo's validators (`validate-plugin`,
 * `check-agents.mjs`, or any plugin schema) — `node scripts/validate-plugin.mjs`
 * passes `agents/eval-judge.md`'s 1,180-char description today. Outliers are
 * reported for visibility via a rank-based "largest N descriptions" list —
 * NOT a statistical fence. Two statistical fences (Tukey's IQR rule and the
 * Iglewicz/Hoaglin modified Z-score) were tried during development and
 * REJECTED: both flagged zero files on the live corpus, so shipping either
 * one would have meant tuning a threshold until it happened to catch the
 * one file we wanted flagged — the exact anti-pattern this module exists to
 * avoid, just aimed at a statistical parameter instead of a raw character
 * count. See `DEFAULT_OUTLIER_TOP_N` for the full rationale. Never a
 * pass/fail gate either way.
 *
 * Pure computation — `measureDescriptionSurface()` never throws and always
 * returns the full shape (mirrors `computeInstructionBudget`'s contract in
 * `instruction-budget-guard.mjs`).
 *
 * Cross-references:
 * - scripts/lib/claude-md-budget-lint.mjs (sibling probe — CLAUDE.md/AGENTS.md only)
 * - scripts/lib/instruction-budget-guard.mjs (sibling probe — always-on rules only, byte-dimension precedent)
 * - scripts/lib/validate/check-agents.mjs (Check 11 — inline-string-only enforcement, agents/*.md ONLY, never skills)
 * - issue #878 (FA2c)
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, resolve } from 'node:path';

/** Block-scalar indicator on the `description:` line: '>' (folded) or '|' (literal), optional chomping '+'/'-'. */
const BLOCK_SCALAR_RE = /^([>|])([+-]?)\s*$/;

/**
 * Default count of "largest descriptions" reported as size outliers.
 *
 * Rank-based, not threshold-based, by deliberate choice: this corpus's
 * length distribution is a smooth long tail (no sharp cliff separating a
 * few anomalies from the rest), so both statistical fences tried during
 * development — Tukey's IQR rule (1.5×IQR above Q3) and the Iglewicz/Hoaglin
 * modified Z-score (median + MAD, threshold 3.5) — flagged ZERO files on
 * the live corpus, INCLUDING `agents/eval-judge.md` at 1,180 chars (the
 * single largest description in the repo, ~17% ahead of the runner-up).
 * Tuning either statistic's threshold until it happened to flag that one
 * file would reproduce the exact anti-pattern this module exists to avoid
 * (inventing a number to fit a desired answer) — just for a STATISTICAL
 * threshold instead of an absolute character count. A plain "top N
 * largest" ranking is honest about what it is (a size-awareness list, not
 * an anomaly claim), and is invariant to the corpus's distribution shape.
 */
export const DEFAULT_OUTLIER_TOP_N = 5;

/**
 * Extracts the TOP-LEVEL frontmatter `description:` field from a markdown
 * file's raw content, folding a YAML block scalar's continuation lines
 * when present. Deliberately narrow — matches ONLY a column-0
 * `description:` key inside the leading `---` … `---` frontmatter fence,
 * so a nested `description:` field (e.g. under an `args-schema:` list item
 * in SKILL.md frontmatter, which is indented) is never mistaken for the
 * top-level field.
 *
 * @param {string} content - raw file content
 * @returns {{ raw: string, isBlockScalar: boolean, style: '>' | '|' | null, chomping: '+' | '-' | null } | null}
 *   null when there is no frontmatter, no closing fence, or no top-level
 *   `description:` key inside it.
 */
export function parseFrontmatterDescription(content) {
  if (typeof content !== 'string' || content === '') return null;
  const lines = content.split(/\r?\n/);
  if (lines[0] === undefined || lines[0].trim() !== '---') return null;

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    // Closing fence is column-0 `---` (trailing whitespace tolerated, LEADING
    // whitespace is NOT — a `.trim()` here previously matched an indented
    // `---` line that is actually part of a block scalar's own body, closing
    // frontmatter parsing early and truncating the description).
    if (lines[i].trimEnd() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return null;

  for (let i = 1; i < end; i++) {
    const m = lines[i].match(/^description:\s*(.*)$/);
    if (!m) continue;

    const rest = m[1].trim();
    const blockMatch = rest.match(BLOCK_SCALAR_RE);

    if (blockMatch) {
      const style = blockMatch[1];
      const chomping = blockMatch[2] || null;

      const bodyLines = [];
      let blockIndent = null;
      for (let j = i + 1; j < end; j++) {
        const line = lines[j];
        if (line.trim() === '') {
          bodyLines.push('');
          continue;
        }
        const indent = line.length - line.replace(/^ */, '').length;
        if (blockIndent === null) blockIndent = indent;
        if (indent < blockIndent) break; // dedent below the block's own indent closes it
        bodyLines.push(line.slice(blockIndent));
      }

      return {
        raw: foldBlockScalar(bodyLines, style, chomping),
        isBlockScalar: true,
        style,
        chomping,
      };
    }

    // Inline value — strip a single layer of matching quotes.
    let val = rest;
    if (val.length >= 2) {
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      else if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
    }
    return { raw: val, isBlockScalar: false, style: null, chomping: null };
  }

  return null;
}

/**
 * Folds a YAML block scalar's dedented body lines per its style/chomping.
 * Close enough to spec for LENGTH-MEASUREMENT purposes — this module is a
 * measurement probe, not a full YAML parser:
 *   - `>` (folded): consecutive non-blank lines join with a single space;
 *     a blank line becomes a paragraph break (kept as `\n`).
 *   - `|` (literal): every line joins with `\n`, preserving line breaks.
 *   - chomping `-` (strip): no trailing newline appended.
 *   - chomping `+` (keep): every trailing blank line is preserved.
 *   - default (clip): a single trailing newline is appended (only when the
 *     block had any content).
 *
 * @param {string[]} bodyLines - dedented body lines (blank lines are '').
 * @param {'>' | '|'} style
 * @param {'+' | '-' | null} chomping
 * @returns {string}
 */
function foldBlockScalar(bodyLines, style, chomping) {
  let trailingBlanks = 0;
  const trimmed = [...bodyLines];
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === '') {
    trimmed.pop();
    trailingBlanks++;
  }

  let text;
  if (style === '>') {
    const paragraphs = [];
    let current = [];
    for (const line of trimmed) {
      if (line === '') {
        if (current.length > 0) paragraphs.push(current.join(' '));
        current = [];
      } else {
        current.push(line);
      }
    }
    if (current.length > 0) paragraphs.push(current.join(' '));
    text = paragraphs.join('\n');
  } else {
    text = trimmed.join('\n');
  }

  if (trimmed.length === 0) return '';
  if (chomping === '-') return text;
  if (chomping === '+') return text + '\n'.repeat(trailingBlanks + 1);
  return `${text}\n`; // default 'clip'
}

/**
 * The naive line-based measurement this module exists to avoid — counts
 * ONLY the characters that appear after `description:` on its own line,
 * exactly what a `grep -m1 '^description:'`-style scanner would see. A block
 * scalar description reads as 0 or 1 chars here (just the `>`/`|`
 * indicator, if present) regardless of how large its real content is.
 * Exported for the falsifiability comparison (`correctTotalChars` MUST be
 * demonstrably larger than `naiveTotalChars` whenever any block scalar is
 * present in the corpus).
 *
 * Deliberately scans the WHOLE file, not just the frontmatter block — this
 * is the more faithful model of "what a real, YAML-unaware grep scanner
 * would see" (a plain `grep -m1 '^description:' file.md` has no concept of
 * a frontmatter fence either). This is safe for `correctChars >= naiveChars`
 * because frontmatter always precedes body content: for any well-formed
 * definition file (frontmatter description as one of the first keys, which
 * `validate-plugin` Check 11 requires for `agents/*.md`), the first
 * column-0 `description:` line this function finds IS the frontmatter one.
 * The one file this bit in practice was `agents/AGENTS.md` — not a
 * definition file at all (no frontmatter, an authoring-convention doc that
 * happens to contain a `description:` example inside its body) — which is
 * why it and `CLAUDE.md` are excluded from the walked corpus entirely (see
 * `INSTRUCTION_FILENAMES`) rather than special-cased here.
 *
 * @param {string} content - raw file content
 * @returns {number}
 */
export function naiveDescriptionLength(content) {
  if (typeof content !== 'string') return 0;
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^description:\s*(.*)$/);
    if (m) return m[1].trim().length;
  }
  return 0;
}

/**
 * Nested instruction files that document authoring conventions for a
 * directory rather than defining an individual agent/command — no
 * frontmatter, not a member of the surface this module measures. Mirrors
 * `scripts/lib/validate/check-agents.mjs`'s identical `INSTRUCTION_FILENAMES`
 * exclusion for the same `agents/` directory (`isAgentDefFile`).
 */
const INSTRUCTION_FILENAMES = new Set(['AGENTS.md', 'CLAUDE.md']);

/**
 * Lists every `{ path, surface }` candidate under the three measured
 * surfaces. Never throws — a missing directory (e.g. no `commands/` in a
 * minimal repo) simply contributes zero entries for that surface.
 *
 * @param {string} repoRoot
 * @returns {Array<{ path: string, surface: 'agents' | 'skills' | 'commands' }>}
 */
function listSurfaceFiles(repoRoot) {
  const files = [];

  files.push(...listMdFilesInDir(join(repoRoot, 'agents'), 'agents'));
  files.push(...listMdFilesInDir(join(repoRoot, 'commands'), 'commands'));

  const skillsDir = join(repoRoot, 'skills');
  try {
    const entries = readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = join(skillsDir, entry.name, 'SKILL.md');
      try {
        if (statSync(skillFile).isFile()) files.push({ path: skillFile, surface: 'skills' });
      } catch {
        // no SKILL.md in this subdirectory — skip
      }
    }
  } catch {
    // no skills/ directory at all — contributes zero entries
  }

  return files;
}

function listMdFilesInDir(dir, surface) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md') && !INSTRUCTION_FILENAMES.has(e.name))
      .map((e) => ({ path: join(dir, e.name), surface }));
  } catch {
    return [];
  }
}

/**
 * Rank-based "largest N descriptions" report over per-file `correctChars`
 * (see `DEFAULT_OUTLIER_TOP_N` doc for why this is rank-based rather than a
 * statistical or absolute-value threshold). Ties at the Nth rank are all
 * included (never silently drops a tied file), so the returned array length
 * can exceed `topN`.
 *
 * @param {Array<{ file: string, correctChars: number }>} perFile
 * @param {number} topN
 * @returns {Array<{ file: string, correctChars: number }>}
 */
function selectLargest(perFile, topN) {
  if (!Array.isArray(perFile) || perFile.length === 0 || topN <= 0) return [];

  const sorted = [...perFile].sort(
    (a, b) => b.correctChars - a.correctChars || a.file.localeCompare(b.file),
  );
  const cutoffValue = sorted[Math.min(topN, sorted.length) - 1].correctChars;
  if (cutoffValue <= 0) return []; // no non-empty descriptions to rank

  return sorted
    .filter((f) => f.correctChars >= cutoffValue)
    .map((f) => ({ file: f.file, correctChars: f.correctChars }));
}

/**
 * Pure computation — always returns the full shape (never null, never
 * throws). Walks `agents/*.md`, every skill's SKILL.md, `commands/*.md`
 * under `opts.repoRoot`, measuring each file's frontmatter `description:`
 * both the naive way and the block-scalar-aware way.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot] project root (defaults to process.cwd()).
 * @param {number} [opts.outlierTopN] size of the "largest descriptions" report (default 5; see `DEFAULT_OUTLIER_TOP_N`).
 * @returns {{
 *   fileCount: number,
 *   naiveTotalChars: number,
 *   correctTotalChars: number,
 *   correctTotalBytes: number,
 *   deltaChars: number,
 *   bySurfaceBytes: { agents: number, skills: number, commands: number },
 *   perFile: Array<{ file: string, surface: string, naiveChars: number, correctChars: number, correctBytes: number, isBlockScalar: boolean }>,
 *   outliers: Array<{ file: string, correctChars: number }>,
 * }}
 *   perFile is sorted DESC by correctChars, tie-broken by file path. `outliers`
 *   is informational sizing (the `outlierTopN` largest descriptions, ties
 *   included), never a pass/fail signal — see `DEFAULT_OUTLIER_TOP_N` doc.
 *   `deltaChars` = correctTotalChars - naiveTotalChars — the visible proof
 *   that folding recovers content the naive scanner missed. It holds >= 0
 *   for every file walked by `listSurfaceFiles`, because that walk is scoped
 *   to well-formed agent/skill/command DEFINITION files, whose frontmatter
 *   `description:` key always precedes any body content — see
 *   `naiveDescriptionLength`'s doc for why that ordering is what makes the
 *   whole-file naive scan safe, and `INSTRUCTION_FILENAMES` for the
 *   authoring-spec files (`agents/AGENTS.md`, `CLAUDE.md`) deliberately
 *   excluded from the walk because they violate that precondition (no
 *   frontmatter at all).
 */
export function measureDescriptionSurface(opts = {}) {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const outlierTopN =
    typeof opts.outlierTopN === 'number' ? opts.outlierTopN : DEFAULT_OUTLIER_TOP_N;

  const empty = {
    fileCount: 0,
    naiveTotalChars: 0,
    correctTotalChars: 0,
    correctTotalBytes: 0,
    deltaChars: 0,
    bySurfaceBytes: { agents: 0, skills: 0, commands: 0 },
    perFile: [],
    outliers: [],
  };

  let entries;
  try {
    entries = listSurfaceFiles(repoRoot);
  } catch {
    return empty;
  }
  if (!Array.isArray(entries) || entries.length === 0) return empty;

  const perFile = [];
  const bySurfaceBytes = { agents: 0, skills: 0, commands: 0 };
  let naiveTotalChars = 0;
  let correctTotalChars = 0;
  let correctTotalBytes = 0;

  for (const entry of entries) {
    let content;
    try {
      content = readFileSync(entry.path, 'utf8');
    } catch {
      continue;
    }

    const naiveChars = naiveDescriptionLength(content);
    const parsed = parseFrontmatterDescription(content);
    const correctChars = parsed ? parsed.raw.length : 0;
    const correctBytes = parsed ? Buffer.byteLength(parsed.raw, 'utf8') : 0;

    naiveTotalChars += naiveChars;
    correctTotalChars += correctChars;
    correctTotalBytes += correctBytes;
    if (bySurfaceBytes[entry.surface] !== undefined) bySurfaceBytes[entry.surface] += correctBytes;

    perFile.push({
      file: relative(repoRoot, entry.path),
      surface: entry.surface,
      naiveChars,
      correctChars,
      correctBytes,
      isBlockScalar: parsed ? parsed.isBlockScalar : false,
    });
  }

  const outliers = selectLargest(perFile, outlierTopN);

  perFile.sort((a, b) => b.correctChars - a.correctChars || a.file.localeCompare(b.file));

  return {
    fileCount: perFile.length,
    naiveTotalChars,
    correctTotalChars,
    correctTotalBytes,
    deltaChars: correctTotalChars - naiveTotalChars,
    bySurfaceBytes,
    perFile,
    outliers,
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

/**
 * Exit code 1 per `.claude/rules/cli-design.md` § Exit Codes — every failure
 * mode below (missing flag value, unrecognized flag, out-of-range value) is
 * a USER/input error, never a system error (network, permissions, missing
 * dependency), so none of them may use exit 2.
 */
function argError(reason) {
  process.stderr.write(JSON.stringify({ status: 'user-error', reason }) + '\n');
  process.exit(1);
}

function parseArgs(argv) {
  const out = { repoRoot: process.cwd(), json: false, outlierTopN: DEFAULT_OUTLIER_TOP_N };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo-root') {
      const val = argv[++i];
      // A trailing `--repo-root` with no following value must fail cleanly,
      // not crash `resolve(undefined)` deeper in main() with an uncaught
      // TypeError.
      if (val === undefined) return argError('--repo-root requires a value');
      out.repoRoot = val;
    } else if (a === '--outlier-top-n') {
      out.outlierTopN = Number.parseInt(argv[++i], 10);
    } else if (a === '--json') {
      out.json = true;
    } else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'Usage: description-surface.mjs [--repo-root PATH] [--outlier-top-n 5] [--json]\n',
      );
      process.exit(0);
    } else {
      return argError(`unknown arg: ${a}`);
    }
  }
  return out;
}

function formatHuman(result) {
  const lines = [
    `Description surface: ${result.fileCount} files — naive: ${result.naiveTotalChars} chars, ` +
      `correct (block-scalar-folded): ${result.correctTotalChars} chars / ${result.correctTotalBytes} bytes ` +
      `(delta: +${result.deltaChars} chars recovered from block scalars).`,
    `  bySurface (bytes): agents=${result.bySurfaceBytes.agents}, skills=${result.bySurfaceBytes.skills}, commands=${result.bySurfaceBytes.commands}`,
  ];
  if (result.outliers.length > 0) {
    lines.push('  Largest descriptions (informational sizing, NOT a limit):');
    for (const o of result.outliers) {
      lines.push(`    - ${o.file}: ${o.correctChars} chars`);
    }
  }
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!Number.isInteger(args.outlierTopN) || args.outlierTopN <= 0) {
    argError('invalid --outlier-top-n');
    return;
  }

  const repoRoot = resolve(args.repoRoot);
  const result = measureDescriptionSurface({ repoRoot, outlierTopN: args.outlierTopN });

  // Deliberately no `process.exit(0)` after this stdout write — mirrors the
  // TRUNCATION half of the #876 fix in scripts/print-applicable-rules.mjs.
  //
  // PARTIAL PARITY, deliberately (session-reviewer finding, 2026-07-25): that
  // module ALSO registers a `process.stdout.on('error')` EPIPE handler so an
  // early-closing reader (`| head`, `| grep -q`) exits 0 quietly instead of
  // throwing an unhandled 'error' event. This module does NOT have that
  // handler. It is not live-reachable today — nothing pipes this CLI (grep
  // -rn "description-surface" scripts/ skills/ hooks/ finds only self-
  // references and its own test) — so porting it now would ship untested
  // behaviour. Port the handler (with an EPIPE test, using a fixture large
  // enough to actually trigger the race — ~240 KB, NOT 80 KB) BEFORE wiring
  // this CLI into any piped consumer. Tracked in issue #892.
  //
  // process.stdout.write() to
  // a pipe is ASYNCHRONOUS in Node; an explicit process.exit() races the
  // kernel pipe buffer (65,536 B on macOS) and can terminate the process
  // before it fully drains, silently truncating any payload beyond that
  // threshold while still reporting exit code 0. Falling off the end of
  // main() lets Node's event loop wait for the pending write to flush before
  // the process exits naturally (default exit code 0) — this generalizes to
  // any payload size, not just today's measured corpus. The two branches
  // below are mutually exclusive (if/else) so only one ever writes to stdout.
  if (args.json) {
    process.stdout.write(JSON.stringify(result) + '\n');
  } else {
    process.stdout.write(formatHuman(result) + '\n');
  }
}

const __filename = fileURLToPath(import.meta.url);
const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] !== null &&
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(__filename);

if (isMain) main();
