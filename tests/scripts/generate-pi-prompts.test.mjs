/**
 * tests/scripts/generate-pi-prompts.test.mjs
 *
 * Drift check for generated Pi prompt wrappers.
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
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'generate-pi-prompts.mjs');

// Built from its code point, never written literally: a raw U+FEFF in tracked
// source is what `check-dangerous-invisibles` blocks, and the escape form is
// what `toolchain-and-build.md` § NUL byte prescribes for control characters in
// fixtures.
const BOM = String.fromCharCode(0xfeff);

/**
 * Materialise the generator into a fixture tree. It resolves its own ROOT from
 * `import.meta.url`, so the copy must sit at `<root>/scripts/` — and since the
 * `user-invocable` predicate is now the SHARED `scripts/lib/user-invocable-skills.mjs`
 * (one truth for Cursor, Pi, Codex and every counter), its dependency-free
 * import chain travels with it.
 *
 * @param {string} fixtureRoot
 * @returns {string} path to the copied generator
 */
function installGenerator(fixtureRoot) {
  mkdirSync(path.join(fixtureRoot, 'scripts', 'lib'), { recursive: true });
  for (const rel of ['lib/user-invocable-skills.mjs', 'lib/agent-frontmatter.mjs']) {
    copyFileSync(path.join(REPO_ROOT, 'scripts', rel), path.join(fixtureRoot, 'scripts', rel));
  }
  const dest = path.join(fixtureRoot, 'scripts', 'generate-pi-prompts.mjs');
  copyFileSync(SCRIPT, dest);
  return dest;
}

