#!/usr/bin/env node
/**
 * check-owner-leakage.mjs — Scan tracked files for owner-privacy leakage patterns.
 *
 * Implements the #462 audit trail durable CI guard (#471).
 *
 * Usage: check-owner-leakage.mjs <plugin-root>
 *
 * Forbidden patterns (P1–P10):
 *   P1  /\/Users\/bernhardg[a-z.]*(\/|\b)/  — personal home path (issue #631)
 *   P2  /\bgitlab\.gotzendorfer\.at\b/  — private GitLab host
 *   P3  /\bevents\.gotzendorfer\.at\b/  — private events domain
 *   P4  /@goetzendorfer\/[A-Za-z0-9*_-]+/  — private package scope
 *   P5  DEFAULT_GITLAB_HOST on line with 'gotzendorfer' OR as exported const
 *   P6  private project slugs (see PRIVATE_SLUGS constant below)
 *   P7  /gotzendorfer\.at/ not matching an allowlisted exclusion
 *   P8  full RFC1918 private dotted-quad (10.x.x.x / 192.168.x.x / 172.16-31.x.x)
 *       — internal IP leak. Placeholder `.x` forms and CIDR/range notation are NOT
 *       matched (only literal 4-octet IPs), so SSRF-range docs stay clean.
 *   P9  /-Users-bernhardg[a-z.]*-/  — dash-encoded personal home path
 *       (Claude Code projects-dir encoding of /Users/bernhardg.; issue #634)
 *   P10 /~\/Projects\/<PersonalName>\//  — personal-name segment in a ~/Projects/ path
 *       (name-denylist driven; see PERSONAL_NAMES constant below; issue #653)
 *
 * Exclusions (line-scoped, never whole-file):
 *   1. Lines with office@gotzendorfer.at or security@gotzendorfer.at
 *      and no other gotzendorfer.at token
 *   2. https://gotzendorfer.at[...] URLs in README.md and the 3 manifest files
 *      and docs/marketplace/**, docs/submissions/**
 *   3. Manifest author/email/url/websiteURL/privacyPolicyURL/termsOfServiceURL keys
 *      in .claude-plugin/plugin.json, .claude-plugin/marketplace.json, .codex-plugin/plugin.json
 *      (covered by exclusions 1 + 2 above; listed explicitly for audit trail)
 *   4. docs/marketplace/** + docs/submissions/** lines with sanctioned email/URL only
 *   5. .orchestrator/audits/** — never scanned (excluded in file enumeration)
 *   6. tests/lib/events-default-url.test.mjs — ONLY the exact JSDoc contract line:
 *      " *   - No literal `events.gotzendorfer.at` URL appears anywhere in scripts/ or hooks/."
 *      (a real string-literal events.gotzendorfer.at elsewhere in that file still FAILs)
 *   7. tests/scripts/export-hw-learnings.test.mjs — exempt from P8 ONLY: the RFC1918
 *      IPs there are the redaction subject of the anonymizeString suite, not leaks.
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — at least one failure (or usage error / unreadable root)
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname, relative, basename, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// CLI: single positional arg required
// ---------------------------------------------------------------------------

const pluginRoot = process.argv[2];
if (!pluginRoot) {
  console.error('Usage: check-owner-leakage.mjs <plugin-root>');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Private slugs constant — #462 audit trail (list is CLOSED: add only after audit review)
// ---------------------------------------------------------------------------
const PRIVATE_SLUGS = [
  'launchpad-ai-factory',
  'Codex-Hackathon',
  'buchhaltgenie',
  'AngebotsChecker',
  'wien-forschungsfragen-klima',
  'aiat-pmo-module',
  'mail-assistant',
];

// ---------------------------------------------------------------------------
// Forbidden patterns
// ---------------------------------------------------------------------------

/**
 * P1: personal home path (issue #631 — Candidate F).
 *
 * Anchors on the real owner prefix `bernhardg`, then matches a trailing-slash
 * OR a word boundary. The trailing-slash-OR-word-boundary alternation is the
 * fix for the original `…[a-z.]*\//` form, which REQUIRED a slash after the
 * username and so let bare `/Users/bernhardg.` (end-of-line, before `&&`,
 * before a newline) pass undetected. The `g`-anchor keeps the
 * false-positive profile tight: `/Users/bernhardgX` (uppercase continuation),
 * `/Users/bernhardo-other`, `/Users/bernhardt`, `/Users/bernhardus/`, and bare
 * `/Users/bernhard` are all correctly rejected.
 */
