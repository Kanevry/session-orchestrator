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

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, cpSync, symlinkSync, realpathSync, unlinkSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// #661: the scanner now exports its canonicalization helpers; the script is
// import-guarded (the top-level scan + process.exit only run when invoked as the
// CLI entry point), so importing these does NOT trigger a scan.
import {
  canonicalizeLine,
  matchOwnerPath,
  isOwnerLeakySegment,
  VAULT_CLEAR_SLUGS,
  getConfidentialNamePatterns,
  inspectOwnerPatterns,
} from '../../../scripts/lib/validate/check-owner-leakage.mjs';
import { loadHostPaths } from '../../../scripts/lib/config/host-paths.mjs';
import { fixtureGitSpawn, makeTmpDir } from '../../_helpers/tmp-fixture.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const inventedOwnerPolicyDir = makeTmpDir('invented-owner-policy-');
const inventedOwnerPolicyPath = join(inventedOwnerPolicyDir, 'owner-patterns.json');
writeFileSync(inventedOwnerPolicyPath, JSON.stringify({
  version: 1, usernamePrefixes: ['sampleg'], privateHosts: ['gitlab.example.invalid'], eventsHosts: ['events.example.invalid'], privateDomains: ['example.invalid'], packageScopes: ['example'],
  privateSlugs: ['project-launchpad','Project-Hackathon','project-ledger','Project-Quotes','project-climate','project-private-module','project-mail'],
  vaultClearSlugs: ['project-ledger','project-mail','project-climate','project-launchpad','project-quotes'], personalNames: ['Sample'],
  publicEmails: ['office@example.invalid','security@example.invalid'], publicUrls: ['https://example.invalid','http://example.invalid','https://www.example.invalid','http://www.example.invalid','www.example.invalid'],
}), {mode: 0o600});
vi.stubEnv('SO_OWNER_PATTERNS_FILE', inventedOwnerPolicyPath);
inspectOwnerPatterns({refresh:true});
beforeEach(() => { vi.stubEnv('SO_OWNER_PATTERNS_FILE', inventedOwnerPolicyPath); });

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
  const root = makeTmpDir('owner-leakage-test-');
  if (initGit) {
    fixtureGitSpawn(['init', '-b', 'main'], root);
    fixtureGitSpawn(['config', 'user.email', 'test@test.com'], root);
    fixtureGitSpawn(['config', 'user.name', 'Test'], root);
  }
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(root, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  if (initGit) {
    // Stage all files so git ls-files can enumerate them
    fixtureGitSpawn(['add', '-A'], root);
  }
  return root;
}

/**
 * Write a host-local confidential-names JSON list OUTSIDE any scanned root and
 * return its path (CP11 resolves it via SO_CONFIDENTIAL_NAMES_FILE).
 * @param {string[]} names
 */
