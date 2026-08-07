#!/usr/bin/env node
/**
 * Invariant canary for the #621 HISTORICAL guard banner.
 *
 * The banner is a single canonical literal exported as `HISTORICAL_GUARD_BANNER`
 * from `scripts/lib/historical-guard.mjs` (the SSOT), and it is ALSO quoted as
 * prose in the skill bodies that instruct the coordinator to render it. A reword
 * on the prose side silently diverges from the code constant and weakens the
 * stale-replay guard, because nothing recompiles when markdown changes.
 *
 * This check pins cross-file parity: every prose site that still carries the
 * banner marker must reproduce the SSOT literal byte-for-byte (or an explicitly
 * elided prefix of it — see `classifyBannerSite`).
 *
 * Why per-SITE and not per-FILE: a file-wide `includes(BANNER)` assertion stays
 * green while five of six sites in the same file rot, because one intact copy
 * satisfies it. Each occurrence is therefore judged independently.
 *
 * Deliberate non-goal — this check never pins a SITE COUNT. Sites may legitimately
 * be added or removed; only DIVERGENCE is an error. Whole-site DELETION is covered
 * by the placement tests in `tests/skills/session-start/` (SKILL.md only —
 * presentation-format.md has no placement coverage; for that file this check is
 * the only divergence gate).
 *
 * Known residuals, named so nobody over-reads the coverage claim:
 *  - Detection is marker-gated on TWO SSOT-derived phrases (`DETECTION_MARKERS`).
 *    A reword that destroys BOTH phrases removes the site from the census — that
 *    degenerate case is indistinguishable from whole-site deletion (see above).
 *  - Judging is per-LINE: two banner copies on ONE physical line are satisfied
 *    by the intact copy (unlikely in prose; accepted).
 *  - Only `SCAN_DIRS` markdown is censused; a future banner copy in e.g.
 *    `agents/` or `docs/` would be invisible until the dir is added here.
 *  - Authoring constraint (fail-closed, not fail-open): the elided form must be
 *    the whole normalized line (canonical prefix + elision marker), and a
 *    soft-wrapped multi-line banner is reported as divergent.
 *
 * Reading is done with `readFileSync`, never a `grep` spawn: a single NUL byte
 * makes a text file invisible to grep-based audits (see
 * `.claude/rules/anti-pattern-a-nul-byte-in-a-tracked-production-file-...md`),
 * which would silently drop a rotted site from the census.
 *
 * Import-safety: importing this module only exposes the inspector and runner;
 * the CLI path is guarded at the bottom of the file.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HISTORICAL_GUARD_BANNER } from '../historical-guard.mjs';

/** Directories whose markdown quotes the banner as coordinator-facing prose. */
const SCAN_DIRS = Object.freeze(['skills', 'commands']);

/** Only markdown carries prose copies of the banner. */
const MARKDOWN_EXT = '.md';

/**
 * `git` is invoked with a filtered environment so an ambient `GIT_DIR` cannot
 * redirect enumeration at a foreign repository — that would silently census the
 * wrong file set and pass vacuously.
 */
