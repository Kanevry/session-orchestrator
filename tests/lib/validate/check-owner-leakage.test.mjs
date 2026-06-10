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
    expect(result.stdout).toContain('P9 (dash-encoded home path)');
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
