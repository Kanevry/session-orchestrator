/**
 * reconcile/rule-expiry-sweep.mjs — the missing REMOVAL half of the
 * generated-rule TTL (issue #1377).
 *
 * `scripts/lib/rule-loader.mjs` filters an expired machine-generated rule out
 * of injection at READ time. Nothing ever removed one from disk, so an expired
 * consolidated file stays tracked, keeps costing bytes against the
 * `generated-byte-ceiling`, and keeps reading as live corpus to every human and
 * every grep — while the loader silently stops shipping it. This module is the
 * mechanical sweep that closes the gap.
 *
 * ## Why removing PROSE is not the same as removing a PAIR
 *
 * `/reconcile` dedupes exclusively on the `## Provenance` bullets —
 * `defaultReadMaterializedProvenance` in `./engine.mjs` scans
 * `.claude/rules/*.md` for `learning-key:` / `learning-id:` markers and treats
 * any match as "already materialized" (#484, #1242). Two consequences fix the
 * design of this file:
 *
 *   - Removing an entry's PROSE is invisible to dedupe. Safe.
 *   - Removing its PAIR (or the whole FILE) makes `/reconcile` re-propose the
 *     learning on the next run. Expensive, and silently so.
 *
 * Therefore: **a pair is NEVER deleted while its file survives.** Sweeping an
 * expired entry deletes its prose block and converts the pair to the
 * `markers only` shape already present in the corpus — a same-line HTML
 * comment appended to the `- learning-id:` bullet. The backticked id stays
 * regex-visible to the dedupe scan, which is the whole point.
 *
 * ## Fail-open, twice
 *
 * Entries carry NO date of their own. A per-entry date is recoverable only via
 * the pair's `learning-id` → `.orchestrator/metrics/learnings.jsonl`
 * `expires_at`. Measured 2026-09-17 @ 9e8146b4: 87 of 92 unique ids in the
 * corpus resolve, 5 do not. So:
 *
 *   1. **Unresolvable id → the entry is KEPT** and counted in
 *      `unresolvedPairIds`. A sweep that guessed would delete prose on no
 *      evidence, and a file with any unresolved pair is never deleted.
 *   2. **Ambiguous file → `action: 'keep'` + a `skipped` record.** The
 *      entry↔pair mapping is POSITIONAL: the k-th `### ` heading belongs to the
 *      k-th non-`markers only` pair. That 1:1 mapping holds in only 3 of the 7
 *      live files (measured 2026-09-17: measurement-discipline 12/12,
 *      process-contracts 6/6, toolchain-and-build 10/10; guard-design 8≠11,
 *      identity-and-locks 9≠10, test-hygiene 7≠8,
 *      review-and-adapter-contracts 9≠12 — several learnings were merged into
 *      one prose entry there). Where it does not hold, this module reports
 *      `no-1to1-mapping` and touches nothing. It never guesses which paragraph
 *      belongs to which learning.
 *
 * ## Header recompute happens ONLY on a file this sweep rewrites
 *
 * A consolidated file's frontmatter `expires-at` plus the body sentence
 * ``**`expires-at` <D> = the EARLIEST of the <N> absorbed dates**`` must not
 * outlive its shortest-lived content. Both are recomputed — but only for a file
 * the sweep actually rewrites. A file with nothing expired is left
 * BYTE-IDENTICAL, deliberately, because a recompute-on-every-run would silently
 * shorten a healthy file's TTL on the very first live invocation. The
 * discrepancy is REPORTED instead, as the per-plan `advisory` field — see
 * {@link headerAdvisory}, which is computed BEFORE the `no-1to1-mapping` skip
 * so a skipped file still gets one.
 *
 * Measured 2026-09-17 (`node scripts/sweep-expired-rules.mjs --json`, 7 files
 * scanned, 0 expired): **6 of the 7 carry a discrepancy** — `identity-and-locks`
 * 2026-10-01 vs 2026-10-02, `measurement-discipline` 2026-10-04 vs 2026-10-02,
 * `process-contracts` 2026-10-04 vs 2026-10-27, `review-and-adapter-contracts`
 * 2026-10-04 vs 2026-10-02, `test-hygiene` 2026-10-20 vs 2026-10-07,
 * `toolchain-and-build` 2026-10-01 vs 2026-10-16; only `guard-design` agrees
 * with its content. Three of the six are the harmful direction — a header
 * OUTLIVING its content: `measurement-discipline`, `review-and-adapter-contracts`
 * and `test-hygiene`. The other three expire EARLIER than they need to, which
 * costs injection but loses nothing.
 *
 * Before the advisory moved above the skip branch it reached only the 3
 * 1:1-mappable files, which structurally excluded the four merged-prose files —
 * `test-hygiene` among them, i.e. the instrument could not report the very
 * defect its docblock named.
 *
 * Two populations, stated because they are not the same:
 *   - `newExpiresAt` (D) = the earliest `expires_at` over remaining resolvable
 *     pairs that are NOT expired as of `now`. Excluding the expired ones is
 *     what stops a rewritten file from being instantly expired again by a pair
 *     whose prose was just swept.
 *   - `newAbsorbedCount` (N) = the number of pairs REMAINING IN THE FILE.
 *     Measured 2026-09-17: all 7 live sentences carry the TOTAL pair count
 *     (15/9/13/17/16/10/12), markers-only pairs included — an absorbed date
 *     stays absorbed after its prose is gone. Since this module never removes a
 *     pair from a surviving file, N is stable across a rewrite by construction;
 *     it is re-emitted from the parse rather than copied so it cannot drift if
 *     the pair population ever does change.
 *
 * ## Deleting a whole file
 *
 * A file is deleted only when it has ZERO kept and ZERO unresolved pairs — i.e.
 * every substantive entry expired. Because the delete DOES remove provenance
 * pairs, every pair's `learning_key` is stamped via `markCandidateProcessed`
 * BEFORE the unlink (`docs/rule-authoring.md` § Consolidated rules). Stamping
 * after the delete would leave a window in which `/reconcile` sees neither the
 * file nor a terminal candidate record and re-proposes the whole file's worth
 * of learnings.
 *
 * Dry-run is the default and writes NOTHING. {@link applyRuleExpirySweep} is
 * the only write path.
 *
 * @module scripts/lib/reconcile/rule-expiry-sweep
 */

import { lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { atomicWriteWithBackup } from '../io.mjs';
import { readLearnings } from '../learnings/io.mjs';
import { listMachineGeneratedRules } from '../instruction-budget-guard.mjs';
import { markCandidateProcessed } from './idempotency.mjs';

/** Repo-relative learnings store — the only source of a per-entry date. */
export const DEFAULT_LEARNINGS_PATH = '.orchestrator/metrics/learnings.jsonl';

/** Event emitted on `--apply` only, AFTER the writes succeeded. */
export const RULE_EXPIRY_SWEEP_EVENT = 'orchestrator.rules.expiry_sweep_applied';

/**
 * `outcome` written on the candidate records stamped before a file delete.
 *
 * A new member of an ADDITIVE field: the ReconcileCandidate typedef documents
 * that nothing branches on `outcome` (terminality is `processed_at` alone), so
 * an unknown value round-trips unchanged. It is distinct from `'written'` on
 * purpose — the file WAS written once and is now gone, and a census over the
 * store must be able to tell "materialized" from "materialized then swept".
 */
export const SWEPT_OUTCOME = 'expired-swept';

const MS_PER_DAY = 86_400_000;

const PAIR_KEY_RE = /^- learning-key:\s*`([^`]+)`/;
const PAIR_ID_RE = /^- learning-id:\s*`([^`]+)`(.*)$/;
const COUNTER_RE = /^\*\*`expires-at` (\S+) = the EARLIEST of the (\d+) absorbed dates\*\*/;
const HEADING_PREFIX = '### ';
const PROVENANCE_HEADING = '## Provenance';
const UNTRUSTED_END = '<!-- untrusted-content:end -->';

/**
 * Parse a consolidated machine-generated rule file into its editable parts.
 *
 * PURE — takes and returns data, touches no disk. Line-based on purpose: the
 * rewrite is a line splice, and a round-trip through a Markdown AST would
 * reformat parts of the file this sweep has no business touching.
 *
 * @param {string} content raw file contents
 * @returns {{
 *   lines: string[],
 *   expiresAtLine: number,
 *   expiresAt: string|null,
 *   counterLine: number,
 *   counterDate: string|null,
 *   counterCount: number|null,
 *   entries: Array<{heading: string, start: number, end: number}>,
 *   provenanceLine: number,
 *   pairs: Array<{key: string, id: string, keyLine: number, idLine: number, markersOnly: boolean}>
 * }} `expiresAtLine` / `counterLine` / `provenanceLine` are `-1` when absent.
 */
export function parseConsolidatedRule(content) {
  const lines = String(content ?? '').split('\n');

  let expiresAtLine = -1;
  let expiresAt = null;
  let counterLine = -1;
  let counterDate = null;
  let counterCount = null;
  let provenanceLine = -1;
  let untrustedEndLine = -1;

  // Frontmatter is the FIRST `---`-delimited block only; an `expires-at:` in
  // the body (a learning quoting one) must never be mistaken for the header.
  let frontmatterEnd = -1;
  if (lines[0] === '---') {
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i] === '---') {
        frontmatterEnd = i;
        break;
      }
    }
  }
  for (let i = 1; i < frontmatterEnd; i += 1) {
    const m = /^expires-at:\s*(\S+)\s*$/.exec(lines[i]);
    if (m) {
      expiresAtLine = i;
      expiresAt = m[1];
      break;
    }
  }

  const bodyStart = frontmatterEnd >= 0 ? frontmatterEnd + 1 : 0;
  for (let i = bodyStart; i < lines.length; i += 1) {
    if (counterLine === -1) {
      const m = COUNTER_RE.exec(lines[i]);
      if (m) {
        counterLine = i;
        counterDate = m[1];
        counterCount = Number(m[2]);
        continue;
      }
    }
    if (untrustedEndLine === -1 && lines[i].startsWith(UNTRUSTED_END)) untrustedEndLine = i;
    if (provenanceLine === -1 && lines[i] === PROVENANCE_HEADING) provenanceLine = i;
  }

  // Prose entries live between the frontmatter and the provenance block. The
  // hard stop is whichever comes first of the untrusted-content sentinel and
  // the `## Provenance` heading, so a `### ` heading inside the provenance
  // block (none today, but nothing forbids one) can never be read as an entry.
  const proseEnd = Math.min(
    ...[untrustedEndLine, provenanceLine, lines.length].filter((n) => n >= 0),
  );
  /** @type {Array<{heading: string, start: number, end: number}>} */
  const entries = [];
  for (let i = bodyStart; i < proseEnd; i += 1) {
    if (!lines[i].startsWith(HEADING_PREFIX)) continue;
    if (entries.length > 0) entries[entries.length - 1].end = i;
    entries.push({ heading: lines[i].slice(HEADING_PREFIX.length).trim(), start: i, end: proseEnd });
  }

  /** @type {Array<{key: string, id: string, keyLine: number, idLine: number, markersOnly: boolean}>} */
  const pairs = [];
  /** @type {{key: string, keyLine: number}|null} */
  let pendingKey = null;
  const pairScanStart = provenanceLine >= 0 ? provenanceLine + 1 : lines.length;
  for (let i = pairScanStart; i < lines.length; i += 1) {
    const keyMatch = PAIR_KEY_RE.exec(lines[i]);
    if (keyMatch) {
      pendingKey = { key: keyMatch[1].trim(), keyLine: i };
      continue;
    }
    const idMatch = PAIR_ID_RE.exec(lines[i]);
    if (!idMatch || !pendingKey) continue;
    pairs.push({
      key: pendingKey.key,
      id: idMatch[1].trim(),
      keyLine: pendingKey.keyLine,
      idLine: i,
      markersOnly: /markers only/.test(idMatch[2]),
    });
    pendingKey = null;
  }

  return {
    lines,
    expiresAtLine,
    expiresAt,
    counterLine,
    counterDate,
    counterCount,
    entries,
    provenanceLine,
    pairs,
  };
}

