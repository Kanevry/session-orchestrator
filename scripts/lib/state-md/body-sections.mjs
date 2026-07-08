/**
 * Body-section helpers for STATE.md.
 *
 * Pure functions — no file I/O.
 *
 * Plus on-disk wrappers (`appendDeviationOnDisk`, `markExpressPathCompleteOnDisk`,
 * `recordAutoCommitOnDisk`) added for PRD 2026-05-22 § 4 Pattern 1 (issue #518).
 * The on-disk wrappers delegate to the pure helpers above and route the
 * read+write cycle through `writeStateMd` from frontmatter-mutators.mjs, which
 * acquires `.orchestrator/state.lock` for mechanical serialization (PSA-004).
 */

import { parseStateMd, serializeStateMd } from './yaml-parser.mjs';
import {
  updateFrontmatterFields,
  touchUpdatedField,
  writeStateMd,
} from './frontmatter-mutators.mjs';

/**
 * Extracts the current-wave banner info from the `## Current Wave` body
 * section: first non-blank line after the heading.
 *
 * @param {string} contents
 * @returns {{waveNumber: number|null, description: string}|null}
 */
export function readCurrentTask(contents) {
  const parsed = parseStateMd(contents);
  if (parsed === null) return null;
  const lines = parsed.body.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !/^##\s+Current Wave\b/.test(lines[i])) i++;
  if (i === lines.length) return null;
  i++;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i === lines.length) return null;
  const description = lines[i].trim();
  const waveMatch = /^Wave\s+(\d+)\b/.exec(description);
  const waveNumber = waveMatch ? parseInt(waveMatch[1], 10) : null;
  return { waveNumber, description };
}

/**
 * Appends a timestamped bullet to the `## Deviations` section in the STATE.md body.
 * Creates the section if missing. Replaces a `(none yet)` placeholder if present.
 *
 * Defensive guard (issue #560): when `isoTimestamp` is omitted, `undefined`, `null`,
 * or a non-string value, defaults to `new Date().toISOString()`. This prevents the
 * literal text `undefined` from rendering in the deviations log when a caller
 * forgets to compute the timestamp (the deep-2115 inter-wave 2→3 incident).
 *
 * @param {string} contents
 * @param {string} [isoTimestamp] - ISO 8601 UTC, e.g. '2026-05-01T17:50:00Z'.
 *   When omitted or not a non-empty string, defaults to `new Date().toISOString()`.
 * @param {string} message - free text; no leading dash, no surrounding brackets
 * @returns {string}
 */
export function appendDeviation(contents, isoTimestamp, message) {
  const parsed = parseStateMd(contents);
  if (parsed === null) return contents;
  const ts = (typeof isoTimestamp === 'string' && isoTimestamp.length > 0)
    ? isoTimestamp
    : new Date().toISOString();
  const bullet = `- [${ts}] ${message}`;
  const lines = parsed.body.split('\n');
  let headingIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Deviations\b/.test(lines[i])) {
      headingIdx = i;
      break;
    }
  }
  if (headingIdx === -1) {
    // Append section at end of body. Ensure trailing newline before adding section.
    let bodyOut = parsed.body;
    if (!bodyOut.endsWith('\n')) bodyOut += '\n';
    bodyOut += `\n## Deviations\n\n${bullet}\n`;
    return serializeStateMd({ frontmatter: parsed.frontmatter, body: bodyOut });
  }
  // Find end-of-section: next `## ` heading or end of lines.
  let sectionEnd = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }
  // Within section body (headingIdx+1 .. sectionEnd-1), look for placeholder
  // or last bullet.
  let placeholderIdx = -1;
  let lastBulletIdx = -1;
  for (let i = headingIdx + 1; i < sectionEnd; i++) {
    const t = lines[i].trim();
    if (t === '(none yet)' || t === '_(none yet)_' || t === '*(none yet)*') {
      placeholderIdx = i;
    }
    if (/^-\s+/.test(t)) {
      lastBulletIdx = i;
    }
  }
  if (placeholderIdx !== -1) {
    lines[placeholderIdx] = bullet;
  } else if (lastBulletIdx !== -1) {
    lines.splice(lastBulletIdx + 1, 0, bullet);
  } else {
    // Insert after heading, with one blank line between heading and bullet.
    // Trim any leading blank lines in section, then insert.
    let insertAt = headingIdx + 1;
    // Skip existing blank lines after heading
    while (insertAt < sectionEnd && lines[insertAt].trim() === '') insertAt++;
    // We want exactly: heading, blank, bullet, [existing trailing content].
    const before = lines.slice(0, headingIdx + 1);
    const after = lines.slice(insertAt);
    const rebuilt = [...before, '', bullet, ...after];
    return serializeStateMd({
      frontmatter: parsed.frontmatter,
      body: rebuilt.join('\n'),
    });
  }
  return serializeStateMd({
    frontmatter: parsed.frontmatter,
    body: lines.join('\n'),
  });
}

