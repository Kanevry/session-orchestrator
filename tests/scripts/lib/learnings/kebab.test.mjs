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

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { kebab, learningKeyOf } from '../../../../scripts/lib/learnings/kebab.mjs';
import { toActivationMetadata } from '../../../../scripts/lib/reconcile/emitter.mjs';
import { inspectLearningProvenance } from '../../../../scripts/lib/validate/check-learning-provenance.mjs';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
const RULES_DIR = join(REPO_ROOT, '.claude', 'rules');

/** The renderer's `LEARNING_KEY_RE` — the shape a stamped key must satisfy. */
const LEARNING_KEY_SHAPE = /^[a-z0-9/-]+$/;

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

describe('learningKeyOf — the writer and the readers derive ONE key', () => {
  // THE bug, and it is silent in both directions: `reconcile/emitter.mjs` (the
  // WRITER, which stamps the key into `.claude/rules/*.md` and
  // `reconcile-candidates.jsonl`) used to kebab the TYPE half, while every
  // READER — engine's rejection path, validate/check-learning-provenance,
  // learnings/candidates dedupe, claude-md-drift-check — took it verbatim.
  // Invisible while every live type is kebab-identical; the first type whose
  // kebab is not the identity makes the writer stamp `config-pattern/x` while
  // the readers compute `Config_Pattern/x`. Dedupe stops matching and the
  // stamped pointer reads as dangling — with nothing failing loudly.
  //
  // These types are deliberately hostile rather than corpus-typical: the four
  // UNREGISTERED dialects already in the store (`harness-regression`,
  // `agent-behavior-pattern`, `operational-pattern`, `config-pattern`) prove
  // the type space is not confined to the registry, so "the registry keeps
  // types kebab-safe" is an empirical claim about today, not an invariant.
  it.each([
    ['Config_Pattern', 'Config_Pattern/some-real-subject'],
    ['UPPER-CASE-TYPE', 'UPPER-CASE-TYPE/some-real-subject'],
    ['anti_pattern', 'anti_pattern/some-real-subject'],
  ])('writer and reader agree for type %s', (type, expectedKey) => {
    const learning = {
      type,
      subject: 'Some real subject',
      insight: 'insight long enough to be useful',
      confidence: 0.9,
      file_paths: ['scripts/lib/reconcile/emitter.mjs'],
      created_at: '2026-08-01T00:00:00.000Z',
    };

    const written = toActivationMetadata(learning, { now: Date.parse('2026-08-01T00:00:00Z') });

    expect(written.learningKey).toBe(expectedKey);
    expect(written.learningKey).toBe(learningKeyOf(learning));
  });

  it('keeps the type half verbatim so a reader can parse it back out', () => {
    // `backfill-learnings-from-vault.mjs` reconstructs a record's `type` from
    // `learning_key.split('/')[0]`. A slugged type half would silently hand it a
    // MUTATED type (`agent_behavior` -> `agent-behavior`) and fire a false
    // conflict against the vault note's real type.
    const key = learningKeyOf({ type: 'agent_behavior', subject: 'x y' });
    expect(key.split('/')[0]).toBe('agent_behavior');
  });

  it('returns null rather than a degenerate key for an all-symbol subject', () => {
    // `kebab('!!!')` is '' — so an unguarded derivation yields `anti-pattern/`,
    // which is not an identity but a bucket every all-symbol-subject record of
    // that type collides in.
    expect(learningKeyOf({ type: 'anti-pattern', subject: '!!!' })).toBeNull();
    expect(learningKeyOf({ type: '', subject: 'has a subject' })).toBeNull();
    expect(learningKeyOf({ type: 'anti-pattern' })).toBeNull();
    expect(learningKeyOf(null)).toBeNull();
    expect(learningKeyOf('not a record')).toBeNull();
  });

  it('makes the emitter reject an unkeyable learning instead of stamping one', () => {
    // The writer needs a string. Rejecting loudly (one auditable rejection, per
    // the engine's per-item try/catch) beats emitting a rule whose key resolves
    // to no learning — the same reject-don't-degrade posture as `host_class`.
    expect(() =>
      toActivationMetadata({
        type: 'anti-pattern',
        subject: '!!!',
        insight: 'insight',
        confidence: 0.9,
        file_paths: ['scripts/lib/reconcile/emitter.mjs'],
      }),
    ).toThrow(/unkeyable learning/);
  });
});

