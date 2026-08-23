/**
 * issue-budget.mjs — per-session issue-creation cap: state, exemptions, verdict.
 *
 * WHY: measured on the private instance over four weeks, sessions created 1784
 * issues against 1285 closed (net +499), with a median inter-creation gap of
 * 2.6 s and 62 % of creations inside bursts of >= 5 per minute. The pre-existing
 * `discovery-severity-threshold` / `discovery-confidence-threshold` keys cannot
 * bound that: they filter individual FINDINGS by quality (and the `low` default
 * filters nothing), they are only consulted in skill prose, and the biggest
 * producers — session-end carryover filing, plan issue creation,
 * `scripts/lib/spiral-carryover.mjs` — never read them at all.
 *
 * This module is the single decision point for BOTH producer paths:
 *   - shell path:        `hooks/pre-bash-issue-budget.mjs` (PreToolUse/Bash)
 *   - programmatic path: `scripts/lib/spiral-carryover.mjs` `runCli()`
 *
 * EXEMPTIONS ARE LOAD-BEARING. `skills/session-end/SKILL.md` carries two
 * standing promises the cap must not break:
 *   - `:319` — "SPIRAL / FAILED agent carryover → auto-carry candidate …
 *     (non-deselectable)"
 *   - `:1113` — "ALWAYS create issues for unfinished PLANNED work … nothing
 *     planned-but-unfinished is 'remembered' without one."
 * A cap that silently swallowed a SPIRAL carryover would turn a hard promise
 * into a lie, so the carryover class plus `priority::critical` bypass the cap
 * entirely (they are counted for observability, but never blocked).
 *
 * Stdlib only — the hook path must stay cheap enough to run on every Bash call.
 */

import { digestSha256Short } from './crypto-digest-utils.mjs';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { writeJsonAtomicSync } from './io.mjs';
import { resolveInstructionFile } from './common.mjs';
import { _parseIssueBudget } from './config/issue-budget.mjs';

/**
 * Legacy single-slot counter file, relative to the repo root.
 *
 * Kept as the path for IDENTITY-LESS callers only, and as the one-time
 * migration source for a session whose spend was recorded before #1141.
 */
export const BUDGET_STATE_REL = '.orchestrator/runtime/issue-budget.json';

/** Directory holding the per-session counter files, relative to the repo root. */
export const BUDGET_STATE_DIR_REL = '.orchestrator/runtime/issue-budget';

/**
 * Relative path of the counter file for one accounting session (#1141).
 *
 * WHY per session and not one file: the counter used to be ONE slot per
 * WORKING COPY, keyed by whichever `sessionId` happened to write last, and
 * `readBudgetState` zeroes the state whenever the file's `sessionId` differs
 * from the reader's. Two concurrent sessions in one working copy therefore
 * alternately reset each other's counter and BOTH ran with the cap silently
 * off — measured 2026-08-23, where the live file was owned by a session that
 * had started 11 h before the one reading it. Session identity belongs in the
 * FILE NAME, not in a field the next writer overwrites.
 *
 * The name is a truncated SHA-256 rather than the id itself because session
 * ids are operator/host-supplied strings: a semantic id contains `/`-free but
 * unbounded text, and a raw id is a UUID. Hashing gives a fixed-length,
 * filesystem-safe, path-traversal-free name for both shapes. 16 hex chars
 * (64 bits) is far beyond the handful of sessions that ever share one working
 * copy; revisit only if a repo ever needs the id to be readable from the name
 * (it never has — every reader already knows which session it is).
 *
 * An identity-less caller (`null`/empty) keeps the legacy flat path: it never
 * reads and never persists (see `readBudgetState` / `chargeIssueBudget`), so
 * it needs a stable path only to NAME the store in messages.
 *
 * @param {string|null|undefined} sessionId accounting session key
 * @returns {string} repo-relative path
 */
export function budgetStateRel(sessionId) {
  const key = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
  if (key === null) return BUDGET_STATE_REL;
  const digest = digestSha256Short(key, { length: 16 });
  return `${BUDGET_STATE_DIR_REL}/${digest}.json`;
}