/**
 * Read `learnings.jsonl` into `id -> expires_at`, counting malformed lines.
 *
 * Malformed lines are COUNTED, never silently dropped: a leniently-skipping
 * JSONL parser turns a partial read into a clean verdict, and this sweep
 * DELETES prose on the strength of that verdict.
 *
 * @param {string} absPath
 * @returns {Promise<{expiryById: Map<string, string>, malformedLines: number}>}
 */
async function loadExpiryIndex(absPath) {
  const expiryById = new Map();
  const { entries, malformed } = await readLearnings(absPath);
  for (const entry of entries) {
    const id = entry?.id;
    const expiresAt = entry?.expires_at;
    if (typeof id === 'string' && id.length > 0 && typeof expiresAt === 'string') {
      expiryById.set(id, expiresAt);
    }
  }
  return { expiryById, malformedLines: malformed.length };
}

/** `now` as epoch-ms, accepting a Date, a number, an ISO string, or nothing. */
function toEpochMs(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number' && Number.isFinite(now)) return now;
  if (typeof now === 'string' && Number.isFinite(Date.parse(now))) return Date.parse(now);
  return Date.now();
}

/** ISO date part (`YYYY-MM-DD`) of an `expires_at` value, for the header. */
function dateOnly(iso) {
  return String(iso).slice(0, 10);
}

