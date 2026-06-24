// dead-bridge-detectors.mjs — PURE detection functions for the dead-bridge
// validator (#671). These functions consolidate the dead-reference guards that
// previously lived as standalone scripts (check-subagent-types.mjs,
// check-rules-references.mjs, check-baseline-fetch-bridge.mjs) plus a NEW
// bridge-balance detector for the producer/consumer dead-bridge class.
//
// PURITY CONTRACT (load-bearing — do not violate):
//   - NO node:fs import. All filesystem access is INJECTED via the RepoContext
//     (`ctx.listMdFiles`, `ctx.listFiles`, `ctx.readText`, `ctx.exists`), so
//     detectors are unit-testable with in-memory fakes.
//   - NO console.* output. Detectors return Finding[] — the orchestrator
//     (check-dead-bridge.mjs) is responsible for rendering and exit codes.
//   - NO process.exit. Tool-error semantics are signalled via a Finding whose
//     `rule` ends in `-tool-error` (see TOOL-ERROR CONVENTION below).
//   - `path` from node:path IS allowed (pure, no IO).
//
// TOOL-ERROR CONVENTION:
//   The original standalone guards exited 2 (tool-error) when a REQUIRED scan
//   directory was missing/unreadable (rules dir for dangling-rule-reference,
//   bootstrap dir for dangling-bootstrap-bridge). Because these detectors are
//   pure (no process.exit), a tool-error is instead signalled by RETURNING a
//   Finding with `rule: '<subrule>-tool-error'`. The orchestrator translates any
//   `*-tool-error` rule into process exit code 2 (distinct from a normal exit-1
//   validation failure). Detectors that find a missing dir which is a vacuous
//   pass (e.g. skills/ for dangling-subagent-type) return NO finding instead.
//
// @typedef {Object} Finding
// @property {string}  rule     stable detector / sub-rule id (or `<id>-tool-error`)
// @property {'fail'}  severity always 'fail' for this validator
// @property {string}  file     absolute path of the offending file ('' = N/A)
// @property {number}  line     1-based line number (0 = file-level / no line)
// @property {string}  message  human-readable description
//
// @typedef {Object} RepoContext
// @property {string} pluginRoot                                   absolute plugin root
// @property {(absDir: string) => string[]} listMdFiles            recursive list of *.md under absDir (abs paths)
// @property {(absDir: string, exts: string[]) => string[]} listFiles  recursive list of files with given exts under absDir (abs paths)
// @property {(absPath: string) => string} readText               read file content as UTF-8
// @property {(absPath: string) => boolean} exists                path-existence test

import { join, dirname, basename } from 'node:path';

// ---------------------------------------------------------------------------
// Shared constants (ported verbatim from the three standalone guards).
// ---------------------------------------------------------------------------

// Any line carrying the consolidated dead-bridge ignore marker is skipped by
// EVERY sub-rule, in addition to each sub-rule's own historical marker — this
// preserves the original per-guard ignore behaviour while giving the merged
// validator a single uniform escape hatch.
const DEAD_BRIDGE_IGNORE = 'check-dead-bridge:ignore';

