/**
 * tests/lib/validate/check-owner-leakage.test.mjs
 *
 * Tests for scripts/lib/validate/check-owner-leakage.mjs (#471, epic #462).
 *
 * The check is a CLI script (not an importable module), so tests exercise it
 * via spawnSync(process.execPath, [SCRIPT, fixtureRoot]) against tmpdir fixtures.
 *
 * Every case asserts BOTH result.status AND presence/absence of `  FAIL:` lines
 * (status-only is the silent-pass class per test-quality.md).
 *
 * Cases:
 *   Positive-1:  path leak (/Users/bernhardg/...)          → status 1, FAIL
 *   Positive-2:  gitlab host (gitlab.gotzendorfer.at)      → status 1, FAIL
 *   Positive-3:  private slug (buchhaltgenie)              → status 1, FAIL
 *   Positive-4:  @goetzendorfer/ scope import              → status 1, FAIL
 *   Positive-5:  events.gotzendorfer.at string-literal
 *                NOT in doc-comment form                   → status 1, FAIL
 *   Negative-1:  clean fixture                             → status 0, PASS, 0 FAIL
 *   Exclusion-1: SECURITY.md security@gotzendorfer.at      → status 0
 *   Exclusion-2: README.md homepage URL                    → status 0
 *   Exclusion-3: manifest author block                     → status 0
 *   Exclusion-4: events test doc-comment line              → status 0
 *   Exclusion-bypass: real leak inside excluded file
 *                (SECURITY.md with /Users/bernhardg/)      → status 1, FAIL
 *   Edge:        empty / no-git repo                       → status 0
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run the check CLI synchronously against a given root.
 * @param {string} root
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function runCheck(root) {
  return spawnSync(process.execPath, [SCRIPT, root], {
    encoding: 'utf8',
    timeout: 20_000,
  });
}

/**
 * Create a tmpdir with a git-init'd repo (no real git needed — just needs
 * ls-files to work) OR an empty dir for the no-git edge case.
 * @param {(root: string) => void} setupFn - write files into root
 * @param {{initGit?: boolean}} [opts]
 * @returns {string} tmpdir path
 */
function makeTmpRepo(setupFn, { initGit = true } = {}) {
  const root = mkdtempSync(join(os.tmpdir(), 'owner-leakage-test-'));
  if (initGit) {
    // Minimal git init so `git ls-files` works
    spawnSync('git', ['init', '-b', 'main'], { cwd: root, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: root, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root, encoding: 'utf8' });
  }
  setupFn(root);
  if (initGit) {
    // Stage all files so git ls-files can enumerate them
    spawnSync('git', ['add', '-A'], { cwd: root, encoding: 'utf8' });
  }
  return root;
}

/** Count occurrences of substring in string */
function countOccurrences(str, sub) {
  let count = 0;
  let pos = 0;
  while ((pos = str.indexOf(sub, pos)) !== -1) { count++; pos += sub.length; }
  return count;
}

// ---------------------------------------------------------------------------
// Positive-1: personal home path (/Users/bernhardx/...)
// ---------------------------------------------------------------------------

describe('Positive-1: personal home path leak', () => {
  it('exits 1 when a tracked file contains a /Users/bernhardg/ path', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'leak.md'), '# test\nPath: /Users/bernhardg/secret/config.txt\n');
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL:');
  });

  it('FAIL line mentions the file name', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'leak.md'), 'run: /Users/bernhardg./Projects/foo/bar.mjs\n');
    });
    const result = runCheck(root);
    expect(result.stdout).toContain('  FAIL:');
    expect(result.stdout).toContain('leak.md');
  });

  // --- Issue #631 regressions: bare trailing-dot home path (no slash after) ---

  it('exits 1 on bare /Users/bernhardg. at end-of-line (issue #631 blindspot)', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'leak.md'), 'home: /Users/bernhardg.\n');
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL:');
  });

  it('exits 1 on /Users/bernhardg. before " && ls" (issue #631 blindspot)', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'leak.sh'), 'cd /Users/bernhardg. && ls\n');
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL:');
  });

  it('exits 1 on home=/Users/bernhardg. followed by a newline (issue #631 blindspot)', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'leak.txt'), 'home=/Users/bernhardg.\nnext line\n');
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL:');
  });

  it('still exits 1 on /Users/bernhardg./ and /Users/bernhardg./Projects/x (no regression)', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(
        join(r, 'leak.md'),
        'a: /Users/bernhardg./\nb: /Users/bernhardg./Projects/x\n',
      );
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL:');
  });

  it('exits 0 on near-miss prefixes /Users/bernhardo-other/ and /Users/bernhardgXfoo (false-positive guard)', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(
        join(r, 'clean.md'),
        'a: /Users/bernhardo-other/\nb: /Users/bernhardgXfoo\n',
      );
    });
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(countOccurrences(result.stdout, '  FAIL:')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Positive-2: private GitLab host
// ---------------------------------------------------------------------------

describe('Positive-2: private GitLab host', () => {
  it('exits 1 when a tracked file contains gitlab.gotzendorfer.at', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'config.md'), 'host: gitlab.gotzendorfer.at\n');
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL:');
  });
});

// ---------------------------------------------------------------------------
// Positive-3: private slug
// ---------------------------------------------------------------------------

describe('Positive-3: private project slug', () => {
  it('exits 1 when a tracked file contains the slug "buchhaltgenie"', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'notes.md'), 'See repo buchhaltgenie for details.\n');
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL:');
  });

  it('exits 1 for other private slugs (AngebotsChecker)', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'test.mjs'), '// target: AngebotsChecker\n');
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL:');
  });
});

// ---------------------------------------------------------------------------
// Positive-4: @goetzendorfer/ scope import
// ---------------------------------------------------------------------------

describe('Positive-4: @goetzendorfer/ package scope', () => {
  it('exits 1 when a tracked file imports from @goetzendorfer/', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(
        join(r, 'index.mjs'),
        "import { createFactory } from '@goetzendorfer/testing-utils';\n",
      );
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL:');
  });
});

// ---------------------------------------------------------------------------
// Positive-5: events.gotzendorfer.at NOT in doc-comment form
// ---------------------------------------------------------------------------

