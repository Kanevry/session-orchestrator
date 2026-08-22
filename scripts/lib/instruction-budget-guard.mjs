/**
 * instruction-budget-guard.mjs — #687 / #877 (FA2)
 *
 * Lightweight directive-budget guard for always-on `.claude/rules/*.md`.
 *
 * Sums the always-on directive count across the rule files that the
 * rule-loader classifies as always-on (no `globs:` frontmatter, and no
 * `paths:` alias either — issue #795: `paths:`-scoped rules are NOT
 * always-on and must not inflate this count) and warns when the total
 * exceeds a ceiling. "Mechanism over discipline" — the #668 instruction-
 * budget audit recommends this as a silent-now growth ratchet that only
 * fires when NEW always-on directives are added.
 *
 * #877 FA2 extends this additively with a BYTE dimension (`totalBytes` /
 * `perFile[].bytes`) and a per-tier surface split (`bySurface`). The
 * original directive-line heuristic only inspects bullet/digit/`##` lines —
 * the majority of an always-on rule file's payload (prose paragraphs, code
 * fences) never contributes to `totalDirectives`, so that count alone
 * understates the real instruction-budget cost. `bySurface` further splits
 * the always-on corpus by `entry.tier` (issue #692) so a coordinator-only
 * file (never reaches a wave agent) does not silently inflate what a wave
 * agent's own budget looks like.
 *
 * #893 correction: `bySurface.coordinator` mirrors
 * `loadApplicableRules({context:'coordinator'})` exactly — the REAL
 * coordinator delivery path (`print-applicable-rules.mjs --context
 * coordinator`) — which EXCLUDES `tier: wave-only` content, not "the entire
 * always-on corpus regardless of tier" as a pre-#893 doc revision claimed.
 * `always` is a strict subset of both `wave` and `coordinator` (neither tier
 * gate touches `tier: 'always'`), but `wave` and `coordinator` are each other's
 * SIBLING projections, not nested — one excludes `coordinator-only`, the other
 * excludes `wave-only`, so neither is guaranteed to be `⊆` the other. Do NOT
 * assume `wave ⊆ coordinator` (that only held under the pre-#893 bug where
 * `context: 'coordinator'` silently meant "untiered"). The additive
 * `coordinator + wave === totalBytes` identity is separately never
 * guaranteed either — it double-counts the `always` tier that sits in both
 * surfaces; see #877 issue discussion.
 *
 * Plain-JS — no Zod dependency. Never throws.
 *   - `computeInstructionBudget` always returns the full shape (never null).
 *   - `checkInstructionBudget` returns a banner object or null (session-start
 *     Phase 4 convention, mirroring checkQgCommandDrift / checkCiStatus).
 *
 * Always-on membership AND tier-surface gating are both delegated to
 * `loadApplicableRules` from `./rule-loader.mjs` (single SSOT) — we do NOT
 * hard-code the file list, and we do NOT hand-roll a second copy of the
 * tier-gate conditionals `applyGates` already implements (the `context`
 * param below is the exact mechanism rule-loader exposes for this).
 *
 * Cross-references:
 * - "2026-06-20 instruction-budget audit" (#668 / #687; archived in the private Meta-Vault)
 * - scripts/lib/rule-loader.mjs (always-on classification + tier-gate SSOT)
 * - scripts/lib/qg-command-drift-banner.mjs (banner-shape convention)
 * - scripts/lib/ci-status-banner.mjs (never-throws convention)
 * - issue #877 (FA2 — byte dimension + surface split)
 * - SISTER GUARD / KNOWN DIVERGENCE (#906.3): the projects-baseline repo
 *   (resolved via `plan-baseline-path` / owner.yaml `baseline-path`) ships
 *   `scripts/check-instruction-budget.sh` under rule CCU-009c. It measures the
 *   SAME `.claude/rules/*.md` corpus and its total is NOT comparable to ours —
 *   it diverges on BOTH axes, in OPPOSITE directions:
 *     (a) MEMBERSHIP — it classifies a file as path-scoped only on a `paths:`
 *         frontmatter key, so this repo's `globs:`-scoped rules stay inside ITS
 *         always-on set: 26 files where `loadApplicableRules` yields 12 here.
 *     (b) HEURISTIC — it counts only rule-ID anchors and imperative-keyword
 *         BULLET lines outside code fences, where `countDirectives` below
 *         counts every bullet, ordered-list item and `##`-or-deeper heading.
 *   The narrower heuristic outweighs the wider file set, so its total runs
 *   LOWER than ours: measured 2026-07-30 against this repo's corpus, 263 (its
 *   heuristic) vs 471 (ours) ≈ 1.79x; its own header reports a ~2-3x spread on
 *   the baseline repo's corpus, so the factor is corpus-dependent, not a
 *   constant. Never diff or reconcile the two totals — each is only meaningful
 *   against its OWN ceiling, and on that same corpus the two already disagree
 *   on the verdict (263 > its max of 200 → over budget; 471 <= our 480 → ok).
 *   Their ceilings are not the same kind of number either: its 200 is an
 *   unvalidated placeholder it explicitly retracts in its own header, ours is a
 *   self-relative growth ratchet calibrated just above our own baseline.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadApplicableRules } from './rule-loader.mjs';

/** Default directive ceiling (operator-chosen growth ratchet just above the ~457 baseline). */
export const DEFAULT_CEILING = 480;

