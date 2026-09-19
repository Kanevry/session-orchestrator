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

// Built from its code point, never written literally: a raw U+FEFF in tracked
// source is what `check-dangerous-invisibles` blocks, and the escape form is
// what `toolchain-and-build.md` § NUL byte prescribes for control characters in
// fixtures.
const BOM = String.fromCharCode(0xfeff);

/**
 * Materialise the generator into a fixture tree. It resolves its own ROOT from
 * `import.meta.url`, so the copy must sit at `<root>/scripts/` — and since the
 * `user-invocable` predicate is now the SHARED
 * `scripts/lib/user-invocable-skills.mjs` (one truth for Cursor, Pi, Codex and
 * every counter), its dependency-free import chain travels with it.
 *
 * @param {string} fixtureRoot
 * @returns {string} path to the copied generator
 */
function installGenerator(fixtureRoot) {
  mkdirSync(path.join(fixtureRoot, 'scripts', 'lib'), { recursive: true });
  for (const rel of ['lib/user-invocable-skills.mjs', 'lib/agent-frontmatter.mjs']) {
    copyFileSync(path.join(REPO_ROOT, 'scripts', rel), path.join(fixtureRoot, 'scripts', rel));
  }
  const dest = path.join(fixtureRoot, 'scripts', 'generate-cursor-adapter.mjs');
  copyFileSync(SCRIPT, dest);
  return dest;
}

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
      installGenerator(fixtureRoot);
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
      installGenerator(fixtureRoot);
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

  it('propagates disable-model-invocation from every source skill that declares it', () => {
    // The bug this catches: the wrapper flag used to be DERIVED from
    // `user-invocable` (`if (!isUserInvocable(...))`), which is the inverse of
    // the source semantics — six operator-only skills carry BOTH flags, so all
    // six Cursor wrappers shipped with none, and a Cursor model could
    // auto-invoke /close, /go and /release. `tests/commands/disable-model-invocation.test.mjs`
    // reads only the SOURCE definitions and stayed green throughout.
    // Census over the real directories: a hand-typed list would only check itself.
    const declaring = readdirSync(path.join(REPO_ROOT, 'skills'))
      .filter((name) => existsSync(path.join(REPO_ROOT, 'skills', name, 'SKILL.md')))
      .filter((name) => /^disable-model-invocation:\s*true\s*$/m.test(
        readFileSync(path.join(REPO_ROOT, 'skills', name, 'SKILL.md'), 'utf8'),
      ));

    // Vacuum guard: an empty census would make every assertion below pass for free.
    expect(declaring.length).toBeGreaterThan(0);

    const missing = declaring.filter((name) => !/^disable-model-invocation:\s*true\s*$/m.test(
      readFileSync(path.join(REPO_ROOT, '.cursor', 'skills', name, 'SKILL.md'), 'utf8'),
    ));
    expect(missing).toEqual([]);

    // Same value on the command surface, where one exists: an operator-only
    // command must stay operator-only on whichever surface Cursor reads.
    const missingCommand = declaring
      .filter((name) => existsSync(path.join(REPO_ROOT, '.cursor', 'commands', `${name}.md`)))
      .filter((name) => !/^disable-model-invocation:\s*true\s*$/m.test(
        readFileSync(path.join(REPO_ROOT, '.cursor', 'commands', `${name}.md`), 'utf8'),
      ));
    expect(missingCommand).toEqual([]);
  });

  // H1 (2026-09-17): this generator was the ONE of five sites that kept a
  // private `user-invocable` predicate (bare `true` after a trim) plus a private
  // frontmatter parser blind to a BOM and to CRLF. Each of the four shapes below
  // therefore read as NOT user-invocable HERE while the shared counter listed
  // the skill as a command — and because `disablesModelInvocation()` ORs
  // `!isUserInvocable`, the demoted skill got `disable-model-invocation: true`
  // STAMPED into its wrapper: a restriction added in the permissive→restrictive
  // direction the docblock says must never happen silently.
  it.each([
    ['True', (v) => `---\nname: close\ndescription: Close it.\nuser-invocable: ${v === 'bare' ? 'true' : 'True'}\n---\n# Body\n`],
    ['true # a slash command', (v) => `---\nname: close\ndescription: Close it.\nuser-invocable: true${v === 'bare' ? '' : ' # a slash command'}\n---\n# Body\n`],
    ['a leading UTF-8 BOM', (v) => `${v === 'bare' ? '' : BOM}---\nname: close\ndescription: Close it.\nuser-invocable: true\n---\n# Body\n`],
    ['CRLF line endings', (v) => {
      const text = '---\nname: close\ndescription: Close it.\nuser-invocable: true\n---\n# Body\n';
      return v === 'bare' ? text : text.replace(/\n/g, '\r\n');
    }],
  ])('emits the same wrapper set for %s as for a bare LF `true`', (_label, render) => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'generate-cursor-adapter-shape-'));
    try {
      mkdirSync(path.join(fixtureRoot, 'commands'), { recursive: true });
      mkdirSync(path.join(fixtureRoot, 'skills', 'close'), { recursive: true });
      const generator = installGenerator(fixtureRoot);
      writeFileSync(path.join(fixtureRoot, 'commands', 'session.md'), '---\ndescription: Source command\n---\n# Body\n');

      const generate = (variant) => {
        writeFileSync(path.join(fixtureRoot, 'skills', 'close', 'SKILL.md'), render(variant));
        const result = spawnSync(process.execPath, [generator], {
          cwd: fixtureRoot,
          encoding: 'utf8',
          timeout: 10_000,
        });
        expect(result.status, result.stderr).toBe(0);
        const commands = readdirSync(path.join(fixtureRoot, '.cursor', 'commands')).sort();
        return Object.fromEntries([
          ...commands.map((name) => [
            `commands/${name}`,
            readFileSync(path.join(fixtureRoot, '.cursor', 'commands', name), 'utf8'),
          ]),
          // The skill wrapper carries the stamped restriction, so it must be in
          // the compared set — a demotion is invisible in the command list alone
          // only when it also drops the file.
          ['skills/close/SKILL.md', readFileSync(path.join(fixtureRoot, '.cursor', 'skills', 'close', 'SKILL.md'), 'utf8')],
        ]);
      };

      const bare = generate('bare');
      expect(Object.keys(bare).sort()).toEqual(['commands/close.md', 'commands/session.md', 'skills/close/SKILL.md']);
      expect(bare['skills/close/SKILL.md']).not.toContain('disable-model-invocation');
      expect(generate('variant')).toEqual(bare);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  // Ground 2 of `disablesModelInvocation()` — the cell no other test covers:
  // source flag ABSENT + `user-invocable: false` must still stamp the
  // restriction. Cells 1 (source flag declared) and 2 (user-invocable truthy
  // look-alikes stay unstamped) are pinned above. The nameable bug: someone
  // drops `|| !userInvocable` reasoning "Cursor ignores the key anyway"
  // (unverified as of 2026-09-18 — see the docblock's named ceiling) and 24 of
  // 50 wrappers silently go permissive with nothing red.
  it('stamps disable-model-invocation on ground 2 alone (no source flag, not user-invocable)', () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'generate-cursor-adapter-ground2-'));
    try {
      mkdirSync(path.join(fixtureRoot, 'commands'), { recursive: true });
      mkdirSync(path.join(fixtureRoot, 'skills', 'libskill'), { recursive: true });
      const generator = installGenerator(fixtureRoot);
      writeFileSync(path.join(fixtureRoot, 'commands', 'session.md'), '---\ndescription: Source command\n---\n# Body\n');
      // No `disable-model-invocation` anywhere in the source — ground 1 absent.
      const source = '---\nname: libskill\ndescription: Library skill.\nuser-invocable: false\n---\n# Body\n';
      writeFileSync(path.join(fixtureRoot, 'skills', 'libskill', 'SKILL.md'), source);
      expect(source).not.toContain('disable-model-invocation');

      const result = spawnSync(process.execPath, [generator], {
        cwd: fixtureRoot,
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(result.status, result.stderr).toBe(0);

      const wrapper = readFileSync(
        path.join(fixtureRoot, '.cursor', 'skills', 'libskill', 'SKILL.md'),
        'utf8',
      );
      expect(wrapper).toMatch(/^disable-model-invocation:\s*true\s*$/m);
      // A library skill is not a slash command either — if it ever became one,
      // the restriction would have to be re-argued rather than inherited.
      expect(existsSync(path.join(fixtureRoot, '.cursor', 'commands', 'libskill.md'))).toBe(false);
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
      installGenerator(fixtureRoot);
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
