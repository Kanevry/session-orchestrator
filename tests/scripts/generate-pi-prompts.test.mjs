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

describe('generate-pi-prompts.mjs', () => {
  it('reports generated Pi prompts are up to date', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--check'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 10_000,
    });

    // Drift-proof: tie the expected count to the actual number of command files
    // rather than a hard-pinned literal (testing.md § Dynamic Artifact Counts —
    // Floor/Ceiling Carve-Out). The count grows whenever a command is added.
    const commandCount = readdirSync(path.join(REPO_ROOT, 'commands')).filter((name) => name.endsWith('.md')).length;
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`pi prompts: ${commandCount} file(s) up to date`);
  });

  it('regenerates stale Pi prompt content from the command source', () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'generate-pi-prompts-'));

    try {
      mkdirSync(path.join(fixtureRoot, 'scripts'), { recursive: true });
      mkdirSync(path.join(fixtureRoot, 'commands'), { recursive: true });
      mkdirSync(path.join(fixtureRoot, 'pi', 'prompts'), { recursive: true });
      copyFileSync(SCRIPT, path.join(fixtureRoot, 'scripts', 'generate-pi-prompts.mjs'));
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

  it('generates one Pi prompt per command file', () => {
    const commands = readdirSync(path.join(REPO_ROOT, 'commands')).filter((name) => name.endsWith('.md'));
    const prompts = readdirSync(path.join(REPO_ROOT, 'pi', 'prompts')).filter((name) => name.endsWith('.md'));

    expect(prompts.sort()).toEqual(commands.sort());
  });

  it('documents the $ARGUMENTS to $@ substitution contract', () => {
    const sessionPrompt = readFileSync(path.join(REPO_ROOT, 'pi', 'prompts', 'session.md'), 'utf8');

    expect(sessionPrompt).toContain('Arguments: $@');
    expect(sessionPrompt).toContain('When it references `$ARGUMENTS`');
  });
});