/**
 * Default BYTE ceiling (#931a) — the second axis of the same growth ratchet.
 *
 * Derived from measurement, not from a feeling. Measured 2026-07-30 against
 * this repo's own always-on corpus:
 *
 *   node -e "import('./scripts/lib/instruction-budget-guard.mjs').then(m =>
 *     console.log(m.computeInstructionBudget({repoRoot: process.cwd()}).totalBytes))"
 *   → 108589    (12 always-on rules, untiered surface)
 *
 * 108589 x 1.05 = 114018 → rounded DOWN to 114000. The +5% headroom is not
 * arbitrary either: it is the SAME relative headroom the directive ceiling
 * already carries (480 over its ~457 baseline = +5.03%), so the two axes are
 * calibrated identically rather than one being tighter than the other by
 * accident. In absolute terms +5% ≈ 5.4 KB ≈ one medium always-on rule file
 * (verification-before-completion.md is 6.1 KB) — i.e. the ratchet fires when
 * a genuinely NEW always-on surface is added, not when an existing rule is
 * edited. A default that reddens the current state would be switched off
 * within one session and measure nothing thereafter.
 *
 * Note the byte axis is materially LOOSER than the directive axis in practice:
 * the live repo sits at 471/480 directives (98.1% of ceiling) but 108589/114000
 * bytes (95.3%). That asymmetry is inherited from the pre-existing directive
 * ratchet, not introduced here.
 *
 * RE-BASELINED 2026-08-22: 114000 -> 121000. The ratchet fired for exactly the
 * reason stated above — "a genuinely NEW always-on surface is added". Since the
 * 2026-07-30 calibration this repo's corpus grew 108589 -> 115730 B, and the
 * largest single cause is a rule file the operator adopted:
 * .claude/rules/host-resources.md (7457 B, #1089, live 2026-08-21). Headroom
 * unchanged at +5%: 115730 x 1.05 = 121516, rounded DOWN to 121000. Same
 * relative slack, measured against the corpus that actually exists.
 *
 * Consumer impact was CHECKED, not assumed. This module ships inside the npm
 * package, so the first instinct was to keep the shared default fixed and set a
 * repo-local `instruction-budget.byte-ceiling` override instead. Two
 * measurements killed that plan: (a) the package ships THREE always-on rules
 * totalling 9261 B — both ceilings sit ~12x above any consumer's inherited
 * corpus, so the delta is numerically inert downstream; and (b) the number was
 * never a shipped-corpus figure in the first place — the calibration above says
 * "measured against this repo's own always-on corpus". A repo-local override
 * also could not have worked: tests/rules/receiving-review.test.mjs calls
 * computeInstructionBudget({repoRoot}), which does not read Session Config, so
 * it pins this constant by construction.
 *
 * Not a licence to raise the number whenever it is hit — a ratchet that yields
 * on contact measures nothing, and the NEXT breach belongs to a diet. 4499 B of
 * the always-on security.md still describes surfaces this repo does not have
 * (SSRF via an http-client package, an OWASP table, RLS, bcrypt/JWT), vendored
 * from the baseline and never adapted — the same class as the Semgrep claim
 * fixed today. That cut is real and nameable and is tracked in #1126; it was
 * deliberately NOT taken in the same pass that raised the ceiling, because
 * deleting security prose to hit a number is the failure build-value.md BV-002
 * names.
 */
