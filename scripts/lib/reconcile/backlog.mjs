/**
 * backlog.mjs — LEAF module for the reconcile BACKLOG count (#1380 follow-up).
 *
 * Holds the side-effect-free half of the reconcile pipeline: the corpus/sidecar/
 * provenance readers, the materialization partition, and the backlog count the
 * session-start nudge judges on. Split out of `engine.mjs` so a read-only probe
 * no longer has to import the WRITE-capable orchestrator to ask a counting
 * question.
 *
 * ── Why a separate file, and what "leaf" binds to ───────────────────────────
 * `scripts/lib/reconcile-nudge-banner.mjs` is a session-start probe: it renders
 * one advisory line and touches nothing. Importing `countReconcileBacklog` from
 * `engine.mjs` pulled the renderer, the emitter, the unicode-safety validator and
 * the candidate-store writer into that probe's static closure — measured
 * 2026-09-18: 11 modules / 151,946 B before the engine import, 19 modules /
 * 322,897 B after (+112 %), inherited unasked by
 * `scripts/lib/maintenance-due-banner.mjs`, which imports the probe.
 * The runtime cost was never the problem (0.55 % of the 2-s probe budget); the
 * DIRECTION was — a banner must not be able to reach a writer.
 *
 * So this module imports ONLY `node:*` plus light siblings that are themselves
 * free of write paths: `../learnings/kebab.mjs`, `../learnings/schema.mjs`,
 * `./eligibility.mjs` (pure partition) and `./idempotency.mjs` (its READ half —
 * `loadCandidates` / `isProcessed`; `mergeCandidates`, the only writer there, is
 * never referenced from here). It MUST NOT import `./engine.mjs`,
 * `./emitter.mjs`, `./renderer.mjs` or `./writer.mjs` — a future import of any
 * of those re-creates exactly the coupling this file exists to break.
 *
 * `engine.mjs` imports from here and RE-EXPORTS `partitionMaterialized` +
 * `countReconcileBacklog`, so every existing caller keeps working unchanged.
 *
 * Cross-references:
 *  - `scripts/lib/reconcile/engine.mjs` — the orchestrator (write side).
 *  - `scripts/lib/reconcile-nudge-banner.mjs` — the probe that imports this leaf.
 *  - `.claude/rules/host-resources.md` § HR-106 — the banner reports what the rule judges.
 *  - Issues #484 / #1242 (dedupe contract), #1380 (backlog vs. eligible).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { learningKeyOf } from '../learnings/kebab.mjs';
import { migrateLegacyLearning, normalizeLearning } from '../learnings/schema.mjs';
import { filterEligible } from './eligibility.mjs';
import { isProcessed, loadCandidates as realLoadCandidates } from './idempotency.mjs';

/** Default repo-relative location of the learnings corpus. */
export const DEFAULT_LEARNINGS_PATH = '.orchestrator/metrics/learnings.jsonl';

/**
 * Default learnings loader — read + parse `<repoRoot>/.orchestrator/metrics/learnings.jsonl`
 * line-by-line, migrate/normalize records through the learnings schema SSOT,
 * and skip blank/malformed lines. A missing file (ENOENT) yields `[]`
 * silently; an unreadable one (EACCES/EISDIR/…) yields `[]` with a stderr
 * WARN (#1210 — ENOENT and other read failures are different facts, same
 * split as `sessions-canonical.mjs` `readCanonicalSessions`).
 *
 * @param {string|undefined} repoRoot
 * @returns {Array<Record<string, unknown>>}
 */
