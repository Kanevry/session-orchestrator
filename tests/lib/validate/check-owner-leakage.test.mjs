/**
 * tests/lib/validate/check-owner-leakage.test.mjs
 *
 * Tests for scripts/lib/validate/check-owner-leakage.mjs (#471, epic #462).
 *
 * The check is a CLI script (not an importable module), so the end-to-end cases
 * exercise it via spawnSync(process.execPath, [SCRIPT, fixtureRoot]) against
 * tmpdir fixtures. The canonicalization helpers ARE exported (#661) and are
 * exercised in-process.
 *
 * Shape (consolidated, issue #985 Tier B): the checkpoint fixtures live in
 * tables (SCAN_CASES / CP11_CASES / DETECTED / CLEAN). Each CLI row asserts a
 * NORMALIZED verdict — `{ status, fails, checkpoints }`, where `checkpoints` is
 * parsed out of the `  FAIL: <path>:<line> — <CPn> …` report lines — against a
 * hardcoded literal. That is strictly stronger than the per-case
 * `expect(stdout).toContain('  FAIL:')` pairs it replaces:
 *   - a wrong-but-nonzero violation count now fails (was: any FAIL passed);
 *   - the ATTRIBUTED checkpoint is pinned, so a CP1 hit can no longer satisfy a
 *     row that means to exercise CP8/CP10/CP11 (substring `toContain('P8')` /
 *     `toContain('P10')` also matched CP-labels they were not aimed at).
 *
 * Kept as individual it() by design: the report-format contract, the
 * SELF_EXCLUSIONS path cases, and the Finding-2 regex-quote blanking cases
 * (line-scoped semantics a table would flatten into unreadability).
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
// #661: the scanner now exports its canonicalization helpers; the script is
// import-guarded (the top-level scan + process.exit only run when invoked as the
// CLI entry point), so importing these does NOT trigger a scan.
import {
  canonicalizeLine,
  matchOwnerPath,
  isOwnerLeakySegment,
  VAULT_CLEAR_SLUGS,
} from '../../../scripts/lib/validate/check-owner-leakage.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'lib', 'validate', 'check-owner-leakage.mjs');

const CP1_LABEL = 'CP1 (personal home path — canonicalized)';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a tmpdir repo containing `files` ({ relPath: content }).
 * git-init'd by default so `git ls-files` enumerates the fixture.
 * @param {Record<string,string>} files
 * @param {{initGit?: boolean}} [opts]
 * @returns {string} tmpdir path
 */
