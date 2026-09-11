/**
 * tests/lib/claude-md-budget-lint.test.mjs
 *
 * Unit tests for `checkClaudeMdBudgetLint()` — the session-start Phase 4
 * banner wrapper added in #878 (FA2b). NOTE on test-file placement: the
 * PRE-EXISTING `lintClaudeMd()` + CLI coverage for this module already
 * lives at tests/scripts/claude-md-budget-lint.test.mjs (issue #722 Epic A
 * Wave 3) — this file deliberately does NOT duplicate that coverage. It
 * covers ONLY the new banner-wrapper surface added by #878, per this wave's
 * scoped test-file path (tests/lib/claude-md-budget-lint.test.mjs).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { checkClaudeMdBudgetLint } from '@lib/claude-md-budget-lint.mjs';

// #1302: the banner's suggested command must name THIS module's own absolute
// path (the code that is actually executing), never a repo-root-relative
// literal — a consumer repo has no `scripts/lib/claude-md-budget-lint.mjs` of
// its own. Computed independently of the `@lib` alias so it is a real
// cross-check, not a restatement of the module's own `__filename`.
const EXPECTED_SCRIPT_PATH = fileURLToPath(
  new URL('../../scripts/lib/claude-md-budget-lint.mjs', import.meta.url),
);

// The banner must name a path the operator can run, WITHOUT naming the
// operator. `$HOME` collapse does both: no POSIX shell expands `~` inside the
// double quotes the banner emits, but it does expand `$HOME`. Computed here
// independently of the module's own helper so this stays a cross-check.
const EXPECTED_SCRIPT_TOKEN = EXPECTED_SCRIPT_PATH.startsWith(homedir() + sep)
  ? '$HOME' + EXPECTED_SCRIPT_PATH.slice(homedir().length)
  : EXPECTED_SCRIPT_PATH;

const tmpDirs = [];

/** A repoRoot INSIDE the home directory — the only place the leak is observable. */
function tmpUnderHome() {
  const d = mkdtempSync(join(homedir(), '.claude-md-budget-lint-banner-'));
  tmpDirs.push(d);
  return d;
}

function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'claude-md-budget-lint-banner-'));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

describe('checkClaudeMdBudgetLint — clean file', () => {
  it('returns null when the resolved CLAUDE.md has zero violations', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'CLAUDE.md'), '# Title\n\nShort clean body.\n', 'utf8');

    const result = checkClaudeMdBudgetLint({ repoRoot: dir });

    expect(result).toBeNull();
  });
});

describe('checkClaudeMdBudgetLint — no instruction file', () => {
  it('returns null when neither CLAUDE.md nor AGENTS.md exists under repoRoot', () => {
    const dir = tmp(); // empty dir, no instruction file written

    const result = checkClaudeMdBudgetLint({ repoRoot: dir });

    expect(result).toBeNull();
  });
});

