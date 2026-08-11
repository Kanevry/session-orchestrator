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

/**
 * This file excludes ITSELF from the consumer corpus. Load-bearing: every
 * `ALLOWLIST` key is a string literal here, so without the exclusion each
 * allowlist entry becomes its own read site and the check reports the key as
 * wired — silently blinding itself to exactly the keys an operator flagged as
 * needing review. (Observed on first run: 2 allowlisted keys reported as 0.)
 */
const SELF_REL = path.join('scripts', 'lib', 'validate', 'check-unwired-features.mjs');

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
 *       | 'allowlist-stale' | 'tool-error',
 *   key: string,
 *   message: string,
 * }} Finding
 */

/**
 * Recursively collect code files, skipping symlinks and excluded directories.
 *
 * @param {string} directory absolute directory path
 * @param {string[]} [acc]
 * @returns {string[]} absolute file paths, sorted
 */
function walkCode(directory, acc = []) {
  if (!existsSync(directory)) return acc;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    if (EXCLUDED_DIRS.includes(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) walkCode(fullPath, acc);
    else if (entry.isFile() && CODE_EXTENSIONS.includes(path.extname(entry.name))) acc.push(fullPath);
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
 * Run the full census.
 *
 * @param {string} pluginRoot absolute plugin root
 * @returns {{
 *   ok: boolean,
 *   summary: {declaredKeys: number, consumerFiles: number, unwired: number, allowlisted: number},
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
    summary: { declaredKeys: 0, consumerFiles: 0, unwired: 0, allowlisted: 0 },
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
export function runCheckUnwiredFeatures(pluginRoot) {
  console.log('--- Check: unwired config keys (declared-but-unread census, WARN-only) ---');
  const inspection = inspectUnwiredFeatures(pluginRoot);

  if (inspection.toolError) {
    for (const item of inspection.findings) console.log(`  FAIL: ${item.key} — ${item.message}`);
    console.log('');
    console.log(`Results: 0 passed, ${inspection.findings.length} failed`);
    return 2;
  }

  const { declaredKeys, consumerFiles, unwired, allowlisted } = inspection.summary;
  for (const item of inspection.findings) {
    console.log(`  WARN: [${item.kind}] ${item.key} — ${item.message}`);
  }
  console.log(
    `  PASS: censused ${declaredKeys} declared key(s) from ${inspection.sourcesScanned.join(' + ') || '(no source)'} ` +
      `against ${consumerFiles} consumer file(s) — ${unwired} unwired, ${allowlisted} allowlisted`,
  );
  console.log('');
  console.log('Results: 1 passed, 0 failed');
  return 0;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  const pluginRoot = process.argv[2];
  if (!pluginRoot) {
    console.error('Usage: check-unwired-features.mjs <plugin-root>');
    process.exit(2);
  }
  process.exit(runCheckUnwiredFeatures(path.resolve(pluginRoot)));
}
