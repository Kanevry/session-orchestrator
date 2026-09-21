/**
 * orphan-reaper.mjs — Teil B of Epic #1425: the NET under the process-group kill.
 *
 * Teil A (`process-group.mjs`) prevents orphans at the source. This module finds
 * the ones that happen anyway — a session that crashed, a harness SIGKILL, a
 * leak from a foreign repo on the same host — and reaps them.
 *
 * The 2026-09-20 incident this exists for: four orphaned `tsgo --noEmit`
 * processes, two at PPID 1, 86-588% CPU and up to 8.0 GB RSS each; the Mac at
 * 13% free memory, load 67.4. The existing detector
 * (`countZombieProcesses`, `resource-probe/parsers.mjs`) would have counted ZERO:
 * its `ps` carries no `ppid` and no `rss`, its name filter knows only
 * `claude`/`node`, and it defines a zombie as IDLE (`cpu <= 1.0`) — the exact
 * opposite of a runaway.
 *
 * ## Shape: pure decision, impure execution
 *
 * Strictly the `lock-reaper.mjs` split — `evaluateRepo()` decides, `archiveLock()`
 * destroys, with a TOCTOU re-check between. Here:
 *
 *   ps text → {@link parsePsSnapshot} → {@link decideReapCandidates} (PURE)
 *           → fresh ps + identity re-check → `deps.killProcessGroup` (IMPURE)
 *
 * {@link decideReapCandidates} does no I/O, sends no signal, and is fully
 * testable from `ps` text fixtures. Everything impure reaches it through
 * `deps` ({@link resolveDeps}).
 *
 * ## Why PPID 1 is necessary and never sufficient
 *
 * Measured on this host 2026-09-21: 538 of 784 processes (68.6%) have PPID 1 —
 * on macOS launchd is the parent of nearly everything. A reaper keyed on PPID 1
 * alone would be a weapon pointed at the operating system. So a candidate is a
 * CONJUNCTION: in our own gate-process ledger, PPID 1, old enough, a read-only
 * gate command, and an identity that still verifies against the ledger record.
 *
 * ## Named ceiling (BV-004) — Stufe 1 matches the ledger by PID
 *
 * The binding `ps` format ({@link PS_ARGS}) publishes no `pgid` column, so a row
 * can only be joined to the ledger on `pid` (and, defensively, on a record's
 * `pgid`, which equals its `pid` under `detached: true`). That means Stufe 1
 * reaps the GROUP LEADER — killing whose group takes its descendants with it —
 * and never a surviving grandchild whose leader is already gone. That grandchild
 * carries no ledger identity in this format and is therefore not a candidate BY
 * DESIGN (PRD § Umfangsgrenze: orphan-confidence via PPID history is Stufe 2 /
 * C4). Revisit trigger: if a grandchild-without-leader case is ever observed for
 * a process the ledger DID record, add `pgid=` to {@link PS_ARGS} and join on it.
 */

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  buildCommandSignature,
  killProcessGroup,
  readGateProcessLedger,
  verifyProcessIdentity,
} from './process-group.mjs';
import { parseEtimeToSeconds } from './resource-probe/parsers.mjs';

/**
 * Stufe-1 parameters. Every number carries its provenance from the PRD
 * parameter table (`docs/prd/2026-09-20-prozessgruppen-kill-und-waisen-waechter.md`
 * § 4) — NOT calibrated, so the provenance is what makes a later re-measurement
 * possible ("keine Zahl ohne ihre Population").
 */
export const REAPER_DEFAULTS = Object.freeze({
  /** `reaper.min-age-seconds`: DevWatchdogs' hard limit for `tsgo`; the
   *  2026-09-20 orphans were 7-17 min old, comfortably above it. */
  minAgeSeconds: 300,
  /** `reaper.min-scan-interval-seconds`: DevWatchdogs' normal scan cadence —
   *  keeps a `PostToolBatch` storm from taxing every tool call. */
  minScanIntervalSeconds: 30,
  /** `reaper.kill-grace-ms`: `DEFAULT_KILL_GRACE_MS` from
   *  `wave-executor/dispatch-common.mjs` — a repo convention, not a new number. */
  killGraceMs: 10_000,
  /** `reaper.verify-wait-ms`: without it the 2026-09-20 hand-run cleanup
   *  reported "still alive" for processes that were already gone. */
  verifyWaitMs: 500,
  /** `reaper.max-hook-latency-ms`: ceiling a scan may delay a hook by. */
  maxHookLatencyMs: 50,
  /** `reaper.false-alarm-window`: last N audit decisions — a ROLLING window
   *  rather than calendar time, so a quiet host still has a population (HR-101). */
  falseAlarmWindow: 50,
});

