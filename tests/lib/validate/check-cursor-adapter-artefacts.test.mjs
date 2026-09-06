/**
 * tests/lib/validate/check-cursor-adapter-artefacts.test.mjs
 *
 * THE BUG (2026-09-06, measured @ HEAD before this fix):
 *   `scripts/generate-cursor-adapter.mjs` routed `description` through
 *   `yamlQuote()` but emitted `argument-hint` RAW. The canonical authored form
 *   is a bare bracket list (`[--headless] [--verbose]`), which YAML reads as a
 *   flow sequence — GH#54, the defect that made Copilot CLI >= 1.0.65 silently
 *   drop the affected files. Census at HEAD:
 *     rg -l 'argument-hint: \[' .cursor/commands/ | wc -l  ->  24
 *     rg -l 'argument-hint: "' .cursor/commands/ | wc -l   ->   0
 *     commands/ (the source, fixed by 93b40dd / v3.16.0)   ->  24 quoted, 0 bare
 *   i.e. the fix in `commands/` was undone in the Cursor mirror on EVERY
 *   generation, and 22 of those files did not even parse as YAML.
 *
 * WHY THE EXISTING GUARD COULD NOT SEE IT:
 *   `check-cursor-adapter.mjs` Check 1 ran the generator with `--check`, i.e.
 *   generator output against generator output. That comparison reports "up to
 *   date" for output that is uniformly broken, and a snapshot-style guard would
 *   have frozen the 24 broken files as the expectation.
 *
 * Both cases below run against a SYNTHETIC fixture, never against the live
 * repo — a test that measures the live corpus pins its defect state and
 * punishes the repair (see .claude/rules/anti-pattern-ein-test-der-gegen-das-
 * lebende-repo-misst-...).
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateCursorArtefacts } from '../../../scripts/lib/validate/check-cursor-adapter.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const GENERATOR = path.join(REPO_ROOT, 'scripts', 'generate-cursor-adapter.mjs');

/** @returns {string} a fresh fixture root the caller must rm afterwards */
function makeFixture() {
  return mkdtempSync(path.join(tmpdir(), 'cursor-artefacts-'));
}

describe('validateCursorArtefacts — generated-artefact frontmatter spec', () => {
  it('reports the GH#54 array-shaped argument-hint the generator re-introduced in 24 of 28 Cursor command wrappers', () => {
    const root = makeFixture();
    try {
      mkdirSync(path.join(root, '.cursor', 'commands'), { recursive: true });
      // Byte-for-byte the shape HEAD's generator emitted for commands/autopilot.md.
      writeFileSync(
        path.join(root, '.cursor', 'commands', 'autopilot.md'),
        '---\ndescription: Autonomous loop\nargument-hint: [--headless] [--verbose]\n---\n\n# /autopilot\n',
      );

      const { files, violations } = validateCursorArtefacts(root);

      expect(files).toBe(1);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain('.cursor/commands/autopilot.md:');
      expect(violations[0]).toMatch(/argument-hint must be a string|not parseable YAML/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('passes artefacts the FIXED generator produces from a bracket-shaped source argument-hint', () => {
    const root = makeFixture();
    try {
      mkdirSync(path.join(root, 'scripts'), { recursive: true });
      mkdirSync(path.join(root, 'commands'), { recursive: true });
      mkdirSync(path.join(root, 'skills', 'session-start'), { recursive: true });
      copyFileSync(GENERATOR, path.join(root, 'scripts', 'generate-cursor-adapter.mjs'));
      writeFileSync(
        path.join(root, 'commands', 'autopilot.md'),
        '---\ndescription: Autonomous loop — kill-switches (Phase C-1.b)\nargument-hint: "[--headless] [--verbose] [--max-sessions=N]"\n---\n# body\n',
      );
      writeFileSync(
        path.join(root, 'skills', 'session-start', 'SKILL.md'),
        '---\nname: session-start\ndescription: Start a session; analyse git state.\nuser-invocable: true\n---\n# body\n',
      );

      const gen = spawnSync(process.execPath, [path.join(root, 'scripts', 'generate-cursor-adapter.mjs')], {
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(gen.status).toBe(0);

      const { files, violations } = validateCursorArtefacts(root);

      expect(violations).toEqual([]);
      expect(files).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a skill wrapper whose description exceeds the 1024-char agentskills.io limit', () => {
    const root = makeFixture();
    try {
      mkdirSync(path.join(root, '.cursor', 'skills', 'huge'), { recursive: true });
      writeFileSync(
        path.join(root, '.cursor', 'skills', 'huge', 'SKILL.md'),
        `---\nname: huge\ndescription: ${'x'.repeat(1025)}\n---\n# body\n`,
      );

      const { violations } = validateCursorArtefacts(root);

      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain('1025 chars');
      expect(violations[0]).toContain('1024');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a skill wrapper missing a name, and reports the file it came from', () => {
    const root = makeFixture();
    try {
      mkdirSync(path.join(root, '.cursor', 'skills', 'nameless'), { recursive: true });
      writeFileSync(
        path.join(root, '.cursor', 'skills', 'nameless', 'SKILL.md'),
        '---\ndescription: A skill with no name key.\n---\n# body\n',
      );

      const { violations } = validateCursorArtefacts(root);

      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain(path.join('.cursor', 'skills', 'nameless', 'SKILL.md'));
      expect(violations[0]).toContain('name must be a non-empty string');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not run the CLI (and does not exit) when the module is merely imported', () => {
    // The module is already imported at the top of this file. Reaching this
    // assertion at all is the proof: before the direct-invocation guard, the
    // top-level CLI body ran on import and called process.exit().
    expect(typeof validateCursorArtefacts).toBe('function');
  });
});
