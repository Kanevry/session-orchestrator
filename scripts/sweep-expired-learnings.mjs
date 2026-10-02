#!/usr/bin/env node
/**
 * sweep-expired-learnings.mjs — CLI for the two mechanical archive-safe writers
 * over `learnings.jsonl`: the time-driven expiry sweep (Epic #723 B4, default)
 * and the decision-driven prune (`--prune`, issue #1017).
 *
 * Both move records OUT of the active store and INTO an append-only archive
 * sidecar. NEVER deletes data — archived entries remain readable in the archive
 * file, tagged with `_archived_at` and an `_archive_reason` from the closed
 * enum `expired | pruned | superseded | merged`.
 *
 * All read/partition/write logic lives in
 * `scripts/lib/learnings/expiry-sweep.mjs` (`sweepExpiredLearnings` /
 * `pruneLearnings`), which delegates the destructive store rewrite to
 * `rewriteLearnings()` from `scripts/lib/learnings/io.mjs` — automatic
 * `.bak-<ISO>` backup + keep-3 rotation (#721) protects every `--apply` run.
 *
 * Why `--prune` is a subcommand here and not an inline `node -e` block in
 * `skills/evolve/SKILL.md`: a mechanism that lives inside prose has no test, no
 * `--help`, and no exit-code contract. `/evolve` names this command; the
 * mechanism stays in code.
 *
 * Usage:
 *   node scripts/sweep-expired-learnings.mjs [--prune] [--dry-run|--apply] [--json]
 *     [--grace-days N] [--snapshot PATH|--entries PATH] [--file PATH] [--archive PATH]
 *     [--appended N] [--boosted M] [--duration-ms D] [--skipped a,b] [--repo-root PATH]
 *   node scripts/sweep-expired-learnings.mjs --drop-malformed --line N [--line M ...]
 *     [--file PATH] [--json] [--apply --generation TOKEN --repo-root PATH]
 *
 * Flags:
 *   --prune           Decision-driven prune+consolidate+rewrite instead of the
 *                      time-driven expiry sweep (issue #1017)
 *   --dry-run         Preview counts; write nothing (DEFAULT, both modes)
 *   --apply           Perform the archive append + store rewrite
 *   --json            Emit a single machine-parseable JSON summary line
 *                      (default: human-readable one-liner)
 *   --grace-days N    Days past expiry before archiving (default: 14).
 *                      SWEEP ONLY — `--prune` has no grace window by design.
 *   --snapshot PATH   PRUNE ONLY (#1486). Write the store's current records to
 *                      PATH, line 1 a `{"_store_generation": "<token>",
 *                      "_store_path": "<store>"}` header naming the exact store
 *                      state and the store they came from. This is the sidecar
 *                      to edit into the next generation. Writes nothing else;
 *                      takes no --entries/--apply/telemetry flag. A PATH that
 *                      would replace the --file store or the --archive sidecar
 *                      exits 1 untouched. A store holding a malformed line is
 *                      snapshotted with a stderr WARN (line numbers) and a
 *                      `malformed` count: the sidecar carries records only, and
 *                      the prune applying it keeps the store's malformed lines
 *                      verbatim (#1489).
 *   --entries PATH    JSONL sidecar holding the caller's next store generation.
 *                      PRUNE ONLY. Must exist, parse cleanly, and hold at least
 *                      one record — absent/malformed/empty all exit 1 untouched.
 *                      Line 1 must be the `_store_generation` header written by
 *                      --snapshot, else exit 1 untouched; a sidecar snapshotted
 *                      from another store than --file exits 1 untouched; a
 *                      store that changed since that snapshot exits 3
 *                      untouched (#1486).
 *                      A NEW record (its `id` not in the store) must pass strict
 *                      `validateLearning()`, else exit 1 untouched (GH#69);
 *                      records already in the store keep the tolerant path.
 *                      Omitted ⇒ a pure prune+consolidate pass over the on-disk
 *                      store.
 *   --file PATH       Learnings store (default: .orchestrator/metrics/learnings.jsonl)
 *   --archive PATH    Archive sidecar (default: .orchestrator/metrics/learnings-archive.jsonl)
 *   --appended N      PRUNE ONLY (#1206). New learnings written this `/evolve`
 *                      run (Step 3.5(4)); folded into the mechanical
 *                      `orchestrator.evolve.completed` emit alongside this
 *                      call's own `pruned` count. Default 0.
 *   --boosted M       PRUNE ONLY (#1206). Existing learnings reinforced this
 *                      run (Step 3.5(2)). Default 0.
 *   --duration-ms D   PRUNE ONLY (#1206). Elapsed ms since the run's telemetry
 *                      start marker. Default 0.
 *   --skipped a,b     PRUNE ONLY (#1206). Comma-separated list of optional
 *                      steps that ran but were themselves skipped this run
 *                      (HR-105 — e.g. `skill-evolution-off`). Default none.
 *   --drop-malformed  Remove unparseable store lines (#1500) — the one sanctioned
 *                      repair; the store keeps such lines verbatim through every
 *                      rewrite. Takes --line (required), --generation, --file,
 *                      --json, --apply, --repo-root; nothing else. A dry run
 *                      (default) checks each line and prints its preview and the
 *                      store generation. --apply re-reads the store under its
 *                      lock, copies it to <stem>.pre-drop-malformed.jsonl.bak-<ISO>
 *                      beside it, rewrites it without those lines, and records
 *                      one orchestrator.learnings.malformed_dropped event.
 *   --line N          DROP-MALFORMED ONLY. 1-based store line (repeatable). Must
 *                      be an unparseable line in the store as read, else exit 1.
 *   --generation TOKEN  DROP-MALFORMED ONLY; required with --apply. The
 *                      generation the dry run printed: line numbers move with
 *                      every rewrite, so a changed store exits 3.
 *   --repo-root PATH  With --drop-malformed --apply: REQUIRED, the repo the
 *                      event is pinned to; --file must lie inside it.
 *                      Otherwise PRUNE ONLY (#1206). Repo root the
 *                      `orchestrator.evolve.completed` record is pinned to.
 *                      No default and NO process.cwd() fallback (#1119) — when
 *                      omitted, no event is emitted at all (stderr WARN, exit
 *                      code unaffected). Emission is best-effort and never
 *                      changes this command's exit code or stdout contract.
 *
 * Exit codes:
 *   0  Success (including no-op when nothing is archive-eligible)
 *   1  Usage/input error (bad flag/value, flag used in the wrong mode, a
 *      --drop-malformed --line that is not an unparseable line, an
 *      absent/malformed/empty `--entries` sidecar, or a NEW `--entries` record
 *      that fails strict schema validation, or an `--entries` sidecar without
 *      its `_store_generation` header or snapshotted from another store than
 *      `--file` — dry run and apply alike; at `--snapshot`, a PATH that would
 *      replace a ledger)
 *   2  Sweep/prune error (I/O or validation failure inside the lib)
 *   3  store-generation-mismatch (#1486, #1500): the store changed after the
 *      --drop-malformed dry run that printed --generation, or after the
 *      `--entries` sidecar was snapshotted — nothing written. Drop: re-run the
 *      dry run, re-check its previews, apply with ITS generation. Prune: re-run
 *      `--snapshot` into a FRESH path, re-apply the edits to the records in
 *      that file, apply it. Never copy the new header onto the old sidecar:
 *      its records lack exactly the peer change the token exists to protect.
 */

