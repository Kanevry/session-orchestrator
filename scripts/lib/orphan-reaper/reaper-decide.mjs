/**
 * orphan-reaper/reaper-decide.mjs — the PURE half of the reaper: which processes
 * are reapable orphans, decided from a `ps` snapshot and the gate-process ledger.
 *
 * ## Why PPID 1 is necessary and never sufficient
 *
 * Measured on this host 2026-09-21: 538 of 784 processes (68.6%) have PPID 1 —
 * on macOS launchd is the parent of nearly everything. A reaper keyed on PPID 1
 * alone would be a weapon pointed at the operating system. So a candidate is a
 * CONJUNCTION: in our own gate-process ledger, PPID 1, old enough, a read-only
 * gate command, and an identity that still verifies against the ledger record.
 *
 * ## Coverage: the ledger is joined by PID **and** by PGID
 *
 * The binding `ps` format (`PS_ARGS` in `ps-snapshot.mjs`) publishes `pgid`, so a row joins the
 * ledger either as the recorded LEADER (`row.pid === record.pid`) or as any
 * member of the recorded GROUP (`row.pgid === record.pgid`). The group join is
 * what covers the measured grandchild case: `npm run typecheck` (82507) spawns
 * `node scripts/typecheck.mjs` (82591) which spawns `tsgo`, all three in pgid
 * 82507 — when only the leader dies, 82591 sits at PPID 1 and the ledger knows
 * its group but not its pid. Named ceiling (BV-004): the join FINDS every
 * member, but a member is only reaped when its own command passes the read-only
 * allowlist — `tsgo`/`vitest` descendants are, a repo-local `node scripts/…`
 * runner is NOT and is reported as `not-read-only` (measured 2026-09-22); the
 * group still dies through its allowlisted sibling. Revisit trigger: an orphaned
 * node runner that outlives every allowlisted sibling.
 *
 * A non-leader cannot be identified the leader's way: its start time is its own
 * and its command line is not the recorded one. Its identity is therefore
 * {@link verifyGroupMemberIdentity} — born no earlier than its group leader
 * (a descendant is never older than the process that forked it), plus either
 * the record's signature token or a command name the read-only allowlist knows.
 *
 * The KILL TARGET is the group in both cases (`-pgid`), so one record still
 * covers its whole group with one ladder.
 *
 * Named ceiling (BV-004): a process that `setsid`-ed out of its group carries no
 * ledger identity in this format and is not a candidate BY DESIGN (PRD
 * § Umfangsgrenze: orphan-confidence via PPID history is Stufe 2 / C4). Revisit
 * if such a case is ever observed for a process the ledger DID record.
 */

import { verifyProcessIdentity } from '../process-group.mjs';
import { REAPER_DEFAULTS } from './defaults.mjs';

/** @typedef {import('./ps-snapshot.mjs').PsRow} PsRow */

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
 * Matched per STATEMENT (see {@link isReadOnlyCommand}), with a `(^|[\s/])`
 * boundary so both `tsgo --noEmit` and `/opt/homebrew/bin/tsgo --noEmit` and
 * `npx tsgo` hit.
 *
 * `eslint` carries a negative lookahead for its WRITING flags: `eslint . --fix`
 * is this repo's own `lint:fix` script and rewrites the working copy, so it is
 * not re-runnable at will and has no business on a read-only allowlist.
 */
export const READ_ONLY_COMMAND_PATTERNS = Object.freeze([
  /(^|[\s/])tsgo(\s|$)/,
  /(^|[\s/])tsc(\s|$)/,
  /(^|[\s/])vitest(\s|$)/,
  /(^|[\s/])eslint(?!\S)(?!.*\s--(fix|fix-dry-run|output-file)(\s|=|$))/,
  /(^|[\s/])node\s+\S*vitest/,
  /(^|[\s/])npm\s+(run\s+)?(test|typecheck|lint)(\s|$)/,
]);

/**
 * Shell operators that separate one STATEMENT from the next in a `ps` `args`
 * line. `ps` prints argv joined by spaces with the quoting already stripped, so
 * a quote-aware lexer (`command-blocker.mjs` `splitChainSegments`) would have
 * nothing left to be aware of here — and it would put 2.190 lines into the
 * static import closure of a module that is destined for a hot-path hook
 * (#1432) and lazily imports even `events.mjs` for that reason.
 */
const STATEMENT_SEPARATOR_RE = /\s*(?:&&|\|\||[;|&])\s*/;

/**
 * True when EVERY statement of `args` is a read-only gate command per
 * {@link READ_ONLY_COMMAND_PATTERNS}.
 *
 * Per-statement and ALL, not the whole string and ANY: judged over the whole
 * line, `sh -c npm run build && npm test` matches the `npm test` pattern as a
 * SUBSTRING and a build — which writes — is allowlisted by the read-only half
 * of its own command. This is the destructive-guard's per-statement rule
 * (`.claude/rules/guard-design.md` § "Widening a matcher without narrowing its
 * bypass"), applied in the other direction: there one appended statement lifts
 * a block, here one appended statement must be able to REVOKE a permission.
 *
 * An empty statement (a trailing `&&`, a doubled separator) is skipped rather
 * than counted as a failure; a line with no statement at all is not read-only.
 *
 * @param {string} args
 * @param {readonly RegExp[]} [patterns]
 * @returns {boolean}
 */
