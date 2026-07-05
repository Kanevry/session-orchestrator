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
import { dirname, join, resolve as resolvePath } from 'node:path';
import { parseStateMd, serializeStateMd } from './yaml-parser.mjs';
import { withStateMdLock } from '../session-lock.mjs';

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

// Canonical STATE.md path candidates (matches harness-audit category1 order).
const STATE_MD_CANDIDATES = [
  '.claude/STATE.md',
  '.codex/STATE.md',
  '.cursor/STATE.md',
  '.pi/STATE.md',
];

function preferredStateMdCandidate() {
  const envStateDir = process.env.SO_STATE_DIR;
  if (typeof envStateDir === 'string' && envStateDir.length > 0) {
    return join(envStateDir, 'STATE.md');
  }
  switch (process.env.SO_PLATFORM) {
    case 'codex': return '.codex/STATE.md';
    case 'cursor': return '.cursor/STATE.md';
    case 'pi': return '.pi/STATE.md';
    default: return '.claude/STATE.md';
  }
}

function orderedStateMdCandidates() {
  const preferred = preferredStateMdCandidate();
  return [
    preferred,
    ...STATE_MD_CANDIDATES.filter((candidate) => candidate !== preferred),
  ];
}

/**
 * Resolve the active STATE.md path under a given repo root.
 *
 * Returns the first existing candidate, checking the active platform first.
 * Falls back to the active platform's state dir when none exist (matches the
 * create-on-first-write semantics expected by callers).
 *
 * @param {string|undefined} repoRoot
 * @returns {string}  Absolute path to STATE.md.
 */
export function resolveStateMdPath(repoRoot) {
  const root = repoRoot ?? process.cwd();
  const candidates = orderedStateMdCandidates();
  for (const candidate of candidates) {
    const abs = resolvePath(join(root, candidate));
    if (existsSync(abs)) return abs;
  }
  return resolvePath(join(root, candidates[0]));
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
// (`serializeStateMd(parseStateMd(after)) === after`) — was evaluated and
// deliberately NOT shipped as a rejection gate. Verified against both the
// live repo's `.claude/STATE.md` (clean fixpoint) AND a legitimate fixture
// whose scalar merely CONTAINS a literal double-quote character (e.g.
// `goal: "investigate the \"leak\" in the serializer"`): the round-trip
// check flags that fixture as a non-fixpoint on its very FIRST write, before
// any corruption has occurred — i.e. it false-positives on ordinary content,
// not just on already-ballooning content. Shipping it as a hard reject would
// block legitimate operator-authored strings. Left as a follow-up: the real
// fix is closing the parseScalar/serializeScalar asymmetry (unescape on
// parse, not just strip-quotes), not gating on the symptom.

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
 * @returns {Promise<{ written: boolean, path: string, contents: string|null, reason?: string }>}
 */
export async function writeStateMd(repoRoot, transformer, opts = {}) {
  if (typeof transformer !== 'function') {
    throw new TypeError('writeStateMd: transformer must be a function');
  }
  const statePath = resolveStateMdPath(repoRoot);
  return withStateMdLock(
    repoRoot,
    async () => {
      const before = existsSync(statePath) ? readFileSync(statePath, 'utf8') : '';
      const after = await transformer(before);
      if (after === null || after === undefined) {
        return { written: false, path: statePath, contents: null };
      }
      if (typeof after !== 'string') {
        throw new TypeError('writeStateMd: transformer must return a string or null');
      }
      if (after === before) {
        // No textual change — skip the write to keep mtime stable.
        return { written: false, path: statePath, contents: before };
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
