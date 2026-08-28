/**
 * tests/scripts/generate-cursor-adapter.test.mjs
 *
 * Drift check for generated Cursor command and skill wrappers.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'generate-cursor-adapter.mjs');

describe('generate-cursor-adapter.mjs', () => {
  it('reports generated Cursor wrappers are up to date', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--check'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 10_000,
    });

    const commandCount = readdirSync(path.join(REPO_ROOT, 'commands')).filter((name) => name.endsWith('.md')).length;
    const skillCount = readdirSync(path.join(REPO_ROOT, 'skills')).filter((name) => {
      try {
        return readdirSync(path.join(REPO_ROOT, 'skills', name)).includes('SKILL.md');
      } catch {
        return false;
      }
    }).length;
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`cursor adapter: ${commandCount} command(s), ${skillCount} skill(s) up to date`);
  });

  it('regenerates stale Cursor command wrappers from the command source', () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'generate-cursor-adapter-'));

    try {
      mkdirSync(path.join(fixtureRoot, 'scripts'), { recursive: true });
      mkdirSync(path.join(fixtureRoot, 'commands'), { recursive: true });
      mkdirSync(path.join(fixtureRoot, 'skills', 'session-start'), { recursive: true });
      mkdirSync(path.join(fixtureRoot, '.cursor', 'commands'), { recursive: true });
      mkdirSync(path.join(fixtureRoot, '.cursor', 'skills', 'session-start'), { recursive: true });
      copyFileSync(SCRIPT, path.join(fixtureRoot, 'scripts', 'generate-cursor-adapter.mjs'));
      writeFileSync(
        path.join(fixtureRoot, 'commands', 'session.md'),
        '---\ndescription: Source command\nargument-hint: "[new-mode]"\n---\n# Source body\n',
      );
      writeFileSync(
        path.join(fixtureRoot, 'skills', 'session-start', 'SKILL.md'),
        '---\nname: session-start\ndescription: Start a session\nuser-invocable: false\n---\n# Body\n',
      );
      writeFileSync(path.join(fixtureRoot, '.cursor', 'commands', 'session.md'), 'stale\n');
      writeFileSync(path.join(fixtureRoot, '.cursor', 'skills', 'session-start', 'SKILL.md'), 'stale\n');

      const result = spawnSync(
        process.execPath,
        [path.join(fixtureRoot, 'scripts', 'generate-cursor-adapter.mjs')],
        { cwd: fixtureRoot, encoding: 'utf8', timeout: 10_000 },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('cursor adapter: wrote 1 command(s), 1 skill(s)');
      const command = readFileSync(path.join(fixtureRoot, '.cursor', 'commands', 'session.md'), 'utf8');
      expect(command).toContain('# /session');
      expect(command).toContain('commands/session.md');
      expect(command).toContain('Cursor has no Skill tool');
      const skill = readFileSync(path.join(fixtureRoot, '.cursor', 'skills', 'session-start', 'SKILL.md'), 'utf8');
      expect(skill).toContain('name: session-start');
      expect(skill).toContain('disable-model-invocation: true');
      expect(skill).toContain('skills/session-start/SKILL.md');
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
