// @secret-shape-allowed — test file contains intentional fixture-shape literals (xoxb-, AKIA, AIzaSy) used as positive-case inputs for the validator under test. Marker placed in first 5 lines per hasAllowedMagicComment contract (#558 M3 — fold-out after SELF_EXCLUSIONS removal).
/**
 * tests/lib/validate/check-test-fixture-shapes.test.mjs
 *
 * Tests for scripts/lib/validate/check-test-fixture-shapes.mjs (#556).
 *
 * The check is a CLI script (not an importable module), so tests exercise it
 * via spawnSync(process.execPath, [SCRIPT, fixtureRoot]) against tmpdir
 * fixtures with minimal git-init for git ls-files enumeration.
 *
 * Every positive case asserts BOTH result.status AND presence of `  FAIL:`
 * lines (status-only is the silent-pass class per test-quality.md).
 *
 * Coverage:
 *   - 4 positive cases for the 4 patterns (F1–F4)
 *   - 4 allowlist cases (AWS canonical, sk_test_, xoxb-PLACEHOLDER,
 *     AIzaSy-PLACEHOLDER)
 *   - 1 magic-comment case
 *   - 1 scope case (production source not scanned)
 *   - 1 empty/control case
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'lib', 'validate', 'check-test-fixture-shapes.mjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Track tmpdirs for cleanup */
const tmpDirs = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

/**
 * Run the check CLI synchronously against a given root.
 * @param {string} root
 */
function runCheck(root) {
  return spawnSync(process.execPath, [SCRIPT, root], {
    encoding: 'utf8',
    timeout: 20_000,
  });
}

/**
 * Create a tmpdir with a git-init'd repo (so `git ls-files` works).
 * @param {(root: string) => void} setupFn - write files into root
 */
function makeTmpRepo(setupFn) {
  const root = mkdtempSync(join(os.tmpdir(), 'fixture-shape-test-'));
  tmpDirs.push(root);
  spawnSync('git', ['init', '-b', 'main'], { cwd: root, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: root, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root, encoding: 'utf8' });
  setupFn(root);
  // Stage all files so git ls-files can enumerate them
  spawnSync('git', ['add', '-A'], { cwd: root, encoding: 'utf8' });
  return root;
}

