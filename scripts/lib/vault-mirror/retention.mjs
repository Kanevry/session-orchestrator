/**
 * retention.mjs — the retention rules shared by the vault mirror
 * (`process.mjs`, write side) and the bestand pruner
 * (`scripts/vault-mirror-prune.mjs`, cleanup side). Issue #1513.
 *
 * One module, so the mirror and the pruner cannot disagree about what counts
 * as narrative, as the same insight, as an archived note, or as a rollup row.
 * String functions plus one read-only directory probe
 * ({@link canonicalNamespace}); no clock (callers pass `today`).
 *
 * ## The rules (deterministic, documented in skills/vault-mirror/SKILL.md)
 *
 * - **Narrative gate (sessions).** A session record earns its own note only
 *   when its FREE-TEXT fields (`notes`, `narrative`, `summary`; strings, or
 *   arrays of strings) carry at least `min-narrative-chars` characters after
 *   whitespace collapse. Tables (waves, agents, files, effectiveness) are not
 *   narrative: they live in `sessions.jsonl` and in git. Calibrated against the
 *   Jev audit 2026-10-03 (3.003 notes): free text under 300 chars held 1 of
 *   2.802 notes scored >= 2.5 "information beyond git"; from 800 chars on, 18 of
 *   55. A record below the gate becomes ONE row in the month rollup
 *   `50-sessions/<ns>/_rollup-YYYY-MM.md`.
 * - **Same insight (learnings).** Two notes carry the same learning when their
 *   `## Insight` sections are equal after {@link normalizeInsight}.
 * - **Archived, not deleted.** A note that leaves the active set keeps its
 *   bytes; only `status:` becomes `archived` and an `archived-reason:` line
 *   names why. `archived` (not `expired`/`superseded`) because the vault
 *   frontmatter status enum (SSOT projects-baseline, mirrored in
 *   skills/vault-sync/validator.mjs) has no such values — a status outside it
 *   fails vault-sync in every vault whose mirror zones are not excluded.
 *
 * @module scripts/lib/vault-mirror/retention
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { subjectToSlug } from './utils.mjs';

/** The generator marker every mirror-written note carries. */
export const GENERATOR_MARKER = 'session-orchestrator-vault-mirror@1';

/** Reasons a note leaves the active zones. Closed set; the manifest uses it. */
export const ARCHIVE_REASONS = Object.freeze([
  'expired',
  'superseded',
  'duplicate',
  'metrics-only-session',
]);

/** Record fields that carry session free text (narrative), in render order. */
export const SESSION_NARRATIVE_FIELDS = Object.freeze(['notes', 'narrative', 'summary']);

/** Vault-relative archive root; the zone path is appended verbatim. */
export const ARCHIVE_ROOT = '90-archive/mirror';

/** Rollup filename prefix — `_` keeps it out of the session-note namespace. */
export const ROLLUP_PREFIX = '_rollup-';

const collapse = (s) => String(s).replace(/\s+/g, ' ').trim();

/**
 * Narrative character count of a session RECORD (the gate's measure).
 *
 * @param {object} entry sessions.jsonl record
 * @returns {number}
 */
/**
 * The session free text as it is RENDERED into the note's `## Notes` section:
 * every narrative field (strings and string-array items), in
 * {@link SESSION_NARRATIVE_FIELDS} order, blank-line separated. One function
 * for the renderer and the gate, so a record that passes the gate always
 * renders a note the pruner measures at least as long (#1513 review H2: the
 * gate counted `narrative`/`summary`, the renderer printed only `notes`, and
 * the pruner archived the empty note the mirror then re-created).
 *
 * @param {object} entry
 * @returns {string} '' when the record carries no free text
 */
export function sessionNarrativeText(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const parts = [];
  for (const field of SESSION_NARRATIVE_FIELDS) {
    const v = entry[field];
    const items = typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
    for (const item of items) if (item.trim()) parts.push(item.trim());
  }
  return parts.join('\n\n');
}

export function sessionNarrativeChars(entry) {
  if (!entry || typeof entry !== 'object') return 0;
  let total = 0;
  for (const field of SESSION_NARRATIVE_FIELDS) {
    const v = entry[field];
    if (typeof v === 'string') total += collapse(v).length;
    else if (Array.isArray(v)) {
      for (const item of v) if (typeof item === 'string') total += collapse(item).length;
    }
  }
  return total;
}

/**
 * Narrative character count of a rendered/on-disk session NOTE: the `## Notes`
 * section, which is where the renderers put the record's `notes` field. The
 * pruner uses this; it agrees with {@link sessionNarrativeChars} for every note
 * the v2/v3 renderers wrote.
 *
 * @param {string} content
 * @returns {number}
 */
export function noteNarrativeChars(content) {
  const text = section(content, 'Notes');
  return text === null ? 0 : collapse(text).length;
}

/**
 * Body of a `## <heading>` section up to the next `## ` heading, trimmed.
 *
 * @param {string} content
 * @param {string} heading
 * @returns {string|null} null when the heading is absent
 */
