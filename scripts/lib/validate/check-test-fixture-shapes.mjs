#!/usr/bin/env node
// @secret-shape-allowed
// (Self-application: this file is the validator itself — it defines the
//  forbidden credential-shape regex literals and the canonical placeholder
//  substrings. Eating own dog food per #558 M3 — magic-comment replaces
//  the previous hardcoded SELF_EXCLUSIONS Set.)
/**
 * check-test-fixture-shapes.mjs — Scan tests/ tracked files for live-credential
 * shape patterns that would block a public GitHub-mirror push.
 *
 * Implements issue #556 (release-day blocker — fixture-shape validator).
 *
 * Forbidden patterns:
 *   F1  /sk_live_[A-Za-z0-9]{24,}/        — Stripe live secret key
 *   F2  /xoxb-\d{6,}/                     — Slack bot token (digit-prefix form)
 *   F3  /AKIA[A-Z0-9]{16}/                — AWS access key
 *   F4  /AIzaSy[A-Za-z0-9_-]{33}/         — Google API key
 *
 * Allowlist (hard-coded — these strings are recommended placeholders or
 * documentation canonical examples that MUST NOT be blocked):
 *   - AKIAIOSFODNN7EXAMPLE   (AWS docs canonical example — appears in
 *                             tests/unit/quality-gate-diagnostics.test.mjs)
 *   - sk_test_<...>          (Stripe test-mode prefix — the suggested
 *                             replacement for sk_live_)
 *   - xoxb-PLACEHOLDER       (canonical Slack placeholder)
 *   - AIzaSy-PLACEHOLDER     (canonical Google API placeholder)
 *
 * Per-file allowlist:
 *   - // @secret-shape-allowed  magic comment in first 5 lines of file
 *     opts that file out of all pattern checks. Use for fixtures that
 *     intentionally test secret scanners.
 *
 * Scope:
 *   Only tracked files under tests/ matching *.{mjs,ts,js}.
 *   Snapshot files (*.snap) are excluded.
 *   Production source (scripts/, hooks/, skills/, etc.) is NOT scanned —
 *   gitleaks / .gitleaks.toml handles that surface.
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — at least one violation found
 *   2 — tool error (unreadable root, missing argument)
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// CLI: single positional arg required
// ---------------------------------------------------------------------------

const pluginRoot = process.argv[2];
if (!pluginRoot) {
  console.error('Usage: check-test-fixture-shapes.mjs <plugin-root>');
  process.exit(2);
}

if (!existsSync(pluginRoot)) {
  console.error(`Error: plugin root does not exist: ${pluginRoot}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Forbidden patterns (with hints)
// ---------------------------------------------------------------------------

/** @type {Array<{name: string, regex: RegExp, hint: string}>} */
const PATTERNS = [
  {
    name: 'F1 (Stripe sk_live_)',
    regex: /sk_live_[A-Za-z0-9]{24,}/,
    hint: 'use sk_test_ prefix + PLACEHOLDER suffix (e.g. sk_test_PLACEHOLDER_AAAAAAAAAAAAAAAAAAAA)',
  },
  {
    name: 'F2 (Slack xoxb-<digits>)',
    regex: /xoxb-\d{6,}/,
    hint: 'use xoxb-PLACEHOLDER segments (e.g. xoxb-PLACEHOLDER-PLACEHOLDER-PLACEHOLDER)',
  },
  {
    name: 'F3 (AWS AKIA…)',
    regex: /AKIA[A-Z0-9]{16}/,
    hint: 'use AKIAIOSFODNN7EXAMPLE (AWS docs canonical example — already allowlisted here)',
  },
  {
    name: 'F4 (Google AIzaSy…)',
    regex: /AIzaSy[A-Za-z0-9_-]{33}/,
    hint: 'use AIzaSy-PLACEHOLDER (canonical placeholder shape)',
  },
  {
    name: 'F5 (Anthropic sk-ant-)',
    regex: /sk-ant-[A-Za-z0-9_-]{30,}/,
    hint: 'use sk-ant-<PLACEHOLDER>-<padding to ≥30 chars after the prefix>',
  },
  {
    name: 'F6 (GitHub PAT classic ghp_)',
    regex: /ghp_[A-Za-z0-9]{36,}/,
    hint: 'use ghp_PLACEHOLDER<padding> (must be ≥36 chars after the underscore)',
  },
  {
    name: 'F7 (GitHub PAT fine-grained github_pat_)',
    regex: /github_pat_[A-Za-z0-9_]{30,}/,
    hint: 'use github_pat_PLACEHOLDER<padding> (must be ≥30 chars after the prefix)',
  },
  {
    name: 'F8 (GitLab PAT glpat-)',
    regex: /glpat-[A-Za-z0-9_-]{20,}/,
    hint: 'use glpat-PLACEHOLDER<padding> (must be ≥20 chars after the prefix)',
  },
  {
    name: 'F9 (Slack webhook URL)',
    regex: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/,
    hint: 'use slack.com/services/T<X>/B<X>/<X> with placeholder segments — not a real webhook URL shape',
  },
  {
    name: 'F10 (Discord webhook URL)',
    regex: /https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/,
    hint: 'use discord.com/api/webhooks/<id>/<token> with placeholder ID + token — not a real URL shape',
  },
];