import { existsSync, realpathSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  sweepExpiredLearnings,
  pruneLearnings,
  dropMalformedLines,
  MalformedLineRefusedError,
  StoreGenerationMismatchError,
  warnUnparseableLines,
} from './lib/learnings/expiry-sweep.mjs';
import { readLearningsSnapshot, parseLearningsText } from './lib/learnings/io.mjs';
import { validateLearning } from './lib/learnings/schema.mjs';
import { emitEvolveCompleted } from './lib/learnings/evolve-telemetry.mjs';

const DEFAULT_FILE = '.orchestrator/metrics/learnings.jsonl';
const DEFAULT_ARCHIVE = '.orchestrator/metrics/learnings-archive.jsonl';
const DEFAULT_GRACE_DAYS = 14;
/** Key of the `--entries` sidecar's first line, written by `--snapshot` (#1486). */
const GENERATION_KEY = '_store_generation';
/** Header key naming the store the snapshot was read from (resolved path). */
const STORE_PATH_KEY = '_store_path';
/** Ledger record of one applied `--drop-malformed` (#1500). */
const DROP_MALFORMED_EVENT = 'orchestrator.learnings.malformed_dropped';

function printHelp() {
  process.stdout.write(
    `Usage: node scripts/sweep-expired-learnings.mjs [--prune] [--dry-run|--apply] [--json] [--grace-days N] [--snapshot PATH|--entries PATH] [--file PATH] [--archive PATH]
       node scripts/sweep-expired-learnings.mjs --drop-malformed --line N [--line M ...] [--file PATH] [--json] [--apply --generation TOKEN --repo-root PATH]

Modes:
  (default)         Expiry sweep — archive entries expired past the grace window
  --prune           Prune + consolidate + rewrite (issue #1017): archives
                    expired / zero-confidence / superseded / caller-dropped
                    records instead of deleting them
  --drop-malformed  Remove unparseable store lines (#1500) — never hand-edit
                    the store. The dry run (default) checks each --line and
                    prints its preview and the store generation; --apply with
                    --generation <that token> --repo-root <root> snapshots the
                    store beside it, rewrites it without those lines and
                    records one ${DROP_MALFORMED_EVENT} event

Options:
  --dry-run         Preview counts; write nothing (default)
  --apply           Perform the archive append + store rewrite
  --json            Emit a single machine-parseable JSON summary line
  --grace-days N    Days past expiry before archiving (default: ${DEFAULT_GRACE_DAYS}); sweep only
  --snapshot PATH   Prune only. Write the store's records to PATH, headed by a
                    ${GENERATION_KEY} line; edit that file into the next
                    generation and pass it as --entries. Writes nothing else;
                    a PATH that is the --file store or --archive sidecar
                    exits 1. Malformed store lines are WARNed and counted,
                    never put in the sidecar; the prune keeps them verbatim
  --entries PATH    JSONL sidecar with the next store generation; prune only.
                    Must exist, parse cleanly, start with the --snapshot
                    header of the same --file store, and hold >= 1 record; a
                    NEW record (id not in the store) must pass strict schema
                    validation, else exit 1 with nothing written
  --file PATH       Learnings store (default: ${DEFAULT_FILE})
  --archive PATH    Archive sidecar (default: ${DEFAULT_ARCHIVE})
  --line N          Drop-malformed only. 1-based store line, repeatable; must be
                    an unparseable line of the store as read, else exit 1
  --generation TOKEN  Drop-malformed only, required with --apply: the dry
                    run's generation; a store changed since exits 3
  --repo-root PATH  Drop-malformed --apply: required, --file must lie inside it

Exit codes:  0 success  1 usage/input error (incl. a --line that is not unparseable,
               an invalid new --entries record,
               a sidecar from another --file store, a --snapshot PATH that
               would replace the store or the archive)
             2 sweep/prune error
             3 store-generation-mismatch: the store changed after the --entries
               snapshot or the drop-malformed dry run; nothing written —
               drop: re-run the dry run and apply with its generation;
               prune: re-snapshot into a fresh path, re-apply the edits
               there, re-run with that path
`
  );
}