export function defaultLoadLearnings(repoRoot) {
  const root = typeof repoRoot === 'string' && repoRoot.length > 0 ? repoRoot : process.cwd();
  const absPath = isAbsolute(DEFAULT_LEARNINGS_PATH)
    ? DEFAULT_LEARNINGS_PATH
    : join(root, DEFAULT_LEARNINGS_PATH);

  let raw;
  try {
    raw = readFileSync(absPath, 'utf8');
  } catch (err) {
    if (!err || err.code !== 'ENOENT') {
      process.stderr.write(
        `⚠ defaultLoadLearnings: cannot read ${absPath} ` +
          `(${err?.code ?? '?'}: ${err?.message ?? String(err)}) — ` +
          'treating as EMPTY, counts below are floors\n',
      );
    }
    return [];
  }

  /** @type {Array<Record<string, unknown>>} */
  const records = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // skip malformed line
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      records.push(
        /** @type {Record<string, unknown>} */ (normalizeLearning(migrateLegacyLearning(parsed))),
      );
    }
  }
  return records;
}

/**
 * Bring an INJECTED corpus onto the same dialect {@link defaultLoadLearnings}
 * produces, so "which learnings were counted" cannot depend on WHO read the file.
 *
 * The nudge loads the corpus through `readLearnings` (`../learnings/io.mjs`),
 * which applies `normalizeLearning` but NOT `migrateLegacyLearning` — so a
 * record still carrying the legacy `files` key would reach the eligibility gate
 * without its `file_paths` axis and be rejected here while `/reconcile` (which
 * loads via `defaultLoadLearnings`) accepts it. Two populations in one banner
 * line is the HR-106 defect; running the injected corpus through the same two
 * functions removes the fork at its source rather than asking every caller to
 * remember.
 *
 * Both functions are idempotent on already-normalized records (verified
 * 2026-09-18 against this repo's corpus), so the pass is a no-op for a corpus
 * that already went through the loader. A record the normalizer rejects is kept
 * VERBATIM rather than dropped: the eligibility gate downstream is the place
 * that decides a record's fate, and silently shrinking the denominator here
 * would under-report the backlog.
 *
 * @param {Array<Record<string, unknown>>} learnings
 * @returns {Array<Record<string, unknown>>}
 */
function normalizeInjectedCorpus(learnings) {
  return learnings.map((entry) => {
    try {
      return /** @type {Record<string, unknown>} */ (normalizeLearning(migrateLegacyLearning(entry)));
    } catch {
      return entry;
    }
  });
}

/**
 * Default sidecar-candidate loader for the issue #484 idempotency dedupe
 * check. Deliberately gated on `repoRoot` being a caller-supplied, non-empty
 * string — UNLIKE `defaultLoadLearnings` and `mergeCandidates`, this does NOT
 * fall back to `process.cwd()` when `repoRoot` is absent. Every existing engine
 * test exercises the pipeline via injected learnings with no `repoRoot`,
 * precisely to avoid touching this repo's OWN
 * `.orchestrator/runtime/reconcile-candidates.jsonl`; a cwd fallback here would
 * silently read it.
 *
 * @param {string|undefined} repoRoot
 * @returns {{ records: import('./idempotency.mjs').ReconcileCandidate[] }}
 */
export function defaultLoadCandidatesForDedupe(repoRoot) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) return { records: [] };
  const { records } = realLoadCandidates({ repoRoot });
  return { records };
}

