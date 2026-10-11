/**
 * tests/lib/state-md/idle-reset.test.mjs — session-start Phase 1.5 Idle Reset (#1560).
 *
 * The chain test is the regression for #1560 itself: the reset used to delete
 * the five recommendation keys, so Phase 7.5's buildLiveSignals() found none
 * and selectMode() fell back to `feature` at confidence 0 after every clean
 * /close. The rule tests each pin a defect with a named consequence (#623,
 * #772, #898, live-state loss on a non-completed STATE.md).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetStateMdToIdle } from '@lib/state-md/idle-reset.mjs';
import { parseStateMd } from '@lib/state-md/yaml-parser.mjs';
import { buildLiveSignals } from '@lib/build-live-signals.mjs';
import { selectMode } from '@lib/mode-selector.mjs';

const COMPLETED = `---
schema-version: 1
session-type: deep
session: main-2026-10-11-session-7
status: completed
current-wave: 4
total-waves: 4
recommended-mode: housekeeping
top-priorities: [1560]
carryover-ratio: 0
completion-rate: 1
rationale: "v0: default clean completion"
scope-baseline-intent: "fix the selector"
scope-baseline-owner-boundary: "scripts/lib/state-md"
scope-baseline-planned-files: 4
scope-baseline-session: main-2026-10-11-session-7
scope-baseline-frozen-at: 2026-10-11T10:00:00.000Z
custom-extension: keep-me
---

# STATE — main-2026-10-11-session-7

## Current Wave

Wave 4 — Finalization

## Wave History

- W1 Discovery: mapped the reset
- W2 Impl: wrote the module

## Deviations

- [2026-10-11T10:00Z] scope narrowed

## Open Questions
- Owner: merge !126? (open)
- Answered already — yes

## What Not To Retry
- Never patch the selector instead of the reset.

## Previous Session

### Wave History (main-2026-10-10-session-3)
- older record that the new archive replaces
`;

/** The raw text of one `## <title>` section, up to the next `## ` heading. */
function section(contents, title) {
  return new RegExp(`## ${title}\\n[\\s\\S]*?(?=\\n## |$)`).exec(contents)?.[0];
}

let sandbox;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'so-idle-reset-'));
  vi.stubEnv('SO_PLATFORM', 'claude');
  vi.stubEnv('SO_STATE_DIR', '');
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('resetStateMdToIdle → buildLiveSignals → selectMode (#1560)', () => {
  it('keeps the previous recommendation readable for the Phase 7.5 Mode-Selector', async () => {
    const { changed, contents } = resetStateMdToIdle(COMPLETED);
    expect(changed).toBe(true);
    mkdirSync(join(sandbox, '.claude'), { recursive: true });
    writeFileSync(join(sandbox, '.claude', 'STATE.md'), contents, 'utf8');

    const signals = await buildLiveSignals({ repoRoot: sandbox, _scanBacklog: async () => null });
    const rec = selectMode(signals);

    expect(signals.recommendedMode).toBe('housekeeping');
    expect(signals.completionRate).toBe(1);
    expect(signals.carryoverRatio).toBe(0);
    expect(rec.confidence).toBeGreaterThan(0);
  });
});

describe('resetStateMdToIdle rules', () => {
  it('applies rules 1-7: idle, wave 0, history demoted, deviations emptied, continuity slots and other keys kept', () => {
    const before = parseStateMd(COMPLETED).frontmatter;
    const { contents } = resetStateMdToIdle(COMPLETED);
    const after = parseStateMd(contents);

    // Rules 1, 2, 5, 6, 7: exactly the five scope-baseline keys leave; nothing else.
    const scopeKeys = Object.keys(before).filter((k) => k.startsWith('scope-baseline-'));
    expect(scopeKeys).toHaveLength(5);
    const expected = { ...before, status: 'idle', 'current-wave': 0 };
    for (const k of scopeKeys) delete expected[k];
    expect(after.frontmatter).toEqual(expected);

    // Rule 4: continuity slots byte-for-byte (#623, #772); Deviations heading only.
    expect(section(contents, 'What Not To Retry')).toBe(section(COMPLETED, 'What Not To Retry'));
    expect(section(contents, 'Open Questions')).toBe(section(COMPLETED, 'Open Questions'));
    expect(section(contents, 'Deviations')).toBe('## Deviations\n');

    // Rules 3 + 6: Wave History demoted under a fresh Previous Session that replaces the old one.
    expect(contents).not.toMatch(/^## Wave History/m);
    expect(contents).not.toContain('older record');
    expect(section(contents, 'Previous Session')).toBe(
      [
        '## Previous Session',
        '',
        '### Recommendations (archived from v1.1 frontmatter)',
        '- **Recommended mode:** housekeeping',
        '- **Rationale:** v0: default clean completion',
        '- **Completion rate:** 100%',
        '- **Carryover ratio:** 0%',
        '- **Top priorities:** #1560',
        '',
        '### Wave History (main-2026-10-11-session-7)',
        '- W1 Discovery: mapped the reset',
        '- W2 Impl: wrote the module',
        '',
      ].join('\n'),
    );
  });

  // A coordinator-direct close writes recommendations but no Wave History: the
  // earlier archive must survive below them (its old recommendations copy is
  // superseded), and `## Wave History Archive` is a section of its own.
  it('keeps the earlier archive when there is no new Wave History', () => {
    const input = COMPLETED.replace(
      '## Wave History\n\n- W1 Discovery: mapped the reset\n- W2 Impl: wrote the module\n',
      '## Wave History Archive\n\n- kept in place\n',
    ).replace(
      '## Previous Session\n',
      '## Previous Session\n\n### Recommendations (archived from v1.1 frontmatter)\n- **Recommended mode:** deep\n',
    );
    const { contents } = resetStateMdToIdle(input);

    expect(section(contents, 'Wave History Archive')).toBe('## Wave History Archive\n\n- kept in place\n');
    expect(section(contents, 'Previous Session')).toBe(
      [
        '## Previous Session',
        '',
        '### Recommendations (archived from v1.1 frontmatter)',
        '- **Recommended mode:** housekeeping',
        '- **Rationale:** v0: default clean completion',
        '- **Completion rate:** 100%',
        '- **Carryover ratio:** 0%',
        '- **Top priorities:** #1560',
        '',
        '### Wave History (main-2026-10-10-session-3)',
        '- older record that the new archive replaces',
        '',
      ].join('\n'),
    );
  });

  it.each([
    ['active', COMPLETED.replace('status: completed', 'status: active'), 'status-not-completed'],
    ['paused', COMPLETED.replace('status: completed', 'status: paused'), 'status-not-completed'],
    ['no frontmatter', '# just a body\n', 'unparseable'],
  ])('leaves a %s STATE.md untouched', (_label, input, reason) => {
    expect(resetStateMdToIdle(input)).toEqual({ changed: false, contents: input, reason });
  });
});
