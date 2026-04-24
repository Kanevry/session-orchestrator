#!/usr/bin/env node
/**
 * vault-mirror.mjs — JSONL-to-Markdown mirror for the Meta-Vault (Issue #14).
 *
 * Reads a JSONL file (one JSON object per line), produces Markdown notes with
 * valid vaultFrontmatterSchema frontmatter, and writes them into the vault.
 *
 * CLI usage:
 *   node vault-mirror.mjs --vault-dir <path> --source <jsonl-path> --kind <learning|session> [--dry-run]
 *
 * Exit codes:
 *   0 — success (including idempotent no-op)
 *   1 — validation error (malformed JSON line, bad slug, etc.)
 *   2 — filesystem error
 *
 * Output: one JSON line per action on stdout:
 *   {"action":"created|updated|skipped-noop|skipped-handwritten|skipped-collision-resolved","path":"...","kind":"...","id":"..."}
 *
 * Idempotency rules:
 *   1. File does not exist → create.
 *   2. File exists, has _generator marker, id matches → overwrite only if updated would advance; else skipped-noop.
 *   3. File exists, lacks _generator → skip (hand-written). Log to stderr.
 *   4. File exists, has _generator, id differs → collision-disambiguate by appending -<first8 of uuid>.
 *
 * Part of session-orchestrator vault-mirror (Issue #14).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';

const GENERATOR_MARKER = 'session-orchestrator-vault-mirror@1';

// ── CLI argument parsing ──────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(name) {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : undefined;
}

const vaultDir = getArg('--vault-dir');
const source = getArg('--source');
const kind = getArg('--kind');
const dryRun = args.includes('--dry-run');
const strictSchema = args.includes('--strict-schema');

if (!vaultDir || !source || !kind) {
  process.stderr.write(
    'Usage: node vault-mirror.mjs --vault-dir <path> --source <jsonl-path> --kind <learning|session> [--dry-run] [--strict-schema]\n',
  );
  process.exit(1);
}

if (kind !== 'learning' && kind !== 'session') {
  process.stderr.write(`vault-mirror: invalid --kind "${kind}" (expected learning or session)\n`);
  process.exit(1);
}

// ── Utility functions ─────────────────────────────────────────────────────────

/**
 * Convert a subject string to a kebab slug.
 * - If subject contains slashes, collapse to last path segment.
 * - Replace dots and underscores with hyphens.
 * - Strip all non-[a-z0-9-] chars.
 * - Collapse consecutive hyphens.
 * - Trim leading/trailing hyphens.
 */
