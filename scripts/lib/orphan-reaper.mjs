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
 *           → targeted ps + identity re-check BEFORE EVERY SIGNAL
 *           → `deps.killProcessGroup` → wait → re-measure (IMPURE)
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
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { isMainModule } from './is-main-module.mjs';
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

/**
 * The TARGETED variant of {@link PS_ARGS}: one pid, same six columns.
 *
 * Used immediately before every signal and once after the ladder (B3/B6). It is
 * a separate call rather than a re-run of the full `-A` scan because the whole
 * point is freshness at the moment of signalling — a 784-row snapshot taken for
 * the population is already stale by the time the ladder's 10 s grace elapses,
 * and re-taking it per signal would cost 287 KB to learn one row.
 *
 * @param {number} pid
 * @returns {string[]}
 */
export function psPidArgs(pid) {
  return ['-ww', '-p', String(pid), '-o', 'pid=,ppid=,rss=,etime=,%cpu=,args='];
}

/**
 * HR-101 ceiling: above this false-alarm rate the INSTRUMENT is suspect, and
 * the answer is to re-aim it — never to raise the threshold it fires on. Surfaced
 * as `instrumentSuspect` in the scan result; nothing in this module acts on it,
 * because acting on a broken instrument is the failure it names.
 */
export const FALSE_ALARM_SUSPECT_RATE = 0.1;

/** Name const for the one event this module emits. @see docs/events-schema.md */
export const REAPER_SCAN_EVENT = 'orchestrator.reaper.scan_completed';

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
  return runPsArgs([...PS_ARGS], timeoutMs);
}

/**
 * Default TARGETED `ps` runner (B3/B6): {@link psPidArgs} with the same hard
 * deadline and the same `null`-on-any-failure contract as {@link defaultRunPs}.
 *
 * `ps -p <gone-pid>` exits NON-ZERO with empty stdout on macOS, which
 * {@link runPsArgs} maps to `null` — so "gone" and "could not measure" arrive
 * here as the same value. That is why the caller treats a `null` as UNMEASURED
 * and refuses the signal, rather than reading it as proof of death: refusing on
 * an absent measurement costs one skipped reap, believing it costs a bystander.
 *
 * @param {number} pid
 * @param {number} [timeoutMs]
 * @returns {Promise<string|null>}
 */
function defaultRunPsPid(pid, timeoutMs = PS_TIMEOUT_MS) {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(null);
  return runPsArgs(psPidArgs(pid), timeoutMs);
}

/**
 * Spawn `ps` with `args`, capped at `timeoutMs`, `null` on any failure.
 * Never throws. Mirrors `runPsDetailed()` in `resource-probe/probe-platform.mjs`.
 *
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {Promise<string|null>}
 */
function runPsArgs(args, timeoutMs) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') { resolve(null); return; }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const child = spawn('ps', args, { stdio: ['ignore', 'pipe', 'ignore'] });
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

/**
 * Default audit READER — the other half of {@link defaultAppendAudit}, and the
 * data source {@link falseAlarmRate} needs (B5: "Dieselbe Datei ist die
 * Datenquelle für `reaper.false-alarm-window`").
 *
 * Tolerant and COUNTING is not needed here for once: a malformed audit line is
 * dropped from the rate's population rather than counted, because an unreadable
 * record carries no decision to classify — and the rate reports its own `n`, so
 * a shrinking population is visible in the number's denominator.
 *
 * Named ceiling (BV-004): reads the whole file and parses only its last `limit`
 * lines. Audit lines are written only for candidates and reports — zero on a
 * healthy host — so the file grows in the tens per week. Revisit (tail-seek, or
 * rotation like `events-rotation.mjs`) if it ever passes ~1 MB.
 *
 * @param {string} repoRoot
 * @param {number} [limit]
 * @returns {object[]} parsed records in chronological order; `[]` on any failure
 */
function defaultReadAuditRecords(repoRoot, limit = REAPER_DEFAULTS.falseAlarmWindow) {
  const target = underRepo(repoRoot, REAPER_AUDIT_RELPATH);
  let raw;
  try {
    raw = readFileSync(target, 'utf8');
  } catch {
    return [];
  }
  const lines = String(raw).split('\n').filter((l) => l.trim().length > 0);
  const records = [];
  for (const line of lines.slice(-Math.max(1, limit))) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') records.push(parsed);
    } catch {
      /* an unreadable line carries no decision to classify */
    }
  }
  return records;
}

