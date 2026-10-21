/**
 * hook-root.mjs — which root holds THIS session's own state (#1605).
 *
 * `$CLAUDE_PROJECT_DIR` stays on the LAUNCH checkout after `EnterWorktree`. A
 * /clear, compact or resume there re-fires SessionStart with the payload `cwd`
 * inside the entered worktree; writing the new session's `session.lock` and
 * `current-session.json` at the launch root blocked whoever works there for the
 * lock's 4 h TTL. Two functions, one per side of the lifecycle:
 *
 *  - {@link resolveSessionStartRoot} — the WRITER (SessionStart) decides by rule
 *    whether the session's state moves into the entered worktree, and records
 *    its answer as `session_root` in the host registry entry of its raw id;
 *  - {@link resolveOwnLockRoot} — the READERS (Stop, PostToolBatch, SessionEnd,
 *    the current-session.json side writers) never re-derive that rule: they
 *    follow the `session_root` pointer first — whatever the current `cwd` — and
 *    accept it only when the lock there carries their own raw `session_id`.
 *
 * Both answer the launch root unchanged whenever anything is in doubt.
 */

import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { dotGitAncestor, linkedWorktreeSpot } from '../../scripts/lib/platform.mjs';
import { activeDir, isRegistryEntryFresh } from '../../scripts/lib/session-registry.mjs';
import { isLockLive, readLockDetailed } from '../../scripts/lib/session-lock.mjs';
import { parseSessionId } from '../../scripts/lib/session-id.mjs';

/** SessionStart sources that continue in the tree the session already works in. */
const RELOCATING_SOURCES = new Set(['clear', 'compact', 'resume']);

/**
 * The payload's own `session_id`, UUID-only, exactly as the lifecycle hooks
 * derive their raw id — never a value read back from `current-session.json`,
 * which would make every ownership compare below self-fulfilling.
 *
 * @param {object|null} input
 * @returns {string|null}
 */
export function rawPayloadSessionId(input) {
  const id = input?.session_id ?? input?.sessionId ?? null;
  return parseSessionId(id)?.format === 'uuid' ? id : null;
}

/** `session_id` of the lock at `root`, `null` when absent; `undefined` when unreadable/corrupt. */
function lockIdAt(root) {
  const detail = readLockDetailed({ repoRoot: root });
  if (detail.status === 'absent') return null;
  return detail.status === 'ok' ? detail.lock.session_id : undefined;
}

/**
 * JSON object at `file`: `{ status: 'absent' }` on ENOENT, `{ status: 'ok', value }`
 * for an object, `{ status: 'unreadable' }` for every other read or parse failure.
 * Callers that judge liveness treat 'unreadable' as LIVE (fail closed, #1605 B6).
 *
 * @param {string} file
 * @returns {{status: 'absent'|'ok'|'unreadable', value?: object}}
 */
function readJsonState(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (err) {
    return { status: err?.code === 'ENOENT' ? 'absent' : 'unreadable' };
  }
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' ? { status: 'ok', value } : { status: 'unreadable' };
  } catch { return { status: 'unreadable' }; }
}

/**
 * The root the host registry entry of `ownId` points at (`session_root`), when
 * the lock there carries `ownId` — else `null`. Independent of the current
 * `cwd`: after `ExitWorktree` the payload `cwd` no longer names the worktree
 * that holds the lock (#1605 B1), and a compact after a `cd` must not decide
 * anew (B2/B3).
 *
 * With `liveAtMs`, the lock there must also be live by its own heartbeat and
 * TTL (`isLockLive`) — the WRITER's test (#1630): a session whose process died
 * without SessionEnd leaves entry and lock behind, and a `resume` hours later
 * from another checkout was pulled back into that worktree past the target
 * checks of {@link resolveSessionStartRoot}. A lock past its TTL is no claim
 * to continue there; the caller then decides by rule. Only a `resume` passes
 * `liveAtMs` — it is the one source that can come from a new process. A
 * `compact` always comes from the running session, whose own stale lock after
 * a long idle is a refresh, not a takeover (`lock-bootstrap.mjs`); dropping the
 * pointer there orphaned the worktree lock (#1630 review). The READERS pass no
 * `liveAtMs` either: a running session must still find its own stale lock to
 * heartbeat and release it.
 *
 * Ceiling (BV-004): a process that dies without SessionEnd and is resumed from
 * the main checkout WITHIN the lock's TTL still follows the pointer back into
 * the worktree — the lock there is live and indistinguishable from a running
 * session's. Revisit when such a case is reported.
 *
 * @param {string|null} ownId
 * @param {number|null} [liveAtMs]
 * @returns {string|null}
 */