const GIT_ENV_ALLOWLIST = Object.freeze(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ']);

/**
 * Load-bearing first sentence of the canonical banner, derived from the SSOT.
 * An elided quote may never truncate below this — dropping "NOT LIVE
 * INSTRUCTIONS" removes the entire guard force of the banner.
 */
export const BANNER_FIRST_SENTENCE = HISTORICAL_GUARD_BANNER.slice(
  0,
  HISTORICAL_GUARD_BANNER.indexOf('.') + 1,
);

/**
 * Substring that marks a line as "this line is quoting the banner", derived from
 * the SSOT rather than hardcoded — a second hardcoded copy of banner text inside
 * the drift checker would be the very drift class this check exists to catch.
 */
export const DETECTION_MARKER = BANNER_FIRST_SENTENCE.replace(/^[^A-Z]+/, '').split(' — ')[0];

/**
 * Detection is a DISJUNCTION of two SSOT-derived phrases: a reword that destroys
 * one marker must not hide the site from the census — only destroying both does,
 * and that degenerate case equals whole-site deletion (owned by the placement
 * tests for SKILL.md). Both tokens derive from the SSOT at import time.
 */
export const DETECTION_MARKERS = Object.freeze([
  DETECTION_MARKER,
  BANNER_FIRST_SENTENCE.split(' — ')[1].replace(/\.$/, ''),
]);

/** @param {string} text @returns {boolean} whether any detection marker is present */
function hasDetectionMarker(text) {
  return DETECTION_MARKERS.some((marker) => text.includes(marker));
}

/** Explicit elision markers a prose site may use to shorten the quote. */
const ELISION_MARKERS = Object.freeze(['…', '...']);

/** Offending-text budget in the reported finding (keeps stdout bounded). */
const QUOTE_BUDGET = 160;

/**
 * @typedef {{
 *   kind: string,
 *   file: string,
 *   line: number,
 *   message: string,
 * }} Finding
 */

/**
 * @typedef {{
 *   file: string,
 *   line: number,
 *   form: 'full' | 'elided',
 * }} BannerSite
 */

/**
 * Recursively collect markdown files in deterministic path order.
 *
 * Symlinked entries are never followed: a symlink is an operator-controlled path
 * escape, and following one would scan a file outside the plugin root.
 *
 * @param {string} directory absolute directory path
 * @returns {string[]} absolute markdown file paths, sorted
 */
function walkMarkdown(directory) {
  if (!existsSync(directory)) return [];
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkMarkdown(fullPath));
    } else if (entry.isFile() && path.extname(entry.name) === MARKDOWN_EXT) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

/**
 * Resolve a path through symlinks, falling back to the input when it does not
 * exist (so a missing root is reported by the caller, not thrown here).
 *
 * @param {string} target
 * @returns {string}
 */
function safeRealpath(target) {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}

/**
 * Enumerate tracked markdown under the scan directories.
 *
 * `git ls-files` is the primary source (tracked-only, so scratch drafts do not
 * fail the build); it is trusted ONLY when `pluginRoot` is itself the repository
 * toplevel. When the root sits inside some other repository — or git is
 * unavailable — enumeration falls back to a recursive filesystem walk rather
 * than censusing a foreign file set.
 *
 * @param {string} pluginRoot absolute plugin root
 * @returns {string[]} absolute markdown file paths, sorted
 */
export function collectMarkdownFiles(pluginRoot) {
  const env = {};
  for (const key of GIT_ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }

  try {
    const toplevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: pluginRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env,
    }).trim();
    if (toplevel && safeRealpath(toplevel) === safeRealpath(pluginRoot)) {
      const output = execFileSync('git', ['ls-files', '-z', '--', ...SCAN_DIRS], {
        cwd: pluginRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        env,
      });
      return output
        .split('\0')
        .filter(Boolean)
        .filter((relative) => path.extname(relative) === MARKDOWN_EXT)
        .map((relative) => path.join(pluginRoot, relative))
        .filter((absolute) => {
          try {
            return lstatSync(absolute).isFile();
          } catch {
            return false;
          }
        })
        .sort();
    }
  } catch {
    // fall through to the filesystem walk
  }

  return SCAN_DIRS.flatMap((dir) => walkMarkdown(path.join(pluginRoot, dir))).sort();
}

/**
 * Strip the markdown decoration a prose site may wrap the banner in, so the
 * comparison judges banner TEXT rather than markdown formatting.
 *
 * Handles leading indentation, one or more `>` blockquote prefixes, and a
 * surrounding backtick run. Inner backticks are deliberately preserved — the
 * full-form comparison is a substring match and does not need them removed.
 *
 * @param {string} line raw markdown line
 * @returns {string} normalized line text
 */
export function normalizeQuotedLine(line) {
  let text = line.trim();
  while (text.startsWith('>')) text = text.slice(1).trim();
  return text.replace(/^`+/, '').replace(/`+$/, '').trim();
}

/**
 * Judge one normalized banner-quoting line against the SSOT literal.
 *
 * Two forms are accepted:
 *  - `full`   — the line contains the canonical banner byte-for-byte;
 *  - `elided` — the line is a canonical PREFIX followed by an explicit elision
 *               marker, and that prefix still covers the load-bearing first
 *               sentence. Render-template examples legitimately shorten the
 *               quote; a reword inside the visible part is still caught, because
 *               every visible character must match the SSOT.
 *
 * @param {string} normalized line text from `normalizeQuotedLine`
 * @returns {{ok: boolean, form: 'full' | 'elided' | 'divergent'}}
 */
