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
    // Strip an optional leading YAML frontmatter block (tier: key added #692) before the title check.
    const firstLine = content.replace(/^---\n[\s\S]*?\n---\n+/, '').split('\n')[0];
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

describe('receiving-review.md — RCR-007 Three-Class Finding Triage (#899)', () => {
  it('RCR-007 section heading is present', () => {
    expect(content).toMatch(/##\s+RCR-007/);
  });

  it('finding class in-scope-blocker is present', () => {
    expect(content).toContain('`in-scope-blocker`');
  });

  it('finding class follow-up is present', () => {
    expect(content).toContain('`follow-up`');
  });

  it('finding class stop-and-escalate is present', () => {
    expect(content).toContain('`stop-and-escalate`');
  });

  it('stop-and-escalate trigger 1 of 5 — a new protocol — is present', () => {
    expect(content).toContain('(1) a new protocol,');
  });

  it('stop-and-escalate trigger 2 of 5 — a new config surface — is present', () => {
    expect(content).toContain('(2) a new config surface,');
  });

  it('stop-and-escalate trigger 3 of 5 — a storage change — is present', () => {
    expect(content).toContain('(3) a storage change,');
  });

  it('stop-and-escalate trigger 4 of 5 — a public-API contract — is present', () => {
    expect(content).toContain('(4) a public-API contract,');
  });

  it('stop-and-escalate trigger 5 of 5 — a different owner boundary or a release-process change — is present', () => {
    expect(content).toContain('(5) a different owner boundary or a release-process change.');
  });

  it('stop-and-escalate trigger list is stated as a closed set (exactly five, nothing else)', () => {
    expect(content).toMatch(/`stop-and-escalate` triggers[\s\S]{0,10}exactly these five, nothing else/);
  });

  it('frozen-scope exception 1 of 5 — active data loss — is present', () => {
    expect(content).toContain('(1) active data loss,');
  });

  it('frozen-scope exception 2 of 5 — crash — is present', () => {
    expect(content).toContain('(2) crash,');
  });

  it('frozen-scope exception 3 of 5 — broken install/upgrade — is present', () => {
    expect(content).toContain('(3) broken install/upgrade,');
  });

  it('frozen-scope exception 4 of 5 — release blocker — is present', () => {
    expect(content).toContain('(4) release blocker,');
  });

  it('frozen-scope exception 5 of 5 — concrete security exposure — is present', () => {
    expect(content).toContain('(5) concrete security exposure.');
  });

  it('frozen-scope exception list is stated as a closed set (exactly five, nothing else)', () => {
    expect(content).toMatch(/Frozen-scope exceptions[\s\S]{0,10}exactly these five, nothing else/);
  });
});

describe('receiving-review.md — RCR-008 Two-Cycle Reclassify (#899)', () => {
  it('RCR-008 section heading is present', () => {
    expect(content).toMatch(/##\s+RCR-008/);
  });

  it('reclassify obligation after two non-converging fix cycles is stated', () => {
    expect(content).toMatch(/two fix cycles without a \*\*strict decrease\*\* in blocking findings/);
  });

  it('no-stack / no-push landing-lane clause is present', () => {
    expect(content).toContain('no stacked, no pushed fix commits');
  });
});

describe('receiving-review.md — instruction budget (#899)', () => {
  it('byte size stays within the +2000B growth ceiling (8225 B) over the pre-change 6225 B baseline', async () => {
    const { computeInstructionBudget } = await import('../../scripts/lib/instruction-budget-guard.mjs');
    const budget = computeInstructionBudget({ repoRoot });
    const entry = budget.perFile.find((f) => f.file === 'receiving-review.md');
    expect(entry).toBeDefined();
    expect(entry.bytes).toBeLessThanOrEqual(8225);
  });

  it('repo-wide always-on directive total stays at or under the 480 ceiling', async () => {
    const { computeInstructionBudget, DEFAULT_CEILING } = await import('../../scripts/lib/instruction-budget-guard.mjs');
    const budget = computeInstructionBudget({ repoRoot });
    expect(budget.ceiling).toBe(DEFAULT_CEILING);
    expect(budget.totalDirectives).toBeLessThanOrEqual(480);
  });

  it('repo-wide instruction budget is not flagged overBudget', async () => {
    const { computeInstructionBudget } = await import('../../scripts/lib/instruction-budget-guard.mjs');
    const budget = computeInstructionBudget({ repoRoot });
    expect(budget.overBudget).toBe(false);
  });
});
