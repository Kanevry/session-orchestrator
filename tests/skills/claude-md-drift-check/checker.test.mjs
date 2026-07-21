/**
 * tests/skills/claude-md-drift-check/checker.test.mjs
 *
 * Vitest suite for skills/claude-md-drift-check/checker.mjs — narrative-drift
 * checks (path-resolver, project-count-sync, issue-reference-freshness,
 * session-file-existence, vault-dir-parity) + mode handling (warn/hard/off).
 *
 * Strategy: spawn the checker as a subprocess with VAULT_DIR pointing at
 * an ephemeral tmp vault. Assert on JSON output + exit code.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

// checker.mjs emits `file` fields using path.relative, which uses the runtime's
// path.sep. Normalize to forward slashes in assertions for Windows portability.
const forwardSlashes = (p) => (p ?? '').replaceAll(sep, '/');

const CHECKER = resolve(process.cwd(), 'skills/claude-md-drift-check/checker.mjs');

function runChecker(vaultDir, args = []) {
  const r = spawnSync('node', [CHECKER, ...args], {
    env: { ...process.env, VAULT_DIR: vaultDir, PATH: process.env.PATH },
    encoding: 'utf8',
  });
  return { stdout: r.stdout, stderr: r.stderr, code: r.status };
}

function parseJson(out) {
  const line = out.trim().split('\n').find((l) => l.startsWith('{'));
  return JSON.parse(line);
}

let vault;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'drift-check-'));
});

afterEach(() => {
  if (vault && existsSync(vault)) rmSync(vault, { recursive: true, force: true });
});

describe('mode handling', () => {
  it('mode=off short-circuits to skipped-mode-off without scanning', () => {
    writeFileSync(join(vault, 'CLAUDE.md'), '# Test\n/Users/nowhere/xyz\n');
    const r = runChecker(vault, ['--mode', 'off']);
    expect(r.code).toBe(0);
    const j = parseJson(r.stdout);
    expect(j.status).toBe('skipped-mode-off');
    expect(j.mode).toBe('off');
  });

  it('mode=warn exits 0 even when errors exist', () => {
    writeFileSync(join(vault, 'CLAUDE.md'), 'Bad path: /Users/definitely/missing/xyz-abc\n');
    const r = runChecker(vault, ['--mode', 'warn', '--skip-issue-refs']);
    expect(r.code).toBe(0);
    const j = parseJson(r.stdout);
    expect(j.status).toBe('invalid');
    expect(j.errors.length).toBeGreaterThan(0);
  });

  it('mode=strict exits 1 when errors exist', () => {
    writeFileSync(join(vault, 'CLAUDE.md'), 'Bad path: /Users/definitely/missing/xyz-abc\n');
    const r = runChecker(vault, ['--mode', 'strict', '--skip-issue-refs']);
    expect(r.code).toBe(1);
    const j = parseJson(r.stdout);
    expect(j.status).toBe('invalid');
    expect(j.mode).toBe('strict');
  });

  it('mode=strict exits 0 when clean', () => {
    writeFileSync(join(vault, 'CLAUDE.md'), '# clean\nNo paths here.\n');
    const r = runChecker(vault, ['--mode', 'strict', '--skip-issue-refs']);
    expect(r.code).toBe(0);
    const j = parseJson(r.stdout);
    expect(j.status).toBe('ok');
  });

  it('mode=hard (legacy alias) exits 1 when errors exist and normalizes to strict', () => {
    writeFileSync(join(vault, 'CLAUDE.md'), 'Bad path: /Users/definitely/missing/xyz-abc\n');
    const r = runChecker(vault, ['--mode', 'hard', '--skip-issue-refs']);
    expect(r.code).toBe(1);
    const j = parseJson(r.stdout);
    expect(j.status).toBe('invalid');
    expect(j.mode).toBe('strict');
  });

  it('mode=hard (legacy alias) exits 0 when clean', () => {
    writeFileSync(join(vault, 'CLAUDE.md'), '# clean\nNo paths here.\n');
    const r = runChecker(vault, ['--mode', 'hard', '--skip-issue-refs']);
    expect(r.code).toBe(0);
    const j = parseJson(r.stdout);
    expect(j.status).toBe('ok');
  });

  it('invalid --mode returns infra-error exit 2', () => {
    writeFileSync(join(vault, 'CLAUDE.md'), '# x\n');
    const r = runChecker(vault, ['--mode', 'banana']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('invalid --mode');
  });
});

describe('check 1: path-resolver', () => {
  it('flags non-existent absolute paths', () => {
    writeFileSync(join(vault, 'CLAUDE.md'), 'See /Users/nobody/nowhere/ghost.txt for details.\n');
    const r = runChecker(vault, ['--skip-issue-refs']);
    const j = parseJson(r.stdout);
    const paths = j.errors.filter((e) => e.check === 'path-resolver');
    expect(paths.length).toBe(1);
    expect(paths[0].extracted).toBe('/Users/nobody/nowhere/ghost.txt');
  });

  it('accepts paths that exist', () => {
    const realFile = join(vault, 'real.txt');
    writeFileSync(realFile, 'x');
    writeFileSync(join(vault, 'CLAUDE.md'), `Found at ${realFile}\n`);
    const r = runChecker(vault, ['--skip-issue-refs']);
    const j = parseJson(r.stdout);
    const paths = j.errors.filter((e) => e.check === 'path-resolver');
    expect(paths.length).toBe(0);
  });

  it('skips paths inside triple-backtick fences', () => {
    writeFileSync(join(vault, 'CLAUDE.md'),
      'Example:\n```\n/Users/example/in-fence\n```\nEnd.\n');
    const r = runChecker(vault, ['--skip-issue-refs']);
    const j = parseJson(r.stdout);
    const paths = j.errors.filter((e) => e.check === 'path-resolver');
    expect(paths.length).toBe(0);
  });

  it('strips trailing punctuation before existence check', () => {
    const realFile = join(vault, 'real.txt');
    writeFileSync(realFile, 'x');
    writeFileSync(join(vault, 'CLAUDE.md'), `Found at ${realFile}.\n`);
    const r = runChecker(vault, ['--skip-issue-refs']);
    const j = parseJson(r.stdout);
    const pathErrs = j.errors.filter((e) => e.check === 'path-resolver');
    expect(pathErrs.length).toBe(0);
  });

  it('can be disabled with --skip-path-resolver', () => {
    writeFileSync(join(vault, 'CLAUDE.md'), '/Users/ghost/nowhere\n');
    const r = runChecker(vault, ['--skip-path-resolver', '--skip-issue-refs']);
    const j = parseJson(r.stdout);
    expect(j.checks_run).not.toContain('path-resolver');
    expect(j.errors.filter((e) => e.check === 'path-resolver').length).toBe(0);
  });
});

describe('check 2: project-count-sync', () => {
  it('flags mismatch between claimed and actual 01-projects/ count', () => {
    mkdirSync(join(vault, '01-projects/alpha'), { recursive: true });
    mkdirSync(join(vault, '01-projects/beta'), { recursive: true });
    writeFileSync(join(vault, 'CLAUDE.md'), 'Currently (5 registered) active projects.\n');
    const r = runChecker(vault, ['--skip-issue-refs']);
    const j = parseJson(r.stdout);
    const errs = j.errors.filter((e) => e.check === 'project-count-sync');
    expect(errs.length).toBe(1);
    expect(errs[0].message).toMatch(/claims 5.*actual.*2/);
  });

  it('accepts matching count', () => {
    mkdirSync(join(vault, '01-projects/alpha'), { recursive: true });
    mkdirSync(join(vault, '01-projects/beta'), { recursive: true });
    mkdirSync(join(vault, '01-projects/gamma'), { recursive: true });
    writeFileSync(join(vault, 'CLAUDE.md'), 'Currently (3 projects) active.\n');
    const r = runChecker(vault, ['--skip-issue-refs']);
    const j = parseJson(r.stdout);
    const errs = j.errors.filter((e) => e.check === 'project-count-sync');
    expect(errs.length).toBe(0);
  });

  it('ignores folders starting with _ or .', () => {
    mkdirSync(join(vault, '01-projects/alpha'), { recursive: true });
    mkdirSync(join(vault, '01-projects/_archive'), { recursive: true });
    mkdirSync(join(vault, '01-projects/.hidden'), { recursive: true });
    writeFileSync(join(vault, 'CLAUDE.md'), 'Claim (1 registered).\n');
    const r = runChecker(vault, ['--skip-issue-refs']);
    const j = parseJson(r.stdout);
    const errs = j.errors.filter((e) => e.check === 'project-count-sync');
    expect(errs.length).toBe(0);
  });

  it('skips when 01-projects/ directory is absent', () => {
    writeFileSync(join(vault, 'CLAUDE.md'), 'Claim (5 projects).\n');
    const r = runChecker(vault, ['--skip-issue-refs']);
    const j = parseJson(r.stdout);
    expect(j.checks_skipped.some((s) => s.startsWith('project-count-sync'))).toBe(true);
    expect(j.errors.filter((e) => e.check === 'project-count-sync').length).toBe(0);
  });
});

describe('check 3: issue-reference-freshness (auto-skip without glab)', () => {
  it('reports skip when glab is absent (skip-issue-refs bypasses)', () => {
    writeFileSync(join(vault, 'CLAUDE.md'), '## Backlog\n- #42 foo\n');
    const r = runChecker(vault, ['--skip-issue-refs']);
    const j = parseJson(r.stdout);
    expect(j.checks_run).not.toContain('issue-reference-freshness');
    expect(j.errors.filter((e) => e.check === 'issue-reference-freshness').length).toBe(0);
  });

  it('forward-section heading detection — "What\'s Next" is forward', () => {
    writeFileSync(join(vault, 'CLAUDE.md'),
      '## Recently Closed\n- #100 shipped\n## What\'s Next\n- #200 upcoming\n');
    const r = runChecker(vault, ['--skip-issue-refs']);
    const j = parseJson(r.stdout);
    expect(j.status).toBe('ok');
  });
});

describe('check 4: session-file-existence', () => {
  it('flags references to missing session files', () => {
    writeFileSync(join(vault, 'CLAUDE.md'),
      'See [[50-sessions/2026-04-19-feat.md]] for details.\n');
    const r = runChecker(vault, ['--skip-issue-refs']);
    const j = parseJson(r.stdout);
    const errs = j.errors.filter((e) => e.check === 'session-file-existence');
    expect(errs.length).toBe(1);
    expect(errs[0].extracted).toBe('50-sessions/2026-04-19-feat.md');
  });

  it('accepts references to existing session files', () => {
    mkdirSync(join(vault, '50-sessions'), { recursive: true });
    writeFileSync(join(vault, '50-sessions/2026-04-19-feat.md'), '# session\n');
    writeFileSync(join(vault, 'CLAUDE.md'),
      'See [[50-sessions/2026-04-19-feat.md]] for details.\n');
    const r = runChecker(vault, ['--skip-issue-refs']);
    const j = parseJson(r.stdout);
    const errs = j.errors.filter((e) => e.check === 'session-file-existence');
    expect(errs.length).toBe(0);
  });

  it('can be disabled with --skip-session-files', () => {
    writeFileSync(join(vault, 'CLAUDE.md'), 'See [[50-sessions/2026-04-19-feat.md]]\n');
    const r = runChecker(vault, ['--skip-session-files', '--skip-issue-refs']);
    const j = parseJson(r.stdout);
    expect(j.checks_run).not.toContain('session-file-existence');
    expect(j.errors.filter((e) => e.check === 'session-file-existence').length).toBe(0);
  });

  // Issue #660 dual-read: flat reference tolerated when note migrated to per-repo subfolder.
  it('accepts flat reference when note exists under per-repo subfolder (migration)', () => {
    mkdirSync(join(vault, '50-sessions', 'my-repo'), { recursive: true });
    writeFileSync(join(vault, '50-sessions', 'my-repo', '2026-04-19-feat.md'), '# session\n');
    // CLAUDE.md still uses the OLD flat reference style
    writeFileSync(join(vault, 'CLAUDE.md'),
      'See [[50-sessions/2026-04-19-feat.md]] for details.\n');
    const r = runChecker(vault, ['--skip-issue-refs']);
    const j = parseJson(r.stdout);
    const errs = j.errors.filter((e) => e.check === 'session-file-existence');
    expect(errs.length).toBe(0);
  });

  it('accepts namespaced reference when note exists at per-repo path', () => {
    mkdirSync(join(vault, '50-sessions', 'my-repo'), { recursive: true });
    writeFileSync(join(vault, '50-sessions', 'my-repo', '2026-04-19-feat.md'), '# session\n');
    writeFileSync(join(vault, 'CLAUDE.md'),
      'See [[50-sessions/my-repo/2026-04-19-feat.md]] for details.\n');
    const r = runChecker(vault, ['--skip-issue-refs']);
    const j = parseJson(r.stdout);
    const errs = j.errors.filter((e) => e.check === 'session-file-existence');
    expect(errs.length).toBe(0);
  });

  it('flags namespaced reference when note is genuinely missing', () => {
    mkdirSync(join(vault, '50-sessions', 'my-repo'), { recursive: true });
    writeFileSync(join(vault, 'CLAUDE.md'),
      'See [[50-sessions/my-repo/2026-04-19-feat.md]] for details.\n');
    const r = runChecker(vault, ['--skip-issue-refs']);
    const j = parseJson(r.stdout);
    const errs = j.errors.filter((e) => e.check === 'session-file-existence');
    expect(errs.length).toBe(1);
    expect(errs[0].extracted).toBe('50-sessions/my-repo/2026-04-19-feat.md');
  });
});

describe('check 7: vault-dir-parity', () => {
  // Minimal Session Config block carrying a vault-integration sub-block.
  const withVaultDir = (dir) =>
    `# Repo\n\n## Session Config\n\nvault-integration:\n  enabled: true\n  vault-dir: ${dir}\n  mode: warn\n`;

  it('agrees: both files share the same vault-dir → 0 parity errors, check ran', () => {
    writeFileSync(join(vault, 'CLAUDE.md'), withVaultDir('~/Projects/Bernhard/vault'));
    writeFileSync(join(vault, 'AGENTS.md'), withVaultDir('~/Projects/Bernhard/vault'));
    const r = runChecker(vault, ['--skip-issue-refs', '--skip-session-config-parity']);
    const j = parseJson(r.stdout);
    expect(j.errors.filter((e) => e.check === 'vault-dir-parity').length).toBe(0);
    expect(j.checks_run).toContain('vault-dir-parity');
  });

  it('disagrees: divergent vault-dir → exactly 1 parity error naming both values', () => {
    writeFileSync(join(vault, 'CLAUDE.md'), withVaultDir('~/Projects/Bernhard/vault'));
    writeFileSync(join(vault, 'AGENTS.md'), withVaultDir('~/Projects/vault'));
    const r = runChecker(vault, ['--skip-issue-refs', '--skip-session-config-parity']);
    const j = parseJson(r.stdout);
    const errs = j.errors.filter((e) => e.check === 'vault-dir-parity');
    expect(errs.length).toBe(1);
    expect(errs[0].message).toContain('~/Projects/Bernhard/vault');
    expect(errs[0].message).toContain('~/Projects/vault');
  });

  it('disagrees in hard mode → exit 1', () => {
    writeFileSync(join(vault, 'CLAUDE.md'), withVaultDir('~/Projects/Bernhard/vault'));
    writeFileSync(join(vault, 'AGENTS.md'), withVaultDir('~/Projects/vault'));
    const r = runChecker(vault, ['--mode', 'hard', '--skip-issue-refs', '--skip-session-config-parity']);
    expect(r.code).toBe(1);
    const j = parseJson(r.stdout);
    expect(j.errors.filter((e) => e.check === 'vault-dir-parity').length).toBe(1);
  });

  it('skips when only CLAUDE.md exists (no AGENTS.md)', () => {
    writeFileSync(join(vault, 'CLAUDE.md'), withVaultDir('~/Projects/Bernhard/vault'));
    const r = runChecker(vault, ['--skip-issue-refs', '--skip-session-config-parity']);
    const j = parseJson(r.stdout);
    expect(j.checks_run).not.toContain('vault-dir-parity');
    expect(j.checks_skipped.some((s) => s.startsWith('vault-dir-parity'))).toBe(true);
    expect(j.errors.filter((e) => e.check === 'vault-dir-parity').length).toBe(0);
  });

  it('skips when neither file has a vault-integration: block', () => {
    writeFileSync(join(vault, 'CLAUDE.md'), '# Repo\n\n## Session Config\n\npersistence: true\n');
    writeFileSync(join(vault, 'AGENTS.md'), '# Repo\n\n## Session Config\n\npersistence: true\n');
    const r = runChecker(vault, ['--skip-issue-refs', '--skip-session-config-parity']);
    const j = parseJson(r.stdout);
    expect(j.checks_run).not.toContain('vault-dir-parity');
    expect(j.checks_skipped.some((s) => s.includes('vault-integration'))).toBe(true);
    expect(j.errors.filter((e) => e.check === 'vault-dir-parity').length).toBe(0);
  });

  it('can be disabled with --skip-vault-dir-parity', () => {
    writeFileSync(join(vault, 'CLAUDE.md'), withVaultDir('~/Projects/Bernhard/vault'));
    writeFileSync(join(vault, 'AGENTS.md'), withVaultDir('~/Projects/vault'));
    const r = runChecker(vault, ['--skip-vault-dir-parity', '--skip-issue-refs', '--skip-session-config-parity']);
    const j = parseJson(r.stdout);
    expect(j.checks_run).not.toContain('vault-dir-parity');
    expect(j.errors.filter((e) => e.check === 'vault-dir-parity').length).toBe(0);
  });

  it('agrees when both files omit vault-dir but have the block (both unset)', () => {
    const blockNoDir = '# Repo\n\n## Session Config\n\nvault-integration:\n  enabled: true\n  mode: warn\n';
    writeFileSync(join(vault, 'CLAUDE.md'), blockNoDir);
    writeFileSync(join(vault, 'AGENTS.md'), blockNoDir);
    const r = runChecker(vault, ['--skip-issue-refs', '--skip-session-config-parity']);
    const j = parseJson(r.stdout);
    expect(j.checks_run).toContain('vault-dir-parity');
    expect(j.errors.filter((e) => e.check === 'vault-dir-parity').length).toBe(0);
  });

  // ── Divergence variants (#600 D4 deepening) ──────────────────────────────────
  // The "happy" disagreement case (canonical vs missing-segment) is covered above.
  // These two edges prove the check has NO hardcoded "expected" value — it flags
  // ANY divergence, regardless of which side carries which non-canonical form.

  it('disagrees: TWO non-canonical custom values → 1 parity error naming BOTH (check has no hardcoded expected)', () => {
    // Neither side is the canonical /Bernhard/vault path — both are different
    // arbitrary custom locations. The check still flags the divergence by
    // including both values in the message.
    writeFileSync(join(vault, 'CLAUDE.md'), withVaultDir('/srv/data/vault-a'));
    writeFileSync(join(vault, 'AGENTS.md'), withVaultDir('/srv/data/vault-b'));
    const r = runChecker(vault, ['--skip-issue-refs', '--skip-session-config-parity']);
    const j = parseJson(r.stdout);
    const errs = j.errors.filter((e) => e.check === 'vault-dir-parity');
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toContain('/srv/data/vault-a');
    expect(errs[0].message).toContain('/srv/data/vault-b');
    // The "extracted" field carries the AGENTS.md value — fixed by the check.
    expect(errs[0].extracted).toBe('/srv/data/vault-b');
  });

  it('disagrees: block-form (vault-dir set) vs block-form (vault-dir omitted) → flagged with "(unset)" in the message', () => {
    // Asymmetric case: CLAUDE.md declares both block + vault-dir; AGENTS.md
    // declares the block but omits vault-dir. Because `present=true` on the
    // AGENTS side and `present=true` on the CLAUDE side, the check RUNS
    // (not skipped). Then `claudeDir='~/Projects/Bernhard/vault'` !== `agentsDir=null`
    // → ERROR flagged. The message must surface "(unset)" so the operator
    // sees WHICH side is missing the value rather than a confusing null/empty.
    writeFileSync(join(vault, 'CLAUDE.md'), withVaultDir('~/Projects/Bernhard/vault'));
    // AGENTS.md: block-form vault-integration present, but vault-dir is OMITTED.
    writeFileSync(
      join(vault, 'AGENTS.md'),
      '# Repo\n\n## Session Config\n\nvault-integration:\n  enabled: true\n  mode: warn\n',
    );
    const r = runChecker(vault, ['--skip-issue-refs', '--skip-session-config-parity']);
    const j = parseJson(r.stdout);
    const errs = j.errors.filter((e) => e.check === 'vault-dir-parity');
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toContain('~/Projects/Bernhard/vault');
    expect(errs[0].message).toContain('(unset)');
    expect(errs[0].extracted).toBe('(unset)');
  });
});

describe('check 5: surface-count family (command/skill/agent/hook/test)', () => {
  // Full per-surface coverage lives in count-drift.test.mjs. These cases assert
  // the family integrates with the shared checker plumbing: checks_run wiring,
  // the back-compat result.command_count field, and the --skip-* flags. They
  // are EXACT-count drift checks (no floor/ceiling — that is the whole point).

  it('flags a drifted command-count claim and preserves result.command_count', () => {
    mkdirSync(join(vault, 'commands'), { recursive: true });
    writeFileSync(join(vault, 'commands/a.md'), '# a\n');
    writeFileSync(join(vault, 'commands/b.md'), '# b\n');
    writeFileSync(join(vault, 'CLAUDE.md'), 'We ship 5 commands today.\n');
    const r = runChecker(vault, ['--skip-issue-refs']);
    const j = parseJson(r.stdout);
    const errs = j.errors.filter((e) => e.check === 'command-count');
    expect(errs.length).toBe(1);
    expect(errs[0].message).toBe('Narrative claims 5 commands but actual on-disk count is 2');
    expect(errs[0].command_count).toEqual({ actual: 2, claimed: 5 });
    expect(j.command_count).toEqual({ actual: 2 });
    expect(j.checks_run).toContain('command-count');
  });

  it('flags a drifted skill-count claim against actual skills/*/SKILL.md', () => {
    for (const name of ['alpha', 'beta', 'gamma']) {
      mkdirSync(join(vault, 'skills', name), { recursive: true });
      writeFileSync(join(vault, 'skills', name, 'SKILL.md'), '# s\n');
    }
    writeFileSync(join(vault, 'CLAUDE.md'), 'There are 5 skills here.\n');
    const r = runChecker(vault, ['--skip-issue-refs']);
    const j = parseJson(r.stdout);
    const errs = j.errors.filter((e) => e.check === 'skill-count');
    expect(errs.length).toBe(1);
    expect(errs[0].message).toBe('Narrative claims 5 skills but actual on-disk count is 3');
    expect(j.checks_run).toContain('skill-count');
  });

  it('--skip-surface-count removes every surface from checks_run', () => {
    mkdirSync(join(vault, 'commands'), { recursive: true });
    writeFileSync(join(vault, 'commands/a.md'), '# a\n');
    mkdirSync(join(vault, 'skills', 'one'), { recursive: true });
    writeFileSync(join(vault, 'skills', 'one', 'SKILL.md'), '# s\n');
    writeFileSync(join(vault, 'CLAUDE.md'), '99 commands and 99 skills.\n');
    const r = runChecker(vault, ['--skip-surface-count', '--skip-issue-refs']);
    const j = parseJson(r.stdout);
    expect(j.checks_run).not.toContain('command-count');
    expect(j.checks_run).not.toContain('skill-count');
    expect(j.errors.filter((e) => /-count$/.test(e.check)).length).toBe(0);
  });
});