/**
 * The read-only gate command class — an ALLOWLIST, which is why no denylist is
 * needed: a dev server or MCP server matches nothing here and is therefore never
 * a candidate, orphaned or not (PRD § Out-of-Scope: two orphaned `browser-kit`
 * servers were reported, not killed).
 *
 * IN — commands that only read the working copy and can be re-run at will:
 *   `tsgo`, `tsc`, `vitest`, `eslint`, `node …vitest…`,
 *   `npm test` / `npm run typecheck` / `npm run lint`.
 * DELIBERATELY OUT — anything that holds state or serves a port: dev servers,
 *   MCP servers, `npm run build`, `git` (writes the index), database processes.
 *
 * Matched against the FULL `args` string, with a `(^|[\s/])` boundary so both
 * `tsgo --noEmit` and `/opt/homebrew/bin/tsgo --noEmit` and `npx tsgo` hit.
 */
export const READ_ONLY_COMMAND_PATTERNS = Object.freeze([
  /(^|[\s/])tsgo(\s|$)/,
  /(^|[\s/])tsc(\s|$)/,
  /(^|[\s/])vitest(\s|$)/,
  /(^|[\s/])eslint(\s|$)/,
  /(^|[\s/])node\s+\S*vitest/,
  /(^|[\s/])npm\s+(run\s+)?(test|typecheck|lint)(\s|$)/,
]);

/**
 * The binding `ps` invocation (Discovery d-2, 2026-09-21, Darwin 25.6.0).
 *
 * Headerless (`=` per field) and five NUMERIC fields before `args`, because on
 * macOS `comm` is a 16-character-truncated PATH that may contain spaces (68 of
 * 784 processes carried a space, 13 of them survived the truncation) — appending
 * `args` after `comm` breaks whitespace splitting outright. `-ww` disables column
 * truncation; `ps` escapes control characters, so one process is one line.
 * `rss` is in KiB. Roundtrip measured at ~47 ms for 287 KB / 784 processes.
 *
 * A targeted call, NOT the full `probe()` — that one spawns up to five
 * subprocesses and has no caching (PRD § B4).
 */
export const PS_ARGS = Object.freeze(['-Aww', '-o', 'pid=,ppid=,rss=,etime=,%cpu=,args=']);

/** Relative path of the JSONL kill audit (B5). Gitignored via `.gitignore:55`
 *  (`.orchestrator/metrics/*.jsonl`), verified with `git check-ignore --no-index -v`.
 *  Under the `ledger-delete-protected` policy rule: in-process fs only, never a
 *  shell `rm`/`mv`. */
export const REAPER_AUDIT_RELPATH = '.orchestrator/metrics/reaper-audit.jsonl';

/** Relative path of the scan-throttle marker (B4). Gitignored via
 *  `.gitignore:141` (`.orchestrator/tmp/`). */
export const SCAN_MARKER_RELPATH = '.orchestrator/tmp/reaper-last-scan';

/** Characters of `args` copied into an audit record — and ONLY for a command
 *  that already matched the read-only allowlist, so a foreign process's command
 *  line (which may carry paths or tokens) never reaches the audit. */
const ARGS_HEAD_CHARS = 80;

/** Wall-clock ceiling for one `ps` call. Same 2 s as `runPsDetailed()` in
 *  `resource-probe/probe-platform.mjs`, whose spawn/timeout shape this mirrors. */
const PS_TIMEOUT_MS = 2000;

/**
 * One parsed `ps` row.
 * @typedef {object} PsRow
 * @property {number} pid
 * @property {number} ppid
 * @property {number} rssKb           Resident set size in KiB.
 * @property {number} etimeSeconds    Elapsed seconds since exec.
 * @property {number} cpuPct
 * @property {string} args            Full command line.
 */

/** @param {string} repoRoot @param {string} relpath @returns {string} */
function underRepo(repoRoot, relpath) {
  return path.join(repoRoot, ...relpath.split('/'));
}

