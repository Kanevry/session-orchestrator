/**
 * writer.mjs — FA3 writer seam for the Reconciliation Engine (Epic #693, issue #696).
 *
 * Persists APPROVED reconciliation rule proposals AFTER operator approval, to
 * every target named in `opts.targets` (issue #1099 — `repo-local` ⇒
 * `<repoRoot>/.claude/rules/`, `baseline` ⇒ `<baselineRoot>/proposals/`; the
 * CLOSED table is {@link TARGET_DIRS}, and a target with no row writes nothing).
 * This is the one and only module that writes rule files on behalf of the engine
 * — the FA2 engine/renderer NEVER touch the filesystem for rule files.
 *
 * Responsibilities:
 *  - Acquire a per-write file lock (`.orchestrator/rules.lock`) to serialise
 *    concurrent writers — mirrors PSA-005 (withStateMdLock) pattern.
 *  - For each approved proposal: path-safety guard → STRUCTURAL content gate
 *    (#1015, see {@link frontmatterRefusalReason}) → mkdirSync → atomic
 *    tmp+rename write → stamp the idempotency sidecar terminal via
 *    `markCandidateProcessed` (issue #484 point 1) so a later reconcile run's
 *    `isProcessed()` check does not re-propose the same learning.
 *  - For each rejected proposal: JSONL-append to `.orchestrator/reconcile.rejected.log`,
 *    and — for an OPERATOR rejection only (see {@link isOperatorRejection}) —
 *    stamp the idempotency sidecar terminal with `outcome: 'rejected'` (issue
 *    #1042) so the operator's "no" survives into the next run.
 *  - Never throws — all failures are collected into errors[] and returned.
 *
 * Path-safety (re-anchored per target in #1099, NOT widened):
 *  - `validatePathInsideProject(<rel>, <target root>, {canonicalizeRoot:true})` is
 *    the primary guard (two-phase lexical + realpath, CWE-22 defence).
 *  - Additional assertion: the resolved path must be inside that target's fixed
 *    subdirectory. Anchored on `repoRoot` — the pre-#1099 hardcoding — it would
 *    reject every baseline path, which is why re-anchoring is the fix.
 *  - For `leaf: 'slug'` targets the filename is derived from `item.slug`, never
 *    from `item.path`, and must match {@link SLUG_RE}. `slug` is
 *    `kebab()`-produced (`[a-z0-9-]` only), so that branch has no
 *    attacker-controllable path component at all.
 *  - All applicable guards must pass; failure skips the (item, target) pair and
 *    pushes an error string.
 *
 * Atomic write strategy (rule files):
 *  - Write content to `<target>.XXXXXXXX.tmp` via `writeFileSync`, then
 *    `renameSync` over the final path. Same-filesystem rename is atomic on POSIX,
 *    so the rule file is never partially visible. Mirrors idempotency.mjs pattern.
 *
 * JSONL append strategy (rejected log):
 *  - `appendFileSync` for the rejected log — each record is a self-contained line,
 *    and POSIX append (O_APPEND) is atomic for writes < PIPE_BUF (4096 bytes),
 *    which every JSONL record satisfies. Mirrors memory-proposals/sink.mjs pattern.
 *
 * DI-friendly: accepts repoRoot as a parameter; no global cwd assumptions.
 *
 * Plain Node ESM, no external deps — Node 20+ stdlib + sibling scripts/lib only.
 *
 * Part of Epic #693 → issue #696 (FA3 Advisory Delivery).
 *
 * @module reconcile/writer
 */

