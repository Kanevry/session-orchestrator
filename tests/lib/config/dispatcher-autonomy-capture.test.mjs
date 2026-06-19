/**
 * dispatcher-autonomy-capture.test.mjs — Unit tests for
 * scripts/lib/config/dispatcher-autonomy-capture.mjs (Epic #673, issue #681).
 *
 * Covers the four exported helpers:
 *  - getDispatcherAutonomyQuestion: AUQ shape contract.
 *  - isDispatcherAutonomyBlockPresent: presence guard + DELIBERATE edge cases
 *    (CRLF, trailing-space, fence, BOM, malformed body) + no-throw guards.
 *  - renderDispatcherAutonomyBlock: enum validation, confidence-floor clamping,
 *    structural contract.
 *  - writeDispatcherAutonomyBlock: append-when-absent, idempotent no-op when
 *    present, IO-failure no-throw, malformed-block no-op.
 *
 * Plus a round-trip test feeding renderDispatcherAutonomyBlock's output into the
 * parser (_parseDispatcherAutonomy) to prove writer/parser contract compatibility.
 *
 * Portability: every tmp file lives under os.tmpdir() via path.join — no hardcoded
 * home or absolute paths (owner-leakage hook compliance).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getDispatcherAutonomyQuestion,
  isDispatcherAutonomyBlockPresent,
  renderDispatcherAutonomyBlock,
  writeDispatcherAutonomyBlock,
} from '../../../scripts/lib/config/dispatcher-autonomy-capture.mjs';

import { _parseDispatcherAutonomy } from '../../../scripts/lib/config/dispatcher-autonomy.mjs';

// ---------------------------------------------------------------------------
// getDispatcherAutonomyQuestion — AUQ shape contract
// ---------------------------------------------------------------------------

describe('getDispatcherAutonomyQuestion — AUQ shape', () => {
  it('exposes exactly 3 options', () => {
    expect(getDispatcherAutonomyQuestion().options).toHaveLength(3);
  });

  it('sets multiSelect to false', () => {
    expect(getDispatcherAutonomyQuestion().multiSelect).toBe(false);
  });

  it('orders option labels as the enum off → advisory → autonomous-gated', () => {
    const labels = getDispatcherAutonomyQuestion().options.map((o) => o.label);
    expect(labels).toEqual(['off', 'advisory', 'autonomous-gated']);
  });

  it('makes option 1 the off (recommended fail-closed) default', () => {
    expect(getDispatcherAutonomyQuestion().options[0].label).toBe('off');
  });

  it('marks the off option description as Recommended', () => {
    expect(getDispatcherAutonomyQuestion().options[0].description).toContain('(Recommended)');
  });

  it('gives every option a non-empty description string', () => {
    const descs = getDispatcherAutonomyQuestion().options.map((o) => o.description);
    expect(descs.every((d) => typeof d === 'string' && d.length > 0)).toBe(true);
  });

  it('provides a non-empty question and header', () => {
    const q = getDispatcherAutonomyQuestion();
    expect(q.question.length).toBeGreaterThan(0);
    expect(q.header).toBe('Dispatcher Autonomy (one-time)');
  });
});

// ---------------------------------------------------------------------------
// isDispatcherAutonomyBlockPresent — no-throw guards
// ---------------------------------------------------------------------------

describe('isDispatcherAutonomyBlockPresent — no-throw guards', () => {
  it('returns false for null', () => {
    expect(isDispatcherAutonomyBlockPresent(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isDispatcherAutonomyBlockPresent(undefined)).toBe(false);
  });

  it('returns false for a number', () => {
    expect(isDispatcherAutonomyBlockPresent(42)).toBe(false);
  });

  it('returns false for an object', () => {
    expect(isDispatcherAutonomyBlockPresent({ 'dispatcher-autonomy': true })).toBe(false);
  });

  it('returns false for the empty string', () => {
    expect(isDispatcherAutonomyBlockPresent('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isDispatcherAutonomyBlockPresent — presence detection
// ---------------------------------------------------------------------------

describe('isDispatcherAutonomyBlockPresent — presence detection', () => {
  it('returns true for a plain column-0 header on its own line', () => {
    expect(isDispatcherAutonomyBlockPresent('# Title\n\ndispatcher-autonomy:\n  autonomy: off\n')).toBe(true);
  });

  it('returns false when no dispatcher-autonomy header is present', () => {
    expect(isDispatcherAutonomyBlockPresent('# Title\n\nskill-evolution:\n  autonomy: off\n')).toBe(false);
  });

  it('returns false when the header is indented (not at column 0)', () => {
    expect(isDispatcherAutonomyBlockPresent('  dispatcher-autonomy:\n')).toBe(false);
  });

  it('returns false when the header has trailing non-whitespace content', () => {
    expect(isDispatcherAutonomyBlockPresent('dispatcher-autonomy: off\n')).toBe(false);
  });

  it('returns false for a substring that is not a standalone header line', () => {
    expect(isDispatcherAutonomyBlockPresent('see dispatcher-autonomy: in the docs\n')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isDispatcherAutonomyBlockPresent — DELIBERATE edge cases (per module JSDoc)
// ---------------------------------------------------------------------------

describe('isDispatcherAutonomyBlockPresent — deliberate edge cases', () => {
  it('treats a CRLF-terminated header as PRESENT', () => {
    expect(isDispatcherAutonomyBlockPresent('dispatcher-autonomy:\r\n  autonomy: off\r\n')).toBe(true);
  });

  it('treats a trailing-space header as PRESENT', () => {
    expect(isDispatcherAutonomyBlockPresent('dispatcher-autonomy:   \n')).toBe(true);
  });

  it('treats a trailing-tab header as PRESENT', () => {
    expect(isDispatcherAutonomyBlockPresent('dispatcher-autonomy:\t\n')).toBe(true);
  });

  it('treats a header inside a fenced code block as PRESENT (parser does not track fences)', () => {
    expect(isDispatcherAutonomyBlockPresent('```yaml\ndispatcher-autonomy:\n  autonomy: off\n```\n')).toBe(true);
  });

  it('treats a BOM glued immediately before the header as ABSENT (^ needs column 0)', () => {
    expect(isDispatcherAutonomyBlockPresent('\uFEFFdispatcher-autonomy:\n  autonomy: off\n')).toBe(false);
  });

  it('treats a header with a malformed (garbage) body as PRESENT', () => {
    expect(isDispatcherAutonomyBlockPresent('dispatcher-autonomy:\n  !!! not yaml @@@\n')).toBe(true);
  });

  it('treats a BOM at file start with the header on a later line as PRESENT', () => {
    expect(isDispatcherAutonomyBlockPresent('\uFEFF# Title\n\ndispatcher-autonomy:\n  autonomy: off\n')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// renderDispatcherAutonomyBlock — structural contract
// ---------------------------------------------------------------------------

describe('renderDispatcherAutonomyBlock — structure', () => {
  it('renders the standalone H2 heading', () => {
    expect(renderDispatcherAutonomyBlock({ autonomy: 'off' })).toContain('## Dispatcher Autonomy');
  });

  it('renders a fenced yaml block containing the dispatcher-autonomy: key', () => {
    const block = renderDispatcherAutonomyBlock({ autonomy: 'off' });
    expect(block).toContain('```yaml');
    expect(block).toContain('dispatcher-autonomy:');
  });

  it('output is recognised as present by the presence guard', () => {
    expect(isDispatcherAutonomyBlockPresent(renderDispatcherAutonomyBlock({ autonomy: 'advisory' }))).toBe(true);
  });

  it('begins and ends with a newline for clean appending', () => {
    const block = renderDispatcherAutonomyBlock({ autonomy: 'off' });
    expect(block.startsWith('\n')).toBe(true);
    expect(block.endsWith('\n')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// renderDispatcherAutonomyBlock — autonomy enum validation
// ---------------------------------------------------------------------------

describe('renderDispatcherAutonomyBlock — autonomy enum', () => {
  it('renders autonomy: off when given off', () => {
    expect(renderDispatcherAutonomyBlock({ autonomy: 'off' })).toContain('autonomy: off');
  });

  it('renders autonomy: advisory when given advisory', () => {
    expect(renderDispatcherAutonomyBlock({ autonomy: 'advisory' })).toContain('autonomy: advisory');
  });

  it('renders autonomy: autonomous-gated when given autonomous-gated', () => {
    expect(renderDispatcherAutonomyBlock({ autonomy: 'autonomous-gated' })).toContain('autonomy: autonomous-gated');
  });

  it('lowercases a mixed-case enum value', () => {
    expect(renderDispatcherAutonomyBlock({ autonomy: 'ADVISORY' })).toContain('autonomy: advisory');
  });

  it('falls back to autonomy: off for an unknown enum value', () => {
    expect(renderDispatcherAutonomyBlock({ autonomy: 'turbo' })).toContain('autonomy: off');
  });

  it('falls back to autonomy: off when autonomy is omitted', () => {
    expect(renderDispatcherAutonomyBlock({})).toContain('autonomy: off');
  });

  it('falls back to autonomy: off when called with no arguments', () => {
    expect(renderDispatcherAutonomyBlock()).toContain('autonomy: off');
  });

  it('falls back to autonomy: off for null autonomy', () => {
    expect(renderDispatcherAutonomyBlock({ autonomy: null })).toContain('autonomy: off');
  });
});

// ---------------------------------------------------------------------------
// renderDispatcherAutonomyBlock — confidence-floor clamping
// ---------------------------------------------------------------------------

describe('renderDispatcherAutonomyBlock — confidence-floor clamp', () => {
  // The rendered yaml line is `  confidence-floor: <value>    # float 0.0..1.0`.
  // Assertions match the value followed by the trailing-space+comment boundary so
  // a substring like `0` cannot pass for a rendered `0.7`, and `1` cannot pass for
  // a rendered `1.5` — this is what makes the clamp assertions falsifiable.
  const floorLine = (v) => `confidence-floor: ${v}    #`;

  it('renders confidence-floor: 0.5 by default', () => {
    expect(renderDispatcherAutonomyBlock({ autonomy: 'off' })).toContain(floorLine('0.5'));
  });

  it('renders an in-range floor verbatim', () => {
    expect(renderDispatcherAutonomyBlock({ autonomy: 'off', confidenceFloor: 0.7 })).toContain(floorLine('0.7'));
  });

  it('clamps a floor above 1 down to 1', () => {
    expect(renderDispatcherAutonomyBlock({ autonomy: 'off', confidenceFloor: 1.5 })).toContain(floorLine('1'));
  });

  it('does not render the pre-clamp value for an above-1 floor', () => {
    expect(renderDispatcherAutonomyBlock({ autonomy: 'off', confidenceFloor: 1.5 })).not.toContain(floorLine('1.5'));
  });

  it('clamps a negative floor up to 0', () => {
    expect(renderDispatcherAutonomyBlock({ autonomy: 'off', confidenceFloor: -0.3 })).toContain(floorLine('0'));
  });

  it('does not render the pre-clamp value for a negative floor', () => {
    expect(renderDispatcherAutonomyBlock({ autonomy: 'off', confidenceFloor: -0.3 })).not.toContain(floorLine('-0.3'));
  });

  it('renders the boundary value 0 unchanged', () => {
    expect(renderDispatcherAutonomyBlock({ autonomy: 'off', confidenceFloor: 0 })).toContain(floorLine('0'));
  });

  it('renders the boundary value 1 unchanged', () => {
    expect(renderDispatcherAutonomyBlock({ autonomy: 'off', confidenceFloor: 1 })).toContain(floorLine('1'));
  });

  it('falls back to 0.5 for a non-finite floor (NaN)', () => {
    expect(renderDispatcherAutonomyBlock({ autonomy: 'off', confidenceFloor: NaN })).toContain(floorLine('0.5'));
  });

  it('falls back to 0.5 for Infinity', () => {
    expect(renderDispatcherAutonomyBlock({ autonomy: 'off', confidenceFloor: Infinity })).toContain(floorLine('0.5'));
  });

  it('falls back to 0.5 for a non-numeric string floor', () => {
    expect(renderDispatcherAutonomyBlock({ autonomy: 'off', confidenceFloor: 'high' })).toContain(floorLine('0.5'));
  });

  it('coerces a numeric-string floor to its numeric value', () => {
    expect(renderDispatcherAutonomyBlock({ autonomy: 'off', confidenceFloor: '0.25' })).toContain(floorLine('0.25'));
  });
});

// ---------------------------------------------------------------------------
// Round-trip — render output parses back to the same autonomy + floor
// ---------------------------------------------------------------------------

describe('renderDispatcherAutonomyBlock → _parseDispatcherAutonomy round-trip', () => {
  it('recovers autonomy: advisory and floor 0.7', () => {
    const block = renderDispatcherAutonomyBlock({ autonomy: 'advisory', confidenceFloor: 0.7 });
    expect(_parseDispatcherAutonomy(block)).toEqual({ autonomy: 'advisory', 'confidence-floor': 0.7 });
  });

  it('recovers autonomy: autonomous-gated and floor 0.9', () => {
    const block = renderDispatcherAutonomyBlock({ autonomy: 'autonomous-gated', confidenceFloor: 0.9 });
    expect(_parseDispatcherAutonomy(block)).toEqual({ autonomy: 'autonomous-gated', 'confidence-floor': 0.9 });
  });

  it('recovers the default off / 0.5 from a defaulted render', () => {
    const block = renderDispatcherAutonomyBlock({});
    expect(_parseDispatcherAutonomy(block)).toEqual({ autonomy: 'off', 'confidence-floor': 0.5 });
  });

  it('recovers a clamped floor of 1 after render of an out-of-range input', () => {
    const block = renderDispatcherAutonomyBlock({ autonomy: 'off', confidenceFloor: 5 });
    expect(_parseDispatcherAutonomy(block)).toEqual({ autonomy: 'off', 'confidence-floor': 1 });
  });
});

// ---------------------------------------------------------------------------
// writeDispatcherAutonomyBlock — filesystem behaviour
// ---------------------------------------------------------------------------

describe('writeDispatcherAutonomyBlock — filesystem behaviour', () => {
  let dir;
  let claudeMdPath;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dispatcher-autonomy-capture-'));
    claudeMdPath = join(dir, 'CLAUDE.md');
    writeFileSync(claudeMdPath, '# Project\n\nSome existing content.\n', 'utf8');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends the block and reports written:true when absent', () => {
    const result = writeDispatcherAutonomyBlock({ claudeMdPath, autonomy: 'advisory', confidenceFloor: 0.6 });
    expect(result).toEqual({ written: true, path: claudeMdPath });
  });

  it('writes content the presence guard then recognises', () => {
    writeDispatcherAutonomyBlock({ claudeMdPath, autonomy: 'advisory', confidenceFloor: 0.6 });
    expect(isDispatcherAutonomyBlockPresent(readFileSync(claudeMdPath, 'utf8'))).toBe(true);
  });

  it('preserves the original file content above the appended block', () => {
    writeDispatcherAutonomyBlock({ claudeMdPath, autonomy: 'off' });
    expect(readFileSync(claudeMdPath, 'utf8')).toContain('Some existing content.');
  });

  it('persists the chosen autonomy value into the file', () => {
    writeDispatcherAutonomyBlock({ claudeMdPath, autonomy: 'autonomous-gated', confidenceFloor: 0.8 });
    expect(_parseDispatcherAutonomy(readFileSync(claudeMdPath, 'utf8'))).toEqual({
      autonomy: 'autonomous-gated',
      'confidence-floor': 0.8,
    });
  });

  it('is a no-op on a second invocation (idempotent)', () => {
    writeDispatcherAutonomyBlock({ claudeMdPath, autonomy: 'advisory', confidenceFloor: 0.6 });
    const second = writeDispatcherAutonomyBlock({ claudeMdPath, autonomy: 'off', confidenceFloor: 0.1 });
    expect(second).toEqual({ written: false, reason: 'already-present' });
  });

  it('does not append a second block on the idempotent re-run', () => {
    writeDispatcherAutonomyBlock({ claudeMdPath, autonomy: 'advisory' });
    writeDispatcherAutonomyBlock({ claudeMdPath, autonomy: 'off' });
    const occurrences = readFileSync(claudeMdPath, 'utf8').match(/^dispatcher-autonomy:\s*$/gm) || [];
    expect(occurrences).toHaveLength(1);
  });

  it('does not overwrite the first chosen value on the idempotent re-run', () => {
    writeDispatcherAutonomyBlock({ claudeMdPath, autonomy: 'advisory', confidenceFloor: 0.6 });
    writeDispatcherAutonomyBlock({ claudeMdPath, autonomy: 'autonomous-gated', confidenceFloor: 0.9 });
    expect(_parseDispatcherAutonomy(readFileSync(claudeMdPath, 'utf8'))).toEqual({
      autonomy: 'advisory',
      'confidence-floor': 0.6,
    });
  });

  it('inserts a separating newline when the existing file has no trailing newline', () => {
    writeFileSync(claudeMdPath, '# No trailing newline', 'utf8');
    writeDispatcherAutonomyBlock({ claudeMdPath, autonomy: 'off' });
    expect(readFileSync(claudeMdPath, 'utf8')).toContain('# No trailing newline\n\n## Dispatcher Autonomy');
  });

  it('is a no-op when a malformed dispatcher-autonomy block already exists', () => {
    writeFileSync(claudeMdPath, '# Project\n\ndispatcher-autonomy:\n  garbage !!! not yaml\n', 'utf8');
    const result = writeDispatcherAutonomyBlock({ claudeMdPath, autonomy: 'advisory' });
    expect(result).toEqual({ written: false, reason: 'already-present' });
  });
});

// ---------------------------------------------------------------------------
// writeDispatcherAutonomyBlock — error paths (no-throw)
// ---------------------------------------------------------------------------

describe('writeDispatcherAutonomyBlock — error paths', () => {
  it('returns an error without throwing when claudeMdPath is missing', () => {
    const result = writeDispatcherAutonomyBlock({ autonomy: 'off' });
    expect(result.written).toBe(false);
    expect(result.error).toContain('requires a claudeMdPath');
  });

  it('returns an error without throwing when claudeMdPath is an empty string', () => {
    const result = writeDispatcherAutonomyBlock({ claudeMdPath: '', autonomy: 'off' });
    expect(result.written).toBe(false);
    expect(result.error).toContain('requires a claudeMdPath');
  });

  it('returns an error without throwing when called with no arguments', () => {
    const result = writeDispatcherAutonomyBlock();
    expect(result.written).toBe(false);
    expect(result.error).toContain('requires a claudeMdPath');
  });

  it('returns a read-failed error (no throw) when the target file does not exist', () => {
    const ghostDir = mkdtempSync(join(tmpdir(), 'dispatcher-autonomy-ghost-'));
    const missingPath = join(ghostDir, 'does-not-exist', 'CLAUDE.md');
    const result = writeDispatcherAutonomyBlock({ claudeMdPath: missingPath, autonomy: 'off' });
    rmSync(ghostDir, { recursive: true, force: true });
    expect(result.written).toBe(false);
    expect(result.error).toContain('read failed');
  });

  it('does not create a file when the parent directory is missing', () => {
    const ghostDir = mkdtempSync(join(tmpdir(), 'dispatcher-autonomy-ghost-'));
    const missingPath = join(ghostDir, 'no-such-dir', 'CLAUDE.md');
    writeDispatcherAutonomyBlock({ claudeMdPath: missingPath, autonomy: 'off' });
    const created = existsSync(missingPath);
    rmSync(ghostDir, { recursive: true, force: true });
    expect(created).toBe(false);
  });
});
