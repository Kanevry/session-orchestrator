#!/usr/bin/env node
/**
 * sync-vault-schema.mjs — Manages the vendored Zod schema in validator.mjs.
 *
 * Keeps the inline schema block in skills/vault-sync/validator.mjs in lockstep
 * with the canonical TypeScript source in projects-baseline. The vendored block
 * is wrapped in sentinel comments; this script replaces only that block.
 *
 * CLI usage:
 *   node sync-vault-schema.mjs [--write] [--check] [--canonical <path>] [--validator <path>]
 *
 * Modes:
 *   --write  (default) Regenerate sentinel block in validator.mjs from canonical. Idempotent.
 *   --check            Exit 0 if block matches; exit 1 with unified diff on stderr if drifted.
 *
 * Path overrides:
 *   --canonical <path>   Override canonical .ts path.
 *                        Fallback env: CANONICAL_VAULT_FRONTMATTER
 *                        Default: ../../projects-baseline/packages/zod-schemas/src/vault-frontmatter.ts
 *   --validator <path>   Override validator.mjs path.
 *                        Default: ../skills/vault-sync/validator.mjs
 *
 * Exit codes:
 *   0 — success / no drift
 *   1 — drift detected (--check mode)
 *   2 — missing file
 *   3 — malformed sentinels (only one of begin/end present)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Sentinel markers ─────────────────────────────────────────────────────────
const SENTINEL_BEGIN =
  '// ── BEGIN GENERATED SCHEMA (sync-vault-schema.mjs) — do not edit between sentinels ──';
const SENTINEL_END = '// ── END GENERATED SCHEMA ──';

// ── CLI argument parsing ─────────────────────────────────────────────────────
const args = process.argv.slice(2);

function getArg(name) {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : undefined;
}

const isCheck = args.includes('--check');
// --write is the default mode (the non-check path); --write flag just makes intent explicit

const canonicalOverride = getArg('--canonical') ?? process.env.CANONICAL_VAULT_FRONTMATTER;
const validatorOverride = getArg('--validator');

const canonicalPath = canonicalOverride
  ? resolve(canonicalOverride)
  : resolve(__dirname, '../../projects-baseline/packages/zod-schemas/src/vault-frontmatter.ts');

const validatorPath = validatorOverride
  ? resolve(validatorOverride)
  : resolve(__dirname, '../skills/vault-sync/validator.mjs');

// ── File existence checks ────────────────────────────────────────────────────
if (!existsSync(canonicalPath)) {
  process.stderr.write(
    `sync-vault-schema: error: canonical file not found: ${canonicalPath}\n`,
  );
  process.exit(2);
}

if (!existsSync(validatorPath)) {
  process.stderr.write(
    `sync-vault-schema: error: validator file not found: ${validatorPath}\n`,
  );
  process.exit(2);
}

// ── Read canonical .ts ───────────────────────────────────────────────────────
const canonicalSrc = readFileSync(canonicalPath, 'utf8');
const canonicalLines = canonicalSrc.split('\n');

// Extract a const declaration block starting from a line containing startSearch
// up to and including the first line matching endSearch (regex or string).
// Returns the lines as an array (without trailing empty line from split).
function _extractBlock(lines, startSearch, endSearch) {
  const startIdx = lines.findIndex((l) => l.includes(startSearch));
  if (startIdx === -1) {
    process.stderr.write(
      `sync-vault-schema: error: cannot find anchor "${startSearch}" in canonical file.\n` +
        `  If the canonical file structure has changed, update this script.\n`,
    );
    process.exit(2);
  }
  const endRe = typeof endSearch === 'string' ? null : endSearch;
  const endStr = typeof endSearch === 'string' ? endSearch : null;

  for (let i = startIdx; i < lines.length; i++) {
    const matches = endRe ? endRe.test(lines[i]) : lines[i].includes(endStr);
    if (matches) {
      return lines.slice(startIdx, i + 1);
    }
  }
  process.stderr.write(
    `sync-vault-schema: error: found start anchor "${startSearch}" but no end anchor in canonical file.\n`,
  );
  process.exit(2);
}

// Strip TypeScript-only syntax from a line.
// Returns null to skip the line entirely, or the cleaned line string.
// Handles: export keyword removal, export type lines, JSDoc/block comments.
function stripTsLine(line) {
  // Skip lines that are purely a `export type ...` (z.infer type alias)
  if (/^\s*export\s+type\s+/.test(line)) return null;

  // Strip `export ` keyword from const/function declarations
  const stripped = line.replace(/^(export\s+)(const|function|let|var)\s/, '$2 ');

  return stripped;
}

// Strip JSDoc/block-comment lines. We drop entire comment blocks
// (lines starting with slash-star-star, space-star, etc.) to keep the generated block compact.
function stripCommentLine(line) {
  const trimmed = line.trim();
  // Block comment openers, continuations, closers, and inline JSDoc
  if (
    trimmed.startsWith('/**') ||
    trimmed.startsWith('* ') ||
    trimmed === '*' ||
    trimmed.startsWith('*/')
  ) {
    return null;
  }
  // Single-line doc comment
  if (trimmed.startsWith('// ') && !trimmed.startsWith('// ──')) {
    // Keep structural separator comments, drop narrative ones
    return null;
  }
  return line;
}

