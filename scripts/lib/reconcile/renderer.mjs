/**
 * renderer.mjs — Reconciliation-engine rule renderer (Epic #693 FA2, issue #695).
 *
 * Turns an eligible learning + its activation-metadata (from the sibling
 * {@link module:reconcile/emitter.toActivationMetadata}) into a complete,
 * loader-parseable `.claude/rules/<slug>.md` markdown document.
 *
 * Pure functions — NO file I/O. {@link renderRule} returns the markdown STRING
 * plus the intended path; it does NOT write `.claude/rules/`. Writing (after
 * operator approval) is FA3's job (issue #696).
 *
 * ── The never-always-on invariant (the "brandmauer") ─────────────────────────
 * docs/rule-authoring.md § "The Never-Always-On Invariant". Every emitted rule
 * carries `auto-generated: true` and MUST therefore carry ≥1 activation axis
 * (non-empty `globs` OR a `host-class`), a `learning-key`, and an `expires-at`.
 * The emitter already guards this, but {@link renderRule} defends it again —
 * it THROWS when handed metadata with empty globs AND no hostClass so the
 * renderer can never serialise an always-on auto-generated rule.
 *
 * Frontmatter is emitted in a fixed key order matching what the rule-loader
 * (`scripts/lib/rule-loader.mjs`) parses: `auto-generated`, `alwaysApply`,
 * `description`, block-style `globs:`, optional `host-class`, `learning-key`,
 * `confidence`, `expires-at`. Glob values are always double-quoted (the loader
 * strips surrounding quotes), which keeps `*`/`[`/`{` safe.
 *
 * ── Untrusted-input containment (issue #1015) ────────────────────────────────
 * Every field this renderer interpolates is AGENT-AUTHORED, and the file it
 * produces becomes a project instruction delivered to every agent in every
 * session — permanently, with no revocation. {@link renderRule} therefore
 * applies `sanitize.mjs` at the render point, in two modes:
 *   - MACHINE values (`description`, `globs[]`, `host-class`, `learning-key`,
 *     `confidence`, `expires-at`, `id`, `source_session`) are ASSERTED and the
 *     record REJECTED (throw) on any violation — never silently repaired.
 *   - PROSE (`title`/`subject`, `insight`, `evidence`) is stripped of
 *     unambiguous non-content, hard-capped in bytes, and FRAMED in the
 *     `untrusted-content` envelope that states it is data, not instruction.
 * The guard lives HERE and not only in the emitter for the same reason the
 * brandmauer is re-checked below: `renderRule` is exported and callable with
 * hand-built metadata, so the emitter's guards do not bind on it.
 *
 * @module reconcile/renderer
 */

import { createHash } from 'node:crypto';

import { kebab } from '../learnings/kebab.mjs';
import {
  EVIDENCE_ITEM_MAX_BYTES,
  EVIDENCE_MAX_BYTES,
  EXPIRES_AT_RE,
  HOST_CLASS_RE,
  INSIGHT_MAX_BYTES,
  LEARNING_KEY_RE,
  PROVENANCE_TOKEN_RE,
  TITLE_MAX_BYTES,
  UNTRUSTED_BEGIN,
  UNTRUSTED_END,
  assertMachineToken,
  assertSafeDescription,
  assertSafeGlob,
  sanitizeProse,
} from './sanitize.mjs';

/**
 * Short, stable SHA-1 prefix (first 7 hex chars) of an input string.
 *
 * @param {string} input
 * @returns {string}
 */
function shortHash(input) {
  return createHash('sha1').update(String(input)).digest('hex').slice(0, 7);
}

/**
 * Derive a kebab-case, stable, idempotent slug for a learning's rule file.
 *
 * `slug = kebab(type) + '-' + kebab(title||subject) + '-' + sha1(`${type}/${title||subject}`)[:7]`.
 * The hash suffix gives collision safety while staying deterministic: the same
 * learning always yields the same slug; distinct learnings yield distinct slugs.
 *
 * Guard: when `type` is missing OR both `title` and `subject` are missing, fall
 * back to `'auto-' + sha1(JSON.stringify(learning))[:7]`. Never throws.
 *
 * @param {object} learning
 * @returns {string}
 */
export function deriveSlug(learning) {
  if (learning === null || typeof learning !== 'object' || Array.isArray(learning)) {
    return `auto-${shortHash(JSON.stringify(learning))}`;
  }

  const type = typeof learning.type === 'string' ? learning.type : '';
  const subjectOrTitle =
    (typeof learning.title === 'string' && learning.title !== '' ? learning.title : '') ||
    (typeof learning.subject === 'string' && learning.subject !== '' ? learning.subject : '');

  if (type === '' || subjectOrTitle === '') {
    return `auto-${shortHash(JSON.stringify(learning))}`;
  }

  const base = `${kebab(type)}-${kebab(subjectOrTitle)}`;
  const suffix = shortHash(`${type}/${subjectOrTitle}`);

  // A kebab of all-symbol inputs can be empty; the hash suffix keeps the slug
  // non-empty and stable regardless.
  return base === '' ? `auto-${suffix}` : `${base}-${suffix}`;
}

