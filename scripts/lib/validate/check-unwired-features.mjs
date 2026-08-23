#!/usr/bin/env node
/**
 * check-unwired-features.mjs — census of DECLARED-BUT-UNREAD Session Config keys.
 *
 * ## The defect class
 *
 * This repo's recurring systemic failure is not a broken feature — it is a
 * feature that was built, documented, schema-validated and tested, and then
 * never switched on. One 2026-08-08 analysis found three independent instances:
 * `efficiency.output-level` (10 test files, 0 runtime consumers, ~15 months
 * dead), `issue-budget` (complete with a PreToolUse hook and an overflow
 * collector, never entered in the live Session Config), and
 * `compact-nudge` / `goal-integration` (0 `.mjs` read sites — schema + prose
 * only). Prose cannot catch this class; every one of those keys was documented
 * exactly as prescribed. A mechanical census can.
 *
 * ## What this check owns — and what it deliberately does NOT
 *
 * The declared config surface has THREE faces, and only one of the three edges
 * between them was previously guarded:
 *
 *   template  ↔  live Session Config   → owned by `claude-md-drift-check`
 *                                        Check 6 (`session-config-parity`).
 *                                        NOT duplicated here.
 *   template  ↔  code   ┐
 *   live cfg  ↔  code   ┘               → owned by THIS check.
 *
 * So: a key that appears in `docs/session-config-template.md` and/or in the
 * live `## Session Config` block, but that NO `.mjs` under `scripts/` or
 * `hooks/` ever reads, is reported here. That is the `compact-nudge` class.
 *
 * ## Two signals, because a mention is not a read
 *
 *   S1 `unwired-config-key`       — zero non-comment mentions in the consumer
 *                                   corpus. The blunt case.
 *   S2 `parser-orphan-config-key` — the key IS mentioned, but no file in the
 *                                   config-parser layer (`PARSER_PATHS`) knows
 *                                   it, so nothing turns the YAML into a value.
 *
 * S2 exists because S1 alone is fooled by a mention that reads nothing.
 * `express-path.enabled` passes S1 on the strength of ONE line —
 * `scripts/lib/state-md/body-sections.mjs:699`, a log-message template literal
 * that interpolates a value its caller already had. No parser resolves
 * `express-path` from config at all; the gate lives entirely in
 * `skills/session-start/phase-8-5-express-path.md` prose. S1 called that wired;
 * S2 calls it what it is.
 *
 * S2 applies to TOP-LEVEL keys only — a nested key reaches code through its
 * parent — and its premise is structural: every Session Config key has to pass
 * through the parser layer to become a value. Measured 2026-08-08: 84 of 89
 * top-level keys satisfy it, so the 5 that do not are signal, not noise.
 *
 * ## S3 `orphaned-prose-module` — the same disease, one level out
 *
 * A config key is not the only thing prose can promise. A DOCUMENT can also
 * assert that a module does a job that nothing calls. S3 reports a module under
 * `scripts/`/`hooks/` that satisfies ALL of:
 *
 *   1. its basename is named in tracked, non-historical prose,
 *   2. NO other production module references that basename on a non-comment line,
 *   3. it is not a CLI entrypoint (no shebang, no main-guard),
 *   4. it exports at least one named symbol, and
 *   5. the prose naming it names NONE of those exported symbols.
 *
 * Condition 5 is the discriminator, and it is a claim about GRAMMAR. "dispatch
 * via `runWavePool()`" names a symbol: it is an INSTRUCTION addressed to a reader
 * who will execute it, which is legitimate prose-wiring. "transitions **are
 * validated** against `foo.mjs`" names only the file, in the passive voice: it
 * ASSERTS that something happens by itself. Nobody is addressed, so nobody does
 * it. Passive + bare filename + zero symbols is the signature of a dead promise.
 *
 * ### Why this is a narrow rule and not an export census
 *
 * The obvious broader check — "report every export with no non-test importer" —
 * was measured on 2026-08-14 and is NOT buildable: 1366 exports, 779 without a
 * non-test importer, a false-positive rate of 93.2% naive and still 81.2% after
 * four exclusion rules. A gate that prints 282 lines gets switched off in week
 * two, which is this file's own disease one level up. S3 trades that recall for
 * precision: it only fires where prose made a CLAIM, so every hit has a document
 * to correct.
 *
 * ### Honest limitation: the population is tiny, by construction
 *
 * The measured cascade on 2026-08-14 was 452 production modules → 329 named in
 * prose → 95 with no production reference → 57 non-entrypoint → 56 with a named
 * export → **2**. Do not read a near-empty report as a broken check: S3 is a
 * RELAPSE GUARD, not a cleanup tool. Its value is catching the NEXT false
 * promise on the day it is written, not finding mass today.
 *
 * ### Two false-positive classes this rule was calibrated against
 *
 * Both were live hits in the first draft, and both are now excluded by
 * construction — reintroducing either would be a regression:
 *
 *  - **Dynamic-import consumers.** `scripts/lib/skill-health/join.mjs` looks
 *    orphaned to any `from '…join.mjs'` regex: `harness-audit/categories/
 *    category9.mjs` resolves it via `new URL('../../skill-health/join.mjs',
 *    import.meta.url)` and imports the resulting VARIABLE inside a generated
 *    child-process source string. Condition 2 therefore counts any non-comment
 *    mention of the basename as a reference, not just a static import specifier.
 *  - **Re-export shims.** `scripts/lib/autopilot-telemetry.mjs` is
 *    `export * from './autopilot/telemetry.mjs'` — zero NAMED exports, so
 *    condition 5 ("prose names none of its exports") is vacuously true and the
 *    module is reported for having no symbols to name. Condition 4 excludes it.
 *
 * `CHANGELOG.md` is excluded from the prose corpus for the same reason: it is an
 * append-only record of what a PAST release shipped, so it names the symbols of
 * code that may since have died. Counting it silenced a true positive
 * (`soul-resolve.mjs`, whose only live claim is in `.claude/rules/owner-persona.md`
 * but whose symbols appear in a 2026-06 changelog entry).
 *
 * ## S4 `unreachable-library-module` — the question the machine can answer
 *
 * S3 asks a document a question about GRAMMAR and accepts "the prose names an
 * exported symbol" as wiring. That is generous by design, and it is where the
 * largest instance of this defect class hid: `skills/session-start/SKILL.md`
 * Phase 4 named 19 banner probes and their symbols, so S3 read every one of them
 * as wired — while no hook, npm script, CI job or husky stage reached a single
 * one. S1/S2 could not see them either, being config-key checks.
 *
 * S4 drops the grammar question and asks a reachability one: can any process
 * that ACTUALLY STARTS arrive at this file? See `collectUnreachableLibraryModules`
 * for the four conditions, the deliberate CLI-entrypoint boundary (with the
 * measured cost of the alternative), the cluster-root collapse, and the named
 * residuals. S4 does not subsume S3 and is not subsumed by it: S3 catches a
 * REACHABLE module whose document lies about it, S4 catches an unreachable one
 * whose document is honest about what it should do.
 *
 * Output shape is deliberately different from S1-S3 too. Those report a handful
 * of lines; S4 measured 51 on the live tree of 2026-08-23, which is a BACKLOG.
 * The CLI therefore prints one aggregate WARN carrying the count, and the full
 * census behind `--list` — see `runCheckUnwiredFeatures`. The `findings` array
 * always carries every finding, so no programmatic consumer loses data.
 *
 * ## Consumer scope, and why "prose-only" is a finding rather than an error
 *
 * Read sites are counted in `scripts/**` and `hooks/**` (`.mjs`/`.js`/`.cjs`),
 * with every `tests/` path excluded — a key read only by its own tests is
 * exactly the dead surface this check hunts.
 *
 * Skill bodies are NOT consumers for this purpose. A key consumed only by
 * markdown prose is real (an LLM reads the instruction), but it is a WEAKER
 * wiring than code: nothing fails when the prose is reworded or the skill is
 * retired. Those keys are legitimate — they belong on the allowlist below with
 * their prose consumer named, which turns an invisible assumption into a
 * reviewable line.
 *
 * ## Allowlisting (how, and the standing requirement)
 *
 * Add an entry to `ALLOWLIST` keyed by the FULL dotted key path, whose value is
 * a non-empty reason naming the actual consumer:
 *
 *     'auto-skill-dispatch': 'prose-only consumer: skills/using-orchestrator/SKILL.md',
 *
 * Every entry needs a reason — an empty or whitespace-only one is itself
 * reported (`allowlist-missing-reason`), so the escape hatch cannot be used to
 * silence a key without saying why. The list also drains itself: an entry is
 * reported as `allowlist-stale` both when its key has left every config surface
 * AND when the key stops triggering a finding (i.e. it finally got wired), so a
 * fixed key does not leave a permanent exemption behind.
 *
 * ## Mode: WARN, not blocking (v1)
 *
 * Findings never fail the process; exit is 0 whenever the scan completed
 * (2 only on a filesystem/tool error). This is deliberate. The repo currently
 * ships 14 of 27 Session Config switches set to `false`; a blocking gate on
 * that inventory would be red from day one, and a gate that is red on day one
 * gets disabled — which is the same disease this file exists to treat, one
 * level up. Warn first, ratchet later once the census is at zero.
 *
 * ## Named residuals (so nobody over-reads the coverage claim)
 *
 *  - **Token-level, not dataflow.** A key whose value is parsed and then never
 *    consumed downstream reads as WIRED here. `efficiency.output-level` is that
 *    shape (parsed by `scripts/lib/owner-yaml.mjs`, consumed by nothing) and
 *    would NOT be caught — nor is it in scope, being an `owner.yaml` key rather
 *    than a Session Config one. Catching it needs an import/dataflow graph.
 *  - **Unused `export`s under `scripts/lib/` are NOT censused here.** A naive
 *    token census of that second axis produced 441 candidates over 356 files on
 *    2026-08-08, with false positives in the first screenful (`validateAgentOutput`
 *    among them) — a list that size is switched off, not acted on. That axis
 *    needs a real import graph; `knip` is not a dependency of this repo
 *    (`grep -n knip package.json` → no match) and adopting it is issue #977.
 *  - **A comment mention counts as a non-read.** Matches are tallied per line;
 *    a key named only in comments is reported, with the comment count attached.
 *  - Files are read with `readFileSync`, never a `grep` spawn: one NUL byte
 *    makes a text file invisible to grep-based audits (see
 *    `.claude/rules/anti-pattern-a-nul-byte-in-a-tracked-production-file-...md`),
 *    which would silently drop a consumer and manufacture a false positive.
 *
 * Import-safety: importing this module exposes the collector and runner only;
 * the CLI path is guarded at the bottom of the file.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Documented config surface — every `yaml` fence in this file is a declaration. */
