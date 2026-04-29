/**
 * tests/scripts/check-doc-consistency.test.mjs
 *
 * Vitest spec for scripts/check-doc-consistency.sh — the README ↔ CLAUDE.md
 * drift checker (issue #30 / W2-B6). Exercises the script via spawnSync so
 * exit codes and stdout are verified end-to-end.
 *
 * Coverage: 6 scenarios — clean state, missing-h2 drift, count-mismatch
 * drift, missing live `## Session Config`, alias-phrasing drift, and the
 * setup-error path (missing README.md).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts', 'check-doc-consistency.sh');

function runScript(cwd) {
  return spawnSync('sh', [SCRIPT], { cwd, encoding: 'utf8' });
}

describe('check-doc-consistency.sh', () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'doc-consistency-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('exits 0 on the live repo (clean state)', () => {
    const result = runScript(REPO_ROOT);
    // Surface any drift in the failure message
    expect(result.stderr || '').toBe('');
    expect(result.stdout).toContain('=> 0 findings (clean)');
    expect(result.status).toBe(0);
  });

  it('detects an H2 in CLAUDE.md without a counterpart in README.md', () => {
    writeFileSync(
      join(tmp, 'README.md'),
      `# Plugin\n\n## Install\n\nstuff\n\n## Components\n\n- 25 Skills\n- 10 Commands\n- 7 Agents\n`,
    );
    writeFileSync(
      join(tmp, 'CLAUDE.md'),
      `# Plugin\n\n## Session Config\n\nfoo\n\n## Some Brand New Heading\n\nbody text\n`,
    );

    const result = runScript(tmp);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('missing-h2');
    expect(result.stdout).toContain('Some Brand New Heading');
  });

  it('detects a count-mismatch between README.md and CLAUDE.md', () => {
    writeFileSync(
      join(tmp, 'README.md'),
      `# Plugin\n\n## Components\n\n- **16 Skills**: foo, bar\n- **10 Commands**: a, b\n`,
    );
    writeFileSync(
      join(tmp, 'CLAUDE.md'),
      `# Plugin\n\n## Session Config\n\nfoo\n\n## Components\n\n- **25 Skills**: foo, bar\n- **10 Commands**: a, b\n`,
    );

    const result = runScript(tmp);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('count-mismatch');
    expect(result.stdout).toContain('16 Skills');
    expect(result.stdout).toContain('25 Skills');
  });

  it('flags CLAUDE.md missing the live `## Session Config` block', () => {
    writeFileSync(
      join(tmp, 'README.md'),
      `# Plugin\n\n## Components\n\n- 25 Skills\n`,
    );
    writeFileSync(
      join(tmp, 'CLAUDE.md'),
      `# Plugin\n\n## Components\n\n- 25 Skills\n\n(no Session Config heading here)\n`,
    );

    const result = runScript(tmp);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('live-config-missing');
  });

  it('flags a bare CLAUDE.md mention not aliased to AGENTS.md', () => {
    writeFileSync(
      join(tmp, 'README.md'),
      `# Plugin\n\nAdd config to your project's CLAUDE.md to enable this feature.\n\n## Components\n\n- 1 Thing\n`,
    );
    writeFileSync(
      join(tmp, 'CLAUDE.md'),
      `# Plugin\n\n## Session Config\n\nfoo\n\n## Components\n\n- 1 Thing\n`,
    );

    const result = runScript(tmp);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('alias-phrasing');
  });

  it('exits 2 with a setup error when README.md is missing in cwd', () => {
    writeFileSync(
      join(tmp, 'CLAUDE.md'),
      `# Plugin\n\n## Session Config\n\nfoo\n`,
    );
    // README.md intentionally absent

    const result = runScript(tmp);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('README.md not found');
  });
});
