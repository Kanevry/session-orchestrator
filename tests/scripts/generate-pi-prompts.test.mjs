/**
 * tests/scripts/generate-pi-prompts.test.mjs
 *
 * Drift check for generated Pi prompt wrappers.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
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
