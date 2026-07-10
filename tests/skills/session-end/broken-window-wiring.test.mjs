/**
 * tests/skills/session-end/broken-window-wiring.test.mjs
 *
 * Regression: #730/H5 "Broken-Window Budget" — session-end Phase 2.6 is a
 * skill-prose procedure (not directly-executable JS). The AUQ/aggregation logic
 * lives in SKILL.md prose that references `.mjs` function names, Session Config
 * keys, and emitted event names by literal string. A rename in the libs, a
 * dropped Gate-condition, or a hyphenated event-name typo would silently break
 * the prose with no test catching it — the prose is never executed.
 *
 * Mirrors tests/skills/session-end/what-not-to-retry-wiring.test.mjs (read the
 * SKILL.md, slice the phase region, assert prose anchors) and the load-bearing
 * "symbols are ACTUALLY exported" guard from handover-gate-wiring.test.mjs.
 *
 * T3 additionally validates the two NEW event names against the real
 * events-schema regex — a hyphenated typo (`orchestrator.broken-window.filed`)
 * would be REJECTED by the schema, so the underscore convention is load-bearing.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBrokenWindowIssue } from '../../../scripts/lib/spiral-carryover.mjs';
import {
  ORCHESTRATOR_EVENT_RE,
  validateEventRecord,
} from '../../../scripts/lib/events-schema.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SESSION_END_PATH = path.join(REPO_ROOT, 'skills/session-end/SKILL.md');
const METRICS_PATH = path.join(REPO_ROOT, 'skills/session-end/metrics-collection.md');

describe('Broken-Window Budget prose↔code wiring (#730/H5, session-end)', () => {
  const body = readFileSync(SESSION_END_PATH, 'utf8');

  // Phase 2.6 region = from its heading to the next H2 (## Phase 3).
  const idx26 = body.indexOf('## Phase 2.6: Broken-Window Budget');
  const idx3 = body.indexOf('## Phase 3: Documentation Updates', idx26);
  const region = body.slice(idx26, idx3);

  it('skills/session-end/SKILL.md exists at the expected path', () => {
    expect(existsSync(SESSION_END_PATH)).toBe(true);
  });

  it('the Phase 2.6 region is bounded: heading precedes the ## Phase 3 heading', () => {
    expect(idx26).toBeGreaterThan(-1);
    expect(idx3).toBeGreaterThan(idx26);
  });

  // (a) heading
  it('contains the "## Phase 2.6: Broken-Window Budget" heading', () => {
    expect(body).toContain('## Phase 2.6: Broken-Window Budget');
  });

  // (b) function + module reference
  it('the Phase 2.6 region references createBrokenWindowIssue', () => {
    expect(region).toContain('createBrokenWindowIssue');
  });

  it('the Phase 2.6 region references scripts/lib/spiral-carryover.mjs', () => {
    expect(region).toContain('scripts/lib/spiral-carryover.mjs');
  });

  // (c) event-name underscore form + hyphen anti-regression
  it('the Phase 2.6 region emits the underscore event-name orchestrator.broken_window.filed', () => {
    expect(region).toContain('orchestrator.broken_window.filed');
  });

  it('the Phase 2.6 region NEVER uses the hyphenated event form orchestrator.broken-window (anti-regression)', () => {
    // A hyphen after "broken" would be a typo the events-schema regex rejects
    // (see the T3 block below). This guard bites if the prose regresses to it.
    expect(region).not.toMatch(/orchestrator\.broken-window/);
  });

  // (e) Gate condition
  it('the Phase 2.6 region names the gate condition broken-window-budget.enabled', () => {
    expect(region).toContain('broken-window-budget.enabled');
  });

  // (d) override event at >= 3 sites (Phase 1.8, 2.3, 2.5)
  it('the SKILL.md emits orchestrator.finding.overridden at >= 3 override sites', () => {
    const matches = body.match(/orchestrator\.finding\.overridden/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it('the override event is wired at each of Phase 1.8, 2.3, and 2.5 (phase-tagged payloads)', () => {
    // Each emit tags its originating phase in the payload — assert all three.
    expect(body).toContain('"phase":"1.8"');
    expect(body).toContain('"phase":"2.3"');
    expect(body).toContain('"phase":"2.5"');
  });
});

// ---------------------------------------------------------------------------
// (f) metrics-collection.md carries the three new effectiveness fields
// ---------------------------------------------------------------------------

describe('Broken-Window metrics fields (#730/H4+H5, metrics-collection.md)', () => {
  const metrics = readFileSync(METRICS_PATH, 'utf8');

  it('skills/session-end/metrics-collection.md exists at the expected path', () => {
    expect(existsSync(METRICS_PATH)).toBe(true);
  });

  it('documents the override_ratio effectiveness field', () => {
    expect(metrics).toContain('override_ratio');
  });

  it('documents the over_delivery_ratio per-wave field', () => {
    expect(metrics).toContain('over_delivery_ratio');
  });

  it('documents the planned_files_count per-wave field', () => {
    expect(metrics).toContain('planned_files_count');
  });
});

// ---------------------------------------------------------------------------
// load-bearing guard: the prose-referenced symbol is ACTUALLY exported
// ---------------------------------------------------------------------------

describe('load-bearing export guard (#730/H5)', () => {
  it('createBrokenWindowIssue is exported from scripts/lib/spiral-carryover.mjs as a function', () => {
    expect(typeof createBrokenWindowIssue).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// T3 — mechanical event-name validation against the real events-schema regex
// ---------------------------------------------------------------------------

describe('event-name schema validation (#730/H5)', () => {
  it('orchestrator.broken_window.filed matches the orchestrator event regex', () => {
    expect(ORCHESTRATOR_EVENT_RE.test('orchestrator.broken_window.filed')).toBe(true);
  });

  it('orchestrator.finding.overridden matches the orchestrator event regex', () => {
    expect(ORCHESTRATOR_EVENT_RE.test('orchestrator.finding.overridden')).toBe(true);
  });

  it('the hyphenated form orchestrator.broken-window.filed is REJECTED by the regex', () => {
    // This is WHY the underscore convention is load-bearing — the schema
    // rejects a hyphen inside a domain segment.
    expect(ORCHESTRATOR_EVENT_RE.test('orchestrator.broken-window.filed')).toBe(false);
  });

  it('validateEventRecord accepts a well-formed broken_window.filed record', () => {
    const record = {
      timestamp: '2026-07-10T12:00:00.000Z',
      event: 'orchestrator.broken_window.filed',
      source: '2.0a',
      issue: 42,
      due: '2026-07-17',
    };
    expect(validateEventRecord(record)).toEqual({ valid: true, errors: [] });
  });

  it('validateEventRecord accepts a well-formed finding.overridden record', () => {
    const record = {
      timestamp: '2026-07-10T12:00:00.000Z',
      event: 'orchestrator.finding.overridden',
      phase: '1.8',
      kind: 'med-low-review-finding',
      count: 2,
    };
    expect(validateEventRecord(record)).toEqual({ valid: true, errors: [] });
  });

  it('validateEventRecord REJECTS the hyphenated broken-window.filed event name', () => {
    const record = {
      timestamp: '2026-07-10T12:00:00.000Z',
      event: 'orchestrator.broken-window.filed',
    };
    const result = validateEventRecord(record);
    expect(result.valid).toBe(false);
  });
});