/** Frontmatter form emitted by renderer.mjs: `learning-key: <value>` (no backticks, no leading dash). */
const FRONTMATTER_LEARNING_KEY_RE = /^learning-key:\s*(.+)$/gm;
/** Provenance-body form emitted by renderer.mjs: `` - learning-key: `<value>` ``. */
const BODY_LEARNING_KEY_RE = /-\s*learning-key:\s*`([^`]+)`/g;
/** Provenance-body form emitted by renderer.mjs: `` - learning-id: `<value>` ``. */
const BODY_LEARNING_ID_RE = /-\s*learning-id:\s*`([^`]+)`/g;

/**
 * Scan `<repoRoot>/.claude/rules/*.md` for the provenance markers the
 * renderer stamps on every machine-generated rule — the frontmatter
 * `learning-key:` line and the body `## Provenance` block's `learning-key`/
 * `learning-id` bullets (`renderer.mjs`) — and return the two identity sets a
 * learning can already be materialized under. A learning whose derived
 * `learning_key` OR raw `.id` appears in either set already has a rule file
 * on disk: re-proposing it is the issue #484 defect (9 of 10 proposals in one
 * run were learnings a `.claude/rules/` file already covered).
 *
 * **This scan is the AUTHORITATIVE half of the dedupe contract** (#1242). The
 * `.claude/rules/*.md` files it reads are TRACKED, so they survive a fresh
 * clone, a wiped working copy, and any loss of `.orchestrator/runtime/` (which
 * is gitignored — `.gitignore:114`). The idempotency sidecar consulted beside
 * it is a CACHE that can only SHORT-CIRCUIT this scan, never replace it: on a
 * fresh clone the sidecar is empty and correctness rests entirely on the
 * markers below. Measured 2026-09-07 on this repo: with the sidecar emptied,
 * the run produced the identical 10 proposals and 30 "already materialized"
 * rejections; with this scan disabled instead, 5 already-consolidated
 * learnings were re-proposed.
 *
 * Both marker forms are load-bearing. Frontmatter `learning-key:` is a YAML
 * SCALAR and can name exactly ONE learning, so a CONSOLIDATED rule file (one
 * file absorbing N learnings) carries the remaining N-1 identities ONLY as
 * `## Provenance` body bullets. Breaking {@link BODY_LEARNING_KEY_RE} would
 * therefore silently re-propose most of a consolidated corpus while every
 * single-learning file still deduped correctly — pinned by the "fresh clone,
 * consolidated shape" test in `tests/lib/reconcile/engine.test.mjs`.
 *
 * `rule-loader.mjs` only EXCLUDES expired rules from injection; it never
 * deletes a file, so an expired rule keeps deduping through these markers.
 *
 * Gated the same way as {@link defaultLoadCandidatesForDedupe}: an absent
 * `repoRoot` yields empty sets rather than falling back to `process.cwd()`.
 * Never throws — a missing `.claude/rules/` dir or an unreadable file
 * degrades to "nothing materialized" for that source, never a crash.
 * @param {string|undefined} repoRoot
 * @returns {{ keys: Set<string>, ids: Set<string> }}
 */
export function defaultReadMaterializedProvenance(repoRoot) {
  const keys = new Set();
  const ids = new Set();
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) return { keys, ids };

  const rulesDir = join(repoRoot, '.claude', 'rules');
  let entries;
  try {
    entries = readdirSync(rulesDir);
  } catch {
    return { keys, ids }; // no rules dir yet → nothing materialized
  }

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    let content;
    try {
      content = readFileSync(join(rulesDir, entry), 'utf8');
    } catch {
      continue; // unreadable file — skip it, do not fail the whole scan
    }
    for (const m of content.matchAll(FRONTMATTER_LEARNING_KEY_RE)) {
      const v = m[1].trim();
      if (v) keys.add(v);
    }
    for (const m of content.matchAll(BODY_LEARNING_KEY_RE)) {
      const v = m[1].trim();
      if (v) keys.add(v);
    }
    for (const m of content.matchAll(BODY_LEARNING_ID_RE)) {
      const v = m[1].trim();
      if (v && v !== 'n/a') ids.add(v);
    }
  }
  return { keys, ids };
}

/**
 * Split rule-eligible learnings into the ones still awaiting a rule and the ones
 * already materialized (#484/#1242 dedupe contract). A learning is materialized
 * when the idempotency sidecar carries a terminal verdict for its `learning_key`
 * (CACHE) OR a `.claude/rules/*.md` provenance marker names its key/id
 * (AUTHORITATIVE).
 *
 * Pure: reads nothing, writes nothing, emits nothing — the engine and the
 * session-start reconcile nudge share it so both judge the same backlog (#1380).
 *
 * @param {Array<Record<string, unknown>>} eligible - output of `filterEligible().eligible`.
 * @param {{ existingCandidates: import('./idempotency.mjs').ReconcileCandidate[], materialized: { keys: Set<string>, ids: Set<string> } }} sources
 * @returns {{
 *   stillEligible: Array<Record<string, unknown>>,
 *   materializedItems: Array<{ learning: Record<string, unknown>, learningKey: string|null, sidecarTerminal: boolean, onDisk: boolean }>,
 * }}
 */