describe('checkClaudeMdBudgetLint — violations present', () => {
  it('returns a warn-severity banner naming the violation count and rule names', () => {
    const dir = tmp();
    // 4 lines total (index 0..3, split('\n') yields 4 entries) — exceeds maxLines: 2.
    // Line 2 is deliberately over maxLineChars: 10.
    const longLine = 'a'.repeat(20);
    writeFileSync(join(dir, 'CLAUDE.md'), `short\n${longLine}\nshort\n`, 'utf8');

    const result = checkClaudeMdBudgetLint({ repoRoot: dir, maxLines: 2, maxLineChars: 10 });

    expect(result).toEqual({
      severity: 'warn',
      message: expect.stringContaining('CLAUDE.md budget lint:'),
    });
    expect(result.message).toContain('max-lines');
    expect(result.message).toContain('max-line-chars');
    expect(result.message).toContain('2 violation(s)');
  });

  it('names a runnable command — a resolvable, existing script path, not a repo-root-relative literal (#1302)', () => {
    // `dir` is a bare tmp directory holding only a CLAUDE.md — exactly the
    // shape of a consumer repo that does not vendor `scripts/lib/`. The old
    // banner text hardcoded `scripts/lib/claude-md-budget-lint.mjs` (relative),
    // which is unresolvable there.
    const dir = tmp();
    const longLine = 'a'.repeat(20);
    writeFileSync(join(dir, 'CLAUDE.md'), `short\n${longLine}\nshort\n`, 'utf8');

    const result = checkClaudeMdBudgetLint({ repoRoot: dir, maxLines: 2, maxLineChars: 10 });

    // Extract the executable-path token after `node ` WITHOUT presuming the
    // old or the new quoting shape, so a fake-regression to the old literal
    // (`node scripts/lib/claude-md-budget-lint.mjs --mode warn`, no quotes,
    // no `--repo-root`) still yields a token — just a relative one — and the
    // very NEXT assertion (`isAbsolute`) is what fails, not a regex miss.
    // That is the deliberate ordering fix: a shape assertion (does the regex
    // even match) placed BEFORE the behavioural one can go red for the wrong
    // reason and prove nothing (a documented trap from an earlier session).
    const afterNode = result.message.split('run `node ')[1];
    expect(afterNode).toBeDefined();
    const scriptPath = afterNode.startsWith('"')
      ? afterNode.slice(1, afterNode.indexOf('"', 1))
      : afterNode.split(' ')[0];

    // The regression proof: a repo-root-relative literal is NOT absolute, and
    // resolving it via `existsSync` alone would be unsound here regardless —
    // vitest's own cwd IS this checkout, so `scripts/lib/claude-md-budget-lint.mjs`
    // would falsely resolve via `existsSync` even though it fails in a real
    // consumer repo (the "test measures the live repo" trap
    // `.claude/rules/test-hygiene.md` warns about). `isAbsolute` sidesteps
    // that cwd dependency entirely.
    // Behaviour first: the token must RESOLVE to this very module. Expanding
    // `$HOME` is what a shell does with it, so the test does the same — a
    // fake-regression to the repo-root-relative literal (#1302) leaves a token
    // that neither resolves nor exists, and fails here rather than on a shape.
    const resolved = scriptPath.startsWith('$HOME')
      ? homedir() + scriptPath.slice('$HOME'.length)
      : scriptPath;
    expect(existsSync(resolved)).toBe(true);
    expect(resolved).toBe(EXPECTED_SCRIPT_PATH);
    expect(isAbsolute(resolved)).toBe(true);
    // Shape pin last (see the ordering note above).
    expect(scriptPath).toBe(EXPECTED_SCRIPT_TOKEN);
    expect(result.message).toContain(`--repo-root "${dir}"`);
  });

  // Bug caught: the banner printed `__filename` and `repoRoot` verbatim while
  // the SAME template literal deliberately redacted `filePath` via
  // `basename()`. Both are CP1-shaped (`/Users/<name>/…`) on a personal host,
  // and the route into public view is copy-paste of the banner into an issue or
  // an agent report. Nothing asserted the banner is free of the operator's home
  // path. Pre-fix output, measured 2026-09-11:
  //   run `node "/Users/<name>/Projects/session-orchestrator/scripts/lib/…"
  //        --repo-root "/Users/<name>/Projects/.budgetlint-probe-W7dY8I" …`
  it('names neither the home directory nor the operator — both paths are $HOME-collapsed', () => {
    const dir = tmpUnderHome(); // the leak is only observable under $HOME
    writeFileSync(join(dir, 'CLAUDE.md'), `${'a'.repeat(20)}\n`, 'utf8');

    const result = checkClaudeMdBudgetLint({ repoRoot: dir, maxLineChars: 10 });

    expect(result.message).not.toContain(homedir());
    expect(result.message).toContain(`node "$HOME`);
    expect(result.message).toContain(`--repo-root "$HOME`);
  });

  it('resolves AGENTS.md when CLAUDE.md is absent, and names it in the banner', () => {
    const dir = tmp();
    const longLine = 'a'.repeat(20);
    writeFileSync(join(dir, 'AGENTS.md'), `${longLine}\n`, 'utf8');

    const result = checkClaudeMdBudgetLint({ repoRoot: dir, maxLineChars: 10 });

    expect(result.severity).toBe('warn');
    expect(result.message).toContain('AGENTS.md');
  });
});

describe('checkClaudeMdBudgetLint — never throws (banner-wrapper contract)', () => {
  it('returns null instead of throwing when repoRoot does not exist on disk', () => {
    const missing = join(tmpdir(), 'definitely-does-not-exist-budget-lint-banner-repo-xyz');

    // A throw would fail this assertion too, so the preceding `.not.toThrow()`
    // was subsumed and was deleted in #959 (TV-002 consolidation).
    expect(checkClaudeMdBudgetLint({ repoRoot: missing })).toBeNull();
  });
});
