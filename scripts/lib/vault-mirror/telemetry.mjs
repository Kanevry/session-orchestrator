/**
 * telemetry.mjs — vault-mirror telemetry emitters (#1116, #1073, #1147).
 *
 * Two events, deliberately BOTH:
 *
 *   - `orchestrator.vault.mirror_completed` — ONE record per JSONL entry
 *     processed (created / updated / every `skipped-*`), carrying the same
 *     `action` the CLI wrote to stdout for that entry.
 *   - `orchestrator.vault.mirror_run_completed` — ONE record per CLI run,
 *     carrying the DENOMINATOR (`total` plus the per-class counts).
 *
 * The per-entry event alone is not enough, and that is the whole point of the
 * pairing: a healthy run over an empty source emits zero per-entry records, and
 * a mirror whose emitter is broken also emits zero — the two are
 * indistinguishable from the ledger (`.claude/rules/host-resources.md` § HR-105,
 * "a rule you cannot falsify is not a rule"). The run event is emitted
 * unconditionally — including on every abort path, where it carries an
 * `aborted` discriminator (`malformed-json` | `filesystem-error` |
 * `unexpected-error`). So `total: 0` is a MEASURED zero, a partial count is a
 * LABELLED partial rather than a silent one, and the record's absence — and
 * nothing else — is the broken-emitter signal.
 *
 * Both emitters are best-effort: a telemetry failure must never fail a mirror
 * run, so every emit is wrapped and its rejection swallowed (same posture as the
 * `orchestrator.secret_masker.applied` emit in `scripts/vault-mirror.mjs`).
 *
 * Ledger destination: `emitEvent` is called 2-arg, so every event from one run
 * resolves the SAME destination (`SO_PROJECT_DIR`, i.e. `CLAUDE_PROJECT_DIR` or
 * the CWD walk-up) as the masker emit. This CLI has no repo-root flag and
 * deriving one from `--source` would split a single run's telemetry across two
 * ledgers.
 */

import { emitEvent, sessionAttribution } from '../events.mjs';
import { SO_PROJECT_DIR } from '../platform.mjs';

/** Canonical event name for a single vault-mirror JSONL entry. */
export const MIRROR_EVENT = 'orchestrator.vault.mirror_completed';

/** Canonical event name for the run-level roll-up (the denominator). */
export const MIRROR_RUN_EVENT = 'orchestrator.vault.mirror_run_completed';

/**
 * Upper bound (characters) on the `reason` string written into the events
 * ledger. Renderer validation messages are short and structured
 * (`missing required field 'x' (session_id=…)`), quality-gate reasons are
 * shorter still (`confidence:0.4 < min:0.5`), and native mapper-crash messages
 * are bounded in practice — the clamp only stops a pathological message from
 * bloating every ledger line. Revisit if a legitimate reason is ever observed
 * truncated.
 */
const MIRROR_REASON_MAX = 300;

/**
 * "Absent is not zero" admission test (docs/events-schema.md): a field that was
 * not measured is OMITTED, never written as `0`/`null`. `null` counts as
 * not-measured here — `record_id` is explicitly `null` for a record carrying
 * neither `id` nor `session_id`, and a null `record_id` in the ledger would read
 * as a measured empty id rather than as "this record had none".
 * @param {unknown} v
 * @returns {boolean}
 */
const present = (v) => v !== undefined && v !== null;

/**
 * Session attribution for this CLI's events.
 *
 * The explicit `SO_PROJECT_DIR` argument is LOAD-BEARING, not decoration:
 * `readLock()` (via `lockPathFor`) defaults to `process.cwd()`, NOT to
 * `SO_PROJECT_DIR`. Calling `sessionAttribution()` bare would therefore read the
 * lock of whatever directory the process happens to run in while the ledger line
 * lands under `CLAUDE_PROJECT_DIR` — attributing a record to a session that
 * never wrote it. Same root for both halves or neither.
 *
 * @returns {{session_id?: string, semantic_session_id?: string}}
 */
function mirrorSessionAttribution() {
  return sessionAttribution(SO_PROJECT_DIR);
}