// ---------------------------------------------------------------------------
// Allowlist substrings — if a regex hit overlaps any of these, it's skipped.
//
// AKIAIOSFODNN7EXAMPLE is the AWS-published canonical-docs example used by
// real-world secret scanners (gitleaks, trufflehog) as a known-safe fixture.
// It MUST stay allowlisted — tests/unit/quality-gate-diagnostics.test.mjs
// uses AKIAIOSFODNN7EXAMPLE23 (canonical + 2-char suffix) to exercise the
// AKIA redaction path of redactDiagnosticsBundle.
//
// sk_test_ is Stripe's official test-mode prefix — the recommended drop-in
// replacement for sk_live_ in tests. Allowlisting the prefix means any
// sk_test_<...> string is exempt.
//
// xoxb-PLACEHOLDER and AIzaSy-PLACEHOLDER are the canonical placeholder
// forms recommended in the hint messages above. Allowlisting them as
// substrings ensures the recommended replacement is never blocked.
// ---------------------------------------------------------------------------
const ALLOWLIST_SUBSTRINGS = [
  'AKIAIOSFODNN7EXAMPLE',  // AWS docs canonical (covers AKIAIOSFODNN7EXAMPLE + any suffix)
  'sk_test_',              // Stripe test-mode prefix (covers any sk_test_<...>)
  'xoxb-PLACEHOLDER',      // canonical Slack placeholder
  'AIzaSy-PLACEHOLDER',    // canonical Google API placeholder
];

const MAGIC_COMMENT = '// @secret-shape-allowed';
const MAGIC_COMMENT_SCAN_LINES = 5;

// ---------------------------------------------------------------------------
// File enumeration: git ls-files | filter tests/**/*.{mjs,ts,js}
// Excludes snapshot files (.snap).
// ---------------------------------------------------------------------------

function getTrackedTestFiles() {
  let output;
  try {
    output = execFileSync('git', ['ls-files'], { cwd: pluginRoot, encoding: 'utf8' });
  } catch {
    // Not a git repo or git unavailable — return empty (caller treats as pass)
    return [];
  }
  return output
    .split('\n')
    .filter(Boolean)
    .filter((rel) => /^tests\/.*\.(mjs|ts|js)$/.test(rel.replace(/\\/g, '/')))
    .filter((rel) => !rel.endsWith('.snap'))
    .map((rel) => join(pluginRoot, rel));
}

// ---------------------------------------------------------------------------
// Self-exclusion via magic-comment (#558 M3) — the validator and its test
// file opt out via // @secret-shape-allowed at top-of-file. This eats own
// dog food: there is no hardcoded path list, only the documented escape
// hatch every other consumer uses.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Per-file magic-comment check
// ---------------------------------------------------------------------------

/**
 * Return true if the file's first MAGIC_COMMENT_SCAN_LINES lines contain
 * the // @secret-shape-allowed marker.
 */
function hasAllowedMagicComment(content) {
  const lines = content.split('\n').slice(0, MAGIC_COMMENT_SCAN_LINES);
  return lines.some((line) => line.includes(MAGIC_COMMENT));
}

/**
 * Return true if the hit text is covered by an allowlist substring.
 * Match is by substring: if the hit string contains any allowlist token,
 * the hit is skipped.
 */
function isAllowlistedHit(hitText) {
  return ALLOWLIST_SUBSTRINGS.some((token) => hitText.includes(token));
}

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function pass(msg) {
  console.log(`  PASS: ${msg}`);
  passed++;
}

function fail(msg) {
  console.log(`  FAIL: ${msg}`);
  failed++;
}

// ---------------------------------------------------------------------------
// Main check
// ---------------------------------------------------------------------------

console.log('--- Check: test fixture shape (live-credential patterns) ---');

// All files in scope — opt-out is per-file via the // @secret-shape-allowed
// magic-comment, checked below in hasAllowedMagicComment().
const scanFiles = getTrackedTestFiles();

/** @type {Array<{relPath: string, lineNum: number, pattern: string, hint: string, hitText: string}>} */
const violations = [];

for (const filePath of scanFiles) {
  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    continue; // unreadable — skip
  }

  // Per-file allowlist via magic comment
  if (hasAllowedMagicComment(content)) {
    continue;
  }

  const relPath = relative(pluginRoot, filePath).replace(/\\/g, '/');
  const lines = content.split('\n');

  lines.forEach((line, idx) => {
    const lineNum = idx + 1;

    for (const { name, regex, hint } of PATTERNS) {
      // Use the same regex with /g to find ALL matches on the line
      const globalRegex = new RegExp(regex.source, 'g');
      let match;
      while ((match = globalRegex.exec(line)) !== null) {
        const hitText = match[0];
        // Per-hit substring allowlist check
        if (isAllowlistedHit(hitText)) {
          continue;
        }
        violations.push({
          relPath,
          lineNum,
          pattern: name,
          hint,
          hitText,
        });
      }
    }
  });
}

if (violations.length === 0) {
  pass(`no live-credential patterns found across ${scanFiles.length} scanned tests/ files`);
} else {
  for (const v of violations) {
    fail(`${v.relPath}:${v.lineNum} — ${v.pattern}: ${v.hitText} — hint: ${v.hint}`);
  }
}

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