describe('Positive-5: events.gotzendorfer.at string-literal (not doc-comment)', () => {
  it('exits 1 when events.gotzendorfer.at appears as a string-literal (not JSDoc)', () => {
    const root = makeTmpRepo((r) => {
      // A real string constant — NOT the excluded doc-comment form
      writeFileSync(
        join(r, 'config.mjs'),
        "const EVENTS_URL = 'https://events.gotzendorfer.at/hook';\n",
      );
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL:');
  });

  it('exits 1 even when the events reference is in a JSON value', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(
        join(r, 'settings.json'),
        '{"webhookUrl": "https://events.gotzendorfer.at/webhook"}\n',
      );
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL:');
  });
});

// ---------------------------------------------------------------------------
// Positive-6: full RFC1918 private dotted-quad (P8)
// ---------------------------------------------------------------------------

describe('Positive-6: RFC1918 private IP leak (P8)', () => {
  it('exits 1 when a tracked file contains a 10.x.x.x private IP', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'infra.md'), '# Infra\nThe service runs at 10.1.2.3 internally.\n');
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL:');
    expect(result.stdout).toContain('P8');
  });

  it('exits 1 for 192.168.x.x and 172.16-31.x.x private IPs', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'a.md'), 'gateway 192.168.1.1\n');
      writeFileSync(join(r, 'b.md'), 'host 172.20.0.5\n');
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(countOccurrences(result.stdout, 'P8')).toBeGreaterThanOrEqual(2);
  });

  it('does NOT flag placeholder .x forms or TEST-NET (192.0.2.x) — SSRF docs stay clean', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(
        join(r, 'ssrf.md'),
        'Blocks private ranges (10.x, 172.16-31.x, 192.168.x, 127.x). Example 192.0.2.1 (TEST-NET).\n',
      );
    });
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(countOccurrences(result.stdout, '  FAIL:')).toBe(0);
  });

  it('does NOT flag 172.15/172.32 (outside the private 16-31 range)', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'public.md'), 'public 172.15.0.1 and 172.32.0.1\n');
    });
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(countOccurrences(result.stdout, '  FAIL:')).toBe(0);
  });

  it('exempts the IP-redaction test file (P8_ALLOWLIST) from P8', () => {
    const root = makeTmpRepo((r) => {
      mkdirSync(join(r, 'tests', 'scripts'), { recursive: true });
      writeFileSync(
        join(r, 'tests', 'scripts', 'export-hw-learnings.test.mjs'),
        "const s = 'Server at 10.0.0.1 responded';\n",
      );
    });
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(countOccurrences(result.stdout, '  FAIL:')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Negative-1: clean fixture
// ---------------------------------------------------------------------------

describe('Negative-1: clean fixture', () => {
  it('exits 0 when no tracked files contain any forbidden pattern', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'README.md'), '# Clean Plugin\n\nNo private data here.\n');
      writeFileSync(join(r, 'index.mjs'), '// clean file\nexport default {};\n');
    });
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('  PASS:');
    expect(countOccurrences(result.stdout, '  FAIL:')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Exclusion-1: SECURITY.md with security@gotzendorfer.at only
// ---------------------------------------------------------------------------

describe('Exclusion-1: sanctioned email in SECURITY.md', () => {
  it('exits 0 when SECURITY.md contains only security@gotzendorfer.at (no other token)', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(
        join(r, 'SECURITY.md'),
        '# Security\n\n**Email:** security@gotzendorfer.at\n',
      );
    });
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(countOccurrences(result.stdout, '  FAIL:')).toBe(0);
  });

  it('exits 0 when SECURITY.md contains only office@gotzendorfer.at (no other token)', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(
        join(r, 'SECURITY.md'),
        'Contact: office@gotzendorfer.at for issues.\n',
      );
    });
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(countOccurrences(result.stdout, '  FAIL:')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Exclusion-2: README.md homepage URL
// ---------------------------------------------------------------------------

describe('Exclusion-2: homepage URL in README.md', () => {
  it('exits 0 when README.md contains https://gotzendorfer.at homepage URL', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(
        join(r, 'README.md'),
        '- [Homepage](https://gotzendorfer.at/en/session-orchestrator)\n',
      );
    });
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(countOccurrences(result.stdout, '  FAIL:')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Exclusion-3: manifest author block
// ---------------------------------------------------------------------------

describe('Exclusion-3: manifest author block in .claude-plugin/plugin.json', () => {
  it('exits 0 when .claude-plugin/plugin.json has author email + url (sanctioned URLs/emails)', () => {
    const root = makeTmpRepo((r) => {
      mkdirSync(join(r, '.claude-plugin'), { recursive: true });
      const manifest = {
        name: 'test-plugin',
        author: {
          email: 'office@gotzendorfer.at',
          url: 'https://gotzendorfer.at',
        },
        homepage: 'https://gotzendorfer.at/en/session-orchestrator',
      };
      writeFileSync(join(r, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n');
    });
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(countOccurrences(result.stdout, '  FAIL:')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Exclusion-4: events-default-url.test.mjs doc-comment line
// ---------------------------------------------------------------------------

describe('Exclusion-4: events doc-comment line in tests/lib/events-default-url.test.mjs', () => {
  it('exits 0 when the exact JSDoc contract line references events.gotzendorfer.at', () => {
    const root = makeTmpRepo((r) => {
      mkdirSync(join(r, 'tests', 'lib'), { recursive: true });
      // Write ONLY the excluded doc-comment form — no other string-literal occurrences
      writeFileSync(
        join(r, 'tests', 'lib', 'events-default-url.test.mjs'),
        [
          '/**',
          ' * Contract:',
          ' *   - No literal `events.gotzendorfer.at` URL appears anywhere in scripts/ or hooks/.',
          ' */',
          "import { describe, it } from 'vitest';",
          "describe('placeholder', () => { it('runs', () => {}); });",
        ].join('\n') + '\n',
      );
    });
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(countOccurrences(result.stdout, '  FAIL:')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Exclusion-bypass: real leak INSIDE an "excluded" file bypasses exclusion
// ---------------------------------------------------------------------------

describe('Exclusion-bypass: real leak inside a normally-excluded file', () => {
  it('exits 1 when SECURITY.md has /Users/bernhardg/ path (not covered by email exclusion)', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(
        join(r, 'SECURITY.md'),
        '**Email:** security@gotzendorfer.at\nSee: /Users/bernhardg/secret.key\n',
      );
    });
    const result = runCheck(root);
    // The /Users/bernhardg/ line is not covered by any exclusion → FAIL
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL:');
  });

  it('exits 1 when events-default-url.test.mjs has a real string-literal (not doc-comment form)', () => {
    const root = makeTmpRepo((r) => {
      mkdirSync(join(r, 'tests', 'lib'), { recursive: true });
      writeFileSync(
        join(r, 'tests', 'lib', 'events-default-url.test.mjs'),
        [
          '/**',
          ' *   - No literal `events.gotzendorfer.at` URL appears anywhere.',
          ' */',
          "// This is a real string literal (NOT the excluded doc-comment form):",
          "const HARDCODED = 'https://events.gotzendorfer.at/hook';",
        ].join('\n') + '\n',
      );
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL:');
  });
});

// ---------------------------------------------------------------------------
// Exclusion-5: persona content-lint test file (self-exclusion)
// ---------------------------------------------------------------------------
//
// tests/templates/personas/content-lint.test.mjs asserts that persona template
// files do NOT contain leakage strings. Its assertion literals must therefore
// CONTAIN those strings (e.g. `expect(c).not.toContain('@gotzendorfer.at')`).
// The scanner would flag those literals as leaks, so the file is in
// SELF_EXCLUSIONS — same pattern as the scanner's own source + test files.
// Regression guard for pipeline #4365 / housekeeping-2 2026-05-19.

describe('Exclusion-5: persona content-lint detection-fixture file', () => {
  it('exits 0 when leakage strings appear inside tests/templates/personas/content-lint.test.mjs', () => {
    const root = makeTmpRepo((r) => {
      // Mirror the real layout exactly — exclusion is matched by relative path
      mkdirSync(join(r, 'tests', 'templates', 'personas'), { recursive: true });
      writeFileSync(
        join(r, 'tests', 'templates', 'personas', 'content-lint.test.mjs'),
        [
          "import { describe, it, expect } from 'vitest';",
          "describe('owner-leakage guard', () => {",
          "  it('does not contain personal email @gotzendorfer.at', () => {",
          "    expect(content).not.toContain('@gotzendorfer.at');",
          "  });",
          "  it('does not contain private repo name buchhaltgenie', () => {",
          "    expect(content).not.toContain('buchhaltgenie');",
          "  });",
          "});",
          "",
        ].join('\n'),
      );
    });
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('  FAIL:');
  });

  it('still flags the same leak strings at a different path (exclusion is path-scoped)', () => {
    const root = makeTmpRepo((r) => {
      // Same content, different path — must NOT be excluded
      writeFileSync(
        join(r, 'somewhere-else.test.mjs'),
        "expect(content).not.toContain('@gotzendorfer.at');\n",
      );
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL:');
  });
});

// ---------------------------------------------------------------------------
// P3 depth: additional scanner edge-cases (Wave-3 additions)
// ---------------------------------------------------------------------------

describe('P3 depth: scanner edge-cases', () => {
  // --- bare /Users/bernhardg without trailing dot (zero [a-z.]* chars + \b) ---
  it('exits 1 on bare /Users/bernhardg (no dot) at end-of-line', () => {
    // Regex: /\/Users\/bernhardg[a-z.]*(\/|\b)/ — zero chars after g, then \b fires at EOL.
    // Mutation guard: restoring the OLD regex /\/Users\/bernhardg[a-z.]*\// would
    // require a slash after the username, so bare /Users/bernhardg at EOL would NOT
    // match and this test would fail → catches the #631 regression class.
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'leak.txt'), 'USER_HOME=/Users/bernhardg\n');
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL:');
  });

  // --- /Users/bernhardg. inside JSON quotes ---
  it('exits 1 on /Users/bernhardg. inside a JSON string value', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(
        join(r, 'config.json'),
        '{"home": "/Users/bernhardg."}\n',
      );
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL:');
  });

  // --- env-assignment form mid-file ---
  it('exits 1 on BERNHARD_HOME=/Users/bernhardg. env-assignment form in a scanned .sh file', () => {
    // Tests that mid-line env-assignment syntax (VAR=/Users/bernhardg.) is caught.
    // Uses a .sh extension which IS in TEXT_EXTS; .env.example has extname ".example"
    // which is NOT in TEXT_EXTS and therefore NOT scanned (pinned by the .png test below).
    const root = makeTmpRepo((r) => {
      writeFileSync(
        join(r, 'setup.sh'),
        '#!/bin/sh\nBERNHARD_HOME=/Users/bernhardg.\nexport BERNHARD_HOME\n',
      );
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL:');
  });

  // --- case-sensitivity: lowercase /users/bernhardg. must NOT match ---
  it('exits 0 on lowercase /users/bernhardg. (P1 is case-sensitive — /Users only)', () => {
    // P1 = /\/Users\/bernhardg.../ — no i flag; lowercase /users/ is not an owner path.
    // Pins the case-sensitivity contract so a future `gi` flag change triggers a test failure.
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'notes.md'), 'see /users/bernhardg. for config\n');
    });
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(countOccurrences(result.stdout, '  FAIL:')).toBe(0);
  });

  // --- multiple P1 hits on one line: violations array records one per match site ---
  it('reports at least one FAIL when a single line has two /Users/bernhardg. paths', () => {
    // The scanner loops lines and records one violation per pattern per line.
    // This test pins that multiple hits on one line produce at least one FAIL entry.
    const root = makeTmpRepo((r) => {
      writeFileSync(
        join(r, 'multi.sh'),
        'cp /Users/bernhardg./src /Users/bernhardg./dst\n',
      );
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    // At least one FAIL: line must appear — the exact count is impl-specific (1 per line).
    expect(countOccurrences(result.stdout, '  FAIL:')).toBeGreaterThanOrEqual(1);
  });

  // --- /Users/bernhardgoetzendorfer/ (old all-lowercase username form) must still match ---
  it('exits 1 on /Users/bernhardgoetzendorfer/ (old full-username form, #605 drift class)', () => {
    // Critical regression guard: Candidate F regex must still catch the original
    // long-form username via the [a-z.]* suffix + trailing slash.
    // Mutation: removing [a-z.]* from P1 would make this test fail.
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'legacy.md'), 'Path: /Users/bernhardgoetzendorfer/projects/\n');
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL:');
  });

  // --- binary/non-TEXT_EXTS file (e.g. .png) is NOT scanned even if it has text content ---
  it('exits 0 when a leak string lives only in a .png file (outside TEXT_EXTS allowlist)', () => {
    // TEXT_EXTS = {.md, .mjs, .js, .ts, .json, .yml, .yaml, .sh, .txt}
    // .png is not in the list → the file is skipped → no FAIL even if it contains the pattern.
    // Pins the enumeration-contract: only whitelisted extensions are scanned.
    const root = makeTmpRepo((r) => {
      // .png extension but plain text content containing a P1 hit
      writeFileSync(join(r, 'image.png'), '/Users/bernhardg./secret\n');
    });
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(countOccurrences(result.stdout, '  FAIL:')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Edge: empty dir / no-git repo
// ---------------------------------------------------------------------------

describe('Edge: empty dir or no-git repo', () => {
  it('exits 0 against an empty dir (no tracked files, git init without commits)', () => {
    const root = makeTmpRepo(() => {
      // No files — git repo exists but nothing tracked
    });
    const result = runCheck(root);
    // No files to scan → either 0 violations (status 0) or PASS
    expect(result.status).toBe(0);
  });

  it('exits 0 against a non-git dir with no text files matching forbidden patterns', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'clean.md'), '# Hello world\n');
    }, { initGit: false });
    const result = runCheck(root);
    expect(result.status).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// W5 fold-in (W3-P3 finding): .env.example DOTFILE_ALLOWLIST reachability —
// extname('.env.example') is '.example' (truthy), so the pre-fix extension-first
// isTextFile() never reached the dotfile allowlist and silently skipped the file.
// Mutation caught: reverting isTextFile() to extension-first makes this exit 0.
// ---------------------------------------------------------------------------

describe('fold-in: .env.example is scanned (dotfile-allowlist reachability)', () => {
  it('exits 1 on a home-path leak inside .env.example', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, '.env.example'), 'OWNER_HOME=/Users/bernhardg.\n');
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(countOccurrences(result.stdout, '  FAIL:')).toBe(1);
  });

  it('exits 0 on a clean .env.example (still scanned, no false positive)', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, '.env.example'), 'API_URL=https://api.example.com\n');
    });
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(countOccurrences(result.stdout, '  FAIL:')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// W5 fold-in (#634 + W4 qa-strategist boundary pins):
// P9 dash-encoded home path + Candidate-F word-boundary intent documentation.
// ---------------------------------------------------------------------------

describe('fold-in: P9 dash-encoded home path (#634)', () => {
  it('exits 1 on the Claude-Code projects-dir encoded form', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(
        join(r, 'doc.md'),
        'See .claude/projects/-Users-bernhardg--Projects-x/memory/foo.md for details\n',
      );
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(countOccurrences(result.stdout, '  FAIL:')).toBe(1);
    // #661: the dash-form is now caught by the canonical CP1 rule (it collapses
    // to /Users/bernhardg…), not a dedicated P9 regex. The label reflects that.
    expect(result.stdout).toContain('CP1 (personal home path — canonicalized)');
  });

  it('exits 0 on a dash-encoded path of a different user', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'doc.md'), 'See -Users-alice--Projects-x/memory/foo.md\n');
    });
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(countOccurrences(result.stdout, '  FAIL:')).toBe(0);
  });
});

describe('fold-in: Candidate-F word-boundary intent pins (W4 qa)', () => {
  it('does NOT match digit-continuation /Users/bernhardg9/ (different user, out-of-scope near-miss)', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'a.md'), 'path: /Users/bernhardg9/proj\n');
    });
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(countOccurrences(result.stdout, '  FAIL:')).toBe(0);
  });

  it('does NOT match underscore-continuation /Users/bernhardg_home (different user)', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'a.md'), 'path: /Users/bernhardg_home\n');
    });
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(countOccurrences(result.stdout, '  FAIL:')).toBe(0);
  });

  it('DOES match hyphen-suffixed /Users/bernhardg-backup/ (owner prefix + non-word boundary = leak)', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'a.md'), 'path: /Users/bernhardg-backup/x\n');
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(countOccurrences(result.stdout, '  FAIL:')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// P10: personal-name segment in a Projects path (#653)
//
// Finding-1 (HIGH): the original P10 `~/Projects/<Name>/` form REQUIRED a
// trailing slash, so a bare `~/Projects/Bernhard` (end-of-line, before `&&`)
// slipped through — the exact blindspot P1 was already patched for.
// Finding-3 (defense-in-depth): the original P10 matched only the ~/-prefixed
// form, so an absolute-home leak (`/Users/alice/Projects/Bernhard/vault` or
// `/home/ci/Projects/Bernhard`) slipped both P1 and P10.
//
// These tests assert real scanner behavior (status + FAIL/P10 marker), not the
// regex in isolation — per .claude/rules/testing.md (no test-the-mock).
// ---------------------------------------------------------------------------

describe('P10: ~/Projects/<PersonalName> leak (#653)', () => {
  it('exits 1 on ~/Projects/Bernhard/vault (trailing-slash form, base case)', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'config.yaml'), 'vault-dir: ~/Projects/Bernhard/vault\n');
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL:');
    expect(result.stdout).toContain('P10');
  });

  it('exits 1 on a BARE ~/Projects/Bernhard at end-of-line (Finding-1 regression guard)', () => {
    // Mutation guard: restoring the OLD `~/Projects/Bernhard/` form (mandatory
    // trailing slash) would NOT match this bare end-of-line ref → this test fails.
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'notes.md'), 'plan-baseline-path: ~/Projects/Bernhard\n');
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL:');
    expect(result.stdout).toContain('P10');
  });

  it('exits 1 on absolute /Users/<user>/Projects/Bernhard/x (Finding-3 defense-in-depth)', () => {
    // A non-owner home (alice) — slips both P1 (bernhardg-anchored) and the old
    // tilde-only P10. The absolute-home alternation catches it.
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'ci.sh'), 'cp /Users/someone/Projects/Bernhard/data ./out\n');
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL:');
    expect(result.stdout).toContain('P10');
  });

  it('exits 1 on absolute /home/<user>/Projects/Bernhard (Linux home, no trailing slash)', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'ci.yml'), 'workdir: /home/ci/Projects/Bernhard\n');
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL:');
    expect(result.stdout).toContain('P10');
  });

  it('exits 0 when ~/Projects/Bernhard lives inside a P10_ALLOWLIST file (allowlist works)', () => {
    // scripts/migrate-vault-paths.mjs is a one-shot-migration source whose whole
    // job is to reference the legacy ~/Projects/Bernhard path — it is allowlisted.
    const root = makeTmpRepo((r) => {
      mkdirSync(join(r, 'scripts'), { recursive: true });
      writeFileSync(
        join(r, 'scripts', 'migrate-vault-paths.mjs'),
        "const LEGACY = '~/Projects/Bernhard/vault';\nexport default LEGACY;\n",
      );
    });
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(countOccurrences(result.stdout, '  FAIL:')).toBe(0);
  });

  it('still flags ~/Projects/Bernhard at a non-allowlisted path (allowlist is path-scoped)', () => {
    const root = makeTmpRepo((r) => {
      // Same content as the allowlist fixture, different path → must NOT be excluded
      writeFileSync(join(r, 'somewhere-else.mjs'), "const LEGACY = '~/Projects/Bernhard/vault';\n");
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL:');
    expect(result.stdout).toContain('P10');
  });

  it('exits 0 on ~/Projects/vault (no personal name — false-positive guard)', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'clean.yaml'), 'vault-dir: ~/Projects/vault\n');
    });
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(countOccurrences(result.stdout, '  FAIL:')).toBe(0);
  });

  it('exits 0 on ~/Projects/Bernhardt/ (name starts with denylisted name but continues — false-positive guard)', () => {
    // The 't' continuation means no word boundary after "Bernhard" and no slash
    // immediately after it → no match. Proves the denylist does not over-match
    // names that merely begin with a denylisted name.
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'clean.md'), 'path: ~/Projects/Bernhardt/app\n');
    });
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(countOccurrences(result.stdout, '  FAIL:')).toBe(0);
  });

  it('exits 0 on ~/Projects/MyApp/ (legit capitalized project dir — false-positive guard)', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'clean.md'), 'cd ~/Projects/MyApp/src\n');
    });
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(countOccurrences(result.stdout, '  FAIL:')).toBe(0);
  });
});

