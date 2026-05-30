#!/usr/bin/env node
// check-rules-references.mjs — Validate that every bare-basename rule reference
// inside `.claude/rules/*.md` resolves to an existing sibling rule file.
//
// Rationale (#445): the `.claude/rules/` tree inherited a baseline-manifest
// cross-reference convention where each rule's See-Also footer (and a handful of
// in-body backtick refs) point at sibling rules by bare basename
// (e.g. `testing.md`, `security-compliance.md`). Several of those targets were
// never vendored into THIS plugin (`security-compliance.md`, `ai-agent.md`,
// `infrastructure.md`, `observability.md`) — the dangling refs sat silent
// because no mechanical guard asserted that a referenced rule file actually
// exists. This validator closes that gap: a future dangling rule reference fails
// plugin validation instead of shipping broken-by-implication navigation.
//
// Usage: check-rules-references.mjs <plugin-root>
// Outputs lines of the form "  PASS: ..." / "  FAIL: ...".
// Exit 0 = all references resolve; 1 = at least one dangling reference;
// 2 = tool error (rules directory unreadable).
//
// Two reference loci are checked per rule file:
//   (a) See-Also footer tokens — the trailing `· `-delimited list of bare
//       `[a-z0-9-]+\.md` basenames at the bottom of each rule.
//   (b) In-body backtick refs — `` `name.md` `` that are NOT path-qualified
//       (no `/`), i.e. a bare sibling-rule reference embedded in prose.
//
// Exclusions (must NOT flag):
//   - Path-qualified refs (`docs/api.md`, `skills/_shared/state-ownership.md`,
//     `../../...`, `templates/...`) — these point outside `.claude/rules/` and
//     are not this guard's concern.
//   - A reference to the file's own basename.
//   - Any source line carrying the inline-ignore marker
//     `check-rules-references:ignore` (mirrors the repo's `consistency:exempt:`
//     and `check-subagent-types:ignore` conventions).

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const IGNORE_MARKER = 'check-rules-references:ignore';
// Backtick-wrapped reference: `name.md`. The capture group is the inner ref so
// path-qualified refs (containing `/`) can be excluded downstream.
const BACKTICK_REF_RE = /`([^`]+\.md)`/g;
// A See-Also footer line is the `· `-delimited list of bare basenames. We detect
// it heuristically: a line that contains `· ` AND at least one `*.md` token.
const SEE_ALSO_TOKEN_RE = /([a-z0-9-]+\.md)/g;
// A rule-style basename is lowercase-kebab: `security-compliance.md`,
// `ai-agent.md`. This deliberately EXCLUDES uppercase doc names that live
// outside `.claude/rules/` (project-instruction files like `CLAUDE.md` /
// `AGENTS.md`, plus `SECURITY.md`, `SKILL.md`, `MIGRATION-vN.md`) and wildcard
// prose (`*.md`) — those are not sibling-rule references and must not be
// flagged. Both reference loci share this shape so the resolution universe
// stays consistent.
const RULE_BASENAME_RE = /^[a-z0-9-]+\.md$/;

/**
 * Collect every bare-basename rule reference inside `.claude/rules/*.md`,
 * recording the referenced basename and the file:line where it appears. Lines
 * carrying the inline-ignore marker are skipped. Path-qualified refs and
 * self-references are excluded.
 *
 * Pure + import-safe: no process.exit, no console — returns the reference list
 * so callers (and tests) can assert against it directly.
 *
 * @param {string} rulesDir absolute path to `.claude/rules/`
 * @returns {Array<{ref: string, file: string, line: number}>}
 */
