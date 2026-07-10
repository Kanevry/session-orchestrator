/**
 * tests/skills/session-start/premise-check-wiring.test.mjs
 *
 * Regression guard for #730/H3 — Phase 7.1 Issue Premise Verification. Locks
 * the prose wiring so a future edit cannot silently drop the phase heading,
 * the cap, the verdict taxonomy, the sub-file reference row, or the
 * downstream session-plan consumption clause without failing a test.
 *
 * Mirrors tests/skills/session-start/what-not-to-retry-surface.test.mjs in
 * style (indexOf-bounded region extraction, REPO_ROOT resolution).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SKILL_PATH = path.join(REPO_ROOT, 'skills/session-start/SKILL.md');
const SUBFILE_PATH = path.join(REPO_ROOT, 'skills/session-start/phase-7-1-premise-check.md');
const SESSION_PLAN_PATH = path.join(REPO_ROOT, 'skills/session-plan/SKILL.md');

describe('Phase 7.1 Issue Premise Verification wiring (#730/H3, session-start SKILL.md)', () => {
  const body = readFileSync(SKILL_PATH, 'utf8');

  it('SKILL.md exists', () => {
    expect(existsSync(SKILL_PATH)).toBe(true);
  });

  it('Phase 7.1 heading sits between Phase 7 and Phase 7.5', () => {
    const idx7 = body.indexOf('## Phase 7: Research');
    const idx71 = body.indexOf('## Phase 7.1: Issue Premise Verification');
    const idx75 = body.indexOf('## Phase 7.5: Mode-Selector Pre-Pass');
    expect(idx7).toBeGreaterThan(-1);
    expect(idx71).toBeGreaterThan(-1);
    expect(idx75).toBeGreaterThan(-1);
    expect(idx7).toBeLessThan(idx71);
    expect(idx71).toBeLessThan(idx75);
  });

  it('the Phase 7.1 region documents the housekeeping skip', () => {
    const idx71 = body.indexOf('## Phase 7.1: Issue Premise Verification');
    const idx75 = body.indexOf('## Phase 7.5: Mode-Selector Pre-Pass', idx71);
    const region = body.slice(idx71, idx75);
    expect(region).toMatch(/Skip for `housekeeping` sessions/);
  });

  it('the Phase 7.1 region documents the 8-issue cap', () => {
    const idx71 = body.indexOf('## Phase 7.1: Issue Premise Verification');
    const idx75 = body.indexOf('## Phase 7.5: Mode-Selector Pre-Pass', idx71);
    const region = body.slice(idx71, idx75);
    expect(region).toMatch(/cap: 8 issues/);
  });

  it('the Phase 7.1 region names the emission block', () => {
    const idx71 = body.indexOf('## Phase 7.1: Issue Premise Verification');
    const idx75 = body.indexOf('## Phase 7.5: Mode-Selector Pre-Pass', idx71);
    const region = body.slice(idx71, idx75);
    expect(region).toContain('### Premise Verification Result (Phase 7.1)');
  });

  it('the Sub-File Reference table has a phase-7-1-premise-check.md row', () => {
    const idxTable = body.indexOf('## Sub-File Reference');
    expect(idxTable).toBeGreaterThan(-1);
    const region = body.slice(idxTable);
    expect(region).toContain('`phase-7-1-premise-check.md`');
  });
});

describe('Phase 7.1 sub-file (#730/H3, phase-7-1-premise-check.md)', () => {
  it('the sub-file exists', () => {
    expect(existsSync(SUBFILE_PATH)).toBe(true);
  });

  const body = readFileSync(SUBFILE_PATH, 'utf8');

  it.each(['SHIPPED', 'GAP', 'FALSCH-PRÄMISSE', 'UNVERIFIED'])(
    'documents the %s verdict',
    (verdict) => {
      expect(body).toContain(verdict);
    },
  );

  it('references the PSA-006 grep-verification discipline', () => {
    expect(body).toMatch(/PSA-006/);
  });
});

describe('Phase 7.1 downstream consumption (#730/H3, session-plan SKILL.md)', () => {
  it('session-plan SKILL.md references the Premise Verification Result emission block', () => {
    const body = readFileSync(SESSION_PLAN_PATH, 'utf8');
    expect(body).toContain('Premise Verification Result');
  });
});
