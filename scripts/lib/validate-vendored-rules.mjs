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
import { join, resolve, relative, basename } from 'node:path';
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
// Vendoring sanitizer (issue #1098)
//
// Lives here rather than in rules-sync.mjs because it has this module's exact
// shape — "judge one rule file, return findings" — and because rules-sync.mjs
// already imports from here, so the move adds no import edge and no cycle.
// rules-sync.mjs re-exports `scanVendoringLeaks` for its existing importers.
// ---------------------------------------------------------------------------

/**
 * Path roots that exist in the PLUGIN repo but are not part of what a consumer
 * repo receives. A rule that cites `scripts/lib/foo.mjs` reads fine here and
 * dangles the moment the file is vendored.
 *
 * Deliberately a small, named list rather than "every top-level directory":
 * the detector below additionally requires the cited path to resolve to a real
 * FILE inside pluginRoot, which is what separates a plugin-internal citation
 * from a consumer-repo path that merely shares a prefix (`docs/api.md`,
 * `tests/` as a generic directory reference, `scripts/smoke-test.ts` in a code
 * sample). Revisit if the plugin grows another top-level source directory that
 * rules cite.
 */
const REPO_LOCAL_PATH_ROOTS = ['scripts', 'hooks', 'skills', 'docs', 'tests'];

// Leading boundary excludes `react-hooks/exhaustive-deps` and
// `templates/shared/hooks/x.sh` — a root only counts at a token boundary.
const REPO_LOCAL_PATH_RE = new RegExp(
  `(?<![\\w./-])((?:${REPO_LOCAL_PATH_ROOTS.join('|')})/[\\w./-]*\\w)`,
  'g',
);

const MD_REFERENCE_RE = /[\w][\w.-]*\.md/g;

/**
 * `*.md` names a `## See Also` section may legitimately cite even though
 * `rules/_index.md` does not register them: they are project-root instruction
 * files every consumer repo has, not rules that travel through the sync.
 */
const NON_RULE_MD_REFERENCES = new Set(['CLAUDE.md', 'AGENTS.md', 'README.md']);

/**
 * 1-based line number of `index` within `content`.
 * @param {string} content
 * @param {number} index
 * @returns {number}
 */
function lineOf(content, index) {
  return content.slice(0, index).split('\n').length;
}

/**
 * Extracts the body of the trailing `## See Also` section, with the offset at
 * which it starts. Returns null when the file has no such section.
 * @param {string} content
 * @returns {{ body: string, offset: number } | null}
 */
function extractSeeAlso(content) {
  const m = /^##\s+See Also\s*$/m.exec(content);
  if (!m) return null;
  const start = m.index + m[0].length;
  const next = /^##\s+/m.exec(content.slice(start));
  const end = next !== null ? start + next.index : content.length;
  return { body: content.slice(start, end), offset: start };
}

/**
 * True when `token` (a repo-relative path taken from rule prose) stays inside
 * `pluginRoot` once resolved. `REPO_LOCAL_PATH_RE`'s character class admits
 * `..`, so `scripts/../../../../etc/passwd` reaches this function; without the
 * containment check its `statSync` would walk outside the plugin root and
 * report a host file as a vendoring leak. Same shape as
 * `git-config-drift.mjs`'s `hooksPathIsTracked` containment guard.
 * @param {string} pluginRoot
 * @param {string} token
 * @returns {boolean}
 */
function tokenStaysInside(pluginRoot, token) {
  const abs = resolve(pluginRoot, token);
  const rel = relative(resolve(pluginRoot), abs);
  return rel !== '' && !rel.startsWith('..') && !/^([a-zA-Z]:)?[\\/]/.test(rel);
}

