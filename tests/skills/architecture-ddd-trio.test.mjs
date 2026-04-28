import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..', '..');

const UPSTREAM_SHA = 'mattpocock/skills@90ea8ee';

// SHA-256 of the byte-identical sub-files vendored from
// mattpocock/skills@90ea8eec03d4ae8f43427aaf6fe4722653561a42 — Epic #309.
// Re-running `shasum -a 256` against /tmp/mattpocock-skills/<src> at that SHA
// reproduces these. If a vendor refresh is intentional, update both the file
// AND the hash below in the same commit.
const PINNED_HASHES = {
  'skills/architecture/LANGUAGE.md':
    '6feca2140439c54a774749e8367f18350899ff69c777144ed2248cd4407949fa',
  'skills/architecture/DEEPENING.md':
    '9577485f4fc32c0267639a9151bb41c8af0f8f6086e4bf8b84d5b236e30604e9',
  'skills/architecture/INTERFACE-DESIGN.md':
    '678c3e34f1339015053212b3316bf0b676c70aa251050a0613667d4e755fb35e',
  'skills/domain-model/CONTEXT-FORMAT.md':
    '8f6baaa3b1c91644bd7c600196b1aee781d5f525c7c345db8cdfbfb368329a05',
  'skills/domain-model/ADR-FORMAT.md':
    'f1f36cd3f8d3b6474ddd5855da4e233bfc4ae1a1c5024909ccf11871819a41b2',
};

function sha256(absPath) {
  return createHash('sha256').update(readFileSync(absPath)).digest('hex');
}

function parseFrontmatter(absPath) {
  const raw = readFileSync(absPath, 'utf8');
  const match = raw.match(/^---\r?\n([\s\S]+?)\r?\n---\r?\n/);
  if (!match) throw new Error(`No frontmatter in ${absPath}`);
  return yaml.load(match[1]);
}

