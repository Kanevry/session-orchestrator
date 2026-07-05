/**
 * validate-vendored-rules.mjs — issue #722 Epic A Wave 2.
 *
 * Validates a canonical rule file (or a directory of them) BEFORE it is
 * written into a consumer repo's `.claude/rules/` by `rules-sync.mjs`.
 * Catches vendoring bugs that are invisible at the source-of-truth layer but
 * become live footguns once synced into a target repo:
 *
 *   - `paths:` frontmatter — `rule-loader.mjs` only understands `globs:`; a
 *     `paths:` key is silently ignored, so the rule loads as always-on
 *     instead of the intended glob-scoped subset.
 *   - Missing provenance header — `rules-sync.mjs` detects "plugin-owned vs.
 *     local override" purely by checking whether the first line starts with
 *     `PLUGIN_HEADER_PREFIX`. A source file missing that header gets
 *     mis-detected as a local override on the NEXT re-sync (it looks
 *     hand-authored), so the plugin can never update it again.
 *   - Unfilled placeholder tokens (`{{PROJECT_NAME}}`-style, `## TODO:
 *     Customize` headings, `<!-- TODO:` comments) leaking from an
 *     un-filled-in skeleton into a synced rule.
 *   - `globs:` patterns that match zero files in the target repo (warn —
 *     legitimately possible in a freshly-scaffolded repo whose src/ tree
 *     doesn't exist yet).
 *   - `globs:` patterns carrying a PascalCase, product-like path segment
 *     (e.g. `WalkAITalkieTests`) — a strong signal the glob leaked from one
 *     specific product repo rather than being written generically.
 *
 * Stdlib-only ESM, with the same picomatch-with-fallback resolution pattern
 * as `rule-loader.mjs` (duplicated here rather than imported because those
 * helpers are module-private there — the *approach* is reused, not
 * reinvented). Frontmatter `globs:` extraction is NOT duplicated — this
 * module imports the already-exported `parseGlobsFrontmatter` from
 * `rule-loader.mjs` directly.
 *
 * @module validate-vendored-rules
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { parseGlobsFrontmatter } from './rule-loader.mjs';

// Mirrors rules-sync.mjs's exported PLUGIN_HEADER_PREFIX (rules-sync.mjs
// line ~13). NOT imported from there on purpose: rules-sync.mjs imports
// validateRuleContent from THIS module for its pre-write gate, so importing
// the constant back would create a module-load cycle between the two files.
// Keep both copies textually identical if either changes.
const PLUGIN_HEADER_PREFIX = '<!-- source: session-orchestrator plugin';

// ---------------------------------------------------------------------------
// Picomatch integration (mirrors rule-loader.mjs's resolution pattern — those
// helpers are module-private there, so the same approach is duplicated here
// rather than invented anew).
// ---------------------------------------------------------------------------

let _picomatch = null;

function getPicomatch() {
  if (_picomatch !== null) return _picomatch;
  try {
    const require = createRequire(import.meta.url);
    _picomatch = require('picomatch');
  } catch {
    _picomatch = false;
  }
  return _picomatch;
}

/**
 * Minimal glob-to-RegExp fallback used only when picomatch is absent.
 * @param {string} pattern
 * @returns {RegExp}
 */