export function collectRuleReferences(rulesDir) {
  /** @type {Array<{ref: string, file: string, line: number}>} */
  const refs = [];

  const ruleFiles = readdirSync(rulesDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name);

  for (const name of ruleFiles) {
    const full = join(rulesDir, name);
    const lines = readFileSync(full, 'utf8').split(/\r?\n/);

    lines.forEach((text, idx) => {
      if (text.includes(IGNORE_MARKER)) return;
      const lineNo = idx + 1;

      // Locus (a): backtick refs `name.md` anywhere in the body.
      BACKTICK_REF_RE.lastIndex = 0;
      let m;
      while ((m = BACKTICK_REF_RE.exec(text)) !== null) {
        const inner = m[1];
        if (inner.includes('/')) continue; // path-qualified — out of scope
        if (!RULE_BASENAME_RE.test(inner)) continue; // not a rule-style basename
        if (inner === name) continue; // self-reference
        refs.push({ ref: inner, file: full, line: lineNo });
      }

      // Locus (b): See-Also footer tokens — only on `· `-delimited list lines.
      if (text.includes('· ') && /[a-z0-9-]+\.md/.test(text)) {
        SEE_ALSO_TOKEN_RE.lastIndex = 0;
        let s;
        while ((s = SEE_ALSO_TOKEN_RE.exec(text)) !== null) {
          const token = s[1];
          // Skip tokens that are part of a path-qualified backtick ref already
          // handled above (those carry a `/` so the bare `[a-z0-9-]+\.md` regex
          // would still match the tail — guard against that by checking the
          // surrounding characters for a slash immediately before the token).
          const before = text.slice(0, s.index);
          if (/[\w./-]$/.test(before.slice(-1)) && /\//.test(before.slice(-40))) {
            // The token is preceded (within the last path-ish run) by a slash —
            // likely a path-qualified ref like `skills/_shared/state-ownership.md`.
            // Confirm by walking back to a whitespace/backtick boundary.
            const segMatch = before.match(/([^\s`·]+)$/);
            if (segMatch && segMatch[1].includes('/')) continue;
          }
          if (token === name) continue; // self-reference
          refs.push({ ref: token, file: full, line: lineNo });
        }
      }
    });
  }

  return refs;
}

/**
 * Run the validator against a plugin root. Prints PASS/FAIL lines and a Results
 * summary; returns the process exit code (0 = all references resolve, 1 = at
 * least one dangling reference, 2 = tool error / rules dir unreadable).
 *
 * @param {string} pluginRoot
 * @returns {number}
 */
export function runCheckRulesReferences(pluginRoot) {
  const rulesDir = join(pluginRoot, '.claude', 'rules');

  console.log('--- Check: .claude/rules/ bare-basename references resolve ---');

  // Tool-error gate: rules dir must exist and be a readable directory.
  try {
    if (!existsSync(rulesDir) || !statSync(rulesDir).isDirectory()) {
      console.error(`  tool-error: rules directory not found: ${rulesDir}`);
      return 2;
    }
    readdirSync(rulesDir);
  } catch (/** @type {unknown} */ e) {
    console.error(`  tool-error: cannot read rules directory: ${(/** @type {Error} */ (e)).message}`);
    return 2;
  }

  // Build the set of existing rule basenames (the resolution universe).
  const existing = new Set(
    readdirSync(rulesDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name),
  );

  const refs = collectRuleReferences(rulesDir);

  let passed = 0;
  let failed = 0;
  const pass = (msg) => { console.log(`  PASS: ${msg}`); passed++; };
  const fail = (msg) => { console.log(`  FAIL: ${msg}`); failed++; };

  const relativize = (f) =>
    f.startsWith(pluginRoot) ? f.slice(pluginRoot.length).replace(/^\//, '') : f;

  if (refs.length === 0) {
    pass('no bare-basename rule references found');
  } else {
    // Aggregate per referenced basename for a compact PASS summary; emit one
    // FAIL line per dangling occurrence so the offending file:line is visible.
    /** @type {Map<string, Array<{file: string, line: number}>>} */
    const byRef = new Map();
    for (const r of refs) {
      if (!byRef.has(r.ref)) byRef.set(r.ref, []);
      byRef.get(r.ref).push({ file: r.file, line: r.line });
    }

    for (const [ref, locations] of [...byRef.entries()].sort()) {
      if (existing.has(ref)) {
        const n = locations.length;
        pass(`${ref} (${n} ref${n === 1 ? '' : 's'})`);
      } else {
        for (const loc of locations) {
          fail(`${ref} NOT FOUND in .claude/rules/ (referenced at ${relativize(loc.file)}:${loc.line})`);
        }
      }
    }
  }

  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  return failed > 0 ? 1 : 0;
}

// CLI entry — only when executed directly, never on import (keeps the exports
// safe to import from tests without triggering process.exit).
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  const [, , pluginRoot] = process.argv;
  if (!pluginRoot) {
    console.error('Usage: check-rules-references.mjs <plugin-root>');
    process.exit(2);
  }
  process.exit(runCheckRulesReferences(pluginRoot));
}