export const DEFAULT_BYTE_CEILING = 121000;

/**
 * Read the `instruction-budget:` nested block from the `## Session Config`
 * section of CLAUDE.md (or AGENTS.md) at `repoRoot`. Synchronous + never throws.
 *
 * The block lives inside `## Session Config`, e.g.:
 *
 *   instruction-budget:
 *     enabled: true
 *     ceiling: 480
 *     byte-ceiling: 114000
 *     mode: warn
 *
 * Behaviour:
 *   - Config-load failure (no instruction file / unreadable) → returns the
 *     graceful fallback `{ enabled: true, ceiling: DEFAULT_CEILING,
 *     'byte-ceiling': DEFAULT_BYTE_CEILING, mode: 'warn' }` so the probe still
 *     computes (mirrors the other session-start probes).
 *   - Absent block → same fallback (the feature is on-by-default, growth-ratchet).
 *   - Malformed individual values silently fall back to the per-key default.
 *
 * The `byte-ceiling` key keeps its KEBAB form in the returned object, matching
 * how every other config loader in `scripts/lib/config/` mirrors a multi-word
 * YAML key (`'due-days'`, `'timeout-ms'`, `'confidence-floor'`). The camelCase
 * `byteCeiling` spelling appears only on the `opts`/result surfaces of
 * `computeInstructionBudget`, which are plain JS objects, not config mirrors.
 *
 * @param {string} repoRoot
 * @returns {{ enabled: boolean, ceiling: number, 'byte-ceiling': number, mode: 'warn' | 'off' }}
 */
export function loadInstructionBudgetConfig(repoRoot) {
  const fallback = {
    enabled: true,
    ceiling: DEFAULT_CEILING,
    'byte-ceiling': DEFAULT_BYTE_CEILING,
    mode: 'warn',
  };

  let content = null;
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    const file = join(repoRoot ?? process.cwd(), name);
    try {
      if (existsSync(file)) {
        content = readFileSync(file, 'utf8');
        break;
      }
    } catch {
      // unreadable — try the next candidate
    }
  }
  if (typeof content !== 'string') return fallback;

  try {
    return _parseInstructionBudget(content, fallback);
  } catch {
    return fallback;
  }
}

/**
 * Parse the `instruction-budget:` block out of raw markdown content.
 * Independent helper (testable without disk IO).
 *
 * A `defaults` object that predates the `byte-ceiling` key (#931a) is tolerated:
 * the missing entry falls back to `DEFAULT_BYTE_CEILING` rather than yielding
 * `undefined`, so an older caller can never disable the byte axis by omission.
 *
 * @param {string} content - full file contents
 * @param {{ enabled: boolean, ceiling: number, 'byte-ceiling'?: number, mode: 'warn' | 'off' }} [defaults]
 * @returns {{ enabled: boolean, ceiling: number, 'byte-ceiling': number, mode: 'warn' | 'off' }}
 */
