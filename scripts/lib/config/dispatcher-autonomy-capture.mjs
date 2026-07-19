/**
 * dispatcher-autonomy-capture.mjs — One-time per-repo capture of the
 * `dispatcher-autonomy:` preference (Epic #673 / issue #681).
 *
 * The committed `dispatcher-autonomy:` block is asked EXACTLY ONCE per repo at
 * two triggers:
 *   (a) bootstrap   — new project, block always absent → always asks.
 *   (b) migration   — first session-start after this feature ships, when the
 *                     committed block is still absent.
 *
 * The guard is the RAW PRESENCE of the committed block, not the RESOLVED value:
 * `_parseDispatcherAutonomy()` returns `autonomy: 'off'` for BOTH "block absent"
 * AND "block present with autonomy: off" — so the resolved value cannot
 * distinguish first-run from a deliberate `off`. This module therefore detects
 * presence via the shared bold-tolerant `hasBlockHeader()` helper
 * (block-header.mjs) — the same matcher the parser now uses (#830).
 * Block presence IS the never-re-ask marker — there is no separate state file.
 *
 * The committed instruction file is `CLAUDE.md` on Claude Code / Cursor IDE and
 * `AGENTS.md` on Codex CLI — transparent aliases (see
 * `skills/_shared/instruction-file-resolution.md`); every reference to `CLAUDE.md`
 * below resolves to `AGENTS.md` on those platforms.
 *
 * The writer writes ONLY the committed default (autonomy enum + confidence-floor).
 * Host-local overrides (env `SO_DISPATCHER_AUTONOMY`, owner.yaml
 * `dispatcher.autonomy`) NEVER land in CLAUDE.md / AGENTS.md — they stay host-local
 * so a machine may differ from the committed default. See
 * `scripts/lib/config/dispatcher-autonomy.mjs` `resolveDispatcherAutonomy()`.
 *
 * Pure, no-throw, zero-coupling helpers. The coordinator drives the
 * AskUserQuestion call; this module only provides the question definition,
 * the presence guard, the block renderer, and the idempotent writer.
 *
 * Consumers:
 *   - `skills/bootstrap/SKILL.md`      (Phase 3.5.1 — new-project capture)
 *   - `skills/session-start/SKILL.md`  (Phase 1.1  — migration capture)
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { hasBlockHeader } from './block-header.mjs';

const ALLOWED_AUTONOMY = ['off', 'advisory', 'autonomous-gated'];
const DEFAULT_CONFIDENCE_FLOOR = 0.5;

/**
 * Coordinator-facing AUQ question definition for the one-time capture.
 * Mirrors the shape of `getInterviewQuestions()` entries in owner-interview.mjs:
 *   { question, header, options: [{ label, description }], multiSelect }
 *
 * Option labels match the ALLOWED_AUTONOMY enum so the selected label maps
 * directly to the `autonomy` value passed to writeDispatcherAutonomyBlock().
 * Option 1 (`off`) is the recommended, fail-closed default.
 *
 * @returns {{ question: string, header: string, options: Array<{ label: string, description: string }>, multiSelect: boolean }}
 */
export function getDispatcherAutonomyQuestion() {
  return {
    question:
      'Cross-repo dispatcher autonomy: how should this repo participate when the free-repo dispatcher routes work to it?',
    header: 'Dispatcher Autonomy (one-time)',
    options: [
      {
        label: 'off',
        description:
          '(Recommended) Fail-closed. The dispatcher never routes work to this repo automatically. No behaviour change.',
      },
      {
        label: 'advisory',
        description:
          'The dispatcher surfaces ranked free-repo candidates for operator review — no automated dispatch.',
      },
      {
        label: 'autonomous-gated',
        description:
          'A deterministic confidence gate is checked first; only dispatches that clear the confidence-floor route automatically.',
      },
    ],
    multiSelect: false,
  };
}

