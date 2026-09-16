/**
 * tests/scripts/generate-cursor-adapter.test.mjs
 *
 * Drift check for generated Cursor command and skill wrappers.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
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

    // `.cursor/commands/` is the UNION of commands/*.md and every skill marked
    // `user-invocable: true` — tie the expectation to that union, never to a
    // literal, and never to commands/ alone (which would stay green while every
    // merged slash command was missing).
    const commandNames = readdirSync(path.join(REPO_ROOT, 'commands'))
      .filter((name) => name.endsWith('.md'))
      .map((name) => name.replace(/\.md$/, ''));
    const skillNames = readdirSync(path.join(REPO_ROOT, 'skills')).filter((name) => {
      try {
        return readdirSync(path.join(REPO_ROOT, 'skills', name)).includes('SKILL.md');
      } catch {
        return false;
      }
    });
    const userInvocable = skillNames.filter((name) => /^user-invocable:\s*true\s*$/m.test(
      readFileSync(path.join(REPO_ROOT, 'skills', name, 'SKILL.md'), 'utf8'),
    ));
    const unionCount = new Set([...commandNames, ...userInvocable]).size;
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`cursor adapter: ${unionCount} command(s), ${skillNames.length} skill(s) up to date`);
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

  it('emits a .cursor/commands wrapper for a user-invocable skill, and none for a library skill', () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'generate-cursor-adapter-union-'));

    try {
      mkdirSync(path.join(fixtureRoot, 'scripts'), { recursive: true });
      mkdirSync(path.join(fixtureRoot, 'commands'), { recursive: true });
      mkdirSync(path.join(fixtureRoot, 'skills', 'close'), { recursive: true });
      mkdirSync(path.join(fixtureRoot, 'skills', 'wave-executor'), { recursive: true });
      copyFileSync(SCRIPT, path.join(fixtureRoot, 'scripts', 'generate-cursor-adapter.mjs'));
      writeFileSync(
        path.join(fixtureRoot, 'commands', 'session.md'),
        '---\ndescription: Source command\nargument-hint: "[new-mode]"\n---\n# Source body\n',
      );
      // Trailing whitespace after `true` is the invisible-demotion case.
      writeFileSync(
        path.join(fixtureRoot, 'skills', 'close', 'SKILL.md'),
        '---\nname: close\ndescription: End session with verification\nuser-invocable: true \nargument-hint: "[--dry-run] [--force]"\n---\n# Body\n',
      );
      writeFileSync(
        path.join(fixtureRoot, 'skills', 'wave-executor', 'SKILL.md'),
        '---\nname: wave-executor\ndescription: Library skill\nuser-invocable: false\n---\n# Body\n',
      );

      const result = spawnSync(
        process.execPath,
        [path.join(fixtureRoot, 'scripts', 'generate-cursor-adapter.mjs')],
        { cwd: fixtureRoot, encoding: 'utf8', timeout: 10_000 },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('cursor adapter: wrote 2 command(s), 2 skill(s)');
      expect(readdirSync(path.join(fixtureRoot, '.cursor', 'commands')).sort()).toEqual(['close.md', 'session.md']);

      const wrapper = readFileSync(path.join(fixtureRoot, '.cursor', 'commands', 'close.md'), 'utf8');
      expect(wrapper).toContain('# /close');
      expect(wrapper).toContain('Use the Session Orchestrator skill definition at `skills/close/SKILL.md`.');
      expect(wrapper).toContain('Arguments: $ARGUMENTS');
      expect(wrapper).toContain('Cursor has no Skill tool.');
      // GH#54: a bare `[--dry-run] [--force]` is a YAML flow sequence.
      expect(wrapper).toContain('argument-hint: "[--dry-run] [--force]"');
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('fails loudly when one public name is claimed by both commands/ and a user-invocable skill', () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'generate-cursor-adapter-collision-'));

    try {
      mkdirSync(path.join(fixtureRoot, 'scripts'), { recursive: true });
      mkdirSync(path.join(fixtureRoot, 'commands'), { recursive: true });
      mkdirSync(path.join(fixtureRoot, 'skills', 'close'), { recursive: true });
      copyFileSync(SCRIPT, path.join(fixtureRoot, 'scripts', 'generate-cursor-adapter.mjs'));
      writeFileSync(path.join(fixtureRoot, 'commands', 'close.md'), '---\ndescription: Command copy\n---\n# Body\n');
      writeFileSync(
        path.join(fixtureRoot, 'skills', 'close', 'SKILL.md'),
        '---\nname: close\ndescription: Skill copy\nuser-invocable: true\n---\n# Body\n',
      );

      const result = spawnSync(
        process.execPath,
        [path.join(fixtureRoot, 'scripts', 'generate-cursor-adapter.mjs'), '--check'],
        { cwd: fixtureRoot, encoding: 'utf8', timeout: 10_000 },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('claimed by BOTH commands/ and a user-invocable skill: close');
      // A conflict must abort BEFORE any write, not resolve by precedence.
      expect(existsSync(path.join(fixtureRoot, '.cursor', 'commands', 'close.md'))).toBe(false);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