function subjectToSlug(subject) {
  let s = subject;

  // Collapse slash paths to last segment
  if (s.includes('/')) {
    const parts = s.split('/').filter(Boolean);
    s = parts[parts.length - 1];
  }

  // Normalise: lowercase, dots/underscores → hyphens, strip invalid chars
  s = s
    .toLowerCase()
    .replace(/[._]/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  return s;
}

const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isValidSlug(s) {
  return slugRegex.test(s);
}

/** Derive the first 8 chars of a UUID (strip hyphens, take first 8 hex chars). */
function uuidPrefix8(id) {
  return id.replace(/-/g, '').slice(0, 8);
}

/** Format a UTC ISO date string as YYYY-MM-DD. */
function toDate(isoString) {
  if (!isoString) return '';
  return isoString.slice(0, 10);
}

/** Truncate a string to maxLen chars, ending at a word boundary. */
function truncateAtWord(str, maxLen) {
  if (str.length <= maxLen) return str;
  const truncated = str.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(' ');
  return lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated;
}

/** Determine if a YAML title value needs quoting (contains : # or starts with -). */
function yamlQuoteIfNeeded(value) {
  if (/[:#{}[\],&*?|<>=!%@`]/.test(value) || value.startsWith('-') || value.startsWith('"')) {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return value;
}

// ── Frontmatter parser (minimal — only reads the opening --- block) ───────────

function parseFrontmatter(content) {
  if (!content.startsWith('---')) return null;
  const end = content.indexOf('\n---', 3);
  if (end === -1) return null;
  const block = content.slice(3, end).trim();
  const result = {};
  for (const line of block.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

// ── Schema detection ──────────────────────────────────────────────────────────

/**
 * Learning JSONL has two producer schemas in production:
 *   v1 (legacy): id, type, subject, insight, evidence, confidence, source_session, created_at, expires_at?
 *   v2 (S69+):   id, type, text, scope, confidence, first_seen, decay?
 * Detect by presence of the v2-only field 'text'.
 */
function detectLearningSchema(entry) {
  return entry && typeof entry.text === 'string' ? 'v2' : 'v1';
}

/**
 * Session JSONL has two producer schemas in production:
 *   v1 (legacy): total_waves, total_agents, total_files_changed, agent_summary, waves[{agent_count, files_changed, quality}]
 *   v2 (S69+):   files_changed (top-level), waves[{agents, agents_done, agents_partial, agents_failed, dispatch, duration_s}]
 * Detect by absence of v1's total_agents.
 */
function detectSessionSchema(entry) {
  return entry && entry.total_agents === undefined && entry.files_changed !== undefined ? 'v2' : 'v1';
}

// ── Markdown generators ───────────────────────────────────────────────────────

function generateLearningNote(entry, slug) {
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

  const sourceTag = source_session.replace(/\./g, '-');
  const tags = `[learning/${type}, status/${status}, source/${sourceTag}]`;

  // Check if expires has a value; it's optional in schema
  const expiresLine = expires ? `expires: ${expires}\n` : '';

  return `---
id: ${slug}
type: learning
title: ${title}
status: ${status}
created: ${created}
updated: ${updated}
tags: ${tags}
${expiresLine}_generator: ${GENERATOR_MARKER}
---

# ${titleRaw}

- **Type:** ${type}
- **Confidence:** ${confidence}
- **Source session:** ${source_session}

## Insight

${insight}

## Evidence

${evidence}
`;
}

function generateLearningNoteV2(entry, slug) {
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

function generateSessionNote(entry) {
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

function generateSessionNoteV2(entry) {
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

// ── Action output ─────────────────────────────────────────────────────────────

function emitAction(action, filePath, fileKind, id) {
  const rel = filePath.startsWith(resolve(vaultDir))
    ? filePath.slice(resolve(vaultDir).length + 1)
    : filePath;
  process.stdout.write(
    JSON.stringify({ action, path: rel, kind: fileKind, id }) + '\n',
  );
}

// ── Core processing ───────────────────────────────────────────────────────────

async function processLearning(entry, _lineNum) {
  const schema = detectLearningSchema(entry);
  const entryId = entry.id;

  // Slug source differs by schema. Both fall back to learning-<uuid8> on invalid.
  // For v2 the id is already a kebab slug (e.g. "s69-compose-pids-cross-validation").
  // Crucially: validate id presence before slug derivation, so missing-id entries
  // become skipped-invalid rather than crashing inside subjectToSlug.
  if (entryId === null || entryId === undefined) {
    throw new Error(`vault-mirror: learning entry missing required field 'id' (id=<no id>)`);
  }
  const slugSource = schema === 'v2' ? entry.id : entry.subject;
  let slug;
  if (typeof slugSource === 'string' && slugSource.length > 0) {
    slug = subjectToSlug(slugSource);
  } else {
    slug = '';
  }
  if (!isValidSlug(slug)) {
    slug = `learning-${uuidPrefix8(entryId)}`;
  }

  // Generator + date source differ by schema
  const generator = schema === 'v2' ? generateLearningNoteV2 : generateLearningNote;
  const dateSource = schema === 'v2' ? entry.first_seen : entry.created_at;

  const targetDir = join(resolve(vaultDir), '40-learnings');
  if (!dryRun) mkdirSync(targetDir, { recursive: true });

  let targetPath = join(targetDir, `${slug}.md`);

  if (existsSync(targetPath)) {
    const existingContent = readFileSync(targetPath, 'utf8');
    const fm = parseFrontmatter(existingContent);

    if (!fm || !fm['_generator']) {
      // Hand-written: skip
      process.stderr.write(`SKIP hand-written: ${targetPath}\n`);
      emitAction('skipped-handwritten', targetPath, kind, entryId);
      return;
    }

    if (fm['_generator'] !== GENERATOR_MARKER) {
      // Different generator — treat as hand-written to be safe
      process.stderr.write(`SKIP unknown generator: ${targetPath}\n`);
      emitAction('skipped-handwritten', targetPath, kind, entryId);
      return;
    }

    if (fm['id'] !== slug) {
      // Different id → collision: disambiguate
      const disambigSlug = `${slug}-${uuidPrefix8(entryId)}`;
      targetPath = join(targetDir, `${disambigSlug}.md`);
      slug = disambigSlug;

      if (existsSync(targetPath)) {
        // Still exists with disambig — check if it's ours
        const disambigContent = readFileSync(targetPath, 'utf8');
        const disambigFm = parseFrontmatter(disambigContent);
        if (!disambigFm || !disambigFm['_generator']) {
          process.stderr.write(`SKIP hand-written (disambig): ${targetPath}\n`);
          emitAction('skipped-handwritten', targetPath, kind, entryId);
          return;
        }
        // Check updated advancement
        const entryUpdated = toDate(dateSource);
        if (disambigFm['updated'] && disambigFm['updated'] >= entryUpdated) {
          emitAction('skipped-noop', targetPath, kind, disambigSlug);
          return;
        }
      }

      const content = generator(entry, slug);
      if (!dryRun) writeFileSync(targetPath, content, 'utf8');
      emitAction('skipped-collision-resolved', targetPath, kind, slug);
      return;
    }

    // Same id: check if updated would advance
    const entryUpdated = toDate(dateSource);
    if (fm['updated'] && fm['updated'] >= entryUpdated) {
      emitAction('skipped-noop', targetPath, kind, slug);
      return;
    }

    // Overwrite with advanced updated date
    const content = generator(entry, slug);
    if (!dryRun) writeFileSync(targetPath, content, 'utf8');
    emitAction('updated', targetPath, kind, slug);
    return;
  }

  // File does not exist — create
  const content = generator(entry, slug);
  if (!dryRun) writeFileSync(targetPath, content, 'utf8');
  emitAction('created', targetPath, kind, slug);
}

async function processSession(entry, _lineNum) {
  const { session_id: rawSessionId } = entry;
  const schema = detectSessionSchema(entry);
  const generator = schema === 'v2' ? generateSessionNoteV2 : generateSessionNote;

  // Validate session_id as a filesystem-safe slug; fall back via subjectToSlug
  // (which collapses slashes to last segment + strips invalid chars) before
  // resorting to a uuid-derived slug. Without subjectToSlug, raw slashes in
  // rawSessionId (e.g. "feat/opus-4-7-...") would survive uuidPrefix8 and
  // produce a path with directory separators in the basename.
  let session_id;
  if (isValidSlug(rawSessionId)) {
    session_id = rawSessionId;
  } else if (typeof rawSessionId === 'string' && rawSessionId.length > 0) {
    const sanitised = subjectToSlug(rawSessionId);
    session_id = isValidSlug(sanitised) ? sanitised : `session-${uuidPrefix8(rawSessionId)}`;
  } else {
    session_id = `session-${uuidPrefix8(randomUUID())}`;
  }

  const targetDir = join(resolve(vaultDir), '50-sessions');
  if (!dryRun) mkdirSync(targetDir, { recursive: true });

  const targetPath = join(targetDir, `${session_id}.md`);

  if (existsSync(targetPath)) {
    const existingContent = readFileSync(targetPath, 'utf8');
    const fm = parseFrontmatter(existingContent);

    if (!fm || !fm['_generator']) {
      // Hand-written: skip
      process.stderr.write(`SKIP hand-written: ${targetPath}\n`);
      emitAction('skipped-handwritten', targetPath, kind, session_id);
      return;
    }

    if (fm['_generator'] !== GENERATOR_MARKER) {
      process.stderr.write(`SKIP unknown generator: ${targetPath}\n`);
      emitAction('skipped-handwritten', targetPath, kind, session_id);
      return;
    }

    // Same generator: check id and updated
    if (fm['id'] === session_id) {
      const entryUpdated = toDate(entry.completed_at);
      if (fm['updated'] && fm['updated'] >= entryUpdated) {
        emitAction('skipped-noop', targetPath, kind, session_id);
        return;
      }
      const content = generator(entry);
      if (!dryRun) writeFileSync(targetPath, content, 'utf8');
      emitAction('updated', targetPath, kind, session_id);
      return;
    }
  }

  // File does not exist — create
  const content = generator(entry);
  if (!dryRun) writeFileSync(targetPath, content, 'utf8');
  emitAction('created', targetPath, kind, session_id);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(resolve(vaultDir))) {
    process.stderr.write(`vault-mirror: vault-dir not found: ${vaultDir}\n`);
    process.exit(2);
  }

  if (!existsSync(resolve(source))) {
    process.stderr.write(`vault-mirror: source file not found: ${source}\n`);
    process.exit(2);
  }

  const rl = createInterface({
    input: createReadStream(resolve(source), 'utf8'),
    crlfDelay: Infinity,
  });

  // Collect all lines first, then process sequentially to avoid mkdirSync/writeFileSync races
  const lines = [];
  for await (const line of rl) {
    lines.push(line);
  }

  let lineNum = 0;
  let skippedInvalidCount = 0;

  for (const line of lines) {
    lineNum++;
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch (err) {
      process.stderr.write(`vault-mirror: malformed JSON on line ${lineNum}: ${err.message}\n`);
      process.exit(1);
    }

    try {
      if (kind === 'learning') {
        await processLearning(entry, lineNum);
      } else {
        await processSession(entry, lineNum);
      }
    } catch (err) {
      // Validation errors (missing required fields) → per-entry skip, not a global failure
      if (err.message.startsWith('vault-mirror:')) {
        process.stderr.write(`${err.message}\n`);
        const entryId = entry.id ?? entry.session_id ?? null;
        process.stdout.write(
          JSON.stringify({ action: 'skipped-invalid', path: null, kind, id: entryId }) + '\n',
        );
        skippedInvalidCount++;
        continue;
      }
      // Unexpected filesystem errors → fatal
      process.stderr.write(`vault-mirror: filesystem error on line ${lineNum}: ${err.message}\n`);
      process.exit(2);
    }
  }

  // --strict-schema: abort with exit 1 when any entry was skipped-invalid.
  // Useful in CI to catch producer-side schema drift early (issue #249).
  if (strictSchema && skippedInvalidCount > 0) {
    process.stdout.write(
      JSON.stringify({ action: 'strict-schema-abort', skipped: skippedInvalidCount, kind }) + '\n',
    );
    process.stderr.write(
      `vault-mirror: --strict-schema: ${skippedInvalidCount} entries failed validation — exiting 1\n`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`vault-mirror: unexpected error: ${err.message}\n`);
  process.exit(2);
});