/**
 * Maximum number of top-level `## What Not To Retry` entries retained.
 *
 * "Pruned on success" (issue #623) is implemented as a simple last-N FIFO:
 * after each append, the section is trimmed to the most-recent
 * `MAX_WHAT_NOT_TO_RETRY` entries (oldest dropped first). This is NOT a
 * per-entry success-clear — entries are not individually retired when an
 * approach later succeeds; the cap is the only pruning mechanism. The slot is
 * a cross-session continuity record that SURVIVES the completed-branch Idle
 * Reset (unlike per-session `## Deviations`).
 */
export const MAX_WHAT_NOT_TO_RETRY = 10;

/**
 * Collapse every run of CR/LF into a single space (#623).
 *
 * `## What Not To Retry` entries are single-line bullets and `readWhatNotToRetry`
 * reads ONE line per field, so an embedded newline in `approach` or `why_failed`
 * would lose everything after line 1 on round-trip. Collapsing here keeps the
 * entry single-line and lossless. Leading/trailing whitespace introduced by the
 * collapse is trimmed.
 *
 * @param {string} value
 * @returns {string}
 */
function collapseNewlines(value) {
  return value.replace(/\r?\n+/g, ' ').trim();
}

/**
 * Reads the `## What Not To Retry` section into an array of entries.
 *
 * Each top-level `- **<approach>** (<session_id>, <date>)` bullet (optionally
 * followed by an indented `- why: <why_failed>` sub-bullet) becomes one entry.
 * Returns `[]` when the section is absent, empty, or holds only the
 * `(none yet)` placeholder. Returns `[]` on unparseable input.
 *
 * @param {string} contents
 * @returns {Array<{approach: string, why_failed: string, session_id: string, date: string}>}
 */
export function readWhatNotToRetry(contents) {
  const parsed = parseStateMd(contents);
  if (parsed === null) return [];
  const lines = parsed.body.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !/^##\s+What Not To Retry\b/.test(lines[i])) i++;
  if (i === lines.length) return [];
  i++;
  const entries = [];
  for (; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) break;
    // Top-level entry: `- **<approach>** (<session_id>, <date>)`
    const head = /^-\s+\*\*(.+?)\*\*\s+\((.+),\s*(.+)\)\s*$/.exec(lines[i]);
    if (!head) continue;
    const approach = head[1];
    const session_id = head[2].trim();
    const date = head[3].trim();
    let why_failed = '';
    // Look ahead for the `- why: <...>` sub-bullet within this entry.
    for (let j = i + 1; j < lines.length; j++) {
      if (/^##\s+/.test(lines[j])) break;
      if (/^-\s+\*\*/.test(lines[j].trim())) break; // next top-level entry
      const why = /^-\s+why:\s*(.*)$/.exec(lines[j].trim());
      if (why) {
        why_failed = why[1];
        break;
      }
    }
    entries.push({ approach, why_failed, session_id, date });
  }
  return entries;
}

/**
 * Appends an entry to the `## What Not To Retry` section in the STATE.md body.
 *
 * Creates the section if missing. Replaces a `(none yet)` placeholder if
 * present. After appending, prunes the section to the most-recent
 * `MAX_WHAT_NOT_TO_RETRY` top-level entries (FIFO — oldest dropped first).
 *
 * Mirrors `appendDeviation` in structure. No-op (returns input unchanged) on
 * unparseable input.
 *
 * @param {string} contents
 * @param {object} entry
 * @param {string} [entry.approach]      — the approach that failed; defaults to '(unspecified approach)'
 * @param {string} [entry.why_failed]    — why it failed; defaults to '(no reason recorded)'
 * @param {string} [entry.session_id]    — originating session id; defaults to 'unknown-session'
 * @param {string} [entry.date]          — YYYY-MM-DD; defaults to today (UTC date slice)
 * @returns {string}
 */
