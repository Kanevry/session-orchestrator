#!/usr/bin/env node
/**
 * apply-session-learnings.mjs — the ONLY sanctioned session-end write path for
 * `learnings.jsonl` (GitLab #1446 / GitHub #69). session-end Phase 3.6 and the
 * `/plan retro` §3.3 learnings update hand their collected changes to this CLI;
 * neither may rewrite the store with a shell `>` or append to it with `>>`
 * (`scripts/lib/validate/check-learnings-shell-writes.mjs` gates the prose).
 *
 * Why a CLI and not prose: until #1446, Phase 3.6 step 4g told the coordinator
 * to "write the entire result back (atomic rewrite with `>`)" from a template
 * that carried no `scope` and no `file_paths`. A shell rewrite bypasses
 * `validateLearning`, the `.bak-<ISO>` snapshot and the archive sidecar — and
 * the producer that wrote a file PATH into the `scope` column (GH#69) was
 * never rejected by anything.
 *
 * Input (stdin, or `--input PATH`), one JSON object:
 *   {
 *     "confidence_updates": [{ "id": "<existing id>", "operation": "confirm"|"contradict" }],
 *     "new_learnings":      [ <complete learning objects> ]
 *   }
 * Both keys are optional (absent = empty list).
 *
 * Steps — every one delegates to an existing helper:
 *   1. read the store             `readLearnings()`            (io.mjs)
 *   2. confirm  → +0.15, cap 1.0, `expires_at` reset via `deriveExpiresAt(now, type)`
 *      contradict → −0.2, floor 0, `expires_at` untouched
 *   3. new learnings → stamped like `appendLearning()` (`created_at`,
 *      `expires_at`, `schema_version: 1` when absent), then STRICT
 *      `validateLearning()` — one invalid record exits 1 with nothing written
 *   4. passive decay (#89) → `learning-decay-rate` subtracted from every
 *      existing learning NOT confirmed/contradicted this run, clamped ≥ 0,
 *      `expires_at` untouched
 *   5. prune (expired, confidence ≤ 0) + consolidate (type+subject, highest
 *      confidence wins) + archive the losers + atomic rewrite with `.bak-<ISO>`
 *      → `pruneLearnings()` (expiry-sweep.mjs)
 *
 * Usage:
 *   node scripts/apply-session-learnings.mjs [--input PATH] [--file PATH]
 *     [--repo-root PATH] [--dry-run|--apply] [--json] [--decay-rate N]
 *
 * Flags:
 *   --input PATH      JSON input file (default: read stdin)
 *   --repo-root PATH  Repo root (default: cwd). Resolves a relative `--file`,
 *                      supplies the Session Config for the decay rate, and pins
 *                      the telemetry record.
 *   --file PATH       Learnings store (default: .orchestrator/metrics/learnings.jsonl).
 *                      The archive is its sibling `learnings-archive.jsonl`.
 *   --dry-run         Preview the summary; write nothing, no `.bak` (DEFAULT)
 *   --apply           Perform the archive append + store rewrite
 *   --json            Emit one machine-parseable JSON summary line
 *   --decay-rate N    Passive decay per run, 0..1 (default: Session Config
 *                      `learning-decay-rate`, else 0.05). 0 disables decay.
 *
 * Telemetry: `--apply` emits `orchestrator.learnings.session_write_applied`
 * after the write — its presence is the proof the write ran. Best-effort: a
 * telemetry failure never changes the exit code. Skipped (stderr WARN) when
 * `--file` lies outside `--repo-root`, so the record is never pinned to a repo
 * whose store was not written.
 *
 * Exit codes:
 *   0  Success (including a no-op)
 *   1  Usage/input/validation error — nothing written
 *   2  Library/IO error (unreadable store, malformed store lines on --apply,
 *      a failure inside the prune/rewrite)
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readLearnings } from './lib/learnings/io.mjs';
import { pruneLearnings } from './lib/learnings/expiry-sweep.mjs';
import {
  CURRENT_SCHEMA_VERSION,
  deriveExpiresAt,
  validateLearning,
} from './lib/learnings/schema.mjs';
import { parseSessionConfig, readConfigFile } from './lib/config.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const DEFAULT_FILE = '.orchestrator/metrics/learnings.jsonl';
const ARCHIVE_BASENAME = 'learnings-archive.jsonl';
const DEFAULT_DECAY_RATE = 0.05;
const CONFIRM_DELTA = 0.15;
const CONTRADICT_DELTA = 0.2;
const OPERATIONS = new Set(['confirm', 'contradict']);

/** Event name — registered in docs/events-schema.md. */
export const SESSION_WRITE_EVENT = 'orchestrator.learnings.session_write_applied';

