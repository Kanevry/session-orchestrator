/**
 * tests/lib/plugin-surface.test.mjs
 *
 * #1240: the four surface generators must agree on which sources are public.
 * Before the shared enumerator, generate-agents-skills / generate-codex-skills
 * skipped a leading `.`/`_` while generate-cursor-adapter / generate-pi-prompts
 * did not — a `commands/_draft.md` became a Cursor command and a Pi prompt with
 * no Codex or `.agents` counterpart.
 *
 * Parser edge cases (quotes, folded scalars, BOM, CRLF, `True`, trailing
 * comment) are already pinned end-to-end in tests/scripts/generate-cursor-
 * adapter.test.mjs and generate-pi-prompts.test.mjs; not duplicated here (TV-004).
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listCommandFiles, listSkillDirs } from '@lib/plugin-surface.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const SKILL = '---\nname: NAME\ndescription: A skill.\nuser-invocable: true\n---\n# Body\n';

function seedSources(root) {
  mkdirSync(path.join(root, 'commands'), { recursive: true });
  for (const name of ['session.md', '_draft.md', '.hidden.md']) {
    writeFileSync(path.join(root, 'commands', name), '---\ndescription: A command.\n---\n# Body\n');
  }
  for (const name of ['close', '_shared', '.wip']) {
    mkdirSync(path.join(root, 'skills', name), { recursive: true });
    writeFileSync(path.join(root, 'skills', name, 'SKILL.md'), SKILL.replace('NAME', name));
  }
}

describe('plugin-surface enumeration', () => {
  it('lists only public commands and skills', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'plugin-surface-'));
    try {
      seedSources(root);
      expect(listCommandFiles(root)).toEqual(['session.md']);
      expect(listSkillDirs(root)).toEqual(['close']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The wiring half: a generator that re-grows a private readdir loop would
  // keep the unit test above green while emitting `_draft` wrappers again.
  it.each([
    ['generate-cursor-adapter.mjs', '.cursor/commands'],
    ['generate-pi-prompts.mjs', 'pi/prompts'],
  ])('%s emits no wrapper for a hidden command or skill', (script, outDir) => {
    const root = mkdtempSync(path.join(tmpdir(), 'plugin-surface-gen-'));
    try {
      seedSources(root);
      mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
      for (const rel of ['lib/user-invocable-skills.mjs', 'lib/agent-frontmatter.mjs', 'lib/plugin-surface.mjs', script]) {
        copyFileSync(path.join(REPO_ROOT, 'scripts', rel), path.join(root, 'scripts', rel));
      }
      const result = spawnSync(process.execPath, [path.join(root, 'scripts', script)], {
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readdirSync(path.join(root, outDir)).sort()).toEqual(['close.md', 'session.md']);
      if (script === 'generate-cursor-adapter.mjs') {
        expect(readdirSync(path.join(root, '.cursor', 'skills')).sort()).toEqual(['close']);
      }
      expect(existsSync(path.join(root, outDir, '_draft.md'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
