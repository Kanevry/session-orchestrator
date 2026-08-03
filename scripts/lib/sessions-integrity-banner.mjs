/**
 * sessions-integrity-banner.mjs — GitLab #958 finding 3 (visibility half).
 *
 * Deterministic session-start nudge for the "silently invalid ledger record"
 * gap: `.orchestrator/metrics/sessions.jsonl` accumulates records that fail
 * the repo's OWN `validateSession()`, and nobody is told.
 *
 * Why the loss is silent (W1/D4, 2026-07-31, HEAD 1f7b449): the ledger record
 * is composed by the coordinator from a Markdown template
 * (`skills/session-end/metrics-collection.md`) and appended directly,
 * bypassing `scripts/emit-session.mjs` — which validates and would have
 * exited 1. Downstream, `scripts/vault-mirror.mjs` logs the casualty as
 * `{"action":"skipped-invalid"}` on stdout and still exits 0, so the affected
 * sessions simply have no vault note. A prose prohibition already exists in
 * `skills/session-end/session-metrics-write.md` and did not stop it; this
 * banner is the instrument that makes the residue visible at session-start.
 *
 * Mirrors the contract used by the sibling Phase 4 banners
 * (`scripts/lib/sessions-staleness-banner.mjs`,
 * `scripts/lib/reconcile-nudge-banner.mjs`,
 * `scripts/lib/vault-staleness-banner.mjs`): a single `checkXxx({repoRoot})`
 * entry point that is COMPLETELY try/catch-wrapped (never throws) and returns
 * either `null` (silent no-op) or `{severity:'warn'|'alert', message, ...extra}`.
 *
 * TWO VALIDATORS OVER ONE STORE — why this banner reports both populations.
 * The repo has two independent notions of "a valid session record", and
 * neither one contains the other:
 *
 *   - `validateSession()` (`scripts/lib/session-schema/validator.mjs`) — the
 *     canonical write-path schema, enforced by `scripts/emit-session.mjs`.
 *     It treats `effectiveness` as OPTIONAL/nullable, so a record vault-mirror
 *     refuses to render can pass it cleanly.
 *   - vault-mirror's render path — its own, differently-shaped requirement
 *     set (`generateSessionNote*` in
 *     `scripts/lib/vault-mirror/render-sessions.mjs`, routed by
 *     `detectSessionSchema`), which REQUIRES `effectiveness` to be present.
 *     A record can therefore be schema-valid and still get no vault note.
 *
 * Reporting one population would hide the other, so the banner names both and
 * attributes each to its own consequence.
 *
 * Live ledger at HEAD 1f7b449 + the #958 fix (2026-07-31, 203 parseable
 * records, 145 of them `status: 'abandoned'`): `validateSession` fails 0,
 * vault-mirror render fails 10 — and all 10 of those are abandoned, i.e.
 * discarded by the #909 filter BEFORE the render path (see
 * `mirrorSkipReason` below), so the banner is correctly silent here. The
 * counts move as the ledger grows; treat them as a dated measurement, never
 * as an invariant.
 *
 * The vault-mirror population is measured by CALLING THE REAL RENDER PATH in
 * a try/catch — never by re-deriving its required-field list here. A third
 * copy of that list would reproduce the very defect this banner reports
 * (`.claude/rules/testing.md` § Unfaithful Double: ask the production code
 * what it would do, do not model it). The same rule is why the #909 abandoned
 * filter is imported from `session-schema/filters.mjs` and not re-typed.
 *
 * Severity is grounded in consequence, not in an arbitrary count threshold:
 *   - `warn`  — records are schema-invalid, but every one of them still
 *               mirrors: the ledger is corrupt, nothing is lost yet.
 *   - `alert` — at least one record is DROPPED by vault-mirror: those
 *               sessions have no vault note right now.
 *
 * Deliberately un-gated (no Session Config key, like `project-hygiene`) — a
 * check nobody enables finds nothing.
 *
 * Plain-JS — no Zod dependency. Never throws. Never mutates input. No
 * `console.*` calls (repo ESLint `no-console` rule).
 *
 * Cross-references:
 *  - `scripts/lib/session-schema/validator.mjs` — `validateSession`.
 *  - `scripts/lib/session-schema/filters.mjs` — `isRealSession` (#909).
 *  - `scripts/lib/vault-mirror/process.mjs` — the routing this probe mirrors.
 *  - `scripts/lib/vault-mirror/render-sessions.mjs` — the real render path.
 *  - `scripts/emit-session.mjs` — the validating writer this banner points at.
 *  - `hooks/pre-bash-sessions-ledger-guard.mjs` — the write-guard half of #958.
 *  - `skills/session-start/SKILL.md` Phase 4 — banner render site.
 *  - `.claude/rules/verification-before-completion.md` — evidence-before-claims.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { isRealSession } from './session-schema/filters.mjs';
import { validateSession } from './session-schema/validator.mjs';
import {
  detectSessionSchema,
  normalizeSessionEntry,
  generateSessionNote,
  generateSessionNoteV2,
  generateSessionNoteV3,
} from './vault-mirror/render-sessions.mjs';

/** Repo-relative path to the session ledger (one record per closed session). */
const SESSIONS_PATH = '.orchestrator/metrics/sessions.jsonl';

