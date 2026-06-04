/**
 * tests/skills/session-start/what-not-to-retry-surface.test.mjs
 *
 * Regression: GL#623 "What Not To Retry" cross-session continuity slot — the
 * session-start SURFACE wiring. session-start Phase 6.5.1 must surface the
 * `## What Not To Retry` section as a forced-read block wrapped in the #621
 * HISTORICAL guard, and the completed-branch Idle Reset must PRESERVE the
 * section (it is cross-session continuity, unlike per-session Deviations).
 *
 * Mirrors tests/skills/session-start/historical-guard-wiring.test.mjs in style
 * (it does NOT edit that file — separate ownership).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HISTORICAL_GUARD_BANNER } from '@lib/historical-guard.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SKILL_PATH = path.join(REPO_ROOT, 'skills/session-start/SKILL.md');
const PRESENTATION_PATH = path.join(REPO_ROOT, 'skills/session-start/presentation-format.md');

describe('What Not To Retry surface wiring (#623, session-start)', () => {
  const body = readFileSync(SKILL_PATH, 'utf8');

  it('skills/session-start/SKILL.md exists', () => {
    expect(existsSync(SKILL_PATH)).toBe(true);
  });

  it('contains a Phase 6.5.1 "What Not To Retry" forced-read section', () => {
    expect(body).toContain('## Phase 6.5.1: What Not To Retry (forced-read, #623)');
  });

  it('the surface block reads via readWhatNotToRetry', () => {
    const idx651 = body.indexOf('## Phase 6.5.1: What Not To Retry');
    const idx66 = body.indexOf('## Phase 6.6', idx651);
    const region = body.slice(idx651, idx66);
    expect(region).toContain('readWhatNotToRetry');
  });

  it('the surface block wraps content via wrapHistorical from the #621 SSOT module', () => {
    const idx651 = body.indexOf('## Phase 6.5.1: What Not To Retry');
    const idx66 = body.indexOf('## Phase 6.6', idx651);
    const region = body.slice(idx651, idx66);
    expect(region).toContain('wrapHistorical');
    expect(region).toContain('scripts/lib/historical-guard.mjs');
  });

  it('the guard (NOT LIVE INSTRUCTIONS) precedes the surfaced content in Phase 6.5.1', () => {
    // Guard must come BEFORE the content render (readWhatNotToRetry call) so a
    // reader cannot mistake a stale entry for a live instruction.
    const idx651 = body.indexOf('## Phase 6.5.1: What Not To Retry');
    const idx66 = body.indexOf('## Phase 6.6', idx651);
    const region = body.slice(idx651, idx66);
    const idxGuard = region.indexOf('NOT LIVE INSTRUCTIONS');
    const idxRead = region.indexOf('readWhatNotToRetry');
    expect(idxGuard).toBeGreaterThan(-1);
    expect(idxRead).toBeGreaterThan(-1);
    expect(idxGuard).toBeLessThan(idxRead);
  });

  it('embeds the byte-identical canonical guard banner literal', () => {
    const idx651 = body.indexOf('## Phase 6.5.1: What Not To Retry');
    const idx66 = body.indexOf('## Phase 6.6', idx651);
    const region = body.slice(idx651, idx66);
    expect(region).toContain(HISTORICAL_GUARD_BANNER);
  });

  it('documents the forced-read (always-render, no AUQ) behaviour', () => {
    const idx651 = body.indexOf('## Phase 6.5.1: What Not To Retry');
    const idx66 = body.indexOf('## Phase 6.6', idx651);
    const region = body.slice(idx651, idx66);
    expect(region).toMatch(/forced-read/i);
    expect(region).toMatch(/unconditional/i);
  });

  it('the Idle Reset section states What Not To Retry is PRESERVED through the reset', () => {
    const idxIdle = body.indexOf('### Idle Reset (completed-branch only)');
    const idxSnapshot = body.indexOf('### Snapshot Recovery (#196)', idxIdle);
    const region = body.slice(idxIdle, idxSnapshot);
    expect(idxIdle).toBeGreaterThan(-1);
    expect(region).toContain('## What Not To Retry');
    expect(region).toMatch(/PRESERVE/);
    // The preservation rule explicitly contrasts with the cleared Deviations.
    expect(region).toMatch(/cross-session continuity/i);
  });
});

describe('What Not To Retry presentation slot (#623, presentation-format)', () => {
  it('presentation-format.md documents a What Not To Retry slot', () => {
    const body = readFileSync(PRESENTATION_PATH, 'utf8');
    expect(body).toContain('## What Not To Retry');
    expect(body).toMatch(/FORCED-READ/i);
  });
});