/** Exit 1 with a diagnostic on stderr (usage/input errors). */
function usageError(message) {
  process.stderr.write(`sweep-expired-learnings: ${message}\n`);
  process.exit(1);
}

/**
 * The value of a PATH flag, or a usage error (exit 1) when it is missing. An
 * absent value used to surface later as a lib TypeError — exit 2, which the
 * exit-code contract reserves for a failure inside the sweep/prune itself.
 */
function pathValue(flag, raw) {
  if (typeof raw !== 'string' || raw.length === 0) usageError(`${flag} requires a PATH`);
  return raw;
}

function parseArgs(argv) {
  const args = {
    prune: false,
    dryRun: true,
    json: false,
    graceDays: DEFAULT_GRACE_DAYS,
    graceDaysExplicit: false,
    entries: null,
    snapshot: null,
    file: DEFAULT_FILE,
    archive: DEFAULT_ARCHIVE,
    appended: 0,
    boosted: 0,
    durationMs: 0,
    skipped: [],
    // #1119 — NO process.cwd() fallback. Most CLI callers (every test in this
    // file except the SKILL.md-extraction fixture, which sets its own tmp
    // `cwd`) invoke this script from the repo root without `--repo-root`; a
    // cwd fallback would silently append synthetic `orchestrator.evolve.
    // completed` records to the operator's REAL fleet ledger on every
    // `--prune --apply` run in `npm test`. `emitEvolveCompleted()` already
    // refuses to emit (stderr WARN, no throw) when repoRoot is absent — same
    // fail-closed contract as `emitReconcileCompleted` / `express-path.mjs`.
    repoRoot: null,
    telemetryExplicit: false,
    // The four /evolve counters alone — `--repo-root` is telemetry too, but it
    // is also the event destination of `--drop-malformed`.
    countersExplicit: false,
    archiveExplicit: false,
    dropMalformed: false,
    lines: [],
    generation: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--prune') {
      args.prune = true;
    } else if (a === '--drop-malformed') {
      args.dropMalformed = true;
    } else if (a === '--line') {
      const raw = argv[++i];
      const v = Number(raw);
      if (!Number.isInteger(v) || v < 1) {
        usageError(`--line requires a positive integer (a 1-based store line), got: ${raw}`);
      }
      args.lines.push(v);
    } else if (a === '--generation') {
      const raw = argv[++i];
      if (typeof raw !== 'string' || raw.length === 0) usageError('--generation requires a TOKEN');
      args.generation = raw;
    } else if (a === '--apply') {
      args.dryRun = false;
    } else if (a === '--dry-run') {
      args.dryRun = true;
    } else if (a === '--json') {
      args.json = true;
    } else if (a === '--grace-days') {
      const raw = argv[++i];
      const v = Number(raw);
      if (!Number.isFinite(v) || v < 0) {
        usageError(`--grace-days requires a non-negative number, got: ${raw}`);
      }
      args.graceDays = v;
      args.graceDaysExplicit = true;
    } else if (a === '--entries') {
      args.entries = pathValue(a, argv[++i]);
    } else if (a === '--snapshot') {
      args.snapshot = pathValue(a, argv[++i]);
    } else if (a === '--file') {
      args.file = pathValue(a, argv[++i]);
    } else if (a === '--archive') {
      args.archive = pathValue(a, argv[++i]);
      args.archiveExplicit = true;
    } else if (a === '--appended') {
      const raw = argv[++i];
      const v = Number(raw);
      if (!Number.isInteger(v) || v < 0) {
        usageError(`--appended requires a non-negative integer, got: ${raw}`);
      }
      args.appended = v;
      args.telemetryExplicit = true;
      args.countersExplicit = true;
    } else if (a === '--boosted') {
      const raw = argv[++i];
      const v = Number(raw);
      if (!Number.isInteger(v) || v < 0) {
        usageError(`--boosted requires a non-negative integer, got: ${raw}`);
      }
      args.boosted = v;
      args.telemetryExplicit = true;
      args.countersExplicit = true;
    } else if (a === '--duration-ms') {
      const raw = argv[++i];
      const v = Number(raw);
      if (!Number.isFinite(v) || v < 0) {
        usageError(`--duration-ms requires a non-negative number, got: ${raw}`);
      }
      args.durationMs = v;
      args.telemetryExplicit = true;
      args.countersExplicit = true;
    } else if (a === '--skipped') {
      const raw = argv[++i];
      args.skipped = typeof raw === 'string' ? raw.split(',').filter((s) => s.length > 0) : [];
      args.telemetryExplicit = true;
      args.countersExplicit = true;
    } else if (a === '--repo-root') {
      // Absolute on purpose: emitEvent refuses a relative root (#1468).
      args.repoRoot = path.resolve(pathValue(a, argv[++i]));
      args.telemetryExplicit = true;
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      usageError(`unknown argument: ${a}`);
    }
  }

  // Mode/flag mismatches are usage errors, never silent no-ops: a `--grace-days`
  // that the prune path ignores would read as "the grace window applied" in a
  // transcript, and an `--entries` the sweep ignores would read as "my next
  // generation was written".
  if (args.dropMalformed) {
    // Its own mode: nothing of the sweep or the prune applies, and an
    // `--archive` would read as "the dropped line was archived" — it never is.
    if (
      args.prune ||
      args.graceDaysExplicit ||
      args.archiveExplicit ||
      args.countersExplicit ||
      args.entries !== null ||
      args.snapshot !== null
    ) {
      usageError(
        '--drop-malformed takes no --prune, --grace-days, --archive, --entries, --snapshot or ' +
          '/evolve counter flag (a dropped line is never archived)'
      );
    }
    if (args.lines.length === 0) usageError('--drop-malformed requires at least one --line N');
    if (!args.dryRun) {
      if (args.generation === null) {
        usageError(
          '--drop-malformed --apply requires --generation TOKEN — the generation its dry run printed ' +
            '(line numbers move with every rewrite); nothing written'
        );
      }
      if (args.repoRoot === null) {
        usageError(
          '--drop-malformed --apply requires --repo-root PATH — the event recording the drop is ' +
            'pinned there (#1119: no cwd fallback); nothing written'
        );
      }
      const rel = path.relative(args.repoRoot, path.resolve(args.file));
      if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
        usageError(`--file ${args.file} lies outside --repo-root ${args.repoRoot} — nothing written`);
      }
    }
    return args;
  }
  if (args.lines.length > 0 || args.generation !== null) {
    usageError('--line/--generation are only valid with --drop-malformed');
  }
  if (args.prune && args.graceDaysExplicit) {
    usageError('--grace-days is not valid with --prune (the prune path has no grace window)');
  }
  if (!args.prune && args.entries !== null) {
    usageError('--entries is only valid with --prune');
  }
  if (!args.prune && args.snapshot !== null) {
    usageError('--snapshot is only valid with --prune');
  }
  if (args.snapshot !== null && (args.entries !== null || !args.dryRun || args.telemetryExplicit)) {
    usageError('--snapshot writes only the sidecar — it takes no --entries, --apply, or telemetry flag');
  }
  if (!args.prune && args.telemetryExplicit) {
    usageError(
      '--appended/--boosted/--duration-ms/--skipped/--repo-root are only valid with --prune ' +
        '(the sweep path never emits orchestrator.evolve.completed)',
    );
  }
  return args;
}

