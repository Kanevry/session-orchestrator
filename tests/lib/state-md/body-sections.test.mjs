import { describe, it, expect } from 'vitest';
import { parseStateMd } from '@lib/state-md/yaml-parser.mjs';
import {
  readCurrentTask,
  appendDeviation,
  markExpressPathComplete,
  appendWhatNotToRetry,
  readWhatNotToRetry,
  MAX_WHAT_NOT_TO_RETRY,
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

// ─── What Not To Retry (#623) ──────────────────────────────────────────────────

const WNTR_NO_SECTION = `---
schema-version: 1
status: active
updated: 2026-05-01T10:00:00Z
---

## Current Wave

Wave 1
`;

const WNTR_PLACEHOLDER = `---
schema-version: 1
status: active
updated: 2026-05-01T10:00:00Z
---

## Current Wave

Wave 1

## What Not To Retry

(none yet)

## Wave History
`;

const WNTR_WITH_ENTRY = `---
schema-version: 1
status: active
updated: 2026-05-01T10:00:00Z
---

## Current Wave

Wave 1

## What Not To Retry

- **Rewrite the parser from scratch** (deep-100, 2026-05-01)
  - why: blew the appetite, regressed 40 tests

## Wave History
`;

describe('appendWhatNotToRetry', () => {
  const ENTRY = {
    approach: 'Switch DB driver to pg-native',
    why_failed: 'native build fails on CI runners',
    session_id: 'deep-200',
    date: '2026-06-04',
  };

  it('creates the section when missing', () => {
    const out = appendWhatNotToRetry(WNTR_NO_SECTION, ENTRY);
    expect(out).toContain('## What Not To Retry');
    const currentWaveIdx = out.indexOf('## Current Wave');
    const wntrIdx = out.indexOf('## What Not To Retry');
    expect(wntrIdx).toBeGreaterThan(currentWaveIdx);
  });

  it('renders the exact head + why sub-bullet format', () => {
    const out = appendWhatNotToRetry(WNTR_NO_SECTION, ENTRY);
    expect(out).toContain('- **Switch DB driver to pg-native** (deep-200, 2026-06-04)');
    expect(out).toContain('  - why: native build fails on CI runners');
  });

  it('replaces the (none yet) placeholder', () => {
    const out = appendWhatNotToRetry(WNTR_PLACEHOLDER, ENTRY);
    expect(out).not.toContain('(none yet)');
    expect(out).toContain('- **Switch DB driver to pg-native** (deep-200, 2026-06-04)');
    expect(out).toContain('  - why: native build fails on CI runners');
  });

  it('appends after the last existing entry, before the next heading', () => {
    const out = appendWhatNotToRetry(WNTR_WITH_ENTRY, ENTRY);
    // First (existing) entry preserved.
    expect(out).toContain('- **Rewrite the parser from scratch** (deep-100, 2026-05-01)');
    expect(out).toContain('  - why: blew the appetite, regressed 40 tests');
    // New entry present.
    expect(out).toContain('- **Switch DB driver to pg-native** (deep-200, 2026-06-04)');
    // New entry appears AFTER the existing one and BEFORE ## Wave History.
    const existingIdx = out.indexOf('- **Rewrite the parser from scratch**');
    const newIdx = out.indexOf('- **Switch DB driver to pg-native**');
    const waveHistoryIdx = out.indexOf('## Wave History');
    expect(newIdx).toBeGreaterThan(existingIdx);
    expect(newIdx).toBeLessThan(waveHistoryIdx);
  });

  it('returns input unchanged on unparseable input', () => {
    const input = '# no frontmatter';
    expect(appendWhatNotToRetry(input, ENTRY)).toBe(input);
  });

  it('coerces missing fields to defaults', () => {
    const out = appendWhatNotToRetry(WNTR_NO_SECTION, {});
    expect(out).toContain('- **(unspecified approach)** (unknown-session,');
    expect(out).toContain('  - why: (no reason recorded)');
  });

  it('output is parseable by parseStateMd and preserves frontmatter', () => {
    const out = appendWhatNotToRetry(WNTR_NO_SECTION, ENTRY);
    const parsed = parseStateMd(out);
    expect(parsed).not.toBeNull();
    expect(parsed.frontmatter['schema-version']).toBe(1);
    expect(parsed.frontmatter.status).toBe('active');
  });

  it('caps the section to exactly 10 entries, dropping the oldest 2 (FIFO)', () => {
    let contents = WNTR_NO_SECTION;
    for (let n = 1; n <= 12; n++) {
      contents = appendWhatNotToRetry(contents, {
        approach: `approach-${n}`,
        why_failed: `reason-${n}`,
        session_id: 'deep-300',
        date: '2026-06-04',
      });
    }
    const entries = readWhatNotToRetry(contents);
    // Exactly 10 survive.
    expect(entries).toHaveLength(10);
    // Oldest two (approach-1, approach-2) dropped.
    const approaches = entries.map((e) => e.approach);
    expect(approaches).not.toContain('approach-1');
    expect(approaches).not.toContain('approach-2');
    // Most-recent (approach-12) kept; oldest survivor is approach-3.
    expect(approaches[0]).toBe('approach-3');
    expect(approaches[9]).toBe('approach-12');
    // Hard literal count of top-level bullets in the rendered section.
    const section = contents.slice(contents.indexOf('## What Not To Retry'));
    const topLevelBullets = section.split('\n').filter((l) => /^-\s+\*\*/.test(l));
    expect(topLevelBullets).toHaveLength(10);
  });

  it('MAX_WHAT_NOT_TO_RETRY constant is 10', () => {
    expect(MAX_WHAT_NOT_TO_RETRY).toBe(10);
  });

  it('round-trips: append → serialize → parse → readWhatNotToRetry returns all 4 fields', () => {
    const out = appendWhatNotToRetry(WNTR_NO_SECTION, ENTRY);
    const entries = readWhatNotToRetry(out);
    expect(entries).toEqual([
      {
        approach: 'Switch DB driver to pg-native',
        why_failed: 'native build fails on CI runners',
        session_id: 'deep-200',
        date: '2026-06-04',
      },
    ]);
  });

  it('collapses newlines in why_failed so the full reason round-trips without truncation (#623)', () => {
    // A multi-line why would previously lose everything after line 1 (the entry
    // is a single-line bullet and readWhatNotToRetry reads one line per field).
    const out = appendWhatNotToRetry(WNTR_NO_SECTION, {
      approach: 'Inline the retry loop',
      why_failed: 'first line of reason\nsecond line of reason\nthird line',
      session_id: 'deep-500',
      date: '2026-06-04',
    });
    // The rendered why bullet is single-line (no trailing-line bleed).
    expect(out).toContain('  - why: first line of reason second line of reason third line');
    const entries = readWhatNotToRetry(out);
    expect(entries).toEqual([
      {
        approach: 'Inline the retry loop',
        why_failed: 'first line of reason second line of reason third line',
        session_id: 'deep-500',
        date: '2026-06-04',
      },
    ]);
  });

  it('collapses newlines in approach so the head bullet round-trips without truncation (#623)', () => {
    const out = appendWhatNotToRetry(WNTR_NO_SECTION, {
      approach: 'Approach line one\nApproach line two',
      why_failed: 'single-line reason',
      session_id: 'deep-501',
      date: '2026-06-04',
    });
    expect(out).toContain('- **Approach line one Approach line two** (deep-501, 2026-06-04)');
    const entries = readWhatNotToRetry(out);
    expect(entries[0].approach).toBe('Approach line one Approach line two');
    expect(entries[0].why_failed).toBe('single-line reason');
  });
});

describe('readWhatNotToRetry', () => {
  it('returns [] when section is absent', () => {
    expect(readWhatNotToRetry(WNTR_NO_SECTION)).toEqual([]);
  });

  it('returns [] when section holds only the (none yet) placeholder', () => {
    expect(readWhatNotToRetry(WNTR_PLACEHOLDER)).toEqual([]);
  });

  it('returns [] on unparseable input', () => {
    expect(readWhatNotToRetry('# no frontmatter')).toEqual([]);
  });

  it('parses an existing entry with approach, session_id, date, and why_failed', () => {
    const entries = readWhatNotToRetry(WNTR_WITH_ENTRY);
    expect(entries).toEqual([
      {
        approach: 'Rewrite the parser from scratch',
        why_failed: 'blew the appetite, regressed 40 tests',
        session_id: 'deep-100',
        date: '2026-05-01',
      },
    ]);
  });

  it('parses an entry whose why sub-bullet is absent (why_failed empty)', () => {
    const noWhy = `---
status: active
---

## What Not To Retry

- **Approach with no why** (deep-400, 2026-06-04)

## Wave History
`;
    const entries = readWhatNotToRetry(noWhy);
    expect(entries).toEqual([
      {
        approach: 'Approach with no why',
        why_failed: '',
        session_id: 'deep-400',
        date: '2026-06-04',
      },
    ]);
  });
});
