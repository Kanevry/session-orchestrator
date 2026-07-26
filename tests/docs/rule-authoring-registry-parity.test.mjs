/**
 * tests/docs/rule-authoring-registry-parity.test.mjs
 *
 * Docs-parity guard (Wave 4 Q1, D3 follow-up: "Kein automatischer Docs-Parity-
 * Test — manuell mitziehen, sonst stille Drift"). Pins docs/rule-authoring.md's
 * "Transcribed verbatim from `LEARNING_TYPE_REGISTRY`" table + surrounding
 * prose against the REAL `LEARNING_TYPE_REGISTRY` / `LEARNING_TYPE_ALIASES`
 * exports in scripts/lib/learnings/schema.mjs. Three parity axes:
 *   (1) every table row's ttlDays/agentProposable/ruleConvertible matches the
 *       registry 1:1 (bijective — no missing row, no extra row);
 *   (2) the "... are the N `ruleConvertible: true` types" prose sentence's
 *       count word AND its listed type names match the registry-derived set;
 *   (3) every `LEARNING_TYPE_ALIASES` key is mentioned (in backticks) inside
 *       the "### Type aliasing" doc section.
 *
 * PARITY-GUARD EXCEPTION to testing.md's "hardcoded expected values" rule:
 * the whole point of this guard is exact parity between two independently-
 * edited artifacts (the markdown doc and the registry constant), so the
 * count/list/table values a test compares against are DERIVED from the real
 * `LEARNING_TYPE_REGISTRY` at test time — never hand-copied as literals.
 * Hardcoding "10" or the ten type names here would defeat the guard's own
 * purpose: it would stop catching exactly the drift class (a registry edit
 * landing without a matching doc edit) it exists to catch. This mirrors
 * .claude/rules/testing.md's "Dynamic Artifact Counts" carve-out in spirit,
 * but goes further — here the doc value must equal the registry-derived
 * value exactly, not just stay within a floor/ceiling band, because the
 * doc's job is to TRANSCRIBE the registry, not merely track its growth.
 *
 * RED/GREEN falsification proof: `computeParityDiffs()` is exercised against
 * (1) the REAL doc text + REAL registry/aliases -> GREEN (diffs === []), and
 * (2) hand-corrupted IN-MEMORY string copies of the real doc text (a single
 * substring substitution simulating a drifted future edit) -> RED (diffs
 * non-empty, message names the drifted field). docs/rule-authoring.md itself
 * is never written to by this file — every "corruption" is a local `const`,
 * never persisted to disk.
 *
 * Bug class caught: a future edit to LEARNING_TYPE_REGISTRY or
 * LEARNING_TYPE_ALIASES (add/remove a ruleConvertible:true type, flip a
 * ttlDays/agentProposable/ruleConvertible flag, add/rename an alias) that is
 * not mirrored into docs/rule-authoring.md's table/prose — exactly the
 * D3-flagged "manual mitziehen, sonst stille Drift" silent-drift failure.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  LEARNING_TYPE_REGISTRY,
  LEARNING_TYPE_ALIASES,
} from '../../scripts/lib/learnings/schema.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DOC_PATH = join(REPO_ROOT, 'docs', 'rule-authoring.md');
const REAL_DOC_TEXT = readFileSync(DOC_PATH, 'utf8');

const WORD_TO_NUMBER = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20,
};

// ---------------------------------------------------------------------------
// Parsers (test-only helpers — docs/rule-authoring.md has no production
// parser; this file's own guard function IS the artifact under test).
// ---------------------------------------------------------------------------

/** Extracts `| \`type\` | ttlDays | agentProposable | ruleConvertible |` rows. */
function parseRegistryTable(docText) {
  const rows = [];
  const rowRe = /^\|\s*`([^`]+)`\s*\|\s*(\d+)\s*\|\s*(true|false)\s*\|\s*(true|false)\s*\|\s*$/gm;
  let m;
  while ((m = rowRe.exec(docText)) !== null) {
    rows.push({
      type: m[1],
      ttlDays: Number(m[2]),
      agentProposable: m[3] === 'true',
      ruleConvertible: m[4] === 'true',
    });
  }
  return rows;
}

/** Extracts the "`a`, `b`, ..., and `z` are the N `ruleConvertible: true` types" claim. */
function parseRuleConvertibleClaim(docText) {
  const m = docText.match(/proposal\)\.\s*([\s\S]*?)are the (\w+) `ruleConvertible: true` types/);
  if (!m) return null;
  const types = [...m[1].matchAll(/`([a-z0-9-]+)`/g)].map((t) => t[1]);
  return { types, countWord: m[2] };
}

/** Slices the "### Type aliasing" section body up to (not including) the next `### ` heading. */
function extractAliasSection(docText) {
  const startIdx = docText.indexOf('### Type aliasing');
  if (startIdx === -1) return '';
  const rest = docText.slice(startIdx);
  const nextHeadingIdx = rest.indexOf('\n### ', 1);
  return nextHeadingIdx === -1 ? rest : rest.slice(0, nextHeadingIdx);
}

