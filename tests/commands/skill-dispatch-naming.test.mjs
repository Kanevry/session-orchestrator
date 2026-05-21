/**
 * tests/commands/skill-dispatch-naming.test.mjs
 *
 * Lint: every Skill dispatch reference in a command body must point to a real
 * skill under skills/<name>/SKILL.md. Catches the command-vs-skill name
 * confusion class (2026-05-21): AI tried Skill(session-orchestrator:session)
 * because the command body said "Invoke the session-start skill" — prose was
 * ambiguous and the AI grabbed the command name instead.
 *
 * Detected dispatch patterns (in body, after frontmatter):
 *   1. `session-orchestrator:<name>` (explicit, preferred)
 *   2. "Invoke the <name> skill" / "invoke the <name> skill" (prose form)
 *
 * Skills referenced this way must exist AND must not block model invocation
 * via `disable-model-invocation: true` in their own frontmatter (the flag
 * lives on commands, not skills, but we check both for completeness).
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '../..');
const COMMANDS_DIR = path.join(PLUGIN_ROOT, 'commands');
const SKILLS_DIR = path.join(PLUGIN_ROOT, 'skills');

function splitFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: '', body: content };
  return { frontmatter: match[1], body: match[2] };
}

function extractSkillRefs(body) {
  const refs = new Set();

  for (const m of body.matchAll(/session-orchestrator:([a-z][a-z0-9-]*)/g)) {
    refs.add(m[1]);
  }

  for (const m of body.matchAll(/[Ii]nvoke (?:the |`)([a-z][a-z0-9-]*)(?:` skill| skill)/g)) {
    refs.add(m[1]);
  }

  return [...refs];
}

function skillExists(name) {
  return existsSync(path.join(SKILLS_DIR, name, 'SKILL.md'));
}

function commandExists(name) {
  return existsSync(path.join(COMMANDS_DIR, `${name}.md`));
}

describe('skill-dispatch naming lint', () => {
  const commandFiles = readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.md'));

  for (const file of commandFiles) {
    const commandName = file.replace(/\.md$/, '');
    const content = readFileSync(path.join(COMMANDS_DIR, file), 'utf8');
    const { body } = splitFrontmatter(content);
    const refs = extractSkillRefs(body);

    if (refs.length === 0) continue;

    for (const ref of refs) {
      if (ref === commandName) continue;

      it(`command "${commandName}" references "${ref}" — must resolve to a real skill`, () => {
        const exists = skillExists(ref) || commandExists(ref);
        expect(exists, `Referenced "${ref}" but neither skills/${ref}/SKILL.md nor commands/${ref}.md exists`).toBe(true);
      });

      if (skillExists(ref)) {
        it(`command "${commandName}" → skill "${ref}" must not block model dispatch`, () => {
          const skillContent = readFileSync(path.join(SKILLS_DIR, ref, 'SKILL.md'), 'utf8');
          const { frontmatter } = splitFrontmatter(skillContent);
          expect(frontmatter).not.toMatch(/^disable-model-invocation:\s*true$/m);
        });
      }
    }
  }
});