/**
 * Parse `ps` output in the {@link PS_ARGS} format, tolerantly — and COUNT what
 * it drops.
 *
 * A silently skipping parser turns a partial read into a clean verdict, which is
 * the exact failure mode a reaper must not have; hence the `malformed` count
 * ({@link parsePsSnapshotDetailed}). A row whose `etime` does not parse is
 * treated as malformed rather than returned with a null age: every returned row
 * must carry a usable age, because age is a load-bearing gate here.
 *
 * @param {string|null|undefined} text
 * @returns {{rows: PsRow[], malformed: number}}
 */
export function parsePsSnapshotDetailed(text) {
  if (text === null || text === undefined) return { rows: [], malformed: 0 };
  /** @type {PsRow[]} */
  const rows = [];
  let malformed = 0;
  // Five whitespace-free fields, then `args` as the ENTIRE rest of the line —
  // args legitimately contains spaces, so it must never be split.
  const rowRe = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/;
  for (const raw of String(text).split(/\r?\n/)) {
    if (raw.trim().length === 0) continue;
    const m = rowRe.exec(raw);
    if (!m) { malformed += 1; continue; }
    const etimeSeconds = parseEtimeToSeconds(m[4]);
    const cpuPct = parseFloat(m[5]);
    if (etimeSeconds === null || Number.isNaN(cpuPct)) { malformed += 1; continue; }
    rows.push({
      pid: parseInt(m[1], 10),
      ppid: parseInt(m[2], 10),
      rssKb: parseInt(m[3], 10),
      etimeSeconds,
      cpuPct,
      args: m[6] ?? '',
    });
  }
  return { rows, malformed };
}

/**
 * {@link parsePsSnapshotDetailed} without the drop count.
 * @param {string|null|undefined} text
 * @returns {PsRow[]}
 */
export function parsePsSnapshot(text) {
  return parsePsSnapshotDetailed(text).rows;
}

/**
 * True when `args` is a read-only gate command per {@link READ_ONLY_COMMAND_PATTERNS}.
 * @param {string} args
 * @param {readonly RegExp[]} [patterns]
 * @returns {boolean}
 */
function isReadOnlyCommand(args, patterns = READ_ONLY_COMMAND_PATTERNS) {
  const s = typeof args === 'string' ? args : '';
  if (s.length === 0) return false;
  return patterns.some((re) => re.test(s));
}

/**
 * Decide which processes are reapable orphans — PURE.
 *
 * No I/O, no signal, no clock of its own: `nowMs` is an argument. The only
 * imports it reaches are {@link verifyProcessIdentity} and
 * {@link buildCommandSignature}, both themselves pure.
 *
 * Exactly ONE verdict per examined row, at a FIXED priority, so a row can never
 * appear twice and a trigger is never ambiguous:
 *
 *   1. not in the ledger            → `rejected: not-in-ledger`
 *   2. PPID !== 1                   → `rejected: has-parent`
 *   3. younger than `minAgeSeconds` → `rejected: too-young`
 *   4. foreign session, live or of unmeasurable liveness
 *                                   → `reported: foreign-live-session`
 *                                     / `foreign-session-liveness-unknown`  (never killed)
 *   5. not a read-only command      → `reported: not-read-only`         (never killed)
 *   6. identity does not verify     → `rejected: identity-mismatch | signature-mismatch`
 *   7. otherwise                    → `candidates` with `trigger: 'orphan-ppid1'`
 *
 * Step 4 precedes step 5 on purpose: a foreign live session's process is
 * reported for its OWNER, whether or not it also happens to be read-only
 * (PRD FA3: "gemeldet, aber nicht automatisch getötet").
 *
 * Named ceiling (BV-004) on the `rejected` volume: every PPID-1 row that is not
 * in the ledger is materialised as `not-in-ledger` — ~538 entries on this
 * 784-process host. That is deliberate (the AC requires the rejection reason to
 * be traceable in the RESULT) and bounded, because only candidates and reports
 * are ever persisted to the audit; `rejected` stays in memory for one scan.
 * Rows with a live parent that are ALSO not in the ledger are skipped entirely —
 * they are neither orphan-shaped nor ours, and materialising them would double
 * the array for no signal. Revisit if a consumer ever persists `rejected`.
 *
 * @param {PsRow[]} snapshot
 * @param {import('./process-group.mjs').GateProcessRecord[]} ledgerRecords
 * @param {number} nowMs
 * @param {object} [opts]
 * @param {string|null} [opts.ownSessionId]
 * @param {string[]|null} [opts.livePeerSessionIds]  Session ids `detectPeers()`
 *   reports LIVE — or `null` when the probe could not measure at all.
 * @param {number} [opts.minAgeSeconds]
 * @param {readonly RegExp[]} [opts.readOnlyPatterns]
 * @param {number} [opts.identityToleranceMs]
 * @returns {{candidates: object[], reported: object[], rejected: object[]}}
 */