export function _parseInstructionBudget(content, defaults) {
  const base = defaults ?? {
    enabled: true,
    ceiling: DEFAULT_CEILING,
    'byte-ceiling': DEFAULT_BYTE_CEILING,
    mode: 'warn',
  };
  const baseByteCeiling =
    typeof base['byte-ceiling'] === 'number' ? base['byte-ceiling'] : DEFAULT_BYTE_CEILING;
  if (typeof content !== 'string' || content === '') {
    return { ...base, 'byte-ceiling': baseByteCeiling };
  }

  const lines = content.split(/\r?\n/);
  let inBlock = false;
  let keyIndent = 0;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      // The block key normally sits at column 0 inside `## Session Config`,
      // but tolerate a leading indent (e.g. nested under another mapping).
      const m = line.match(/^(\s*)instruction-budget:\s*$/);
      if (m) {
        inBlock = true;
        keyIndent = m[1].length;
      }
      continue;
    }
    // Blank lines stay inside the block (mid-block spacing is tolerated).
    if (line.trim() === '') {
      blockLines.push(line);
      continue;
    }
    // A child line must be indented STRICTLY DEEPER than the block key.
    // Any line at or below the key's indent (incl. column 0) closes the block.
    const indent = line.length - line.replace(/^\s+/, '').length;
    if (indent <= keyIndent) break;
    blockLines.push(line);
  }

  if (blockLines.length === 0) return { ...base, 'byte-ceiling': baseByteCeiling };

  let enabled = base.enabled;
  let ceiling = base.ceiling;
  let byteCeiling = baseByteCeiling;
  let mode = base.mode;

  for (const rawLine of blockLines) {
    const clean = rawLine.replace(/\s*#.*$/, '').replace(/\s+$/, '');
    if (!clean.trim()) continue;

    const kvMatch = clean.match(/^\s+([a-zA-Z_-]+):\s*(.*)/);
    if (!kvMatch) continue;

    const k = kvMatch[1];
    let v = kvMatch[2].trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1);

    switch (k) {
      case 'enabled':
        // Default on → only flip to false on explicit "false".
        enabled = v.toLowerCase() !== 'false';
        break;
      case 'ceiling': {
        if (/^-?\d+$/.test(v)) {
          const n = Number.parseInt(v, 10);
          if (Number.isFinite(n) && n > 0) ceiling = n;
        }
        break;
      }
      case 'byte-ceiling': {
        // Same shape as `ceiling` above — integer, strictly positive, malformed
        // or non-positive values silently keep the default (#931a).
        if (/^-?\d+$/.test(v)) {
          const n = Number.parseInt(v, 10);
          if (Number.isFinite(n) && n > 0) byteCeiling = n;
        }
        break;
      }
      case 'mode':
        // Only `off` silences; any other value (incl. `warn`) surfaces the banner.
        mode = v.toLowerCase() === 'off' ? 'off' : 'warn';
        break;
    }
  }

  return { enabled, ceiling, 'byte-ceiling': byteCeiling, mode };
}

/**
 * Skips a leading YAML frontmatter block (`---` … `---`) and returns the
 * remaining lines. Shared frontmatter classification for BOTH the directive
 * counter and the byte-walk (#877) — a single SSOT so the two dimensions
 * can never drift on "where does the file's body actually start".
 *
 * @param {string} content - raw file contents
 * @returns {string[]} lines after the frontmatter block (or all lines when
 *   there is no leading frontmatter / it never closes)
 */
function stripFrontmatterLines(content) {
  if (typeof content !== 'string' || content === '') return [];

  const lines = content.split(/\r?\n/);
  let i = 0;

  // Skip a leading YAML frontmatter block: `---` … `---`.
  if (lines[0] !== undefined && lines[0].trim() === '---') {
    let j = 1;
    while (j < lines.length && lines[j].trim() !== '---') j++;
    // Only skip if a closing fence was found; otherwise leave i at 0.
    if (j < lines.length) i = j + 1;
  }

  return lines.slice(i);
}

/**
 * Count always-on directives in a single rule file's content.
 *
 * Deterministic heuristic — counts lines that represent a directive:
 *   - bullets:       /^\s*[-*+]\s/
 *   - ordered items: /^\s*\d+[.)]\s/
 *   - headings ≥2:   /^#{2,}\s/
 *
 * Fenced code blocks (``` … ```) are excluded entirely, and a leading
 * `---` … `---` YAML frontmatter block is skipped before counting (shared
 * skip logic with the byte-walk below — see `stripFrontmatterLines`).
 *
 * Exported (#877) so `countContentBytes` reuses this exact classification
 * instead of a second hand-rolled copy — see the module doc's "Guard &
 * Threshold Design" cross-reference in `.claude/rules/development.md` on
 * why a duplicated classifier is a drift hazard, not a convenience.
 *
 * @param {string} content - raw file contents
 * @returns {number}
 */
