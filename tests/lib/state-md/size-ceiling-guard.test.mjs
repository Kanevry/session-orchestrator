/**
 * tests/lib/state-md/size-ceiling-guard.test.mjs
 *
 * Regression coverage for the STATE.md size-ceiling guard (issue #739) —
 * a mechanical refuse-write-if-ballooning check added to `writeStateMd`
 * (frontmatter-mutators.mjs) after a real incident where editing STATE.md
 * frontmatter via `updateFrontmatterFields` ballooned the file from ~6KB to
 * 6.3MB (main-2026-06-26-session-2). Root cause: `serializeScalar` in
 * yaml-parser.mjs JSON-escapes special characters but `parseScalar` strips
 * quotes WITHOUT unescaping — so a scalar containing a literal `"` gains an
 * extra layer of backslash-escaping on every parse→serialize round-trip,
 * and repeated writes compound exponentially.
 *
 * All fixtures live under `os.tmpdir()` mkdtemp roots. NEVER exercises the
 * live repo's `.claude/STATE.md`.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeStateMd,
  touchUpdatedFieldOnDisk,
  updateFrontmatterFieldsOnDisk,
  DEFAULT_STATE_MD_SIZE_CEILING_BYTES,
  STATE_MD_SIZE_CEILING_RATIO,
} from '@lib/state-md/frontmatter-mutators.mjs';
import { appendDeviationOnDisk } from '@lib/state-md/body-sections.mjs';

// ─── Fixtures & helpers ──────────────────────────────────────────────────────

const tmpRoots = [];

function makeTmpRepo() {
  const root = mkdtempSync(join(tmpdir(), 'state-md-ceiling-'));
  tmpRoots.push(root);
  return root;
}

function statePathFor(root) {
  return join(root, '.claude', 'STATE.md');
}

/** Writes `content` directly to `<root>/.claude/STATE.md`, creating the directory first. */
function seedState(root, content) {
  const statePath = statePathFor(root);
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(statePath, content, { encoding: 'utf8' });
  return statePath;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tmpRoots.length > 0) {
    const root = tmpRoots.pop();
    rmSync(root, { recursive: true, force: true });
  }
});

// A modest, realistic STATE.md fixture — well under any ceiling.
const SMALL_FIXTURE = `---
schema-version: 1
session-type: deep
status: active
updated: 2026-04-19T17:30:00Z
---

## Current Wave

Wave 2 — Impl-Core.

## Mission Status

- m-1: in-dev — some task
- m-2: validated — another task

## Deviations

- [2026-04-19T17:00:00Z] example deviation entry.
`;

// A frontmatter scalar containing an embedded, already-escaped double-quote —
// the exact shape `serializeScalar` produces for a string containing a
// literal `"`. Re-parsing and re-serializing this WITHOUT changing the value
// grows it on every round-trip (the balloon-incident mechanism).
const QUOTE_FIXTURE = `---
schema-version: 1
goal: "has "quote" inside"
updated: 2026-01-01T00:00:00Z
---

## Body
`;

function stderrOutput(spy) {
  return spy.mock.calls.map((args) => String(args[0])).join('');
}

// ─── Balloon-regression (core) ───────────────────────────────────────────────

describe('writeStateMd — size-ceiling guard: balloon regression (core)', () => {
  it('refuses a write whose after-size exceeds the absolute ceiling, leaving disk untouched', async () => {
    const root = makeTmpRepo();
    const statePath = statePathFor(root);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // No STATE.md exists yet — before === ''. Oversized first-write triggers
    // ONLY the absolute ceiling (ratio check is skipped for empty `before`).
    const oversized = 'x'.repeat(DEFAULT_STATE_MD_SIZE_CEILING_BYTES + 50000);
    const result = await writeStateMd(root, () => oversized);

    expect(result).toEqual({
      written: false,
      path: statePath,
      contents: '',
      reason: 'size-ceiling',
    });

    // Guard must WARN, not throw — and the warning must name the failure class.
    const output = stderrOutput(stderrSpy);
    expect(output).toContain('⚠');
    expect(output).toContain('size-ceiling');
    expect(output).toContain('absolute ceiling');

    // On-disk STATE.md is byte-for-byte unchanged — it never existed, and
    // still does not exist after the refusal.
    expect(existsSync(statePath)).toBe(false);
  });

  it('refuses a write whose after-size exceeds 5x a non-empty prior, even under the absolute ceiling', async () => {
    const root = makeTmpRepo();
    const statePath = seedState(root, 'a'.repeat(1000));
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const sixTimesOver = 'b'.repeat(6001); // > 5 * 1000, well under 256KB absolute
    const result = await writeStateMd(root, () => sixTimesOver);

    expect(result.written).toBe(false);
    expect(result.reason).toBe('size-ceiling');
    expect(result.contents).toBe('a'.repeat(1000));

    const output = stderrOutput(stderrSpy);
    expect(output).toContain('⚠');
    expect(output).toContain(`${STATE_MD_SIZE_CEILING_RATIO}x`);

    // Disk unchanged — still the original 1000-byte content.
    expect(readFileSync(statePath, 'utf8')).toBe('a'.repeat(1000));
  });
});