/**
 * Report-only vendoring sanitizer (issue #1098).
 *
 * Scans one rule file for the two ways a rule that reads correctly INSIDE this
 * plugin repo breaks once it is vendored into a consumer repo:
 *
 *   - `repo-local-path` — a `scripts/…`, `hooks/…`, `skills/…`, `docs/…` or
 *     `tests/…` citation that resolves to a real file under `pluginRoot`. The
 *     consumer has no such file, so the citation dangles.
 *   - `unresolvable-see-also` — a `## See Also` entry naming a `*.md` rule that
 *     `rules/_index.md` does not register, so it is never vendored alongside.
 *
 * **This function never rewrites content.** Silent stripping would change the
 * meaning of a rule at vendoring time, invisibly to both the author and the
 * consumer; the finding is reported and a human decides. `@your-org/*`
 * placeholders are deliberately NOT flagged — they are the documented
 * placeholder convention for consumer-supplied package scopes, not a leak.
 *
 * @param {object} opts
 * @param {string} opts.content - raw rule file content (never modified)
 * @param {string} opts.relPath - manifest-relative path, used as `file`
 * @param {string} opts.pluginRoot - repo root the repo-local check resolves against
 * @param {Set<string>|null} [opts.manifestBasenames] - basenames registered in
 *   `rules/_index.md`; when null the `unresolvable-see-also` check is skipped
 * @returns {Array<{file: string, line: number, kind: 'repo-local-path'|'unresolvable-see-also', text: string}>}
 */
export function scanVendoringLeaks({ content, relPath, pluginRoot, manifestBasenames = null }) {
  const findings = [];

  REPO_LOCAL_PATH_RE.lastIndex = 0;
  const seenPaths = new Set();
  let m;
  while ((m = REPO_LOCAL_PATH_RE.exec(content)) !== null) {
    const token = m[1];
    if (seenPaths.has(token)) continue;
    let isFile;
    try {
      // Containment first: never stat a path that escapes pluginRoot.
      if (!tokenStaysInside(pluginRoot, token)) continue;
      const abs = join(pluginRoot, token);
      isFile = existsSync(abs) && statSync(abs).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) continue;
    seenPaths.add(token);
    findings.push({
      file: relPath,
      line: lineOf(content, m.index),
      kind: 'repo-local-path',
      text: token,
    });
  }

  if (manifestBasenames) {
    const seeAlso = extractSeeAlso(content);
    if (seeAlso) {
      const ownBasename = basename(relPath);
      const seenRefs = new Set();
      MD_REFERENCE_RE.lastIndex = 0;
      let r;
      while ((r = MD_REFERENCE_RE.exec(seeAlso.body)) !== null) {
        const ref = r[0];
        const refBase = basename(ref);
        if (refBase === ownBasename || seenRefs.has(refBase)) continue;
        if (NON_RULE_MD_REFERENCES.has(refBase)) continue;
        if (manifestBasenames.has(refBase)) continue;
        seenRefs.add(refBase);
        findings.push({
          file: relPath,
          line: lineOf(content, seeAlso.offset + r.index),
          kind: 'unresolvable-see-also',
          text: ref,
        });
      }
    }
  }

  return findings;
}

/**
 * Reads `<pluginRoot>/rules/_index.md` and returns the set of rule basenames it
 * registers, for `scanVendoringLeaks()`'s `unresolvable-see-also` check.
 * Returns `null` when the manifest is absent or unreadable — the caller then
 * skips that check rather than reporting every See-Also entry as a leak.
 *
 * The bullet shape is the one `rules-sync.mjs`'s `parseIndex()` parses; it is
 * matched here with a local regex rather than imported, because `rules-sync.mjs`
 * imports from THIS module and an import back would create a module-load cycle
 * (same reasoning as the `PLUGIN_HEADER_PREFIX` copy above).
 *
 * @param {string} pluginRoot
 * @returns {Set<string>|null}
 */
