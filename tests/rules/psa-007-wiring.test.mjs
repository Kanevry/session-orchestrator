/**
 * tests/rules/psa-007-wiring.test.mjs
 *
 * Regression tests for #724 (PSA/VBC extensions, part a+b) — PSA-007 subagent
 * git-write prohibition.
 *
 * Verifies that:
 *   (a) .claude/rules/parallel-sessions.md carries the PSA-007 section with
 *       the full git-write ban command list.
 *   (b) Every repo-write agent (discovered dynamically by scanning agents/*.md
 *       for a `tools:` line containing both Edit and Write — per
 *       .claude/rules/testing.md § Dynamic Artifact Counts, floor/ceiling
 *       instead of a pinned exact count) carries the PSA-007 ban line.
 *   (c) .claude/rules/verification-before-completion.md VBC-003 table has the
 *       new "Subagent edit persisted" row.
 *   (d) agents/AGENTS.md documents the authoring convention so future agents
 *       don't repeat the docs-writer gap.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..', '..');

const parallelSessionsPath = path.join(repoRoot, '.claude', 'rules', 'parallel-sessions.md');
const vbcPath = path.join(repoRoot, '.claude', 'rules', 'verification-before-completion.md');
const agentsDir = path.join(repoRoot, 'agents');
const agentsAgentsMdPath = path.join(agentsDir, 'AGENTS.md');

const parallelSessionsContent = readFileSync(parallelSessionsPath, 'utf8');
const vbcContent = readFileSync(vbcPath, 'utf8');
const agentsAgentsMdContent = readFileSync(agentsAgentsMdPath, 'utf8');

/**
 * Parse the YAML frontmatter block from a Markdown file.
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]+?)\n---/);
  return match ? match[1] : null;
}

/**
 * Discover every agent definition under agents/ (excluding AGENTS.md itself)
 * whose `tools:` frontmatter line contains BOTH Edit and Write — i.e. every
 * "repo-write" agent per agents/AGENTS.md § Optional sandbox-tier: field
 * inference rule. Dynamic discovery (not a hardcoded list) so this test does
 * not drift when new repo-write agents are added.
 */
function discoverRepoWriteAgents() {
  const files = readdirSync(agentsDir).filter((f) => f.endsWith('.md') && f !== 'AGENTS.md');
  const repoWrite = [];
  for (const file of files) {
    const rel = path.join('agents', file);
    const content = readFileSync(path.join(agentsDir, file), 'utf8');
    const fm = parseFrontmatter(content);
    if (!fm) continue;
    const toolsLine = fm.split('\n').find((l) => l.startsWith('tools:'));
    if (!toolsLine) continue;
    if (toolsLine.includes('Edit') && toolsLine.includes('Write')) {
      repoWrite.push({ rel, content });
    }
  }
  return repoWrite;
}

