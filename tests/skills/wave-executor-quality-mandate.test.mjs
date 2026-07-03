/**
 * tests/skills/wave-executor-quality-mandate.test.mjs
 *
 * Regression-guard tests for the #724 C6 Quality-wave Full-Gate mandate +
 * #724 C5c Edit-Persistence Verify contract.
 *
 * C6: the Quality wave's Full Gate must be mechanically un-skippable — the
 * Baseline cache short-circuit (shouldSkipIncremental) is bypassed for the
 * Quality wave via a `waveRole` parameter, not merely by prose. C5c: an agent's
 * `STATUS: done` is verified against the on-disk change set (git diff/status)
 * before the coordinator trusts it.
 *
 * These are content-presence assertions against the LIVE skill + source files.
 * They go RED if the contract wording is removed or reverted. No subprocess
 * spawning, no mocks (per .claude/rules/testing.md: hardcoded literals, behaviour
 * = "the mechanical-mandate wiring is present", so a revert turns them red — see
 * the fake-regression note at the bottom).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WAVE_LOOP_MD = join(REPO_ROOT, 'skills/wave-executor/wave-loop.md');
const WAVE_SKILL_MD = join(REPO_ROOT, 'skills/wave-executor/SKILL.md');
const QUALITY_GATES_MD = join(REPO_ROOT, 'skills/quality-gates/SKILL.md');
const CACHE_MJS = join(REPO_ROOT, 'scripts/lib/quality-gates-cache.mjs');

let waveLoop;
let waveSkill;
let qualityGates;
let cacheSrc;

/**
 * Extract the "Baseline cache check" block from wave-loop.md — from that heading
 * up to (but excluding) the following "- After **Discovery**" role-list bullet.
 * Scopes the waveRole-passthrough assertions to the exact snippet that owns them.
 */
function baselineCacheBlock(text) {
  const start = text.indexOf('**Baseline cache check');
  const end = text.indexOf('- After **Discovery**', start);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('could not locate the Baseline cache check block in wave-loop.md');
  }
  return text.slice(start, end);
}

beforeAll(() => {
  waveLoop = readFileSync(WAVE_LOOP_MD, 'utf8');
  waveSkill = readFileSync(WAVE_SKILL_MD, 'utf8');
  qualityGates = readFileSync(QUALITY_GATES_MD, 'utf8');
  cacheSrc = readFileSync(CACHE_MJS, 'utf8');
});

// ── (a) Edit-Persistence Verify step exists (#724 C5c) ──────────────────────

describe('#724 C5c Edit-Persistence Verify (wave-loop.md §2 Review)', () => {
  it('has the "3d. Edit-Persistence Verify" step heading', () => {
    expect(waveLoop).toContain('3d. **Edit-Persistence Verify');
  });

  it('sits between step 3c and step 4 in the Review section', () => {
    const idx3c = waveLoop.indexOf('3c. **File-level grounding');
    const idx3d = waveLoop.indexOf('3d. **Edit-Persistence Verify');
    const idx4 = waveLoop.indexOf('4. **Run incremental verification');
    expect(idx3c).toBeGreaterThan(0);
    expect(idx3d).toBeGreaterThan(idx3c);
    expect(idx4).toBeGreaterThan(idx3d);
  });

  it('verifies declared files against the on-disk change set via git diff + status', () => {
    expect(waveLoop).toContain('git diff --name-only');
    expect(waveLoop).toContain('git status --porcelain');
  });

  it('names the violation outcome + STATE.md deviation logging', () => {
    expect(waveLoop).toContain('edit-persistence violation');
    expect(waveLoop).toContain('NOT verified');
    expect(waveLoop).toContain('appendDeviationOnDisk');
  });

  it('cross-references verification-before-completion VBC-004 Exception 2', () => {
    expect(waveLoop).toContain('verification-before-completion.md');
    expect(waveLoop).toContain('VBC-004 Exception 2');
  });
});

// ── (b) Baseline cache check threads waveRole + excludes the Quality wave ────