const TEMPLATE_REL = 'docs/session-config-template.md';

/** Live config surface. First existing file wins (CLAUDE.md beats AGENTS.md). */
const INSTRUCTION_FILES = Object.freeze(['CLAUDE.md', 'AGENTS.md']);

/** Directories whose code counts as a runtime consumer. */
const CONSUMER_DIRS = Object.freeze(['scripts', 'hooks']);

/** Extensions that can hold a runtime read site. */
const CODE_EXTENSIONS = Object.freeze(['.mjs', '.js', '.cjs']);

/** Directory names excluded from the consumer scan at any depth. */
const EXCLUDED_DIRS = Object.freeze(['node_modules', '.git', 'tests', 'test', '__tests__']);

/** Extension carrying prose claims (signal S3). */
const PROSE_EXTENSIONS = Object.freeze(['.md']);

/**
 * Additionally excluded from the S3 PROSE corpus. `.orchestrator/` is generated
 * telemetry and audit output — machine-written, so it asserts nothing.
 */
const PROSE_EXCLUDED_DIRS = Object.freeze([...EXCLUDED_DIRS, '.orchestrator']);

/**
 * Prose files excluded by basename.
 *
 * `CHANGELOG.md` is a HISTORICAL record: it describes what a past release
 * shipped, so it keeps naming symbols of code that has since been deleted. See
 * the header for the true positive this masked.
 *
 * `STATE.md` is per-session MUTABLE state, not documentation. A module named in
 * a wave plan is not a durable promise, and counting it would make this check's
 * output depend on whichever session happens to be open — a repo-wide census
 * must not change because a task description mentioned a filename.
 */
