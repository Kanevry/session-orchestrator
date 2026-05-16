import { describe, it, expect } from 'vitest';
import { parseStateMd } from '@lib/state-md/yaml-parser.mjs';
import {
  readCurrentTask,
  appendDeviation,
  markExpressPathComplete,
} from '@lib/state-md/body-sections.mjs';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const WITH_WAVE = `---
schema-version: 1
status: active
updated: 2026-05-01T10:00:00Z
---

## Current Wave

Wave 3 — Impl-Core

## Wave History

### Wave 1 — Discovery
`;

const IDLE_STATE = `---
status: idle
---

## Current Wave

(idle — no active session)
`;

const WITH_DEVIATIONS = `---
schema-version: 1
status: active
updated: 2026-05-01T10:00:00Z
---

## Current Wave

Wave 1 — Discovery

## Deviations

- [2026-05-01T09:00:00Z] First deviation
- [2026-05-01T09:30:00Z] Second deviation

## Wave History
`;

const WITH_PLACEHOLDER = `---
schema-version: 1
status: active
updated: 2026-05-01T10:00:00Z
---

## Current Wave

Wave 1

## Deviations

(none yet)

## Wave History
`;

const NO_DEVIATIONS_SECTION = `---
schema-version: 1
status: active
updated: 2026-05-01T10:00:00Z
---

## Current Wave

Wave 1
`;

const ACTIVE_FOR_MARK = `---
schema-version: 1
session-type: housekeeping
status: active
updated: 2026-05-01T10:00:00Z
---

## Current Wave

Wave 1 — Express Path

## Deviations

- [2026-05-01T09:00:00Z] Initial scope adjustment
`;

// ─── readCurrentTask ─────────────────────────────────────────────────────────

describe('readCurrentTask', () => {
  it('extracts wave number and description when Current Wave section present', () => {
    const task = readCurrentTask(WITH_WAVE);
    expect(task).toEqual({ waveNumber: 3, description: 'Wave 3 — Impl-Core' });
  });

  it('returns waveNumber: null for descriptions not starting with Wave <number>', () => {
    const task = readCurrentTask(IDLE_STATE);
    expect(task).toEqual({ waveNumber: null, description: '(idle — no active session)' });
  });

  it('returns null when Current Wave section is absent', () => {
    const noSection = '---\nstatus: active\n---\n\n## Wave History\n';
    expect(readCurrentTask(noSection)).toBeNull();
  });

  it('returns null when STATE.md has no frontmatter', () => {
    expect(readCurrentTask('# plain markdown')).toBeNull();
  });

  it('returns null when Current Wave section heading exists but body is end-of-file', () => {
    // When the section ends immediately at EOF (no lines follow the heading),
    // readCurrentTask returns null because there is no first non-blank line.
    const eof = `---
status: active
---

## Current Wave
`;
    expect(readCurrentTask(eof)).toBeNull();
  });

  it('handles wave description with only Wave prefix (no description suffix)', () => {
    const simple = `---
status: active
---

## Current Wave

Wave 2
`;
    const task = readCurrentTask(simple);
    expect(task).toEqual({ waveNumber: 2, description: 'Wave 2' });
  });
});

// ─── appendDeviation ─────────────────────────────────────────────────────────