// ===========================================================================
// #661: Canonicalization-before-matching — regression CORPUS
//
// The one-encoding-at-a-time regex treadmill (P1 slash-form #631, P9
// dash-encoded #634, …) is replaced by a single canonicalization step. These
// tests pin two contracts:
//   A. matchOwnerPath() / canonicalizeLine() unit behavior — every historical
//      evasion variant AND a panel of NOVEL encodings all canonicalize to the
//      same /Users/bernhardg… form and are DETECTED; the lookalike negatives
//      and the case-sensitivity contract are NOT flagged.
//   B. End-to-end: a synthesized novel encoding planted in a tracked file is
//      caught by the CLI (acceptance criterion: "new encodings cannot silently
//      pass").
//
// Per .claude/rules/testing.md: expected booleans are hardcoded literals (not
// computed), each test has ≥1 meaningful assertion, behavior is tested (the
// detector's verdict) not implementation, and both happy + error/edge cases
// are covered.
// ===========================================================================

describe('#661 corpus A: matchOwnerPath — historical + novel encodings DETECTED', () => {
  // Each row: [label, input line]. Every one MUST be detected as a leak.
  // Hardcoded expectation: matchOwnerPath() returns a non-null label string.
  const DETECTED = [
    ['P1 plain slash-form', '/Users/bernhardg/secret/config.txt'],
    ['P1 trailing-dot', 'home: /Users/bernhardg.'],
    ['P1 bare no-dot at EOL (#631)', 'USER_HOME=/Users/bernhardg'],
    ['P1 before " && ls" (#631)', 'cd /Users/bernhardg. && ls'],
    ['P1 inside JSON quotes', '{"home": "/Users/bernhardg."}'],
    ['P1 hyphen-suffixed', 'path: /Users/bernhardg-backup/x'],
    ['P1 full legacy username', 'Path: /Users/bernhardgoetzendorfer/projects/'],
    ['P9 dash-encoded projects-dir (#634)', 'See -Users-bernhardg--Projects-x/memory/foo.md'],
    ['P9 dash-encoded bare', 'dir=-Users-bernhardg'],
    ['NOVEL url-percent encoded', 'p=%2FUsers%2Fbernhardg%2Fsecret'],
    ['NOVEL url-percent uppercase hex', 'p=%2fUsers%2fbernhardg'],
    ['NOVEL double-percent encoded', 'p=%252FUsers%252Fbernhardg'],
    ['NOVEL backslash separators', String.raw`p=\Users\bernhardg\secret`],
    ['NOVEL homoglyph division-slash (∕)', 'p=∕Users∕bernhardg∕secret'],
    ['NOVEL homoglyph fullwidth-slash (／)', 'p=／Users／bernhardg'],
    ['NOVEL html numeric entity (&#47;)', 'p=&#47;Users&#47;bernhardg'],
    ['NOVEL html hex entity (&#x2F;)', 'p=&#x2F;Users&#x2F;bernhardg'],
    ['NOVEL html named entity (&sol;)', 'p=&sol;Users&sol;bernhardg'],
  ];

  for (const [label, line] of DETECTED) {
    it(`DETECTS: ${label}`, () => {
      // Hardcoded literal expectation — a leak must be reported (truthy label).
      expect(matchOwnerPath(line)).toBe('CP1 (personal home path — canonicalized)');
    });
  }
});