class UsageError extends Error {}

/**
 * Round to 6 decimals. Without it, ten 0.05 decay steps from 0.5 leave a
 * float residue > 0 that the `confidence <= 0` prune never catches.
 *
 * @param {number} n
 * @returns {number}
 */
function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

function printHelp() {
  process.stdout.write(
    'Usage: node scripts/apply-session-learnings.mjs [--input PATH] [--file PATH] ' +
      '[--repo-root PATH] [--dry-run|--apply] [--json] [--decay-rate N]\n',
  );
}

function parseArgs(argv) {
  const opts = { input: null, file: null, repoRoot: null, apply: false, json: false, decayRate: null };
  const valueOf = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${flag} requires a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case '--help':
      case '-h':
        opts.help = true;
        break;
      case '--apply':
        opts.apply = true;
        break;
      case '--dry-run':
        opts.apply = false;
        break;
      case '--json':
        opts.json = true;
        break;
      case '--input':
        opts.input = valueOf(i, a);
        i += 1;
        break;
      case '--file':
        opts.file = valueOf(i, a);
        i += 1;
        break;
      case '--repo-root':
        opts.repoRoot = valueOf(i, a);
        i += 1;
        break;
      case '--decay-rate': {
        const raw = valueOf(i, a);
        const n = Number(raw);
        if (raw.trim() === '' || !Number.isFinite(n) || n < 0 || n > 1) {
          throw new UsageError(`--decay-rate must be a number in [0, 1], got: ${raw}`);
        }
        opts.decayRate = n;
        i += 1;
        break;
      }
      default:
        throw new UsageError(`unknown argument: ${a}`);
    }
  }
  return opts;
}

/**
 * Parse and shape-check the input document. Throws UsageError.
 *
 * @param {string} raw
 * @returns {{ updates: {id: string, operation: string}[], newLearnings: object[] }}
 */
function parseInput(raw) {
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new UsageError(`input is not valid JSON: ${err.message}`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new UsageError('input must be a JSON object {confidence_updates, new_learnings}');
  }
  const updates = doc.confidence_updates ?? [];
  const newLearnings = doc.new_learnings ?? [];
  if (!Array.isArray(updates)) throw new UsageError('confidence_updates must be an array');
  if (!Array.isArray(newLearnings)) throw new UsageError('new_learnings must be an array');
  const seen = new Set();
  updates.forEach((u, i) => {
    if (!u || typeof u.id !== 'string' || u.id.length === 0) {
      throw new UsageError(`confidence_updates[${i}]: id must be a non-empty string`);
    }
    if (!OPERATIONS.has(u.operation)) {
      throw new UsageError(
        `confidence_updates[${i}] (id=${u.id}): operation must be confirm|contradict, got: ${u.operation}`,
      );
    }
    if (seen.has(u.id)) throw new UsageError(`confidence_updates[${i}]: id ${u.id} listed twice`);
    seen.add(u.id);
  });
  return { updates, newLearnings };
}

/**
 * Session Config `learning-decay-rate`, or the default when no config is
 * readable. Never throws.
 *
 * @param {string} repoRoot
 * @returns {Promise<number>}
 */
async function resolveDecayRate(repoRoot) {
  try {
    const cfg = parseSessionConfig(await readConfigFile(repoRoot));
    const rate = cfg?.['learning-decay-rate'];
    return typeof rate === 'number' && Number.isFinite(rate) ? rate : DEFAULT_DECAY_RATE;
  } catch {
    return DEFAULT_DECAY_RATE;
  }
}

