/**
 * process.mjs — Core entry processors for vault-mirror (Issue #283 split).
 *
 * Exports: processLearning, processSession
 * Both functions write to the vault dir and emit JSON action lines to stdout.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSecretValueMasker } from '../secret-masker.mjs';
import { subjectToSlug, isValidSlug, uuidPrefix8, toDate, parseFrontmatter } from './utils.mjs';
import { isRealSession } from '../session-schema/filters.mjs';
import { resolveRepoNamespace } from './namespace.mjs';
import { detectLearningSchema, normalizeLearningEntry, generateLearningNote, generateLearningNoteV2 } from './render-learnings.mjs';
import { detectSessionSchema, normalizeSessionEntry, generateSessionNote, generateSessionNoteV2, generateSessionNoteV3 } from './render-sessions.mjs';
import { emitMirrorEvent } from './telemetry.mjs';

const GENERATOR_MARKER = 'session-orchestrator-vault-mirror@1';

// ── Session-note existence index (Issue #704) ─────────────────────────────────

/**
 * Module-level cache: resolved vaultDir path → Set of known session basenames
 * (without the `.md` extension). Built once per unique vaultDir per process.
 *
 * @type {Map<string, Set<string>>}
 */
const _sessionNoteSets = new Map();

/**
 * Recursively walk `<vaultDir>/50-sessions/` and collect every `.md` basename
 * (without extension) into a Set. Returns an EMPTY Set (never throws) when the
 * directory is absent or unreadable — callers treat an empty Set as "no predicate
 * available", falling back to format-validation in resolveSourceSessionLink.
 *
 * Read-only: never creates directories, safe in dryRun mode.
 *
 * @param {string} vaultDir — absolute path to the vault root
 * @returns {Set<string>}
 */
function getSessionNoteSet(vaultDir) {
  const resolvedVault = resolve(vaultDir);
  if (_sessionNoteSets.has(resolvedVault)) return _sessionNoteSets.get(resolvedVault);

  const knownSessions = new Set();
  const sessionsDir = join(resolvedVault, '50-sessions');

  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // dir absent or inaccessible — skip silently
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        walk(join(dir, entry.name));
      } else if (entry.name.endsWith('.md')) {
        knownSessions.add(entry.name.slice(0, -3)); // basename without .md
      }
    }
  }

  walk(sessionsDir);
  _sessionNoteSets.set(resolvedVault, knownSessions);
  return knownSessions;
}

// ── Content diff helper ───────────────────────────────────────────────────────

/**
 * Extract canonical comparable fields from a rendered learning note string.
 *
 * We compare only the fields that represent meaningful SSOT content changes —
 * not created/updated dates or frontmatter ordering, which differ on every
 * render without signalling a content change.
 *
 * Comparable fields:
 *   - status (frontmatter line `status: <value>`)
 *   - expires (frontmatter line `expires: <value>`, v1 only; absent in v2)
 *   - confidence (body bullet `- **Confidence:** <value>`)
 *   - insight body (text after `## Insight\n\n` heading, trimmed)
 *
 * @param {string} noteContent — rendered markdown string
 * @returns {{ status: string, expires: string, confidence: string, insight: string }}
 */
