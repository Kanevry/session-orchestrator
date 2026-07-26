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
import {
  lintClaudeMd,
  ClaudeMdLintInfraError,
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_LINE_CHARS,
} from '@lib/claude-md-budget-lint.mjs';

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
// Defaults sanity (hardcoded literals — these are the documented constants)
// ---------------------------------------------------------------------------

describe('exported defaults', () => {
  it('DEFAULT_MAX_LINES is 150', () => {
    expect(DEFAULT_MAX_LINES).toBe(150);
  });

  it('DEFAULT_MAX_LINE_CHARS is 400', () => {
    expect(DEFAULT_MAX_LINE_CHARS).toBe(400);
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

  it('exits 2 when the file does not exist', () => {
    const missing = join(tmpdir(), 'definitely-does-not-exist-budget-lint-cli.md');

    const { status } = runCLI(['--file', missing]);

    expect(status).toBe(2);
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

  it('still exits 2 for a genuine infra error (missing target file) — unaffected by the arg-hygiene fix', () => {
    const missing = join(tmpdir(), 'definitely-does-not-exist-budget-lint-arg-hygiene.md');

    const { stderr, status } = runCLI(['--file', missing]);

    expect(status).toBe(2);
    const parsed = JSON.parse(stderr);
    expect(parsed.status).toBe('infra-error');
  });

  it('--help documents the exit-code contract', () => {
    const { stdout, status } = runCLI(['--help']);

    expect(status).toBe(0);
    expect(stdout).toContain('Exit codes:');
    expect(stdout).toContain('CLI argument error');
  });
});