function makeTmpRepo(files, { initGit = true } = {}) {
  const root = mkdtempSync(join(os.tmpdir(), 'owner-leakage-test-'));
  if (initGit) {
    spawnSync('git', ['init', '-b', 'main'], { cwd: root, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: root, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root, encoding: 'utf8' });
  }
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(root, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  if (initGit) {
    // Stage all files so git ls-files can enumerate them
    spawnSync('git', ['add', '-A'], { cwd: root, encoding: 'utf8' });
  }
  return root;
}

/**
 * Write a host-local confidential-names JSON list OUTSIDE any scanned root and
 * return its path (CP11 resolves it via SO_CONFIDENTIAL_NAMES_FILE).
 * @param {string[]} names
 */
function writeNamesFile(names) {
  const namesDir = mkdtempSync(join(os.tmpdir(), 'owner-leakage-names-'));
  const namesFile = join(namesDir, 'confidential-names.json');
  writeFileSync(namesFile, JSON.stringify(names));
  return namesFile;
}

/**
 * Run the check CLI synchronously against a given root.
 * `names` semantics: undefined → inherit the ambient env; null → explicitly
 * unset SO_CONFIDENTIAL_NAMES_FILE (unconfigured-default case); array → inject
 * a real host-local names file.
 * @param {string} root
 * @param {string[]|null} [names]
 */
function runCheck(root, names) {
  const env =
    names === undefined
      ? process.env
      : { ...process.env, SO_CONFIDENTIAL_NAMES_FILE: names === null ? '' : writeNamesFile(names) };
  return spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8', timeout: 20_000, env });
}

/** Count occurrences of substring in string */
function countOccurrences(str, sub) {
  let count = 0;
  let pos = 0;
  while ((pos = str.indexOf(sub, pos)) !== -1) { count++; pos += sub.length; }
  return count;
}

/** The report lines: `  FAIL: <relPath>:<lineNum> — <CPn (label)>: <content>` */
function failLines(result) {
  return result.stdout.split('\n').filter((l) => l.startsWith('  FAIL:'));
}

/**
 * Normalize a CLI run into a comparable verdict. `checkpoints` is the DISTINCT,
 * report-order list of CP ids actually attributed — parsed from the label field,
 * so 'CP1' can never satisfy an expectation of 'CP10'/'CP11'.
 */
function summarizeScan(result) {
  const ids = failLines(result).map((l) => (l.match(/ — (CP\d+)/) || [])[1]);
  return {
    status: result.status,
    fails: ids.length,
    checkpoints: [...new Set(ids)],
  };
}

/**
 * CP11 verdict: adds the two privacy invariants — the redaction sentinel must be
 * present, and NO forbidden token (confidential name or suffix residue) may reach
 * stdout, because this scanner runs in a PUBLIC GitHub-Actions mirror.
 */
function summarizeRedaction(result, forbidden) {
  return {
    ...summarizeScan(result),
    redacted: result.stdout.includes('[REDACTED]'),
    echoed: forbidden.filter((token) => result.stdout.includes(token)),
  };
}

// ===========================================================================
// CLI scan verdicts — one row per checkpoint fixture.
// ===========================================================================

const SCAN_CASES = [
  // --- CP1: personal home path, slash form + #631 trailing/bare blindspots ---
  {
    name: 'CP1: plain /Users/<owner>/ path in a tracked .md',
    files: { 'leak.md': '# test\nPath: /Users/bernhardg/secret/config.txt\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP1'] },
  },
  {
    name: 'CP1: bare trailing-dot home path at end-of-line (#631)',
    files: { 'leak.md': 'home: /Users/bernhardg.\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP1'] },
  },
  {
    name: 'CP1: trailing-dot home path before " && ls" (#631)',
    files: { 'leak.sh': 'cd /Users/bernhardg. && ls\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP1'] },
  },
  {
    name: 'CP1: home=/Users/bernhardg. followed by a newline (#631)',
    files: { 'leak.txt': 'home=/Users/bernhardg.\nnext line\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP1'] },
  },
  {
    name: 'CP1: slash forms /Users/bernhardg./ and /…/Projects/x — one FAIL per line',
    files: { 'leak.md': 'a: /Users/bernhardg./\nb: /Users/bernhardg./Projects/x\n' },
    expected: { status: 1, fails: 2, checkpoints: ['CP1'] },
  },
  {
    name: 'CP1: bare /Users/bernhardg (no dot) at end-of-line — \\b arm of the regex',
    // Mutation guard: the OLD regex /\/Users\/bernhardg[a-z.]*\// required a slash
    // after the username, so this bare EOL form would NOT match → #631 class.
    files: { 'leak.txt': 'USER_HOME=/Users/bernhardg\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP1'] },
  },
  {
    name: 'CP1: /Users/bernhardg. inside a JSON string value',
    files: { 'config.json': '{"home": "/Users/bernhardg."}\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP1'] },
  },
  {
    name: 'CP1: env-assignment form BERNHARD_HOME=/Users/bernhardg. in a .sh file',
    files: { 'setup.sh': '#!/bin/sh\nBERNHARD_HOME=/Users/bernhardg.\nexport BERNHARD_HOME\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP1'] },
  },
  {
    name: 'CP1: two home paths on ONE line report a single per-line violation',
    files: { 'multi.sh': 'cp /Users/bernhardg./src /Users/bernhardg./dst\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP1'] },
  },
  {
    name: 'CP1: legacy full username /Users/bernhardgoetzendorfer/ (#605 drift class)',
    // Mutation: removing [a-z.]* from the username token makes this row fail.
    files: { 'legacy.md': 'Path: /Users/bernhardgoetzendorfer/projects/\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP1'] },
  },
  {
    name: 'CP1: hyphen-suffixed /Users/bernhardg-backup/ (owner prefix + non-word boundary)',
    files: { 'a.md': 'path: /Users/bernhardg-backup/x\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP1'] },
  },
  {
    name: 'CP1: dash-encoded Claude-Code projects-dir form (#634)',
    files: { 'doc.md': 'See .claude/projects/-Users-bernhardg--Projects-x/memory/foo.md for details\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP1'] },
  },
  {
    name: 'CP1 e2e: url-percent-encoded home path (#661 novel encoding)',
    files: { 'leak.md': 'config path: %2FUsers%2Fbernhardg%2Fsecret\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP1'] },
  },
  {
    name: 'CP1 e2e: backslash-separated home path (Windows-style spelling)',
    files: { 'leak.txt': String.raw`p=\Users\bernhardg\config` + '\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP1'] },
  },
  {
    name: 'CP1 e2e: homoglyph-slash home path (unicode evasion)',
    files: { 'leak.md': 'p=∕Users∕bernhardg∕secret\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP1'] },
  },
  {
    name: 'CP1 e2e: html-entity-encoded home path',
    files: { 'leak.md': 'p=&#47;Users&#47;bernhardg\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP1'] },
  },
  {
    name: 'CP1 e2e: capitalized username /Users/Bernhardg. (#661 Finding 1)',
    files: { 'leak.md': 'home: /Users/Bernhardg./Projects/secret\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP1'] },
  },
  {
    name: 'CP1 e2e: zero-width space spliced into the username (#661 Finding 3)',
    files: { 'leak.md': 'p: /Users/bern\u200bhardg/secret\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP1'] },
  },
  {
    name: 'CP1 e2e: percent-encoded LETTERS of the path (#661 Finding 4)',
    files: { 'leak.md': 'p: /%55sers/%62ernhardg/secret\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP1'] },
  },
  {
    name: 'CP1 e2e: home-path leak inside .env.example (dotfile-allowlist reachability)',
    // Mutation caught: reverting isTextFile() to extension-first (extname of
    // '.env.example' is '.example') skips the file entirely → status 0.
    files: { '.env.example': 'OWNER_HOME=/Users/bernhardg.\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP1'] },
  },

  // --- CP1 false-positive guards (near-miss usernames stay clean) ---
  {
    name: 'CLEAN: near-miss prefixes /Users/bernhardo-other/ and /Users/bernhardgXfoo',
    files: { 'clean.md': 'a: /Users/bernhardo-other/\nb: /Users/bernhardgXfoo\n' },
    expected: { status: 0, fails: 0, checkpoints: [] },
  },
  {
    name: 'CLEAN: lowercase /users/bernhardg. (CP1 host stays case-SENSITIVE)',
    files: { 'notes.md': 'see /users/bernhardg. for config\n' },
    expected: { status: 0, fails: 0, checkpoints: [] },
  },
  {
    name: 'CLEAN: digit continuation /Users/bernhardg9/ (different user)',
    files: { 'a.md': 'path: /Users/bernhardg9/proj\n' },
    expected: { status: 0, fails: 0, checkpoints: [] },
  },
  {
    name: 'CLEAN: underscore continuation /Users/bernhardg_home (different user)',
    files: { 'a.md': 'path: /Users/bernhardg_home\n' },
    expected: { status: 0, fails: 0, checkpoints: [] },
  },
  {
    name: 'CLEAN: dash-encoded path of a DIFFERENT user (alice)',
    files: { 'doc.md': 'See -Users-alice--Projects-x/memory/foo.md\n' },
    expected: { status: 0, fails: 0, checkpoints: [] },
  },
  {
    name: 'CLEAN: ordinary hyphenated prose (dash→slash canonicalization stays honest)',
    files: { 'clean.md': 'See multi-story autopilot and cross-repo audit notes.\n' },
    expected: { status: 0, fails: 0, checkpoints: [] },
  },
  {
    name: 'CLEAN: leak string only in a .png file (outside the TEXT_EXTS allowlist)',
    files: { 'image.png': '/Users/bernhardg./secret\n' },
    expected: { status: 0, fails: 0, checkpoints: [] },
  },
  {
    name: 'CLEAN: .env.example without a leak (still scanned, no false positive)',
    files: { '.env.example': 'API_URL=https://api.example.com\n' },
    expected: { status: 0, fails: 0, checkpoints: [] },
  },

  // --- CP2 / CP3 / CP4 / CP6 / CP7: hosts, domains, scopes, private slugs ---
  {
    name: 'CP2: private GitLab host (also trips the CP7 catch-all)',
    files: { 'config.md': 'host: gitlab.gotzendorfer.at\n' },
    expected: { status: 1, fails: 2, checkpoints: ['CP2', 'CP7'] },
  },
  {
    name: 'CP3: events domain as a string-literal (NOT the excluded doc-comment form)',
    files: { 'config.mjs': "const EVENTS_URL = 'https://events.gotzendorfer.at/hook';\n" },
    expected: { status: 1, fails: 2, checkpoints: ['CP3', 'CP7'] },
  },
  {
    name: 'CP3: events domain inside a JSON value',
    files: { 'settings.json': '{"webhookUrl": "https://events.gotzendorfer.at/webhook"}\n' },
    expected: { status: 1, fails: 2, checkpoints: ['CP3', 'CP7'] },
  },
  {
    name: 'CP4: @goetzendorfer/ package-scope import',
    files: { 'index.mjs': "import { createFactory } from '@goetzendorfer/testing-utils';\n" },
    expected: { status: 1, fails: 1, checkpoints: ['CP4'] },
  },
  {
    name: 'CP6: private project slug "buchhaltgenie"',
    files: { 'notes.md': 'See repo buchhaltgenie for details.\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP6'] },
  },
  {
    name: 'CP6: private project slug "AngebotsChecker" (case-insensitive)',
    files: { 'test.mjs': '// target: AngebotsChecker\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP6'] },
  },
  {
    name: 'CP6: carved-out slug "mail-assistant" STILL fails the tracked-file scan (#59 split proof)',
    files: { 'notes.md': 'Deploy notes for mail-assistant service.\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP6'] },
  },
  {
    name: 'CP6: carved-out slug "launchpad-ai-factory" STILL fails the tracked-file scan (#59)',
    files: { 'notes.md': 'See launchpad-ai-factory for the epic.\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP6'] },
  },
  {
    name: 'CLEAN: a slug that was never in PRIVATE_SLUGS is not flagged (fake-regression control)',
    files: { 'bogus-membership-check.md': 'Reference to totally-bogus-slug-never-in-private-slugs-xyz here.\n' },
    expected: { status: 0, fails: 0, checkpoints: [] },
  },

  // --- CP8: RFC1918 private IPs ---
  {
    name: 'CP8: 10.x.x.x private IP',
    files: { 'infra.md': '# Infra\nThe service runs at 10.1.2.3 internally.\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP8'] },
  },
  {
    name: 'CP8: 192.168.x.x and 172.16-31.x.x private IPs in two files',
    files: { 'a.md': 'gateway 192.168.1.1\n', 'b.md': 'host 172.20.0.5\n' },
    expected: { status: 1, fails: 2, checkpoints: ['CP8'] },
  },
  {
    name: 'CLEAN: placeholder .x forms and TEST-NET 192.0.2.x (SSRF docs stay clean)',
    files: {
      'ssrf.md': 'Blocks private ranges (10.x, 172.16-31.x, 192.168.x, 127.x). Example 192.0.2.1 (TEST-NET).\n',
    },
    expected: { status: 0, fails: 0, checkpoints: [] },
  },
  {
    name: 'CLEAN: 172.15 / 172.32 sit outside the private 16-31 range',
    files: { 'public.md': 'public 172.15.0.1 and 172.32.0.1\n' },
    expected: { status: 0, fails: 0, checkpoints: [] },
  },
  {
    name: 'CLEAN: the IP-redaction fixture file is CP8-allowlisted',
    files: { 'tests/scripts/export-hw-learnings.test.mjs': "const s = 'Server at 10.0.0.1 responded';\n" },
    expected: { status: 0, fails: 0, checkpoints: [] },
  },

  // --- CP10: personal-name segment in a Projects path (#653) ---
  {
    name: 'CP10: ~/Projects/Bernhard/vault (trailing-slash base case)',
    files: { 'config.yaml': 'vault-dir: ~/Projects/Bernhard/vault\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP10'] },
  },
  {
    name: 'CP10: BARE ~/Projects/Bernhard at end-of-line (Finding-1 regression guard)',
    // Mutation guard: the OLD mandatory-trailing-slash form would NOT match here.
    files: { 'notes.md': 'plan-baseline-path: ~/Projects/Bernhard\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP10'] },
  },
  {
    name: 'CP10: absolute /Users/<other-user>/Projects/Bernhard/x (Finding-3 defense-in-depth)',
    files: { 'ci.sh': 'cp /Users/someone/Projects/Bernhard/data ./out\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP10'] },
  },
  {
    name: 'CP10: absolute /home/<user>/Projects/Bernhard (Linux home, no trailing slash)',
    files: { 'ci.yml': 'workdir: /home/ci/Projects/Bernhard\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP10'] },
  },
  {
    name: 'CP10: the same legacy path at a NON-allowlisted file still fails (allowlist is path-scoped)',
    files: { 'somewhere-else.mjs': "const LEGACY = '~/Projects/Bernhard/vault';\n" },
    expected: { status: 1, fails: 1, checkpoints: ['CP10'] },
  },
  {
    name: 'CLEAN: ~/Projects/Bernhard inside a CP10_ALLOWLIST migration source',
    files: {
      'scripts/migrate-vault-paths.mjs': "const LEGACY = '~/Projects/Bernhard/vault';\nexport default LEGACY;\n",
    },
    expected: { status: 0, fails: 0, checkpoints: [] },
  },
  {
    name: 'CLEAN: ~/Projects/vault (no personal name)',
    files: { 'clean.yaml': 'vault-dir: ~/Projects/vault\n' },
    expected: { status: 0, fails: 0, checkpoints: [] },
  },
  {
    name: 'CLEAN: ~/Projects/Bernhardt/ (name merely BEGINS with a denylisted name)',
    files: { 'clean.md': 'path: ~/Projects/Bernhardt/app\n' },
    expected: { status: 0, fails: 0, checkpoints: [] },
  },
  {
    name: 'CLEAN: ~/Projects/MyApp/ (legit capitalized project dir)',
    files: { 'clean.md': 'cd ~/Projects/MyApp/src\n' },
    expected: { status: 0, fails: 0, checkpoints: [] },
  },

  // --- Sanctioned exclusions (public-facing owner references) ---
  {
    name: 'CLEAN: SECURITY.md with only security@gotzendorfer.at',
    files: { 'SECURITY.md': '# Security\n\n**Email:** security@gotzendorfer.at\n' },
    expected: { status: 0, fails: 0, checkpoints: [] },
  },
  {
    name: 'CLEAN: SECURITY.md with only office@gotzendorfer.at',
    files: { 'SECURITY.md': 'Contact: office@gotzendorfer.at for issues.\n' },
    expected: { status: 0, fails: 0, checkpoints: [] },
  },
  {
    name: 'CLEAN: README.md homepage URL',
    files: { 'README.md': '- [Homepage](https://gotzendorfer.at/en/session-orchestrator)\n' },
    expected: { status: 0, fails: 0, checkpoints: [] },
  },
  {
    name: 'CLEAN: .claude-plugin/plugin.json author email + url block',
    files: {
      '.claude-plugin/plugin.json':
        JSON.stringify(
          {
            name: 'test-plugin',
            author: { email: 'office@gotzendorfer.at', url: 'https://gotzendorfer.at' },
            homepage: 'https://gotzendorfer.at/en/session-orchestrator',
          },
          null,
          2,
        ) + '\n',
    },
    expected: { status: 0, fails: 0, checkpoints: [] },
  },
  {
    name: 'CLEAN: the exact events doc-comment contract line in events-default-url.test.mjs',
    files: {
      'tests/lib/events-default-url.test.mjs':
        [
          '/**',
          ' * Contract:',
          ' *   - No literal `events.gotzendorfer.at` URL appears anywhere in scripts/ or hooks/.',
          ' */',
          "import { describe, it } from 'vitest';",
          "describe('placeholder', () => { it('runs', () => {}); });",
        ].join('\n') + '\n',
    },
    expected: { status: 0, fails: 0, checkpoints: [] },
  },

  {
    // #1076 NEGATIVE PATH. Golden lines harvested verbatim from the three published
    // pages (site/index.html:39/57/58/64/66/68/1050, site/impressum/index.html:2/220,
    // site/datenschutz/index.html:2) — the exact 10 hits that adding '.html' to
    // TEXT_EXTS surfaced. All 10 are the www. host, which the pre-existing
    // SANCTIONED_URL form (bare domain right after the scheme) CANNOT match.
    // Bug caught: an exclusion that does not actually exclude — i.e. adding the three
    // paths to ALLOWLISTED_URL_PATHS without the SANCTIONED_PUBLIC_SITE form. That
    // combination turns the gate (and .husky/pre-commit) permanently red.
    // The impressum Website row carries TWO tokens on one line, so it also pins that
    // the sanctioned form is counted per-occurrence, not once per line.
    name: 'CLEAN: the published site pages — www. host in JSON-LD, rel="author" and the Impressum row',
    files: {
      'site/index.html':
        [
          '<script type="application/ld+json">{',
          '  "publisher": { "@id": "https://www.gotzendorfer.at/#person" },',
          '  "url": "https://www.gotzendorfer.at",',
          '}</script>',
          '<a href="https://www.gotzendorfer.at" rel="author">Maintainer</a>',
        ].join('\n') + '\n',
      'site/impressum/index.html':
        [
          '<!--',
          '  https://www.gotzendorfer.at/impressum. Die Datenschutzerklaerung ist NICHT',
          '-->',
          '<div><dt>Website</dt><dd><a href="https://www.gotzendorfer.at">www.gotzendorfer.at</a></dd></div>',
        ].join('\n') + '\n',
      'site/datenschutz/index.html':
        '<!--\n  https://www.gotzendorfer.at/impressum. Die Datenschutzerklaerung ist NICHT\n-->\n',
    },
    expected: { status: 0, fails: 0, checkpoints: [] },
  },

  // --- Exclusion bypass: an exclusion covers a LINE FORM, never a whole file ---
  {
    name: 'BYPASS: SECURITY.md with a real /Users/ home path still FAILs (email exclusion does not cover it)',
    files: { 'SECURITY.md': '**Email:** security@gotzendorfer.at\nSee: /Users/bernhardg/secret.key\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP1'] },
  },
  {
    name: 'BYPASS: events-default-url.test.mjs with a REAL string literal still FAILs',
    files: {
      'tests/lib/events-default-url.test.mjs':
        [
          '/**',
          ' *   - No literal `events.gotzendorfer.at` URL appears anywhere.',
          ' */',
          '// This is a real string literal (NOT the excluded doc-comment form):',
          "const HARDCODED = 'https://events.gotzendorfer.at/hook';",
        ].join('\n') + '\n',
    },
    expected: { status: 1, fails: 2, checkpoints: ['CP3', 'CP7'] },
  },

  {
    // #1076 BYPASS. The site exclusion is reached ONLY through isAllowlisted(), which
    // just CP3 and CP7 consult — so CP1 must still fire on an allowlisted page, on the
    // very line that carries the sanctioned URL. The home path is HTML-ENTITY encoded:
    // canonicalizeLine() has decoded entities since #661, but '.html' was outside
    // TEXT_EXTS, so that branch was unreachable for the only file class with native
    // entities. Bug caught: an exclusion written against a FILE instead of a LINE FORM
    // (e.g. a SELF_EXCLUSIONS entry), which would switch off all eleven CP rules here.
    name: 'BYPASS: entity-encoded home path on the sanctioned-URL line of an allowlisted site page still FAILs',
    files: {
      'site/impressum/index.html':
        [
          '<div><dt>Website</dt><dd><a href="https://www.gotzendorfer.at">www.gotzendorfer.at</a></dd></div>',
          '<!-- &#47;Users&#47;bernhardg&#47;Projects&#47;PLACEHOLDER <a href="https://www.gotzendorfer.at">x</a> -->',
        ].join('\n') + '\n',
    },
    expected: { status: 1, fails: 1, checkpoints: ['CP1'] },
  },
  {
    // #1076 PATH SCOPE. Bug caught: the exclusion degrading into a blanket allowance
    // for the www. domain anywhere in the tree.
    name: 'BYPASS: the same www. link text in templates/static-html/index.html is NOT allowlisted',
    files: {
      'templates/static-html/index.html':
        '<a href="https://www.gotzendorfer.at" rel="author">Maintainer</a>\n',
    },
    expected: { status: 1, fails: 1, checkpoints: ['CP7'] },
  },
  {
    // #1076 PATH SCOPE, sharper arm: site/guide/index.html is a tracked sibling INSIDE
    // site/ that carries zero domain hits today and is deliberately NOT allowlisted.
    // Bug caught: implementing the exclusion as a `site/` PREFIX test rather than the
    // three exact paths — which the templates/ row above would not detect.
    name: 'BYPASS: site/guide/index.html is inside site/ but NOT allowlisted (exact paths, not a prefix)',
    files: {
      'site/guide/index.html':
        '<a href="https://www.gotzendorfer.at" rel="author">Maintainer</a>\n',
    },
    expected: { status: 1, fails: 1, checkpoints: ['CP7'] },
  },

  // =========================================================================
  // #1080 Finding A — the canonical form now feeds the four DOT-anchored rules.
  //
  // Bug these rows catch: until #1080, matchOwnerPath (CP1) was the ONLY consumer
  // of canonicalizeLine(). CP2-CP8/CP10/CP11 each tested the RAW line, so an
  // entity-encoded private host inside an href — a link the BROWSER resolves and
  // the scanner did not — reported nothing. Reproduced before the fix: the raw
  // host FAILed CP2+CP7 while every encoded spelling below scanned CLEAN.
  //
  // Each row pins the ATTRIBUTED checkpoint AND the fail COUNT, so a regression
  // that double-reports (raw hit + canonical hit pushed as two violations) fails
  // just as loudly as one that stops detecting.
  // =========================================================================
  {
    name: '#1080 A: entity-encoded private GitLab host in an .html link → CP2 + CP7',
    files: { 'site/guide/index.html': '<a href="https://gitlab&#46;gotzendorfer&#46;at/runner">CI</a>\n' },
    expected: { status: 1, fails: 2, checkpoints: ['CP2', 'CP7'] },
  },
  {
    name: '#1080 A: percent-encoded private GitLab host → CP2 + CP7 (same axis, other encoding)',
    files: { 'site/guide/index.html': '<a href="https://gitlab%2Egotzendorfer%2Eat/runner">CI</a>\n' },
    expected: { status: 1, fails: 2, checkpoints: ['CP2', 'CP7'] },
  },
  {
    name: '#1080 A: hex-entity private GitLab host → CP2 + CP7',
    files: { 'site/guide/index.html': '<a href="https://gitlab&#x2E;gotzendorfer&#x2E;at/x">y</a>\n' },
    expected: { status: 1, fails: 2, checkpoints: ['CP2', 'CP7'] },
  },
  {
    name: '#1080 A: entity-encoded events domain → CP3 + CP7',
    files: { 'site/guide/index.html': '<img src="https://events&#46;gotzendorfer&#46;at/px.gif">\n' },
    expected: { status: 1, fails: 2, checkpoints: ['CP3', 'CP7'] },
  },
  {
    name: '#1080 A: entity-encoded RFC1918 quad → CP8',
    files: { 'site/guide/index.html': '<!-- runner 10&#46;11&#46;12&#46;13 -->\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP8'] },
  },
  {
    // The sharpest arm. On an ALLOWLISTED page every RAW gotzendorfer.at token is
    // the sanctioned www. publication, so isAllowlisted(raw) is true. A naive fix
    // ("if raw OR canonical matches, then consult isAllowlisted(raw)") would let
    // that verdict cover the ENCODED private host riding on the same line — the
    // exclusion would launder the leak. The occurrence-count split (canonical token
    // count > raw token count, therefore decoded, therefore bypasses the allowlist)
    // is what closes it. Paired with the CLEAN row below, which proves the allowlist
    // is still doing its job rather than having been switched off.
    name: '#1080 A: sanctioned www. URL + an encoded private host on ONE allowlisted line still FAILs',
    files: {
      'site/index.html':
        '<a href="https://www.gotzendorfer.at" rel="author">M</a><!-- gitlab&#46;gotzendorfer&#46;at -->\n',
    },
    expected: { status: 1, fails: 2, checkpoints: ['CP2', 'CP7'] },
  },
  {
    name: '#1080 A: the same allowlisted page WITHOUT an encoded token stays CLEAN (allowlist intact)',
    files: { 'site/index.html': '<a href="https://www.gotzendorfer.at" rel="author">M</a>\n' },
    expected: { status: 0, fails: 0, checkpoints: [] },
  },
  {
    // No-double-count pin. A RAW host matches the raw line AND its canonical form
    // (canonicalization is a no-op on a dot-separated domain). Two separate per-rule
    // conditionals would report 4 here; the single OR-ed conditional reports 2.
    name: '#1080 A: a raw host matching BOTH forms still reports exactly 2 (no double-count)',
    files: { 'c.md': 'host: gitlab.gotzendorfer.at\n' },
    expected: { status: 1, fails: 2, checkpoints: ['CP2', 'CP7'] },
  },
  {
    // CP6 is DELIBERATELY left raw: canonicalization folds dash runs to slashes,
    // which SHREDS five of the seven private slugs (mail-assistant becomes
    // mail/assistant), so a canonical CP6 test is a no-op at best. This row pins the
    // other direction — the dash folding must not MANUFACTURE a slug hit out of
    // ordinary hyphenation.
    name: '#1080 A: CP6 stays raw — benign hyphenated prose is not folded into a slug hit',
    files: { 'clean.md': 'The buchhalt-genie tool and the angebots-checker script are unrelated.\n' },
    expected: { status: 0, fails: 0, checkpoints: [] },
  },
  {
    name: '#1080 A: CP6 dash-bearing slug still fires on the RAW line (unchanged by the canonical pass)',
    files: { 'notes.md': 'Deploy notes for mail-assistant service.\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP6'] },
  },

  // =========================================================================
  // #1080 Finding B — .xml / .svg / .css joined the PUBLICLY-SHIPPED scan set.
  //
  // Bug these rows catch: site/sitemap.xml and site/favicon.svg sit in the same
  // published directory as the .html pages the previous wave gated, carry the same
  // consequence, and were skipped by isTextFile(). Reproduced with one identical
  // planted defect per class: the .html and .txt copies FAILed, the .xml and .svg
  // copies reported nothing. .png stays out (see the pre-existing CLEAN row above),
  // so the allowlist is proven to be an allowlist and not a scan-everything.
  // =========================================================================
  {
    name: '#1080 B: planted private host in site/sitemap.xml → CP2 + CP7',
    files: { 'site/sitemap.xml': '<loc>https://gitlab.gotzendorfer.at/x</loc>\n' },
    expected: { status: 1, fails: 2, checkpoints: ['CP2', 'CP7'] },
  },
  {
    name: '#1080 B: planted private host in site/favicon.svg → CP2 + CP7',
    files: { 'site/favicon.svg': '<svg><desc>gitlab.gotzendorfer.at</desc></svg>\n' },
    expected: { status: 1, fails: 2, checkpoints: ['CP2', 'CP7'] },
  },
  {
    name: '#1080 B: planted private host in a .css file → CP2 + CP7',
    files: { 'templates/static-html/styles.css': '/* gitlab.gotzendorfer.at */\n' },
    expected: { status: 1, fails: 2, checkpoints: ['CP2', 'CP7'] },
  },
  {
    name: '#1080 B: an entity-encoded home path in .svg → CP1 (findings A and B compose)',
    files: { 'site/favicon.svg': '<svg><desc>&#47;Users&#47;bernhardg&#47;PLACEHOLDER</desc></svg>\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP1'] },
  },

  // --- Edge: empty repo / no-git dir ---
  {
    name: 'EDGE: empty git repo (no tracked files)',
    files: {},
    expected: { status: 0, fails: 0, checkpoints: [] },
  },
  {
    name: 'EDGE: non-git dir with a clean text file',
    files: { 'clean.md': '# Hello world\n' },
    initGit: false,
    expected: { status: 0, fails: 0, checkpoints: [] },
  },
];