export function countDirectives(content) {
  const lines = stripFrontmatterLines(content);

  let count = 0;
  let inFence = false;

  for (const line of lines) {
    // Toggle code-fence state on any line that opens/closes a fence.
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (
      /^\s*[-*+]\s/.test(line) ||
      /^\s*\d+[.)]\s/.test(line) ||
      /^#{2,}\s/.test(line)
    ) {
      count++;
    }
  }

  return count;
}

/**
 * Byte-walk companion to `countDirectives` (#877 FA2). Sums the UTF-8 byte
 * length of a rule file's BODY (everything after a leading YAML frontmatter
 * block, reusing `stripFrontmatterLines` — the exact same frontmatter
 * classification `countDirectives` uses, so the two dimensions can never
 * disagree on where the body starts).
 *
 * Deliberately UNLIKE `countDirectives`: fenced code blocks are NOT
 * excluded here. That divergence is the entire point of the byte
 * dimension — the #877 audit measured that fenced-code and prose bytes
 * (both invisible to the directive-line heuristic) still consume real
 * instruction-budget payload. Frontmatter is excluded from both dimensions
 * identically because it is metadata, not instructional content.
 *
 * @param {string} content - raw file contents
 * @returns {number} UTF-8 byte length of the body (0 for empty/non-string input)
 */
function countContentBytes(content) {
  const lines = stripFrontmatterLines(content);
  if (lines.length === 0) return 0;
  return Buffer.byteLength(lines.join('\n'), 'utf8');
}

/**
 * Sums `countContentBytes` over an entry list already filtered to
 * `alwaysOn === true`. Small private helper so the three surface totals
 * below (`coordinator` / `wave` / `always`) share one summation shape.
 *
 * @param {Array<{content: string}>} entries
 * @returns {number}
 */
function sumBytes(entries) {
  let bytes = 0;
  for (const entry of entries) bytes += countContentBytes(entry.content);
  return bytes;
}