// ── Extract the five schema constants ────────────────────────────────────────
// Each extraction: find start (line includes anchor), end (semicolon-terminated)

// Regex consts (single-line or two-line continued)
function extractRegexConst(lines, name) {
  const startIdx = lines.findIndex((l) => l.includes(`const ${name} =`));
  if (startIdx === -1) {
    process.stderr.write(
      `sync-vault-schema: error: cannot find "const ${name}" in canonical file.\n`,
    );
    process.exit(2);
  }
  // May be a single line or two lines (value continues on next line)
  // End when we hit a line ending with `;`
  const result = [];
  for (let i = startIdx; i < lines.length; i++) {
    result.push(lines[i]);
    if (lines[i].trimEnd().endsWith(';')) break;
  }
  return result;
}

// z.enum and z.object const blocks — end when line is `);` at top indent level
function extractZodConst(lines, name) {
  const startIdx = lines.findIndex((l) => {
    // Match `export const <name>` or `const <name>`
    return /^(?:export\s+)?const\s+/.test(l) && l.includes(`const ${name} =`);
  });
  if (startIdx === -1) {
    process.stderr.write(
      `sync-vault-schema: error: cannot find "const ${name}" in canonical file.\n`,
    );
    process.exit(2);
  }

  // For z.enum: ends with `]);` at column 0 or indented as part of enum
  // For z.object: ends with `.passthrough();`
  const result = [];
  let depth = 0; // rough bracket depth
  for (let i = startIdx; i < lines.length; i++) {
    const l = lines[i];
    result.push(l);
    for (const ch of l) {
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      if (ch === ')' || ch === ']' || ch === '}') depth--;
    }
    // Terminated when depth returns to 0 AND line ends with `;`
    if (depth === 0 && l.trimEnd().endsWith(';')) break;
  }
  return result;
}

// ── Build generated block ────────────────────────────────────────────────────
function buildGeneratedBlock() {
  const sections = [
    extractRegexConst(canonicalLines, 'slugRegex'),
    extractRegexConst(canonicalLines, 'tagPathRegex'),
    extractRegexConst(canonicalLines, 'isoDateRegex'),
    extractZodConst(canonicalLines, 'vaultNoteTypeSchema'),
    extractZodConst(canonicalLines, 'vaultNoteStatusSchema'),
    extractZodConst(canonicalLines, 'vaultFrontmatterSchema'),
  ];

  const outputLines = [];
  for (const section of sections) {
    for (const rawLine of section) {
      // Strip TypeScript-only syntax
      const afterTs = stripTsLine(rawLine);
      if (afterTs === null) continue;
      // Strip JSDoc/block-comment lines
      const afterComment = stripCommentLine(afterTs);
      if (afterComment === null) continue;
      outputLines.push(afterComment);
    }
    // Blank line between sections
    outputLines.push('');
  }
  // Remove trailing blank line
  while (outputLines.length > 0 && outputLines[outputLines.length - 1] === '') {
    outputLines.pop();
  }

  return outputLines.join('\n');
}