/** Write a file under tests/ — caller passes the basename or relative path */
function writeTestFile(root, relPath, content) {
  const full = join(root, 'tests', relPath);
  const dir = full.substring(0, full.lastIndexOf('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(full, content);
}

// ---------------------------------------------------------------------------
// Control: empty tests/ tree
// ---------------------------------------------------------------------------

describe('Control: empty tests/ tree', () => {
  it('exits 0 with empty tests/ tree', () => {
    const root = makeTmpRepo((r) => {
      // Write only a non-tests/ file so git has something to track
      writeFileSync(join(r, 'README.md'), '# test\n');
    });
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('  PASS:');
    expect(result.stdout).not.toContain('  FAIL:');
  });
});

// ---------------------------------------------------------------------------
// F1: Stripe sk_live_
// ---------------------------------------------------------------------------

describe('F1: Stripe sk_live_ pattern', () => {
  it('exits 1 when sk_live_<24+chars> is found', () => {
    const root = makeTmpRepo((r) => {
      // 26 chars after sk_live_ — well over the 24 minimum.
      // Literal split so the test file SOURCE never contains a contiguous Stripe-shape
      // pattern (GitHub secret-scanner protection — see issue #556 commit history).
      writeTestFile(r, 'leak.test.mjs', "const KEY = '" + 'sk_live' + "_" + "abcdefghijklmnopqrstuvwxyz12';\n");
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL:');
    expect(result.stdout).toContain('F1 (Stripe sk_live_)');
    expect(result.stdout).toContain('leak.test.mjs');
  });
});

// ---------------------------------------------------------------------------
// F2: Slack xoxb-<digits>
// ---------------------------------------------------------------------------

describe('F2: Slack xoxb-<digits> pattern', () => {
  it('exits 1 when xoxb-<6+digits> is found', () => {
    const root = makeTmpRepo((r) => {
      // 8 digits — over the 6 minimum
      writeTestFile(r, 'slack.test.mjs', "const TOKEN = 'xoxb-12345678-987654321-AbCdEfGhIj';\n");
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL:');
    expect(result.stdout).toContain('F2 (Slack xoxb-<digits>)');
  });
});

// ---------------------------------------------------------------------------
// F3: AWS AKIA pattern (NOT the canonical AKIAIOSFODNN7EXAMPLE)
// ---------------------------------------------------------------------------

describe('F3: AWS AKIA pattern (live shape, not canonical)', () => {
  it('exits 1 when AKIA<16-uppercase-alphanum-chars> is found (and is not the canonical example)', () => {
    const root = makeTmpRepo((r) => {
      // 16 uppercase-alphanum chars after AKIA — NOT the canonical example
      // "REALLIVEKEY9ABCDE" = 17 chars; want exactly 16: REALLIVEKEY9ABCD = 16
      writeTestFile(r, 'aws.test.mjs', "const ACCESS_KEY = 'AKIAREALLIVEKEY9ABCD';\n");
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL:');
    expect(result.stdout).toContain('F3 (AWS AKIA…)');
  });
});

// ---------------------------------------------------------------------------
// F4: Google AIzaSy pattern
// ---------------------------------------------------------------------------

describe('F4: Google AIzaSy pattern', () => {
  it('exits 1 when AIzaSy<33-chars> is found', () => {
    const root = makeTmpRepo((r) => {
      // Synthetic, non-functional Google-API-key-SHAPE (AIzaSy + 33 chars).
      // Assembled from fragments so the contiguous literal never appears in this
      // source file — GitHub secret-scanning flags a single bare `AIzaSy<33>`
      // literal as a "publicly leaked secret" even though it is a fake test
      // fixture (alert #5). The written fixture still carries the full shape at
      // runtime, so the F4 detector is exercised exactly as before.
      const fakeGoogleKey = 'AIza' + 'SyA1B2C3D4E5F6G7H8I9J0kLmNoPqRsTuVw';
      writeTestFile(r, 'google.test.mjs', `const API_KEY = '${fakeGoogleKey}';\n`);
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL:');
    expect(result.stdout).toContain('F4 (Google AIzaSy…)');
  });
});

// ---------------------------------------------------------------------------
// Allowlist-1: AWS canonical example AKIAIOSFODNN7EXAMPLE
// ---------------------------------------------------------------------------

describe('Allowlist-1: AWS canonical AKIAIOSFODNN7EXAMPLE', () => {
  it('exits 0 when AKIAIOSFODNN7EXAMPLE appears in tests/ (AWS docs canonical allowlist)', () => {
    const root = makeTmpRepo((r) => {
      // Match the real-world usage in tests/unit/quality-gate-diagnostics.test.mjs:
      // "AKIAIOSFODNN7EXAMPLE23" — canonical + 2-char suffix
      writeTestFile(r, 'redaction.test.mjs', "const input = 'key=AKIAIOSFODNN7EXAMPLE23 found';\n");
    });
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('  FAIL:');
  });

  it('exits 0 for the bare canonical form AKIAIOSFODNN7EXAMPLE without suffix', () => {
    const root = makeTmpRepo((r) => {
      writeTestFile(r, 'redaction.test.mjs', "const KEY = 'AKIAIOSFODNN7EXAMPLE';\n");
    });
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('  FAIL:');
  });
});

// ---------------------------------------------------------------------------
// Allowlist-2: sk_test_ prefix
// ---------------------------------------------------------------------------

describe('Allowlist-2: Stripe sk_test_ prefix', () => {
  it('exits 0 when sk_test_<24+chars> is in tests/ (the suggested replacement)', () => {
    const root = makeTmpRepo((r) => {
      writeTestFile(r, 'stripe.test.mjs', "const KEY = 'sk_test_PLACEHOLDER_AAAAAAAAAAAAAAAAAAAAAA';\n");
    });
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('  FAIL:');
  });
});

// ---------------------------------------------------------------------------
// Allowlist-3: xoxb-PLACEHOLDER
// ---------------------------------------------------------------------------

describe('Allowlist-3: xoxb-PLACEHOLDER canonical', () => {
  it('exits 0 when xoxb-PLACEHOLDER segments are in tests/', () => {
    const root = makeTmpRepo((r) => {
      writeTestFile(r, 'slack.test.mjs', "const TOKEN = 'xoxb-PLACEHOLDER-PLACEHOLDER-PLACEHOLDER';\n");
    });
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('  FAIL:');
  });
});

// ---------------------------------------------------------------------------
// Allowlist-4: AIzaSy-PLACEHOLDER
// ---------------------------------------------------------------------------

describe('Allowlist-4: AIzaSy-PLACEHOLDER canonical', () => {
  it('exits 0 when AIzaSy-PLACEHOLDER appears in tests/', () => {
    const root = makeTmpRepo((r) => {
      writeTestFile(r, 'google.test.mjs', "const API_KEY = 'AIzaSy-PLACEHOLDER-AAAAAAAAAAAAAAAAAAAAAAA';\n");
    });
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('  FAIL:');
  });
});

// ---------------------------------------------------------------------------
// Magic-comment: // @secret-shape-allowed
// ---------------------------------------------------------------------------

describe('Magic-comment: // @secret-shape-allowed', () => {
  it('exits 0 when a file with a live-shape pattern has // @secret-shape-allowed in first 5 lines', () => {
    const root = makeTmpRepo((r) => {
      writeTestFile(
        r,
        'scanner-fixture.test.mjs',
        [
          '// @secret-shape-allowed',
          '// Fixture file: intentionally contains live-shape patterns',
          '// to exercise the secret scanner.',
          "const STRIPE = '" + 'sk_live' + "_" + "abcdefghijklmnopqrstuvwxyz12';",
          "const AWS = 'AKIAREALLIVEKEYABCD';",
        ].join('\n') + '\n',
      );
    });
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('  FAIL:');
  });

  it('exits 1 when the magic comment is BELOW the first 5 lines (out of scan window)', () => {
    const root = makeTmpRepo((r) => {
      writeTestFile(
        r,
        'too-late.test.mjs',
        [
          '// line 1',
          '// line 2',
          '// line 3',
          '// line 4',
          '// line 5',
          '// line 6 — magic comment too late',
          '// @secret-shape-allowed',
          "const KEY = '" + 'sk_live' + "_" + "abcdefghijklmnopqrstuvwxyz12';",
        ].join('\n') + '\n',
      );
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL:');
  });
});

// ---------------------------------------------------------------------------
// Scope: production source not scanned
// ---------------------------------------------------------------------------

describe('Scope: only tests/**/*.{mjs,ts,js} scanned', () => {
  it('exits 0 when a live-shape pattern appears in production source (scripts/, not tests/)', () => {
    const root = makeTmpRepo((r) => {
      // Production source outside tests/ — must NOT be scanned
      mkdirSync(join(r, 'scripts'), { recursive: true });
      writeFileSync(
        join(r, 'scripts', 'config.mjs'),
        // Literal split — see F1 test above for rationale.
        "const KEY = '" + 'sk_live' + "_" + "abcdefghijklmnopqrstuvwxyz12';\n",
      );
      // Plus a clean tests/ file so the tree isn't completely empty
      writeTestFile(r, 'clean.test.mjs', "import { it } from 'vitest';\n");
    });
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('  FAIL:');
  });
});

// ---------------------------------------------------------------------------
// Group A — #558 Q2-M6: Line-5 inclusive magic-comment boundary
// ---------------------------------------------------------------------------

describe('Magic-comment line-5 inclusive boundary (#558 Q2-M6)', () => {
  it('exits 0 when the magic comment is on line 5 (inclusive boundary)', () => {
    // The validator scans the first MAGIC_COMMENT_SCAN_LINES (5) lines.
    // Line 5 must be inside the window — this is the inclusive-boundary regression.
    const root = makeTmpRepo((r) => {
      writeTestFile(
        r,
        'line5-allowed.test.mjs',
        [
          '// line 1',
          '// line 2',
          '// line 3',
          '// line 4',
          '// @secret-shape-allowed', // line 5 — must still be inside the scan window
          "const KEY = '" + 'sk_live' + "_" + "abcdefghijklmnopqrstuvwxyz12';",
        ].join('\n') + '\n',
      );
    });
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('  FAIL:');
  });

  it('exits 1 when the magic comment is on line 6 (one past the window — off-by-one regression)', () => {
    // Line 6 is OUT of the scan window. The validator should treat the file
    // as un-allowlisted and FAIL on the live-shape pattern below.
    const root = makeTmpRepo((r) => {
      writeTestFile(
        r,
        'line6-not-allowed.test.mjs',
        [
          '// line 1',
          '// line 2',
          '// line 3',
          '// line 4',
          '// line 5',
          '// @secret-shape-allowed', // line 6 — outside the 5-line window
          "const KEY = '" + 'sk_live' + "_" + "abcdefghijklmnopqrstuvwxyz12';",
        ].join('\n') + '\n',
      );
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL:');
    expect(result.stdout).toContain('F1 (Stripe sk_live_)');
  });
});

// ---------------------------------------------------------------------------
// Group B — F5–F10 positive + negative tests (12 tests total)
// ---------------------------------------------------------------------------

describe('F5: Anthropic sk-ant- pattern', () => {
  it('exits 1 when sk-ant-<30+chars> is found (positive)', () => {
    const root = makeTmpRepo((r) => {
      // sk-ant- + 'api03-' (6 chars) + 30 alphanumerics = 36 chars total — well over 30.
      writeTestFile(
        r,
        'anthropic.test.mjs',
        "const TOKEN = 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';\n",
      );
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL:');
    expect(result.stdout).toContain('F5 (Anthropic sk-ant-)');
  });

  it('exits 0 when sk-ant-<20chars> is too short (negative)', () => {
    const root = makeTmpRepo((r) => {
      // 20 chars after 'sk-ant-' — 10 short of the 30 minimum.
      writeTestFile(
        r,
        'anthropic-short.test.mjs',
        "const TOKEN = 'sk-ant-aaaaaaaaaaaaaaaaaaaa';\n",
      );
    });
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('  FAIL:');
  });
});

describe('F6: GitHub PAT classic ghp_ pattern', () => {
  it('exits 1 when ghp_<36chars> is found (positive)', () => {
    const root = makeTmpRepo((r) => {
      // Exactly 36 alphanumerics after ghp_ — at the boundary.
      writeTestFile(
        r,
        'github-classic.test.mjs',
        "const TOKEN = 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';\n",
      );
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL:');
    expect(result.stdout).toContain('F6 (GitHub PAT classic ghp_)');
  });

  it('exits 0 when ghp_<30chars> is too short (negative)', () => {
    const root = makeTmpRepo((r) => {
      // 30 alphanumerics — 6 short of the 36 minimum.
      writeTestFile(
        r,
        'github-classic-short.test.mjs',
        "const TOKEN = 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';\n",
      );
    });
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('  FAIL:');
  });
});

describe('F7: GitHub PAT fine-grained github_pat_ pattern', () => {
  it('exits 1 when github_pat_<30chars> is found (positive)', () => {
    const root = makeTmpRepo((r) => {
      // 30 alphanumerics after github_pat_ — at the boundary.
      writeTestFile(
        r,
        'github-fg.test.mjs',
        "const TOKEN = 'github_pat_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';\n",
      );
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL:');
    expect(result.stdout).toContain('F7 (GitHub PAT fine-grained github_pat_)');
  });

  it('exits 0 when github_pat_<20chars> is too short (negative)', () => {
    const root = makeTmpRepo((r) => {
      // 20 chars after github_pat_ — 10 short of the 30 minimum.
      writeTestFile(
        r,
        'github-fg-short.test.mjs',
        "const TOKEN = 'github_pat_aaaaaaaaaaaaaaaaaaaa';\n",
      );
    });
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('  FAIL:');
  });
});

describe('F8: GitLab PAT glpat- pattern', () => {
  it('exits 1 when glpat-<20chars> is found (positive)', () => {
    const root = makeTmpRepo((r) => {
      // 20 chars after glpat- — at the boundary.
      writeTestFile(
        r,
        'gitlab.test.mjs',
        "const TOKEN = 'glpat-aaaaaaaaaaaaaaaaaaaa';\n",
      );
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL:');
    expect(result.stdout).toContain('F8 (GitLab PAT glpat-)');
  });

  it('exits 0 when glpat-<10chars> is too short (negative)', () => {
    const root = makeTmpRepo((r) => {
      // 10 chars after glpat- — 10 short of the 20 minimum.
      writeTestFile(
        r,
        'gitlab-short.test.mjs',
        "const TOKEN = 'glpat-aaaaaaaaaa';\n",
      );
    });
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('  FAIL:');
  });
});

describe('F9: Slack webhook URL pattern', () => {
  it('exits 1 when a Slack webhook URL is found (positive)', () => {
    const root = makeTmpRepo((r) => {
      writeTestFile(
        r,
        'slack-webhook.test.mjs',
        "const URL = 'https://hooks.slack.com/services/T123ABC/B456DEF/abc123def456';\n",
      );
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL:');
    expect(result.stdout).toContain('F9 (Slack webhook URL)');
  });

  it('exits 0 when the URL path is wrong-shape (negative)', () => {
    const root = makeTmpRepo((r) => {
      // Wrong path — does not match /services/T<...>/B<...>/<token>.
      writeTestFile(
        r,
        'slack-webhook-bad.test.mjs',
        "const URL = 'https://hooks.slack.com/T123/abc';\n",
      );
    });
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('  FAIL:');
  });
});

describe('F10: Discord webhook URL pattern', () => {
  it('exits 1 when a Discord webhook URL is found (positive)', () => {
    const root = makeTmpRepo((r) => {
      writeTestFile(
        r,
        'discord-webhook.test.mjs',
        "const URL = 'https://discord.com/api/webhooks/123456/AbCdEf123-_';\n",
      );
    });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('  FAIL:');
    expect(result.stdout).toContain('F10 (Discord webhook URL)');
  });

  it('exits 0 when the URL path is wrong-shape (negative)', () => {
    const root = makeTmpRepo((r) => {
      // Wrong path — not /api/webhooks/<digits>/<token>.
      writeTestFile(
        r,
        'discord-webhook-bad.test.mjs',
        "const URL = 'https://discord.com/some-other-path';\n",
      );
    });
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('  FAIL:');
  });
});

// ---------------------------------------------------------------------------
// Group C — #558 Unnumbered 2: 1-char-short lookalike boundary tests
// (Confirms the validator does NOT false-positive on patterns that are one
// character shy of the minimum length — the typical lookalike-shape risk.)
// ---------------------------------------------------------------------------

describe('Boundary lookalikes: 1-char-short variants must NOT match', () => {
  it('F1 lookalike: sk_live_<23chars> (one short of the 24 minimum) does NOT match', () => {
    const root = makeTmpRepo((r) => {
      // 23 chars after sk_live_ — exactly one short of the 24-char minimum
      // (alphabet 'a'..'w' = 23 letters; 'a'..'z' is 26).
      // Literal split — see F1 test above for rationale.
      writeTestFile(
        r,
        'stripe-lookalike.test.mjs',
        "const KEY = '" + 'sk_live' + "_" + "abcdefghijklmnopqrstuvw';\n",
      );
    });
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('  FAIL:');
  });

  it('F3 lookalike: AKIA<15chars> (one short of the 16 minimum) does NOT match', () => {
    const root = makeTmpRepo((r) => {
      // 15 uppercase-alphanum chars after AKIA — exactly one short of 16.
      writeTestFile(
        r,
        'aws-lookalike.test.mjs',
        "const KEY = 'AKIAREALLIVEKEY9ABC';\n",
      );
    });
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('  FAIL:');
  });
});