/**
 * Render the body's `## Evidence` section content from a learning's `evidence`.
 *
 * Array → one `- ` bullet per item; string → as-is; absent/empty →
 * `(no evidence recorded)`.
 *
 * Untrusted (#1015): every item passes through {@link sanitizeProse} with a
 * per-bullet byte cap, and the whole region is bounded by
 * {@link EVIDENCE_MAX_BYTES}. Items that would cross the region budget are
 * dropped with a machine-emitted note — visibly, never silently. Because
 * `EVIDENCE_ITEM_MAX_BYTES < EVIDENCE_MAX_BYTES` by construction, at least the
 * first item always fits.
 *
 * @param {unknown} evidence
 * @returns {string}
 * @throws {Error} when an item carries a delivery-wrapper forgery literal
 */
function renderEvidence(evidence) {
  const isArray = Array.isArray(evidence);
  const items = isArray
    ? evidence.filter((e) => e !== null && e !== undefined && String(e) !== '')
    : typeof evidence === 'string' && evidence !== ''
      ? [evidence]
      : [];

  if (items.length === 0) return '(no evidence recorded)';

  /** @type {string[]} */
  const lines = [];
  let usedBytes = 0;
  for (const item of items) {
    const safe = sanitizeProse(item, { field: 'evidence', maxBytes: EVIDENCE_ITEM_MAX_BYTES });
    const line = isArray ? `- ${safe}` : safe;
    const width = Buffer.byteLength(line, 'utf8');
    if (lines.length > 0 && usedBytes + width > EVIDENCE_MAX_BYTES) break;
    lines.push(line);
    usedBytes += width;
  }

  const omitted = items.length - lines.length;
  if (omitted > 0) {
    lines.push(
      `- […${omitted} further evidence item(s) omitted by the reconciliation engine: ${EVIDENCE_MAX_BYTES}-byte region cap]`,
    );
  }

  return lines.join('\n');
}

/**
 * Render a complete `.claude/rules/<slug>.md` document for an eligible learning.
 *
 * @param {object} learning - the eligible learning (carries `type`,
 *   `subject`/`title`, `insight`, `evidence`, `id`, `source_session`).
 * @param {object} metadata - activation metadata from the emitter:
 *   `{ globs: string[], description, learningKey, confidence, expiresAt,
 *      autoGenerated: true, alwaysApply: false, hostClass?: string }`.
 * @returns {{ slug: string, path: string, content: string }}
 * @throws {Error} when `metadata.globs` is empty AND `metadata.hostClass` is
 *   falsy — the never-always-on invariant (defends the emitter's guard).
 * @throws {Error} (`reconcile-sanitize: rejecting record — …`) when a machine
 *   value is malformed (a `description` with a control char, a dangerous
 *   invisible, a wrapper-forgery literal or over its byte budget; a `globs[]`
 *   element with a quote/control char/invisible; a non-token
 *   `host-class`/`learning-key`/`id`/`source_session`; a non-finite
 *   `confidence`; a non-`YYYY-MM-DD` `expires-at`) or when prose forges the
 *   delivery wrapper's framing — issue #1015. The record is REJECTED, never
 *   repaired.
 */
