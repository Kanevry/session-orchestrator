/**
 * The ONE `user-invocable` normaliser (HIGH-2 / MED-3 / MED-4, 2026-09-17).
 *
 * Bugs pinned here, each one measured before the fix:
 *  - HIGH-2: `user-invocable: "true"` was NOT a slash command for this module
 *    (count 28) while the Cursor and Pi generators emitted a wrapper for it (29)
 *    and `generate-codex-skills` threw. One value, four verdicts.
 *  - MED-3: `metadata:\n  user-invocable: true` was HOISTED to top level by
 *    `parseAgentFrontmatter`, so this module counted a skill no generator did.
 *  - MED-4: `True`, `yes`, `true # note`, a BOM — every one silently `false`
 *    with no diagnostic anywhere.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isUserInvocableValue,
  parseSkillFrontmatter,
  slashCommandNames,
  userInvocableSkills,
} from '../../scripts/lib/user-invocable-skills.mjs';

// U+FEFF written as an escape, never a literal: a literal BOM in a tracked
// file is a `dangerous-invisible` validate-plugin failure (check-unicode-safety).
const BOM = String.fromCharCode(0xfeff);

/** @param {string} value raw frontmatter text after `user-invocable:` */
function skillDoc(value, { key = 'user-invocable', bom = false, nested = false } = {}) {
  const flag = nested ? `metadata:\n  ${key}: ${value}` : `${key}: ${value}`;
  return `${bom ? BOM : ''}---\nname: probe\ndescription: A probe skill.\n${flag}\n---\n\n# Body\n`;
}

describe('isUserInvocableValue — the single normaliser', () => {
  /** @type {import('vitest').MockInstance} */
  let stderr;
  beforeEach(() => {
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    stderr.mockRestore();
  });

  const cases = [
    { label: 'boolean true', value: true, expected: true, warns: false },
    { label: 'bare true', value: 'true', expected: true, warns: false },
    { label: 'double-quoted "true"', value: '"true"', expected: true, warns: false },
    { label: "single-quoted 'true'", value: "'true'", expected: true, warns: false },
    { label: 'cased True', value: 'True', expected: true, warns: false },
    { label: 'trailing comment', value: 'true # slash command', expected: true, warns: false },
    { label: 'trailing whitespace', value: 'true   ', expected: true, warns: false },
    { label: 'boolean false', value: false, expected: false, warns: false },
    { label: 'bare false', value: 'false', expected: false, warns: false },
    { label: 'absent', value: undefined, expected: false, warns: false },
    // YAML 1.1 booleans — plain strings under YAML 1.2 / js-yaml CORE_SCHEMA,
    // so rejected; the demotion is the surprising half, hence the WARN.
    { label: 'yes', value: 'yes', expected: false, warns: true },
    { label: 'on', value: 'on', expected: false, warns: true },
    { label: '1', value: '1', expected: false, warns: true },
    { label: 'quoted "yes"', value: '"yes"', expected: false, warns: true },
    { label: 'unrelated string', value: 'maybe', expected: false, warns: false },
  ];

  it.each(cases)('$label → $expected', ({ value, expected, warns }) => {
    expect(isUserInvocableValue(value, 'skills/probe/SKILL.md')).toBe(expected);
    // QA-LOW-2: count only WARN-tagged lines (like the sibling MED-4 test
    // below), not every stderr write — a raw call count would mis-measure if
    // an unrelated stderr write ever landed alongside the warning.
    const warned = stderr.mock.calls.map((c) => String(c[0])).filter((line) => line.includes('WARN'));
    expect(warned.length).toBe(warns ? 1 : 0);
    if (warns) {
      expect(warned[0]).toContain('skills/probe/SKILL.md');
      expect(warned[0]).toContain('user-invocable');
    }
  });

  it('a `#` inside quotes is content, not a comment', () => {
    expect(isUserInvocableValue('"true # not a comment"')).toBe(false);
  });

  it('is callable with one argument (existing consumers)', () => {
    expect(isUserInvocableValue('true')).toBe(true);
  });

  // BUG this catches (#1384 P1, measured 2026-09-18): the WARN named
  // `user-invocable` unconditionally, while the Cursor adapter judges the
  // SIBLING key `disable-model-invocation` with the same predicate. A
  // `disable-model-invocation: yes` demotion therefore told the operator to fix
  // `user-invocable:` — a line that does not exist in that file. Red before the
  // third parameter: the WARN carried the wrong key name.
  it('names the KEY it was asked about, not always `user-invocable`', () => {
    expect(isUserInvocableValue('yes', 'skills/probe/SKILL.md', 'disable-model-invocation'))
      .toBe(false);
    const warned = stderr.mock.calls.map((c) => String(c[0])).filter((line) => line.includes('WARN'));
    expect(warned.length).toBe(1);
    expect(warned[0]).toContain('disable-model-invocation: "yes"');
    expect(warned[0]).toContain('Write `disable-model-invocation: true`');
    expect(warned[0]).not.toContain('user-invocable:');
  });
});

describe('userInvocableSkills / slashCommandNames over a temp tree', () => {
  /** @type {string} */
  let root;
  /** @type {import('vitest').MockInstance} */
  let stderr;

  beforeEach(() => {
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    root = mkdtempSync(path.join(tmpdir(), 'so-uis-'));
    mkdirSync(path.join(root, 'skills'), { recursive: true });
    mkdirSync(path.join(root, 'commands'), { recursive: true });
    writeFileSync(path.join(root, 'commands', 'session.md'), '---\ndescription: x\n---\n');
    const write = (name, content) => {
      mkdirSync(path.join(root, 'skills', name), { recursive: true });
      writeFileSync(path.join(root, 'skills', name, 'SKILL.md'), content);
    };
    write('bare', skillDoc('true'));
    write('quoted', skillDoc('"true"'));
    write('single-quoted', skillDoc("'true'"));
    write('cased', skillDoc('True'));
    write('commented', skillDoc('true # a slash command'));
    write('bom', skillDoc('true', { bom: true }));
    write('nested', skillDoc('true', { nested: true }));
    write('lookalike', skillDoc('yes'));
    write('library', skillDoc('false'));
  });

  afterEach(() => {
    stderr.mockRestore();
    rmSync(root, { recursive: true, force: true });
  });

  it('counts every shape a YAML parser reads as true, and nothing else (HIGH-2, MED-4)', () => {
    expect(userInvocableSkills(root)).toEqual([
      'bare',
      'bom',
      'cased',
      'commented',
      'quoted',
      'single-quoted',
    ]);
  });

  it('does NOT hoist a flag nested under `metadata:` (MED-3)', () => {
    expect(userInvocableSkills(root)).not.toContain('nested');
    const doc = readFileSync(path.join(root, 'skills', 'nested', 'SKILL.md'), 'utf8');
    expect(parseSkillFrontmatter(doc)?.['user-invocable']).toBeUndefined();
  });

  it('warns rather than silently demoting a truthy lookalike (MED-4)', () => {
    userInvocableSkills(root);
    const warned = stderr.mock.calls.map((c) => String(c[0])).filter((line) => line.includes('WARN'));
    expect(warned.length).toBe(1);
    expect(warned[0]).toContain('lookalike');
  });

  it('unions commands/ with user-invocable skills, deduplicated', () => {
    expect(slashCommandNames(root)).toEqual([
      'bare',
      'bom',
      'cased',
      'commented',
      'quoted',
      'session',
      'single-quoted',
    ]);
  });
});
