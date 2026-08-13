/**
 * learnings/kebab.mjs — the slug primitive behind every `learning_key`, and
 * {@link learningKeyOf}, the whole-key derivation built on it.
 *
 * `learning_key` is not a stored field. It is DERIVED as
 * `` `${type}/${kebab(title || subject)}` `` and is the logical identity the
 * whole dedupe/idempotency layer keys on (`reconcile/idempotency.mjs` calls it
 * "THE logical dedupe key"). That makes this a contract, not a formatting
 * helper: two callers that derive differently do not produce two ugly slugs,
 * they FORK the key space — the same learning renders under two identities,
 * dedupe stops firing, and both halves look correct in isolation.
 *
 * Before this module existed there were four copies of `kebab` plus one inline
 * expression, none exported, none shared (two of the four landed on the same
 * day, from two different authors, each of whom flagged the duplication in
 * their own report). They agreed on every reachable input — verified, not
 * assumed — so consolidating here changed no existing key. See the byte-identity
 * proof pinned in `tests/scripts/lib/learnings/kebab.test.mjs`.
 *
 * Consolidating the primitive left the SECOND half of the problem open, and it
 * is the half that bites: what each call site FED the primitive. Four sites
 * derived `${type}/…` verbatim while the writer (`reconcile/emitter.mjs`) alone
 * derived `${kebab(type)}/…` — a divergence invisible while every live `type`
 * is kebab-identical, and silent in BOTH directions the moment one is not.
 * {@link learningKeyOf} exists so there is one derivation to agree with rather
 * than five to keep in sync.
 *
 * ## Why this file lives under `learnings/` and not under `reconcile/`
 *
 * Dependency direction, measured rather than presumed (2026-08-13, HEAD
 * 5d59e62): `grep -rn "from '../learnings/" scripts/lib/reconcile/` reports 6
 * import edges across 4 files (`eligibility.mjs`, `engine.mjs` ×2,
 * `emitter.mjs` ×2, `renderer.mjs` — three of them pulling THIS module, three
 * pulling `learnings/schema.mjs`), and the reverse grep
 * `from '../reconcile/'` over `scripts/lib/learnings/` reports 0. A primitive
 * shared by both packages therefore belongs on the `learnings/` side; placing
 * it under `reconcile/` would invert an edge and introduce a cycle.
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

/**
 * THE derivation of a learning's logical key: `` `${type}/${kebab(title || subject)}` ``.
 *
 * One rule, four decisions, each of which was a divergence between call sites
 * before this function existed:
 *
 *   1. **The TYPE half is verbatim (trimmed), never kebab'd.** The subject half
 *      is prose and must be slugged; the type half is an enum token a reader
 *      parses BACK OUT of the key — `backfill-learnings-from-vault.mjs` uses
 *      `learning_key.split('/')[0]` as the reconstructed `type` and
 *      cross-checks it against the vault note's type. Kebabbing it would make
 *      that half lossy, which is precisely the fidelity downgrade the backfill
 *      labels `derived:learning-key-slug (original prose not recoverable)` for
 *      the subject half. Frontmatter safety does not need it either: the key
 *      becomes an unquoted `learning-key:` scalar, and `reconcile/renderer.mjs`
 *      already asserts `LEARNING_KEY_RE` (`/^[a-z0-9/-]+$/`) on the whole value
 *      before rendering — an unsafe type is REJECTED loudly there rather than
 *      silently re-keyed here.
 *   2. **`title` wins over `subject`**, and a whitespace-only `title` falls
 *      through to `subject` rather than yielding an empty slug.
 *   3. **`null`, not a throw, for an unkeyable record.** Readers scan corpora
 *      that contain shape-foreign lines; an unkeyable record simply does not
 *      participate in key resolution. Writers that need a string check for
 *      `null` and reject the record with their own auditable reason.
 *   4. **An empty slug is unkeyable, not a key.** `kebab('!!!')` is `''`, and
 *      `` `anti-pattern/` `` is not an identity — it is a bucket every
 *      all-symbol-subject record of that type would collide in.
 *
 * @param {unknown} record A learning record (or anything; non-records yield `null`).
 * @returns {string|null} `` `${type}/${slug}` ``, or `null` when unkeyable.
 */
export function learningKeyOf(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return null;
  const rec = /** @type {Record<string, unknown>} */ (record);
  const type = typeof rec.type === 'string' ? rec.type.trim() : '';
  const titleOrSubject =
    (typeof rec.title === 'string' && rec.title.trim() !== '' ? rec.title : '') ||
    (typeof rec.subject === 'string' && rec.subject.trim() !== '' ? rec.subject : '');
  if (type === '' || titleOrSubject === '') return null;
  const slug = kebab(titleOrSubject);
  if (slug === '') return null;
  return `${type}/${slug}`;
}