export function readManifestBasenames(pluginRoot) {
  const indexPath = join(pluginRoot, 'rules', '_index.md');
  let indexContent;
  try {
    indexContent = readFileSync(indexPath, 'utf8');
  } catch {
    return null;
  }
  const names = new Set();
  const bulletRe = /^-\s+`([^`]+\.md)`/gm;
  let m;
  while ((m = bulletRe.exec(indexContent)) !== null) {
    names.add(basename(m[1]));
  }
  return names;
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
        // NOTE (#795 / corrected 2026-07-25): the previous wording claimed rule-loader.mjs
        // does not recognize `paths:` and that such a rule loads always-on. Both are false
        // since #795 — `rule-loader.mjs:275` accepts `paths` alongside `globs`, and `:313`
        // treats it as a fallback alias (`globs:` wins silently when both are present), so a
        // `paths:`-only rule IS glob-scoped. The probe itself stays: it enforces the canonical
        // vendoring form, which is a convention gate, not a loader-compatibility gate. That
        // intent survives #795 and is the subject of the #742 fleet canonicalisation sweep.
        message:
          `${relPath}: frontmatter declares a top-level 'paths:' key. It is a recognized alias ` +
          `for 'globs:' (issue #795), so the rule does load glob-scoped — but 'globs:' is the ` +
          `canonical form for vendored rules. Migrate to 'globs:' (see issue #742).`,
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
 * When `pluginRoot` is given, every scanned file is additionally passed through
 * `scanVendoringLeaks()` and the findings are collected into the additive
 * `sanitizer[]` array (issue #1098). Report-only, exactly as in `syncRules()`:
 * a finding contributes to neither `errorCount` nor `warnCount`, so it can
 * never change this function's `ok` verdict or its CLI's exit code.
 *
 * @param {object} opts
 * @param {string} opts.dir - absolute path to a directory of rule files
 * @param {string|null} [opts.targetRoot] - forwarded to validateRuleContent
 * @param {boolean} [opts.requireProvenance] - forwarded to validateRuleContent
 * @param {string|null} [opts.pluginRoot] - when provided, enables the vendoring
 *   sanitizer scan against this plugin root
 * @returns {{ ok: boolean, files: Array<{ file: string, violations: RuleViolation[] }>, errorCount: number, warnCount: number, sanitizer: Array<{file: string, line: number, kind: string, text: string}> }}
 */
export function validateRulesDir({ dir, targetRoot = null, requireProvenance = false, pluginRoot = null }) {
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
  const sanitizer = [];
  let errorCount = 0;
  let warnCount = 0;

  const manifestBasenames = pluginRoot ? readManifestBasenames(pluginRoot) : null;

  for (const name of entries) {
    const filePath = join(dir, name);
    const content = readFileSync(filePath, 'utf8');
    const { violations } = validateRuleContent({ content, relPath: name, targetRoot, requireProvenance });
    for (const v of violations) {
      if (v.severity === 'error') errorCount++;
      else if (v.severity === 'warn') warnCount++;
    }
    files.push({ file: name, violations });

    if (pluginRoot) {
      sanitizer.push(
        ...scanVendoringLeaks({ content, relPath: name, pluginRoot, manifestBasenames }),
      );
    }
  }

  return { ok: errorCount === 0, files, errorCount, warnCount, sanitizer };
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
      'Usage: validate-vendored-rules.mjs --dir <rulesDir> [--target-root <repo>] [--plugin-root <dir>] [--require-provenance] [--json] [--mode hard|warn]\n',
    );
    process.exit(0);
  }

  const dirArg = getArg('--dir');
  const targetRoot = getArg('--target-root') ?? null;
  // Enables the report-only vendoring sanitizer (#1098). Never affects the
  // exit code — findings are surfaced, the operator decides.
  const pluginRootArg = getArg('--plugin-root');
  const pluginRoot = pluginRootArg ? resolve(pluginRootArg) : null;
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
    result = validateRulesDir({ dir, targetRoot, requireProvenance, pluginRoot });
  } catch (err) {
    process.stderr.write(`validate-vendored-rules: error: failed to read --dir ${dir}: ${err.message}\n`);
    process.exit(2);
  }

  if (jsonOutput) {
    process.stdout.write(
      JSON.stringify({ mode, dir, targetRoot, pluginRoot, requireProvenance, ...result }, null, 2) + '\n',
    );
  } else {
    process.stdout.write(formatSummary(result, dir) + '\n');
    for (const f of result.sanitizer) {
      process.stderr.write(
        `validate-vendored-rules: sanitizer ${f.kind} ${f.file}:${f.line} — ${f.text}\n`,
      );
    }
  }

  const exitCode = result.errorCount > 0 && mode === 'hard' ? 1 : 0;
  process.exit(exitCode);
}