// ── Locate / replace sentinel block in validator.mjs ─────────────────────────
function updateValidator(validatorContent, generatedBlock, _dryRun = false) {
  const beginIdx = validatorContent.indexOf(SENTINEL_BEGIN);
  const endIdx = validatorContent.indexOf(SENTINEL_END);

  if (beginIdx !== -1 && endIdx === -1) {
    process.stderr.write(
      `sync-vault-schema: error: found BEGIN sentinel but missing END sentinel in validator.mjs.\n`,
    );
    process.exit(3);
  }
  if (beginIdx === -1 && endIdx !== -1) {
    process.stderr.write(
      `sync-vault-schema: error: found END sentinel but missing BEGIN sentinel in validator.mjs.\n`,
    );
    process.exit(3);
  }

  // Build the full replacement block (sentinels + content)
  const fullBlock = `${SENTINEL_BEGIN}\n${generatedBlock}\n${SENTINEL_END}`;

  let updatedContent;

  if (beginIdx !== -1 && endIdx !== -1) {
    // Sentinels exist — replace the range between (and including) them
    const afterEnd = endIdx + SENTINEL_END.length;
    updatedContent =
      validatorContent.slice(0, beginIdx) + fullBlock + validatorContent.slice(afterEnd);
  } else {
    // First run — no sentinels yet. Locate the existing inline schema block.
    // Search for `const slugRegex = ` as start anchor.
    const inlineStart = validatorContent.indexOf('const slugRegex = ');
    if (inlineStart === -1) {
      process.stderr.write(
        `sync-vault-schema: error: no sentinels found and cannot locate inline schema anchor "const slugRegex = " in validator.mjs.\n`,
      );
      process.exit(2);
    }
    // Find end: `.passthrough();` (the final line of vaultFrontmatterSchema)
    const inlineEnd = validatorContent.indexOf('.passthrough();', inlineStart);
    if (inlineEnd === -1) {
      process.stderr.write(
        `sync-vault-schema: error: found start anchor but cannot locate ".passthrough();" in validator.mjs.\n`,
      );
      process.exit(2);
    }
    // Include to the end of that line
    const eolAfterEnd = validatorContent.indexOf('\n', inlineEnd);
    const replaceEnd = eolAfterEnd !== -1 ? eolAfterEnd : validatorContent.length;

    updatedContent =
      validatorContent.slice(0, inlineStart) + fullBlock + validatorContent.slice(replaceEnd);
  }

  return updatedContent;
}

// ── Produce a simple unified diff (no external deps) ─────────────────────────
function unifiedDiff(labelA, labelB, linesA, linesB) {
  // Naive line-by-line diff — sufficient for small schema blocks
  const out = [`--- ${labelA}`, `+++ ${labelB}`];
  const maxLen = Math.max(linesA.length, linesB.length);
  let hasDiff = false;
  for (let i = 0; i < maxLen; i++) {
    const a = linesA[i];
    const b = linesB[i];
    if (a !== b) {
      hasDiff = true;
      if (a !== undefined) out.push(`-${a}`);
      if (b !== undefined) out.push(`+${b}`);
    } else {
      out.push(` ${a}`);
    }
  }
  return { hasDiff, text: out.join('\n') };
}

// ── Main ─────────────────────────────────────────────────────────────────────
const validatorContent = readFileSync(validatorPath, 'utf8');
const generatedBlock = buildGeneratedBlock();

if (isCheck) {
  // Extract current block from validator (between sentinels or inline)
  const beginIdx = validatorContent.indexOf(SENTINEL_BEGIN);
  const endIdx = validatorContent.indexOf(SENTINEL_END);

  let currentBlock;
  if (beginIdx !== -1 && endIdx !== -1) {
    // Content between sentinels (exclusive)
    const afterBegin = validatorContent.indexOf('\n', beginIdx) + 1;
    currentBlock = validatorContent.slice(afterBegin, endIdx).trimEnd();
  } else if (beginIdx !== -1 || endIdx !== -1) {
    // One sentinel missing
    process.stderr.write(
      `sync-vault-schema: error: malformed sentinels in validator.mjs (only one sentinel found).\n`,
    );
    process.exit(3);
  } else {
    // No sentinels — compare against inline schema region
    const inlineStart = validatorContent.indexOf('const slugRegex = ');
    const inlineEnd = validatorContent.indexOf('.passthrough();');
    if (inlineStart === -1 || inlineEnd === -1) {
      process.stderr.write(
        `sync-vault-schema: error: cannot locate inline schema in validator.mjs for comparison.\n`,
      );
      process.exit(2);
    }
    const eolAfterEnd = validatorContent.indexOf('\n', inlineEnd);
    currentBlock = validatorContent.slice(inlineStart, eolAfterEnd).trimEnd();
  }

  const { hasDiff, text } = unifiedDiff(
    'validator.mjs (current)',
    'canonical (generated)',
    currentBlock.split('\n'),
    generatedBlock.split('\n'),
  );

  if (hasDiff) {
    process.stderr.write(`sync-vault-schema: drift detected between validator.mjs and canonical.\n\n`);
    process.stderr.write(text + '\n');
    process.exit(1);
  } else {
    process.stdout.write('sync-vault-schema: check passed — no drift detected.\n');
    process.exit(0);
  }
}

// --write mode (default)
const updatedContent = updateValidator(validatorContent, generatedBlock);

if (updatedContent === validatorContent) {
  process.stdout.write('sync-vault-schema: synced: 0 changes (already up-to-date).\n');
  process.exit(0);
}

writeFileSync(validatorPath, updatedContent, 'utf8');

const newLines = generatedBlock.split('\n').length;
process.stdout.write(`sync-vault-schema: wrote: ${newLines} lines between sentinels.\n`);
process.exit(0);