import { mkdirSync, writeFileSync, renameSync, appendFileSync, realpathSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { withFileLock } from '../file-lock.mjs';
import { validatePathInsideProject } from '../path-utils.mjs';
import { parseGlobsFrontmatter } from '../rule-loader.mjs';
import { markCandidateProcessed } from './idempotency.mjs';

// ---------------------------------------------------------------------------
// Path constants (relative to repoRoot)
// ---------------------------------------------------------------------------

/** Lock file that serialises concurrent rule-write operations. */
const RULES_LOCK_REL = path.join('.orchestrator', 'rules.lock');

/** Directory where auto-generated rule files are written (repo-relative). */
const RULES_DIR_REL = path.join('.claude', 'rules');

/** Rejected-proposals log for rules declined by the operator (repo-relative). */
const REJECTED_LOG_REL = path.join('.orchestrator', 'reconcile.rejected.log');

/**
 * CLOSED write-target table (issue #1099).
 *
 * A target with NO ROW HERE writes NOTHING — the absence of a row IS the
 * refusal, so adding a target stays a deliberate, reviewable act rather than a
 * fall-through. `global` is documented-but-unimplemented upstream (see
 * `VALID_TARGETS` in `scripts/lib/config/reconcile.mjs`) and deliberately has no
 * row here either.
 *
 * Per row:
 *  - `root`   — which key of the caller-supplied roots map anchors the write.
 *  - `subdir` — the fixed subdirectory under that root. NEVER caller-supplied.
 *  - `leaf`   — where the FILENAME comes from:
 *      `'path'` → `item.path` (repo-local). This is the pre-#1099 contract and
 *        stays: the three live path-traversal tests in
 *        `tests/lib/reconcile/writer.test.mjs` are the standing proof that its
 *        guard bites, and switching repo-local to slug-derivation would make
 *        `item.path` unreachable and silently retire them.
 *      `'slug'` → `item.slug` (baseline). `slug` comes from `deriveSlug`
 *        (`renderer.mjs`), which is `kebab()`-produced and therefore
 *        `[a-z0-9-]`-only — so the baseline branch has NO attacker-controllable
 *        path component at all. {@link SLUG_RE} re-asserts that here rather than
 *        trusting the upstream derivation.
 *  - `requireExistingRoot` — when true the root must ALREADY exist as a
 *        directory and is NEVER created. A typo'd baseline path must not
 *        silently mint a whole directory tree that looks like a successful write.
 */
const TARGET_DIRS = Object.freeze({
  'repo-local': Object.freeze({
    root: 'repoRoot',
    subdir: RULES_DIR_REL,
    leaf: 'path',
    requireExistingRoot: false,
  }),
  baseline: Object.freeze({
    root: 'baselineRoot',
    subdir: 'proposals',
    leaf: 'slug',
    requireExistingRoot: true,
  }),
});

/** Default target set — byte-identical to the pre-#1099 behaviour. */
const DEFAULT_TARGETS = Object.freeze(['repo-local']);

/**
 * The only shape a slug-derived filename may take. Mirrors exactly what
 * `kebab()` (`scripts/lib/learnings/kebab.mjs`) can produce: lowercase
 * alphanumerics and hyphens, never a leading hyphen. `.`, `..`, `/`, `\` and
 * every absolute form are unrepresentable, so a crafted slug cannot traverse.
 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Normalise the caller's target list: strings only, de-duplicated,
 * order-preserving.
 *
 * OMITTED (`undefined`/non-array) ⇒ {@link DEFAULT_TARGETS} — the pre-#1099
 * back-compat path. An EXPLICIT empty array ⇒ stays empty, and that distinction
 * is load-bearing rather than pedantic: `resolveEffectiveTargets`
 * (`engine.mjs`) returns `[]` when `targets: [baseline]` was declared and the
 * baseline root turned out unusable. Defaulting that `[]` back to
 * `['repo-local']` would silently redirect a baseline-only write INTO this repo
 * — the operator asked for one destination and would get a different one.
 * Nothing is written for an empty list; the caller sees one `errors[]` entry
 * rather than a success-shaped no-op.
 *
 * @param {unknown} targets
 * @returns {string[]}
 */
function normalizeTargets(targets) {
  if (!Array.isArray(targets)) return [...DEFAULT_TARGETS];
  return [...new Set(targets.filter((t) => typeof t === 'string' && t.length > 0))];
}

/**
 * @typedef {Object} PreparedTarget
 * @property {boolean} ok    - false ⇒ every write to this target is skipped.
 * @property {string}  [dir] - canonical absolute directory writes land in.
 * @property {string}  [root]- canonical absolute root the confinement anchors on.
 * @property {object}  [spec]- the {@link TARGET_DIRS} row.
 */

/**
 * Prepare ONE write target: resolve its root, refuse a missing or non-existent
 * root, create only the fixed subdirectory, and run the parent-symlink
 * hardening check.
 *
 * Runs once per distinct target rather than once per batch (pre-#1099 it was a
 * single `rulesDirSafe` boolean): with two targets a symlinked `.claude/rules/`
 * must disqualify repo-local WITHOUT also disqualifying baseline, and vice
 * versa.
 *
 * @param {string} target
 * @param {{repoRoot?: string, baselineRoot?: string}} roots
 * @param {string[]} errors - mutated in place with any refusal reason.
 * @returns {PreparedTarget}
 */
function prepareTarget(target, roots, errors) {
  const spec = TARGET_DIRS[target];
  if (!spec) {
    errors.push(
      `target "${target}": no row in the write-target table — nothing written (known targets: ${Object.keys(TARGET_DIRS).join(', ')})`,
    );
    return { ok: false };
  }

  const root = roots[spec.root];
  if (typeof root !== 'string' || root.length === 0) {
    errors.push(`target "${target}": no ${spec.root} supplied — skipped (no-op, not a failure)`);
    return { ok: false };
  }

  if (spec.requireExistingRoot) {
    let isDir;
    try {
      isDir = statSync(root).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      errors.push(
        `target "${target}": root "${root}" does not exist as a directory — skipped; a non-existent root is NEVER created (a typo would otherwise mint a directory tree that looks like a successful write)`,
      );
      return { ok: false };
    }
  }

  let canonRoot = root;
  try {
    canonRoot = realpathSync(root);
  } catch {
    /* ENOENT/EACCES: fall back to the lexical root */
  }
  const expectedDir = path.resolve(canonRoot, spec.subdir);

  // Parent-directory symlink hardening (#697 security follow-up, re-anchored per
  // target in #1099): if the subdir is itself a pre-planted symlink to a
  // directory outside its root, a lexically-safe leaf path would still be
  // written through it. Requires local FS write access to exploit (below the VCS
  // trust boundary) but the guard is one cheap call. mkdir creates ONLY the
  // fixed subdir — the root's own existence was decided above.
  try {
    mkdirSync(path.resolve(root, spec.subdir), { recursive: true });
    const realDir = realpathSync(path.resolve(root, spec.subdir));
    if (realDir !== expectedDir && !realDir.startsWith(expectedDir + path.sep)) {
      errors.push(
        `path-confinement: ${spec.subdir}/ resolves outside "${root}" (symlinked dir) — all approved writes to target "${target}" skipped`,
      );
      return { ok: false };
    }
  } catch {
    /* mkdir/realpath failure — per-item writes will surface errors normally */
  }

  return { ok: true, dir: expectedDir, root: canonRoot, spec };
}

/**
 * Resolve the absolute write target for ONE (item, target) pair.
 *
 * Both leaf strategies end in the SAME two guards — `validatePathInsideProject`
 * (two-phase lexical + realpath, CWE-22 defence) plus a belt-and-braces
 * `startsWith` assertion — anchored on the PER-TARGET root. Anchoring them on
 * `repoRoot` (the pre-#1099 hardcoding) would reject every baseline path, so
 * re-anchoring is what keeps this a re-aim rather than a widening.
 *
 * @param {WriterApprovedItem} item
 * @param {string} target
 * @param {PreparedTarget} prep
 * @param {{repoRoot?: string, baselineRoot?: string}} roots
 * @param {string[]} errors - mutated in place with any refusal reason.
 * @returns {string|null} absolute destination path, or null when refused.
 */
function resolveDest(item, target, prep, roots, errors) {
  const spec = prep.spec;
  const root = roots[spec.root];

  /** @type {string} */
  let candidateRel;

  if (spec.leaf === 'slug') {
    const slug = item.slug;
    if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
      errors.push(
        `slug-safety: target "${target}" derives its filename from item.slug, and ${JSON.stringify(slug)} is not a bare kebab slug (${SLUG_RE}) — skipped`,
      );
      return null;
    }
    candidateRel = path.join(spec.subdir, `${slug}.md`);
  } else {
    if (!item || typeof item.path !== 'string' || item.path.length === 0) {
      errors.push(`approved item missing path: ${JSON.stringify(item)}`);
      return null;
    }
    candidateRel = item.path;
  }

  const pathResult = validatePathInsideProject(candidateRel, root, { canonicalizeRoot: true });
  if (!pathResult.ok) {
    errors.push(`path-safety (${pathResult.reason}): "${candidateRel}" [target ${target}] — skipped`);
    return null;
  }

  const absPath = pathResult.realPath ?? pathResult.lexicalPath;
  if (!absPath.startsWith(prep.dir + path.sep) && absPath !== prep.dir) {
    errors.push(`path-confinement: "${candidateRel}" resolves outside ${spec.subdir}/ [target ${target}] — skipped`);
    return null;
  }
  return absPath;
}

