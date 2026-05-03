/**
 * render-learnings.mjs — Learning markdown generators for vault-mirror (Issue #283 split).
 *
 * Exports: detectLearningSchema, generateLearningNote, generateLearningNoteV2
 */

import { toDate, truncateAtWord, yamlQuoteIfNeeded, subjectToSlug } from './utils.mjs';

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

export function generateLearningNote(entry, slug) {
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

  const sourceTag = subjectToSlug(String(source_session)) || 'unknown';
  const tags = `[learning/${type}, status/${status}, source/${sourceTag}]`;

  // Check if expires has a value; it's optional in schema
  const expiresLine = expires ? `expires: ${expires}\n` : '';

  // source_session emitted as Obsidian wikilink so the learning becomes a
  // graph edge to its 50-sessions/<id>.md note (Properties/Links docs:
  // wikilinks in YAML list/text properties must be quoted). Use the
  // already-sanitised sourceTag as link target so YAML stays valid even
  // when upstream source_session is corrupted (e.g. "[object").
  const sourceSessionLink = `"[[${sourceTag}]]"`;
  const sourceSessionBodyLink = `[[${sourceTag}]]`;

  return `---
id: ${slug}
type: learning
title: ${title}
status: ${status}
created: ${created}
updated: ${updated}
tags: ${tags}
source_session: ${sourceSessionLink}
${expiresLine}_generator: ${GENERATOR_MARKER}
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

export function generateLearningNoteV2(entry, slug) {
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

  const scopeTag = subjectToSlug(scope) || 'unscoped';
  const tags = `[learning/${type}, status/${status}, scope/${scopeTag}]`;

  return `---
id: ${slug}
type: learning
title: ${title}
status: ${status}
created: ${created}
updated: ${updated}
tags: ${tags}
_generator: ${GENERATOR_MARKER}
---

# ${titleRaw}

- **Type:** ${type}
- **Confidence:** ${confidence}
- **Scope:** ${scope}

## Insight

${text}
`;
}
