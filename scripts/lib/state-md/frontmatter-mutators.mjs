/**
 * Frontmatter mutation helpers for STATE.md.
 *
 * Pure functions — no file I/O.
 *
 * Plus a small I/O-touching surface (`writeStateMd`, `updateFrontmatterFieldsOnDisk`,
 * `touchUpdatedFieldOnDisk`) added for PRD 2026-05-22 § 4 Pattern 1 (issue #518).
 * These delegate to the pure helpers above but route the actual readFileSync /
 * writeFileSync through `withStateMdLock` from session-lock.mjs so concurrent
 * writers serialise mechanically rather than relying on PSA-004 discipline.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { parseStateMd, serializeStateMd } from './yaml-parser.mjs';
import { withStateMdLock } from '../session-lock.mjs';
import { resolveStateDir } from '../platform.mjs';
// Hook-closure note: own-session.mjs imports only node:* and the import-free
// session-lock-shape.mjs, both already in the hook import set.
import { readProcessLocalSessionIds } from '../session-identity/own-session.mjs';

/**
 * Sets frontmatter.updated to the given ISO 8601 timestamp and returns the
 * new contents. If the file has no frontmatter, returns input unchanged.
 *
 * @param {string} contents
 * @param {string} isoTimestamp
 * @returns {string}
 */
export function touchUpdatedField(contents, isoTimestamp) {
  const parsed = parseStateMd(contents);
  if (parsed === null) return contents;
  parsed.frontmatter.updated = isoTimestamp;
  return serializeStateMd(parsed);
}

/**
 * Additively writes frontmatter keys. Only keys present in `fields` are
 * touched; all other existing frontmatter keys (including unknown
 * extensions) are preserved verbatim.
 *
 * Value semantics:
 *   - `null` or `undefined` value → key is DELETED from the frontmatter
 *   - anything else → key is set/overwritten
 *
 * No-ops if `contents` has no frontmatter (returns input unchanged).
 *
 * @param {string} contents
 * @param {object} fields
 * @returns {string}
 */
export function updateFrontmatterFields(contents, fields) {
  const parsed = parseStateMd(contents);
  if (parsed === null) return contents;
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    return contents;
  }
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) {
      delete parsed.frontmatter[k];
    } else {
      parsed.frontmatter[k] = v;
    }
  }
  return serializeStateMd(parsed);
}

// ---------------------------------------------------------------------------
// On-disk wrappers (PRD 2026-05-22 § 4 — Pattern 1, issue #518)
// ---------------------------------------------------------------------------
//
// All STATE.md writes from .mjs callers SHOULD route through `writeStateMd`.
// Skill bodies that previously did inline `readFileSync(STATE) → transform →
// writeFileSync(STATE)` migrate to `await writeStateMd(repoRoot, contents => …)`,
// which mechanically serialises concurrent writers via `withStateMdLock`.

// Legacy fallback order; the requested artifact's active harness always wins.
const STATE_DIR_CANDIDATES = ['.claude', '.codex', '.cursor', '.pi'];

/**
 * Resolve a state artifact independently of other files in the state directory.
 * Check SO_STATE_DIR, the detected active harness, then legacy harness directories.
 * If none exist, return the preferred path for create-on-first-write callers.
 * In particular, an existing legacy STATE.md must not redirect a native scope.
 *
 * @param {string|undefined} repoRoot
 * @param {string} filename - Artifact filename, such as STATE.md or wave-scope.json.
 * @returns {string} Absolute artifact path.
 */