const P1 = /\/Users\/bernhardg[a-z.]*(\/|\b)/;

/** P2: private GitLab host */
const P2 = /\bgitlab\.gotzendorfer\.at\b/;

/** P3: private events domain */
const P3 = /\bevents\.gotzendorfer\.at\b/;

/** P4: private package scope */
const P4 = /@goetzendorfer\/[A-Za-z0-9*_-]+/;

/** P5: DEFAULT_GITLAB_HOST on a line with 'gotzendorfer' OR as an exported const */
const P5_WITH_GOTZ = /DEFAULT_GITLAB_HOST/;
const P5_EXPORT = /\bexport\b.*\bconst\b.*\bDEFAULT_GITLAB_HOST\b/;

/** P6: private project slugs (word-boundary anchored, case-insensitive — #483 W4-Q6 caught "Buchhaltgenie" capitalized) */
const P6_PATTERNS = PRIVATE_SLUGS.map((slug) => new RegExp(`\\b${escapeRegex(slug)}\\b`, 'i'));

/** P7: catch-all gotzendorfer.at (must not match allowlist) */
const P7 = /gotzendorfer\.at/;

/**
 * P8: full RFC1918 private dotted-quad — internal-IP leak.
 * Matches only literal 4-octet private IPs (10.x.x.x, 192.168.x.x, 172.16-31.x.x).
 * Deliberately does NOT match placeholder `.x` forms (10.x, 192.168.x) or CIDR/range
 * notation used in SSRF-range documentation, nor TEST-NET (192.0.2.x, RFC 5737).
 */
const P8 = /(?:\b10(?:\.\d{1,3}){3}|\b192\.168(?:\.\d{1,3}){2}|\b172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})/;

/** P8 allowlist: files where RFC1918 IPs are a legitimate test subject (IP-redaction fixtures). */
const P8_ALLOWLIST = new Set(['tests/scripts/export-hw-learnings.test.mjs']);

/**
 * P9: dash-encoded personal home path — the Claude Code projects-dir encoding
 * of `/Users/bernhardg.` (slashes → dashes, e.g. `-Users-bernhardg--Projects-…`).
 * Same sensitivity class as P1 but invisible to the slash-form regex (issue #634).
 */
const P9 = /-Users-bernhardg[a-z.]*-/;

/** P10: personal-name owner segment in a ~/Projects/<Name>/ path (#653).
 *  Name-denylist driven (CLOSED list, audit-reviewed) — mirrors PRIVATE_SLUGS (P6).
 *  A generic ~/Projects/[A-Z][a-z]+/ would false-positive on legit capitalized
 *  project dirs (~/Projects/MyApp/), so we match only known personal names.
 *
 *  Matches the tilde form (`~/Projects/Bernhard`) OR an absolute home form
 *  (`/Users/<user>/Projects/Bernhard`, `/home/<user>/Projects/Bernhard`), then a
 *  trailing-slash OR word boundary. The slash-OR-word-boundary alternation is the
 *  Finding-1 fix for the original `…/<Name>/` form, which REQUIRED a slash after the
 *  name and so let a bare `~/Projects/Bernhard` (end-of-line, before `&&`) pass
 *  undetected — the same blindspot P1 was patched for (see P1 doc above). The
 *  absolute-home alternation is the Finding-3 defense-in-depth: a leak in a
 *  non-owner home (`/Users/alice/Projects/Bernhard/vault`) slipped both P1 and the
 *  old tilde-only P10. The trailing word boundary keeps the false-positive profile
 *  tight: `~/Projects/Bernhardt/` (denylisted name + a continuation letter) does
 *  NOT match, so names that merely START with a denylisted name are not flagged. */