export function appendWhatNotToRetry(contents, entry) {
  const parsed = parseStateMd(contents);
  if (parsed === null) return contents;
  const e = entry || {};
  const approach = (typeof e.approach === 'string' && e.approach.length > 0)
    ? e.approach
    : '(unspecified approach)';
  const why = (typeof e.why_failed === 'string' && e.why_failed.length > 0)
    ? e.why_failed
    : '(no reason recorded)';
  const sid = (typeof e.session_id === 'string' && e.session_id.length > 0)
    ? e.session_id
    : 'unknown-session';
  const date = (typeof e.date === 'string' && e.date.length > 0)
    ? e.date
    : new Date().toISOString().slice(0, 10);

  // Collapse embedded newlines (#623): the entry renders as single-line bullets
  // (`- **<approach>**` + `  - why: <why>`), and readWhatNotToRetry reads ONE
  // line per field. A multi-line `approach`/`why_failed` would silently truncate
  // everything after line 1 on round-trip. Collapse `\r?\n+` runs to a single
  // space so the entry stays single-line and round-trips losslessly.
  const headBullet = `- **${collapseNewlines(approach)}** (${sid}, ${date})`;
  const whyBullet = `  - why: ${collapseNewlines(why)}`;

  const lines = parsed.body.split('\n');
  let headingIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+What Not To Retry\b/.test(lines[i])) {
      headingIdx = i;
      break;
    }
  }

  let rebuiltBody;
  if (headingIdx === -1) {
    // Append section at end of body. Ensure trailing newline before adding.
    let bodyOut = parsed.body;
    if (!bodyOut.endsWith('\n')) bodyOut += '\n';
    bodyOut += `\n## What Not To Retry\n\n${headBullet}\n${whyBullet}\n`;
    rebuiltBody = bodyOut;
  } else {
    // Find end-of-section: next `## ` heading or end of lines.
    let sectionEnd = lines.length;
    for (let i = headingIdx + 1; i < lines.length; i++) {
      if (/^##\s+/.test(lines[i])) {
        sectionEnd = i;
        break;
      }
    }
    // Look for placeholder or last top-level entry bullet within the section.
    let placeholderIdx = -1;
    let lastEntryIdx = -1;
    for (let i = headingIdx + 1; i < sectionEnd; i++) {
      const t = lines[i].trim();
      if (t === '(none yet)' || t === '_(none yet)_' || t === '*(none yet)*') {
        placeholderIdx = i;
      }
      if (/^-\s+\*\*/.test(t)) {
        lastEntryIdx = i;
      }
    }
    if (placeholderIdx !== -1) {
      // Replace the placeholder line with the head bullet, then insert why.
      lines.splice(placeholderIdx, 1, headBullet, whyBullet);
    } else if (lastEntryIdx !== -1) {
      // Insert after the last entry's why sub-bullet (or the entry itself):
      // scan forward over any indented sub-bullets belonging to lastEntryIdx.
      let insertAt = lastEntryIdx + 1;
      while (
        insertAt < sectionEnd &&
        lines[insertAt].trim() !== '' &&
        !/^-\s+\*\*/.test(lines[insertAt].trim()) &&
        /^\s+-\s+/.test(lines[insertAt])
      ) {
        insertAt++;
      }
      lines.splice(insertAt, 0, headBullet, whyBullet);
    } else {
      // Empty section (heading only): insert heading, blank, entry, why.
      let insertAt = headingIdx + 1;
      while (insertAt < sectionEnd && lines[insertAt].trim() === '') insertAt++;
      const before = lines.slice(0, headingIdx + 1);
      const after = lines.slice(insertAt);
      const rebuilt = [...before, '', headBullet, whyBullet, ...after];
      rebuiltBody = rebuilt.join('\n');
    }
    if (rebuiltBody === undefined) {
      rebuiltBody = lines.join('\n');
    }
  }

  // Prune to the most-recent MAX_WHAT_NOT_TO_RETRY top-level entries (FIFO).
  rebuiltBody = pruneWhatNotToRetry(rebuiltBody);

  return serializeStateMd({ frontmatter: parsed.frontmatter, body: rebuiltBody });
}

