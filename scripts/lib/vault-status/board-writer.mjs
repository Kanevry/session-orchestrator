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
 * Exports:
 *   GENERATOR_MARKER  — frontmatter sentinel that identifies generator-owned files
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

import { isLockLive, readLock } from '../session-lock.mjs';
import { readRegistry, repoPathHash, isRegistryEntryFresh } from '../session-registry.mjs';
import { parseFrontmatter } from '../vault-mirror/utils.mjs';
import { readConfigFile, parseSessionConfig } from '../config.mjs';
import { validatePathInsideProject } from '../path-utils.mjs';
import { enumerateCandidates } from '../dispatcher/enumerate.mjs';

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

// ── Path helpers ────────────────────────────────────────────────────────────────

/**
 * Expand a leading `~` to the current user's home directory. Inlined here on
 * purpose — the shared helper is private elsewhere, and a shared
 * `vault-write-guard.mjs` extraction is deferred to a later epic (W2 forbids a
 * new shared file in this slice).
 *
 * @param {string} p
 * @returns {string}
 */
function expandHome(p) {
  if (typeof p !== 'string' || p.length === 0) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Resolve the board file path from a vault directory.
 *
 * @param {string} vaultDir — absolute or `~`-prefixed vault root
 * @returns {string} `<vaultDir>/01-projects/_active-sessions.md`
 */
export function resolveBoardPath(vaultDir) {
  return path.join(expandHome(vaultDir), '01-projects', '_active-sessions.md');
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
 * @param {Map<string, string>} [opts.priorStatusByRepo] — {@link foldKey}-folded
 *   (case-insensitive) repoName → prior board status, used to derive `closed`
 *   when a once-active repo now has no lock. Callers MUST fold the key with
 *   {@link foldKey} before inserting (issue #719) — this function folds its
 *   own lookup key to match.
 * @returns {Promise<Array<{ repo: string, status: string, session: string|null,
 *   branch: string|null, mode: string|null, heartbeat: string|null }>>}
 */
export async function collectRows({ repos, now = new Date(), registry, priorStatusByRepo } = {}) {
  if (!Array.isArray(repos)) {
    throw new TypeError('collectRows: opts.repos must be an array');
  }

  const nowMs = now instanceof Date ? now.getTime() : Date.now();
  const registryEntries = Array.isArray(registry) ? registry : await readRegistry();
  const priorStatus = priorStatusByRepo instanceof Map ? priorStatusByRepo : new Map();

  const rows = [];

  for (const repo of repos) {
    if (!repo || typeof repo.repoRoot !== 'string' || repo.repoRoot.length === 0) {
      // Skip malformed repo descriptors rather than throwing — one bad entry
      // must not abort the whole board render.
      continue;
    }

    const repoName = typeof repo.repoName === 'string' && repo.repoName.length > 0
      ? repo.repoName
      : path.basename(path.resolve(repo.repoRoot));

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
      // Key is folded (issue #719) so `Some-Repo` and `some-repo` resolve
      // to the same prior-status entry on case-insensitive-preserving filesystems.
      const prior = priorStatus.get(foldKey(repoName));
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
 * Rows are sorted alphabetically by repo name for stable, diff-friendly output.
 *
 * @param {Array<{ repo: string, status: string, session?: string|null,
 *   branch?: string|null, mode?: string|null, heartbeat?: string|null }>} rows
 * @param {{ now: Date, createdIso?: string, updatedPlaceholder?: string }} opts
 * @returns {string} full markdown (frontmatter + table)
 */
export function renderBoard(rows, opts = {}) {
  const { now, createdIso, updatedPlaceholder } = opts;
  const nowDate = now instanceof Date ? now : new Date();

  const nowIso = toIso(nowDate);
  const updatedValue = updatedPlaceholder ?? nowIso;
  const createdValue = createdIso ?? nowIso;

  const sortedRows = [...(Array.isArray(rows) ? rows : [])].sort((a, b) =>
    String(a?.repo ?? '').localeCompare(String(b?.repo ?? '')),
  );

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
  lines.push('| Repo | Status | Session | Branch | Mode | Last heartbeat |');
  lines.push('|---|---|---|---|---|---|');
  for (const row of sortedRows) {
    lines.push(
      `| ${cell(row?.repo)} | ${cell(row?.status)} | ${cell(row?.session)} | ` +
      `${cell(row?.branch)} | ${cell(row?.mode)} | ${cell(fmtHeartbeat(row?.heartbeat))} |`,
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
 * is not a 6-column table row, and maps the literal '—' placeholder back to
 * null. Unescapes the `\|` pipe-escaping applied by {@link renderBoard}.
 *
 * @param {string} content — full board markdown
 * @returns {Array<{ repo: string, status: string, session: string|null,
 *   branch: string|null, mode: string|null, heartbeat: string|null }>}
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
    if (cells.length !== 6) continue;
    // Skip the header row and the |---|---| separator row.
    if (cells[0] === 'Repo' || /^-+$/.test(cells[0])) continue;
    const unesc = (v) => (v === '—' ? null : v.replace(/\\\|/g, '|'));
    const repo = unesc(cells[0]);
    if (repo === null) continue;
    rows.push({
      repo,
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
 *   4. else → mkdirSync(recursive) + writeFileSync → written.
 *
 * @param {{
 *   outputPath: string,
 *   content: string,
 *   dryRun?: boolean,
 *   fs?: { readFileSync?: Function, writeFileSync?: Function, mkdirSync?: Function, existsSync?: Function },
 * }} opts
 * @returns {{ action: 'written'|'skipped-handwritten'|'skipped-noop'|'dry-run', path: string }}
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

  // 4. Write.
  fsMkdir(path.dirname(outputPath), { recursive: true });
  fsWriteFile(outputPath, content, 'utf8');
  return { action: 'written', path: outputPath };
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
 *   Full repo list; defaults to `[{ repoRoot, status: explicitStatus }]`.
 * @param {string} [opts.explicitStatus] — per-repo status override ('closed' from session-end).
 * @param {Date} [opts.now]
 * @param {boolean} [opts.dryRun]
 * @param {object} [opts.fs] — injectable fs for tests.
 * @returns {Promise<{ action: string, path?: string }>}
 */
export async function mirrorBoard({ repoRoot, repos, explicitStatus, now = new Date(), dryRun = false, fs } = {}) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    return { action: 'skipped-vault-disabled' };
  }

  // Read + parse Session Config. Any failure → silent no-op.
  let config;
  try {
    const text = await readConfigFile(repoRoot);
    config = parseSessionConfig(text);
  } catch {
    return { action: 'skipped-vault-disabled' };
  }

  const vault = config?.['vault-integration'];
  if (!vault || vault.enabled !== true) {
    return { action: 'skipped-vault-disabled' };
  }
  const vaultDir = vault['vault-dir'];
  if (typeof vaultDir !== 'string' || vaultDir.length === 0) {
    return { action: 'skipped-vault-disabled' };
  }

  // Safety: the resolved vault dir must live under $HOME.
  const expandedVault = expandHome(vaultDir);
  const home = os.homedir();
  const inHome = validatePathInsideProject(expandedVault, home);
  if (!inHome.ok) {
    return { action: 'skipped-vault-disabled' };
  }

  const repoList = Array.isArray(repos) && repos.length > 0
    ? repos
    : [{ repoRoot, status: explicitStatus }];

  const outputPath = resolveBoardPath(vaultDir);

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
  const priorStatusByRepo = new Map();
  const preservedRows = new Map(); // foldKey(repoName) → prior row (for merge)
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
          const key = foldKey(prior.repo);
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
          priorStatusByRepo.set(key, prior.status);
          preservedRows.set(key, prior);
        }
      }
    }
  }

  const rows = await collectRows({ repos: repoList, now, priorStatusByRepo });

  // Idempotent merge: keep prior rows for repos NOT in this update, then upsert
  // the freshly-derived rows over them so repeated writes stay stable. Both the
  // seed (`preservedRows`) and the upsert key below are folded via {@link
  // foldKey} (issue #719) — a freshly-derived row ALWAYS wins over a preserved
  // row sharing its folded key, which is what collapses a live `Some-Repo`
  // row over a stale preserved `some-repo` row on the next board write.
  const merged = new Map(preservedRows);
  for (const row of rows) merged.set(foldKey(row.repo), row);

  const content = renderBoard([...merged.values()], { now, createdIso });

  return writeBoard({ outputPath, content, dryRun, fs });
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
 *       ms at host scale (~31 repos observed). No timeout is applied: a sync
 *       call cannot be preempted in-process, so a timeout would only convert a
 *       slow sweep into a thrown error, not a faster one.
 *   (d) Merge key is `repoName` (`path.basename`), case-insensitively folded via
 *       {@link foldKey} (issue #719) — two rows differing only by case (e.g.
 *       `some-repo` vs `Some-Repo`, the same physical directory on a
 *       case-insensitive-preserving filesystem like APFS) now collapse to ONE
 *       board row instead of rendering as duplicates. The survivor is whichever
 *       row is live/newest: a freshly-derived row (this sweep's own
 *       `collectRows` output) always wins over a preserved stale row; among two
 *       PRESERVED rows colliding on the folded key, the more-recent `heartbeat`
 *       wins (see the collision-resolution loop inside {@link mirrorBoard}).
 *       Two GENUINELY different, differently-rooted repos that happen to share
 *       a basename (case-insensitively) still collapse to one row — that
 *       remains a known limitation, inherited from {@link collectRows}/
 *       {@link mirrorBoard}; not addressed here.
 *
 * Best-effort contract: `sweepBoard` itself never throws for an enumeration
 * failure — `enumerateCandidates` is wrapped in try/catch; on ANY failure the
 * sweep degrades to the pre-#716 single-repo write
 * (`mirrorBoard({ repoRoot, explicitStatus: 'in-progress' })`) so the board
 * write still happens. `mirrorBoard`'s own internal guards (vault disabled,
 * `_overview.md` refusal, noop-skip, …) are untouched and still apply.
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
 * @returns {Promise<{ action: string, path?: string }>}
 */
export async function sweepBoard({ repoRoot, startDir, now = new Date(), dryRun = false, fs, deps } = {}) {
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
    return await mirrorBoard({ repoRoot, repos, now: nowForMirror, dryRun, fs });
  } catch (err) {
    console.warn('[sweepBoard] host-wide enumeration failed — degraded to single-repo board write:', err?.message ?? err);
    // Best-effort fallback: enumeration failed for any reason — degrade to the
    // pre-#716 single-repo write so the board is still updated for THIS repo.
    return mirrorBoard({ repoRoot, explicitStatus: 'in-progress', now: nowForMirror, dryRun, fs });
  }
}