/**
 * The header-vs-content discrepancy, as a one-line advisory string.
 *
 * Population: EVERY provenance pair on the file whose `learning-id` resolves to
 * a parseable `expires_at`, markers-only pairs included — an absorbed date
 * stays absorbed after its prose is gone, which is exactly what the body
 * sentence's `N` counts. Unresolvable ids contribute nothing (they are reported
 * separately as `unresolvedPairIds`), so a file whose ids all fail to resolve
 * gets no advisory rather than a guessed one.
 *
 * Deliberately NOT the `newExpiresAt` population: that one excludes expired
 * pairs so a rewritten file is not instantly expired again. This is a
 * diagnostic about the file AS COMMITTED, so it excludes nothing.
 *
 * @param {ReturnType<typeof parseConsolidatedRule>} parsed
 * @param {Map<string, string>} expiryById
 * @returns {string|undefined} undefined when there is nothing to report
 */
function headerAdvisory(parsed, expiryById) {
  if (!parsed.expiresAt) return undefined;
  const dates = parsed.pairs
    .map((p) => expiryById.get(p.id))
    .filter((v) => typeof v === 'string' && Number.isFinite(Date.parse(v)))
    .sort();
  if (dates.length === 0) return undefined;
  const earliest = dateOnly(dates[0]);
  if (earliest === parsed.expiresAt) return undefined;
  return `header expires-at ${parsed.expiresAt} != earliest resolvable absorbed date ${earliest}`;
}

/**
 * Plan the sweep over every machine-generated rule file. Reads only.
 *
 * @param {object} [opts]
 * @param {string} opts.repoRoot           absolute repo root (required —
 *   no `process.cwd()` fallback, so a caller cannot accidentally sweep the
 *   operator's live checkout by omitting it)
 * @param {Date|number|string} [opts.now]  injected clock
 * @param {number} [opts.graceDays=0]      days past expiry before an entry is
 *   swept. Default 0: unlike the learnings sweep, nothing re-stamps a rule
 *   file's `expires-at`, so there is no re-stamp window to protect.
 * @param {string} [opts.learningsPath]    override the learnings store
 * @returns {Promise<{plans: Array<object>, skipped: Array<{file: string, reason: string}>, malformedLines: number, ok: boolean}>}
 */
