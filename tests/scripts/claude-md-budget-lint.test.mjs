/**
 * tests/scripts/claude-md-budget-lint.test.mjs
 *
 * Unit tests for scripts/lib/claude-md-budget-lint.mjs — issue #722 Epic A
 * Wave 3. Covers lintClaudeMd() (max-lines, max-line-chars, provenance-header
 * probes, infra errors) and the CLI's exit-code contract (0/1/2) + --json shape.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lintClaudeMd, ClaudeMdLintInfraError } from '@lib/claude-md-budget-lint.mjs';
import { _extractConfigSection } from '@lib/config/section-extractor.mjs';
import { parseSessionConfig } from '@lib/config.mjs';

const SCRIPT_PATH = fileURLToPath(new URL('../../scripts/lib/claude-md-budget-lint.mjs', import.meta.url));

// ---------------------------------------------------------------------------
// Fixture management
// ---------------------------------------------------------------------------

const tmpDirs = [];

function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'claude-md-budget-lint-'));
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

function runCLI(args = [], cwd = undefined) {
  const env = { ...process.env };
  delete env.TYPECHECK_CMD;
  delete env.TEST_CMD;
  delete env.LINT_CMD;
  delete env.FILES;
  delete env.SESSION_START_REF;
  const result = spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 10 * 1024 * 1024,
    env,
    cwd,
  });
  if (result.error) throw result.error;
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

// ---------------------------------------------------------------------------
// Defaults — asserted through BEHAVIOUR, not by re-stating the constants.
// (Replaces two `expect(CONST).toBe(<same literal>)` tautologies deleted in
// #959: they restated the module's own literals and so could not fail while
// the module compiled. The ceilings below are hardcoded on purpose — a silent
// change to either default flips these.)
// ---------------------------------------------------------------------------

describe('applied defaults', () => {
  it('applies the 80-line default ceiling to non-exempt lines when maxLines is omitted', () => {
    const dir = tmp();
    const at80 = join(dir, 'at-80.md');
    const at81 = join(dir, 'at-81.md');
    // 79 newline-terminated lines -> split('\n') yields 80 entries (trailing '').
    writeFileSync(at80, 'x\n'.repeat(79), 'utf8');
    writeFileSync(at81, 'x\n'.repeat(80), 'utf8');

    expect(lintClaudeMd({ filePath: at80 }).lineCount).toBe(80);
    expect(lintClaudeMd({ filePath: at80 }).violations).toHaveLength(0);

    const over = lintClaudeMd({ filePath: at81 });
    expect(over.lineCount).toBe(81);
    expect(over.violations.map((v) => v.rule)).toEqual(['max-lines']);
  });

  it('applies the 400-char default per-line ceiling when maxLineChars is omitted', () => {
    const dir = tmp();
    const filePath = join(dir, 'CLAUDE.md');
    writeFileSync(filePath, `${'a'.repeat(400)}\n${'b'.repeat(401)}\n`, 'utf8');

    const result = lintClaudeMd({ filePath });

    // Only the 401-char line trips: the 400-char line sits exactly at the ceiling.
    expect(result.violations.map((v) => ({ rule: v.rule, line: v.line }))).toEqual([
      { rule: 'max-line-chars', line: 2 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// lintClaudeMd — happy path
// ---------------------------------------------------------------------------

describe('lintClaudeMd — clean file', () => {
  it('returns status ok with no violations for a small file under both ceilings', () => {
    const dir = tmp();
    const filePath = join(dir, 'CLAUDE.md');
    writeFileSync(filePath, '# Title\n\nShort body.\n', 'utf8');

    const result = lintClaudeMd({ filePath });

    expect(result.status).toBe('ok');
    expect(result.violations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// max-lines violation
// ---------------------------------------------------------------------------

describe('lintClaudeMd — max-lines violation', () => {
  it('reports a max-lines violation when the file exceeds maxLines', () => {
    const dir = tmp();
    const filePath = join(dir, 'CLAUDE.md');
    // 'line1\nline2\nline3\nline4\n'.split('\n') === ['line1','line2','line3','line4',''] -> lineCount 5
    writeFileSync(filePath, 'line1\nline2\nline3\nline4\n', 'utf8');

    const result = lintClaudeMd({ filePath, maxLines: 4 });

    expect(result.status).toBe('invalid');
    expect(result.lineCount).toBe(5);
    const v = result.violations.find((x) => x.rule === 'max-lines');
    expect(v).toBeDefined();
    expect(v.message).toContain('5 lines');
  });

  it('does not report a max-lines violation when the file is under the ceiling', () => {
    const dir = tmp();
    const filePath = join(dir, 'CLAUDE.md');
    writeFileSync(filePath, 'line1\nline2\n', 'utf8');

    const result = lintClaudeMd({ filePath, maxLines: 10 });

    expect(result.violations.filter((x) => x.rule === 'max-lines')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Session Config exempt region (#959). The ceiling is measured against
// NON-EXEMPT lines, so each case below names a distinct way the exemption
// could silently mis-fire: not applying, applying to a near-miss heading,
// swallowing the rest of the file, or being gamed by a duplicate heading.
// ---------------------------------------------------------------------------

describe('lintClaudeMd — Session Config exemption', () => {
  it('excludes the Session Config block from the ceiling while keeping lineCount raw', () => {
    const dir = tmp();
    const filePath = join(dir, 'CLAUDE.md');
    // 10 raw lines; the Session Config block spans lines 4..7 (4 lines),
    // terminated by the `## Tail` heading on line 8 -> 6 non-exempt.
    writeFileSync(
      filePath,
      '# Title\n\n## Intro\n## Session Config\nwaves: 5\nvcs: gitlab\n\n## Tail\nprose\n',
      'utf8'
    );

    const result = lintClaudeMd({ filePath, maxLines: 6 });

    expect(result.lineCount).toBe(10);
    expect(result.exemptLines).toBe(4);
    expect(result.effectiveLineCount).toBe(6);
    expect(result.status).toBe('ok');

    // One line tighter and the SAME file trips — proving the ceiling is live,
    // not merely unreachable because everything was exempted.
    expect(lintClaudeMd({ filePath, maxLines: 5 }).violations.map((v) => v.rule)).toEqual([
      'max-lines',
    ]);
  });

  it('names raw, non-exempt, exempt and ceiling figures in the max-lines message', () => {
    const dir = tmp();
    const filePath = join(dir, 'CLAUDE.md');
    writeFileSync(filePath, '# Title\n## Session Config\nwaves: 5\n\n## Tail\nprose\n', 'utf8');

    const v = lintClaudeMd({ filePath, maxLines: 3 }).violations.find(
      (x) => x.rule === 'max-lines'
    );

    expect(v.message).toContain('7 lines'); // raw
    expect(v.message).toContain('4 non-exempt');
    expect(v.message).toContain('3 exempt');
    expect(v.message).toContain('max-lines 3'); // ceiling
  });

  it('exempts a Session Config block that runs to EOF (no following ## heading)', () => {
    const dir = tmp();
    const filePath = join(dir, 'CLAUDE.md');
    // Mirrors tests/fixtures/harness-audit/clean-repo/CLAUDE.md, whose block ends at EOF.
    writeFileSync(filePath, '# Title\n\n## Session Config\nwaves: 5\nvcs: gitlab\n', 'utf8');

    const result = lintClaudeMd({ filePath, maxLines: 3 });

    expect(result.lineCount).toBe(6);
    expect(result.exemptLines).toBe(4); // heading + 2 keys + trailing ''
    expect(result.effectiveLineCount).toBe(2);
    expect(result.violations).toHaveLength(0);
  });

  it('exempts nothing when the file has no Session Config heading', () => {
    const dir = tmp();
    const filePath = join(dir, 'CLAUDE.md');
    writeFileSync(filePath, '# Title\n\n## Intro\nprose\n', 'utf8');

    const result = lintClaudeMd({ filePath, maxLines: 4 });

    expect(result.exemptLines).toBe(0);
    expect(result.effectiveLineCount).toBe(result.lineCount);
    expect(result.violations.map((v) => v.rule)).toEqual(['max-lines']);
  });

  it('does not exempt near-miss headings that merely start with "Session Config"', () => {
    const dir = tmp();
    const filePath = join(dir, 'CLAUDE.md');
    // Real in-repo heading shapes: CONTRIBUTING.md, SECURITY.md, docs/recipes/*.
    writeFileSync(
      filePath,
      '## Session Config Convention\n## Session Config Command Trust\n## Session Config (CLAUDE.md)\n### Session Config\n',
      'utf8'
    );

    const result = lintClaudeMd({ filePath, maxLines: 4 });

    expect(result.exemptLines).toBe(0);
    expect(result.violations.map((v) => v.rule)).toEqual(['max-lines']);
  });

  // The bug this replaces a test for: the lint used to own a LOCAL heading
  // regex that tolerated a trailing HTML comment and extra spaces, while the
  // runtime parser (`_extractConfigSection`) requires the exact literal. A
  // CLAUDE.md decorated as this repo's own `## Current State <!-- … -->`
  // convention encourages therefore lost EVERY runtime config key to its
  // default, while the lint simultaneously reported `148 exempt:
  // "## Session Config"` — affirming the block at the moment it went blind.
  //
  // The predecessor test asserted `exemptLines === 3` for exactly that
  // decorated heading, i.e. it PINNED the defect as expected behaviour
  // (`.claude/rules/testing.md` § "Security Tests Must Not Encode the
  // Vulnerability"). It is replaced — not supplemented — by this one.
  it('never exempts a heading the runtime config parser rejects', () => {
    // Each heading is fed to BOTH the lint and the real runtime parser. A row
    // where the lint exempts but the parser sees no block is the silent
    // config-default fallback; the assertion is agreement, not a fixed verdict.
    const headings = [
      '## Session Config', // canonical — both accept
      '##  Session Config', // two spaces
      '## Session Config <!-- consistency:exempt:runtime-critical -->', // decorated
      '## Session Config Convention', // prose near-miss
    ];

    const disagreements = [];
    for (const heading of headings) {
      const content = `# T\n${heading}\nvcs: gitlab\n\n## Tail\n`;
      const filePath = join(tmp(), 'CLAUDE.md');
      writeFileSync(filePath, content, 'utf8');

      const lintSeesBlock = lintClaudeMd({ filePath, maxLines: 999 }).exemptLines > 0;
      const runtimeSeesBlock = _extractConfigSection(content).length > 0;
      if (lintSeesBlock !== runtimeSeesBlock) {
        disagreements.push({ heading, lintSeesBlock, runtimeSeesBlock });
      }
    }

    expect(disagreements).toEqual([]);

    // Pin the direction too, so a predicate that rejects EVERYTHING would still
    // fail: the canonical heading must be exempted by both.
    const canonical = `# T\n## Session Config\nvcs: gitlab\n\n## Tail\n`;
    const canonicalPath = join(tmp(), 'CLAUDE.md');
    writeFileSync(canonicalPath, canonical, 'utf8');
    expect(lintClaudeMd({ filePath: canonicalPath, maxLines: 999 }).exemptLines).toBe(3);
    expect(_extractConfigSection(canonical).length).toBeGreaterThan(0);

    // …and that the runtime genuinely loses its keys on the decorated form —
    // the concrete harm, asserted through the real parseSessionConfig entry
    // point rather than inferred from the extractor.
    expect(parseSessionConfig(canonical).vcs).toBe('gitlab');
    expect(
      parseSessionConfig(`# T\n## Session Config <!-- x -->\nvcs: gitlab\n\n## Tail\n`).vcs
    ).toBeNull();
  });

  it('exempts NOTHING and reports duplicate-session-config for two headings (fail-closed)', () => {
    const dir = tmp();
    const filePath = join(dir, 'CLAUDE.md');
    writeFileSync(filePath, '# T\n\n## Session Config\nkey: a\n\n## Session Config\nkey: b\n', 'utf8');

    const result = lintClaudeMd({ filePath, maxLines: 3 });

    expect(result.exemptLines).toBe(0);
    expect(result.effectiveLineCount).toBe(8);
    const dup = result.violations.find((v) => v.rule === 'duplicate-session-config');
    expect(dup).toBeDefined();
    expect(dup.line).toBe(6);
    expect(dup.message).toContain('lines 3, 6');
    // The budget is measured raw while duplicates exist -> the ceiling also trips.
    expect(result.violations.some((v) => v.rule === 'max-lines')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// max-line-chars violation
// ---------------------------------------------------------------------------

describe('lintClaudeMd — max-line-chars violation', () => {
  it('reports a max-line-chars violation with the correct line number', () => {
    const dir = tmp();
    const filePath = join(dir, 'CLAUDE.md');
    const longLine = 'a'.repeat(11); // 11 chars, exceeds maxLineChars: 10
    writeFileSync(filePath, `short\n${longLine}\nshort again\n`, 'utf8');

    const result = lintClaudeMd({ filePath, maxLineChars: 10 });

    expect(result.status).toBe('invalid');
    expect(result.maxLineCharsSeen).toBe(11);
    const v = result.violations.find((x) => x.rule === 'max-line-chars');
    expect(v).toBeDefined();
    expect(v.line).toBe(2);
    expect(v.message).toContain('11 chars');
  });

  it('does not report a max-line-chars violation when every line is under the ceiling', () => {
    const dir = tmp();
    const filePath = join(dir, 'CLAUDE.md');
    writeFileSync(filePath, 'short\nalso short\n', 'utf8');

    const result = lintClaudeMd({ filePath, maxLineChars: 400 });

    expect(result.violations.filter((x) => x.rule === 'max-line-chars')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// provenance-header probe
// ---------------------------------------------------------------------------

describe('lintClaudeMd — provenance-header probe', () => {
  it('reports a provenance-header violation when requireProvenance is true and line 1 lacks it', () => {
    const dir = tmp();
    const filePath = join(dir, 'CLAUDE.md');
    writeFileSync(filePath, '# Title\n\nNo header here.\n', 'utf8');

    const result = lintClaudeMd({ filePath, requireProvenance: true });

    expect(result.hasProvenance).toBe(false);
    const v = result.violations.find((x) => x.rule === 'provenance-header');
    expect(v).toBeDefined();
    expect(v.line).toBe(1);
  });

  it('does not report a provenance-header violation when line 1 carries the header', () => {
    const dir = tmp();
    const filePath = join(dir, 'CLAUDE.md');
    writeFileSync(filePath, '<!-- source: some-baseline v1.2.3 -->\n# Title\n\nBody.\n', 'utf8');

    const result = lintClaudeMd({ filePath, requireProvenance: true });

    expect(result.hasProvenance).toBe(true);
    expect(result.violations.filter((x) => x.rule === 'provenance-header')).toHaveLength(0);
  });

  it('does not evaluate provenance when requireProvenance is false (default)', () => {
    const dir = tmp();
    const filePath = join(dir, 'CLAUDE.md');
    writeFileSync(filePath, '# Title\n\nNo header here.\n', 'utf8');

    const result = lintClaudeMd({ filePath });

    expect(result.violations.filter((x) => x.rule === 'provenance-header')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Infra errors
// ---------------------------------------------------------------------------

describe('lintClaudeMd — infra errors', () => {
  it('throws ClaudeMdLintInfraError when the file does not exist', () => {
    const missing = join(tmpdir(), 'definitely-does-not-exist-budget-lint-xyz.md');

    expect(() => lintClaudeMd({ filePath: missing })).toThrow(ClaudeMdLintInfraError);
  });

  it('throws ClaudeMdLintInfraError when filePath is omitted', () => {
    expect(() => lintClaudeMd({})).toThrow(ClaudeMdLintInfraError);
  });
});

// ---------------------------------------------------------------------------
// CLI — exit-code contract + --json shape
// ---------------------------------------------------------------------------

describe('CLI — exit codes', () => {
  it('exits 0 for a clean file in hard mode (default)', () => {
    const dir = tmp();
    const filePath = join(dir, 'CLAUDE.md');
    writeFileSync(filePath, '# Title\n\nShort body.\n', 'utf8');

    const { status } = runCLI(['--file', filePath]);

    expect(status).toBe(0);
  });

  it('auto-resolves AGENTS.md from --repo-root when CLAUDE.md is absent', () => {
    const dir = tmp();
    const agentsPath = join(dir, 'AGENTS.md');
    writeFileSync(agentsPath, '<!-- source: fixture -->\n# Title\n\nShort body.\n', 'utf8');

    const { stdout, status } = runCLI(['--repo-root', dir, '--require-provenance', '--json']);

    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.file).toBe(agentsPath);
    expect(parsed.hasProvenance).toBe(true);
  });

  it('exits 1 in hard mode when a violation is present', () => {
    const dir = tmp();
    const filePath = join(dir, 'CLAUDE.md');
    writeFileSync(filePath, 'line1\nline2\nline3\n', 'utf8');

    const { status } = runCLI(['--file', filePath, '--max-lines', '2']);

    expect(status).toBe(1);
  });

  it('exits 0 in warn mode even when a violation is present', () => {
    const dir = tmp();
    const filePath = join(dir, 'CLAUDE.md');
    writeFileSync(filePath, 'line1\nline2\nline3\n', 'utf8');

    const { status } = runCLI(['--file', filePath, '--max-lines', '2', '--mode', 'warn']);

    expect(status).toBe(0);
  });

  it('exits 2 with an infra-error envelope when the file does not exist', () => {
    const missing = join(tmpdir(), 'definitely-does-not-exist-budget-lint-cli.md');

    const { stderr, status } = runCLI(['--file', missing]);

    expect(status).toBe(2);
    // Folded in from a duplicate case in the arg-hygiene block (deleted #959):
    // exit 2 stays reserved for genuine infra errors, never CLI-arg errors.
    expect(JSON.parse(stderr).status).toBe('infra-error');
  });

  it('--json produces parseable output with the expected top-level shape', () => {
    const dir = tmp();
    const filePath = join(dir, 'CLAUDE.md');
    writeFileSync(filePath, '# Title\n\nShort body.\n', 'utf8');

    const { stdout, status } = runCLI(['--file', filePath, '--json']);

    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toMatchObject({
      status: 'ok',
      file: filePath,
      hasProvenance: false,
    });
    expect(Array.isArray(parsed.violations)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CLI — argument-hygiene error paths (#892). Every CLI-argument error (a
// missing flag value, an invalid --mode enum value, a non-numeric
// --max-lines/--max-line-chars, or an unknown flag) is a USER/input error
// per `.claude/rules/cli-design.md` § Exit Codes and MUST exit 1 — never
// exit 2 (reserved for genuine infra errors: missing/unreadable target
// file). Before #892, `--repo-root` with no following value crashed into an
// uncaught `resolve(undefined)` TypeError (leaked internal message, exit 2),
// and every other arg-error path here also exited 2.
// ---------------------------------------------------------------------------

describe('CLI — argument-hygiene error paths (#892)', () => {
  it('exits 1 with a clean stderr message when --repo-root has no following value', () => {
    const { stdout, stderr, status } = runCLI(['--repo-root']);

    expect(status).toBe(1);
    // No leaked internal Node TypeError ("paths[0] argument must be of type string").
    expect(stderr).not.toMatch(/TypeError|paths\[0\]/);
    const parsed = JSON.parse(stderr);
    expect(parsed).toEqual({ status: 'user-error', reason: '--repo-root requires a value' });
    expect(stdout).toBe('');
  });

  it('exits 1 with a clean stderr message when --file has no following value', () => {
    const { stderr, status } = runCLI(['--file']);

    expect(status).toBe(1);
    const parsed = JSON.parse(stderr);
    expect(parsed).toEqual({ status: 'user-error', reason: '--file requires a value' });
  });

  it('exits 1 when --max-lines has no following value', () => {
    const { stderr, status } = runCLI(['--max-lines']);

    expect(status).toBe(1);
    const parsed = JSON.parse(stderr);
    expect(parsed).toEqual({ status: 'user-error', reason: '--max-lines requires a value' });
  });

  it('exits 1 when --max-lines is given a non-numeric value', () => {
    const { stderr, status } = runCLI(['--max-lines', 'abc']);

    expect(status).toBe(1);
    const parsed = JSON.parse(stderr);
    expect(parsed).toEqual({ status: 'user-error', reason: 'invalid --max-lines: abc' });
  });

  it('exits 1 when --max-line-chars has no following value', () => {
    const { stderr, status } = runCLI(['--max-line-chars']);

    expect(status).toBe(1);
    const parsed = JSON.parse(stderr);
    expect(parsed).toEqual({ status: 'user-error', reason: '--max-line-chars requires a value' });
  });

  it('exits 1 when --max-line-chars is given a non-numeric value', () => {
    const { stderr, status } = runCLI(['--max-line-chars', 'xyz']);

    expect(status).toBe(1);
    const parsed = JSON.parse(stderr);
    expect(parsed).toEqual({ status: 'user-error', reason: 'invalid --max-line-chars: xyz' });
  });

  it('exits 1 when --mode has no following value', () => {
    const { stderr, status } = runCLI(['--mode']);

    expect(status).toBe(1);
    const parsed = JSON.parse(stderr);
    expect(parsed).toEqual({ status: 'user-error', reason: '--mode requires a value' });
  });

  it('exits 1 when --mode is given an unrecognized enum value', () => {
    const { stderr, status } = runCLI(['--mode', 'bogus']);

    expect(status).toBe(1);
    const parsed = JSON.parse(stderr);
    expect(parsed).toEqual({ status: 'user-error', reason: 'invalid --mode: bogus' });
  });

  it('exits 1 for an unrecognized flag', () => {
    const { stderr, status } = runCLI(['--does-not-exist']);

    expect(status).toBe(1);
    const parsed = JSON.parse(stderr);
    expect(parsed).toEqual({ status: 'user-error', reason: 'unknown arg: --does-not-exist' });
  });

  // Deleted in #959 (TV-002/TV-003 consolidation, paying for the exemption tests):
  //  - "still exits 2 for a genuine infra error" — identical args and status
  //    assertion to the exit-2 case above; its one extra field check was folded
  //    in there.
  //  - "--help documents the exit-code contract" — pinned usage-string prose
  //    (`toContain('Exit codes:')`); the exit-code contract itself is covered
  //    behaviourally by the 9 exit-code cases in this file.
});