export function resolveStateArtifactPath(repoRoot, filename) {
  const { candidates } = stateArtifactCandidates(repoRoot, filename);
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

/**
 * Shared candidate list: SO_STATE_DIR override (if set), the active harness's
 * state dir, then the legacy harness dirs. `preferredCount` is how many of the
 * leading entries are override/active (as opposed to legacy).
 *
 * @param {string|undefined} repoRoot
 * @param {string} filename
 * @returns {{ candidates: string[], preferredCount: number }}
 */
function stateArtifactCandidates(repoRoot, filename) {
  const root = repoRoot ?? process.cwd();
  const override = (process.env.SO_STATE_DIR ?? '').trim();
  const active = resolveStateDir();
  const preferred = [...new Set([override || active, active])];
  const directories = [...new Set([...preferred, ...STATE_DIR_CANDIDATES])];
  return {
    candidates: directories.map((directory) => resolvePath(root, directory, filename)),
    preferredCount: preferred.length,
  };
}

/**
 * May THIS process write into the existing STATE.md at `candidate`?
 * Always yes for a placeholder (no frontmatter or no `session-id`), a
 * `status: idle` record, or a `session-id` naming this process
 * (`readProcessLocalSessionIds()`). An unreadable file is never a target.
 *
 * Otherwise the answer depends on where the candidate sits:
 *   - Legacy (other-platform) dir: no — #1618, unchanged.
 *   - SO_STATE_DIR / active dir (`preferred`): refused ONLY when it is
 *     `status: completed` AND this process has a measurable own id (#1640 —
 *     the measured damage: session-end Phase 3.7a wrote into a FINISHED
 *     foreign session's record). A non-completed record keeps the pre-#1640
 *     behaviour: one checkout has one session.lock owner, and after `/clear`
 *     the process carries a NEW raw id while its own active STATE.md still
 *     names the old one — refusing that file made `/close` unable to finish.
 *     `completedHandoff` (Idle Reset) may take a completed record too: that
 *     rewrite IS the hand-over to the next session.
 *
 * CEILING (BV-004): a `/clear`ed session's active file is still identified by
 * its OLD id until close, where {@link markStateMdCompletedOnDisk} re-stamps
 * it; a live parallel session in the same checkout is PSA territory, not
 * this guard's. Revisit when the raw id survives `/clear` (resume linkage).
 *
 * @param {string} candidate
 * @param {string[]} ownIds
 * @param {{ preferred: boolean, completedHandoff?: boolean }} opts
 * @returns {boolean}
 */
function isWritableStateMd(candidate, ownIds, { preferred, completedHandoff = false }) {
  let frontmatter;
  try {
    frontmatter = parseStateMd(readFileSync(candidate, 'utf8'))?.frontmatter ?? null;
  } catch {
    return false;
  }
  const raw = frontmatter?.['session-id'];
  const sessionId = typeof raw === 'string' ? raw.trim() : '';
  if (!sessionId) return true;
  const status = frontmatter.status;
  if (status === 'idle') return true;
  if (ownIds.includes(sessionId)) return true;
  if (!preferred) return false;
  return status !== 'completed' || completedHandoff || ownIds.length === 0;
}

/**
 * Resolve the active STATE.md path under a given repo root — READ side.
 *
 * Returns the first existing candidate, checking the active platform first.
 * Falls back to the active platform's state dir when none exist (matches the
 * create-on-first-write semantics expected by callers). The legacy fallback to
 * another platform's STATE.md is kept for readers (#890); writers must use
 * {@link resolveStateMdWritePath}.
 *
 * @param {string|undefined} repoRoot
 * @returns {string}  Absolute path to STATE.md.
 */
export function resolveStateMdPath(repoRoot) {
  return resolveStateArtifactPath(repoRoot, 'STATE.md');
}

/**
 * Resolve the STATE.md path a WRITE may target (#1618, #1640).
 *
 * Every existing candidate — SO_STATE_DIR, the active platform's dir, the
 * legacy dirs — must pass the ownership rule ({@link isWritableStateMd}); the
 * first one that does wins. Before #1640 the override/active candidates were
 * taken unchecked, so session-end Phase 3.7a wrote its recommendation fields
 * into a FOREIGN completed `.claude/STATE.md` while this session's own record
 * lived elsewhere. Without a qualifying candidate the preferred path is
 * returned for create-on-first-write — unless that path itself holds a foreign
 * file, in which case `blocked` is true and writers refuse.
 *
 * @param {string|undefined} repoRoot
 * @returns {string}  Absolute path to STATE.md.
 */
export function resolveStateMdWritePath(repoRoot) {
  return resolveStateMdWriteTarget(repoRoot).path;
}

/**
 * Like {@link resolveStateMdWritePath}, but also names the first STATE.md
 * that was REJECTED on the way (#1618 review): `rejected` is the absolute path
 * of an existing STATE.md not proven to be this process's, set only when the
 * returned `path` is NOT a qualifying existing file (absent → create, or
 * `blocked`). Callers use it to say why nothing was written instead of
 * returning a silent no-op. `blocked` means `path` exists and is foreign:
 * nothing may be written there (#1640).
 *
 * `opts.statePath` (#1640) pins the target explicitly — session-end passes the
 * same path to Phase 3.7a and Phase 3.4 so both land in one file — and is
 * subject to the same ownership rule (treated as a preferred candidate).
 * `opts.completedHandoff` lets the Idle Reset take a preferred
 * `status: completed` record (see {@link isWritableStateMd}).
 *
 * @param {string|undefined} repoRoot
 * @param {{ statePath?: string, completedHandoff?: boolean }} [opts]
 * @returns {{ path: string, rejected: string|null, blocked: boolean }}
 */
export function resolveStateMdWriteTarget(repoRoot, opts = {}) {
  const { statePath, completedHandoff = false } = opts;
  const ownIds = readProcessLocalSessionIds();
  const explicit = typeof statePath === 'string' && statePath.trim() !== '';
  const { candidates, preferredCount } = explicit
    ? { candidates: [resolvePath(repoRoot ?? process.cwd(), statePath)], preferredCount: 1 }
    : stateArtifactCandidates(repoRoot, 'STATE.md');
  let rejected = null;
  for (const [index, candidate] of candidates.entries()) {
    if (!existsSync(candidate)) continue;
    if (isWritableStateMd(candidate, ownIds, { preferred: index < preferredCount, completedHandoff })) {
      return { path: candidate, rejected: null, blocked: false };
    }
    rejected ??= candidate;
  }
  const path = candidates[0];
  return { path, rejected, blocked: existsSync(path) };
}

/**
 * One stderr line naming a rejected foreign STATE.md, so a fail-closed
 * write target never degrades into a silent no-op (#1618 review). When the
 * rejected file IS the target (#1640 `blocked`), the line says nothing is
 * written instead of naming a different target.
 *
 * @param {string} caller
 * @param {string} rejected
 * @param {string} target
 */
export function warnForeignStateMd(caller, rejected, target) {
  const outcome = rejected === target
    ? 'nothing written — it is no session-own write target'
    : `write target is ${target}`;
  process.stderr.write(
    `⚠ ${caller}: ignoring ${rejected} — its session-id is not this process's ` +
      `(no matching process-local session id); ${outcome} (#1618/#1640)\n`
  );
}

// ---------------------------------------------------------------------------
// Size-ceiling guard (issue #739)
// ---------------------------------------------------------------------------
//
// Incident: editing STATE.md frontmatter via updateFrontmatterFields ballooned
// the file from ~6KB to 6.3MB. Root cause is a yaml-parser/serializer
// asymmetry — serializeScalar() JSON-escapes special characters (quotes,
// backslashes) but parseScalar() strips the surrounding quotes WITHOUT
// unescaping the interior escape sequences. A frontmatter scalar containing a
// literal `"` therefore gains an extra layer of backslash-escaping on every
// parse→serialize round-trip, and repeated writes (each innocuous on its own)
// compound into exponential growth. See `.claude/STATE.md` § "What Not To
// Retry" for the incident note (main-2026-06-26-session-2).
//
// This guard is MECHANICAL and content-agnostic — it never inspects
// frontmatter shape, only the byte size of the proposed write relative to (a)
// an absolute ceiling and (b) the prior on-disk size. It refuses a write that
// would breach either bound rather than let a corrupt/ballooning write land,
// leaving the last-known-good on-disk contents intact.
//
// A DEEPER fix — a frontmatter-safe round-trip verification
// (`serializeStateMd(parseStateMd(after)) === after`) — was evaluated at the
// time and deliberately NOT shipped as a rejection gate, because the
// yaml-parser asymmetry it would have been checking FOR (parseScalar
// stripping quotes without unescaping the interior) made it false-positive on
// ordinary operator-authored content on its very first write, before any
// corruption had occurred.
//
// #747 (this session) closed that root-cause asymmetry directly in
// yaml-parser.mjs (parseScalar now unescapes via `JSON.parse`; serializeScalar
// force-quotes coercible strings) — see that module's docstring for the
// inverse-property contract. With the asymmetry gone, the round-trip verify
// is now SAFE to ship as an active guard: `evaluateFrontmatterSafe` below
// re-verifies it, scoped to the FRONTMATTER BLOCK only (not the full
// document). Scoping choice, empirically derived: `after` is always the
// TRANSFORMER's return value, and every transformer in this module family
// (`updateFrontmatterFields`, `touchUpdatedField`, and every body-section /
// mission-status writer) produces `after` via `serializeStateMd(...)` as its
// final step — so `after` is itself always fresh serializer output, and a
// full-document `serializeStateMd(parseStateMd(after)) === after` check DOES
// hold for it (verified against the live repo's `.claude/STATE.md` and a
// battery of quote/umlaut/array/block-seq fixtures). However, an EARLIER,
// weaker probe against the raw ON-DISK file (not transformer output) showed a
// body-only blank-line normalization difference — a pre-existing, unrelated
// serializeStateMd behaviour (it always emits a blank line between the
// closing `---` and the body) that has nothing to do with the frontmatter
// asymmetry this guard exists to catch. Scoping the check to the frontmatter
// block alone sidesteps that unrelated body-formatting difference entirely,
// keeps the guard's blast radius precisely matched to its name, and remains
// the narrower, safer gate for a mechanism whose whole history is "shipped
// too eagerly once already flagged legitimate content."

/** Absolute ceiling (bytes) above which a STATE.md write is refused outright. */
export const DEFAULT_STATE_MD_SIZE_CEILING_BYTES = 262144; // 256 KB

/** A write more than this many times the prior on-disk size is refused, even under the absolute ceiling. */
export const STATE_MD_SIZE_CEILING_RATIO = 5;

/**
 * Evaluates the proposed `after` contents against the size-ceiling guard.
 *
 * Two independent checks, either of which is a breach:
 *   - Absolute: `after` byte-size exceeds `ceilingBytes`.
 *   - Ratio: when `before` is non-empty, `after` byte-size exceeds
 *     `STATE_MD_SIZE_CEILING_RATIO` times the `before` byte-size. Skipped on
 *     first-writes (`before === ''`) — there is no prior size to ratio against.
 *
 * @param {string} before
 * @param {string} after
 * @param {number} ceilingBytes
 * @returns {{ breached: boolean, reason: string|null, afterBytes: number }}
 */
function evaluateSizeCeiling(before, after, ceilingBytes) {
  const afterBytes = Buffer.byteLength(after, 'utf8');
  if (afterBytes > ceilingBytes) {
    return {
      breached: true,
      reason: `after-size ${afterBytes}B exceeds absolute ceiling ${ceilingBytes}B`,
      afterBytes,
    };
  }
  if (before.length > 0) {
    const beforeBytes = Buffer.byteLength(before, 'utf8');
    if (afterBytes > beforeBytes * STATE_MD_SIZE_CEILING_RATIO) {
      return {
        breached: true,
        reason: `after-size ${afterBytes}B exceeds ${STATE_MD_SIZE_CEILING_RATIO}x prior on-disk size ${beforeBytes}B`,
        afterBytes,
      };
    }
  }
  return { breached: false, reason: null, afterBytes };
}

// ---------------------------------------------------------------------------
// Frontmatter-safe round-trip guard (issue #747 follow-up)
// ---------------------------------------------------------------------------

/** Matches the raw `---\n<frontmatter>\n---` block, mirroring yaml-parser.mjs's FRONTMATTER_RE. */
const FRONTMATTER_BLOCK_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Extracts the raw frontmatter block text (the bytes between the opening and
 * closing `---` fences, exclusive) from a STATE.md-shaped string. Returns
 * `null` when `text` has no matching frontmatter fence.
 *
 * @param {string} text
 * @returns {string|null}
 */
function extractFrontmatterBlock(text) {
  const match = FRONTMATTER_BLOCK_RE.exec(text);
  return match ? match[1] : null;
}

/**
 * Evaluates whether `after`'s frontmatter block is a byte-fixpoint under a
 * further `serializeStateMd(parseStateMd(...))` round-trip.
 *
 * Scoped to the frontmatter block only (see the "Frontmatter-safe round-trip
 * guard" comment above `DEFAULT_STATE_MD_SIZE_CEILING_BYTES` for the scoping
 * rationale).
 *
 * `parseStateMd(after) === null` has TWO causes and they get OPPOSITE verdicts,
 * because collapsing them is what made this guard blind:
 *   - NO frontmatter fence in `after` → SAFE. There is nothing frontmatter-shaped
 *     to verify, and non-STATE.md-shaped writes (arbitrary test fixtures, plain
 *     body text) stay ungated, matching `evaluateSizeCeiling`'s content-agnostic
 *     posture for that case.
 *   - A fence IS present but its contents do not parse → UNSAFE. A write whose
 *     frontmatter this repo's own parser cannot read back is precisely the
 *     corruption class this guard exists to refuse; treating it as "nothing to
 *     verify" let the single worst input pass unchecked (the 2026-08-24 #1111
 *     regression, where one flow item nulled the whole document, sat in exactly
 *     this hole).
 *
 * Never throws — mirrors the never-throw contract of yaml-parser.mjs.
 *
 * @param {string} after
 * @returns {{ unsafe: boolean, reason: string|null }}
 */
export function evaluateFrontmatterSafe(after) {
  const beforeBlock = extractFrontmatterBlock(after);
  const parsed = parseStateMd(after);
  if (parsed === null) {
    if (beforeBlock === null) {
      return { unsafe: false, reason: null };
    }
    return {
      unsafe: true,
      reason:
        `frontmatter block is present but parseStateMd could not read it back ` +
        `(${Buffer.byteLength(beforeBlock, 'utf8')}B unparseable)`,
    };
  }
  const reserialized = serializeStateMd(parsed);
  const afterBlock = extractFrontmatterBlock(reserialized);
  if (beforeBlock !== afterBlock) {
    return {
      unsafe: true,
      reason:
        `frontmatter block is not a serialize(parse(after)) byte-fixpoint ` +
        `(${Buffer.byteLength(beforeBlock ?? '', 'utf8')}B -> ${Buffer.byteLength(afterBlock ?? '', 'utf8')}B)`,
    };
  }
  return { unsafe: false, reason: null };
}

/**
 * Atomic write helper: write to a sibling tmp file then rename. Avoids
 * partial-write races with concurrent readers (e.g. session-start probes
 * reading STATE.md while a write is in flight).
 *
 * @param {string} filePath
 * @param {string} contents
 */
function writeFileAtomic(filePath, contents) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  // Sibling tmp name uses high-entropy suffix to avoid collisions across
  // concurrent attempts. Tmp + rename is atomic on the same filesystem (POSIX).
  const tmpSuffix = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const tmpFile = `${filePath}.tmp.${tmpSuffix}`;
  writeFileSync(tmpFile, contents, { encoding: 'utf8' });
  renameSync(tmpFile, filePath);
}