export function section(content, heading) {
  const lines = String(content ?? '').split('\n');
  const start = lines.findIndex((l) => l.trimEnd() === `## ${heading}`);
  if (start === -1) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ')) break;
    out.push(lines[i]);
  }
  return out.join('\n').trim();
}

/**
 * Normalise insight text for equality: case, whitespace, trailing punctuation
 * and typographic quotes/dashes are not content.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeInsight(text) {
  return collapse(
    String(text ?? '')
      .toLowerCase()
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[–—]/g, '-'),
  ).replace(/[\s.;:!,]+$/, '');
}

/**
 * Insight texts that are NOT a learning but a placeholder a tool wrote — equal
 * placeholders say nothing about two notes carrying the same learning (#1513
 * review M4). Matched against the normalised text.
 */
const PLACEHOLDER_INSIGHTS = Object.freeze([
  /^\(legacy record\b/,
  /^\(none recorded\)$/,
  /insight backfilled during/,
  /^\(no insight\b/,
  /^(?:n\/a|tbd|todo|unknown|none)$/,
]);

/** Shorter normalised insights are too generic to identify one learning. */
export const MIN_INSIGHT_KEY_CHARS = 40;

/**
 * The dedupe key of an insight text: normalised, or `''` (= never a
 * duplicate) for placeholders and texts under {@link MIN_INSIGHT_KEY_CHARS}.
 *
 * @param {string} text
 * @returns {string}
 */
export function insightDedupeKey(text) {
  const key = normalizeInsight(text);
  if (key.length < MIN_INSIGHT_KEY_CHARS) return '';
  return PLACEHOLDER_INSIGHTS.some((re) => re.test(key)) ? '' : key;
}

/** Dedupe key of a learning note's `## Insight`, or `''` (see {@link insightDedupeKey}). */
export function noteInsightKey(content) {
  return insightDedupeKey(section(content, 'Insight') ?? '');
}

const dehyphen = (s) => String(s).replace(/-/g, '');
const hyphenCount = (s) => (String(s).match(/-/g) || []).length;

/**
 * The hyphen-alias rule, shared by the mirror and the pruner (#1513 review
 * M2): among namespace folders that are equal modulo hyphens, the one with the
 * most hyphens is canonical (ties: lexicographic). The repo-identity fallback
 * that drops hyphens (`GotzendorferV2` → `gotzendorferv2`) and the
 * remote-derived name (`gotzendorfer-v2`) thereby land in one folder.
 *
 * @param {Iterable<string>} folders namespace folder names present
 * @param {string} ns
 * @returns {string} the canonical folder for `ns` (`ns` itself when none)
 */
export function canonicalAmong(folders, ns) {
  if (!ns) return ns;
  let best = ns;
  for (const f of folders) {
    if (f === best || dehyphen(f) !== dehyphen(ns)) continue;
    const better = hyphenCount(f) > hyphenCount(best) || (hyphenCount(f) === hyphenCount(best) && f < best);
    if (better) best = f;
  }
  return hyphenCount(best) > hyphenCount(ns) ? best : ns;
}

/**
 * {@link canonicalAmong} over the namespace folders that exist in the vault's
 * two mirror zones. Read-only; an unreadable zone contributes nothing.
 *
 * @param {string} vaultDir
 * @param {string} ns
 * @returns {string}
 */
export function canonicalNamespace(vaultDir, ns) {
  if (!ns) return ns;
  const folders = new Set();
  for (const zone of ['40-learnings', '50-sessions']) {
    try {
      for (const ent of readdirSync(join(vaultDir, zone), { withFileTypes: true })) {
        if (ent.isDirectory()) folders.add(ent.name);
      }
    } catch {
      /* zone absent */
    }
  }
  return canonicalAmong(folders, ns);
}

/**
 * The pre-#725 slug of a v1 subject: `subjectToSlug` WITHOUT the whitespace →
 * hyphen pre-map, i.e. every space dropped ("3 parallel impl" → "3parallelimpl").
 * The mirror wrote this form until #725 D1; the current form hyphenates. Used
 * only to RECOGNISE an existing note, never to name a new one.
 *
 * @param {unknown} subject
 * @returns {string} '' when the subject yields no slug
 */
export function legacyConcatSlug(subject) {
  if (typeof subject !== 'string' || subject.length === 0) return '';
  return subjectToSlug(subject);
}

/**
 * Set a note's frontmatter to archived with a reason. Idempotent: an already
 * archived note with the same reason comes back byte-identical. Only the first
 * frontmatter block is touched; the body stays verbatim.
 *
 * @param {string} content
 * @param {string} reason one of {@link ARCHIVE_REASONS}
 * @returns {string}
 */
export function markArchived(content, reason) {
  const text = String(content ?? '');
  if (!text.startsWith('---\n')) return text;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return text;
  const fmLines = text.slice(4, end).split('\n');
  const rest = text.slice(end);
  let sawStatus = false;
  const out = [];
  for (const line of fmLines) {
    if (/^archived-reason:/.test(line)) continue;
    if (/^status:/.test(line)) {
      out.push('status: archived');
      out.push(`archived-reason: ${reason}`);
      sawStatus = true;
      continue;
    }
    if (/^tags:\s*\[/.test(line)) {
      out.push(line.replace(/\bstatus\/[a-z0-9-]+/, 'status/archived'));
      continue;
    }
    out.push(line);
  }
  if (!sawStatus) {
    const genIdx = out.findIndex((l) => l.startsWith('_generator:'));
    const at = genIdx === -1 ? out.length : genIdx;
    out.splice(at, 0, 'status: archived', `archived-reason: ${reason}`);
  }
  return `---\n${out.join('\n')}${rest}`;
}

/**
 * Archive path for a vault-relative note path: the zone path is kept verbatim
 * under {@link ARCHIVE_ROOT}, so `git log --follow` and the folder shape match.
 *
 * @param {string} relPath e.g. `40-learnings/repo/x.md`
 * @returns {string}
 */
export function archivePathFor(relPath) {
  return `${ARCHIVE_ROOT}/${relPath}`;
}

// ── Session month rollup ──────────────────────────────────────────────────────

const ROW_RE = /^\| (\d{4}-\d{2}-\d{2}) \| `([^`]+)` \| ([^|]*) \| ([^|]*) \| ([^|]*) \| ([^|]*) \|$/;

/**
 * Derive one rollup row from a rendered session note (all three renderer
 * generations print the same `**Type:**` / `**Waves:**` bullets). Reading the
 * RENDERED note means the mirror and the pruner share one parser.
 *
 * @param {string} content rendered or on-disk session note
 * @param {{id?: string}} [opts] id override (defaults to frontmatter `id`)
 * @returns {{date: string, id: string, type: string, waves: string, agents: string, files: string}|null}
 *   null when the note carries no usable date or id
 */
export function rollupRowFromNote(content, opts = {}) {
  const text = String(content ?? '');
  const fm = (key) => (text.match(new RegExp(`^${key}:\\s*"?([^"\\n]+)"?\\s*$`, 'm')) || [])[1]?.trim() ?? '';
  const id = opts.id ?? fm('id');
  const date = (fm('updated') || fm('created')).slice(0, 10);
  if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const pick = (re) => ((text.match(re) || [])[1] ?? '?').trim().replace(/\|/g, '/');
  return {
    date,
    id,
    type: pick(/\*\*Type:\*\*\s*([^·\n]+)/),
    waves: pick(/\*\*Waves:\*\*\s*([^·\n]+)/),
    agents: pick(/\*\*Agents:\*\*\s*([^·\n]+)/),
    files: pick(/\*\*Files changed:\*\*\s*([^·\n]+)/),
  };
}