/** Max session_ids listed inline before the message collapses to "+N more". */
export const MAX_LISTED_IDS = 5;

/**
 * Read the ledger's non-empty lines. Returns `null` when the file is absent
 * or unreadable, `[]` when it exists but has no non-empty lines. Never throws.
 *
 * @param {string} filePath
 * @returns {string[]|null}
 */
function readJsonlLines(filePath) {
  if (!existsSync(filePath)) return null;
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  return raw.split('\n').filter((line) => line.length > 0);
}

/**
 * Ask the REAL vault-mirror render path whether it would skip this entry AS
 * `skipped-invalid`. Reproduces `scripts/lib/vault-mirror/process.mjs`
 * `processSession()` routing in its production ORDER: normalize aliases (#635)
 * → detect schema → select that schema's generator → **#909 abandoned filter**
 * → invoke the generator. A throw from the generator is precisely what
 * `scripts/vault-mirror.mjs` catches and reports as
 * `{"action":"skipped-invalid"}`.
 *
 * The abandoned filter is load-bearing, not decoration. `process.mjs:485`
 * returns `skipped-abandoned` for `!isRealSession(entry)` BEFORE the generator
 * is ever called, so an abandoned record can never reach the render path and
 * can never become `skipped-invalid`. Omitting it made this probe measure a
 * population production never reaches: on this repo's ledger (2026-07-31, HEAD
 * 1f7b449, 203 records) **all 10** reported "dropped" records were
 * `status: 'abandoned'` — a 100 %-false 🚨 on every session start, with a
 * prescribed remedy (re-emit) that produces no vault note for such a record.
 * The predicate is IMPORTED from `session-schema/filters.mjs` rather than
 * re-derived: that rule already has exactly two homes (the filter module and
 * `process.mjs`'s call site), and a hand-copied `status !== 'abandoned'` here
 * would make a third — the divergence class this banner exists to report.
 *
 * The generator is invoked with one argument where production passes
 * `generator(entry, { repoNs })` (`process.mjs:517`). All three generators
 * declare `options = {}` and use `repoNs` only for a frontmatter field, never
 * to decide whether to throw — so the omission cannot change the render/skip
 * verdict this probe reads. Resolving a real `repoNs` here would cost a git
 * subprocess per record for a value the verdict ignores.
 *
 * @param {object} record
 * @returns {string|null} the skip reason, or `null` when production would
 *   either render it or discard it for a reason OTHER than invalidity.
 */
function mirrorSkipReason(record) {
  try {
    const entry = normalizeSessionEntry(record);
    const schema = detectSessionSchema(entry);
    const generator =
      schema === 'v3' ? generateSessionNoteV3 : schema === 'v2' ? generateSessionNoteV2 : generateSessionNote;
    // #909 filter — production returns `skipped-abandoned` here and never
    // reaches the generator. Not a render failure; not this banner's signal.
    if (!isRealSession(entry)) return null;
    generator(entry);
    return null;
  } catch (err) {
    return err && typeof err.message === 'string' ? err.message : 'unknown render failure';
  }
}

