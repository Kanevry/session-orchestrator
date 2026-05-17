/**
 * tests/commands/disable-model-invocation.test.mjs
 *
 * Tests for the disable-model-invocation frontmatter flag (#430).
 *
 * USER-ONLY commands: commands that run coordinator logic directly without
 * invoking a model (disable-model-invocation: true required).
 * MODEL-INVOCABLE commands: commands that invoke a skill/model and must NOT
 * carry the flag.
 *
 * Floor/ceiling pattern used for total command count per test-quality.md
 * (Dynamic Artifact Counts — Floor/Ceiling Carve-Out). The command catalog
 * grows over time; exact-count pins drift on every addition.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '../..');
const COMMANDS_DIR = path.join(PLUGIN_ROOT, 'commands');

function getFrontmatter(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  return match ? match[1] : '';
}

describe('disable-model-invocation (#430)', () => {
  const commandFiles = readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.md'));

  it('total command count is in expected range (floor/ceiling)', () => {
    expect(commandFiles.length).toBeGreaterThanOrEqual(10);
    expect(commandFiles.length).toBeLessThanOrEqual(40);
  });

  const userOnlyCommands = [
    'bootstrap', 'brainstorm', 'close', 'discovery', 'evolve', 'go',
    'harness-audit', 'memory-cleanup', 'plan', 'repo-audit', 'session', 'test',
  ];

  userOnlyCommands.forEach((cmd) => {
    it(`USER-ONLY command "${cmd}" has disable-model-invocation: true`, () => {
      const fm = getFrontmatter(path.join(COMMANDS_DIR, `${cmd}.md`));
      expect(fm).toMatch(/^disable-model-invocation:\s*true$/m);
    });
  });

  const modelInvocableCommands = ['autopilot', 'autopilot-multi', 'debug', 'portfolio'];

  modelInvocableCommands.forEach((cmd) => {
    it(`MODEL-INVOCABLE command "${cmd}" does NOT have disable-model-invocation: true`, () => {
      const filePath = path.join(COMMANDS_DIR, `${cmd}.md`);
      const fm = getFrontmatter(filePath);
      expect(fm).not.toMatch(/^disable-model-invocation:\s*true$/m);
    });
  });

  it('total commands with disable-model-invocation: true matches USER-ONLY count', () => {
    const count = commandFiles.reduce((acc, f) => {
      const fm = getFrontmatter(path.join(COMMANDS_DIR, f));
      return acc + (/^disable-model-invocation:\s*true$/m.test(fm) ? 1 : 0);
    }, 0);
    expect(count).toBe(userOnlyCommands.length);
  });
});
