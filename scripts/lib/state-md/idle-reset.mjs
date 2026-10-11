/**
 * Idle Reset for STATE.md (issue #1560) — the code form of session-start
 * Phase 1.5 § "Idle Reset" (skills/session-start/references/phase-1-5-session-continuity.md).
 *
 * Until #1560 the reset existed only as prose and every coordinator rewrote
 * STATE.md by hand. Its Rule 6 deleted the five recommendation keys from the
 * frontmatter, which is exactly what Phase 7.5's `buildLiveSignals()` reads —
 * so after every clean `/close` the Mode-Selector saw no recommendation and
 * fell back to `feature` at confidence 0. The keys now STAY in the frontmatter:
 * they are the session-to-session handoff, and session-end Phase 3.7a (their
 * sole writer) overwrites them at the next close.
 *
 * Deliberately NOT re-exported from `scripts/lib/state-md.mjs`: that barrel is
 * part of the hook import closure (`hooks/_lib/hook-import-set.json`), and no
 * hook needs the reset. The CLI `scripts/state-md-idle-reset.mjs` imports this
 * module directly.
 */

import { parseStateMd, serializeStateMd } from './yaml-parser.mjs';
import { updateFrontmatterFields, writeStateMd } from './frontmatter-mutators.mjs';
import { parseRecommendations } from './recommendations.mjs';

/** Rule 7: the drift-baseline keys that must not survive into session N+1. */
const SCOPE_BASELINE_KEYS = [
  'scope-baseline-intent',
  'scope-baseline-owner-boundary',
  'scope-baseline-planned-files',
  'scope-baseline-session',
  'scope-baseline-frozen-at',
];

/** A level-2 heading (`## X`), never a deeper one (`### X`). */
const H2_RE = /^##(?!#)\s/;

/** Rule 6: heading of the human-readable recommendations copy. */
const RECOMMENDATIONS_HEADING = '### Recommendations (archived from v1.1 frontmatter)';

/**
 * Splits a STATE.md body into the text before the first level-2 heading and
 * one record per level-2 section. Every record keeps its raw lines (heading
 * included, up to the next level-2 heading), so re-joining an untouched
 * section is byte-identical.
 *
 * KNOWN CEILING: a `## ` line inside a fenced code block is read as a heading,
 * the same limitation every helper in body-sections.mjs shares. No STATE.md
 * section observed so far carries fenced code.
 *
 * @param {string} body
 * @returns {{preamble: string[], sections: Array<{heading: string, lines: string[]}>}}
 */
function splitSections(body) {
  const preamble = [];
  const sections = [];
  for (const line of body.split('\n')) {
    if (H2_RE.test(line)) sections.push({ heading: line, lines: [line] });
    else if (sections.length === 0) preamble.push(line);
    else sections[sections.length - 1].lines.push(line);
  }
  return { preamble, sections };
}

/** @param {string} heading @param {string} title */
function isSection(heading, title) {
  // The title must END there (or open a parenthesis): `## Wave History Archive`
  // is a different section.
  return new RegExp(`^##\\s+${title}(?:\\s*\\(|\\s*$)`).test(heading);
}

/** Drops leading and trailing blank lines. */
function trimBlankLines(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start++;
  while (end > start && lines[end - 1].trim() === '') end--;
  return lines.slice(start, end);
}

/** @param {number} x  a ratio in 0..1 */
function pct(x) {
  return `${Math.round(x * 100)}%`;
}

/**
 * Rule 6: the human-readable copy of the recommendation fields. Null fields
 * are omitted; `null` overall when there is nothing to show.
 *
 * @param {object} frontmatter
 * @returns {string|null}
 */
function renderRecommendationsBlock(frontmatter) {
  const rec = parseRecommendations(frontmatter);
  if (rec === null) return null;
  const bullets = [];
  if (rec.mode !== null) bullets.push(`- **Recommended mode:** ${rec.mode}`);
  if (rec.rationale !== null) bullets.push(`- **Rationale:** ${rec.rationale}`);
  if (rec.completionRate !== null) bullets.push(`- **Completion rate:** ${pct(rec.completionRate)}`);
  if (rec.carryoverRatio !== null) bullets.push(`- **Carryover ratio:** ${pct(rec.carryoverRatio)}`);
  if (rec.priorities !== null) {
    const list = rec.priorities.length > 0 ? rec.priorities.map((id) => `#${id}`).join(', ') : 'none';
    bullets.push(`- **Top priorities:** ${list}`);
  }
  if (bullets.length === 0) return null;
  return [RECOMMENDATIONS_HEADING, ...bullets].join('\n');
}

/**
 * Removes one `### <heading>` subsection (up to the next `### ` or `## ` line).
 *
 * @param {string[]} lines
 * @param {string} heading  the full `### …` line
 * @returns {string[]}
 */
