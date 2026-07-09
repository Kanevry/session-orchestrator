import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..', '..');

function parseFrontmatter(absPath) {
  const raw = readFileSync(absPath, 'utf8');
  const match = raw.match(/^---\r?\n([\s\S]+?)\r?\n---\r?\n/);
  if (!match) throw new Error(`No frontmatter in ${absPath}`);
  return yaml.load(match[1]);
}

function stripFrontmatter(absPath) {
  const raw = readFileSync(absPath, 'utf8');
  return raw.replace(/^---\r?\n[\s\S]+?\r?\n---\r?\n/, '');
}

const SKILL_PATH = path.join(repoRoot, 'skills/grill/SKILL.md');
const SOUL_PATH = path.join(repoRoot, 'skills/grill/soul.md');
const COMMAND_PATH = path.join(repoRoot, 'commands/grill.md');

describe('Grill skill', () => {
  describe('file existence', () => {
    it('SKILL.md exists at skills/grill/SKILL.md', () => {
      expect(existsSync(SKILL_PATH)).toBe(true);
    });

    it('soul.md exists at skills/grill/soul.md', () => {
      expect(existsSync(SOUL_PATH)).toBe(true);
    });

    it('commands/grill.md exists', () => {
      expect(existsSync(COMMAND_PATH)).toBe(true);
    });
  });

  describe('soul.md content', () => {
    it('soul.md is non-empty (>200 bytes)', () => {
      const stats = readFileSync(SOUL_PATH);
      expect(stats.length).toBeGreaterThan(200);
    });

    it('soul.md documents all Six Tactics', () => {
      const soul = readFileSync(SOUL_PATH, 'utf8').toLowerCase();
      expect(soul).toContain('glossary conflict');
      expect(soul).toContain('sharpen fuzzy language');
      expect(soul).toContain('code contradiction');
      expect(soul).toContain('edge-case scenario');
      expect(soul).toContain('assumption audit');
      expect(soul).toContain('pre-mortem');
    });
  });

  describe('SKILL.md frontmatter', () => {
    it('frontmatter name field is "grill"', () => {
      const fm = parseFrontmatter(SKILL_PATH);
      expect(fm.name).toBe('grill');
    });

    it('frontmatter description is a string between 50 and 1024 chars', () => {
      const fm = parseFrontmatter(SKILL_PATH);
      expect(typeof fm.description).toBe('string');
      expect(fm.description.length).toBeGreaterThanOrEqual(50);
      expect(fm.description.length).toBeLessThanOrEqual(1024);
    });

    it('frontmatter description contains trigger marker "grill"', () => {
      const fm = parseFrontmatter(SKILL_PATH);
      expect(fm.description.toLowerCase()).toContain('grill');
    });

    it('skill does NOT carry disable-model-invocation (it is model-invocable)', () => {
      const fm = parseFrontmatter(SKILL_PATH);
      expect(fm['disable-model-invocation']).toBeUndefined();
    });
  });

  describe('SKILL.md body — required section headers', () => {
    const required = [
      '## Soul Reference',
      '## Phase 0',
      '## Phase 1',
      '## Phase 2',
      '## Phase 4',
      '## Anti-Patterns',
      '## See Also',
    ];
    for (const header of required) {
      it(`body contains ${header}`, () => {
        const body = stripFrontmatter(SKILL_PATH);
        expect(body).toContain(header);
      });
    }
  });

  describe('SKILL.md body — grill substance', () => {
    it('body drives the one-question-at-a-time discipline', () => {
      const body = stripFrontmatter(SKILL_PATH).toLowerCase();
      expect(body).toContain('one question at a time');
    });

    it('body references contradictions and assumptions as core output', () => {
      const body = stripFrontmatter(SKILL_PATH).toLowerCase();
      expect(body).toContain('contradiction');
      expect(body).toContain('assumption');
      expect(body).toContain('edge-case');
    });

    it('body has no HARD-GATE (composable thinking tool)', () => {
      const body = stripFrontmatter(SKILL_PATH);
      expect(body).toContain('No HARD-GATE');
    });
  });

  describe('SKILL.md body — output contract', () => {
    it('body mentions the optional grill-summary path under docs/specs/', () => {
      const body = stripFrontmatter(SKILL_PATH);
      expect(body).toContain('docs/specs/');
      expect(body).toContain('-grill.md');
    });
  });

  describe('commands/grill.md — registration', () => {
    it('command body references skills/grill/SKILL.md', () => {
      const raw = readFileSync(COMMAND_PATH, 'utf8');
      expect(raw).toContain('skills/grill/SKILL.md');
    });

    it('command does NOT carry disable-model-invocation: true', () => {
      const raw = readFileSync(COMMAND_PATH, 'utf8');
      const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1];
      expect(fm).not.toMatch(/^disable-model-invocation:\s*true$/m);
    });
  });
});