describe('PSA-007 — parallel-sessions.md section structure (#724)', () => {
  it('has a PSA-007 heading', () => {
    expect(parallelSessionsContent).toMatch(/##\s+PSA-007/);
  });

  it('PSA-007 section names it as the in-run axis', () => {
    const start = parallelSessionsContent.indexOf('## PSA-007');
    const end = parallelSessionsContent.indexOf('## Anti-Patterns');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const section = parallelSessionsContent.slice(start, end);
    expect(section).toMatch(/in-run/);
  });

  it('PSA-007 section lists all 7 banned git-write commands', () => {
    const start = parallelSessionsContent.indexOf('## PSA-007');
    const end = parallelSessionsContent.indexOf('## Anti-Patterns');
    const section = parallelSessionsContent.slice(start, end);
    const bannedCommands = [
      'git add',
      'git commit',
      'git stash',
      'git mv',
      'git rm',
      'git push',
      'git reset',
    ];
    for (const cmd of bannedCommands) {
      expect(section, `PSA-007 section should mention ${cmd}`).toContain(cmd);
    }
  });

  it('PSA-007 section cites the shared-resource rationale (index/stash)', () => {
    const start = parallelSessionsContent.indexOf('## PSA-007');
    const end = parallelSessionsContent.indexOf('## Anti-Patterns');
    const section = parallelSessionsContent.slice(start, end);
    expect(section.toLowerCase()).toMatch(/shared/);
    expect(section).toMatch(/index\.lock|index/);
  });

  it('Decision Tree references a sibling-wave-agent branch before PSA-002', () => {
    const treeStart = parallelSessionsContent.indexOf('## Decision Tree');
    const psa001Start = parallelSessionsContent.indexOf('## PSA-001');
    const tree = parallelSessionsContent.slice(treeStart, psa001Start);
    expect(tree).toMatch(/SIBLING/);
    expect(tree).toMatch(/PSA-002/);
  });

  it('PSA-001 and PSA-002 sections each carry an isolation:none caveat', () => {
    const psa001Start = parallelSessionsContent.indexOf('## PSA-001');
    const psa002Start = parallelSessionsContent.indexOf('## PSA-002');
    const psa003Start = parallelSessionsContent.indexOf('## PSA-003');
    const psa001Body = parallelSessionsContent.slice(psa001Start, psa002Start);
    const psa002Body = parallelSessionsContent.slice(psa002Start, psa003Start);
    expect(psa001Body).toMatch(/isolation:\s*none/);
    expect(psa002Body).toMatch(/isolation:\s*none/);
  });
});

describe('PSA-007 — repo-write agent wiring (dynamic discovery, floor/ceiling)', () => {
  const repoWriteAgents = discoverRepoWriteAgents();

  it('discovers a plausible number of repo-write agents (floor/ceiling, not pinned count)', () => {
    // Currently 5 (code-implementer, db-specialist, docs-writer, test-writer,
    // ui-developer). Floor/ceiling per testing.md § Dynamic Artifact Counts —
    // catches accidental deletions (floor) and runaway drift (ceiling)
    // without pinning the exact count.
    expect(repoWriteAgents.length).toBeGreaterThanOrEqual(4);
    expect(repoWriteAgents.length).toBeLessThanOrEqual(30);
  });

  it('every discovered repo-write agent carries the PSA-007 marker in its Rules', () => {
    expect(repoWriteAgents.length).toBeGreaterThan(0);
    for (const { rel, content } of repoWriteAgents) {
      expect(content, `${rel} must reference PSA-007`).toContain('PSA-007');
    }
  });

  it('every discovered repo-write agent bans git stash explicitly', () => {
    for (const { rel, content } of repoWriteAgents) {
      expect(content, `${rel} must ban git stash`).toContain('git stash');
    }
  });

  it('docs-writer.md specifically is included (previously had zero git-write ban — #724 gap)', () => {
    const rels = repoWriteAgents.map((a) => a.rel);
    expect(rels).toContain(path.join('agents', 'docs-writer.md'));
  });
});

describe('VBC-003 — subagent edit persistence row (#724)', () => {
  it('VBC-003 table contains the "Subagent edit persisted" row', () => {
    expect(vbcContent).toContain('Subagent edit persisted');
  });

  it('the new row requires git diff evidence, not agent say-so', () => {
    const rowStart = vbcContent.indexOf('Subagent edit persisted');
    const rowLine = vbcContent.slice(rowStart, vbcContent.indexOf('\n', rowStart));
    expect(rowLine).toMatch(/git diff/);
  });

  it('VBC-004 Exception 2 requires the coordinator to pair STATUS with git diff evidence', () => {
    const exception2Start = vbcContent.indexOf('2. **Coordinator orchestration**');
    const exception3Start = vbcContent.indexOf('3. **Documentation-only changes**');
    expect(exception2Start).toBeGreaterThan(-1);
    expect(exception3Start).toBeGreaterThan(exception2Start);
    const exception2Body = vbcContent.slice(exception2Start, exception3Start);
    expect(exception2Body).toMatch(/git diff --name-only/);
  });
});

describe('PSA-007 — authoring convention wired into agents/AGENTS.md (#724)', () => {
  it('AGENTS.md documents the git-write ban-line requirement', () => {
    expect(agentsAgentsMdContent).toMatch(/PSA-007/);
  });

  it('AGENTS.md requirement references docs-writer as the closed gap', () => {
    const start = agentsAgentsMdContent.indexOf('PSA-007');
    const section = agentsAgentsMdContent.slice(start, start + 2000);
    expect(section).toMatch(/docs-writer/);
  });
});