/**
 * Lock-guarded STATE.md read-transform-write.
 *
 * Acquires `.orchestrator/state.lock` for the duration of the read +
 * transform + write, releasing it on completion or throw. Concurrent
 * callers serialize on the lock; the second caller observes the first
 * caller's write.
 *
 * The transformer receives the CURRENT contents (string) and MUST return
 * the new contents (string). If the transformer returns `null` or
 * `undefined`, the write is skipped and the lock released — this is the
 * intended path for "read, decide, no-op" flows.
 *
 * If STATE.md does not exist on disk, the transformer receives an empty
 * string. Callers that need to assert presence should `existsSync` upfront.
 *
 * Size-ceiling guard (issue #739): before writing, `after` is checked against
 * an absolute byte-size ceiling and a ratio-vs-`before` ceiling (see
 * `evaluateSizeCeiling`). A breach REFUSES the write (leaves the prior
 * on-disk contents intact — last-known-good) and emits a `⚠` WARN to
 * `process.stderr`, rather than throwing — STATE.md is load-bearing and a
 * hard throw here could wedge a session mid-wave. Pass
 * `opts.throwOnCeiling: true` to opt into a thrown Error instead.
 *
 * Frontmatter-safe round-trip guard (issue #747 follow-up): after the
 * size-ceiling check passes, `after`'s frontmatter block is independently
 * verified to be a byte-fixpoint under a further
 * `serializeStateMd(parseStateMd(after))` round-trip (see
 * `evaluateFrontmatterSafe`). This is now ACTIVE (it was evaluated and
 * deliberately left unshipped when issue #739 first landed, because the
 * yaml-parser asymmetry it exists to catch made it false-positive on ordinary
 * content at the time) — #747 closed that asymmetry in yaml-parser.mjs, so
 * the check is safe to enforce. A frontmatter fence that is present but does
 * NOT parse back is refused by the same guard (see `evaluateFrontmatterSafe`);
 * only content with no fence at all leaves it inert. It catches FUTURE
 * serializer/parser drift
 * that reintroduces a non-idempotent frontmatter round-trip — the exact
 * incident class behind #739 — rather than the symptom (file size) the
 * size-ceiling guard was limited to. Same non-throw, WARN-then-refuse
 * contract as the size-ceiling guard: pass `opts.throwOnFrontmatterUnsafe:
 * true` to opt into a thrown Error instead.
 *
 * @param {string|undefined} repoRoot
 * @param {(contents: string) => string|null|undefined|Promise<string|null|undefined>} transformer
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]  — passed to acquireStateLock.
 * @param {string} [opts.holder]     — human-readable holder identifier.
 * @param {number} [opts.pollMs]     — test-only override of poll cadence.
 * @param {number} [opts._ceilingBytes]  — test-only override of the absolute
 *   size ceiling (default `DEFAULT_STATE_MD_SIZE_CEILING_BYTES`, 256 KB).
 *   Production callers MUST omit this option.
 * @param {boolean} [opts.throwOnCeiling]  — when true, a size-ceiling breach
 *   throws an `Error` (`.code === 'STATE_MD_SIZE_CEILING'`) instead of
 *   returning a no-op result. Default `false`.
 * @param {boolean} [opts.throwOnFrontmatterUnsafe]  — when true, a
 *   frontmatter-unsafe breach throws an `Error`
 *   (`.code === 'STATE_MD_FRONTMATTER_UNSAFE'`) instead of returning a no-op
 *   result. Default `false`.
 * @param {string} [opts.statePath]  — explicit STATE.md target (#1640), absolute
 *   or repo-relative; still ownership-checked. A foreign existing target is
 *   refused with `reason: 'foreign-state-md'`, never overwritten.
 * @param {boolean} [opts.completedHandoff]  — Idle Reset only: a preferred
 *   `status: completed` record qualifies as write target (#1640).
 * @returns {Promise<{ written: boolean, path: string, contents: string|null, reason?: string }>}
 */