function extractLearningCanonicalFields(noteContent) {
  const status = (noteContent.match(/^status:\s*(.+)$/m) || [])[1]?.trim() ?? '';
  const expires = (noteContent.match(/^expires:\s*(.+)$/m) || [])[1]?.trim() ?? '';
  const confidence = (noteContent.match(/^- \*\*Confidence:\*\*\s*(.+)$/m) || [])[1]?.trim() ?? '';
  // Extract insight body: everything after `## Insight\n\n` until the next `##` or end-of-string
  const insightMatch = noteContent.match(/^## Insight\n\n([\s\S]*?)(?=\n## |\s*$)/m);
  const insight = insightMatch ? insightMatch[1].trim() : '';
  // #704: track the frontmatter source_session so a normal re-mirror repairs
  // historical dangling-link notes (e.g. `source_session: "[[unknown]]"`) once
  // the renderer emits the corrected plain-text/resolvable form — otherwise the
  // content-diff would treat the stale note as a no-op and never heal it.
  const source_session = (noteContent.match(/^source_session:\s*(.+)$/m) || [])[1]?.trim() ?? '';
  return { status, expires, confidence, insight, source_session };
}

/**
 * The marker every redaction sink in this repo splices in (`redact-spans.mjs`).
 * Declared here as a literal rather than imported: `redactSpans` does not export
 * it, and this module needs it as a SEARCH token, not as a replacement.
 */
const REDACTION_MARKER = '[REDACTED]';

/**
 * Does the on-disk `existingVal` match `renderedVal` once every `[REDACTED]`
 * span in it is treated as a wildcard? (#1025)
 *
 * WHY THIS EXISTS. Masking is env-derived and the env is not part of the record,
 * so the two sides of the idempotency comparison can be masked DIFFERENTLY: a
 * note written while `FOO_TOKEN` was set carries `[REDACTED]`, and a later run
 * with that var absent renders the RAW value. Plain equality then reports
 * "content changed" and the mirror WRITES THE RAW SECRET — the repeated leak
 * measured in #1025 Probe A. Treating an on-disk redaction as "some value stood
 * here" makes that second run a `skipped-noop` again.
 *
 * DIRECTION IS DELIBERATE — the wildcard is only ever read off the ON-DISK side.
 * An on-disk `[REDACTED]` is evidence that a mask ran; an on-disk raw value is
 * evidence of nothing, so the reverse (candidate redacted, disk raw) stays a
 * mismatch. See the COLD-START FREEZE note in `maskEntrySecrets` for the residual
 * that this asymmetry leaves open on purpose.
 *
 * NAMED CEILING: the wildcard is exactly as wide as the marker spans — every
 * literal segment AROUND them must still match byte for byte. A genuine content
 * edit that happens to sit entirely inside a redacted span is therefore read as a
 * no-op. That is a bounded over-approximation on a field whose masked half is by
 * definition unpublishable; the alternative (persisting the needle set to disk)
 * would put a secrets file on disk to protect against secrets, which is worse.
 *
 * THE MARKER IS NOT AUTHENTICATED — and it cannot be. `[REDACTED]` is an ordinary
 * string that this repo's own prose uses freely (ADRs, rule files, learnings), so
 * its presence is evidence a mask MAY have run, never proof one did. Two cheap
 * narrowings bound what that costs:
 *   - A value consisting of NOTHING BUT markers (`[REDACTED]`, or two in a row)
 *     leaves zero literal anchors, compiling to a pattern that matches every
 *     string — a field permanently blind to every future edit. Rejected outright:
 *     with no anchor there is no evidence of what stood there, so the safe read is
 *     "not a redaction of this candidate".
 *   - A marker span stands for at least ONE character (`+?`, not `*?`). A masked
 *     needle is >= `MIN_MASKABLE_LENGTH` (8) characters by construction, so this
 *     never rejects a real redaction and does reject the empty-span reading.
 *
 * REJECTED ALTERNATIVE — gating the wildcard on `needleCount > 0`. It reads as the
 * obvious authentication ("no needles this run, so an on-disk marker cannot be
 * ours") and it destroys the fix, because the leaking run is EXACTLY the run with
 * zero needles: #1025 Probe A reproduced `written` + raw value on the second run
 * precisely because the env no longer carried the secret. Gating there would
 * disable the wildcard in the only case it exists for. The needle count of the
 * CURRENT run says nothing about the env of the run that wrote the file.
 *
 * SHARED BY TWO VAULT SINKS — do not inline a second copy. `writeNarrative` in
 * `scripts/lib/vault-status/narrative-mirror.mjs` imports this for its own
 * skip-noop decision; both write into the same tracked, pushed vault repo, so the
 * contract in `secret-masker.mjs`'s header must hold identically in both. (That
 * module is the natural long-term home for this predicate — see the note there.)
 *
 * @param {string} existingVal — field value parsed out of the note on disk
 * @param {string} renderedVal — same field from the freshly rendered candidate
 * @returns {boolean}
 */
export function matchesModuloRedaction(existingVal, renderedVal) {
  if (typeof existingVal !== 'string' || typeof renderedVal !== 'string') return false;
  if (!existingVal.includes(REDACTION_MARKER)) return false;
  const segments = existingVal.split(REDACTION_MARKER);
  // Degenerate-wildcard guard: no literal anchor survives, so the pattern would
  // match anything and freeze the field forever. See the header above.
  if (segments.every((segment) => segment === '')) return false;
  const pattern = segments.map((segment) => RegExp.escape(segment)).join('[\\s\\S]+?');
  return new RegExp(`^${pattern}$`).test(renderedVal);
}

/**
 * Return true when the existing vault note content and the freshly-rendered
 * candidate share identical canonical fields (i.e. no meaningful update needed).
 *
 * A true result means → emit skipped-noop.
 * A false result means → the SSOT changed; write the new content.
 *
 * Comparison semantics: a field that is ABSENT in the existing note (empty
 * string from extractLearningCanonicalFields) is treated as matching any
 * rendered value for that field. This preserves backward compatibility with
 * notes written by older generator versions that may not have emitted every
 * field. Only when an existing field is NON-EMPTY and differs from the
 * rendered candidate do we conclude the SSOT has changed and an update is needed.
 *
 * @param {string} existingContent — content read from the vault note on disk
 * @param {string} renderedContent — freshly generated note from the renderer
 * @returns {boolean}
 */
function learningContentMatches(existingContent, renderedContent) {
  const existing = extractLearningCanonicalFields(existingContent);
  const rendered = extractLearningCanonicalFields(renderedContent);
  // For each field: if the existing value is absent (empty string), it cannot
  // signal a mismatch — it means the old note didn't track that field. Only
  // non-empty existing values are compared against the rendered candidate.
  // #1025: a field whose only difference from the candidate is a `[REDACTED]`
  // span counts as a match — see matchesModuloRedaction above.
  const fieldMatches = (existingVal, renderedVal) =>
    existingVal === '' ||
    existingVal === renderedVal ||
    matchesModuloRedaction(existingVal, renderedVal);
  return (
    fieldMatches(existing.status, rendered.status) &&
    fieldMatches(existing.expires, rendered.expires) &&
    fieldMatches(existing.confidence, rendered.confidence) &&
    fieldMatches(existing.insight, rendered.insight) &&
    fieldMatches(existing.source_session, rendered.source_session)
  );
}

/**
 * Would the process-wide masker (see `ensureMasker` below) still change `text`
 * if it ran again right now? (#1028 residue 1)
 *
 * Used as a LAST guard before returning `skipped-noop` in `processLearning`.
 * `learningContentMatches` above compares only five canonical fields, so it
 * cannot see a raw secret sitting in a NON-canonical field (`evidence` is the
 * realistic one — see the KNOWN-RESIDUAL note on `maskEntrySecrets` below): a
 * candidate that matches on those five fields can still be an on-disk leak.
 * When this returns `true`, the caller must NOT skip — it falls through to the
 * write path so the note is re-rendered (and re-masked) from the current entry.
 *
 * NAMED CEILING: this only heals a needle that is still present in the CURRENT
 * process env. A needle that has since been rotated out of the env no longer
 * masks to anything different, so `mask(text) === text` and this returns
 * `false` — that needle's leak is healed only by an explicit `force: true`
 * re-mirror (which bypasses the comparison entirely), never by a plain re-run.
 *
 * COST: one extra `mask()` call per candidate no-op — cheap relative to the
 * read/parse/render already done to reach this check, and only paid on the
 * no-op path (a real content change already writes without reaching here).
 *
 * @param {string} text — on-disk note content to probe
 * @returns {boolean} true when masking `text` again would produce different output
 */
function maskerWouldChange(text) {
  return ensureMasker().mask(text) !== text;
}

// ── repo derivation ───────────────────────────────────────────────────────────

/**
 * `deriveRepo` LIVES IN `./namespace.mjs` and is re-exported here (issue #734b).
 *
 * Until #734b this module defined it while `namespace.mjs` imported it — and
 * `namespace.mjs` was in turn imported here for `resolveRepoNamespace`, forming
 * the repo's only import cycle. Moving the definition down to the leaf-ward
 * identity module broke the cycle; this re-export keeps `process.mjs`'s public
 * surface unchanged for the existing consumers that import it from here.
 *
 * Do NOT re-add a second definition: `deriveRepo` caches its result in a
 * module-level variable, so a duplicate would produce two independent caches
 * (and two `git remote get-url origin` spawns).
 */
export { deriveRepo } from './namespace.mjs';

// ── Action output ─────────────────────────────────────────────────────────────

/**
 * Emit a JSON action line to stdout.
 *
 * Takes a single self-documenting options object (issue #511). `emitAction` is a
 * module-level export (independently unit-tested), so `vaultDir` is carried as a
 * named option field rather than pulled from a closure — both callers
 * (processLearning, processSession) destructure it from their own `ctx` and pass
 * it through.
 *
 * #589 LOW-arch-3 — the `vaultDir`-in-options-object pattern is consciously
 * accepted: the 16 call-sites in THIS module repeat `vaultDir` as boilerplate,
 * but there is only one consumer module, so a `makeEmitAction({ vaultDir })`
 * closure factory would be premature (YAGNI). Extract the factory ONLY when a
 * SECOND module needs `emitAction` and would otherwise re-thread `vaultDir`.
 *
 * @param {object} opts
 * @param {string} opts.action — action name (e.g. 'created', 'updated', 'skipped-quality-low')
 * @param {string|null} opts.path — absolute path to the file (or null when no file
 *   was created/touched, e.g. for quality-gate skips before any write)
 * @param {string} opts.kind — 'learning' or 'session'
 * @param {string|null} opts.id — entry id
 * @param {string} opts.vaultDir — vault root (used to relativise `path`)
 * @param {object} [opts.meta] — optional extra fields merged into the emitted JSON
 *   (used for quality-gate skips to carry a `reason` field). Callers that omit
 *   `meta` get the base JSON shape unchanged.
 * @param {number} [opts.line] — 1-based JSONL line number. When FINITE, this
 *   entry also gets one `orchestrator.vault.mirror_completed` ledger record
 *   (#1147) — UNLESS `action` is `skipped-noop`, whose per-entry record is
 *   suppressed as ledger flood and reported only in the run-level roll-up
 *   (#1151; see the gate below). Omitting `line` keeps the stdout-only
 *   behaviour, which is what the direct unit tests of this function exercise.
 * @param {boolean} [opts.dryRun] — the run's dry-run flag, for telemetry only.
 * @param {string} [opts.skipClass] — `validation` | `mapper-crash`; telemetry only.
 * @param {string} [opts.reason] — explicit telemetry reason. Defaults to
 *   `meta.reason` when that exists, so the quality-gate strings
 *   (`confidence:X < min:Y` / `narrative:N < min:M` / `status:…`) are REUSED
 *   rather than recomputed — recomputing is how one fact becomes two copies.
 * @returns {Promise<string>} the `action` string, so the CLI's main loop can
 *   tally a run-level denominator without a second census of these call sites.
 */
export async function emitAction({
  action,
  path,
  kind,
  id,
  vaultDir,
  meta,
  line,
  dryRun,
  skipClass,
  reason,
}) {
  let rel;
  if (path === null || path === undefined) {
    rel = null;
  } else {
    const resolvedVaultDir = resolve(vaultDir);
    rel = path.startsWith(resolvedVaultDir)
      ? path.slice(resolvedVaultDir.length + 1)
      : path;
  }
  const payload = { action, path: rel, kind, id };
  if (meta && typeof meta === 'object') {
    Object.assign(payload, meta);
  }
  // The stdout JSON-per-entry protocol is the CONTRACT other callers parse —
  // it stays byte-identical; the ledger record below is purely additive.
  process.stdout.write(JSON.stringify(payload) + '\n');

  // Per-entry ledger record for every action EXCEPT `skipped-noop` (#1151).
  //
  // `skipped-noop` is the STEADY STATE, not an event: on a populated vault
  // nearly every record is already mirrored, so one `--kind session` run over
  // this repo's ~276-record sessions ledger wrote ~276 per-entry records that
  // between them said "nothing happened" — burying every other event class in
  // the same file. No information is lost by dropping them: `finishRun()` in
  // `scripts/vault-mirror.mjs` counts this class into the run event's `skipped`
  // total AND names it in `action_breakdown['skipped-noop']`, so the noop COUNT
  // stays measured per run and the gate stays falsifiable (HR-105).
  //
  // BV-004 ceiling: what this drops is the per-LINE locator for noops — the
  // ledger can still say HOW MANY records were unchanged, never WHICH. Revisit
  // if a consumer ever needs to name them (a staleness audit over unchanged
  // notes would); reinstate it behind an opt-in flag then, not unconditionally.
  if (Number.isFinite(line) && action !== 'skipped-noop') {
    const telemetryReason =
      reason ?? (meta && typeof meta.reason === 'string' ? meta.reason : undefined);
    await emitMirrorEvent({
      action,
      kind,
      line,
      recordId: id,
      // The VAULT-RELATIVE path (`rel`), never the absolute one: the ledger
      // record can travel over the optional Clank webhook unredacted.
      path: rel,
      skipClass,
      reason: telemetryReason,
      dryRun,
    });
  }

  return action;
}

/**
 * Per-entry stdout + telemetry wrapper used by {@link processLearning} and
 * {@link processSession}. Threads the line number, kind, vaultDir and dry-run
 * flag out of the processor `ctx` so the 18 call sites do not repeat them.
 *
 * @param {number} lineNum — 1-based JSONL line number of the entry.
 * @param {object} ctx — processor context (`vaultDir`, `dryRun`, `kind`).
 * @param {object} opts — the remaining {@link emitAction} fields (`action`,
 *   `path`, `id`, and optionally `meta`).
 * @returns {Promise<string>} the `action` string.
 */
function emitEntryAction(lineNum, ctx, opts) {
  const { vaultDir, dryRun, kind } = ctx;
  return emitAction({ ...opts, vaultDir, kind, line: lineNum, dryRun });
}

// ── Secret masking (#974) — THE choke-point ───────────────────────────────────

/**
 * Lazily-built, process-wide masker. `createSecretValueMasker` scans the whole
 * env and compiles one RegExp per needle, so it is built ONCE (on the first
 * record) and reused for every record afterwards — never per entry.
 *
 * Lazy rather than module-load-eager so that importing this module for
 * `deriveRepo`/`emitAction` alone costs nothing, and so the env is read at the
 * moment the mirror actually runs.
 *
 * @type {{ mask: (text: string) => string, needleCount: number } | null}
 */
let _secretMasker = null;

/** Records handed to `maskEntrySecrets` this process. Counts only. */
let _maskedRecords = 0;
/** String values this process that masking actually CHANGED. Counts only. */
let _maskHits = 0;

/**
 * Build (once) and return the process-wide masker.
 * @returns {{ mask: (text: string) => string, needleCount: number }}
 */
function ensureMasker() {
  if (_secretMasker === null) _secretMasker = createSecretValueMasker(process.env);
  return _secretMasker;
}

/**
 * Counts-only view of the masking that happened in this process (#1025).
 *
 * Exists so the CLI can emit `orchestrator.secret_masker.applied` at the END of a
 * channel run without reaching into a module-private singleton. It FORCE-BUILDS
 * the masker rather than reporting 0 for an unbuilt one: at 0 processed records
 * the lazy build never fires, and a `needle_count: 0` from that path would be
 * indistinguishable from "this channel has no masking wired at all" — the exact
 * ambiguity the event was added to remove.
 *
 * NEVER returns a needle, a prefix of one, or any masked text — only cardinals.
 *
 * @returns {{ needleCount: number, records: number, hits: number }}
 */
export function getMaskerStats() {
  return { needleCount: ensureMasker().needleCount, records: _maskedRecords, hits: _maskHits };
}

/**
 * Mask every env-derived secret VALUE occurring anywhere in a mirror record,
 * BEFORE any of it becomes a filename, a stdout line, or vault Markdown.
 *
 * WHY THIS IS THE CHOKE-POINT — and why it is on the INPUT, not the output.
 * Everything this mirror writes lands in a TRACKED, PUSHED artifact
 * (`auto-commit.mjs` runs `git add` + `commit` in the vault repo), so a leak here
 * is not deletable — it would need a history rewrite in a foreign repo that
 * neither this repo's `.gitleaks.toml` nor `check-owner-leakage.mjs` guards.
 *
 * THIS IS NOT THE ONLY SUCH CHANNEL — an earlier revision of this comment claimed
 * it was, and that was wrong. Measured 2026-08-15 against the vault at
 * `83a868059` (`git -C <vault> ls-files`): 18 tracked `_session-narrative.md`
 * files (written by `scripts/lib/vault-status/narrative-mirror.mjs`) and 1 tracked
 * `01-projects/session-orchestrator/research/hardware-patterns.md` (written by
 * `scripts/export-hw-learnings.mjs`) live in the same pushed repo. All three
 * channels carry agent-authored free text and all three need hardening
 * independently — the value masker was wired into `export-hw-learnings.mjs` in
 * #1025 for exactly this reason. Read "the vault is a tracked sink" as the
 * property that makes masking necessary HERE, never as a census of the sinks.
 *
 * The records carry agent-authored free text (`insight`, `evidence`, `notes`,
 * `text`) that routinely quotes command lines and error output, which is exactly
 * the class shape-regexes cannot catch: the VALUE is in the prose, with no
 * `FOO_TOKEN=` key beside it.
 *
 * Masking the ENTRY rather than the rendered Markdown is deliberate, for four
 * reasons — a post-render mask would be wrong on all four:
 *   1. The FILENAME. `slug` / `session_id` derive from `subject` / `session_id`,
 *      and the file path is itself committed. A post-render mask never touches
 *      the path, so a secret in a subject would be published as a filename.
 *   2. STDOUT. `emitAction` prints the derived `id` and `path`; masking the input
 *      keeps the action stream clean too.
 *   3. YAML VALIDITY. The renderers decide quoting with `yamlQuoteIfNeeded`
 *      BEFORE emitting `title:`. Masking first lets that decision see the `[`
 *      of the marker and quote the scalar; masking afterwards would inject a bare
 *      `title: [REDACTED]` — a YAML flow sequence, which fails the vault-sync
 *      frontmatter schema at the session-end hard gate.
 *   4. IDEMPOTENCY. `learningContentMatches` compares the on-disk note against a
 *      freshly rendered candidate. Masking the input keeps both sides masked, so
 *      an already-mirrored record still resolves to `skipped-noop`; masking only
 *      on write would make every affected note re-render (and re-commit) forever.
 *
 *      That symmetry holds only while the ENV is stable, and the env is not part
 *      of the record — so idempotency here is env-DEPENDENT. Reproduced (#1025):
 *      a run WITH the secret in env writes `[REDACTED]`; a second run WITHOUT it
 *      renders the raw value, the two differ, and the note is `updated` — i.e.
 *      the leak is written a second time, by the very run that was supposed to be
 *      a no-op. `learningContentMatches` now treats an on-disk `[REDACTED]` span
 *      as a wildcard (see that function) so this direction resolves to
 *      `skipped-noop` again.
 *
 *      RESIDUAL (#1028), NOW HEALED BY A MASK RE-PROBE — and NOT the residual an
 *      earlier revision of this note named. That revision claimed a COLD-START
 *      FREEZE over the CANONICAL fields: first run without the env writes the raw
 *      value, later runs render `[REDACTED]`, and the note freezes. Measured, that
 *      direction HEALS: with no marker on the on-disk side `matchesModuloRedaction`
 *      returns false at its first line, the canonical fields differ, and the run
 *      writes the masked content. The asymmetry is still deliberate (an on-disk
 *      redaction is evidence a mask ran; an on-disk raw value is evidence of
 *      nothing) — it simply does not freeze anything the field comparison can see.
 *
 *      What the field comparison ALONE cannot see: `learningContentMatches`
 *      compares exactly five canonical fields — `status`, `expires`, `confidence`,
 *      `insight`, `source_session`. A raw secret sitting in any OTHER field
 *      (`evidence` is the realistic one; it is agent-authored free text and it is
 *      rendered into the note) leaves all five identical between the raw on-disk
 *      note and the masked candidate — the comparison alone reports a match.
 *
 *      THE FIX: every `skipped-noop` return in `processLearning` (legacy-flat,
 *      disambig-collision, same-id) is now additionally gated by
 *      `maskerWouldChange` (see that function above). When the on-disk content
 *      would still be changed by the CURRENT masker, the run falls through to the
 *      write path and re-renders (masked) instead of skipping — so a plain
 *      re-mirror heals the leak on its own; `force: true` is no longer the only
 *      escape hatch. The disambig-collision branch's `!force` guard now also
 *      matches the same-id and legacy-flat branches (it previously lacked one, so
 *      `force: true` was silently ignored on that one path).
 *      Revisit-Trigger: `maskerWouldChange` only detects needles present in the
 *      CURRENT process env — a needle since rotated out of the env is not seen as
 *      still-leaking and is healed only by an explicit `force: true` re-mirror.
 *      Widen this (e.g. persist a needle-shape fingerprint, or diff the whole
 *      rendered body) the first time a rotated-out secret is observed staying on
 *      disk after a plain re-run.
 *
 * FRONTMATTER AND BODY ARE TREATED IDENTICALLY. A credential is exactly as
 * published in `title:` as it is under `## Insight` — both live in the same
 * committed file — so there is no case for exempting the structured half. The
 * schema risk that exemption would otherwise be arguing for is removed by
 * reason 3 above rather than by leaving a field unmasked.
 *
 * Fail-soft by construction: with zero needles the entry is returned by
 * reference (byte-identical downstream), and `mask` itself passes non-strings
 * through — the masker must never be the reason a mirror run dies.
 *
 * @template T
 * @param {T} entry — a normalized learning/session record (plain JSON shape)
 * @returns {T} the same record with every string value masked
 */
function maskEntrySecrets(entry) {
  const { mask, needleCount } = ensureMasker();
  // Counted BEFORE the fast path: "records the choke-point saw" must not depend
  // on whether the env happened to carry a needle.
  _maskedRecords++;
  if (needleCount === 0) return entry;
  const walk = (value) => {
    if (typeof value === 'string') {
      const masked = mask(value);
      if (masked !== value) _maskHits++;
      return masked;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = walk(v);
      return out;
    }
    return value;
  };
  return walk(entry);
}

// ── Core processing ───────────────────────────────────────────────────────────

export async function processLearning(rawEntry, _lineNum, ctx) {
  const {
    vaultDir,
    dryRun,
    kind: _kind, // threaded to emitAction via ctx by emitEntryAction (#1147); kept for ctx symmetry
    force = false,
    qualityMinConfidence = 0.5,
    qualityMinNarrativeChars: _qualityMinNarrativeChars = 400, // unused for learnings; kept for ctx symmetry
  } = ctx;
  // #635: map producer alias fields (summary/detail, description/rationale,
  // title/body, name, narrative, content) onto the canonical v1 shape BEFORE
  // schema detection and slug/id derivation. Canonical entries pass through.
  // #974: the ONE masking site for learnings — before slug/filename derivation,
  // before the render, before any write. See maskEntrySecrets above.
  const entry = maskEntrySecrets(normalizeLearningEntry(rawEntry));
  const schema = detectLearningSchema(entry);
  const entryId = entry.id;

  // Slug source differs by schema. Both fall back to learning-<uuid8> on invalid.
  // For v2 the id is already a kebab slug (e.g. "s69-compose-pids-cross-validation").
  // Crucially: validate id presence before slug derivation, so missing-id entries
  // become skipped-invalid rather than crashing inside subjectToSlug.
  if (entryId === null || entryId === undefined) {
    throw new Error(`vault-mirror: learning entry missing required field 'id' (id=<no id>)`);
  }
  // #725 D1: the raw v1 subject is prose WITH SPACES, and subjectToSlug() strips
  // spaces WITHOUT hyphenating — so "Dead fallback removal when primary parser
  // matures" collapsed into a single run "deadfallbackremovalwhenprimaryparser…"
  // (a silent slug corruption that still passes isValidSlug). Pre-map the
  // subject's whitespace to hyphens BEFORE subjectToSlug, mirroring the id
  // derivation in normalizeLearningEntry (render-learnings.mjs L63-65) so a
  // learning's slug matches its derived id. This keeps the subject as the v1 slug
  // source (the established contract: entry.id is reserved for the disambiguation
  // /invalid-slug fallback prefix via uuidPrefix8 below), and only heals the
  // space-collapse defect. v2 ids are already kebab slugs.
  //
  // NOTE (#725 D1 divergence): the wave brief asked to make entry.id the PRIMARY
  // slug source. That is architecturally incompatible with the invalid-slug
  // fallback `learning-<uuidPrefix8(entry.id)>` (which requires entry.id to stay
  // a clean value SEPARATE from the slug source) and would invert the slug-from-
  // subject contract pinned by 15 tests in tests/unit/vault-mirror.test.mjs. The
  // pre-map is the mechanism the brief itself names and yields the IDENTICAL slug
  // for real data (kebab id derived from the same subject); see report.
  let slugSource;
  if (schema === 'v2') {
    slugSource = entry.id;
  } else if (typeof entry.subject === 'string') {
    slugSource = entry.subject.trim().replace(/\s+/g, '-');
  } else {
    slugSource = entry.subject;
  }
  let slug;
  if (typeof slugSource === 'string' && slugSource.length > 0) {
    slug = subjectToSlug(slugSource);
  } else {
    slug = '';
  }
  if (!isValidSlug(slug)) {
    slug = `learning-${uuidPrefix8(entryId)}`;
  }
  // #635: cap the slug so `<slug>.md` (plus a possible `-<uuid8>` disambig
  // suffix) stays under the 255-byte filename limit. Normalized prose subjects
  // can be arbitrarily long and previously aborted the whole mirror run with
  // ENAMETOOLONG. 240 + 9 (disambig) + 3 (.md) = 252 — and every pre-existing
  // vault note (max observed slug: 208 chars) keeps its identity untouched.
  if (slug.length > 240) {
    slug = slug.slice(0, 240).replace(/-+$/, '');
  }

  // Generator + date source differ by schema
  const generator = schema === 'v2' ? generateLearningNoteV2 : generateLearningNote;
  const dateSource = schema === 'v2' ? entry.first_seen : entry.created_at;

  // #704: Build a noteExists predicate from the vault's 50-sessions index so that
  // resolveSourceSessionLink can use EXISTENCE-based resolution instead of strict
  // format-validation. The index is built once per vaultDir (cached in
  // _sessionNoteSets). When the 50-sessions dir is absent/empty, the Set is empty
  // and we pass NO predicate — resolveSourceSessionLink falls back to format
  // validation (never worse than Wave 2 behaviour).
  const _knownSessions = getSessionNoteSet(vaultDir);
  const _noteExists = _knownSessions.size > 0 ? (s) => _knownSessions.has(s) : undefined;
  const generatorOpts = _noteExists ? { noteExists: _noteExists } : {};

  // Quality gate (PRD F1.2): skip learnings with confidence below threshold.
  // Runs BEFORE the --force branch so --force does NOT bypass the quality filter.
  // Missing/non-numeric confidence is treated as 1.0 (legacy entries pass).
  const learningConfidence = typeof entry.confidence === 'number' ? entry.confidence : 1.0;
  if (learningConfidence < qualityMinConfidence) {
    return emitEntryAction(_lineNum, ctx, {
      action: 'skipped-quality-low',
      path: null,
      id: entryId,
      meta: { reason: `confidence:${learningConfidence} < min:${qualityMinConfidence}` },
    });
  }

  // #660: namespace new writes under a per-repo subdirectory.
  const repoNs = resolveRepoNamespace({ vaultName: ctx?.vaultName ?? null });
  // #725 D2: thread the resolved repo namespace into the learning frontmatter as
  // `source-repo` for cross-repo attribution. repoNs is already sanitised +
  // leak-guarded by resolveRepoNamespace, so it is safe to interpolate as-is. The
  // renderer reads opts.repoNs (see render-learnings.mjs); when absent (older
  // callers), the source-repo line is omitted — backward-compatible.
  generatorOpts.repoNs = repoNs;
  const targetDir = join(resolve(vaultDir), '40-learnings', repoNs);
  if (!dryRun) mkdirSync(targetDir, { recursive: true });

  let targetPath = join(targetDir, `${slug}.md`);

  // #660 IDEMPOTENCY DUAL-PROBE: before treating the namespaced path as absent,
  // also check the legacy flat path. If a note with the same slug already exists
  // in the flat layout (pre-namespace migration), treat it as existing to avoid
  // duplicating the note. The deferred-migration decision means we only skip;
  // we do NOT move the flat note into the namespaced dir here.
  const legacyFlatPath = join(resolve(vaultDir), '40-learnings', `${slug}.md`);
  if (!existsSync(targetPath) && existsSync(legacyFlatPath)) {
    const legacyContent = readFileSync(legacyFlatPath, 'utf8');
    const legacyFm = parseFrontmatter(legacyContent);
    // Only skip if the flat note is ours (has our generator marker and matching id).
    if (legacyFm && legacyFm['_generator'] === GENERATOR_MARKER && legacyFm['id'] === slug) {
      const entryUpdated = toDate(dateSource);
      if (!force && legacyFm['updated'] && legacyFm['updated'] >= entryUpdated) {
        // Date has not advanced — but content may have changed (confidence, insight, etc.).
        // Render the candidate and compare canonical fields before deciding to skip.
        const candidateContent = generator(entry, slug, generatorOpts);
        if (learningContentMatches(legacyContent, candidateContent)) {
          // #1028 residue 1: the five-field compare cannot see a raw secret
          // sitting in a non-canonical field (e.g. `evidence`) — probe the
          // on-disk content against the CURRENT masker before trusting the
          // match. See maskerWouldChange above.
          const stillLeaks = maskerWouldChange(legacyContent);
          if (!stillLeaks) {
            return emitEntryAction(_lineNum, ctx, { action: 'skipped-noop', path: legacyFlatPath, id: slug });
          }
        }
        // Content differs, or the on-disk note still leaks under the current
        // env — fall through to write into the namespaced path.
      }
      // Updated date would advance or content changed — fall through to write into the namespaced path.
    }
  }

  if (existsSync(targetPath)) {
    const existingContent = readFileSync(targetPath, 'utf8');
    const fm = parseFrontmatter(existingContent);

    if (!fm || !fm['_generator']) {
      // Hand-written: skip
      process.stderr.write(`SKIP hand-written: ${targetPath}\n`);
      return emitEntryAction(_lineNum, ctx, { action: 'skipped-handwritten', path: targetPath, id: entryId });
    }

    if (fm['_generator'] !== GENERATOR_MARKER) {
      // Different generator — treat as hand-written to be safe
      process.stderr.write(`SKIP unknown generator: ${targetPath}\n`);
      return emitEntryAction(_lineNum, ctx, { action: 'skipped-handwritten', path: targetPath, id: entryId });
    }

    if (fm['id'] !== slug) {
      // Different id → collision: disambiguate
      const disambigSlug = `${slug}-${uuidPrefix8(entryId)}`;
      targetPath = join(targetDir, `${disambigSlug}.md`);
      slug = disambigSlug;

      if (existsSync(targetPath)) {
        // Still exists with disambig — check if it's ours
        const disambigContent = readFileSync(targetPath, 'utf8');
        const disambigFm = parseFrontmatter(disambigContent);
        if (!disambigFm || !disambigFm['_generator']) {
          process.stderr.write(`SKIP hand-written (disambig): ${targetPath}\n`);
          return emitEntryAction(_lineNum, ctx, { action: 'skipped-handwritten', path: targetPath, id: entryId });
        }
        // Check updated advancement; if date has not advanced, also diff content.
        // #1028 residue 1: this guard previously lacked the `!force &&` that the
        // legacy-flat and same-id branches carry, so `force: true` was silently
        // ignored on this one path — byte-identical guard shape to those two now.
        const entryUpdated = toDate(dateSource);
        if (!force && disambigFm['updated'] && disambigFm['updated'] >= entryUpdated) {
          const candidateContent = generator(entry, slug, generatorOpts);
          if (learningContentMatches(disambigContent, candidateContent)) {
            // #1028 residue 1: probe the on-disk content against the CURRENT
            // masker before trusting the five-field match — see maskerWouldChange.
            const stillLeaks = maskerWouldChange(disambigContent);
            if (!stillLeaks) {
              return emitEntryAction(_lineNum, ctx, { action: 'skipped-noop', path: targetPath, id: disambigSlug });
            }
          }
          // Content differs, or the on-disk note still leaks under the current
          // env — fall through to write.
        }
      }

      const content = generator(entry, slug, generatorOpts);
      if (!dryRun) writeFileSync(targetPath, content, 'utf8');
      return emitEntryAction(_lineNum, ctx, { action: 'skipped-collision-resolved', path: targetPath, id: slug });
    }

    // Same id: check if updated would advance (unless --force overrides).
    // Even when the date has not advanced, content may have changed (confidence,
    // insight, expires_at, etc.) — compare canonical fields before skipping.
    const entryUpdated = toDate(dateSource);
    if (!force && fm['updated'] && fm['updated'] >= entryUpdated) {
      const candidateContent = generator(entry, slug, generatorOpts);
      if (learningContentMatches(existingContent, candidateContent)) {
        // #1028 residue 1: probe the on-disk content against the CURRENT masker
        // before trusting the five-field match — see maskerWouldChange above.
        const stillLeaks = maskerWouldChange(existingContent);
        if (!stillLeaks) {
          return emitEntryAction(_lineNum, ctx, { action: 'skipped-noop', path: targetPath, id: slug });
        }
      }
      // Content differs, or the on-disk note still leaks under the current env —
      // fall through to overwrite (same path as date-advance branch).
    }

    // Overwrite with advanced updated date (or forced re-render)
    const content = generator(entry, slug, generatorOpts);
    if (!dryRun) writeFileSync(targetPath, content, 'utf8');
    return emitEntryAction(_lineNum, ctx, { action: 'updated', path: targetPath, id: slug });
  }

  // File does not exist — create
  const content = generator(entry, slug, generatorOpts);
  if (!dryRun) writeFileSync(targetPath, content, 'utf8');
  return emitEntryAction(_lineNum, ctx, { action: 'created', path: targetPath, id: slug });
}

export async function processSession(rawEntry, _lineNum, ctx) {
  const {
    vaultDir,
    dryRun,
    kind: _kind, // threaded to emitAction via ctx by emitEntryAction (#1147); kept for ctx symmetry
    force = false,
    qualityMinNarrativeChars = 400,
    qualityMinConfidence: _qualityMinConfidence = 0.5, // unused for sessions; kept for ctx symmetry
  } = ctx;
  // #635: map producer alias fields (ended_at, mode, total_waves/waves_completed
  // without a `waves` field) onto the canonical shapes BEFORE schema detection.
  // Canonical v1/v2/v3 entries pass through untouched.
  // #974: the ONE masking site for sessions — same contract as processLearning.
  const entry = maskEntrySecrets(normalizeSessionEntry(rawEntry));
  const { session_id: rawSessionId } = entry;
  const schema = detectSessionSchema(entry);
  const generator =
    schema === 'v3' ? generateSessionNoteV3 : schema === 'v2' ? generateSessionNoteV2 : generateSessionNote;

  // Validate session_id as a filesystem-safe slug; fall back via subjectToSlug
  // (which collapses slashes to last segment + strips invalid chars) before
  // resorting to a uuid-derived slug. Without subjectToSlug, raw slashes in
  // rawSessionId (e.g. "feat/opus-4-7-...") would survive uuidPrefix8 and
  // produce a path with directory separators in the basename.
  let session_id;
  if (isValidSlug(rawSessionId)) {
    session_id = rawSessionId;
  } else if (typeof rawSessionId === 'string' && rawSessionId.length > 0) {
    const sanitised = subjectToSlug(rawSessionId);
    session_id = isValidSlug(sanitised) ? sanitised : `session-${uuidPrefix8(rawSessionId)}`;
  } else {
    session_id = `session-${uuidPrefix8(randomUUID())}`;
  }
  // #635: symmetric slug-length cap (see processLearning) — a pathologically
  // long but otherwise valid session_id slug would abort the mirror run with
  // ENAMETOOLONG when the filename exceeds the 255-byte limit.
  if (session_id.length > 240) {
    session_id = session_id.slice(0, 240).replace(/-+$/, '');
  }

  // #909 ABANDONED FILTER: a phantom stub backfilled from events.jsonl for a
  // session that never ran /close is legitimate DATA in the ledger but not
  // legitimate SIGNAL in a knowledge store — it records that a start happened,
  // with 0 waves, 0 agents and synthesized fields. Mirroring it would add a note
  // whose every number is a placeholder.
  //
  // The predicate is `isRealSession` from scripts/lib/session-schema/filters.mjs
  // (fail-open: only an explicit `status: 'abandoned'` is filtered; the absent-
  // status pre-#724 majority passes through). Reused rather than re-implemented
  // so the ledger's definition of "real" lives in exactly one place.
  //
  // Placed BEFORE repoNs resolution and BEFORE the quality-gate render: skipping
  // early avoids a git subprocess and a wasted render for a record we discard.
  // This is deliberately REDUNDANT with the renderer's status mapping (#909,
  // render-sessions.mjs) — see that module's header. The filter removes one
  // status from the vault; the mapping keeps every OTHER status honest, and
  // guards the generators' other entry point (the render.mjs barrel).
  if (!isRealSession(entry)) {
    return emitEntryAction(_lineNum, ctx, {
      action: 'skipped-abandoned',
      path: null,
      id: session_id,
      meta: { reason: `status:${entry?.status}` },
    });
  }

  // #732: resolve the leak-guarded repo namespace ONCE per session, BEFORE the
  // quality gate, so both the write path (targetDir, below) AND the rendered
  // frontmatter (`source-repo`) use the SAME sanitised / pseudonym-mapped value.
  // Previously the frontmatter carried the RAW deriveRepo() output via a `repo:`
  // field while only the write path routed through resolveRepoNamespace() — an
  // owner-leaky repo's real name reached the vault through the session-note
  // frontmatter even though the directory AND the learning `source-repo` field
  // were already pseudonym-mapped/redacted (#732 leak-guard bypass).
  const repoNs = resolveRepoNamespace({ vaultName: ctx?.vaultName ?? null });

  // Quality gate (PRD F1.2): skip sessions whose rendered narrative is too short.
  // Measure on the rendered markdown body so the check is schema-agnostic across
  // v1 and v2 producers. The render is cheap and idempotent; we reuse the result
  // below instead of calling generator() a second time.
  // Runs BEFORE the --force branch so --force does NOT bypass the quality filter.
  // If the generator throws a `vault-mirror: …` validation error (missing
  // required field), it propagates up to vault-mirror.mjs which classifies it
  // as `skipped-invalid` rather than `skipped-quality-low` — semantically more
  // accurate for the metrics summary in session-end Phase 3.7.
  const renderedBody = generator(entry, { repoNs });
  // Strip YAML frontmatter (lines between the first two `---` markers) so we
  // measure only narrative content, not boilerplate.
  const narrativeBody = renderedBody.replace(/^---[\s\S]*?---/m, '').trim();
  const narrativeChars = narrativeBody.length;
  if (narrativeChars < qualityMinNarrativeChars) {
    return emitEntryAction(_lineNum, ctx, {
      action: 'skipped-quality-low',
      path: null,
      id: session_id,
      meta: { reason: `narrative:${narrativeChars} < min:${qualityMinNarrativeChars}` },
    });
  }

  // #660: namespace new writes under a per-repo subdirectory. repoNs was
  // resolved above (before the quality gate) so it is reused here unchanged —
  // the write path and the rendered `source-repo` frontmatter share one value.
  const targetDir = join(resolve(vaultDir), '50-sessions', repoNs);
  if (!dryRun) mkdirSync(targetDir, { recursive: true });

  // Canonical filename pattern (issue #343): `<session_id>.md` where session_id
  // follows `<branch>-<YYYY-MM-DD>-<HHmm>-<slug>` per the session-id schema.
  // session_id has been validated/sanitised above (isValidSlug → subjectToSlug
  // → uuid fallback). Historical filename inconsistencies in 50-sessions/ are
  // pre-existing on-disk artefacts and are NOT retroactively renamed here.
  const targetPath = join(targetDir, `${session_id}.md`);

  // #660 IDEMPOTENCY DUAL-PROBE: check the legacy flat path before treating
  // the namespaced path as absent. If a session note already exists flat
  // (pre-namespace migration), skip creating a duplicate.
  const legacyFlatPath = join(resolve(vaultDir), '50-sessions', `${session_id}.md`);
  if (!existsSync(targetPath) && existsSync(legacyFlatPath)) {
    const legacyContent = readFileSync(legacyFlatPath, 'utf8');
    const legacyFm = parseFrontmatter(legacyContent);
    if (legacyFm && legacyFm['_generator'] === GENERATOR_MARKER && legacyFm['id'] === session_id) {
      const entryUpdated = toDate(entry.completed_at);
      if (!force && legacyFm['updated'] && legacyFm['updated'] >= entryUpdated) {
        return emitEntryAction(_lineNum, ctx, { action: 'skipped-noop', path: legacyFlatPath, id: session_id });
      }
      // Updated date would advance — fall through to write into the namespaced path.
    }
  }

  if (existsSync(targetPath)) {
    const existingContent = readFileSync(targetPath, 'utf8');
    const fm = parseFrontmatter(existingContent);

    if (!fm || !fm['_generator']) {
      // Hand-written: skip
      process.stderr.write(`SKIP hand-written: ${targetPath}\n`);
      return emitEntryAction(_lineNum, ctx, { action: 'skipped-handwritten', path: targetPath, id: session_id });
    }

    if (fm['_generator'] !== GENERATOR_MARKER) {
      process.stderr.write(`SKIP unknown generator: ${targetPath}\n`);
      return emitEntryAction(_lineNum, ctx, { action: 'skipped-handwritten', path: targetPath, id: session_id });
    }

    // Same generator: check id and updated
    if (fm['id'] === session_id) {
      const entryUpdated = toDate(entry.completed_at);
      if (!force && fm['updated'] && fm['updated'] >= entryUpdated) {
        return emitEntryAction(_lineNum, ctx, { action: 'skipped-noop', path: targetPath, id: session_id });
      }
      if (!dryRun) writeFileSync(targetPath, renderedBody, 'utf8');
      return emitEntryAction(_lineNum, ctx, { action: 'updated', path: targetPath, id: session_id });
    }
  }

  // File does not exist — create. Reuse the rendered body computed during the
  // quality-gate check (avoids a second generator invocation).
  if (!dryRun) writeFileSync(targetPath, renderedBody, 'utf8');
  return emitEntryAction(_lineNum, ctx, { action: 'created', path: targetPath, id: session_id });
}