/** Vault-relative rollup path for a namespace (`''` = flat) and a `YYYY-MM`. */
export function rollupRelPath(ns, month) {
  return ns ? `50-sessions/${ns}/${ROLLUP_PREFIX}${month}.md` : `50-sessions/${ROLLUP_PREFIX}${month}.md`;
}

/** Parse the rows of an existing rollup note. */
export function parseRollupRows(content) {
  const rows = [];
  for (const line of String(content ?? '').split('\n')) {
    const m = ROW_RE.exec(line);
    if (m) rows.push({ date: m[1], id: m[2], type: m[3].trim(), waves: m[4].trim(), agents: m[5].trim(), files: m[6].trim() });
  }
  return rows;
}

/**
 * Merge rows into a month rollup and render it. Deterministic in its inputs
 * (rows sorted by date, then id; created/updated from the row dates), so the
 * same row set always renders the same bytes — the idempotency the mirror's
 * no-op check and the pruner's re-run rely on.
 *
 * @param {string|null} existing current rollup content, or null
 * @param {Array<object>} rows rows to add (a row with a known id replaces it)
 * @param {{ns: string, month: string}} where
 * @returns {string}
 */
export function renderRollup(existing, rows, { ns, month }) {
  const byId = new Map();
  for (const r of parseRollupRows(existing)) byId.set(r.id, r);
  for (const r of rows) byId.set(r.id, r);
  const all = [...byId.values()].sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : a.date.localeCompare(b.date)));
  const label = ns || 'unsorted';
  const idSlug = subjectToSlug(`${label}-sessions-rollup-${month}`) || `sessions-rollup-${month}`;
  const created = all.length > 0 ? all[0].date : `${month}-01`;
  const updated = all.length > 0 ? all[all.length - 1].date : `${month}-01`;
  const body = all
    .map((r) => `| ${r.date} | \`${r.id}\` | ${r.type} | ${r.waves} | ${r.agents} | ${r.files} |`)
    .join('\n');
  return `---
id: ${idSlug}
type: session
title: "Sessions ${month} (${label}, metrics only)"
status: verified
created: ${created}
updated: ${updated}
tags: [session/rollup]
${ns ? `source-repo: ${ns}\n` : ''}_generator: ${GENERATOR_MARKER}
---

# Sessions ${month} (${label}, metrics only)

Sessions without narrative (free text below the vault-mirror narrative gate). The full records live in \`.orchestrator/metrics/sessions.jsonl\` of the repo; archived notes, if any, under \`${ARCHIVE_ROOT}/50-sessions/\`.

| Date | Session | Type | Waves | Agents | Files |
|---|---|---|---|---|---|
${body}
`;
}
