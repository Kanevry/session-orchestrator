/**
 * tests/skills/using-orchestrator.test.mjs
 *
 * Behavioral tests for skills/using-orchestrator/SKILL.md — issue #337
 * (auto-skill meta-skill).
 *
 * The skill is dispatched in-prose (no importable module), so tests verify
 * the skill document content directly via readFileSync.
 *
 * Tests assert structure, phrase coverage, default-behavior documentation,
 * and AUQ-disambiguation wiring.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SKILL_PATH = join(REPO_ROOT, 'skills', 'using-orchestrator', 'SKILL.md');

// Read once — all tests share the same file content
const skill = readFileSync(SKILL_PATH, 'utf8');

// ---------------------------------------------------------------------------
// Test 1: file exists and is non-empty
// ---------------------------------------------------------------------------

describe('file presence', () => {
  it('SKILL.md exists and is non-empty', () => {
    expect(skill.length).toBeGreaterThan(0);
  });

  it('contains the expected skill name in frontmatter', () => {
    expect(skill).toContain('name: using-orchestrator');
  });
});

// ---------------------------------------------------------------------------
// Test 2: phrase map has at least 12 trigger phrases
// ---------------------------------------------------------------------------

describe('phrase map coverage', () => {
  it('contains a phrase map section heading', () => {
    expect(skill).toMatch(/##\s+Phrase Map/i);
  });

  it('contains at least 12 table rows in the phrase map', () => {
    // Each table row starts with a pipe (|) and contains a phrase
    // Count rows that look like data rows (not header or separator rows)
    const lines = skill.split('\n');
    const dataRows = lines.filter((line) => {
      const trimmed = line.trim();
      // Data rows start and end with | and are not the separator (---|---)
      return (
        trimmed.startsWith('|') &&
        !trimmed.includes('---') &&
        // Exclude the header row (contains "Phrase" column header)
        !trimmed.includes('Phrase |') &&
        !trimmed.includes('| Phrase')
      );
    });
    expect(dataRows.length).toBeGreaterThanOrEqual(12);
  });
});

// ---------------------------------------------------------------------------
// Test 3: at least 6 DE phrases present
// ---------------------------------------------------------------------------

describe('German (DE) phrase coverage', () => {
  it('contains at least 6 German trigger phrases', () => {
    // Count rows that are tagged DE or contain German-language content
    const lines = skill.split('\n');
    const deRows = lines.filter((line) => {
      const lower = line.toLowerCase();
      return (
        line.includes('| DE |') ||
        line.includes('| DE/') ||
        lower.includes('plane') ||
        lower.includes('feature planen') ||
        lower.includes('retrospektive') ||
        lower.includes('session beenden') ||
        lower.includes('/discovery starten') ||
        lower.includes('evolve learnings')
      );
    });
    expect(deRows.length).toBeGreaterThanOrEqual(6);
  });

  it('contains "plane neues Projekt" DE phrase', () => {
    expect(skill).toContain('plane neues Projekt');
  });

  it('contains "feature planen" DE phrase', () => {
    expect(skill).toContain('feature planen');
  });

  it('contains "retrospektive" DE phrase', () => {
    expect(skill.toLowerCase()).toContain('retrospektive');
  });

  it('contains "session beenden" DE phrase', () => {
    expect(skill).toContain('session beenden');
  });
});

// ---------------------------------------------------------------------------
// Test 4: at least 6 EN phrases present
// ---------------------------------------------------------------------------

describe('English (EN) phrase coverage', () => {
  it('contains at least 6 English trigger phrases', () => {
    const lines = skill.split('\n');
    const enRows = lines.filter((line) => {
      const lower = line.toLowerCase();
      return (
        line.includes('| EN |') ||
        line.includes('| EN/') ||
        lower.includes('/plan new') ||
        lower.includes('plan a feature') ||
        lower.includes('run retro') ||
        lower.includes('wrap up session') ||
        lower.includes('run discovery') ||
        lower.includes('evolve learnings') ||
        lower.includes('/close') ||
        lower.includes('/discovery') ||
        lower.includes('/evolve') ||
        lower.includes('/bootstrap')
      );
    });
    expect(enRows.length).toBeGreaterThanOrEqual(6);
  });

  it('contains "/plan new" EN phrase', () => {
    expect(skill).toContain('/plan new');
  });

  it('contains "plan a feature" EN phrase', () => {
    expect(skill).toContain('plan a feature');
  });

  it('contains "wrap up session" EN phrase', () => {
    expect(skill).toContain('wrap up session');
  });

  it('contains "run discovery" EN phrase', () => {
    expect(skill).toContain('run discovery');
  });

  it('contains "/bootstrap" EN/DE entry', () => {
    expect(skill).toContain('/bootstrap');
  });
});

// ---------------------------------------------------------------------------
// Test 5: documents auto-skill-dispatch: false default + no-op behavior
// ---------------------------------------------------------------------------

describe('auto-skill-dispatch: false default behavior', () => {
  it('contains auto-skill-dispatch: false flag reference', () => {
    expect(skill).toContain('auto-skill-dispatch: false');
  });

  it('documents that the skill is opt-in and off by default', () => {
    // Should state that false is the default / off by default
    expect(skill).toMatch(/off by default|default.*false|false.*default/i);
  });

  it('documents no-op / silent return when flag is false', () => {
    // Must state that the skill returns silently without side effects
    expect(skill).toMatch(/return immediately|return silently|silent no-op|no-op/i);
  });

  it('explicitly states zero side effects when disabled', () => {
    expect(skill).toMatch(/without.*logging.*without.*side effects|without.*reading.*without.*logging|no side effects/i);
  });

  it('states that existing call sites are unaffected (zero behavior change)', () => {
    expect(skill).toMatch(/Zero behavior change|no.*behavior change|unchanged/i);
  });
});

// ---------------------------------------------------------------------------
// Test 6: references ask-via-tool.md for AUQ disambiguation
// ---------------------------------------------------------------------------

describe('AUQ disambiguation reference', () => {
  it('references .claude/rules/ask-via-tool.md', () => {
    expect(skill).toContain('.claude/rules/ask-via-tool.md');
  });

  it('describes the disambiguation delta threshold (< 0.15)', () => {
    expect(skill).toContain('0.15');
  });

  it('mandates AUQ when top two candidates are within the delta', () => {
    expect(skill).toMatch(/AUQ.*mandatory|mandatory.*AUQ|AskUserQuestion.*required|required.*AskUserQuestion/i);
  });

  it('contains the AskUserQuestion call pattern for disambiguation', () => {
    expect(skill).toContain('AskUserQuestion');
  });

  it('specifies the dispatch confidence threshold (0.85)', () => {
    expect(skill).toContain('0.85');
  });

  it('documents anti-pattern of silent dispatch on ambiguous match', () => {
    expect(skill).toMatch(/Never silently dispatch|never.*silent.*dispatch|silent.*dispatch.*bug/i);
  });
});
