/**
 * render-sessions.mjs — Session markdown generators for vault-mirror (Issue #283 split).
 *
 * Exports: detectSessionSchema, normalizeSessionEntry, generateSessionNote, generateSessionNoteV2, generateSessionNoteV3
 *
 * #732: all three generators accept `options.repoNs` (the leak-guarded /
 * pseudonym-mapped namespace segment from resolveRepoNamespace(), threaded
 * through by process.mjs::processSession) and emit it as a `source-repo:`
 * frontmatter line — mirroring render-learnings.mjs's `source-repo` field.
 * Prior to #732, session notes emitted a raw `repo:` field sourced directly
 * from deriveRepo() (bypassing the leak-guard entirely, even though the write
 * PATH already used resolveRepoNamespace()). Historical notes on disk may still
 * carry the legacy `repo:` key — the vault frontmatter Zod schema tolerates it
 * via `.passthrough()`, and it is NOT rewritten retroactively by this change.
 */

import { toDate, buildTag, slugifyIdSafe } from './utils.mjs';

const GENERATOR_MARKER = 'session-orchestrator-vault-mirror@1';

/**
 * Frontmatter line emitter — skips emission when value is null/undefined/empty
 * to avoid template-literal coercion bugs (e.g. `platform: undefined` → "undefined").
 * Returns the formatted line with trailing newline, or empty string to skip.
 */
function fmLine(key, value) {
  if (value === null || value === undefined || value === '') return '';
  return `${key}: ${value}\n`;
}

/**
 * Session JSONL has three producer schemas in production:
 *   v1 (legacy):  total_waves, total_agents, total_files_changed, agent_summary, waves[{agent_count, files_changed, quality}]
 *   v2 (S69+):    files_changed (top-level), waves[{agents, agents_done, agents_partial, agents_failed, dispatch, duration_s}]
 *   v3 (2026-05+): coordinator-direct records — `waves` is a SCALAR count and
 *                  `agents_dispatched` is a scalar; no per-wave array breakdown.
 *                  This is the shape session-end actually emits (#491), which
 *                  previously fell through to v1 validation and was rejected as
 *                  `skipped-invalid` (no vault session-note was ever written).
 * v1 and v2 both carry `waves` as an ARRAY, so a numeric `waves` is the
 * unambiguous v3 discriminator.
 */
export function detectSessionSchema(entry) {
  if (!entry) return 'v1';
  if (typeof entry.waves === 'number') return 'v3';
  return entry.total_agents === undefined && entry.files_changed !== undefined ? 'v2' : 'v1';
}

/**
 * Map known producer alias fields onto the canonical session shapes (#635).
 *
 * Several session-end variants emitted alias fields the validators reject:
 * `ended_at` (for completed_at), `mode` (for session_type), and wave counts
 * only as `total_waves`/`waves_completed` with no `waves` field at all. Such
 * records fell through to v1 validation and were skipped-invalid. This pure
 * function fills MISSING canonical fields from their aliases so the entry
 * routes to the v3 (scalar-waves) renderer. Canonical v1/v2/v3 entries pass
 * through untouched (`waves` is only filled when absent — an existing array
 * or number is never modified).
 *
 * Returns a new object; never mutates the input.
 */
export function normalizeSessionEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const e = { ...entry };

  if (e.completed_at === null || e.completed_at === undefined) {
    if (e.ended_at !== null && e.ended_at !== undefined) e.completed_at = e.ended_at;
  }
  if (e.session_type === null || e.session_type === undefined) {
    if (typeof e.mode === 'string' && e.mode.length > 0) e.session_type = e.mode;
  }
  if (e.waves === null || e.waves === undefined) {
    if (typeof e.total_waves === 'number') e.waves = e.total_waves;
    else if (typeof e.waves_completed === 'number') e.waves = e.waves_completed;
    else e.waves = 0; // coordinator-direct record with no wave breakdown
  }

  return e;
}

