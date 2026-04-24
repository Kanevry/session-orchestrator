/**
 * tests/skills/session-plan-docs-role.test.mjs
 *
 * Regression-guard tests for the session-plan handoff contract for Docs-role
 * tasks. Greps the live SKILL.md to assert that critical protocol text is
 * present — these tests fail if the contract wording is removed or changed.
 *
 * No subprocess spawning needed — these are content-presence assertions.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SKILL_MD = join(REPO_ROOT, 'skills/session-plan/SKILL.md');

let content;

beforeAll(() => {
  content = readFileSync(SKILL_MD, 'utf8');
});

// ── Step 1.5 — docs-writer matching ─────────────────────────────────────────

describe('session-plan Step 1.5 — docs-writer matching', () => {
  it('documents docs-writer as the Docs-role project agent', () => {
    // The fast-path rule: Docs-role tasks resolve to "docs-writer" subagent_type.
    // Removing this breaks the entire Docs-role dispatch chain.
    expect(content).toContain('resolve `subagent_type: "docs-writer"`');
    expect(content).toContain('docs-writer');
    expect(content).toContain('Docs');
  });

  it('honors agent-mapping.docs config override', () => {
    // The agent-mapping.docs override must be documented so operators can
    // redirect Docs-role tasks to a custom agent without touching skill files.
    expect(content).toContain('agent-mapping.docs');
  });
});

// ── Step 1.8 — Phase 2.5 consumption ────────────────────────────────────────

describe('session-plan Step 1.8 — Phase 2.5 consumption', () => {
  it('identifies the Phase 2.5 emission block by its exact heading', () => {
    // session-plan locates the Phase 2.5 output by this exact heading string.
    // If the heading drifts, the parser will silently skip the block.
    expect(content).toMatch(/### Docs Planning Result \(Phase 2\.5\)/);
  });

  it('documents parse-order rule for multi-entry Docs-tasks-seed bullets', () => {
    // The "in document order" rule prevents seed entries from being merged or
    // reordered, which would assign wrong audiences to tasks.
    expect(content).toContain('Parse in document order');
  });

  it('specifies 0 Docs tasks when block is absent', () => {
    // When Phase 2.5 was skipped, session-plan must not fabricate Docs tasks.
    // This is the guard against phantom docs-writer dispatches.
    expect(content).toContain('emit **0 Docs tasks** and do not fabricate any');
  });
});

// ── slot-vs-inline dispatch rule ─────────────────────────────────────────────

describe('session-plan slot-vs-inline dispatch rule', () => {
  it('formalizes the len==0 / len==1 / len>=2 branches', () => {
    // All three branches of the dispatch rule must be present.
    // Removing any one branch creates an unhandled case.
    expect(content).toContain('`len(docs-tasks) == 0`');
    expect(content).toContain('`len(docs-tasks) == 1`');
    expect(content).toContain('`len(docs-tasks) >= 2`');
  });

  it('forbids a 6th wave for Docs role', () => {
    // Docs must always fit into an existing wave. Adding a 6th wave breaks the
    // 5-wave default and confuses wave numbering for all downstream skills.
    expect(content).toContain('NEVER add a 6th wave');
  });
});

// ── Docs Tasks machine-readable emission ─────────────────────────────────────

describe('session-plan Docs Tasks machine-readable emission', () => {
  it('defines the Docs Tasks SSOT heading', () => {
    // wave-executor and session-end locate the SSOT block by this exact heading.
    // A heading change breaks the entire persistence chain without a test error.
    expect(content).toMatch(/### Docs Tasks \(machine-readable\)/);
  });

  it('documents the 6 task fields', () => {
    // All 6 fields must be present in the emit format; any missing field causes
    // downstream consumers (wave-executor Pre-Wave 1b, session-end Phase 3.2)
    // to silently drop or misread entries.
    expect(content).toContain('id:');
    expect(content).toContain('audience:');
    expect(content).toContain('target-pattern:');
    expect(content).toContain('rationale:');
    expect(content).toContain('wave:');
    expect(content).toContain('status:');
  });

  it('specifies terminal status values ok|partial|gap set by session-end', () => {
    // The aligned terminal enum (ok / partial / gap) is the contract between
    // session-plan (planner), wave-executor (persister), and session-end
    // (verifier). Any drift breaks the verification loop.
    expect(content).toContain('`ok` (diff substantive)');
    expect(content).toContain('`partial` (diff has `<!-- REVIEW: source needed -->` markers)');
    expect(content).toContain('`gap` (no matching diff)');
  });
});
