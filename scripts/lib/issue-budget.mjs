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

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { writeJsonAtomicSync } from './io.mjs';
import { resolveInstructionFile } from './common.mjs';
import { _parseIssueBudget } from './config/issue-budget.mjs';

/** Runtime counter file, relative to the repo root. */
export const BUDGET_STATE_REL = '.orchestrator/runtime/issue-budget.json';

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
 * Absolute path of the runtime counter file for a repo.
 * @param {string} repoRoot
 * @returns {string}
 */
export function budgetStatePath(repoRoot) {
  return path.join(repoRoot, BUDGET_STATE_REL);
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
 * The counter file is SHARED across invocations, so this read-side isolation is
 * only half the contract: an identity-less charge must also never PERSIST its
 * fresh state, or it silently zeroes a live session's count and deletes its
 * parked overflow records. `chargeIssueBudget` enforces that write-side half.
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

  const file = budgetStatePath(repoRoot);
  if (!existsSync(file)) return fresh;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object') return fresh;
    if (data.sessionId !== accountingSessionId) return fresh;
    return {
      sessionId: accountingSessionId,
      count: Number.isInteger(data.count) && data.count >= 0 ? data.count : 0,
      exempt: Number.isInteger(data.exempt) && data.exempt >= 0 ? data.exempt : 0,
      overflow: Array.isArray(data.overflow) ? data.overflow : [],
    };
  } catch {
    return fresh;
  }
}

/**
 * Persist the counter file. Best-effort: a write failure never blocks a
 * creation (fail-open), it only means the count is under-reported.
 *
 * @param {string} repoRoot
 * @param {object} state
 * @returns {boolean} true on success
 */
export function writeBudgetState(repoRoot, state) {
  const res = writeJsonAtomicSync(budgetStatePath(repoRoot), state, {
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
  const overflowPath = budgetStatePath(repoRoot);

  const base = { max, mode, overflowSink, overflowPath };

  if (mode === 'off') {
    return { ...base, decision: 'off', count: 0, overflowCount: 0, reason: null };
  }

  const accountingSessionId =
    typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
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