describe('#724 C6 Quality-wave cache exclusion (wave-loop.md Baseline cache check)', () => {
  it('passes waveRole into the shouldSkipIncremental call', () => {
    const block = baselineCacheBlock(waveLoop);
    expect(block).toContain('shouldSkipIncremental');
    expect(block).toContain('sessionStartRef: SESSION_START_REF, waveRole');
  });

  it('documents that the Quality wave is exempt from the skip', () => {
    const block = baselineCacheBlock(waveLoop);
    expect(block).toContain('Quality wave is exempt');
    expect(block).toContain('quality-wave-full-gate-mandate');
  });

  it('footnote extends the NEVER-skipped invariant to after the Quality wave', () => {
    // The extended footnote must name both session-end and after the Quality wave.
    expect(waveLoop).toContain('Full Gate at session-end is NEVER skipped, and after the Quality wave is likewise NEVER skipped');
  });

  it('role-table "After Quality" entry marks the mandate MECHANICAL', () => {
    expect(waveLoop).toContain("passes `waveRole: 'Quality'`");
    expect(waveLoop).toContain('necessary but NOT sufficient');
  });
});

// ── (c) wave-executor/SKILL.md Inter-Wave section carries the mandate ────────

describe('#724 C6 Inter-Wave Quality-Gate mandate (wave-executor/SKILL.md)', () => {
  it('states the Quality-wave gate is ALWAYS the Full Gate', () => {
    expect(waveSkill).toContain('Quality-wave Full-Gate mandate (#724 C6)');
    expect(waveSkill).toContain('ALWAYS the Full Gate');
  });

  it('references the waveRole threading + quality-gates Variant 3', () => {
    expect(waveSkill).toContain('waveRole');
    expect(waveSkill).toContain('Variant 3: Full Gate');
  });
});

// ── (d) quality-gates/SKILL.md names BOTH never-skipped consumers ────────────

describe('#724 C6 quality-gates/SKILL.md dual-consumer invariant', () => {
  it('Variant 3 "Used by" lists session-end AND the wave-executor Quality wave', () => {
    expect(qualityGates).toContain('**Used by:** session-end (Phase 2); wave-executor (Quality wave');
    expect(qualityGates).toContain('mechanically enforced via the `waveRole` parameter, #724');
  });

  it('Baseline-Cache invariant covers session-end AND after the Quality wave', () => {
    expect(qualityGates).toContain('Full Gate at session-end AND after the Quality wave is NEVER skipped');
    expect(qualityGates).toContain('quality-wave-full-gate-mandate');
  });
});

// ── (e) quality-gates-cache.mjs docstring invariant extended ────────────────

describe('#724 C6 quality-gates-cache.mjs docstring', () => {
  it('module-header invariant names both session-end and the Quality wave', () => {
    expect(cacheSrc).toContain('Full Gate at session-end AND at the Quality wave is NEVER skipped');
  });

  it('shouldSkipIncremental hard-returns the mandate reason for waveRole Quality (case-insensitive, trimmed — #F-B)', () => {
    // Hardened match (W4 fix pass F-B): case-insensitive + trimmed, so a
    // coordinator prose typo like 'quality' or 'Quality ' cannot silently
    // disable the invariant. Pin the hardened literal, not the old bare
    // strict-equality form it replaced.
    expect(cacheSrc).toContain("String(waveRole ?? '').trim().toLowerCase() === 'quality'");
    expect(cacheSrc).toContain("reason: 'quality-wave-full-gate-mandate'");
  });
});

/*
 * Fake-regression rationale (.claude/rules/testing.md § Negative-Assertion
 * Fake-Regression Check): these are content contracts, not mocked behaviour.
 * Manually verified during authoring that (1) deleting the "3d. Edit-Persistence
 * Verify" block turns (a) RED; (2) reverting the shouldSkipIncremental call to
 * drop `waveRole` turns (b) RED; (3) removing the hardened case-insensitive
 * `waveRole` guard from quality-gates-cache.mjs (or reverting it to the bare
 * `waveRole === 'Quality'` strict-equality form) turns (e) RED. Each assertion
 * pins an exact literal that a revert re-removes.
 */