export async function planRuleExpirySweep(opts = {}) {
  const { repoRoot, now, graceDays = 0, learningsPath } = opts;
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new TypeError('planRuleExpirySweep: repoRoot is required');
  }
  if (!Number.isFinite(graceDays) || graceDays < 0) {
    throw new TypeError(`planRuleExpirySweep: graceDays must be a non-negative number, got ${graceDays}`);
  }

  const nowMs = toEpochMs(now);
  const cutoffMs = nowMs - graceDays * MS_PER_DAY;
  const { expiryById, malformedLines } = await loadExpiryIndex(
    join(repoRoot, learningsPath ?? DEFAULT_LEARNINGS_PATH),
  );

  const listed = listMachineGeneratedRules({ repoRoot });
  const rulesDir = join(repoRoot, '.claude', 'rules');
  /** @type {Array<object>} */
  const plans = [];
  /** @type {Array<{file: string, reason: string}>} */
  const skipped = [];

  for (const rule of listed.rules) {
    const abs = join(rulesDir, rule.file);
    let content;
    try {
      content = readFileSync(abs, 'utf8');
    } catch {
      skipped.push({ file: rule.file, reason: 'unreadable' });
      continue;
    }

    const parsed = parseConsolidatedRule(content);
    const substantive = parsed.pairs.filter((p) => !p.markersOnly);

    if (parsed.provenanceLine === -1 || parsed.pairs.length === 0) {
      // Not a consolidated file (or no provenance block at all): this sweep has
      // no way to date its content, so it is out of its own remit.
      skipped.push({ file: rule.file, reason: 'no-provenance-block' });
      continue;
    }

    // The header advisory is computed HERE — over every RESOLVABLE pair on the
    // file, before any early `continue`. It has to be: the discrepancy it
    // reports needs no entry↔pair mapping (it compares the frontmatter date
    // against dates read out of `learnings.jsonl` by id), and while it sat
    // below the `no-1to1-mapping` skip the four merged-prose files — the ones
    // most likely to carry a stale header, `test-hygiene.md` among them — could
    // never receive one. Measured 2026-09-17: the advisory reached 3 of 7 files
    // where 6 of 7 have the discrepancy.
    const advisory = headerAdvisory(parsed, expiryById);

    if (parsed.entries.length !== substantive.length) {
      // FAIL-OPEN (decision 3): report, never guess. A skipped file still
      // carries its advisory — reporting is all this branch can do.
      skipped.push({ file: rule.file, reason: 'no-1to1-mapping' });
      plans.push({
        file: rule.file,
        action: 'keep',
        expiredPairIds: [],
        keptPairIds: substantive.map((p) => p.id),
        unresolvedPairIds: substantive.filter((p) => !expiryById.has(p.id)).map((p) => p.id),
        newExpiresAt: null,
        newAbsorbedCount: parsed.pairs.length,
        bytesBefore: Buffer.byteLength(content, 'utf8'),
        bytesAfter: Buffer.byteLength(content, 'utf8'),
        headings: parsed.entries.length,
        substantivePairs: substantive.length,
        ...(advisory ? { advisory } : {}),
      });
      continue;
    }

    /** @type {Array<{pair: object, entry: object}>} */
    const expired = [];
    const kept = [];
    const unresolved = [];
    substantive.forEach((pair, idx) => {
      const entry = parsed.entries[idx];
      const raw = expiryById.get(pair.id);
      const at = raw !== undefined ? Date.parse(raw) : Number.NaN;
      if (!Number.isFinite(at)) {
        unresolved.push({ pair, entry }); // FAIL-OPEN (decision 2)
      } else if (at < cutoffMs) {
        expired.push({ pair, entry, expiresAt: raw });
      } else {
        kept.push({ pair, entry, expiresAt: raw });
      }
    });

    // D: earliest date over pairs that remain AND are not expired. Markers-only
    // pairs are excluded here even though they count toward N — an already-swept
    // pair's elapsed date would re-expire the file the moment it was rewritten.
    const remainingDates = kept.map((k) => k.expiresAt).filter(Boolean).sort();
    const earliest = remainingDates.length > 0 ? dateOnly(remainingDates[0]) : null;

    const base = {
      file: rule.file,
      expiredPairIds: expired.map((e) => e.pair.id),
      keptPairIds: kept.map((k) => k.pair.id),
      unresolvedPairIds: unresolved.map((u) => u.pair.id),
      bytesBefore: Buffer.byteLength(content, 'utf8'),
      headings: parsed.entries.length,
      substantivePairs: substantive.length,
    };

    if (expired.length === 0) {
      // Byte-identical. The header/earliest discrepancy is REPORTED, never
      // silently repaired — see the module header.
      plans.push({
        ...base,
        action: 'keep',
        newExpiresAt: null,
        newAbsorbedCount: parsed.pairs.length,
        bytesAfter: base.bytesBefore,
        ...(advisory ? { advisory } : {}),
      });
      continue;
    }

    if (kept.length === 0 && unresolved.length === 0) {
      plans.push({
        ...base,
        action: 'delete',
        newExpiresAt: null,
        newAbsorbedCount: 0,
        bytesAfter: 0,
        // EVERY pair on the file, not only the substantive ones — the delete
        // removes markers-only pairs too, and each is a dedupe marker.
        stampKeys: parsed.pairs.map((p) => p.key),
      });
      continue;
    }

    const nextContent = rewriteContent({ parsed, expired, earliest, nowMs });
    plans.push({
      ...base,
      action: 'rewrite',
      newExpiresAt: earliest,
      newAbsorbedCount: parsed.pairs.length,
      bytesAfter: Buffer.byteLength(nextContent, 'utf8'),
      nextContent,
    });
  }

  return { plans, skipped, malformedLines, ok: listed.ok };
}

