/**
 * board-writer.mjs — Render + idempotently write the vault live-status board.
 *
 * Epic #673 Phase 1 (issue #674). Writes a host-local board at
 * `<vault-dir>/01-projects/_active-sessions.md` listing, per repo, one row:
 *   status ∈ {frei, in-progress, closed, force-closed}
 *   semantic-session-id · branch · mode · last-heartbeat
 *
 * Source of truth: the per-repo `session.lock` v2 lease (heartbeat-based
 * liveness via {@link isLockLive}) plus the host-wide session registry (the
 * registry entry is the ONLY source of `branch` — the lock lacks that field).
 *
 * Telemetry: every {@link mirrorBoard} call — and therefore every
 * {@link sweepBoard} call — emits exactly ONE {@link BOARD_EVENT} record,
 * including the no-op paths (`skipped-vault-disabled`, `skipped-handwritten`,
 * `skipped-noop`, `skipped-write-failed`). Those are the states that previously
 * looked identical to a healthy write from outside the process. Emission is
 * best-effort and can never fail a board write.
 *
 * Exports:
 *   GENERATOR_MARKER  — frontmatter sentinel that identifies generator-owned files
 *   BOARD_EVENT       — canonical event name for a board-write attempt
 *   boardKey          — repoRoot → stable path-derived row identity (issue #871)
 *   resolveBoardPath  — vaultDir → `<vaultDir>/01-projects/_active-sessions.md`
 *   collectRows       — per-repo status derivation (readLock + readRegistry)
 *   renderBoard       — pure render: rows[] → full markdown (frontmatter + table)
 *   normalizeUpdated  — stabilise the `updated:` line for byte-equality noop compare
 *   writeBoard        — idempotent write with skip-handwritten / skip-noop / dry-run
 *   mirrorBoard       — thin convenience: config-read + resolve + write (no-ops when vault off)
 *   buildSweepRepos   — pure helper: Candidate[] → sweep repo descriptors (busy ∪ thisRepo)
 *   sweepBoard        — host-wide sweep: enumerateCandidates + mirrorBoard (issue #716)
 *
 * Idempotent merge: writeBoard's caller passes a fully-rendered board, but
 * {@link collectRows} preserves rows for repos NOT in the current update by
 * reading the EXISTING generator-owned board first, so repeated writes are stable.
 * PRESERVED `in-progress` rows are additionally re-derived for TTL staleness
 * (issue #829 Finding 2) inside {@link mirrorBoard} — a preserved row whose
 * heartbeat has aged past {@link DEFAULT_TTL_HOURS} flips to `force-closed`
 * instead of being copied forward unboundedly.
 *
 * CRITICAL SAFETY (Epic #673 #1 risk — never clobber hand-authored vault notes):
 *   1. The `_generator` marker guard refuses any file we did not author.
 *   2. Defense-in-depth: writeBoard hard-refuses to touch `_overview.md`
 *      (sven-owned, must NEVER be written by this generator).
 *
 * No console noise — library code. Plain Node ESM. No external deps.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { emitEvent, sessionAttribution } from '../events.mjs';
import { isLockLive, readLock, DEFAULT_TTL_HOURS } from '../session-lock.mjs';
import { readRegistry, repoPathHash, isRegistryEntryFresh } from '../session-registry.mjs';
import { parseFrontmatter } from '../vault-mirror/utils.mjs';
import { readConfigFile, parseSessionConfig } from '../config.mjs';
import { validatePathInsideProject } from '../path-utils.mjs';
import { enumerateCandidates } from '../dispatcher/enumerate.mjs';
import { atomicWriteWithBackup } from '../io.mjs';
import { withBoardLock } from './board-lock.mjs';
import { expandTilde } from '../common.mjs';

/** Frontmatter sentinel that identifies generator-owned board files. */
export const GENERATOR_MARKER = 'session-orchestrator-active-sessions@1';

/** Placeholder used for noop comparison (replaces the live `updated:` value). */
const UPDATED_PLACEHOLDER = '__UPDATED_PLACEHOLDER__';

/** The four board statuses, in display priority order. */
const STATUS_IN_PROGRESS = 'in-progress';
const STATUS_FORCE_CLOSED = 'force-closed';
const STATUS_CLOSED = 'closed';
const STATUS_FREI = 'frei';

// ── Key normalization ────────────────────────────────────────────────────────────

/**
 * Fold a repo-name key to a case-insensitive form for merge/compare purposes
 * (issue #719). On case-insensitive-preserving filesystems (APFS, the default
 * for macOS Home volumes), `some-repo` and `Some-Repo` are the SAME
 * physical directory — every site that keys rows by `repoName` (prior-status
 * lookup, preserved-row map, merge upsert) must fold through this helper so
 * the two casings collapse to one board row instead of rendering as
 * duplicates. Row OBJECTS are left untouched — {@link renderBoard} still
 * displays the row's original `repo` string (true on-disk casing); only the
 * MAP KEY is folded.
 *
 * @param {string} s
 * @returns {string}
 */
const foldKey = (s) => String(s ?? '').toLowerCase();

/**
 * Rendered length of the path-derived board key (issue #871).
 *
 * BV-004 ceiling: 8 hex chars = 4.29e9 slots. At host scale (the reference host
 * enumerates ~45 repos at the depth-2 default) the birthday collision
 * probability is ~2.3e-7 — far below the failure modes this key REPLACES. It is
 * a prefix, not a truncated identity: the full `repoPathHash` still drives
 * registry matching. REVISIT TRIGGER — if a host ever enumerates >10 000 repos
 * (p(collision) ≈ 1.2e-2 there), widen to 12 and accept that legacy 8-char rows
 * migrate on their next sweep exactly like the 6-column rows do today.
 */
const KEY_LENGTH = 8;

/**
 * Whether the host filesystem is case-insensitive-preserving (issue #719).
 *
 * The board key is derived from a PATH, so on APFS/NTFS `…/Some-Repo` and
 * `…/some-repo` are the same physical directory but two different strings — and
 * would hash to two different keys, re-introducing the duplicate rows #719 fixed
 * at the name layer. Folding the path before hashing keeps that guarantee.
 * Deliberately NOT applied to {@link repoPathHash}'s registry-matching use: that
 * hash must stay byte-identical to what `session-registry.mjs` writes.
 */
const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

/**
 * Derive the stable, path-based board identity for a repo (issue #871).
 *
 * Board rows were keyed by `repoName` (`path.basename(repoRoot)`) until #871.
 * Two repos with the same directory name under different parents — e.g.
 * `<org-a>/<name>` and `<org-b>/<name>`, both enumerable since the depth-2 walk
 * of #832 — folded onto ONE row, and whichever was written second silently
 * overwrote the other's status. A display name is not an identity.
 *
 * @param {string} repoRoot — absolute (or resolvable) repo path.
 * @returns {string|null} `KEY_LENGTH`-char hex prefix, or null for an unusable path.
 */
export function boardKey(repoRoot) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) return null;
  try {
    const resolved = path.resolve(repoRoot);
    return repoPathHash(CASE_INSENSITIVE_FS ? resolved.toLowerCase() : resolved).slice(0, KEY_LENGTH);
  } catch {
    return null;
  }
}

// ── Merge slots (dual-key: path-derived key, legacy display name) ───────────────

/**
 * Merge-slot id for a row that carries a path-derived {@link boardKey}.
 * @param {string} key
 * @returns {string}
 */
const hashSlot = (key) => `h:${key}`;