const PROSE_EXCLUDED_FILES = Object.freeze(['CHANGELOG.md', 'STATE.md']);

/**
 * This file excludes ITSELF from the consumer corpus. Load-bearing: every
 * `ALLOWLIST` key is a string literal here, so without the exclusion each
 * allowlist entry becomes its own read site and the check reports the key as
 * wired — silently blinding itself to exactly the keys an operator flagged as
 * needing review. (Observed on first run: 2 allowlisted keys reported as 0.)
 */
const SELF_REL = path.join('scripts', 'lib', 'validate', 'check-unwired-features.mjs');

/**
 * Signal S4 entry surfaces: the NON-markdown files that mechanically invoke a
 * module by path. Markdown is deliberately absent — that a SKILL.md names a
 * module is precisely the claim S4 refuses to accept as wiring.
 */
const WIRING_FILES = Object.freeze(['package.json', '.gitlab-ci.yml']);

/** Directory surfaces for S4, as `[dir, extensions]`. `''` catches husky's extensionless stages. */
const WIRING_DIRS = Object.freeze([
  ['.github', Object.freeze(['.yml', '.yaml'])],
  ['.husky', Object.freeze(['', '.sh'])],
  ['hooks', Object.freeze(['.json', '.sh'])],
]);

/**
 * The config-parser layer: the files a Session Config key must pass through to
 * become a runtime value. Signal S2 (see header) checks top-level keys against
 * this subset. Directories are walked; plain files are taken as-is.
 */
const PARSER_PATHS = Object.freeze([
  path.join('scripts', 'lib', 'config'),
  path.join('scripts', 'lib', 'config.mjs'),
  path.join('scripts', 'lib', 'config-schema.mjs'),
  path.join('scripts', 'parse-config.mjs'),
]);

/**
 * Declared-but-unread keys accepted on purpose. Key = full dotted path,
 * value = REASON naming the real consumer. See the header for the contract:
 * an empty reason, a key that left every config surface, and a key that got
 * wired are all reported so the list stays short and true.
 */
const ALLOWLIST = Object.freeze({
  'auto-skill-dispatch':
    'prose-only consumer — skills/using-orchestrator/SKILL.md + skills/_shared/bootstrap-gate.md read this key as an LLM instruction; there is no .mjs gate by design',
  'auto-commit-per-wave':
    'prose-only consumer — skills/wave-executor/wave-loop.md gates the per-wave commit step on this key; the commit itself is a coordinator action, not a script',
  'instruction-budget':
    'dedicated reader outside the parser layer — scripts/lib/instruction-budget-guard.mjs parses this block itself (S2 exemption only; S1 evidence is real)',
  webhooks:
    'dedicated reader outside the parser layer — scripts/lib/webhook-url.mjs resolves these URLs env-first (S2 exemption only; S1 evidence is real)',
});

/**
 * @typedef {{
 *   key: string,
 *   leaf: string,
 *   root: string,
 *   sources: string[],
 * }} DeclaredKey
 */

/**
 * @typedef {{
 *   kind: 'unwired-config-key' | 'parser-orphan-config-key' | 'allowlist-missing-reason'
 *       | 'allowlist-stale' | 'orphaned-prose-module' | 'unreachable-library-module'
 *       | 'tool-error',
 *   key: string,
 *   message: string,
 * }} Finding
 */

/**
 * Recursively collect files, skipping symlinks and excluded directories.
 *
 * @param {string} directory absolute directory path
 * @param {string[]} [acc]
 * @param {readonly string[]} [extensions] extensions to keep
 * @param {readonly string[]} [excludedDirs] directory names pruned at any depth
 * @returns {string[]} absolute file paths
 */