/**
 * Build the rewritten file contents: expired prose removed, expired pairs
 * converted to `markers only`, header + counter sentence recomputed.
 *
 * @param {{parsed: object, expired: Array<object>, earliest: string|null, nowMs: number}} args
 * @returns {string}
 */
function rewriteContent({ parsed, expired, earliest, nowMs }) {
  const lines = [...parsed.lines];
  const sweptOn = new Date(nowMs).toISOString().slice(0, 10);

  // Annotate the pairs FIRST (line indices are still the parsed ones), then
  // splice prose out back-to-front so earlier indices stay valid.
  for (const { pair, expiresAt } of expired) {
    lines[pair.idLine] =
      `${lines[pair.idLine]}  <!-- markers only (substance: expired ${dateOnly(expiresAt)}, prose swept ${sweptOn}) -->`;
  }

  if (earliest !== null) {
    if (parsed.expiresAtLine >= 0) lines[parsed.expiresAtLine] = `expires-at: ${earliest}`;
    if (parsed.counterLine >= 0) {
      lines[parsed.counterLine] = lines[parsed.counterLine].replace(
        COUNTER_RE,
        `**\`expires-at\` ${earliest} = the EARLIEST of the ${parsed.pairs.length} absorbed dates**`,
      );
    }
  }

  const blocks = expired.map((e) => e.entry).sort((a, b) => b.start - a.start);
  for (const entry of blocks) lines.splice(entry.start, entry.end - entry.start);

  return lines.join('\n');
}

/**
 * Refuse to write to (or unlink) anything that is not a regular file sitting
 * directly under the rules directory. Throws; the caller turns that into a
 * per-file `errors[]` entry and moves on to the next plan.
 *
 * Two independent checks, because they fail differently:
 *
 *  1. **`lstatSync` symlink check.** `writeFileSync` FOLLOWS a symlink and
 *     rewrites its TARGET, leaving the link intact — so a symlink tracked at
 *     `.claude/rules/<n>.md` pointing anywhere on the host turns this sweep
 *     into an arbitrary-file writer whose victim's `sha` changes with nothing
 *     in the rules directory to show for it. The atomic writer above is not a
 *     fix for that: `renameSync` would replace the LINK, silently discarding an
 *     operator's deliberate indirection. Same precedent as
 *     `.claude/rules/guard-design.md` § "a security fix that follows an
 *     unreviewed security fix" (*"`writeFileSync` followed symlinks"*).
 *  2. **Path confinement.** `p.file` arrives from
 *     `listMachineGeneratedRules()` today, but this function is exported and a
 *     hand-built plan carrying `../../victim.md` would `join()` cleanly out of
 *     the directory. `resolve()`-then-prefix is the check that survives a
 *     future second caller.
 *
 * @param {string} abs       joined absolute path
 * @param {string} rulesDir  the `.claude/rules` directory
 * @param {string} file      plan-relative name, for the message
 * @returns {void}
 */
