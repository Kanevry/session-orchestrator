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
