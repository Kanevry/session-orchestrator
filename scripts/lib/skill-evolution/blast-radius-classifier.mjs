/**
 * blast-radius-classifier.mjs — R5 blast-radius classifier for the C2
 * auto-repair engine (Epic #643 Skill Self-Evolution Foundation / issue #647).
 *
 * The heart of the gate-per-artifact-type design: maps a repair target's path
 * to a `{ targetType, gate, posture }` triple that the auto-repair engine uses
 * to decide whether a change may be applied autonomously (behind a gate) or
 * must always go through a merge request.
 *
 * SECURITY (R5 traversal safety): the classifier is PATH-TRAVERSAL-SAFE and
 * FAIL-CLOSED. `targetPath` is never trusted lexically — it is resolved against
 * a canonicalised `repoRoot` and any path that escapes the repo (or is
 * otherwise ambiguous) is classified as `unknown` with the safest posture
 * (`always-mr`). The ONLY input that yields `autonomous-gated` is the repo's
 * own ROOT `CLAUDE.md` / `AGENTS.md`.
 *
 * No throwing: every code path returns a valid classification triple.
 *
 * Consumers:
 *  - C2 auto-repair engine (issue #647) — decides apply-vs-MR per repair target.
 */

import path from 'node:path';
import fs from 'node:fs';

/**
 * @typedef {'plugin-skill' | 'local-skill' | 'local-config' | 'unknown'} TargetType
 * @typedef {'none' | 'config-validation'} Gate
 * @typedef {'always-mr' | 'autonomous-gated'} Posture
 * @typedef {{ targetType: TargetType, gate: Gate, posture: Posture }} Classification
 */

/**
 * The fail-closed default: returned for any path that escapes the repo, is
 * empty/ambiguous, or matches no known artifact type. Never silent-applies.
 * @type {Classification}
 */
const FAIL_CLOSED = Object.freeze({
  targetType: 'unknown',
  gate: 'none',
  posture: 'always-mr',
});

/**
 * Classify a repair target's path into its blast-radius triple.
 *
 * The path is resolved against a canonicalised `repoRoot` before any
 * classification rule is applied; paths that resolve outside the repo are
 * fail-closed to `unknown` / `always-mr`. Path rules are applied first-match-wins
 * against the repo-relative POSIX path:
 *
 *   1. `.claude/skills` (or under it) → local-skill   / none              / always-mr
 *   2. `skills`         (or under it) → plugin-skill   / none              / always-mr
 *   3. ROOT `CLAUDE.md` / `AGENTS.md` → local-config   / config-validation / autonomous-gated
 *   4. anything else                  → unknown        / none              / always-mr (fail-closed)
 *
 * @param {string} targetPath — repair target path (relative or absolute); not trusted lexically.
 * @param {{ repoRoot: string }} options — `repoRoot` is the repository root to resolve against.
 * @returns {Classification} the blast-radius triple; never throws.
 */
export function classifyTarget(targetPath, { repoRoot } = {}) {
  // Guard the inputs — fail-closed on anything we cannot work with.
  if (typeof targetPath !== 'string' || typeof repoRoot !== 'string' || repoRoot.length === 0) {
    return { ...FAIL_CLOSED };
  }

  // Canonicalise the repo root. realpathSync resolves symlinks so a symlinked
  // repoRoot still anchors the escape check correctly. If it throws (e.g. the
  // root does not exist yet), fall back to a lexical resolve.
  let root;
  try {
    root = fs.realpathSync(path.resolve(repoRoot));
  } catch {
    root = path.resolve(repoRoot);
  }

  // Resolve the target against the canonical root, then compute the repo-relative
  // path. We do NOT inspect `targetPath` lexically before this point.
  const abs = path.resolve(root, targetPath);
  let rel = path.relative(root, abs);

  // ESCAPE CHECK (fail-closed): empty rel means the target IS the root itself;
  // a `..` prefix or an absolute rel means the target escaped the repo. Either
  // way → unknown / always-mr. Never throw.
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ...FAIL_CLOSED };
  }

  // Normalize separators to POSIX so the rules below are platform-independent.
  rel = rel.split(path.sep).join('/');

  // Rule 1 — local (project) skills under `.claude/skills`.
  if (rel === '.claude/skills' || rel.startsWith('.claude/skills/')) {
    return { targetType: 'local-skill', gate: 'none', posture: 'always-mr' };
  }

  // Rule 2 — plugin skills under `skills`.
  if (rel === 'skills' || rel.startsWith('skills/')) {
    return { targetType: 'plugin-skill', gate: 'none', posture: 'always-mr' };
  }

  // Rule 3 — ROOT instruction files ONLY (no path separator in rel). A nested
  // `subdir/CLAUDE.md` falls through to the fail-closed default below.
  if (rel === 'CLAUDE.md' || rel === 'AGENTS.md') {
    return {
      targetType: 'local-config',
      gate: 'config-validation',
      posture: 'autonomous-gated',
    };
  }

  // Rule 4 — fail-closed default for everything else.
  return { ...FAIL_CLOSED };
}