/**
 * Resolve the accounting key for a native session id.
 *
 * A semantic id is an accounting continuity bridge only after the native id
 * proves that `current-session.json` belongs to this invocation. This neither
 * establishes lock ownership nor bridges a host rotation that changes both ids.
 *
 * @param {string|null|undefined} candidateRawSessionId native hook/env session id
 * @param {unknown} currentSession parsed `.orchestrator/current-session.json`
 * @returns {string|null} semantic key for a verified pair, otherwise raw key
 */
export function resolveIssueBudgetSessionId(candidateRawSessionId, currentSession) {
  const rawSessionId =
    typeof candidateRawSessionId === 'string' && candidateRawSessionId.length > 0
      ? candidateRawSessionId
      : null;
  if (
    rawSessionId === null ||
    !currentSession ||
    typeof currentSession !== 'object' ||
    Array.isArray(currentSession) ||
    currentSession.session_id !== rawSessionId ||
    typeof currentSession.semantic_session_id !== 'string' ||
    currentSession.semantic_session_id.length === 0
  ) {
    return rawSessionId;
  }
  return currentSession.semantic_session_id;
}

/**
 * Commands whose issue creation MUST NOT be blocked, with the reason recorded
 * for the stderr trace and for the overflow bookkeeping.
 *
 * Each entry is `[regex, reason]`. Both the scoped (`priority::critical`) and
 * the legacy unscoped (`priority:critical`) spellings are accepted: the label
 * migration to scoped `priority::` runs alongside this change and a
 * half-migrated producer must not lose its exemption mid-flight.
 */