export async function writeStateMd(repoRoot, transformer, opts = {}) {
  if (typeof transformer !== 'function') {
    throw new TypeError('writeStateMd: transformer must be a function');
  }
  const { path: statePath, rejected, blocked } = resolveStateMdWriteTarget(repoRoot, {
    statePath: opts.statePath,
    completedHandoff: opts.completedHandoff,
  });
  if (rejected) warnForeignStateMd('writeStateMd', rejected, statePath);
  const foreign = rejected ? { reason: 'foreign-state-md' } : {};
  // #1640: the only existing file at the target belongs to another session —
  // never overwrite it, never call the transformer on its contents.
  if (blocked) return { written: false, path: statePath, contents: null, ...foreign };
  return withStateMdLock(
    repoRoot,
    async () => {
      const before = existsSync(statePath) ? readFileSync(statePath, 'utf8') : '';
      const after = await transformer(before);
      if (after === null || after === undefined) {
        return { written: false, path: statePath, contents: null, ...foreign };
      }
      if (typeof after !== 'string') {
        throw new TypeError('writeStateMd: transformer must return a string or null');
      }
      if (after === before) {
        // No textual change — skip the write to keep mtime stable.
        return { written: false, path: statePath, contents: before, ...foreign };
      }

      const ceilingBytes = typeof opts._ceilingBytes === 'number' && opts._ceilingBytes > 0
        ? opts._ceilingBytes
        : DEFAULT_STATE_MD_SIZE_CEILING_BYTES;
      const ceilingCheck = evaluateSizeCeiling(before, after, ceilingBytes);
      if (ceilingCheck.breached) {
        process.stderr.write(
          `⚠ writeStateMd: refusing write to ${statePath} (reason: size-ceiling) — ${ceilingCheck.reason}\n`
        );
        if (opts.throwOnCeiling === true) {
          const err = new Error(`writeStateMd: size-ceiling breach — ${ceilingCheck.reason}`);
          err.code = 'STATE_MD_SIZE_CEILING';
          throw err;
        }
        return { written: false, path: statePath, contents: before, reason: 'size-ceiling' };
      }

      const frontmatterCheck = evaluateFrontmatterSafe(after);
      if (frontmatterCheck.unsafe) {
        process.stderr.write(
          `⚠ writeStateMd: refusing write to ${statePath} (reason: frontmatter-unsafe) — ${frontmatterCheck.reason}\n`
        );
        if (opts.throwOnFrontmatterUnsafe === true) {
          const err = new Error(`writeStateMd: frontmatter-unsafe breach — ${frontmatterCheck.reason}`);
          err.code = 'STATE_MD_FRONTMATTER_UNSAFE';
          throw err;
        }
        return { written: false, path: statePath, contents: before, reason: 'frontmatter-unsafe' };
      }

      // A list item the parser cannot represent is dropped on READ (see
      // yaml-parser.mjs `parseBlockValue`), so this write is what makes the drop
      // permanent on disk. Dropping is the right call — the alternatives are a
      // mangled key or a dead no-op — but it must not be SILENT, which is the
      // whole complaint the per-item scoping answers. Name the items, then write
      // anyway: blocking here would re-create the no-op this fix removed.
      const droppedItems = parseStateMd(before)?.warnings;
      if (droppedItems !== undefined) {
        process.stderr.write(
          `⚠ writeStateMd: ${statePath} — dropping ${droppedItems.length} unrepresentable list item(s): ` +
            `${droppedItems.map((w) => `${w.key}[${w.index}] (${w.reason})`).join(', ')}\n`
        );
      }
      writeFileAtomic(statePath, after);
      return { written: true, path: statePath, contents: after };
    },
    { timeoutMs: opts.timeoutMs, holder: opts.holder, pollMs: opts.pollMs }
  );
}