export function decideReapCandidates(snapshot, ledgerRecords, nowMs, {
  ownSessionId = null,
  livePeerSessionIds = [],
  minAgeSeconds = REAPER_DEFAULTS.minAgeSeconds,
  readOnlyPatterns = READ_ONLY_COMMAND_PATTERNS,
  identityToleranceMs = 2000,
} = {}) {
  const rows = Array.isArray(snapshot) ? snapshot : [];
  const records = Array.isArray(ledgerRecords) ? ledgerRecords : [];
  // THREE states, not two: a measured list, an empty measured list, or `null`
  // for "liveness could not be measured". A failed peer probe must not read as
  // "no peers are alive" — that would turn an unmeasured foreign session into a
  // kill target (a missing measurement must never look like a zero).
  const peers = livePeerSessionIds === null || livePeerSessionIds === undefined
    ? null
    : new Set((Array.isArray(livePeerSessionIds) ? livePeerSessionIds : [])
      .filter((id) => typeof id === 'string' && id.length > 0));

  /** @type {Map<number, object>} */
  const byPid = new Map();
  for (const rec of records) {
    if (!rec || typeof rec.pid !== 'number') continue;
    // A `pid` hit wins over a `pgid` hit: under `detached: true` the two are
    // equal, so indexing both is defensive, never a second source of truth.
    if (typeof rec.pgid === 'number' && !byPid.has(rec.pgid)) byPid.set(rec.pgid, rec);
    byPid.set(rec.pid, rec);
  }

  const candidates = [];
  const reported = [];
  const rejected = [];

  for (const row of rows) {
    const record = byPid.get(row.pid) ?? null;
    const orphanShaped = row.ppid === 1;

    if (!record) {
      if (orphanShaped) {
        rejected.push({
          pid: row.pid, ppid: row.ppid, ageSeconds: row.etimeSeconds, reason: 'not-in-ledger',
        });
      }
      continue;
    }

    const base = {
      pid: row.pid,
      pgid: typeof record.pgid === 'number' ? record.pgid : row.pid,
      ppid: row.ppid,
      ageSeconds: row.etimeSeconds,
      rssKb: row.rssKb,
      cpuPct: row.cpuPct,
      commandSignature: record.commandSignature ?? null,
      sessionId: record.sessionId ?? null,
    };

    if (!orphanShaped) {
      rejected.push({ ...base, reason: 'has-parent' });
      continue;
    }
    if (row.etimeSeconds < minAgeSeconds) {
      rejected.push({ ...base, reason: 'too-young', threshold: { minAgeSeconds } });
      continue;
    }

    const foreignSessionId = typeof record.sessionId === 'string' && record.sessionId.length > 0
      && record.sessionId !== ownSessionId
      ? record.sessionId
      : null;
    if (foreignSessionId !== null) {
      if (peers === null) {
        // Unmeasurable liveness → report, never reap. The only foreign process
        // this function reaps is one whose session a SUCCESSFUL probe proved dead.
        reported.push({ ...base, reason: 'foreign-session-liveness-unknown' });
        continue;
      }
      if (peers.has(foreignSessionId)) {
        reported.push({ ...base, args: row.args, reason: 'foreign-live-session' });
        continue;
      }
    }

    if (!isReadOnlyCommand(row.args, readOnlyPatterns)) {
      // No `args` here: a command the allowlist did not recognise is not ours to
      // copy around (dev servers, MCP servers, anything with a command line we
      // have no reason to retain).
      reported.push({ ...base, reason: 'not-read-only' });
      continue;
    }

    const identity = verifyProcessIdentity(
      row.pid,
      {
        startTime: record.startTime,
        commandSignature: record.commandSignature ?? buildCommandSignature(row.args),
      },
      { snapshotLine: row, nowMs, toleranceMs: identityToleranceMs },
    );
    if (!identity.match) {
      rejected.push({
        ...base,
        reason: identity.reason === 'signature-mismatch' ? 'signature-mismatch' : 'identity-mismatch',
        identity: { match: identity.match, reason: identity.reason },
      });
      continue;
    }

    candidates.push({
      ...base,
      args: row.args,
      ledgerRecord: record,
      identity: { match: identity.match, reason: identity.reason },
      trigger: 'orphan-ppid1',
      threshold: { minAgeSeconds },
      actual: { ageSeconds: row.etimeSeconds },
    });
  }

  return { candidates, reported, rejected };
}