describe('#661 corpus A: matchOwnerPath — benign + lookalike NOT flagged', () => {
  // Each MUST be clean. Hardcoded expectation: matchOwnerPath() returns null.
  const CLEAN = [
    ['near-miss diverges before g (bernhardo)', '/Users/bernhardo-other/'],
    ['near-miss uppercase continuation (bernhardgXfoo)', '/Users/bernhardgXfoo'],
    ['near-miss digit continuation (bernhardg9)', '/Users/bernhardg9/proj'],
    ['near-miss underscore continuation (bernhardg_home)', '/Users/bernhardg_home'],
    ['case-sensitivity contract: lowercase /users', 'see /users/bernhardg. for config'],
    ['other-user dash-encoded (alice)', '-Users-alice--Projects-x/memory/foo.md'],
    ['self-doc: quotes old P1 regex', 'P1 regex `/\\/Users\\/bernhardg[a-z.]*(\\/|\\b)/` is tight'],
    ['self-doc: quotes P9 dash regex', 'added P9 `/-Users-bernhardg[a-z.]*-/`'],
    ['benign capitalized project dir', '~/Projects/MyApp/src'],
    ['benign clean url', 'API_URL=https://api.example.com'],
    ['empty string', ''],
  ];

  for (const [label, line] of CLEAN) {
    it(`CLEAN: ${label}`, () => {
      // Hardcoded literal expectation — no leak reported.
      expect(matchOwnerPath(line)).toBe(null);
    });
  }
});