function walkCode(directory, acc = [], extensions = CODE_EXTENSIONS, excludedDirs = EXCLUDED_DIRS) {
  if (!existsSync(directory)) return acc;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    if (excludedDirs.includes(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) walkCode(fullPath, acc, extensions, excludedDirs);
    else if (entry.isFile() && extensions.includes(path.extname(entry.name))) acc.push(fullPath);
  }
  return acc;
}

/**
 * Extract dotted key paths from YAML-ish lines.
 *
 * Indentation drives nesting; a `- ` list-item prefix is treated as one extra
 * level so `custom-phases: [- name: …]` yields `custom-phases.name`. Comment
 * lines and inline `# …` trailers are stripped first, so a commented-out key
 * (e.g. the deliberately-disabled `# bash-write-guard: true`) is NOT counted as
 * declared — commenting a key out IS the documented way to leave it unset.
 *
 * @param {string[]} lines raw YAML lines
 * @param {(key: string, leaf: string, rootKey: string) => void} emit
 * @returns {void}
 */
function extractKeyLines(lines, emit) {
  /** @type {{name: string, indent: number}[]} */
  const stack = [];
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const withoutComment = raw.replace(/\s+#.*$/, '');
    let indent = (withoutComment.match(/^(\s*)/) ?? ['', ''])[1].length;
    let body = withoutComment.trim();
    if (body.startsWith('- ')) {
      body = body.slice(2).trim();
      indent += 2;
    }
    const matched = body.match(/^([A-Za-z0-9_.-]+):(?:\s.*)?$/);
    if (!matched) continue;
    const name = matched[1];
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parents = stack.map((frame) => frame.name);
    emit([...parents, name].join('.'), name, parents[0] ?? name);
    stack.push({ name, indent });
  }
}

/**
 * Collect every key declared in the template's ```yaml fences and in the live
 * `## Session Config` block(s) of the instruction file.
 *
 * The live-config scan runs to the next `## ` heading at column 0, so the
 * parity-exempt `## Skill Evolution` / `## Dispatcher Autonomy` blocks are
 * picked up as their own declaration sources rather than silently skipped —
 * their keys are just as capable of going unread.
 *
 * @param {string} pluginRoot absolute plugin root
 * @returns {{keys: Map<string, DeclaredKey>, sourcesScanned: string[]}}
 */
export function collectDeclaredKeys(pluginRoot) {
  /** @type {Map<string, DeclaredKey>} */
  const keys = new Map();
  /** @type {string[]} */
  const sourcesScanned = [];

  /** @type {(source: string) => (key: string, leaf: string, rootKey: string) => void} */
  const emitter = (source) => (key, leaf, rootKey) => {
    const existing = keys.get(key);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      return;
    }
    keys.set(key, { key, leaf, root: rootKey, sources: [source] });
  };

  const templatePath = path.join(pluginRoot, TEMPLATE_REL);
  if (existsSync(templatePath)) {
    sourcesScanned.push(TEMPLATE_REL);
    const emit = emitter(TEMPLATE_REL);
    let inYamlFence = false;
    /** @type {string[]} */
    let fence = [];
    for (const raw of readFileSync(templatePath, 'utf8').split('\n')) {
      if (raw.trim().startsWith('```')) {
        if (inYamlFence) extractKeyLines(fence, emit);
        inYamlFence = raw.trim().startsWith('```yaml');
        fence = [];
        continue;
      }
      if (inYamlFence) fence.push(raw);
    }
    if (inYamlFence) extractKeyLines(fence, emit);
  }

  for (const candidate of INSTRUCTION_FILES) {
    const instructionPath = path.join(pluginRoot, candidate);
    if (!existsSync(instructionPath)) continue;
    sourcesScanned.push(candidate);
    const emit = emitter(candidate);
    const lines = readFileSync(instructionPath, 'utf8').split('\n');
    let inConfigBlock = false;
    /** @type {string[]} */
    let block = [];
    for (const raw of lines) {
      if (/^## /.test(raw)) {
        if (inConfigBlock) extractKeyLines(block, emit);
        block = [];
        inConfigBlock = /^## (Session Config|Skill Evolution|Dispatcher Autonomy)\b/.test(raw);
        continue;
      }
      // `>` blockquote prose inside a config block carries no declarations.
      if (inConfigBlock && !raw.trim().startsWith('>')) block.push(raw);
    }
    if (inConfigBlock) extractKeyLines(block, emit);
    break; // CLAUDE.md wins ties (skills/_shared/instruction-file-resolution.md)
  }

  return { keys, sourcesScanned };
}

/**
 * Build a word-boundary matcher for a config-key token.
 *
 * `-` is part of the boundary class so `mode` does not match `mode-x`, and
 * `$` so `enabled` does not match `isEnabled$`.
 *
 * @param {string} token
 * @returns {RegExp}
 */