export function partitionMaterialized(eligible, { existingCandidates, materialized }) {
  /** @type {Array<Record<string, unknown>>} */
  const stillEligible = [];
  const materializedItems = [];
  for (const learning of eligible) {
    const learningKey = learningKeyOf(learning);
    const learningId =
      learning &&
      typeof learning === 'object' &&
      typeof learning.id === 'string' &&
      learning.id.length > 0
        ? learning.id
        : null;

    const sidecarTerminal =
      learningKey !== null && isProcessed({ learning_key: learningKey }, existingCandidates);
    const onDisk =
      (learningKey !== null && materialized.keys.has(learningKey)) ||
      (learningId !== null && materialized.ids.has(learningId));

    if (!sidecarTerminal && !onDisk) {
      stillEligible.push(learning);
    } else {
      materializedItems.push({ learning, learningKey, sidecarTerminal, onDisk });
    }
  }
  return { stillEligible, materializedItems };
}

/**
 * Count the reconcile BACKLOG the way a real `/reconcile` run would see it:
 * rule-eligible learnings (expiry-gated by `now`) minus those already
 * materialized in the sidecar or under `.claude/rules/`. This is the quantity
 * `/reconcile` can actually drive to zero — the session-start nudge judges on it
 * (#1380; HR-101: a probe that counts already-materialized learnings can never
 * go green).
 *
 * Side-effect-free (no event, no sidecar write) so session-start probes may call
 * it. Never throws — any failure degrades to all-zero counts.
 *
 * @param {object} [params]
 * @param {string} [params.repoRoot] - repo root; required for the sidecar + rules scan
 *        (absent → both sources are empty, same gate as the engine defaults).
 * @param {Array<Record<string, unknown>>} [params.learnings] - injected corpus;
 *        defaults to {@link defaultLoadLearnings} for
 *        `<repoRoot>/.orchestrator/metrics/learnings.jsonl`. An injected corpus is
 *        run through {@link normalizeInjectedCorpus} first, so injecting can never
 *        silently count a DIFFERENT population than loading would.
 * @param {import('./idempotency.mjs').ReconcileCandidate[]} [params.existingCandidates]
 *        already-loaded sidecar records (DI seam for a caller that read the store
 *        itself — the session-start nudge does, for the last-run timestamp). Absent
 *        ⇒ this function reads the store via {@link defaultLoadCandidatesForDedupe}.
 * @param {Date|number} [params.now] - clock for the expiry gate (defaults to `Date.now()`).
 * @param {number} [params.minInsightChars] - forwarded to `filterEligible`.
 * @returns {{ eligible: number, alreadyMaterialized: number, backlog: number }}
 */
export function countReconcileBacklog({
  repoRoot,
  learnings,
  existingCandidates,
  now,
  minInsightChars,
} = {}) {
  try {
    const corpus = Array.isArray(learnings)
      ? normalizeInjectedCorpus(learnings)
      : defaultLoadLearnings(repoRoot);
    if (corpus.length === 0) return { eligible: 0, alreadyMaterialized: 0, backlog: 0 };
    const nowMs =
      now instanceof Date ? now.getTime() : typeof now === 'number' ? now : Date.now();
    const { eligible } = filterEligible(corpus, { now: nowMs, minInsightChars });
    const { stillEligible, materializedItems } = partitionMaterialized(eligible, {
      existingCandidates: Array.isArray(existingCandidates)
        ? existingCandidates
        : defaultLoadCandidatesForDedupe(repoRoot).records,
      materialized: defaultReadMaterializedProvenance(repoRoot),
    });
    return {
      eligible: eligible.length,
      alreadyMaterialized: materializedItems.length,
      backlog: stillEligible.length,
    };
  } catch {
    return { eligible: 0, alreadyMaterialized: 0, backlog: 0 };
  }
}