export function generateSessionNote(entry, options = {}) {
  const REQUIRED_SESSION_FIELDS = ['session_id', 'session_type', 'started_at', 'completed_at', 'total_waves', 'total_agents', 'total_files_changed', 'agent_summary', 'waves', 'effectiveness'];
  for (const field of REQUIRED_SESSION_FIELDS) {
    if (entry[field] === null || entry[field] === undefined) {
      throw new Error(`vault-mirror: session entry missing required field '${field}' (session_id=${entry.session_id ?? '<no session_id>'})`);
    }
  }

  const {
    session_id,
    session_type,
    platform,
    started_at,
    completed_at,
    duration_seconds,
    total_waves,
    total_agents,
    total_files_changed,
    agent_summary,
    waves,
    effectiveness,
  } = entry;

  if (typeof effectiveness !== 'object' || effectiveness === null) {
    throw new Error(`vault-mirror: session entry missing nested field 'effectiveness' (session_id=${session_id})`);
  }
  if (typeof agent_summary !== 'object' || agent_summary === null) {
    throw new Error(`vault-mirror: session entry missing nested field 'agent_summary' (session_id=${session_id})`);
  }
  if (!Array.isArray(waves)) {
    throw new Error(`vault-mirror: session entry missing nested field 'waves' (session_id=${session_id})`);
  }

  const created = toDate(started_at);
  const updated = toDate(completed_at);
  const durationMin = Math.round((duration_seconds ?? 0) / 60);
  const { planned_issues, completed, carryover, emergent, completion_rate } = effectiveness;
  const ratePercent = Math.round(completion_rate * 100) + '%';
  const { complete, partial, failed, spiral } = agent_summary;

  const titleValue = `Session ${created} — ${session_type}`;
  // Always quote session title — it contains em-dash
  const title = `"${titleValue}"`;

  // #602: session_type is interpolated raw upstream; slugify each tag segment
  // and cap the combined tag at 64 chars so the frontmatter passes the vault
  // tagPathRegex. The `id` is likewise slugified to a kebab slug below —
  // entry.session_id may carry an ISO-timestamp uppercase `T`/`:`/`.`/`Z`.
  const noteId = slugifyIdSafe(session_id) ?? session_id;
  const tags = `[${buildTag(['session', session_type])}, ${buildTag(['status', 'verified'])}]`;

  // Build wave table rows
  const waveRows = waves
    .map(
      (w) =>
        `| ${w.wave} | ${w.role} | ${w.agent_count} | ${w.files_changed} | ${w.quality} |`,
    )
    .join('\n');

  // Skip-emit guard: avoid `platform: undefined` literal coercion (issue #343).
  const platformBullet = (platform === null || platform === undefined || platform === '')
    ? ''
    : ` · **Platform:** ${platform}`;

  // #732: emit `source-repo` (the leak-guarded/pseudonym-mapped namespace from
  // resolveRepoNamespace(), threaded through by process.mjs) instead of the
  // legacy raw `repo` field — mirrors render-learnings.mjs's source-repo line.
  const { repoNs } = options;

  return `---
id: ${noteId}
type: session
title: ${title}
status: verified
created: ${created}
updated: ${updated}
tags: ${tags}
${fmLine('source-repo', repoNs)}_generator: ${GENERATOR_MARKER}
---

# Session ${session_id}

- **Type:** ${session_type}${platformBullet}
- **Duration:** ${durationMin}m (${started_at} → ${completed_at})
- **Waves:** ${total_waves} · **Agents:** ${total_agents} · **Files changed:** ${total_files_changed}
- **Effectiveness:** planned=${planned_issues}, completed=${completed}, carryover=${carryover}, emergent=${emergent}, rate=${ratePercent}

## Wave breakdown

| Wave | Role | Agents | Files | Quality |
|------|------|--------|-------|---------|
${waveRows}

## Agent summary

- Complete: ${complete} · Partial: ${partial} · Failed: ${failed} · Spiral: ${spiral}
`;
}

