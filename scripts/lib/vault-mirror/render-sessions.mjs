/**
 * render-sessions.mjs — Session markdown generators for vault-mirror (Issue #283 split).
 *
 * Exports: detectSessionSchema, generateSessionNote, generateSessionNoteV2
 */

import { toDate } from './utils.mjs';

const GENERATOR_MARKER = 'session-orchestrator-vault-mirror@1';

/**
 * Session JSONL has two producer schemas in production:
 *   v1 (legacy): total_waves, total_agents, total_files_changed, agent_summary, waves[{agent_count, files_changed, quality}]
 *   v2 (S69+):   files_changed (top-level), waves[{agents, agents_done, agents_partial, agents_failed, dispatch, duration_s}]
 * Detect by absence of v1's total_agents.
 */
export function detectSessionSchema(entry) {
  return entry && entry.total_agents === undefined && entry.files_changed !== undefined ? 'v2' : 'v1';
}

export function generateSessionNote(entry) {
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

  const tags = `[session/${session_type}, status/verified]`;

  // Build wave table rows
  const waveRows = waves
    .map(
      (w) =>
        `| ${w.wave} | ${w.role} | ${w.agent_count} | ${w.files_changed} | ${w.quality} |`,
    )
    .join('\n');

  return `---
id: ${session_id}
type: session
title: ${title}
status: verified
created: ${created}
updated: ${updated}
tags: ${tags}
_generator: ${GENERATOR_MARKER}
---

# Session ${session_id}

- **Type:** ${session_type} · **Platform:** ${platform}
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

export function generateSessionNoteV2(entry) {
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

  const tags = `[session/${session_type}, status/verified]`;

  const waveRows = waves
    .map((w) => `| ${w.wave} | ${w.role} | ${w.agents ?? '?'} | ${w.dispatch ?? '?'} | ${w.duration_s ?? '?'}s | ${w.agents_done ?? 0}/${w.agents_partial ?? 0}/${w.agents_failed ?? 0} |`)
    .join('\n');

  const closedList = Array.isArray(issues_closed) && issues_closed.length ? issues_closed.join(', ') : '—';
  const createdList = Array.isArray(issues_created) && issues_created.length ? issues_created.join(', ') : '—';
  const branchLine = branch ? ` · **Branch:** ${branch}` : '';
  const notesBlock = notes ? `\n## Notes\n\n${notes}\n` : '';

  return `---
id: ${session_id}
type: session
title: ${title}
status: verified
created: ${created}
updated: ${updated}
tags: ${tags}
_generator: ${GENERATOR_MARKER}
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