/**
 * Merge-slot id for a LEGACY (key-less, 6-column) row, folded by display name.
 *
 * This is the migration bridge, not a second identity scheme: a legacy row has
 * no path in it — {@link parseBoardRows} cannot recover one — so its only
 * available handle is the rendered repo name. A freshly-derived row ADOPTS the
 * matching legacy slot (see {@link mirrorBoard}), which converts the row to a
 * keyed one in a single board write.
 *
 * PRECONDITION on "no `n:` slot exists" — the end state is reached per repo
 * ONLY once that repo has been re-derived at least once, and nothing in this
 * module forces that. A repo that stays `frei` is skipped by
 * {@link buildSweepRepos}, the TTL pass rewrites only `status`, and no code
 * path removes a row (`merged` starts as a copy of ALL prior rows; the single
 * `.delete()` in {@link mirrorBoard} is the adoption, not pruning). So a repo
 * that leaves one legacy row behind and is then permanently free — or removed
 * from the host — keeps its `n:` slot indefinitely. Pruning is deliberately NOT
 * implemented here: deleting rows for repos this host can no longer see is a
 * policy decision over an operator-owned file, not a merge detail.
 *
 * BV-004 DELETION TRIGGER (do not delete on vibes, measure): drop `nameSlot`,
 * the `cells.length === 6` branch in {@link parseBoardRows}, and the
 * `priorStatusByRepo` fallback in {@link collectRows} once a host-wide sweep
 * reports ZERO key-less rows for 30 consecutive days —
 * `parseBoardRows(readFileSync(resolveBoardPath(vaultDir), 'utf8'))
 *   .filter((r) => r.key === null).length === 0`. Until that holds, the branch
 * is load-bearing for exactly the boards it still describes.
 *
 * @param {string} repo
 * @returns {string}
 */
const nameSlot = (repo) => `n:${foldKey(repo)}`;

// ── Path helpers ────────────────────────────────────────────────────────────────

/**
 * Resolve the board file path from a vault directory.
 *
 * @param {string} vaultDir — absolute or `~`-prefixed vault root
 * @returns {string} `<vaultDir>/01-projects/_active-sessions.md`
 */
export function resolveBoardPath(vaultDir) {
  return path.join(expandTilde(vaultDir), '01-projects', '_active-sessions.md');
}

// ── Formatting helpers ───────────────────────────────────────────────────────────

/**
 * Format a Date as ISO 8601 (for frontmatter fields).
 * @param {Date} date
 * @returns {string}
 */
function toIso(date) {
  return date.toISOString();
}

/**
 * Format a last-heartbeat ISO string for table display. Returns '—' if absent.
 * Kept verbatim (the ISO string) so operators can diff against lock files.
 *
 * @param {string|null|undefined} iso
 * @returns {string}
 */
function fmtHeartbeat(iso) {
  if (!iso) return '—';
  return String(iso);
}

/**
 * Render a cell value, substituting '—' for empty/absent values and escaping
 * the pipe character so a stray `|` cannot break the markdown table.
 *
 * @param {string|null|undefined} value
 * @returns {string}
 */
function cell(value) {
  if (value === null || value === undefined || value === '') return '—';
  return String(value).replace(/\|/g, '\\|');
}

// ── Row collection (status derivation) ───────────────────────────────────────────

/**
 * Build the rows array from each repo's session.lock + the host-wide registry.
 *
 * Status derivation (this module derives ALL four states itself — no existing
 * code does):
 *   - in-progress  — readLock non-null AND isLockLive(lock) === true.
 *   - force-closed — readLock non-null AND isLockLive(lock) === false (dead
 *                    lease: heartbeat older than ttl). Fields are read straight
 *                    off the raw lock — the dead lock is never silently dropped.
 *   - closed       — explicit per-repo `status: 'closed'` override (session-end
 *                    passes this for the current repo), OR a prior generator-owned
 *                    board row was in-progress/force-closed and there is now no lock.
 *   - frei         — no lock AND no fresh registry entry AND not previously in-progress.
 *
 * branch/mode/semantic-session-id: prefer the lock's, then the matching registry
 * entry. `branch` ONLY exists on the registry entry (the lock has no branch).
 * semantic id = `semantic_session_id ?? session_id`.
 *
 * @param {object} opts
 * @param {Array<{ repoRoot: string, repoName?: string, status?: string }>} opts.repos
 *   Repos to compute rows for. `repoRoot` is an absolute path; `repoName`
 *   defaults to its basename; optional `status: 'closed'` forces a closed row.
 * @param {Date} [opts.now] — clock seam (defaults to new Date()).
 * @param {Array<object>} [opts.registry] — pre-read registry (test seam); defaults
 *   to a fresh {@link readRegistry} call.
 * @param {Map<string, string>} [opts.priorStatusByKey] — {@link boardKey} → prior
 *   board status. The PRIMARY prior-status lookup since #871; consulted before
 *   the name-based map below.
 * @param {Map<string, string>} [opts.priorStatusByRepo] — {@link foldKey}-folded
 *   (case-insensitive) repoName → prior board status, used to derive `closed`
 *   when a once-active repo now has no lock. Callers MUST fold the key with
 *   {@link foldKey} before inserting (issue #719) — this function folds its
 *   own lookup key to match. Since #871 this map is the LEGACY fallback and
 *   callers MUST populate it from key-less (6-column) prior rows ONLY: two
 *   different repos sharing a basename would otherwise bleed one's terminal
 *   status onto the other, which is the very collision #871 fixes.
 *   Consulted only when the folded name has exactly ONE claimant in `repos`
 *   (#1022) — see the ambiguity gate in the body. LIMIT, stated rather than
 *   implied: the census sees only THIS batch, so a lone claimant can still
 *   inherit a legacy row that in truth belonged to a same-named sibling absent
 *   from the batch. That residual is unfixable from a key-less row (it carries
 *   no path) and is bounded to a single migration hop — the row becomes keyed
 *   on that write, and from then on only the authoritative key map applies.
 * @returns {Promise<Array<{ repo: string, key: string|null, status: string,
 *   session: string|null, branch: string|null, mode: string|null,
 *   heartbeat: string|null }>>}
 */