/**
 * Default `ps` runner: the {@link PS_ARGS} call with a hard 2 s deadline,
 * SIGKILL on overrun, and `null` on any failure. Never throws.
 *
 * Mirrors `runPsDetailed()` in `resource-probe/probe-platform.mjs` — the same
 * spawn/settle/timeout shape, a different column set.
 *
 * @param {number} [timeoutMs]
 * @returns {Promise<string|null>}
 */
function defaultRunPs(timeoutMs = PS_TIMEOUT_MS) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') { resolve(null); return; }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const child = spawn('ps', [...PS_ARGS], { stdio: ['ignore', 'pipe', 'ignore'] });
      const chunks = [];
      child.stdout.on('data', (c) => chunks.push(c));
      child.on('error', () => finish(null));
      child.on('close', (code) => {
        if (code !== 0) return finish(null);
        finish(Buffer.concat(chunks).toString('utf8'));
      });
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        finish(null);
      }, timeoutMs);
      timer.unref?.();
    } catch {
      finish(null);
    }
  });
}

/**
 * Default audit sink: append one JSONL line to {@link REAPER_AUDIT_RELPATH}.
 * In-process fs only (the path sits under the `ledger-delete-protected` policy
 * rule). Best-effort — an audit write must never fail a scan — but a failure
 * prints one WARN line rather than vanishing.
 *
 * @param {string} repoRoot
 * @param {object} record
 * @returns {void}
 */