/**
 * Pure computation — always returns the full shape (never null, never throws).
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]  project root (defaults to process.cwd()).
 * @param {string} [opts.rulesDir]  rules directory (defaults to <repoRoot>/.claude/rules).
 * @param {number} [opts.ceiling]   directive ceiling (defaults to DEFAULT_CEILING).
 * @param {number} [opts.byteCeiling] byte ceiling (defaults to DEFAULT_BYTE_CEILING).
 *   #931a: the byte dimension shipped in #877 as DATA ONLY — nothing read it,
 *   so a rule file could grow without limit as long as it added few bullet
 *   lines. It is now a verdict axis alongside the directive count.
 * @param {'wave'|'coordinator'|null} [opts.context]  (#877; corrected #893)
 *   narrows the PRIMARY totals (`totalDirectives`/`totalBytes`/`perFile`) to
 *   what a given surface actually receives, via rule-loader's own tier gate
 *   (`loadApplicableRules({context})`) — no hand-rolled tier conditionals
 *   here:
 *     - `'wave'`: excludes `tier: coordinator-only` (what a WAVE agent
 *       receives).
 *     - `'coordinator'` (#893 fix — previously silently coerced to `null`,
 *       i.e. untiered): excludes `tier: wave-only` — mirrors
 *       `loadApplicableRules({context:'coordinator'})` exactly, the REAL
 *       coordinator delivery path (`print-applicable-rules.mjs --context
 *       coordinator`).
 *     - `null` (default) OR any unrecognised value (`undefined`, `'bogus'`,
 *       …): the pre-#877 tier-agnostic shape — every always-on rule,
 *       regardless of tier. This ALSO matches rule-loader's own
 *       `context: null` semantics (no tier gating at all — see
 *       `rule-loader.mjs`'s `applyGates`), so `null` is not a special case
 *       invented by this module; it is the same "no tier gate" behaviour
 *       rule-loader itself defines. Fail-open: an unrecognised string never
 *       throws, it just falls back to this same untiered shape.
 *   This `context` param is independent of `bySurface`, which is ALWAYS
 *   computed the same way for all three surfaces regardless of `context`
 *   (see the `bySurface` doc below).
 * @returns {{
 *   totalDirectives: number,
 *   totalBytes: number,
 *   perFile: Array<{ file: string, count: number, bytes: number }>,
 *   ceiling: number,
 *   byteCeiling: number,
 *   overDirectiveBudget: boolean,
 *   overByteBudget: boolean,
 *   overBudget: boolean,
 *   severity: 'ok' | 'warn',
 *   bySurface: { coordinator: number, wave: number, always: number },
 * }}
 *   perFile is sorted DESC by count. On missing/unreadable dir →
 *   { totalDirectives: 0, totalBytes: 0, perFile: [], ceiling, byteCeiling,
 *     overDirectiveBudget: false, overByteBudget: false, overBudget: false,
 *     severity: 'ok', bySurface: { coordinator: 0, wave: 0, always: 0 } }.
 *
 *   #931a verdict rule — `overBudget` is the OR of the two axes
 *   (`overDirectiveBudget || overByteBudget`), NOT a per-axis severity split:
 *     - Both axes measure the SAME quantity (the cost of the always-on
 *       instruction corpus) on different scales, and either one breaching is
 *       equally actionable. A 9 KB prose-only rule with three bullets is
 *       invisible to the directive axis while consuming real payload — that
 *       gap is precisely what #877 measured and what this OR closes.
 *     - A per-axis severity would need a third value in the banner-shape
 *       vocabulary (`{severity:'warn', message}` is a fixed convention shared
 *       with checkQgCommandDrift / checkCiStatus), i.e. a protocol change for
 *       every Phase-4 banner consumer — disproportionate to the gain.
 *     - Alarm fatigue is governed by the CEILING CHOICE, not by the severity
 *       label: a ceiling calibrated above the current state (see
 *       DEFAULT_BYTE_CEILING) fires rarely, whereas a too-tight ceiling
 *       produces a line at every session start no matter how it is labelled.
 *   The two sub-flags are exported so a consumer can discriminate WHICH axis
 *   broke without re-deriving the comparison (the banner below does exactly
 *   this to choose its Top-files sort key).
 *
 *   bySurface definition (#877; corrected #893 — NOT the additive
 *   `coordinator + wave === totalBytes` identity, which double-counts the
 *   `always` tier):
 *     bySurface.wave === bytes of every always-on rule whose tier is not
 *       'coordinator-only' (i.e. what `loadApplicableRules({context:'wave'})`
 *       returns) — equivalently "always + wave-only" bytes.
 *     bySurface.coordinator === bytes of every always-on rule whose tier is
 *       not 'wave-only' (i.e. what `loadApplicableRules({context:'coordinator'})`
 *       returns — the REAL coordinator delivery path,
 *       `print-applicable-rules.mjs --context coordinator`) —
 *       equivalently "always + coordinator-only" bytes. #893 fix: this is
 *       NOT a tier-agnostic alias of `totalBytes` — a pre-#893 doc revision
 *       claimed the coordinator "structurally sees the entire always-on
 *       corpus regardless of tier", which does not match rule-loader's own
 *       tier gate and is corrected here.
 *     bySurface.always === bytes of always-on rules with `tier === 'always'` only.
 *
 *   `always` is a strict subset of BOTH `wave` and `coordinator` (neither
 *   tier gate excludes `tier: 'always'`), but `wave` and `coordinator` are
 *   SIBLING projections of the same corpus, not nested in each other — each
 *   excludes a DIFFERENT tier, so their relative size depends on how much
 *   content actually carries `tier: wave-only` vs. `tier: coordinator-only`.
 *   Do NOT assume `wave ⊆ coordinator` or `coordinator ⊆ wave`.
 *
 *   `bySurface` is computed identically regardless of what `opts.context`
 *   was requested for the PRIMARY totals above — e.g. a `context: 'wave'`
 *   call still reports the FULL coordinator-surface byte sum in
 *   `bySurface.coordinator`, not the wave-narrowed `totalBytes`.
 */