export async function collectRows({ repos, now = new Date(), registry, priorStatusByRepo, priorStatusByKey } = {}) {
  if (!Array.isArray(repos)) {
    throw new TypeError('collectRows: opts.repos must be an array');
  }

  const nowMs = now instanceof Date ? now.getTime() : Date.now();
  const registryEntries = Array.isArray(registry) ? registry : await readRegistry();
  const priorStatus = priorStatusByRepo instanceof Map ? priorStatusByRepo : new Map();
  const priorStatusKeyed = priorStatusByKey instanceof Map ? priorStatusByKey : new Map();

  const rows = [];

  // Normalise the descriptors ONCE. The display name + path key computed here
  // are the same values the derivation loop below uses, so the ambiguity census
  // cannot drift from the lookup it gates (a second, independent derivation of
  // `repoName` would silently mis-census).
  const descriptors = [];
  for (const repo of repos) {
    if (!repo || typeof repo.repoRoot !== 'string' || repo.repoRoot.length === 0) {
      // Skip malformed repo descriptors rather than throwing — one bad entry
      // must not abort the whole board render.
      continue;
    }
    const repoName = typeof repo.repoName === 'string' && repo.repoName.length > 0
      ? repo.repoName
      : path.basename(path.resolve(repo.repoRoot));
    // Path-derived identity (#871). Independent of `repoName`, so two repos
    // sharing a basename get two distinct rows instead of overwriting each other.
    descriptors.push({ repo, repoName, key: boardKey(repo.repoRoot) });
  }

  // Ambiguity census for the LEGACY name fallback (#1022).
  //
  // A key-less prior row carries no path — {@link parseBoardRows} cannot
  // recover one — so its only handle is a display name. When TWO distinct repos
  // in this batch answer to that name, the row provably describes at most one
  // of them and there is no evidence which. Counting the claimants here lets
  // the derivation below withhold the fallback from all of them instead of
  // stamping the terminal status onto every claimant.
  const claimantsByName = new Map();
  for (const d of descriptors) {
    const folded = foldKey(d.repoName);
    let claimants = claimantsByName.get(folded);
    if (!claimants) {
      claimants = new Set();
      claimantsByName.set(folded, claimants);
    }
    // Identity, not object: the same repo listed twice is ONE claimant. Fall
    // back to the raw path when `boardKey` could not derive one.
    claimants.add(d.key ?? `path:${d.repo.repoRoot}`);
  }

  for (const { repo, repoName, key } of descriptors) {
    const lock = readLock({ repoRoot: repo.repoRoot });

    // Match the registry entry for this repo by path hash (branch lives here only).
    let registryEntry;
    try {
      const hash = repoPathHash(repo.repoRoot);
      registryEntry = registryEntries.find((e) => e && e.repo_path_hash === hash) ?? null;
    } catch {
      registryEntry = null;
    }

    // Field resolution: prefer the lock, then the registry entry.
    const semanticFromLock = lock
      ? (lock.semantic_session_id ?? lock.session_id ?? null)
      : null;
    const semanticFromRegistry = registryEntry
      ? (registryEntry.semantic_session_id ?? registryEntry.session_id ?? null)
      : null;
    const session = semanticFromLock ?? semanticFromRegistry ?? null;

    // branch ONLY exists on the registry entry — the lock has no branch field.
    const branch = (registryEntry && registryEntry.branch) ? registryEntry.branch : null;

    const mode = (lock && lock.mode)
      ? lock.mode
      : (registryEntry && registryEntry.mode ? registryEntry.mode : null);

    const heartbeat = lock
      ? (lock.last_heartbeat ?? lock.started_at ?? null)
      : (registryEntry ? (registryEntry.last_heartbeat ?? null) : null);

    // ── Status derivation ──
    let status;
    if (repo.status === STATUS_CLOSED) {
      // Explicit per-repo override (session-end passes 'closed' for current repo).
      status = STATUS_CLOSED;
    } else if (lock && isLockLive(lock, nowMs)) {
      status = STATUS_IN_PROGRESS;
    } else if (lock) {
      // Lock present but dead lease (heartbeat older than ttl).
      status = STATUS_FORCE_CLOSED;
    } else {
      // No live lock. Derive status from the prior board state + registry freshness.
      //
      // Dual lookup (#871): the path-derived key is authoritative; the folded
      // NAME map is only the legacy bridge for prior rows written before the
      // 7-column format (they carry no key, so the name is all there is). The
      // name map holds legacy rows ONLY — see the caller contract on
      // `priorStatusByRepo` — otherwise a same-basename sibling repo would
      // inherit this repo's terminal status. Folded (issue #719) so `Some-Repo`
      // and `some-repo` still resolve to the same legacy entry.
      //
      // AMBIGUITY GATE (#1022): the legacy fallback is withheld entirely when
      // more than one repo in this batch claims the name. On the MIGRATION run
      // — every operator's board is still 6-column, so NO repo has a keyed
      // prior yet — both same-basename repos would otherwise inherit the one
      // legacy row's terminal status, each writing it under its own key. From
      // the next run on that wrong status is keyed and therefore STICKY (a
      // terminal status is never reset without a live lock), so a repo that
      // never had a session would stand `closed` on the board permanently.
      // Awarding the row to the FIRST claimant instead is not a repair: the
      // batch order comes from `enumerateCandidates`' unsorted `readdirSync`
      // walk, which would make a permanent status depend on directory-entry
      // order — and it would still be a coin flip between two repos, one of
      // which never owned that status. Withholding costs at most one migration
      // hop: each claimant is re-derived from its own lock/registry this run
      // and is keyed from here on.
      const nameIsAmbiguous = (claimantsByName.get(foldKey(repoName))?.size ?? 0) > 1;
      const prior = (key !== null ? priorStatusKeyed.get(key) : undefined)
        ?? (nameIsAmbiguous ? undefined : priorStatus.get(foldKey(repoName)));
      if (prior === STATUS_CLOSED || prior === STATUS_FORCE_CLOSED) {
        // Terminal prior state is STICKY absent a live lock. A still-fresh registry
        // entry must NOT resurrect a cleanly-closed (or force-closed) repo to
        // in-progress — only a real lock (handled above) re-asserts in-progress.
        // Without this, a second bare refresh within the registry freshness window
        // (default 15min) of a clean close would wrongly flip `closed` → `in-progress`
        // (#674 review finding).
        status = prior;
      } else if (prior === STATUS_IN_PROGRESS) {
        // Was live, lock now gone → the session ended → closed.
        status = STATUS_CLOSED;
      } else if (registryEntry && isRegistryEntryFresh(registryEntry, { now: nowMs })) {
        // Never-seen repo with a fresh registry heartbeat but the lock momentarily
        // absent — treat as in-progress (the session is heartbeating the registry).
        status = STATUS_IN_PROGRESS;
      } else {
        status = STATUS_FREI;
      }
    }

    rows.push({
      repo: repoName,
      key,
      status,
      session: status === STATUS_FREI ? null : session,
      branch: status === STATUS_FREI ? null : branch,
      mode: status === STATUS_FREI ? null : mode,
      heartbeat: status === STATUS_FREI ? null : heartbeat,
    });
  }

  return rows;
}

// ── Render (pure) ────────────────────────────────────────────────────────────────

/**
 * Render the board markdown from the rows array.
 *
 * Rows are sorted alphabetically by repo name, then by {@link boardKey}, for
 * stable diff-friendly output. The key tiebreak is load-bearing since #871: two
 * repos sharing a basename now render as two ADJACENT rows, and without it their
 * relative order would depend on Map insertion order (i.e. on enumeration order),
 * making the file churn between otherwise-identical writes.
 *
 * Column 7 (`Key`) carries the path-derived identity so the next
 * {@link parseBoardRows} can recover it — the six original columns contain no
 * path, which is exactly why the pre-#871 board could not be re-keyed in place.
 *
 * @param {Array<{ repo: string, key?: string|null, status: string,
 *   session?: string|null, branch?: string|null, mode?: string|null,
 *   heartbeat?: string|null }>} rows
 * @param {{ now: Date, createdIso?: string, updatedPlaceholder?: string }} opts
 * @returns {string} full markdown (frontmatter + table)
 */
export function renderBoard(rows, opts = {}) {
  const { now, createdIso, updatedPlaceholder } = opts;
  const nowDate = now instanceof Date ? now : new Date();

  const nowIso = toIso(nowDate);
  const updatedValue = updatedPlaceholder ?? nowIso;
  const createdValue = createdIso ?? nowIso;

  const sortedRows = [...(Array.isArray(rows) ? rows : [])].sort((a, b) => {
    const byRepo = String(a?.repo ?? '').localeCompare(String(b?.repo ?? ''));
    if (byRepo !== 0) return byRepo;
    return String(a?.key ?? '').localeCompare(String(b?.key ?? ''));
  });

  const lines = [];

  // Frontmatter
  lines.push('---');
  lines.push(`_generator: ${GENERATOR_MARKER}`);
  lines.push('id: active-sessions');
  lines.push('type: board');
  lines.push(`created: ${createdValue}`);
  lines.push(`updated: ${updatedValue}`);
  lines.push('---');
  lines.push('');

  // Title + preamble
  lines.push('# Active Sessions');
  lines.push('');
  lines.push('> Live session-status board. Generator-owned — do not hand-edit.');
  lines.push('');

  // Board table
  lines.push('| Repo | Status | Session | Branch | Mode | Last heartbeat | Key |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const row of sortedRows) {
    lines.push(
      `| ${cell(row?.repo)} | ${cell(row?.status)} | ${cell(row?.session)} | ` +
      `${cell(row?.branch)} | ${cell(row?.mode)} | ${cell(fmtHeartbeat(row?.heartbeat))} | ` +
      `${cell(row?.key)} |`,
    );
  }
  lines.push('');

  return lines.join('\n');
}

// ── Write (idempotent) ───────────────────────────────────────────────────────────

/**
 * Normalize a markdown string by replacing the `updated:` frontmatter line with
 * a stable placeholder, enabling byte-for-byte noop comparison.
 *
 * @param {string} content
 * @returns {string}
 */
export function normalizeUpdated(content) {
  return String(content ?? '').replace(/^(updated:\s*)(.+)$/m, `$1${UPDATED_PLACEHOLDER}`);
}

