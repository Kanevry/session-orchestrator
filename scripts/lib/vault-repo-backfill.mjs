#!/usr/bin/env node
/**
 * vault-repo-backfill.mjs — Pure inference layer for vault session→repo backfill.
 *
 * Infers the owning repo namespace for historical, flat-corpus vault SESSION notes
 * that predate per-repo namespacing (Issue #700 Vault-Coverage-Lift). Unlike
 * vault-relocation-rules.mjs (which classifies notes that already carry a `repo:` /
 * `project/<slug>` signal), this module recovers ownership for sessions whose only
 * recoverable signal is their `id` — by joining against authoritative cross-repo
 * indices that the CLI builds from each repo's `sessions.jsonl`.
 *
 * This module is PURE: no `fs`, no `child_process`, no `process.cwd()`, no network.
 * ALL cross-repo data (the sid + branch/date indices) is INJECTED by the caller.
 * The CLI walks the filesystem and builds the indices; this module only reasons.
 * The ONLY import is the pure, leak-guarding resolveRepoNamespace string function.
 *
 * Confidence tiers (W1-D5 frozen contract; W1-D2 evidence — do not re-litigate):
 *   - HIGH   ('sid-authoritative')  : frontmatter.id is in sidIndex AND that id maps
 *                                     to EXACTLY ONE repo. The sid-join is collision-
 *                                     free by construction (size===1 gate). 23 ids
 *                                     collide cross-repo → they hit SKIP, never HIGH.
 *   - SKIP   ('id-collision')       : id maps to >1 repo in sidIndex → ambiguous.
 *   - MEDIUM ('branchdate-unique')  : id NOT in sidIndex, but (branch,date) parsed
 *                                     from the id maps to EXACTLY ONE repo in bdIndex.
 *                                     Bare branch+date is UNSAFE (37/106 pairs collide)
 *                                     — that's exactly why MEDIUM also requires size===1.
 *   - SKIP   ('no-signal')          : no usable signal / ambiguous (branch+date >1 repo,
 *                                     or no parseable date token).
 *   - SKIP   ('leak-guarded')       : a tier resolved a repo, but the resolved namespace
 *                                     is 'redacted-repo' or 'unknown-repo'. A leak-guarded
 *                                     slug must NEVER become a confident move — this is the
 *                                     blast-radius floor for a mis-inferred PRIVATE slug on
 *                                     a future live --apply.
 */

import { resolveRepoNamespace } from './vault-mirror/namespace.mjs';

// ---------------------------------------------------------------------------
// Test seam — mirrors _setResolverForTest in vault-relocation-rules.mjs
// ---------------------------------------------------------------------------

/** @type {(opts: { vaultName: string | null }) => string} */
let _resolveNamespace = resolveRepoNamespace;

/**
 * Inject a custom namespace resolver for testing. Returns the previous resolver
 * so tests can restore it after each case.
 *
 * @param {(opts: { vaultName: string | null }) => string} fn
 * @returns {(opts: { vaultName: string | null }) => string}
 */
export function _setResolverForTest(fn) {
  const prev = _resolveNamespace;
  _resolveNamespace = fn;
  return prev;
}

// ---------------------------------------------------------------------------
// Leak-guard sentinels
// ---------------------------------------------------------------------------

const LEAK_GUARDED = new Set(['redacted-repo', 'unknown-repo']);

// ---------------------------------------------------------------------------
// Session-id parsing
// ---------------------------------------------------------------------------

/**
 * Parse a session id into its branch + date components.
 *
 * A session_id looks like `<branch>-YYYY-MM-DD-<suffix>` where the BRANCH MAY
 * CONTAIN HYPHENS (e.g. `feat-harness-reliability-2026-04-19-1515` → branch
 * `feat-harness-reliability`, date `2026-04-19`). The regex anchors on the date
 * token so a hyphenated branch is captured whole.
 *
 * @param {string} id
 * @returns {{ branch: string, date: string } | null} null when no date token is found.
 */
export function parseSessionId(id) {
  if (!id || typeof id !== 'string') return null;
  const m = id.match(/^(.*)-(\d{4}-\d{2}-\d{2})(?:-|$)/);
  if (!m) return null;
  const branch = m[1];
  const date = m[2];
  // A bare leading date ('2026-04-19-x') yields an empty branch — no (branch,date)
  // signal, since branch is part of the bdIndex key.
  if (!branch) return null;
  return { branch, date };
}

// ---------------------------------------------------------------------------
// Internal: leak-guarded namespace resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a repo basename to its vault namespace, then apply the leak-guard
 * downgrade. Returns either the confident namespace, or a SKIP result when the
 * resolved namespace is a leak-guard sentinel.
 *
 * @param {string} repoBasename - the single resolved repo basename
 * @returns {{ repo: string, confidence: 'HIGH'|'MEDIUM', source: string } | { repo: null, confidence: 'SKIP', source: 'leak-guarded' }}
 *   shaped via the caller passing through the intended confidence/source on success.
 */