const PERSONAL_NAMES = ['Bernhard'];
const P10_PATTERNS = PERSONAL_NAMES.map(
  (name) => new RegExp(`(?:~|/Users/[^/]+|/home/[^/]+)/Projects/${escapeRegex(name)}(\\/|\\b)`),
);

/** P10 allowlist: files where ~/Projects/Bernhard is a deliberate test subject
 *  (migration/drift fixtures) or a legitimate one-shot-migration source/target. */
const P10_ALLOWLIST = new Set([
  'tests/scripts/vault-consolidate.test.mjs',
  'tests/scripts/migrate-vault-paths.test.mjs',
  'tests/lib/migrate-vault-paths-pure.test.mjs',
  'tests/lib/cli-flags.test.mjs',
  'tests/lib/config/vault-integration.test.mjs',
  'tests/skills/claude-md-drift-check/checker.test.mjs',
  'scripts/migrate-vault-paths.mjs',
  'scripts/vault-consolidate.mjs',
]);

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Text-scan extension allowlist (spec A.2)
// ---------------------------------------------------------------------------
const TEXT_EXTS = new Set(['.md', '.mjs', '.js', '.ts', '.json', '.yml', '.yaml', '.sh', '.txt']);

// Dotfiles to include (checked by basename, BEFORE the extension gate —
// extname('.env.example') is '.example' (truthy), so an extension-first check
// would make that allowlist entry unreachable; W3-P3 finding, 2026-06-10)
const DOTFILE_ALLOWLIST = new Set(['.env.example', '.nvmrc', '.vault.yaml']);

function isTextFile(filePath) {
  const base = basename(filePath);
  if (DOTFILE_ALLOWLIST.has(base)) return true;
  const ext = extname(filePath);
  return ext ? TEXT_EXTS.has(ext) : false;
}

// ---------------------------------------------------------------------------
// File enumeration: git ls-files primary, recursive fs walk fallback (spec A.2)
// Exclusions: .git/, node_modules/, .orchestrator/audits/
// ---------------------------------------------------------------------------

function getTrackedFiles() {
  try {
    const output = execFileSync('git', ['ls-files'], { cwd: pluginRoot, encoding: 'utf8' });
    return output
      .split('\n')
      .filter(Boolean)
      .map((f) => join(pluginRoot, f));
  } catch {
    // git unavailable or not a git repo — fall back to recursive fs walk
    return walkDir(pluginRoot);
  }
}

function walkDir(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    // Exclusions: .git, node_modules, .orchestrator/audits
    if (entry === '.git' || entry === 'node_modules') continue;
    const rel = relative(pluginRoot, full);
    if (rel === join('.orchestrator', 'audits') || rel.startsWith(join('.orchestrator', 'audits') + sep)) continue;
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      walkDir(full, acc);
    } else {
      acc.push(full);
    }
  }
  return acc;
}

// ---------------------------------------------------------------------------
// Allowlist helpers (spec A.4)
// ---------------------------------------------------------------------------

/**
 * Return true if this gotzendorfer.at hit is covered by the exclusion allowlist.
 * @param {string} relPath - path relative to pluginRoot (forward slashes)
 * @param {string} line    - the raw line content
 * @returns {boolean}
 */
