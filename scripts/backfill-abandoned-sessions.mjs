#!/usr/bin/env node
/**
 * backfill-abandoned-sessions.mjs — one-time historical migration CLI (#724 C1).
 *
 * Scans `.orchestrator/metrics/events.jsonl` for every distinct
 * `orchestrator.session.started` UUID that has no counterpart in
 * `.orchestrator/metrics/sessions.jsonl`, bridges each to its semantic id via
 * `orchestrator.session.lock.acquired` where available, and synthesizes a
 * `status: 'abandoned'` stub through the shared backfill core
 * (`scripts/lib/session-close-backfill.mjs`).
 *
 * SAFETY: `--dry-run` is the DEFAULT — nothing is written unless `--apply` is
 * passed. Dry-run is idempotent (creates no marker files, appends nothing) so
 * you can safely preview counts, then apply once against a copy or the live
 * store at the operator's discretion.
 *
 *   node scripts/backfill-abandoned-sessions.mjs [--dry-run|--apply] [--json]
 *                                                [--repo-root PATH]
 *                                                [--assume-dead-before ISO]
 *
 * DEAD-BY-AGE RELAXATION (#731): every CLI run happens FROM an active
 * session, so `.orchestrator/session.lock` is ALWAYS live at run-time — the
 * foreign-live-lock guard in the shared core (session-close-backfill.mjs)
 * would otherwise block every historical candidate unconditionally. This CLI
 * therefore ALWAYS passes `relaxDeadByAge: true`, so a candidate whose last
 * known event is older than the lock's own default TTL
 * (`session-lock.mjs` `DEFAULT_TTL_HOURS`) bypasses the current lock. The
 * optional `--assume-dead-before <ISO>` flag additionally bypasses the guard
 * for any candidate whose last known event predates the given cutoff,
 * regardless of the TTL window. This relaxation is scoped to THIS CLI only —
 * `hooks/on-session-end.mjs` never passes it (see the comment there).
 *
 * Exit codes (cli-design.md):
 *   0 — completed (dry-run or apply)
 *   1 — user/input error (bad args, invalid --assume-dead-before)
 *   2 — system error (unreadable events file, etc.)
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import { backfillAbandonedSession } from './lib/session-close-backfill.mjs';
import { SO_PROJECT_DIR } from './lib/platform.mjs';

const LOCK_ACQUIRED = 'orchestrator.session.lock.acquired';
const SESSION_STARTED = 'orchestrator.session.started';

/** Read a JSONL file into parsed objects; missing → []; malformed lines skipped. */
function readJsonl(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

/**
 * Enumerate distinct sessions worth evaluating: every unique
 * session.started UUID, each bridged to its semantic id via lock.acquired
 * where one exists. Preserves first-seen order.
 *
 * @param {{ repoRoot: string }} args
 * @returns {Array<{ sessionId: string, semanticSessionId: string|null }>}
 */
export function planSessions({ repoRoot }) {
  const events = readJsonl(path.join(repoRoot, '.orchestrator', 'metrics', 'events.jsonl'));

  const semanticByUuid = new Map();
  for (const ev of events) {
    if (
      ev.event === LOCK_ACQUIRED &&
      typeof ev.session_id === 'string' &&
      typeof ev.semantic_session_id === 'string'
    ) {
      semanticByUuid.set(ev.session_id, ev.semantic_session_id);
    }
  }

  const seen = new Set();
  const plan = [];
  for (const ev of events) {
    if (ev.event !== SESSION_STARTED || typeof ev.session_id !== 'string') continue;
    if (seen.has(ev.session_id)) continue;
    seen.add(ev.session_id);
    plan.push({ sessionId: ev.session_id, semanticSessionId: semanticByUuid.get(ev.session_id) ?? null });
  }
  return plan;
}

/**
 * Run the migration over every planned session.
 *
 * `relaxDeadByAge: true` is ALWAYS passed to the shared core (#731) — see the
 * module docblock for why. `assumeDeadBeforeMs` is forwarded as-is (null when
 * `--assume-dead-before` was not given).
 *
 * @param {{ repoRoot: string, apply: boolean, assumeDeadBeforeMs?: number|null }} args
 * @returns {Promise<object>} aggregate summary
 */
export async function runMigration({ repoRoot, apply, assumeDeadBeforeMs = null }) {
  const plan = planSessions({ repoRoot });
  const summary = {
    repoRoot,
    mode: apply ? 'apply' : 'dry-run',
    total: plan.length,
    backfilled: 0,
    would_backfill: 0,
    dead_by_age: 0,
    errors: 0,
    skipped: {},
  };

  // Dry-run has no incremental sessions.jsonl write, so two started-UUIDs that
  // bridge to the SAME semantic id (a session that cleared/compacted mid-run)
  // would both report 'would-backfill' and over-count. Track projected ids
  // here so the dry-run total matches what --apply actually writes.
  const projected = new Set();

  for (const item of plan) {
    const res = await backfillAbandonedSession({
      repoRoot,
      sessionId: item.sessionId,
      semanticSessionId: item.semanticSessionId,
      dryRun: !apply,
      relaxDeadByAge: true,
      assumeDeadBeforeMs,
    });
    switch (res.action) {
      case 'backfilled':
        summary.backfilled += 1;
        if (res.deadByAge) summary.dead_by_age += 1;
        break;
      case 'would-backfill':
        if (projected.has(res.sessionId)) {
          summary.skipped['skipped-already-recorded'] =
            (summary.skipped['skipped-already-recorded'] ?? 0) + 1;
        } else {
          projected.add(res.sessionId);
          summary.would_backfill += 1;
          if (res.deadByAge) summary.dead_by_age += 1;
        }
        break;
      case 'error':
        summary.errors += 1;
        break;
      default:
        summary.skipped[res.action] = (summary.skipped[res.action] ?? 0) + 1;
    }
  }
  return summary;
}

function renderHuman(summary) {
  const lines = [];
  lines.push(`Backfill abandoned sessions — ${summary.mode}`);
  lines.push(`  repo:            ${summary.repoRoot}`);
  lines.push(`  sessions seen:   ${summary.total}`);
  if (summary.mode === 'apply') {
    lines.push(`  backfilled:      ${summary.backfilled}`);
  } else {
    lines.push(`  would backfill:  ${summary.would_backfill}`);
  }
  if (summary.dead_by_age > 0) {
    lines.push(`  dead-by-age:     ${summary.dead_by_age} (relaxed past a live foreign session.lock)`);
  }
  lines.push(`  errors:          ${summary.errors}`);
  const skips = Object.entries(summary.skipped);
  if (skips.length > 0) {
    lines.push('  skipped:');
    for (const [reason, n] of skips) lines.push(`    ${reason}: ${n}`);
  }
  return lines.join('\n') + '\n';
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      options: {
        apply: { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        'repo-root': { type: 'string' },
        'assume-dead-before': { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
    });
  } catch (err) {
    process.stderr.write(`backfill-abandoned-sessions: ${err.message}\n`);
    process.exit(1);
  }

  const { values } = parsed;

  if (values.help) {
    process.stdout.write(
      'Usage: node scripts/backfill-abandoned-sessions.mjs [--dry-run|--apply] [--json]\n' +
        '                                                     [--repo-root PATH]\n' +
        '                                                     [--assume-dead-before ISO]\n' +
        '  --dry-run             preview only (DEFAULT — nothing is written)\n' +
        '  --apply               synthesize + append abandoned-session stubs\n' +
        '  --json                emit the summary as JSON to stdout\n' +
        '  --repo-root           override the project root (default: resolved SO_PROJECT_DIR)\n' +
        '  --assume-dead-before  ISO-8601 cutoff; a candidate whose last known event\n' +
        '                        predates it bypasses a live foreign session.lock\n' +
        'Exit codes: 0 ok, 1 arg error, 2 system error\n'
    );
    process.exit(0);
  }

  // --apply is an explicit opt-in; absent it (or with --dry-run) we never write.
  const apply = values.apply === true && values['dry-run'] !== true;
  const repoRoot = values['repo-root'] || SO_PROJECT_DIR;

  let assumeDeadBeforeMs = null;
  if (typeof values['assume-dead-before'] === 'string' && values['assume-dead-before'].length > 0) {
    const ms = Date.parse(values['assume-dead-before']);
    if (Number.isNaN(ms)) {
      process.stderr.write(
        `backfill-abandoned-sessions: --assume-dead-before is not a valid ISO-8601 timestamp: "${values['assume-dead-before']}"\n`
      );
      process.exit(1);
    }
    assumeDeadBeforeMs = ms;
  }

  let summary;
  try {
    summary = await runMigration({ repoRoot, apply, assumeDeadBeforeMs });
  } catch (err) {
    process.stderr.write(`backfill-abandoned-sessions: ${err?.message ?? String(err)}\n`);
    process.exit(2);
  }

  if (values.json) {
    process.stdout.write(JSON.stringify(summary) + '\n');
  } else {
    process.stdout.write(renderHuman(summary));
  }
  process.exit(0);
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`backfill-abandoned-sessions: unexpected error: ${err?.stack ?? err}\n`);
    process.exit(2);
  });
}