function assertSweepable(abs, rulesDir, file) {
  const confined = `${resolve(rulesDir)}${sep}`;
  const resolved = resolve(abs);
  if (!resolved.startsWith(confined)) {
    throw new Error(`refusing to touch ${file}: resolves outside ${rulesDir}`);
  }
  let stat;
  try {
    stat = lstatSync(abs);
  } catch (err) {
    throw new Error(`refusing to touch ${file}: ${err?.message ?? String(err)}`, { cause: err });
  }
  if (stat.isSymbolicLink()) {
    throw new Error(
      `refusing to touch ${file}: it is a symlink — a write would follow it to its target`,
    );
  }
  if (!stat.isFile()) {
    throw new Error(`refusing to touch ${file}: not a regular file`);
  }
}

/**
 * Execute a plan. THE ONLY WRITE PATH.
 *
 * Ordering is load-bearing for `action: 'delete'`: every provenance pair is
 * stamped terminal via `markCandidateProcessed` BEFORE the unlink. A crash
 * between the two leaves a stamped candidate and a live file (harmless — the
 * file still dedupes) rather than an unstamped learning with no file, which
 * `/reconcile` would re-propose.
 *
 * Every rewrite and every delete passes {@link assertSweepable} first (regular
 * file, inside the rules directory, not a symlink), and every rewrite goes
 * through `atomicWriteWithBackup` rather than `writeFileSync`. A refusal is a
 * per-file `errors[]` entry and never aborts the remaining plans — but it DOES
 * make the CLI exit 2, so a refused write cannot pass as a clean sweep.
 *
 * @param {{plans: Array<object>}} plan the {@link planRuleExpirySweep} result
 * @param {{repoRoot: string, now?: Date|number|string}} ctx
 * @returns {{rewritten: string[], deleted: string[], stamped: number, errors: Array<{file: string, error: string}>}}
 */
export function applyRuleExpirySweep(plan, ctx = {}) {
  const { repoRoot, now } = ctx;
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new TypeError('applyRuleExpirySweep: repoRoot is required');
  }
  const plans = Array.isArray(plan?.plans) ? plan.plans : [];
  const rulesDir = join(repoRoot, '.claude', 'rules');
  const processedAt = new Date(toEpochMs(now)).toISOString();

  const rewritten = [];
  const deleted = [];
  const errors = [];
  let stamped = 0;

  for (const p of plans) {
    const abs = join(rulesDir, p.file);
    try {
      if (p.action === 'rewrite' || p.action === 'delete') assertSweepable(abs, rulesDir, p.file);
      if (p.action === 'rewrite') {
        if (typeof p.nextContent !== 'string') {
          throw new Error('plan carries action "rewrite" but no nextContent');
        }
        // Atomic tmp+rename, never a bare writeFileSync: a crash mid-write
        // would leave a half-written RULE FILE tracked in git, and a torn
        // `## Provenance` block is a silently re-proposing corpus.
        const res = atomicWriteWithBackup(abs, p.nextContent, {
          tmpPrefix: '.rule-expiry-sweep',
        });
        if (!res.ok) throw new Error(res.error);
        rewritten.push(p.file);
      } else if (p.action === 'delete') {
        for (const key of p.stampKeys ?? []) {
          const res = markCandidateProcessed({
            learningKey: key,
            outcome: SWEPT_OUTCOME,
            processedAt,
            fallbackSlug: p.file.replace(/\.md$/, ''),
            repoRoot,
          });
          if (!res.written) {
            throw new Error(`stamp failed for learning-key ${key} — refusing to delete ${p.file}`);
          }
          stamped += 1;
        }
        unlinkSync(abs);
        deleted.push(p.file);
      }
    } catch (err) {
      errors.push({ file: p.file, error: err?.message ?? String(err) });
    }
  }

  return { rewritten, deleted, stamped, errors };
}