/**
 * The guard itself: compares docText's table/prose against a registry +
 * alias map, returning a list of human-readable diff strings (empty = parity).
 */
function computeParityDiffs(docText, registry, aliases) {
  const diffs = [];

  const tableRows = parseRegistryTable(docText);
  const tableByType = new Map(tableRows.map((r) => [r.type, r]));

  for (const [type, meta] of Object.entries(registry)) {
    const row = tableByType.get(type);
    if (!row) {
      diffs.push(`table missing row for type '${type}'`);
      continue;
    }
    if (row.ttlDays !== meta.ttlDays) {
      diffs.push(`table ttlDays mismatch for '${type}': doc=${row.ttlDays} registry=${meta.ttlDays}`);
    }
    if (row.agentProposable !== meta.agentProposable) {
      diffs.push(`table agentProposable mismatch for '${type}': doc=${row.agentProposable} registry=${meta.agentProposable}`);
    }
    if (row.ruleConvertible !== meta.ruleConvertible) {
      diffs.push(`table ruleConvertible mismatch for '${type}': doc=${row.ruleConvertible} registry=${meta.ruleConvertible}`);
    }
  }
  for (const row of tableRows) {
    if (!(row.type in registry)) {
      diffs.push(`table has extra row for unregistered type '${row.type}'`);
    }
  }

  const registryTrueTypes = Object.entries(registry)
    .filter(([, meta]) => meta.ruleConvertible === true)
    .map(([type]) => type)
    .sort();
  const claim = parseRuleConvertibleClaim(docText);
  if (!claim) {
    diffs.push('could not locate the "are the N `ruleConvertible: true` types" sentence');
  } else {
    const claimedCount = WORD_TO_NUMBER[claim.countWord.toLowerCase()];
    if (claimedCount !== registryTrueTypes.length) {
      diffs.push(`doc claims '${claim.countWord}' ruleConvertible:true types but registry has ${registryTrueTypes.length}`);
    }
    const claimedTypesSorted = [...claim.types].sort();
    if (JSON.stringify(claimedTypesSorted) !== JSON.stringify(registryTrueTypes)) {
      diffs.push('doc-listed ruleConvertible:true type names differ from the registry-derived set');
    }
  }

  const aliasSection = extractAliasSection(docText);
  for (const key of Object.keys(aliases)) {
    if (!aliasSection.includes(`\`${key}\``)) {
      diffs.push(`alias section does not mention alias key '${key}'`);
    }
  }

  return diffs;
}

// ---------------------------------------------------------------------------
// GREEN — the real doc against the real registry/aliases
// ---------------------------------------------------------------------------

describe('docs/rule-authoring.md registry-table parity (D3 follow-up)', () => {
  it('the real doc has zero parity diffs against the real registry + aliases', () => {
    const diffs = computeParityDiffs(REAL_DOC_TEXT, LEARNING_TYPE_REGISTRY, LEARNING_TYPE_ALIASES);
    expect(diffs).toEqual([]);
  });

  it('extracts exactly as many table rows as the registry has entries (bijective, not floor/ceiling)', () => {
    const rows = parseRegistryTable(REAL_DOC_TEXT);
    expect(rows).toHaveLength(Object.keys(LEARNING_TYPE_REGISTRY).length);
  });
});

// ---------------------------------------------------------------------------
// RED — hand-corrupted in-memory copies of the real doc text. Every fixture
// below is a local `const`; docs/rule-authoring.md is never written to.
// ---------------------------------------------------------------------------