/**
 * Trims the `## What Not To Retry` section to the most-recent
 * `MAX_WHAT_NOT_TO_RETRY` top-level entries, dropping the oldest. Each entry is
 * its top-level `- **...**` bullet plus any immediately-following indented
 * sub-bullets (e.g. `  - why: ...`). No-op when the section is absent or the
 * entry count is at/under the cap.
 *
 * @param {string} body — STATE.md body (no frontmatter)
 * @returns {string}
 */
function pruneWhatNotToRetry(body) {
  const lines = body.split('\n');
  let headingIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+What Not To Retry\b/.test(lines[i])) {
      headingIdx = i;
      break;
    }
  }
  if (headingIdx === -1) return body;
  let sectionEnd = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }
  // Collect the start index of each top-level entry within the section.
  const entryStarts = [];
  for (let i = headingIdx + 1; i < sectionEnd; i++) {
    if (/^-\s+\*\*/.test(lines[i].trim())) entryStarts.push(i);
  }
  if (entryStarts.length <= MAX_WHAT_NOT_TO_RETRY) return body;
  // Keep the last MAX_WHAT_NOT_TO_RETRY entries; drop everything from the first
  // entry up to (but not including) the first kept entry.
  const dropCount = entryStarts.length - MAX_WHAT_NOT_TO_RETRY;
  const firstKeptIdx = entryStarts[dropCount];
  const firstDropIdx = entryStarts[0];
  lines.splice(firstDropIdx, firstKeptIdx - firstDropIdx);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Open Questions (Close Handover-Alignment-Gate, PRD 2026-07-07)
// ---------------------------------------------------------------------------
//
// Unresolved user-facing questions surfaced by wave agents during a session,
// collected at inter-wave checkpoints, and (optionally) marked answered by
// session-end. This is a cross-session-visible channel — unlike per-session
// `## Deviations`, unanswered questions are meant to surface to the NEXT
// session's operator via the Handover-Alignment-Gate.
//
// SSOT format note: the bullet template lives in ONE place
// (`formatOpenQuestionBullet`) and `OPEN_QUESTION_RE` is the ONE regex that
// parses it back. A reader regex that drifts from the writer's template
// silently returns `[]` on any format change — the narrative-mirror.mjs
// lockstep gotcha. Keep both derived from this single definition.

/**
 * Maximum number of `## Open Questions` entries retained on disk.
 *
 * This is a storage cap (FIFO, oldest dropped first) — distinct from the
 * Handover-Alignment-Gate's own `max-open-questions` config, which caps how
 * many questions are surfaced/asked in a single gate run, not how many are
 * stored in STATE.md.
 */
export const MAX_OPEN_QUESTIONS_STORED = 20;

/**
 * Builds a single `## Open Questions` bullet line from an entry. The single
 * source of truth for the on-disk format — `OPEN_QUESTION_RE` below MUST stay
 * in lockstep with this template.
 *
 * @param {object} entry
 * @param {string} entry.question
 * @param {string} entry.source
 * @param {'high'|'medium'|'low'} entry.priority
 * @param {boolean} [entry.answered=false]
 * @param {string} [entry.answer]
 * @returns {string}
 */
function formatOpenQuestionBullet({ question, source, priority, answered = false, answer }) {
  const base = `- [${answered ? 'x' : ' '}] ${question} (source: ${source}, prio: ${priority})`;
  if (answered) {
    return `${base} → Antwort: ${typeof answer === 'string' ? answer : ''}`;
  }
  return base;
}

/**
 * Parses one `## Open Questions` bullet line. Derived in lockstep with
 * `formatOpenQuestionBullet` — see the SSOT note above.
 *
 * Capture groups: 1=checkbox state (' '|'x'), 2=question, 3=source,
 * 4=priority, 5=answer (only present when checkbox is 'x' and an
 * `→ Antwort: ...` suffix follows).
 *
 * The `source` group intentionally uses `(.+?)` rather than a comma-excluding
 * `([^,]+?)`: the writer (`formatOpenQuestionBullet`) permits free-text
 * `source` values that may themselves contain a comma (e.g.
 * `'W2/agent-desc, extra'`). A comma-intolerant capture would silently fail to
 * match such a writer-valid bullet — the question would vanish from the
 * roundtrip with no error. `(.+?)` stays unambiguously anchored because the
 * lazy quantifier backtracks until it finds the trailing
 * `,\s*prio:(high|medium|low)\)` literal, which cannot itself appear inside a
 * legitimate `source` value.
 */
