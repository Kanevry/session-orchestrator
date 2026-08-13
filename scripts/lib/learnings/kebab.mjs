/**
 * learnings/kebab.mjs — the slug primitive behind every `learning_key`.
 *
 * `learning_key` is not a stored field. It is DERIVED at reconcile time as
 * `` `${type}/${kebab(title || subject)}` `` and is the logical identity the
 * whole dedupe/idempotency layer keys on (`reconcile/idempotency.mjs` calls it
 * "THE logical dedupe key"). That makes this four-line function a contract, not
 * a formatting helper: two callers that kebab differently do not produce two
 * ugly slugs, they FORK the key space — the same learning renders under two
 * identities, dedupe stops firing, and both halves look correct in isolation.
 *
 * Before this module existed there were four copies of it plus one inline
 * expression, none exported, none shared (two of the four landed on the same
 * day, from two different authors, each of whom flagged the duplication in
 * their own report). They agreed on every reachable input — verified, not
 * assumed — so consolidating here changed no existing key. See the byte-identity
 * proof pinned in `tests/scripts/lib/learnings/kebab.test.mjs`.
 *
 * ## Why this file lives under `learnings/` and not under `reconcile/`
 *
 * Dependency direction, measured rather than presumed:
 * `scripts/lib/reconcile/*` imports from `scripts/lib/learnings/*` at three
 * call sites (`emitter.mjs`, `eligibility.mjs`, `engine.mjs` — all pulling
 * `learnings/schema.mjs`) and `scripts/lib/learnings/*` imports from
 * `reconcile/*` at zero. A primitive shared by both packages therefore belongs
 * on the `learnings/` side; placing it under `reconcile/` would invert an edge
 * and introduce a cycle.
 *
 * Deliberately NOT re-exported from the `scripts/lib/learnings.mjs` barrel —
 * `surface.mjs` and `affinity.mjs` set that precedent: consumers import the
 * leaf directly, so the barrel stays the historical schema/io/filters surface.
 *
 * ## What this module is NOT
 *
 * Not a general-purpose slugifier. Vault note ids, tag segments, and rule
 * filenames have their own slug rules with their own length caps and charset
 * contracts (`vault-mirror/utils.mjs`, `vault-archive.mjs`). Do not route those
 * through here — a shared slugifier across unrelated identity spaces is how a
 * cap added for one consumer silently re-keys another.
 *
 * Pure, stdlib-only, no imports, no clock, no fs.
 */

/**
 * Slugify a string into the stable kebab-case token used for learning keys.
 *
 * Lowercases, collapses every run of non-`[a-z0-9]` characters into a single
 * `-`, and trims leading/trailing `-`.
 *
 * Three properties callers depend on:
 *
 *   1. **Total** — never throws. Non-string input is coerced via `String()`,
 *      so `null`/`undefined`/numbers yield `"null"`/`"undefined"`/`"12345"`
 *      rather than a `TypeError`. Callers pass values typed `unknown` at
 *      their trust boundary; a throw there would abort a reconcile run.
 *   2. **Lossy on non-ASCII** — German umlauts and em-dashes in the corpus are
 *      collapsed to `-` (`"Größe"` → `"gr-e"`), NOT transliterated. Ugly, and
 *      deliberately frozen: every stamped key in `.claude/rules/*.md` and in
 *      `.orchestrator/runtime/reconcile-candidates.jsonl` was minted this way.
 *      Adding transliteration would re-key the entire corpus.
 *   3. **May return the empty string** — an all-symbol input (`"!!!"`) yields
 *      `""`. `reconcile/renderer.mjs::deriveSlug` branches on exactly that to
 *      fall back to its hash suffix, so an "always return something non-empty"
 *      change here would silently disable that branch.
 *
 * @param {unknown} s Value to slugify; coerced with `String()`.
 * @returns {string} Kebab token; `''` when the input holds no `[a-z0-9]`.
 */
export function kebab(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