/**
 * Default event emitter. Lazily imported for the same reason as
 * {@link defaultReadOwnSessionId}: `events.mjs` pulls in the schema validator,
 * the attribution chain and the webhook client, and this module is destined for
 * a hot-path hook (#1432) whose static import closure is measured.
 *
 * Never throws and never rejects — telemetry that can fail a scan would fail the
 * hook the scan runs in.
 *
 * @param {string} type
 * @param {object} payload
 * @param {{repoRoot?: string}} [opts]
 * @returns {Promise<boolean>} whether the record was written
 */
async function defaultEmitEvent(type, payload, opts = {}) {
  try {
    const mod = await import('./events.mjs');
    await mod.emitEvent(type, payload, opts);
    return true;
  } catch {
    return false;
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
    runPsPid: d.runPsPid ?? defaultRunPsPid,
    readLedger: d.readLedger ?? readGateProcessLedger,
    verifyIdentity: d.verifyIdentity ?? verifyProcessIdentity,
    killProcessGroup: d.killProcessGroup ?? killProcessGroup,
    detectPeers: d.detectPeers ?? defaultDetectPeers,
    readOwnSessionId: d.readOwnSessionId ?? defaultReadOwnSessionId,
    appendAudit: d.appendAudit ?? defaultAppendAudit,
    readAuditRecords: d.readAuditRecords ?? defaultReadAuditRecords,
    emitEvent: d.emitEvent ?? defaultEmitEvent,
    now: d.now ?? Date.now,
    sleep: d.sleep ?? defaultSleep,
  };
}

/**
 * Map an identity verdict's reason to the audit's `reason` vocabulary.
 *
 * Three outcomes, never two: `gone` (measured, the process is not there),
 * `signature-mismatch` / `identity-mismatch` (measured, it is a DIFFERENT
 * process) and `unmeasured` (the probe itself could not answer). The third is
 * the one a two-state mapping loses, and losing it is how an absent measurement
 * starts reading like a clean verdict.
 *
 * @param {string|null|undefined} identityReason
 * @returns {'gone'|'signature-mismatch'|'identity-mismatch'|'unmeasured'}
 */
function rejectReasonFor(identityReason) {
  if (identityReason === 'gone') return 'gone';
  if (identityReason === 'unmeasured') return 'unmeasured';
  if (identityReason === 'signature-mismatch') return 'signature-mismatch';
  return 'identity-mismatch';
}

/**
 * Build one B5 audit record.
 *
 * Exactly ONE `trigger` per record, taken from the single verdict
 * {@link decideReapCandidates} assigned at its fixed priority — a kill carries
 * `orphan-ppid1`, a report carries the reason it was reported for. That is what
 * makes "why exactly was this killed" answerable afterwards; a record listing
 * two triggers would answer it with a shrug.
 *
 * `reason` is separate from `trigger` and present on every WITHDRAWAL: the
 * trigger says what made this a candidate, the reason says what took it back.
 * `args_head` is present ONLY for a command that cleared the read-only
 * allowlist — see {@link ARGS_HEAD_CHARS}.
 *
 * @param {object} entry     A candidate or a reported/rejected entry.
 * @param {'kill'|'report'|'reject'|'dry-run'} decision
 * @param {object} [extra]
 * @param {string} extra.timestamp
 * @param {string|null} [extra.sessionId]
 * @param {object} [extra.result]
 * @param {string} [extra.reason]
 * @returns {object}
 */