const OPEN_QUESTION_RE =
  /^-\s+\[([ x])\]\s+(.+?)\s+\(source:\s*(.+?),\s*prio:\s*(high|medium|low)\)(?:\s*→\s*Antwort:\s*(.*))?$/;

/**
 * Reads the `## Open Questions` section into an array of entries.
 *
 * Returns `[]` when the section is absent, empty, holds only the
 * `(none yet)` placeholder, or on unparseable input. Lines that do not match
 * `OPEN_QUESTION_RE` (malformed bullets) are silently skipped rather than
 * throwing — tolerant of hand-edited STATE.md content.
 *
 * @param {string} contents
 * @returns {Array<{question: string, source: string, priority: 'high'|'medium'|'low', answered: boolean, answer?: string}>}
 */
export function readOpenQuestions(contents) {
  const parsed = parseStateMd(contents);
  if (parsed === null) return [];
  const lines = parsed.body.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !/^##\s+Open Questions\b/.test(lines[i])) i++;
  if (i === lines.length) return [];
  i++;
  const entries = [];
  for (; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) break;
    const m = OPEN_QUESTION_RE.exec(lines[i].trim());
    if (!m) continue;
    const answered = m[1] === 'x';
    const entry = {
      question: m[2].trim(),
      source: m[3].trim(),
      priority: m[4],
      answered,
    };
    if (answered && typeof m[5] === 'string') {
      entry.answer = m[5].trim();
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * Appends an entry to the `## Open Questions` section in the STATE.md body.
 *
 * Creates the section if missing. Replaces a `(none yet)` placeholder if
 * present. Deduplicates by question text — keyed replace-else-append, like
 * `setMissionStatus` (mission-status.mjs): if an existing bullet's question
 * text matches (after newline-collapse + trim), it is replaced in place
 * (reset to unanswered) rather than duplicated. After appending, prunes the
 * section to the most-recent `MAX_OPEN_QUESTIONS_STORED` entries (FIFO —
 * oldest dropped first).
 *
 * No-op (returns input unchanged) on unparseable input.
 *
 * @param {string} contents
 * @param {object} entry
 * @param {string} [entry.question]  — defaults to '(unspecified question)'
 * @param {string} [entry.source]    — defaults to 'unknown-source'
 * @param {'high'|'medium'|'low'} [entry.priority] — defaults to 'medium'
 * @returns {string}
 */
export function appendOpenQuestion(contents, entry) {
  const parsed = parseStateMd(contents);
  if (parsed === null) return contents;
  const e = entry || {};
  const question = (typeof e.question === 'string' && e.question.length > 0)
    ? collapseNewlines(e.question)
    : '(unspecified question)';
  const source = (typeof e.source === 'string' && e.source.length > 0)
    ? collapseNewlines(e.source)
    : 'unknown-source';
  const priority = ['high', 'medium', 'low'].includes(e.priority) ? e.priority : 'medium';

  const bullet = formatOpenQuestionBullet({ question, source, priority, answered: false });

  const lines = parsed.body.split('\n');
  let headingIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Open Questions\b/.test(lines[i])) {
      headingIdx = i;
      break;
    }
  }

  let rebuiltBody;
  if (headingIdx === -1) {
    // Append section at end of body. Ensure trailing newline before adding.
    let bodyOut = parsed.body;
    if (!bodyOut.endsWith('\n')) bodyOut += '\n';
    bodyOut += `\n## Open Questions\n\n${bullet}\n`;
    rebuiltBody = bodyOut;
  } else {
    // Find end-of-section: next `## ` heading or end of lines.
    let sectionEnd = lines.length;
    for (let i = headingIdx + 1; i < lines.length; i++) {
      if (/^##\s+/.test(lines[i])) {
        sectionEnd = i;
        break;
      }
    }
    // Look for a dedup match, a placeholder, or the last bullet within the section.
    let existingIdx = -1;
    let placeholderIdx = -1;
    let lastBulletIdx = -1;
    for (let i = headingIdx + 1; i < sectionEnd; i++) {
      const t = lines[i].trim();
      if (t === '(none yet)' || t === '_(none yet)_' || t === '*(none yet)*') {
        placeholderIdx = i;
      }
      const m = OPEN_QUESTION_RE.exec(t);
      if (m) {
        lastBulletIdx = i;
        if (m[2].trim() === question) existingIdx = i;
      }
    }
    if (existingIdx !== -1) {
      lines[existingIdx] = bullet;
    } else if (placeholderIdx !== -1) {
      lines[placeholderIdx] = bullet;
    } else if (lastBulletIdx !== -1) {
      lines.splice(lastBulletIdx + 1, 0, bullet);
    } else {
      // Empty section (heading only): insert heading, blank, bullet.
      let insertAt = headingIdx + 1;
      while (insertAt < sectionEnd && lines[insertAt].trim() === '') insertAt++;
      const before = lines.slice(0, headingIdx + 1);
      const after = lines.slice(insertAt);
      const rebuilt = [...before, '', bullet, ...after];
      rebuiltBody = rebuilt.join('\n');
    }
    if (rebuiltBody === undefined) {
      rebuiltBody = lines.join('\n');
    }
  }

  rebuiltBody = pruneOpenQuestions(rebuiltBody);

  return serializeStateMd({ frontmatter: parsed.frontmatter, body: rebuiltBody });
}