export function classifyBannerSite(normalized) {
  if (normalized.includes(HISTORICAL_GUARD_BANNER)) return { ok: true, form: 'full' };

  const ellipsis = ELISION_MARKERS.find((marker) => normalized.endsWith(marker));
  if (ellipsis) {
    const prefix = normalized.slice(0, -ellipsis.length).trim();
    const ok =
      HISTORICAL_GUARD_BANNER.startsWith(prefix) && prefix.length >= BANNER_FIRST_SENTENCE.length;
    return { ok, form: 'elided' };
  }

  return { ok: false, form: 'divergent' };
}

/**
 * Inspect cross-file parity of the HISTORICAL guard banner.
 *
 * @param {string} pluginRoot absolute plugin root
 * @returns {{ok: boolean, summary: {filesScanned: number, files: number, sites: number}, sites: BannerSite[], findings: Finding[], toolError: boolean}}
 */
export function inspectBannerParity(pluginRoot) {
  const result = {
    ok: false,
    summary: { filesScanned: 0, files: 0, sites: 0 },
    /** @type {BannerSite[]} */
    sites: [],
    /** @type {Finding[]} */
    findings: [],
    toolError: false,
  };

  let markdownFiles;
  try {
    markdownFiles = collectMarkdownFiles(pluginRoot);
  } catch (error) {
    result.toolError = true;
    result.findings.push({
      kind: 'tool-error',
      file: SCAN_DIRS.join(', '),
      line: 1,
      message: `cannot enumerate markdown: ${error instanceof Error ? error.message : String(error)}`,
    });
    return result;
  }
  result.summary.filesScanned = markdownFiles.length;

  for (const filePath of markdownFiles) {
    const relative = path.relative(pluginRoot, filePath);
    let body;
    try {
      body = readFileSync(filePath, 'utf8');
    } catch (error) {
      result.toolError = true;
      result.findings.push({
        kind: 'tool-error',
        file: relative,
        line: 1,
        message: `cannot read file: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    if (!hasDetectionMarker(body)) continue;

    let sitesInFile = 0;
    const lines = body.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const raw = lines[index];
      if (!hasDetectionMarker(raw)) continue;
      sitesInFile += 1;
      result.summary.sites += 1;

      const normalized = normalizeQuotedLine(raw);
      const verdict = classifyBannerSite(normalized);
      if (verdict.ok) {
        result.sites.push({ file: relative, line: index + 1, form: verdict.form });
        continue;
      }

      const quoted =
        normalized.length > QUOTE_BUDGET ? `${normalized.slice(0, QUOTE_BUDGET)}…` : normalized;
      result.findings.push({
        kind: 'banner-divergence',
        file: relative,
        line: index + 1,
        message:
          `quoted banner diverges from HISTORICAL_GUARD_BANNER (SSOT: scripts/lib/historical-guard.mjs); ` +
          `found: ${JSON.stringify(quoted)}`,
      });
    }
    if (sitesInFile > 0) result.summary.files += 1;
  }

  result.ok = !result.toolError && result.findings.length === 0;
  return result;
}

/**
 * Run the human-readable validator CLI.
 *
 * @param {string} pluginRoot absolute plugin root
 * @returns {number} 0 = pass, 1 = banner divergence, 2 = filesystem/tool failure
 */
export function runCheckBannerParity(pluginRoot) {
  console.log('--- Check: HISTORICAL guard banner parity (#621 invariant canary) ---');
  const inspection = inspectBannerParity(pluginRoot);
  if (inspection.ok) {
    console.log(
      `  PASS: ${inspection.summary.sites} banner site(s) across ${inspection.summary.files} file(s) match the SSOT literal ` +
        `(${inspection.summary.filesScanned} markdown file(s) scanned)`,
    );
    console.log('');
    console.log('Results: 1 passed, 0 failed');
    return 0;
  }

  for (const item of inspection.findings) {
    console.log(`  FAIL: ${item.file}:${item.line} — ${item.message}`);
  }
  console.log('');
  console.log(`Results: 0 passed, ${inspection.findings.length} failed`);
  return inspection.toolError ? 2 : 1;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  const pluginRoot = process.argv[2];
  if (!pluginRoot) {
    console.error('Usage: check-banner-parity.mjs <plugin-root>');
    process.exit(2);
  }
  process.exit(runCheckBannerParity(path.resolve(pluginRoot)));
}