const EXEMPT_RULES = [
  [/priority::?critical\b/i, 'priority::critical'],
  // `[Carryover] [SPIRAL] …` / `[Carryover] [FAILED] …` — the exact title
  // template `createSpiralCarryoverIssue` emits, plus the `type::carryover`
  // and bare `carryover` labels used by the vault/drift/docs strict fallbacks.
  [/\[(SPIRAL|FAILED)\]/, 'spiral-failed-auto-carry'],
  [/\[Carryover\]/i, 'carryover-class'],
  [/\btype::?carryover\b/i, 'carryover-class'],
  [/(^|[\s,"'=])carryover([\s,"']|$)/i, 'carryover-class'],
  [/(^|[\s,"'=])broken-window([\s,"']|$)/i, 'broken-window-closure'],
  [/\[Backlog-Sammel\]/i, 'overflow-collector'],
];

/**
 * Decide whether an issue-create command bypasses the cap.
 *
 * @param {string} command — the full shell command (or a reconstructed argv join)
 * @returns {{ exempt: boolean, reason: string|null }}
 */
export function classifyExemption(command) {
  if (typeof command !== 'string' || command.length === 0) {
    return { exempt: false, reason: null };
  }
  for (const [re, reason] of EXEMPT_RULES) {
    if (re.test(command)) return { exempt: true, reason };
  }
  return { exempt: false, reason: null };
}

/**
 * Load the `issue-budget` config from the repo's instruction file
 * (CLAUDE.md / AGENTS.md). Reads only that one file and only that one block —
 * `parseSessionConfig()` is deliberately NOT used here so the hook path does
 * not pay for host-path resolution and owner.yaml I/O on every Bash call.
 *
 * @param {string} repoRoot
 * @returns {{ "max-per-session": number, mode: string, overflow: string }}
 */
export function loadIssueBudgetConfig(repoRoot) {
  const defaults = { 'max-per-session': 12, mode: 'strict', overflow: 'collect-issue' };
  try {
    const resolved = resolveInstructionFile(repoRoot);
    if (!resolved) return defaults;
    return _parseIssueBudget(readFileSync(resolved.path, 'utf8'));
  } catch {
    return defaults;
  }
}

/**
 * Absolute path of the runtime counter file for one session in a repo.
 *
 * @param {string} repoRoot
 * @param {string|null} [sessionId] accounting session key; omitted/empty
 *   yields the legacy identity-less flat path.
 * @returns {string}
 */
export function budgetStatePath(repoRoot, sessionId = null) {
  return path.join(repoRoot, budgetStateRel(sessionId));
}

/**
 * Coerce a parsed counter file into a state object, or `null` when it does not
 * belong to `accountingSessionId`.
 *
 * The owner check survives the move to per-session files: the file NAME now
 * carries identity, but a hand-edited, hash-colliding or hand-copied file must
 * still not hand its spend to a different session.
 *
 * @param {unknown} data
 * @param {string} accountingSessionId
 * @returns {{ sessionId: string, count: number, exempt: number, overflow: object[] }|null}
 */
function _coerceState(data, accountingSessionId) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (data.sessionId !== accountingSessionId) return null;
  return {
    sessionId: accountingSessionId,
    count: Number.isInteger(data.count) && data.count >= 0 ? data.count : 0,
    exempt: Number.isInteger(data.exempt) && data.exempt >= 0 ? data.exempt : 0,
    overflow: Array.isArray(data.overflow) ? data.overflow : [],
  };
}

/**
 * Read a counter file and coerce it, swallowing every I/O and parse error
 * (fail-open: an unreadable ledger must never block a creation).
 *
 * @param {string} file
 * @param {string} accountingSessionId
 * @returns {object|null}
 */
function _readStateFile(file, accountingSessionId) {
  if (!existsSync(file)) return null;
  try {
    return _coerceState(JSON.parse(readFileSync(file, 'utf8')), accountingSessionId);
  } catch {
    return null;
  }
}

/**
 * Read the counter file. A missing, malformed, or foreign-session file yields
 * a fresh zeroed state for `sessionId` — the counter is per session by
 * construction, so a new session never inherits the previous session's spend.
 *
 * An identity-less invocation always gets a fresh state and never reads a
 * persisted budget. It therefore cannot provide durable per-session continuity,
 * but avoiding cross-session budget and overflow attribution wins over a
 * continuity guess without a verified native identity.
 *
 * The counter file is per session since #1141, but an identity-less charge
 * still must never PERSIST its fresh state — it would land on the shared
 * legacy path and, before the split, silently zeroed a live session's count
 * and deleted its parked overflow records. `chargeIssueBudget` enforces that
 * write-side half.
 *
 * MIGRATION (one-time, read-only): a session that started before the per-session
 * split has its spend in the legacy flat file. When no per-session file exists
 * yet and the legacy file still names THIS session, seed from it — otherwise the
 * split itself would hand every in-flight session a fresh cap, which is the very
 * failure it exists to remove. The legacy file is never written back; the first
 * charge after the seed persists to the per-session path.
 *
 * @param {string} repoRoot
 * @param {string|null} sessionId
 * @returns {{ sessionId: string|null, count: number, exempt: number, overflow: object[] }}
 */
export function readBudgetState(repoRoot, sessionId) {
  const accountingSessionId =
    typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
  const fresh = { sessionId: accountingSessionId, count: 0, exempt: 0, overflow: [] };
  if (accountingSessionId === null) return fresh;

  const ownFile = budgetStatePath(repoRoot, accountingSessionId);
  const own = _readStateFile(ownFile, accountingSessionId);
  if (own) return own;
  // A present-but-unusable own file is a fail-open fresh state, NOT a reason to
  // fall back to the legacy slot — the migration seed applies only before the
  // session has a file of its own.
  if (existsSync(ownFile)) return fresh;

  return _readStateFile(path.join(repoRoot, BUDGET_STATE_REL), accountingSessionId) ?? fresh;
}

/**
 * Persist the counter file for `state.sessionId`. Best-effort: a write failure
 * never blocks a creation (fail-open), it only means the count is
 * under-reported.
 *
 * The target path is derived from `state.sessionId`, so a state object can only
 * ever be written into its OWN session's slot. `writeJsonAtomicSync` mkdir -p's
 * the containing directory (`io.mjs#atomicWriteWithBackup`), which is what
 * creates `.orchestrator/runtime/issue-budget/` on first use.
 *
 * @param {string} repoRoot
 * @param {object} state
 * @returns {boolean} true on success
 */
export function writeBudgetState(repoRoot, state) {
  const res = writeJsonAtomicSync(budgetStatePath(repoRoot, state?.sessionId ?? null), state, {
    tmpPrefix: '.issue-budget',
  });
  return res.ok === true;
}

/**
 * Charge one issue creation against the session budget and return the verdict.
 *
 * Decision table:
 *   mode `off`                          → `{ decision: 'off' }`, no state written
 *   exempt command                      → `{ decision: 'exempt' }`, `exempt` counter++
 *   count < max                         → `{ decision: 'allow' }`, `count`++
 *   count >= max, mode `warn`           → `{ decision: 'warn' }`, `count`++ (creation proceeds)
 *   count >= max, mode `strict`         → `{ decision: 'block' }`, overflow record appended
 *
 * In `strict` the blocked creation is NOT counted (it never happened); the
 * request is parked in `overflow[]` so session-end can file exactly one
 * collector issue instead of losing the item.
 *
 * @param {{
 *   repoRoot: string,
 *   sessionId?: string|null,
 *   command: string,
 *   title?: string|null,
 *   config?: { "max-per-session": number, mode: string, overflow: string },
 *   now?: string,
 * }} opts
 * @returns {{
 *   decision: 'off'|'exempt'|'allow'|'warn'|'block',
 *   count: number,
 *   max: number,
 *   mode: string,
 *   overflowSink: string,
 *   overflowPath: string,
 *   overflowCount: number,
 *   reason?: string|null,
 * }}
 */
export function chargeIssueBudget({
  repoRoot,
  sessionId = null,
  command,
  title = null,
  config,
  now = new Date().toISOString(),
}) {
  const cfg = config ?? loadIssueBudgetConfig(repoRoot);
  const max = cfg['max-per-session'];
  const mode = cfg.mode;
  const overflowSink = cfg.overflow;
  const accountingSessionId =
    typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
  // Per-session store (#1141) — the path an operator or session-end must open
  // to find THIS session's parked overflow, so the verdict has to name the
  // session's own slot, not the directory or the legacy flat file.
  const overflowPath = budgetStatePath(repoRoot, accountingSessionId);

  const base = { max, mode, overflowSink, overflowPath };

  if (mode === 'off') {
    return { ...base, decision: 'off', count: 0, overflowCount: 0, reason: null };
  }

  const state = readBudgetState(repoRoot, accountingSessionId);
  state.sessionId = accountingSessionId;

  // An identity-less charge has no key to account under, so it must not touch
  // the SHARED counter file at all. Writing its fresh state would reset a live
  // session's count to 0 AND drop its parked overflow[] entries — breaking the
  // strict cap (a single identity-less call clears it) and session-end's
  // "nothing is lost" promise. Read-side isolation alone does not cover this.
  const persist = (next) =>
    accountingSessionId === null ? false : writeBudgetState(repoRoot, next);

  const { exempt, reason } = classifyExemption(command);
  if (exempt) {
    state.exempt += 1;
    persist(state);
    return {
      ...base,
      decision: 'exempt',
      count: state.count,
      overflowCount: state.overflow.length,
      reason,
    };
  }

  if (state.count < max) {
    state.count += 1;
    persist(state);
    return { ...base, decision: 'allow', count: state.count, overflowCount: state.overflow.length, reason: null };
  }

  if (mode === 'warn') {
    state.count += 1;
    persist(state);
    return { ...base, decision: 'warn', count: state.count, overflowCount: state.overflow.length, reason: null };
  }

  // strict — park the request, do not count it.
  state.overflow.push({
    title: title ?? null,
    command: String(command).slice(0, 500),
    at: now,
  });
  persist(state);
  return {
    ...base,
    decision: 'block',
    count: state.count,
    overflowCount: state.overflow.length,
    reason: null,
  };
}

/**
 * Human-readable block message. Shared by the hook (stderr + deny JSON) and the
 * programmatic path so an agent sees the same instruction either way.
 *
 * @param {{ count: number, max: number, overflowPath: string, overflowSink: string, overflowCount: number }} v
 * @returns {string}
 */
export function formatBlockReason(v) {
  const sink =
    v.overflowSink === 'vault-note'
      ? 'a note under `vault/00-inbox/`'
      : 'ONE collector issue `[Backlog-Sammel] <session-id>, N zurückgestellte Punkte`';
  return [
    `issue-budget: session cap reached — ${v.count}/${v.max} issues already created.`,
    `This request was NOT created. It is parked as overflow entry #${v.overflowCount} in:`,
    `  ${v.overflowPath}`,
    `session-end Phase 5 will fold all overflow entries into ${sink}. Nothing is lost.`,
    `Exempt from the cap: priority::critical, the carryover class (SPIRAL/FAILED, [Carryover]),`,
    `and broken-window closure issues — those are never deferred.`,
    `To raise the cap for this repo, edit \`issue-budget.max-per-session\` in the Session Config;`,
    `\`mode: warn\` reports without blocking, \`mode: off\` disables the gate.`,
  ].join('\n');
}