export function computeInstructionBudget(opts = {}) {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const rulesDir = opts.rulesDir ?? join(repoRoot, '.claude/rules');
  const ceiling = typeof opts.ceiling === 'number' ? opts.ceiling : DEFAULT_CEILING;
  const byteCeiling =
    typeof opts.byteCeiling === 'number' ? opts.byteCeiling : DEFAULT_BYTE_CEILING;
  // #893 fix: 'coordinator' used to fall through to the `null` (untiered)
  // branch below — silently measuring the WRONG rule set for a coordinator
  // context (it never excluded `tier: wave-only`). Now explicitly recognised
  // alongside 'wave'; any other value (incl. `undefined`/'bogus') still
  // fails open to the untiered `null` shape — see the param doc above.
  const context =
    opts.context === 'wave' ? 'wave' : opts.context === 'coordinator' ? 'coordinator' : null;

  const empty = {
    totalDirectives: 0,
    totalBytes: 0,
    perFile: [],
    ceiling,
    byteCeiling,
    overDirectiveBudget: false,
    overByteBudget: false,
    overBudget: false,
    severity: 'ok',
    bySurface: { coordinator: 0, wave: 0, always: 0 },
  };

  let allEntries;
  let waveEntries;
  let coordinatorEntries;
  try {
    // Empty scopePaths → only always-on rules (no glob matches) are
    // returned by any of the three calls. `context: null` is the pre-#877
    // shape (tier-agnostic — no tier gating at all, matching rule-loader's
    // own `context: null` semantics); `context: 'wave'` / `context:
    // 'coordinator'` each apply rule-loader's own tier gate (`applyGates`)
    // — reused, not reimplemented. All three lists are loaded unconditionally
    // (not just the one matching `opts.context`) because `bySurface` reports
    // all three surfaces regardless of which `context` was requested for the
    // PRIMARY totals (see doc above).
    allEntries = loadApplicableRules({ rulesDir, scopePaths: [] });
    waveEntries = loadApplicableRules({ rulesDir, scopePaths: [], context: 'wave' });
    coordinatorEntries = loadApplicableRules({ rulesDir, scopePaths: [], context: 'coordinator' });
  } catch {
    return empty;
  }

  if (
    !Array.isArray(allEntries) ||
    !Array.isArray(waveEntries) ||
    !Array.isArray(coordinatorEntries)
  ) {
    return empty;
  }

  const alwaysOnAll = allEntries.filter((e) => e && e.alwaysOn === true);
  const alwaysOnWave = waveEntries.filter((e) => e && e.alwaysOn === true);
  const alwaysOnCoordinator = coordinatorEntries.filter((e) => e && e.alwaysOn === true);

  const bySurface = {
    coordinator: sumBytes(alwaysOnCoordinator),
    wave: sumBytes(alwaysOnWave),
    always: sumBytes(alwaysOnAll.filter((e) => e.tier === 'always')),
  };

  // Surface-selected entry set for the PRIMARY totals. `context: null`
  // (default, or any unrecognised value) preserves pre-#877 behaviour —
  // every always-on rule, tier-agnostic. `context: 'wave'` / `context:
  // 'coordinator'` each narrow to the exact same filtered list their
  // `bySurface` counterpart sums (no second, separately computed entry list).
  const selectedEntries =
    context === 'wave' ? alwaysOnWave : context === 'coordinator' ? alwaysOnCoordinator : alwaysOnAll;

  const perFile = [];
  let totalDirectives = 0;
  let totalBytes = 0;

  for (const entry of selectedEntries) {
    const count = countDirectives(entry.content);
    const bytes = countContentBytes(entry.content);
    totalDirectives += count;
    totalBytes += bytes;
    perFile.push({ file: basename(entry.path), count, bytes });
  }

  // Sort DESC by count; tie-break by filename for deterministic output.
  perFile.sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));

  // #931a: both axes are evaluated; `overBudget` is their OR (rationale in the
  // returns-doc above). Strict `>` on both, so a total sitting exactly ON its
  // ceiling is still "ok" — the byte axis inherits the directive axis's
  // long-standing boundary semantics rather than inventing a second rule.
  const overDirectiveBudget = totalDirectives > ceiling;
  const overByteBudget = totalBytes > byteCeiling;
  const overBudget = overDirectiveBudget || overByteBudget;

  return {
    totalDirectives,
    totalBytes,
    perFile,
    ceiling,
    byteCeiling,
    overDirectiveBudget,
    overByteBudget,
    overBudget,
    severity: overBudget ? 'warn' : 'ok',
    bySurface,
  };
}

