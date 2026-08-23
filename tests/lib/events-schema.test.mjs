/**
 * tests/lib/events-schema.test.mjs
 *
 * Unit tests for scripts/lib/events-schema.mjs — the canonical events.jsonl
 * schema + naming-convention validator (Track A, issue #609 / epic #608).
 *
 * Mostly pure. The two catalog-parity tests are NOT: they walk the repo and read
 * docs/events-schema.md, deliberately. The alternative — a hand-typed list of
 * event names — is what stood here until 2026-08-23, under a title claiming a
 * census it never performed, while 21 of the 31 emitted names sat outside it.
 * A parity test that does not read both sides is a parity test in name only.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isIso8601,
  validateEventRecord,
  ORCHESTRATOR_EVENT_RE,
} from '@lib/events-schema.mjs';

// CENSUS, not a list. The predecessor here was a hand-typed array of ten literals
// under the title "matches every orchestrator.* event the codebase emits" — a title
// that claimed a census it never performed. Measured 2026-08-23: the codebase emitted
// 31 distinct names, so 21 were outside the array the test iterated, and the green
// checkmark read as coverage. That is the exact defect class this repo keeps paying
// for, in the test that was supposed to guard against it.
//
// The recipe is code now for the same reason `.claude/rules/test-value.md` § TV-003
// made the tests:src ratio a script: a list a human maintains diverges from the thing
// it describes, and nothing says when.
//
// LOWER BOUND, stated because it matters: this only sees names written as string
// literals. A computed or template-literal event name is invisible to it. Adding one
// is therefore still a silent gap — the census narrows the hole, it does not close it.
const EVENT_SOURCE_DIRS = ['scripts', 'hooks', 'skills', 'commands', 'server'];

/** Every `orchestrator.*` string literal under EVENT_SOURCE_DIRS, deduped and sorted. */
function censusEmittedEventNames(repoRoot) {
  const names = new Set();
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // a source dir that does not exist in this checkout is not a failure
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'worktrees') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(mjs|js|cjs|ts|sh)$/.test(entry.name)) continue;
      const body = readFileSync(full, 'utf8');
      for (const m of body.matchAll(/['"`](orchestrator\.[a-z0-9_]+(?:\.[a-z0-9_]+)+)['"`]/g)) {
        names.add(m[1]);
      }
    }
  };
  for (const dir of EVENT_SOURCE_DIRS) walk(join(repoRoot, dir));
  return [...names].sort();
}

// Emitted names that carry NO row in docs/events-schema.md. This is a DEBT LIST and it
// is meant to shrink; it exists so the mechanism can land today without a
// twelve-event documentation marathon blocking it. Measured 2026-08-23 @ 34321bc.
// Adding a name here is a deliberate, reviewable act — which is the whole difference
// from the situation before, where an undocumented event needed no act at all.
const UNDOCUMENTED_EVENT_ALLOWLIST = new Set([
  'orchestrator.agent.dispatched',
  'orchestrator.config.protection_warning',
  'orchestrator.destructive_guard.blocked',
  'orchestrator.destructive_guard.warned',
  'orchestrator.frontend_slop.warning',
  'orchestrator.learnings.index.injected',
  'orchestrator.loop.warning',
  'orchestrator.memory.cleanup_completed',
  'orchestrator.session.lock.read_anomaly',
  'orchestrator.telemetry.flush',
]);

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EMITTED_ORCHESTRATOR_EVENTS = censusEmittedEventNames(REPO_ROOT);

/**
 * The catalog lists sibling verbs in shorthand — `orchestrator.wave.started` / `.completed`
 * on one row. A plain substring test therefore under-reports; this accepts either the
 * full name or the `.verb` shorthand on a line that also names the domain.
 */
function catalogMentions(catalog, name) {
  if (catalog.includes(name)) return true;
  const lastDot = name.lastIndexOf('.');
  const stem = name.slice(0, lastDot);
  const verb = name.slice(lastDot);
  return catalog.split('\n').some((line) => line.includes(stem) && line.includes(verb));
}

describe('isIso8601', () => {
  it('accepts an ISO-8601 UTC timestamp with milliseconds', () => {
    expect(isIso8601('2026-05-28T14:35:13.123Z')).toBe(true);
  });

  it('accepts an ISO-8601 UTC timestamp without milliseconds', () => {
    expect(isIso8601('2026-05-28T14:35:13Z')).toBe(true);
  });

  it('rejects a date-only string (no time, no Z)', () => {
    expect(isIso8601('2026-05-28')).toBe(false);
  });

  it('rejects a timestamp without the trailing Z', () => {
    expect(isIso8601('2026-05-28T14:35:13.123')).toBe(false);
  });

  it('rejects a non-string', () => {
    expect(isIso8601(1716900913000)).toBe(false);
  });

  it('rejects a regex-shaped string that is not a real date — Date.parse guard is load-bearing (#613)', () => {
    // "2026-13-45T99:99:99Z" matches the ISO_8601_RE shape (4-2-2 T 2:2:2 Z) but
    // is an impossible calendar instant (month 13, day 45, 99h99m99s). isIso8601
    // chains ISO_8601_RE.test(value) AND !Number.isNaN(Date.parse(value)). If the
    // second guard were removed (dead-code), this would WRONGLY return true.
    const impossible = '2026-13-45T99:99:99Z';
    // Premise check — confirm the input truly exercises the Date.parse branch:
    // Date.parse (the exact dependency the guard calls) yields NaN for this value.
    expect(Number.isNaN(Date.parse(impossible))).toBe(true);
    // Load-bearing assertion — must be rejected despite passing the regex shape.
    expect(isIso8601(impossible)).toBe(false);
  });
});