export function isReadOnlyCommand(args, patterns = READ_ONLY_COMMAND_PATTERNS) {
  const s = typeof args === 'string' ? args : '';
  if (s.trim().length === 0) return false;
  const statements = s.split(STATEMENT_SEPARATOR_RE).filter((part) => part.trim().length > 0);
  if (statements.length === 0) return false;
  return statements.every((statement) => patterns.some((re) => re.test(statement)));
}

/**
 * Identity check for a NON-LEADER member of a recorded process group — PURE.
 *
 * {@link verifyProcessIdentity} cannot serve here: it compares the row's start
 * time against the LEADER's and the row's first token against the LEADER's
 * signature, and a descendant matches neither (`node scripts/typecheck.mjs` was
 * forked by `npm run typecheck` seconds after it).
 *
 * Both checks must hold, and both are one-sided on purpose:
 *  1. NOT OLDER than the group leader, within `toleranceMs`. A process that
 *     existed BEFORE the leader cannot be its descendant, so an older row in the
 *     same pgid is a recycled group id, never a grandchild.
 *  2. Either the leader's signature token prefixes the row's command (the
 *     descendant re-execs the same binary — `npm` → `npm`), or the row's command
 *     is itself on the read-only allowlist (`tsgo`, `node …vitest` — NOT a
 *     repo-local `node scripts/typecheck.mjs`, see the module head).
 *
 * @param {PsRow|null} row
 * @param {import('../process-group.mjs').GateProcessRecord} record
 * @param {object} [opts]
 * @param {number} [opts.nowMs]
 * @param {number} [opts.toleranceMs]
 * @param {readonly RegExp[]} [opts.readOnlyPatterns]
 * @returns {{match: boolean, reason: 'ok'|'gone'|'start-time-mismatch'|'signature-mismatch'}}
 */
export function verifyGroupMemberIdentity(row, record, {
  nowMs = Date.now(),
  toleranceMs = 2000,
  readOnlyPatterns = READ_ONLY_COMMAND_PATTERNS,
} = {}) {
  if (!row || typeof row !== 'object') return { match: false, reason: 'gone' };
  const etimeSeconds = typeof row.etimeSeconds === 'number' && Number.isFinite(row.etimeSeconds)
    ? row.etimeSeconds
    : null;
  // An unmeasurable age is a refusal, never a pass — the same fail-closed
  // direction `verifyProcessIdentity` takes for the leader.
  if (etimeSeconds === null) return { match: false, reason: 'start-time-mismatch' };
  const observedStart = nowMs - etimeSeconds * 1000;
  const leaderStart = Number(record?.startTime);
  if (!Number.isFinite(leaderStart)) return { match: false, reason: 'start-time-mismatch' };
  if (observedStart < leaderStart - toleranceMs) {
    return { match: false, reason: 'start-time-mismatch' };
  }

  const args = typeof row.args === 'string' ? row.args : '';
  const token = signatureTokenOf(record?.commandSignature);
  const firstToken = args.trim().split(/\s+/)[0] ?? '';
  const tokenOk = token.length > 0 && firstToken === token;
  if (!tokenOk && !isReadOnlyCommand(args, readOnlyPatterns)) {
    return { match: false, reason: 'signature-mismatch' };
  }
  return { match: true, reason: 'ok' };
}

/**
 * The command-name half of a command signature (`npm:6f1c…` → `npm`).
 * A local four-liner rather than an import: `process-group.mjs` keeps its own
 * copy private, and re-exporting it for one caller would widen that module's
 * interface for no second consumer.
 *
 * @param {unknown} signature
 * @returns {string}
 */
function signatureTokenOf(signature) {
  const s = typeof signature === 'string' ? signature : '';
  const i = s.lastIndexOf(':');
  return i === -1 ? s : s.slice(0, i);
}