/**
 * Time-driven expiry sweep (Epic #723 B4) — the default mode.
 *
 * @param {ReturnType<typeof parseArgs>} args
 */
async function runSweep(args) {
  let result;
  try {
    result = await sweepExpiredLearnings({
      filePath: args.file,
      archivePath: args.archive,
      dryRun: args.dryRun,
      graceDays: args.graceDays,
    });
  } catch (err) {
    process.stderr.write(`sweep-expired-learnings: sweep failed: ${err.message}\n`);
    process.exit(2);
  }

  const summary = {
    file: args.file,
    grace_days: args.graceDays,
    ...result,
  };

  if (args.json) {
    process.stdout.write(JSON.stringify(summary) + '\n');
  } else {
    process.stdout.write(
      `sweep-expired-learnings: scanned=${summary.scanned} kept=${summary.kept} ` +
        `archived=${summary.archived} dry_run=${summary.dryRun} archive=${summary.archivePath}\n`
    );
  }
}

/**
 * Resolve the `--entries` sidecar into the caller's next store generation.
 *
 * Fails closed on THREE input conditions, all of which yield the same lethal
 * value — an empty next generation, which makes `pruneLearnings()` treat the
 * ENTIRE store as caller-dropped:
 *
 *   1. **absent file** — `readLearnings()` returns `{entries: [], malformed: []}`
 *      for a missing path, so one mistyped path would archive every active
 *      learning. A path the operator named and the filesystem does not have is
 *      an input error, not an empty set.
 *   2. **malformed line** — a half-written sidecar reads as a SHORTER next
 *      generation, pruning every record the truncated tail omitted.
 *   3. **parses to zero records** — a 0-byte or blank-line-only file. Guard (1)
 *      closes ABSENCE, which is a different condition: an empty file EXISTS, so
 *      it sails past `existsSync` and parses to a legitimate-looking empty
 *      generation. Measured on a 3-record fixture before this guard: a 0-byte
 *      `--entries` archived all 3 and exited 0.
 *
 * Condition 3 is REJECTED rather than obeyed because at a file boundary an
 * empty parse is indistinguishable from a truncated write, a failed producer,
 * or a typo that landed on an unrelated empty file — and no caller expresses
 * "archive the whole corpus" through this flag: `/evolve`'s next generation
 * always carries the survivors. The cost of rejecting a genuinely-intended
 * empty generation is one re-run; the cost of obeying a corrupt one is the
 * active store. Note this guard is deliberately NOT in `pruneLearnings()`: an
 * explicit `entries: []` written in CODE is a statement, and the lib keeps it
 * expressible. Only the FILE is ambiguous, so only the file is guarded.
 *
 * A fourth guard (#1486): line 1 must be the `_store_generation` header that
 * `--snapshot` wrote. The sidecar is derived minutes before the prune, in
 * another process, so a record a peer appends in between is absent from it and
 * would be archived `pruned`; the header lets `pruneLearnings()` refuse under
 * the store lock instead. A headerless sidecar is refused, not trusted: a check
 * that runs only when the token is present is bypassed by every producer that
 * forgets it. The producers are prose, so every one must say `--snapshot`:
 * `skills/evolve/references/evolve-analyze-mode.md` § 3.5, `skills/evolve/SKILL.md`
 * § 4.4, and `.cursor/rules/060-evolve.mdc` (analyze Step 5 + review Step 3),
 * which `scripts/cursor-install.mjs` installs into consumer repos. Census
 * 2026-10-02: `rg --hidden -e --entries` over the tracked tree; plain `rg`
 * skips `.cursor/`, which is how the first census missed the third producer.
 *
 * The header also names the store it was snapshotted from (`_store_path`);
 * `runPrune()` refuses a sidecar applied to another `--file`. A header without
 * that key is the earlier format of this same unreleased flag and is accepted
 * on its token alone.
 *
 * @param {string} entriesPath
 * @returns {Promise<{entries: object[], generation: string, storePath: string|null}>}
 *   the validated, non-empty next generation, the store generation it was
 *   derived from, and the store it was snapshotted from (null: not recorded)
 */