function writeNamesFile(names) {
  const namesDir = makeTmpDir('owner-leakage-names-');
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
 * @param {string[]} [args]
 */
function runCheck(root, names, args = []) {
  const env =
    names === undefined
      ? process.env
      : { ...process.env, SO_CONFIDENTIAL_NAMES_FILE: names === null ? '' : writeNamesFile(names) };
  return spawnSync(process.execPath, [SCRIPT, root, ...args], { encoding: 'utf8', timeout: 20_000, env });
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
    files: { 'leak.md': '# test\nPath: /Users/sampleg/secret/config.txt\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP1'] },
  },
  {
    name: 'CP1: tracked MDX content is scanned (#1267)',
    files: { 'post.mdx': '<Note>See /Users/sampleg/private</Note>\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP1'] },
  },
  {
    name: 'CLEAN: tracked MDX content without leakage (#1267)',
    files: { 'post.mdx': '<Note>See ~/Projects/example</Note>\n' },
    expected: { status: 0, fails: 0, checkpoints: [] },
  },
  {
    name: 'CP1: bare trailing-dot home path at end-of-line (#631)',
    files: { 'leak.md': 'home: /Users/sampleg.\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP1'] },
  },
  {
    name: 'CP1: trailing-dot home path before " && ls" (#631)',
    files: { 'leak.sh': 'cd /Users/sampleg. && ls\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP1'] },
  },
  {
    name: 'CP1: home=/Users/sampleg. followed by a newline (#631)',
    files: { 'leak.txt': 'home=/Users/sampleg.\nnext line\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP1'] },
  },
  {
    name: 'CP1: slash forms /Users/sampleg./ and /…/Projects/x — one FAIL per line',
    files: { 'leak.md': 'a: /Users/sampleg./\nb: /Users/sampleg./Projects/x\n' },
    expected: { status: 1, fails: 2, checkpoints: ['CP1'] },
  },
  {
    name: 'CP1: bare /Users/sampleg (no dot) at end-of-line — \\b arm of the regex',
    // Mutation guard: the OLD regex /\/Users\/sampleg[a-z.]*\// required a slash
    // after the username, so this bare EOL form would NOT match → #631 class.
    files: { 'leak.txt': 'USER_HOME=/Users/sampleg\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP1'] },
  },
  {
    name: 'CP1: /Users/sampleg. inside a JSON string value',
    files: { 'config.json': '{"home": "/Users/sampleg."}\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP1'] },
  },
  {
    name: 'CP1: env-assignment form BERNHARD_HOME=/Users/sampleg. in a .sh file',
    files: { 'setup.sh': '#!/bin/sh\nBERNHARD_HOME=/Users/sampleg.\nexport BERNHARD_HOME\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP1'] },
  },
  {
    name: 'CP1: two home paths on ONE line report a single per-line violation',
    files: { 'multi.sh': 'cp /Users/sampleg./src /Users/sampleg./dst\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP1'] },
  },
  {
    name: 'CP1: legacy full username /Users/samplegaccount/ (#605 drift class)',
    // Mutation: removing [a-z.]* from the username token makes this row fail.
    files: { 'legacy.md': 'Path: /Users/samplegaccount/projects/\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP1'] },
  },
  {
    name: 'CP1: hyphen-suffixed /Users/sampleg-backup/ (owner prefix + non-word boundary)',
    files: { 'a.md': 'path: /Users/sampleg-backup/x\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP1'] },
  },
  {
    name: 'CP1: dash-encoded Claude-Code projects-dir form (#634)',
    files: { 'doc.md': 'See .claude/projects/-Users-sampleg--Projects-x/memory/foo.md for details\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP1'] },
  },
  {
    name: 'CP1 e2e: url-percent-encoded home path (#661 novel encoding)',
    files: { 'leak.md': 'config path: %2FUsers%2Fsampleg%2Fsecret\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP1'] },
  },
  {
    name: 'CP1 e2e: backslash-separated home path (Windows-style spelling)',
    files: { 'leak.txt': String.raw`p=\Users\sampleg\config` + '\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP1'] },
  },
  {
    name: 'CP1 e2e: homoglyph-slash home path (unicode evasion)',
    files: { 'leak.md': 'p=∕Users∕sampleg∕secret\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP1'] },
  },
  {
    name: 'CP1 e2e: html-entity-encoded home path',
    files: { 'leak.md': 'p=&#47;Users&#47;sampleg\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP1'] },
  },
  {
    name: 'CP1 e2e: capitalized username /Users/Sampleg. (#661 Finding 1)',
    files: { 'leak.md': 'home: /Users/Sampleg./Projects/secret\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP1'] },
  },
  {
    name: 'CP1 e2e: zero-width space spliced into the username (#661 Finding 3)',
    files: { 'leak.md': 'p: /Users/sam\u200bpleg/secret\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP1'] },
  },
  {
    name: 'CP1 e2e: percent-encoded LETTERS of the path (#661 Finding 4)',
    files: { 'leak.md': 'p: /%55sers/%73ampleg/secret\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP1'] },
  },
  {
    name: 'CP1 e2e: home-path leak inside .env.example (dotfile-allowlist reachability)',
    // Mutation caught: reverting isTextFile() to extension-first (extname of
    // '.env.example' is '.example') skips the file entirely → status 0.
    files: { '.env.example': 'OWNER_HOME=/Users/sampleg.\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP1'] },
  },

  // --- CP1 false-positive guards (near-miss usernames stay clean) ---
  {
    name: 'CLEAN: near-miss prefixes /Users/sampleo-other/ and /Users/samplegXfoo',
    files: { 'clean.md': 'a: /Users/sampleo-other/\nb: /Users/samplegXfoo\n' },
    expected: { status: 0, fails: 0, checkpoints: [] },
  },
  {
    name: 'CLEAN: lowercase /users/sampleg. (CP1 host stays case-SENSITIVE)',
    files: { 'notes.md': 'see /users/sampleg. for config\n' },
    expected: { status: 0, fails: 0, checkpoints: [] },
  },
  {
    name: 'CLEAN: digit continuation /Users/sampleg9/ (different user)',
    files: { 'a.md': 'path: /Users/sampleg9/proj\n' },
    expected: { status: 0, fails: 0, checkpoints: [] },
  },
  {
    name: 'CLEAN: underscore continuation /Users/sampleg_home (different user)',
    files: { 'a.md': 'path: /Users/sampleg_home\n' },
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
    files: { 'image.png': '/Users/sampleg./secret\n' },
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
    files: { 'config.md': 'host: gitlab.example.invalid\n' },
    expected: { status: 1, fails: 2, checkpoints: ['CP2', 'CP7'] },
  },
  {
    name: 'CP3: events domain as a string-literal (NOT the excluded doc-comment form)',
    files: { 'config.mjs': "const EVENTS_URL = 'https://events.example.invalid/hook';\n" },
    expected: { status: 1, fails: 2, checkpoints: ['CP3', 'CP7'] },
  },
  {
    name: 'CP3: events domain inside a JSON value',
    files: { 'settings.json': '{"webhookUrl": "https://events.example.invalid/webhook"}\n' },
    expected: { status: 1, fails: 2, checkpoints: ['CP3', 'CP7'] },
  },
  {
    name: 'CP4: @example/ package-scope import',
    files: { 'index.mjs': "import { createFactory } from '@example/testing-utils';\n" },
    expected: { status: 1, fails: 1, checkpoints: ['CP4'] },
  },
  {
    name: 'CP6: private project slug "project-ledger"',
    files: { 'notes.md': 'See repo project-ledger for details.\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP6'] },
  },
  {
    name: 'CP6: private project slug "Project-Quotes" (case-insensitive)',
    files: { 'test.mjs': '// target: Project-Quotes\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP6'] },
  },
  {
    name: 'CP6: carved-out slug "project-mail" STILL fails the tracked-file scan (#59 split proof)',
    files: { 'notes.md': 'Deploy notes for project-mail service.\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP6'] },
  },
  {
    name: 'CP6: carved-out slug "project-launchpad" STILL fails the tracked-file scan (#59)',
    files: { 'notes.md': 'See project-launchpad for the epic.\n' },
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
    name: 'CP10: ~/Projects/Sample/vault (trailing-slash base case)',
    files: { 'config.yaml': 'vault-dir: ~/Projects/Sample/vault\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP10'] },
  },
  {
    name: 'CP10: BARE ~/Projects/Sample at end-of-line (Finding-1 regression guard)',
    // Mutation guard: the OLD mandatory-trailing-slash form would NOT match here.
    files: { 'notes.md': 'plan-baseline-path: ~/Projects/Sample\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP10'] },
  },
  {
    name: 'CP10: absolute /Users/<other-user>/Projects/Sample/x (Finding-3 defense-in-depth)',
    files: { 'ci.sh': 'cp /Users/someone/Projects/Sample/data ./out\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP10'] },
  },
  {
    name: 'CP10: absolute /home/<user>/Projects/Sample (Linux home, no trailing slash)',
    files: { 'ci.yml': 'workdir: /home/ci/Projects/Sample\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP10'] },
  },
  {
    name: 'CP10: the same legacy path at a NON-allowlisted file still fails (allowlist is path-scoped)',
    files: { 'somewhere-else.mjs': "const LEGACY = '~/Projects/Sample/vault';\n" },
    expected: { status: 1, fails: 1, checkpoints: ['CP10'] },
  },
  {
    name: 'CLEAN: ~/Projects/Sample inside a CP10_ALLOWLIST migration source',
    files: {
      'scripts/migrate-vault-paths.mjs': "const LEGACY = '~/Projects/Sample/vault';\nexport default LEGACY;\n",
    },
    expected: { status: 0, fails: 0, checkpoints: [] },
  },
  {
    name: 'CLEAN: ~/Projects/vault (no personal name)',
    files: { 'clean.yaml': 'vault-dir: ~/Projects/vault\n' },
    expected: { status: 0, fails: 0, checkpoints: [] },
  },
  {
    name: 'CLEAN: ~/Projects/Samplet/ (name merely BEGINS with a denylisted name)',
    files: { 'clean.md': 'path: ~/Projects/Samplet/app\n' },
    expected: { status: 0, fails: 0, checkpoints: [] },
  },
  {
    name: 'CLEAN: ~/Projects/MyApp/ (legit capitalized project dir)',
    files: { 'clean.md': 'cd ~/Projects/MyApp/src\n' },
    expected: { status: 0, fails: 0, checkpoints: [] },
  },

  // --- Sanctioned exclusions (public-facing owner references) ---
  {
    name: 'CLEAN: SECURITY.md with only security@example.invalid',
    files: { 'SECURITY.md': '# Security\n\n**Email:** security@example.invalid\n' },
    expected: { status: 0, fails: 0, checkpoints: [] },
  },
  {
    name: 'CLEAN: SECURITY.md with only office@example.invalid',
    files: { 'SECURITY.md': 'Contact: office@example.invalid for issues.\n' },
    expected: { status: 0, fails: 0, checkpoints: [] },
  },
  {
    name: 'CLEAN: README.md homepage URL',
    files: { 'README.md': '- [Homepage](https://example.invalid/en/session-orchestrator)\n' },
    expected: { status: 0, fails: 0, checkpoints: [] },
  },
  {
    name: 'CLEAN: .claude-plugin/plugin.json author email + url block',
    files: {
      '.claude-plugin/plugin.json':
        JSON.stringify(
          {
            name: 'test-plugin',
            author: { email: 'office@example.invalid', url: 'https://example.invalid' },
            homepage: 'https://example.invalid/en/session-orchestrator',
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
          ' *   - No literal `events.example.invalid` URL appears anywhere in scripts/ or hooks/.',
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
          '  "publisher": { "@id": "https://www.example.invalid/#person" },',
          '  "url": "https://www.example.invalid",',
          '}</script>',
          '<a href="https://www.example.invalid" rel="author">Maintainer</a>',
        ].join('\n') + '\n',
      'site/impressum/index.html':
        [
          '<!--',
          '  https://www.example.invalid/impressum. Die Datenschutzerklaerung ist NICHT',
          '-->',
          '<div><dt>Website</dt><dd><a href="https://www.example.invalid">www.example.invalid</a></dd></div>',
        ].join('\n') + '\n',
      'site/datenschutz/index.html':
        '<!--\n  https://www.example.invalid/impressum. Die Datenschutzerklaerung ist NICHT\n-->\n',
    },
    expected: { status: 0, fails: 0, checkpoints: [] },
  },

  // --- Exclusion bypass: an exclusion covers a LINE FORM, never a whole file ---
  {
    name: 'BYPASS: SECURITY.md with a real /Users/ home path still FAILs (email exclusion does not cover it)',
    files: { 'SECURITY.md': '**Email:** security@example.invalid\nSee: /Users/sampleg/secret.key\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP1'] },
  },
  {
    name: 'BYPASS: events-default-url.test.mjs with a REAL string literal still FAILs',
    files: {
      'tests/lib/events-default-url.test.mjs':
        [
          '/**',
          ' *   - No literal `events.example.invalid` URL appears anywhere in scripts/ or hooks/.',
          ' */',
          '// This is a real string literal (NOT the excluded doc-comment form):',
          "const HARDCODED = 'https://events.example.invalid/hook';",
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
          '<div><dt>Website</dt><dd><a href="https://www.example.invalid">www.example.invalid</a></dd></div>',
          '<!-- &#47;Users&#47;sampleg&#47;Projects&#47;PLACEHOLDER <a href="https://www.example.invalid">x</a> -->',
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
        '<a href="https://www.example.invalid" rel="author">Maintainer</a>\n',
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
        '<a href="https://www.example.invalid" rel="author">Maintainer</a>\n',
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
    files: { 'site/guide/index.html': '<a href="https://gitlab&#46;example&#46;invalid/runner">CI</a>\n' },
    expected: { status: 1, fails: 2, checkpoints: ['CP2', 'CP7'] },
  },
  {
    name: '#1080 A: percent-encoded private GitLab host → CP2 + CP7 (same axis, other encoding)',
    files: { 'site/guide/index.html': '<a href="https://gitlab%2Eexample%2Einvalid/runner">CI</a>\n' },
    expected: { status: 1, fails: 2, checkpoints: ['CP2', 'CP7'] },
  },
  {
    name: '#1080 A: hex-entity private GitLab host → CP2 + CP7',
    files: { 'site/guide/index.html': '<a href="https://gitlab&#x2E;example&#x2E;invalid/x">y</a>\n' },
    expected: { status: 1, fails: 2, checkpoints: ['CP2', 'CP7'] },
  },
  {
    name: '#1080 A: entity-encoded events domain → CP3 + CP7',
    files: { 'site/guide/index.html': '<img src="https://events&#46;example&#46;invalid/px.gif">\n' },
    expected: { status: 1, fails: 2, checkpoints: ['CP3', 'CP7'] },
  },
  {
    name: '#1080 A: entity-encoded RFC1918 quad → CP8',
    files: { 'site/guide/index.html': '<!-- runner 10&#46;11&#46;12&#46;13 -->\n' },
    expected: { status: 1, fails: 1, checkpoints: ['CP8'] },
  },
  {
    // The sharpest arm. On an ALLOWLISTED page every RAW example.invalid token is
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
        '<a href="https://www.example.invalid" rel="author">M</a><!-- gitlab&#46;example&#46;invalid -->\n',
    },
    expected: { status: 1, fails: 2, checkpoints: ['CP2', 'CP7'] },
  },
  {
    name: '#1080 A: the same allowlisted page WITHOUT an encoded token stays CLEAN (allowlist intact)',
    files: { 'site/index.html': '<a href="https://www.example.invalid" rel="author">M</a>\n' },
    expected: { status: 0, fails: 0, checkpoints: [] },
  },
  {
    // No-double-count pin. A RAW host matches the raw line AND its canonical form
    // (canonicalization is a no-op on a dot-separated domain). Two separate per-rule
    // conditionals would report 4 here; the single OR-ed conditional reports 2.
    name: '#1080 A: a raw host matching BOTH forms still reports exactly 2 (no double-count)',
    files: { 'c.md': 'host: gitlab.example.invalid\n' },
    expected: { status: 1, fails: 2, checkpoints: ['CP2', 'CP7'] },
  },
  {
    // CP6 is DELIBERATELY left raw: canonicalization folds dash runs to slashes,
    // which SHREDS five of the seven private slugs (project-mail becomes
    // mail/assistant), so a canonical CP6 test is a no-op at best. This row pins the
    // other direction — the dash folding must not MANUFACTURE a slug hit out of
    // ordinary hyphenation.
    name: '#1080 A: CP6 stays raw — benign hyphenated prose is not folded into a slug hit',
    files: { 'clean.md': 'The buchhalt-genie tool and the angebots-checker script are unrelated.\n' },
    expected: { status: 0, fails: 0, checkpoints: [] },
  },
  {
    name: '#1080 A: CP6 dash-bearing slug still fires on the RAW line (unchanged by the canonical pass)',
    files: { 'notes.md': 'Deploy notes for project-mail service.\n' },
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
    files: { 'site/sitemap.xml': '<loc>https://gitlab.example.invalid/x</loc>\n' },
    expected: { status: 1, fails: 2, checkpoints: ['CP2', 'CP7'] },
  },
  {
    name: '#1080 B: planted private host in site/favicon.svg → CP2 + CP7',
    files: { 'site/favicon.svg': '<svg><desc>gitlab.example.invalid</desc></svg>\n' },
    expected: { status: 1, fails: 2, checkpoints: ['CP2', 'CP7'] },
  },
  {
    name: '#1080 B: planted private host in a .css file → CP2 + CP7',
    files: { 'templates/static-html/styles.css': '/* gitlab.example.invalid */\n' },
    expected: { status: 1, fails: 2, checkpoints: ['CP2', 'CP7'] },
  },
  {
    name: '#1080 B: an entity-encoded home path in .svg → CP1 (findings A and B compose)',
    files: { 'site/favicon.svg': '<svg><desc>&#47;Users&#47;sampleg&#47;PLACEHOLDER</desc></svg>\n' },
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

describe('#1267: untracked scan opt-in', () => {
  it.each([
    { args: [], expected: { status: 0, fails: 0, checkpoints: [] }, scanned: 1 },
    { args: ['--include-untracked'], expected: { status: 1, fails: 1, checkpoints: ['CP1'] }, scanned: 2 },
  ])('args $args respect Git ignores and the tracked-only default', ({ args, expected, scanned }) => {
    const root = makeTmpRepo({ 'tracked.md': 'Clean tracked content\n' });
    writeFileSync(join(root, '.gitignore'), 'ignored.mdx\n');
    writeFileSync(join(root, '.git', 'info', 'exclude'), 'local-only.md\n');
    writeFileSync(join(root, 'draft café.mdx'), '/Users/sampleg/private\n');
    writeFileSync(join(root, 'ignored.mdx'), 'project-ledger\n');
    writeFileSync(join(root, 'local-only.md'), 'project-ledger\n');
    const result = runCheck(root, null, args);
    expect(summarizeScan(result)).toEqual(expected);
    expect(result.stdout).toContain(`${scanned} scanned files`);
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
    expect(result.stdout).toContain('2 scanned files');
  });

  it('names the offending file and line number in the FAIL line', () => {
    const root = makeTmpRepo({ 'leak.md': '# doc\nrun: /Users/sampleg./Projects/foo/bar.mjs\n' });
    const result = runCheck(root);
    expect(failLines(result)[0]).toContain(`leak.md:2 — ${CP1_LABEL}`);
    expect(result.stdout).toContain('1 scanned files');
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
    "import { describe, it, expect, beforeEach, vi } from 'vitest';",
    "describe('owner-leakage guard', () => {",
    "  it('blocks a personal home path', () => {",
    "    expect(hookOutput).toContain('/Users/sampleg./Projects/x');",
    '  });',
    "  it('blocks a private repo name project-ledger', () => {",
    "    expect(content).not.toContain('project-ledger');",
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
// canonicalize to the same /Users/sampleg… form and are DETECTED, while the
// lookalike negatives and the case-sensitivity contract are NOT flagged.
// Expected values are hardcoded literals (the CP1 label / null).
// ===========================================================================

describe('#661 corpus: matchOwnerPath — historical + novel encodings DETECTED', () => {
  const DETECTED = [
    ['CP1 plain slash-form', '/Users/sampleg/secret/config.txt'],
    ['CP1 trailing-dot', 'home: /Users/sampleg.'],
    ['CP1 bare no-dot at EOL (#631)', 'USER_HOME=/Users/sampleg'],
    ['CP1 before " && ls" (#631)', 'cd /Users/sampleg. && ls'],
    ['CP1 inside JSON quotes', '{"home": "/Users/sampleg."}'],
    ['CP1 hyphen-suffixed', 'path: /Users/sampleg-backup/x'],
    ['CP1 full legacy username', 'Path: /Users/samplegaccount/projects/'],
    ['CP1 full legacy username, bare trailing slash', '/Users/samplegaccount/'],
    ['dash-encoded projects-dir (#634)', 'See -Users-sampleg--Projects-x/memory/foo.md'],
    ['dash-encoded bare', 'dir=-Users-sampleg'],
    ['NOVEL url-percent encoded', 'p=%2FUsers%2Fsampleg%2Fsecret'],
    ['NOVEL url-percent uppercase hex', 'p=%2fUsers%2fsampleg'],
    ['NOVEL double-percent encoded', 'p=%252FUsers%252Fsampleg'],
    ['NOVEL backslash separators', String.raw`p=\Users\sampleg\secret`],
    ['NOVEL homoglyph division-slash (∕)', 'p=∕Users∕sampleg∕secret'],
    ['NOVEL homoglyph fullwidth-slash (／)', 'p=／Users／sampleg'],
    ['NOVEL html numeric entity (&#47;)', 'p=&#47;Users&#47;sampleg'],
    ['NOVEL html hex entity (&#x2F;)', 'p=&#x2F;Users&#x2F;sampleg'],
    ['NOVEL html named entity (&sol;)', 'p=&sol;Users&sol;sampleg'],
    // Finding 1 (HIGH): username matched case-INSENSITIVELY (real path on APFS).
    ['Finding 1: capitalized username', '/Users/Sampleg./Projects/secret'],
    ['Finding 1: lowercase control', '/Users/sampleg/secret'],
    // Finding 3 (MED): zero-width / format chars spliced into the username.
    ['Finding 3: zero-width space in username', '/Users/sam\u200bpleg/secret'],
    ['Finding 3: soft-hyphen in username', '/Users/sam\u00adpleg/secret'],
    ['Finding 3: tab in username', '/Users/sam\tpleg/secret'],
    // Findings 4+5 (LOW): decoders cover LETTERS, and loop to a FIXPOINT.
    ['Finding 4: percent-encoded letters', '/%55sers/%73ampleg/secret'],
    ['Finding 4: decimal entity for a letter', '/&#85;sers/sampleg/secret'],
    ['Finding 4: hex entity for a letter', '/&#x55;sers/sampleg/secret'],
    ['Finding 5: NESTED double-percent letter encoding (%2555 → %55 → U)', '/%2555sers/%2573ampleg/secret'],
  ];

  it.each(DETECTED)('DETECTS: %s', (_label, line) => {
    expect(matchOwnerPath(line)).toBe(CP1_LABEL);
  });
});

describe('#661 corpus: matchOwnerPath — benign + lookalike NOT flagged', () => {
  const CLEAN = [
    ['near-miss diverges before g (sampleo)', '/Users/sampleo-other/'],
    ['near-miss uppercase continuation (samplegXfoo)', '/Users/samplegXfoo'],
    ['near-miss digit continuation (sampleg9)', '/Users/sampleg9/proj'],
    ['near-miss underscore continuation (sampleg_home)', '/Users/sampleg_home'],
    ['case-sensitivity contract: lowercase /users', 'see /users/sampleg. for config'],
    ['case-sensitivity contract: lowercase /users with path', '/users/sampleg/x'],
    ['other-user dash-encoded (alice)', '-Users-alice--Projects-x/memory/foo.md'],
    ['self-doc: quotes old P1 regex', 'P1 regex `/\\/Users\\/sampleg[a-z.]*(\\/|\\b)/` is tight'],
    ['self-doc: quotes P9 dash regex', 'added P9 `/-Users-sampleg[a-z.]*-/`'],
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
    ['url-percent slashes', '%2FUsers%2Fsampleg', '/Users/sampleg'],
    ['backslash separators', String.raw`\Users\sampleg`, '/Users/sampleg'],
    ['dash-encoded projects-dir', '-Users-sampleg--Projects-x', '/Users/sampleg'],
    ['homoglyph division-slash (∕)', '∕Users∕sampleg', '/Users/sampleg'],
    ['html numeric entity &#47;', '&#47;Users&#47;sampleg', '/Users/sampleg'],
    // Case-sensitivity contract: uppercase continuation survives so the
    // lowercase-only [a-z.]* username token stops at it.
    ['uppercase username continuation is preserved', '/Users/samplegXfoo', 'samplegX'],
  ];

  it.each(NORMALIZES)('canonicalizes %s', (_label, input, expectedSubstring) => {
    expect(canonicalizeLine(input)).toContain(expectedSubstring);
  });

  it('PRESERVES letter case — a lowercase /users path is never upper-cased into a false hit', () => {
    expect(canonicalizeLine('/users/sampleg.')).not.toContain('/Users/sampleg');
  });
});

// ---------------------------------------------------------------------------
// #661 Finding 2 (MED) — regex-quote blanking is TOKEN-scoped, not line-scoped.
// Kept as individual it()s: the whole point is that ONE line carries both a
// quoted regex and (sometimes) a real path, which a fixture table flattens.
// ---------------------------------------------------------------------------

describe('#661 follow-up: Finding 2 — regex-quote blanks only the token, not the line', () => {
  it('DETECTS a real path on a line that ALSO quotes the scanner regex (residue re-scan)', () => {
    // The real `/Users/sampleg/Projects/secret` shares the line with a quoted
    // regex `/Users/sampleg[a-z.]*`. Before the fix the whole line was
    // suppressed; now only the `…sampleg[` token is blanked and the real path
    // is caught.
    expect(
      matchOwnerPath('Real: /Users/sampleg/Projects/secret (see regex /Users/sampleg[a-z.]*)'),
    ).toBe(CP1_LABEL);
  });

  it('CLEAN on a line that ONLY quotes the old P1 regex (self-doc, no real path)', () => {
    expect(matchOwnerPath('P1 regex `/\\/Users\\/sampleg[a-z.]*(\\/|\\b)/` is tight')).toBe(null);
  });

  it('CLEAN on a line that ONLY quotes the P9 dash regex (self-doc)', () => {
    expect(matchOwnerPath('added P9 `/-Users-sampleg[a-z.]*-/`')).toBe(null);
  });

  it('exits 1 end-to-end when a real leak shares a line with a quoted regex', () => {
    const root = makeTmpRepo({
      'doc.md': 'Real: /Users/sampleg/Projects/secret (see regex /Users/sampleg[a-z.]*)\n',
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
    ['carved-out slug', 'project-ledger', null],
    ['carved-out slug, mixed case', 'Project-Ledger', null],
    ['carved-out slug, upper case', 'MAIL-ASSISTANT', null],
    ['carved-out slug, camel case', 'Project-Quotes', null],
    // The carve-out did NOT blanket-disable CP6 — retained slugs still bite.
    ['retained slug', 'project-private-module', 'CP6'],
    ['retained slug, mixed case', 'Project-Hackathon', 'CP6'],
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

// ---------------------------------------------------------------------------
// #1244: CP11 must fail CLOSED and say so
//
// Three independent fail-OPEN paths, each of which made the scanner print
// `PASS: no owner-privacy leakage found` and exit 0 while CP11 matched nothing
// (or, for the third, while NOTHING ran at all). Every case below is red on the
// pre-#1244 code and green after.
// ---------------------------------------------------------------------------

/** Write a loader that makes `js-yaml` unresolvable for the child process. */
function writeYamlBlockingLoader(dir) {
  const loader = join(dir, 'block-js-yaml.mjs');
  writeFileSync(
    loader,
    [
      "import { registerHooks } from 'node:module';",
      'registerHooks({',
      '  resolve(specifier, context, next) {',
      "    if (specifier === 'js-yaml') {",
      '      const err = new Error("Cannot find package \'js-yaml\'");',
      "      err.code = 'ERR_MODULE_NOT_FOUND';",
      '      throw err;',
      '    }',
      '    return next(specifier, context);',
      '  },',
      '});',
      '',
    ].join('\n'),
  );
  return loader;
}

describe('#1269: CP11 owner-loader health', () => {
  it.each([
    { name: 'throwing owner loader', throws: true, disabled: true },
    { name: 'absent owner file with healthy defaults', throws: false, disabled: false },
  ])('$name', async ({ throws, disabled }) => {
    // Use the real host-path loader to exercise its defensive all-undefined
    // result, which the current disk-backed owner loader cannot produce.
    const result = await getConfidentialNamePatterns({
      loadHostPaths: () => loadHostPaths({
        env: {},
        ownerLoader: () => {
          if (throws) throw new Error('unreadable private owner path');
          return { config: { paths: {} }, source: 'defaults' };
        },
      }),
    });
    expect(result.patterns).toEqual([]);
    if (disabled) {
      expect(result.disabledReason).toMatch(/owner config loader failed.*failing closed/);
      expect(result.disabledReason).not.toContain('unreadable private owner path');
    } else {
      expect(result.disabledReason).toBeUndefined();
      expect(result.inertWarn).toBeUndefined();
    }
  });
});

describe('#1244: CP11 fails CLOSED when it was expected but could not run', () => {
  it('js-yaml unresolvable + names configured via owner.yaml → CP11 DISABLED + exit 1 (was: silent PASS)', () => {
    // THE BUG: getConfidentialNamePatterns() wrapped the dynamic imports, the
    // config read and loadConfidentialNames in ONE bare `catch { return [] }`.
    // With js-yaml missing, loadOwnerConfig() degrades to defaults, the names
    // path resolves to '', CP11 matches nothing — and the scanner reported the
    // clean verdict it never earned. Only the env route stayed fail-closed.
    const configHome = makeTmpDir('owner-leakage-confighome-');
    const namesDir = makeTmpDir('owner-leakage-names-');
    const namesFile = join(namesDir, 'names.json');
    writeFileSync(namesFile, JSON.stringify(['zenithcorp']));
    writeFileSync(
      join(configHome, 'owner.yaml'),
      [
        'owner:',
        '  name: "Test Owner"',
        '  language: "en"',
        'tone:',
        '  style: "direct"',
        'efficiency:',
        '  output-level: "full"',
        '  preamble: "minimal"',
        'hardware-sharing:',
        '  enabled: false',
        '  hash-salt: ""',
        'paths:',
        `  confidential-names-file: "${namesFile}"`,
        '',
      ].join('\n'),
    );
    const loader = writeYamlBlockingLoader(configHome);
    const root = makeTmpRepo({ 'notes.md': 'Mentions zenithcorp explicitly.\n' });

    const result = spawnSync(process.execPath, ['--import', loader, SCRIPT, root], {
      encoding: 'utf8',
      timeout: 20_000,
      // SO_CONFIDENTIAL_NAMES_FILE explicitly cleared: this exercises the
      // owner.yaml route, which is the one that used to fail open.
      env: { ...process.env, SO_CONFIG_HOME: configHome, SO_CONFIDENTIAL_NAMES_FILE: '' },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CP11 DISABLED');
    expect(result.stdout).not.toContain('PASS: no owner-privacy leakage found');
    // Privacy: the reason line must never echo the host-local path (this
    // scanner's output is captured by a PUBLIC CI mirror).
    expect(result.stderr).not.toContain(namesFile);
    expect(result.stdout).not.toContain(namesFile);
  });

  it('names file configured but missing → CP11 DISABLED + exit 1 (was: silent PASS)', () => {
    // Second shape of the same bug: loadConfidentialNames() returns null for a
    // missing file exactly as it does for "unconfigured", so a typo'd path
    // silently disabled the rule.
    const namesDir = makeTmpDir('owner-leakage-names-');
    const root = makeTmpRepo({ 'notes.md': 'Mentions zenithcorp explicitly.\n' });

    const result = spawnSync(process.execPath, [SCRIPT, root], {
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, SO_CONFIDENTIAL_NAMES_FILE: join(namesDir, 'does-not-exist.json') },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CP11 DISABLED');
  });

  it('invoked through a symlinked path → still scans, prints and fails (was: zero output, exit 0)', () => {
    // THE BUG: `isMain` compared resolve(argv[1]) against fileURLToPath(import.meta.url),
    // which Node canonicalizes. Any invocation whose path traverses a symlink
    // (on macOS every /tmp/… path) made isMain false — runScan() never ran, the
    // process printed NOTHING and exited 0. A guard that never runs must not
    // look like a guard that passed.
    const stage = makeTmpDir('owner-leakage-symlink-');
    const realDir = join(stage, 'real');
    cpSync(join(REPO_ROOT, 'scripts'), join(realDir, 'scripts'), { recursive: true });
    symlinkSync(realDir, join(stage, 'link'), 'dir');
    const linkedScript = join(stage, 'link', 'scripts', 'lib', 'validate', 'check-owner-leakage.mjs');
    const root = makeTmpRepo({ 'leak.md': 'p: /Users/sampleg/secret\n' });

    // Empty SO_CONFIG_HOME (no owner.yaml) + no names env: CP11 is unconfigured,
    // so this row isolates the isMain defect from the CP11 fail-closed rows above.
    // (The staged copy has no node_modules, so a REAL owner.yaml on the host would
    // otherwise legitimately trip the js-yaml-missing CP11 DISABLED verdict.)
    const result = spawnSync(process.execPath, [linkedScript, root], {
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        ...process.env,
        SO_CONFIG_HOME: makeTmpDir('owner-leakage-nocfg-'),
        SO_CONFIDENTIAL_NAMES_FILE: '',
      },
    });

    expect(result.stdout).toContain('Check 11: owner-privacy leakage');
    expect(result.status).toBe(1);
    expect(summarizeScan(result)).toEqual({ status: 1, fails: 1, checkpoints: ['CP1'] });
  });
});

describe('#1244 Q4: healthy-host regression — owner.yaml valid, has paths:, no names-file configured', () => {
  it('SO_CONFIG_HOME owner.yaml (valid, paths.vault-dir set, no confidential-names-file) → PASS, no CP11 in stderr', () => {
    // THE BUG THIS GUARDS AGAINST: the three rows above cover the DISABLED
    // verdicts (CP11 expected but unusable) and an EMPTY SO_CONFIG_HOME (no
    // owner.yaml at all) — neither is the operator's actual shape, which is an
    // owner.yaml that EXISTS, is VALID, and carries a `paths:` section for
    // something OTHER than CP11 (vault-dir here). A refactor that keys the
    // configured/unconfigured branch on `existsSync(resolveOwnerYamlPath())`
    // alone (instead of on whether `confidential-names-file` itself resolves
    // to a non-empty path — see getConfidentialNamePatterns()'s `existsSync`
    // check in host-paths.mjs's precedence chain) would turn EVERY commit red
    // on every host that configured `paths:` for anything else. SO_CONFIG_HOME
    // IS the private config dir — owner.yaml sits directly under it, not in a
    // subdirectory (both Q2 and Q4 tripped on this while writing fixtures).
    const configHome = makeTmpDir('owner-leakage-confighome-healthy-');
    const vaultDir = join(configHome, 'vault');
    writeFileSync(
      join(configHome, 'owner.yaml'),
      [
        'owner:',
        '  name: "Test Owner"',
        '  language: "en"',
        'tone:',
        '  style: "direct"',
        '  tonality: ""',
        'efficiency:',
        '  output-level: "full"',
        '  preamble: "minimal"',
        'hardware-sharing:',
        '  enabled: false',
        '  hash-salt: ""',
        'paths:',
        `  vault-dir: "${vaultDir}"`,
        '',
      ].join('\n'),
    );
    const root = makeTmpRepo({ 'README.md': '# Clean fixture repo\n\nNothing to see here.\n' });

    const result = spawnSync(process.execPath, [SCRIPT, root], {
      encoding: 'utf8',
      timeout: 20_000,
      // SO_CONFIDENTIAL_NAMES_FILE explicitly cleared: only owner.yaml's
      // (absent) paths.confidential-names-file governs CP11 here.
      env: { ...process.env, SO_CONFIG_HOME: configHome, SO_CONFIDENTIAL_NAMES_FILE: '' },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS');
    expect(result.stderr).not.toContain('CP11');
  });
});

describe('#1244 follow-up (W4-F6): an invalid paths: section only DISABLES CP11 when CP11 was configured', () => {
  /**
   * Build an owner.yaml whose four REQUIRED sections are valid and whose
   * OPTIONAL `paths:` section is invalid (`vault-dir: 42` — a plain typo), with
   * or without a `confidential-names-file` key inside that same broken section.
   */
  function writeOwnerYaml(configHome, { withNamesKey }) {
    const lines = [
      'owner:',
      '  name: "Test Owner"',
      '  language: "en"',
      'tone:',
      '  style: "direct"',
      'efficiency:',
      '  output-level: "full"',
      '  preamble: "minimal"',
      'hardware-sharing:',
      '  enabled: false',
      '  hash-salt: ""',
      'paths:',
      '  vault-dir: 42',
    ];
    if (withNamesKey) lines.push(`  confidential-names-file: "${withNamesKey}"`);
    lines.push('');
    writeFileSync(join(configHome, 'owner.yaml'), lines.join('\n'));
  }

  it('invalid paths: section with NO confidential-names-file → PASS exit 0, one WARN, no CP11 DISABLED', () => {
    // THE BUG (Codex repro, 2026-09-06): the #1244 fail-closed fix keyed the
    // DISABLED verdict on `droppedSections includes 'paths'` alone. A host that
    // never configured CP11 but has an unrelated typo anywhere in `paths:` got
    // `CP11 DISABLED` + exit 1 on EVERY commit — and because .husky/pre-commit
    // suppressed the scanner's output, the operator saw "privacy leak detected"
    // for a repo with no leak, which teaches --no-verify. The verdict now turns
    // on whether the raw `paths.confidential-names-file` key is actually there.
    const configHome = makeTmpDir('owner-leakage-dropped-paths-nokey-');
    writeOwnerYaml(configHome, { withNamesKey: null });
    const root = makeTmpRepo({ 'README.md': '# Clean fixture repo\n' });

    const result = spawnSync(process.execPath, [SCRIPT, root], {
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, SO_CONFIG_HOME: configHome, SO_CONFIDENTIAL_NAMES_FILE: '' },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS');
    expect(result.stderr).not.toContain('CP11 DISABLED');
    // Not silent either: the dropped section is named exactly once, as a WARN.
    expect(result.stderr).toContain('CP11 inactive');
    expect(result.stderr).toMatch(/paths/);
  });

  it('SAME invalid paths: section but WITH confidential-names-file → CP11 DISABLED + exit 1', () => {
    // The other half of the same decision: the operator DID configure CP11, and
    // the section carrying that configuration was discarded — so the rule cannot
    // run and must not report the clean verdict it did not earn.
    const namesDir = makeTmpDir('owner-leakage-dropped-paths-names-');
    const namesFile = join(namesDir, 'names.json');
    writeFileSync(namesFile, JSON.stringify(['zenithcorp']));
    const configHome = makeTmpDir('owner-leakage-dropped-paths-key-');
    writeOwnerYaml(configHome, { withNamesKey: namesFile });
    const root = makeTmpRepo({ 'notes.md': 'Mentions zenithcorp explicitly.\n' });

    const result = spawnSync(process.execPath, [SCRIPT, root], {
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, SO_CONFIG_HOME: configHome, SO_CONFIDENTIAL_NAMES_FILE: '' },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CP11 DISABLED');
    expect(result.stdout).not.toContain('PASS: no owner-privacy leakage found');
    // Privacy: the host-local path never reaches stdout/stderr (public CI mirror).
    expect(result.stderr).not.toContain(namesFile);
    expect(result.stdout).not.toContain(namesFile);
  });
});

describe('#1244 follow-up (W4-F6): the inert degrade is scoped to the scanner\'s OWN direct helper imports', () => {
  it('a missing TRANSITIVE module with names configured → CP11 DISABLED + exit 1 (was: inert, silent PASS)', () => {
    // THE BUG (Codex debt item, 2026-09-06): the ERR_MODULE_NOT_FOUND degrade
    // covered the error CODE alone, so ANY unresolvable module anywhere down the
    // CP11 helper chain — not just the standalone single-file vendoring shape it
    // was written for — silently returned zero patterns. A broken in-tree install
    // then reported the clean verdict with names ACTIVELY configured, which is the
    // exact fail-open #1244 set out to close. `err.url` names the module that could
    // not be found, so a direct sibling (inert) is now distinguishable from a
    // transitive (fail closed).
    const stage = makeTmpDir('owner-leakage-transitive-');
    const validateDir = join(stage, 'scripts', 'lib', 'validate');
    const configDir = join(stage, 'scripts', 'lib', 'config');
    mkdirSync(validateDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    cpSync(SCRIPT, join(validateDir, 'check-owner-leakage.mjs'));
    cpSync(join(REPO_ROOT, 'scripts', 'lib', 'validate', 'confidential-names.mjs'), join(validateDir, 'confidential-names.mjs'));
    cpSync(join(REPO_ROOT, 'scripts', 'lib', 'config', 'host-paths.mjs'), join(configDir, 'host-paths.mjs'));
    cpSync(join(REPO_ROOT, 'scripts', 'lib', 'owner-yaml.mjs'), join(stage, 'scripts', 'lib', 'owner-yaml.mjs'));
    // scripts/lib/config/private-config-dir.mjs is DELIBERATELY not copied: it is a
    // transitive of owner-yaml.mjs, never a direct import of the scanner.

    const namesDir = makeTmpDir('owner-leakage-transitive-names-');
    const namesFile = join(namesDir, 'names.json');
    writeFileSync(namesFile, JSON.stringify(['zenithcorp']));
    const root = makeTmpRepo({ 'notes.md': 'Mentions zenithcorp explicitly.\n' });

    const result = spawnSync(process.execPath, [join(validateDir, 'check-owner-leakage.mjs'), root], {
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, SO_CONFIDENTIAL_NAMES_FILE: namesFile },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CP11 DISABLED');
    expect(result.stdout).not.toContain('PASS: no owner-privacy leakage found');
  });
});

describe('#1260: the platform assumption behind CP11 direct-sibling detection (err.url)', () => {
  // WHY THIS TEST EXISTS. isMissingDirectSibling() in check-owner-leakage.mjs is
  // `typeof err?.url === 'string' && CP11_DIRECT_SIBLING_URLS.has(err.url)`, and
  // CP11_DIRECT_SIBLING_URLS is built as `new URL(spec, import.meta.url).href`.
  // Both halves are UNWRITTEN CONTRACTS WITH NODE: that an ERR_MODULE_NOT_FOUND
  // for a relative specifier carries `url`, that its value is exactly the
  // resolved-href form the Set is keyed on, and that a BARE package specifier
  // carries none. `engines.node >= 24` covers this today and nothing pins it —
  // a future Node that drops, renames, or reformats `url` turns every standalone
  // single-file copy of the scanner into an unconditional commit blocker, and
  // there is no way to observe that from the scanner's own output.
  //
  // MEASURED IN A CHILD `node`, NEVER IN-PROCESS. Under vitest the import goes
  // through the vite-node module runner, whose ERR_MODULE_NOT_FOUND carries NO
  // `url` at all — an in-process probe measures the test runner, not the platform.
  // The scanner runs as a plain-node CLI (spawnSync throughout this file), so the
  // child process IS the production shape.

  /**
   * Probe a failing import in a real `node` child and return `{code, url}`.
   * @param {string} specifier
   * @param {string} prefix
   */
  function probeMissingImport(specifier, prefix) {
    const dir = realpathSync(makeTmpDir(prefix));
    writeFileSync(join(dir, 'importer.mjs'), `import ${JSON.stringify(specifier)};\n`);
    const probe = join(dir, 'probe.mjs');
    writeFileSync(
      probe,
      [
        "const err = await import('./importer.mjs').then(() => null, (e) => e);",
        "process.stdout.write(JSON.stringify({ code: err?.code ?? null, url: err?.url ?? null }));",
        '',
      ].join('\n'),
    );
    const result = spawnSync(process.execPath, [probe], { encoding: 'utf8', timeout: 20_000 });
    expect(result.status).toBe(0);
    return { ...JSON.parse(result.stdout), importerUrl: pathToFileURL(join(dir, 'importer.mjs')).href };
  }

  it('a RELATIVE specifier miss carries err.url as the resolved-href form CP11_DIRECT_SIBLING_URLS is keyed on', () => {
    const { code, url, importerUrl } = probeMissingImport('./nope-xyz.mjs', 'cp11-errurl-relative-');

    expect(code).toBe('ERR_MODULE_NOT_FOUND');
    expect(typeof url).toBe('string');
    // The exact identity the production Set relies on: `new URL(spec, importer).href`.
    expect(url).toBe(new URL('./nope-xyz.mjs', importerUrl).href);
  });

  it('a BARE package miss carries no err.url, so it can never be classified as a direct sibling', () => {
    const { code, url } = probeMissingImport(
      'definitely-not-installed-pkg-xyz',
      'cp11-errurl-bare-',
    );

    expect(code).toBe('ERR_MODULE_NOT_FOUND');
    expect(url).toBe(null); // absent on the error object (JSON-transported as null)
  });
});

describe('#1260: the DIRECT-SIBLING branch, exercised end-to-end via the documented single-file vendoring', () => {
  /**
   * The documented standalone shape (security.md § Owner-Privacy: "Reuse the same
   * scanner"): EXACTLY ONE file copied out of the tree, so all three direct helper
   * imports miss. Deliberately not an import-chain copy — copying a chain would
   * make the import list itself the contract.
   */
  function standaloneCopy() {
    const stage = makeTmpDir('owner-leakage-standalone-');
    const copy = join(stage, 'check-owner-leakage.mjs');
    cpSync(SCRIPT, copy);
    return copy;
  }

  it('standalone copy with NO names configured → inert WARN, clean PASS, exit 0', () => {
    const root = makeTmpRepo({ 'notes.md': 'Nothing confidential here.\n' });

    const result = spawnSync(process.execPath, [standaloneCopy(), root], {
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, SO_CONFIDENTIAL_NAMES_FILE: '' },
    });

    // THE BUG THIS CATCHES: if `err.url` ever stops naming the missing relative
    // sibling, isMissingDirectSibling() returns false for this very case, the
    // scanner falls through to the transitive fail-closed path, and every
    // standalone vendored copy blocks every commit unconditionally.
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('WARN: CP11 inert');
    expect(result.stderr).not.toContain('CP11 DISABLED');
    expect(result.stdout).toContain('PASS: no owner-privacy leakage found');
  });

  it('standalone copy WITH SO_CONFIDENTIAL_NAMES_FILE set → fails closed with the standalone-specific reason', () => {
    const namesFile = writeNamesFile(['zenithcorp']);
    const root = makeTmpRepo({ 'notes.md': 'Mentions zenithcorp explicitly.\n' });

    const result = spawnSync(process.execPath, [standaloneCopy(), root], {
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, SO_CONFIDENTIAL_NAMES_FILE: namesFile },
    });

    // Distinguishes the DIRECT-SIBLING fail-closed (#1262) from the generic
    // broken-install one: a misclassification here would still exit 1, so only
    // the reason text falsifies it.
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CP11 DISABLED');
    expect(result.stderr).toContain('(standalone copy) — failing closed');
    expect(result.stdout).not.toContain('PASS: no owner-privacy leakage found');
    // Privacy: the host-local path never reaches stdout/stderr (public CI mirror).
    expect(result.stderr).not.toContain(namesFile);
    expect(result.stdout).not.toContain(namesFile);
  });
});

// ---------------------------------------------------------------------------
// W4 fix pass (F3/F4): the remaining CP11 loader verdicts, end-to-end
//
// F3 is a FAIL-OPEN: a configured names file whose entries are ALL rejected by
// validation was classified 'empty' — the same class as the operator's `[]`
// opt-out — so the scanner ran CP11 with zero patterns and printed the clean
// verdict. F4 pins the 'malformed' verdict end-to-end (only 'missing' was) plus
// the whitespace-only env value, which documents "whitespace = unconfigured".
// ---------------------------------------------------------------------------

describe("W4-F3/F4: 'empty' is an opt-out, 'all-dropped' and 'malformed' fail closed", () => {
  /**
   * Write RAW content (not necessarily a valid names list) to a host-local file
   * outside any scanned root, and return its path.
   * @param {string} raw
   */
  function writeRawNamesFile(raw) {
    const namesFile = join(makeTmpDir('owner-leakage-rawnames-'), 'names.json');
    writeFileSync(namesFile, raw);
    return namesFile;
  }

  /**
   * `configHome` defaults to an EMPTY tmp dir (no owner.yaml), so a row whose env
   * value does not itself resolve a names file is decided by the fixture rather
   * than by whatever the running operator configured host-locally.
   * @param {string} root @param {string} namesEnv
   */
  function runWithNamesEnv(root, namesEnv) {
    return spawnSync(process.execPath, [SCRIPT, root], {
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        ...process.env,
        SO_CONFIG_HOME: makeTmpDir('owner-leakage-rawnames-cfg-'),
        SO_CONFIDENTIAL_NAMES_FILE: namesEnv,
      },
    });
  }

  it('a deliberate `[]` names file → CP11 inactive, PASS, exit 0 (operator opt-out stays silent)', () => {
    // Folding `[]` into the fail-closed class would block EVERY commit for any
    // operator who disables CP11 that way — which is why 'empty' survives as its
    // own status rather than being merged with 'all-dropped'.
    const root = makeTmpRepo({ 'notes.md': 'Nothing confidential here.\n' });

    const result = runWithNamesEnv(root, writeRawNamesFile('[]'));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS: no owner-privacy leakage found');
    expect(result.stderr).not.toContain('CP11 DISABLED');
  });

  it('a names file whose entries are ALL rejected → CP11 DISABLED + exit 1 (was: silent PASS)', () => {
    // THE BUG (F3): ["xxx…300", "yyy…400", 123, ""] parses fine, every entry is
    // dropped (two oversized, one non-string, one blank), names.length === 0 —
    // and the old 'empty' classification made the scanner treat that corrupted
    // list as a deliberate opt-out: exit 0, `PASS`, CP11 carrying no patterns.
    const namesFile = writeRawNamesFile(
      JSON.stringify(['x'.repeat(300), 'y'.repeat(400), 123, '']),
    );
    const root = makeTmpRepo({ 'notes.md': 'Mentions zenithcorp explicitly.\n' });

    const result = runWithNamesEnv(root, namesFile);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CP11 DISABLED');
    expect(result.stdout).not.toContain('PASS: no owner-privacy leakage found');
    // Privacy: neither the reason line nor the loader WARN may echo the path.
    expect(result.stderr).not.toContain(namesFile);
    expect(result.stdout).not.toContain(namesFile);
  });

  it("a MALFORMED names file → CP11 DISABLED + exit 1, and the path never reaches the output (F4)", () => {
    // Only the 'missing' verdict was pinned end-to-end. 'malformed' reaches the
    // same fail-closed branch by a different route (JSON.parse throws), and it is
    // also the branch whose loader WARN used to print the host-local path
    // verbatim next to a FAIL the operator pastes into a public CI log (F1).
    const namesFile = writeRawNamesFile('[ broken');
    const root = makeTmpRepo({ 'notes.md': 'Mentions zenithcorp explicitly.\n' });

    const result = runWithNamesEnv(root, namesFile);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CP11 DISABLED');
    expect(result.stdout).not.toContain('PASS: no owner-privacy leakage found');
    expect(result.stderr).not.toContain(namesFile);
    expect(result.stdout).not.toContain(namesFile);
  });

  it('the MISSING-file verdict also keeps the configured path out of stdout+stderr (F1)', () => {
    // Same F1 regression, second branch: `loadConfidentialNames` used to WARN with
    // `${namesPath}` before the scanner's path-free `disabledReason` was emitted,
    // so the FAIL and the leak arrived in the same capture.
    const namesFile = join(makeTmpDir('owner-leakage-absent-'), 'names.json'); // never written
    const root = makeTmpRepo({ 'notes.md': 'Mentions zenithcorp explicitly.\n' });

    const result = runWithNamesEnv(root, namesFile);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CP11 DISABLED');
    expect(result.stderr).not.toContain(namesFile);
    expect(result.stdout).not.toContain(namesFile);
  });

  it('a whitespace-only SO_CONFIDENTIAL_NAMES_FILE reads as UNCONFIGURED → PASS, exit 0', () => {
    // `'   '` is truthy, so a naive `env || fallback` treats it as a configured
    // path (development.md § Env-var fallback whitespace trap). The loader trims
    // first, so this must stay the silent ~99% default rather than a fail-closed
    // "configured but unusable" verdict.
    const root = makeTmpRepo({ 'notes.md': 'Nothing confidential here.\n' });

    const result = runWithNamesEnv(root, '   ');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS: no owner-privacy leakage found');
    expect(result.stderr).not.toContain('CP11 DISABLED');
  });
});

// #1530: a harmless packed filename must not hide private file contents.
it('loads invented host patterns and inspects packed operational contents', () => {
  const hostDir = realpathSync(makeTmpDir('host-policy-regression-'));
  const policyPath = join(hostDir, 'owner-patterns.json');
  writeFileSync(policyPath, JSON.stringify({version: 1, privateHosts: ['gitlab.example.invalid'], privateDomains: ['example.invalid']}), {mode: 0o600});
  const root = makeTmpRepo({'operational.mjs': 'export const endpoint = "gitlab.example.invalid";\n'}, {initGit: false});
  const inventory = join(hostDir, 'inventory.json');
  writeFileSync(inventory, JSON.stringify([{files:[{path:'operational.mjs'}]}]));
  const result = spawnSync(process.execPath, [SCRIPT, root, '--require-owner-patterns', '--packed-files', inventory], {encoding:'utf8', timeout: 20000, env:{...process.env, SO_OWNER_PATTERNS_FILE:policyPath, SO_CONFIG_HOME:hostDir}});
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('CP2');
});

it.each(['missing', 'malformed', 'permissions', 'symlink', 'traversal', 'unreadable'])('fails closed for required owner policy / packed inventory: %s', (failure) => {
  const hostDir = realpathSync(makeTmpDir('host-policy-safety-'));
  const policyPath = join(hostDir, 'owner-patterns.json');
  writeFileSync(policyPath, JSON.stringify({version:1, privateDomains:['example.invalid']}), {mode: failure === 'permissions' ? 0o644 : 0o600});
  if (failure === 'missing') unlinkSync(policyPath);
  if (failure === 'malformed') writeFileSync(policyPath, '{');
  if (failure === 'symlink') { const target = join(hostDir, 'target.json'); renameSync(policyPath, target); symlinkSync(target, policyPath); }
  const root = makeTmpRepo({'clean.mjs': 'export const clean = true;\n'}, {initGit:false});
  const inventory = join(hostDir, 'inventory.json');
  writeFileSync(inventory, JSON.stringify([{files:[{path: failure === 'traversal' ? '../outside.mjs' : failure === 'unreadable' ? 'absent.mjs' : 'clean.mjs'}]}]));
  const result = spawnSync(process.execPath, [SCRIPT, root, '--require-owner-patterns', '--packed-files', inventory], {encoding:'utf8', timeout:20000, env:{...process.env, SO_OWNER_PATTERNS_FILE:policyPath, SO_CONFIG_HOME:hostDir}});
  expect(result.status).toBe(1);
  expect(result.stdout + result.stderr).not.toContain(policyPath);
});

it('rejects explicitly null owner-pattern arrays', () => {
  const hostDir = realpathSync(makeTmpDir('host-null-policy-'));
  const policyPath = join(hostDir, 'owner-patterns.json');
  writeFileSync(policyPath, JSON.stringify({version:1, privateHosts:null, privateDomains:['example.invalid']}), {mode:0o600});
  expect(inspectOwnerPatterns({filePath:policyPath,refresh:true}).status).toBe('invalid');
});

it('keeps encoded owner values and private filename segments out of diagnostics', () => {
  const hostDir = realpathSync(makeTmpDir('host-safe-diagnostics-'));
  const policyPath = join(hostDir, 'owner-patterns.json');
  writeFileSync(policyPath, JSON.stringify({version:1, usernamePrefixes:['sampleg'], privateHosts:['gitlab.example.invalid'], privateDomains:['example.invalid'], privateSlugs:['project-secret']}), {mode:0o600});
  const encodedHost = [...'gitlab.example.invalid'].map((c) => '%' + c.charCodeAt(0).toString(16)).join('');
  const root = makeTmpRepo({'project-secret/notes.md': '/Users/%73amplegaccount/private\n' + encodedHost + '\n'});
  const result = spawnSync(process.execPath, [SCRIPT, root], {encoding:'utf8',timeout:20000,env:{...process.env,SO_OWNER_PATTERNS_FILE:policyPath}});
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('CP1');
  expect(result.stdout).toContain('CP2');
  expect(result.stdout).toContain('[REDACTED]');
  for (const value of ['%73amplegaccount','samplegaccount',encodedHost,'gitlab.example.invalid','project-secret']) expect(result.stdout + result.stderr).not.toContain(value);
});

it.each(['missing-root', 'invalid-inventory'])('keeps private paths out of scan-wide diagnostics: %s', (failure) => {
  const hostDir = realpathSync(makeTmpDir('host-scan-error-'));
  const root = failure === 'missing-root' ? join(hostDir, 'project-secret-missing') : makeTmpRepo({'clean.mjs':'export const clean = true;\n'}, {initGit:false});
  const inventory = join(hostDir, 'project-secret-inventory.json');
  writeFileSync(inventory, '{project-secret');
  const args = [SCRIPT, root, ...(failure === 'invalid-inventory' ? ['--packed-files', inventory] : [])];
  const result = spawnSync(process.execPath, args, {encoding:'utf8',timeout:20000});
  expect(result.status).toBe(1);
  expect(result.stdout + result.stderr).not.toContain('project-secret');
});

it('uses one canonical packed root through a symlink alias and preserves safe diagnostic filenames', () => {
  const hostDir = realpathSync(makeTmpDir('packed-alias-policy-'));
  const policyPath = join(hostDir, 'owner-patterns.json');
  writeFileSync(policyPath, JSON.stringify({version:1, privateDomains:['example.invalid'], privateHosts:['gitlab.example.invalid'], privateSlugs:['project-secret'], publicUrls:['https://www.example.invalid']}), {mode:0o600});
  const root = makeTmpRepo({'.claude-plugin/plugin.json':'{"homepage":"https://www.example.invalid"}\n'}, {initGit:false});
  const alias = join(hostDir, 'root-alias');
  symlinkSync(root, alias, 'dir');
  const inventory = join(hostDir, 'inventory.json');
  writeFileSync(inventory, JSON.stringify([{files:[{path:'.claude-plugin/plugin.json'}]}]));
  const scan = () => spawnSync(process.execPath, [SCRIPT,alias,'--require-owner-patterns','--packed-files',inventory], {encoding:'utf8',timeout:20000,env:{...process.env,SO_OWNER_PATTERNS_FILE:policyPath}});
  expect(scan().status).toBe(0);
  writeFileSync(join(root,'.claude-plugin/plugin.json'), '{"homepage":"https://www.example.invalid", "private":"gitlab.example.invalid"}\n');
  const result = scan();
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('FAIL: .claude-plugin/plugin.json:1');
  expect(result.stdout).toContain('CP2');
  expect(result.stdout).toContain('CP7');
  expect(result.stdout).not.toContain('root-alias');
  expect(result.stdout).not.toContain('gitlab.example.invalid');
});

it('checks packed operational legacy filenames despite ordinary CP10 and CP8 exemptions', () => {
  const hostDir = realpathSync(makeTmpDir('packed-legacy-policy-'));
  const policyPath = join(hostDir, 'owner-patterns.json');
  writeFileSync(policyPath, JSON.stringify({version:1,personalNames:['FixtureOwner']}), {mode:0o600});
  const root = makeTmpRepo({'scripts/migrate-vault-paths.mjs':'const oldPath = "~/Projects/FixtureOwner/work";\n', 'tests/scripts/export-hw-learnings.test.mjs':'const privateIp = "10.12.34.56";\n'}, {initGit:false});
  const inventory = join(hostDir, 'inventory.json');
  writeFileSync(inventory, JSON.stringify([{files:[{path:'scripts/migrate-vault-paths.mjs'},{path:'tests/scripts/export-hw-learnings.test.mjs'}]}]));
  const result = spawnSync(process.execPath, [SCRIPT,root,'--require-owner-patterns','--packed-files',inventory], {encoding:'utf8',timeout:20000,env:{...process.env,SO_OWNER_PATTERNS_FILE:policyPath}});
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('CP10');
  expect(result.stdout).toContain('CP8');
  expect(result.stdout).not.toContain('FixtureOwner');
});