export function renderRule(learning, metadata) {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('renderer: metadata must be a non-null object');
  }

  const globs = Array.isArray(metadata.globs) ? metadata.globs : [];
  const hostClass =
    typeof metadata.hostClass === 'string' && metadata.hostClass !== ''
      ? metadata.hostClass
      : undefined;

  // The brandmauer: refuse to serialise an always-on auto-generated rule.
  if (globs.length === 0 && hostClass === undefined) {
    throw new Error(
      'renderer: no activation axis (globs/host-class) — refusing to render always-on auto-generated rule (never-always-on invariant)',
    );
  }

  // ── Machine-value gate (#1015) — assert, never repair ─────────────────────
  // Each of these is serialised into a frontmatter scalar (or, for the last
  // two, into an inline-code span). A violation REJECTS the whole record: the
  // engine catches the throw and records an audited `emit/render error: …`
  // rejection, so a hostile record costs one rejected proposal, never a rule
  // file. Repairing instead of rejecting would invent information — see
  // `sanitize.mjs` for the per-field reasoning.
  // `description` is the ONE agent-authored value emitted outside the untrusted
  // envelope (a frontmatter scalar cannot carry the envelope's HTML comment —
  // the loader would read the comment AS the description). It therefore gets
  // equivalent neutralisation instead of framing: no frontmatter escape, no
  // smuggled invisibles, no delivery-wrapper forgery, bounded length. See
  // `sanitize.mjs` § assertSafeDescription.
  assertSafeDescription(metadata.description);
  for (const glob of globs) assertSafeGlob(glob);
  if (hostClass !== undefined) {
    assertMachineToken(hostClass, { field: 'host-class', pattern: HOST_CLASS_RE });
  }
  assertMachineToken(metadata.learningKey, { field: 'learning-key', pattern: LEARNING_KEY_RE });
  if (!Number.isFinite(metadata.confidence)) {
    // A non-finite confidence is SILENTLY DROPPED by the loader's `Number(...)`
    // coercion, so the rule would load with no confidence at all rather than
    // fail loudly.
    throw new Error(
      `reconcile-sanitize: rejecting record — confidence must be a finite number (got ${JSON.stringify(metadata.confidence)})`,
    );
  }
  assertMachineToken(metadata.expiresAt, { field: 'expires-at', pattern: EXPIRES_AT_RE });

  const slug = deriveSlug(learning);
  const path = `.claude/rules/${slug}.md`;

  // Prose sources. `deriveSlug` is safe by construction (its `kebab` collapses
  // every non-`[a-z0-9]` run, so no title can steer the output path), but the
  // rendered H1 carries the raw value — `title` outranks `subject` and has no
  // schema constraint at all, so it is capped and framed like any other prose.
  const rawTitle =
    (typeof learning.title === 'string' && learning.title !== '' ? learning.title : '') ||
    (typeof learning.subject === 'string' && learning.subject !== '' ? learning.subject : '') ||
    metadata.learningKey ||
    slug;
  const safeTitle = sanitizeProse(rawTitle, { field: 'title', maxBytes: TITLE_MAX_BYTES })
    // The H1 is a single line: a newline in the title would end the heading and
    // let the remainder render as top-level markdown of the attacker's choosing.
    .replace(/[\t\n]+/g, ' ')
    .trim();
  // A title made only of stripped invisibles sanitises to '' — fall back to the
  // slug so the H1 is never empty.
  const humanTitle = safeTitle !== '' ? safeTitle : slug;

  const insight =
    typeof learning.insight === 'string' && learning.insight !== ''
      ? sanitizeProse(learning.insight, { field: 'insight', maxBytes: INSIGHT_MAX_BYTES })
      : '(no insight recorded)';

  // ── Frontmatter (fixed key order; loader-parseable) ──────────────────────
  const fm = [];
  fm.push('---');
  fm.push('auto-generated: true');
  fm.push('alwaysApply: false');
  fm.push(`description: ${metadata.description}`);
  // OMIT the `globs:` key entirely when there are no globs (a host-class-only
  // activation axis). An empty `globs:` line parses in the loader as
  // `globs: []`, which short-circuits BEFORE the host-class gate runs
  // (`if (globs.length === 0) continue;`) — dropping the rule on every host. A
  // rule with no `globs:` key is treated as not glob-scoped, so it is gated
  // purely by `host-class:` (loads only on a matching host) — the intended
  // behavior, and still never always-on (host-class IS an activation axis).
  if (globs.length > 0) {
    fm.push('globs:');
    for (const glob of globs) {
      // Always double-quote — keeps `*`/`[`/`{` safe; loader strips quotes.
      fm.push(`  - "${glob}"`);
    }
  }
  if (hostClass !== undefined) {
    fm.push(`host-class: ${hostClass}`);
  }
  fm.push(`learning-key: ${metadata.learningKey}`);
  fm.push(`confidence: ${metadata.confidence}`);
  fm.push(`expires-at: ${metadata.expiresAt}`);
  fm.push('---');

  // ── Body (free markdown; does not affect frontmatter parsing) ────────────
  // Both provenance values are rendered INSIDE an inline-code span below, which
  // an interior backtick would close — so they are asserted as machine tokens
  // rather than escaped. The 'n/a' fallbacks are machine-emitted, not asserted.
  const learningId = learning.id
    ? assertMachineToken(String(learning.id), {
        field: 'learning-id',
        pattern: PROVENANCE_TOKEN_RE,
      })
    : 'n/a';
  const sourceSession = learning.source_session
    ? assertMachineToken(String(learning.source_session), {
        field: 'source-session',
        pattern: PROVENANCE_TOKEN_RE,
      })
    : 'n/a';

  // The untrusted region (H1 + insight + Evidence) is FRAMED: the envelope
  // states, in machine-generated text the record cannot forge, that everything
  // inside is agent-authored data rather than an instruction to the reading
  // agent. Provenance stays OUTSIDE the envelope — it is machine-derived and
  // asserted above.
  const body = [
    '',
    UNTRUSTED_BEGIN,
    `# Auto-generated rule: ${humanTitle}`,
    '',
    insight,
    '',
    '## Evidence',
    renderEvidence(learning.evidence),
    '',
    UNTRUSTED_END,
    '',
    '<!-- provenance (auto-generated by the reconciliation engine — do not hand-edit) -->',
    '## Provenance',
    `- learning-key: \`${metadata.learningKey}\``,
    `- learning-id: \`${learningId}\``,
    `- source-session: \`${sourceSession}\``,
    `- confidence: ${metadata.confidence}`,
    '- generated-by: reconciliation-engine (Epic #693 FA2 / #695)',
    `- expires-at: ${metadata.expiresAt}`,
    '',
  ];

  const content = `${fm.join('\n')}\n${body.join('\n')}`;

  return { slug, path, content };
}