/**
 * Write `content` to `destPath` atomically via tmp+rename.
 *
 * Uses a random 8-hex-char suffix for the tmp file to avoid collisions when
 * multiple proposals write to the same directory concurrently (defensive;
 * under the lock this should not happen, but the pattern is cheap).
 *
 * Throws on filesystem errors — callers must catch.
 *
 * @param {string} destPath - absolute path of the target rule file.
 * @param {string} content  - UTF-8 text content to write.
 */
function writeTextAtomic(destPath, content) {
  const dir = path.dirname(destPath);
  mkdirSync(dir, { recursive: true });
  const suffix = randomBytes(4).toString('hex');
  const tmpPath = `${destPath}.${suffix}.tmp`;
  writeFileSync(tmpPath, content, 'utf8');
  renameSync(tmpPath, destPath);
}

/**
 * STRUCTURAL content gate (#1015) — the last chokepoint before disk.
 *
 * Every other defence in this module is PATH-oriented (`validatePathInsideProject`,
 * the `.claude/rules/` confinement assertion, the parent-symlink realpath check,
 * the file lock). Not one of them inspects a single byte of `content`, so a rule
 * document whose frontmatter was corrupted upstream — by an injected newline in
 * an agent-authored field, or by truncation — reached disk unexamined.
 *
 * This gate re-parses the rendered document with the REAL loader parser and
 * refuses the write when the document could not be audited or would load
 * always-on. It is deliberately STRUCTURAL, not content-semantic: it never
 * inspects or rewrites what the text SAYS, only whether the document still
 * serialises to the frontmatter contract it claims. Neutralising agent text is
 * the renderer's single responsibility; this gate does not duplicate it.
 *
 * Two proven injection outcomes it catches (both verified against the real
 * parser + `rule-loader.mjs`):
 *  - an injected `\n---` closes the frontmatter early → `globs` becomes null and
 *    `learning-key`/`expires-at` are gone → `rule-loader.mjs` (~:519-530) pushes
 *    the entry with `alwaysOn: true` and no expiry;
 *  - an injected newline followed by a colon-less line → `parseGlobsFrontmatter`
 *    THROWS → `rule-loader.mjs` (~:500-507) falls back to
 *    `globs=null, meta={}, parseError=true` → always-on again, and with empty
 *    meta it passes every gate by design.
 *
 * Scope (#1018 L2) — three tiers, deliberately not one:
 *
 *  1. PARSE — every document. Unparseable means unsafe, not unknown.
 *  2. `alwaysApply: true` — every document, regardless of any marker. A rule
 *     file that DECLARES itself always-on is precisely the outcome this gate
 *     exists to prevent, and declaring it must not be the way around the gate.
 *     Before #1018 this check sat behind the `auto-generated: true` branch, so
 *     a document with `alwaysApply: true` and no `auto-generated` key was
 *     written to disk unexamined — measured, not inferred: a `writeApprovedRules`
 *     probe returned `written: 1` for exactly that input.
 *  3. The never-always-on invariant set (activation axis, non-empty globs,
 *     `learning-key`, `expires-at`) — every document carrying ANY machine-
 *     provenance marker (`auto-generated: true`, `learning-key`, or
 *     `expires-at`). Keying on the marker SET rather than on `auto-generated`
 *     alone means a document that loses its `auto-generated` line to truncation
 *     but keeps its provenance keys is still held to the invariant.
 *
 * Why tier 3 is marker-scoped and not universal — measured against the live
 * corpus, not assumed: applying the invariant set to EVERY document would
 * refuse 16 of the 29 files currently in `.claude/rules/`. Those 16 are the
 * hand-authored always-on rules (`development.md`, `security.md`,
 * `parallel-sessions.md`, …), for which always-on is the intended, correct
 * shape — they carry no frontmatter at all. A universal gate would therefore
 * refuse the legitimate majority of the corpus to catch a machine-path defect.
 * Marker-scoped refuses 0 of 29. The module's general contract survives: a
 * caller may still write a document with no frontmatter.
 *
 * CEILING (BV-004): the marker set is a fixed three-key list, not a schema
 * lookup — and the renderer HAS since gained a fourth provenance key
 * (`evidence-digest: sha256-v1:<hex>`). That key is deliberately NOT in the
 * marker set, and the ceiling did not need raising, because this gate is
 * POSITIVE-KEY-ONLY: it asks whether the required keys are PRESENT, never
 * whether an unknown key appeared. A new renderer key therefore passes
 * untouched by construction — pinned by the `evidence-digest` case in
 * `tests/lib/reconcile/writer.test.mjs`. Add a key to the marker set only when
 * its ABSENCE should refuse a write; adding `evidence-digest` there would refuse
 * every document rendered before the key existed. Revisit if a second
 * non-reconcile caller of `writeApprovedRules` appears — today there is exactly
 * one production caller and it passes renderer output.
 *
 * Mirrors `scripts/lib/validate/check-rules.mjs`, which enforces the same
 * invariants as a CI gate. Two enforcement points, one invariant: CI catches
 * what is already on disk, this catches it before it lands.
 *
 * @param {string} content - the full rendered markdown document.
 * @returns {string|null} a refusal reason, or `null` when the document is sound.
 */