function globToRegExp(pattern) {
  const p = pattern.replace(/\\/g, '/');
  let re = '';
  let i = 0;
  while (i < p.length) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      re += '.*';
      i += 2;
      if (p[i] === '/') i++;
    } else if (c === '*') {
      re += '[^/]*';
      i++;
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if (c === '.') {
      re += '\\.';
      i++;
    } else {
      re += c.replace(/[$()+[\]^{|}]/g, '\\$&');
      i++;
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * @param {string} filePath - path relative to repo root, forward-slash separated
 * @param {string} globPattern
 * @returns {boolean}
 */
function matchGlob(filePath, globPattern) {
  const pm = getPicomatch();
  if (pm) return pm.isMatch(filePath, globPattern, { dot: true });
  return globToRegExp(globPattern).test(filePath);
}

// ---------------------------------------------------------------------------
// Frontmatter helpers
// ---------------------------------------------------------------------------

const HEADER_LINE_RE = /^[ \t]*(?:<!--.*-->)?[ \t]*$/;

/**
 * Finds a YAML frontmatter block delimited by `---` lines.
 *
 * Mirrors rule-loader.mjs's header-tolerant frontmatter shape for the `paths:`
 * authoring guard: a leading run of blank lines and/or single-line HTML
 * comments may precede the opening `---`.
 *
 * @param {string} content
 * @returns {{ body: string, startLine: number } | null} startLine is the
 *   0-based file-line index of the opening `---`.
 */
function extractFrontmatter(content) {
  const lines = content.split(/\r?\n/);
  let startLine = 0;
  while (startLine < lines.length && HEADER_LINE_RE.test(lines[startLine])) {
    startLine++;
  }
  if (lines[startLine] !== '---') return null;
  for (let i = startLine + 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      return { body: lines.slice(startLine + 1, i).join('\n'), startLine };
    }
  }
  return null;
}

/**
 * Line number (1-based, absolute within the file) of a match at `bodyIndex`
 * inside the frontmatter body.
 * @param {number} startLine - 0-based file-line index of the opening `---`
 * @param {string} body - frontmatter body text
 * @param {number} bodyIndex - character offset within body
 * @returns {number}
 */
function lineWithinFrontmatter(startLine, body, bodyIndex) {
  return startLine + 1 + body.slice(0, bodyIndex).split('\n').length;
}

/**
 * Blanks out fenced code-block lines (content between ``` markers) while
 * preserving line count, so placeholder-token detection does not false-
 * positive on documentation that explains the placeholder convention.
 * @param {string} content
 * @returns {string}
 */
function stripFencedCodeBlocks(content) {
  const lines = content.split('\n');
  let inFence = false;
  const out = [];
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      out.push('');
      continue;
    }
    out.push(inFence ? '' : line);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Target-repo file list (for zero-match-globs), cached per resolved root.
// ---------------------------------------------------------------------------

const _fileListCache = new Map();

/**
 * @param {string} dir
 * @returns {string[]} paths relative to dir, forward-slash separated
 */
function walkRecursive(dir) {
  const root = resolve(dir);
  const results = [];
  function walk(current) {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        results.push(relative(root, full).replace(/\\/g, '/'));
      }
    }
  }
  walk(root);
  return results;
}

/**
 * Returns the list of tracked files under `targetRoot` (relative,
 * forward-slash separated). Prefers `git ls-files` (respects .gitignore);
 * falls back to a recursive readdir walk when not a git repo or git is
 * unavailable. Cached per resolved root for the lifetime of the process.
 * @param {string} targetRoot
 * @returns {string[]}
 */