function defaultAppendAudit(repoRoot, record) {
  const target = underRepo(repoRoot, REAPER_AUDIT_RELPATH);
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    appendFileSync(target, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (err) {
    process.stderr.write(
      `orphan-reaper: could not append to ${REAPER_AUDIT_RELPATH}: ${err?.message ?? String(err)}\n`,
    );
  }
}

/** Default own-session-id reader. Lazily imported so the static import closure
 *  of this module stays small — it is destined for a hot-path hook (#1432).
 *  @param {string} repoRoot @returns {Promise<string|null>} */
async function defaultReadOwnSessionId(repoRoot) {
  try {
    const mod = await import('./session-identity/own-session.mjs');
    const ids = mod.readOwnSessionIds(repoRoot);
    for (const id of ids) return id;
    return null;
  } catch {
    return null;
  }
}

/**
 * Default live-peer probe. Lazily imported for the same reason as
 * {@link defaultReadOwnSessionId}.
 *
 * Returns `null` — never `[]` — when the registry cannot be read. The two mean
 * opposite things to {@link decideReapCandidates}: `[]` is a MEASUREMENT ("no
 * peer is alive", so a foreign session's leftovers are reapable), `null` is the
 * absence of one ("report it, do not touch it").
 *
 * @param {string|null} sessionId
 * @returns {Promise<string[]|null>}
 */
async function defaultDetectPeers(sessionId) {
  try {
    const mod = await import('./session-registry.mjs');
    const peers = await mod.detectPeers({ sessionId: sessionId ?? undefined });
    if (!Array.isArray(peers)) return null;
    return peers.map((p) => p?.session_id).filter((v) => typeof v === 'string' && v.length > 0);
  } catch {
    return null;
  }
}

/** @param {number} ms @returns {Promise<void>} */
function defaultSleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Resolve the dependency bundle, defaulting every seam to the real
 * implementation — the `resolveDeps()` pattern from `lock-reaper.mjs:77-100`.
 *
 * `killProcessGroup` HAS a real default, and that is safe only because
 * {@link runOrphanScan} defaults `dryRun: true`. Tests ALWAYS inject it
 * (`.claude/rules/testing.md`: never a real process as a kill target).
 *
 * @param {object} [deps]
 * @returns {object}
 */
export function resolveDeps(deps = {}) {
  const d = deps ?? {};
  return {
    runPs: d.runPs ?? defaultRunPs,
    readLedger: d.readLedger ?? readGateProcessLedger,
    verifyIdentity: d.verifyIdentity ?? verifyProcessIdentity,
    killProcessGroup: d.killProcessGroup ?? killProcessGroup,
    detectPeers: d.detectPeers ?? defaultDetectPeers,
    readOwnSessionId: d.readOwnSessionId ?? defaultReadOwnSessionId,
    appendAudit: d.appendAudit ?? defaultAppendAudit,
    now: d.now ?? Date.now,
    sleep: d.sleep ?? defaultSleep,
  };
}

/**
 * Build one B5 audit record.
 *
 * `args_head` is present ONLY for a command that cleared the read-only
 * allowlist — see {@link ARGS_HEAD_CHARS}.
 *
 * @param {object} entry     A candidate or a reported/rejected entry.
 * @param {'kill'|'report'|'reject'|'dry-run'} decision
 * @param {object} [extra]
 * @param {string} extra.timestamp
 * @param {string|null} [extra.sessionId]
 * @param {object} [extra.result]
 * @returns {object}
 */
function auditRecord(entry, decision, { timestamp, sessionId = null, result } = {}) {
  /** @type {Record<string, unknown>} */
  const record = {
    timestamp,
    session_id: sessionId,
    pid: entry.pid,
    pgid: entry.pgid ?? null,
    trigger: entry.trigger ?? entry.reason ?? null,
    threshold: entry.threshold ?? null,
    actual: entry.actual ?? (typeof entry.ageSeconds === 'number' ? { ageSeconds: entry.ageSeconds } : null),
    unit: 'seconds',
    command_signature: entry.commandSignature ?? null,
    decision,
  };
  if (typeof entry.args === 'string' && entry.args.length > 0) {
    record.args_head = entry.args.slice(0, ARGS_HEAD_CHARS);
  }
  if (result !== undefined) record.result = result;
  return record;
}

/**
 * Run one orphan scan: `ps` → decide → (unless `dryRun`) re-verify identity
 * against a FRESH snapshot → kill the group → audit.
 *
 * NO-THROW contract: every failure degrades into `skipped: '<reason>'` or a
 * `rejected` entry, because this runs from a hook and must never fail it
 * (PRD FA4: "bei jedem Fehler degradiert er lautlos").
 *
 * The second `ps` is the TOCTOU defence and the whole point of FA3: a PID
 * recycled between decision and signal must NOT be signalled. The re-check runs
 * {@link verifyProcessIdentity} against the fresh row; on any mismatch the
 * candidate is recorded as `decision: 'reject'` and no signal is sent. Such a
 * candidate stays in `candidates` (that WAS the decision) and additionally
 * appears in `rejected` (that is the withdrawal) — the two arrays answer
 * different questions and collapsing them would lose the TOCTOU event.
 *
 * `dryRun` defaults to TRUE: this module ships inert, and #1431/#1433 (Wave 3)
 * harden and arm the kill path.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {number} [opts.now]
 * @param {boolean} [opts.dryRun]
 * @param {object} [opts.deps]
 * @param {number} [opts.minAgeSeconds]
 * @param {number} [opts.killGraceMs]
 * @param {number} [opts.verifyWaitMs]
 * @returns {Promise<{scanned: number, candidates: object[], reported: object[],
 *   rejected: object[], killed: object[], skipped?: string, malformed: number,
 *   durationMs: number}>}
 */
export async function runOrphanScan({
  repoRoot,
  now,
  dryRun = true,
  deps,
  minAgeSeconds = REAPER_DEFAULTS.minAgeSeconds,
  killGraceMs = REAPER_DEFAULTS.killGraceMs,
  verifyWaitMs = REAPER_DEFAULTS.verifyWaitMs,
} = {}) {
  const d = resolveDeps(deps);
  const startedAt = typeof now === 'number' ? now : d.now();
  const empty = (skipped, malformed = 0) => ({
    scanned: 0,
    candidates: [],
    reported: [],
    rejected: [],
    killed: [],
    skipped,
    malformed,
    durationMs: Math.max(0, d.now() - startedAt),
  });

  if (typeof repoRoot !== 'string' || repoRoot.length === 0) return empty('no-repo-root');

  let text;
  try {
    text = await d.runPs();
  } catch {
    return empty('ps-failed');
  }
  if (text === null || text === undefined) return empty('ps-failed');

  const { rows, malformed } = parsePsSnapshotDetailed(text);

  let ledger;
  try {
    ledger = d.readLedger(repoRoot, { nowMs: startedAt });
  } catch {
    return empty('ledger-unreadable', malformed);
  }

  let ownSessionId = null;
  try {
    ownSessionId = await d.readOwnSessionId(repoRoot);
  } catch {
    ownSessionId = null;
  }

  /** @type {string[]|null} */
  let livePeerSessionIds;
  try {
    livePeerSessionIds = await d.detectPeers(ownSessionId);
  } catch {
    // null = unmeasured, NOT "no peers" — see decideReapCandidates.
    livePeerSessionIds = null;
  }

  const { candidates, reported, rejected } = decideReapCandidates(
    rows,
    ledger?.records ?? [],
    startedAt,
    { ownSessionId, livePeerSessionIds, minAgeSeconds },
  );

  const timestamp = new Date(startedAt).toISOString();
  const audit = (entry, decision, result) => {
    try {
      d.appendAudit(repoRoot, auditRecord(entry, decision, { timestamp, sessionId: ownSessionId, result }));
    } catch {
      /* the audit is an aid, never a precondition */
    }
  };

  for (const entry of reported) audit(entry, 'report');

  /** @type {object[]} */
  const killed = [];

  if (dryRun) {
    for (const c of candidates) audit(c, 'dry-run');
    return {
      scanned: rows.length, candidates, reported, rejected, killed, malformed,
      durationMs: Math.max(0, d.now() - startedAt),
    };
  }

  // TOCTOU: one FRESH snapshot for the whole kill pass. Re-reading `ps` per
  // candidate would cost a subprocess each and still not be atomic.
  let freshText;
  try {
    freshText = await d.runPs();
  } catch {
    freshText = null;
  }
  if (freshText === null || freshText === undefined) {
    for (const c of candidates) {
      rejected.push({ ...c, reason: 'identity-mismatch', identity: { match: false, reason: 'gone' } });
      audit(c, 'reject');
    }
    return {
      scanned: rows.length, candidates, reported, rejected, killed,
      skipped: 'ps-failed-before-kill', malformed,
      durationMs: Math.max(0, d.now() - startedAt),
    };
  }

  /** @type {Map<number, PsRow>} */
  const freshByPid = new Map();
  for (const row of parsePsSnapshot(freshText)) freshByPid.set(row.pid, row);

  for (const c of candidates) {
    const freshRow = freshByPid.get(c.pid) ?? null;
    let identity;
    try {
      identity = d.verifyIdentity(
        c.pid,
        { startTime: c.ledgerRecord.startTime, commandSignature: c.ledgerRecord.commandSignature },
        { snapshotLine: freshRow, nowMs: d.now() },
      );
    } catch {
      identity = { match: false, reason: 'gone' };
    }
    if (!identity.match) {
      rejected.push({
        ...c,
        reason: identity.reason === 'signature-mismatch' ? 'signature-mismatch' : 'identity-mismatch',
        identity,
      });
      audit(c, 'reject');
      continue;
    }

    let result;
    try {
      result = await d.killProcessGroup(c.pgid, { killGraceMs, verifyWaitMs, sleepFn: d.sleep });
    } catch (err) {
      result = { ok: false, signalsSent: [], survivors: [c.pgid], error: err?.code ?? null };
    }
    killed.push({
      pid: c.pid,
      pgid: c.pgid,
      ok: result?.ok === true,
      signalsSent: result?.signalsSent ?? [],
      survivors: result?.survivors ?? [],
      verifiedAfterMs: verifyWaitMs,
    });
    audit(c, 'kill', {
      ok: result?.ok === true,
      signalsSent: result?.signalsSent ?? [],
      survivors: result?.survivors ?? [],
    });
  }

  return {
    scanned: rows.length,
    candidates,
    reported,
    rejected,
    killed,
    malformed,
    durationMs: Math.max(0, d.now() - startedAt),
  };
}

/**
 * Throttle gate (B4): may a scan run now?
 *
 * Reads the marker's mtime; a missing or unreadable marker means "yes" — the
 * first scan of a host must not be blocked by the absence of its own throttle
 * file. Writing the marker is the CALLER's job ({@link touchScanMarker}), so
 * this stays a read-only predicate a hook can call cheaply.
 *
 * @param {string} markerPath   Absolute path — build it with {@link scanMarkerPath}.
 * @param {number} nowMs
 * @param {number} [minIntervalSeconds]
 * @param {object} [opts]
 * @param {(p: string) => {mtimeMs: number}} [opts.statFn]
 * @returns {boolean}
 */
export function shouldScanNow(markerPath, nowMs, minIntervalSeconds = REAPER_DEFAULTS.minScanIntervalSeconds, {
  statFn = statSync,
} = {}) {
  if (typeof markerPath !== 'string' || markerPath.length === 0) return false;
  let mtimeMs;
  try {
    mtimeMs = statFn(markerPath)?.mtimeMs;
  } catch {
    return true; // no marker yet → first scan
  }
  if (typeof mtimeMs !== 'number' || Number.isNaN(mtimeMs)) return true;
  return (nowMs - mtimeMs) >= minIntervalSeconds * 1000;
}

/**
 * Stamp the throttle marker. Best-effort and never throws — a marker that could
 * not be written means the next scan runs, which is the safe direction for a
 * read-only probe.
 *
 * @param {string} markerPath
 * @param {object} [opts]
 * @param {(p: string, data: string) => void} [opts.writeFn]
 * @returns {boolean} whether the marker was written
 */
export function touchScanMarker(markerPath, { writeFn } = {}) {
  try {
    if (writeFn) {
      writeFn(markerPath, `${new Date().toISOString()}\n`);
      return true;
    }
    mkdirSync(path.dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, `${new Date().toISOString()}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** Absolute path of the throttle marker for a repo. One constant per path.
 *  @param {string} repoRoot @returns {string} */
export function scanMarkerPath(repoRoot) {
  return underRepo(repoRoot, SCAN_MARKER_RELPATH);
}

/** Absolute path of the kill audit for a repo. One constant per path.
 *  @param {string} repoRoot @returns {string} */
export function auditPath(repoRoot) {
  return underRepo(repoRoot, REAPER_AUDIT_RELPATH);
}

/**
 * False-alarm rate over the last `windowSize` audit decisions — the HR-101
 * instrument-health check ("a signal may only warn if it is rare"; above ~10%
 * the instrument is broken and gets re-aimed, never re-thresholded).
 *
 * POPULATION (the number's denominator, stated because a rate without one is a
 * claim): audit records where the reaper judged a process a reapable orphan —
 * `decision` in `kill` | `dry-run` | `reject`. `report` records are excluded:
 * reporting a foreign or non-read-only process is the correct outcome, not a
 * firing of the kill signal.
 *
 * FALSE ALARM: a record where that judgement was refuted afterwards —
 * `decision: 'reject'` (the identity re-check withdrew the candidate) or a kill
 * whose `result.ok` is false (the signal did not take effect).
 *
 * Returns `{rate: null}` below 10 records: a rate over a handful of decisions
 * says nothing, and `null` is distinguishable from a measured 0 (a missing
 * measurement must never look like a zero).
 *
 * @param {object[]} auditRecords  In chronological order; the LAST `windowSize` are used.
 * @param {number} [windowSize]
 * @returns {{rate: number|null, n: number}}
 */
export function falseAlarmRate(auditRecords, windowSize = REAPER_DEFAULTS.falseAlarmWindow) {
  const all = Array.isArray(auditRecords) ? auditRecords : [];
  const firings = all.filter((r) => r && (r.decision === 'kill' || r.decision === 'dry-run' || r.decision === 'reject'));
  const window = windowSize > 0 ? firings.slice(-windowSize) : firings;
  const n = window.length;
  if (n < 10) return { rate: null, n };
  const falseAlarms = window.filter((r) => r.decision === 'reject' || r?.result?.ok === false).length;
  return { rate: falseAlarms / n, n };
}