function frontmatterRefusalReason(content) {
  let parsed;
  try {
    parsed = parseGlobsFrontmatter(content);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    return `frontmatter does not parse (${msg}) — rule-loader.mjs treats a parse error as ALWAYS-ON with empty meta, so this file would load in every context and pass every gate`;
  }

  const { globs, meta } = parsed;
  const hasKey = (key) => Object.prototype.hasOwnProperty.call(meta, key);

  const problems = [];

  // ── Tier 2: binds on EVERY document (see the scope note above) ────────────
  // Not gated behind any marker: a document that declares itself always-on is
  // the exact outcome this gate prevents, so the declaration cannot be the
  // escape hatch. The renderer only ever emits `alwaysApply: false`.
  if (meta.alwaysApply === true) {
    problems.push(
      'alwaysApply: true — a rule written through this writer must never declare itself always-on (the renderer only ever emits false)',
    );
  }

  // ── Tier 3: binds on any machine-provenance-bearing document ──────────────
  // Marker-scoped rather than universal so the hand-authored always-on corpus
  // (16 of 29 live rule files) keeps writing; marker-scoped rather than
  // `auto-generated`-only so a document that loses that line to truncation but
  // keeps its provenance keys is still held to the invariant.
  const isProvenanceBearing =
    meta['auto-generated'] === true || hasKey('learning-key') || hasKey('expires-at');

  if (isProvenanceBearing) {
    const hasEmptyGlobs = Array.isArray(globs) && globs.length === 0;
    const hasGlobs = Array.isArray(globs) && globs.length > 0;
    const hasHostClass = hasKey('host-class');

    if (hasEmptyGlobs) {
      // NOT the "no axis" case and NOT always-on — the opposite: rule-loader.mjs
      // excludes on `globs.length === 0` unconditionally, AFTER gating, so the
      // rule never loads in ANY context even alongside a host-class: key.
      problems.push('empty globs array (globs: []) — the rule would match nothing and never load in ANY context');
    } else if (!hasGlobs && !hasHostClass) {
      problems.push('no activation axis (globs absent AND host-class absent) — the rule would load always-on');
    }
    if (!hasKey('learning-key')) {
      problems.push('missing required frontmatter key: learning-key');
    }
    if (!hasKey('expires-at')) {
      problems.push('missing required frontmatter key: expires-at');
    }
  }

  if (problems.length === 0) return null;
  return `rule fails the never-always-on invariant: ${problems.join('; ')}`;
}

