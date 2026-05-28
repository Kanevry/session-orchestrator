/**
 * tests/skills/adr-drift.test.mjs
 *
 * ADR-text drift canary (issue #492 L2, deep-3 qa coverage-gap bundle).
 *
 * The #492 finding: editing an ADR under docs/adr/ trips NO test, so an ADR can
 * silently lose its required structure (e.g. someone deletes the ## Decision
 * section while editing) with zero signal. This file is a LOW-flake canary that
 * catches that drift.
 *
 * SCOPE — numbered ADRs only (docs/adr/NNNN-*.md, e.g. 0001-…, 0009-…).
 * The directory also holds dated research/spike files (2026-05-10-*.md) that
 * deliberately do NOT follow the ADR section contract — `…-spike-cluster-risks.md`
 * is a Risk Register, `…-cross-connections.md` is a Connection Map. Scoping the
 * canary to the numbered-ADR convention keeps it stable: it asserts the contract
 * the numbered files genuinely share, and is unaffected by the free-form dated
 * documents.
 *
 * Canaries (each independently falsifiable, none brittle full-text matches):
 *   1. Every numbered ADR has the three required MADR-style sections:
 *      ## Context, ## Decision, ## Consequences. (Verified present in all 9
 *      numbered ADRs at authoring time, 2026-05-28.) Dropping any one trips it.
 *   2. Every numbered ADR H1 title contains the token "ADR" (catches a stray
 *      non-ADR file accidentally matching the NNNN-*.md glob).
 *   3. The numbered-ADR sequence is contiguous and unique starting at 1
 *      (catches an accidental duplicate number or a gap from a deleted/renamed
 *      file).
 *
 * Why these and not full-text snapshots: ADR bodies are long prose that change
 * legitimately (Implementation Status appendices, follow-up edits). Asserting
 * section *presence* + numbering *integrity* protects the load-bearing structure
 * without flaking on every wording change.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ADR_DIR = join(REPO_ROOT, 'docs', 'adr');

// Numbered-ADR convention: a 4-digit sequence number, a hyphen, then a slug.
// e.g. "0001-context-vs-orchestration.md". The negative lookahead rejects the
// dated research/spike files ("2026-05-10-…") whose 4-digit prefix is a YEAR
// followed by a MM-DD- date — those do NOT follow the ADR section contract.
const NUMBERED_ADR_RE = /^(\d{4})-(?!\d{2}-\d{2}-).+\.md$/;

const REQUIRED_SECTIONS = Object.freeze(['## Context', '## Decision', '## Consequences']);

/**
 * Discover numbered ADR files, sorted by their leading number. Returns
 * [{ file, num }] tuples so the parameterised tests carry a stable label.
 */
function discoverNumberedAdrs() {
  return readdirSync(ADR_DIR)
    .map((file) => {
      const match = NUMBERED_ADR_RE.exec(file);
      return match ? { file, num: Number(match[1]) } : null;
    })
    .filter((entry) => entry !== null)
    .sort((a, b) => a.num - b.num);
}

const NUMBERED_ADRS = discoverNumberedAdrs();

// ---------------------------------------------------------------------------
// Guard: the discovery itself must find ADRs — a glob that silently matches
// nothing would make every it.each below vacuously pass (zero cases).
// ---------------------------------------------------------------------------

describe('docs/adr — numbered ADR discovery', () => {
  it('finds at least the 9 originally-shipped numbered ADRs (0001–0009)', () => {
    expect(NUMBERED_ADRS.length).toBeGreaterThanOrEqual(9);
  });

  it('finds at most 200 numbered ADRs (ceiling guards against a runaway glob)', () => {
    expect(NUMBERED_ADRS.length).toBeLessThanOrEqual(200);
  });
});

// ---------------------------------------------------------------------------
// Canary 1: required MADR-style sections present in every numbered ADR.
// Data-driven over the discovered files; one case per ADR.
// ---------------------------------------------------------------------------

describe('docs/adr — required sections present (drift canary)', () => {
  it.each(NUMBERED_ADRS)(
    '$file contains ## Context, ## Decision, and ## Consequences headers',
    ({ file }) => {
      const content = readFileSync(join(ADR_DIR, file), 'utf8');
      const missing = REQUIRED_SECTIONS.filter((section) => !content.includes(section));
      expect(missing).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// Canary 2: every numbered ADR H1 title carries the "ADR" token.
// Catches a non-ADR markdown file that accidentally adopts the NNNN- glob.
// ---------------------------------------------------------------------------

describe('docs/adr — H1 title carries the ADR token (drift canary)', () => {
  it.each(NUMBERED_ADRS)('$file H1 heading contains "ADR"', ({ file }) => {
    const content = readFileSync(join(ADR_DIR, file), 'utf8');
    const firstLine = content.split('\n', 1)[0];
    expect(firstLine.startsWith('# ')).toBe(true);
    expect(firstLine).toContain('ADR');
  });
});

// ---------------------------------------------------------------------------
// Canary 3: numbering is contiguous and unique, starting at 1.
// Catches a duplicate ADR number or a gap left by a deleted/renamed ADR.
// ---------------------------------------------------------------------------

describe('docs/adr — numbering integrity (drift canary)', () => {
  it('ADR numbers are unique (no two files share a number)', () => {
    const numbers = NUMBERED_ADRS.map((entry) => entry.num);
    const unique = new Set(numbers);
    expect(unique.size).toBe(numbers.length);
  });

  it('ADR numbers form a contiguous 1..N run with no gaps', () => {
    const numbers = NUMBERED_ADRS.map((entry) => entry.num);
    const expected = Array.from({ length: numbers.length }, (_, i) => i + 1);
    expect(numbers).toEqual(expected);
  });
});