/**
 * Emit one `orchestrator.vault.mirror_completed` telemetry record for a single
 * mirrored entry. Never throws — a rejected emit is swallowed silently.
 *
 * @param {object} opts
 * @param {string} opts.action — the `action` value the CLI wrote to stdout for
 *   this same entry (`created` | `updated` | `skipped-*`).
 * @param {string} opts.kind — `learning` | `session` (the `--kind` flag).
 * @param {number} opts.line — 1-based JSONL line number of the entry. Always
 *   measured; the only locator available when the record has no id.
 * @param {string|null} [opts.recordId] — the record's `id` / `session_id`.
 *   Omitted from the payload when absent.
 * @param {string|null} [opts.path] — VAULT-RELATIVE target path, when one was
 *   resolved. Omitted on `skipped-invalid` and on the pre-path quality skips,
 *   which are reached before any target path exists. Relative, never absolute:
 *   this payload also travels over the optional Clank webhook with no
 *   redaction, and an absolute path leaks the operator's home directory.
 * @param {string} [opts.skipClass] — failure-class discriminator on the invalid
 *   branches: `validation` | `mapper-crash`.
 * @param {string} [opts.reason] — the renderer's error message, or the
 *   quality-gate `meta.reason` string. Clamped to {@link MIRROR_REASON_MAX}.
 * @param {boolean} [opts.dryRun] — whether this run wrote anything at all.
 * @returns {Promise<void>}
 */
export async function emitMirrorEvent({
  action,
  kind,
  line,
  recordId,
  path,
  skipClass,
  reason,
  dryRun,
}) {
  try {
    await emitEvent(MIRROR_EVENT, {
      action,
      kind,
      line,
      ...(present(recordId) ? { record_id: recordId } : {}),
      ...(present(path) ? { path } : {}),
      ...(present(skipClass) ? { skip_class: skipClass } : {}),
      ...(present(reason) ? { reason: String(reason).slice(0, MIRROR_REASON_MAX) } : {}),
      ...(typeof dryRun === 'boolean' ? { dry_run: dryRun } : {}),
      ...mirrorSessionAttribution(),
    });
  } catch {
    // Silent no-op — telemetry must never be the reason a mirror run fails.
  }
}

/**
 * Emit the single `orchestrator.vault.mirror_run_completed` roll-up for a
 * whole CLI run. Never throws.
 *
 * The five counters (`total`, `created`, `updated`, `skipped`, `failed`) are
 * ALWAYS present, INCLUDING when they are `0` — they are the denominator, and
 * this is the one place where a written zero is the payload rather than a
 * violation of "absent is not zero": each one was measured over the entire run.
 * `action_breakdown` is the opposite: it enumerates only the actions that
 * actually occurred, and a missing key there means zero occurrences (the
 * always-present `total` makes that reading unambiguous).
 *
 * On an ABORTED run the same five counters are still written, and `aborted`
 * is what keeps them honest: it says the run stopped before its tail, so the
 * lines after the abort were never attempted and
 * `created + updated + skipped + failed === total` no longer holds. Without
 * that label a partial denominator would be indistinguishable from a complete
 * one — the same "absent is not zero" failure this event exists to prevent,
 * one level up.
 *
 * @param {object} opts
 * @param {string} opts.kind — `learning` | `session` (the `--kind` flag).
 * @param {number} opts.total — non-blank JSONL entries the run attempted.
 * @param {number} opts.created — entries whose action was `created`.
 * @param {number} opts.updated — entries whose action was `updated`.
 * @param {number} opts.skipped — entries skipped for a NON-failure reason
 *   (`skipped-noop`, `skipped-handwritten`, `skipped-quality-low`,
 *   `skipped-collision-resolved`, `skipped-abandoned`).
 * @param {number} opts.failed — entries that produced `skipped-invalid`
 *   (validation error or mapper crash). Split out from `skipped` because these
 *   are the runs where a session silently ends up WITHOUT its vault note.
 * @param {Record<string, number>} [opts.actionBreakdown] — per-action counts;
 *   only actions observed at least once appear.
 * @param {boolean} opts.dryRun — whether this run wrote anything at all.
 * @param {'malformed-json'|'filesystem-error'|'unexpected-error'} [opts.aborted]
 *   Present ONLY when the run exited before its normal tail. OMITTED on a
 *   complete run — absent means "ran to the end", never "unknown".
 * @returns {Promise<void>}
 */
export async function emitMirrorRunEvent({
  kind,
  total,
  created,
  updated,
  skipped,
  failed,
  actionBreakdown,
  dryRun,
  aborted,
}) {
  try {
    await emitEvent(MIRROR_RUN_EVENT, {
      kind,
      total,
      created,
      updated,
      skipped,
      failed,
      ...(actionBreakdown && Object.keys(actionBreakdown).length > 0
        ? { action_breakdown: actionBreakdown }
        : {}),
      dry_run: dryRun,
      ...(present(aborted) ? { aborted } : {}),
      ...mirrorSessionAttribution(),
    });
  } catch {
    // Silent no-op — telemetry must never be the reason a mirror run fails.
  }
}
