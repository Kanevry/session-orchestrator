/**
 * tests/skills/session-start/what-not-to-retry-surface.test.mjs
 *
 * Regression: GL#623 "What Not To Retry" cross-session continuity slot — the
 * session-start SURFACE wiring. session-start Phase 6.5.1 must surface the
 * `## What Not To Retry` section as a forced-read block wrapped in the #621
 * HISTORICAL guard, and the completed-branch Idle Reset must PRESERVE the
 * section (it is cross-session continuity, unlike per-session Deviations).
 *
 * Path note (#1157 references/ split): SKILL.md keeps the Phase 6.5.1 heading +
 * a stub naming the reference file (asserted below — a dropped stub is still a
 * red test), while the PROCEDURE moved verbatim to
 * `references/phase-6-5-forced-reads.md` and the Idle Reset rule to
 * `references/phase-1-5-session-continuity.md`. Each assertion targets the file
 * that owns the text — never a "somewhere in the skill" search, which would stop
 * catching a lost section.
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
const FORCED_READS_PATH = path.join(
  REPO_ROOT,
  'skills/session-start/references/phase-6-5-forced-reads.md',
);
const CONTINUITY_PATH = path.join(
  REPO_ROOT,
  'skills/session-start/references/phase-1-5-session-continuity.md',
);

describe('What Not To Retry surface wiring (#623, session-start)', () => {
  const body = readFileSync(SKILL_PATH, 'utf8');
  const forcedReads = readFileSync(FORCED_READS_PATH, 'utf8');
  const continuity = readFileSync(CONTINUITY_PATH, 'utf8');

  // The Phase 6.5.1 region inside the reference file: heading → next phase heading.
  const idx651 = forcedReads.indexOf('## Phase 6.5.1: What Not To Retry');
  const idx652 = forcedReads.indexOf('## Phase 6.5.2', idx651);
  const region = forcedReads.slice(idx651, idx652);

  it('skills/session-start/SKILL.md exists', () => {
    expect(existsSync(SKILL_PATH)).toBe(true);
  });

  it('references/phase-6-5-forced-reads.md exists', () => {
    expect(existsSync(FORCED_READS_PATH)).toBe(true);
  });

  it('contains a Phase 6.5.1 "What Not To Retry" forced-read section', () => {
    expect(body).toContain('## Phase 6.5.1: What Not To Retry (forced-read, #623)');
  });

  it('the SKILL.md stub routes Phase 6.5.1 to references/phase-6-5-forced-reads.md', () => {
    const stubIdx = body.indexOf('## Phase 6.5.1: What Not To Retry (forced-read, #623)');
    const nextIdx = body.indexOf('## Phase 6.5.2', stubIdx);
    expect(body.slice(stubIdx, nextIdx)).toContain('references/phase-6-5-forced-reads.md');
  });

  it('the Phase 6.5.1 region in the reference file is bounded by the 6.5.2 heading', () => {
    expect(idx651).toBeGreaterThan(-1);
    expect(idx652).toBeGreaterThan(idx651);
  });

  it('the surface block reads via readWhatNotToRetry', () => {
    expect(region).toContain('readWhatNotToRetry');
  });

  it('the surface block wraps content via wrapHistorical from the #621 SSOT module', () => {
    expect(region).toContain('wrapHistorical');
    expect(region).toContain('scripts/lib/historical-guard.mjs');
  });

  it('the guard (NOT LIVE INSTRUCTIONS) precedes the surfaced content in Phase 6.5.1', () => {
    // Guard must come BEFORE the content render (readWhatNotToRetry call) so a
    // reader cannot mistake a stale entry for a live instruction.
    const idxGuard = region.indexOf('NOT LIVE INSTRUCTIONS');
    const idxRead = region.indexOf('readWhatNotToRetry');
    expect(idxGuard).toBeGreaterThan(-1);
    expect(idxRead).toBeGreaterThan(-1);
    expect(idxGuard).toBeLessThan(idxRead);
  });

  it('embeds the byte-identical canonical guard banner literal', () => {
    expect(region).toContain(HISTORICAL_GUARD_BANNER);
  });

  it('documents the forced-read (always-render, no AUQ) behaviour', () => {
    expect(region).toMatch(/forced-read/i);
    expect(region).toMatch(/unconditional/i);
  });

  it('the Idle Reset section states What Not To Retry is PRESERVED through the reset', () => {
    // Phase 1.5 (incl. Idle Reset) moved to references/phase-1-5-session-continuity.md (#1157).
    const idxIdle = continuity.indexOf('### Idle Reset (completed-branch only)');
    const idxSnapshot = continuity.indexOf('### Snapshot Recovery (#196)', idxIdle);
    const idleRegion = continuity.slice(idxIdle, idxSnapshot);
    expect(idxIdle).toBeGreaterThan(-1);
    expect(idxSnapshot).toBeGreaterThan(idxIdle);
    expect(idleRegion).toContain('## What Not To Retry');
    expect(idleRegion).toMatch(/PRESERVE/);
    // The preservation rule explicitly contrasts with the cleared Deviations.
    expect(idleRegion).toMatch(/cross-session continuity/i);
  });
});

describe('What Not To Retry presentation slot (#623, presentation-format)', () => {
  it('presentation-format.md documents a What Not To Retry slot', () => {
    const body = readFileSync(PRESENTATION_PATH, 'utf8');
    expect(body).toContain('## What Not To Retry');
    expect(body).toMatch(/FORCED-READ/i);
  });
});