/**
 * True iff a rejected item is an OPERATOR rejection — a proposal that was
 * rendered, surfaced in the approval AUQ and then declined — as opposed to an
 * engine-side rejection (ineligible, `capped — max-proposals-per-run`, or
 * already-materialized).
 *
 * The distinction decides whether the item gets a TERMINAL sidecar stamp, so it
 * has to be conservative in a specific direction. A false negative costs
 * nothing beyond today's behaviour (the learning is simply re-proposed next
 * run); a false positive would stamp an engine rejection terminal and thereby
 * permanently suppress a learning that was only capped by the volume brake or
 * not yet mature enough — silently, and with no way back short of editing the
 * sidecar by hand.
 *
 * The discriminator is the rendered `content`: `engine.mjs` pushes its own
 * rejections as `{learningKey, type, reason, status:'rejected'}` — they never
 * reach the renderer, so they never carry `content`/`slug`/`path` — while the
 * proposals the operator declines are full `ReconcileProposal` records whose
 * `content` is the very rule text the AUQ showed him.
 *
 * CEILING (BV-004): this reads an implicit signal, not an explicit marker,
 * because the one production caller (`skills/session-end/phase-3-6-tail.md`
 * step 6/7) concatenates engine rejections and operator-declined proposals into
 * ONE `rejected` array and marks neither. Revisit if that caller starts passing
 * rendered content on engine-side rejections, or if it gains an explicit
 * operator-rejection flag — then key on the flag instead.
 *
 * @param {WriterRejectedItem & {content?: unknown, learningKey?: unknown}} item
 * @returns {boolean}
 */
