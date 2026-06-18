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

/** Frontmatter sentinel that identifies generator-owned board files. */
export const GENERATOR_MARKER = 'session-orchestrator-active-sessions@1';

/** Placeholder used for noop comparison (replaces the live `updated:` value). */
const UPDATED_PLACEHOLDER = '__UPDATED_PLACEHOLDER__';

/** The four board statuses, in display priority order. */
const STATUS_IN_PROGRESS = 'in-progress';
const STATUS_FORCE_CLOSED = 'force-closed';
const STATUS_CLOSED = 'closed';
const STATUS_FREI = 'frei';

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
 * @param {Map<string, string>} [opts.priorStatusByRepo] — repoName → prior board
 *   status, used to derive `closed` when a once-active repo now has no lock.
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
      const prior = priorStatus.get(repoName);
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
  const fsReadFile = fs?.readFileSync ?? readFileSync;
  const fsExists = fs?.existsSync ?? existsSync;
  let createdIso;
  const priorStatusByRepo = new Map();
  const preservedRows = new Map(); // repoName → prior row (for merge)
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
          priorStatusByRepo.set(prior.repo, prior.status);
          preservedRows.set(prior.repo, prior);
        }
      }
    }
  }

  const rows = await collectRows({ repos: repoList, now, priorStatusByRepo });

  // Idempotent merge: keep prior rows for repos NOT in this update, then upsert
  // the freshly-derived rows over them so repeated writes stay stable.
  const merged = new Map(preservedRows);
  for (const row of rows) merged.set(row.repo, row);

  const content = renderBoard([...merged.values()], { now, createdIso });

  return writeBoard({ outputPath, content, dryRun, fs });
}