describe('RED fixtures — falsification proof (docs/rule-authoring.md is never edited on disk)', () => {
  it('flags a drifted ttlDays value in the table', () => {
    const corrupted = REAL_DOC_TEXT.replace(
      '| `fragile-file` | 45 | true | true |',
      '| `fragile-file` | 999 | true | true |',
    );
    expect(corrupted).not.toBe(REAL_DOC_TEXT);
    const diffs = computeParityDiffs(corrupted, LEARNING_TYPE_REGISTRY, LEARNING_TYPE_ALIASES);
    expect(diffs).toContain("table ttlDays mismatch for 'fragile-file': doc=999 registry=45");
  });

  it('flags a drifted ruleConvertible boolean in the table', () => {
    const corrupted = REAL_DOC_TEXT.replace(
      '| `convention` | 90 | true | true |',
      '| `convention` | 90 | true | false |',
    );
    expect(corrupted).not.toBe(REAL_DOC_TEXT);
    const diffs = computeParityDiffs(corrupted, LEARNING_TYPE_REGISTRY, LEARNING_TYPE_ALIASES);
    expect(diffs).toContain("table ruleConvertible mismatch for 'convention': doc=false registry=true");
  });

  it('flags a removed table row for a registered type', () => {
    const corrupted = REAL_DOC_TEXT.replace('| `design-pattern` | 90 | true | true |\n', '');
    expect(corrupted).not.toBe(REAL_DOC_TEXT);
    const diffs = computeParityDiffs(corrupted, LEARNING_TYPE_REGISTRY, LEARNING_TYPE_ALIASES);
    expect(diffs).toContain("table missing row for type 'design-pattern'");
  });

  it('flags an extra unregistered-type row (a simulated table addition with no matching registry entry)', () => {
    const corrupted = REAL_DOC_TEXT.replace(
      '| `design-pattern` | 90 | true | true |',
      '| `design-pattern` | 90 | true | true |\n| `made-up-type` | 30 | true | true |',
    );
    expect(corrupted).not.toBe(REAL_DOC_TEXT);
    const diffs = computeParityDiffs(corrupted, LEARNING_TYPE_REGISTRY, LEARNING_TYPE_ALIASES);
    expect(diffs).toContain("table has extra row for unregistered type 'made-up-type'");
  });

  it('flags a count-word drift in the "are the N `ruleConvertible: true` types" sentence', () => {
    const corrupted = REAL_DOC_TEXT.replace(
      'are the ten `ruleConvertible: true` types',
      'are the nine `ruleConvertible: true` types',
    );
    expect(corrupted).not.toBe(REAL_DOC_TEXT);
    const diffs = computeParityDiffs(corrupted, LEARNING_TYPE_REGISTRY, LEARNING_TYPE_ALIASES);
    expect(diffs).toContain("doc claims 'nine' ruleConvertible:true types but registry has 10");
  });

  it('flags a type-name substitution in the ruleConvertible:true prose list', () => {
    const corrupted = REAL_DOC_TEXT.replace(
      '`fragile-file`, `recurring-issue`,',
      '`hardware-pattern`, `recurring-issue`,',
    );
    expect(corrupted).not.toBe(REAL_DOC_TEXT);
    const diffs = computeParityDiffs(corrupted, LEARNING_TYPE_REGISTRY, LEARNING_TYPE_ALIASES);
    expect(diffs).toContain('doc-listed ruleConvertible:true type names differ from the registry-derived set');
  });

  it('flags a missing alias-key mention in the "### Type aliasing" section', () => {
    const corrupted = REAL_DOC_TEXT.replace('`gotcha` → `anti-pattern`', 'REDACTED → `anti-pattern`');
    expect(corrupted).not.toBe(REAL_DOC_TEXT);
    const diffs = computeParityDiffs(corrupted, LEARNING_TYPE_REGISTRY, LEARNING_TYPE_ALIASES);
    expect(diffs).toContain("alias section does not mention alias key 'gotcha'");
  });
});

// ---------------------------------------------------------------------------
// Sanity — the guard also bites on a synthetic (non-doc) registry, proving
// computeParityDiffs() is not hardwired to the real doc's current shape.
// ---------------------------------------------------------------------------

describe('computeParityDiffs() sanity (non-doc synthetic case)', () => {
  it('reports a missing-row diff when the registry has a type absent from a minimal doc fixture', () => {
    const minimalDoc = [
      '| Type | ttlDays | agentProposable | ruleConvertible |',
      '|------|---------|------------------|------------------|',
      '| `alpha` | 30 | true | false |',
    ].join('\n');
    const syntheticRegistry = {
      alpha: { ttlDays: 30, agentProposable: true, ruleConvertible: false },
      beta: { ttlDays: 45, agentProposable: true, ruleConvertible: true },
    };
    const diffs = computeParityDiffs(minimalDoc, syntheticRegistry, {});
    expect(diffs).toContain("table missing row for type 'beta'");
  });
});