/**
 * Build the next store generation from the current one plus the input.
 * Pure apart from the clock. Throws UsageError on an unknown/duplicate id or
 * an invalid new learning.
 *
 * @returns {{ next: object[], confirmed: number, contradicted: number, appended: number,
 *   decayed: number, undecayable: number }}
 */
export function buildNextGeneration({ current, updates, newLearnings, decayRate, nowIso }) {
  const byId = new Map();
  for (const entry of current) {
    if (typeof entry?.id === 'string' && entry.id.length > 0) byId.set(entry.id, entry);
  }

  const updateOf = new Map();
  for (const u of updates) {
    if (!byId.has(u.id)) {
      throw new UsageError(`confidence_updates: id ${u.id} not found in the store`);
    }
    updateOf.set(u.id, u.operation);
  }

  let confirmed = 0;
  let contradicted = 0;
  let decayed = 0;
  let undecayable = 0;
  const next = current.map((entry) => {
    const op = typeof entry?.id === 'string' ? updateOf.get(entry.id) : undefined;
    const c = entry?.confidence;
    if (op === 'confirm') {
      confirmed += 1;
      return {
        ...entry,
        confidence: round6(Math.min(1, (typeof c === 'number' ? c : 0) + CONFIRM_DELTA)),
        expires_at: deriveExpiresAt(nowIso, entry.type),
      };
    }
    if (op === 'contradict') {
      contradicted += 1;
      return { ...entry, confidence: round6(Math.max(0, (typeof c === 'number' ? c : 0) - CONTRADICT_DELTA)) };
    }
    if (decayRate > 0 && typeof c === 'number' && c > 0) {
      // An id-less record is keyed by a content fingerprint in pruneLearnings'
      // reconcile pass, so changing its confidence would archive the old
      // version as a spurious "pruned" duplicate every run. It is left to age
      // out via `expires_at` instead — revisit once the legacy id-less records
      // are gone (`migrateLegacyLearning` backfill).
      if (typeof entry?.id !== 'string' || entry.id.length === 0) {
        undecayable += 1;
        return entry;
      }
      decayed += 1;
      return { ...entry, confidence: round6(Math.max(0, c - decayRate)) };
    }
    return entry;
  });

  const newIds = new Set();
  newLearnings.forEach((raw, i) => {
    const label = `new_learnings[${i}] (id=${raw?.id ?? '<missing>'})`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new UsageError(`${label}: must be an object`);
    }
    // Stamping mirrors appendLearning() (io.mjs) so both write paths agree.
    const createdAt =
      typeof raw.created_at === 'string' && raw.created_at.length > 0 ? raw.created_at : nowIso;
    const stamped = {
      ...raw,
      created_at: createdAt,
      expires_at:
        typeof raw.expires_at === 'string' && raw.expires_at.length > 0
          ? raw.expires_at
          : deriveExpiresAt(createdAt, raw.type),
      schema_version: raw.schema_version ?? CURRENT_SCHEMA_VERSION,
    };
    let validated;
    try {
      validated = validateLearning(stamped);
    } catch (err) {
      throw new UsageError(`${label}: ${err.message}`);
    }
    if (byId.has(validated.id) || newIds.has(validated.id)) {
      throw new UsageError(`${label}: id already exists — use confidence_updates to reinforce it`);
    }
    newIds.add(validated.id);
    next.push(validated);
  });

  return { next, confirmed, contradicted, appended: newIds.size, decayed, undecayable };
}

async function emitSessionWriteApplied({ repoRoot, filePath, payload }) {
  const rel = path.relative(repoRoot, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    process.stderr.write(
      `apply-session-learnings: skipped ${SESSION_WRITE_EVENT} — ${filePath} lies outside ` +
        `--repo-root ${repoRoot}\n`,
    );
    return;
  }
  try {
    const { emitEvent, sessionAttribution } = await import('./lib/events.mjs');
    await emitEvent(
      SESSION_WRITE_EVENT,
      { file: rel, ...payload, ...sessionAttribution(repoRoot) },
      { repoRoot },
    );
  } catch (err) {
    // Best-effort telemetry — the write already happened and is authoritative.
    process.stderr.write(`apply-session-learnings: ${SESSION_WRITE_EVENT} not recorded: ${err?.message ?? err}\n`);
  }
}