/**
 * Guard: throws a clear Error when repoRoot is undefined, null, or empty.
 * Parallel-session CWD drift (PSA rules) makes `process.cwd()` fallbacks a
 * footgun — callers MUST be explicit about which repo root they target.
 *
 * @param {unknown} repoRoot
 * @param {string} fnName  — name of the calling function, for error messages
 */
function requireRepoRoot(repoRoot, fnName) {
  if (!repoRoot) {
    throw new Error(
      `${fnName}: repoRoot is required (got ${typeof repoRoot}). Pass an explicit repo root, e.g. via execSync('git rev-parse --show-toplevel').`
    );
  }
}

/**
 * Convenience wrapper: apply `updateFrontmatterFields` under the state-lock.
 * Pure callers (in-memory transforms) should keep using
 * `updateFrontmatterFields` directly — this wrapper exists for call sites
 * that previously did the read + transform + write inline.
 *
 * @param {string} repoRoot  — absolute path to the repository root (required)
 * @param {object} fields
 * @param {object} [opts]
 * @returns {Promise<{ written: boolean, path: string, contents: string|null }>}
 * @throws {Error} when repoRoot is undefined, null, or empty
 */
export async function updateFrontmatterFieldsOnDisk(repoRoot, fields, opts = {}) {
  requireRepoRoot(repoRoot, 'updateFrontmatterFieldsOnDisk');
  return writeStateMd(repoRoot, (contents) => updateFrontmatterFields(contents, fields), opts);
}

