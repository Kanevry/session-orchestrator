import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import yaml from 'js-yaml';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SKILL_PATH = join(REPO_ROOT, 'skills', 'write-executable-plan', 'SKILL.md');
const TEMPLATE_PATH = join(REPO_ROOT, 'skills', 'write-executable-plan', 'plan-template.md');
const REF_PLAN_PATH = join(REPO_ROOT, 'docs', 'plans', '2026-05-16-superpowers-cluster.md');

function parseFrontmatter(absPath) {
  const raw = readFileSync(absPath, 'utf8');
  const match = raw.match(/^---\r?\n([\s\S]+?)\r?\n---\r?\n/);
  if (!match) throw new Error(`No frontmatter in ${absPath}`);
  return yaml.load(match[1]);
}

/**
 * Strip fenced code blocks (``` ... ```) from a markdown string so that
 * embedded code examples are not matched by the placeholder linter.
 * The reference plan embeds test code that itself references forbidden
 * strings as string literals in test assertions — those are quoted
 * references, not live placeholder usage.
 */
function stripFencedCodeBlocks(text) {
  return text.replace(/```[\s\S]*?```/g, '[CODE BLOCK REMOVED]');
}

// ─── Group 1: SKILL.md structure ────────────────────────────────────────────

describe('write-executable-plan SKILL.md — file presence + frontmatter', () => {
  it('SKILL.md exists at skills/write-executable-plan/SKILL.md', () => {
    expect(existsSync(SKILL_PATH), 'SKILL.md must exist at skills/write-executable-plan/SKILL.md').toBe(true);
  });

  it('frontmatter name field equals write-executable-plan', () => {
    const fm = parseFrontmatter(SKILL_PATH);
    expect(fm.name).toBe('write-executable-plan');
  });

  it('frontmatter description is a string between 50 and 1024 characters', () => {
    const fm = parseFrontmatter(SKILL_PATH);
    expect(typeof fm.description).toBe('string');
    expect(fm.description.length).toBeGreaterThanOrEqual(50);
    expect(fm.description.length).toBeLessThanOrEqual(1024);
  });
});