/**
 * Parse a generator-owned board's table back into row objects. Used by the
 * idempotent-merge path in {@link mirrorBoard} to recover prior per-repo rows
 * (status carry-over + row preservation for repos not in the current update).
 *
 * Tolerant by design: skips the header + separator rows, ignores any line that
 * is not a 6- or 7-column table row, and maps the literal '—' placeholder back
 * to null. Unescapes the `\|` pipe-escaping applied by {@link renderBoard}.
 *
 * SIX **or** seven columns (#871): the pre-#871 board rendered 6. A hard
 * `length !== 7` filter would silently DROP every row on an operator's existing
 * board on the first run after upgrade — the board would appear to reset. A
 * 6-column row parses as a LEGACY row with `key: null`; {@link mirrorBoard}
 * adopts it into a keyed row the next time that repo is actually derived.
 *
 * @param {string} content — full board markdown
 * @returns {Array<{ repo: string, key: string|null, status: string,
 *   session: string|null, branch: string|null, mode: string|null,
 *   heartbeat: string|null }>}
 */
export function parseBoardRows(content) {
  const rows = [];
  const text = String(content ?? '');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('|')) continue;
    // Split on unescaped pipes, drop the leading/trailing empty fields.
    const cells = line
      .split(/(?<!\\)\|/)
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length !== 6 && cells.length !== 7) continue;
    // Skip the header row and the |---|---| separator row.
    if (cells[0] === 'Repo' || /^-+$/.test(cells[0])) continue;
    const unesc = (v) => (v === '—' ? null : v.replace(/\\\|/g, '|'));
    const repo = unesc(cells[0]);
    if (repo === null) continue;
    rows.push({
      repo,
      key: cells.length === 7 ? unesc(cells[6]) : null,
      status: cells[1],
      session: unesc(cells[2]),
      branch: unesc(cells[3]),
      mode: unesc(cells[4]),
      heartbeat: unesc(cells[5]),
    });
  }
  return rows;
}

/**
 * Write the board file with idempotency + safety guards.
 *
 * Guard order:
 *   1. dryRun → { action: 'dry-run' } (never touches disk).
 *   2. SAFETY (Epic #673 #1 risk): basename === '_overview.md' →
 *      { action: 'skipped-handwritten' }. `_overview.md` is sven-owned and must
 *      NEVER be written by this generator, regardless of any marker.
 *   3. file exists → parseFrontmatter:
 *        - !fm || !fm._generator                  → skipped-handwritten
 *        - fm._generator !== GENERATOR_MARKER      → skipped-handwritten
 *        - normalizeUpdated(existing) === new      → skipped-noop
 *   4. else → {@link atomicWriteWithBackup} (mkdir -p + tmp + rename) → written.
 *      A failed write returns `skipped-write-failed` rather than throwing: a
 *      board update is best-effort telemetry and must never abort a session
 *      phase (mirrors {@link sweepBoard}'s degrade-don't-throw contract).
 *
 * @param {{
 *   outputPath: string,
 *   content: string,
 *   dryRun?: boolean,
 *   fs?: { readFileSync?: Function, writeFileSync?: Function, mkdirSync?: Function,
 *          existsSync?: Function, renameSync?: Function, copyFileSync?: Function },
 * }} opts — an injected `fs` MUST provide `renameSync` alongside `writeFileSync`
 *   since #734c; a stub that mocks the write but not the rename would otherwise
 *   have the real `renameSync` look for a tmp file the stub never created.
 *   `copyFileSync` is pass-through only (forwarded to {@link atomicWriteWithBackup},
 *   never called here) and stays optional while this call site pins `backup: false`.
 * @returns {{ action: 'written'|'skipped-handwritten'|'skipped-noop'|'dry-run'
 *   |'skipped-write-failed', path: string, error?: string }}
 */
export function writeBoard(opts) {
  const { outputPath, content, dryRun = false, fs: injectedFs } = opts;

  const fsReadFile = injectedFs?.readFileSync ?? readFileSync;
  const fsWriteFile = injectedFs?.writeFileSync ?? writeFileSync;
  const fsMkdir = injectedFs?.mkdirSync ?? mkdirSync;
  const fsExists = injectedFs?.existsSync ?? existsSync;

  // 1. Dry-run: never write.
  if (dryRun) {
    return { action: 'dry-run', path: outputPath };
  }

  // 2. SAFETY (Epic #673 #1 risk): _overview.md is sven-owned — NEVER write it.
  if (path.basename(outputPath) === '_overview.md') {
    return { action: 'skipped-handwritten', path: outputPath };
  }

  // 3. Existing-file guards.
  if (fsExists(outputPath)) {
    let existingContent;
    try {
      existingContent = fsReadFile(outputPath, 'utf8');
    } catch {
      existingContent = null;
    }

    if (existingContent !== null && existingContent !== undefined) {
      const fm = parseFrontmatter(existingContent);

      // Skip-on-manual-edit: no _generator, or a different generator.
      if (!fm || !fm['_generator']) {
        return { action: 'skipped-handwritten', path: outputPath };
      }
      if (fm['_generator'] !== GENERATOR_MARKER) {
        return { action: 'skipped-handwritten', path: outputPath };
      }

      // Skip-noop: identical modulo the live `updated:` timestamp.
      if (normalizeUpdated(existingContent) === normalizeUpdated(content)) {
        return { action: 'skipped-noop', path: outputPath };
      }
    }
  }

  // 4. Write — atomically (issue #734c).
  //
  // The board is a file the operator reads WHILE sessions write it. A plain
  // writeFileSync truncates in place, so a crash (or a reader arriving between
  // truncate and flush) can surface a half-board. tmp+rename removes that
  // window; the tmp file is a sibling, so the rename stays same-filesystem.
  //
  // `backup: false` on purpose: the board is 100% re-derivable from the per-repo
  // locks plus the host registry (that is what `sweepBoard` does on every
  // session-start), so a `.bak-<ISO>` sidecar would buy nothing — and it would
  // drop generator litter into the operator's `01-projects/` vault directory,
  // which is precisely the surface the `_overview.md` refusal above protects.
  //
  // `copyFileSync` is forwarded even though `backup: false` makes it inert
  // today: {@link atomicWriteWithBackup} falls back to the REAL `node:fs` per
  // MISSING method, so a 4-of-5 adapter would silently route the backup copy
  // to the real filesystem the moment anyone flips `backup` — a test that
  // believes itself hermetic would drop `.bak-<ISO>` files into the repo.
  // Forwarding the fifth method keeps the adapter total over io.mjs's
  // injectable surface.
  const result = atomicWriteWithBackup(outputPath, content, {
    tmpPrefix: '.active-sessions',
    fs: {
      mkdirSync: fsMkdir,
      writeFileSync: fsWriteFile,
      existsSync: fsExists,
      renameSync: injectedFs?.renameSync,
      copyFileSync: injectedFs?.copyFileSync,
    },
  });
  if (!result.ok) {
    return { action: 'skipped-write-failed', path: outputPath, error: result.error };
  }
  return { action: 'written', path: outputPath };
}

// ── Telemetry ────────────────────────────────────────────────────────────────────

/**
 * Canonical event name for a board-write attempt.
 *
 * ONE event per {@link mirrorBoard} call — including every no-op path. The
 * no-op paths are the point: a vault-disabled config, a hand-edited board, or a
 * failed write returned silently before this existed, so an outage of this
 * writer was indistinguishable from a healthy skip. Measured 2026-08-23 over
 * 28 387 ledger records: ZERO board/mirror events, because this module did not
 * import {@link emitEvent} at all.
 */
export const BOARD_EVENT = 'orchestrator.vault.board_written';

/**
 * Emit the board-write telemetry record. Best-effort: never throws, never
 * alters the board result.
 *
 * ABSENT IS NOT ZERO (`docs/events-schema.md`): every optional field is spread
 * conditionally, so an UNMEASURED field is missing from the record rather than
 * written as `0`. A present `repos_swept: 0` therefore means "enumeration ran
 * and surfaced nothing" (the documented silent-enumeration failure mode), while
 * an absent `repos_swept` means "not a sweep, or enumeration threw" — reading
 * the missing key as `0` would conflate the two in both directions.
 *
 * @param {object} opts
 * @param {string} [opts.repoRoot] — pins the ledger to THIS repo's
 *   `.orchestrator/metrics/events.jsonl` (#941). Omitted only when the caller
 *   supplied no usable root, where `SO_PROJECT_DIR` is the sole destination left.
 * @param {'sweepBoard'|'mirrorBoard'} opts.caller — which entry point ran.
 * @param {string} opts.action — the `action` the board write returned.
 * @param {string} [opts.path] — resolved board path, when one was resolved.
 * @param {number} [opts.rows] — rows in the board content THIS call rendered.
 *   Present whenever the render was reached (so also on `skipped-noop` /
 *   `dry-run`, where the content was built but not written — `action` is what
 *   says whether it landed); absent on the early no-op paths that never render.
 * @param {number} [opts.reposSwept] — candidates {@link enumerateCandidates}
 *   returned, on the {@link sweepBoard} path only.
 * @param {number} [opts.durationMs]
 * @param {{ locked: boolean, reason?: string, stale_override?: string, waited_ms: number }} [opts.lock]
 *   — board-lock outcome, present only when the lock was actually attempted
 *   (i.e. not on the early no-op guards, not on dry-run). Never carries the lock
 *   PATH — that is a `$HOME`-rooted string, the CP1 shape this payload keeps out.
 * @returns {Promise<void>}
 */