describe('check-owner-leakage CLI — checkpoint scan verdicts', () => {
  it.each(SCAN_CASES)('$name', ({ files, initGit = true, expected }) => {
    const root = makeTmpRepo(files, { initGit });
    expect(summarizeScan(runCheck(root))).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// Report-format contract — the two report shapes the table normalizes away.
// ---------------------------------------------------------------------------

describe('check-owner-leakage CLI — report format', () => {
  it('emits a PASS line (not silence) when nothing is found', () => {
    const root = makeTmpRepo({
      'README.md': '# Clean Plugin\n\nNo private data here.\n',
      'index.mjs': '// clean file\nexport default {};\n',
    });
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('  PASS:');
    expect(countOccurrences(result.stdout, '  FAIL:')).toBe(0);
  });

  it('names the offending file and line number in the FAIL line', () => {
    const root = makeTmpRepo({ 'leak.md': '# doc\nrun: /Users/bernhardg./Projects/foo/bar.mjs\n' });
    const result = runCheck(root);
    expect(failLines(result)[0]).toContain(`leak.md:2 — ${CP1_LABEL}`);
  });
});

// ---------------------------------------------------------------------------
// SELF_EXCLUSIONS — detection-fixture files whose assertion literals MUST
// contain leak strings. Kept as individual it()s: the contract is about a
// specific tracked PATH, and the pairing with the path-scoped negative below is
// what proves the exclusion is not a blanket content exemption.
// Regression guard for pipeline #4365 / housekeeping-2 2026-05-19.
// ---------------------------------------------------------------------------

describe('SELF_EXCLUSIONS: detection-fixture files are exempt by PATH', () => {
  // tests/husky/pre-commit-owner-leakage.test.mjs plants real leak literals to
  // prove the pre-commit hook blocks them; the scanner would otherwise flag its
  // own fixtures. Any SELF_EXCLUSIONS member works as the subject here — this
  // one is deliberately NOT the persona content-lint entry, whose membership is
  // in flux.
  const SELF_EXCLUDED_PATH = 'tests/husky/pre-commit-owner-leakage.test.mjs';
  const FIXTURE_BODY = [
    "import { describe, it, expect } from 'vitest';",
    "describe('owner-leakage guard', () => {",
    "  it('blocks a personal home path', () => {",
    "    expect(hookOutput).toContain('/Users/bernhardg./Projects/x');",
    '  });',
    "  it('blocks a private repo name buchhaltgenie', () => {",
    "    expect(content).not.toContain('buchhaltgenie');",
    '  });',
    '});',
    '',
  ].join('\n');

  it('exits 0 when leak literals appear inside a SELF_EXCLUSIONS file', () => {
    const root = makeTmpRepo({ [SELF_EXCLUDED_PATH]: FIXTURE_BODY });
    const result = runCheck(root);
    expect(summarizeScan(result)).toEqual({ status: 0, fails: 0, checkpoints: [] });
  });

  it('still flags the SAME literals at a different path (exclusion is path-scoped)', () => {
    // 3 violations: the home-path line (CP1) + BOTH lines naming the private
    // slug (CP6) — the it()-title line and the assertion line.
    const root = makeTmpRepo({ 'somewhere-else.test.mjs': FIXTURE_BODY });
    const result = runCheck(root);
    expect(summarizeScan(result)).toEqual({ status: 1, fails: 3, checkpoints: ['CP1', 'CP6'] });
  });
});

// ===========================================================================
// #661: Canonicalization-before-matching — regression CORPUS
//
// The one-encoding-at-a-time regex treadmill (P1 slash-form #631, P9
// dash-encoded #634, …) is replaced by a single canonicalization step. These
// rows pin that every historical evasion variant AND a panel of NOVEL encodings
// canonicalize to the same /Users/bernhardg… form and are DETECTED, while the
// lookalike negatives and the case-sensitivity contract are NOT flagged.
// Expected values are hardcoded literals (the CP1 label / null).
// ===========================================================================

describe('#661 corpus: matchOwnerPath — historical + novel encodings DETECTED', () => {
  const DETECTED = [
    ['CP1 plain slash-form', '/Users/bernhardg/secret/config.txt'],
    ['CP1 trailing-dot', 'home: /Users/bernhardg.'],
    ['CP1 bare no-dot at EOL (#631)', 'USER_HOME=/Users/bernhardg'],
    ['CP1 before " && ls" (#631)', 'cd /Users/bernhardg. && ls'],
    ['CP1 inside JSON quotes', '{"home": "/Users/bernhardg."}'],
    ['CP1 hyphen-suffixed', 'path: /Users/bernhardg-backup/x'],
    ['CP1 full legacy username', 'Path: /Users/bernhardgoetzendorfer/projects/'],
    ['CP1 full legacy username, bare trailing slash', '/Users/bernhardgoetzendorfer/'],
    ['dash-encoded projects-dir (#634)', 'See -Users-bernhardg--Projects-x/memory/foo.md'],
    ['dash-encoded bare', 'dir=-Users-bernhardg'],
    ['NOVEL url-percent encoded', 'p=%2FUsers%2Fbernhardg%2Fsecret'],
    ['NOVEL url-percent uppercase hex', 'p=%2fUsers%2fbernhardg'],
    ['NOVEL double-percent encoded', 'p=%252FUsers%252Fbernhardg'],
    ['NOVEL backslash separators', String.raw`p=\Users\bernhardg\secret`],
    ['NOVEL homoglyph division-slash (∕)', 'p=∕Users∕bernhardg∕secret'],
    ['NOVEL homoglyph fullwidth-slash (／)', 'p=／Users／bernhardg'],
    ['NOVEL html numeric entity (&#47;)', 'p=&#47;Users&#47;bernhardg'],
    ['NOVEL html hex entity (&#x2F;)', 'p=&#x2F;Users&#x2F;bernhardg'],
    ['NOVEL html named entity (&sol;)', 'p=&sol;Users&sol;bernhardg'],
    // Finding 1 (HIGH): username matched case-INSENSITIVELY (real path on APFS).
    ['Finding 1: capitalized username', '/Users/Bernhardg./Projects/secret'],
    ['Finding 1: lowercase control', '/Users/bernhardg/secret'],
    // Finding 3 (MED): zero-width / format chars spliced into the username.
    ['Finding 3: zero-width space in username', '/Users/bern\u200bhardg/secret'],
    ['Finding 3: soft-hyphen in username', '/Users/bern\u00adhardg/secret'],
    ['Finding 3: tab in username', '/Users/bern\thardg/secret'],
    // Findings 4+5 (LOW): decoders cover LETTERS, and loop to a FIXPOINT.
    ['Finding 4: percent-encoded letters', '/%55sers/%62ernhardg/secret'],
    ['Finding 4: decimal entity for a letter', '/&#85;sers/bernhardg/secret'],
    ['Finding 4: hex entity for a letter', '/&#x55;sers/bernhardg/secret'],
    ['Finding 5: NESTED double-percent letter encoding (%2555 → %55 → U)', '/%2555sers/%2562ernhardg/secret'],
  ];

  it.each(DETECTED)('DETECTS: %s', (_label, line) => {
    expect(matchOwnerPath(line)).toBe(CP1_LABEL);
  });
});

describe('#661 corpus: matchOwnerPath — benign + lookalike NOT flagged', () => {
  const CLEAN = [
    ['near-miss diverges before g (bernhardo)', '/Users/bernhardo-other/'],
    ['near-miss uppercase continuation (bernhardgXfoo)', '/Users/bernhardgXfoo'],
    ['near-miss digit continuation (bernhardg9)', '/Users/bernhardg9/proj'],
    ['near-miss underscore continuation (bernhardg_home)', '/Users/bernhardg_home'],
    ['case-sensitivity contract: lowercase /users', 'see /users/bernhardg. for config'],
    ['case-sensitivity contract: lowercase /users with path', '/users/bernhardg/x'],
    ['other-user dash-encoded (alice)', '-Users-alice--Projects-x/memory/foo.md'],
    ['self-doc: quotes old P1 regex', 'P1 regex `/\\/Users\\/bernhardg[a-z.]*(\\/|\\b)/` is tight'],
    ['self-doc: quotes P9 dash regex', 'added P9 `/-Users-bernhardg[a-z.]*-/`'],
    ['benign capitalized project dir', '~/Projects/MyApp/src'],
    ['benign clean url', 'API_URL=https://api.example.com'],
    ['benign unrelated percent escape (%20)', 'cache%20dir is fine'],
    ['empty string', ''],
  ];

  it.each(CLEAN)('CLEAN: %s', (_label, line) => {
    expect(matchOwnerPath(line)).toBe(null);
  });
});

describe('#661 corpus: canonicalizeLine — separator normalization (case preserved)', () => {
  const NORMALIZES = [
    ['url-percent slashes', '%2FUsers%2Fbernhardg', '/Users/bernhardg'],
    ['backslash separators', String.raw`\Users\bernhardg`, '/Users/bernhardg'],
    ['dash-encoded projects-dir', '-Users-bernhardg--Projects-x', '/Users/bernhardg'],
    ['homoglyph division-slash (∕)', '∕Users∕bernhardg', '/Users/bernhardg'],
    ['html numeric entity &#47;', '&#47;Users&#47;bernhardg', '/Users/bernhardg'],
    // Case-sensitivity contract: uppercase continuation survives so the
    // lowercase-only [a-z.]* username token stops at it.
    ['uppercase username continuation is preserved', '/Users/bernhardgXfoo', 'bernhardgX'],
  ];

  it.each(NORMALIZES)('canonicalizes %s', (_label, input, expectedSubstring) => {
    expect(canonicalizeLine(input)).toContain(expectedSubstring);
  });

  it('PRESERVES letter case — a lowercase /users path is never upper-cased into a false hit', () => {
    expect(canonicalizeLine('/users/bernhardg.')).not.toContain('/Users/bernhardg');
  });
});

// ---------------------------------------------------------------------------
// #661 Finding 2 (MED) — regex-quote blanking is TOKEN-scoped, not line-scoped.
// Kept as individual it()s: the whole point is that ONE line carries both a
// quoted regex and (sometimes) a real path, which a fixture table flattens.
// ---------------------------------------------------------------------------

describe('#661 follow-up: Finding 2 — regex-quote blanks only the token, not the line', () => {
  it('DETECTS a real path on a line that ALSO quotes the scanner regex (residue re-scan)', () => {
    // The real `/Users/bernhardg/Projects/secret` shares the line with a quoted
    // regex `/Users/bernhardg[a-z.]*`. Before the fix the whole line was
    // suppressed; now only the `…bernhardg[` token is blanked and the real path
    // is caught.
    expect(
      matchOwnerPath('Real: /Users/bernhardg/Projects/secret (see regex /Users/bernhardg[a-z.]*)'),
    ).toBe(CP1_LABEL);
  });

  it('CLEAN on a line that ONLY quotes the old P1 regex (self-doc, no real path)', () => {
    expect(matchOwnerPath('P1 regex `/\\/Users\\/bernhardg[a-z.]*(\\/|\\b)/` is tight')).toBe(null);
  });

  it('CLEAN on a line that ONLY quotes the P9 dash regex (self-doc)', () => {
    expect(matchOwnerPath('added P9 `/-Users-bernhardg[a-z.]*-/`')).toBe(null);
  });

  it('exits 1 end-to-end when a real leak shares a line with a quoted regex', () => {
    const root = makeTmpRepo({
      'doc.md': 'Real: /Users/bernhardg/Projects/secret (see regex /Users/bernhardg[a-z.]*)\n',
    });
    expect(summarizeScan(runCheck(root))).toEqual({ status: 1, fails: 1, checkpoints: ['CP1'] });
  });
});

// ===========================================================================
// CP11: host-local confidential customer/repo names (#728a)
//
// The names list is HOST-LOCAL and never committed; the CLI resolves it via
// resolveHostPath('confidential-names-file', …), whose highest-precedence tier
// is the env-var SO_CONFIDENTIAL_NAMES_FILE. Rows inject a real temp names JSON
// via that env-var, written OUTSIDE the scanned root so the names file itself is
// never a scan subject. Fixture names are invented ('zenithcorp') — never a real
// confidential name (confidentiality invariant).
//
// LOAD-BEARING: `echoed: []` — a CP11 hit must REDACT every configured name (and
// every suffix residue) from stdout, because the checker runs in a PUBLIC
// GitHub-Actions mirror; the name must NOT appear in the CI log even when the
// guard fires.
// ===========================================================================

const CP11_CASES = [
  {
    name: 'CP11: a configured confidential name FAILs and is redacted from the report',
    files: { 'notes.md': '# Client work\nContract signed with zenithcorp GmbH.\n' },
    names: ['zenithcorp'],
    forbidden: ['zenithcorp'],
    expected: { status: 1, fails: 1, checkpoints: ['CP11'], redacted: true, echoed: [] },
  },
  {
    name: 'CP11: matches case-insensitively and redacts EVERY occurrence on the line',
    files: { 'notes.md': 'ZenithCorp and zenithcorp are the same client.\n' },
    names: ['zenithcorp'],
    forbidden: ['ZenithCorp', 'zenithcorp'],
    expected: { status: 1, fails: 1, checkpoints: ['CP11'], redacted: true, echoed: [] },
  },
  {
    name: 'CP11: a line naming TWO different configured names redacts BOTH',
    // Redacting only the FIRST matching pattern (and breaking) would echo the
    // SECOND NDA name verbatim to the public log — a worse leak than the guard.
    files: { 'notes.md': 'zenithcorp and apexglobal are both clients.\n' },
    names: ['zenithcorp', 'apexglobal'],
    forbidden: ['zenithcorp', 'apexglobal'],
    expected: { status: 1, fails: 1, checkpoints: ['CP11'], redacted: true, echoed: [] },
  },
  {
    name: 'CP11 Fix 1: a name riding in on a CP8 hit is scrubbed at the print choke-point',
    // Pre-fix RED: the CP8 FAIL line printed the confidential name verbatim.
    files: { 'infra.md': 'zenithcorp server runs at 10.1.2.3 internally\n' },
    names: ['zenithcorp'],
    forbidden: ['zenithcorp'],
    expected: { status: 1, fails: 2, checkpoints: ['CP8', 'CP11'], redacted: true, echoed: [] },
  },
  {
    name: 'CP11 Fix 2 ORDER A [short,long]: prefix name leaves no suffix residue',
    files: { 'notes.md': 'The acme-corp-secret-project launches soon.\n' },
    names: ['acme', 'acme-corp-secret-project'],
    forbidden: ['acme-corp-secret-project', '-corp-secret-project'],
    expected: { status: 1, fails: 1, checkpoints: ['CP11'], redacted: true, echoed: [] },
  },
  {
    name: 'CP11 Fix 2 ORDER B [long,short]: same input, list order reversed, still fully redacted',
    files: { 'notes.md': 'The acme-corp-secret-project launches soon.\n' },
    names: ['acme-corp-secret-project', 'acme'],
    forbidden: ['acme-corp-secret-project', '-corp-secret-project'],
    expected: { status: 1, fails: 1, checkpoints: ['CP11'], redacted: true, echoed: [] },
  },
  {
    name: 'CP11: a tracked file with no configured name PASSes',
    files: { 'notes.md': 'We onboarded a new client this week.\n' },
    names: ['zenithcorp'],
    forbidden: [],
    expected: { status: 0, fails: 0, checkpoints: [], redacted: false, echoed: [] },
  },
  {
    name: 'CP11 is INACTIVE with an empty configured list',
    files: { 'notes.md': 'Mentions zenithcorp explicitly.\n' },
    names: [],
    forbidden: [],
    expected: { status: 0, fails: 0, checkpoints: [], redacted: false, echoed: [] },
  },
  {
    name: 'CP11 is INACTIVE when no confidential-names file is configured (default on every host/CI)',
    files: { 'notes.md': 'A synthetic token zenithcorp-unconfigured appears here.\n' },
    names: null,
    forbidden: [],
    expected: { status: 0, fails: 0, checkpoints: [], redacted: false, echoed: [] },
  },
];

describe('CP11: confidential-name leak (host-local list)', () => {
  it.each(CP11_CASES)('$name', ({ files, names, forbidden, expected }) => {
    const root = makeTmpRepo(files);
    expect(summarizeRedaction(runCheck(root, names), forbidden)).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// VAULT_CLEAR_SLUGS carve-out — in-process guard vs tracked-file scan (#59)
//
// The SPLIT (owner decision 2026-07-18): five slugs are cleared for use as an
// IN-PROCESS vault-namespace segment (isOwnerLeakySegment returns null) while
// STILL being blocked from leaking into TRACKED public-mirror files (the CLI
// still exits 1 — pinned by the CP6 rows in SCAN_CASES above).
// isOwnerLeakySegment returns null when clean, or the pattern id string
// ('CP1'|'CP6'|'CP10') when leaky — asserted on that shape.
// ---------------------------------------------------------------------------

describe('VAULT_CLEAR_SLUGS carve-out — isOwnerLeakySegment (in-process guard)', () => {
  const SEGMENTS = [
    ['carved-out slug', 'buchhaltgenie', null],
    ['carved-out slug, mixed case', 'BuchhaltGenie', null],
    ['carved-out slug, upper case', 'MAIL-ASSISTANT', null],
    ['carved-out slug, camel case', 'AngebotsChecker', null],
    // The carve-out did NOT blanket-disable CP6 — retained slugs still bite.
    ['retained slug', 'aiat-pmo-module', 'CP6'],
    ['retained slug, mixed case', 'Codex-Hackathon', 'CP6'],
  ];

  it.each(SEGMENTS)('%s "%s" → %s', (_label, segment, expected) => {
    expect(isOwnerLeakySegment(segment)).toBe(expected);
  });

  it('every VAULT_CLEAR_SLUGS member is cleared in-process, and the set has 5 members', () => {
    const leaky = [...VAULT_CLEAR_SLUGS].filter((slug) => isOwnerLeakySegment(slug) !== null);
    expect(leaky).toEqual([]);
    expect(VAULT_CLEAR_SLUGS.size).toBe(5); // integrity-anchor: closed, audit-reviewed carve-out list (#59)
  });
});

// ---------------------------------------------------------------------------
// Subset invariant: VAULT_CLEAR_SLUGS ⊆ PRIVATE_SLUGS
//
// PRIVATE_SLUGS is not exported (it is the CLOSED, audit-reviewed source list),
// so the invariant is checked through the CLI: CP6_PATTERNS is built DIRECTLY
// from PRIVATE_SLUGS, so "does the tracked-file scan flag this slug as CP6" is
// ground truth for "is this slug a member of PRIVATE_SLUGS".
//
// Why this matters: `isOwnerLeakySegment(slug) === null` is TAUTOLOGICAL for a
// typo'd/dead VAULT_CLEAR_SLUGS entry — ANY string never in PRIVATE_SLUGS also
// returns null, so a bogus carve-out entry ('buchhaltgeni') would pass review
// with zero test failure. The fake-regression control for this loop is the
// 'a slug that was never in PRIVATE_SLUGS is not flagged' row in SCAN_CASES:
// it pins that a non-member scans CLEAN, so the rows below have teeth.
// No slug value is hardcoded — the table drives off the exported set.
// ---------------------------------------------------------------------------

describe('Subset invariant: VAULT_CLEAR_SLUGS ⊆ PRIVATE_SLUGS (#59)', () => {
  it.each([...VAULT_CLEAR_SLUGS])('carve-out member "%s" is a real PRIVATE_SLUGS entry (CP6 catches it)', (slug) => {
    const root = makeTmpRepo({ 'membership-check.md': `Reference to ${slug} here.\n` });
    expect(summarizeScan(runCheck(root))).toEqual({ status: 1, fails: 1, checkpoints: ['CP6'] });
  });
});
