/**
 * tests/rules/rules-library-parity.test.mjs — issue #1098 review follow-up.
 *
 * `rules/always-on/*.md` are sanitized forks of `.claude/rules/*.md`: same
 * rules, with plugin-internal citations and non-vendored siblings removed. Two
 * corpora, one meaning — and until this test, nothing tied them together.
 *
 * The bug this catches: **a rule section added to the live `.claude/rules/`
 * copy that never reaches the vendored library copy**, so every consumer repo
 * keeps receiving the old rule set while this repo behaves by the new one. It
 * is silent by construction — both files parse, both load, and the only symptom
 * is a consumer that never learns the rule exists.
 *
 * The census is rule-ID DEFINITIONS, not byte parity and not every ID mention:
 *
 *   - A definition is a heading whose FIRST token is a rule ID
 *     (`## PSA-003 — Destructive Action Safeguards`, `## AUQ-001: Route …`).
 *   - A mere mention is not, and must not be — measured 2026-08-28 on the live
 *     corpora, the "every `[A-Z]{2,4}-\d{3}` token" form the review asked for is
 *     RED on 4 of 9 shared files (7 tokens: `LM-005`, `PSA-003`×2, `CSM-001`,
 *     `CSM-004`, `RCR-003`, `AUQ-001`). Every one is a CROSS-REFERENCE to a rule
 *     defined in a different file, which a sanitized fork legitimately drops —
 *     e.g. `.claude/rules/loop-and-monitor.md:218` heads a section
 *     `## LM-006: PSA-003 Applies` that the library copy deliberately renames to
 *     `## LM-006: Destructive-Action Safeguards Apply`. Pinning mentions would
 *     make the guard fail on correct sanitization, which is worse than no guard.
 *
 * Byte parity is likewise wrong on purpose: the fork EXISTS in order to differ.
 *
 * The file list is derived at test time from the two directories, so a rule
 * added to (or removed from) either corpus is covered without editing this test.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const LIVE_DIR = join(REPO_ROOT, '.claude', 'rules');
const LIB_DIR = join(REPO_ROOT, 'rules', 'always-on');

/** Heading whose first token is a rule ID — `LM-002a` counts as `LM-002`. */
const DEFINITION_RE = /^#{2,4}\s+([A-Z]{2,4}-\d{3})[a-z]?\b/gm;

/**
 * @param {string} filePath
 * @returns {Set<string>} rule IDs the file DEFINES (heading-leading tokens)
 */
function definedRuleIds(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const ids = new Set();
  DEFINITION_RE.lastIndex = 0;
  let m;
  while ((m = DEFINITION_RE.exec(content)) !== null) ids.add(m[1]);
  return ids;
}

function mdFiles(dir) {
  return new Set(readdirSync(dir).filter((f) => f.endsWith('.md') && f !== '_index.md'));
}

const sharedBasenames = (() => {
  const lib = mdFiles(LIB_DIR);
  return [...mdFiles(LIVE_DIR)].filter((f) => lib.has(f)).sort();
})();

describe('rules library parity — every rule defined live also reaches the vendored fork', () => {
  it('finds shared basenames to compare (guards against an empty, vacuously-green census)', () => {
    // Without this, a renamed directory would make every it.each below vanish
    // and the suite would report green while measuring nothing.
    expect(sharedBasenames.length).toBeGreaterThan(0);
  });

  it.each(sharedBasenames)('%s defines the same rule IDs in both corpora', (basename) => {
    const live = definedRuleIds(join(LIVE_DIR, basename));
    const lib = definedRuleIds(join(LIB_DIR, basename));
    const missing = [...live].filter((id) => !lib.has(id)).sort();

    expect(
      missing,
      `.claude/rules/${basename} defines ${JSON.stringify(missing)} but ` +
        `rules/always-on/${basename} does not — consumer repos would never receive ` +
        `${missing.length === 1 ? 'that rule' : 'those rules'}. Port the section into the ` +
        `library copy (sanitizing plugin-internal citations), then re-run.`,
    ).toEqual([]);
  });
});