/**
 * Reduce an absolute vault path to its LAST TWO segments for telemetry.
 *
 * The full path is the module's public return contract and stays untouched.
 * What must not travel is the path in the EMITTED payload: on a real host it
 * reads `/Users/<name>/Projects/<vault>/01-projects/<private-slug>/…`, i.e. an
 * OS username plus a private project slug. Those are exactly the two shapes
 * `scripts/lib/validate/check-owner-leakage.mjs` blocks as CP1 and CP6 — and
 * that scanner structurally cannot see this one, because it walks `git ls-files`
 * and `.orchestrator/metrics/*.jsonl` is gitignored (`.gitignore:40`).
 * The record is invisible to the pre-commit guard and visible to the optional
 * Clank webhook (`scripts/lib/events.mjs`, `CLANK_EVENT_URL`), which posts the
 * payload verbatim with no redaction.
 *
 * The BASENAME is the deliberate ceiling — one segment, not two. Two segments
 * would keep the parent directory, and under `01-projects/` that directory IS
 * the private project slug, i.e. exactly the CP6 shape this is meant to drop.
 * The diagnostic value lives in the filename alone: it says WHICH writer ran
 * (`_session-narrative.md` vs `_active-sessions.md`), which is the question the
 * event exists to answer. Which project it was is already answerable from the
 * record's own `session_id` / repo-scoped ledger location.
 * Revisit trigger: a consumer that needs more than the filename — then it
 * belongs in the RETURN value, which already carries the absolute path, never
 * in the event.
 *
 * @param {unknown} outputPath
 * @returns {string|undefined} `undefined` when there is nothing measured to report.
 */
function telemetrySafePath(outputPath) {
  if (typeof outputPath !== 'string' || outputPath.length === 0) return undefined;
  const base = path.basename(outputPath);
  return base.length > 0 ? base : undefined;
}

async function emitBoardEvent({ repoRoot, caller, action, path: outputPath, rows, reposSwept, durationMs, lock }) {
  // Refuse the SO_PROJECT_DIR fallback instead of guessing a destination.
  // Without an explicit repoRoot, `emitEvent` resolves `eventsFilePath(undefined)`
  // and writes into whatever tree the ambient env points at — so `mirrorBoard()`
  // called with no argument used to append a record to an UNRELATED repo's ledger.
  // Measured 2026-08-23: a review agent reproduced it and put a second, byte-identical
  // record into this repo's live events.jsonl doing so. Two sibling emitters in the
  // same commit arc already refuse it (`express-path.mjs` with a WARN,
  // `narrative-mirror.mjs` silently); this one was the odd one out, and it was the
  // unsafe one. A stderr WARN, not silence: a telemetry record that goes missing
  // should say so, or it becomes the very blind spot this event was added to close.
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    process.stderr.write(
      `[board-writer] ${BOARD_EVENT} not emitted: no repoRoot given, and the ambient ` +
        `SO_PROJECT_DIR fallback would write to an unrelated repo's ledger.\n`,
    );
    return;
  }
  try {
    await emitEvent(
      BOARD_EVENT,
      {
        action,
        caller,
        ...(telemetrySafePath(outputPath) !== undefined ? { path_tail: telemetrySafePath(outputPath) } : {}),
        // Number.isFinite — NOT truthiness — is what keeps a MEASURED zero in
        // the record (`repos_swept: 0` = "enumeration ran, found nothing") while
        // still omitting an unmeasured field. `x || undefined` would silently
        // delete exactly the zero the field exists to report. (`!= null` is the
        // idiom elsewhere but this repo's eqeqeq rule forbids it.)
        ...(Number.isFinite(rows) ? { rows } : {}),
        ...(Number.isFinite(reposSwept) ? { repos_swept: reposSwept } : {}),
        ...(Number.isFinite(durationMs) ? { duration_ms: durationMs } : {}),
        // Lock diagnostics (absent on every path that never took the lock: the
        // early no-op guards and dry-run). `lock.locked === false` marks a
        // fail-open unlocked write; `lock.stale_override` marks an acquire that
        // aged out someone else's lock — the observable behind board-lock's
        // DEFAULT_STALE_MS revisit trigger.
        ...(lock && typeof lock === 'object' ? { lock } : {}),
        // #1147: join key parity with the sibling `narrative_mirrored` event,
        // which has carried attribution since #1073. Without it a board record
        // cannot be joined to the session that wrote it. Both keys are OMITTED
        // (never fabricated) when no session.lock is readable at `repoRoot` —
        // and `repoRoot` is the SAME root the ledger line is pinned to below,
        // so the attribution can never name a different tree than the record.
        ...sessionAttribution(repoRoot),
      },
      { repoRoot },
    );
  } catch {
    /* Best-effort telemetry. emitEvent does real file I/O (mkdir + append), so a
       read-only or occupied ledger path WILL throw — and a broken ledger must
       never fail a board write. The board result is authoritative. */
  }
}

// ── Convenience: config-read + resolve + write ───────────────────────────────────

/**
 * Thin convenience that reads Session Config, resolves the vault board path,
 * collects rows, renders, and writes. Silently no-ops when vault-integration is
 * disabled or vault-dir is absent — returns `{ action: 'skipped-vault-disabled' }`.
 *
 * The caller (session-start / session-end) typically owns the higher-level
 * decision and may call {@link collectRows} + {@link renderBoard} + {@link writeBoard}
 * directly; this helper exists for the common single-repo update path.
 *
 * Vault path assertion (Epic #673 safety): the resolved vault dir MUST live
 * under $HOME — a vault outside the home tree is refused as `skipped-vault-disabled`
 * so a misconfigured path can never drive a write into an arbitrary location.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot — the repo whose row is being updated.
 * @param {Array<{ repoRoot: string, repoName?: string, status?: string }>} [opts.repos]
 *   Full repo list; defaults to a single-repo descriptor
 *   `[{ repoRoot, status: explicitStatus }]`. Whichever entry resolves to
 *   `repoRoot` — in the caller-supplied list as well as in the default — gets
 *   its `repoName` filled from Session Config `vault-integration.vault-name`
 *   (#660) unless it already carries one; entries for other repos are never
 *   touched. With no `vault-name` configured, {@link collectRows} falls back to
 *   `path.basename(repoRoot)` as before.
 * @param {string} [opts.explicitStatus] — per-repo status override ('closed' from session-end).
 * @param {Date} [opts.now]
 * @param {boolean} [opts.dryRun]
 * @param {object} [opts.fs] — injectable fs for tests.
 * @param {{ env?: Record<string, string|undefined>, ownerConfig?: object }} [opts.hostPaths]
 *   — forwarded verbatim to {@link parseSessionConfig}'s `hostPaths` DI seam (issue #653).
 *   Tests MUST pass a hermetic ctx (e.g. `{ env: {}, ownerConfig: undefined }`) when
 *   asserting a fixture's committed `vault-dir` — omitting it reads the REAL host
 *   `owner.yaml`, whose `paths.vault-dir` override (if set) wins over the fixture value
 *   and bleeds into the assertion (issue #783). Production callers omit this — the
 *   default (real owner.yaml resolution) is the correct host-local behavior there.
 * @returns {Promise<{ result: { action: string, path?: string }, rows?: number,
 *   lock?: { locked: boolean, reason?: string, stale_override?: string, waited_ms: number } }>}
 *   `lock` is present only on the locked path (absent on the early no-op guards
 *   and on dry-run, which deliberately takes no lock).
 *   `rows` is present only once the render was reached — see
 *   {@link emitBoardEvent}'s `rows` contract. The public {@link mirrorBoard}
 *   wrapper unwraps `result` so the caller-visible return shape is unchanged.
 */
