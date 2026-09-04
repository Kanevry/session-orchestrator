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

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isLockShape } from '../session-lock-shape.mjs';

/**
 * Read the two session ids out of `<repoRoot>/.orchestrator/session.lock`.
 *
 * A deliberate, behaviour-identical stand-in for `readLock()` from
 * `../session-lock.mjs` (#1153 P7): that import drags a static closure of six
 * modules (session-lock → exclusivity-matrix, file-lock, io, host-identity,
 * crypto-digest-utils — measured 2026-09-04 by following its `^import` lines)
 * into every consumer of this module, of which the live
 * `hooks/enforce-scope.mjs` runs on EVERY Edit/Write. Two strings do not need
 * a lock manager.
 *
 * Tolerance is matched to `readLock()` exactly, which collapses every non-ok
 * outcome of `readLockDetailed()` to `null`: missing file, unreadable file,
 * invalid JSON, and **valid JSON that fails the lock schema** all yield `{}`
 * here. The schema check is not reproduced but IMPORTED — `isLockShape()` from
 * `../session-lock-shape.mjs` is the same predicate `parseLock()` applies, and
 * that module imports nothing, so sharing it costs the hook chain no closure.
 * A copy would have been free to drift the fail-OPEN way: a relaxed
 * `parseLock` plus an unchanged copy here drops the lock tier's ids, the own
 * manifest reads `foreign`, and enforcement switches itself off silently.
 *
 * Never throws.
 *
 * @param {string} repoRoot
 * @returns {{ session_id?: string, semantic_session_id?: string }}
 */
function readLockIds(repoRoot) {
  try {
    const raw = readFileSync(
      path.join(repoRoot ?? process.cwd(), '.orchestrator', 'session.lock'),
      'utf8',
    );
    const obj = JSON.parse(raw);
    if (!isLockShape(obj)) return {};
    return { session_id: obj.session_id, semantic_session_id: obj.semantic_session_id };
  } catch {
    return {};
  }
}

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
    const lock = readLockIds(repoRoot);
    for (const key of ['session_id', 'semantic_session_id']) add(lock?.[key]);
  } catch {
    /* readLockIds never throws by contract, but that contract is not ours to trust */
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
 * naming schemes: `session_id` is the raw harness session id (a UUID on Claude
 * Code), `semantic_session_id` the `<branch>-<date>-<mode>-<n>` form. A harness
 * that resolves only the semantic one must still recognise its own manifest.
 * The pre-#1153 spellings `session` / `semantic_session` are still READ (see
 * {@link MANIFEST_SESSION_KEYS}).
 *
 * @param {unknown} scope — parsed wave-scope manifest (any shape; a non-object
 *   simply yields no ids, hence `'unknown'`).
 * @param {Set<string>} ownIds — from EITHER producer, depending on what is
 *   being judged: {@link readOwnSessionIds} when every id this process could
 *   legitimately claim counts, or `new Set(`{@link readProcessLocalSessionIds}
 *   `(...))` when the lock tier would match vacuously — which is the case for a
 *   wave-scope manifest in a checkout shared by two sessions (#1194). Note the
 *   latter returns a `string[]`: a bare array is NOT a Set and folds to the
 *   empty set below, yielding `'unknown'` for every manifest.
 * @returns {{ verdict: 'own'|'foreign'|'unknown', manifestIds: string[] }}
 * @see MANIFEST_SESSION_KEYS / {@link manifestSessionBinding} — defined
 *   immediately below rather than above this doc comment, because the three
 *   live hooks import this module on EVERY tool call: a use-before-define here
 *   throws inside the hook chain and locks every session sharing the checkout
 *   out of Edit/Write/Bash (measured 2026-09-04, ~8 minutes, #1153 P2).
 */
/**
 * The session-binding key names of a `wave-scope.json` manifest — the ONE place
 * these literals live (#1153 P2). Every reader imports them from here instead
 * of repeating the strings: `scripts/materialize-wave-scope.mjs`,
 * `scripts/validate-wave-scope.mjs`, `scripts/memory-propose.mjs`, and — via
 * {@link classifyManifestSession} — `scripts/lib/events.mjs` plus the three
 * live hooks.
 *
 * `current` are the canonical names, chosen to match the two neighbouring
 * session artefacts a reader already knows: `.orchestrator/session.lock` and
 * `current-session.json` both spell them `session_id` / `semantic_session_id`,
 * and `scripts/lib/quality-gate.mjs` reads that exact pair. One session
 * identity should not carry two spellings depending on which file names it.
 *
 * `legacy` are the pre-#1153 spellings, and they are **accepted on the READ
 * side only, until the next minor release**. `wave-scope.json` is git-ignored
 * and session-ephemeral, so the one surviving reason to read them is a package
 * upgraded mid-wave with an old-format manifest already on disk. The writer
 * (`scripts/wave-scope-binding.mjs`) emits `current` exclusively.
 *
 * @type {Readonly<{ current: readonly string[], legacy: readonly string[] }>}
 */
export const MANIFEST_SESSION_KEYS = Object.freeze({
  current: Object.freeze(['session_id', 'semantic_session_id']),
  legacy: Object.freeze(['session', 'semantic_session']),
});

/**
 * Resolve the binding out of a manifest under BOTH key spellings. A non-object
 * — including an ARRAY, which `typeof` calls `'object'` — yields no ids.
 *
 * **A CONFLICT yields no value for that slot, and that is fail-CLOSED.**
 * When both spellings of one slot are present with different non-empty values,
 * the manifest is self-contradictory (`scripts/validate-wave-scope.mjs` calls
 * exactly this an ERROR — but no hook runs the validator, so the classifier is
 * the only thing standing between the manifest and the guard). Preferring the
 * current spelling let a peer DISARM this session's guard by appending
 * `"session_id": "attacker"` beside a legitimate legacy `"session": "<me>"`:
 * the slot then resolved to an id this session does not carry,
 * {@link classifyManifestSession} returned `'foreign'`, and
 * `hooks/enforce-scope.mjs` skips enforcement on `'foreign'`. Dropping the slot
 * instead collapses the verdict to `'unknown'`, which every caller treats as
 * "keep enforcing".
 *
 * Both present and EQUAL (after trim) → that value. Only one present → that
 * value. Both present and different → the slot is omitted.
 *
 * @param {unknown} scope
 * @returns {{ session_id?: string, semantic_session_id?: string }}
 */
export function manifestSessionBinding(scope) {
  const out = {};
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return out;
  MANIFEST_SESSION_KEYS.current.forEach((key, i) => {
    const legacyKey = MANIFEST_SESSION_KEYS.legacy[i];
    const pick = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');
    const current = pick(scope[key]);
    const legacy = pick(scope[legacyKey]);
    if (current && legacy && current !== legacy) return; // conflict → no value
    const value = current || legacy;
    if (value) out[key] = value;
  });
  return out;
}

/** @see the contract note above `MANIFEST_SESSION_KEYS` — the full docblock for
 * this function sits there, separated from it only because the constants must
 * be defined before use (#1153 P2). */
export function classifyManifestSession(scope, ownIds) {
  const manifestIds = [];
  const binding = manifestSessionBinding(scope);
  for (const key of MANIFEST_SESSION_KEYS.current) {
    if (binding[key]) manifestIds.push(binding[key]);
  }
  const own = ownIds instanceof Set ? ownIds : new Set();
  if (manifestIds.length === 0 || own.size === 0) return { verdict: 'unknown', manifestIds };
  const matched = manifestIds.some((id) => own.has(id));
  return { verdict: matched ? 'own' : 'foreign', manifestIds };
}