/**
 * Detect whether the committed `dispatcher-autonomy:` block is present in the
 * given CLAUDE.md / AGENTS.md content. This is the one-time-capture guard:
 * absent → ask, present → never re-ask.
 *
 * SOURCE-OF-TRUTH ALIGNMENT: this guard mirrors the block-header detection of
 * `_parseDispatcherAutonomy()` in dispatcher-autonomy.mjs EXACTLY — both now call
 * the shared `matchBlockHeader()` matcher (block-header.mjs). `hasBlockHeader()`
 * splits on `/\r?\n/` and tests each line, so `\r` and trailing whitespace are
 * eaten by the `\s*$` tail and the identical set of inputs matches.
 * Verified-equivalent edge cases:
 *   - CRLF line endings (`dispatcher-autonomy:\r\n`) → PRESENT (`\s*$` eats the `\r`).
 *   - Trailing spaces / tabs on the header line → PRESENT (`\s*$`).
 *   - Header glued to a leading BOM (a U+FEFF byte-order-mark immediately
 *     preceding `dispatcher-autonomy:`) → ABSENT, because `^...` requires column-0
 *     and the BOM occupies it — IDENTICAL to the parser, which also rejects it.
 *     (A BOM at file START with the header on a
 *     LATER line is unaffected; the block is always appended to the end of an
 *     existing file, so the BOM never touches the header in practice.)
 *   - Header inside a ``` fenced code block → PRESENT. This is DELIBERATE: the
 *     parser does not track fences and would treat such a header as a real block,
 *     so the guard must agree. The never-re-ask marker is "the parser would see a
 *     block", not "a human would call it config". If the parser is ever taught to
 *     skip fences, update this guard in lock-step.
 *   - Header present but BODY malformed (garbage non-yaml lines) → PRESENT. A
 *     malformed block is the operator's to fix, never a re-prompt trigger — the
 *     parser tolerantly falls back to defaults, and capture must not re-ask.
 *
 * No-throw: null / non-string / empty → false.
 *
 * @param {unknown} claudeMdContent — full CLAUDE.md / AGENTS.md file contents
 * @returns {boolean}
 */
export function isDispatcherAutonomyBlockPresent(claudeMdContent) {
  if (typeof claudeMdContent !== 'string' || claudeMdContent.length === 0) return false;
  return hasBlockHeader(claudeMdContent, 'dispatcher-autonomy');
}

/**
 * Coerce a candidate autonomy value to a valid lowercase enum, falling back to
 * 'off' when unset/empty/whitespace/invalid (fail-closed). Mirrors the
 * fail-closed posture of resolveDispatcherAutonomy().
 *
 * @param {unknown} value
 * @returns {string} one of ALLOWED_AUTONOMY
 */
function coerceAutonomy(value) {
  if (value === null || value === undefined) return 'off';
  const normalized = String(value).toLowerCase().trim();
  return ALLOWED_AUTONOMY.includes(normalized) ? normalized : 'off';
}

/**
 * Clamp a candidate confidence-floor to the closed interval [0.0, 1.0],
 * falling back to the default when unset/non-finite.
 *
 * @param {unknown} value
 * @returns {number} float in [0.0, 1.0]
 */
function clampConfidenceFloor(value) {
  if (value === null || value === undefined || value === '') return DEFAULT_CONFIDENCE_FLOOR;
  const f = Number(value);
  if (!Number.isFinite(f)) return DEFAULT_CONFIDENCE_FLOOR;
  if (f < 0) return 0;
  if (f > 1) return 1;
  return f;
}

/**
 * Render the canonical standalone `## Dispatcher Autonomy` H2 block + fenced
 * yaml. The standalone-H2 placement is MANDATORY: it keeps
 * claude-md-drift-check Check-6 (Session-Config-parity) green. Promoting the
 * block into `## Session Config` would hard-fail drift-check on every repo
 * lacking the key.
 *
 * Validates `autonomy` against the enum (fall back to 'off') and clamps
 * `confidenceFloor` to [0, 1]. Writes ONLY the committed default — never the
 * host-local override.
 *
 * @param {{ autonomy?: unknown, confidenceFloor?: unknown }} [opts]
 * @returns {string} the rendered block (leading newline, trailing newline)
 */
