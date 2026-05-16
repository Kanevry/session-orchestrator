import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..', '..');
const rulesDir = path.join(repoRoot, '.claude', 'rules');
const ruleFile = path.join(rulesDir, 'verification-before-completion.md');

const content = readFileSync(ruleFile, 'utf8');

describe('verification-before-completion.md — VBC rule structure (#38)', () => {
  it('file exists at .claude/rules/verification-before-completion.md', () => {
    expect(existsSync(ruleFile)).toBe(true);
  });

  it('title line is correct — starts with # Verification Before Completion (Always-on)', () => {
    const firstLine = content.split('\n')[0];
    expect(firstLine).toBe('# Verification Before Completion (Always-on)');
  });

  it('Iron Law is present verbatim — NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE.', () => {
    expect(content).toContain('NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE.');
  });

  it('VBC-001 section heading is present', () => {
    expect(content).toMatch(/##\s+VBC-001/);
  });

  it('VBC-002 section heading is present', () => {
    expect(content).toMatch(/##\s+VBC-002/);
  });

  it('VBC-003 section heading is present', () => {
    expect(content).toMatch(/##\s+VBC-003/);
  });

  it('VBC-004 section heading is present', () => {
    expect(content).toMatch(/##\s+VBC-004/);
  });

  it('VBC-005 section heading is present', () => {
    expect(content).toMatch(/##\s+VBC-005/);
  });

  it('banned phrases in VBC-002 — at least 6 of 7 required phrases present', () => {
    const bannedPhrases = [
      '"should pass"',
      '"I\'m confident"',
      '"looks correct"',
      '"Great!"',
      '"Perfect!"',
      '"Done!"',
      '"Agent said success"',
    ];
    const presentCount = bannedPhrases.filter((phrase) => content.includes(phrase)).length;
    expect(presentCount).toBeGreaterThanOrEqual(6);
  });

  it('Gate Function step IDENTIFY is present (uppercase, as a word)', () => {
    expect(content).toContain('IDENTIFY');
  });

  it('Gate Function step RUN is present (uppercase, as a word)', () => {
    expect(content).toMatch(/\bRUN\b/);
  });

  it('Gate Function step READ is present (uppercase, as a word)', () => {
    expect(content).toMatch(/\bREAD\b/);
  });

  it('Gate Function step VERIFY is present (uppercase, as a word)', () => {
    expect(content).toMatch(/\bVERIFY\b/);
  });

  it('Gate Function step STATE is present (uppercase, as a word)', () => {
    expect(content).toMatch(/\bSTATE\b/);
  });

  it('Anti-Patterns section header is present', () => {
    expect(content).toMatch(/##\s+Anti-Patterns/);
  });

  it('See Also footer links to development.md', () => {
    expect(content).toContain('development.md');
  });

  it('See Also footer links to testing.md', () => {
    expect(content).toContain('testing.md');
  });

  it('See Also footer links to cli-design.md', () => {
    expect(content).toContain('cli-design.md');
  });

  it('See Also footer links to ask-via-tool.md', () => {
    expect(content).toContain('ask-via-tool.md');
  });

  it('See Also footer links to parallel-sessions.md', () => {
    expect(content).toContain('parallel-sessions.md');
  });

  it('bidirectional link verified — development.md See Also references verification-before-completion.md', () => {
    const developmentMd = readFileSync(path.join(rulesDir, 'development.md'), 'utf8');
    expect(developmentMd).toContain('verification-before-completion.md');
  });

  it('bidirectional link verified — testing.md See Also references verification-before-completion.md', () => {
    const testingMd = readFileSync(path.join(rulesDir, 'testing.md'), 'utf8');
    expect(testingMd).toContain('verification-before-completion.md');
  });

  it('bidirectional link verified — cli-design.md See Also references verification-before-completion.md', () => {
    const cliDesignMd = readFileSync(path.join(rulesDir, 'cli-design.md'), 'utf8');
    expect(cliDesignMd).toContain('verification-before-completion.md');
  });
});