function tokenMatcher(token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_$-])${escaped}(?![A-Za-z0-9_$-])`);
}

/** @param {string} line @returns {boolean} whether the line is comment-only */
function isCommentLine(line) {
  const trimmed = line.trim();
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('#')
  );
}

/**
 * Count read sites for one declared key across the consumer corpus.
 *
 * Matching is on the LEAF token, because a nested key is read as
 * `cfg['memory']?.banner?.enabled` — the dotted path never appears verbatim.
 * That alone would make a generic leaf (`enabled`, `mode`, `url`) match
 * everywhere, so a nested key with a NON-DISTINCTIVE leaf (no hyphen — i.e. a
 * token that could be a plain JS identifier) additionally requires its
 * top-level ancestor token in the SAME file.
 *
 * A hyphenated leaf is exempt from that ancestor requirement on purpose:
 * `enforcement-gates.path-guard` is read in `hooks/enforce-scope.mjs` as
 * `scope.gates?.['path-guard']`, a file that never names `enforcement-gates`.
 * Requiring the ancestor there produced a false positive on a genuinely-wired
 * gate — and false positives are what get this check switched off.
 *
 * @param {DeclaredKey} declared
 * @param {{relative: string, lines: string[], body: string}[]} corpus
 * @returns {{code: number, comment: number, files: string[]}}
 */
export function countReadSites(declared, corpus) {
  const leafRe = tokenMatcher(declared.leaf);
  const rootRe = tokenMatcher(declared.root);
  const scopedByAncestor = declared.key !== declared.leaf && !declared.leaf.includes('-');
  let code = 0;
  let comment = 0;
  /** @type {string[]} */
  const files = [];

  for (const file of corpus) {
    if (scopedByAncestor && !rootRe.test(file.body)) continue;
    if (!leafRe.test(file.body)) continue;
    let codeInFile = 0;
    for (const line of file.lines) {
      if (!leafRe.test(line)) continue;
      if (isCommentLine(line)) comment += 1;
      else codeInFile += 1;
    }
    if (codeInFile > 0) files.push(file.relative);
    code += codeInFile;
  }

  return { code, comment, files };
}

/**
 * Extract the NAMED symbols a module exports.
 *
 * Deliberately named-only: `export * from './x.mjs'` yields nothing, which is
 * what marks a re-export shim as unjudgeable by S3 (see header, FP class 2).
 *
 * @param {string} body module source
 * @returns {string[]} exported symbol names
 */
export function collectExportedSymbols(body) {
  /** @type {Set<string>} */
  const names = new Set();
  const declaration = /^export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z0-9_$]+)/gm;
  for (const match of body.matchAll(declaration)) names.add(match[1]);
  for (const match of body.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const clause of match[1].split(',')) {
      const name = clause.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && /^[A-Za-z0-9_$]+$/.test(name)) names.add(name);
    }
  }
  return [...names];
}

/**
 * Whether a module is a CLI entrypoint rather than a library.
 *
 * An entrypoint is invoked by path (npm script, hook wiring, CI job), so having
 * no importer is its normal state and says nothing about being wired.
 *
 * @param {string} body module source
 * @returns {boolean}
 */
export function isCliEntrypoint(body) {
  return (
    body.startsWith('#!') ||
    /import\.meta\.url\s*===|require\.main\s*===\s*module|process\.argv\[1\]/.test(body)
  );
}

/**
 * Signal S3 — modules a document promises but nothing calls.
 *
 * See the header for the five conditions, the grammar discriminator, and the two
 * false-positive classes this is calibrated against. Condition 2 counts ANY
 * non-comment mention of the basename as a reference (not just a static import
 * specifier) because a real consumer can reach a module through
 * `new URL(…, import.meta.url)` + dynamic `import()`.
 *
 * @param {string} pluginRoot absolute plugin root
 * @returns {{findings: Finding[], scanned: {modules: number, prose: number}}}
 */
export function collectOrphanedProseModules(pluginRoot) {
  /** @type {Finding[]} */
  const findings = [];

  const modules = CONSUMER_DIRS.flatMap((dir) => walkCode(path.join(pluginRoot, dir)))
    .sort()
    .map((absolute) => {
      const body = readFileSync(absolute, 'utf8');
      return {
        relative: path.relative(pluginRoot, absolute),
        base: path.basename(absolute),
        body,
        lines: body.split('\n'),
      };
    });

  const prose = walkCode(pluginRoot, [], PROSE_EXTENSIONS, PROSE_EXCLUDED_DIRS)
    .filter((absolute) => !PROSE_EXCLUDED_FILES.includes(path.basename(absolute)))
    .sort()
    .map((absolute) => ({
      relative: path.relative(pluginRoot, absolute),
      body: readFileSync(absolute, 'utf8'),
    }));

  for (const module of modules) {
    // (1) named by a live document
    const claims = prose.filter((doc) => doc.body.includes(module.base));
    if (claims.length === 0) continue;

    // (2) no production module references it outside a comment
    const referenced = modules.some(
      (other) =>
        other.relative !== module.relative &&
        other.lines.some((line) => line.includes(module.base) && !isCommentLine(line)),
    );
    if (referenced) continue;

    // (3) not invoked by path
    if (isCliEntrypoint(module.body)) continue;

    // (4) has symbols the prose could have named
    const symbols = collectExportedSymbols(module.body);
    if (symbols.length === 0) continue;

    // (5) the prose names none of them → nobody is addressed, so nobody acts
    const naming = claims.filter((doc) => symbols.some((symbol) => tokenMatcher(symbol).test(doc.body)));
    if (naming.length > 0) continue;

    findings.push({
      kind: 'orphaned-prose-module',
      key: module.relative,
      message:
        `named in ${claims.map((doc) => doc.relative).join(' + ')} but no .mjs under ` +
        `${CONSUMER_DIRS.join('/ or ')}/ references it, and that prose names none of its ` +
        `export(s) (${symbols.join(', ')}) — the document promises behaviour nothing performs; ` +
        'wire it, delete it, or reword the prose to describe what actually happens',
    });
  }

  return { findings, scanned: { modules: modules.length, prose: prose.length } };
}

/**
 * Extract every module-filename token a body mentions, ignoring comment lines.
 *
 * Token extraction beats a substring scan in BOTH directions. It is faster (one
 * pass per file instead of one regex per candidate pair — 467² pair tests on the
 * live tree), and it is more precise: `text.includes('writer.mjs')` is TRUE for
 * `config-writer.mjs`, which silently marks an unrelated module as referenced.
 * The character class stops at `/`, so `'./locks/state-md-lock.mjs'` yields
 * exactly `state-md-lock.mjs`.
 *
 * @param {string[]} lines source lines
 * @returns {Set<string>} module basenames mentioned outside comments
 */
function mentionedModuleTokens(lines) {
  /** @type {Set<string>} */
  const tokens = new Set();
  for (const line of lines) {
    if (isCommentLine(line)) continue;
    for (const match of line.matchAll(/[A-Za-z0-9_.-]+\.(?:mjs|js|cjs)/g)) tokens.add(match[0]);
  }
  return tokens;
}

/**
 * Signal S4 — library modules no mechanical caller can reach.
 *
 * ## The gap this closes, in one line
 *
 * S3 asks "does a DOCUMENT name a symbol of this module?" and accepts a yes as
 * wiring. S4 asks the question the machine can answer: "can any process that
 * actually starts — a hook, an npm script, a CI job, a husky stage — arrive at
 * this file?" Prose in a SKILL.md is an instruction to an LLM, not a caller: the
 * measured instance is `skills/session-start/SKILL.md` Phase 4, which named 19
 * banner probes that no `.mjs` reached from any entrypoint.
 *
 * ## Entry roots, and why CLI entrypoints are among them
 *
 * Roots are (a) every module named in a NON-markdown wiring surface
 * (`package.json`, `.gitlab-ci.yml`, `.github/workflows/**`, `.husky/**`,
 * `hooks/*.json`) and (b) every CLI entrypoint. Reachability then follows
 * module→module references transitively.
 *
 * (b) is a DELIBERATE boundary, not an oversight. A CLI entrypoint is invoked by
 * path, and "the operator types `/autopilot`, whose skill body runs
 * `node scripts/autopilot.mjs`" IS this repo's architecture — reporting it would
 * indict the design rather than a defect. Measured 2026-08-23: treating CLI
 * entrypoints as non-roots moves the census from 73 to 268 of 467 modules
 * (15.6% → 57.5%), i.e. straight into the broken-instrument band that
 * `.claude/rules/host-resources.md` § HR-101 forbids. A LIBRARY module, by
 * contrast, can only ever be reached by being imported — so "nothing imports it,
 * transitively" is a fact about the machine, not a judgement about prose.
 *
 * ## Cluster roots — one defect, one line
 *
 * Only the ROOT of each unreachable cluster is reported: a module no OTHER
 * unreachable module references. `scripts/lib/owner-config.mjs` has no importer
 * and drags its whole 7-file `owner-config/` subtree down with it; reporting the
 * six interior files would multiply one deletion into seven findings that all
 * disappear together. Measured on the live tree: 73 unreachable modules collapse
 * to 51 roots. This is category separation in the sense of
 * `.claude/rules/development.md` § Guard & Threshold Design — a structural split,
 * never a raised threshold.
 *
 * ## Named residuals
 *
 *  - **Basename granularity.** 22 basenames collide across 56 files (7 × `schema.mjs`,
 *    3 × `telemetry.mjs`, …), so a mention of `schema.mjs` marks every `schema.mjs`
 *    as referenced. This errs toward WIRED — it can hide a finding, never invent
 *    one, which is the right direction for a check whose failure mode is being
 *    switched off. Revisit if a real module-resolver (import-specifier resolution
 *    relative to the importing file) becomes cheap, or if a collided basename is
 *    ever confirmed to mask a true positive.
 *  - **Reachable ≠ executed.** A module imported by a hook that never takes that
 *    branch reads as wired here. Proving execution needs coverage data, not a graph.
 *  - **Reachable from SOME entrypoint is not reachable from the PROMISED one.**
 *    This is the sharpest limit and it cost real recall. `ci-status-banner.mjs` is
 *    imported by `dispatcher/rank.mjs`, so S4 stays silent — yet CLAUDE.md promises
 *    it runs at SESSION-START, and no SessionStart path reached it at `4f6404e`.
 *    Same shape for `sessions-integrity-banner.mjs` (via `session-record-repair.mjs`)
 *    and `historical-guard.mjs` (via `check-banner-parity.mjs`). Catching those needs
 *    a per-entrypoint reachability question ("is X reachable from the SessionStart
 *    hook?"), which is a different check with a different root set, not a tightening
 *    of this one. Revisit if a second promised-entrypoint claim is ever missed.
 *
 * @param {string} pluginRoot absolute plugin root
 * @returns {{findings: Finding[], scanned: {modules: number, roots: number, unreachable: number}}}
 */