function auditRecord(entry, decision, {
  timestamp, sessionId = null, result, reason,
} = {}) {
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
  const effectiveReason = reason ?? (decision === 'report' ? entry.reason : undefined);
  if (effectiveReason !== undefined && effectiveReason !== null) record.reason = effectiveReason;
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
 * The pre-signal re-check is the TOCTOU defence and the whole point of FA3: a
 * PID recycled between decision and signal must NOT be signalled. It runs a
 * TARGETED `ps` ({@link psPidArgs}) through `deps.runPsPid` and feeds the row to
 * {@link verifyProcessIdentity} — immediately before SIGTERM **and** immediately
 * before SIGKILL, via `killProcessGroup`'s `beforeSignal` gate, because the
 * ladder's 10 s grace is itself a recycling window. On any mismatch no further
 * signal is sent and the candidate is recorded as `decision: 'reject'` with the
 * reason that withdrew it. Such a candidate stays in `candidates` (that WAS the
 * decision) and additionally appears in `rejected` (that is the withdrawal) —
 * the two arrays answer different questions and collapsing them would lose the
 * TOCTOU event.
 *
 * Success is proven the same way, never from an exit code: after the ladder the
 * scan waits `verifyWaitMs` and re-measures (B6). `ok` is true only for a
 * process that is GONE; one that outlived SIGKILL is booked
 * `survivedSigkill: true`, and one the probe could not measure is `verified:
 * 'unmeasured'` — neither is ever a success.
 *
 * `dryRun` defaults to TRUE: arming happens at the CALL SITE (#1432), so a
 * caller that forgets the flag scans and reports instead of killing.
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
 *   durationMs: number, instrumentSuspect: boolean|null, falseAlarmRate: number|null,
 *   falseAlarmWindowN: number}>}
 *   `instrumentSuspect`/`falseAlarmRate` are `null` on a degraded (`skipped`) scan
 *   and `falseAlarmRate` is `null` below the 10-decision floor — in both cases a
 *   measurement that does not exist, never a measured zero.
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
  // A degraded scan measured NOTHING — including the instrument's own health.
  // `null` rather than `false`/`0` for both instrument fields: a scan that never
  // ran must not report a healthy instrument it never looked at.
  const empty = (skipped, malformed = 0) => ({
    scanned: 0,
    candidates: [],
    reported: [],
    rejected: [],
    killed: [],
    skipped,
    malformed,
    durationMs: Math.max(0, d.now() - startedAt),
    instrumentSuspect: null,
    falseAlarmRate: null,
    falseAlarmWindowN: 0,
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
  const audit = (entry, decision, extra = {}) => {
    try {
      d.appendAudit(repoRoot, auditRecord(entry, decision, {
        timestamp, sessionId: ownSessionId, ...extra,
      }));
    } catch {
      /* the audit is an aid, never a precondition */
    }
  };

  for (const entry of reported) audit(entry, 'report');

  /** @type {object[]} */
  const killed = [];

  /**
   * Close the scan: measure the instrument's own health (HR-101), emit at most
   * one event, return the result. Both real exits go through here so the rate
   * and the event can never be computed twice or forgotten once.
   * @returns {Promise<object>}
   */
  const complete = async () => {
    let auditRecords;
    try {
      auditRecords = (await d.readAuditRecords(repoRoot, REAPER_DEFAULTS.falseAlarmWindow)) ?? [];
    } catch {
      auditRecords = [];
    }
    const fa = falseAlarmRate(auditRecords, REAPER_DEFAULTS.falseAlarmWindow);
    // HR-101: the rate re-aims the instrument, it never re-thresholds it — so
    // this flag is REPORTED and nothing here branches on it.
    const instrumentSuspect = typeof fa.rate === 'number' && fa.rate > FALSE_ALARM_SUSPECT_RATE;
    const survivedSigkill = killed.filter((k) => k.survivedSigkill === true).length;
    const durationMs = Math.max(0, d.now() - startedAt);

    // HR-101 again, in the other direction: a signal that fires on every hook
    // is noise nobody reads. A scan that found nothing emits nothing — the
    // absence of a record IS the healthy state, and `instrumentSuspect` is the
    // one finding that must surface even from an empty scan.
    if (candidates.length + reported.length + killed.length > 0 || instrumentSuspect) {
      try {
        await d.emitEvent(REAPER_SCAN_EVENT, {
          scanned: rows.length,
          candidates: candidates.length,
          reported: reported.length,
          rejected: rejected.length,
          killed: killed.length,
          survived_sigkill: survivedSigkill,
          dry_run: dryRun === true,
          duration_ms: durationMs,
          instrument_suspect: instrumentSuspect,
          // OMITTED below the 10-decision floor, never 0: absence means "no
          // population yet", and a fabricated zero would read as a clean
          // instrument (`falseAlarmRate` returns `{rate: null}` there).
          ...(typeof fa.rate === 'number' ? { false_alarm_rate: fa.rate } : {}),
        }, { repoRoot });
      } catch {
        /* telemetry that can fail a scan would fail the hook the scan runs in */
      }
    }

    return {
      scanned: rows.length,
      candidates,
      reported,
      rejected,
      killed,
      malformed,
      durationMs,
      instrumentSuspect,
      falseAlarmRate: fa.rate,
      falseAlarmWindowN: fa.n,
    };
  };

  if (dryRun) {
    for (const c of candidates) audit(c, 'dry-run');
    return complete();
  }

  /**
   * ONE fresh, targeted identity measurement for one candidate (B3).
   *
   * There is deliberately no second, bulk `ps` pass any more: two TOCTOU
   * instruments measuring the same property at different freshness is how the
   * stale one silently wins. This is the only pre-signal measurement, and it is
   * taken immediately before each signal rather than once for the whole pass.
   *
   * @param {object} c
   * @returns {Promise<{match: boolean, reason: string, observed?: object}>}
   */
  const freshIdentity = async (c) => {
    let text;
    try {
      text = await d.runPsPid(c.pid);
    } catch {
      text = null;
    }
    // `ps -p` cannot distinguish "gone" from "could not run"; both must refuse
    // the signal, and only the second is an instrument gap worth its own reason.
    if (text === null || text === undefined) return { match: false, reason: 'unmeasured' };
    const row = parsePsSnapshot(text).find((r) => r.pid === c.pid) ?? null;
    try {
      return d.verifyIdentity(
        c.pid,
        { startTime: c.ledgerRecord.startTime, commandSignature: c.ledgerRecord.commandSignature },
        { snapshotLine: row, nowMs: d.now() },
      );
    } catch {
      return { match: false, reason: 'gone' };
    }
  };

  for (const c of candidates) {
    /** Set by the gate below when it refuses; `null` means every signal was permitted. */
    let withdrawal = null;
    const beforeSignal = async (signal) => {
      const identity = await freshIdentity(c);
      if (identity?.match === true) return true;
      withdrawal = { signal, identity, reason: rejectReasonFor(identity?.reason) };
      return false;
    };

    let result;
    try {
      result = await d.killProcessGroup(c.pgid, {
        killGraceMs, verifyWaitMs, sleepFn: d.sleep, beforeSignal,
      });
    } catch (err) {
      result = { ok: false, signalsSent: [], survivors: [c.pgid], error: err?.code ?? null, aborted: null };
    }
    const signalsSent = Array.isArray(result?.signalsSent) ? result.signalsSent : [];

    if (withdrawal !== null) {
      // The candidate was withdrawn between decision and signal. It stays in
      // `candidates` (that WAS the decision) and appears in `rejected` (that is
      // the withdrawal) — collapsing the two would lose the TOCTOU event.
      // `signalsSent` is carried even here: a withdrawal before the ESCALATION
      // still means a SIGTERM went out, and an audit that hid it would
      // under-report what this reaper did to the host.
      rejected.push({
        ...c, reason: withdrawal.reason, identity: withdrawal.identity, signalsSent,
      });
      audit(c, 'reject', {
        reason: withdrawal.reason,
        result: {
          ok: false,
          signalsSent,
          survivors: [],
          survivedSigkill: false,
          verifiedAfterMs: 0,
          verified: 'withdrawn',
        },
      });
      continue;
    }

    // B6: prove the EFFECT, after a wait, from a fresh measurement of the
    // process table. An exit code and a sent signal prove nothing — on
    // 2026-09-20 a probe with no wait reported "still alive" for dead processes.
    let verified = 'unverified';
    if (signalsSent.length > 0) {
      await d.sleep(verifyWaitMs);
      const after = await freshIdentity(c);
      if (after?.match === true) verified = 'alive';
      else if (after?.reason === 'unmeasured') verified = 'unmeasured';
      else verified = 'gone';
    }
    const ok = verified === 'gone';
    const survivedSigkill = verified === 'alive' && signalsSent.includes('SIGKILL');
    const survivors = ok ? [] : [c.pgid];
    const verifiedAfterMs = signalsSent.length > 0 ? verifyWaitMs : 0;

    killed.push({
      pid: c.pid,
      pgid: c.pgid,
      ok,
      signalsSent,
      survivors,
      survivedSigkill,
      verified,
      verifiedAfterMs,
    });
    audit(c, 'kill', {
      result: { ok, signalsSent, survivors, survivedSigkill, verifiedAfterMs, verified },
    });
  }

  return complete();
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

// ---------------------------------------------------------------------------
// CLI (#1432 B4 follow-up)
// ---------------------------------------------------------------------------
//
// The two trigger hooks (`hooks/on-stop.mjs`,
// `hooks/post-tool-batch-wave-signal.mjs`) spawn the scan as a DETACHED child.
// Before this tail existed they had to hand `node` an `--input-type=module -e
// <program>` string that dynamically imported this module — a program the
// hooks carried as source text, in two byte-identical copies. This entry point
// replaces it with a plain argv call, so the hooks spawn `node
// scripts/lib/orphan-reaper.mjs --repo-root <p> --mode <m> …` and the child's
// contract lives HERE, in one place, next to the function it drives.

/**
 * Parse the CLI argv — PURE, and exported so the flag contract is testable
 * without starting a process (the argv form is what the two hooks build, so a
 * typo in it fails silently as a dead detached child).
 *
 * Never throws: an unknown flag, a missing value and a non-numeric value all
 * land in `errors`, which the tail maps to exit 2. Returning the errors rather
 * than throwing keeps this usable from a test and from the tail alike.
 *
 * @param {string[]} [argv]  `process.argv.slice(2)`
 * @returns {{help: boolean, json: boolean, repoRoot: string|null, mode: 'report'|'kill',
 *   dryRun: boolean, minAgeSeconds: number, killGraceMs: number, verifyWaitMs: number,
 *   errors: string[]}}
 */
export function parseReaperCliArgs(argv = []) {
  const args = Array.isArray(argv) ? argv : [];
  /** @type {string[]} */
  const errors = [];
  const out = {
    help: false,
    json: false,
    repoRoot: null,
    mode: /** @type {'report'|'kill'} */ ('report'),
    dryRun: true,
    minAgeSeconds: REAPER_DEFAULTS.minAgeSeconds,
    killGraceMs: REAPER_DEFAULTS.killGraceMs,
    verifyWaitMs: REAPER_DEFAULTS.verifyWaitMs,
    errors,
  };

  /**
   * Consume the value of `--flag <value>`; records an error when it is absent.
   * @param {string} flag @param {number} i @returns {string|null}
   */
  const valueAt = (flag, i) => {
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) {
      errors.push(`missing value for ${flag}`);
      return null;
    }
    return value;
  };

  /**
   * A count of seconds/milliseconds: finite and non-negative. A `NaN` here
   * would reach `runOrphanScan` as a threshold that compares false against
   * everything — a silently disarmed gate, which is why it is an error and
   * never a fallback to the default.
   * @param {string} flag @param {string} raw @returns {number|null}
   */
  const numberFrom = (flag, raw) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      errors.push(`${flag} expects a non-negative number, got ${JSON.stringify(raw)}`);
      return null;
    }
    return n;
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case '--help':
      case '-h':
        out.help = true;
        break;
      case '--json':
        out.json = true;
        break;
      case '--repo-root': {
        const value = valueAt(arg, i);
        if (value !== null) { out.repoRoot = value; i += 1; }
        break;
      }
      case '--mode': {
        const value = valueAt(arg, i);
        if (value === null) break;
        i += 1;
        if (value !== 'report' && value !== 'kill') {
          errors.push(`--mode expects report|kill, got ${JSON.stringify(value)}`);
          break;
        }
        out.mode = value;
        break;
      }
      case '--min-age-seconds':
      case '--kill-grace-ms':
      case '--verify-wait-ms': {
        const value = valueAt(arg, i);
        if (value === null) break;
        i += 1;
        const n = numberFrom(arg, value);
        if (n === null) break;
        if (arg === '--min-age-seconds') out.minAgeSeconds = n;
        else if (arg === '--kill-grace-ms') out.killGraceMs = n;
        else out.verifyWaitMs = n;
        break;
      }
      default:
        errors.push(`unknown argument: ${arg}`);
    }
  }

  // `kill` is the ONLY value that disarms the dry run — same direction as
  // `runOrphanScan`'s own `dryRun = true` default: a caller that mistypes the
  // mode scans and reports, it does not signal. (A rejected `--mode` value
  // already left `mode` at `report`, so this stays `true` there too.)
  out.dryRun = out.mode !== 'kill';
  return out;
}

