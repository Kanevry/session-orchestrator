/**
 * candidate-intake.mjs — Pure transform for the #647 C2 auto-repair engine.
 *
 * Ingests the two repair-candidate feeders and normalises them into a single
 * `RepairCandidate[]` shape:
 *   1. `/evolve` learnings (`.orchestrator/metrics/learnings.jsonl` records)
 *   2. `claude-md-drift-check` output (`driftResult.errors[]`)
 *
 * This module WRITES nothing. Its only read is target resolution for the
 * learnings feeder: at most one `git ls-files` per `extractCandidates` call
 * (lazy — only when a learning survives the cheaper filters), plus a
 * `realpathSync` containment check that applies with or without git. A
 * learning becomes a candidate only when its extracted path resolves — symlinks
 * followed — to a regular file inside the realpath of `repoRoot` that is also
 * the ONE tracked file it names (tracking is skipped when git is unavailable);
 * the kept `target_path` is the repo-relative form of that resolved file, so a
 * bare basename becomes its full path and `scripts/../x.mjs` becomes `x.mjs`. Persistence and
 * the `processed_at` / `superseded_by` lifecycle are OWNED BY the sibling
 * `idempotency.mjs` module — this module only emits the raw candidates with
 * those fields nulled out.
 *
 * The `id` field is a deterministic short hash of (source, target_path,
 * fingerprint), so the same input always yields the same id. That determinism
 * is the idempotency key the sibling module relies on.
 *
 * Part of Epic #643 → issue #647 (C2 auto-repair engine).
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * @typedef {Object} RepairCandidate
 * @property {string}      id              Deterministic short hash (idempotency key).
 * @property {1}          schema_version  Schema version, always 1.
 * @property {'evolve-learning'|'drift-check'} source  Originating feeder.
 * @property {string}     source_ref      Back-reference into the source feeder.
 * @property {string}     target_path     Repo-relative path the repair targets.
 * @property {number}     evidence        Numeric confidence/strength of the signal.
 * @property {'confidence'|'filesystem-fact'} evidence_kind  Interpretation of `evidence`.
 * @property {string}     proposed_change Short human-readable description of the fix.
 * @property {string}     rationale       Why this candidate exists.
 * @property {string}     created_at      ISO timestamp when the candidate was minted.
 * @property {null}       processed_at    Always null (idempotency.mjs sets this later).
 * @property {null}       superseded_by   Always null (idempotency.mjs sets this later).
 */

/** Drift-check checks that map to error candidates → `proposed_change` template. */
const DRIFT_PROPOSED_CHANGE = {
  'path-resolver': () => 'Update/remove stale absolute path',
  'project-count-sync': () => 'Sync project count',
  'session-file-existence': () => 'Remove/repoint missing session-file ref',
  'issue-reference-freshness': () =>
    'Move/remove closed issue ref out of forward-looking section',
  'session-config-parity': () => 'Add missing Session Config key',
  'vault-dir-parity': () => 'Reconcile vault-dir between CLAUDE.md and AGENTS.md',
};

/** Path-extraction regex: repo-relative dir paths OR bare known-extension filenames. */
const PATH_RE =
  /(scripts|skills|hooks|tests|docs)\/[\w./-]+|\b[\w-]+\.(mjs|md|json|js|ts)\b/;

/** Prescriptive-verb regex: the insight must propose an action, not merely describe. */
const PRESCRIPTIVE_RE =
  /\b(fix|change|switch|default|pin|port|remove|add|update|replace|disable|enable|require)\b/i;

/** Drift-check statuses that mean "no candidates to emit". */
const DRIFT_INERT_STATUSES = new Set(['skipped', 'skipped-mode-off', undefined]);

/**
 * Slugify a string for use inside the deterministic fingerprint. The exact form
 * is internal (it only feeds the hash) — kebab-case, alnum-only, collapsed.
 * @param {string} input
 * @returns {string}
 */