/**
 * Why the STATE.md `session-id` `sessionId` may NOT be taken over by this
 * process (#1640 review MED-1), or `null` when it may. A non-completed record
 * passes the write rule even with a foreign id (a `/clear`ed session's own
 * file still names its pre-`/clear` id), so before re-stamping the id and
 * completing the file we ask the host session registry whether that id is
 * still REGISTERED at all (`readRegistry()`; the caller already excludes our
 * own id). A registered session owns the file: completing it would lock that
 * session out of its own record. No freshness window: the heartbeat is only
 * written at turn end (hooks/on-stop.mjs), and 92 of 954 consecutive
 * `orchestrator.turn.stopped` gaps (48 of 64 sessions) exceeded 15 min —
 * an idle-but-live peer would look dead. Measured 2026-10-15: 13 of 13
 * sessions that ended with SessionEnd `reason: clear` were already
 * deregistered (on-session-end.mjs deregisters on every reason), so a
 * `/clear` predecessor does not block its successor's close.
 *
 * Fail-closed: a registry directory that exists but cannot be read refuses.
 * An absent registry (ENOENT) means no live peers.
 *
 * CEILING (BV-004): the registry is host-wide, not per checkout, and the
 * check runs inside the STATE.md lock but not under the registry's. A session
 * that crashed without SessionEnd (or whose deregistration failed) stays
 * registered until `sweepZombies()` removes it after 60 min of inactivity at
 * the next SessionStart of ANY session — until then no other session can
 * complete its STATE.md (fail-closed direction, refused loudly). Revisit if
 * that refusal shows up in close transcripts.
 *
 * Lazy import: this module is in the hook import closure; the registry is
 * only needed on this async session-end path.
 *
 * @param {string} sessionId
 * @param {string|undefined} ownId
 * @returns {Promise<string|null>}
 */