describe('Architecture-DDD-Trio adoption — Epic #309 (#310/#311/#312)', () => {
  describe('S2/S4 byte-equality of vendored sub-files (mattpocock@90ea8ee)', () => {
    for (const [relPath, expectedHash] of Object.entries(PINNED_HASHES)) {
      it(`${relPath} matches pinned SHA-256 from ${UPSTREAM_SHA}`, () => {
        const abs = path.join(repoRoot, relPath);
        expect(existsSync(abs), `${relPath} must exist`).toBe(true);
        expect(sha256(abs)).toBe(expectedHash);
      });
    }
  });

  describe('S1 architecture skill — frontmatter + structure', () => {
    const skillPath = path.join(repoRoot, 'skills/architecture/SKILL.md');

    it('SKILL.md exists', () => {
      expect(existsSync(skillPath)).toBe(true);
    });

    it('frontmatter declares name, description, attribution, license, upstream-url', () => {
      const fm = parseFrontmatter(skillPath);
      expect(fm.name).toBe('architecture');
      expect(typeof fm.description).toBe('string');
      expect(fm.description.length).toBeGreaterThan(80);
      expect(fm.description.length).toBeLessThanOrEqual(1024);
      expect(fm['derived-from']).toBe('mattpocock/skills@90ea8ee');
      expect(fm.license).toBe('MIT');
      expect(fm['upstream-url']).toMatch(
        /^https:\/\/github\.com\/mattpocock\/skills\/tree\/main\/improve-codebase-architecture$/,
      );
    });

    it('description follows our trigger convention (Use when …)', () => {
      const fm = parseFrontmatter(skillPath);
      expect(fm.description).toMatch(/Use when/);
    });

    it('vendored sub-files LANGUAGE.md and INTERFACE-DESIGN.md are referenced from the body', () => {
      const body = readFileSync(skillPath, 'utf8');
      expect(body).toMatch(/LANGUAGE\.md/);
      expect(body).toMatch(/INTERFACE-DESIGN\.md/);
      expect(body).toMatch(/deepening/i); // DEEPENING.md is bundled but referenced conceptually
    });
  });

  describe('S3 domain-model skill — frontmatter + disable-model-invocation flag', () => {
    const skillPath = path.join(repoRoot, 'skills/domain-model/SKILL.md');

    it('SKILL.md exists', () => {
      expect(existsSync(skillPath)).toBe(true);
    });

    it('frontmatter preserves disable-model-invocation: true and carries attribution', () => {
      const fm = parseFrontmatter(skillPath);
      expect(fm.name).toBe('domain-model');
      expect(fm['disable-model-invocation']).toBe(true);
      expect(fm['derived-from']).toBe('mattpocock/skills@90ea8ee');
      expect(fm.license).toBe('MIT');
      expect(fm['upstream-url']).toMatch(
        /^https:\/\/github\.com\/mattpocock\/skills\/tree\/main\/domain-model$/,
      );
    });

    it('description follows our trigger convention (Use when …)', () => {
      const fm = parseFrontmatter(skillPath);
      expect(typeof fm.description).toBe('string');
      expect(fm.description).toMatch(/Use when/);
      expect(fm.description.length).toBeLessThanOrEqual(1024);
    });

    it('vendored sub-files (CONTEXT-FORMAT/ADR-FORMAT) are referenced from the body', () => {
      const body = readFileSync(skillPath, 'utf8');
      expect(body).toMatch(/CONTEXT-FORMAT\.md|CONTEXT\.md/);
      expect(body).toMatch(/ADR-FORMAT\.md|docs\/adr\//);
    });
  });

  describe('S5 ubiquitous-language skill — frontmatter + disable-model-invocation flag', () => {
    const skillPath = path.join(repoRoot, 'skills/ubiquitous-language/SKILL.md');

    it('SKILL.md exists (single-file skill, no sub-files)', () => {
      expect(existsSync(skillPath)).toBe(true);
    });

    it('frontmatter preserves disable-model-invocation: true and carries attribution', () => {
      const fm = parseFrontmatter(skillPath);
      expect(fm.name).toBe('ubiquitous-language');
      expect(fm['disable-model-invocation']).toBe(true);
      expect(fm['derived-from']).toBe('mattpocock/skills@90ea8ee');
      expect(fm.license).toBe('MIT');
      expect(fm['upstream-url']).toMatch(
        /^https:\/\/github\.com\/mattpocock\/skills\/tree\/main\/ubiquitous-language$/,
      );
    });

    it('description follows our trigger convention (Use when …)', () => {
      const fm = parseFrontmatter(skillPath);
      expect(typeof fm.description).toBe('string');
      expect(fm.description).toMatch(/Use when/);
      expect(fm.description.length).toBeLessThanOrEqual(1024);
    });

    it('writes UBIQUITOUS_LANGUAGE.md as the canonical output target', () => {
      const body = readFileSync(skillPath, 'utf8');
      expect(body).toMatch(/UBIQUITOUS_LANGUAGE\.md/);
    });
  });

  describe('NOTICE — MIT redistribution compliance', () => {
    const noticePath = path.join(repoRoot, 'NOTICE');

    it('repo-root NOTICE exists', () => {
      expect(existsSync(noticePath)).toBe(true);
    });

    it('NOTICE attributes mattpocock/skills with full SHA and reproduces upstream MIT notice', () => {
      const notice = readFileSync(noticePath, 'utf8');
      expect(notice).toMatch(/mattpocock\/skills/);
      expect(notice).toMatch(/90ea8eec03d4ae8f43427aaf6fe4722653561a42/);
      expect(notice).toMatch(/MIT License/);
      expect(notice).toMatch(/Copyright \(c\) 2026 Matt Pocock/);
    });

    it('NOTICE inventories all 5 byte-identical sub-files plus 3 adapted SKILL.md files', () => {
      const notice = readFileSync(noticePath, 'utf8');
      for (const rel of Object.keys(PINNED_HASHES)) {
        expect(notice).toMatch(new RegExp(rel.replace(/[.]/g, '\\.')));
      }
      expect(notice).toMatch(/skills\/architecture\/SKILL\.md/);
      expect(notice).toMatch(/skills\/domain-model\/SKILL\.md/);
      expect(notice).toMatch(/skills\/ubiquitous-language\/SKILL\.md/);
    });
  });
});