/** `--help` text. Exit codes documented here are the ones the tail returns. */
const REAPER_HELP_TEXT = `orphan-reaper.mjs — scan for orphaned read-only gate processes (#1425 Teil B)

USAGE
  node scripts/lib/orphan-reaper.mjs [options]

DESCRIPTION
  Runs ONE orphan scan: ps -> decide -> (with --mode kill) re-verify identity
  against a fresh snapshot -> kill the process group -> audit. Candidates are a
  CONJUNCTION: recorded in this repo's gate-process ledger, PPID 1, older than
  --min-age-seconds, a read-only gate command, and an identity that still
  verifies. Spawned detached by hooks/on-stop.mjs and
  hooks/post-tool-batch-wave-signal.mjs; runnable by hand for diagnosis.

OPTIONS
  --repo-root <path>        Repo whose ledger, audit and marker are used
                            (default: cwd).
  --mode report|kill        report = dry run, signals nothing (default);
                            kill = send the SIGTERM/SIGKILL ladder.
  --min-age-seconds <n>     Minimum elapsed time before a process is reapable
                            (default: ${REAPER_DEFAULTS.minAgeSeconds}).
  --kill-grace-ms <n>       Grace between SIGTERM and SIGKILL
                            (default: ${REAPER_DEFAULTS.killGraceMs}).
  --verify-wait-ms <n>      Wait before re-measuring the effect
                            (default: ${REAPER_DEFAULTS.verifyWaitMs}).
  --json                    Emit the full scan result as one JSON object.
  --help, -h                Show this help and exit.

EXIT CODES
  0  the scan ran (0 candidates is a normal, successful scan)
  2  usage error, or a degraded scan that measured nothing (\`skipped\`)
`;