function dropSubsection(lines, heading) {
  const out = [];
  let skipping = false;
  for (const line of lines) {
    if (line === heading) skipping = true;
    else if (skipping && /^#{2,3}\s/.test(line)) skipping = false;
    if (!skipping) out.push(line);
  }
  return out;
}

/**
 * Resets a `status: completed` STATE.md to idle (Phase 1.5 § Idle Reset,
 * Rules 1-7). Pure: string in, result out, no file I/O.
 *
 * 1. `status: idle`. 2. `current-wave: 0`. 3. Every `## Wave History` body moves
 * into a new `## Previous Session` section (appended at the end of the body,
 * replacing any earlier one) under `### Wave History (<session>)`; the original
 * section is removed. 4. `## Deviations` keeps its heading with an empty body;
 * `## What Not To Retry` and `## Open Questions` stay byte-for-byte. 5. Other
 * frontmatter keys are untouched. 6. The five recommendation keys STAY in the
 * frontmatter (Phase 7.5 reads them); a readable copy heads `## Previous Session`.
 * 7. The five `scope-baseline-*` keys are deleted, no other key.
 *
 * When neither a Wave History section nor a recommendation exists, an existing
 * `## Previous Session` is left as it is — there is nothing to replace it with.
 * With recommendations but no Wave History (a coordinator-direct session), the
 * earlier archive body stays below the new recommendations block.
 *
 * @param {string} contents  STATE.md contents
 * @returns {{changed: boolean, contents: string, reason?: 'status-not-completed'|'unparseable'}}
 */
export function resetStateMdToIdle(contents) {
  const parsed = parseStateMd(contents);
  if (parsed === null) return { changed: false, contents, reason: 'unparseable' };
  if (parsed.frontmatter.status !== 'completed') {
    return { changed: false, contents, reason: 'status-not-completed' };
  }

  const { preamble, sections } = splitSections(parsed.body);
  const waveHistory = sections.filter((s) => isSection(s.heading, 'Wave History'));
  const recBlock = renderRecommendationsBlock(parsed.frontmatter);
  const archive = waveHistory.length > 0 || recBlock !== null;
  // Rule 6 PREPENDS: without a new Wave History, the earlier archive stays below
  // the fresh recommendations block (minus its own, now superseded, copy).
  const keptArchive =
    waveHistory.length === 0
      ? trimBlankLines(
          dropSubsection(
            sections.filter((s) => isSection(s.heading, 'Previous Session')).flatMap((s) => s.lines.slice(1)),
            RECOMMENDATIONS_HEADING,
          ),
        )
      : [];

  const lines = [...preamble];
  for (const { heading, lines: own } of sections) {
    if (isSection(heading, 'Wave History')) continue;
    if (archive && isSection(heading, 'Previous Session')) continue;
    lines.push(...(isSection(heading, 'Deviations') ? [heading, ''] : own));
  }

  let body = lines.join('\n');
  if (archive) {
    const blocks = [];
    if (recBlock !== null) blocks.push(recBlock);
    if (waveHistory.length > 0) {
      const session = typeof parsed.frontmatter.session === 'string' ? parsed.frontmatter.session : '';
      const heading = session ? `### Wave History (${session})` : '### Wave History';
      const moved = trimBlankLines(waveHistory.flatMap((s) => s.lines.slice(1)));
      blocks.push([heading, ...moved].join('\n'));
    }
    if (keptArchive.length > 0) blocks.push(keptArchive.join('\n'));
    // Only ever ADD newlines before the new section — trimming would change the
    // trailing bytes of whatever section now precedes it (possibly WNTR).
    if (body.length > 0 && !body.endsWith('\n\n')) body += body.endsWith('\n') ? '\n' : '\n\n';
    body += `## Previous Session\n\n${blocks.join('\n\n')}\n`;
  }

  const fields = { status: 'idle', 'current-wave': 0 };
  for (const key of SCOPE_BASELINE_KEYS) fields[key] = null;
  const next = updateFrontmatterFields(
    serializeStateMd({ frontmatter: parsed.frontmatter, body }),
    fields,
  );
  return { changed: next !== contents, contents: next };
}

/**
 * Applies `resetStateMdToIdle` to the repo's STATE.md under the STATE.md lock
 * (`writeStateMd`). A missing or empty STATE.md is a no-op with reason `missing`.
 * A write the size-ceiling / frontmatter-safe guards refuse comes back as
 * `changed: false` with that guard's reason.
 *
 * @param {string} repoRoot  absolute repository root (required)
 * @param {object} [opts]    passed through to `writeStateMd`
 * @returns {Promise<{changed: boolean, reason?: string, path: string}>}
 * @throws {Error} when repoRoot is missing
 */
export async function resetStateMdToIdleOnDisk(repoRoot, opts = {}) {
  if (!repoRoot) {
    throw new Error(`resetStateMdToIdleOnDisk: repoRoot is required (got ${typeof repoRoot}).`);
  }
  let reason;
  const result = await writeStateMd(
    repoRoot,
    (contents) => {
      if (contents === '') {
        reason = 'missing';
        return null;
      }
      const reset = resetStateMdToIdle(contents);
      reason = reset.reason;
      return reset.changed ? reset.contents : null;
    },
    opts,
  );
  const out = { changed: result.written, path: result.path };
  const why = result.reason ?? reason;
  if (why !== undefined) out.reason = why;
  return out;
}