async function loadEntriesSidecar(entriesPath) {
  if (!existsSync(entriesPath)) {
    usageError(
      `--entries sidecar not found: ${entriesPath} (refusing to prune — an absent ` +
        `next generation would archive the whole store)`
    );
  }
  let raw;
  try {
    raw = await readFile(entriesPath, 'utf8');
  } catch (err) {
    usageError(`--entries sidecar unreadable: ${entriesPath}: ${err.message}`);
  }
  const firstLine = raw.split('\n').find((l) => l.length > 0) ?? '';
  const header = parseHeader(firstLine);
  const read = parseLearningsText(header === null ? raw : raw.slice(raw.indexOf(firstLine) + firstLine.length));
  if (read.malformed.length > 0) {
    usageError(
      `refusing to prune — ${read.malformed.length} malformed line(s) in ${entriesPath}`
    );
  }
  if (read.entries.length === 0) {
    usageError(
      `--entries sidecar holds no records: ${entriesPath} (refusing to prune — an empty ` +
        `next generation would archive every record in the store; omit --entries for a ` +
        `pure prune+consolidate pass)`
    );
  }
  if (header === null) {
    // The recovery names a FRESH path: snapshotting onto the --entries path
    // would overwrite the decisions this run assembled there.
    usageError(
      `--entries sidecar has no "${GENERATION_KEY}" header line: ${entriesPath} (refusing ` +
        `to prune — without it a record appended after the sidecar was derived would be ` +
        `archived as pruned; run --prune --snapshot into a FRESH path, re-apply this run's ` +
        `edits to the records in that file keeping its line 1, and pass it as --entries)`
    );
  }
  return { entries: read.entries, generation: header.generation, storePath: header.storePath };
}

/**
 * The header a sidecar's first line carries, or `null` when that line is not
 * a `{"_store_generation": "<non-empty string>"}` header. `_store_path` may be
 * absent (earlier format, `storePath: null`); present, it must be a non-empty
 * string, else the whole header is refused — a mangled line 1 is not trusted.
 *
 * @param {string} line
 * @returns {{generation: string, storePath: string|null}|null}
 */
function parseHeader(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const isToken = (v) => typeof v === 'string' && v.length > 0;
  const generation = parsed[GENERATION_KEY];
  const storePath = parsed[STORE_PATH_KEY];
  if (!isToken(generation) || (storePath !== undefined && !isToken(storePath))) return null;
  return { generation, storePath: storePath ?? null };
}

