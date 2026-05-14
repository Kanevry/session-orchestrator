#!/usr/bin/env node
/**
 * check-playwright-mcp-canary.mjs — Forbid @playwright/mcp references in
 * skills/playwright-driver/** and scripts/lib/test-runner/**.
 *
 * Rationale: Playwright MCP costs ~4× more tokens per test than the
 * canonical playwright CLI (Microsoft's own benchmark: ~114K vs ~27K).
 * The playwright-driver and test-runner stack MUST stay on the CLI.
 *
 * Forbidden patterns:
 *   - @playwright/mcp
 *   - playwright-mcp
 *
 * Allowed patterns:
 *   - mentions inside lines that contain HARD-GATE markers or other
 *     canary-exempt tokens — those are documentation blocks explaining
 *     WHY the pattern is forbidden, not actual imports or usage.
 *
 * Detection strategy:
 *   - Scan all .md, .mjs, .js, .ts files under the two forbidden dirs
 *   - Flag any line containing one of the forbidden patterns
 *   - Skip lines that also contain a documentation marker
 *     (HARD-GATE, check-playwright-mcp-canary, R5 grep-canary, canary-exempt)
 *
 * Exit codes:
 *   0 — no violations
 *   1 — at least one violation found
 *
 * Usage:
 *   node scripts/lib/validate/check-playwright-mcp-canary.mjs <plugin-root>
 *
 * Test approach (for W4):
 *   - Verify exit 0 when scan roots are clean or absent
 *   - Verify exit 1 + FAIL line when a scanned file contains a bare forbidden pattern
 *   - Verify that lines containing HARD-GATE are skipped (no false positives on SKILL.md)
 *   - Verify non-scanned file extensions (e.g. .yaml) are not processed
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const pluginRoot = process.argv[2];
if (!pluginRoot) {
  console.error('Usage: check-playwright-mcp-canary.mjs <plugin-root>');
  process.exit(1);
}

let passed = 0;
let failed = 0;

function pass(msg) { console.log(`  PASS: ${msg}`); passed += 1; }
function fail(msg) { console.log(`  FAIL: ${msg}`); failed += 1; }

console.log('--- Check 1: playwright-mcp canary (R5 — forbidden in driver + helpers) ---');

const FORBIDDEN_PATTERNS = [
  /@playwright\/mcp/,
  /playwright-mcp/,
];

// Lines that mention the forbidden pattern AS PART OF documenting the rule
// itself are skipped. Any of these markers on the same line indicates a
// documentation context, not an actual import or usage reference.
const DOCUMENTATION_MARKERS = [
  /HARD-GATE/,
  /check-playwright-mcp-canary/,
  /R5 grep-canary/,
  /R5 hard-gate/,
  /canary-exempt/,
  // "Never @playwright/mcp" — anti-pattern prohibition in soul.md / SKILL.md
  /Never.*@playwright\/mcp/,
  /Never.*playwright-mcp/,
  // "blocks @playwright/mcp" — rule-enforcement documentation
  /blocks.*@playwright\/mcp/,
  /blocks.*playwright-mcp/,
  // Markdown table rows listing @playwright/mcp as a "DO NOT USE" item
  /DO NOT USE.*@playwright\/mcp|@playwright\/mcp.*DO NOT USE/,
  /DO NOT USE.*playwright-mcp|playwright-mcp.*DO NOT USE/,
];

const SCAN_ROOTS = [
  'skills/playwright-driver',
  'scripts/lib/test-runner',
  'scripts/lib/shared/profiles',
];

const SCAN_EXTENSIONS = ['.md', '.mjs', '.js', '.ts'];

/**
 * Recursively walk a directory and return all file paths with the allowed extensions.
 * @param {string} dir
 * @returns {string[]}
 */
function walk(dir) {
  const results = [];
  if (!existsSync(dir)) return results;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      results.push(...walk(full));
    } else if (SCAN_EXTENSIONS.some((ext) => name.endsWith(ext))) {
      results.push(full);
    }
  }
  return results;
}

const violations = [];

for (const rel of SCAN_ROOTS) {
  const absDir = join(pluginRoot, rel);
  if (!existsSync(absDir)) {
    pass(`${rel}/ does not exist yet (no scan needed)`);
    continue;
  }
  const files = walk(absDir);
  let fileViolations = 0;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const matchesForbidden = FORBIDDEN_PATTERNS.some((p) => p.test(line));
      if (!matchesForbidden) continue;
      const isDocumentation = DOCUMENTATION_MARKERS.some((p) => p.test(line));
      if (isDocumentation) continue;
      violations.push({
        file: relative(pluginRoot, file),
        line: i + 1,
        text: line.trim().slice(0, 160),
      });
      fileViolations += 1;
    }
  }
  if (fileViolations === 0) {
    pass(`${rel}/ scanned (${files.length} files): no playwright-mcp references`);
  }
}

if (violations.length === 0) {
  pass(`playwright-mcp canary clean across all ${SCAN_ROOTS.length} scan roots`);
} else {
  for (const v of violations) {
    fail(
      `${v.file}:${v.line} — '${v.text}' (matches forbidden pattern; ` +
      `if intentional documentation, add a HARD-GATE marker on the line)`,
    );
  }
}

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