async function main(argv) {
  let opts;
  let input;
  try {
    opts = parseArgs(argv);
    if (opts.help) {
      printHelp();
      return 0;
    }
    if (opts.input === null && process.stdin.isTTY) {
      throw new UsageError('no input — pipe JSON on stdin or pass --input PATH');
    }
    let raw;
    try {
      raw = readFileSync(opts.input ?? 0, 'utf8');
    } catch (err) {
      throw new UsageError(`cannot read input: ${err.message}`);
    }
    input = parseInput(raw);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`apply-session-learnings: ${err.message}\n`);
      printHelp();
      return 1;
    }
    throw err;
  }

  const repoRoot = path.resolve(opts.repoRoot ?? process.cwd());
  const filePath = path.resolve(repoRoot, opts.file ?? DEFAULT_FILE);
  const archivePath = path.join(path.dirname(filePath), ARCHIVE_BASENAME);
  const decayRate = opts.decayRate ?? (await resolveDecayRate(repoRoot));
  const now = new Date();
  const nowIso = now.toISOString();

  let read;
  try {
    read = await readLearnings(filePath);
  } catch (err) {
    process.stderr.write(`apply-session-learnings: cannot read ${filePath}: ${err.message}\n`);
    return 2;
  }
  if (opts.apply && read.malformed.length > 0) {
    // pruneLearnings rewrites from parsed entries only — a malformed line
    // would vanish without an archive record.
    process.stderr.write(
      `apply-session-learnings: refusing to rewrite — ${read.malformed.length} malformed line(s) in ${filePath}\n`,
    );
    return 2;
  }

  let built;
  try {
    built = buildNextGeneration({
      current: read.entries,
      updates: input.updates,
      newLearnings: input.newLearnings,
      decayRate,
      nowIso,
    });
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`apply-session-learnings: ${err.message} — nothing written\n`);
      return 1;
    }
    throw err;
  }

  let res;
  try {
    res = await pruneLearnings({ filePath, archivePath, entries: built.next, now, dryRun: !opts.apply });
  } catch (err) {
    process.stderr.write(`apply-session-learnings: prune/rewrite failed: ${err.message}\n`);
    return 2;
  }

  const byReason = res.byReason ?? {};
  const pruned = (byReason.expired ?? 0) + (byReason.pruned ?? 0);
  const summary = {
    dry_run: !opts.apply,
    file: filePath,
    read: read.entries.length,
    malformed: read.malformed.length,
    confirmed: built.confirmed,
    contradicted: built.contradicted,
    appended: built.appended,
    decay_rate: decayRate,
    decayed: built.decayed,
    undecayable: built.undecayable,
    pruned,
    consolidated: byReason.superseded ?? 0,
    archived: res.archived,
    kept: res.kept,
    by_reason: byReason,
    written: opts.apply ? res.kept : 0,
  };

  if (opts.apply) {
    await emitSessionWriteApplied({
      repoRoot,
      filePath,
      payload: {
        appended: built.appended,
        confirmed: built.confirmed,
        contradicted: built.contradicted,
        decayed: built.decayed,
        pruned,
      },
    });
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } else {
    process.stdout.write(
      `${summary.dry_run ? '[dry-run] ' : ''}learnings: read ${summary.read}, confirmed ${summary.confirmed}, ` +
        `contradicted ${summary.contradicted}, appended ${summary.appended}, decayed ${summary.decayed} ` +
        `(rate ${decayRate}), pruned ${pruned}, consolidated ${summary.consolidated}, kept ${summary.kept}` +
        `${summary.dry_run ? ' — nothing written' : ` — wrote ${summary.written}`}\n`,
    );
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`apply-session-learnings: ${err?.stack ?? err}\n`);
      process.exitCode = 2;
    },
  );
}
