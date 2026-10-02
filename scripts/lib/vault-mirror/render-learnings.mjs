/**
 * render-learnings.mjs — Learning markdown generators for vault-mirror (Issue #283 split).
 *
 * Exports: detectLearningSchema, normalizeLearningEntry, generateLearningNote, generateLearningNoteV2,
 *          sourceRecordValue, learningSourceRecord, sourceRecordLine (#1503)
 */

import { toDate, truncateAtWord, yamlQuoteIfNeeded, subjectToSlug, isValidSlug, buildTag, resolveSourceSessionLink } from './utils.mjs';

const GENERATOR_MARKER = 'session-orchestrator-vault-mirror@1';

/**
 * Learning JSONL has two producer schemas in production:
 *   v1 (legacy): id, type, subject, insight, evidence, confidence, source_session, created_at, expires_at?
 *   v2 (S69+):   id, type, text, scope, confidence, first_seen, decay?
 * Detect by presence of the v2-only field 'text'.
 */
export function detectLearningSchema(entry) {
  return entry && typeof entry.text === 'string' ? 'v2' : 'v1';
}

/**
 * Characters a `source-record:` value may carry (#1503). The value is always
 * written double-quoted, and BOTH readers of it — the vault-sync YAML loader and
 * the line-based `parseFrontmatter` in utils.mjs, which only strips the
 * surrounding quotes and never unescapes — must read back exactly the string
 * that was rendered. Excluding `"`, `\`, whitespace and anything non-ASCII is
 * what makes that round trip lossless without an escaping scheme. Record uuids,
 * kebab ids, session uuids and ISO timestamps all fit.
 */
const SOURCE_RECORD_RE = /^[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,199}$/;

/**
 * Normalise one candidate `source-record` value (#1503): the identity of the
 * JSONL record a vault note was rendered from. Returns `null` for anything that
 * cannot round-trip through the frontmatter (see {@link SOURCE_RECORD_RE}) — the
 * line is then omitted and the record-level ownership check is skipped for that
 * entry, which is the same "absent = allow" reading an old note gets.
 *
 * Shared by both renderers so the rendered value and the value process.mjs
 * compares against come from ONE derivation.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function sourceRecordValue(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return SOURCE_RECORD_RE.test(trimmed) ? trimmed : null;
}

/**
 * The `source-record` of a learning note: the record's own `id` (a uuid for v1
 * producers, the kebab id for v2 and for alias producers whose id was derived
 * from the subject by {@link normalizeLearningEntry}).
 *
 * Named ceiling: a derived id IS the subject slug, so two repos holding the same
 * subject under derived ids render the same `source-record` and this field
 * cannot tell them apart — `source-repo` and the CLI's repo-root resolution are
 * what separate those.
 *
 * @param {object} entry - normalized learning entry.
 * @returns {string|null}
 */
export function learningSourceRecord(entry) {
  return sourceRecordValue(entry?.id);
}

/**
 * Render the `source-record:` frontmatter line, or `''` when the entry has no
 * representable record key.
 * @param {string|null} value - output of {@link sourceRecordValue}.
 * @returns {string}
 */
export function sourceRecordLine(value) {
  return value === null ? '' : `source-record: "${value}"\n`;
}

const firstString = (...vals) => vals.find((v) => typeof v === 'string' && v.length > 0);

const joinList = (v) =>
  Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string') ? v.join(', ') : undefined;

/**
 * Map known producer alias fields onto the canonical v1 shape (#635).
 *
 * Newer producers (evolve consolidation, memory-propose, dialectic) emit
 * field families the v1 validator rejects — summary/detail, description/rationale,
 * title/body/how_to_apply, content, narrative, name — causing up to 44% of
 * learnings to be skipped-invalid at mirror time. Rather than one generator per
 * producer family, this pure function fills MISSING canonical fields from their
 * aliases and leaves canonical v1/v2 entries byte-identical (pass-through).
 *
 * Returns a new object; never mutates the input. Entries that lack any insight
 * source remain incomplete and still fail validation (intentional — content-free
 * records should stay skipped-invalid).
 */
export function normalizeLearningEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  if (typeof entry.text === 'string') return entry; // v2 — canonical, untouched
  const e = { ...entry };

  if (!firstString(e.insight)) {
    e.insight = firstString(e.detail, e.rationale, e.body, e.narrative, e.content, e.how_to_apply);
  }
  if (!firstString(e.subject)) {
    e.subject = firstString(e.summary, e.title, e.name);
  }
  // `description` is ambiguous: insight-like next to name/title, subject-like
  // next to rationale/detail. Assign it to whichever slot is still empty.
  if (!firstString(e.insight)) e.insight = firstString(e.description);
  else if (!firstString(e.subject)) e.subject = firstString(e.description);
  if (!firstString(e.subject) && firstString(e.insight)) {
    e.subject = truncateAtWord(e.insight, 80);
  }

  if (e.evidence === null || e.evidence === undefined || e.evidence === '') {
    e.evidence = joinList(e.evidence_sessions) ?? joinList(e.files) ?? joinList(e.sessions) ?? '(none recorded)';
  }
  if (e.id === null || e.id === undefined) {
    // subjectToSlug strips whitespace without hyphenating (designed for
    // kebab-ish inputs) — pre-map whitespace to hyphens for prose subjects.
    const derived = firstString(e.subject) ? subjectToSlug(e.subject.trim().replace(/\s+/g, '-')) : '';
    if (isValidSlug(derived)) e.id = derived;
  }
  if (e.source_session === null || e.source_session === undefined) {
    e.source_session =
      firstString(e.session_id, Array.isArray(e.sessions) ? e.sessions[0] : undefined, e._provenance) ?? 'unknown';
  }
  if (e.created_at === null || e.created_at === undefined) {
    e.created_at = firstString(e.first_seen, e.last_seen, e.updated_at);
  }
  if (e.type === null || e.type === undefined) e.type = 'general';

  return e;
}

