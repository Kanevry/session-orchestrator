/**
 * tests/lib/validate/check-agents-psa-007.test.mjs
 *
 * Tests for Check 10 of scripts/lib/validate/check-agents.mjs — the PSA-007
 * git-write ban on repo-write agents (#724).
 *
 * Bug class this locks in (TV-001): a NEW agent definition ships with
 * `tools: ... Edit, Write` but no PSA-007 git-write ban in its body. Nothing
 * else in the repo notices — the agent validates, dispatches, and then races
 * its wave siblings for `.git/index` or stashes their work-in-progress away.
 * That is not hypothetical: `agents/docs-writer.md` shipped in exactly that
 * state until #724 found it, which is why the guard discovers agents
 * DYNAMICALLY (a hardcoded roster would have missed docs-writer too).
 *
 * The structural invariant lives in the gate rather than in a test per
 * .claude/rules/test-value.md § TV-005; this file verifies the GATE bites.
 *
 * Strategy: spawn the CLI against tmp plugin-roots holding agent fixtures,
 * matching tests/lib/validate/check-rules.test.mjs.
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
  const root = mkdtempSync(join(tmpdir(), 'check-agents-psa007-'));
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

/** A frontmatter-valid agent definition; `tools` and `body` are the variables. */
function agentMd({ name, tools, body }) {
  return [
    '---',
    `name: ${name}`,
    `description: Fixture agent for the PSA-007 gate test (${name}).`,
    'model: sonnet',
    'color: blue',
    `tools: ${tools}`,
    '---',
    '',
    body,
    '',
  ].join('\n');
}

const BAN_BODY = [
  '## Rules',
  '',
  '- Do NOT run ANY git write operation (`git add`, `git commit`, `git stash`,',
  '  `git push`) — the git index and stash are shared session resources',
  '  (PSA-007); the coordinator handles ALL VCS operations.',
].join('\n');

describe('check-agents Check 10 — PSA-007 git-write ban (#724)', () => {
  it('fails a repo-write agent (Edit+Write) whose body has no ban', () => {
    const root = makeRoot({
      'rogue-writer.md': agentMd({
        name: 'rogue-writer',
        tools: 'Read, Edit, Write',
        body: '## Rules\n\n- Implement the feature and report back.',
      }),
    });
    const res = run(root);

    expect(res.status).toBe(1);
    expect(res.stdout).toContain('FAIL: rogue-writer.md');
    expect(res.stdout).toContain('PSA-007');
  });

  it('passes a repo-write agent that carries both the PSA-007 ref and the git stash ban', () => {
    const root = makeRoot({
      'good-writer.md': agentMd({
        name: 'good-writer',
        tools: 'Read, Edit, Write',
        body: BAN_BODY,
      }),
    });
    const res = run(root);

    expect(res.status).toBe(0);
    expect(res.stdout).toContain('PASS: good-writer.md: PSA-007 git-write ban present');
  });

  it('fails when only the PSA-007 reference is present but the git stash ban line is not', () => {
    const root = makeRoot({
      'half-writer.md': agentMd({
        name: 'half-writer',
        tools: 'Read, Edit, Write',
        body: '## Rules\n\n- Follow PSA-007.',
      }),
    });
    const res = run(root);

    expect(res.status).toBe(1);
    expect(res.stdout).toContain('git stash');
  });

  it('does not require the ban from a read-only agent (no Write tool)', () => {
    const root = makeRoot({
      'reader.md': agentMd({
        name: 'reader',
        tools: 'Read, Grep, Glob',
        body: '## Rules\n\n- Report findings; never edit.',
      }),
    });
    const res = run(root);

    expect(res.status).toBe(0);
    expect(res.stdout).toContain('(no repo-write agents found — check skipped)');
  });

  it('discovers MultiEdit-based repo-write agents too (Edit-suffix tools)', () => {
    // A roster hardcoded to the literal tool name `Edit` would let an agent
    // declaring `MultiEdit, Write` slip past the ban entirely.
    const root = makeRoot({
      'multi-writer.md': agentMd({
        name: 'multi-writer',
        tools: 'Read, MultiEdit, Write',
        body: '## Rules\n\n- Implement the feature and report back.',
      }),
    });
    const res = run(root);

    expect(res.status).toBe(1);
    expect(res.stdout).toContain('FAIL: multi-writer.md');
  });

  it('does not accept a PSA-007 mention in frontmatter as the ban', () => {
    // The instruction has to reach the agent's rules, not just its description.
    const root = makeRoot({
      'frontmatter-only.md': [
        '---',
        'name: frontmatter-only',
        'description: Agent that mentions PSA-007 and git stash only in frontmatter.',
        'model: sonnet',
        'color: blue',
        'tools: Read, Edit, Write',
        '---',
        '',
        '## Rules',
        '',
        '- Implement the feature and report back.',
        '',
      ].join('\n'),
    });
    const res = run(root);

    expect(res.status).toBe(1);
    expect(res.stdout).toContain('FAIL: frontmatter-only.md');
  });
});