export function generateSessionNoteV2(entry, options = {}) {
  const REQUIRED_SESSION_V2_FIELDS = ['session_id', 'session_type', 'started_at', 'completed_at', 'waves', 'files_changed', 'effectiveness'];
  for (const field of REQUIRED_SESSION_V2_FIELDS) {
    if (entry[field] === null || entry[field] === undefined) {
      throw new Error(`vault-mirror: session entry missing required field '${field}' (session_id=${entry.session_id ?? '<no session_id>'})`);
    }
  }
  if (!Array.isArray(entry.waves)) {
    throw new Error(`vault-mirror: session entry 'waves' must be an array (session_id=${entry.session_id})`);
  }
  if (typeof entry.effectiveness !== 'object' || entry.effectiveness === null) {
    throw new Error(`vault-mirror: session entry missing nested field 'effectiveness' (session_id=${entry.session_id})`);
  }

  const { session_id, session_type, started_at, completed_at, duration_seconds, branch, planned_issues, waves, files_changed, issues_closed, issues_created, effectiveness, notes } = entry;

  const created = toDate(started_at);
  const updated = toDate(completed_at);
  const durationMin = Math.round((duration_seconds ?? 0) / 60);

  // Derive v1-equivalent aggregates from v2 wave structure
  const totalWaves = waves.length;
  const totalAgents = waves.reduce((acc, w) => acc + (w.agents ?? 0), 0);
  const complete = waves.reduce((acc, w) => acc + (w.agents_done ?? 0), 0);
  const partial = waves.reduce((acc, w) => acc + (w.agents_partial ?? 0), 0);
  const failed = waves.reduce((acc, w) => acc + (w.agents_failed ?? 0), 0);

  const completionRate = effectiveness.completion_rate;
  const ratePercent = typeof completionRate === 'number' ? Math.round(completionRate * 100) + '%' : 'n/a';
  const carryover = effectiveness.carryover ?? 0;

  const titleValue = `Session ${created} — ${session_type}`;
  const title = `"${titleValue}"`;

  // #602: session_type is interpolated raw upstream; slugify each tag segment
  // and cap the combined tag at 64 chars so the frontmatter passes the vault
  // tagPathRegex. The `id` is likewise slugified to a kebab slug below —
  // entry.session_id may carry an ISO-timestamp uppercase `T`/`:`/`.`/`Z`.
  const noteId = slugifyIdSafe(session_id) ?? session_id;
  const tags = `[${buildTag(['session', session_type])}, ${buildTag(['status', 'verified'])}]`;

  const waveRows = waves
    .map((w) => `| ${w.wave} | ${w.role} | ${w.agents ?? '?'} | ${w.dispatch ?? '?'} | ${w.duration_s ?? '?'}s | ${w.agents_done ?? 0}/${w.agents_partial ?? 0}/${w.agents_failed ?? 0} |`)
    .join('\n');

  const closedList = Array.isArray(issues_closed) && issues_closed.length ? issues_closed.join(', ') : '—';
  const createdList = Array.isArray(issues_created) && issues_created.length ? issues_created.join(', ') : '—';
  const branchLine = branch ? ` · **Branch:** ${branch}` : '';
  const notesBlock = notes ? `\n## Notes\n\n${notes}\n` : '';

  // #732: emit `source-repo` (leak-guarded/pseudonym-mapped) instead of the
  // legacy raw `repo` field — see generateSessionNote for the full rationale.
  const { repoNs } = options;

  return `---
id: ${noteId}
type: session
title: ${title}
status: verified
created: ${created}
updated: ${updated}
tags: ${tags}
${fmLine('source-repo', repoNs)}_generator: ${GENERATOR_MARKER}
---

# Session ${session_id}

- **Type:** ${session_type}${branchLine}
- **Duration:** ${durationMin}m (${started_at} → ${completed_at})
- **Waves:** ${totalWaves} · **Agents:** ${totalAgents} · **Files changed:** ${files_changed}
- **Effectiveness:** planned=${planned_issues ?? 'n/a'}, carryover=${carryover}, rate=${ratePercent}
- **Issues closed:** ${closedList}
- **Issues created:** ${createdList}

## Wave breakdown

| Wave | Role | Agents | Dispatch | Duration | done/partial/failed |
|------|------|--------|----------|----------|---------------------|
${waveRows}

## Agent summary

- Complete: ${complete} · Partial: ${partial} · Failed: ${failed}
${notesBlock}`;
}

/**
 * v3 generator — coordinator-direct session records (#491).
 *
 * These records carry `waves` as a scalar count and `agents_dispatched` as a
 * scalar (no per-wave array), plus rich top-level metadata (issues_closed,
 * follow_ups_filed, commits, tests_total_*). They are what session-end actually
 * writes to sessions.jsonl. The v1/v2 generators require `waves` to be an array
 * and reject this shape, so it gets its own renderer.
 */