async function mirrorBoardInner({ repoRoot, repos, explicitStatus, now = new Date(), dryRun = false, fs, hostPaths } = {}) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    return { result: { action: 'skipped-vault-disabled' } };
  }

  // Read + parse Session Config. Any failure → silent no-op.
  let config;
  try {
    const text = await readConfigFile(repoRoot);
    config = parseSessionConfig(text, { hostPaths });
  } catch {
    return { result: { action: 'skipped-vault-disabled' } };
  }

  const vault = config?.['vault-integration'];
  if (!vault || vault.enabled !== true) {
    return { result: { action: 'skipped-vault-disabled' } };
  }
  const vaultDir = vault['vault-dir'];
  if (typeof vaultDir !== 'string' || vaultDir.length === 0) {
    return { result: { action: 'skipped-vault-disabled' } };
  }

  // Safety: the resolved vault dir must live under $HOME.
  const expandedVault = expandTilde(vaultDir);
  const home = os.homedir();
  const inHome = validatePathInsideProject(expandedVault, home);
  if (!inHome.ok) {
    return { result: { action: 'skipped-vault-disabled' } };
  }

  // `vault-name` (#660) overrides the git-derived repo slug for per-project
  // vault namespacing. Without it `collectRows` falls back to
  // `path.basename(repoRoot)`, so a repo whose directory name differs from its
  // configured vault name renders under the wrong board row.
  //
  // The override is applied during descriptor NORMALISATION, not descriptor
  // CONSTRUCTION (#835). Applying it only to the fallback single-repo
  // descriptor made it inert on the primary production path: `sweepBoard`
  // (session-start Phase 1.7) ALWAYS passes a non-empty `repos` — see
  // {@link buildSweepRepos}, which unconditionally appends `thisRepoRoot` and
  // emits bare `{ repoRoot }` entries with NO `repoName`. So session-start
  // keyed the row `foldKey(path.basename(repoRoot))` while session-end (which
  // calls this function WITHOUT `repos`) keyed it `foldKey(vault-name)`. The
  // merge key is `repoName`, so the close never updated the in-progress row:
  // a duplicate row plus a permanently stale `in-progress` status.
  //
  // Scope: ONLY the entry whose `repoRoot` resolves to THIS repo's root is
  // touched. Entries for FOREIGN repos are left alone — a foreign repo's
  // `vault-name` lives in ITS own Session Config, which this function does not
  // read; stamping our override onto it would mislabel someone else's row. An
  // entry that already carries an explicit non-empty `repoName` also wins, so
  // a caller can still name its own row deliberately (#832 contract).
  const vaultName = vault['vault-name'];
  const repoNameOverride = typeof vaultName === 'string' && vaultName.length > 0
    ? vaultName
    : undefined;

  const baseRepoList = Array.isArray(repos) && repos.length > 0
    ? repos
    : [{ repoRoot, status: explicitStatus }];

  const repoList = repoNameOverride === undefined
    ? baseRepoList
    : baseRepoList.map((entry) => {
        if (!entry || typeof entry.repoRoot !== 'string' || entry.repoRoot.length === 0) return entry;
        if (typeof entry.repoName === 'string' && entry.repoName.length > 0) return entry;
        let isSelf;
        try {
          isSelf = path.resolve(entry.repoRoot) === path.resolve(repoRoot);
        } catch {
          isSelf = false;
        }
        return isSelf ? { ...entry, repoName: repoNameOverride } : entry;
      });

  const outputPath = resolveBoardPath(vaultDir);

  // Everything below — the two reads of the existing board, the merge, and the
  // write — is ONE read-modify-write over a file shared by every repo on the
  // host (issue #1180). Serialise it on the vault-scoped board lock so a
  // concurrent sweepBoard() from another repo cannot compute its merge from a
  // base we are about to replace. Fail-open: withBoardLock runs the closure
  // unlocked (with a WARN) rather than let a contended lock abort the phase.
  const mergeAndWrite = async () => {
    // Read the EXISTING generator-owned board (if any) to:
    //   1. preserve its `created:` — otherwise every render differs on `created:`
    //      and the noop-skip in writeBoard would never fire.
    //   2. recover the prior per-repo status — drives the `closed` derivation for
    //      repos NOT in this update (idempotent merge: their rows are re-derived).
    // Both maps are keyed by {@link foldKey}(repo) — case-insensitively folded
    // (issue #719) — so two prior rows differing only by case (e.g.
    // `some-repo` vs `Some-Repo`, the same physical directory on a
    // case-insensitive-preserving filesystem like APFS) collapse to ONE entry
    // instead of coexisting as duplicates. The row OBJECTS keep their original
    // `repo` string untouched, so `renderBoard` still displays true casing.
    const fsReadFile = fs?.readFileSync ?? readFileSync;
    const fsExists = fs?.existsSync ?? existsSync;
    let createdIso;
    const priorStatusByRepo = new Map();   // LEGACY rows only — see collectRows contract
    const priorStatusByKey = new Map();    // boardKey → status (authoritative since #871)
    const preservedRows = new Map(); // merge slot (see hashSlot/nameSlot) → prior row
    if (fsExists(outputPath)) {
      let existing;
      try {
        existing = fsReadFile(outputPath, 'utf8');
      } catch {
        existing = null;
      }
      if (existing) {
        const fm = parseFrontmatter(existing);
        if (fm && fm['_generator'] === GENERATOR_MARKER) {
          if (fm['created']) createdIso = fm['created'];
          for (const prior of parseBoardRows(existing)) {
            // Dual-key slotting (#871): a keyed row owns its own hash slot; a
            // legacy (6-column) row falls back to its folded display name. Two
            // keyed rows can only collide when they resolve to the SAME path, so
            // the heartbeat-preference resolution below is now reached almost
            // exclusively by legacy rows — which is precisely the case it was
            // written for (#719).
            const key = prior.key ? hashSlot(prior.key) : nameSlot(prior.repo);
            const collidingPrior = preservedRows.get(key);
            if (collidingPrior) {
              // Collision WITHIN parseBoardRows output — two prior rows fold to
              // the same key with no fresh row in play yet (that upsert happens
              // below). Prefer the row with the most-recent `heartbeat` rather
              // than silently last-in-file-order. Guard: if either heartbeat is
              // unparsable, fall through to last-written-wins (the pre-#719
              // default) by NOT skipping the overwrite below.
              const collidingTs = Date.parse(collidingPrior.heartbeat ?? '');
              const priorTs = Date.parse(prior.heartbeat ?? '');
              if (Number.isFinite(collidingTs) && Number.isFinite(priorTs) && collidingTs > priorTs) {
                // The already-preserved row is strictly newer — keep it, skip
                // this older colliding row entirely.
                continue;
              }
            }
            if (prior.key) {
              priorStatusByKey.set(prior.key, prior.status);
            } else {
              // LEGACY rows only. Seeding this map from keyed rows too would let
              // repo B (never seen, same basename) inherit repo A's terminal
              // status through the name fallback in collectRows — reintroducing
              // the identity collision #871 exists to remove, one layer down.
              priorStatusByRepo.set(foldKey(prior.repo), prior.status);
            }
            preservedRows.set(key, prior);
          }
        }
      }
    }

    const rows = await collectRows({ repos: repoList, now, priorStatusByRepo, priorStatusByKey });

    // TTL-staleness re-derivation for PRESERVED rows (issue #829 Finding 2).
    // Without this pass, a preserved `in-progress` row (a repo NOT in this
    // update) is copied forward FOREVER — a crashed/never-closed session's row
    // never flips even after its heartbeat has aged well past the lock's TTL,
    // because `collectRows` only re-derives status for repos actually IN
    // `repoList`. Re-derive staleness for every preserved row here, BEFORE the
    // freshly-derived `rows` are upserted over it below (fresh data always
    // wins regardless of this pass — a live lock or an explicit-closed update
    // always takes precedence over the TTL flip).
    //
    // Board rows carry only a raw `heartbeat` string, never the lock's own
    // `ttl_hours` (that field is not part of the rendered board) — so this
    // reuses the shared {@link DEFAULT_TTL_HOURS} constant rather than the
    // per-lock TTL {@link isLockLive} uses when a live lock object is in hand.
    // Rows with an unparseable/absent heartbeat are left UNCHANGED (fail-open,
    // never crash on a malformed prior board).
    const nowMs = now instanceof Date ? now.getTime() : Date.now();
    const ttlMs = DEFAULT_TTL_HOURS * 3600 * 1000;
    const staleRederivedRows = new Map();
    for (const [key, row] of preservedRows) {
      if (row.status === STATUS_IN_PROGRESS) {
        const heartbeatMs = Date.parse(row.heartbeat ?? '');
        if (Number.isFinite(heartbeatMs) && (nowMs - heartbeatMs) >= ttlMs) {
          staleRederivedRows.set(key, { ...row, status: STATUS_FORCE_CLOSED });
          continue;
        }
      }
      staleRederivedRows.set(key, row);
    }

    // Idempotent merge: keep prior (TTL-rederived) rows for repos NOT in this
    // update, then upsert the freshly-derived rows over them so repeated writes
    // stay stable. A freshly-derived row ALWAYS wins over a preserved row in the
    // same slot — that is what collapses a live row over a stale preserved one.
    //
    // Dual-key upsert (#871). A naive switch from the folded name to the path
    // key would make the two key spaces DISJOINT: the fresh row would never
    // overwrite the legacy row, the legacy row would become immortal (the sweep
    // skips `frei` candidates and the TTL pass only rewrites `status`, never
    // removes a row), and the board would grow a permanent duplicate per repo.
    // So a fresh row first claims its hash slot; if that slot is new, it ADOPTS
    // the legacy name slot for the same folded name — one board write converts
    // the row, and the migration is complete for that repo.
    const merged = new Map(staleRederivedRows);
    for (const row of rows) {
      const slot = row.key ? hashSlot(row.key) : nameSlot(row.repo);
      if (row.key && !merged.has(slot)) {
        // First keyed write for this repo — take over its legacy row rather than
        // rendering a second one beside it.
        merged.delete(nameSlot(row.repo));
      }
      merged.set(slot, row);
    }

    const content = renderBoard([...merged.values()], { now, createdIso });

    return { result: writeBoard({ outputPath, content, dryRun, fs }), rows: merged.size };
  };

  // dry-run never touches disk (writeBoard guard 1) — so it must not create a
  // lock file in the operator's vault either. Nothing to serialise.
  if (dryRun) return await mergeAndWrite();

  // The lock outcome is diagnostic, and until now it went nowhere: `withBoardLock`
  // has exposed `onLockOutcome` since #1180, and NO production caller passed one
  // (measured 2026-09-02: `grep -rn onLockOutcome scripts hooks` → board-lock.mjs
  // and its test, nothing else). So the two states that silently weaken the mutex —
  // a fail-open unlocked write, and a stale-override that can override a LIVE
  // writer (see board-lock's DEFAULT_STALE_MS § CEILING) — were unobservable in
  // aggregate, which is exactly what the revisit trigger needs. Capture it here and
  // ride it out on the ONE board_written event rather than adding a second event.
  let lockOutcome;
  const acquireStartedAt = Date.now();
  const inner = await withBoardLock(expandedVault, mergeAndWrite, {
    onLockOutcome: (o) => {
      // Called exactly once, strictly BEFORE `fn` — so the elapsed time is the
      // acquire wait, not the merge. `lockPath` is deliberately DROPPED: it is
      // `<vault>/.orchestrator/board.lock` under $HOME, i.e. the CP1 (OS username)
      // shape `telemetrySafePath` exists to keep out of the payload.
      lockOutcome = {
        locked: o?.locked === true,
        ...(typeof o?.reason === 'string' ? { reason: o.reason } : {}),
        ...(typeof o?.staleOverride === 'string' ? { stale_override: o.staleOverride } : {}),
        waited_ms: Date.now() - acquireStartedAt,
      };
    },
  });

  return lockOutcome === undefined ? inner : { ...inner, lock: lockOutcome };
}