export function collectUnreachableLibraryModules(pluginRoot) {
  const absolute = CONSUMER_DIRS.flatMap((dir) => walkCode(path.join(pluginRoot, dir))).sort();
  const modules = absolute.map((file) => {
    const body = readFileSync(file, 'utf8');
    const lines = body.split('\n');
    return {
      relative: path.relative(pluginRoot, file),
      base: path.basename(file),
      entrypoint: isCliEntrypoint(body),
      exports: collectExportedSymbols(body),
      mentions: mentionedModuleTokens(lines),
    };
  });

  // Non-markdown surfaces that mechanically invoke a module by path.
  const wiringBodies = [
    ...WIRING_FILES.map((rel) => path.join(pluginRoot, rel)).filter((file) => existsSync(file)),
    ...WIRING_DIRS.flatMap(([dir, extensions]) =>
      walkCode(path.join(pluginRoot, dir), [], extensions, EXCLUDED_DIRS),
    ),
  ].map((file) => readFileSync(file, 'utf8'));
  const wiringTokens = mentionedModuleTokens(wiringBodies.join('\n').split('\n'));

  /** @type {Set<string>} */
  const reachable = new Set();
  /** @type {string[]} */
  const stack = [];
  for (const module of modules) {
    if (!module.entrypoint && !wiringTokens.has(module.base)) continue;
    reachable.add(module.relative);
    stack.push(module.relative);
  }

  const byRelative = new Map(modules.map((module) => [module.relative, module]));
  while (stack.length > 0) {
    const current = byRelative.get(/** @type {string} */ (stack.pop()));
    if (!current) continue;
    for (const module of modules) {
      if (reachable.has(module.relative) || !current.mentions.has(module.base)) continue;
      reachable.add(module.relative);
      stack.push(module.relative);
    }
  }

  const unreachable = modules.filter(
    (module) => !reachable.has(module.relative) && !module.entrypoint && module.exports.length > 0,
  );
  const unreachableSet = new Set(unreachable.map((module) => module.relative));
  const roots = unreachable.filter(
    (module) =>
      !unreachable.some((other) => other.relative !== module.relative && other.mentions.has(module.base)),
  );

  const findings = roots.map((module) => {
    const dragged = [...module.mentions].filter(
      (token) => token !== module.base && [...unreachableSet].some((rel) => path.basename(rel) === token),
    );
    const tail = dragged.length > 0 ? `, and drags ${dragged.length} further unreachable module(s)` : '';
    return /** @type {Finding} */ ({
      kind: 'unreachable-library-module',
      key: module.relative,
      message:
        `exports ${module.exports.length} symbol(s) (${module.exports.slice(0, 3).join(', ')}) but no hook, ` +
        `npm script, CI job or husky stage reaches it — transitively${tail}. Only markdown names it, and ` +
        'prose is an instruction to an LLM, not a caller: wire it, delete it, or allowlist it with a reason',
    });
  });

  return {
    findings,
    scanned: { modules: modules.length, roots: roots.length, unreachable: unreachable.length },
  };
}