export function generateSessionNoteV3(entry, options = {}) {
  const REQUIRED_SESSION_V3_FIELDS = ['session_id', 'session_type', 'started_at', 'completed_at', 'waves', 'effectiveness'];
  for (const field of REQUIRED_SESSION_V3_FIELDS) {
    if (entry[field] === null || entry[field] === undefined) {
      throw new Error(`vault-mirror: session entry missing required field '${field}' (session_id=${entry.session_id ?? '<no session_id>'})`);
    }
  }
  if (typeof entry.waves !== 'number') {
    throw new Error(`vault-mirror: session entry 'waves' must be a number (session_id=${entry.session_id})`);
  }
  if (typeof entry.effectiveness !== 'object' || entry.effectiveness === null) {
    throw new Error(`vault-mirror: session entry missing nested field 'effectiveness' (session_id=${entry.session_id})`);
  }

  const {
    session_id, session_type, platform, branch, started_at, completed_at,
    duration_minutes, duration_seconds, waves, agents_dispatched, agent_summary,
    planned_issues, effectiveness, commits, issues_closed, issues_created,
    follow_ups_filed, tests_total_pre, tests_total_post, tests_added, notes,
  } = entry;

  const created = toDate(started_at);
  const updated = toDate(completed_at);
  const durationMin = duration_minutes ?? Math.round((duration_seconds ?? 0) / 60);

  const completionRate = effectiveness.completion_rate;
  const ratePercent = typeof completionRate === 'number' ? Math.round(completionRate * 100) + '%' : 'n/a';
  const completed = effectiveness.completed_issues ?? effectiveness.completed ?? 'n/a';
  const carryover = effectiveness.carryover ?? 'n/a';
  const emergent = effectiveness.unplanned_finds ?? effectiveness.emergent ?? 0;

  const agentsValue = typeof agents_dispatched === 'number' ? agents_dispatched : 'n/a';
  const as = agent_summary && typeof agent_summary === 'object' ? agent_summary : {};
  const { complete = 0, partial = 0, failed = 0, spiral = 0 } = as;

  const fmtIssues = (list) =>
    Array.isArray(list) && list.length ? list.map((i) => `#${i}`).join(', ') : '—';
  const closedList = fmtIssues(issues_closed);
  const createdList = fmtIssues(issues_created);
  const followList = fmtIssues(follow_ups_filed);
  const commitCount = Array.isArray(commits) ? commits.length : 0;
  const testsDelta =
    typeof tests_total_pre === 'number' && typeof tests_total_post === 'number'
      ? `${tests_total_pre} → ${tests_total_post}`
      : typeof tests_added === 'number'
        ? `+${tests_added}`
        : '—';

  const titleValue = `Session ${created} — ${session_type}`;
  const title = `"${titleValue}"`;
  // #602: session_type is interpolated raw upstream; slugify each tag segment
  // and cap the combined tag at 64 chars so the frontmatter passes the vault
  // tagPathRegex. The `id` is likewise slugified to a kebab slug below —
  // entry.session_id may carry an ISO-timestamp uppercase `T`/`:`/`.`/`Z`.
  const noteId = slugifyIdSafe(session_id) ?? session_id;
  const tags = `[${buildTag(['session', session_type])}, ${buildTag(['status', 'verified'])}]`;

  const platformBullet = platform === null || platform === undefined || platform === '' ? '' : ` · **Platform:** ${platform}`;
  const branchLine = branch ? ` · **Branch:** ${branch}` : '';
  const notesBlock = notes ? `\n## Notes\n\n${notes}\n` : '';

  // #732: emit `source-repo` (leak-guarded/pseudonym-mapped) instead of the
  // legacy raw `repo` field — see generateSessionNote for the full rationale.
  const { repoNs } = options;

  return `---
id: ${noteId}
type: session
title: ${title}
status: verified
created: ${created}
updated: ${updated}
tags: ${tags}
${fmLine('source-repo', repoNs)}_generator: ${GENERATOR_MARKER}
---

# Session ${session_id}

- **Type:** ${session_type}${branchLine}${platformBullet}
- **Duration:** ${durationMin}m (${started_at} → ${completed_at})
- **Waves:** ${waves} · **Agents:** ${agentsValue} · **Commits:** ${commitCount}
- **Effectiveness:** planned=${planned_issues ?? 'n/a'}, completed=${completed}, carryover=${carryover}, emergent=${emergent}, rate=${ratePercent}
- **Tests:** ${testsDelta}
- **Issues closed:** ${closedList}
- **Issues created:** ${createdList}
- **Follow-ups filed:** ${followList}

## Agent summary

- Complete: ${complete} · Partial: ${partial} · Failed: ${failed} · Spiral: ${spiral}
${notesBlock}`;
}
