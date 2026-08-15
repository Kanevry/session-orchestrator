/**
 * tests/lib/validate/check-agents.test.mjs
 *
 * Tests for the YAML-parse rule in Check 6 of scripts/lib/validate/check-agents.mjs.
 *
 * Bug class this locks in (TV-001): an agent definition ships with a
 * frontmatter block that is not YAML, and nothing notices. That is not
 * hypothetical — measured 2026-08-15, 14 of 16 files in `agents/` were in
 * exactly that state. Every one failed the same way: an unquoted single-line
 * `description:` carrying a `: ` inside it (`<example>Context: /plan ...`),
 * which YAML reads as a nested mapping at an impossible indentation. The gate
 * could not see it because every rule in Check 6 reads the block with line
 * regexes, and `^description:` matches a broken line just as happily as a
 * sound one.
 *
 * The rules below therefore pin two things a regex gate cannot give:
 *   (a) the block IS YAML (the 14-file defect), and
 *   (b) the pre-existing block-scalar ban still fires on a block that parses —
 *       the two rules are orthogonal, and a later "unification" that drops
 *       either one is a regression this file catches.
 *
 * Strategy: spawn the CLI against tmp plugin-roots holding agent fixtures,
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
const SCRIPT = join(REPO_ROOT, 'scripts', 'lib', 'validate', 'check-agents.mjs');

const tmpRoots = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Build a tmp plugin-root whose agents/ holds the given fixtures. */
function makeRoot(agents) {
  const root = mkdtempSync(join(tmpdir(), 'check-agents-yaml-'));
  tmpRoots.push(root);
  const agentsDir = join(root, 'agents');
  mkdirSync(agentsDir, { recursive: true });
  for (const [file, content] of Object.entries(agents)) {
    writeFileSync(join(agentsDir, file), content, 'utf8');
  }
  return root;
}

function run(pluginRoot) {
  return spawnSync('node', [SCRIPT, pluginRoot], { encoding: 'utf8', timeout: 20_000 });
}

/** An agent definition whose only variable is the raw `description:` line. */
function agentWithDescriptionLine(descriptionLine) {
  return [
    '---',
    'name: fixture-agent',
    descriptionLine,
    'model: sonnet',
    'color: blue',
    'tools: Read, Grep, Glob',
    '---',
    '',
    '## Rules',
    '',
    '- Report findings; never edit.',
    '',
  ].join('\n');
}

describe('check-agents Check 6 — frontmatter must parse as YAML', () => {
  it('fails an unquoted description carrying a `: ` (the 14-file defect)', () => {
    // The exact live shape: an inline <example> whose "Context: " colon turns
    // the plain scalar into a mapping entry at an impossible indentation.
    const root = makeRoot({
      'fixture-agent.md': agentWithDescriptionLine(
        'description: Use this agent for review. <example>Context: /plan produced a PRD. user: "Review it." <commentary>Catches vague criteria.</commentary></example>',
      ),
    });
    const res = run(root);

    expect(res.status).toBe(1);
    expect(res.stdout).toContain('FAIL: fixture-agent.md: invalid YAML frontmatter');
    expect(res.stdout).toContain('bad indentation of a mapping entry');
  });

  it('accepts the same description once it is single-quoted', () => {
    // The repair form. `description: >` is NOT available here — the agent
    // loader cannot read a block scalar, which the ban below enforces — so
    // quoting is the only fix, and this pins that it IS a fix.
    const root = makeRoot({
      'fixture-agent.md': agentWithDescriptionLine(
        `description: 'Use this agent for review. <example>Context: /plan produced a PRD. user: "Review it." <commentary>Catches vague criteria.</commentary></example>'`,
      ),
    });
    const res = run(root);

    expect(res.status).toBe(0);
    expect(res.stdout).toContain('PASS: all 1 agent frontmatter blocks parse as YAML mappings');
  });

  it('preserves an apostrophe through the doubled-quote escape', () => {
    // Single-quoting is only a safe repair if `''` round-trips to one `'`.
    // If it did not, the repair would silently rewrite the agent's triggering
    // surface — the one thing the 14 repairs had to not do.
    const root = makeRoot({
      'fixture-agent.md': agentWithDescriptionLine(
        `description: 'Guards the implementer''s scope. <example>Context: a wave. user: "Go."</example>'`,
      ),
    });
    const res = run(root);

    expect(res.status).toBe(0);
    // Check 9 reads `description` back through getField and matches on its
    // content; a mangled escape would have thrown at parse time above.
    expect(res.stdout).toContain('PASS: all 1 agent frontmatter blocks parse as YAML mappings');
  });

  it('fails a frontmatter block that parses but is not a mapping', () => {
    // A block that is a sequence (or a bare scalar) has no fields at all;
    // without this rule the field regexes would report every one as "missing"
    // and bury the actual shape error under six unrelated failures.
    const root = makeRoot({
      'fixture-agent.md': ['---', '- name: fixture-agent', '- model: sonnet', '---', '', 'Body.', ''].join('\n'),
    });
    const res = run(root);

    expect(res.status).toBe(1);
    expect(res.stdout).toContain('FAIL: fixture-agent.md: YAML frontmatter must be a non-null mapping/object');
  });

  it('still fails a `description: >` block scalar, which is valid YAML', () => {
    // Orthogonality guard. The block scalar PARSES, so the new rule waves it
    // through — the pre-existing ban must be what catches it. A later change
    // that folds the two rules into one would drop this case silently, and the
    // agent loader cannot read a folded description.
    const root = makeRoot({
      'fixture-agent.md': [
        '---',
        'name: fixture-agent',
        'description: >',
        '  Use this agent for review.',
        'model: sonnet',
        'color: blue',
        '---',
        '',
        'Body.',
        '',
      ].join('\n'),
    });
    const res = run(root);

    expect(res.status).toBe(1);
    expect(res.stdout).toContain('must be an inline string, not a YAML block scalar');
  });

  it('reports the shared extractor diagnostic when the closing fence is absent', () => {
    // Pins the message change from lifting extraction into
    // frontmatter-block.mjs: a truncated block is now named precisely instead
    // of collapsing into a generic "missing YAML frontmatter".
    const root = makeRoot({
      'fixture-agent.md': ['---', 'name: fixture-agent', 'model: sonnet', '', 'Body with no closing fence.', ''].join('\n'),
    });
    const res = run(root);

    expect(res.status).toBe(1);
    expect(res.stdout).toContain('FAIL: fixture-agent.md: missing YAML frontmatter closing delimiter');
  });
});