/**
 * Run the full census.
 *
 * @param {string} pluginRoot absolute plugin root
 * @returns {{
 *   ok: boolean,
 *   summary: {declaredKeys: number, consumerFiles: number, unwired: number, allowlisted: number,
 *             orphanedModules: number},
 *   sourcesScanned: string[],
 *   findings: Finding[],
 *   toolError: boolean,
 * }}
 */
export function inspectUnwiredFeatures(pluginRoot) {
  /** @type {Finding[]} */
  const findings = [];
  const result = {
    ok: false,
    summary: {
      declaredKeys: 0,
      consumerFiles: 0,
      unwired: 0,
      allowlisted: 0,
      orphanedModules: 0,
      unreachableModules: 0,
    },
    /** @type {string[]} */
    sourcesScanned: [],
    findings,
    toolError: false,
  };

  /** @type {{keys: Map<string, DeclaredKey>, sourcesScanned: string[]}} */
  let declared;
  /** @type {{relative: string, lines: string[], body: string}[]} */
  let corpus;
  /** @type {string} */
  let parserBody;
  /** @type {ReturnType<typeof collectOrphanedProseModules>} */
  let orphans;
  /** @type {ReturnType<typeof collectUnreachableLibraryModules>} */
  let unreachable;
  try {
    declared = collectDeclaredKeys(pluginRoot);
    corpus = CONSUMER_DIRS.flatMap((dir) => walkCode(path.join(pluginRoot, dir)))
      .sort()
      .filter((absolute) => path.relative(pluginRoot, absolute) !== SELF_REL)
      .map((absolute) => {
        const body = readFileSync(absolute, 'utf8');
        return { relative: path.relative(pluginRoot, absolute), lines: body.split('\n'), body };
      });
    parserBody = PARSER_PATHS.flatMap((relative) => {
      const absolute = path.join(pluginRoot, relative);
      if (!existsSync(absolute)) return [];
      return CODE_EXTENSIONS.includes(path.extname(absolute)) ? [absolute] : walkCode(absolute);
    })
      .map((absolute) => readFileSync(absolute, 'utf8'))
      .join('\n');
    orphans = collectOrphanedProseModules(pluginRoot);
    unreachable = collectUnreachableLibraryModules(pluginRoot);
  } catch (error) {
    result.toolError = true;
    findings.push({
      kind: 'tool-error',
      key: '-',
      message: `cannot enumerate config surface: ${error instanceof Error ? error.message : String(error)}`,
    });
    return result;
  }

  result.sourcesScanned = declared.sourcesScanned;
  result.summary.declaredKeys = declared.keys.size;
  result.summary.consumerFiles = corpus.length;

  /** @type {Set<string>} */
  const flagged = new Set();

  for (const key of [...declared.keys.keys()].sort()) {
    const meta = /** @type {DeclaredKey} */ (declared.keys.get(key));
    const { code, comment } = countReadSites(meta, corpus);

    /** @type {Finding | null} */
    let issue = null;
    if (code === 0) {
      const commentNote = comment > 0 ? ` (${comment} comment-only mention(s))` : '';
      issue = {
        kind: 'unwired-config-key',
        key,
        message:
          `declared in ${meta.sources.join(' + ')} but no .mjs under ${CONSUMER_DIRS.join('/ or ')}/ ` +
          `reads it${commentNote} — wire it, delete it, or allowlist it with a reason`,
      };
    } else if (key === meta.root && !tokenMatcher(key).test(parserBody)) {
      issue = {
        kind: 'parser-orphan-config-key',
        key,
        message:
          `mentioned in ${CONSUMER_DIRS.join('/ or ')}/ but unknown to the config-parser layer ` +
          `(${PARSER_PATHS.join(', ')}) — nothing turns this YAML into a value; the mention may be ` +
          'a log string or a comment-adjacent reference',
      };
    }
    if (!issue) continue;
    flagged.add(key);

    if (Object.prototype.hasOwnProperty.call(ALLOWLIST, key)) {
      result.summary.allowlisted += 1;
      if (String(ALLOWLIST[key] ?? '').trim() === '') {
        findings.push({
          kind: 'allowlist-missing-reason',
          key,
          message: 'allowlist entry has no reason — name the actual consumer or remove the entry',
        });
      }
      continue;
    }

    result.summary.unwired += 1;
    findings.push(issue);
  }

  // S3 — prose promises a module nothing calls. Reported alongside the config
  // census because it is the same defect class one level out: a claim with no
  // mechanism behind it.
  result.summary.orphanedModules = orphans.findings.length;
  findings.push(...orphans.findings);

  // S4 — no process that actually starts can reach these. Allowlistable on the
  // same terms as a config key: the entry's reason must name the real consumer.
  for (const finding of unreachable.findings) {
    if (Object.prototype.hasOwnProperty.call(ALLOWLIST, finding.key)) {
      result.summary.allowlisted += 1;
      flagged.add(finding.key);
      continue;
    }
    result.summary.unreachableModules += 1;
    findings.push(finding);
  }

  for (const key of Object.keys(ALLOWLIST).sort()) {
    if (flagged.has(key)) continue;
    findings.push({
      kind: 'allowlist-stale',
      key,
      message: declared.keys.has(key)
        ? 'allowlisted key no longer triggers a finding (it is wired now) — remove the entry'
        : 'allowlisted key is no longer declared in any config surface — remove the entry',
    });
  }

  result.ok = !result.toolError && findings.length === 0;
  return result;
}

