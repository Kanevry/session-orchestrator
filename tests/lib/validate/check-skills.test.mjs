/**
 * tests/lib/validate/check-skills.test.mjs
 *
 * Tests for scripts/lib/validate/check-skills.mjs — the SKILL.md frontmatter gate.
 *
 * Bug class this locks in (TV-001): a SKILL.md ships with frontmatter that is not
 * valid YAML — overwhelmingly an unquoted single-line `description:` whose text
 * contains a `: ` (e.g. "Iron Law: NO FIXES WITHOUT ..." or "<example>Context: ...").
 * Claude Code's own loader is lenient, so the skill keeps working and nothing goes
 * red; a strict YAML consumer silently loses the skill. This was not hypothetical:
 * 12 of 46 SKILL.md files sat in exactly that state (confirmed by two independent
 * parsers, js-yaml and yaml 2.x) until the repairs that accompany this file. The
 * sibling check-agents.mjs could not see it because it validates with line-oriented
 * regexes rather than a parser — hence the R8 parse rule here.
 *
 * The structural invariant lives in the gate rather than in per-file tests per
 * .claude/rules/test-value.md § TV-005; this file verifies the GATE bites.
 *
 * Strategy: spawn the CLI against tmp plugin-roots holding SKILL.md fixtures,
 * matching tests/lib/validate/check-agents-psa-007.test.mjs.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'lib', 'validate', 'check-skills.mjs');

const tmpRoots = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Build a tmp plugin-root whose skills/ holds the given fixtures.
 *
 * @param {Record<string, string>} skills - directory name -> full SKILL.md text
 * @returns {string} absolute path to the tmp plugin-root
 */
function makeRoot(skills) {
  const root = mkdtempSync(join(tmpdir(), 'check-skills-'));
  tmpRoots.push(root);
  for (const [dirName, content] of Object.entries(skills)) {
    const dir = join(root, 'skills', dirName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), content);
  }
  return root;
}

/**
 * Run the checker against a plugin-root.
 *
 * @param {string} root
 * @returns {{ code: number, out: string }}
 */
function run(root) {
  const res = spawnSync('node', [SCRIPT, root], { encoding: 'utf8' });
  return { code: res.status, out: (res.stdout ?? '') + (res.stderr ?? '') };
}

/** A SKILL.md that satisfies every rule — the control fixture. */
const VALID = `---
name: good-skill
description: Use when the corpus needs a control fixture that satisfies every rule.
---

# Good Skill
`;

describe('check-skills.mjs — R8: frontmatter parses as YAML', () => {
  it('fails an unquoted single-line description containing a colon-space (the 12-file live defect)', () => {
    const root = makeRoot({
      broken: `---
name: broken
description: Use when encountering any bug — runs a 4-phase process. Iron Law: NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST.
---

# Broken
`,
    });

    const { code, out } = run(root);

    expect(code).toBe(1);
    expect(out).toContain('FAIL: skills/broken/SKILL.md: invalid YAML frontmatter');
    expect(out).toContain('bad indentation of a mapping entry');
  });

  it('accepts the SAME description as a folded block scalar — the repair form must not be banned', () => {
    // check-agents.mjs bans `description: >` for agents/*.md. Porting that ban to
    // skills would forbid the only form that makes the colon-space collision above
    // structurally impossible, and would red the 23 SKILL.md files already using it.
    const root = makeRoot({
      repaired: `---
name: repaired
description: >
  Use when encountering any bug — runs a 4-phase process. Iron Law: NO FIXES WITHOUT
  ROOT CAUSE INVESTIGATION FIRST.
---

# Repaired
`,
    });

    const { code, out } = run(root);

    expect(code).toBe(0);
    expect(out).not.toContain('FAIL:');
  });
});

describe('check-skills.mjs — R1: frontmatter block present', () => {
  it('fails a SKILL.md with no opening delimiter', () => {
    const root = makeRoot({ nofm: '# No Frontmatter\n\nBody only.\n' });

    const { code, out } = run(root);

    expect(code).toBe(1);
    expect(out).toContain('FAIL: skills/nofm/SKILL.md: missing YAML frontmatter opening delimiter');
  });

  it('fails a SKILL.md whose frontmatter is never closed', () => {
    const root = makeRoot({ unclosed: '---\nname: unclosed\ndescription: Use when the fence never closes.\n' });

    const { code, out } = run(root);

    expect(code).toBe(1);
    expect(out).toContain('FAIL: skills/unclosed/SKILL.md: missing YAML frontmatter closing delimiter');
  });
});

describe('check-skills.mjs — R2/R3/R5/R6: name and description contract', () => {
  it('fails a frontmatter with no name field (R2)', () => {
    const root = makeRoot({ noname: '---\ndescription: Use when the name field is absent entirely.\n---\n' });

    const { code, out } = run(root);

    expect(code).toBe(1);
    expect(out).toContain('FAIL: skills/noname/SKILL.md: missing or empty required frontmatter field: name');
  });

  it('fails a non-kebab-case name (R3) without also mis-firing R5', () => {
    // Directory equals the bad name on purpose, so R5 is satisfied and only R3 fires.
    const root = makeRoot({ Bad_Name: '---\nname: Bad_Name\ndescription: Use when the name is not kebab-case.\n---\n' });

    const { code, out } = run(root);

    expect(code).toBe(1);
    expect(out).toContain("name must be kebab-case (^[a-z0-9]+(-[a-z0-9]+)*$), got: 'Bad_Name'");
    expect(out).not.toContain('does not match its directory');
  });

  it('fails a kebab-case name that does not match its directory (R5)', () => {
    const root = makeRoot({ 'actual-dir': '---\nname: other-name\ndescription: Use when name and directory disagree.\n---\n' });

    const { code, out } = run(root);

    expect(code).toBe(1);
    expect(out).toContain("name 'other-name' does not match its directory 'actual-dir'");
  });

  it('fails an empty description (R6)', () => {
    const root = makeRoot({ emptydesc: '---\nname: emptydesc\ndescription: "   "\n---\n' });

    const { code, out } = run(root);

    expect(code).toBe(1);
    expect(out).toContain('FAIL: skills/emptydesc/SKILL.md: missing or empty required frontmatter field: description');
  });

  it('passes a fixture that satisfies every rule', () => {
    const root = makeRoot({ 'good-skill': VALID });

    const { code, out } = run(root);

    expect(code).toBe(0);
    expect(out).not.toContain('FAIL:');
    expect(out).toContain('PASS: skills directory contains 1 SKILL.md files');
  });
});

describe('check-skills.mjs — live corpus', () => {
  it('reports every tracked SKILL.md in this repo as valid', () => {
    // Regression guard for the 12 repairs: re-introducing an unparseable
    // frontmatter anywhere under skills/ turns this red.
    const { code, out } = run(REPO_ROOT);

    expect(out).not.toContain('FAIL:');
    expect(code).toBe(0);
  });
});