describe('write-executable-plan SKILL.md — phase headers', () => {
  const skill = readFileSync(SKILL_PATH, 'utf8');

  it('contains Phase 0 Bootstrap Gate header', () => {
    expect(skill).toMatch(/^## Phase 0/m);
  });

  it('contains Phase 1 header', () => {
    expect(skill).toMatch(/^## Phase 1/m);
  });

  it('contains Phase 2 header', () => {
    expect(skill).toMatch(/^## Phase 2/m);
  });

  it('contains Phase 3 header', () => {
    expect(skill).toMatch(/^## Phase 3/m);
  });

  it('contains Phase 4 header', () => {
    expect(skill).toMatch(/^## Phase 4/m);
  });

  it('contains Phase 5 header', () => {
    expect(skill).toMatch(/^## Phase 5/m);
  });

  it('contains Phase 6 header', () => {
    expect(skill).toMatch(/^## Phase 6/m);
  });
});

describe('write-executable-plan SKILL.md — 5-step TDD structure per Task', () => {
  const skill = readFileSync(SKILL_PATH, 'utf8');

  it('documents Step 1: Write the failing test', () => {
    expect(skill, 'SKILL.md must contain "Step 1: Write the failing test"').toContain(
      'Step 1: Write the failing test',
    );
  });

  it('documents Step 2: Run (confirm failure)', () => {
    // Step 2 heading uses "Run the test to confirm it fails"
    expect(skill, 'SKILL.md must contain a Step 2: Run heading').toMatch(/Step 2: Run/);
  });

  it('documents Step 3: Implement the minimal code', () => {
    expect(skill, 'SKILL.md must contain "Step 3: Implement"').toMatch(/Step 3: Implement/);
  });

  it('documents Step 4: Run (verify pass)', () => {
    expect(skill, 'SKILL.md must contain a Step 4: Run heading').toMatch(/Step 4: Run/);
  });

  it('documents Step 5: Commit', () => {
    expect(skill, 'SKILL.md must contain "Step 5: Commit"').toMatch(/Step 5: Commit/);
  });
});

describe('write-executable-plan SKILL.md — Phase 4 placeholder linter section', () => {
  const skill = readFileSync(SKILL_PATH, 'utf8');

  it('Phase 4 body references TBD as a forbidden string', () => {
    expect(skill, 'Phase 4 linter must list "TBD" as forbidden').toContain('TBD');
  });

  it('Phase 4 body references TODO as a forbidden string', () => {
    expect(skill, 'Phase 4 linter must list "TODO" as forbidden').toContain('TODO');
  });

  it('Phase 4 body references FIXME as a forbidden string', () => {
    expect(skill, 'Phase 4 linter must list "FIXME" as forbidden').toContain('FIXME');
  });

  it('Phase 4 body bans "add error handling" vague phrases', () => {
    expect(skill, 'Phase 4 linter must ban "add error handling" patterns').toMatch(
      /add.*error handling/i,
    );
  });

  it('Phase 4 body bans cross-reference shortcuts like "similar to Task N"', () => {
    expect(skill, 'Phase 4 linter must ban "similar to Task N" pattern').toMatch(
      /similar to Task/i,
    );
  });
});

// ─── Group 2: plan-template.md ───────────────────────────────────────────────

describe('write-executable-plan plan-template.md', () => {
  it('plan-template.md exists and is non-empty (>500 bytes)', () => {
    expect(existsSync(TEMPLATE_PATH), 'plan-template.md must exist').toBe(true);
    const size = readFileSync(TEMPLATE_PATH).length;
    expect(size, 'plan-template.md must be larger than 500 bytes').toBeGreaterThan(500);
  });

  it('template contains at least 3 uppercase angle-bracket slot markers', () => {
    const template = readFileSync(TEMPLATE_PATH, 'utf8');
    const slots = template.match(/<[A-Z_]+>/g) ?? [];
    expect(
      slots.length,
      `template must have ≥3 slot markers like <FEATURE_TITLE>; found: ${slots.join(', ')}`,
    ).toBeGreaterThanOrEqual(3);
  });

  it('template contains the <FEATURE_TITLE> slot', () => {
    const template = readFileSync(TEMPLATE_PATH, 'utf8');
    expect(template, 'template must include <FEATURE_TITLE> slot').toContain('<FEATURE_TITLE>');
  });

  it('template contains the <SOURCE_PATH> slot', () => {
    const template = readFileSync(TEMPLATE_PATH, 'utf8');
    expect(template, 'template must include <SOURCE_PATH> slot').toContain('<SOURCE_PATH>');
  });

  it('template contains the <COMPLETE_TEST_CODE> slot', () => {
    const template = readFileSync(TEMPLATE_PATH, 'utf8');
    expect(template, 'template must include <COMPLETE_TEST_CODE> slot').toContain(
      '<COMPLETE_TEST_CODE>',
    );
  });
});

// ─── Group 3: Reference plan dogfood validity ────────────────────────────────

describe('reference plan docs/plans/2026-05-16-superpowers-cluster.md — existence', () => {
  it('reference plan exists and has >200 lines', () => {
    expect(existsSync(REF_PLAN_PATH), 'reference plan must exist').toBe(true);
    const content = readFileSync(REF_PLAN_PATH, 'utf8');
    const lineCount = content.split('\n').length;
    expect(
      lineCount,
      `reference plan must have >200 lines (documented as 927); found ${lineCount}`,
    ).toBeGreaterThan(200);
  });
});

describe('reference plan — Task sections (Tasks 1-6)', () => {
  const plan = readFileSync(REF_PLAN_PATH, 'utf8');

  it('contains ## Task 1 section', () => {
    expect(plan, 'reference plan must contain "## Task 1"').toMatch(/^## Task 1/m);
  });

  it('contains ## Task 2 section', () => {
    expect(plan, 'reference plan must contain "## Task 2"').toMatch(/^## Task 2/m);
  });

  it('contains ## Task 3 section', () => {
    expect(plan, 'reference plan must contain "## Task 3"').toMatch(/^## Task 3/m);
  });

  it('contains ## Task 4 section', () => {
    expect(plan, 'reference plan must contain "## Task 4"').toMatch(/^## Task 4/m);
  });

  it('contains ## Task 5 section', () => {
    expect(plan, 'reference plan must contain "## Task 5"').toMatch(/^## Task 5/m);
  });

  it('contains ## Task 6 section', () => {
    expect(plan, 'reference plan must contain "## Task 6"').toMatch(/^## Task 6/m);
  });
});

describe('reference plan — ### Files sub-heading coverage', () => {
  it('has at least 6 "### Files" sub-headings (one per task)', () => {
    const plan = readFileSync(REF_PLAN_PATH, 'utf8');
    const matches = plan.match(/^### Files/gm) ?? [];
    expect(
      matches.length,
      `reference plan must have ≥6 "### Files" sub-headings; found ${matches.length}`,
    ).toBeGreaterThanOrEqual(6);
  });
});

describe('reference plan — placeholder linter (outside code blocks)', () => {
  // Strip all fenced code blocks before checking for forbidden tokens.
  // The plan embeds test code in Task 4 Step 1 that intentionally
  // references these strings as test assertion targets — those are
  // quoted references, not live placeholder usage.
  const plan = readFileSync(REF_PLAN_PATH, 'utf8');
  const planWithoutCode = stripFencedCodeBlocks(plan);

  it('does not contain bare TBD outside code blocks', () => {
    expect(
      planWithoutCode,
      'reference plan must not contain "TBD" as a live placeholder outside code blocks',
    ).not.toMatch(/\bTBD\b/);
  });

  it('does not contain FIXME outside code blocks', () => {
    expect(
      planWithoutCode,
      'reference plan must not contain "FIXME" outside code blocks',
    ).not.toMatch(/\bFIXME\b/);
  });

  it('does not contain XXX outside code blocks', () => {
    expect(
      planWithoutCode,
      'reference plan must not contain "XXX" outside code blocks',
    ).not.toMatch(/\bXXX\b/);
  });

  it('does not contain "add appropriate error handling" outside code blocks', () => {
    expect(
      planWithoutCode,
      'reference plan must not contain "add appropriate error handling" as live text',
    ).not.toContain('add appropriate error handling');
  });

  it('does not contain "similar to Task N" outside code blocks', () => {
    expect(
      planWithoutCode,
      'reference plan must not contain "similar to Task N" as live text',
    ).not.toMatch(/similar to Task \w/i);
  });

  it('does not contain "same as above" outside code blocks', () => {
    expect(
      planWithoutCode,
      'reference plan must not contain "same as above" as live text',
    ).not.toMatch(/same as above/i);
  });

  it('does not contain <placeholder> outside code blocks', () => {
    expect(
      planWithoutCode,
      'reference plan must not contain literal "<placeholder>"',
    ).not.toContain('<placeholder>');
  });

  it('does not contain unquoted TODO outside code blocks', () => {
    // After stripping code blocks, any remaining TODO is a real unquoted usage.
    // The plan's embedded test code references TODO inside a ```js``` block;
    // stripFencedCodeBlocks removes that block entirely.
    expect(
      planWithoutCode,
      'reference plan must not contain unquoted TODO outside code blocks',
    ).not.toMatch(/\bTODO\b/);
  });
});

// ─── Optional Group 4: Self-consistency ──────────────────────────────────────

describe('write-executable-plan SKILL.md — self-consistency', () => {
  it('description or body explicitly rejects placeholder strings (TBD/TODO/etc.)', () => {
    const fm = parseFrontmatter(SKILL_PATH);
    const skill = readFileSync(SKILL_PATH, 'utf8');
    // The description in frontmatter OR the body must mention the linter rejects these.
    // The description says: 'Rejects "TBD", "TODO", "add error handling", "similar to Task N"'
    const mentionsTBD = fm.description.includes('TBD') || skill.includes('TBD');
    const mentionsTODO = fm.description.includes('TODO') || skill.includes('TODO');
    expect(mentionsTBD, 'skill description or body must mention TBD as a rejected token').toBe(true);
    expect(mentionsTODO, 'skill description or body must mention TODO as a rejected token').toBe(
      true,
    );
  });
});
