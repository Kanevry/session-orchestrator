/**
 * own-session.mjs — "which session am I, and does this shared artefact belong to me?"
 *
 * A working copy is shared; a session is not. Every `.orchestrator/` and
 * `<state-dir>/` artefact in this repo is written into the WORKING COPY, so a
 * second live session reads the first one's files as if they were its own. The
 * damage is always invisible to the writer: a peer's corrective hints briefing
 * this session's fixer (#1058), a peer's `allowedPaths: []` locking this
 * session out of every write (#1082/#1123).
 *
 * This module is the reusable half of that check, split into two pure-ish
 * functions so a caller can resolve identity once and classify many artefacts:
 *
 *   - {@link readOwnSessionIds} — every id that provably names THIS session.
 *   - {@link classifyManifestSession} — own / foreign / unknown for a manifest.
 *
 * Semantics were lifted from the `current-session.json` ownership check in
 * `scripts/lib/quality-gate.mjs` (#1058), which is module-private there and sits
 * behind a module this repo's hook guard-source-loader cannot bind. This is a
 * deliberate re-implementation of the SEMANTICS, not a re-export.
 *
 * **Only what is PROVABLY foreign is foreign.** Every unprovable case returns
 * `'unknown'`, and every caller is expected to treat `'unknown'` exactly as it
 * behaved before this check existed. An ownership check that guesses turns
 * "cannot tell" into a silent feature-off on every harness that exports no
 * session id.
 */

import { readLock } from '../session-lock.mjs';

/**
 * The set of session ids that provably name THIS session — the UNION of every
 * tier, never the first one that answers.
 *
 * Three sources, all read, all merged:
 *
 *   1. `hookInput` — the harness's own statement about the invocation being
 *      handled right now (`session_id` / `sessionId`, plus `parent_session_id`
 *      for a sub-agent invocation, whose coordinator is equally us). The only
 *      tier that is per-INVOCATION rather than per-working-copy.
 *   2. `CLAUDE_CODE_SESSION_ID` — process-scoped, absent on harnesses that
 *      export no session env var.
 *   3. `session.lock` `session_id` / `semantic_session_id` — repo-GLOBAL, and
 *      the identity the WRITER of a manifest uses: `wave-scope.json`'s
 *      `session` field comes from `sessionAttribution()`, which reads this same
 *      lock (`skills/wave-executor/wave-loop.md` § Scope Manifest 1).
 *
 * **Why the union, and not first-tier-wins.** Any id the process can
 * legitimately claim — its own invocation, its harness env, the repo's live
 * lock — names this session; only an id in NONE of them is somebody else's.
 * Gating the tiers made the READER's identity a strict subset of the WRITER's,
 * and three distinct ways of diverging all landed on the same silent failure —
 * the OWN manifest classified `foreign`, so the write gate switched itself off
 * for the whole wave, with an event that reads exactly like correct behaviour:
 *
 *   - **Nested-harness divergence.** The payload `session_id` and
 *     `CLAUDE_CODE_SESSION_ID` disagree in a nested harness — already measured
 *     and documented in `resolveSessionId()` of
 *     `hooks/pre-bash-issue-budget.mjs`: *"stdin still wins: it is the id of
 *     THIS tool call, whereas the env var is the id of the process tree, and
 *     the two differ in a nested harness"*, alongside the measurement that the
 *     env var equals the `session.lock` `session_id` and survives into
 *     subagents. Under tier-gating, the payload alone decided.
 *   - **Sub-agent invocation.** A dispatched agent's own set was
 *     `{subagent-uuid}` while the manifest names the coordinator.
 *     `parent_session_id` is in tier 1 too, but a payload that carries only
 *     `session_id` still hid the coordinator's env/lock ids behind the gate.
 *   - **Peer-owned lock.** A second session that failed to acquire the lock
 *     (`bootstrapLock()` reason `active`, the lock keeps the PEER's id) writes
 *     that peer id into its OWN manifest via `sessionAttribution()`. Its own
 *     hook then read the payload tier, never reached the lock, and disarmed
 *     itself against the manifest it had just written.
 *
 * **The security direction is unchanged: the union only ADDS ids this process
 * actually carries.** A manifest whose id appears in NO tier — not the
 * invocation, not the env, not the lock — still classifies `foreign`, exactly
 * as before; nothing here invents an id or widens what counts as a match.
 *
 * The cost is named rather than hidden, and it points the fail-CLOSED way: when
 * the lock names a peer, that peer's manifest now reads `own`, so we ENFORCE a
 * wave plan that is not ours. That is a visible, actionable deny — the inverse
 * of tier-gating's failure, which was a silent enforcement-off. `unknown` still
 * means unknown: an empty set can only produce `unknown`, never a mismatch.
 *
 * Every value is `.trim()`ed before it enters the set: a whitespace-only env
 * var is truthy and would otherwise enter as a PHANTOM id that matches nothing
 * — which would make every manifest read `foreign` and switch enforcement off
 * (`.claude/rules/development.md` § env-var whitespace trap).
 *
 * Never throws.
 *
 * @param {string} repoRoot — working copy root, for the `session.lock` tier.
 * @param {{ hookInput?: object|null }} [opts]
 * @returns {Set<string>} possibly EMPTY — an empty set means "identity
 *   unresolvable", which {@link classifyManifestSession} treats as `unknown`,
 *   never as a mismatch.
 */