// --- dangling-subagent-type (port of check-subagent-types.mjs) -------------
const SUBAGENT_IGNORE_MARKER = 'check-subagent-types:ignore';
const SUBAGENT_REF_RE = /subagent_type:\s*["']session-orchestrator:([a-z0-9-]+)["']/g;

// --- dangling-rule-reference (port of check-rules-references.mjs) -----------
const RULES_IGNORE_MARKER = 'check-rules-references:ignore';
// Backtick-wrapped reference: `name.md`. Capture group = inner ref so
// path-qualified refs (containing `/`) can be excluded downstream.
const BACKTICK_REF_RE = /`([^`]+\.md)`/g;
// See-Also footer tokens — bare `[a-z0-9-]+\.md` basenames in a `· `-delimited
// list line.
const SEE_ALSO_TOKEN_RE = /([a-z0-9-]+\.md)/g;
// A rule-style basename is lowercase-kebab. Deliberately EXCLUDES uppercase doc
// names (CLAUDE.md, AGENTS.md, SECURITY.md, SKILL.md, MIGRATION-vN.md) and
// wildcard prose (`*.md`).
const RULE_BASENAME_RE = /^[a-z0-9-]+\.md$/;

// --- dangling-bootstrap-bridge (port of check-baseline-fetch-bridge.mjs) ---
const BOOTSTRAP_IGNORE_MARKER = 'check-baseline-fetch-bridge:ignore';
const BOOTSTRAP_FILES = [
  '_shared-template.md',
  'SKILL.md',
  'standard-template.md',
  'deep-template.md',
];
const STALE_BASENAME = 'fetch-baseline.sh';
const DEAD_FUNCTIONS = [
  'fetch_baseline_file',
  'fetch_baseline_files_batch',
  'write_baseline_fetch_lock',
];
// A `-f "$PLUGIN_ROOT/scripts/lib/fetch-baseline.<ext>"` guard reference.
// Capture group = guarded path relative to the plugin root.
const GUARD_RE = /-f\s+["']?\$(?:\{)?PLUGIN_ROOT(?:\})?\/(scripts\/lib\/fetch-baseline\.[a-z]+)["']?/g;

// Default file extensions searched by detectBridgeBalance scope entries when a
// scope entry does not carry its own `exts`.
const DEFAULT_BRIDGE_EXTS = ['.mjs', '.md'];

// ---------------------------------------------------------------------------
// Small helpers (pure).
// ---------------------------------------------------------------------------

/**
 * Split file content into lines, tolerant of CRLF.
 * @param {string} text
 * @returns {string[]}
 */
function splitLines(text) {
  return String(text).split(/\r?\n/);
}

/**
 * True if a line should be skipped by a sub-rule: it carries either the
 * sub-rule's own historical ignore marker or the consolidated dead-bridge
 * marker.
 * @param {string} text
 * @param {string} ownMarker
 * @returns {boolean}
 */
function isIgnored(text, ownMarker) {
  return text.includes(ownMarker) || text.includes(DEAD_BRIDGE_IGNORE);
}

/**
 * Make a fail Finding.
 * @param {string} rule
 * @param {string} file
 * @param {number} line
 * @param {string} message
 * @returns {Finding}
 */
function fail(rule, file, line, message) {
  return { rule, severity: 'fail', file: file || '', line: line ?? 0, message };
}

// ---------------------------------------------------------------------------
// Sub-rule 1 — dangling-subagent-type (port of check-subagent-types.mjs).
// ---------------------------------------------------------------------------

/**
 * Scan recursive skills/**.md for `subagent_type: "session-orchestrator:<X>"`
 * references and FAIL when no `agents/<X>.md` exists. Missing skills/ dir is a
 * vacuous pass (no findings).
 *
 * @param {RepoContext} ctx
 * @returns {Finding[]}
 */
function detectDanglingSubagentTypes(ctx) {
  /** @type {Finding[]} */
  const findings = [];
  const skillsDir = join(ctx.pluginRoot, 'skills');
  const agentsDir = join(ctx.pluginRoot, 'agents');

  // Missing skills/ dir → vacuously OK (no findings, NOT a tool-error).
  if (!ctx.exists(skillsDir)) return findings;

  for (const file of ctx.listMdFiles(skillsDir)) {
    const lines = splitLines(ctx.readText(file));
    lines.forEach((text, idx) => {
      if (isIgnored(text, SUBAGENT_IGNORE_MARKER)) return;
      SUBAGENT_REF_RE.lastIndex = 0;
      let m;
      while ((m = SUBAGENT_REF_RE.exec(text)) !== null) {
        const agent = m[1];
        const agentFile = join(agentsDir, `${agent}.md`);
        if (!ctx.exists(agentFile)) {
          findings.push(
            fail(
              'dangling-subagent-type',
              file,
              idx + 1,
              `subagent_type session-orchestrator:${agent} → agents/${agent}.md NOT FOUND`,
            ),
          );
        }
      }
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Sub-rule 2 — dangling-rule-reference (port of check-rules-references.mjs).
// ---------------------------------------------------------------------------

/**
 * Scan TOP-LEVEL `.claude/rules/*.md` (non-recursive) for bare-basename rule
 * references — backtick refs and See-Also footer tokens — and FAIL when the
 * referenced basename does not resolve to an existing sibling rule file.
 *
 * Tool-error: missing/unreadable rules dir → a `dangling-rule-reference-tool-error`
 * Finding (orchestrator maps to exit 2).
 *
 * @param {RepoContext} ctx
 * @returns {Finding[]}
 */
