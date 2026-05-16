import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..', '..');
const rulesDir = path.join(repoRoot, '.claude', 'rules');
const ruleFile = path.join(rulesDir, 'receiving-review.md');

const content = readFileSync(ruleFile, 'utf8');

describe('receiving-review.md — RCR rule structure (#40)', () => {
  it('file exists at .claude/rules/receiving-review.md', () => {
    expect(existsSync(ruleFile)).toBe(true);
  });

  it('title line is correct — starts with # Receiving Code Review (Always-on)', () => {
    const firstLine = content.split('\n')[0];
    expect(firstLine).toBe('# Receiving Code Review (Always-on)');
  });

  it('RCR-001 section heading is present', () => {
    expect(content).toMatch(/##\s+RCR-001/);
  });

  it('RCR-002 section heading is present', () => {
    expect(content).toMatch(/##\s+RCR-002/);
  });

  it('RCR-003 section heading is present', () => {
    expect(content).toMatch(/##\s+RCR-003/);
  });

  it('RCR-004 section heading is present', () => {
    expect(content).toMatch(/##\s+RCR-004/);
  });

  it('RCR-005 section heading is present', () => {
    expect(content).toMatch(/##\s+RCR-005/);
  });

  it('RCR-006 section heading is present', () => {
    expect(content).toMatch(/##\s+RCR-006/);
  });

  it('6-step pattern in RCR-001 — step READ present (uppercase)', () => {
    expect(content).toMatch(/\bREAD\b/);
  });

  it('6-step pattern in RCR-001 — step UNDERSTAND present (uppercase)', () => {
    expect(content).toMatch(/\bUNDERSTAND\b/);
  });

  it('6-step pattern in RCR-001 — step VERIFY present (uppercase)', () => {
    expect(content).toMatch(/\bVERIFY\b/);
  });

  it('6-step pattern in RCR-001 — step EVALUATE present (uppercase)', () => {
    expect(content).toMatch(/\bEVALUATE\b/);
  });

  it('6-step pattern in RCR-001 — step RESPOND present (uppercase)', () => {
    expect(content).toMatch(/\bRESPOND\b/);
  });

  it('6-step pattern in RCR-001 — step IMPLEMENT present (uppercase)', () => {
    expect(content).toMatch(/\bIMPLEMENT\b/);
  });

  it('forbidden phrases in RCR-002 — at least 4 of 5 required phrases present', () => {
    const forbiddenPhrases = [
      '"You\'re absolutely right!"',
      '"Great point!"',
      '"Excellent feedback!"',
      '"Let me implement that now"',
      '"Thanks for catching that!"',
    ];
    const presentCount = forbiddenPhrases.filter((phrase) => content.includes(phrase)).length;
    expect(presentCount).toBeGreaterThanOrEqual(4);
  });

  it('YAGNI check section present — RCR-004 heading exists', () => {
    expect(content).toMatch(/##\s+RCR-004/);
  });

  it('YAGNI check section present — YAGNI keyword appears in body', () => {
    expect(content.toUpperCase()).toContain('YAGNI');
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

  it('See Also footer cross-references verification-before-completion.md', () => {
    expect(content).toContain('verification-before-completion.md');
  });

  it('bidirectional link verified — development.md See Also references receiving-review.md', () => {
    const developmentMd = readFileSync(path.join(rulesDir, 'development.md'), 'utf8');
    expect(developmentMd).toContain('receiving-review.md');
  });

  it('bidirectional link verified — testing.md See Also references receiving-review.md', () => {
    const testingMd = readFileSync(path.join(rulesDir, 'testing.md'), 'utf8');
    expect(testingMd).toContain('receiving-review.md');
  });

  it('bidirectional link verified — cli-design.md See Also references receiving-review.md', () => {
    const cliDesignMd = readFileSync(path.join(rulesDir, 'cli-design.md'), 'utf8');
    expect(cliDesignMd).toContain('receiving-review.md');
  });
});
