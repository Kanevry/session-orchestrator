/**
 * loop-readiness-banner.mjs — #633, #767
 *
 * Mechanical session-start readiness probe with three independent
 * silent-failure detections for `/loop`:
 *
 *  1. No `.claude/loop.md` in the repo AND no host-wide `~/.claude/loop.md`
 *     baseline — bare `/loop` falls back to Anthropic's generic maintenance
 *     prompt instead of a project-tuned loop body. (#633)
 *  2. `CLAUDE_CODE_DISABLE_CRON` set to a non-empty value — the cron
 *     scheduler backing `/loop` is disabled outright, independent of
 *     whether any loop.md file exists. (#767)
 *  3. A present `.claude/loop.md` (repo) or `~/.claude/loop.md` (user)
 *     exceeds `LOOP_MD_MAX_BYTES` — Anthropic silently truncates the loaded
 *     body past this size, so the operator-authored tail of the file is
 *     never read. Checked independently per file. (#767)
 *
 * Plain-JS — no Zod dependency. Never throws. Returns null (silent no-op)
 * when healthy (no findings) or on bad input. Multiple findings are
 * combined into a SINGLE warn object — never an array, never multiple
 * return values.
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
 *  - Issues #633 (original no-loop.md detection), #767 (DISABLE_CRON + truncation).
 */

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

/**
 * Upstream (Anthropic) silently truncates a loaded loop.md body past this
 * size — the tail of an oversized file is never read, a silent-failure
 * class distinct from the file simply being absent. (#767)
 */
const LOOP_MD_MAX_BYTES = 25_000;

/**
 * Return `filePath`'s byte size, or null on any stat failure. Never throws.
 * @param {string} filePath
 * @returns {number | null}
 */
function safeStatSize(filePath) {
  try {
    return statSync(filePath).size;
  } catch {
    return null;
  }
}

/**
 * Check loop-readiness and produce a session-start banner.
 *
 * Combines up to three independent findings into a single null-or-warn
 * result:
 *  - no loop.md anywhere (repo AND user baseline both absent)
 *  - `CLAUDE_CODE_DISABLE_CRON` set to a non-empty value
 *  - a present loop.md (repo and/or user, checked independently) exceeding
 *    `LOOP_MD_MAX_BYTES`
 *
 * @param {{repoRoot: string, homeDir?: string, env?: Record<string, string|undefined>}} opts
 *   - `repoRoot`: REQUIRED absolute path to the repo root.
 *   - `homeDir`: defaults to `os.homedir()`; exists ONLY for test injection.
 *   - `env`: defaults to `process.env`; exists ONLY for test injection.
 * @returns {null | {severity:'warn', message:string, repoLoopMd:boolean, userLoopMd:boolean, disableCron?:boolean, oversize?:string[]}}
 */
export function checkLoopReadiness({ repoRoot, homeDir, env } = {}) {
  try {
    if (!repoRoot || typeof repoRoot !== 'string') return null;

    const home = typeof homeDir === 'string' && homeDir ? homeDir : os.homedir();
    const activeEnv = env && typeof env === 'object' ? env : process.env;

    const repoLoopMdPath = join(repoRoot, '.claude', 'loop.md');
    const userLoopMdPath = join(home, '.claude', 'loop.md');
    const repoLoopMd = existsSync(repoLoopMdPath);
    const userLoopMd = existsSync(userLoopMdPath);

    const findings = [];

    // Finding 1 (#633): neither loop.md exists — bare /loop uses the
    // generic Anthropic maintenance prompt instead of a project-tuned body.
    if (!repoLoopMd && !userLoopMd) {
      findings.push(
        'no .claude/loop.md (repo) and no ~/.claude/loop.md (user baseline) — ' +
          'bare /loop uses the generic Anthropic maintenance prompt. Copy ' +
          'templates/_shared/loop.md via /bootstrap or add a host-wide ' +
          '~/.claude/loop.md.'
      );
    }

    // Finding 2 (#767): CLAUDE_CODE_DISABLE_CRON set — /loop's cron
    // scheduler is disabled outright, independent of loop.md presence.
    const disableCron = Boolean(activeEnv && activeEnv.CLAUDE_CODE_DISABLE_CRON);
    if (disableCron) {
      findings.push(
        'CLAUDE_CODE_DISABLE_CRON is set — the cron scheduler backing /loop ' +
          'is disabled; scheduled loop bodies will not fire.'
      );
    }

    // Finding 3 (#767): a present loop.md (repo and/or user, checked
    // independently) exceeds the truncation ceiling.
    const oversizeChecks = [
      { kind: 'repo', filePath: repoLoopMdPath, exists: repoLoopMd },
      { kind: 'user', filePath: userLoopMdPath, exists: userLoopMd },
    ];
    const oversize = [];
    for (const { kind, filePath, exists } of oversizeChecks) {
      if (!exists) continue;
      const size = safeStatSize(filePath);
      if (typeof size === 'number' && size > LOOP_MD_MAX_BYTES) {
        oversize.push(kind);
        findings.push(
          `${filePath} is ${size} bytes, exceeding the ${LOOP_MD_MAX_BYTES}-byte ` +
            "truncation ceiling — Anthropic silently truncates the loaded loop.md " +
            "body past this size, so the file's tail is never read."
        );
      }
    }

    if (findings.length === 0) return null;

    return {
      severity: 'warn',
      message: '⚠ loop-readiness: ' + findings.join(' '),
      repoLoopMd,
      userLoopMd,
      ...(disableCron ? { disableCron: true } : {}),
      ...(oversize.length > 0 ? { oversize } : {}),
    };
  } catch {
    // Defensive catch-all — banner must never throw.
    return null;
  }
}