/**
 * A comparable key for the directory entry a write-then-rename onto `p`
 * replaces: the nearest EXISTING ancestor directory by `dev`+`ino` (so a
 * symlinked directory, a firmlink, or a differently-cased spelling of it is
 * the same key), then the rest of the path case-folded. Case-folding the rest
 * is what a case-insensitive volume (default APFS, NTFS) does to the name;
 * on a case-sensitive volume it can only over-match — two names differing in
 * case alone get refused, which costs a re-run with another name. Deliberate
 * ceiling: the fold is `NFC` + `toLowerCase()`, so a name differing only by a
 * fold outside that (`ß`/`SS`) is not caught — revisit if a ledger name ever
 * leaves ASCII.
 *
 * @param {string} p
 * @returns {string}
 */
function renameTargetKey(p) {
  const abs = path.resolve(p);
  const rest = [path.basename(abs)];
  for (let dir = path.dirname(abs); ; ) {
    try {
      const { dev, ino } = statSync(dir, { bigint: true });
      return `${dev}:${ino}/${rest.join('/').normalize('NFC').toLowerCase()}`;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return abs.normalize('NFC').toLowerCase(); // not even the root stats
      rest.unshift(path.basename(dir));
      dir = parent;
    }
  }
}

/**
 * A ledger path resolved to the file it names: through symlinks when it
 * exists, else absolute as given.
 *
 * @param {string} p
 * @returns {string}
 */
function resolveLedger(p) {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Exit 1 when `--snapshot` would replace the store or the archive. The rename
 * lands the header as the store's line 1 with no `.bak` (and drops malformed
 * lines), or replaces the append-only archive with the store's records —
 * measured on 91b35d4b, both exit 0. The target is compared by
 * {@link renameTargetKey} against the ledger's own entry and the file it
 * resolves to. A path-string compare (44fc80e4) closed the symlinked-directory
 * spelling but not letter case: on this host's case-insensitive APFS,
 * `--snapshot <metrics>/Learnings.jsonl`, `METRICS/learnings.jsonl` and
 * `LEARNINGS-ARCHIVE.jsonl` each replaced a ledger, exit 0 (measured
 * 2026-10-02). Hard links need no check: rename replaces the directory entry,
 * never the inode behind it.
 *
 * @param {ReturnType<typeof parseArgs>} args
 */
function refuseLedgerSnapshotTarget(args) {
  const target = renameTargetKey(args.snapshot);
  for (const [label, ledger] of [['store', args.file], ['archive', args.archive]]) {
    if ([renameTargetKey(ledger), renameTargetKey(resolveLedger(ledger))].includes(target)) {
      usageError(
        `--snapshot ${args.snapshot} would replace the learnings ${label} ${ledger} (refusing — ` +
          `nothing written; snapshot into a sidecar such as .orchestrator/tmp/learnings-next.jsonl)`
      );
    }
  }
}

/**
 * `--prune --snapshot PATH` (#1486): write the store's current records to PATH
 * behind a `_store_generation` header, token and records from ONE read. This
 * is the sidecar `/evolve` edits into its next generation; `--entries` later
 * refuses it if the store moved in between. Write-then-rename, so a crash
 * never leaves a header over a truncated record list.
 *
 * A store holding a malformed line is snapshotted with a WARN (its line
 * numbers) and a `malformed` count in the summary. The sidecar holds records
 * only — a malformed line is no record — and the prune applying it keeps the
 * store's malformed lines verbatim at the end of the rewrite, never archived
 * (`pruneLearnings()` reads them under the lock, #1489). Refusing here, as
 * before 26746202 made the rewrite keep them, would block every `/evolve`
 * write on that store with no sanctioned repair path.
 *
 * @param {ReturnType<typeof parseArgs>} args
 */
async function runSnapshot(args) {
  refuseLedgerSnapshotTarget(args);
  let snap;
  try {
    snap = await readLearningsSnapshot(args.file);
  } catch (err) {
    process.stderr.write(`sweep-expired-learnings: snapshot failed: ${err.message}\n`);
    process.exit(2);
  }
  warnUnparseableLines(args.file, snap.malformed, snap.malformedLineNumbers);
  try {
    const lines = [
      JSON.stringify({ [GENERATION_KEY]: snap.generation, [STORE_PATH_KEY]: resolveLedger(args.file) }),
      ...snap.entries.map((e) => JSON.stringify(e)),
    ];
    await mkdir(path.dirname(args.snapshot), { recursive: true });
    const tmp = `${args.snapshot}.tmp-${process.pid}`;
    await writeFile(tmp, lines.join('\n') + '\n', 'utf8');
    await rename(tmp, args.snapshot);
  } catch (err) {
    process.stderr.write(`sweep-expired-learnings: snapshot failed: ${err.message}\n`);
    process.exit(2);
  }
  const summary = {
    file: args.file,
    snapshot: args.snapshot,
    generation: snap.generation,
    records: snap.entries.length,
    // Present only when non-zero — the convention of the sweep/prune results.
    ...(snap.malformed.length > 0 ? { malformed: snap.malformed.length } : {}),
  };
  if (args.json) {
    process.stdout.write(JSON.stringify(summary) + '\n');
  } else {
    process.stdout.write(
      `sweep-expired-learnings: snapshot records=${summary.records} ` +
        `generation=${summary.generation} -> ${summary.snapshot}\n`
    );
  }
}