function pointedOwnRoot(ownId, liveAtMs = null) {
  if (ownId === null) return null;
  const entry = readJsonState(path.join(activeDir(), `${ownId}.json`));
  const root = entry.status === 'ok' ? entry.value.session_root : null;
  if (typeof root !== 'string' || !path.isAbsolute(root)) return null;
  if (liveAtMs === null) return lockIdAt(root) === ownId ? root : null;
  const detail = readLockDetailed({ repoRoot: root });
  return detail.status === 'ok' && detail.lock.session_id === ownId && isLockLive(detail.lock, liveAtMs)
    ? root : null;
}

/** Is `child` equal to or inside `parent`? Plain path compare — both sides are realpaths. */
function isSameOrInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Does a LIVE host registry entry other than `ownId` hold state in, or work in,
 * the checkout `targetTop`? Reads `session_root` (where its lock lives) AND
 * `work_root` (where it works) of every fresh entry — the second catches a
 * session that entered `targetTop` by EnterWorktree while its lock stayed at its
 * own launch root (#1605 B4). A root that merely CONTAINS `targetTop` (the main
 * checkout around `.claude/worktrees/<name>`) is a different working copy and
 * does not count. Fail closed: an unreadable registry directory or entry counts
 * as a live claim (#1605 B6); only ENOENT means "nobody".
 *
 * @param {string} targetTop  realpath of the target checkout's top
 * @param {string|null} ownId
 * @param {number} nowMs
 * @returns {boolean}
 */
function foreignRegistryClaim(targetTop, ownId, nowMs) {
  let names;
  try { names = readdirSync(activeDir()); } catch (err) { return err?.code !== 'ENOENT'; }
  for (const name of names) {
    if (!name.endsWith('.json') || name === `${ownId}.json`) continue;
    const entry = readJsonState(path.join(activeDir(), name));
    if (entry.status === 'absent') continue;
    if (entry.status === 'unreadable') return true;
    const e = entry.value;
    if (e.session_id === ownId || !isRegistryEntryFresh(e, { now: nowMs })) continue;
    for (const root of [e.session_root, e.work_root]) {
      if (typeof root === 'string' && path.isAbsolute(root) && isSameOrInside(root, targetTop)) return true;
    }
  }
  return false;
}

/** realpath of the checkout top holding `dir`, or '' when it has none or cannot be resolved. */
function checkoutTopOf(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return '';
  const top = dotGitAncestor(dir);
  if (top === '') return '';
  try { return realpathSync.native(top); } catch { return ''; }
}

/**
 * #1636 Pkt 2 / #1634 Pkt 1 — a MEASUREMENT, not a guard: does a fresh host
 * registry entry other than `ownId` WORK in the checkout `repoRoot` (its
 * `work_root` lies in it) while its lock lives in a DIFFERENT checkout (its
 * `session_root` does not)? That is the session that left its worktree by
 * ExitWorktree and works in the main checkout — `acquire()` cannot see it, so a
 * new session there gets the lock with no conflict. Recorded on
 * `orchestrator.session.lock.acquired` so the rate is countable before any
 * banner is built on it (HR-101/HR-105).
 *
 * Three states, never two (an unreadable registry must not read as "nobody"):
 * `true`, `false`, or `null` when the registry directory or an entry cannot be
 * read (ENOENT of the directory is `false` — no registry, no claim).
 * Spawn-free: `fs` reads only.
 *
 * @param {string} repoRoot
 * @param {string|null} ownId — this session's raw id (its own entry is skipped).
 * @param {number} [nowMs]
 * @returns {boolean|null}
 */
export function foreignWorkRootIn(repoRoot, ownId, nowMs = Date.now()) {
  const targetTop = checkoutTopOf(repoRoot);
  if (targetTop === '') return null;
  let names;
  try { names = readdirSync(activeDir()); } catch (err) { return err?.code === 'ENOENT' ? false : null; }
  let unreadable = false;
  for (const name of names) {
    if (!name.endsWith('.json') || name === `${ownId}.json`) continue;
    const entry = readJsonState(path.join(activeDir(), name));
    if (entry.status === 'absent') continue;
    if (entry.status === 'unreadable') { unreadable = true; continue; }
    const e = entry.value;
    if (e.session_id === ownId || !isRegistryEntryFresh(e, { now: nowMs })) continue;
    if (checkoutTopOf(e.work_root) === targetTop && checkoutTopOf(e.session_root) !== targetTop) return true;
  }
  return unreadable ? null : false;
}

/**
 * Is session `id` live by the host registry? A non-UUID id cannot be looked up
 * safely (it would become a path segment), so it counts as live — fail closed,
 * like an entry that exists but cannot be read (#1605 B6).
 *
 * @param {string} id
 * @param {number} nowMs
 * @returns {boolean}
 */
function isRegisteredLive(id, nowMs) {
  if (parseSessionId(id)?.format !== 'uuid') return true;
  const entry = readJsonState(path.join(activeDir(), `${id}.json`));
  if (entry.status === 'absent') return false;
  return entry.status === 'unreadable' || isRegistryEntryFresh(entry.value, { now: nowMs });
}

/**
 * The root SessionStart writes this session's own state into (#1605).
 *
 * First: when the registry entry of the raw payload id already points at a root
 * whose LIVE lock carries that id, that root — a compact or resume continues
 * where the session's lock is, whatever the current `cwd` (#1605 B2/B3). On a
 * `resume` a pointed lock past its TTL is ignored (#1630) and the rule below
 * decides; a `compact` follows its own pointer even to a stale lock. Ceiling:
 * see {@link pointedOwnRoot} (resume within the TTL after a crash).
 *
 * Otherwise the entered worktree wins ONLY when ALL hold, else `launchRoot`:
 *  (a) the payload `source` continues a session (`clear`, `compact`, `resume`)
 *      — a `startup` belongs to the launch root;
 *  (b) the payload `cwd` sits in a back-pointer-confirmed linked worktree of the
 *      launch root's repository, other than the launch checkout
 *      (`linkedWorktreeSpot`);
 *  (c) the session does not already hold its lock at the launch root;
 *  (d) the target holds no live lock of ANOTHER session, no unreadable lock, no
 *      `current-session.json` naming another session that is live by the host
 *      registry, and no live registry entry of another session whose
 *      `session_root` or `work_root` lies in the target checkout (B4).
 *      Registry read errors other than ENOENT count as live (B6).
 * A /clear's predecessor is released and deregistered by its SessionEnd(clear)
 * first, so it does not count; when that SessionEnd failed, the predecessor
 * still looks live and the session keeps the launch root — the pre-#1605
 * answer (ceiling, BV-004; revisit when a /clear in a worktree reports a lock
 * written to the launch root although its SessionEnd ran).
 *
 * Spawn-free: `fs` reads only.
 *
 * @param {object|null} input       the parsed SessionStart payload
 * @param {string} launchRoot        `resolveProjectDir()`
 * @param {number} [nowMs]
 * @returns {Promise<string>}
 */
export async function resolveSessionStartRoot(input, launchRoot, nowMs = Date.now()) {
  const ownId = rawPayloadSessionId(input);
  const pointed = pointedOwnRoot(ownId, input?.source === 'resume' ? nowMs : null);
  if (pointed !== null) return pointed;
  if (!RELOCATING_SOURCES.has(input?.source)) return launchRoot;
  // Without a raw payload id no reader (resolveOwnLockRoot) can ever find a
  // relocated lock again — it would sit orphaned in the worktree for its TTL.
  if (ownId === null) return launchRoot;
  const spot = linkedWorktreeSpot(input?.cwd, launchRoot);
  if (spot === '') return launchRoot;
  if (ownId !== null && lockIdAt(launchRoot) === ownId) return launchRoot;

  const detail = readLockDetailed({ repoRoot: spot });
  if (detail.status === 'unreadable' || detail.status === 'corrupt') return launchRoot;
  if (detail.status === 'ok' && detail.lock.session_id !== ownId && isLockLive(detail.lock, nowMs)) {
    return launchRoot;
  }
  const current = readJsonState(path.join(spot, '.orchestrator', 'current-session.json'));
  if (current.status === 'unreadable') return launchRoot;
  const named = current.status === 'ok' ? current.value.session_id : null;
  if (typeof named === 'string' && named !== '' && named !== ownId && isRegisteredLive(named, nowMs)) {
    return launchRoot;
  }
  const top = dotGitAncestor(spot);
  if (top === '') return launchRoot;
  let targetTop;
  try { targetTop = realpathSync.native(top); } catch { return launchRoot; }
  if (foreignRegistryClaim(targetTop, ownId, nowMs)) return launchRoot;
  return spot;
}

/**
 * The root whose `.orchestrator/session.lock` carries THIS session's raw
 * `session_id`: the registry pointer (`session_root`) first, then the launch
 * root, then the entered worktree's spot (`linkedWorktreeSpot` of the payload
 * `cwd`) — else `launchRoot` unchanged. For Stop, PostToolBatch, SessionEnd and
 * the hooks that annotate `current-session.json`: they act where SessionStart
 * actually put the lock, and never re-derive SessionStart's rule. Without a raw
 * payload id ownership cannot be established, so the answer is the launch root.
 *
 * Ceiling (BV-004): a session that never got a lock at a relocated root (lost
 * the acquire race) is read at the launch root. Revisit when a relocated
 * `current-session.json` is found without a lock beside it.
 *
 * @param {object|null} input       the parsed hook payload
 * @param {string} launchRoot        `getProjectDir()`
 * @returns {string}
 */
export function resolveOwnLockRoot(input, launchRoot) {
  const ownId = rawPayloadSessionId(input);
  if (ownId === null) return launchRoot;
  const pointed = pointedOwnRoot(ownId);
  if (pointed !== null) return pointed;
  if (lockIdAt(launchRoot) === ownId) return launchRoot;
  const spot = linkedWorktreeSpot(input?.cwd, launchRoot);
  return spot !== '' && lockIdAt(spot) === ownId ? spot : launchRoot;
}