describe('learningKeyOf — a stamped key still resolves to its learning', () => {
  // Bug: a derivation change re-keys the stored contract. The key is stamped
  // into 13 tracked `.claude/rules/*.md` provenance blocks; if the derivation
  // moves, every one of them becomes a `dangling-learning-key` finding and the
  // rule loses its traceability to the learning it was minted from.
  //
  // Golden pairs, harvested 2026-08-13 from the live store x the stamped rule
  // files: the (type, subject) side is the record as it sits in
  // `.orchestrator/metrics/learnings.jsonl` (gitignored, absent in CI — hence
  // inlined), the expected key is READ AT RUNTIME out of the tracked rule file,
  // so this asserts derivation-vs-committed-artifact rather than
  // derivation-vs-my-expectation.
  it.each([
    [
      'anti-pattern-validate-config-cli-exit-code-is-not-a-schema-gate-under-enforcement-warn-73b1249.md',
      'anti-pattern',
      'validate-config CLI exit code is not a schema gate under enforcement:warn',
    ],
    [
      'fragile-file-quality-gate-wrapper-needs-large-output-buffer-and-env-isolation-1f999bc.md',
      'fragile-file',
      'quality-gate-wrapper-needs-large-output-buffer-and-env-isolation',
    ],
    [
      'recurring-issue-session-registry-fresh-claim-files-must-be-age-gated-f1f3be4.md',
      'recurring-issue',
      'session-registry-fresh-claim-files-must-be-age-gated',
    ],
    [
      'proven-pattern-nul-byte-corruption-needs-a-byte-level-pre-commit-gate-posix-tr-cmp-is-the-only-portable-detector-9d8032c.md',
      'proven-pattern',
      'NUL-byte corruption needs a byte-level pre-commit gate; POSIX tr|cmp is the only portable detector',
    ],
  ])('%s', (ruleFile, type, subject) => {
    const body = readFileSync(join(RULES_DIR, ruleFile), 'utf8');
    const stamped = /^[-*][ \t]+learning-key:[ \t]*`([^`]+)`/m.exec(body);
    expect(stamped, `no learning-key stamped in ${ruleFile}`).not.toBeNull();
    expect(learningKeyOf({ type, subject })).toBe(stamped[1]);
  });

  it('derives a key of the shape every stamped key already has', () => {
    // Corpus-wide and CI-safe (the rule files are tracked; the store is not).
    // Floor/ceiling per `testing.md` § Dynamic Artifact Counts — the corpus
    // grows — but "zero stamped keys of a shape the derivation cannot produce"
    // is a fixed invariant, not a count.
    const stamped = readdirSync(RULES_DIR)
      .filter((n) => n.endsWith('.md'))
      .map((n) => /^[-*][ \t]+learning-key:[ \t]*`([^`]+)`/m.exec(readFileSync(join(RULES_DIR, n), 'utf8')))
      .filter((m) => m !== null)
      .map((m) => m[1]);

    expect(stamped.length).toBeGreaterThanOrEqual(5);
    expect(stamped.length).toBeLessThanOrEqual(200);
    for (const key of stamped) {
      expect(key).toMatch(LEARNING_KEY_SHAPE);
      // Exactly one separator: the type half carries none and `kebab` emits
      // none, so a two-slash key would break `split('/')[0]` type recovery.
      expect(key.split('/')).toHaveLength(2);
      expect(key.split('/')[1]).not.toBe('');
    }
  });
});

describe('learningKeyOf — writer-to-reader wiring (real production call shape)', () => {
  // Bug: the emitter stamps a key the provenance check cannot re-derive, so a
  // perfectly healthy rule is reported as `dangling-learning-key` (and, on the
  // other side of the same divergence, a genuinely rotten pointer resolves
  // against a key nobody stamped). This exercises BOTH real functions end to
  // end — the unit assertions above pin the derivation, this pins the wiring.
  it('resolves a rule the emitter stamped, for a type kebab would alter', async () => {
    const root = mkdtempSync(join(tmpdir(), 'learning-key-wiring-'));
    try {
      const learning = {
        schema_version: 1,
        id: '11111111-2222-3333-4444-555555555555',
        type: 'Config_Pattern',
        subject: 'a type whose kebab is not the identity',
        insight: 'synthetic insight',
        evidence: 'synthetic evidence',
        confidence: 0.9,
        file_paths: ['scripts/lib/reconcile/emitter.mjs'],
        created_at: '2026-08-01T00:00:00.000Z',
      };
      const metadata = toActivationMetadata(learning, { now: Date.parse('2026-08-01T00:00:00Z') });

      mkdirSync(join(root, '.claude', 'rules'), { recursive: true });
      mkdirSync(join(root, '.orchestrator', 'metrics'), { recursive: true });
      writeFileSync(
        join(root, '.claude', 'rules', 'auto-generated-fixture.md'),
        ['# Auto-generated rule', '', 'Body.', '', '## Provenance', `- learning-key: \`${metadata.learningKey}\``, ''].join('\n'),
      );
      writeFileSync(
        join(root, '.orchestrator', 'metrics', 'learnings.jsonl'),
        `${JSON.stringify(learning)}\n`,
      );

      const result = await inspectLearningProvenance(root);

      expect(result.findings.map((f) => f.kind)).toEqual([]);
      expect(result.summary.resolved).toBe(1);
      expect(result.summary.dangling).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