/**
 * Render `<id>, <id>, … (+N more)` for a bounded id list.
 *
 * @param {{sessionId: string}[]} rows
 * @returns {string}
 */
function formatIds(rows) {
  const ids = rows.map((r) => r.sessionId);
  const shown = ids.slice(0, MAX_LISTED_IDS).join(', ');
  const rest = ids.length - MAX_LISTED_IDS;
  return rest > 0 ? `${shown} (+${rest} more)` : shown;
}

/**
 * Check sessions-ledger schema integrity and produce a session-start banner.
 *
 * Silent (`null`) when: `sessions.jsonl` is missing, empty, unreadable, holds
 * no parseable JSON line at all, or every parseable record satisfies BOTH
 * `validateSession()` and the vault-mirror render path. An `abandoned` record
 * satisfies the render half vacuously — production discards it as
 * `skipped-abandoned` before rendering, so it can never be `skipped-invalid`
 * and is never counted in `mirrorSkipped`. Unparseable lines are
 * SKIPPED, not reported — this probe judges schema integrity, not file
 * corruption (matching the sibling banners' malformed-line handling). Never
 * throws.
 *
 * @param {{repoRoot: string}} opts
 *   - `repoRoot`: REQUIRED absolute path to the repo root.
 * @returns {null | {
 *   severity: 'warn'|'alert',
 *   message: string,
 *   total: number,
 *   schemaInvalid: {line: number, sessionId: string, error: string}[],
 *   mirrorSkipped: {line: number, sessionId: string, error: string}[],
 * }}
 */
export function checkSessionsIntegrity({ repoRoot } = {}) {
  try {
    if (!repoRoot || typeof repoRoot !== 'string') return null;

    const lines = readJsonlLines(path.join(repoRoot, SESSIONS_PATH));
    if (lines === null || lines.length === 0) return null;

    /** @type {{line: number, sessionId: string, error: string}[]} */
    const schemaInvalid = [];
    /** @type {{line: number, sessionId: string, error: string}[]} */
    const mirrorSkipped = [];
    let total = 0;

    for (let i = 0; i < lines.length; i++) {
      let record;
      try {
        record = JSON.parse(lines[i]);
      } catch {
        continue; // unparseable line — not this probe's concern
      }
      if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
      total += 1;

      const sessionId =
        typeof record.session_id === 'string' && record.session_id.length > 0
          ? record.session_id
          : '<no session_id>';

      try {
        validateSession(record);
      } catch (err) {
        schemaInvalid.push({
          line: i + 1,
          sessionId,
          error: err && typeof err.message === 'string' ? err.message : 'unknown validation failure',
        });
      }

      const skipReason = mirrorSkipReason(record);
      if (skipReason !== null) {
        mirrorSkipped.push({ line: i + 1, sessionId, error: skipReason });
      }
    }

    if (total === 0) return null;
    if (schemaInvalid.length === 0 && mirrorSkipped.length === 0) return null;

    // alert only when records are ACTUALLY being dropped by vault-mirror —
    // those sessions have no vault note right now. A schema-invalid record
    // that still mirrors is corruption without loss: warn.
    const severity = mirrorSkipped.length > 0 ? 'alert' : 'warn';

    const parts = [];
    if (schemaInvalid.length > 0) {
      parts.push(
        `${schemaInvalid.length} of ${total} records fail validateSession (${formatIds(schemaInvalid)})`
      );
    }
    if (mirrorSkipped.length > 0) {
      parts.push(
        `${mirrorSkipped.length} are dropped by vault-mirror as skipped-invalid — those sessions have NO vault note (${formatIds(mirrorSkipped)})`
      );
    }

    const base =
      `sessions-integrity: ${parts.join('; ')} — records were appended without passing ` +
      `scripts/emit-session.mjs (which validates and would have refused). ` +
      `Inspect: node -e with validateSession from scripts/lib/session-schema/validator.mjs; ` +
      `re-emit affected records via scripts/emit-session.mjs`;

    const message = severity === 'alert' ? `🚨 ${base}.` : `⚠ ${base}.`;

    return { severity, message, total, schemaInvalid, mirrorSkipped };
  } catch {
    // Defensive catch-all — banner must never throw.
    return null;
  }
}