/**
 * Public {@link mirrorBoardInner} wrapper that emits exactly ONE
 * {@link BOARD_EVENT} per call — on EVERY path, no-ops included.
 *
 * The wrapper exists so the emit cannot be forgotten: the six return points
 * inside {@link mirrorBoardInner} (five `skipped-vault-disabled` guards plus
 * whatever {@link writeBoard} decides) all funnel through here, and so does the
 * seventh someone adds next. Emitting per-return instead would leave each new
 * early return silent by default — which is the exact defect being fixed.
 *
 * A THROW from the inner function is deliberately NOT converted into an event:
 * `action` is mandatory in the payload and a throw has no action the code knows,
 * so inventing one would put a fictional state in the ledger. The throw is not
 * silent either — it propagates to the caller, and on the {@link sweepBoard}
 * path the fallback write emits its own record.
 *
 * Return shape is byte-identical to the pre-telemetry contract.
 *
 * @param {Parameters<typeof mirrorBoardInner>[0] & {
 *   caller?: 'sweepBoard'|'mirrorBoard', reposSwept?: number }} [opts]
 *   — full parameter contract (`repoRoot`, `repos`, `explicitStatus`, `now`,
 *   `dryRun`, `fs`, `hostPaths`) is documented on {@link mirrorBoardInner}.
 *   `caller` / `reposSwept` are telemetry attribution only and never reach the
 *   board content. `caller` defaults to `'mirrorBoard'`; {@link sweepBoard}
 *   overrides it so the two entry points stay separable in the ledger.
 * @returns {Promise<{ action: string, path?: string }>}
 */
export async function mirrorBoard(opts = {}) {
  const startedAt = Date.now();
  // Destructured directly (not via `opts ?? {}`) so a `null` argument still
  // throws exactly as it did before this wrapper existed.
  const { repoRoot, caller = 'mirrorBoard', reposSwept } = opts;

  const { result, rows, lock } = await mirrorBoardInner(opts);

  await emitBoardEvent({
    repoRoot,
    caller,
    action: result?.action,
    path: result?.path,
    rows,
    reposSwept,
    durationMs: Date.now() - startedAt,
    lock,
  });

  return result;
}

// ── Host-wide sweep (issue #716) ─────────────────────────────────────────────────

/**
 * Pure helper: reduce an {@link enumerateCandidates} result down to the sweep
 * repo descriptors {@link mirrorBoard} expects — every BUSY candidate
 * (`free === false`, i.e. `in-progress` or `force-closed`), unioned with the
 * calling repo (`thisRepoRoot`) so its own row is always re-derived even when
 * `enumerateCandidates` did not surface it (e.g. `thisRepoRoot` sits outside
 * `startDir`'s confinement root).
 *
 * Free (`frei`) candidates are intentionally EXCLUDED — re-deriving them would
 * add board noise for repos with nothing to report; their prior rows (if any)
 * are preserved by {@link mirrorBoard}'s idempotent merge.
 *
 * Pure — no fs access, no I/O. Dedupe is by `path.resolve()` so a candidate
 * already covering `thisRepoRoot` is not duplicated.
 *
 * @param {import('../dispatcher/enumerate.mjs').Candidate[]} candidates
 * @param {{ thisRepoRoot: string }} opts
 * @returns {Array<{ repoRoot: string }>}
 */
export function buildSweepRepos(candidates, { thisRepoRoot } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const seen = new Set();
  const repos = [];

  for (const candidate of list) {
    if (!candidate || candidate.free !== false) continue;
    if (typeof candidate.repoRoot !== 'string' || candidate.repoRoot.length === 0) continue;
    const resolved = path.resolve(candidate.repoRoot);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    repos.push({ repoRoot: candidate.repoRoot });
  }

  if (typeof thisRepoRoot === 'string' && thisRepoRoot.length > 0) {
    const resolvedThis = path.resolve(thisRepoRoot);
    if (!seen.has(resolvedThis)) {
      seen.add(resolvedThis);
      repos.push({ repoRoot: thisRepoRoot });
    }
  }

  return repos;
}