function getTargetFileList(targetRoot) {
  const resolvedRoot = resolve(targetRoot);
  if (_fileListCache.has(resolvedRoot)) return _fileListCache.get(resolvedRoot);

  let files;
  try {
    const out = execFileSync('git', ['-C', resolvedRoot, 'ls-files'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    files = out.split('\n').map((f) => f.trim()).filter(Boolean);
  } catch {
    files = walkRecursive(resolvedRoot);
  }

  _fileListCache.set(resolvedRoot, files);
  return files;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const PLACEHOLDER_HANDLEBARS_RE = /\{\{[A-Z_]+\}\}/;
const FOREIGN_TOKEN_RE = /[A-Z][a-z]+[A-Z]/;

/**
 * @typedef {object} RuleViolation
 * @property {string} rule - check id (paths-frontmatter | provenance-header | placeholder | zero-match-globs | foreign-glob)
 * @property {'error'|'warn'} severity
 * @property {string} message
 * @property {number} [line] - 1-based line number, when known
 */

/**
 * Validates a single rule file's content against the vendoring checks
 * described in the module header.
 *
 * @param {object} opts
 * @param {string} opts.content - raw rule file content
 * @param {string} opts.relPath - path used in messages (e.g. 'rules/always-on/foo.md')
 * @param {string|null} [opts.targetRoot] - when provided, enables the
 *   zero-match-globs check against this repo's tracked files
 * @param {boolean} [opts.requireProvenance] - when true, enables the
 *   provenance-header check
 * @returns {{ ok: boolean, violations: RuleViolation[] }}
 */
export function validateRuleContent({ content, relPath, targetRoot = null, requireProvenance = false }) {
  /** @type {RuleViolation[]} */
  const violations = [];

  // ---- paths-frontmatter (error) ----
  const fm = extractFrontmatter(content);
  if (fm) {
    const pathsMatch = /^paths:/m.exec(fm.body);
    if (pathsMatch) {
      violations.push({
        rule: 'paths-frontmatter',
        severity: 'error',
        message:
          `${relPath}: frontmatter declares a top-level 'paths:' key, which rule-loader.mjs does not recognize — ` +
          `it is silently ignored and the rule loads as always-on instead of glob-scoped. Migrate to 'globs:'.`,
        line: lineWithinFrontmatter(fm.startLine, fm.body, pathsMatch.index),
      });
    }
  }

  // ---- provenance-header (error, opt-in) ----
  if (requireProvenance) {
    const firstLine = content.split('\n')[0] ?? '';
    if (!firstLine.startsWith(PLUGIN_HEADER_PREFIX)) {
      violations.push({
        rule: 'provenance-header',
        severity: 'error',
        message:
          `${relPath}: missing provenance header — the first line must start with ` +
          `${JSON.stringify(PLUGIN_HEADER_PREFIX)} (see rules-sync.mjs PLUGIN_HEADER_PREFIX). ` +
          `Without it, rules-sync.mjs mis-detects this file as a local override on the next re-sync ` +
          `and will never update it again.`,
        line: 1,
      });
    }
  }

  // ---- placeholder (error) — skip matches inside fenced code blocks ----
  const stripped = stripFencedCodeBlocks(content);
  const strippedLines = stripped.split('\n');

  const handlebarsLineIdx = strippedLines.findIndex((l) => PLACEHOLDER_HANDLEBARS_RE.test(l));
  if (handlebarsLineIdx !== -1) {
    violations.push({
      rule: 'placeholder',
      severity: 'error',
      message: `${relPath}: unfilled handlebars placeholder token (e.g. '{{PROJECT_NAME}}') found — fill in or remove before vendoring.`,
      line: handlebarsLineIdx + 1,
    });
  }

  const todoHeadingLineIdx = strippedLines.findIndex((l) => l.includes('## TODO: Customize'));
  if (todoHeadingLineIdx !== -1) {
    violations.push({
      rule: 'placeholder',
      severity: 'error',
      message: `${relPath}: unfilled '## TODO: Customize' heading found — this is skeleton content, not a finished rule.`,
      line: todoHeadingLineIdx + 1,
    });
  }

  const todoCommentLineIdx = strippedLines.findIndex((l) => l.includes('<!-- TODO:'));
  if (todoCommentLineIdx !== -1) {
    violations.push({
      rule: 'placeholder',
      severity: 'error',
      message: `${relPath}: unfilled '<!-- TODO:' comment found — this is skeleton content, not a finished rule.`,
      line: todoCommentLineIdx + 1,
    });
  }

  // ---- globs: derived checks (zero-match-globs, foreign-glob) ----
  let globs;
  try {
    ({ globs } = parseGlobsFrontmatter(content));
  } catch {
    // Malformed frontmatter — rule-loader.mjs itself falls back to
    // always-on in this case; the globs-derived checks simply don't apply.
    globs = null;
  }

  if (Array.isArray(globs) && globs.length > 0) {
    // foreign-glob (warn) — always evaluated when globs are present.
    for (const g of globs) {
      const segments = g.split('/');
      const foreignSegment = segments.find((seg) => FOREIGN_TOKEN_RE.test(seg));
      if (foreignSegment) {
        violations.push({
          rule: 'foreign-glob',
          severity: 'warn',
          message:
            `${relPath}: glob '${g}' contains a PascalCase, product-like token '${foreignSegment}' — ` +
            `this looks like it leaked from a specific product repo. Verify or generalize before vendoring.`,
        });
      }
    }

    // zero-match-globs (warn) — only when a target repo tree is available.
    if (targetRoot) {
      const fileList = getTargetFileList(targetRoot);
      for (const g of globs) {
        const hasMatch = fileList.some((f) => matchGlob(f, g));
        if (!hasMatch) {
          violations.push({
            rule: 'zero-match-globs',
            severity: 'warn',
            message:
              `${relPath}: glob '${g}' matches 0 files under ${targetRoot} — verify the pattern, ` +
              `or ignore if the target repo hasn't scaffolded this path yet.`,
          });
        }
      }
    }
  }

  const ok = violations.every((v) => v.severity !== 'error');
  return { ok, violations };
}

/**
 * Validates every `*.md` rule file under `dir`, recursively (skips dotfiles
 * and `_index.md`).
 *
 * @param {object} opts
 * @param {string} opts.dir - absolute path to a directory of rule files
 * @param {string|null} [opts.targetRoot] - forwarded to validateRuleContent
 * @param {boolean} [opts.requireProvenance] - forwarded to validateRuleContent
 * @returns {{ ok: boolean, files: Array<{ file: string, violations: RuleViolation[] }>, errorCount: number, warnCount: number }}
 */
export function validateRulesDir({ dir, targetRoot = null, requireProvenance = false }) {
  function collectRuleFiles(absDir) {
    const files = [];
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const absPath = join(absDir, entry.name);
      if (entry.isDirectory()) {
        files.push(...collectRuleFiles(absPath));
      } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== '_index.md') {
        files.push(relative(dir, absPath).replace(/\\/g, '/'));
      }
    }
    return files;
  }

  const entries = collectRuleFiles(dir).sort();

  const files = [];
  let errorCount = 0;
  let warnCount = 0;

  for (const name of entries) {
    const filePath = join(dir, name);
    const content = readFileSync(filePath, 'utf8');
    const { violations } = validateRuleContent({ content, relPath: name, targetRoot, requireProvenance });
    for (const v of violations) {
      if (v.severity === 'error') errorCount++;
      else if (v.severity === 'warn') warnCount++;
    }
    files.push({ file: name, violations });
  }

  return { ok: errorCount === 0, files, errorCount, warnCount };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] !== null &&
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(__filename);

/**
 * @param {{ ok: boolean, files: Array<{ file: string, violations: RuleViolation[] }>, errorCount: number, warnCount: number }} result
 * @param {string} dir
 * @returns {string}
 */
function formatSummary(result, dir) {
  const lines = [];
  lines.push(`validate-vendored-rules: scanned ${result.files.length} file(s) in ${dir}`);
  lines.push(`  errors: ${result.errorCount}  warnings: ${result.warnCount}`);
  for (const f of result.files) {
    if (f.violations.length === 0) continue;
    lines.push(`  ${f.file}:`);
    for (const v of f.violations) {
      const lineInfo = typeof v.line === 'number' ? ` (line ${v.line})` : '';
      lines.push(`    [${v.severity}] ${v.rule}${lineInfo}: ${v.message}`);
    }
  }
  if (result.errorCount === 0 && result.warnCount === 0) {
    lines.push('  (no violations found)');
  }
  return lines.join('\n');
}

if (isMain) {
  const args = process.argv.slice(2);

  function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 ? args[idx + 1] : undefined;
  }

  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(
      'Usage: validate-vendored-rules.mjs --dir <rulesDir> [--target-root <repo>] [--require-provenance] [--json] [--mode hard|warn]\n',
    );
    process.exit(0);
  }

  const dirArg = getArg('--dir');
  const targetRoot = getArg('--target-root') ?? null;
  const requireProvenance = args.includes('--require-provenance');
  const jsonOutput = args.includes('--json');
  const mode = getArg('--mode') ?? 'hard';

  if (!['hard', 'warn'].includes(mode)) {
    process.stderr.write(`validate-vendored-rules: error: invalid --mode '${mode}' (expected hard|warn)\n`);
    process.exit(2);
  }

  if (!dirArg) {
    process.stderr.write('validate-vendored-rules: error: --dir <path> is required\n');
    process.exit(2);
  }

  const dir = resolve(dirArg);

  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    process.stderr.write(`validate-vendored-rules: error: --dir does not exist or is not a directory: ${dir}\n`);
    process.exit(2);
  }

  let result;
  try {
    result = validateRulesDir({ dir, targetRoot, requireProvenance });
  } catch (err) {
    process.stderr.write(`validate-vendored-rules: error: failed to read --dir ${dir}: ${err.message}\n`);
    process.exit(2);
  }

  if (jsonOutput) {
    process.stdout.write(JSON.stringify({ mode, dir, targetRoot, requireProvenance, ...result }, null, 2) + '\n');
  } else {
    process.stdout.write(formatSummary(result, dir) + '\n');
  }

  const exitCode = result.errorCount > 0 && mode === 'hard' ? 1 : 0;
  process.exit(exitCode);
}
