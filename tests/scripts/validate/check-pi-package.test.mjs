/**
 * tests/scripts/validate/check-pi-package.test.mjs
 *
 * Direct tests for the Pi package manifest validator.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'lib', 'validate', 'check-pi-package.mjs');

function run(pluginRoot) {
  return spawnSync(process.execPath, [SCRIPT, pluginRoot], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 10_000,
  });
}

function makeFixture(pkg) {
  const dir = mkdtempSync(path.join(tmpdir(), 'check-pi-package-'));
  mkdirSync(path.join(dir, 'pi', 'extensions'), { recursive: true });
  mkdirSync(path.join(dir, 'pi', 'prompts'), { recursive: true });
  mkdirSync(path.join(dir, 'skills'), { recursive: true });
  mkdirSync(path.join(dir, 'commands'), { recursive: true });
  writeFileSync(path.join(dir, 'pi', 'extensions', 'session-orchestrator.ts'), 'export default function plugin() {}\n');
  writeFileSync(path.join(dir, 'pi', 'prompts', 'session.md'), '# Session prompt\n');
  writeFileSync(path.join(dir, 'skills', 'SKILL.md'), '# Skill\n');
  writeFileSync(path.join(dir, 'commands', 'session.md'), '# Session\n');
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  return dir;
}

const validPackage = {
  name: 'session-orchestrator',
  keywords: ['pi-package'],
  pi: {
    extensions: ['./pi/extensions/session-orchestrator.ts'],
    skills: ['./skills'],
    prompts: ['./pi/prompts/*.md'],
  },
};

describe('check-pi-package.mjs', () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('exits 0 against the current repo', () => {
    const result = run(REPO_ROOT);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('package.json keywords include pi-package');
  });

  it('exits 0 for a valid synthetic package', () => {
    dir = makeFixture(validPackage);
    const result = run(dir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('pi.extensions entry resolves');
    expect(result.stdout).toContain('pi.prompts entry resolves');
  });

  it('fails when the pi-package keyword is absent', () => {
    dir = makeFixture({ ...validPackage, keywords: [] });
    const result = run(dir);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('keywords must include pi-package');
  });

  it('fails when a manifest path does not resolve', () => {
    dir = makeFixture({
      ...validPackage,
      pi: {
        ...validPackage.pi,
        extensions: ['./pi/extensions/missing.ts'],
      },
    });
    const result = run(dir);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('entry does not resolve');
  });

  it('fails when a path is not repo-relative', () => {
    dir = makeFixture({
      ...validPackage,
      pi: {
        ...validPackage.pi,
        skills: ['skills'],
      },
    });
    const result = run(dir);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('start with ./');
  });
});