async function liveForeignOwner(sessionId) {
  try {
    const { activeDir, readRegistry } = await import('../session-registry.mjs');
    const { readdir } = await import('node:fs/promises');
    try {
      await readdir(activeDir());
    } catch (err) {
      if (err?.code === 'ENOENT') return null;
      return `session registry unreadable (${err?.code ?? 'error'})`;
    }
    const entries = await readRegistry();
    return entries.some((entry) => entry.session_id === sessionId)
      ? 'its session-id belongs to a session still registered on this host'
      : null;
  } catch (err) {
    return `session registry unreadable (${err?.code ?? err?.message ?? 'error'})`;
  }
}

/**
 * session-end Phase 3.4 (#1640): finalize THIS session's STATE.md in one
 * locked write — `status: completed`, `updated`, optionally `current-wave`,
 * and `session-id` re-stamped to the closing process's own raw id when one is
 * measurable. The re-stamp keeps a `/clear`ed session's record its own after
 * 3.4: the writers that run LATER in the close — Phase 5's
 * `markOpenQuestionAnsweredOnDisk` — would otherwise find a completed record
 * naming the pre-`/clear` id and be refused as foreign. Without a measurable
 * id the existing `session-id` is left as is.
 *
 * Refused (`reason: 'foreign-state-md'`, one stderr line, file byte-identical)
 * when the record's `session-id` is neither this process's nor free to take
 * over — see {@link liveForeignOwner}. Placeholder (no `session-id`), idle and
 * own records are never checked against the registry.
 *
 * @param {string} repoRoot  — absolute path to the repository root (required)
 * @param {object} [opts]  — `writeStateMd` options; pass the SAME `statePath` as Phase 3.7a.
 * @param {number} [opts.currentWave]  — final wave count, written as `current-wave`.
 * @returns {Promise<{ written: boolean, path: string, contents: string|null, reason?: string }>}
 * @throws {Error} when repoRoot is undefined, null, or empty
 */
