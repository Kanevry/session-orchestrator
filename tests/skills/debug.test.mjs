import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..', '..');

function parseFrontmatter(absPath) {
  const raw = readFileSync(absPath, 'utf8');
  const match = raw.match(/^---\r?\n([\s\S]+?)\r?\n---\r?\n/);
  if (!match) throw new Error(`No frontmatter in ${absPath}`);
  // js-yaml cannot handle description values containing `: ` mid-line without quoting.
  // Use a targeted regex extraction for the `name` and `description` fields, then fall
  // back to yaml.load for the remaining simple scalar fields.
  const block = match[1];
  const nameMatch = block.match(/^name:\s*(.+)$/m);
  const descMatch = block.match(/^description:\s*(.+)$/m);
  return {
    name: nameMatch ? nameMatch[1].trim() : undefined,
    description: descMatch ? descMatch[1].trim() : undefined,
  };
}

function stripFrontmatter(absPath) {
  const raw = readFileSync(absPath, 'utf8');
  return raw.replace(/^---\r?\n[\s\S]+?\r?\n---\r?\n/, '');
}

const SKILL_PATH = path.join(repoRoot, 'skills/debug/SKILL.md');
const SOUL_PATH = path.join(repoRoot, 'skills/debug/soul.md');
const COMMAND_PATH = path.join(repoRoot, 'commands/debug.md');

const IRON_LAW_PHRASE = 'NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST';

describe('Debug skill — GH #37', () => {
  describe('file existence', () => {
    it('SKILL.md exists at skills/debug/SKILL.md', () => {
      expect(existsSync(SKILL_PATH)).toBe(true);
    });

    it('soul.md exists at skills/debug/soul.md', () => {
      expect(existsSync(SOUL_PATH)).toBe(true);
    });

    it('commands/debug.md exists', () => {
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
    it('frontmatter name field is "debug"', () => {
      const fm = parseFrontmatter(SKILL_PATH);
      expect(fm.name).toBe('debug');
    });

    it('frontmatter description is a string between 50 and 1024 chars', () => {
      const fm = parseFrontmatter(SKILL_PATH);
      expect(typeof fm.description).toBe('string');
      expect(fm.description.length).toBeGreaterThanOrEqual(50);
      expect(fm.description.length).toBeLessThanOrEqual(1024);
    });

    it('frontmatter description contains "Iron Law" (case-insensitive)', () => {
      const fm = parseFrontmatter(SKILL_PATH);
      expect(fm.description.toLowerCase()).toContain('iron law');
    });
  });

  describe('SKILL.md body — 4-phase structure', () => {
    it('body contains ## Phase 1', () => {
      const body = stripFrontmatter(SKILL_PATH);
      expect(body).toContain('## Phase 1');
    });

    it('body contains ## Phase 2', () => {
      const body = stripFrontmatter(SKILL_PATH);
      expect(body).toContain('## Phase 2');
    });

    it('body contains ## Phase 3', () => {
      const body = stripFrontmatter(SKILL_PATH);
      expect(body).toContain('## Phase 3');
    });

    it('body contains ## Phase 4', () => {
      const body = stripFrontmatter(SKILL_PATH);
      expect(body).toContain('## Phase 4');
    });
  });

  describe('SKILL.md body — Iron Law contract', () => {
    it('full raw file contains the verbatim Iron Law phrase at least once', () => {
      const raw = readFileSync(SKILL_PATH, 'utf8');
      expect(raw).toContain(IRON_LAW_PHRASE);
    });

    it('body-only (after stripping frontmatter) contains the verbatim Iron Law phrase', () => {
      const body = stripFrontmatter(SKILL_PATH);
      expect(body).toContain(IRON_LAW_PHRASE);
    });
  });

  describe('SKILL.md body — artifact path contract', () => {
    it('body mentions .orchestrator/debug/ as the artifact directory', () => {
      const body = stripFrontmatter(SKILL_PATH);
      expect(body).toContain('.orchestrator/debug/');
    });

    it('body contains the substring "Phase 1 artifact" (artifact contract section named correctly)', () => {
      const body = stripFrontmatter(SKILL_PATH);
      expect(body).toContain('Phase 1 artifact');
    });
  });

  describe('commands/debug.md — skill reference', () => {
    it('commands/debug.md body references skills/debug/SKILL.md', () => {
      const raw = readFileSync(COMMAND_PATH, 'utf8');
      expect(raw).toContain('skills/debug/SKILL.md');
    });
  });
});