describe('appendDeviation', () => {
  it('appends to existing Deviations section after last bullet', () => {
    const out = appendDeviation(WITH_DEVIATIONS, '2026-05-01T11:00:00Z', 'Third deviation');
    expect(out).toContain('- [2026-05-01T09:00:00Z] First deviation');
    expect(out).toContain('- [2026-05-01T09:30:00Z] Second deviation');
    expect(out).toContain('- [2026-05-01T11:00:00Z] Third deviation');
    // New bullet must appear after second bullet, before ## Wave History
    const newIdx = out.indexOf('- [2026-05-01T11:00:00Z]');
    const secondIdx = out.indexOf('- [2026-05-01T09:30:00Z]');
    const waveHistoryIdx = out.indexOf('## Wave History');
    expect(newIdx).toBeGreaterThan(secondIdx);
    expect(newIdx).toBeLessThan(waveHistoryIdx);
  });

  it('replaces (none yet) placeholder', () => {
    const out = appendDeviation(WITH_PLACEHOLDER, '2026-05-01T11:00:00Z', 'First real deviation');
    expect(out).not.toContain('(none yet)');
    expect(out).toContain('- [2026-05-01T11:00:00Z] First real deviation');
  });

  it('creates Deviations section when missing', () => {
    const out = appendDeviation(NO_DEVIATIONS_SECTION, '2026-05-01T11:00:00Z', 'Brand new deviation');
    expect(out).toContain('## Deviations');
    expect(out).toContain('- [2026-05-01T11:00:00Z] Brand new deviation');
    const currentWaveIdx = out.indexOf('## Current Wave');
    const deviationsIdx = out.indexOf('## Deviations');
    expect(deviationsIdx).toBeGreaterThan(currentWaveIdx);
  });

  it('returns input unchanged on unparseable input', () => {
    const input = '# no frontmatter';
    expect(appendDeviation(input, '2026-05-01T11:00:00Z', 'x')).toBe(input);
  });

  it('bullet format is "- [timestamp] message"', () => {
    const out = appendDeviation(NO_DEVIATIONS_SECTION, '2026-05-01T11:00:00Z', 'My message');
    expect(out).toContain('- [2026-05-01T11:00:00Z] My message');
  });

  it('newly created section is parseable by parseStateMd', () => {
    const out = appendDeviation(NO_DEVIATIONS_SECTION, '2026-05-01T11:00:00Z', 'check');
    expect(parseStateMd(out)).not.toBeNull();
  });

  it('appended section preserves existing frontmatter', () => {
    const out = appendDeviation(NO_DEVIATIONS_SECTION, '2026-05-01T11:00:00Z', 'check');
    const parsed = parseStateMd(out);
    expect(parsed.frontmatter['schema-version']).toBe(1);
    expect(parsed.frontmatter.status).toBe('active');
  });
});

// ─── markExpressPathComplete ──────────────────────────────────────────────────

describe('markExpressPathComplete', () => {
  it('sets status to completed', () => {
    const out = markExpressPathComplete(ACTIVE_FOR_MARK, {
      taskCount: 3,
      sessionType: 'housekeeping',
      expressPathEnabled: true,
      timestamp: '2026-05-01T12:00:00Z',
    });
    const parsed = parseStateMd(out);
    expect(parsed.frontmatter.status).toBe('completed');
  });

  it('sets updated to the provided timestamp', () => {
    const out = markExpressPathComplete(ACTIVE_FOR_MARK, {
      taskCount: 3,
      timestamp: '2026-05-01T12:00:00Z',
    });
    const parsed = parseStateMd(out);
    expect(parsed.frontmatter.updated).toBe('2026-05-01T12:00:00Z');
  });

  it('appends Express path deviation with correct format', () => {
    const out = markExpressPathComplete(ACTIVE_FOR_MARK, {
      taskCount: 3,
      sessionType: 'housekeeping',
      expressPathEnabled: true,
      timestamp: '2026-05-01T12:00:00Z',
    });
    expect(out).toContain(
      '- [2026-05-01T12:00:00Z] Express path: 3 tasks executed coord-direct (express-path.enabled: true, session-type: housekeeping, scope: 3 issues)',
    );
  });

  it('preserves pre-existing deviations', () => {
    const out = markExpressPathComplete(ACTIVE_FOR_MARK, {
      taskCount: 3,
      timestamp: '2026-05-01T12:00:00Z',
    });
    expect(out).toContain('- [2026-05-01T09:00:00Z] Initial scope adjustment');
  });

  it('returns input unchanged on unparseable input', () => {
    const input = 'plain markdown, no frontmatter';
    const out = markExpressPathComplete(input, { taskCount: 1, timestamp: '2026-05-01T12:00:00Z' });
    expect(out).toBe(input);
  });

  it('defaults sessionType to housekeeping when not provided', () => {
    const out = markExpressPathComplete(ACTIVE_FOR_MARK, {
      taskCount: 2,
      timestamp: '2026-05-01T12:00:00Z',
    });
    expect(out).toContain('session-type: housekeeping');
  });

  it('defaults expressPathEnabled to true when not provided', () => {
    const out = markExpressPathComplete(ACTIVE_FOR_MARK, {
      taskCount: 2,
      timestamp: '2026-05-01T12:00:00Z',
    });
    expect(out).toContain('express-path.enabled: true');
  });

  it('result is parseable by parseStateMd (output integrity)', () => {
    const out = markExpressPathComplete(ACTIVE_FOR_MARK, {
      taskCount: 5,
      timestamp: '2026-05-01T12:00:00Z',
    });
    expect(parseStateMd(out)).not.toBeNull();
  });
});
