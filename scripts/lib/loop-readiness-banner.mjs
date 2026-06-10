/**
 * loop-readiness-banner.mjs — #633
 *
 * Mechanical session-start readiness probe: warn when a repo has no
 * `.claude/loop.md` AND no host-wide `~/.claude/loop.md` baseline, so the
 * operator knows that a bare `/loop` invocation falls back to Anthropic's
 * generic maintenance prompt instead of a project-tuned loop body.
 *
 * Plain-JS — no Zod dependency. Never throws. Returns null (silent no-op)
 * when healthy or on bad input.
 *
 * Mirrors the contract used by other Phase 4 banners
 * (`scripts/lib/vault-staleness-banner.mjs`, `scripts/lib/ci-status-banner.mjs`,
 * `scripts/lib/peer-cards/staleness-banner.mjs`): a single `checkXxx()` entry
 * point that returns `null` or `{ severity, message, ... }`.
 *
 * Cross-references:
 *  - `.claude/rules/loop-and-monitor.md` — when to use `/loop` vs Monitor vs Routines.
 *  - `templates/_shared/loop.md` — the template body `/bootstrap` copies into a repo.
 *  - `skills/session-start/SKILL.md` Phase 4 — banner render site.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

/**
 * Check loop-readiness and produce a session-start banner.
 *
 * Healthy (returns null) when EITHER a repo-level `.claude/loop.md` OR a
 * host-wide `~/.claude/loop.md` baseline exists — the user-level baseline
 * covers repos that do not ship their own loop body.
 *
 * @param {{repoRoot: string, homeDir?: string}} opts
 *   - `repoRoot`: REQUIRED absolute path to the repo root.
 *   - `homeDir`: defaults to `os.homedir()`; exists ONLY for test injection.
 * @returns {null | {severity:'warn', message:string, repoLoopMd:boolean, userLoopMd:boolean}}
 */
export function checkLoopReadiness({ repoRoot, homeDir } = {}) {
  try {
    if (!repoRoot || typeof repoRoot !== 'string') return null;

    const home = typeof homeDir === 'string' && homeDir ? homeDir : os.homedir();

    const repoLoopMd = existsSync(join(repoRoot, '.claude', 'loop.md'));
    const userLoopMd = existsSync(join(home, '.claude', 'loop.md'));

    // Healthy: either the repo ships its own loop body or a host-wide baseline
    // covers it. Only warn when NEITHER exists.
    if (repoLoopMd || userLoopMd) return null;

    return {
      severity: 'warn',
      message:
        '⚠ loop-readiness: no .claude/loop.md (repo) and no ~/.claude/loop.md ' +
        '(user baseline) — bare /loop uses the generic Anthropic maintenance ' +
        'prompt. Copy templates/_shared/loop.md via /bootstrap or add a ' +
        'host-wide ~/.claude/loop.md.',
      repoLoopMd: false,
      userLoopMd: false,
    };
  } catch {
    // Defensive catch-all — banner must never throw.
    return null;
  }
}