function isOperatorRejection(item) {
  if (!item || typeof item !== 'object') return false;
  if (typeof item.content !== 'string' || item.content.length === 0) return false;
  return typeof item.learningKey === 'string' && item.learningKey.length > 0;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} WriterApprovedItem
 * @property {string} slug     - kebab-case slug (from renderer.mjs / engine.mjs).
 *   THE filename source for every target whose {@link TARGET_DIRS} row declares
 *   `leaf: 'slug'` (today: `baseline`).
 * @property {string} path     - repo-relative rule path (`.claude/rules/<slug>.md`).
 *   THE filename source for `leaf: 'path'` targets (today: `repo-local`).
 * @property {string} content  - full rendered markdown content.
 * @property {string} [learningKey]
 * @property {number} [confidence]
 * @property {string} [candidateId]
 * @property {string} [status]
 */

/**
 * A record in the `rejected` array. Two shapes arrive here through the same
 * array (see {@link isOperatorRejection}):
 *   - an ENGINE rejection — `{learningKey, type, reason, status:'rejected'}`;
 *   - an OPERATOR-declined proposal — a full `ReconcileProposal`, i.e. the
 *     engine shape PLUS `slug`/`path`/`content`/`confidence`/`candidateId`.
 * Only the latter gets a terminal sidecar stamp.
 *
 * @typedef {Object} WriterRejectedItem
 * @property {string} [learningKey]
 * @property {string} [type]
 * @property {string} [reason]
 * @property {string} [status]
 * @property {string} [slug]        - operator-declined proposals only.
 * @property {string} [content]     - operator-declined proposals only; THE discriminator.
 * @property {number} [confidence]  - operator-declined proposals only.
 * @property {string} [candidateId] - operator-declined proposals only.
 */

/**
 * @typedef {Object} WriteApprovedRulesResult
 * @property {number}   written   - number of rule files successfully written.
 * @property {number}   archived  - number of rejected records appended to the log.
 * @property {string[]} errors    - per-item error strings (never fatal).
 */