/**
 * Banner wrapper — session-start Phase 4 convention.
 *
 * Reads `instruction-budget.{enabled,ceiling,byte-ceiling,mode}` from Session
 * Config (CLAUDE.md / AGENTS.md at `opts.repoRoot`, default process.cwd()):
 *   - `enabled: false` OR `mode: off` → returns null (silent no-op).
 *   - The config `ceiling` / `byte-ceiling` are used unless `opts.ceiling` /
 *     `opts.byteCeiling` are explicitly supplied (an explicit opt wins, keeping
 *     callers that pin a ceiling deterministic).
 *   - Config-load failure → graceful fallback `{enabled:true, ceiling:480,
 *     'byte-ceiling':114000, mode:warn}` so the probe still computes (mirrors
 *     the other probes).
 * Never throws.
 *
 * The message names WHICH axis breached (#931a) — a banner that only said
 * "over budget" would leave the operator guessing whether to prune bullets or
 * prose. It stays at three lines because it renders at every session start.
 *
 * @param {object} [opts]  forwarded to computeInstructionBudget.
 * @param {string} [opts.repoRoot] project root for the config read.
 * @param {number} [opts.ceiling]  explicit directive-ceiling override (wins over config).
 * @param {number} [opts.byteCeiling] explicit byte-ceiling override (wins over config).
 * @returns {{ severity: 'warn', message: string } | null}
 *   null when disabled / off / both axes at-or-under ceiling OR on any read failure.
 */
export function checkInstructionBudget(opts = {}) {
  let cfg;
  try {
    cfg = loadInstructionBudgetConfig(opts.repoRoot);
  } catch {
    cfg = {
      enabled: true,
      ceiling: DEFAULT_CEILING,
      'byte-ceiling': DEFAULT_BYTE_CEILING,
      mode: 'warn',
    };
  }

  // Opt-out gates — return null without computing.
  if (!cfg.enabled || cfg.mode === 'off') return null;

  // An explicit ceiling opt wins over the config ceiling; otherwise use config.
  const ceiling = typeof opts.ceiling === 'number' ? opts.ceiling : cfg.ceiling;
  const byteCeiling =
    typeof opts.byteCeiling === 'number'
      ? opts.byteCeiling
      : typeof cfg['byte-ceiling'] === 'number'
        ? cfg['byte-ceiling']
        : DEFAULT_BYTE_CEILING;

  let budget;
  try {
    budget = computeInstructionBudget({ ...opts, ceiling, byteCeiling });
  } catch {
    return null; // never throw out of the banner wrapper
  }

  if (!budget || !budget.overBudget) return null;

  // Name only the breached axes — listing a healthy axis would pad the line
  // without telling the operator anything they must act on.
  const axes = [];
  if (budget.overDirectiveBudget) {
    axes.push(`directives ${budget.totalDirectives} > ${budget.ceiling}`);
  }
  if (budget.overByteBudget) {
    axes.push(`bytes ${budget.totalBytes} > ${budget.byteCeiling}`);
  }

  // `perFile` arrives sorted DESC by directive count. When ONLY the byte axis
  // broke, that ordering points at the wrong files — re-sort by bytes so the
  // Top-files line lists the ones actually responsible for the breach.
  const ranked =
    budget.overByteBudget && !budget.overDirectiveBudget
      ? [...budget.perFile].sort((a, b) => b.bytes - a.bytes || a.file.localeCompare(b.file))
      : budget.perFile;

  const top = ranked
    .slice(0, 3)
    .map((f) => `${f.file} (${f.count} dir, ${f.bytes} B)`)
    .join(', ');

  const message = [
    `⚠ Instruction budget over — ${axes.join(' · ')} across ${budget.perFile.length} always-on rules.`,
    `  Top files: ${top}`,
    '  See the instruction-budget audit (#687; archived in the private Meta-Vault) for the prune/demote list.',
  ].join('\n');

  return { severity: 'warn', message };
}