export function generateLearningNote(entry, slug, opts = {}) {
  const REQUIRED_LEARNING_FIELDS = ['id', 'type', 'subject', 'insight', 'evidence', 'confidence', 'source_session', 'created_at'];
  for (const field of REQUIRED_LEARNING_FIELDS) {
    if (entry[field] === null || entry[field] === undefined) {
      throw new Error(`vault-mirror: learning entry missing required field '${field}' (id=${entry.id ?? '<no id>'})`);
    }
  }

  const { id: _id, type, subject: _subject, insight, evidence, confidence, source_session, created_at, expires_at } = entry;

  const status = confidence > 0.8 ? 'verified' : 'draft';
  const created = toDate(created_at);
  const updated = toDate(created_at);
  const expires = toDate(expires_at);

  const titleRaw = truncateAtWord(insight, 80);
  const title = yamlQuoteIfNeeded(titleRaw);

  // #602: type/status are interpolated raw upstream; route every tag segment
  // through buildTag so each is kebab-slugified and capped at 64 chars. The
  // existing source/<session> slug is preserved (buildTag is idempotent for an
  // already-kebab value and adds the length cap).
  const sourceTag = subjectToSlug(String(source_session)) || 'unknown';
  const tags = `[${buildTag(['learning', type])}, ${buildTag(['status', status])}, ${buildTag(['source', sourceTag])}]`;

  // Check if expires has a value; it's optional in schema
  const expiresLine = expires ? `expires: ${expires}\n` : '';

  // #725 D2: emit `source-repo` for cross-repo attribution when the caller
  // (process.mjs) threads the resolved repo namespace through opts.repoNs. The
  // value is already sanitised + leak-guarded by resolveRepoNamespace. Absent for
  // older callers / unit tests → the line is omitted (backward-compatible; the
  // vault-sync schema declares source-repo OPTIONAL).
  const sourceRepoLine =
    typeof opts.repoNs === 'string' && opts.repoNs.length > 0 ? `source-repo: ${opts.repoNs}\n` : '';
  // #1503: the record this note was rendered from — process.mjs refuses to
  // overwrite a note whose `source-record` names a different record.
  const recordLine = sourceRecordLine(learningSourceRecord(entry));

  // source_session is emitted as an Obsidian wikilink ONLY when source_session
  // resolves to a real, mirror-able session id (semantic or UUID-v4). Anything
  // else — 'unknown', legacy timestamp ids without a trailing counter, provenance
  // tags, etc. — is emitted as plain text to prevent dangling [[unknown]] /
  // [[malformed]] links in the vault (Issue #704 bugs A + B). Tags are fed by
  // sourceTag (L102 above) which is independent of this link decision.
  const { isLink: _srcIsLink, target: _srcTarget } = resolveSourceSessionLink(source_session, { noteExists: opts.noteExists });
  const sourceSessionLink = _srcIsLink ? `"[[${_srcTarget}]]"` : yamlQuoteIfNeeded(_srcTarget);
  const sourceSessionBodyLink = _srcIsLink ? `[[${_srcTarget}]]` : _srcTarget;

  return `---
id: ${slug}
type: learning
title: ${title}
status: ${status}
created: ${created}
updated: ${updated}
tags: ${tags}
source_session: ${sourceSessionLink}
${expiresLine}${sourceRepoLine}${recordLine}_generator: ${GENERATOR_MARKER}
---

# ${titleRaw}

- **Type:** ${type}
- **Confidence:** ${confidence}
- **Source session:** ${sourceSessionBodyLink}

## Insight

${insight}

## Evidence

${evidence}
`;
}

export function generateLearningNoteV2(entry, slug, opts = {}) {
  const REQUIRED_LEARNING_V2_FIELDS = ['id', 'type', 'text', 'scope', 'confidence', 'first_seen'];
  for (const field of REQUIRED_LEARNING_V2_FIELDS) {
    if (entry[field] === null || entry[field] === undefined) {
      throw new Error(`vault-mirror: learning entry missing required field '${field}' (id=${entry.id ?? '<no id>'})`);
    }
  }

  const { type, text, scope, confidence, first_seen } = entry;

  const status = confidence > 0.8 ? 'verified' : 'draft';
  const created = toDate(first_seen);
  const updated = created;

  const titleRaw = truncateAtWord(text, 80);
  const title = yamlQuoteIfNeeded(titleRaw);

  // #602: type/status interpolated raw upstream — slugify + cap each segment.
  const scopeTag = subjectToSlug(scope) || 'unscoped';
  const tags = `[${buildTag(['learning', type])}, ${buildTag(['status', status])}, ${buildTag(['scope', scopeTag])}]`;

  // #725 D2: emit `source-repo` for cross-repo attribution when the caller threads
  // opts.repoNs (see generateLearningNote for the full contract). Backward-compatible.
  const sourceRepoLine =
    typeof opts.repoNs === 'string' && opts.repoNs.length > 0 ? `source-repo: ${opts.repoNs}\n` : '';
  // #1503: see generateLearningNote.
  const recordLine = sourceRecordLine(learningSourceRecord(entry));

  return `---
id: ${slug}
type: learning
title: ${title}
status: ${status}
created: ${created}
updated: ${updated}
tags: ${tags}
${sourceRepoLine}${recordLine}_generator: ${GENERATOR_MARKER}
---

# ${titleRaw}

- **Type:** ${type}
- **Confidence:** ${confidence}
- **Scope:** ${scope}

## Insight

${text}
`;
}