/**
 * Trims the `## Open Questions` section to the most-recent
 * `MAX_OPEN_QUESTIONS_STORED` entries, dropping the oldest. Unlike
 * `## What Not To Retry`, each entry is exactly one line (no sub-bullets).
 * No-op when the section is absent or the entry count is at/under the cap.
 *
 * @param {string} body — STATE.md body (no frontmatter)
 * @returns {string}
 */
function pruneOpenQuestions(body) {
  const lines = body.split('\n');
  let headingIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Open Questions\b/.test(lines[i])) {
      headingIdx = i;
      break;
    }
  }
  if (headingIdx === -1) return body;
  let sectionEnd = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }
  const entryIdxs = [];
  for (let i = headingIdx + 1; i < sectionEnd; i++) {
    if (OPEN_QUESTION_RE.test(lines[i].trim())) entryIdxs.push(i);
  }
  if (entryIdxs.length <= MAX_OPEN_QUESTIONS_STORED) return body;
  const dropCount = entryIdxs.length - MAX_OPEN_QUESTIONS_STORED;
  const firstKeptIdx = entryIdxs[dropCount];
  const firstDropIdx = entryIdxs[0];
  lines.splice(firstDropIdx, firstKeptIdx - firstDropIdx);
  return lines.join('\n');
}

/**
 * Flips an unanswered `## Open Questions` bullet to answered:
 * `- [ ] <q> (...)` → `- [x] <q> (...) → Antwort: <answer>`.
 *
 * No-op (returns input unchanged) when: the section is absent, the question
 * text is not found (matched by trimmed, newline-collapsed equality against
 * each bullet's question field), or the matched bullet is already answered.
 *
 * @param {string} contents
 * @param {string} question — must match an existing unanswered bullet's question text
 * @param {string} answer
 * @returns {string}
 */
export function markOpenQuestionAnswered(contents, question, answer) {
  const parsed = parseStateMd(contents);
  if (parsed === null) return contents;
  if (typeof question !== 'string' || question.length === 0) return contents;
  const needle = collapseNewlines(question);

  const lines = parsed.body.split('\n');
  let headingIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Open Questions\b/.test(lines[i])) {
      headingIdx = i;
      break;
    }
  }
  if (headingIdx === -1) return contents;
  let sectionEnd = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }

  for (let i = headingIdx + 1; i < sectionEnd; i++) {
    const m = OPEN_QUESTION_RE.exec(lines[i].trim());
    if (!m) continue;
    if (m[2].trim() !== needle) continue;
    if (m[1] === 'x') return contents; // already answered — no-op
    lines[i] = formatOpenQuestionBullet({
      question: m[2].trim(),
      source: m[3].trim(),
      priority: m[4],
      answered: true,
      answer: typeof answer === 'string' ? collapseNewlines(answer) : '',
    });
    return serializeStateMd({ frontmatter: parsed.frontmatter, body: lines.join('\n') });
  }
  return contents; // question not found
}