export function renderDispatcherAutonomyBlock({ autonomy, confidenceFloor = DEFAULT_CONFIDENCE_FLOOR } = {}) {
  const safeAutonomy = coerceAutonomy(autonomy);
  const safeFloor = clampConfidenceFloor(confidenceFloor);

  return [
    '',
    '## Dispatcher Autonomy',
    '',
    '> **Parity-exempt section.** This H2 is intentionally placed outside the `## Session Config` block so that the `claude-md-drift-check` Check-6 parity scanner (which extracts only column-0 keys inside the `## Session Config` block) does not flag repos that have not yet adopted this feature. Issue #679 / #681.',
    '',
    'Opt-in configuration for the cross-repo free-repo dispatcher autonomy gate (Epic #673). The default is `off` — fail-closed. The effective `autonomy` resolves with host-local precedence `SO_DISPATCHER_AUTONOMY` env > `owner.yaml` `dispatcher.autonomy` > committed > `off` (#653 pattern).',
    '',
    '```yaml',
    'dispatcher-autonomy:',
    `  autonomy: ${safeAutonomy}            # off | advisory | autonomous-gated — default off (fail-closed)`,
    `  confidence-floor: ${safeFloor}    # float 0.0..1.0`,
    '```',
    '',
    'Read by: `scripts/lib/config/dispatcher-autonomy.mjs` (parser + resolver), `skills/dispatcher/SKILL.md` (cross-repo dispatch flow). Issue: #681.',
    '',
  ].join('\n');
}

/**
 * Idempotently append the committed `dispatcher-autonomy:` block to CLAUDE.md.
 *
 * Behaviour:
 *   - block ABSENT  → append the rendered block → { written: true, path }.
 *   - block PRESENT → no-op → { written: false, reason: 'already-present' }.
 *   - IO failure    → { written: false, error: <message> } (no-throw).
 *
 * Block presence IS the never-re-ask marker, so a second invocation after a
 * successful write is a safe no-op. A defensive double-write guard re-checks
 * absence against the freshly-read file content immediately before writing (the
 * content read here is the source of truth, not a stale caller-supplied value).
 * This guard fires for a PARTIAL/MALFORMED existing block too: if a (even
 * garbage-bodied) `dispatcher-autonomy:` header already exists, the writer
 * returns `already-present` and never appends a second block — a malformed block
 * is the operator's to repair, not ours to duplicate. The no-op is therefore
 * idempotent against concurrent sessions (parallel writers) AND against
 * hand-edited malformed blocks.
 *
 * @param {{ claudeMdPath: string, autonomy?: unknown, confidenceFloor?: unknown }} opts
 * @returns {{ written: boolean, path?: string, reason?: string, error?: string }}
 */
export function writeDispatcherAutonomyBlock({ claudeMdPath, autonomy, confidenceFloor } = {}) {
  if (typeof claudeMdPath !== 'string' || claudeMdPath.length === 0) {
    return { written: false, error: 'writeDispatcherAutonomyBlock requires a claudeMdPath' };
  }

  let content;
  try {
    content = readFileSync(claudeMdPath, 'utf8');
  } catch (err) {
    return { written: false, error: `read failed: ${err && err.message ? err.message : String(err)}` };
  }

  // Defensive double-write guard: re-check absence against the freshly-read
  // content before writing.
  if (isDispatcherAutonomyBlockPresent(content)) {
    return { written: false, reason: 'already-present' };
  }

  const block = renderDispatcherAutonomyBlock({ autonomy, confidenceFloor });
  // Ensure exactly one separating newline between existing content and the block.
  const separator = content.endsWith('\n') ? '' : '\n';
  const next = `${content}${separator}${block}`;

  try {
    writeFileSync(claudeMdPath, next, 'utf8');
  } catch (err) {
    return { written: false, error: `write failed: ${err && err.message ? err.message : String(err)}` };
  }

  return { written: true, path: claudeMdPath };
}