describe('ORCHESTRATOR_EVENT_RE', () => {
  it('matches every orchestrator.* event the codebase emits (census, not a list)', () => {
    // Guard the census itself: an empty result would make the assertion below vacuous,
    // which is precisely how the hand-typed predecessor stayed green while drifting.
    expect(EMITTED_ORCHESTRATOR_EVENTS.length).toBeGreaterThan(25);
    const nonMatching = EMITTED_ORCHESTRATOR_EVENTS.filter((e) => !ORCHESTRATOR_EVENT_RE.test(e));
    expect(nonMatching).toEqual([]);
  });

  it('documents every emitted orchestrator.* event in docs/events-schema.md', () => {
    const catalog = readFileSync(join(REPO_ROOT, 'docs', 'events-schema.md'), 'utf8');
    const undocumented = EMITTED_ORCHESTRATOR_EVENTS.filter(
      (name) => !UNDOCUMENTED_EVENT_ALLOWLIST.has(name) && !catalogMentions(catalog, name),
    );
    expect(undocumented).toEqual([]);
  });

  it('keeps the undocumented-event allowlist honest — no entry that is now documented', () => {
    // A debt list that keeps paid-off entries stops being a debt list. This is the
    // ratchet: documenting an event REQUIRES removing it here, or this goes red.
    const catalog = readFileSync(join(REPO_ROOT, 'docs', 'events-schema.md'), 'utf8');
    const stale = [...UNDOCUMENTED_EVENT_ALLOWLIST].filter((name) => catalogMentions(catalog, name));
    expect(stale).toEqual([]);
  });

  it('keeps the undocumented-event allowlist honest — no entry that is no longer emitted', () => {
    const emitted = new Set(EMITTED_ORCHESTRATOR_EVENTS);
    const phantom = [...UNDOCUMENTED_EVENT_ALLOWLIST].filter((name) => !emitted.has(name));
    expect(phantom).toEqual([]);
  });

  it('matches a four-segment name', () => {
    expect(ORCHESTRATOR_EVENT_RE.test('orchestrator.session.lock.acquired')).toBe(true);
  });

  it('allows underscores within a segment', () => {
    expect(ORCHESTRATOR_EVENT_RE.test('orchestrator.quality_gate.passed')).toBe(true);
  });

  it('rejects a two-segment name (domain without verb)', () => {
    expect(ORCHESTRATOR_EVENT_RE.test('orchestrator.session')).toBe(false);
  });

  it('rejects uppercase segments', () => {
    expect(ORCHESTRATOR_EVENT_RE.test('orchestrator.Session.Stopped')).toBe(false);
  });
});

describe('validateEventRecord — valid records', () => {
  it('accepts a canonical orchestrator record', () => {
    const result = validateEventRecord({
      timestamp: '2026-05-28T14:35:13.123Z',
      event: 'orchestrator.session.ended',
      session_id: 'sess-1',
      reason: 'clear',
      duration_ms: 4200,
    });
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it('accepts a non-orchestrator (third-party) dotted event as-is', () => {
    const result = validateEventRecord({
      timestamp: '2026-05-28T14:35:13Z',
      event: 'tmux-layout.invoked',
    });
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it('accepts a legacy bare event name (non-orchestrator namespace)', () => {
    const result = validateEventRecord({
      timestamp: '2026-05-28T14:35:13Z',
      event: 'grounding_injected',
    });
    expect(result).toEqual({ valid: true, errors: [] });
  });
});

describe('validateEventRecord — invalid records', () => {
  it('rejects a record missing the timestamp', () => {
    const result = validateEventRecord({ event: 'orchestrator.session.ended' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('timestamp must be an ISO-8601 UTC string ending in Z');
  });

  it('rejects a non-ISO timestamp', () => {
    const result = validateEventRecord({ timestamp: '2026-05-28', event: 'orchestrator.session.ended' });
    expect(result.valid).toBe(false);
  });

  it('rejects an empty event string', () => {
    const result = validateEventRecord({ timestamp: '2026-05-28T14:35:13Z', event: '' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('event must be a non-empty string');
  });

  it('rejects a malformed orchestrator-domain event name', () => {
    const result = validateEventRecord({
      timestamp: '2026-05-28T14:35:13Z',
      event: 'orchestrator.Session.Stopped',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('orchestrator.<domain>.<verb>'))).toBe(true);
  });

  it('rejects a two-segment orchestrator event (no verb)', () => {
    const result = validateEventRecord({
      timestamp: '2026-05-28T14:35:13Z',
      event: 'orchestrator.session',
    });
    expect(result.valid).toBe(false);
  });

  it('rejects null', () => {
    expect(validateEventRecord(null)).toEqual({ valid: false, errors: ['record must be a non-array object'] });
  });

  it('rejects an array', () => {
    expect(validateEventRecord([])).toEqual({ valid: false, errors: ['record must be a non-array object'] });
  });

  it('rejects a string', () => {
    expect(validateEventRecord('orchestrator.session.ended')).toEqual({
      valid: false,
      errors: ['record must be a non-array object'],
    });
  });
});

describe('validateEventRecord — #773 orchestrator.handover.gated', () => {
  it('accepts a handover.gated record carrying the full 8-field payload with path fail_open', () => {
    const result = validateEventRecord({
      timestamp: '2026-07-08T14:35:13.123Z',
      event: 'orchestrator.handover.gated',
      candidates_total: 5,
      auto_carry: 2,
      asked: 3,
      dropped: 0,
      questions_asked: 3,
      questions_answered: 2,
      questions_deferred: 1,
      path: 'fail_open',
    });
    // The dotted name is a well-formed orchestrator.<domain>.<verb>, and the
    // extra payload fields pass through untouched → valid with no errors.
    expect(result).toEqual({ valid: true, errors: [] });
  });
});
