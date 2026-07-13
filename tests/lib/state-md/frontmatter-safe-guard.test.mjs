/**
 * tests/lib/state-md/frontmatter-safe-guard.test.mjs
 *
 * Regression coverage for the STATE.md frontmatter-safe round-trip guard
 * (issue #747 follow-up) — a second, independent `writeStateMd` guard added
 * alongside the pre-existing size-ceiling guard (issue #739,
 * `tests/lib/state-md/size-ceiling-guard.test.mjs`).
 *
 * The guard verifies that `after`'s frontmatter block is a byte-fixpoint
 * under a further `serializeStateMd(parseStateMd(after))` round-trip — see
 * `evaluateFrontmatterSafe` in `scripts/lib/state-md/frontmatter-mutators.mjs`
 * for the full rationale (including why this was evaluated and deliberately
 * left unshipped when #739 first landed, and why #747 made it safe to ship).
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
  evaluateFrontmatterSafe,
} from '@lib/state-md/frontmatter-mutators.mjs';

// ─── Fixtures & helpers ──────────────────────────────────────────────────────

const tmpRoots = [];

function makeTmpRepo() {
  const root = mkdtempSync(join(tmpdir(), 'state-md-fm-safe-'));
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

function stderrOutput(spy) {
  return spy.mock.calls.map((args) => String(args[0])).join('');
}

// A realistic STATE.md fixture whose `goal` scalar contains an embedded
// double-quote — the exact shape that used to trip the pre-#747 serializer
// asymmetry (issue #739). The guard exists precisely to keep this class of
// content safe going forward.
const QUOTE_FIXTURE = `---
schema-version: 1
goal: "has "quote" inside"
updated: 2026-01-01T00:00:00Z
---

## Body
`;

const SMALL_FIXTURE = `---
schema-version: 1
session-type: deep
status: active
updated: 2026-04-19T17:30:00Z
---

## Current Wave

Wave 3 — Impl-Polish.
`;

// ─── evaluateFrontmatterSafe: direct unit tests ──────────────────────────────

describe('evaluateFrontmatterSafe', () => {
  it('reports safe (unsafe: false) for a fresh serializer-shaped frontmatter block', () => {
    // Same shape a real writeStateMd transformer would hand it: `after` is
    // itself the output of a prior serializeStateMd() call.
    const after = '---\nschema-version: 1\ngoal: "has \\"quote\\" inside"\nupdated: 2026-01-01T00:00:07Z\n---\n\n## Body\n';
    const result = evaluateFrontmatterSafe(after);
    expect(result).toEqual({ unsafe: false, reason: null });
  });

  it('reports safe (unsafe: false) for content with no parseable frontmatter — nothing to verify', () => {
    const result = evaluateFrontmatterSafe('just plain text, no frontmatter fence at all');
    expect(result).toEqual({ unsafe: false, reason: null });
  });

  it('does not throw on malformed/garbage input (never-throw contract)', () => {
    expect(() => evaluateFrontmatterSafe('')).not.toThrow();
    expect(() => evaluateFrontmatterSafe('---\nnot: closed properly')).not.toThrow();
    expect(() => evaluateFrontmatterSafe('---\n  bad-indent: oops\n---\n\nBody\n')).not.toThrow();
  });

  // ── FAKE-REGRESSION (negative-assertion check, per testing.md) ──────────
  //
  // Hand-constructs a frontmatter block with trailing whitespace on a scalar
  // line — content no REAL production transformer would ever emit (every
  // transformer's `after` comes from serializeStateMd(), which never trails
  // whitespace), but a valid probe of the guard's actual bite: parseFrontmatter
  // trims trailing whitespace before parsing, so the re-serialized frontmatter
  // block omits it — a genuine, deterministic non-fixpoint. This is the
  // RED-relative proof that the guard actually detects a violation, not just
  // that it returns a plausible-looking shape.
  it('FAKE-REGRESSION: flags a hand-crafted frontmatter block with trailing whitespace as unsafe (non-fixpoint)', () => {
    const malformed = '---\nname: "value"   \n---\n\nBody\n';
    const result = evaluateFrontmatterSafe(malformed);
    expect(result.unsafe).toBe(true);
    expect(result.reason).toContain('not a serialize(parse(after)) byte-fixpoint');
  });
});

// ─── writeStateMd: normal writes pass the guard ──────────────────────────────

describe('writeStateMd — frontmatter-safe guard: normal writes are unaffected', () => {
  it('allows touchUpdatedFieldOnDisk on a realistic small fixture', async () => {
    const root = makeTmpRepo();
    const statePath = seedState(root, SMALL_FIXTURE);

    const result = await touchUpdatedFieldOnDisk(root, '2026-05-01T12:00:00Z');

    expect(result.written).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(readFileSync(statePath, 'utf8')).toContain('updated: 2026-05-01T12:00:00Z');
  });

  it('allows updateFrontmatterFieldsOnDisk repeatedly on the #739 quote-bearing fixture', async () => {
    const root = makeTmpRepo();
    const statePath = seedState(root, QUOTE_FIXTURE);

    for (let i = 0; i < 5; i++) {
      const result = await updateFrontmatterFieldsOnDisk(root, {
        updated: `2026-01-01T00:00:0${i}Z`,
      });
      expect(result.written).toBe(true);
      expect(result.reason).toBeUndefined();
    }
    expect(existsSync(statePath)).toBe(true);
  });

  it('allows a write whose after has no frontmatter fence at all (guard stays inert)', async () => {
    const root = makeTmpRepo();
    const statePath = statePathFor(root);

    const result = await writeStateMd(root, () => 'no frontmatter here, just body text\n');

    expect(result.written).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(existsSync(statePath)).toBe(true);
  });
});

// ─── writeStateMd: fake-regression end-to-end via a hand-crafted transformer ─

describe('writeStateMd — frontmatter-safe guard: FAKE-REGRESSION (guard bites end-to-end)', () => {
  it('refuses a write whose after has a non-fixpoint frontmatter block, leaving disk untouched', async () => {
    const root = makeTmpRepo();
    const statePath = seedState(root, 'a'.repeat(10)); // arbitrary prior on-disk content
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // A hand-crafted transformer bypassing serializeStateMd — simulates a
    // future serializer/parser drift reintroducing a non-idempotent write.
    const malformed = '---\nname: "value"   \n---\n\nBody\n';
    const result = await writeStateMd(root, () => malformed);

    expect(result).toEqual({
      written: false,
      path: statePath,
      contents: 'a'.repeat(10),
      reason: 'frontmatter-unsafe',
    });

    const output = stderrOutput(stderrSpy);
    expect(output).toContain('⚠');
    expect(output).toContain('frontmatter-unsafe');

    // Disk unchanged — still the original prior content (last-known-good).
    expect(readFileSync(statePath, 'utf8')).toBe('a'.repeat(10));
  });

  it('throws a tagged Error instead of refusing silently when opts.throwOnFrontmatterUnsafe is set', async () => {
    const root = makeTmpRepo();
    seedState(root, 'a'.repeat(10));
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const malformed = '---\nname: "value"   \n---\n\nBody\n';

    await expect(
      writeStateMd(root, () => malformed, { throwOnFrontmatterUnsafe: true })
    ).rejects.toMatchObject({ code: 'STATE_MD_FRONTMATTER_UNSAFE' });
  });
});
