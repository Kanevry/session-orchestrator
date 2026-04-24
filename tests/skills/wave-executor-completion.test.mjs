import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..', '..');
const skillMd = readFileSync(path.join(repoRoot, 'skills', 'wave-executor', 'SKILL.md'), 'utf8');

describe('skills/wave-executor/SKILL.md — issue #253 fixes', () => {
  describe('#253 Housekeeping section — state-ownership contract compliance', () => {
    it('extracts a non-empty Housekeeping Sessions section', () => {
      const housekeepingMatch = skillMd.match(/Housekeeping Sessions[\s\S]+?(?=\n### |\n## )/);
      expect(housekeepingMatch).toBeTruthy();
      expect(housekeepingMatch[0].length).toBeGreaterThan(100);
    });

    it('does NOT instruct wave-executor to write status:completed (forbidden per contract)', () => {
      const housekeepingMatch = skillMd.match(/Housekeeping Sessions[\s\S]+?(?=\n### |\n## )/);
      const section = housekeepingMatch[0];
      expect(section).not.toMatch(/Update STATE\.md to `status: completed` when done/);
    });

    it('explicitly defers status:completed write to session-end with contract citation', () => {
      const housekeepingMatch = skillMd.match(/Housekeeping Sessions[\s\S]+?(?=\n### |\n## )/);
      const section = housekeepingMatch[0];
      expect(section).toMatch(/reserved for session-end/);
      expect(section).toMatch(/state-ownership contract/);
      expect(section).toMatch(/skills\/_shared\/state-ownership\.md/);
    });

    it('instructs coordinator to leave status: active during housekeeping close', () => {
      const housekeepingMatch = skillMd.match(/Housekeeping Sessions[\s\S]+?(?=\n### |\n## )/);
      const section = housekeepingMatch[0];
      expect(section).toMatch(/Leave `status: active`/);
    });
  });

  describe('#253 Completion section — persistence-aware /close suggestion', () => {
    it('extracts a non-empty Completion section', () => {
      const completionMatch = skillMd.match(/## Completion[\s\S]+?(?=\n## )/);
      expect(completionMatch).toBeTruthy();
      expect(completionMatch[0].length).toBeGreaterThan(50);
    });

    it('has persistence:true branch recommending /close', () => {
      const completionMatch = skillMd.match(/## Completion[\s\S]+?(?=\n## )/);
      const section = completionMatch[0];
      expect(section).toMatch(/If `persistence: true`, suggest invoking `\/close`/);
    });

    it('has persistence:false branch noting session is complete', () => {
      const completionMatch = skillMd.match(/## Completion[\s\S]+?(?=\n## )/);
      const section = completionMatch[0];
      expect(section).toMatch(/If `persistence: false`/);
      expect(section).toMatch(/no STATE\.md to close/);
      expect(section).toMatch(/session-end would be a no-op/);
    });

    it('branches the /close suggestion conditionally on both persistence values', () => {
      const completionMatch = skillMd.match(/## Completion[\s\S]+?(?=\n## )/);
      const section = completionMatch[0];
      expect(section).toMatch(/persistence: true/);
      expect(section).toMatch(/persistence: false/);
    });

    it('preserves the no-auto-commit rule in Completion', () => {
      const completionMatch = skillMd.match(/## Completion[\s\S]+?(?=\n## )/);
      const section = completionMatch[0];
      expect(section).toMatch(/Do NOT auto-commit/);
      expect(section).toMatch(/`\/close` handles that/);
    });
  });
});
