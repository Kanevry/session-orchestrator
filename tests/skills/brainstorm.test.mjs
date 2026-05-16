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

const SKILL_PATH = path.join(repoRoot, 'skills/brainstorm/SKILL.md');
const SOUL_PATH = path.join(repoRoot, 'skills/brainstorm/soul.md');
const COMMAND_PATH = path.join(repoRoot, 'commands/brainstorm.md');

const HARD_GATE_PHRASE =
  'Do NOT invoke any implementation skill, write any code, scaffold any project, or take any implementation action until you have presented a design and the user has approved it.';

describe('Brainstorm skill — GH #36', () => {
  describe('file existence', () => {
    it('SKILL.md exists at skills/brainstorm/SKILL.md', () => {
      expect(existsSync(SKILL_PATH)).toBe(true);
    });

    it('soul.md exists at skills/brainstorm/soul.md', () => {
      expect(existsSync(SOUL_PATH)).toBe(true);
    });

    it('commands/brainstorm.md exists', () => {
      expect(existsSync(COMMAND_PATH)).toBe(true);
    });
  });

  describe('soul.md content', () => {
    it('soul.md is non-empty (>200 bytes)', () => {
      const stats = readFileSync(SOUL_PATH);
      expect(stats.length).toBeGreaterThan(200);
    });
  });

  describe('SKILL.md frontmatter', () => {
    it('frontmatter name field is "brainstorm"', () => {
      const fm = parseFrontmatter(SKILL_PATH);
      expect(fm.name).toBe('brainstorm');
    });

    it('frontmatter description is a string between 50 and 1024 chars', () => {
      const fm = parseFrontmatter(SKILL_PATH);
      expect(typeof fm.description).toBe('string');
      expect(fm.description.length).toBeGreaterThanOrEqual(50);
      expect(fm.description.length).toBeLessThanOrEqual(1024);
    });

    it('frontmatter description contains boundary marker "BEFORE /plan feature" (case-insensitive)', () => {
      const fm = parseFrontmatter(SKILL_PATH);
      expect(fm.description.toLowerCase()).toContain('before /plan feature');
    });
  });

  describe('SKILL.md body — required section headers', () => {
    it('body contains ## Phase 0', () => {
      const body = stripFrontmatter(SKILL_PATH);
      expect(body).toContain('## Phase 0');
    });

    it('body contains ## Phase 1', () => {
      const body = stripFrontmatter(SKILL_PATH);
      expect(body).toContain('## Phase 1');
    });

    it('body contains ## Phase 2', () => {
      const body = stripFrontmatter(SKILL_PATH);
      expect(body).toContain('## Phase 2');
    });

    it('body contains ## Phase 5', () => {
      const body = stripFrontmatter(SKILL_PATH);
      expect(body).toContain('## Phase 5');
    });

    it('body contains ## Phase 6', () => {
      const body = stripFrontmatter(SKILL_PATH);
      expect(body).toContain('## Phase 6');
    });

    it('body contains ## Anti-Patterns', () => {
      const body = stripFrontmatter(SKILL_PATH);
      expect(body).toContain('## Anti-Patterns');
    });

    it('body contains ## See Also', () => {
      const body = stripFrontmatter(SKILL_PATH);
      expect(body).toContain('## See Also');
    });
  });

  describe('SKILL.md body — HARD-GATE contract', () => {
    it('full raw file contains the verbatim HARD-GATE phrase', () => {
      const raw = readFileSync(SKILL_PATH, 'utf8');
      expect(raw).toContain(HARD_GATE_PHRASE);
    });

    it('body-only (after stripping frontmatter) also contains the verbatim HARD-GATE phrase', () => {
      const body = stripFrontmatter(SKILL_PATH);
      expect(body).toContain(HARD_GATE_PHRASE);
    });
  });

  describe('SKILL.md body — output path contract', () => {
    it('body mentions docs/specs/ as the spec output directory', () => {
      const body = stripFrontmatter(SKILL_PATH);
      expect(body).toContain('docs/specs/');
    });
  });

  describe('commands/brainstorm.md — skill reference', () => {
    it('commands/brainstorm.md body references skills/brainstorm/SKILL.md', () => {
      const raw = readFileSync(COMMAND_PATH, 'utf8');
      expect(raw).toContain('skills/brainstorm/SKILL.md');
    });
  });
});