// ─── Fake-regression (negative-assertion check, per testing.md) ─────────────

describe('writeStateMd — size-ceiling guard: fake-regression (guard disabled)', () => {
  it('lands the oversize write when _ceilingBytes is set to Infinity (guard disabled)', async () => {
    const root = makeTmpRepo();
    const statePath = statePathFor(root);

    // Same shape as the core absolute-ceiling regression test above — no
    // prior file, so the ratio check is inert regardless; setting
    // _ceilingBytes: Infinity disables the ONLY active check (absolute).
    const oversized = 'x'.repeat(DEFAULT_STATE_MD_SIZE_CEILING_BYTES + 50000);
    const result = await writeStateMd(root, () => oversized, { _ceilingBytes: Infinity });

    // With the guard disabled, the write LANDS — this is the "red-relative"
    // observation confirming the guard (not something else) is what makes
    // the paired core test above refuse the write.
    expect(result.written).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(existsSync(statePath)).toBe(true);
    expect(readFileSync(statePath, 'utf8')).toHaveLength(DEFAULT_STATE_MD_SIZE_CEILING_BYTES + 50000);
  });
});

// ─── Compounding regression ──────────────────────────────────────────────────

describe('writeStateMd — size-ceiling guard: compounding regression (real serializer asymmetry)', () => {
  it('bounds file size across repeated updateFrontmatterFieldsOnDisk calls on a quote-bearing fixture', async () => {
    const root = makeTmpRepo();
    const statePath = seedState(root, QUOTE_FIXTURE);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // A small forced ceiling makes the real exponential growth (driven by
    // the yaml-parser round-trip asymmetry on the `goal` field, which this
    // loop never itself touches) trip deterministically within a handful of
    // iterations instead of needing ~16 iterations to cross the 256KB default.
    const forcedCeiling = 2000;
    const sizes = [];
    const results = [];

    for (let i = 0; i < 12; i++) {
      const result = await updateFrontmatterFieldsOnDisk(
        root,
        { updated: `2026-01-01T00:00:0${i % 10}Z` },
        { _ceilingBytes: forcedCeiling }
      );
      results.push(result);
      sizes.push(Buffer.byteLength(readFileSync(statePath, 'utf8'), 'utf8'));
    }

    // The guard must actually have tripped at least once — this is the
    // meaningful regression assertion: without the guard, sizes keep growing
    // past the forced ceiling instead of ever refusing.
    expect(results.some((r) => r.written === false && r.reason === 'size-ceiling')).toBe(true);

    // Every on-disk size after every iteration stays under the forced
    // ceiling — a write only ever lands when it already passed the check, so
    // this proves growth cannot run away no matter how many iterations pass.
    expect(sizes.every((s) => s < forcedCeiling)).toBe(true);

    // Once tripped, the file size plateaus (no further growth) — the guard
    // keeps refusing the same oversized candidate against the same
    // last-known-good `before` on every subsequent call.
    const lastSize = sizes[sizes.length - 1];
    const secondLastSize = sizes[sizes.length - 2];
    expect(lastSize).toBe(secondLastSize);
  });
});

// ─── Normal write passes ─────────────────────────────────────────────────────

describe('writeStateMd — size-ceiling guard: normal writes are unaffected', () => {
  it('allows touchUpdatedFieldOnDisk on a realistic small fixture (default ceiling)', async () => {
    const root = makeTmpRepo();
    const statePath = seedState(root, SMALL_FIXTURE);

    const result = await touchUpdatedFieldOnDisk(root, '2026-05-01T12:00:00Z');

    expect(result.written).toBe(true);
    expect(result.reason).toBeUndefined();
    const onDisk = readFileSync(statePath, 'utf8');
    expect(onDisk).toContain('updated: 2026-05-01T12:00:00Z');
    expect(Buffer.byteLength(onDisk, 'utf8')).toBeLessThan(DEFAULT_STATE_MD_SIZE_CEILING_BYTES);
  });

  it('allows appendDeviationOnDisk on the same fixture (default ceiling, body-section growth)', async () => {
    const root = makeTmpRepo();
    const statePath = seedState(root, SMALL_FIXTURE);

    const result = await appendDeviationOnDisk(root, '2026-05-01T12:05:00Z', 'a legitimate deviation note');

    expect(result.written).toBe(true);
    expect(result.reason).toBeUndefined();
    const onDisk = readFileSync(statePath, 'utf8');
    expect(onDisk).toContain('a legitimate deviation note');
    expect(Buffer.byteLength(onDisk, 'utf8')).toBeLessThan(DEFAULT_STATE_MD_SIZE_CEILING_BYTES);
  });
});