/**
 * Strict-validate every `--entries` record the store does not already hold.
 *
 * `pruneLearnings()` rewrites through `rewriteLearnings()`, which runs
 * `legacyTolerant` so records ALREADY in the store (legacy shapes, EventDrop
 * #386) survive a round-trip. Without this gate the same tolerance admitted
 * NEW records too — a sidecar record with `scope: "src/app/x.tsx"` and no
 * `created_at`/`expires_at` was written (GH#69). New = its `id` is absent from
 * the store; an id-less record counts as known only when an id-less store
 * record is deep-equal to it (the carry-through case — linear scan over the
 * id-less subset, fine while such records stay rare; revisit if a store holds
 * hundreds of them). Runs before any write, in dry run and apply alike.
 *
 * A failure is judged against the store's generation first: a peer that
 * dropped a snapshotted legacy record turns it "new", and strict validation
 * then reported exit 1 ("re-write the sidecar") for what is a stale snapshot —
 * exit 3 (measured on 91b35d4b). The generation decides ONLY on a failure, so
 * a stale sidecar that validates still reaches the authoritative re-read under
 * the lock in `pruneLearnings()`; an unconditional comparison here pre-empted
 * that check and left it untested (disabled, the suite stayed 32/32 green).
 *
 * @param {object[]} entries - the parsed `--entries` generation
 * @param {string} expectedGeneration - the sidecar's `_store_generation`
 * @param {ReturnType<typeof parseArgs>} args
 */
async function rejectInvalidNewRecords(entries, expectedGeneration, args) {
  let store;
  try {
    store = await readLearningsSnapshot(args.file);
  } catch (err) {
    process.stderr.write(`sweep-expired-learnings: prune failed: cannot read ${args.file}: ${err.message}\n`);
    process.exit(2);
  }
  const idOf = (e) => (typeof e?.id === 'string' && e.id.length > 0 ? e.id : null);
  const storeIds = new Set(store.entries.map(idOf).filter((id) => id !== null));
  const storeIdless = store.entries.filter((e) => idOf(e) === null);
  for (const entry of entries) {
    const id = idOf(entry);
    const known = id !== null ? storeIds.has(id) : storeIdless.some((s) => isDeepStrictEqual(s, entry));
    if (known) continue;
    try {
      validateLearning(entry);
    } catch (err) {
      if (store.generation !== expectedGeneration) exitGenerationMismatch(args);
      usageError(`--entries: new record ${id ?? '(no id)'} is invalid: ${err.message} — nothing written`);
    }
  }
}

/**
 * Exit 3 for a stale `--entries` sidecar (#1486). The recovery names a FRESH
 * snapshot path and prints no generation token: the current token copied onto
 * this sidecar's line 1 would carry its stale records past the guard.
 *
 * @param {ReturnType<typeof parseArgs>} args
 */
function exitGenerationMismatch(args) {
  process.stderr.write(
    `sweep-expired-learnings: store-generation-mismatch: ${args.file} changed after ${args.entries} ` +
      `was snapshotted — nothing written. Run --prune --snapshot into a FRESH path, re-apply this ` +
      `run's edits to the records in that file, and pass it as --entries; never copy a newer ` +
      `${GENERATION_KEY} header onto ${args.entries}\n`
  );
  process.exit(3);
}

/**
 * Decision-driven prune + consolidate + rewrite (issue #1017).
 *
 * @param {ReturnType<typeof parseArgs>} args
 */
async function runPrune(args) {
  if (args.snapshot !== null) {
    await runSnapshot(args);
    return;
  }
  const sidecar = args.entries === null ? undefined : await loadEntriesSidecar(args.entries);
  if (sidecar !== undefined) {
    // Before any generation comparison: a sidecar applied to another store can
    // never match it, so exit 3 sent the documented retry — snapshot without
    // that --file, apply with it — round the loop forever (measured
    // 2026-10-02), its message naming the wrong file.
    if (
      sidecar.storePath !== null &&
      renameTargetKey(resolveLedger(sidecar.storePath)) !== renameTargetKey(resolveLedger(args.file))
    ) {
      usageError(
        `--entries ${args.entries} was snapshotted from ${sidecar.storePath}, not from the --file ` +
          `store ${args.file} (refusing — nothing written; pass the same --file/--archive to ` +
          `--snapshot and to this call)`
      );
    }
    await rejectInvalidNewRecords(sidecar.entries, sidecar.generation, args);
  }

  let result;
  try {
    result = await pruneLearnings({
      filePath: args.file,
      archivePath: args.archive,
      entries: sidecar?.entries,
      expectedGeneration: sidecar?.generation,
      dryRun: args.dryRun,
    });
  } catch (err) {
    if (err instanceof StoreGenerationMismatchError) exitGenerationMismatch(args);
    process.stderr.write(`sweep-expired-learnings: prune failed: ${err.message}\n`);
    process.exit(2);
  }

  const summary = {
    file: args.file,
    entries_from: args.entries,
    ...result,
  };

  // #1206 — the ONE mechanical call site for `orchestrator.evolve.completed`:
  // this `--prune --apply` invocation IS `/evolve analyze`'s Step 3.5(5) store
  // write, so folding the emit in here (instead of a separate
  // `emit-event.mjs` call in skill prose) means the event can no longer be
  // forgotten independently of the write it reports on. Gated on `!dryRun` —
  // a `--prune --dry-run` preview (the docs' own recommended pre-check for a
  // hand-assembled `--entries` sidecar) never wrote anything, so it must not
  // report a completed run either. Best-effort — never changes this
  // command's exit code or stdout contract.
  if (!args.dryRun) {
    await emitEvolveCompleted({
      repoRoot: args.repoRoot,
      appended: args.appended,
      boosted: args.boosted,
      pruned: result.archived,
      durationMs: args.durationMs,
      skipped: args.skipped,
    });
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(summary) + '\n');
  } else {
    const byReason =
      Object.entries(summary.byReason)
        .map(([reason, n]) => `${reason}:${n}`)
        .join(',') || '-';
    process.stdout.write(
      `sweep-expired-learnings: prune scanned=${summary.scanned} kept=${summary.kept} ` +
        `archived=${summary.archived} by_reason=${byReason} dry_run=${summary.dryRun} ` +
        `archive=${summary.archivePath}\n`
    );
  }
}