export function readOwnSessionIds(repoRoot, { hookInput = null } = {}) {
  const ids = new Set();
  const add = (value) => {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed) ids.add(trimmed);
  };

  // Source 1 — the harness's statement about THIS invocation.
  if (hookInput && typeof hookInput === 'object') {
    for (const key of ['session_id', 'sessionId', 'parent_session_id']) add(hookInput[key]);
  }

  // Source 2 — process-scoped env var.
  add(process.env.CLAUDE_CODE_SESSION_ID);

  // Source 3 — repo-global lock file (the manifest writer's own identity).
  try {
    const lock = readLock({ repoRoot });
    for (const key of ['session_id', 'semantic_session_id']) add(lock?.[key]);
  } catch {
    /* readLock never throws by contract, but that contract is not ours to trust */
  }
  return ids;
}

/**
 * The ids that name this session and are PROCESS-LOCAL — tiers 1 and 2 only,
 * never the lock and never STATE.md.
 *
 * A sibling of {@link readOwnSessionIds}, not a replacement: the two answer
 * different questions and the difference is the whole point.
 *
 *   - `readOwnSessionIds()` answers *"could this id name me?"* and unions three
 *     tiers, the third of which IS `session.lock`. That union is correct when
 *     the thing being classified was written by some OTHER process (a wave-scope
 *     manifest), because every id this process can legitimately claim counts.
 *   - This function answers *"which process is emitting right now?"*, and for
 *     that question the lock is **vacuous**: when the candidate ids under
 *     judgement are the lock's OWN values, a membership test against a set that
 *     contains the lock matches by construction — a peer-owned lock would
 *     classify as `own` 100% of the time.
 *
 * **STATE.md is excluded for the same reason, and this is the #1177-FX1 fix.**
 * `.claude/STATE.md` is a SHARED working-copy artefact written by whichever
 * session owns the working copy — normally the lock holder. So when a peer holds
 * the lock, the peer also wrote STATE.md, and the two "independent" witnesses
 * agree with each other about the PEER. Unioning a shared-file witness with a
 * process-local one lets the weaker witness carry the verdict while a
 * disagreeing process-local id cannot veto it (measured: lock=peer +
 * STATE.md=peer + `CLAUDE_CODE_SESSION_ID`=me stamped the PEER's ids). Tiering
 * rather than unioning is the fix — a better signal REPLACES a worse one
 * (`.claude/rules/host-resources.md` § HR-102).
 *
 * Never throws.
 *
 * @param {{ env?: object, hookInput?: object|null }} [opts]
 * @param {object} [opts.env=process.env] — injectable for tests.
 * @param {object|null} [opts.hookInput=null] — the harness's statement about
 *   THIS invocation, when the caller is a hook.
 * @returns {string[]} possibly EMPTY — an empty result means "this process
 *   cannot prove who it is", which callers must treat as unprovable rather
 *   than as a match.
 */
export function readProcessLocalSessionIds({ env = process.env, hookInput = null } = {}) {
  const ids = [];
  const add = (value) => {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed && !ids.includes(trimmed)) ids.push(trimmed);
  };

  // Tier 1 — the harness's statement about THIS invocation.
  if (hookInput && typeof hookInput === 'object') {
    for (const key of ['session_id', 'sessionId', 'parent_session_id']) add(hookInput[key]);
  }
  // Tier 2 — process-scoped env var.
  add(env?.CLAUDE_CODE_SESSION_ID);

  return ids;
}

/**
 * Decide whether a wave-scope manifest belongs to THIS session.
 *
 * Three outcomes, and the middle one is load-bearing:
 *
 *   - `'foreign'` — the manifest names at least one session id, we know at
 *     least one of our own, and NONE of them match. The only verdict that
 *     changes behaviour.
 *   - `'unknown'` — the manifest names no id (a legacy manifest written before
 *     the `session` field existed), or we could not resolve our own. Ownership
 *     is unproven in BOTH directions, so the caller must keep doing exactly
 *     what it did before.
 *   - `'own'` — an id matched.
 *
 * Both id fields are consulted because they address the same session under two
 * naming schemes: `session` is the raw harness session id (a UUID on Claude
 * Code), `semantic_session` the `<branch>-<date>-<mode>-<n>` form. A harness
 * that resolves only the semantic one must still recognise its own manifest.
 *
 * @param {unknown} scope — parsed wave-scope manifest (any shape; a non-object
 *   simply yields no ids, hence `'unknown'`).
 * @param {Set<string>} ownIds — from {@link readOwnSessionIds}.
 * @returns {{ verdict: 'own'|'foreign'|'unknown', manifestIds: string[] }}
 */
export function classifyManifestSession(scope, ownIds) {
  const manifestIds = [];
  if (scope && typeof scope === 'object' && !Array.isArray(scope)) {
    for (const key of ['session', 'semantic_session']) {
      const value = typeof scope[key] === 'string' ? scope[key].trim() : '';
      if (value) manifestIds.push(value);
    }
  }
  const own = ownIds instanceof Set ? ownIds : new Set();
  if (manifestIds.length === 0 || own.size === 0) return { verdict: 'unknown', manifestIds };
  const matched = manifestIds.some((id) => own.has(id));
  return { verdict: matched ? 'own' : 'foreign', manifestIds };
}
