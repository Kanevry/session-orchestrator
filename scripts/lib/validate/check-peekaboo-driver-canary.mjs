#!/usr/bin/env node
/**
 * check-peekaboo-driver-canary.mjs — Forbid peekaboo-mcp references in
 * skills/peekaboo-driver/** and scripts/lib/test-runner/**.
 *
 * Rationale: The peekaboo-driver skill wraps the `peekaboo` binary (steipete,
 * MIT, macOS-only) directly via the CLI. Introducing an MCP adapter layer
 * (peekaboo-mcp) would add unnecessary token overhead and couples the driver
 * to a specific MCP transport. All invocations MUST use the raw binary.
 *
 * Forbidden pattern:
 *   - peekaboo-mcp   (the string; NOT bare "peekaboo" which is the valid binary name)
 *
 * Allowed patterns:
 *   - mentions inside lines that contain documentation markers explaining
 *     WHY the pattern is forbidden, not actual imports or usage.
 *
 * Detection strategy:
 *   - Scan all .md, .mjs, .js, .ts files under the two forbidden dirs
 *   - Flag any line containing the forbidden pattern
 *   - Skip lines that also contain a documentation marker
 *     (HARD-GATE, check-peekaboo-driver-canary, R5 grep-canary, canary-exempt)
 *
 * Exit codes:
 *   0 — no violations
 *   1 — at least one violation found
 *
 * Usage:
 *   node scripts/lib/validate/check-peekaboo-driver-canary.mjs <plugin-root>
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
  console.error('Usage: check-peekaboo-driver-canary.mjs <plugin-root>');
  process.exit(1);
}

let passed = 0;
let failed = 0;

function pass(msg) { console.log(`  PASS: ${msg}`); passed += 1; }
function fail(msg) { console.log(`  FAIL: ${msg}`); failed += 1; }

console.log('--- Check 1: peekaboo-mcp canary (R5 — forbidden in peekaboo-driver + helpers) ---');

const FORBIDDEN_PATTERNS = [
  /peekaboo-mcp/,
];

// Lines that mention the forbidden pattern AS PART OF documenting the rule
// itself are skipped. Any of these markers on the same line indicates a
// documentation context, not an actual import or usage reference.
const DOCUMENTATION_MARKERS = [
  /HARD-GATE/,
  /check-peekaboo-driver-canary/,
  /R5 grep-canary/,
  /R5 hard-gate/,
  // SEC-PD-LOW-2: canary-exempt was an unguarded bypass keyword (security_control_bypass).
  // HARD-GATE remains for legitimate documenting-the-rule context.
  // "Never peekaboo-mcp" — anti-pattern prohibition in soul.md / SKILL.md
  /Never.*peekaboo-mcp/,
  // "blocks peekaboo-mcp" — rule-enforcement documentation
  /blocks.*peekaboo-mcp/,
  // Markdown table rows listing peekaboo-mcp as a "DO NOT USE" item
  /DO NOT USE.*peekaboo-mcp|peekaboo-mcp.*DO NOT USE/,
];

const SCAN_ROOTS = [
  'skills/peekaboo-driver',
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
    pass(`${rel}/ scanned (${files.length} files): no peekaboo-mcp references`);
  }
}

if (violations.length === 0) {
  pass(`peekaboo-mcp canary clean across all ${SCAN_ROOTS.length} scan roots`);
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
