/**
 * tests/scripts/lib/learnings/kebab.test.mjs
 *
 * Contract tests for scripts/lib/learnings/kebab.mjs — the slug primitive
 * behind every derived `learning_key`.
 *
 * Each describe block names the ONE concrete bug it catches. There is no test
 * here for coverage: the module is four lines, and four lines do not need four
 * hundred assertions. What they need is a tripwire on the only thing that can
 * go wrong — a well-meaning "improvement" that silently re-keys the corpus.
 *
 * Expected values are golden records harvested from live production state, not
 * hand-shaped fixtures: every (title, key) pair in the first block was read out
 * of `.orchestrator/metrics/learnings.jsonl` paired with the `learning-key`
 * actually stamped into the matching `.claude/rules/*.md` provenance block. A
 * hand-written fixture here would encode what the reader expects; these encode
 * what the writer already committed to disk.
 */

import { describe, expect, it } from 'vitest';

import { kebab } from '../../../../scripts/lib/learnings/kebab.mjs';

describe('kebab — stamped learning_key stability (golden records)', () => {
  // Bug: someone "improves" kebab — adds Unicode transliteration so "Größe"
  // becomes "groesse", or a length cap, or a different separator policy — and
  // every already-stamped learning_key silently forks. The same learning then
  // renders under two identities, `reconcile/idempotency.mjs` stops matching
  // its own dedupe key, and BOTH halves look correct in isolation because
  // nothing compares them. These 5 pairs are real, stamped, and immutable:
  // if any assertion below moves, existing keys moved with it.
  //
  // Harvested 2026-08-13 at c87102b from learnings.jsonl x .claude/rules/*.md
  // (13 stamped keys total; these 5 cover the punctuation classes present).
  it.each([
    // em-dash + "+" + "()" — the em-dash is corpus-typical German-keyboard prose
    [
      'console.log + process.exit() drops stdout above the pipe buffer — on an exit-0 protocol that means fail-open',
      'console-log-process-exit-drops-stdout-above-the-pipe-buffer-on-an-exit-0-protocol-that-means-fail-open',
    ],
    // apostrophe inside a word: "doesn't" -> "doesn-t", NOT "doesnt"
    [
      "vi.restoreAllMocks() doesn't clear vi.fn() call-history from a vi.mock() factory",
      'vi-restoreallmocks-doesn-t-clear-vi-fn-call-history-from-a-vi-mock-factory',
    ],
    // pipe + semicolon
    [
      'NUL-byte corruption needs a byte-level pre-commit gate; POSIX tr|cmp is the only portable detector',
      'nul-byte-corruption-needs-a-byte-level-pre-commit-gate-posix-tr-cmp-is-the-only-portable-detector',
    ],
    // TRAILING "(>)" — proves the trailing-separator trim is load-bearing on
    // real data, not just on a synthetic "---foo---" probe
    [
      'agents/*.md description frontmatter must be inline string, not YAML block scalar (>)',
      'agents-md-description-frontmatter-must-be-inline-string-not-yaml-block-scalar',
    ],
    // colon
    [
      'validate-config CLI exit code is not a schema gate under enforcement:warn',
      'validate-config-cli-exit-code-is-not-a-schema-gate-under-enforcement-warn',
    ],
  ])('reproduces the stamped key for %#', (title, expected) => {
    expect(kebab(title)).toBe(expected);
  });
});

describe('kebab — totality on non-string input', () => {
  // Bug: a refactor drops the String() coercion (it looks redundant next to a
  // `@param {string}` annotation). It is not: `reconcile/emitter.mjs` calls
  // kebab(learning.type) on a record parsed straight from JSONL, where `type`
  // is `unknown` at that trust boundary. Without the coercion a malformed
  // record throws a TypeError mid-run and aborts the whole reconcile pass
  // instead of producing a degenerate-but-harmless key.
  //
  // This is also the ONE measured behavioural difference between the five
  // pre-consolidation copies: `reconcile/engine.mjs`'s inline expression omits
  // String() and throws here. That divergence is unreachable at its own call
  // site (a typeof guard runs first), which is why consolidating on the
  // coercing form changed no key — see the byte-identity proof in the session
  // report.
  it.each([
    [null, 'null'],
    [undefined, 'undefined'],
    [12345, '12345'],
    [0, '0'],
    [true, 'true'],
  ])('coerces %p instead of throwing', (input, expected) => {
    expect(kebab(input)).toBe(expected);
  });
});

describe('kebab — separator collapse and trim', () => {
  // Bug: the `+` quantifier is dropped from /[^a-z0-9]+/ (yielding "a---b"
  // where the corpus has "a-b"), or the /^-+|-+$/ trim is dropped (yielding
  // "-foo-"). Either forks the key space for every title that has adjacent
  // punctuation or a leading/trailing symbol — which, per the golden block
  // above, is a large share of the real corpus.
  it('collapses each run of non-alphanumerics to exactly one hyphen', () => {
    expect(kebab('a!!!@@@###b')).toBe('a-b');
  });

  it('trims leading and trailing hyphens', () => {
    expect(kebab('  --Foo Bar--  ')).toBe('foo-bar');
  });

  it('lowercases before matching, so uppercase never survives as a separator', () => {
    expect(kebab('FOO BAR BAZ')).toBe('foo-bar-baz');
  });
});

describe('kebab — empty result is a supported outcome', () => {
  // Bug: someone makes kebab "safer" by returning a fallback ('untitled', a
  // hash, the raw input) when the result would be empty. That silently
  // disables `reconcile/renderer.mjs::deriveSlug`, which branches on
  // `base === ''` to swap in its collision-safe hash suffix. The branch would
  // become dead code and all-symbol learnings would collide on the fallback
  // string instead of getting distinct slugs.
  it('returns the empty string when the input holds no [a-z0-9]', () => {
    expect(kebab('!!!')).toBe('');
    expect(kebab('')).toBe('');
  });

  // Non-ASCII is COLLAPSED, not transliterated. Frozen deliberately: the
  // stamped corpus was minted this way, so "ä" must stay a separator.
  it('collapses non-ASCII letters rather than transliterating them', () => {
    expect(kebab('äöüß')).toBe('');
    expect(kebab('Größe')).toBe('gr-e');
  });
});
