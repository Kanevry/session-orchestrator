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
import { once } from 'node:events';

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

if (!vaultDir || !source || !kind) {
  process.stderr.write(
    'Usage: node vault-mirror.mjs --vault-dir <path> --source <jsonl-path> --kind <learning|session> [--dry-run]\n',
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
  if (/[:#{}\[\],&*?|<>=!%@`]/.test(value) || value.startsWith('-') || value.startsWith('"')) {
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

// ── Markdown generators ───────────────────────────────────────────────────────

function generateLearningNote(entry, slug) {
  const { id, type, subject, insight, evidence, confidence, source_session, created_at, expires_at } = entry;

  const status = confidence > 0.8 ? 'verified' : 'draft';
  const created = toDate(created_at);
  const updated = toDate(created_at);
  const expires = toDate(expires_at);

  const titleRaw = truncateAtWord(insight, 80);
  const title = yamlQuoteIfNeeded(titleRaw);

  const tags = `[learning/${type}, status/${status}, source/${source_session}]`;

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
- **Source session:** [[50-sessions/${source_session}]]

## Insight

${insight}

## Evidence

${evidence}
`;
}

function generateSessionNote(entry) {
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

  const created = toDate(started_at);
  const updated = toDate(completed_at);
  const durationMin = Math.round(duration_seconds / 60);
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

async function processLearning(entry, lineNum) {
  const { id: entryId, subject, created_at } = entry;

  // Derive slug
  let slug = subjectToSlug(subject);
  if (!isValidSlug(slug)) {
    slug = `learning-${uuidPrefix8(entryId)}`;
  }

  const targetDir = join(resolve(vaultDir), '40-learnings');
  mkdirSync(targetDir, { recursive: true });

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
        const entryUpdated = toDate(created_at);
        if (disambigFm['updated'] && disambigFm['updated'] >= entryUpdated) {
          emitAction('skipped-noop', targetPath, kind, disambigSlug);
          return;
        }
      }

      const content = generateLearningNote(entry, slug);
      if (!dryRun) writeFileSync(targetPath, content, 'utf8');
      emitAction('skipped-collision-resolved', targetPath, kind, slug);
      return;
    }

    // Same id: check if updated would advance
    const entryUpdated = toDate(created_at);
    if (fm['updated'] && fm['updated'] >= entryUpdated) {
      emitAction('skipped-noop', targetPath, kind, slug);
      return;
    }

    // Overwrite with advanced updated date
    const content = generateLearningNote(entry, slug);
    if (!dryRun) writeFileSync(targetPath, content, 'utf8');
    emitAction('updated', targetPath, kind, slug);
    return;
  }

  // File does not exist — create
  const content = generateLearningNote(entry, slug);
  if (!dryRun) writeFileSync(targetPath, content, 'utf8');
  emitAction('created', targetPath, kind, slug);
}

async function processSession(entry, lineNum) {
  const { session_id } = entry;

  const targetDir = join(resolve(vaultDir), '50-sessions');
  mkdirSync(targetDir, { recursive: true });

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
      const content = generateSessionNote(entry);
      if (!dryRun) writeFileSync(targetPath, content, 'utf8');
      emitAction('updated', targetPath, kind, session_id);
      return;
    }
  }

  // File does not exist — create
  const content = generateSessionNote(entry);
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

  let lineNum = 0;

  rl.on('line', async (line) => {
    lineNum++;
    const trimmed = line.trim();
    if (!trimmed) return;

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
      process.stderr.write(`vault-mirror: filesystem error on line ${lineNum}: ${err.message}\n`);
      process.exit(2);
    }
  });

  await once(rl, 'close');
}

main().catch((err) => {
  process.stderr.write(`vault-mirror: unexpected error: ${err.message}\n`);
  process.exit(2);
});