describe('#661 corpus A: canonicalizeLine — separator normalization (case preserved)', () => {
  it('collapses url-percent slashes to /Users/bernhardg (capital U preserved)', () => {
    expect(canonicalizeLine('%2FUsers%2Fbernhardg')).toContain('/Users/bernhardg');
  });

  it('collapses backslash separators to forward slashes', () => {
    expect(canonicalizeLine(String.raw`\Users\bernhardg`)).toContain('/Users/bernhardg');
  });

  it('collapses dash-encoded projects-dir to /Users/bernhardg', () => {
    expect(canonicalizeLine('-Users-bernhardg--Projects-x')).toContain('/Users/bernhardg');
  });

  it('collapses homoglyph division-slash (∕) to ASCII /', () => {
    expect(canonicalizeLine('∕Users∕bernhardg')).toContain('/Users/bernhardg');
  });

  it('decodes html numeric entity &#47; to /', () => {
    expect(canonicalizeLine('&#47;Users&#47;bernhardg')).toContain('/Users/bernhardg');
  });

  it('PRESERVES letter case (lowercase /users stays lowercase)', () => {
    // Case-sensitivity contract: a lowercased path must not be upper-cased into
    // a false /Users match. Hardcoded: the output must NOT contain capital-U form.
    expect(canonicalizeLine('/users/bernhardg.')).not.toContain('/Users/bernhardg');
  });

  it('PRESERVES uppercase username continuation (bernhardgX stays X)', () => {
    // /Users/bernhardgXfoo must keep the capital X so [a-z.]* stops at it.
    expect(canonicalizeLine('/Users/bernhardgXfoo')).toContain('bernhardgX');
  });
});

describe('#661 corpus B: end-to-end — novel encoding planted in a tracked file is caught', () => {
  it('exits 1 on a url-percent-encoded home path in a tracked .md file', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'leak.md'), 'config path: %2FUsers%2Fbernhardg%2Fsecret\n');
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL:');
    expect(result.stdout).toContain('CP1 (personal home path — canonicalized)');
  });

  it('exits 1 on a backslash-separated home path (Windows-style spelling)', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'leak.txt'), String.raw`p=\Users\bernhardg\config` + '\n');
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL:');
  });

  it('exits 1 on a homoglyph-slash home path (unicode evasion)', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'leak.md'), 'p=∕Users∕bernhardg∕secret\n');
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL:');
  });

  it('exits 1 on an html-entity-encoded home path', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'leak.md'), 'p=&#47;Users&#47;bernhardg\n');
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL:');
  });

  it('exits 0 on a benign file that merely contains hyphenated words (no false-positive)', () => {
    // The dash→slash canonicalization is over-broad by design; this pins that it
    // does NOT manufacture a /Users/bernhardg hit out of ordinary hyphenated prose.
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'clean.md'), 'See multi-story autopilot and cross-repo audit notes.\n');
    });
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(countOccurrences(result.stdout, '  FAIL:')).toBe(0);
  });
});

