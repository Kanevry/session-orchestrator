/**
 * tests/lib/validate/check-test-git-config-target.test.mjs
 *
 * Coverage for the static half of the 2026-08-19 `.git/config` contamination
 * incident: a state-mutating `git` call in `tests/**` whose destination is
 * decided by ambient state instead of by the call.
 *
 * NOTE ON LOCATION: every other `check-*.mjs` test in this repo lives under
 * `tests/scripts/validate/` (8 files). This one sits in `tests/lib/validate/`
 * because that is the path its wave file-scope declares, and the scope guard
 * enforces it mechanically. Moving it next to its siblings is a one-line
 * rename; it is flagged here so the divergence is visible rather than
 * inherited by the next check that copies this file.
 *
 * The load-bearing pair in this file is POSITIVE + NEGATIVE TWIN. A detector
 * that flags everything passes every positive case; only the twin separates a
 * working rule from a broken one. That is not hypothetical here — the rule's
 * first cut reported 11 findings against the live `tests/` tree and **all 11
 * were false positives** (`git init [-q] <dir>`, whose positional IS the
 * target). The `git init <dir>` case below is the regression pin for exactly
 * that measurement.
 *
 * The runner's WARN-only posture is also pinned, and is not cosmetic:
 * `scripts/validate-plugin.mjs` tallies `^ {2}FAIL:` lines from every
 * sub-check into one counter and exits 1 when it is non-zero. A stray `FAIL:`
 * line here would red the whole validator on a census.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  classifyArgv,
  hasSubcommandTarget,
  inspectTestGitConfigTarget,
  isMutating,
  runCheckTestGitConfigTarget,
  tokenizeArgv,
  tokenizeShellCommand,
} from '@lib/validate/check-test-git-config-target.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const CHECK = join(REPO_ROOT, 'scripts/lib/validate/check-test-git-config-target.mjs');

/** @type {string[]} */
const tmpDirs = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    try {
      rmSync(/** @type {string} */ (tmpDirs.pop()), { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

/**
 * Build a fixture plugin root containing `tests/<name>` with `body`.
 * @param {string} body
 * @param {string} [name]
 * @returns {string} the fixture root
 */
function fixtureRoot(body, name = 'fixture.test.mjs') {
  const root = mkdtempSync(join(tmpdir(), 'so-git-target-'));
  tmpDirs.push(root);
  mkdirSync(join(root, 'tests'), { recursive: true });
  writeFileSync(join(root, 'tests', name), body, 'utf8');
  return root;
}

describe('inspectTestGitConfigTarget — the incident shape (positive)', () => {
  it('flags the three mutations that landed in the real .git', () => {
    const root = fixtureRoot(
      [
        "execFileSync('git', ['config', 'user.email', 'test@example.com']);",
        "execFileSync('git', ['remote', 'add', 'gitlab', 'git@gitlab.example.com:g/p.git']);",
        "spawnSync('git', ['commit', '-q', '-m', 'init']);",
      ].join('\n'),
    );

    const result = inspectTestGitConfigTarget(root);

    expect(result.ok).toBe(false);
    expect(result.findings.map((f) => `${f.line}:${f.command}`)).toEqual([
      '1:git config user.email test@example.com',
      '2:git remote add gitlab git@gitlab.example.com:g/p.git',
      '3:git commit -q -m init',
    ]);
  });

  it('flags a shell-string mutation with no cwd option', () => {
    // The argv form and the shell form are separate scan paths; a refactor of
    // one silently dropped the other during development, and this is the pin.
    const root = fixtureRoot("execSync('git commit -m \"x\"');");

    expect(inspectTestGitConfigTarget(root).findings).toHaveLength(1);
  });
});

describe('inspectTestGitConfigTarget — the negative twins', () => {
  it('accepts the SAME mutations once they name a target', () => {
    const root = fixtureRoot(
      [
        "execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);",
        "execFileSync('git', ['remote', 'add', 'gitlab', url], { cwd: dir });",
        "spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir, encoding: 'utf8' });",
        "execSync('git commit -m \"x\"', { cwd: dir });",
      ].join('\n'),
    );

    const result = inspectTestGitConfigTarget(root);

    expect(result.findings).toEqual([]);
    expect(result.summary.applicable).toBe(4);
    expect(result.summary.targeted).toBe(4);
  });

  it('accepts `git init <dir>` — the shape that produced 11/11 false positives', () => {
    const root = fixtureRoot(
      [
        "execFileSync('git', ['init', '-q', dir]);",
        "execFileSync('git', ['init', '-q', '--bare', bare], { env: GIT_ENV });",
        "spawnSync('git', ['init', vault], { encoding: 'utf8' });",
        "execFileSync('git', ['init', '-b', 'main', dir]);",
      ].join('\n'),
    );

    expect(inspectTestGitConfigTarget(root).findings).toEqual([]);
  });

  it('still flags a bare `git init` that names no directory at all', () => {
    // The counterpart to the case above: the exemption is the POSITIONAL, not
    // the subcommand. Without this, exempting `init` would blind the check to a
    // real ambient-cwd mutation.
    const root = fixtureRoot("execFileSync('git', ['init', '-q']);\nexecFileSync('git', ['init', '-b', 'main']);");

    expect(inspectTestGitConfigTarget(root).findings).toHaveLength(2);
  });

  it('accepts a git config write scoped off the repository', () => {
    const root = fixtureRoot(
      [
        "execFileSync('git', ['config', '--global', 'user.email', 'x']);",
        "execFileSync('git', ['config', '--file', f, 'a.b', 'c']);",
      ].join('\n'),
    );

    expect(inspectTestGitConfigTarget(root).findings).toEqual([]);
  });

  it('ignores read-only invocations entirely', () => {
    const root = fixtureRoot(
      [
        "execFileSync('git', ['status', '--porcelain']);",
        "execFileSync('git', ['rev-parse', 'HEAD']);",
        "execFileSync('git', ['config', '--get', 'user.email']);",
        "execFileSync('git', ['remote', '-v']);",
        "execFileSync('git', ['tag', '--list']);",
      ].join('\n'),
    );

    const result = inspectTestGitConfigTarget(root);
    expect(result.findings).toEqual([]);
    expect(result.summary.applicable).toBe(0);
  });

  it('never judges a variable argv array, and says so in the summary', () => {
    const root = fixtureRoot("execFileSync('git', args, { encoding: 'utf8' });");

    const result = inspectTestGitConfigTarget(root);
    expect(result.findings).toEqual([]);
    expect(result.summary.unresolvedArgv).toBe(1);
  });

  it('does not flag a documented counter-example inside a comment', () => {
    const root = fixtureRoot("// execFileSync('git', ['config', 'user.email', 'x']); <- the bug\n");

    expect(inspectTestGitConfigTarget(root).findings).toEqual([]);
  });
});

describe('argv tokenisation', () => {
  it('separates a string literal, a spread and a plain expression', () => {
    expect(tokenizeArgv("'-C', dir, ...args")).toEqual([
      { t: 'lit', v: '-C' },
      { t: 'expr' },
      { t: 'spread' },
    ]);
  });

  it('treats `-C` as a target and finds the subcommand after it', () => {
    const parsed = classifyArgv(tokenizeArgv("'-C', dir, 'commit', '-m', 'x'"));
    expect(parsed.hasArgvTarget).toBe(true);
    expect(parsed.subcommand).toBe('commit');
  });

  it('refuses to resolve a subcommand hidden behind a spread', () => {
    // `['-C', dir, ...args]`: the target IS known, the subcommand is not.
    // Guessing here is how a helper wrapper becomes a false positive.
    expect(classifyArgv(tokenizeArgv("'-C', dir, ...args")).subcommand).toBeNull();
  });

  it('does not mistake a global option VALUE for the subcommand', () => {
    expect(classifyArgv(tokenizeArgv("'-c', 'user.name=t', 'commit'")).subcommand).toBe('commit');
  });

  it('classifies mutating vs read-only forms of the same subcommand', () => {
    expect(isMutating('remote', tokenizeArgv("'add', 'gitlab', 'u'"))).toBe(true);
    expect(isMutating('remote', tokenizeArgv("'-v'"))).toBe(false);
    expect(isMutating('config', tokenizeArgv("'user.email', 'x'"))).toBe(true);
    expect(isMutating('config', tokenizeArgv("'--get', 'user.email'"))).toBe(false);
    expect(isMutating('status', tokenizeArgv("'--porcelain'"))).toBe(false);
  });

  it('reads a `git init` positional target through an opaque expression', () => {
    expect(hasSubcommandTarget('init', tokenizeArgv("'-q', dir"))).toBe(true);
    expect(hasSubcommandTarget('init', tokenizeArgv("'-q'"))).toBe(false);
    expect(hasSubcommandTarget('init', tokenizeArgv("'-q', ...rest"))).toBe(false);
  });

  it('erases interpolation holes from a shell command before tokenising', () => {
    expect(tokenizeShellCommand('git add ${JSON.stringify(rel)}')).toEqual(['git', 'add']);
  });
});

describe('runCheckTestGitConfigTarget — WARN-only contract', () => {
  it('prints WARN (never FAIL) for findings and returns 0', () => {
    const root = fixtureRoot("execFileSync('git', ['config', 'user.email', 'x']);");
    /** @type {string[]} */
    const lines = [];
    const original = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    let code;
    try {
      code = runCheckTestGitConfigTarget(root);
    } finally {
      console.log = original;
    }

    const output = lines.join('\n');
    expect(code).toBe(0);
    expect(output).toMatch(/^ {2}WARN: \[no-target]/m);
    // The load-bearing negative: validate-plugin tallies `  FAIL:` lines from
    // EVERY sub-check, so one here would red the entire validator.
    expect(output).not.toMatch(/^ {2}FAIL:/m);
    expect(output).toContain('Results: 1 passed, 0 failed');
  });

  it('reports a missing scan root as a tool error', () => {
    const root = mkdtempSync(join(tmpdir(), 'so-git-target-empty-'));
    tmpDirs.push(root);

    const inspection = inspectTestGitConfigTarget(root);
    expect(inspection.toolError).toBe(true);
    expect(inspection.findings[0].kind).toBe('tool-error');
  });

  it('exposes the census as JSON on stdout via the CLI', () => {
    const root = fixtureRoot("execFileSync('git', ['config', 'user.email', 'x']);");
    const res = spawnSync('node', [CHECK, root, '--json'], { encoding: 'utf8' });

    expect(res.status).toBe(0);
    const envelope = JSON.parse(res.stdout);
    expect(envelope.summary.findings).toBe(1);
    expect(envelope.summary.filesScanned).toBe(1);
  });
});

describe('the repository that owns this check', () => {
  it('has no state-mutating git call in tests/ without an explicit target', () => {
    // A live-tree assertion. It is also the premise of the WARN-only decision
    // recorded in validate-plugin.mjs: this census was 0 on the day it landed,
    // so any future finding is a genuinely new call site.
    const result = inspectTestGitConfigTarget(REPO_ROOT);

    expect(result.toolError).toBe(false);
    expect(result.findings.map((f) => `${f.file}:${f.line}`)).toEqual([]);
    expect(result.summary.applicable).toBeGreaterThan(50);
  });
});
