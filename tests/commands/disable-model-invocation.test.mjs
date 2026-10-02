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
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { slashCommandNames } from '../../scripts/lib/user-invocable-skills.mjs';

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '../..');

// Since the 2026-09-16 command→skill fold a slash command is EITHER a
// `commands/<name>.md` file OR a `skills/<name>/SKILL.md` with explicit
// `user-invocable: true`; the flag lives in whichever file defines the name.
function commandDefinition(name) {
  const command = path.join(PLUGIN_ROOT, 'commands', `${name}.md`);
  return existsSync(command) ? command : path.join(PLUGIN_ROOT, 'skills', name, 'SKILL.md');
}

function getFrontmatter(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  return match ? match[1] : '';
}

describe('disable-model-invocation (#430)', () => {
  const commandFiles = slashCommandNames(PLUGIN_ROOT);

  it('total command count is in expected range (floor/ceiling)', () => {
    expect(commandFiles.length).toBeGreaterThanOrEqual(10);
    expect(commandFiles.length).toBeLessThanOrEqual(40);
  });

  // USER-ONLY: commands with irreversible side-effects (commits, scaffolding,
  // wave-state mutation) or ceremonial entry-points that must not be invoked
  // by a model autonomously. Narrowed from 12 → 6 on 2026-05-19 after
  // pushback that the original blanket policy was too aggressive (#430 partial
  // reversal). Read-only/analytical commands moved to model-invocable.
  // 2026-05-21: `session` moved to MODEL-INVOCABLE — it is read-only/analytical
  // (project-state research, no writes). The flag was blocking model dispatch
  // when users described session-start in prose rather than typing `/session`.
  const userOnlyCommands = [
    'bootstrap', 'brainstorm', 'close', 'go', 'plan', 'release',
  ];

  userOnlyCommands.forEach((cmd) => {
    it(`USER-ONLY command "${cmd}" has disable-model-invocation: true`, () => {
      const fm = getFrontmatter(commandDefinition(cmd));
      expect(fm).toMatch(/^disable-model-invocation:\s*true$/m);
    });
  });

  // MODEL-INVOCABLE: read-only probes, analytical commands, and orchestrators
  // that the model may legitimately invoke when context warrants it.
  //
  // ENUMERATED from commands/*.md, not hardcoded (2026-09-06). The previous
  // curated 12-name list broke with ENOENT the moment `autopilot-multi.md` was
  // deleted — a maintenance drift class, not a caught bug. Enumeration is
  // strictly stronger: it covers EVERY command outside the USER-ONLY list
  // (currently more than the 12 that were named), so a newly added command that
  // wrongly ships the flag fails here by name instead of only shifting the
  // aggregate count below, and a deleted command needs no test edit.
  const modelInvocableCommands = commandFiles.filter((cmd) => !userOnlyCommands.includes(cmd));

  it('every command outside the USER-ONLY list is enumerated (no empty sweep)', () => {
    expect(modelInvocableCommands.length).toBeGreaterThanOrEqual(10);
  });

  it('total commands with disable-model-invocation: true matches USER-ONLY count', () => {
    const count = commandFiles.reduce((acc, cmd) => {
      const fm = getFrontmatter(commandDefinition(cmd));
      return acc + (/^disable-model-invocation:\s*true$/m.test(fm) ? 1 : 0);
    }, 0);
    expect(count).toBe(userOnlyCommands.length);
  });
});