// ===========================================================================
// #661 security follow-up — HIGH/MED false-negative fixes (security-reviewer)
//
// Finding 1 (HIGH): capitalized username `/Users/Bernhardg.` evaded — the
//   username segment was matched case-SENSITIVELY. On case-insensitive APFS it
//   is a real operator path. Now matched case-INSENSITIVELY via a per-letter
//   token, while the HOST stays case-sensitive (`/Users`, not `/users`) and the
//   CONTINUATION class stays lowercase-only (so an uppercase-letter continuation
//   marks a DIFFERENT user and is NOT flagged).
// Finding 2 (MED): a real path on a line that also QUOTED the scanner regex was
//   suppressed wholesale. Now only the quoted regex TOKEN is blanked; the real
//   path on the same line is re-scanned and caught.
// Finding 3 (MED): zero-width / format chars spliced into the username
//   (`/Users/bern<U+200B>hardg`) evaded. Now stripped from the canonical form.
// Findings 4+5 (LOW): percent/entity/unicode-escape decoders now decode the
//   LETTERS of `Users`/`bernhardg` (not only separators), and the decode
//   pipeline loops to a FIXPOINT so a nested encoding (`%2555` → `%55` → `U`)
//   is caught.
//
// Per .claude/rules/testing.md: hardcoded literal expecteds, behavior-focused
// (the detector's verdict via matchOwnerPath / the CLI), ≥1 meaningful
// assertion, both DETECTED and CLEAN (boundary) cases pinned.
// ===========================================================================

describe('#661 follow-up: Finding 1 — case-insensitive username, narrow boundaries', () => {
  // The four operator-verified boundary cases, pinned as explicit assertions.
  it('DETECTS capitalized username /Users/Bernhardg./Projects/secret (Finding 1 fix)', () => {
    expect(matchOwnerPath('/Users/Bernhardg./Projects/secret')).toBe(
      'CP1 (personal home path — canonicalized)',
    );
  });

  it('DETECTS lowercase control /Users/bernhardg/secret (no regression)', () => {
    expect(matchOwnerPath('/Users/bernhardg/secret')).toBe(
      'CP1 (personal home path — canonicalized)',
    );
  });

  it('CLEAN on lowercase host /users/bernhardg/x (host stays case-SENSITIVE)', () => {
    // Mutation guard: adding the /i flag (instead of a per-letter username token)
    // would loosen the host anchor and make this match → this test fails.
    expect(matchOwnerPath('/users/bernhardg/x')).toBe(null);
  });

  it('CLEAN on uppercase continuation /Users/bernhardgXfoo (different user)', () => {
    // The continuation class [a-z.]* must stay lowercase-only so an uppercase
    // letter continuing the segment (= different user) stops the match.
    expect(matchOwnerPath('/Users/bernhardgXfoo')).toBe(null);
  });

  it('DETECTS legacy lowercase continuation /Users/bernhardgoetzendorfer/ (no regression)', () => {
    expect(matchOwnerPath('/Users/bernhardgoetzendorfer/')).toBe(
      'CP1 (personal home path — canonicalized)',
    );
  });

  it('exits 1 end-to-end on a capitalized-username leak in a tracked file', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'leak.md'), 'home: /Users/Bernhardg./Projects/secret\n');
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL:');
    expect(result.stdout).toContain('CP1 (personal home path — canonicalized)');
  });
});

describe('#661 follow-up: Finding 2 — regex-quote blanks only the token, not the line', () => {
  it('DETECTS a real path on a line that ALSO quotes the scanner regex (residue re-scan)', () => {
    // The real `/Users/bernhardg/Projects/secret` shares the line with a quoted
    // regex `/Users/bernhardg[a-z.]*`. Before the fix the whole line was
    // suppressed; now only the `…bernhardg[` token is blanked and the real path
    // is caught.
    expect(
      matchOwnerPath('Real: /Users/bernhardg/Projects/secret (see regex /Users/bernhardg[a-z.]*)'),
    ).toBe('CP1 (personal home path — canonicalized)');
  });

  it('CLEAN on a line that ONLY quotes the old P1 regex (self-doc, no real path)', () => {
    expect(matchOwnerPath('P1 regex `/\\/Users\\/bernhardg[a-z.]*(\\/|\\b)/` is tight')).toBe(null);
  });

  it('CLEAN on a line that ONLY quotes the P9 dash regex (self-doc)', () => {
    expect(matchOwnerPath('added P9 `/-Users-bernhardg[a-z.]*-/`')).toBe(null);
  });

  it('exits 1 end-to-end when a real leak shares a line with a quoted regex', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(
        join(r, 'doc.md'),
        'Real: /Users/bernhardg/Projects/secret (see regex /Users/bernhardg[a-z.]*)\n',
      );
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL:');
  });
});

describe('#661 follow-up: Finding 3 — zero-width / format chars stripped', () => {
  it('DETECTS a zero-width space spliced into the username (/Users/bern\\u200bhardg)', () => {
    // The \u200b escape produces the same ZWSP code point a real evasion would
    // splice in — kept as an escape (not a literal glyph) to keep source ASCII.
    expect(matchOwnerPath('/Users/bern\u200bhardg/secret')).toBe(
      'CP1 (personal home path — canonicalized)',
    );
  });

  it('DETECTS a soft-hyphen spliced into the username (/Users/bern\\u00adhardg)', () => {
    expect(matchOwnerPath('/Users/bern\u00adhardg/secret')).toBe(
      'CP1 (personal home path — canonicalized)',
    );
  });

  it('DETECTS a tab spliced into the username (/Users/bern\\thardg)', () => {
    expect(matchOwnerPath('/Users/bern\thardg/secret')).toBe(
      'CP1 (personal home path — canonicalized)',
    );
  });

  it('exits 1 end-to-end on a zero-width-spliced home path in a tracked file', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'leak.md'), 'p: /Users/bern\u200bhardg/secret\n');
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL:');
  });
});