/**
 * Records an auto-commit checkpoint in the `## Deviations` section of STATE.md.
 *
 * Phase-1 stub — appends a human-readable deviation entry only. Does NOT perform
 * any git operations. The procedural commit body (`scripts/lib/auto-commit.mjs`)
 * is deferred to V3.6 (GitLab #214). Until then, callers (wave-executor coordinator)
 * invoke this function AFTER the git commit succeeds to create the audit trail.
 *
 * @param {string} contents - current STATE.md text
 * @param {object} options
 * @param {string} options.sha - short git SHA of the auto-commit (e.g. 'a1b2c3d')
 * @param {number} options.waveN - wave number that triggered the checkpoint
 * @param {string} options.waveResultSummary - one-line summary, e.g. 'Impl-Core, Quality-Lite PASS, 12 files'
 * @param {string} [options.timestamp] - ISO 8601 UTC; defaults to current time
 * @returns {string} updated STATE.md text
 */
export function recordAutoCommit(contents, options) {
  const opts = options || {};
  const { sha, waveN, waveResultSummary } = opts;
  const timestamp = opts.timestamp ?? new Date().toISOString();
  const message = `Wave ${waveN} auto-commit: ${sha} (${waveResultSummary})`;
  return appendDeviation(contents, timestamp, message);
}

/**
 * Finalizes a STATE.md after express-path coord-direct execution.
 * Sets `status: completed`, appends an `Express path:` deviation, refreshes `updated`.
 * No-op (returns input unchanged) if `contents` is unparseable.
 *
 * @param {string} contents
 * @param {object} options
 * @param {number} options.taskCount - number of tasks executed coord-direct (required)
 * @param {string} [options.sessionType='housekeeping']
 * @param {boolean} [options.expressPathEnabled=true]
 * @param {string} [options.timestamp] - ISO 8601, defaults to current time
 * @returns {string}
 */
export function markExpressPathComplete(contents, options) {
  const parsed = parseStateMd(contents);
  if (parsed === null) return contents;
  const opts = options || {};
  const taskCount = opts.taskCount;
  const sessionType = opts.sessionType ?? 'housekeeping';
  const expressPathEnabled = opts.expressPathEnabled ?? true;
  const timestamp = opts.timestamp ?? new Date().toISOString();
  const message = `Express path: ${taskCount} tasks executed coord-direct (express-path.enabled: ${expressPathEnabled}, session-type: ${sessionType}, scope: ${taskCount} issues)`;
  let next = updateFrontmatterFields(contents, { status: 'completed' });
  next = appendDeviation(next, timestamp, message);
  next = touchUpdatedField(next, timestamp);
  return next;
}

// ---------------------------------------------------------------------------
// On-disk wrappers (PRD 2026-05-22 § 4 — Pattern 1, issue #518)
// ---------------------------------------------------------------------------

/**
 * Guard: throws a clear Error when repoRoot is undefined, null, or empty.
 * Parallel-session CWD drift (PSA rules) makes `process.cwd()` fallbacks a
 * footgun — callers MUST be explicit about which repo root they target.
 *
 * @param {unknown} repoRoot
 * @param {string} fnName  — name of the calling function, for error messages
 */
function requireRepoRoot(repoRoot, fnName) {
  if (!repoRoot) {
    throw new Error(
      `${fnName}: repoRoot is required (got ${typeof repoRoot}). Pass an explicit repo root, e.g. via execSync('git rev-parse --show-toplevel').`
    );
  }
}

/**
 * Lock-guarded append to the `## Deviations` section.
 *
 * Delegates to the pure `appendDeviation` helper; the read+write cycle is
 * serialized via `withStateMdLock` (PSA-004 mechanical enforcement).
 *
 * When `isoTimestamp` is omitted, `undefined`, `null`, or a non-string value,
 * the underlying `appendDeviation` defaults to `new Date().toISOString()` (issue #560).
 *
 * @param {string} repoRoot  — absolute path to the repository root (required)
 * @param {string} [isoTimestamp]  — defaults to current time if omitted
 * @param {string} message
 * @param {object} [opts]
 * @returns {Promise<{ written: boolean, path: string, contents: string|null }>}
 * @throws {Error} when repoRoot is undefined, null, or empty
 */
export async function appendDeviationOnDisk(repoRoot, isoTimestamp, message, opts = {}) {
  requireRepoRoot(repoRoot, 'appendDeviationOnDisk');
  return writeStateMd(
    repoRoot,
    (contents) => appendDeviation(contents, isoTimestamp, message),
    opts
  );
}