function resolveWithLeakGuard(repoBasename, confidence, source) {
  const namespace = _resolveNamespace({ vaultName: repoBasename });
  if (LEAK_GUARDED.has(namespace)) {
    return { repo: null, confidence: 'SKIP', source: 'leak-guarded' };
  }
  return { repo: namespace, confidence, source };
}

/**
 * Extract the sole member of a Set, or null when the set is absent/empty/non-unique.
 *
 * @param {Set<string> | undefined} set
 * @returns {string | null}
 */
function soleMember(set) {
  if (!set || typeof set.size !== 'number' || set.size !== 1) return null;
  // Iterate to grab the single element.
  for (const v of set) return v;
  return null;
}

// ---------------------------------------------------------------------------
// Per-session inference
// ---------------------------------------------------------------------------

/**
 * Infer the owning repo namespace for a single vault session note.
 *
 * @param {object} frontmatter - parsed session frontmatter; only `id` is consulted.
 * @param {object} [opts]
 * @param {Map<string, Set<string>>} [opts.sidIndex] - Map<sessionId, Set<repoBasename>>:
 *   the AUTHORITATIVE join — which repos' sessions.jsonl carry this session_id.
 * @param {Map<string, Set<string>>} [opts.bdIndex] - Map<`${branch}|${date}`, Set<repoBasename>>:
 *   the branch+date fallback index.
 * @param {(o: { vaultName: string | null }) => string} [opts.resolveNamespace] -
 *   per-call override of the bound resolver (defaults to the module resolver).
 * @returns {{ repo: string | null, confidence: 'HIGH'|'MEDIUM'|'SKIP', source: string }}
 */
export function inferRepoForSession(frontmatter, opts = {}) {
  const {
    sidIndex = new Map(),
    bdIndex = new Map(),
    resolveNamespace,
  } = opts;

  // Allow a per-call resolver override without disturbing the module seam.
  const prev = resolveNamespace ? _setResolverForTest(resolveNamespace) : null;
  try {
    const id =
      frontmatter && typeof frontmatter.id === 'string' ? frontmatter.id.trim() : '';

    // --- Tier 1: authoritative sid-join (HIGH / id-collision SKIP) ---
    if (id && sidIndex.has(id)) {
      const repos = sidIndex.get(id);
      if (repos && repos.size > 1) {
        return { repo: null, confidence: 'SKIP', source: 'id-collision' };
      }
      const sole = soleMember(repos);
      if (sole) {
        return resolveWithLeakGuard(sole, 'HIGH', 'sid-authoritative');
      }
      // Defensive: an empty Set under a present key carries no signal — fall through.
    }

    // --- Tier 2: branch+date fallback (MEDIUM / no-signal SKIP) ---
    if (id) {
      const parsed = parseSessionId(id);
      if (parsed) {
        const key = `${parsed.branch}|${parsed.date}`;
        const repos = bdIndex.get(key);
        const sole = soleMember(repos);
        if (sole) {
          return resolveWithLeakGuard(sole, 'MEDIUM', 'branchdate-unique');
        }
      }
    }

    // --- No usable signal / ambiguous ---
    return { repo: null, confidence: 'SKIP', source: 'no-signal' };
  } finally {
    if (prev) _setResolverForTest(prev);
  }
}

// ---------------------------------------------------------------------------
// Convenience index builder
// ---------------------------------------------------------------------------

/**
 * Build a backfill index from already-parsed vault session notes.
 *
 * The CLI parses each vault session file into `{ id, frontmatter }`; this stays
 * pure and only reasons over the injected indices. Returns ONLY confident entries
 * (HIGH or MEDIUM); SKIP entries are omitted.
 *
 * @param {Array<{ id: string, frontmatter: object }>} parsedVaultSessions
 * @param {object} [opts] - forwarded to inferRepoForSession (sidIndex, bdIndex, resolveNamespace).
 * @returns {Map<string, { repo: string, confidence: 'HIGH'|'MEDIUM', source: string }>}
 *   keyed by sessionId.
 */
export function buildBackfillIndex(parsedVaultSessions, opts = {}) {
  const out = new Map();
  if (!Array.isArray(parsedVaultSessions)) return out;

  for (const entry of parsedVaultSessions) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, frontmatter } = entry;
    if (!id || typeof id !== 'string') continue;

    const result = inferRepoForSession(frontmatter ?? {}, opts);
    if (isBackfillDerivable(result.confidence)) {
      out.set(id, result);
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Derivability predicate
// ---------------------------------------------------------------------------

/**
 * Single source of truth for "feeds --derivable-only": a confidence tier is
 * derivable iff it is HIGH or MEDIUM. SKIP (any source) is not derivable.
 *
 * @param {string} confidence
 * @returns {boolean}
 */
export function isBackfillDerivable(confidence) {
  return confidence === 'HIGH' || confidence === 'MEDIUM';
}