/**
 * Persist approved reconciliation rule proposals to every requested target and
 * archive rejected proposals to the rejected log.
 *
 * NEVER throws — all per-item failures are collected into `errors[]`.
 *
 * Targets (issue #1099): `targets` names the {@link TARGET_DIRS} rows to write.
 * Omitted ⇒ `['repo-local']` ⇒ byte-identical to the pre-#1099 behaviour. One
 * approved proposal written to two targets counts TWICE in `written` (it is a
 * file count, not a proposal count) and stamps the idempotency sidecar ONCE.
 *
 * `baselineRoot` ABSENT IS NOT AN ERROR — it is the documented no-op path: a
 * `baseline` target with no root, a root that is a placeholder, or a root that
 * does not exist on disk each skip that target with an `errors[]` entry while
 * every other target still writes. The caller is expected to have dropped
 * `baseline` from `targets` upstream in that case (see `resolveEffectiveTargets`
 * in `scripts/lib/reconcile/engine.mjs`); this layer is the second line, held
 * here because it is the only layer holding the filesystem at write time.
 *
 * @param {Object}                opts
 * @param {WriterApprovedItem[]}  opts.approved     - proposals approved by the operator.
 * @param {WriterRejectedItem[]}  [opts.rejected]   - proposals declined by the operator.
 * @param {string}                opts.repoRoot     - absolute repo root path.
 * @param {string}                [opts.baselineRoot] - absolute projects-baseline root; absent ⇒ no-op for the `baseline` target.
 * @param {string[]}              [opts.targets]    - target ids; default `['repo-local']`.
 * @param {string}                [opts.sessionId]  - current session id (informational; unused in v1).
 * @returns {Promise<WriteApprovedRulesResult>}
 */
