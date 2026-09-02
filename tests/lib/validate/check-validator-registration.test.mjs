/**
 * tests/lib/validate/check-validator-registration.test.mjs
 *
 * Integration tests for scripts/lib/validate/check-validator-registration.mjs
 * (#1184) — every `scripts/lib/validate/check-*.mjs` must be referenced by
 * basename from `scripts/validate-plugin.mjs`, `.husky/pre-commit`, or
 * `.gitlab-ci.yml`, or declare itself standalone via a
 * `// registration: standalone <reason>` header marker.
 *
 * The bug this check exists to catch: a checker is authored with real
 * detection logic and never wired into any of the three surfaces that
 * actually run a validator — built work nobody runs, invisible until this
 * checker names it.
 *
 *   0 = every checker registered or standalone
 *   1 = at least one unregistered checker
 *   2 = tool error
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  scanValidatorRegistration,
  runCheckValidatorRegistration,
  stripComments,
} from '@lib/validate/check-validator-registration.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'lib', 'validate', 'check-validator-registration.mjs');

// ---------------------------------------------------------------------------
// Fixture helper
// ---------------------------------------------------------------------------

const tmpRoots = [];

/**
 * Build a tmp repo root with scripts/lib/validate/<checker files>, plus the
 * three run surfaces. `checkers` maps basename -> source text.
 * `surfaces` maps { validatePlugin?, husky?, gitlabCi? } -> text content
 * (each defaults to referencing nothing).
 */
function makeFixture(checkers, surfaces = {}) {
  const root = mkdtempSync(join(tmpdir(), 'check-validator-registration-'));
  tmpRoots.push(root);

  const validateDir = join(root, 'scripts', 'lib', 'validate');
  mkdirSync(validateDir, { recursive: true });
  for (const [basename, source] of Object.entries(checkers)) {
    writeFileSync(join(validateDir, basename), source, 'utf8');
  }

  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'validate-plugin.mjs'), surfaces.validatePlugin ?? '// no checkers referenced\n', 'utf8');
  mkdirSync(join(root, '.husky'), { recursive: true });
  writeFileSync(join(root, '.husky', 'pre-commit'), surfaces.husky ?? '# no checkers referenced\n', 'utf8');
  writeFileSync(join(root, '.gitlab-ci.yml'), surfaces.gitlabCi ?? '# no checkers referenced\n', 'utf8');

  return root;
}