/**
 * Decide which processes are reapable orphans — PURE.
 *
 * No I/O, no signal, no clock of its own: `nowMs` is an argument. The only
 * imports it reaches are {@link verifyProcessIdentity} and
 * {@link verifyGroupMemberIdentity}, both themselves pure.
 *
 * Exactly ONE verdict per examined row, at a FIXED priority, so a row can never
 * appear twice and a trigger is never ambiguous:
 *
 *   1. not in the ledger            → `rejected: not-in-ledger`
 *   2. record with `pgid !== pid`   → `rejected: pgid-mismatch`
 *   3. PPID !== 1                   → `rejected: has-parent`
 *   4. younger than `minAgeSeconds` → `rejected: too-young`
 *   5. no `sessionId` on the record → `reported: unattributed`          (never killed)
 *   6. foreign session, live or of unmeasurable liveness
 *                                   → `reported: foreign-live-session`
 *                                     / `foreign-session-liveness-unknown`  (never killed)
 *   7. not a read-only command      → `reported: not-read-only`         (never killed)
 *   8. identity does not verify     → `rejected: identity-mismatch | signature-mismatch`
 *   9. otherwise                    → `candidates` with `trigger: 'orphan-ppid1'`
 *
 * Step 2 is a LEDGER-INTEGRITY rejection, not a property of the row: under
 * `detached: true` the leader IS its own group, so `pgid === pid` is the
 * documented invariant (`process-group.mjs` — "the child calls setsid, so it IS
 * its own group leader"). A record violating it describes a group this module
 * did not create, and its `pgid` is the value that gets negated and signalled.
 *
 * Step 5 is fail-closed and was inert until 2026-09-22: `sessionId` was `null`
 * in 377 of 377 live records because the gate runner passed none, and a null
 * owner was silently read as "nobody's, therefore mine". An unattributed process
 * is REPORTED — it is not evidence of ownership in either direction.
 *
 * Step 6 precedes step 7 on purpose: a foreign live session's process is
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
 * @param {import('../process-group.mjs').GateProcessRecord[]} ledgerRecords
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

  /** Leader index: the pid the ledger recorded. @type {Map<number, object>} */
  const byPid = new Map();
  /** Group index: every member of a recorded group joins through this.
   *  @type {Map<number, object>} */
  const byPgid = new Map();
  for (const rec of records) {
    if (!rec || typeof rec.pid !== 'number') continue;
    byPid.set(rec.pid, rec);
    // First record wins for a pgid: a recycled group id would otherwise let a
    // newer record claim an older group's members.
    if (typeof rec.pgid === 'number' && !byPgid.has(rec.pgid)) byPgid.set(rec.pgid, rec);
  }

  const candidates = [];
  const reported = [];
  const rejected = [];

  for (const row of rows) {
    // A `pid` hit is the LEADER; a `pgid` hit is any other member of its group
    // (the measured grandchild case — see the module header). The leader wins,
    // so a row is never judged by the weaker of the two identities.
    const leaderRecord = byPid.get(row.pid) ?? null;
    const record = leaderRecord
      ?? (typeof row.pgid === 'number' ? byPgid.get(row.pgid) ?? null : null);
    const isLeader = leaderRecord !== null;
    const orphanShaped = row.ppid === 1;

    if (!record) {
      if (orphanShaped) {
        rejected.push({
          pid: row.pid, ppid: row.ppid, ageSeconds: row.etimeSeconds, reason: 'not-in-ledger',
        });
      }
      continue;
    }

    const recordSessionId = typeof record.sessionId === 'string' && record.sessionId.length > 0
      ? record.sessionId
      : null;
    const base = {
      pid: row.pid,
      pgid: record.pgid,
      ppid: row.ppid,
      isLeader,
      ageSeconds: row.etimeSeconds,
      rssKb: row.rssKb,
      cpuPct: row.cpuPct,
      commandSignature: record.commandSignature ?? null,
      // Normalised to `null`: an empty-string owner is an ABSENT owner, and
      // leaving `''` here would let a downstream truthiness check read it as one.
      sessionId: recordSessionId,
    };

    // Ledger integrity before anything else: `record.pgid` is the value that
    // gets NEGATED and signalled, and `pgid === pid` is the invariant every
    // record this module writes satisfies.
    if (record.pgid !== record.pid) {
      rejected.push({ ...base, reason: 'pgid-mismatch' });
      continue;
    }

    if (!orphanShaped) {
      rejected.push({ ...base, reason: 'has-parent' });
      continue;
    }
    if (row.etimeSeconds < minAgeSeconds) {
      rejected.push({ ...base, reason: 'too-young', threshold: { minAgeSeconds } });
      continue;
    }

    if (recordSessionId === null) {
      // Fail-closed: an unowned record is not an unowned PROCESS. Report it and
      // let the operator (or a fixed producer) decide.
      reported.push({ ...base, reason: 'unattributed' });
      continue;
    }
    const foreignSessionId = recordSessionId !== ownSessionId ? recordSessionId : null;
    if (foreignSessionId !== null) {
      if (peers === null) {
        // Unmeasurable liveness → report, never reap. The only foreign process
        // this function reaps is one whose session a SUCCESSFUL probe proved dead.
        reported.push({ ...base, reason: 'foreign-session-liveness-unknown' });
        continue;
      }
      if (peers.has(foreignSessionId)) {
        // `args` ONLY for a command the allowlist already cleared — the same
        // rule `ARGS_HEAD_CHARS` (`reaper-audit.mjs`) states, applied at the source rather than at
        // the audit writer, so a foreign dev server's command line (paths,
        // tokens) never enters the result in the first place.
        reported.push({
          ...base,
          ...(isReadOnlyCommand(row.args, readOnlyPatterns) ? { args: row.args } : {}),
          reason: 'foreign-live-session',
        });
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

    const identity = isLeader
      ? verifyProcessIdentity(
        row.pid,
        { startTime: record.startTime, commandSignature: record.commandSignature },
        { snapshotLine: row, nowMs, toleranceMs: identityToleranceMs },
      )
      : verifyGroupMemberIdentity(row, record, {
        nowMs, toleranceMs: identityToleranceMs, readOnlyPatterns,
      });
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