describe('include-paths globbing', () => {
  it('scans _meta/**/*.md files by default', () => {
    mkdirSync(join(vault, '_meta/sub'), { recursive: true });
    writeFileSync(join(vault, '_meta/sub/notes.md'), '/Users/ghost/missing\n');
    const r = runChecker(vault, ['--skip-issue-refs']);
    const j = parseJson(r.stdout);
    expect(j.files_scanned).toBe(1);
    const errs = j.errors.filter((e) => e.check === 'path-resolver');
    expect(errs.length).toBe(1);
    expect(forwardSlashes(errs[0].file)).toBe('_meta/sub/notes.md');
  });

  it('honors explicit --include-path overrides', () => {
    writeFileSync(join(vault, 'CLAUDE.md'), '/Users/ghost/one\n');
    writeFileSync(join(vault, 'README.md'), '/Users/ghost/two\n');
    const r = runChecker(vault, ['--include-path', 'README.md', '--skip-issue-refs']);
    const j = parseJson(r.stdout);
    expect(j.files_scanned).toBe(1);
    const files = j.errors.map((e) => e.file);
    expect(files).toContain('README.md');
    expect(files).not.toContain('CLAUDE.md');
  });

  it('reports skipped status when no scope files match', () => {
    const r = runChecker(vault, ['--skip-issue-refs']);
    const j = parseJson(r.stdout);
    expect(j.status).toBe('skipped');
    expect(j.files_scanned).toBe(0);
  });
});

describe('infra errors', () => {
  it('returns exit 2 on unknown argument', () => {
    writeFileSync(join(vault, 'CLAUDE.md'), '# x\n');
    const r = runChecker(vault, ['--not-a-real-flag']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown arg');
  });
});