function isAllowlisted(relPath, line) {
  // Normalize to forward-slash for matching
  const norm = relPath.replace(/\\/g, '/');

  // A.4 exclusion 6: tests/lib/events-default-url.test.mjs — ONLY the exact JSDoc contract line
  if (norm === 'tests/lib/events-default-url.test.mjs') {
    // The exact doc-comment line: " *   - No literal `events.gotzendorfer.at` URL..."
    // Match the literal backtick-quoted pattern in a JSDoc/comment line
    if (/^\s+\*\s+- No literal `events\.gotzendorfer\.at`/.test(line)) {
      return true;
    }
    // Any other gotzendorfer.at in this file is NOT excluded
    return false;
  }

  // A.4 exclusion 1: lines with office@ or security@ gotzendorfer.at and NO other gotzendorfer.at token
  // (i.e., the only gotzendorfer.at occurrence is an email address — count occurrences)
  const SANCTIONED_EMAILS = /(?:office|security)@gotzendorfer\.at/g;
  const allGotzTokens = [...line.matchAll(/gotzendorfer\.at/g)];
  const sanctionedMatches = [...line.matchAll(SANCTIONED_EMAILS)];
  if (allGotzTokens.length > 0 && allGotzTokens.length === sanctionedMatches.length) {
    // All gotzendorfer.at occurrences are the sanctioned email addresses
    return true;
  }

  // A.4 exclusion 2 + 3 + 4: https://gotzendorfer.at URLs in README.md, the 3 manifest files,
  // docs/marketplace/**, docs/submissions/**
  const ALLOWLISTED_URL_PATHS = new Set([
    'README.md',
    '.claude-plugin/plugin.json',
    '.claude-plugin/marketplace.json',
    '.codex-plugin/plugin.json',
  ]);
  const inDocsMarketplace = norm.startsWith('docs/marketplace/') || norm.startsWith('docs/submissions/');
  const inAllowlistedFile = ALLOWLISTED_URL_PATHS.has(norm);

  if ((inAllowlistedFile || inDocsMarketplace)) {
    // Check that the only gotzendorfer.at occurrences on this line are sanctioned URLs or emails
    const SANCTIONED_URL = /https?:\/\/gotzendorfer\.at\b/g;
    const allGotzOnLine = [...line.matchAll(/gotzendorfer\.at/g)];
    const sanctionedUrlMatches = [...line.matchAll(SANCTIONED_URL)];
    const emailMatches = [...line.matchAll(SANCTIONED_EMAILS)];
    const totalSanctioned = sanctionedUrlMatches.length + emailMatches.length;
    if (allGotzOnLine.length > 0 && allGotzOnLine.length === totalSanctioned) {
      return true;
    }
  }

  return false;
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

console.log('--- Check 11: owner-privacy leakage ---');

if (!existsSync(pluginRoot)) {
  fail(`plugin root does not exist: ${pluginRoot}`);
  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

const allFiles = getTrackedFiles();
const textFiles = allFiles.filter(isTextFile);

// Exclusions:
//   - .orchestrator/audits/** never scanned (A.2/A.4-5)
//   - This guard's own source file (pattern-doc-comments define the scanner — not leaks).
//   - This guard's own test file (string-literal fixtures exercise the detector — not leaks).
//   - Persona content-lint tests (assert template files don't contain leakage strings;
//     the assertion literals themselves match the scanner regex — fixtures, not leaks).
// Self-exclusions are the design-time fix for the latent bug exposed when scanner
// fixture files transition from untracked → tracked in the same commit that tightens
// detection (commit a68e94f for the original two; commit 95c8237 deep-3 W4 added the
// case-insensitive P6 regex + introduced content-lint.test.mjs in the same commit,
// producing a pre-commit false-pass — see pipeline #4365 / housekeeping-2 2026-05-19).
const SELF_EXCLUSIONS = new Set([
  'scripts/lib/validate/check-owner-leakage.mjs',
  'tests/lib/validate/check-owner-leakage.test.mjs',
  'tests/templates/personas/content-lint.test.mjs',
  'tests/husky/pre-commit-owner-leakage.test.mjs',
  // #634: encoding-contract fixtures (`-Users-bernhardg-` expected-value literals
  // are load-bearing for the resolveMemoryDir() assertions; P9 would self-flag them)
  'tests/lib/memory-paths.test.mjs',
]);
const scanFiles = textFiles.filter((f) => {
  const rel = relative(pluginRoot, f).replace(/\\/g, '/');
  if (rel.startsWith('.orchestrator/audits/')) return false;
  if (SELF_EXCLUSIONS.has(rel)) return false;
  return true;
});

/** @type {Array<{relPath: string, lineNum: number, pattern: string, lineContent: string}>} */
const violations = [];

for (const filePath of scanFiles) {
  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    continue; // unreadable — skip
  }

  const relPath = relative(pluginRoot, filePath).replace(/\\/g, '/');
  const lines = content.split('\n');

  lines.forEach((line, idx) => {
    const lineNum = idx + 1;

    // P1: personal home path
    if (P1.test(line)) {
      violations.push({ relPath, lineNum, pattern: 'P1 (personal home path)', lineContent: line.trim() });
    }

    // P2: private GitLab host
    if (P2.test(line)) {
      violations.push({ relPath, lineNum, pattern: 'P2 (gitlab.gotzendorfer.at)', lineContent: line.trim() });
    }

    // P3: private events domain — check exclusion 6 first
    if (P3.test(line)) {
      if (!isAllowlisted(relPath, line)) {
        violations.push({ relPath, lineNum, pattern: 'P3 (events.gotzendorfer.at)', lineContent: line.trim() });
      }
    }

    // P4: private package scope
    if (P4.test(line)) {
      violations.push({ relPath, lineNum, pattern: 'P4 (@goetzendorfer/ scope)', lineContent: line.trim() });
    }

    // P5: DEFAULT_GITLAB_HOST with gotzendorfer OR as exported const
    if (P5_WITH_GOTZ.test(line) && /gotzendorfer/.test(line)) {
      violations.push({ relPath, lineNum, pattern: 'P5 (DEFAULT_GITLAB_HOST on gotzendorfer line)', lineContent: line.trim() });
    } else if (P5_EXPORT.test(line)) {
      violations.push({ relPath, lineNum, pattern: 'P5 (DEFAULT_GITLAB_HOST exported const)', lineContent: line.trim() });
    }

    // P6: private project slugs
    for (let i = 0; i < P6_PATTERNS.length; i++) {
      if (P6_PATTERNS[i].test(line)) {
        violations.push({ relPath, lineNum, pattern: `P6 (private slug: ${PRIVATE_SLUGS[i]})`, lineContent: line.trim() });
        break; // one violation per line per slug is enough
      }
    }

    // P7: catch-all gotzendorfer.at — check exclusion allowlist
    if (P7.test(line)) {
      if (!isAllowlisted(relPath, line)) {
        violations.push({ relPath, lineNum, pattern: 'P7 (gotzendorfer.at catch-all)', lineContent: line.trim() });
      }
    }

    // P8: full RFC1918 private dotted-quad — internal IP leak (redaction-test fixtures exempt)
    if (P8.test(line) && !P8_ALLOWLIST.has(relPath)) {
      violations.push({ relPath, lineNum, pattern: 'P8 (RFC1918 private IP)', lineContent: line.trim() });
    }

    // P9: dash-encoded home path (Claude Code projects-dir encoding) — #634
    if (P9.test(line)) {
      violations.push({ relPath, lineNum, pattern: 'P9 (dash-encoded home path)', lineContent: line.trim() });
    }

    // P10: personal-name segment in a ~/Projects/<name>/ path (allowlisted migration fixtures exempt) — #653
    if (!P10_ALLOWLIST.has(relPath)) {
      for (const re of P10_PATTERNS) {
        if (re.test(line)) {
          violations.push({ relPath, lineNum, pattern: 'P10 (~/Projects/<name>/ personal segment)', lineContent: line.trim() });
          break;
        }
      }
    }
  });
}

// Deduplicate: P7 and P3 can overlap — de-dup by (relPath, lineNum, pattern)
// But P3 and P7 are distinct patterns so they'd produce separate entries.
// However, one line could match both P3 and P7 — treat as two violations.
// The spec does not say to deduplicate, so keep as-is.

if (violations.length === 0) {
  pass(`no owner-privacy leakage found across ${scanFiles.length} scanned files`);
} else {
  for (const v of violations) {
    fail(`${v.relPath}:${v.lineNum} — ${v.pattern}: ${v.lineContent.slice(0, 120)}`);
  }
}

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