describe('#661 follow-up: Findings 4+5 — letter-decoding + fixpoint loop', () => {
  it('DETECTS percent-encoded LETTERS of the path (/%55sers/%62ernhardg — Finding 4)', () => {
    expect(matchOwnerPath('/%55sers/%62ernhardg/secret')).toBe(
      'CP1 (personal home path — canonicalized)',
    );
  });

  it('DETECTS a decimal HTML entity for a LETTER (/&#85;sers/bernhardg — Finding 4)', () => {
    expect(matchOwnerPath('/&#85;sers/bernhardg/secret')).toBe(
      'CP1 (personal home path — canonicalized)',
    );
  });

  it('DETECTS a hex HTML entity for a LETTER (/&#x55;sers/bernhardg — Finding 4)', () => {
    expect(matchOwnerPath('/&#x55;sers/bernhardg/secret')).toBe(
      'CP1 (personal home path — canonicalized)',
    );
  });

  it('DETECTS a NESTED double-percent letter encoding (%2555 → %55 → U — Finding 5 fixpoint)', () => {
    expect(matchOwnerPath('/%2555sers/%2562ernhardg/secret')).toBe(
      'CP1 (personal home path — canonicalized)',
    );
  });

  it('exits 1 end-to-end on a percent-letter-encoded home path in a tracked file', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'leak.md'), 'p: /%55sers/%62ernhardg/secret\n');
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL:');
  });

  it('CLEAN on ordinary text with an unrelated percent escape (no false-positive)', () => {
    // %20 → space; this must NOT manufacture a /Users/bernhardg hit.
    expect(matchOwnerPath('cache%20dir is fine')).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// CP11: host-local confidential customer/repo names (#728a)
//
// The names list is HOST-LOCAL and never committed; the CLI resolves it via
// resolveHostPath('confidential-names-file', …), whose highest-precedence tier
// is the env-var SO_CONFIDENTIAL_NAMES_FILE. Tests inject a real temp names JSON
// via that env-var, written OUTSIDE the scanned root so the names file itself is
// never a scan subject. Fixture names are invented ('zenithcorp') — never a real
// confidential name (confidentiality invariant).
//
// LOAD-BEARING assertion: a CP11 hit must REDACT the matched name from stdout,
// because the checker runs in a PUBLIC GitHub-Actions mirror — the confidential
// name must NOT appear in the CI log even when the guard fires.
// ---------------------------------------------------------------------------

describe('CP11: confidential-name leak (host-local list)', () => {
  /**
   * Run the check CLI with a host-local confidential-names file injected via env.
   * The names file is written to a sibling tmpdir, never inside `root`.
   * @param {string} root - scanned repo root
   * @param {string[]} names - confidential names to write into the JSON list
   */
  function runCheckWithNames(root, names) {
    const namesDir = mkdtempSync(join(os.tmpdir(), 'owner-leakage-names-'));
    const namesFile = join(namesDir, 'confidential-names.json');
    writeFileSync(namesFile, JSON.stringify(names));
    return spawnSync(process.execPath, [SCRIPT, root], {
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, SO_CONFIDENTIAL_NAMES_FILE: namesFile },
    });
  }

  it('exits 1 and FAILs when a tracked file contains a configured confidential name', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'notes.md'), '# Client work\nWe onboarded zenithcorp last week.\n');
    });
    const result = runCheckWithNames(root, ['zenithcorp']);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL:');
    expect(result.stdout).toContain('CP11');
  });

  it('REDACTS the matched name from the FAIL output (load-bearing privacy invariant)', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'notes.md'), 'Contract signed with zenithcorp GmbH.\n');
    });
    const result = runCheckWithNames(root, ['zenithcorp']);
    expect(result.status).toBe(1);
    // The redaction sentinel is present …
    expect(result.stdout).toContain('[REDACTED]');
    // … and the confidential name itself NEVER reaches stdout.
    expect(result.stdout).not.toContain('zenithcorp');
  });

  it('matches case-insensitively and redacts every occurrence on the line', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'notes.md'), 'ZenithCorp and zenithcorp are the same client.\n');
    });
    const result = runCheckWithNames(root, ['zenithcorp']);
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('ZenithCorp');
    expect(result.stdout).not.toContain('zenithcorp');
    expect(result.stdout).toContain('[REDACTED]');
  });

  it('redacts ALL configured names on a line naming two DIFFERENT ones (multi-name leak)', () => {
    // CRITICAL CP11 privacy invariant: a line mentioning TWO distinct confidential
    // names must have BOTH redacted before its lineContent reaches the PUBLIC
    // GitHub-Actions log. Redacting only the FIRST matching pattern (and breaking)
    // echoes the SECOND NDA name verbatim to stdout — a worse leak than the one
    // being guarded. Both names must be absent; [REDACTED] must be present.
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'notes.md'), 'zenithcorp and apexglobal are both clients.\n');
    });
    const result = runCheckWithNames(root, ['zenithcorp', 'apexglobal']);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('CP11');
    expect(result.stdout).toContain('[REDACTED]');
    // NEITHER confidential name may reach stdout — the bug leaks at least one.
    expect(result.stdout).not.toContain('zenithcorp');
    expect(result.stdout).not.toContain('apexglobal');
  });

  it('PASSES a tracked file that contains no configured confidential name', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'notes.md'), 'We onboarded a new client this week.\n');
    });
    const result = runCheckWithNames(root, ['zenithcorp']);
    expect(result.status).toBe(0);
    expect(countOccurrences(result.stdout, '  FAIL:')).toBe(0);
  });

  // Fix 1 (architect): choke-point redaction — a confidential name that rides in on
  // a CP1–CP10 hit (here CP8, an RFC1918 IP) must be scrubbed from THAT violation's
  // lineContent too. Pre-fix RED: the CP8 FAIL line printed the name verbatim.
  it('redacts a confidential name that co-occurs with a CP8 (RFC1918 IP) hit — choke-point (Fix 1)', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'infra.md'), 'zenithcorp server runs at 10.1.2.3 internally\n');
    });
    const result = runCheckWithNames(root, ['zenithcorp']);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('P8');
    expect(result.stdout).not.toContain('zenithcorp');
    expect(result.stdout).toContain('[REDACTED]');
  });

  // Fix 2 (security, PoC-confirmed): order-independent redaction — a name that is a
  // PREFIX of another must not leak a suffix residue, in EITHER list order.
  it('order-independent redaction, ORDER A [short,long] — no suffix residue (Fix 2)', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'notes.md'), 'The acme-corp-secret-project launches soon.\n');
    });
    const result = runCheckWithNames(root, ['acme', 'acme-corp-secret-project']);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('CP11');
    expect(result.stdout).toContain('[REDACTED]');
    expect(result.stdout).not.toContain('acme-corp-secret-project');
    expect(result.stdout).not.toContain('-corp-secret-project');
  });

  it('order-independent redaction, ORDER B [long,short] — same input fully redacts (Fix 2)', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'notes.md'), 'The acme-corp-secret-project launches soon.\n');
    });
    const result = runCheckWithNames(root, ['acme-corp-secret-project', 'acme']);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('[REDACTED]');
    expect(result.stdout).not.toContain('acme-corp-secret-project');
    expect(result.stdout).not.toContain('-corp-secret-project');
  });

  it('is INACTIVE when the list is empty (configured but zero names)', () => {
    const root = makeTmpRepo((r) => {
      // A would-be confidential token — but the empty list means CP11 never fires.
      writeFileSync(join(r, 'notes.md'), 'Mentions zenithcorp explicitly.\n');
    });
    const result = runCheckWithNames(root, []);
    expect(result.status).toBe(0);
    expect(countOccurrences(result.stdout, 'CP11')).toBe(0);
  });

  it('is INACTIVE when no confidential-names file is configured (unconfigured default)', () => {
    // No SO_CONFIDENTIAL_NAMES_FILE override → env tier explicitly unset → owner.yaml
    // is unconfigured for this brand-new key on every host/CI this test runs on →
    // CP11 inactive. The invented token below is never a real confidential name.
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'notes.md'), 'A synthetic token zenithcorp-unconfigured appears here.\n');
    });
    const result = spawnSync(process.execPath, [SCRIPT, root], {
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, SO_CONFIDENTIAL_NAMES_FILE: '' },
    });
    expect(result.status).toBe(0);
    expect(countOccurrences(result.stdout, 'CP11')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// VAULT_CLEAR_SLUGS carve-out — in-process guard vs tracked-file scan (#59)
//
// The SPLIT (owner decision 2026-07-18): five slugs are cleared for use as an
// IN-PROCESS vault-namespace segment (isOwnerLeakySegment returns null) while
// STILL being blocked from leaking into TRACKED public-mirror files (runScan /
// the CLI still exits 1). isOwnerLeakySegment returns null when clean, or the
// pattern id string ('CP1'|'CP6'|'CP10') when leaky — asserted on that shape.
// ---------------------------------------------------------------------------
describe('VAULT_CLEAR_SLUGS carve-out — isOwnerLeakySegment (in-process guard)', () => {
  it('carved-out slug "buchhaltgenie" is NOT owner-leaky in-process (returns null)', () => {
    expect(isOwnerLeakySegment('buchhaltgenie')).toBe(null);
  });

  it('retained slug "aiat-pmo-module" IS still owner-leaky in-process (returns "CP6")', () => {
    // Proves the in-process CP6 guard still bites for the non-carved slugs — the
    // carve-out did not blanket-disable CP6.
    expect(isOwnerLeakySegment('aiat-pmo-module')).toBe('CP6');
    expect(isOwnerLeakySegment('Codex-Hackathon')).toBe('CP6');
  });

  it('carve-out is case-insensitive (BuchhaltGenie / MAIL-ASSISTANT → null)', () => {
    expect(isOwnerLeakySegment('BuchhaltGenie')).toBe(null);
    expect(isOwnerLeakySegment('MAIL-ASSISTANT')).toBe(null);
    expect(isOwnerLeakySegment('AngebotsChecker')).toBe(null);
  });

  it('all five VAULT_CLEAR_SLUGS members are cleared in-process', () => {
    // VAULT_CLEAR_SLUGS values are lowercased; each must be non-leaky in-process.
    for (const slug of VAULT_CLEAR_SLUGS) {
      expect(isOwnerLeakySegment(slug)).toBe(null);
    }
    expect(VAULT_CLEAR_SLUGS.size).toBe(5);
  });
});

describe('VAULT_CLEAR_SLUGS carve-out — tracked-file scanner UNCHANGED (#59 split proof)', () => {
  it('a carved-out slug ("mail-assistant") in a TRACKED file STILL fails the CLI scan (exit 1)', () => {
    // The load-bearing proof that the carve-out did NOT leak into runScan: the
    // public-mirror guard must still block every one of the 7 PRIVATE_SLUGS.
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'notes.md'), 'Deploy notes for mail-assistant service.\n');
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(countOccurrences(result.stdout, 'CP6')).toBeGreaterThan(0);
  });

  it('another carved-out slug ("launchpad-ai-factory") in a TRACKED file STILL fails the CLI scan (exit 1)', () => {
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'notes.md'), 'See launchpad-ai-factory for the epic.\n');
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(countOccurrences(result.stdout, 'CP6')).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Subset invariant: VAULT_CLEAR_SLUGS ⊆ PRIVATE_SLUGS
//
// PRIVATE_SLUGS itself is not exported from the scanner module (it is the
// CLOSED, audit-reviewed source list — see the module's own "list is CLOSED"
// comment), so this invariant is checked WITHOUT importing it: the
// tracked-file CLI scan's CP6 rule is built DIRECTLY from PRIVATE_SLUGS
// (`CP6_PATTERNS = PRIVATE_SLUGS.map(...)`), so "does the CLI flag this slug
// as CP6 when planted in a tracked file" is ground truth for "is this slug a
// member of PRIVATE_SLUGS" — the same CLI harness every other test in this
// file already relies on.
//
// Why this matters: `isOwnerLeakySegment(slug) === null` (asserted elsewhere
// in the "carved-out slug is NOT owner-leaky in-process" tests) is
// TAUTOLOGICAL for a typo'd/dead VAULT_CLEAR_SLUGS entry — ANY string that
// was never in PRIVATE_SLUGS ALSO returns null from isOwnerLeakySegment, so a
// bogus carve-out entry (e.g. "buchhaltgeni" instead of "buchhaltgenie")
// would silently pass review with zero test failure. This test instead
// asserts the actual SUBSET RELATIONSHIP the carve-out promises (#59): every
// VAULT_CLEAR_SLUGS member must be a REAL PRIVATE_SLUGS entry, i.e. the
// tracked-file scanner must still catch it as CP6. No slug value is
// hardcoded here — the loop drives entirely off the exported VAULT_CLEAR_SLUGS
// set, so the test survives future legitimate edits to either list.
// ---------------------------------------------------------------------------

describe('Subset invariant: VAULT_CLEAR_SLUGS ⊆ PRIVATE_SLUGS (#59)', () => {
  it('every VAULT_CLEAR_SLUGS entry is a real PRIVATE_SLUGS member — CP6 still catches it in a tracked file', () => {
    for (const slug of VAULT_CLEAR_SLUGS) {
      const root = makeTmpRepo((r) => {
        writeFileSync(join(r, 'membership-check.md'), `Reference to ${slug} here.\n`);
      });
      const result = runCheck(root);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('CP6');
    }
  });

  // Fake-regression demonstration (per PSA-006 / testing.md negative-assertion
  // discipline): a slug that was NEVER added to PRIVATE_SLUGS is NOT caught by
  // CP6 — proving that if a typo'd/dead entry were ever (accidentally) added to
  // the real VAULT_CLEAR_SLUGS export, the primary loop above would fail at
  // that exact slug (status !== 1 / no 'CP6' in stdout) instead of passing
  // tautologically. This is the same invariant-check logic as the primary
  // assertion, run against a synthetic value known to be OUTSIDE PRIVATE_SLUGS,
  // rather than a permanent mutation of VAULT_CLEAR_SLUGS itself.
  it('fake-regression control: a bogus slug NOT in PRIVATE_SLUGS is NOT flagged — the invariant check has teeth', () => {
    const bogusSlug = 'totally-bogus-slug-never-in-private-slugs-xyz';
    const root = makeTmpRepo((r) => {
      writeFileSync(join(r, 'bogus-membership-check.md'), `Reference to ${bogusSlug} here.\n`);
    });
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(countOccurrences(result.stdout, 'CP6')).toBe(0);
  });
});