export async function writeApprovedRules({
  approved,
  rejected = [],
  repoRoot,
  baselineRoot,
  targets,
  sessionId: _sessionId,
}) {
  // Defensive: coerce inputs
  const approvedItems = Array.isArray(approved) ? approved : [];
  const rejectedItems = Array.isArray(rejected) ? rejected : [];
  const effectiveTargets = normalizeTargets(targets);

  if (approvedItems.length === 0 && rejectedItems.length === 0) {
    return { written: 0, archived: 0, errors: [] };
  }

  const lockPath = path.join(repoRoot, RULES_LOCK_REL);

  // Ensure .orchestrator dir exists so lock acquisition can create the lock file.
  try {
    mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch {
    // Non-fatal: withFileLock will surface the fs-error if the lock cannot be created.
  }

  // Acquire the rules lock — serialises concurrent rule writes.
  const lockResult = await withFileLock(
    lockPath,
    async () => {
      /** @type {string[]} */
      const errors = [];
      let written = 0;
      let archived = 0;

      const roots = { repoRoot, baselineRoot };
      // Shared stamp for every candidate this batch writes — mirrors `rejectedAt`
      // below (step 2), one timestamp per invocation rather than one per item.
      const approvedAt = new Date().toISOString();

      // Per-target pre-flight — root resolution, existence refusal, subdir
      // creation and parent-symlink hardening, once per DISTINCT target rather
      // than once per batch or once per item.
      /** @type {Map<string, PreparedTarget>} */
      const prepared = new Map();
      if (approvedItems.length > 0) {
        if (effectiveTargets.length === 0) {
          errors.push(
            `no write target in effect — ${approvedItems.length} approved proposal(s) not written (an explicitly empty \`targets\` is honoured, never defaulted back to repo-local)`,
          );
        }
        for (const target of effectiveTargets) {
          prepared.set(target, prepareTarget(target, roots, errors));
        }
      }

      // ── Step 1: write approved rule files ──────────────────────────────────
      for (const item of approvedItems) {
        // Item-level guards run ONCE, before any target loop: content is a
        // property of the proposal, not of where it lands.

        // Guard: content must be a string
        if (!item || typeof item.content !== 'string') {
          const label = item && typeof item.path === 'string' ? item.path : `slug=${item && item.slug}`;
          errors.push(`approved item "${label}" has non-string content — skipped`);
          continue;
        }

        // Structural content gate (#1015) — runs BEFORE any tmp-file creation,
        // so a refused write leaves no `.tmp` residue behind.
        const refusal = frontmatterRefusalReason(item.content);
        if (refusal !== null) {
          const label = typeof item.path === 'string' ? item.path : `slug=${item.slug}`;
          errors.push(`content-structure: "${label}" — ${refusal} — skipped`);
          continue;
        }

        let writeOk = false;
        for (const target of effectiveTargets) {
          const prep = prepared.get(target);
          if (!prep || !prep.ok) continue;

          const absPath = resolveDest(item, target, prep, roots, errors);
          if (absPath === null) continue;

          try {
            writeTextAtomic(absPath, item.content);
            written++;
            writeOk = true;
          } catch (err) {
            const msg = err && err.message ? err.message : String(err);
            errors.push(`write failed "${absPath}" [target ${target}]: ${msg}`);
          }
        }

        // Stamp the idempotency sidecar (issue #484 point 1): once a rule
        // file is on disk, the candidate that proposed it must be marked
        // terminal, or the next reconcile run has no way to know the
        // proposal was already acted on and re-proposes it. Best-effort and
        // gated on a successful write — the rule file landing is the thing
        // that matters; a stamp failure is reported but does not undo it.
        if (writeOk && typeof item.learningKey === 'string' && item.learningKey.length > 0) {
          const stampResult = markCandidateProcessed({
            learningKey: item.learningKey,
            outcome: 'written',
            processedAt: approvedAt,
            fallbackSlug: item.slug,
            fallbackCandidateId: item.candidateId,
            fallbackConfidence: item.confidence,
            repoRoot,
          });
          if (!stampResult.written) {
            errors.push(
              `sidecar-stamp failed for "${item.path ?? item.slug}" (learningKey=${item.learningKey}) — rule file was written but the idempotency sidecar was not updated`,
            );
          }
        }
      }

      // ── Step 2: archive rejected proposals to the rejected log ─────────────
      if (rejectedItems.length > 0) {
        const rejectedLogRelPath = REJECTED_LOG_REL;
        const logResult = validatePathInsideProject(rejectedLogRelPath, repoRoot, { canonicalizeRoot: true });

        if (!logResult.ok) {
          errors.push(`path-safety (rejected log): ${logResult.reason} (${rejectedLogRelPath})`);
        } else {
          const rejectedLogPath = logResult.realPath ?? logResult.lexicalPath;

          // Ensure parent directory exists
          try {
            mkdirSync(path.dirname(rejectedLogPath), { recursive: true });
          } catch (err) {
            const msg = err && err.message ? err.message : String(err);
            errors.push(`mkdir failed (rejected log): ${msg}`);
          }

          const rejectedAt = new Date().toISOString();

          for (const item of rejectedItems) {
            try {
              const archiveRecord = {
                ...item,
                _rejected_reason: (item && typeof item.reason === 'string' && item.reason !== '')
                  ? item.reason
                  : 'user-declined',
                _rejected_at: rejectedAt,
              };
              const line = JSON.stringify(archiveRecord) + '\n';
              appendFileSync(rejectedLogPath, line, 'utf8');
              archived++;

              // Stamp the idempotency sidecar for an OPERATOR rejection
              // (issue #1042): the rejected log is an append-only AUDIT trail —
              // nothing reads it back — so without this stamp `isProcessed()`
              // finds no terminal verdict for the learning and the next run
              // re-proposes the exact rule the operator just declined. Same
              // shape and same single writer as the approved path above; only
              // `outcome` differs. Engine-side rejections are deliberately NOT
              // stamped (see `isOperatorRejection`) — a capped or not-yet-mature
              // learning must stay proposable. Best-effort and gated on a
              // successful append, mirroring the approved path.
              if (isOperatorRejection(item)) {
                const stampResult = markCandidateProcessed({
                  learningKey: item.learningKey,
                  outcome: 'rejected',
                  processedAt: rejectedAt,
                  fallbackSlug: item.slug,
                  fallbackCandidateId: item.candidateId,
                  fallbackConfidence: item.confidence,
                  repoRoot,
                });
                if (!stampResult.written) {
                  errors.push(
                    `sidecar-stamp failed for rejected "${item.learningKey}" — the rejection was archived but the idempotency sidecar was not updated, so a later run may re-propose it`,
                  );
                }
              }
            } catch (err) {
              const msg = err && err.message ? err.message : String(err);
              const key = (item && item.learningKey) ? item.learningKey : '<unknown>';
              errors.push(`archive failed "${key}": ${msg}`);
            }
          }
        }
      }

      return { written, archived, errors };
    },
    { timeoutMs: 10000 },
  );

  // If lock acquisition failed, return a zeroed result with the lock error.
  if (lockResult.ok === false) {
    return {
      written: 0,
      archived: 0,
      errors: [`lock-${lockResult.reason ?? 'unknown'}`],
    };
  }

  // Unwrap the result returned from inside the lock body.
  return lockResult.value;
}