/**
 * Run the human-readable validator CLI.
 *
 * WARN-ONLY: findings print as WARN and still exit 0. See the header for why a
 * blocking gate would be red on day one on this repo's current inventory.
 *
 * @param {string} pluginRoot absolute plugin root
 * @returns {number} 0 = scan completed (with or without findings), 2 = tool error
 */
export function runCheckUnwiredFeatures(pluginRoot, { list = false } = {}) {
  console.log('--- Check: unwired config keys (declared-but-unread census, WARN-only) ---');
  const inspection = inspectUnwiredFeatures(pluginRoot);

  if (inspection.toolError) {
    for (const item of inspection.findings) console.log(`  FAIL: ${item.key} — ${item.message}`);
    console.log('');
    console.log(`Results: 0 passed, ${inspection.findings.length} failed`);
    return 2;
  }

  const { declaredKeys, consumerFiles, unwired, allowlisted, orphanedModules, unreachableModules } =
    inspection.summary;

  // S4 is a BACKLOG, not a per-run alarm: 51 findings on the live tree against
  // 1-2 WARN lines from every sibling check. Printing all 51 every run is the
  // "gate that prints 282 lines gets switched off in week two" failure this
  // file's own header names. So the default carries the NUMBER (which ratchets,
  // and which a reviewer can compare run to run) plus the first few paths; the
  // full census is one `--list` away. Nothing is suppressed — only deferred.
  const s4 = inspection.findings.filter((item) => item.kind === 'unreachable-library-module');
  for (const item of inspection.findings) {
    if (!list && item.kind === 'unreachable-library-module') continue;
    console.log(`  WARN: [${item.kind}] ${item.key} — ${item.message}`);
  }
  if (!list && s4.length > 0) {
    console.log(
      `  WARN: [unreachable-library-module] ${s4.length} library module(s) that no hook, npm script, ` +
        `CI job or husky stage can reach — e.g. ${s4.slice(0, 3).map((item) => item.key).join(', ')}. ` +
        'Re-run with --list for the full census.',
    );
  }

  console.log(
    `  PASS: censused ${declaredKeys} declared key(s) from ${inspection.sourcesScanned.join(' + ') || '(no source)'} ` +
      `against ${consumerFiles} consumer file(s) — ${unwired} unwired, ${allowlisted} allowlisted, ` +
      `${orphanedModules} prose-orphaned module(s), ${unreachableModules} unreachable module(s)`,
  );
  console.log('');
  console.log('Results: 1 passed, 0 failed');
  return 0;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  const args = process.argv.slice(2);
  const pluginRoot = args.find((arg) => !arg.startsWith('-'));
  if (!pluginRoot) {
    console.error('Usage: check-unwired-features.mjs <plugin-root> [--list]');
    console.error('  --list  print every unreachable-library-module finding instead of the aggregate');
    process.exit(2);
  }
  process.exit(runCheckUnwiredFeatures(path.resolve(pluginRoot), { list: args.includes('--list') }));
}