function slug(input) {
  return String(input ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Build the deterministic candidate id from its idempotency triple.
 * @param {string} source
 * @param {string} targetPath
 * @param {string} fingerprint
 * @returns {string}
 */
function makeId(source, targetPath, fingerprint) {
  const hash = createHash('sha256')
    .update(source + '\0' + targetPath + '\0' + fingerprint)
    .digest('hex')
    .slice(0, 8);
  return `rc-${hash}`;
}

/**
 * Extract the first repo-relative path from a candidate's text fields.
 * @param {string} text
 * @returns {string|null}
 */
function extractPath(text) {
  const match = PATH_RE.exec(String(text ?? ''));
  return match ? match[0] : null;
}

/**
 * Build the target resolver for ONE extraction run. `PATH_RE` also admits bare
 * basenames (`engine.mjs`, `mcp.json`) that exist nowhere at the repo root, so
 * an extracted path is a claim, not a target, until it resolves here.
 *
 * Resolution is fail-closed — `null` drops the candidate. In BOTH modes the
 * path is resolved with `realpathSync` (every symlink followed) and must land
 * on a regular file inside `realpathSync(repoRoot)`; any resolution error
 * drops it. The kept `target_path` is the repo-relative POSIX form of that
 * RESOLVED path, so `scripts/../CLAUDE.md` and `CLAUDE.md` name one target
 * (and mint one id). Containment follows `classifyTarget` in
 * `blast-radius-classifier.mjs`, plus the realpath of the target itself.
 *
 * With git, the resolved path must additionally be a tracked file:
 *   - a path containing `/` is resolved as given;
 *   - a bare basename must match exactly ONE tracked file (zero = unresolvable,
 *     two or more = ambiguous) and is resolved from that file's full path.
 * A tracked symlink whose target lies outside the repo is therefore dropped.
 *
 * The tracked-file index is read lazily and at most once per resolver
 * (`git ls-files -z` in `repoRoot`), so a run without a qualifying learning
 * never spawns git. Without git (binary missing, not a repository) only the
 * realpath containment applies — a bare basename then resolves only at the
 * root, since nothing enumerates the tree.
 *
 * @param {string} repoRoot
 * @returns {(extracted: string) => string|null}
 */
function makeTargetResolver(repoRoot) {
  /** @type {{ tracked: Set<string>, byBasename: Map<string, string[]> }|null|undefined} */
  let index; // undefined = not read yet, null = git unavailable

  // Canonicalise the root once, as blast-radius-classifier does: a symlinked
  // repoRoot (macOS /var → /private/var) must still anchor the escape check.
  let root;
  try {
    root = realpathSync(path.resolve(repoRoot));
  } catch {
    root = path.resolve(repoRoot);
  }

  function readIndex() {
    try {
      const out = execFileSync('git', ['ls-files', '-z'], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 64 * 1024 * 1024,
      });
      const tracked = new Set(out.split('\0').filter(Boolean));
      /** @type {Map<string, string[]>} */
      const byBasename = new Map();
      for (const file of tracked) {
        const base = file.slice(file.lastIndexOf('/') + 1);
        const list = byBasename.get(base);
        if (list) list.push(file);
        else byBasename.set(base, [file]);
      }
      return { tracked, byBasename };
    } catch {
      return null;
    }
  }

  /**
   * Realpath-resolve `rel` against the canonical root.
   * @param {string} rel
   * @returns {string|null} repo-relative POSIX path of the regular file it
   *   resolves to, or null when it escapes the root, is not a regular file, or
   *   does not resolve at all.
   */
  function resolveInsideRoot(rel) {
    let real;
    try {
      real = realpathSync(path.resolve(root, rel));
      if (!statSync(real).isFile()) return null;
    } catch {
      return null;
    }
    const back = path.relative(root, real);
    if (back === '' || back.startsWith('..') || path.isAbsolute(back)) return null;
    return back.split(path.sep).join('/');
  }

  return (extracted) => {
    if (index === undefined) index = readIndex();
    if (index === null) return resolveInsideRoot(extracted);
    let candidate = extracted;
    if (!extracted.includes('/')) {
      const matches = index.byBasename.get(extracted) ?? [];
      if (matches.length !== 1) return null;
      candidate = matches[0];
    }
    const resolved = resolveInsideRoot(candidate);
    return resolved !== null && index.tracked.has(resolved) ? resolved : null;
  };
}

/**
 * Map a single learning record to a RepairCandidate, or null when it fails any
 * actionable filter. learnings.jsonl records are NOT uniform — only `confidence`
 * and `created_at` are guaranteed — so id/subject/insight/evidence are handled
 * defensively.
 * @param {Record<string, unknown>} learning
 * @param {number} evidenceFloor
 * @param {string} nowIso
 * @param {(extracted: string) => string|null} resolveTarget
 * @returns {RepairCandidate|null}
 */
function learningToCandidate(learning, evidenceFloor, nowIso, resolveTarget) {
  if (!learning || typeof learning !== 'object') return null;

  // Filter 1: confidence gate.
  const confidence = /** @type {unknown} */ (learning.confidence);
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return null;
  if (confidence < evidenceFloor) return null;

  // Filter 4: not expired (missing expires_at ⇒ live).
  const expiresAt = learning.expires_at;
  if (typeof expiresAt === 'string' && expiresAt.length > 0 && expiresAt < nowIso) {
    return null;
  }

  const subject = typeof learning.subject === 'string' ? learning.subject : '';
  const insight = typeof learning.insight === 'string' ? learning.insight : '';

  // Filter 2: a path-shaped token in subject OR insight.
  const extracted = extractPath(subject) ?? extractPath(insight);
  if (!extracted) return null;

  // Filter 3: insight must be prescriptive.
  if (!PRESCRIPTIVE_RE.test(insight)) return null;

  // Filter 5: the token resolves to exactly one tracked file (last — it is the
  // only filter that may spawn git).
  const targetPath = resolveTarget(extracted);
  if (!targetPath) return null;

  const source = 'evolve-learning';
  const sourceRef = typeof learning.id === 'string' && learning.id.length > 0
    ? learning.id
    : null;
  const fingerprint = slug(targetPath + '-' + insight.slice(0, 80));

  return {
    id: makeId(source, targetPath, fingerprint),
    schema_version: 1,
    source,
    source_ref: sourceRef,
    target_path: targetPath,
    evidence: confidence,
    evidence_kind: 'confidence',
    proposed_change: insight,
    rationale: `evolve learning (confidence ${confidence}): ${insight}`,
    created_at: nowIso,
    processed_at: null,
    superseded_by: null,
  };
}

/**
 * Map a single drift-check error to a RepairCandidate. Drift errors are
 * filesystem facts (evidence 1.0). Unknown checks fall back to a generic
 * proposed-change derived from the check name.
 * @param {Record<string, unknown>} err
 * @param {string} nowIso
 * @returns {RepairCandidate|null}
 */
function driftErrorToCandidate(err, nowIso) {
  if (!err || typeof err !== 'object') return null;

  const check = typeof err.check === 'string' ? err.check : '';
  const file = typeof err.file === 'string' ? err.file : '';
  const line = err.line ?? '';
  const message = typeof err.message === 'string' ? err.message : '';

  // target_path is required — drift errors carry a repo-relative file already.
  if (!file) return null;

  const source = 'drift-check';
  const sourceRef = `${check}:${file}:${line}`;

  // Per-check proposed-change templates; command-count needs the actual count.
  let proposedChange;
  if (check === 'command-count') {
    // Prefer the STRUCTURED bare claimed number (checker.mjs:495 exposes
    // `command_count: { actual, claimed }` where `claimed` is `parseInt(m[1])`).
    // `err.extracted` is the FULL regex match (e.g. "8 commands"); using it here
    // produced the malformed double-word `'8 commands commands'` that the engine
    // whitelist regex (engine.mjs COMMAND_COUNT_SHAPE) correctly rejects — making
    // autonomous-apply dead code for this shape (#651 FIX 1).
    const claimed =
      (err.command_count && typeof err.command_count === 'object' && err.command_count !== null
        ? /** @type {Record<string, unknown>} */ (err.command_count).claimed
        : undefined) ?? err.extracted ?? '?';
    const actual =
      err.command_count && typeof err.command_count === 'object' && err.command_count !== null
        ? /** @type {Record<string, unknown>} */ (err.command_count).actual ?? '?'
        : '?';
    proposedChange = `Update narrative '${claimed} commands' to actual ${actual}`;
  } else if (Object.prototype.hasOwnProperty.call(DRIFT_PROPOSED_CHANGE, check)) {
    proposedChange = DRIFT_PROPOSED_CHANGE[check]();
  } else {
    proposedChange = `Resolve drift-check '${check}'`;
  }

  const fingerprint = slug(file + '-' + message.slice(0, 80));

  return {
    id: makeId(source, file, fingerprint),
    schema_version: 1,
    source,
    source_ref: sourceRef,
    target_path: file,
    evidence: 1.0,
    evidence_kind: 'filesystem-fact',
    proposed_change: proposedChange,
    rationale: message,
    created_at: nowIso,
    processed_at: null,
    superseded_by: null,
  };
}

/**
 * Ingest the two repair-candidate feeders and return a normalised
 * `RepairCandidate[]`. Writes nothing; learnings are resolved against the files
 * tracked in `repoRoot` (see `makeTargetResolver`). Drift errors pass through
 * unresolved — the checker reported them from a file it read.
 *
 * @param {Object} params
 * @param {Array<Record<string, unknown>>} [params.learnings] - `/evolve` learning records.
 * @param {{ status?: string, errors?: Array<Record<string, unknown>>, warnings?: unknown[] }|null} [params.driftResult]
 *        claude-md-drift-check output. Only `errors[]` are mapped; `warnings[]`
 *        are skipped. A null result, or a status of `skipped`/`skipped-mode-off`/
 *        undefined, emits zero drift candidates.
 * @param {string} [params.repoRoot] - repo root learning targets must resolve in
 *        (default `process.cwd()`). A learning is dropped unless its extracted
 *        path realpath-resolves to a regular file inside this root that is
 *        exactly one tracked file there (tracking skipped without git).
 * @param {number} [params.evidenceFloor=0.5] - minimum learning confidence to qualify.
 * @param {string} [params.now] - ISO timestamp for `created_at` + expiry checks (test determinism).
 * @returns {RepairCandidate[]}
 */
export function extractCandidates({
  learnings,
  driftResult,
  repoRoot,
  evidenceFloor = 0.5,
  now,
} = {}) {
  const nowIso = typeof now === 'string' && now.length > 0 ? now : new Date().toISOString();
  const floor = Number.isFinite(evidenceFloor) ? evidenceFloor : 0.5;
  const root = typeof repoRoot === 'string' && repoRoot.length > 0 ? repoRoot : process.cwd();
  const resolveTarget = makeTargetResolver(root);

  /** @type {RepairCandidate[]} */
  const candidates = [];

  // Feeder 1: /evolve learnings.
  if (Array.isArray(learnings)) {
    for (const learning of learnings) {
      const candidate = learningToCandidate(learning, floor, nowIso, resolveTarget);
      if (candidate) candidates.push(candidate);
    }
  }

  // Feeder 2: drift-check errors (skip when inert).
  if (
    driftResult &&
    typeof driftResult === 'object' &&
    !DRIFT_INERT_STATUSES.has(driftResult.status) &&
    Array.isArray(driftResult.errors)
  ) {
    for (const err of driftResult.errors) {
      const candidate = driftErrorToCandidate(err, nowIso);
      if (candidate) candidates.push(candidate);
    }
  }

  return candidates;
}