/**
 * Host-wide vault-board staleness sweep (issue #716). Extends {@link mirrorBoard}'s
 * single-repo re-derivation to every BUSY repo on the host, so a crashed session
 * in repo A renders as `force-closed` on the board from any repo B's
 * session-start — not only from repo A's own next session-start/-end.
 *
 * Composition: {@link enumerateCandidates}(startDir) → {@link buildSweepRepos}
 * (busy ∪ thisRepo) → {@link mirrorBoard}(repos).
 *
 * Notes:
 *   (a) THIS repo's `in-progress` row is rendered from ITS OWN live
 *       `session.lock` lease via {@link collectRows} — NOT via `explicitStatus`
 *       (that field is inert for `'in-progress'`; `collectRows` only honors an
 *       explicit `status: 'closed'` override). The lease is the one Phase 1.2
 *       writes/heartbeats for the calling session.
 *   (b) `frei` (lock-less) repos are excluded from re-derivation to avoid board
 *       noise — see {@link buildSweepRepos}. Prior rows of un-swept repos
 *       (busy-but-not-enumerated, or genuinely frei) are preserved by
 *       {@link mirrorBoard}'s idempotent merge, never dropped.
 *   (c) The enumerate + collectRows path is synchronous fs (readdirSync /
 *       existsSync / readLock per candidate) — O(repos) small reads, single-digit
 *       ms at host scale (45 repos, ~0.9-1.9ms warm measured 2026-07-19 at the
 *       default walk depth of 2; pre-#832's depth-1 scan saw only 1 of 47). No
 *       timeout is applied: a sync call cannot be preempted in-process, so a
 *       timeout would only convert a slow sweep into a thrown error, not a
 *       faster one.
 *   (d) Merge key is the path-derived {@link boardKey} (issue #871), with a
 *       one-shot fallback to the case-insensitively folded `repoName` for LEGACY
 *       6-column rows (issue #719) — two rows differing only by case (e.g.
 *       `some-repo` vs `Some-Repo`, the same physical directory on a
 *       case-insensitive-preserving filesystem like APFS) now collapse to ONE
 *       board row instead of rendering as duplicates. The survivor is whichever
 *       row is live/newest: a freshly-derived row (this sweep's own
 *       `collectRows` output) always wins over a preserved stale row; among two
 *       PRESERVED rows colliding on the folded key, the more-recent `heartbeat`
 *       wins (see the collision-resolution loop inside {@link mirrorBoard}).
 *       Two GENUINELY different, differently-rooted repos sharing a basename
 *       no longer collapse (#871, the follow-up #832 named): the merge key is
 *       the path-derived {@link boardKey}, so `<org-a>/<name>` and
 *       `<org-b>/<name>` render as two rows. The depth-2 walk (#832) is what
 *       made both enumerable and turned the old basename key into silent
 *       cross-repo status loss — two such collisions were measured on the
 *       reference host immediately after that change.
 *
 * Best-effort contract: `sweepBoard` itself never throws for an enumeration
 * failure — `enumerateCandidates` is wrapped in try/catch; on ANY failure the
 * sweep degrades to the pre-#716 single-repo write
 * (`mirrorBoard({ repoRoot, explicitStatus: 'in-progress' })`) so the board
 * write still happens. `mirrorBoard`'s own internal guards (vault disabled,
 * `_overview.md` refusal, noop-skip, …) are untouched and still apply.
 *
 * Telemetry: BOTH paths emit one {@link BOARD_EVENT} with `caller: 'sweepBoard'`
 * (the wrapping {@link mirrorBoard} call does the emitting, so a sweep never
 * produces two records). The happy path carries `repos_swept`; the fallback
 * omits it, which is what distinguishes "enumeration ran and found nothing"
 * (`repos_swept: 0`) from "enumeration threw" (key absent).
 *
 * @param {object} [opts]
 * @param {string} opts.repoRoot — the calling repo (always included in the sweep).
 * @param {string} [opts.startDir] — enumeration root; omitted in production so
 *   {@link enumerateCandidates} defaults to `getConfinementRoot()` (~/Projects).
 *   Test seam only — do NOT compute `path.dirname(repoRoot)` here.
 * @param {Date|number} [opts.now] — clock seam. A `Date` is used as-is; a finite
 *   number is treated as epoch-ms (matching {@link collectRows}'s own
 *   `now instanceof Date ? … : Date.now()` convention); anything else falls
 *   back to `Date.now()`. Always forwarded to {@link mirrorBoard} as a `Date`
 *   (see body) — {@link renderBoard} only special-cases `now instanceof Date`,
 *   so a bare number would otherwise be silently discarded there.
 * @param {boolean} [opts.dryRun]
 * @param {object} [opts.fs] — injectable fs for {@link mirrorBoard}/{@link writeBoard}.
 * @param {object} [opts.deps] — injectable deps for {@link enumerateCandidates}
 *   (test seam: `readdirSync`, `existsSync`, `readLock`, `isLockLive`,
 *   `getCrossRepoProjects`, `validatePathInsideProject`, `now`).
 * @param {{ env?: Record<string, string|undefined>, ownerConfig?: object }} [opts.hostPaths]
 *   — forwarded verbatim to every {@link mirrorBoard} call below (both the happy-path
 *   and the enumeration-failure-fallback path), which in turn forwards it to
 *   {@link parseSessionConfig}'s `hostPaths` DI seam (issue #653/#783). See
 *   {@link mirrorBoard}'s own `hostPaths` doc for the hermetic-test rationale.
 * @returns {Promise<{ action: string, path?: string }>}
 */
export async function sweepBoard({ repoRoot, startDir, now = new Date(), dryRun = false, fs, deps, hostPaths } = {}) {
  // Accept both a Date and a caller-passed epoch-ms number (previously the
  // numeric case was silently discarded by `now instanceof Date ? … : Date.now()`).
  const nowMs = now instanceof Date
    ? now.getTime()
    : (typeof now === 'number' && Number.isFinite(now) ? now : Date.now());

  // mirrorBoard → renderBoard only special-case `now instanceof Date` (a bare
  // number falls through to `new Date()` inside renderBoard, breaking
  // determinism). Forward a real Date built from `nowMs` so a numeric `now`
  // stays deterministic end-to-end.
  const nowForMirror = now instanceof Date ? now : new Date(nowMs);

  try {
    const candidates = await enumerateCandidates({ startDir, now: nowMs, deps });
    const repos = buildSweepRepos(candidates, { thisRepoRoot: repoRoot });
    // Telemetry counts what ENUMERATION surfaced, not what we sweep: `repos`
    // always contains at least `thisRepoRoot` (buildSweepRepos unions it in),
    // so a silently-empty enumeration — the documented macOS realpath-hop
    // failure, 0 candidates and no error — would be invisible in `repos.length`
    // and plainly visible as `repos_swept: 0`. Guarded with Array.isArray so a
    // non-array return keeps flowing into buildSweepRepos exactly as before
    // rather than throwing us into the fallback branch below.
    const reposSwept = Array.isArray(candidates) ? candidates.length : undefined;
    return await mirrorBoard({ repoRoot, repos, now: nowForMirror, dryRun, fs, hostPaths, caller: 'sweepBoard', reposSwept });
  } catch (err) {
    console.warn('[sweepBoard] host-wide enumeration failed — degraded to single-repo board write:', err?.message ?? err);
    // Best-effort fallback: enumeration failed for any reason — degrade to the
    // pre-#716 single-repo write so the board is still updated for THIS repo.
    // `reposSwept` is deliberately NOT passed: nothing was enumerated, so the
    // field is omitted rather than reported as 0 (absent is not zero).
    return mirrorBoard({ repoRoot, explicitStatus: 'in-progress', now: nowForMirror, dryRun, fs, hostPaths, caller: 'sweepBoard' });
  }
}