// ─── Ratio-vs-absolute boundary ──────────────────────────────────────────────

describe('writeStateMd — size-ceiling guard: ratio-vs-absolute boundary', () => {
  it('allows a first-write (before === "") of a modestly large legal body under the absolute ceiling', async () => {
    const root = makeTmpRepo();
    const statePath = statePathFor(root);

    // No prior STATE.md — ratio check is inert regardless of size. 50KB is
    // "modestly large" but comfortably under the 256KB absolute ceiling.
    const legalBody = '#'.repeat(50000);
    const result = await writeStateMd(root, () => legalBody);

    expect(result.written).toBe(true);
    expect(existsSync(statePath)).toBe(true);
    expect(readFileSync(statePath, 'utf8')).toHaveLength(50000);
  });

  it('rejects a 6x-over-prior write even though it stays well under the 256KB absolute ceiling', async () => {
    const root = makeTmpRepo();
    const statePath = seedState(root, 'a'.repeat(1000));

    const sixTimesOver = 'b'.repeat(6001); // 6.001x prior; << 256KB absolute
    const result = await writeStateMd(root, () => sixTimesOver);

    expect(result.written).toBe(false);
    expect(result.reason).toBe('size-ceiling');
    expect(readFileSync(statePath, 'utf8')).toBe('a'.repeat(1000));
  });
});

// ─── Exact-boundary cases (issue #739 follow-up gap) ─────────────────────────
//
// evaluateSizeCeiling uses strict `>` for BOTH checks (absolute:
// `afterBytes > ceilingBytes`; ratio: `afterBytes > beforeBytes * RATIO`), so
// a value exactly AT the boundary must pass and one byte past it must be
// refused. Falsification: flipping either `>` to `>=` would make the
// exact-boundary "passes" test below refuse the write instead, and the
// "1 byte over" test would still refuse either way — the exact-boundary case
// is what actually distinguishes strict `>` from `>=`.

describe('writeStateMd — size-ceiling guard: exact-boundary (absolute)', () => {
  it('allows a write whose after-size is EXACTLY the absolute ceiling (262144 bytes)', async () => {
    const root = makeTmpRepo();
    const statePath = statePathFor(root);
    const exact = 'x'.repeat(DEFAULT_STATE_MD_SIZE_CEILING_BYTES);

    const result = await writeStateMd(root, () => exact);

    expect(result.written).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(Buffer.byteLength(readFileSync(statePath, 'utf8'), 'utf8')).toBe(
      DEFAULT_STATE_MD_SIZE_CEILING_BYTES,
    );
  });

  it('refuses a write whose after-size is exactly ONE BYTE over the absolute ceiling (262145 bytes)', async () => {
    const root = makeTmpRepo();
    const statePath = statePathFor(root);
    const overByOne = 'x'.repeat(DEFAULT_STATE_MD_SIZE_CEILING_BYTES + 1);

    const result = await writeStateMd(root, () => overByOne);

    expect(result.written).toBe(false);
    expect(result.reason).toBe('size-ceiling');
    expect(existsSync(statePath)).toBe(false);
  });
});

describe('writeStateMd — size-ceiling guard: exact-boundary (ratio)', () => {
  it('allows a write whose after-size is EXACTLY 5x the prior on-disk size', async () => {
    const root = makeTmpRepo();
    const statePath = seedState(root, 'a'.repeat(1000));
    const exactly5x = 'b'.repeat(5000); // 1000 * 5 === 5000, not > 5000

    const result = await writeStateMd(root, () => exactly5x);

    expect(result.written).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(readFileSync(statePath, 'utf8')).toBe(exactly5x);
  });

  it('refuses a write whose after-size is exactly ONE BYTE over 5x the prior on-disk size', async () => {
    const root = makeTmpRepo();
    const statePath = seedState(root, 'a'.repeat(1000));
    const overBy1 = 'b'.repeat(5001); // 1000 * 5 + 1

    const result = await writeStateMd(root, () => overBy1);

    expect(result.written).toBe(false);
    expect(result.reason).toBe('size-ceiling');
    expect(readFileSync(statePath, 'utf8')).toBe('a'.repeat(1000));
  });
});
