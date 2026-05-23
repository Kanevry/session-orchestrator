/**
 * staleness-banner.mjs — Session-start banner for #503 peer-card staleness.
 *
 * Surfaces a `warn` banner during session-start Phase 4 when peer cards
 * (USER.md / AGENT.md under `.orchestrator/peers/`) have an `updated:`
 * frontmatter older than `STALENESS_THRESHOLD_DAYS` (30) days.
 *
 * Design notes:
 *  - Mirrors the contract used by other Phase 4 banners
 *    (`scripts/lib/vault-staleness-banner.mjs`, `scripts/lib/ci-status-banner.mjs`,
 *    `scripts/lib/qg-command-drift-banner.mjs`): a single `checkXxx()` entry
 *    point that returns `null` (silent no-op) or `{ severity, message, ... }`.
 *  - Never throws. The banner is informational — the session-start renderer
 *    must not be derailed by reader errors, missing files, or schema mismatches.
 *    Defensive `try/catch` wraps every potentially-throwing call.
 *  - Clock is injectable (`opts.now`) to keep tests deterministic. Propagates
 *    through to `readPeerCards()` so staleness computations agree across the
 *    reader and the banner.
 *
 * Cross-references:
 *  - `scripts/lib/peer-cards/reader.mjs` — produces the `PeerCardsResult`
 *    consumed here.
 *  - `scripts/lib/peer-cards/schema.mjs` — `STALENESS_THRESHOLD_DAYS = 30`.
 *  - `.claude/rules/owner-persona.md` — host-wide `owner.yaml`; peer cards
 *    are the per-repo behavioural complement.
 *  - `skills/session-start/SKILL.md` Phase 4 — banner render site.
 */

import { readPeerCards } from './reader.mjs';

/**
 * Check peer-card staleness and produce a session-start banner.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot - REQUIRED absolute path to repo root
 * @param {Date} [opts.now] - injectable clock for tests
 * @returns {Promise<null | { severity: 'warn', message: string, stale: Array<{target: string, days: number}> }>}
 */
export async function checkPeerCardsStaleness({ repoRoot, now } = {}) {
  // Silent no-op on bad input (consistent with other Phase 4 banners).
  if (!repoRoot || typeof repoRoot !== 'string') return null;

  let result;
  try {
    result = await readPeerCards(repoRoot, { now });
  } catch {
    // Never throw — banner is informational only.
    return null;
  }

  if (!result || !result.exists) return null;

  const stale = [];

  // Only count cards that are (a) present, (b) have valid frontmatter so the
  // `updated:` date could be parsed, and (c) flagged stale by the reader.
  // A card without parseable frontmatter still has `isStale: true` because
  // `stalenessDays === Infinity`, but in that case the corrective action is
  // "fix the frontmatter", not "run /evolve --dialectic" — so we exclude it
  // from this banner.
  if (
    result.user &&
    result.user.isStale &&
    result.user.frontmatter &&
    Number.isFinite(result.user.stalenessDays)
  ) {
    stale.push({ target: 'USER.md', days: result.user.stalenessDays });
  }
  if (
    result.agent &&
    result.agent.isStale &&
    result.agent.frontmatter &&
    Number.isFinite(result.agent.stalenessDays)
  ) {
    stale.push({ target: 'AGENT.md', days: result.agent.stalenessDays });
  }

  if (stale.length === 0) return null;

  const parts = stale.map((s) => `${s.target} (${s.days}d)`).join(', ');
  const message =
    `⚠ peer-cards: ${parts} stale (>30 days) — ` +
    `consider running /evolve --dialectic to refresh.`;

  return { severity: 'warn', message, stale };
}

/**
 * Convenience renderer: returns the banner message string, or empty string
 * when no banner should be shown. Intended for inline use from SKILL.md
 * snippets, matching the shape of `vault-staleness-banner.mjs::renderBanner`.
 *
 * @param {{repoRoot: string, now?: Date}} opts
 * @returns {Promise<string>}
 */
export async function renderBanner({ repoRoot, now } = {}) {
  const result = await checkPeerCardsStaleness({ repoRoot, now });
  return result ? result.message : '';
}