function detectDanglingRuleReferences(ctx) {
  /** @type {Finding[]} */
  const findings = [];
  const rulesDir = join(ctx.pluginRoot, '.claude', 'rules');

  // Tool-error gate: the rules dir is REQUIRED for this sub-rule.
  if (!ctx.exists(rulesDir)) {
    return [
      fail(
        'dangling-rule-reference-tool-error',
        '',
        0,
        `rules directory not found: ${rulesDir}`,
      ),
    ];
  }

  // listMdFiles is recursive; filter to DIRECT children of rulesDir only — the
  // original guard scanned the top level of `.claude/rules/` exclusively.
  const allMd = ctx.listMdFiles(rulesDir);
  const topLevel = allMd.filter((f) => dirname(f) === rulesDir);

  // The resolution universe: the set of existing top-level rule basenames.
  const existing = new Set(topLevel.map((f) => basename(f)));

  for (const full of topLevel) {
    const name = basename(full);
    const lines = splitLines(ctx.readText(full));

    lines.forEach((text, idx) => {
      if (isIgnored(text, RULES_IGNORE_MARKER)) return;
      const lineNo = idx + 1;

      // Locus (a): backtick refs `name.md` anywhere in the body.
      BACKTICK_REF_RE.lastIndex = 0;
      let m;
      while ((m = BACKTICK_REF_RE.exec(text)) !== null) {
        const inner = m[1];
        if (inner.includes('/')) continue; // path-qualified — out of scope
        if (!RULE_BASENAME_RE.test(inner)) continue; // not a rule-style basename
        if (inner === name) continue; // self-reference
        if (!existing.has(inner)) {
          findings.push(
            fail(
              'dangling-rule-reference',
              full,
              lineNo,
              `rule reference ${inner} NOT FOUND in .claude/rules/`,
            ),
          );
        }
      }

      // Locus (b): See-Also footer tokens — only on `· `-delimited list lines.
      if (text.includes('· ') && /[a-z0-9-]+\.md/.test(text)) {
        SEE_ALSO_TOKEN_RE.lastIndex = 0;
        let s;
        while ((s = SEE_ALSO_TOKEN_RE.exec(text)) !== null) {
          const token = s[1];
          // Skip tokens that are the tail of a path-qualified ref (e.g.
          // `skills/_shared/state-ownership.md`): walk back to the nearest
          // whitespace/backtick/`·` boundary and check for a slash.
          const before = text.slice(0, s.index);
          if (/[\w./-]$/.test(before.slice(-1)) && /\//.test(before.slice(-40))) {
            const segMatch = before.match(/([^\s`·]+)$/);
            if (segMatch && segMatch[1].includes('/')) continue;
          }
          if (token === name) continue; // self-reference
          if (!existing.has(token)) {
            findings.push(
              fail(
                'dangling-rule-reference',
                full,
                lineNo,
                `rule reference ${token} NOT FOUND in .claude/rules/`,
              ),
            );
          }
        }
      }
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Sub-rule 3 — dangling-bootstrap-bridge (port of check-baseline-fetch-bridge.mjs).
// ---------------------------------------------------------------------------

/**
 * Scan the fixed bootstrap file set for the baseline-fetch bridge and FAIL on:
 *   - a `-f "$PLUGIN_ROOT/scripts/lib/fetch-baseline.<ext>"` guard whose target
 *     does not exist (the #618 always-false dead-bridge),
 *   - any reference to the stale `fetch-baseline.sh` basename,
 *   - any reference to a dead shell-function name,
 *   - ZERO guards found across the whole scanned set (requireAtLeastOne).
 *
 * Absent individual bootstrap files are skipped silently (informational, not a
 * finding). Tool-error: missing bootstrap dir → a
 * `dangling-bootstrap-bridge-tool-error` Finding (orchestrator maps to exit 2).
 *
 * @param {RepoContext} ctx
 * @returns {Finding[]}
 */
function detectDanglingBootstrapBridge(ctx) {
  /** @type {Finding[]} */
  const findings = [];
  const bootstrapDir = join(ctx.pluginRoot, 'skills', 'bootstrap');

  // Tool-error gate: the bootstrap dir is REQUIRED for this sub-rule.
  if (!ctx.exists(bootstrapDir)) {
    return [
      fail(
        'dangling-bootstrap-bridge-tool-error',
        '',
        0,
        `bootstrap directory not found: ${bootstrapDir}`,
      ),
    ];
  }

  let guardCount = 0;

  for (const name of BOOTSTRAP_FILES) {
    const full = join(bootstrapDir, name);
    // Absent bootstrap file → skip silently (informational, not a finding).
    if (!ctx.exists(full)) continue;

    const lines = splitLines(ctx.readText(full));
    lines.forEach((text, idx) => {
      if (isIgnored(text, BOOTSTRAP_IGNORE_MARKER)) return;
      const lineNo = idx + 1;

      // Guard refs — every guarded fetch-baseline path must resolve.
      GUARD_RE.lastIndex = 0;
      let m;
      while ((m = GUARD_RE.exec(text)) !== null) {
        guardCount++;
        const guardedPath = m[1];
        const target = join(ctx.pluginRoot, guardedPath);
        if (!ctx.exists(target)) {
          findings.push(
            fail(
              'dangling-bootstrap-bridge',
              full,
              lineNo,
              `guard "${guardedPath}" points at a non-existent file — dead always-false bridge (#618 regression class)`,
            ),
          );
        }
      }

      // Forbidden-presence: stale `.sh` basename.
      if (text.includes(STALE_BASENAME)) {
        findings.push(
          fail(
            'dangling-bootstrap-bridge',
            full,
            lineNo,
            `stale "${STALE_BASENAME}" reference (the plugin ships .mjs only)`,
          ),
        );
      }

      // Forbidden-presence: dead shell-function names.
      for (const fn of DEAD_FUNCTIONS) {
        if (text.includes(fn)) {
          findings.push(
            fail(
              'dangling-bootstrap-bridge',
              full,
              lineNo,
              `dead shell-function reference "${fn}" (removed shell-source bridge)`,
            ),
          );
        }
      }
    });
  }

  // requireAtLeastOne: zero fetch-baseline guards anywhere is itself a dead
  // bridge (the on-demand baseline-fetch step lost its guard entirely).
  if (guardCount === 0) {
    findings.push(
      fail(
        'dangling-bootstrap-bridge',
        '',
        0,
        'no fetch-baseline guard reference found in bootstrap files (expected the on-demand baseline-fetch bridge guard)',
      ),
    );
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Public detector: detectDanglingReferences — composes the 3 sub-rules.
// ---------------------------------------------------------------------------

/**
 * Run all three dangling-reference sub-rules and return their combined
 * Finding[]. Tool-errors are surfaced as `*-tool-error` Findings (see the
 * TOOL-ERROR CONVENTION at the top of this file).
 *
 * @param {RepoContext} ctx
 * @returns {Finding[]}
 */
export function detectDanglingReferences(ctx) {
  return [
    ...detectDanglingSubagentTypes(ctx),
    ...detectDanglingRuleReferences(ctx),
    ...detectDanglingBootstrapBridge(ctx),
  ];
}

// ---------------------------------------------------------------------------
// Public detector: detectBridgeBalance — the NEW dead-bridge class.
// ---------------------------------------------------------------------------

/**
 * Build a RegExp from a producer/consumer pattern. The pattern may be a string
 * (treated as a literal substring) or a RegExp source string. We always compile
 * with the 'g' flag so `match` counts every occurrence. A leading/trailing `/`
 * pair is treated as a regex literal; otherwise the string is escaped to a
 * literal match.
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
function compilePattern(pattern) {
  const src = String(pattern);
  // `/.../flags` form → treat the inside as a regex source.
  const literalRe = src.match(/^\/(.*)\/([a-z]*)$/s);
  if (literalRe) {
    const flags = literalRe[2].includes('g') ? literalRe[2] : `${literalRe[2]}g`;
    return new RegExp(literalRe[1], flags);
  }
  // Plain string → escape regex metacharacters and match literally.
  const escaped = src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped, 'g');
}

/**
 * Normalize an extension allow-list so every entry carries a leading dot. This
 * lets the corpus declare exts either way (`'md'` or `'.md'`) while the
 * underlying `ctx.listFiles` (which compares against `path.extname()`, e.g.
 * `'.md'`) still matches. Idempotent: `'.md'` stays `'.md'`.
 *
 * @param {string[]|undefined} exts
 * @param {string[]} defaultExts
 * @returns {string[]}
 */
function normalizeExts(exts, defaultExts) {
  const list = exts && exts.length ? exts : defaultExts;
  return list.map((e) => (String(e).startsWith('.') ? String(e) : `.${e}`));
}

/**
 * Count total matches of `pattern` across every file in `scope`. Each scope
 * entry is a repo-relative path that may be EITHER a single FILE or a DIRECTORY
 * (optionally an object `{ dir, exts }`):
 *
 *   - FILE entry  → read it directly via ctx.readText and count matches. We
 *     detect "is a file" by ATTEMPTING ctx.readText first: detectors only have
 *     the injected ctx callbacks (no isDirectory), so a successful read of a
 *     string is the cheapest reliable file-signal. If the read throws (the path
 *     is a directory, or missing), we fall through to the directory branch.
 *   - DIRECTORY entry → enumerate via ctx.listFiles with the scope's `exts`
 *     (default `.mjs` + `.md`, leading dot normalized) and read each file.
 *
 * This file-or-dir handling lets the corpus declare scope as concrete file
 * paths (e.g. `docs/session-config-template.md`) without a new ctx callback.
 *
 * @param {RepoContext} ctx
 * @param {string} pattern
 * @param {Array<string|{dir: string, exts?: string[]}>} scope
 * @param {string[]} defaultExts
 * @returns {number}
 */
function countMatches(ctx, pattern, scope, defaultExts) {
  let count = 0;
  const countIn = (text) => {
    const re = compilePattern(pattern);
    const matches = String(text).match(re);
    return matches ? matches.length : 0;
  };
  for (const entry of scope ?? []) {
    const relPath = typeof entry === 'string' ? entry : entry.dir;
    const exts = normalizeExts(typeof entry === 'object' ? entry.exts : undefined, defaultExts);
    const abs = join(ctx.pluginRoot, relPath);
    if (!ctx.exists(abs)) continue;

    // FILE-first: try reading the entry directly. A successful read means it is
    // a single file; a throw means it is a directory (or vanished) → fall back
    // to the recursive directory walk.
    let fileText;
    try {
      fileText = ctx.readText(abs);
    } catch {
      // Not a readable file (directory or vanished) → fall through to dir walk.
    }
    if (typeof fileText === 'string') {
      count += countIn(fileText);
      continue;
    }
    for (const file of ctx.listFiles(abs, exts)) {
      count += countIn(ctx.readText(file));
    }
  }
  return count;
}

/**
 * The NEW dead-bridge class. For each declared bridge — a producer/consumer
 * pair — FAIL when exactly one side has zero matches:
 *   - producerCount === 0 && consumerCount > 0  → "read but never set"
 *   - consumerCount === 0 && producerCount > 0  → "set but never read"
 *
 * A bridge where BOTH sides are zero, or BOTH are non-zero, is NOT a finding.
 * `bridges` defaults to [] → no findings (zero false positives by construction;
 * only declared bridges are checked).
 *
 * @param {RepoContext} ctx
 * @param {Array<{id: string, description?: string, producer: {pattern: string, scope: Array<string|{dir:string,exts?:string[]}>, exts?: string[]}, consumer: {pattern: string, scope: Array<string|{dir:string,exts?:string[]}>, exts?: string[]}}>} bridges
 * @returns {Finding[]}
 */
export function detectBridgeBalance(ctx, bridges) {
  /** @type {Finding[]} */
  const findings = [];

  for (const bridge of bridges ?? []) {
    const id = bridge?.id ?? '<unnamed>';
    const producer = bridge?.producer;
    const consumer = bridge?.consumer;
    if (!producer || !consumer) continue; // malformed bridge — nothing to check

    const producerExts = producer.exts || DEFAULT_BRIDGE_EXTS;
    const consumerExts = consumer.exts || DEFAULT_BRIDGE_EXTS;

    const producerCount = countMatches(ctx, producer.pattern, producer.scope, producerExts);
    const consumerCount = countMatches(ctx, consumer.pattern, consumer.scope, consumerExts);

    if (producerCount === 0 && consumerCount > 0) {
      findings.push(
        fail(
          'bridge-balance',
          '',
          0,
          `bridge "${id}": consumer side matches (${consumerCount}) but producer side has ZERO matches — read but never set (dead bridge)`,
        ),
      );
    } else if (consumerCount === 0 && producerCount > 0) {
      findings.push(
        fail(
          'bridge-balance',
          '',
          0,
          `bridge "${id}": producer side matches (${producerCount}) but consumer side has ZERO matches — set but never read (dead bridge)`,
        ),
      );
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Detector registry — consumed by the orchestrator (check-dead-bridge.mjs).
// Each entry's `fn(ctx, corpus)` returns Finding[]. The corpus carries the
// declared BRIDGES list for the bridge-balance detector.
// ---------------------------------------------------------------------------

export const DETECTORS = [
  { id: 'dangling-reference', fn: (ctx, _corpus) => detectDanglingReferences(ctx) },
  { id: 'bridge-balance', fn: (ctx, corpus) => detectBridgeBalance(ctx, corpus.BRIDGES ?? []) },
];