/**
 * Record one applied `--drop-malformed` in the repo's ledger. Best-effort: the
 * rewrite already happened and is authoritative, so a telemetry failure is
 * reported on stderr and never changes the exit code. No line text goes in —
 * the record travels over the optional webhook unredacted; the snapshot holds it.
 *
 * @param {ReturnType<typeof parseArgs>} args - `repoRoot` set, `file` inside it (parseArgs)
 * @param {Awaited<ReturnType<typeof dropMalformedLines>>} result
 */
async function emitMalformedDropped(args, result) {
  const rel = (p) => path.relative(args.repoRoot, path.resolve(p));
  try {
    const { emitEvent, sessionAttribution } = await import('./lib/events.mjs');
    await emitEvent(
      DROP_MALFORMED_EVENT,
      {
        file: rel(args.file),
        dropped: result.dropped.length,
        lines: result.dropped.map((d) => d.line),
        remaining_malformed: result.remainingMalformed,
        snapshot: rel(result.snapshot),
        source: 'sweep-expired-learnings-cli',
        ...sessionAttribution(args.repoRoot),
      },
      { repoRoot: args.repoRoot },
    );
  } catch (err) {
    process.stderr.write(`sweep-expired-learnings: ${DROP_MALFORMED_EVENT} not recorded: ${err?.message ?? err}\n`);
  }
}

/**
 * `--drop-malformed --line N` (#1500): remove unparseable store lines — the
 * sanctioned repair the WARN and learning-patterns.md §f name. A dry run
 * (default) checks each line and prints its preview plus the store generation;
 * `--apply --generation <that token> --repo-root <root>` re-reads the store
 * under its lock, refuses a changed store (exit 3) or a line that is not
 * unparseable (exit 1), snapshots the store beside it, rewrites it, and
 * records one {@link DROP_MALFORMED_EVENT}.
 *
 * @param {ReturnType<typeof parseArgs>} args
 */
async function runDropMalformed(args) {
  let result;
  try {
    result = await dropMalformedLines({
      filePath: args.file,
      lines: args.lines,
      expectedGeneration: args.generation ?? undefined,
      dryRun: args.dryRun,
    });
  } catch (err) {
    if (err instanceof MalformedLineRefusedError) usageError(err.message);
    if (err instanceof StoreGenerationMismatchError) {
      process.stderr.write(
        `sweep-expired-learnings: store-generation-mismatch: ${args.file} changed after the dry run ` +
          `that printed --generation — nothing written. Its line numbers may name other lines now: ` +
          `re-run the dry run, check the previews it prints, and apply with ITS generation\n`
      );
      process.exit(3);
    }
    process.stderr.write(`sweep-expired-learnings: drop-malformed failed: ${err.message}\n`);
    process.exit(2);
  }

  if (!args.dryRun) await emitMalformedDropped(args, result);

  const summary = {
    file: args.file,
    generation: result.generation,
    dropped: result.dropped,
    records: result.records,
    remaining_malformed: result.remainingMalformed,
    dry_run: result.dryRun,
    snapshot: result.snapshot,
  };
  if (args.json) {
    process.stdout.write(JSON.stringify(summary) + '\n');
    return;
  }
  process.stdout.write(
    `sweep-expired-learnings: drop-malformed lines=${JSON.stringify(summary.dropped.map((d) => d.line))} ` +
      `records=${summary.records} remaining_malformed=${summary.remaining_malformed} ` +
      `dry_run=${summary.dry_run} generation=${summary.generation}` +
      (summary.snapshot ? ` snapshot=${summary.snapshot}` : '') +
      '\n' +
      summary.dropped.map((d) => `  line ${d.line}: ${d.preview}\n`).join('')
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.dropMalformed) {
    await runDropMalformed(args);
    return;
  }
  if (args.prune) {
    await runPrune(args);
    return;
  }
  await runSweep(args);
}

main().catch((err) => {
  process.stderr.write(`sweep-expired-learnings: unexpected error: ${err?.stack ?? err}\n`);
  process.exit(2);
});