/**
 * Lock-guarded append to the `## What Not To Retry` section (#623).
 *
 * Delegates to the pure `appendWhatNotToRetry` helper; the read+write cycle is
 * serialized via `withStateMdLock` (PSA-005 mechanical enforcement).
 *
 * @param {string} repoRoot  — absolute path to the repository root (required)
 * @param {object} entry  See appendWhatNotToRetry signature above.
 * @param {object} [opts]
 * @returns {Promise<{ written: boolean, path: string, contents: string|null }>}
 * @throws {Error} when repoRoot is undefined, null, or empty
 */
export async function appendWhatNotToRetryOnDisk(repoRoot, entry, opts = {}) {
  requireRepoRoot(repoRoot, 'appendWhatNotToRetryOnDisk');
  return writeStateMd(
    repoRoot,
    (contents) => appendWhatNotToRetry(contents, entry),
    opts
  );
}

/**
 * Lock-guarded `recordAutoCommit` for express-path / wave-checkpoint flows.
 *
 * @param {string} repoRoot  — absolute path to the repository root (required)
 * @param {{ sha: string, waveN: number, waveResultSummary: string, timestamp?: string }} options
 * @param {object} [opts]
 * @returns {Promise<{ written: boolean, path: string, contents: string|null }>}
 * @throws {Error} when repoRoot is undefined, null, or empty
 */
export async function recordAutoCommitOnDisk(repoRoot, options, opts = {}) {
  requireRepoRoot(repoRoot, 'recordAutoCommitOnDisk');
  return writeStateMd(
    repoRoot,
    (contents) => recordAutoCommit(contents, options),
    opts
  );
}

/**
 * Lock-guarded `markExpressPathComplete` — used by session-end and the
 * express-path skill flow.
 *
 * @param {string} repoRoot  — absolute path to the repository root (required)
 * @param {object} options  See markExpressPathComplete signature above.
 * @param {object} [opts]
 * @returns {Promise<{ written: boolean, path: string, contents: string|null }>}
 * @throws {Error} when repoRoot is undefined, null, or empty
 */
export async function markExpressPathCompleteOnDisk(repoRoot, options, opts = {}) {
  requireRepoRoot(repoRoot, 'markExpressPathCompleteOnDisk');
  return writeStateMd(
    repoRoot,
    (contents) => markExpressPathComplete(contents, options),
    opts
  );
}

/**
 * Lock-guarded append to the `## Open Questions` section (Close
 * Handover-Alignment-Gate, PRD 2026-07-07).
 *
 * Delegates to the pure `appendOpenQuestion` helper; the read+write cycle is
 * serialized via `withStateMdLock` (PSA-005 mechanical enforcement — the
 * lock is acquired exclusively by `writeStateMd`, never by this wrapper
 * directly, to avoid a non-reentrant-mutex deadlock).
 *
 * @param {string} repoRoot  — absolute path to the repository root (required)
 * @param {object} entry  See appendOpenQuestion signature above.
 * @param {object} [opts]
 * @returns {Promise<{ written: boolean, path: string, contents: string|null }>}
 * @throws {Error} when repoRoot is undefined, null, or empty
 */
export async function appendOpenQuestionOnDisk(repoRoot, entry, opts = {}) {
  requireRepoRoot(repoRoot, 'appendOpenQuestionOnDisk');
  return writeStateMd(
    repoRoot,
    (contents) => appendOpenQuestion(contents, entry),
    opts
  );
}

/**
 * Lock-guarded `markOpenQuestionAnswered` — used by session-end to record an
 * answer against a previously-surfaced open question.
 *
 * @param {string} repoRoot  — absolute path to the repository root (required)
 * @param {string} question
 * @param {string} answer
 * @param {object} [opts]
 * @returns {Promise<{ written: boolean, path: string, contents: string|null }>}
 * @throws {Error} when repoRoot is undefined, null, or empty
 */
export async function markOpenQuestionAnsweredOnDisk(repoRoot, question, answer, opts = {}) {
  requireRepoRoot(repoRoot, 'markOpenQuestionAnsweredOnDisk');
  return writeStateMd(
    repoRoot,
    (contents) => markOpenQuestionAnswered(contents, question, answer),
    opts
  );
}