describe('generate-pi-prompts.mjs', () => {
  it('reports generated Pi prompts are up to date', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--check'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 10_000,
    });

    // Drift-proof: tie the expected count to the actual sources rather than a
    // hard-pinned literal (testing.md § Dynamic Artifact Counts — Floor/Ceiling
    // Carve-Out). `pi/prompts/` is the UNION of commands/*.md and every skill
    // marked `user-invocable: true`; counting commands/ alone would stay green
    // while every merged slash command was missing its prompt.
    const commandNames = readdirSync(path.join(REPO_ROOT, 'commands'))
      .filter((name) => name.endsWith('.md'))
      .map((name) => name.replace(/\.md$/, ''));
    const userInvocable = readdirSync(path.join(REPO_ROOT, 'skills')).filter((name) => {
      try {
        return /^user-invocable:\s*true\s*$/m.test(
          readFileSync(path.join(REPO_ROOT, 'skills', name, 'SKILL.md'), 'utf8'),
        );
      } catch {
        return false;
      }
    });
    const unionCount = new Set([...commandNames, ...userInvocable]).size;
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`pi prompts: ${unionCount} file(s) up to date`);
  });

  it('regenerates stale Pi prompt content from the command source', () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'generate-pi-prompts-'));

    try {
      mkdirSync(path.join(fixtureRoot, 'scripts'), { recursive: true });
      mkdirSync(path.join(fixtureRoot, 'commands'), { recursive: true });
      mkdirSync(path.join(fixtureRoot, 'pi', 'prompts'), { recursive: true });
      installGenerator(fixtureRoot);
      writeFileSync(
        path.join(fixtureRoot, 'commands', 'session.md'),
        '---\ndescription: Source command\nargument-hint: "[new-mode]"\n---\n# Source body\n',
      );
      writeFileSync(
        path.join(fixtureRoot, 'pi', 'prompts', 'session.md'),
        '---\ndescription: Stale prompt\nargument-hint: [old-mode]\n---\n# Stale body\n',
      );

      const result = spawnSync(
        process.execPath,
        [path.join(fixtureRoot, 'scripts', 'generate-pi-prompts.mjs')],
        { cwd: fixtureRoot, encoding: 'utf8', timeout: 10_000 },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('pi prompts: wrote 1 file(s)');
      expect(readFileSync(path.join(fixtureRoot, 'pi', 'prompts', 'session.md'), 'utf8')).toBe(`---
description: Source command
argument-hint: "[new-mode]"
---

# /session

Use the Session Orchestrator command definition at \`commands/session.md\`.

Arguments: $@

Read that command file and follow it exactly. When it references \`$ARGUMENTS\`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.
`);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('emits a pi prompt for a user-invocable skill, and none for a library skill', () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'generate-pi-prompts-union-'));

    try {
      mkdirSync(path.join(fixtureRoot, 'scripts'), { recursive: true });
      mkdirSync(path.join(fixtureRoot, 'commands'), { recursive: true });
      mkdirSync(path.join(fixtureRoot, 'skills', 'close'), { recursive: true });
      mkdirSync(path.join(fixtureRoot, 'skills', 'wave-executor'), { recursive: true });
      mkdirSync(path.join(fixtureRoot, 'pi', 'prompts'), { recursive: true });
      installGenerator(fixtureRoot);
      writeFileSync(
        path.join(fixtureRoot, 'commands', 'session.md'),
        '---\ndescription: Source command\nargument-hint: "[new-mode]"\n---\n# Source body\n',
      );
      // Trailing whitespace after `true` is the invisible-demotion case; the
      // folded `>` description is the shape every merged skill actually uses.
      writeFileSync(
        path.join(fixtureRoot, 'skills', 'close', 'SKILL.md'),
        '---\nname: close\ndescription: >\n  End session with verification,\n  commits, and documentation.\nuser-invocable: true \nargument-hint: "[--dry-run]"\n---\n# Body\n',
      );
      writeFileSync(
        path.join(fixtureRoot, 'skills', 'wave-executor', 'SKILL.md'),
        '---\nname: wave-executor\ndescription: Library skill\nuser-invocable: false\n---\n# Body\n',
      );

      const result = spawnSync(
        process.execPath,
        [path.join(fixtureRoot, 'scripts', 'generate-pi-prompts.mjs')],
        { cwd: fixtureRoot, encoding: 'utf8', timeout: 10_000 },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('pi prompts: wrote 2 file(s)');
      expect(readdirSync(path.join(fixtureRoot, 'pi', 'prompts')).sort()).toEqual(['close.md', 'session.md']);
      expect(readFileSync(path.join(fixtureRoot, 'pi', 'prompts', 'close.md'), 'utf8')).toBe(`---
description: End session with verification, commits, and documentation.
argument-hint: "[--dry-run]"
---

# /close

Use the Session Orchestrator skill definition at \`skills/close/SKILL.md\`.

Arguments: $@

Read that skill file and follow it exactly. When it references \`$ARGUMENTS\`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.
`);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  // HIGH-2 (2026-09-17): private `isUserInvocable` copies disagreed on the
  // spelling of `true` — this generator wrote a wrapper the shared counter did
  // not count and `generate-codex-skills` threw on. Every form a YAML parser
  // reads as `true` must yield the identical wrapper set.
  //
  // Only the shapes that BITE are parameterised. `"true"` / `'true'` were
  // dropped (MED-3, 2026-09-17): `parseFrontmatter` strips one layer of
  // surrounding quotes BEFORE the predicate sees the value, so both pass even
  // with the private bare-`true` predicate restored — a row that is green in
  // both directions proves nothing. `True` and `true # …` reach the predicate
  // verbatim; the BOM and CRLF rows bite one layer earlier, in the local
  // frontmatter parser, whose `startsWith('---\n')` / `indexOf('\n---\n')`
  // probes both missed the block and silently dropped every flag in it.
  it.each([
    ['True', (v) => `---\nname: close\ndescription: Close it.\nuser-invocable: ${v === 'bare' ? 'true' : 'True'}\n---\n# Body\n`],
    ['true # a slash command', (v) => `---\nname: close\ndescription: Close it.\nuser-invocable: true${v === 'bare' ? '' : ' # a slash command'}\n---\n# Body\n`],
    ['a leading UTF-8 BOM', (v) => `${v === 'bare' ? '' : BOM}---\nname: close\ndescription: Close it.\nuser-invocable: true\n---\n# Body\n`],
    ['CRLF line endings', (v) => {
      const text = '---\nname: close\ndescription: Close it.\nuser-invocable: true\n---\n# Body\n';
      return v === 'bare' ? text : text.replace(/\n/g, '\r\n');
    }],
  ])('emits the same wrapper set for %s as for a bare LF true', (_label, render) => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'generate-pi-prompts-shape-'));
    try {
      mkdirSync(path.join(fixtureRoot, 'commands'), { recursive: true });
      mkdirSync(path.join(fixtureRoot, 'skills', 'close'), { recursive: true });
      mkdirSync(path.join(fixtureRoot, 'pi', 'prompts'), { recursive: true });
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
        return Object.fromEntries(
          readdirSync(path.join(fixtureRoot, 'pi', 'prompts')).sort().map((name) => [
            name,
            readFileSync(path.join(fixtureRoot, 'pi', 'prompts', name), 'utf8'),
          ]),
        );
      };

      const bare = generate('bare');
      expect(Object.keys(bare)).toEqual(['close.md', 'session.md']);
      expect(generate('variant')).toEqual(bare);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('fails loudly when one public name is claimed by both commands/ and a user-invocable skill', () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'generate-pi-prompts-collision-'));

    try {
      mkdirSync(path.join(fixtureRoot, 'scripts'), { recursive: true });
      mkdirSync(path.join(fixtureRoot, 'commands'), { recursive: true });
      mkdirSync(path.join(fixtureRoot, 'skills', 'close'), { recursive: true });
      mkdirSync(path.join(fixtureRoot, 'pi', 'prompts'), { recursive: true });
      installGenerator(fixtureRoot);
      writeFileSync(path.join(fixtureRoot, 'commands', 'close.md'), '---\ndescription: Command copy\n---\n# Body\n');
      writeFileSync(
        path.join(fixtureRoot, 'skills', 'close', 'SKILL.md'),
        '---\nname: close\ndescription: Skill copy\nuser-invocable: true\n---\n# Body\n',
      );

      const result = spawnSync(
        process.execPath,
        [path.join(fixtureRoot, 'scripts', 'generate-pi-prompts.mjs'), '--check'],
        { cwd: fixtureRoot, encoding: 'utf8', timeout: 10_000 },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('claimed by BOTH commands/ and a user-invocable skill: close');
      // A conflict must abort BEFORE any write, not resolve by precedence.
      expect(readdirSync(path.join(fixtureRoot, 'pi', 'prompts'))).toEqual([]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
