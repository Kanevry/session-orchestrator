/**
 * tests/skills/wave-executor-isolation-default.test.mjs
 *
 * Regression-guard tests for the #243 new-directory detection protocol in
 * wave-loop.md and the STATE.md docs-tasks extension in wave-executor/SKILL.md.
 *
 * Greps live skill files to assert that critical protocol text is present.
 * These tests fail if the contract wording is removed or silently changed.
 *
 * No subprocess spawning needed — these are content-presence assertions.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WAVE_LOOP_MD = join(REPO_ROOT, 'skills/wave-executor/wave-loop.md');
const SKILL_MD = join(REPO_ROOT, 'skills/wave-executor/SKILL.md');

let waveLoop;
let skill;

beforeAll(() => {
  waveLoop = readFileSync(WAVE_LOOP_MD, 'utf8');
  skill = readFileSync(SKILL_MD, 'utf8');
});

// ── Pre-Dispatch New-Directory Detection (#243) ───────────────────────────────

describe('Pre-Dispatch New-Directory Detection (#243)', () => {
  it('has the Pre-Dispatch New-Directory Detection heading in wave-loop.md', () => {
    // The heading is the anchor for the entire #243 fix block. Without it,
    // coordinators cannot locate the detection protocol.
    expect(waveLoop).toMatch(/#### Pre-Dispatch New-Directory Detection/);
  });

  it('forces isolation:"none" on new-dir detection (not worktree)', () => {
    // CORE correctness check: the fix avoids worktree by overriding
    // configIsolation to 'none' before resolveIsolation() is called.
    // If this line is removed, new-directory agents get worktrees and the
    // merge-back regression (#243) silently reappears.
    expect(waveLoop).toContain("configIsolation = 'none'");
  });

  it('cites both learning references', () => {
    // Both learnings that motivated the fix must be cited so the protocol
    // is traceable. Removing a citation severs the audit trail.
    expect(waveLoop).toContain('agent-tool-worktree-no-sync-regression');
    expect(waveLoop).toContain('wave3-isolation-none-dispatch');
  });

  it('documents enforcement auto-promote warn to strict', () => {
    // When isolation is forced to 'none', enforcement auto-promotes from
    // 'warn' to 'strict'. This must be documented so operators understand
    // why enforcement escalated for a wave they didn't configure strictly.
    expect(waveLoop).toContain("auto-promotes `warn` → `strict`");
  });

  it('honors explicit configIsolation worktree override with warning', () => {
    // When the user explicitly sets configIsolation:'worktree', the protocol
    // must honour it but emit a warning. Silently ignoring the override or
    // silently forcing none without a warning would violate user intent.
    expect(waveLoop).toContain("configIsolation: 'worktree'");
    expect(waveLoop).toContain('isolation is explicitly set to \'worktree\'');
  });
});

// ── Pre-Wave 1b docs-tasks persistence ───────────────────────────────────────

describe('Pre-Wave 1b docs-tasks persistence', () => {
  it('persists docs-tasks to STATE.md when the block is present and enabled', () => {
    // BOTH conditions must be checked: the plan block must exist AND
    // docs-orchestrator.enabled must be true. A single-condition check
    // would either always write (ignoring config) or never write (ignoring plan).
    expect(skill).toContain('### Docs Tasks (machine-readable)');
    expect(skill).toContain('`$CONFIG."docs-orchestrator".enabled` is `true`');
  });

  it('omits the key entirely when disabled or block absent (no empty key)', () => {
    // Absence is the sentinel — downstream consumers (session-end Phase 3.2)
    // treat missing docs-tasks identically to an empty list. Writing an empty
    // key would be interpreted as "planned but nothing to do" instead of "opt-out".
    expect(skill).toContain('Do NOT write an empty key (`docs-tasks: []`)');
  });

  it('documents ownership: wave-executor owns STATE.md writes', () => {
    // session-plan must NOT write STATE.md directly. The wave-executor owns
    // all STATE.md writes. Blurring ownership causes double-writes or races.
    expect(skill).toContain('Ownership clarification');
    expect(skill).toContain('The wave-executor owns ALL STATE.md writes');
  });

  it('documents terminal status values as ok|partial|gap (aligned with session-end)', () => {
    // The terminal enum must match between wave-executor/SKILL.md and
    // session-plan/SKILL.md. Any drift breaks session-end Phase 3.2 verification.
    expect(skill).toContain('`ok` (diff is substantive)');
    expect(skill).toContain('`partial` (diff region contains `<!-- REVIEW: source needed -->` markers)');
    expect(skill).toContain('`gap` (no matching diff)');
  });
});

// ── wave-executor agent-type resolution for docs-writer ──────────────────────

describe('wave-executor agent-type resolution for docs-writer', () => {
  it('cross-references docs-writer in wave-loop.md Agent-Type Resolution area', () => {
    // docs-writer must appear in the resolution chain commentary so coordinators
    // know it flows through step 3a (project-agent match) without a special branch.
    // Removing this note leads coordinators to add redundant special-case branches.
    expect(waveLoop).toContain('docs-writer');
    // Confirms the 3a natural-flow statement is present
    expect(waveLoop).toContain('flows through step 3a naturally');
  });
});