/**
 * CLI body: one scan, one line (or one JSON object) of output.
 *
 * A degraded scan — `skipped: 'ps-failed' | 'ledger-unreadable' | …` — exits 2,
 * not 0: it measured NOTHING, and an exit 0 there is exactly the "missing
 * measurement looks like a zero" shape this module refuses everywhere else.
 * The detached hook child ignores the code; a human or a CI caller does not.
 *
 * @param {string[]} argv  `process.argv.slice(2)`
 * @returns {Promise<number>} process exit code
 */
async function mainCli(argv) {
  const cli = parseReaperCliArgs(argv);

  if (cli.help) {
    process.stdout.write(REAPER_HELP_TEXT);
    return 0;
  }
  if (cli.errors.length > 0) {
    for (const message of cli.errors) process.stderr.write(`orphan-reaper: ${message}\n`);
    process.stderr.write('Run with --help for usage.\n');
    return 2;
  }

  const repoRoot = cli.repoRoot ?? process.cwd();
  let result;
  try {
    result = await runOrphanScan({
      repoRoot,
      dryRun: cli.dryRun,
      minAgeSeconds: cli.minAgeSeconds,
      killGraceMs: cli.killGraceMs,
      verifyWaitMs: cli.verifyWaitMs,
    });
  } catch (err) {
    // runOrphanScan carries a NO-THROW contract; this catch exists so a broken
    // contract surfaces as a tool error instead of an unhandled rejection.
    process.stderr.write(`orphan-reaper: scan failed — ${err?.message ?? String(err)}\n`);
    return 2;
  }

  if (cli.json) {
    process.stdout.write(`${JSON.stringify({ repoRoot, mode: cli.mode, ...result })}\n`);
  } else {
    process.stdout.write(
      `orphan-reaper: scanned=${result.scanned} candidates=${result.candidates.length} `
      + `reported=${result.reported.length} killed=${result.killed.length} `
      + `malformed=${result.malformed} mode=${cli.mode}`
      + `${result.skipped ? ` skipped=${result.skipped}` : ''}\n`,
    );
  }
  return result.skipped ? 2 : 0;
}

// Entry guard: a bare `import()` of this module must do NOTHING — both trigger
// hooks import it for `scanMarkerPath`/`shouldScanNow` on a hot path. Written
// in the one symlink-safe form `scripts/lib/validate/check-entry-guard.mjs`
// and `check-hook-entry-guards.mjs` accept.
//
// `process.exitCode` rather than `process.exit()`: `--json` carries the whole
// result, whose `rejected` array materialises every PPID-1 row not in the
// ledger — measured 2026-09-22 on this host, 40.224 bytes for 834 processes,
// the same order as the 64 KiB pipe buffer above which `process.exit()`
// DISCARDS the pending write and turns a full result into a truncated one.
if (isMainModule(import.meta.url)) {
  process.exitCode = await mainCli(process.argv.slice(2));
}