function run(repoRoot) {
  return spawnSync('node', [SCRIPT, repoRoot], { encoding: 'utf8', timeout: 15_000 });
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// In-process: import-safety + live repo
// ---------------------------------------------------------------------------

describe('runCheckValidatorRegistration — in-process against the live repo', () => {
  it('returns 0 for the real repo — every currently-tracked checker is wired', () => {
    expect(runCheckValidatorRegistration(REPO_ROOT)).toBe(0);
  });

  it('scanValidatorRegistration reports no unregistered, non-standalone checker among tracked files', () => {
    const results = scanValidatorRegistration(REPO_ROOT);
    expect(results.length).toBeGreaterThan(0);
    expect(results.filter((r) => !r.registered && !r.standalone)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Subprocess: wired / unwired / standalone fixtures
// ---------------------------------------------------------------------------

describe('check-validator-registration CLI — wired, unwired, standalone', () => {
  it('exits 1 and names the unwired checker when it is referenced by none of the three surfaces', () => {
    const root = makeFixture({
      'check-wired.mjs': '// a checker\n',
      'check-orphan.mjs': '// never referenced anywhere\n',
    }, {
      validatePlugin: "runCheck('check-wired.mjs');\n",
    });

    const r = run(root);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('FAIL');
    expect(r.stdout).toContain('check-orphan.mjs');
    expect(r.stdout).toContain('Results: 1 passed, 1 failed');
  });

  it('exits 0 when every checker is referenced in at least one surface', () => {
    const root = makeFixture({
      'check-wired.mjs': '// a checker\n',
    }, {
      validatePlugin: "runCheck('check-wired.mjs');\n",
    });

    const r = run(root);

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('FAIL');
    expect(r.stdout).toContain('Results: 1 passed, 0 failed');
  });

  it('exits 0 when the unreferenced checker declares itself standalone', () => {
    const root = makeFixture({
      'check-cli-only.mjs': '// registration: standalone invoked manually by an operator, never by CI\n// a checker\n',
    });

    const r = run(root);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('standalone');
    expect(r.stdout).toContain('Results: 1 passed, 0 failed');
  });

  it('exits 2 and writes usage to stderr when no repo-root argument is supplied', () => {
    const r = spawnSync('node', [SCRIPT], { encoding: 'utf8', timeout: 15_000 });

    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Usage: check-validator-registration.mjs <repo-root>');
  });
});

// ---------------------------------------------------------------------------
// Comment-stripping (HIGH, qa review, #1184 FX-C)
//
// The bug this guards against: a checker referenced only inside a `//`/`#`
// comment (the exact shape of a disabled, commented-out registration line)
// reported `registered: true` before this fix — a plain substring match saw
// the basename inside the comment text and never asked whether it sat on a
// live code line. MEASURED before the fix: exit 0 for a fixture whose only
// reference sat in `// runCheck('check-ghost.mjs'); // DISABLED`.
// ---------------------------------------------------------------------------

describe('check-validator-registration CLI — comment-stripped matching (HIGH, #1184 FX-C)', () => {
  it('exits 1 and reports UNREGISTERED when the only reference sits in a `//` line comment', () => {
    const root = makeFixture({
      'check-ghost.mjs': '// a checker\n',
    }, {
      validatePlugin: "// runCheck('check-ghost.mjs'); // DISABLED\n",
    });

    const r = run(root);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('FAIL');
    expect(r.stdout).toContain('check-ghost.mjs');
    expect(r.stdout).toContain('Results: 0 passed, 1 failed');
  });

  it('exits 1 and reports UNREGISTERED when the only reference sits in a `#` shell comment', () => {
    const root = makeFixture({
      'check-ghost.mjs': '// a checker\n',
    }, {
      husky: "# husky run 'check-ghost.mjs' disabled pending #1184\n",
    });

    const r = run(root);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('check-ghost.mjs');
  });

  it('exits 1 and reports UNREGISTERED when the only reference sits inside a `/* */` block comment', () => {
    const root = makeFixture({
      'check-ghost.mjs': '// a checker\n',
    }, {
      validatePlugin: "/*\nrunCheck('check-ghost.mjs');\n*/\n",
    });

    const r = run(root);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('check-ghost.mjs');
  });

  it('still reports REGISTERED for a real, live (uncommented) reference — no false positive from stripping', () => {
    const root = makeFixture({
      'check-real.mjs': '// a checker\n',
    }, {
      validatePlugin: "runCheck('check-real.mjs'); // registered here\n",
    });

    const r = run(root);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Results: 1 passed, 0 failed');
  });
});

describe('stripComments — quote-aware `//`/`#`/`/* */` stripping', () => {
  const jsStyle = { lineComment: '//', blockComment: true, quoteChars: ['"', "'", '`'] };
  const shStyle = { lineComment: '#', blockComment: false, quoteChars: ['"', "'"] };

  it('drops everything after `//` on a js-style line', () => {
    expect(stripComments("runCheck('a.mjs'); // runCheck('b.mjs')\n", jsStyle)).toBe("runCheck('a.mjs'); \n");
  });

  it('drops a `/* */` block comment spanning multiple lines', () => {
    expect(stripComments("x();\n/*\nrunCheck('b.mjs');\n*/\ny();\n", jsStyle)).toBe('x();\n\ny();\n');
  });

  it('drops everything after `#` on a shell-style line', () => {
    expect(stripComments("real-command\n# runCheck check-b.mjs\n", shStyle)).toBe('real-command\n\n');
  });

  it('does NOT treat a `#` inside a double-quoted shell string as a comment start', () => {
    const src = 'GLAB_TARBALL="glab_${GLAB_VERSION#v}_linux_amd64.tar.gz"\n';
    expect(stripComments(src, shStyle)).toBe(src);
  });

  it('does NOT treat a `//` inside a js string as a comment start', () => {
    const src = "const url = 'https://example.test/check-b.mjs';\n";
    expect(stripComments(src, jsStyle)).toBe(src);
  });
});