export async function markStateMdCompletedOnDisk(repoRoot, opts = {}) {
  requireRepoRoot(repoRoot, 'markStateMdCompletedOnDisk');
  const { currentWave, ...writeOpts } = opts;
  const fields = { status: 'completed', updated: new Date().toISOString() };
  if (Number.isInteger(currentWave)) fields['current-wave'] = currentWave;
  const [ownId] = readProcessLocalSessionIds();
  if (ownId) fields['session-id'] = ownId;
  let refusal = null;
  const result = await writeStateMd(
    repoRoot,
    async (contents) => {
      const frontmatter = parseStateMd(contents)?.frontmatter;
      const raw = frontmatter?.['session-id'];
      const sessionId = typeof raw === 'string' ? raw.trim() : '';
      if (sessionId && sessionId !== ownId && frontmatter.status !== 'idle') {
        refusal = await liveForeignOwner(sessionId);
        if (refusal) return null;
      }
      return updateFrontmatterFields(contents, fields);
    },
    writeOpts,
  );
  if (!refusal) return result;
  process.stderr.write(`⚠ markStateMdCompletedOnDisk: refusing ${result.path} — ${refusal}; nothing written (#1640)\n`);
  return { ...result, written: false, reason: 'foreign-state-md' };
}

/**
 * Convenience wrapper: apply `touchUpdatedField` under the state-lock.
 *
 * @param {string} repoRoot  — absolute path to the repository root (required)
 * @param {string} [isoTimestamp]  — defaults to current time when omitted.
 * @param {object} [opts]
 * @returns {Promise<{ written: boolean, path: string, contents: string|null }>}
 * @throws {Error} when repoRoot is undefined, null, or empty
 */
export async function touchUpdatedFieldOnDisk(repoRoot, isoTimestamp, opts = {}) {
  requireRepoRoot(repoRoot, 'touchUpdatedFieldOnDisk');
  const ts = typeof isoTimestamp === 'string' && isoTimestamp.length > 0
    ? isoTimestamp
    : new Date().toISOString();
  return writeStateMd(repoRoot, (contents) => touchUpdatedField(contents, ts), opts);
}
